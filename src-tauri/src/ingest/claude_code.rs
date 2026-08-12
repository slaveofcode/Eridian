//! Claude Code ingester.
//!
//! Sources: ~/.claude/projects/<encoded-cwd>/*.jsonl and .../subagents/agent-*.jsonl
//! Strategy: initial backfill walk, then `notify` watcher → per-file byte-offset tail.
//! Every write batch commits events + new offset in ONE transaction (restart-safe,
//! duplicate-safe via the uq_events_source index).
//!
//! Schema-tolerance rules (do not "improve" these away):
//!   * parse into serde_json::Value, never into rigid structs
//!   * missing/renamed fields → best-effort extraction, never an error
//!   * a line that matches nothing → single EventKind::Unknown with raw preserved
//!   * only complete lines (ending '\n') are consumed; the tail remainder stays
//!     un-offset so a partially-flushed line is re-read next round

use crate::normalize::*;
use crate::store::Store;
use anyhow::{Context, Result};
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Flush pending file-change notifications no more often than this (debounce).
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);
/// Reconciliation sweep cadence — catches notify events the OS dropped.
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Blocking entry point. Run on a dedicated thread (keeps the watcher alive):
/// initial backfill, then watch + debounced tail + periodic reconciliation sweep.
pub fn run(store: Store) -> Result<()> {
    let Some(root) = claude_projects_dir() else {
        tracing::info!("no home dir; claude_code ingest disabled");
        return Ok(());
    };
    if !root.exists() {
        tracing::info!(path = %root.display(), "claude projects dir missing; ingest idle");
        return Ok(());
    }

    // 1. Backfill with progress reporting so the window fills in as it runs.
    let n = backfill(&store, true)?;
    tracing::info!(files = n, "claude_code backfill complete");
    let _ = store.enforce_retention();
    let _ = store.reconcile_source_alive();
    // Flip the banner to the steady "watching" state.
    store.emit_progress(crate::store::IngestProgress {
        phase: "watching".into(),
        files_done: n,
        files_total: n,
        events: 0,
        done: true,
    });

    // 2. Watch recursively; the callback runs on notify's thread → forward paths.
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .context("create fs watcher")?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .with_context(|| format!("watch {}", root.display()))?;
    tracing::info!(path = %root.display(), "watching claude projects");

    // 3. Drain loop: coalesce changes, flush ≤ every FLUSH_INTERVAL, sweep every 30s.
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut last_flush = Instant::now();
    let mut last_sweep = Instant::now();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(Ok(event)) => {
                for p in event.paths {
                    if is_jsonl(&p) {
                        pending.insert(p);
                    }
                }
            }
            Ok(Err(e)) => tracing::warn!("watch error: {e}"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if !pending.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL {
            for path in pending.drain() {
                if let Err(e) = tail_file(&store, &path, true) {
                    tracing::warn!(path = %path.display(), "live tail failed: {e:#}");
                }
            }
            last_flush = Instant::now();
        }

        if last_sweep.elapsed() >= SWEEP_INTERVAL {
            // backfill() re-tails every file from its stored offset → picks up
            // any change the watcher missed (atomic writes, dropped events).
            // Silent (report=false): the sweep must not spam progress events.
            if let Err(e) = backfill(&store, false) {
                tracing::warn!("reconciliation sweep failed: {e:#}");
            }
            let _ = store.enforce_retention();
            let _ = store.reconcile_source_alive();
            last_sweep = Instant::now();
        }
    }
    Ok(())
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("jsonl")
}

/// Backfill: walk all *.jsonl (incl. subagents/) and tail each from its stored
/// offset (0 on first run). Individual events aren't pushed to the timeline, but
/// when `report` is set, a throttled progress signal + periodic list refresh let
/// the UI show the archive filling in. Returns number of files touched.
pub fn backfill(store: &Store, report: bool) -> Result<usize> {
    let Some(root) = claude_projects_dir() else {
        return Ok(0);
    };
    if !root.exists() {
        return Ok(0);
    }
    let mut files: Vec<PathBuf> = walkdir(&root)?.into_iter().filter(|p| is_jsonl(p)).collect();
    // Respect the configured backfill file limit (Settings page).
    if let Some(limit) = store.backfill_file_limit() {
        files.truncate(limit);
    }
    let total = files.len();

    let mut events: i64 = 0;
    let mut last_report = Instant::now();
    let mut last_list = Instant::now();
    for (i, entry) in files.iter().enumerate() {
        match tail_file(store, entry, false) {
            Ok(n) => events += n as i64,
            Err(e) => tracing::warn!(path = %entry.display(), "backfill tail failed: {e:#}"),
        }
        if report {
            // Throttle progress to ~7/s and list refetches to ~1/s so the window
            // populates during a multi-minute first backfill without flooding.
            if last_report.elapsed() >= Duration::from_millis(150) {
                store.emit_progress(crate::store::IngestProgress {
                    phase: "backfilling".into(),
                    files_done: i + 1,
                    files_total: total,
                    events,
                    done: false,
                });
                last_report = Instant::now();
            }
            if last_list.elapsed() >= Duration::from_secs(1) {
                store.emit_sessions_updated();
                last_list = Instant::now();
            }
        }
    }
    if report {
        store.emit_progress(crate::store::IngestProgress {
            phase: "backfilling".into(),
            files_done: total,
            files_total: total,
            events,
            done: true,
        });
        store.emit_sessions_updated();
    }
    Ok(total)
}

/// Tail one JSONL file from its persisted byte offset. Idempotent; safe to call
/// on every notify event AND from the reconciliation sweep. When `emit` is true,
/// newly-inserted events are pushed to the frontend after the commit. Returns the
/// number of events inserted.
pub fn tail_file(store: &Store, path: &Path, emit: bool) -> Result<usize> {
    let source = path.to_string_lossy().to_string();
    let mut offset = store.get_offset(&source)?;

    let mut f = std::fs::File::open(path).with_context(|| format!("open {source}"))?;
    let len = f.metadata()?.len();
    if len < offset {
        // File truncated/rotated (shouldn't happen for cc, but never assume): restart.
        tracing::warn!(path = %source, "file shrank ({len} < {offset}), re-reading");
        offset = 0;
    }
    if len == offset {
        return Ok(0);
    }

    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity((len - offset) as usize);
    f.read_to_end(&mut buf)?;

    // Consume only complete lines; a partially-flushed tail is re-read next round.
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(last_nl) => last_nl + 1,
        None => return Ok(0), // no complete line yet
    };
    let chunk = &buf[..consumed];
    let is_sidechain_file = source.contains("/subagents/");

    let mut batches = Vec::new();
    for line in chunk.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let raw = String::from_utf8_lossy(line).to_string();
        batches.push(normalize_line(&raw, path, is_sidechain_file));
    }

    // events + offset in one transaction — offset and data can never disagree.
    let inserted = store.commit_batches(&source, offset + consumed as u64, batches)?;
    let n = inserted.len();
    if emit {
        store.emit_appended(inserted);
    }
    Ok(n)
}

/// Normalize one transcript line. NEVER returns Err — worst case is Unknown.
pub fn normalize_line(raw: &str, path: &Path, sidechain_file: bool) -> NormalizedBatch {
    let mut out = NormalizedBatch::default();
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => {
            out.events.push(unknown_event(fallback_session_id(path), raw));
            return out;
        }
    };

    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    // Sidechain (subagent) transcripts are their own session, keyed by the FILE.
    // Their `sessionId` field frequently points at the PARENT session — using it
    // would merge subagent events into the parent and flip the parent to
    // is_subagent. Main transcripts key by sessionId as usual.
    let native_sid = if sidechain_file {
        stem(path)
    } else {
        s("sessionId").unwrap_or_else(|| stem(path))
    };
    let session_id = format!("cc:{native_sid}");
    // A sidechain's `sessionId` is its PARENT (the main conversation it belongs
    // to) — a real hard link, not a heuristic. Record it so the UI shows true
    // parent → child, not time-overlap siblings.
    let parent_session_id = if sidechain_file {
        s("sessionId")
            .map(|p| format!("cc:{p}"))
            .filter(|p| p != &session_id)
    } else {
        None
    };
    let ts = s("timestamp");
    let uuid = s("uuid");
    let parent_uuid = s("parentUuid");
    let is_sidechain =
        sidechain_file || v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);

    // Session metadata (merge-upserted; last non-None wins).
    out.session = Some(NormalizedSession {
        id: session_id.clone(),
        agent: AgentKind::ClaudeCode,
        project_path: s("cwd"),
        title: None, // set by store from first User event text
        model: v
            .pointer("/message/model")
            .and_then(Value::as_str)
            .map(str::to_string),
        git_branch: s("gitBranch"),
        started_at: ts.clone(),
        updated_at: ts.clone(),
        is_subagent: is_sidechain,
        parent_session_id,
        source_ref: Some(path.to_string_lossy().to_string()),
    });

    let line_type = s("type").unwrap_or_default();
    match line_type.as_str() {
        "user" | "assistant" => {
            let role = v
                .pointer("/message/role")
                .and_then(Value::as_str)
                .unwrap_or(&line_type);
            let (tin, tout) = usage(&v);
            let content = v.pointer("/message/content");
            match content {
                // Plain-string user content
                Some(Value::String(text)) => out.events.push(NormalizedEvent {
                    session_id: session_id.clone(),
                    ts: ts.clone(),
                    kind: if role == "user" {
                        EventKind::User
                    } else {
                        EventKind::Assistant
                    },
                    role: Some(role.into()),
                    text: Some(text.clone()),
                    tool_name: None,
                    tool_input_json: None,
                    tool_result_json: None,
                    tokens_in: tin,
                    tokens_out: tout,
                    source_uuid: uuid.clone(),
                    parent_uuid: parent_uuid.clone(),
                    tool_use_id: None,
                    raw_json: raw.into(),
                }),
                // Block array: text / thinking / tool_use / tool_result → 1 event each
                Some(Value::Array(blocks)) => {
                    for (i, b) in blocks.iter().enumerate() {
                        let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                        let (kind, text, tool_name, tool_input, tool_result) = match bt {
                            "text" => (
                                if role == "user" {
                                    EventKind::User
                                } else {
                                    EventKind::Assistant
                                },
                                b.get("text").and_then(Value::as_str).map(str::to_string),
                                None,
                                None,
                                None,
                            ),
                            "thinking" => (
                                EventKind::Thinking,
                                b.get("thinking").and_then(Value::as_str).map(str::to_string),
                                None,
                                None,
                                None,
                            ),
                            "tool_use" => (
                                EventKind::ToolCall,
                                None,
                                b.get("name").and_then(Value::as_str).map(str::to_string),
                                b.get("input").map(|x| x.to_string()),
                                None,
                            ),
                            "tool_result" => (
                                EventKind::ToolResult,
                                None,
                                None,
                                None,
                                b.get("content").map(|x| x.to_string()),
                            ),
                            "image" => (
                                EventKind::Meta,
                                Some("image".to_string()),
                                None,
                                None,
                                None,
                            ),
                            _ => (EventKind::Unknown, None, None, None, None),
                        };
                        // Correlation id: a tool_use carries its own `id`; the
                        // matching tool_result carries `tool_use_id`.
                        let tool_use_id = match bt {
                            "tool_use" => b.get("id").and_then(Value::as_str).map(str::to_string),
                            "tool_result" => {
                                b.get("tool_use_id").and_then(Value::as_str).map(str::to_string)
                            }
                            _ => None,
                        };
                        out.events.push(NormalizedEvent {
                            session_id: session_id.clone(),
                            ts: ts.clone(),
                            kind,
                            role: Some(role.into()),
                            text,
                            tool_name,
                            tool_input_json: tool_input,
                            tool_result_json: tool_result,
                            // usage belongs to the message; attach to first block only
                            tokens_in: if i == 0 { tin } else { None },
                            tokens_out: if i == 0 { tout } else { None },
                            // uuid must stay unique per event for the dedupe index
                            source_uuid: uuid.as_ref().map(|u| format!("{u}#{i}")),
                            parent_uuid: parent_uuid.clone(),
                            tool_use_id,
                            raw_json: raw.into(),
                        });
                    }
                }
                _ => out.events.push(unknown_event(session_id.clone(), raw)),
            }
        }
        "summary" => out.events.push(NormalizedEvent {
            session_id: session_id.clone(),
            ts,
            kind: EventKind::Summary,
            role: None,
            text: s("summary"),
            tool_name: None,
            tool_input_json: None,
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: uuid,
            parent_uuid,
            tool_use_id: None,
            raw_json: raw.into(),
        }),
        "system" => out.events.push(NormalizedEvent {
            session_id: session_id.clone(),
            ts,
            kind: EventKind::System,
            role: None,
            text: s("content").or_else(|| s("subtype")),
            tool_name: None,
            tool_input_json: None,
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: uuid,
            parent_uuid,
            tool_use_id: None,
            raw_json: raw.into(),
        }),
        // ai-title carries the human-readable session title — the best title we
        // have. Set it on the session; emit no timeline event.
        "ai-title" => {
            if let (Some(sess), Some(t)) = (out.session.as_mut(), s("aiTitle")) {
                sess.title = Some(t);
            }
        }
        // pr-link is genuinely useful — surface it as a system event with a
        // clickable link (GitLab merge requests vs GitHub pull requests).
        "pr-link" => {
            let n = v.get("prNumber").and_then(|x| x.as_i64());
            let repo = s("prRepository").unwrap_or_default();
            let url = s("prUrl").unwrap_or_default();
            let kind = if url.contains("/merge_requests/") { "MR" } else { "PR" };
            let label = match n {
                Some(n) => format!("{kind} #{n} · {repo}"),
                None => format!("{kind} · {repo}"),
            };
            // Markdown link when we have a URL → the UI renders it clickable.
            let text = if url.is_empty() {
                label
            } else {
                format!("[{label}]({url})")
            };
            out.events.push(NormalizedEvent {
                session_id: session_id.clone(),
                ts,
                kind: EventKind::System,
                role: None,
                text: Some(text),
                tool_name: None,
                tool_input_json: None,
                tool_result_json: None,
                tokens_in: None,
                tokens_out: None,
                source_uuid: uuid,
                parent_uuid,
                tool_use_id: None,
                raw_json: raw.into(),
            });
        }
        // Known control/metadata lines → Meta (hidden by default in the UI).
        "mode" | "permission-mode" | "queue-operation" | "attachment"
        | "file-history-snapshot" | "last-prompt" | "bridge-session" => {
            out.events.push(meta_event(session_id.clone(), ts, meta_label(&line_type, &v), raw));
        }
        _ => out.events.push(unknown_event(session_id.clone(), raw)),
    }
    out
}

/// Concise human label for a known control line.
fn meta_label(line_type: &str, v: &Value) -> String {
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    match line_type {
        "mode" => format!("mode: {}", field("mode")),
        "permission-mode" => format!("permission: {}", field("permissionMode")),
        "queue-operation" => format!("queued: {}", field("operation")),
        "file-history-snapshot" => "file snapshot".to_string(),
        "attachment" => "attachment".to_string(),
        "bridge-session" => "bridge session".to_string(),
        "last-prompt" => "last-prompt".to_string(),
        other => other.to_string(),
    }
}

fn meta_event(session_id: String, ts: Option<String>, text: String, raw: &str) -> NormalizedEvent {
    NormalizedEvent {
        session_id,
        ts,
        kind: EventKind::Meta,
        role: None,
        text: Some(text),
        tool_name: None,
        tool_input_json: None,
        tool_result_json: None,
        tokens_in: None,
        tokens_out: None,
        source_uuid: None,
        parent_uuid: None,
        tool_use_id: None,
        raw_json: raw.into(),
    }
}

fn usage(v: &Value) -> (Option<i64>, Option<i64>) {
    // Input side = the whole prompt actually sent: fresh input + cache reads +
    // cache creation. Cache tokens dominate a real Claude Code turn, so counting
    // only input_tokens would badly under-report both cost and context fill.
    let u = v.pointer("/message/usage");
    let field = |k: &str| u.and_then(|u| u.get(k)).and_then(Value::as_i64);
    let input = field("input_tokens");
    let cache_read = field("cache_read_input_tokens");
    let cache_create = field("cache_creation_input_tokens");
    let total_in = match (input, cache_read, cache_create) {
        (None, None, None) => None,
        _ => Some(input.unwrap_or(0) + cache_read.unwrap_or(0) + cache_create.unwrap_or(0)),
    };
    (total_in, field("output_tokens"))
}

fn unknown_event(session_id: String, raw: &str) -> NormalizedEvent {
    NormalizedEvent {
        session_id,
        ts: None,
        kind: EventKind::Unknown,
        role: None,
        text: None,
        tool_name: None,
        tool_input_json: None,
        tool_result_json: None,
        tokens_in: None,
        tokens_out: None,
        source_uuid: None,
        parent_uuid: None,
        tool_use_id: None,
        raw_json: raw.into(),
    }
}

fn stem(p: &Path) -> String {
    p.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into())
}
fn fallback_session_id(p: &Path) -> String {
    format!("cc:{}", stem(p))
}

/// Minimal recursive walk.
fn walkdir(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                tracing::warn!(path = %dir.display(), "read_dir failed: {e}");
                continue;
            }
        };
        for e in rd {
            let p = match e {
                Ok(e) => e.path(),
                Err(_) => continue,
            };
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> PathBuf {
        PathBuf::from("/home/u/.claude/projects/proj/s1.jsonl")
    }

    #[test]
    fn user_string_content_is_one_user_event() {
        let raw = r#"{"type":"user","sessionId":"s1","uuid":"u1","timestamp":"2026-08-08T00:00:00Z","cwd":"/proj","gitBranch":"main","message":{"role":"user","content":"hello"}}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::User);
        assert_eq!(b.events[0].text.as_deref(), Some("hello"));
        let s = b.session.unwrap();
        assert_eq!(s.id, "cc:s1");
        assert_eq!(s.project_path.as_deref(), Some("/proj"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert!(!s.is_subagent);
    }

    #[test]
    fn captures_tool_use_id_for_bash_call_and_result() {
        let call = r#"{"type":"assistant","sessionId":"s1","uuid":"a1","timestamp":"2026-08-11T00:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"git status"}}]}}"#;
        let result = r#"{"type":"user","sessionId":"s1","uuid":"u1","timestamp":"2026-08-11T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"ok"}]}}"#;
        let b1 = normalize_line(call, &p(), false);
        let call_ev = b1.events.iter().find(|e| e.kind == EventKind::ToolCall).unwrap();
        assert_eq!(call_ev.tool_use_id.as_deref(), Some("toolu_01"));
        let b2 = normalize_line(result, &p(), false);
        let res_ev = b2.events.iter().find(|e| e.kind == EventKind::ToolResult).unwrap();
        assert_eq!(res_ev.tool_use_id.as_deref(), Some("toolu_01"));
    }

    #[test]
    fn assistant_block_array_splits_into_events() {
        let raw = r#"{"type":"assistant","sessionId":"s1","uuid":"a1","timestamp":"2026-08-08T00:00:01Z","message":{"role":"assistant","model":"claude-x","usage":{"input_tokens":10,"output_tokens":20},"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 3);
        assert_eq!(b.events[0].kind, EventKind::Thinking);
        assert_eq!(b.events[0].text.as_deref(), Some("hmm"));
        // usage attaches to the first block only
        assert_eq!(b.events[0].tokens_in, Some(10));
        assert_eq!(b.events[1].tokens_in, None);
        assert_eq!(b.events[1].kind, EventKind::Assistant);
        assert_eq!(b.events[2].kind, EventKind::ToolCall);
        assert_eq!(b.events[2].tool_name.as_deref(), Some("Bash"));
        assert!(b.events[2].tool_input_json.as_deref().unwrap().contains("ls"));
        // per-block uuids are unique for the dedupe index
        assert_eq!(b.events[0].source_uuid.as_deref(), Some("a1#0"));
        assert_eq!(b.events[2].source_uuid.as_deref(), Some("a1#2"));
        assert_eq!(b.session.unwrap().model.as_deref(), Some("claude-x"));
    }

    #[test]
    fn tool_result_block_is_captured() {
        let raw = r#"{"type":"user","sessionId":"s1","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","content":"file listing"}]}}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::ToolResult);
        assert!(b.events[0]
            .tool_result_json
            .as_deref()
            .unwrap()
            .contains("file listing"));
    }

    #[test]
    fn image_block_is_meta() {
        let raw = r#"{"type":"assistant","sessionId":"s1","uuid":"a2","message":{"role":"assistant","content":[{"type":"image","source":{}}]}}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::Meta);
    }

    #[test]
    fn ai_title_sets_session_title_and_emits_no_event() {
        let raw = r#"{"type":"ai-title","aiTitle":"Refactor the ingest loop","sessionId":"s1"}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 0, "ai-title should not create a timeline event");
        assert_eq!(
            b.session.unwrap().title.as_deref(),
            Some("Refactor the ingest loop")
        );
    }

    #[test]
    fn control_lines_become_meta_with_labels() {
        let cases = [
            (r#"{"type":"mode","mode":"default","sessionId":"s1"}"#, "mode: default"),
            (
                r#"{"type":"permission-mode","permissionMode":"plan","sessionId":"s1"}"#,
                "permission: plan",
            ),
            (
                r#"{"type":"queue-operation","operation":"enqueue","sessionId":"s1"}"#,
                "queued: enqueue",
            ),
            (r#"{"type":"attachment","sessionId":"s1"}"#, "attachment"),
            (
                r#"{"type":"file-history-snapshot","sessionId":"s1"}"#,
                "file snapshot",
            ),
        ];
        for (raw, expected_text) in cases {
            let b = normalize_line(raw, &p(), false);
            assert_eq!(b.events.len(), 1, "for {raw}");
            assert_eq!(b.events[0].kind, EventKind::Meta, "for {raw}");
            assert_eq!(b.events[0].text.as_deref(), Some(expected_text), "for {raw}");
        }
    }

    #[test]
    fn pr_link_becomes_clickable_system_link() {
        let raw = r#"{"type":"pr-link","sessionId":"s1","prNumber":42,"prUrl":"https://ex.test/org/repo/pull/42","prRepository":"org/repo","timestamp":"2026-08-08T00:00:00Z"}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::System);
        let text = b.events[0].text.as_deref().unwrap();
        // A GitHub URL → "PR", rendered as a markdown link to the URL.
        assert_eq!(text, "[PR #42 · org/repo](https://ex.test/org/repo/pull/42)");
    }

    #[test]
    fn pr_link_detects_gitlab_merge_request() {
        let raw = r#"{"type":"pr-link","sessionId":"s1","prNumber":5,"prUrl":"https://ex.test/org/repo/-/merge_requests/5","prRepository":"org/repo","timestamp":"2026-08-08T00:00:00Z"}"#;
        let b = normalize_line(raw, &p(), false);
        let text = b.events[0].text.as_deref().unwrap();
        assert!(text.starts_with("[MR #5"), "text was {text}");
    }

    #[test]
    fn malformed_line_becomes_unknown_not_error() {
        let raw = "{not valid json";
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::Unknown);
        assert_eq!(b.events[0].raw_json, raw);
        // session id falls back to the file stem
        assert_eq!(b.events[0].session_id, "cc:s1");
    }

    #[test]
    fn truly_unknown_line_type_stays_unknown() {
        // A type we don't recognize at all still falls back to Unknown.
        let raw = r#"{"type":"some-future-type","sessionId":"s1"}"#;
        let b = normalize_line(raw, &p(), false);
        assert_eq!(b.events.len(), 1);
        assert_eq!(b.events[0].kind, EventKind::Unknown);
    }

    #[test]
    fn summary_and_system_lines() {
        let sum = r#"{"type":"summary","summary":"did stuff","uuid":"x1"}"#;
        assert_eq!(
            normalize_line(sum, &p(), false).events[0].kind,
            EventKind::Summary
        );
        let sys = r#"{"type":"system","subtype":"hook","uuid":"x2"}"#;
        assert_eq!(
            normalize_line(sys, &p(), false).events[0].kind,
            EventKind::System
        );
    }

    #[test]
    fn sidechain_uses_file_identity_not_parent_session_id() {
        // Sidechain lines often carry the PARENT's sessionId; the subagent must
        // become its own session keyed by the file, never merge into the parent.
        let raw = r#"{"type":"user","sessionId":"parent-uuid","uuid":"u1","message":{"role":"user","content":"hi"}}"#;
        let sub_path = PathBuf::from("/home/u/.claude/projects/proj/subagents/agent-xyz.jsonl");
        let b = normalize_line(raw, &sub_path, true);
        let s = b.session.unwrap();
        assert_eq!(s.id, "cc:agent-xyz", "keyed by file stem, not parent sessionId");
        assert!(s.is_subagent);
        assert_eq!(
            s.parent_session_id.as_deref(),
            Some("cc:parent-uuid"),
            "real parent link from the sessionId field"
        );
        assert_eq!(b.events[0].session_id, "cc:agent-xyz");
    }

    /// Real-data smoke test: backfill the actual ~/.claude/projects into a temp
    /// DB (read-only against agent data). Ignored by default — depends on the
    /// machine having transcripts. Run: `cargo test -- --ignored real_backfill`.
    #[test]
    #[ignore]
    fn real_backfill_ingests_without_panic() {
        let store = Store::open_in_memory().unwrap();
        let n = backfill(&store, false).unwrap();
        let sessions = store.list_sessions(None).unwrap();
        let status = store.ingest_status().unwrap();
        eprintln!(
            "backfilled {n} files → {} sessions, {} cc events",
            sessions.len(),
            status.claude_code_events
        );
        assert!(n > 0, "expected at least one transcript file");
        assert!(!sessions.is_empty(), "expected at least one session");
        assert!(status.claude_code_events > 0, "expected some events");
        // Idempotency: a second backfill (simulating restart) adds nothing.
        backfill(&store, false).unwrap();
        let after = store.ingest_status().unwrap();
        assert_eq!(
            status.claude_code_events, after.claude_code_events,
            "restart backfill must not duplicate events"
        );
    }

    // ── fixture round-trip: normalize → store → query (PLAN.md M1) ────────────

    #[test]
    fn fixture_session_round_trips_through_store() {
        let fixture = include_str!("../../fixtures/claude_code_session.jsonl");
        let path = PathBuf::from("/tmp/demo/fix-1.jsonl");
        let mut batches = Vec::new();
        for line in fixture.lines() {
            if line.trim().is_empty() {
                continue;
            }
            batches.push(normalize_line(line, &path, false));
        }
        let store = Store::open_in_memory().unwrap();
        // A malformed line in the middle must not abort ingest of the rest.
        let inserted = store
            .commit_batches("/tmp/demo/fix-1.jsonl", 999, batches)
            .unwrap();
        assert!(inserted.len() >= 8, "expected all events, got {}", inserted.len());

        let sessions = store.list_sessions(None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "cc:fix-1");
        // title backfilled from the first user prompt
        assert_eq!(
            sessions[0].title.as_deref(),
            Some("summarize the partition strategy")
        );
        assert_eq!(sessions[0].model.as_deref(), Some("claude-opus-4-8"));

        // Kinds present across the session.
        let events = store.session_events("cc:fix-1", 500, None).unwrap();
        let kinds: std::collections::HashSet<&str> =
            events.iter().map(|e| e.kind.as_str()).collect();
        // 'mode' line → meta; the malformed line → unknown.
        for expected in [
            "user", "assistant", "thinking", "tool_call", "tool_result", "summary",
            "system", "meta", "unknown",
        ] {
            assert!(kinds.contains(expected), "missing kind {expected}");
        }
    }

    #[test]
    fn usage_sums_input_and_all_cache_tokens() {
        // The whole prompt actually sent = input + cache_read + cache_creation.
        let v: Value = serde_json::from_str(
            r#"{"message":{"usage":{"input_tokens":5,"cache_read_input_tokens":300,"cache_creation_input_tokens":40,"output_tokens":12}}}"#,
        )
        .unwrap();
        assert_eq!(usage(&v), (Some(345), Some(12)));
    }

    #[test]
    fn usage_partial_and_missing_fields() {
        // Only cache_read present → still summed (input/creation default 0).
        let v: Value = serde_json::from_str(
            r#"{"message":{"usage":{"cache_read_input_tokens":100}}}"#,
        )
        .unwrap();
        assert_eq!(usage(&v), (Some(100), None));

        // No usage object at all → both None (not Some(0)).
        let empty: Value = serde_json::from_str(r#"{"message":{}}"#).unwrap();
        assert_eq!(usage(&empty), (None, None));
    }
}
