//! Tauri command surface. UI reads ONLY through these commands; live updates
//! arrive via `app.emit(...)` from the store write path — never by the frontend
//! touching agent files. DTOs mirror src/lib/types.ts (serde camelCase).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

/// Handle to an `opencode serve` process Eridian started, plus a rolling buffer
/// of its stdout/stderr so the Servers page can show it like a live terminal.
#[derive(Default)]
pub struct OpenCodeProc {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<Vec<String>>>,
}

/// Live server-log line pushed to the frontend (mirrors api.ts).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerLog {
    pub server: String,
    pub line: String,
}

const SERVER_LOG_CAP: usize = 500;

impl OpenCodeProc {
    /// Kill the managed child if any (called on app exit to avoid orphaning the
    /// `opencode serve` process across dev rebuilds / quits).
    pub fn kill_child(&self) {
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
        }
    }
}

/// Append `line`, keeping at most `cap` most-recent entries (pure — no emit).
fn push_capped(buf: &mut Vec<String>, line: String, cap: usize) {
    buf.push(line);
    let over = buf.len().saturating_sub(cap);
    if over > 0 {
        buf.drain(0..over);
    }
}

fn push_log(logs: &Arc<Mutex<Vec<String>>>, app: &tauri::AppHandle, line: String) {
    {
        let mut l = logs.lock().unwrap();
        push_capped(&mut l, line.clone(), SERVER_LOG_CAP);
    }
    let _ = app.emit(
        "eridian://server-log",
        ServerLog {
            server: "opencode".into(),
            line,
        },
    );
}

fn pipe_reader<R: Read + Send + 'static>(
    reader: R,
    logs: Arc<Mutex<Vec<String>>>,
    app: tauri::AppHandle,
) {
    let buf = BufReader::new(reader);
    for line in buf.lines().map_while(Result::ok) {
        push_log(&logs, &app, line);
    }
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub agent: String,
    pub project_path: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub is_subagent: bool,
    pub parent_session_id: Option<String>,
    pub source_alive: bool,
    pub event_count: i64,
    /// Σ input / output tokens across the session's events (cost rollup).
    pub tokens_in: i64,
    pub tokens_out: i64,
    /// Latest turn's input tokens (incl. cache) — how full the context is now.
    /// Drops after a compaction (unlike an all-time peak).
    pub context_tokens: i64,
    /// Peak single-turn input — used only to detect the context tier (a session
    /// that ever exceeded 200k must be on the 1M-token window).
    pub peak_tokens_in: i64,
    /// updated within the last 60s
    pub live: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub id: i64,
    pub session_id: String,
    pub ts: Option<String>,
    pub kind: String,
    pub role: Option<String>,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input_json: Option<String>,
    pub tool_result_json: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IngestStatus {
    pub claude_code_files: i64,
    pub claude_code_events: i64,
    pub opencode_connected: bool,
    pub opencode_events: i64,
    pub last_activity_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub include_subagents: Option<bool>,
}

// ── Change-inspection DTOs (Part 3) ──────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDetail {
    pub op: String, // write | edit | read
    pub ts: Option<String>,
    pub preview: Option<String>,
    pub risk: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRow {
    pub path: String,
    pub writes: i64,
    pub edits: i64,
    pub reads: i64,
    pub last_ts: Option<String>,
    pub risk: String, // max risk across this file's ops
    pub changes: Vec<FileChangeDetail>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandRow {
    pub command: String,
    pub ts: Option<String>,
    pub risk: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RiskSummary {
    pub danger: i64,
    pub notable: i64,
    pub safe: i64,
}

/// A skill or slash-command executed during a session.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillRun {
    pub kind: String, // "skill" (reliable) | "command" (heuristic)
    pub name: String,
    pub ts: Option<String>,
    pub count: i64,
}

/// Availability of a local OpenCode cold-import.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColdImportStatus {
    pub available: bool,
    pub total: i64,
    pub pending: i64,
}

/// Per-day token rollup across all sessions (cost/usage over time).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub date: String, // YYYY-MM-DD
    pub tokens_in: i64,
    pub tokens_out: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    pub files: Vec<FileChangeRow>,
    pub commands: Vec<CommandRow>,
    pub risk: RiskSummary,
    /// True totals before the `files` list was capped for payload size.
    pub files_total: i64,
    pub commands_total: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBucket {
    pub ts: String, // minute bucket (YYYY-MM-DDTHH:MM)
    pub total: i64,
    pub tools: i64,
}

/// A subagent that was active during a given parent session's time window.
/// Spans are scoped to the parent window (subagent files accumulate across weeks,
/// so raw session spans are not a meaningful per-session flow).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLink {
    pub id: String,
    pub agent: String,
    pub title: Option<String>,
    pub event_count: i64,       // total events in the subagent (context)
    pub window_start: Option<String>, // first activity within the parent window
    pub window_end: Option<String>,   // last activity within the parent window
    pub events_in_window: i64,
    pub live: bool,
}

/// A top-level session that has ≥1 subagent active within its window.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubagentParent {
    pub session_id: String,
    pub count: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: i64,
    pub session_id: String,
    pub agent: String,
    pub session_title: Option<String>,
    pub kind: String,
    pub ts: Option<String>,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub agent: String,
    pub scope: String, // "user" | "plugin" | "project"
    pub name: String,
    pub description: String,
    pub source: String, // SKILL.md path
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRow {
    pub agent: String,
    pub scope: String,     // "user" | "project"
    pub name: String,
    pub transport: String, // "stdio" | "http" | "sse" | "unknown"
    pub target: String,    // command line or url (secrets masked)
    pub source: String,    // config file path
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command(async)]
pub fn list_sessions(
    store: State<crate::store::Store>,
    filter: Option<SessionFilter>,
) -> Result<Vec<SessionRow>, String> {
    store.list_sessions(filter).map_err(err)
}

/// Paged newest-first: pass `before_id` = smallest id you hold to page back.
#[tauri::command(async)]
pub fn session_events(
    store: State<crate::store::Store>,
    session_id: String,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<EventRow>, String> {
    store
        .session_events(&session_id, limit.unwrap_or(200), before_id)
        .map_err(err)
}

#[tauri::command(async)]
pub fn ingest_status(store: State<crate::store::Store>) -> Result<IngestStatus, String> {
    store.ingest_status().map_err(err)
}

#[tauri::command(async)]
pub fn session_skills(
    store: State<crate::store::Store>,
    session_id: String,
) -> Result<Vec<SkillRun>, String> {
    store.session_skills(&session_id).map_err(err)
}

#[tauri::command(async)]
pub fn usage_by_day(
    store: State<crate::store::Store>,
    days: Option<i64>,
) -> Result<Vec<DayUsage>, String> {
    store.usage_by_day(days.unwrap_or(30)).map_err(err)
}

/// How much OpenCode history sits in the local `opencode.db` and how much of it
/// Eridian hasn't imported yet. Used to offer a (confirmed) cold-import when the
/// server is down.
#[tauri::command(async)]
pub fn opencode_cold_status(store: State<crate::store::Store>) -> Result<ColdImportStatus, String> {
    let (total, pending) = crate::ingest::opencode_cold::cold_status(&store).map_err(err)?;
    Ok(ColdImportStatus {
        available: total > 0,
        total: total as i64,
        pending: pending as i64,
    })
}

/// Run the OpenCode cold-import (user-confirmed). Returns sessions imported.
#[tauri::command(async)]
pub fn opencode_cold_import(store: State<crate::store::Store>) -> Result<i64, String> {
    let n = crate::ingest::opencode_cold::cold_import(&store).map_err(err)?;
    store.emit_sessions_updated();
    Ok(n as i64)
}

/// Files changed + commands run + risk summary for a session (heuristic).
#[tauri::command(async)]
pub fn session_changes(
    store: State<crate::store::Store>,
    session_id: String,
) -> Result<SessionChanges, String> {
    store.session_changes(&session_id).map_err(err)
}

/// Subagent sessions heuristically linked to this session (project + time overlap).
#[tauri::command(async)]
pub fn session_subagents(
    store: State<crate::store::Store>,
    session_id: String,
) -> Result<Vec<SubagentLink>, String> {
    store.session_subagents(&session_id).map_err(err)
}

/// All top-level sessions that have subagents active within their window
/// (for a "has subagents" badge in the list). One pass.
#[tauri::command(async)]
pub fn subagent_parents(
    store: State<crate::store::Store>,
) -> Result<Vec<SubagentParent>, String> {
    store.subagent_parents().map_err(err)
}

/// Per-minute event activity buckets for a session (for the activity graph).
#[tauri::command(async)]
pub fn session_activity(
    store: State<crate::store::Store>,
    session_id: String,
) -> Result<Vec<ActivityBucket>, String> {
    store.session_activity(&session_id).map_err(err)
}

/// Full-text search across all events (both agents), newest-relevant first.
#[tauri::command(async)]
pub fn search_events(
    store: State<crate::store::Store>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, String> {
    store.search_events(&query, limit.unwrap_or(60)).map_err(err)
}

/// Read-only MCP config across agents (Claude Code + OpenCode).
#[tauri::command(async)]
pub fn list_mcp_servers() -> Result<Vec<McpServerRow>, String> {
    crate::mcp_config::read_all().map_err(err)
}

/// Skills discovered across agents (Claude Code user/plugin, OpenCode).
#[tauri::command(async)]
pub fn list_skills() -> Result<Vec<SkillRow>, String> {
    crate::skills_config::read_all().map_err(err)
}

/// Browseable catalog (local plugin cache + opt-in allowlisted remote sources).
#[tauri::command]
pub async fn market_catalog(
    store: State<'_, crate::store::Store>,
) -> Result<crate::catalog::Catalog, String> {
    crate::catalog::build_catalog(&store, false)
        .await
        .map_err(err)
}

/// Force-refresh the catalog (bypass cache). No-op remote when the toggle is off.
#[tauri::command]
pub async fn market_refresh(
    store: State<'_, crate::store::Store>,
) -> Result<crate::catalog::Catalog, String> {
    crate::catalog::build_catalog(&store, true).await.map_err(err)
}

/// Audit installed skills against the local catalog (status + heuristic flags +
/// copyable update/remove commands). Read-only; no network.
#[tauri::command(async)]
pub fn skills_audit(_store: State<crate::store::Store>) -> Result<Vec<crate::catalog::AuditRow>, String> {
    let installed = crate::skills_config::read_all().map_err(err)?;
    let root = dirs::home_dir()
        .map(|h| h.join(".claude").join("plugins").join("cache"))
        .unwrap_or_default();
    let mut catalog = crate::catalog::local::read_plugin_cache(&root);
    for it in &mut catalog {
        it.install_commands = crate::catalog::skills::skill_commands(it);
    }
    let rows = crate::catalog::compare::audit_skills(&installed, &catalog, &|p| {
        std::fs::read_to_string(p).ok()
    });
    Ok(rows)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size_bytes: i64,
    pub truncated: bool,
}

/// A commit that touched a file (for the FileViewer time machine).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: String, // ISO-8601 (author date)
    pub subject: String,
}

/// Commits that touched `path`, newest first. Empty if not in a git repo.
#[tauri::command(async)]
pub fn file_history(path: String) -> Result<Vec<FileCommit>, String> {
    Ok(crate::git_history::file_history(&path))
}

/// File content at a specific commit (read-only `git show`).
#[tauri::command(async)]
pub fn file_at_commit(path: String, sha: String) -> Result<FileContent, String> {
    crate::git_history::file_at_commit(&path, &sha).map_err(err)
}

/// An image inlined as a data: URL for the viewer.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub data_url: String,
    pub size_bytes: i64,
}

fn image_mime(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next().map(|e| e.to_lowercase()).as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("svg") => Some("image/svg+xml"),
        Some("bmp") => Some("image/bmp"),
        Some("ico") => Some("image/x-icon"),
        Some("avif") => Some("image/avif"),
        _ => None,
    }
}

/// Read a local image (read-only, size-capped) as a data: URL. Errs if the path
/// isn't a known image type, is missing, or is too large.
#[tauri::command(async)]
pub fn read_image(path: String) -> Result<ImageData, String> {
    use base64::Engine;
    const MAX: u64 = 12_000_000; // 12 MB
    let mime = image_mime(&path).ok_or_else(|| format!("not an image: {path}"))?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("open {path}: {e}"))?;
    if meta.len() > MAX {
        return Err(format!("image too large ({} bytes)", meta.len()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ImageData {
        data_url: format!("data:{mime};base64,{b64}"),
        size_bytes: meta.len() as i64,
    })
}

/// Read a file for the built-in inspector (read-only, size-capped). Lets you open
/// a changed file / skill in full without leaving Eridian.
#[tauri::command(async)]
pub fn read_file(path: String) -> Result<FileContent, String> {
    use std::io::Read;
    const MAX: usize = 500_000;
    let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(-1);
    let f = std::fs::File::open(&path).map_err(|e| format!("open {path}: {e}"))?;
    let mut buf = Vec::new();
    f.take(MAX as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {path}: {e}"))?;
    let truncated = buf.len() > MAX;
    buf.truncate(MAX);
    Ok(FileContent {
        path,
        content: String::from_utf8_lossy(&buf).to_string(),
        size_bytes: size,
        truncated,
    })
}

// ── settings / DB management ─────────────────────────────────────────────────

#[tauri::command(async)]
pub fn db_info(store: State<crate::store::Store>) -> Result<crate::store::DbInfo, String> {
    store.db_info().map_err(err)
}

#[tauri::command(async)]
pub fn get_settings(store: State<crate::store::Store>) -> crate::store::Settings {
    store.settings()
}

#[tauri::command(async)]
pub fn set_settings(
    store: State<crate::store::Store>,
    settings: crate::store::Settings,
) -> Result<crate::store::Settings, String> {
    store.set_settings(settings).map_err(err)
}

/// Wipe the derived cache and re-ingest from scratch (background thread).
#[tauri::command(async)]
pub fn rebuild_db(store: State<crate::store::Store>) -> Result<(), String> {
    store.clear_all().map_err(err)?;
    let s = store.inner().clone();
    std::thread::spawn(move || {
        if let Err(e) = crate::ingest::claude_code::backfill(&s, true) {
            tracing::error!("rebuild backfill failed: {e:#}");
        }
    });
    Ok(())
}

/// Start `opencode serve` on :4096 as a managed child (idempotent). stdout/stderr
/// are streamed to a rolling buffer + `eridian://server-log` for the terminal
/// view. Deliberate, user-invoked control action — the ingest loop then connects.
#[tauri::command(async)]
pub fn start_opencode(app: tauri::AppHandle, proc: State<OpenCodeProc>) -> Result<(), String> {
    let mut guard = proc.child.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(()); // already running
        }
    }
    let bin = opencode_bin();
    proc.logs.lock().unwrap().clear();
    push_log(&proc.logs, &app, format!("$ {bin} serve --port 4096"));

    let mut child = Command::new(&bin)
        .args(["serve", "--port", "4096"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("could not start `{bin} serve`: {e}");
            push_log(&proc.logs, &app, msg.clone());
            msg
        })?;
    tracing::info!(bin = %bin, "started opencode serve");

    if let Some(out) = child.stdout.take() {
        let (logs, app2) = (proc.logs.clone(), app.clone());
        std::thread::spawn(move || pipe_reader(out, logs, app2));
    }
    if let Some(err) = child.stderr.take() {
        let (logs, app2) = (proc.logs.clone(), app.clone());
        std::thread::spawn(move || pipe_reader(err, logs, app2));
    }
    *guard = Some(child);
    Ok(())
}

/// Stop the opencode server Eridian started (no-op if we didn't start one).
#[tauri::command(async)]
pub fn stop_opencode(app: tauri::AppHandle, proc: State<OpenCodeProc>) -> Result<(), String> {
    if let Some(mut child) = proc.child.lock().unwrap().take() {
        let _ = child.kill();
        tracing::info!("stopped opencode serve");
        push_log(&proc.logs, &app, "— stopped by Eridian —".into());
    }
    Ok(())
}

/// The buffered server log (seeds the terminal view on open).
#[tauri::command(async)]
pub fn opencode_logs(proc: State<OpenCodeProc>) -> Vec<String> {
    proc.logs.lock().unwrap().clone()
}

/// Force-kill whatever process is listening on :4096 — for reclaiming an
/// orphaned/external opencode server so Eridian can manage its own. User-invoked
/// and explicit (the UI confirms first).
#[tauri::command(async)]
pub fn force_kill_opencode(proc: State<OpenCodeProc>) -> Result<(), String> {
    proc.kill_child(); // our own child, if any
    let out = Command::new("lsof")
        .args(["-ti", "tcp:4096", "-sTCP:LISTEN"])
        .output()
        .map_err(|e| format!("lsof: {e}"))?;
    let pids: Vec<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .split_whitespace()
        .collect();
    if pids.is_empty() {
        return Ok(());
    }
    for pid in pids {
        let _ = Command::new("kill").arg("-9").arg(pid).status();
    }
    tracing::info!("force-killed process(es) on :4096");
    Ok(())
}

/// Whether the currently-connected opencode server is one Eridian started (so we
/// can offer Stop only for our own child — never kill the user's own server).
#[tauri::command(async)]
pub fn opencode_managed(proc: State<OpenCodeProc>) -> bool {
    matches!(
        proc.child.lock().unwrap().as_mut().map(|c| c.try_wait()),
        Some(Ok(None))
    )
}

/// Locate the opencode binary. GUI apps often have a minimal PATH, so probe the
/// usual install locations before falling back to PATH resolution.
fn opencode_bin() -> String {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/opencode"));
        candidates.push(home.join(".opencode/bin/opencode"));
    }
    candidates.push("/opt/homebrew/bin/opencode".into());
    candidates.push("/usr/local/bin/opencode".into());
    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    "opencode".to_string()
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_capped_keeps_most_recent() {
        let mut buf = Vec::new();
        for i in 0..5 {
            push_capped(&mut buf, format!("l{i}"), 3);
        }
        assert_eq!(buf, vec!["l2", "l3", "l4"]); // oldest dropped, cap held
    }

    #[test]
    fn push_capped_under_cap_keeps_all() {
        let mut buf = vec!["a".to_string()];
        push_capped(&mut buf, "b".into(), 10);
        assert_eq!(buf, vec!["a", "b"]);
    }

    #[test]
    fn err_formats_anyhow_chain() {
        let e = anyhow::anyhow!("root").context("outer");
        let s = err(e);
        assert!(s.contains("outer") && s.contains("root"));
    }
}
