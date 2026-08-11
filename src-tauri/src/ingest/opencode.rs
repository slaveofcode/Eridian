//! OpenCode ingester.
//!
//! OpenCode runs a local HTTP server (`opencode serve`, default :4096) with an
//! OpenAPI spec at GET /doc and an SSE stream at GET /event.
//!
//! Design (robust to SSE payload drift, verified against opencode 1.17.9 /doc):
//!   * Bootstrap over REST — shapes we control: GET /session, then
//!     GET /session/{id}/message → { data: [SessionMessage], cursor }.
//!   * Live: SSE frames are `{ type:"sync", syncEvent:{ data:{ sessionID }}}`.
//!     We DON'T parse part payloads from SSE (they drift); a frame is only a
//!     "session X changed" signal → debounced REST re-pull of that session.
//!   * Server down → mark disconnected (UI shows a CTA), retry with backoff.

use crate::normalize::*;
use crate::store::Store;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub mod routes {
    pub const DOC: &str = "/doc";
    pub const EVENT_SSE: &str = "/event";
    pub const SESSIONS: &str = "/session";
    pub const PROJECTS: &str = "/project";
    pub fn session(id: &str) -> String {
        format!("/session/{id}")
    }
    pub fn session_messages(id: &str) -> String {
        format!("/session/{id}/message")
    }
}

/// Percent-encode a directory path for a query string (spaces, etc.).
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

const DEFAULT_BASE: &str = "http://localhost:4096";
/// Don't re-pull the same session more often than this in response to SSE bursts.
const RESYNC_DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Clone)]
pub struct OpenCodeClient {
    base: String,
    http: reqwest::Client,
    /// session id → last-seen `time.updated`, so polling only re-pulls messages
    /// for sessions that actually changed.
    seen: Arc<Mutex<HashMap<String, String>>>,
}

impl OpenCodeClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .build()
                .expect("reqwest client"),
            seen: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn source_key(&self) -> String {
        format!("opencode:{}", self.base)
    }

    async fn is_up(&self) -> bool {
        self.http
            .get(format!("{}{}", self.base, routes::DOC))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    async fn get_json(&self, path: &str) -> Result<Value> {
        Ok(self
            .http
            .get(format!("{}{}", self.base, path))
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?)
    }

    /// Sessions are directory-scoped, so enumerate every project and list
    /// sessions per directory (deduped), then import each + its messages. Only
    /// re-pulls messages for sessions whose `time.updated` changed. Returns
    /// events inserted. This is what lets Eridian see sessions from the user's
    /// own opencode server/TUI (they share opencode.db across processes).
    async fn bootstrap(&self, store: &Store, emit: bool) -> Result<usize> {
        // Directories to query: every known project + the server default.
        let mut dirs: Vec<Option<String>> = vec![None];
        if let Ok(projects) = self.get_json(routes::PROJECTS).await {
            if let Some(arr) = projects.as_array() {
                for p in arr {
                    if let Some(d) = p
                        .get("worktree")
                        .and_then(Value::as_str)
                        .or_else(|| p.get("directory").and_then(Value::as_str))
                    {
                        dirs.push(Some(d.to_string()));
                    }
                }
            }
        }

        // Collect sessions across directories, deduped by id.
        let mut seen_ids = std::collections::HashSet::new();
        let mut sessions: Vec<Value> = Vec::new();
        for dir in &dirs {
            let path = match dir {
                Some(d) => format!("{}?directory={}", routes::SESSIONS, enc(d)),
                None => routes::SESSIONS.to_string(),
            };
            if let Ok(v) = self.get_json(&path).await {
                if let Some(arr) = v.as_array() {
                    for s in arr {
                        if let Some(id) = s.get("id").and_then(Value::as_str) {
                            if seen_ids.insert(id.to_string()) {
                                sessions.push(s.clone());
                            }
                        }
                    }
                }
            }
        }

        let mut total = 0;
        for s in &sessions {
            let Some(sid) = s.get("id").and_then(Value::as_str) else {
                continue;
            };
            // Always upsert session metadata (cheap; refreshes title/updated_at).
            store.commit_batches(&self.source_key(), 0, vec![normalize_session_obj(s)])?;

            // Skip message re-pull when this session hasn't changed.
            let updated = ms_to_iso(s, &["time", "updated"]).unwrap_or_default();
            let changed = {
                let mut seen = self.seen.lock().unwrap();
                if seen.get(sid).is_some_and(|u| u == &updated) {
                    false
                } else {
                    seen.insert(sid.to_string(), updated);
                    true
                }
            };
            if !changed {
                continue;
            }

            let msgs = self
                .get_json(&routes::session_messages(sid))
                .await
                .unwrap_or(Value::Null);
            let items = msgs
                .get("data")
                .and_then(Value::as_array)
                .or_else(|| msgs.as_array())
                .cloned()
                .unwrap_or_default();
            let batches: Vec<NormalizedBatch> =
                items.iter().map(|m| normalize_message_obj(sid, m)).collect();
            apply_tool_completions(store, &batches);
            let inserted = store.commit_batches(&self.source_key(), 0, batches)?;
            total += inserted.len();
            if emit {
                store.emit_appended(inserted);
            }
        }
        if emit {
            store.emit_sessions_updated();
        }
        Ok(total)
    }

    /// Re-pull one session (metadata + messages) and commit. When `emit` is set,
    /// push the new events to the timeline and refresh the session list.
    async fn resync_session(&self, store: &Store, sid: &str, emit: bool) -> Result<usize> {
        let mut batches: Vec<NormalizedBatch> = Vec::new();
        if let Ok(sess) = self.get_json(&routes::session(sid)).await {
            batches.push(normalize_session_obj(&sess));
        }
        let msgs = self
            .get_json(&routes::session_messages(sid))
            .await
            .context("list messages")?;
        // { data: [SessionMessage], cursor }  (fallback to a bare array)
        let items = msgs
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| msgs.as_array())
            .cloned()
            .unwrap_or_default();
        for m in &items {
            batches.push(normalize_message_obj(sid, m));
        }
        apply_tool_completions(store, &batches);
        let inserted = store.commit_batches(&self.source_key(), 0, batches)?;
        let n = inserted.len();
        if emit {
            store.emit_sessions_updated();
            store.emit_appended(inserted);
        }
        Ok(n)
    }

    /// Blocking-forever run loop (spawn on the async runtime): connect, bootstrap,
    /// stream SSE as change signals, reconnect with backoff on failure.
    pub async fn run(self, store: Store) {
        let mut backoff = Duration::from_secs(1);
        loop {
            if !self.is_up().await {
                store.set_opencode_connected(false);
                tokio::time::sleep(backoff).await;
                // Cap low so a just-started server (e.g. via the Servers page) is
                // detected within a few seconds.
                backoff = (backoff * 2).min(Duration::from_secs(4));
                continue;
            }
            store.set_opencode_connected(true);
            backoff = Duration::from_secs(1);
            match self.bootstrap(&store, true).await {
                Ok(n) => tracing::info!(events = n, "opencode bootstrap complete"),
                Err(e) => tracing::warn!("opencode bootstrap failed: {e:#}"),
            }
            // SSE gives instant updates for same-process sessions; polling catches
            // cross-process changes (the user's own opencode server/TUI shares
            // opencode.db but not the in-process event bus).
            tokio::select! {
                r = self.stream(&store) => {
                    if let Err(e) = r { tracing::warn!("opencode sse ended: {e:#}"); }
                }
                _ = self.poll(&store) => {}
            }
            store.set_opencode_connected(false);
            tokio::time::sleep(backoff).await;
        }
    }

    /// Periodic re-bootstrap to catch cross-process changes. Returns when the
    /// server goes down so the outer loop can reconnect.
    async fn poll(&self, store: &Store) {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if !self.is_up().await {
                return;
            }
            if let Err(e) = self.bootstrap(store, true).await {
                tracing::warn!("opencode poll failed: {e:#}");
            }
        }
    }

    async fn stream(&self, store: &Store) -> Result<()> {
        use eventsource_stream::Eventsource;
        let resp = self
            .http
            .get(format!("{}{}", self.base, routes::EVENT_SSE))
            .send()
            .await
            .context("connect /event")?
            .error_for_status()?;
        let mut stream = resp.bytes_stream().eventsource();
        let mut last_resync: HashMap<String, std::time::Instant> = HashMap::new();
        while let Some(ev) = stream.next().await {
            let ev = ev.context("sse frame")?;
            let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
                continue;
            };
            let Some(sid) = session_id_from_sse(&v) else {
                continue;
            };
            // Debounce per session against SSE bursts.
            let now = std::time::Instant::now();
            if let Some(t) = last_resync.get(&sid) {
                if now.duration_since(*t) < RESYNC_DEBOUNCE {
                    continue;
                }
            }
            last_resync.insert(sid.clone(), now);
            if let Err(e) = self.resync_session(store, &sid, true).await {
                tracing::warn!("opencode resync failed: {e:#}");
            }
        }
        Ok(())
    }
}

/// Spawn the OpenCode ingester on the async runtime (base from env or default).
pub fn spawn(store: Store) {
    let base = std::env::var("ERIDIAN_OPENCODE_URL").unwrap_or_else(|_| DEFAULT_BASE.to_string());
    let client = OpenCodeClient::new(base);
    tauri::async_runtime::spawn(client.run(store));
}

// ── pure normalizers (schema verified against opencode 1.17.9) ────────────────

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    cur.as_str()
}
fn ms_to_iso(v: &Value, path: &[&str]) -> Option<String> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    let ms = cur.as_i64()?;
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339())
}

pub fn normalize_session_obj(s: &Value) -> NormalizedBatch {
    let sid = str_at(s, &["id"]).unwrap_or_default().to_string();
    let parent = str_at(s, &["parentID"]).map(str::to_string);
    NormalizedBatch {
        session: Some(NormalizedSession {
            id: format!("oc:{sid}"),
            agent: AgentKind::OpenCode,
            project_path: str_at(s, &["directory"])
                .or_else(|| str_at(s, &["path"]))
                .map(str::to_string),
            title: str_at(s, &["title"]).map(str::to_string),
            model: str_at(s, &["model", "id"]).map(str::to_string),
            git_branch: None,
            started_at: ms_to_iso(s, &["time", "created"]),
            updated_at: ms_to_iso(s, &["time", "updated"]),
            is_subagent: parent.is_some(),
            parent_session_id: parent.map(|p| format!("oc:{p}")),
            source_ref: Some(sid),
        }),
        events: vec![],
    }
}

/// One OpenCode message → events. User messages carry `text`; assistant messages
/// carry `content` (an array of parts). Non-conversational parts → Meta.
pub fn normalize_message_obj(sid: &str, m: &Value) -> NormalizedBatch {
    let session_id = format!("oc:{sid}");
    // Some versions wrap the message as { info: {...}, parts: [...] }; others are
    // flat. Read metadata from `info` when present, fall back to the object.
    let info = m.get("info").filter(|v| v.is_object()).unwrap_or(m);
    let mtype = str_at(info, &["type"]).or_else(|| str_at(info, &["role"])).unwrap_or("");
    let mid = str_at(info, &["id"]).unwrap_or("").to_string();
    let ts = ms_to_iso(info, &["time", "created"]).or_else(|| ms_to_iso(info, &["time"]));
    let tokens_in = info.pointer("/tokens/input").and_then(Value::as_i64);
    let tokens_out = info.pointer("/tokens/output").and_then(Value::as_i64);

    let mut events = Vec::new();
    let mut push = |i: usize,
                    kind: EventKind,
                    text: Option<String>,
                    tool_name: Option<String>,
                    tool_input: Option<String>,
                    tool_result: Option<String>,
                    tool_use_id: Option<String>,
                    raw: &Value| {
        events.push(NormalizedEvent {
            session_id: session_id.clone(),
            ts: ts.clone(),
            kind,
            role: Some(mtype.to_string()),
            text,
            tool_name,
            tool_input_json: tool_input,
            tool_result_json: tool_result,
            tokens_in: if i == 0 { tokens_in } else { None },
            tokens_out: if i == 0 { tokens_out } else { None },
            source_uuid: Some(format!("{mid}#{i}")),
            parent_uuid: None,
            tool_use_id,
            raw_json: raw.to_string(),
        });
    };

    match mtype {
        "user" => {
            if let Some(t) = str_at(info, &["text"]) {
                push(0, EventKind::User, Some(t.to_string()), None, None, None, None, info);
            }
            if let Some(files) = info.get("files").and_then(Value::as_array) {
                for (i, f) in files.iter().enumerate() {
                    let label = str_at(f, &["filename"]).unwrap_or("file");
                    push(i + 1, EventKind::Meta, Some(format!("file: {label}")), None, None, None, None, f);
                }
            }
        }
        "assistant" => {
            let parts = m
                .get("parts")
                .and_then(Value::as_array)
                .or_else(|| info.get("content").and_then(Value::as_array))
                .or_else(|| info.get("parts").and_then(Value::as_array))
                .cloned()
                .unwrap_or_default();
            for (i, p) in parts.iter().enumerate() {
                let (kind, text, tool_name, tool_input, tool_result, tool_use_id) = normalize_part(p);
                push(i, kind, text, tool_name, tool_input, tool_result, tool_use_id, p);
            }
        }
        // agent-switched / model-switched / synthetic / …
        other if !other.is_empty() => {
            push(0, EventKind::Meta, Some(other.replace('-', " ")), None, None, None, None, m);
        }
        _ => {}
    }
    NormalizedBatch {
        session: None,
        events,
    }
}

/// Flip any OpenCode tool call that arrived (or was re-pulled) in a terminal
/// state to finished. OpenCode collapses call+result into one part; the dedupe
/// index keeps the original running row, so we fill its result explicitly.
/// Best-effort — writes Eridian's own DB only; a no-op when nothing changed.
fn apply_tool_completions(store: &Store, batches: &[NormalizedBatch]) {
    for b in batches {
        for e in &b.events {
            if e.kind == EventKind::ToolCall {
                if let (Some(id), Some(result)) = (&e.tool_use_id, &e.tool_result_json) {
                    let _ = store.update_tool_completion(&e.session_id, id, result);
                }
            }
        }
    }
}

type PartTuple = (
    EventKind,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>, // tool_use_id (part callID) — Some only for tool parts
);

fn normalize_part(p: &Value) -> PartTuple {
    match str_at(p, &["type"]).unwrap_or("") {
        "text" => (
            EventKind::Assistant,
            str_at(p, &["text"]).map(str::to_string),
            None,
            None,
            None,
            None,
        ),
        "reasoning" => (
            EventKind::Thinking,
            str_at(p, &["text"]).map(str::to_string),
            None,
            None,
            None,
            None,
        ),
        "tool" => (
            EventKind::ToolCall,
            None,
            str_at(p, &["tool"]).map(str::to_string),
            p.pointer("/state/input").map(|x| x.to_string()),
            p.pointer("/state/output").map(|x| x.to_string()),
            str_at(p, &["callID"])
                .or_else(|| str_at(p, &["callId"]))
                .or_else(|| str_at(p, &["id"]))
                .map(str::to_string),
        ),
        // file / subtask / agent / step-* / snapshot / patch / compaction / retry
        t @ ("file" | "subtask" | "agent" | "step-start" | "step-finish" | "snapshot"
        | "patch" | "compaction" | "retry") => {
            (EventKind::Meta, Some(t.replace('-', " ")), None, None, None, None)
        }
        _ => (EventKind::Unknown, None, None, None, None, None),
    }
}

/// SSE frames are `{ type:"sync", syncEvent:{ data:{ sessionID }}}`. Pull the
/// affected session id; we re-pull it over REST rather than parsing the payload.
pub fn session_id_from_sse(v: &Value) -> Option<String> {
    v.pointer("/syncEvent/data/sessionID")
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/properties/sessionID").and_then(Value::as_str))
        .or_else(|| v.pointer("/data/sessionID").and_then(Value::as_str))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_object_normalizes() {
        let s = serde_json::json!({
            "id": "ses_abc",
            "directory": "/home/u/proj",
            "title": "Fix the bug",
            "model": {"id": "claude-sonnet-5", "providerID": "anthropic"},
            "time": {"created": 1_700_000_000_000i64, "updated": 1_700_000_100_000i64},
            "parentID": "ses_parent"
        });
        let b = normalize_session_obj(&s);
        let sess = b.session.unwrap();
        assert_eq!(sess.id, "oc:ses_abc");
        assert_eq!(sess.agent, AgentKind::OpenCode);
        assert_eq!(sess.project_path.as_deref(), Some("/home/u/proj"));
        assert_eq!(sess.title.as_deref(), Some("Fix the bug"));
        assert_eq!(sess.model.as_deref(), Some("claude-sonnet-5"));
        assert!(sess.is_subagent);
        assert_eq!(sess.parent_session_id.as_deref(), Some("oc:ses_parent"));
        assert!(sess.started_at.is_some());
    }

    #[test]
    fn user_message_yields_user_event() {
        let m = serde_json::json!({
            "id": "msg_1", "type": "user",
            "time": {"created": 1_700_000_000_000i64},
            "text": "hello opencode"
        });
        let b = normalize_message_obj("ses_abc", &m);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::User);
        assert_eq!(b.events[0].text.as_deref(), Some("hello opencode"));
        assert_eq!(b.events[0].session_id, "oc:ses_abc");
        assert_eq!(b.events[0].source_uuid.as_deref(), Some("msg_1#0"));
    }

    #[test]
    fn assistant_content_parts_split_into_events() {
        let m = serde_json::json!({
            "id": "msg_2", "type": "assistant",
            "time": {"created": 1_700_000_001_000i64},
            "tokens": {"input": 100, "output": 50},
            "content": [
                {"type": "reasoning", "text": "thinking..."},
                {"type": "text", "text": "the answer"},
                {"type": "tool", "tool": "bash",
                 "state": {"status": "completed", "input": {"command": "ls"}, "output": "a\nb"}}
            ]
        });
        let b = normalize_message_obj("ses_abc", &m);
        assert_eq!(b.events.len(), 3);
        assert_eq!(b.events[0].kind, EventKind::Thinking);
        assert_eq!(b.events[0].tokens_in, Some(100));
        assert_eq!(b.events[1].kind, EventKind::Assistant);
        assert_eq!(b.events[1].tokens_in, None);
        assert_eq!(b.events[2].kind, EventKind::ToolCall);
        assert_eq!(b.events[2].tool_name.as_deref(), Some("bash"));
        assert!(b.events[2].tool_input_json.as_deref().unwrap().contains("ls"));
        assert!(b.events[2].tool_result_json.as_deref().unwrap().contains("a"));
    }

    #[test]
    fn tool_part_carries_call_id() {
        let msg = serde_json::json!({
            "info": {"id": "msg_1", "type": "assistant", "time": {"created": 1_700_000_000_000i64}},
            "parts": [{
                "type": "tool", "tool": "bash", "callID": "call_9",
                "state": {"status": "completed", "input": {"command": "ls"}, "output": "a\nb"}
            }]
        });
        let b = normalize_message_obj("s", &msg);
        let call = b.events.iter().find(|e| e.kind == EventKind::ToolCall).unwrap();
        assert_eq!(call.tool_use_id.as_deref(), Some("call_9"));
    }

    #[test]
    fn non_conversational_parts_are_meta() {
        for t in ["step-start", "snapshot", "patch", "file", "subtask"] {
            let m = serde_json::json!({
                "id": "m", "type": "assistant",
                "content": [{"type": t}]
            });
            let b = normalize_message_obj("s", &m);
            assert_eq!(b.events.len(), 1, "for part {t}");
            assert_eq!(b.events[0].kind, EventKind::Meta, "for part {t}");
        }
    }

    #[test]
    fn sse_sync_frame_yields_session_id() {
        let frame = serde_json::json!({
            "type": "sync",
            "id": "evt_1",
            "syncEvent": {
                "type": "message.part.updated.1",
                "data": {"sessionID": "ses_live"}
            }
        });
        assert_eq!(session_id_from_sse(&frame).as_deref(), Some("ses_live"));
    }

    #[test]
    fn sse_unrelated_frame_is_ignored() {
        let frame = serde_json::json!({"type": "sync", "syncEvent": {"type": "server.disposed"}});
        assert_eq!(session_id_from_sse(&frame), None);
    }

    #[test]
    fn sse_alternate_pointers() {
        let a = serde_json::json!({"properties": {"sessionID": "ses_a"}});
        assert_eq!(session_id_from_sse(&a).as_deref(), Some("ses_a"));
        let b = serde_json::json!({"data": {"sessionID": "ses_b"}});
        assert_eq!(session_id_from_sse(&b).as_deref(), Some("ses_b"));
    }

    #[test]
    fn enc_percent_encodes_reserved_only() {
        assert_eq!(enc("/home/u/a-b_c.d~"), "/home/u/a-b_c.d~"); // unreserved kept
        assert_eq!(enc("a b"), "a%20b");
        assert_eq!(enc("x?y=1&z"), "x%3Fy%3D1%26z");
    }

    #[test]
    fn normalize_part_covers_remaining_types() {
        use serde_json::json;
        // agent/step-finish/compaction/retry → Meta
        for t in ["agent", "step-finish", "compaction", "retry"] {
            let (kind, _, _, _, _, _) = normalize_part(&json!({"type": t}));
            assert_eq!(kind, EventKind::Meta, "for {t}");
        }
        // unknown type → Unknown
        let (k, _, _, _, _, _) = normalize_part(&json!({"type": "bananas"}));
        assert_eq!(k, EventKind::Unknown);
    }

    #[test]
    fn wrapped_info_parts_shape_and_user_files() {
        use serde_json::json;
        // { info, parts } wrapper + a user message with a files array → Meta events
        let m = json!({
            "info": {"id": "msg_x", "type": "user", "time": {"created": 1_700_000_000_000i64},
                     "text": "hi", "files": [{"filename": "a.txt"}, {"filename": "b.txt"}]},
            "parts": []
        });
        let b = normalize_message_obj("ses_z", &m);
        // 1 user text + 2 file meta
        assert_eq!(b.events.len(), 3);
        assert_eq!(b.events[0].kind, EventKind::User);
        assert!(b.events[1..].iter().all(|e| e.kind == EventKind::Meta));
        assert!(b.events[1].text.as_deref().unwrap().contains("a.txt"));
    }

    #[test]
    fn other_message_type_is_meta() {
        let m = serde_json::json!({"id": "m", "type": "agent-switched"});
        let b = normalize_message_obj("s", &m);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::Meta);
        assert_eq!(b.events[0].text.as_deref(), Some("agent switched"));
    }

    /// Live REST bootstrap against a running `opencode serve` on :4096. Ignored by
    /// default. Run: `cargo test opencode_live_bootstrap -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn opencode_live_bootstrap() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = OpenCodeClient::new("http://localhost:4096");
            assert!(client.is_up().await, "opencode serve must be running on :4096");
            let store = Store::open_in_memory().unwrap();
            let n = client.bootstrap(&store, false).await.unwrap();
            let sessions = store.list_sessions(None).unwrap();
            eprintln!("bootstrapped {n} events across {} sessions", sessions.len());
            assert!(sessions.iter().all(|s| s.agent == "opencode"));
            assert!(!sessions.is_empty(), "expected at least one opencode session");
        });
    }
}
