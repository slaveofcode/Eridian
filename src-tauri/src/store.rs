//! SQLite store: single-writer (`Mutex<Connection>`), migration runner, and the
//! write path that keeps the frontend live.
//!
//! Guardrails honored here:
//!   * DB file created 0600 (transcripts are sensitive).
//!   * All writes go through transactions; each `commit_batches` updates events +
//!     ingest offset atomically — offset and data can never disagree.
//!   * No event/message bodies are ever logged (paths, counts, offsets only).

use crate::commands::{EventRow, IngestStatus, SessionFilter, SessionRow};
use crate::normalize::NormalizedBatch;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_SQL: &str = include_str!("schema.sql");
// NOTE: stays 2. The `tool_use_id` column/index change to the (derived) events
// table is realized through the NORMALIZER_VERSION reset (drop+recreate), NOT
// through this gate — bumping it would re-run schema.sql against the *old*
// events table and the new index would fail on the missing column at open().
const SCHEMA_VERSION: i64 = 2;
/// Bumped whenever the normalizer's output changes. On mismatch the store clears
/// its (regenerable) cache of agent data and re-ingests — Eridian's DB is a
/// derived index, and re-deriving is cheaper than a bespoke data migration.
const NORMALIZER_VERSION: i64 = 6;
/// Internal ingest_state key holding the applied normalizer version.
const NORMALIZER_MARKER: &str = "__normalizer__";
/// First user-prompt text is truncated to this many chars for the session title.
const TITLE_MAX: usize = 80;
/// A shell command counts as "running" only in a session updated within this
/// window — bounds the live set and stops a crashed session spinning forever.
const RUNNING_WINDOW_SECS: i64 = 300;
/// Hard cap on a single command-history page (mirrors session_changes' cap).
const HISTORY_MAX: i64 = 400;
/// Command output is size-capped on read (never bulk-load a huge stdout).
const OUTPUT_CAP: usize = 20_000;

/// Cloneable handle to the single connection. Cheap to clone (Arc inside).
#[derive(Clone)]
pub struct Store {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    conn: Mutex<Connection>,
    /// Attached after the Tauri app is built so ingest tasks can push live updates.
    emitter: Mutex<Option<tauri::AppHandle>>,
    /// Live OpenCode server reachability, updated by the opencode ingest task.
    opencode_connected: std::sync::atomic::AtomicBool,
    db_path: Option<std::path::PathBuf>,
    settings: Mutex<Settings>,
    settings_path: Option<std::path::PathBuf>,
}

/// Payload for the `eridian://events-appended` live event (mirrors api.ts).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppendedPayload {
    pub session_id: String,
    pub events: Vec<EventRow>,
}

/// Payload for `eridian://ingest-progress` — drives the backfill progress banner.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IngestProgress {
    pub phase: String, // "backfilling" | "watching"
    pub files_done: usize,
    pub files_total: usize,
    pub events: i64,
    pub done: bool,
}

/// User-configurable settings, persisted to settings.json beside the DB.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Max transcript files to backfill (None = all).
    pub backfill_file_limit: Option<i64>,
    /// Retention: keep only the N most-recent sessions per agent (None = keep all).
    pub max_sessions_per_agent: Option<i64>,
    /// Opt-in: allow read-only GET fetches to the catalog allowlist (default off).
    pub catalog_fetch_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Bounded-but-generous defaults so the DB doesn't grow without limit,
        // while comfortably covering typical local histories.
        Self {
            backfill_file_limit: Some(2000),
            max_sessions_per_agent: Some(1000),
            catalog_fetch_enabled: false,
        }
    }
}

/// DB stats for the settings page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub path: String,
    pub size_bytes: i64,
    pub sessions: i64,
    pub events: i64,
}

impl Store {
    /// Open (creating if needed) the DB at `path`, enforce 0600, run migrations.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create db dir {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open db {}", path.display()))?;
        set_owner_only_perms(path);

        // foreign_keys is per-connection (not persisted) — set on every open.
        conn.pragma_update(None, "foreign_keys", "ON").ok();

        let settings_path = path.parent().map(|p| p.join("settings.json"));
        let settings = settings_path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        let store = Store {
            inner: std::sync::Arc::new(Inner {
                conn: Mutex::new(conn),
                emitter: Mutex::new(None),
                opencode_connected: std::sync::atomic::AtomicBool::new(false),
                db_path: Some(path.to_path_buf()),
                settings: Mutex::new(settings),
                settings_path,
            }),
        };
        store.migrate()?;
        store.reset_if_normalizer_changed()?;
        store.ensure_indexes()?;
        // WAL sidecar files can hold transcript data too — best-effort lock them down.
        set_owner_only_perms(&with_suffix(path, "-wal"));
        set_owner_only_perms(&with_suffix(path, "-shm"));
        Ok(store)
    }

    /// Open an in-memory DB (tests only).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let store = Store {
            inner: std::sync::Arc::new(Inner {
                conn: Mutex::new(conn),
                emitter: Mutex::new(None),
                opencode_connected: std::sync::atomic::AtomicBool::new(false),
                db_path: None,
                settings: Mutex::new(Settings::default()),
                settings_path: None,
            }),
        };
        store.migrate()?;
        Ok(store)
    }

    /// If the normalizer version changed since last run, drop the derived data
    /// (sessions/events/offsets) and re-create the schema so the next backfill
    /// re-ingests everything with current normalization. No-op when unchanged.
    fn reset_if_normalizer_changed(&self) -> Result<()> {
        let current = self.get_offset(NORMALIZER_MARKER)? as i64;
        if current == NORMALIZER_VERSION {
            return Ok(());
        }
        tracing::info!(
            from = current,
            to = NORMALIZER_VERSION,
            "normalizer changed — clearing derived cache for full re-ingest"
        );
        {
            let conn = self.lock();
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS events_ai;
                 DROP TRIGGER IF EXISTS events_ad;
                 DROP TABLE IF EXISTS events_fts;
                 DROP TABLE IF EXISTS events;
                 DROP TABLE IF EXISTS sessions;
                 DELETE FROM ingest_state;
                 PRAGMA user_version = 0;",
            )?;
        }
        self.migrate()?; // recreate schema fresh
        let conn = self.lock();
        conn.execute(
            "INSERT INTO ingest_state(source, byte_offset, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(source) DO UPDATE SET byte_offset = ?2, updated_at = ?3",
            params![NORMALIZER_MARKER, NORMALIZER_VERSION, crate::now_iso8601()],
        )?;
        Ok(())
    }

    /// Run migrations gated on `PRAGMA user_version`. schema.sql is idempotent
    /// (all `CREATE ... IF NOT EXISTS`) and bumps user_version to SCHEMA_VERSION.
    fn migrate(&self) -> Result<()> {
        let conn = self.lock();
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current >= SCHEMA_VERSION {
            return Ok(());
        }
        conn.execute_batch(SCHEMA_SQL)
            .context("apply schema.sql")?;
        let after: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        tracing::info!(from = current, to = after, "migrated db schema");
        Ok(())
    }

    /// Additive indexes that must exist even on DBs created before they were
    /// introduced (schema.sql only runs on a fresh/normalizer-reset DB). All
    /// `IF NOT EXISTS`, so this is a fast no-op once built.
    fn ensure_indexes(&self) -> Result<()> {
        let conn = self.lock();
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts) WHERE ts IS NOT NULL;",
        )
        .context("ensure indexes")?;
        Ok(())
    }

    /// Attach the app handle so the write path can emit live events.
    pub fn attach_emitter(&self, app: tauri::AppHandle) {
        *self.inner.emitter.lock().unwrap() = Some(app);
    }

    /// Record OpenCode server reachability (from the opencode ingest task).
    pub fn set_opencode_connected(&self, connected: bool) {
        self.inner
            .opencode_connected
            .store(connected, std::sync::atomic::Ordering::Relaxed);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // Mutex poisoning only happens if a holder panicked; recover the guard
        // rather than cascading the panic through the ingest loop.
        self.inner.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── ingest write path ────────────────────────────────────────────────────

    /// Byte offset last consumed for `source` (0 if never seen).
    pub fn get_offset(&self, source: &str) -> Result<u64> {
        let conn = self.lock();
        let off: Option<i64> = conn
            .query_row(
                "SELECT byte_offset FROM ingest_state WHERE source = ?1",
                params![source],
                |r| r.get(0),
            )
            .optional()?;
        Ok(off.unwrap_or(0).max(0) as u64)
    }

    /// Commit a group of normalized batches for one source in ONE transaction:
    /// upsert sessions, insert-or-ignore events, advance the ingest offset.
    /// Returns the events actually inserted (for the live emit).
    pub fn commit_batches(
        &self,
        source: &str,
        new_offset: u64,
        batches: Vec<NormalizedBatch>,
    ) -> Result<Vec<EventRow>> {
        let now = crate::now_iso8601();
        let mut inserted: Vec<EventRow> = Vec::new();
        {
            let mut conn = self.lock();
            let tx = conn.transaction()?;
            for batch in &batches {
                if let Some(s) = &batch.session {
                    upsert_session(&tx, s)?;
                }
                for ev in &batch.events {
                    if let Some(row) = insert_event(&tx, ev)? {
                        // Backfill session title from the first user prompt text.
                        if matches!(ev.kind, crate::normalize::EventKind::User) {
                            if let Some(text) = &ev.text {
                                backfill_title(&tx, &ev.session_id, text)?;
                            }
                        }
                        inserted.push(row);
                    }
                }
            }
            tx.execute(
                "INSERT INTO ingest_state(source, byte_offset, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(source) DO UPDATE SET byte_offset = ?2, updated_at = ?3",
                params![source, new_offset as i64, now],
            )?;
            conn2_commit(tx)?;
        }
        Ok(inserted)
    }

    /// Emit a backfill/watch progress update. No-op if no emitter attached.
    pub fn emit_progress(&self, progress: IngestProgress) {
        let guard = self.inner.emitter.lock().unwrap();
        if let Some(app) = guard.as_ref() {
            use tauri::Emitter;
            let _ = app.emit("eridian://ingest-progress", progress);
        }
    }

    /// Emit only the sessions-updated signal (list refetch), no timeline push.
    pub fn emit_sessions_updated(&self) {
        let guard = self.inner.emitter.lock().unwrap();
        if let Some(app) = guard.as_ref() {
            use tauri::Emitter;
            let _ = app.emit("eridian://sessions-updated", ());
        }
    }

    /// Emit live updates after a successful commit. No-op if no emitter attached.
    pub fn emit_appended(&self, inserted: Vec<EventRow>) {
        if inserted.is_empty() {
            return;
        }
        let guard = self.inner.emitter.lock().unwrap();
        let Some(app) = guard.as_ref() else { return };
        use tauri::Emitter;
        let _ = app.emit("eridian://sessions-updated", ());
        // Group by session for the timeline push.
        let mut by_session: std::collections::HashMap<String, Vec<EventRow>> =
            std::collections::HashMap::new();
        for ev in inserted {
            by_session.entry(ev.session_id.clone()).or_default().push(ev);
        }
        for (session_id, events) in by_session {
            let _ = app.emit(
                "eridian://events-appended",
                AppendedPayload { session_id, events },
            );
        }
    }

    // ── read path (commands) ──────────────────────────────────────────────────

    pub fn list_sessions(&self, filter: Option<SessionFilter>) -> Result<Vec<SessionRow>> {
        let f = filter.unwrap_or(SessionFilter {
            agent: None,
            project: None,
            include_subagents: None,
        });
        let include_subagents = f.include_subagents.unwrap_or(true);
        let conn = self.lock();
        // One aggregate pass over events (uses idx_events_session) instead of a
        // correlated COUNT per row — critical when there are 1000+ sessions.
        let mut sql = String::from(
            "SELECT s.id, s.agent, s.project_path, s.title, s.model, s.git_branch,
                    s.started_at, s.updated_at, s.is_subagent, s.parent_session_id,
                    s.source_alive,
                    COALESCE(ec.c, 0) AS event_count,
                    COALESCE(ec.ti, 0) AS tokens_in,
                    COALESCE(ec.toko, 0) AS tokens_out,
                    COALESCE(lt.last_ti, 0) AS context_tokens,
                    COALESCE(ec.pti, 0) AS peak_tokens_in
             FROM sessions s
             LEFT JOIN (SELECT session_id, COUNT(*) AS c,
                               SUM(COALESCE(tokens_in, 0))  AS ti,
                               SUM(COALESCE(tokens_out, 0)) AS toko,
                               MAX(COALESCE(tokens_in, 0))  AS pti
                        FROM events GROUP BY session_id) ec
               ON ec.session_id = s.id
             -- Context fill = the LATEST turn's input (bare-column + MAX(id) picks
             -- the row with the largest id among rows that have token usage). Using
             -- MAX(tokens_in) would report the all-time peak and never drop after a
             -- compaction, so it read ~100% for every long session.
             LEFT JOIN (SELECT session_id, tokens_in AS last_ti, MAX(id)
                        FROM events WHERE tokens_in IS NOT NULL
                        GROUP BY session_id) lt
               ON lt.session_id = s.id
             WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(agent) = &f.agent {
            sql.push_str(" AND s.agent = ?");
            args.push(Box::new(agent.clone()));
        }
        if let Some(project) = &f.project {
            sql.push_str(" AND s.project_path = ?");
            args.push(Box::new(project.clone()));
        }
        if !include_subagents {
            sql.push_str(" AND s.is_subagent = 0");
        }
        sql.push_str(" ORDER BY s.updated_at DESC");

        let now = crate::now_iso8601();
        let mut stmt = conn.prepare(&sql)?;
        let arg_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(arg_refs.as_slice(), |r| {
            let updated_at: Option<String> = r.get(7)?;
            Ok(SessionRow {
                id: r.get(0)?,
                agent: r.get(1)?,
                project_path: r.get(2)?,
                title: r.get(3)?,
                model: r.get(4)?,
                git_branch: r.get(5)?,
                started_at: r.get(6)?,
                updated_at: updated_at.clone(),
                is_subagent: r.get::<_, i64>(8)? != 0,
                parent_session_id: r.get(9)?,
                source_alive: r.get::<_, i64>(10)? != 0,
                event_count: r.get(11)?,
                tokens_in: r.get(12)?,
                tokens_out: r.get(13)?,
                context_tokens: r.get(14)?,
                peak_tokens_in: r.get(15)?,
                live: is_live(updated_at.as_deref(), &now),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Newest-first, paged. `before_id` = smallest id already held → page back.
    pub fn session_events(
        &self,
        session_id: &str,
        limit: i64,
        before_id: Option<i64>,
    ) -> Result<Vec<EventRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, ts, kind, role, text, tool_name,
                    tool_input_json, tool_result_json, tokens_in, tokens_out, tool_use_id
             FROM events
             WHERE session_id = ?1 AND (?2 IS NULL OR id < ?2)
             ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, before_id, limit], map_event_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Events centered on `event_id`: up to `before` rows at/preceding it plus
    /// `after` rows following it, chronological. Used by drill-in so a target
    /// event outside the recent window (e.g. a long-running command) is still
    /// loaded and can be scrolled to.
    pub fn session_events_around(
        &self,
        session_id: &str,
        event_id: i64,
        before: i64,
        after: i64,
    ) -> Result<Vec<EventRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, ts, kind, role, text, tool_name,
                    tool_input_json, tool_result_json, tokens_in, tokens_out, tool_use_id
             FROM (
               SELECT * FROM events
               WHERE session_id = ?1 AND id <= ?2 ORDER BY id DESC LIMIT ?3
             )
             UNION
             SELECT id, session_id, ts, kind, role, text, tool_name,
                    tool_input_json, tool_result_json, tokens_in, tokens_out, tool_use_id
             FROM (
               SELECT * FROM events
               WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?4
             )
             ORDER BY id",
        )?;
        let rows = stmt.query_map(
            params![session_id, event_id, before.max(1), after.max(0)],
            map_event_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Per-day token rollup across all sessions, most recent `days` days,
    /// returned chronologically. Days with no usage are simply absent.
    /// Per-day token totals. Optionally filtered to a single model or agent
    /// (for the "click a series to visualize it" chart). Only one filter is
    /// applied at a time — `model` takes precedence over `agent`.
    pub fn usage_by_day(
        &self,
        days: i64,
        model: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Vec<crate::commands::DayUsage>> {
        // Pick the single active filter column + value (fixed columns, not input).
        let filter: Option<(&str, &str)> = match (model, agent) {
            (Some(m), _) => Some(("s.model", m)),
            (None, Some(a)) => Some(("s.agent", a)),
            _ => None,
        };
        // Bound the scan to the window (uses idx_events_ts) instead of scanning
        // every event — the difference between ~0.1s and several seconds.
        let cutoff = {
            use chrono::{Duration, Utc};
            (Utc::now() - Duration::days(days.max(1)))
                .format("%Y-%m-%d")
                .to_string()
        };
        let conn = self.lock();
        let (join, cond) = match filter {
            Some((col, _)) => (" JOIN sessions s ON s.id = e.session_id", format!(" AND {col} = ?2")),
            None => ("", String::new()),
        };
        let sql = format!(
            "SELECT substr(e.ts, 1, 10) AS day,
                    SUM(COALESCE(e.tokens_in, 0))  AS ti,
                    SUM(COALESCE(e.tokens_out, 0)) AS toko
             FROM events e{join}
             WHERE e.ts >= ?1{cond}
             GROUP BY day
             HAVING ti > 0 OR toko > 0
             ORDER BY day"
        );
        let mut stmt = conn.prepare(&sql)?;
        let map = |r: &rusqlite::Row<'_>| {
            Ok(crate::commands::DayUsage {
                date: r.get(0)?,
                tokens_in: r.get(1)?,
                tokens_out: r.get(2)?,
            })
        };
        let rows: Vec<_> = match filter {
            Some((_, v)) => stmt
                .query_map(params![cutoff, v], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => stmt
                .query_map(params![cutoff], map)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows) // already chronological (ORDER BY day)
    }

    /// Token totals over the last `days`, broken down by model and by agent.
    /// Ranked by total tokens; capped so the UI stays bounded.
    pub fn usage_breakdown(&self, days: i64) -> Result<crate::commands::UsageBreakdown> {
        use chrono::{Duration, Utc};
        let cutoff = (Utc::now() - Duration::days(days.max(1)))
            .format("%Y-%m-%d")
            .to_string();
        let conn = self.lock();
        // `expr` is a fixed column expression (never user input) → safe to embed.
        let slice = |expr: &str| -> Result<Vec<crate::commands::UsageSlice>> {
            let sql = format!(
                "SELECT COALESCE(NULLIF({expr}, ''), 'unknown') AS k,
                        SUM(COALESCE(e.tokens_in, 0))  AS ti,
                        SUM(COALESCE(e.tokens_out, 0)) AS toko,
                        COUNT(DISTINCT e.session_id)   AS sess
                 FROM events e JOIN sessions s ON s.id = e.session_id
                 WHERE e.ts >= ?1 AND (e.tokens_in IS NOT NULL OR e.tokens_out IS NOT NULL)
                 GROUP BY k
                 HAVING ti > 0 OR toko > 0
                 ORDER BY (ti + toko) DESC
                 LIMIT 12"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([&cutoff], |r| {
                Ok(crate::commands::UsageSlice {
                    key: r.get(0)?,
                    tokens_in: r.get(1)?,
                    tokens_out: r.get(2)?,
                    sessions: r.get(3)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        };
        Ok(crate::commands::UsageBreakdown {
            by_model: slice("s.model")?,
            by_agent: slice("s.agent")?,
        })
    }

    /// Map of `oc:` session id → stored `updated_at` (for incremental cold-import
    /// skip: don't re-parse a session whose messages haven't changed).
    pub fn opencode_session_updated(&self) -> Result<std::collections::HashMap<String, String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(updated_at, '') FROM sessions WHERE agent = 'opencode'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn ingest_status(&self) -> Result<IngestStatus> {
        let conn = self.lock();
        let cc_files: i64 = conn.query_row(
            // Exclude the opencode cursor and internal markers (e.g. __normalizer__).
            "SELECT COUNT(*) FROM ingest_state
             WHERE source NOT LIKE 'opencode:%' AND source NOT GLOB '__*'",
            [],
            |r| r.get(0),
        )?;
        let cc_events: i64 = conn.query_row(
            "SELECT COUNT(*) FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE s.agent = 'claude-code'",
            [],
            |r| r.get(0),
        )?;
        let oc_events: i64 = conn.query_row(
            "SELECT COUNT(*) FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE s.agent = 'opencode'",
            [],
            |r| r.get(0),
        )?;
        let last_activity_at: Option<String> = conn
            .query_row("SELECT MAX(updated_at) FROM sessions", [], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(IngestStatus {
            claude_code_files: cc_files,
            claude_code_events: cc_events,
            opencode_connected: self
                .inner
                .opencode_connected
                .load(std::sync::atomic::Ordering::Relaxed),
            opencode_events: oc_events,
            last_activity_at,
        })
    }

    /// FTS5 search across both agents. Query is sanitized into a prefix MATCH
    /// so arbitrary user input never trips FTS syntax errors.
    pub fn search_events(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Vec<crate::commands::SearchResult>> {
        let Some(fts) = to_fts_query(query) else {
            return Ok(vec![]);
        };
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT e.id, e.session_id, s.agent, s.title, e.kind, e.ts,
                    snippet(events_fts, 0, '⟦', '⟧', '…', 12)
             FROM events_fts f
             JOIN events e ON e.id = f.rowid
             JOIN sessions s ON s.id = e.session_id
             WHERE events_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts, limit], |r| {
            let snippet: String = r.get(6)?;
            let kind: String = r.get(4)?;
            Ok(crate::commands::SearchResult {
                id: r.get(0)?,
                session_id: r.get(1)?,
                agent: r.get(2)?,
                session_title: r.get(3)?,
                kind,
                ts: r.get(5)?,
                snippet,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── change inspection (Part 3) ────────────────────────────────────────────

    /// Aggregate a session's tool calls into files changed + commands + risk.
    ///
    /// Max file rows returned (each carries diff previews — the heavy payload).
    /// The risk summary is still counted over ALL events, so chips stay accurate.
    pub fn session_changes(&self, session_id: &str) -> Result<crate::commands::SessionChanges> {
        const MAX_CHANGE_FILES: usize = 400;
        use crate::commands::*;
        use crate::inspect::{classify_tool, extract_file_change, FileOp, Risk};

        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT ts, tool_name, tool_input_json FROM events
             WHERE session_id = ?1 AND kind = 'tool_call' ORDER BY id",
        )?;
        struct Raw {
            ts: Option<String>,
            tool: String,
            input: Option<String>,
        }
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(Raw {
                ts: r.get(0)?,
                tool: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                input: r.get(2)?,
            })
        })?;

        // path → accumulator, preserving insertion order via a Vec of keys.
        struct Acc {
            writes: i64,
            edits: i64,
            reads: i64,
            last_ts: Option<String>,
            max_risk: Risk,
            changes: Vec<FileChangeDetail>,
        }
        let mut files: std::collections::HashMap<String, Acc> = std::collections::HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut commands: Vec<CommandRow> = Vec::new();
        let mut summary = RiskSummary::default();

        for row in rows {
            let Raw { ts, tool, input } = row?;
            let val: serde_json::Value = input
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::Value::Null);

            let (risk, reason) = classify_tool(&tool, &val);
            match risk {
                Risk::Danger => summary.danger += 1,
                Risk::Notable => summary.notable += 1,
                Risk::Safe => summary.safe += 1,
            }

            let tl = tool.to_lowercase();
            if matches!(tl.as_str(), "bash" | "shell" | "run") {
                if let Some(cmd) = val
                    .get("command")
                    .or_else(|| val.get("cmd"))
                    .or_else(|| val.get("script"))
                    .and_then(|v| v.as_str())
                {
                    commands.push(CommandRow {
                        command: cmd.to_string(),
                        ts: ts.clone(),
                        risk: risk.as_str().to_string(),
                        reason,
                    });
                }
            }

            if let Some(fc) = extract_file_change(&tool, &val) {
                let acc = files.entry(fc.path.clone()).or_insert_with(|| {
                    order.push(fc.path.clone());
                    Acc {
                        writes: 0,
                        edits: 0,
                        reads: 0,
                        last_ts: None,
                        max_risk: Risk::Safe,
                        changes: Vec::new(),
                    }
                });
                match fc.op {
                    FileOp::Write => acc.writes += 1,
                    FileOp::Edit => acc.edits += 1,
                    FileOp::Read => acc.reads += 1,
                }
                if risk.rank() > acc.max_risk.rank() {
                    acc.max_risk = risk;
                }
                if ts.is_some() {
                    acc.last_ts = ts.clone();
                }
                // newest kept at front, cap per file
                acc.changes.insert(
                    0,
                    FileChangeDetail {
                        op: fc.op.as_str().to_string(),
                        ts: ts.clone(),
                        preview: fc.preview,
                        risk: risk.as_str().to_string(),
                    },
                );
                acc.changes.truncate(8);
            }
        }

        let mut file_rows: Vec<FileChangeRow> = order
            .into_iter()
            .filter_map(|p| files.remove(&p).map(|a| (p, a)))
            .map(|(path, a)| FileChangeRow {
                path,
                writes: a.writes,
                edits: a.edits,
                reads: a.reads,
                last_ts: a.last_ts,
                risk: a.max_risk.as_str().to_string(),
                changes: a.changes,
            })
            .collect();
        // Highest-risk first, then most-recently-touched — so the cap keeps the
        // files worth reviewing even on huge sessions.
        file_rows.sort_by(|a, b| {
            crate::inspect::Risk::rank_str(&b.risk)
                .cmp(&crate::inspect::Risk::rank_str(&a.risk))
                .then_with(|| b.last_ts.cmp(&a.last_ts))
        });
        commands.reverse(); // newest first

        // Cap the returned payload — files carry per-change diff previews, so a
        // 50k-event session can otherwise ship megabytes over IPC and freeze the
        // UI on deserialize/render. Risk summary above is counted over ALL events,
        // so the chips stay accurate; totals let the UI show "of N".
        let files_total = file_rows.len() as i64;
        let commands_total = commands.len() as i64;
        file_rows.truncate(MAX_CHANGE_FILES);

        Ok(SessionChanges {
            files: file_rows,
            commands,
            risk: summary,
            files_total,
            commands_total,
        })
    }

    /// Skills and slash-commands executed in a session, most-run first. Skills
    /// (Skill tool) are reliable; commands (`<command-name>` tag) are heuristic.
    pub fn session_skills(&self, session_id: &str) -> Result<Vec<crate::commands::SkillRun>> {
        use crate::inspect::{detect_command_run, detect_skill_run};
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT ts, kind, text, tool_name, tool_input_json FROM events
             WHERE session_id = ?1 ORDER BY id",
        )?;
        struct Raw {
            ts: Option<String>,
            kind: String,
            text: Option<String>,
            tool: Option<String>,
            input: Option<String>,
        }
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(Raw {
                ts: r.get(0)?,
                kind: r.get(1)?,
                text: r.get(2)?,
                tool: r.get(3)?,
                input: r.get(4)?,
            })
        })?;
        // Aggregate by (kind, name): first ts + run count, insertion order kept.
        let mut order: Vec<(String, String)> = Vec::new();
        let mut agg: std::collections::HashMap<(String, String), (Option<String>, i64)> =
            std::collections::HashMap::new();
        let mut bump = |kind: &str, name: String, ts: Option<String>| {
            let key = (kind.to_string(), name);
            let e = agg.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                (ts.clone(), 0)
            });
            e.1 += 1;
        };
        for row in rows {
            let Raw { ts, kind, text, tool, input } = row?;
            if kind == "tool_call" {
                if let Some(tool) = &tool {
                    let val: serde_json::Value = input
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(serde_json::Value::Null);
                    if let Some(skill) = detect_skill_run(tool, &val) {
                        bump("skill", skill, ts.clone());
                    }
                }
            }
            if let Some(text) = &text {
                if let Some(cmd) = detect_command_run(text) {
                    bump("command", cmd, ts.clone());
                }
            }
        }
        let mut out: Vec<crate::commands::SkillRun> = order
            .into_iter()
            .map(|key| {
                let (ts, count) = agg.remove(&key).unwrap();
                crate::commands::SkillRun { kind: key.0, name: key.1, ts, count }
            })
            .collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.count));
        Ok(out)
    }

    /// Fill a tool call's result (OpenCode running→finished) — monotonic: only sets
    /// a result on a row that has none, never overwrites. Returns whether a row
    /// changed. Writes Eridian's own DB only.
    pub fn update_tool_completion(
        &self,
        session_id: &str,
        tool_use_id: &str,
        result_json: &str,
    ) -> Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE events SET tool_result_json = ?3
             WHERE session_id = ?1 AND tool_use_id = ?2 AND kind = 'tool_call'
               AND tool_result_json IS NULL",
            params![session_id, tool_use_id, result_json],
        )?;
        Ok(n > 0)
    }

    /// In-flight shell commands across live/recent sessions (bounded).
    pub fn running_commands(&self) -> Result<Vec<crate::commands::RunningCommandRow>> {
        use crate::inspect::classify_command;
        use crate::shell::command_of;
        let cutoff = {
            use chrono::{Duration, Utc};
            (Utc::now() - Duration::seconds(RUNNING_WINDOW_SECS)).to_rfc3339()
        };
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.session_id, s.agent, s.title, c.tool_input_json, c.ts
             FROM events c JOIN sessions s ON s.id = c.session_id
             WHERE c.kind = 'tool_call'
               AND lower(c.tool_name) IN ('bash','shell','run')
               AND c.tool_use_id IS NOT NULL
               AND c.tool_result_json IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM events r
                 WHERE r.session_id = c.session_id AND r.kind = 'tool_result'
                   AND r.tool_use_id = c.tool_use_id)
               AND s.updated_at >= ?1
             ORDER BY c.ts DESC",
        )?;
        let raw = stmt
            .query_map(params![cutoff], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(raw
            .into_iter()
            .filter_map(|(id, sid, agent, title, input, ts)| {
                let command = command_of(input.as_deref())?;
                let (risk, _) = classify_command(&command);
                Some(crate::commands::RunningCommandRow {
                    event_id: id,
                    session_id: sid,
                    agent,
                    session_title: title,
                    command,
                    risk: risk.as_str().to_string(),
                    started_at: ts,
                })
            })
            .collect())
    }

    /// Finished shell commands, newest-first, keyset-paged by event id.
    pub fn command_history(
        &self,
        before_id: Option<i64>,
        limit: i64,
    ) -> Result<crate::commands::CommandHistoryPage> {
        use crate::inspect::classify_command;
        use crate::shell::{command_of, duration_secs};
        let lim = limit.clamp(1, HISTORY_MAX);
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.session_id, s.agent, c.tool_input_json, c.ts, r.ts AS result_ts
             FROM events c JOIN sessions s ON s.id = c.session_id
             LEFT JOIN events r ON r.session_id = c.session_id AND r.kind = 'tool_result'
                                AND r.tool_use_id = c.tool_use_id
             WHERE c.kind = 'tool_call'
               AND lower(c.tool_name) IN ('bash','shell','run')
               AND c.tool_use_id IS NOT NULL
               AND (c.tool_result_json IS NOT NULL OR r.id IS NOT NULL)
               AND (?1 IS NULL OR c.id < ?1)
             ORDER BY c.id DESC
             LIMIT ?2",
        )?;
        let raw = stmt
            .query_map(params![before_id, lim], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut rows = Vec::new();
        for (id, sid, agent, input, start_ts, result_ts) in raw {
            let Some(command) = command_of(input.as_deref()) else { continue };
            let (risk, _) = classify_command(&command);
            rows.push(crate::commands::CommandHistoryRow {
                event_id: id,
                session_id: sid,
                agent,
                command,
                risk: risk.as_str().to_string(),
                status: "ok".to_string(),
                duration_secs: duration_secs(start_ts.as_deref(), result_ts.as_deref()),
                started_at: start_ts,
            });
        }
        let next_before_id = (rows.len() as i64 == lim)
            .then(|| rows.last().map(|r| r.event_id))
            .flatten();
        Ok(crate::commands::CommandHistoryPage { rows, next_before_id })
    }

    /// One command's output (size-capped), lazily. CC: the paired tool_result
    /// event's body; OC: the call row's own tool_result_json.
    pub fn command_output(&self, event_id: i64) -> Result<Option<String>> {
        let conn = self.lock();
        let out: Option<String> = conn
            .query_row(
                "SELECT COALESCE(
                     c.tool_result_json,
                     (SELECT r.tool_result_json FROM events r
                      WHERE r.session_id = c.session_id AND r.kind = 'tool_result'
                        AND r.tool_use_id = c.tool_use_id
                      ORDER BY r.id LIMIT 1))
                 FROM events c WHERE c.id = ?1",
                params![event_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(out.map(|s: String| {
            if s.len() > OUTPUT_CAP {
                let mut t: String = s.chars().take(OUTPUT_CAP).collect();
                t.push_str("\n… (truncated)");
                t
            } else {
                s
            }
        }))
    }

    /// The real subagents of `session_id` — sessions whose parent_session_id links
    /// back to it (the sidechain's own `sessionId` field is its parent, a hard
    /// link from the transcript). Activity is clipped to the parent's window for
    /// the flow graph.
    pub fn session_subagents(&self, session_id: &str) -> Result<Vec<crate::commands::SubagentLink>> {
        let conn = self.lock();
        let (win_start, win_end): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT started_at, updated_at FROM sessions WHERE id = ?1",
                params![session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));

        let mut stmt = conn.prepare(
            "SELECT s.id, s.agent, s.title,
                    (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id)
             FROM sessions s
             WHERE s.parent_session_id = ?1",
        )?;
        let children: Vec<(String, String, Option<String>, i64)> = stmt
            .query_map(params![session_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let now = crate::now_iso8601();
        let mut out = Vec::new();
        for (id, agent, title, event_count) in children {
            // Clip this child's activity to the parent's window (falls back to the
            // child's full span when the parent has no timestamps).
            let (ws, we, n): (Option<String>, Option<String>, i64) = match (&win_start, &win_end) {
                (Some(a), Some(b)) => conn.query_row(
                    "SELECT MIN(ts), MAX(ts), COUNT(*) FROM events
                     WHERE session_id = ?1 AND ts IS NOT NULL AND ts >= ?2 AND ts <= ?3",
                    params![id, a, b],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?,
                _ => conn.query_row(
                    "SELECT MIN(ts), MAX(ts), COUNT(*) FROM events
                     WHERE session_id = ?1 AND ts IS NOT NULL",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?,
            };
            out.push(crate::commands::SubagentLink {
                id,
                agent,
                title,
                event_count,
                window_start: ws,
                window_end: we.clone(),
                events_in_window: n,
                live: is_live(we.as_deref(), &now),
            });
        }
        out.sort_by(|a, b| a.window_start.cmp(&b.window_start));
        Ok(out)
    }

    /// Sessions that have ≥1 subagent (by the real parent link), for list badges.
    pub fn subagent_parents(&self) -> Result<Vec<crate::commands::SubagentParent>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT parent_session_id, COUNT(*)
             FROM sessions
             WHERE parent_session_id IS NOT NULL
             GROUP BY parent_session_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::commands::SubagentParent {
                session_id: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── settings / DB management ──────────────────────────────────────────────

    pub fn settings(&self) -> Settings {
        self.inner.settings.lock().unwrap().clone()
    }

    /// Whether opt-in read-only catalog fetches are enabled (default false).
    pub fn catalog_fetch_enabled(&self) -> bool {
        self.inner.settings.lock().unwrap().catalog_fetch_enabled
    }

    pub fn backfill_file_limit(&self) -> Option<usize> {
        self.inner
            .settings
            .lock()
            .unwrap()
            .backfill_file_limit
            .filter(|n| *n > 0)
            .map(|n| n as usize)
    }

    /// Persist settings (0600) and apply retention immediately.
    pub fn set_settings(&self, s: Settings) -> Result<Settings> {
        *self.inner.settings.lock().unwrap() = s.clone();
        if let Some(p) = &self.inner.settings_path {
            std::fs::write(p, serde_json::to_string_pretty(&s)?)
                .with_context(|| format!("write {}", p.display()))?;
            set_owner_only_perms(p);
        }
        self.enforce_retention()?;
        Ok(s)
    }

    /// The app-data directory (parent of the DB file). `None` for in-memory DBs.
    /// The catalog cache lives under here — never under an agent's directory.
    pub fn app_data_dir(&self) -> Option<std::path::PathBuf> {
        self.inner
            .db_path
            .as_ref()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
    }

    pub fn db_info(&self) -> Result<DbInfo> {
        let path = self
            .inner
            .db_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| ":memory:".into());
        let size_bytes = self
            .inner
            .db_path
            .as_ref()
            .map(|p| {
                let main = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                let wal = std::fs::metadata(with_suffix(p, "-wal"))
                    .map(|m| m.len())
                    .unwrap_or(0);
                (main + wal) as i64
            })
            .unwrap_or(0);
        let conn = self.lock();
        let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?;
        let events: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(DbInfo {
            path,
            size_bytes,
            sessions,
            events,
        })
    }

    /// Retention: keep only the N most-recent sessions per agent (deleting the
    /// rest and their events). No-op if unset. Pruned sessions stay pruned until
    /// their source file grows (offsets aren't reset), which is the desired
    /// behavior.
    pub fn enforce_retention(&self) -> Result<usize> {
        let Some(max) = self.inner.settings.lock().unwrap().max_sessions_per_agent else {
            return Ok(0);
        };
        if max <= 0 {
            return Ok(0);
        }

        // Cheap early-out: window over sessions only (~1k rows). Nothing over the
        // cap → return without touching the (large) events table.
        let ids: Vec<String> = {
            let conn = self.lock();
            let mut stmt = conn.prepare(
                "SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (PARTITION BY agent ORDER BY updated_at DESC) rn
                   FROM sessions
                 ) WHERE rn > ?1",
            )?;
            let rows = stmt.query_map(params![max], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        if ids.is_empty() {
            return Ok(0);
        }

        // Delete each pruned session's events in bounded chunks, committing per
        // chunk and RELEASING the connection lock between chunks. A single big
        // session (tens of thousands of events × FTS delete triggers) would
        // otherwise hold the lock for seconds and freeze every UI read.
        for id in &ids {
            loop {
                let mut conn = self.lock();
                let tx = conn.transaction()?;
                let deleted = tx.execute(
                    "DELETE FROM events WHERE id IN (
                       SELECT id FROM events WHERE session_id = ?1 LIMIT 4000)",
                    params![id],
                )?;
                conn2_commit(tx)?;
                drop(conn); // yield the lock so UI queries can interleave
                if deleted == 0 {
                    break;
                }
            }
            let conn = self.lock();
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        }
        tracing::info!(pruned = ids.len(), max, "retention prune");
        Ok(ids.len())
    }

    /// Reconcile the archive flag: flip `source_alive` to 0 for claude-code
    /// sessions whose transcript file no longer exists on disk (and back to 1
    /// if it reappears). Proves the durability story — Eridian keeps the data
    /// after the agent purges its source. Only writes rows that actually change.
    /// Returns the number of rows updated.
    pub fn reconcile_source_alive(&self) -> Result<usize> {
        // Read the session list under the lock, then RELEASE it before touching
        // the filesystem — otherwise ~1000 stat() calls run while holding the
        // single connection, blocking every UI query (main thread freeze).
        let rows: Vec<(String, String, i64)> = {
            let conn = self.lock();
            let mut stmt = conn.prepare(
                "SELECT id, source_ref, source_alive FROM sessions
                 WHERE agent = 'claude-code' AND source_ref IS NOT NULL",
            )?;
            let r = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            r.collect::<rusqlite::Result<_>>()?
        };
        // Filesystem checks with NO lock held.
        let updates: Vec<(String, i64)> = rows
            .into_iter()
            .filter_map(|(id, path, alive)| {
                let want = if std::path::Path::new(&path).exists() { 1 } else { 0 };
                (want != alive).then_some((id, want))
            })
            .collect();
        if updates.is_empty() {
            return Ok(0);
        }
        // Re-acquire only to write the (few) changed rows.
        let conn = self.lock();
        for (id, want) in &updates {
            conn.execute(
                "UPDATE sessions SET source_alive = ?1 WHERE id = ?2",
                params![want, id],
            )?;
        }
        tracing::info!(changed = updates.len(), "archive reconcile");
        Ok(updates.len())
    }

    /// Wipe all derived data (sessions/events/offsets) so a fresh backfill
    /// re-ingests everything. Used by the Settings "rebuild" action.
    pub fn clear_all(&self) -> Result<()> {
        {
            let conn = self.lock();
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS events_ai;
                 DROP TRIGGER IF EXISTS events_ad;
                 DROP TABLE IF EXISTS events_fts;
                 DROP TABLE IF EXISTS events;
                 DROP TABLE IF EXISTS sessions;
                 DELETE FROM ingest_state;
                 PRAGMA user_version = 0;",
            )?;
        }
        self.migrate()?;
        // Preserve the normalizer marker so open() doesn't double-reset later.
        let conn = self.lock();
        conn.execute(
            "INSERT INTO ingest_state(source, byte_offset, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(source) DO UPDATE SET byte_offset = ?2, updated_at = ?3",
            params![NORMALIZER_MARKER, NORMALIZER_VERSION, crate::now_iso8601()],
        )?;
        Ok(())
    }

    /// Per-minute activity buckets (total events + tool events) for a session.
    pub fn session_activity(&self, session_id: &str) -> Result<Vec<crate::commands::ActivityBucket>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT substr(ts,1,16) AS bucket,
                    COUNT(*) AS total,
                    SUM(CASE WHEN kind IN ('tool_call','tool_result') THEN 1 ELSE 0 END) AS tools
             FROM events
             WHERE session_id = ?1 AND ts IS NOT NULL AND ts != ''
             GROUP BY bucket ORDER BY bucket",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(crate::commands::ActivityBucket {
                ts: r.get(0)?,
                total: r.get(1)?,
                tools: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

// ── row helpers ────────────────────────────────────────────────────────────

fn map_event_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        ts: r.get(2)?,
        kind: r.get(3)?,
        role: r.get(4)?,
        text: r.get(5)?,
        tool_name: r.get(6)?,
        tool_input_json: r.get(7)?,
        tool_result_json: r.get(8)?,
        tokens_in: r.get(9)?,
        tokens_out: r.get(10)?,
        tool_use_id: r.get(11)?,
    })
}

fn upsert_session(
    tx: &rusqlite::Transaction<'_>,
    s: &crate::normalize::NormalizedSession,
) -> Result<()> {
    // Merge semantics: last non-None wins; started_at keeps the earliest.
    tx.execute(
        "INSERT INTO sessions(
             id, agent, project_path, title, model, git_branch,
             started_at, updated_at, is_subagent, parent_session_id, source_ref, source_alive)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1)
         ON CONFLICT(id) DO UPDATE SET
             project_path      = COALESCE(excluded.project_path, sessions.project_path),
             title             = COALESCE(excluded.title, sessions.title),
             model             = COALESCE(excluded.model, sessions.model),
             git_branch        = COALESCE(excluded.git_branch, sessions.git_branch),
             started_at        = MIN(COALESCE(sessions.started_at, excluded.started_at),
                                     COALESCE(excluded.started_at, sessions.started_at)),
             updated_at        = MAX(COALESCE(sessions.updated_at, excluded.updated_at),
                                     COALESCE(excluded.updated_at, sessions.updated_at)),
             is_subagent       = MAX(sessions.is_subagent, excluded.is_subagent),
             parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
             source_ref        = COALESCE(excluded.source_ref, sessions.source_ref)",
        params![
            s.id,
            s.agent.as_str(),
            s.project_path,
            s.title,
            s.model,
            s.git_branch,
            // Bind NULL (not now()) when a line has no timestamp — control lines
            // must never bump a session's recency during backfill.
            s.started_at,
            s.updated_at,
            s.is_subagent as i64,
            s.parent_session_id,
            s.source_ref,
        ],
    )?;
    Ok(())
}

/// Insert an event, honoring the idempotency index. Returns the row (with its
/// assigned id) when a new row was inserted, or None when it was a duplicate.
fn insert_event(
    tx: &rusqlite::Transaction<'_>,
    ev: &crate::normalize::NormalizedEvent,
) -> Result<Option<EventRow>> {
    let changed = tx.execute(
        "INSERT OR IGNORE INTO events(
             session_id, ts, kind, role, text, tool_name,
             tool_input_json, tool_result_json, tokens_in, tokens_out,
             source_uuid, parent_uuid, raw_json, tool_use_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            ev.session_id,
            ev.ts,
            ev.kind.as_str(),
            ev.role,
            ev.text,
            ev.tool_name,
            ev.tool_input_json,
            ev.tool_result_json,
            ev.tokens_in,
            ev.tokens_out,
            ev.source_uuid,
            ev.parent_uuid,
            ev.raw_json,
            ev.tool_use_id,
        ],
    )?;
    if changed == 0 {
        return Ok(None); // duplicate absorbed by uq_events_source
    }
    let id = tx.last_insert_rowid();
    Ok(Some(EventRow {
        id,
        session_id: ev.session_id.clone(),
        ts: ev.ts.clone(),
        kind: ev.kind.as_str().to_string(),
        role: ev.role.clone(),
        text: ev.text.clone(),
        tool_name: ev.tool_name.clone(),
        tool_input_json: ev.tool_input_json.clone(),
        tool_result_json: ev.tool_result_json.clone(),
        tokens_in: ev.tokens_in,
        tokens_out: ev.tokens_out,
        tool_use_id: ev.tool_use_id.clone(),
    }))
}

/// Set the session title from the first user prompt if not already set.
fn backfill_title(tx: &rusqlite::Transaction<'_>, session_id: &str, text: &str) -> Result<()> {
    let title = truncate_title(text);
    tx.execute(
        "UPDATE sessions SET title = ?2
         WHERE id = ?1 AND (title IS NULL OR title = '')",
        params![session_id, title],
    )?;
    Ok(())
}

fn truncate_title(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= TITLE_MAX {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(TITLE_MAX).collect();
    out.push('…');
    out
}

/// A session is "live" if it was updated within the last 60 seconds.
fn is_live(updated_at: Option<&str>, now_iso: &str) -> bool {
    use chrono::{DateTime, Utc};
    let (Some(u), Ok(now)) = (updated_at, now_iso.parse::<DateTime<Utc>>()) else {
        return false;
    };
    match u.parse::<DateTime<Utc>>() {
        Ok(t) => (now - t).num_seconds().abs() < 60,
        Err(_) => false,
    }
}

fn conn2_commit(tx: rusqlite::Transaction<'_>) -> Result<()> {
    tx.commit()?;
    Ok(())
}

/// Sanitize free text into a safe FTS5 prefix MATCH query (implicit AND across
/// terms). Returns None when there's nothing searchable.
fn to_fts_query(input: &str) -> Option<String> {
    let mut terms = Vec::new();
    for tok in input.split_whitespace() {
        let cleaned: String = tok
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !cleaned.is_empty() {
            terms.push(format!("{cleaned}*"));
        }
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

/// Best-effort chmod 0600 (unix). No-op elsewhere / if the file doesn't exist.
fn set_owner_only_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::*;

    fn ev(session: &str, kind: EventKind, uuid: Option<&str>, text: Option<&str>) -> NormalizedEvent {
        NormalizedEvent {
            session_id: session.to_string(),
            ts: Some("2026-08-08T00:00:00Z".to_string()),
            kind,
            role: Some("user".to_string()),
            text: text.map(String::from),
            tool_name: None,
            tool_input_json: None,
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: uuid.map(String::from),
            parent_uuid: None,
            tool_use_id: None,
            raw_json: "{}".to_string(),
        }
    }

    fn session(id: &str) -> NormalizedSession {
        NormalizedSession {
            id: id.to_string(),
            agent: AgentKind::ClaudeCode,
            project_path: Some("/tmp/proj".to_string()),
            title: None,
            model: Some("claude-x".to_string()),
            git_branch: Some("main".to_string()),
            started_at: Some("2026-08-08T00:00:00Z".to_string()),
            updated_at: Some("2026-08-08T00:00:00Z".to_string()),
            is_subagent: false,
            parent_session_id: None,
            source_ref: Some("/path/to.jsonl".to_string()),
        }
    }

    fn cc_bash_call(session: &str, uuid: &str, id: &str, cmd: &str, ts: &str) -> NormalizedEvent {
        let mut e = ev(session, EventKind::ToolCall, Some(uuid), None);
        e.ts = Some(ts.into());
        e.tool_name = Some("Bash".into());
        e.tool_input_json = Some(format!(r#"{{"command":"{cmd}"}}"#));
        e.tool_use_id = Some(id.into());
        e
    }
    fn cc_result(session: &str, uuid: &str, id: &str, ts: &str) -> NormalizedEvent {
        let mut e = ev(session, EventKind::ToolResult, Some(uuid), None);
        e.ts = Some(ts.into());
        e.tool_result_json = Some(r#""done""#.into());
        e.tool_use_id = Some(id.into());
        e
    }

    #[test]
    fn history_lists_finished_commands_with_duration() {
        let store = Store::open_in_memory().unwrap();
        let s = session("cc:s1");
        let call = cc_bash_call("cc:s1", "a1", "toolu_1", "git status", "2026-08-11T00:00:00Z");
        let res = cc_result("cc:s1", "u1", "toolu_1", "2026-08-11T00:00:04Z");
        store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(s), events: vec![call, res] }])
            .unwrap();
        let page = store.command_history(None, 50).unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].command, "git status");
        assert_eq!(page.rows[0].duration_secs, Some(4));
    }

    #[test]
    fn running_excludes_finished_and_stale() {
        let store = Store::open_in_memory().unwrap();
        let mut live = session("cc:live");
        live.updated_at = Some(crate::now_iso8601());
        let call = cc_bash_call("cc:live", "a1", "toolu_1", "cargo test", &crate::now_iso8601());
        store
            .commit_batches("/f1", 1, vec![NormalizedBatch { session: Some(live), events: vec![call] }])
            .unwrap();
        assert_eq!(store.running_commands().unwrap().len(), 1);

        let mut stale = session("cc:stale");
        stale.updated_at = Some("2020-01-01T00:00:00Z".into());
        let old = cc_bash_call("cc:stale", "a2", "toolu_2", "sleep 999", "2020-01-01T00:00:00Z");
        store
            .commit_batches("/f2", 1, vec![NormalizedBatch { session: Some(stale), events: vec![old] }])
            .unwrap();
        assert!(store.running_commands().unwrap().iter().all(|r| r.session_id != "cc:stale"));
    }

    #[test]
    fn command_output_returns_paired_result() {
        let store = Store::open_in_memory().unwrap();
        let s = session("cc:s1");
        let call = cc_bash_call("cc:s1", "a1", "toolu_1", "ls", "2026-08-11T00:00:00Z");
        let res = cc_result("cc:s1", "u1", "toolu_1", "2026-08-11T00:00:01Z");
        let saved = store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(s), events: vec![call, res] }])
            .unwrap();
        let call_id = saved.iter().find(|e| e.kind == "tool_call").unwrap().id;
        let out = store.command_output(call_id).unwrap().unwrap();
        assert!(out.contains("done"));
    }

    #[test]
    fn update_tool_completion_fills_result_once() {
        let store = Store::open_in_memory().unwrap();
        let mut s = session("oc:s1");
        s.agent = AgentKind::OpenCode;
        s.updated_at = Some(crate::now_iso8601());
        let mut call = ev("oc:s1", EventKind::ToolCall, Some("m#0"), None);
        call.ts = Some(crate::now_iso8601());
        call.tool_name = Some("bash".into());
        call.tool_input_json = Some(r#"{"command":"ls"}"#.into());
        call.tool_use_id = Some("call_9".into());
        store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(s), events: vec![call] }])
            .unwrap();

        // Running: no result yet.
        assert!(store.running_commands().unwrap().iter().any(|r| r.session_id == "oc:s1"));

        // Terminal re-pull fills the output → now finished.
        assert!(store.update_tool_completion("oc:s1", "call_9", "a\nb").unwrap());
        assert!(store.running_commands().unwrap().is_empty());
        // Idempotent: already has a result → no further change.
        assert!(!store.update_tool_completion("oc:s1", "call_9", "a\nb").unwrap());
    }

    #[test]
    fn session_events_around_includes_an_old_target() {
        let store = Store::open_in_memory().unwrap();
        let s = session("cc:s1");
        // 50 events; the target is #5 (old), far from the tail.
        let mut evs = Vec::new();
        for i in 0..50 {
            evs.push(ev("cc:s1", EventKind::Assistant, Some(&format!("u{i}")), Some("x")));
        }
        let saved = store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(s), events: evs }])
            .unwrap();
        let target = saved[5].id;
        // A small "recent" window would miss it; around() must include it.
        let around = store.session_events_around("cc:s1", target, 3, 3).unwrap();
        assert!(around.iter().any(|e| e.id == target), "target must be in the window");
        assert!(around.len() <= 7, "window is bounded (before+after+target)");
    }

    #[test]
    fn opens_and_upgrades_an_existing_pre_tool_use_id_db() {
        // Reproduces the open() panic: an existing on-disk DB at user_version=2
        // with an OLD events table (no tool_use_id) and normalizer marker 4 must
        // upgrade cleanly — the NORMALIZER_VERSION reset drops+recreates events
        // with the new column. (Bumping SCHEMA_VERSION instead re-ran schema.sql
        // against the old table and the new index failed on the missing column.)
        let dir = std::env::temp_dir().join(format!("eridian_regress_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("old.db");
        let _ = std::fs::remove_file(&db);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions(id TEXT PRIMARY KEY, agent TEXT NOT NULL, updated_at TEXT);
                 CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
                     kind TEXT NOT NULL, tool_name TEXT, tool_input_json TEXT,
                     tool_result_json TEXT, raw_json TEXT NOT NULL);
                 CREATE TABLE ingest_state(source TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL
                     DEFAULT 0, meta_json TEXT, updated_at TEXT NOT NULL);
                 INSERT INTO ingest_state(source, byte_offset, updated_at)
                     VALUES ('__normalizer__', 4, '2026-01-01T00:00:00Z');
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        }
        let store = Store::open(&db).expect("open must upgrade, not panic");
        let conn = store.lock();
        let has_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('events') WHERE name = 'tool_use_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_col, 1, "events table should have tool_use_id after upgrade");
        drop(conn);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn usage_breakdown_groups_by_model_and_agent() {
        let store = Store::open_in_memory().unwrap();
        let now = crate::now_iso8601();
        let mk = |id: &str, agent: AgentKind, model: &str, tin: i64, tout: i64| {
            let mut s = session(id);
            s.agent = agent;
            s.model = Some(model.into());
            let mut e = ev(id, EventKind::Assistant, Some(&format!("{id}u")), Some("x"));
            e.ts = Some(now.clone());
            e.tokens_in = Some(tin);
            e.tokens_out = Some(tout);
            NormalizedBatch { session: Some(s), events: vec![e] }
        };
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    mk("cc:a", AgentKind::ClaudeCode, "claude-opus-4-8", 100, 10),
                    mk("cc:b", AgentKind::ClaudeCode, "claude-opus-4-8", 50, 5),
                    mk("oc:c", AgentKind::OpenCode, "gpt-x", 30, 3),
                ],
            )
            .unwrap();
        let b = store.usage_breakdown(30).unwrap();
        // by model: opus (150/15) ranks above gpt-x (30/3).
        assert_eq!(b.by_model[0].key, "claude-opus-4-8");
        assert_eq!(b.by_model[0].tokens_in, 150);
        assert_eq!(b.by_model[0].sessions, 2);
        // by agent: claude-code (150/15) above opencode (30/3).
        assert_eq!(b.by_agent[0].key, "claude-code");
        assert_eq!(b.by_agent[0].tokens_in, 150);

        // Daily usage filtered to one model sums only that model's events.
        let opus = store.usage_by_day(30, Some("claude-opus-4-8"), None).unwrap();
        assert_eq!(opus.iter().map(|d| d.tokens_in).sum::<i64>(), 150);
        let oc = store.usage_by_day(30, None, Some("opencode")).unwrap();
        assert_eq!(oc.iter().map(|d| d.tokens_in).sum::<i64>(), 30);
    }

    #[test]
    fn migration_sets_user_version_and_tables() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.lock();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // Core tables exist.
        for t in ["sessions", "events", "ingest_state", "events_fts"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    params![t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "table {t} should exist");
        }
    }

    #[test]
    fn migration_is_idempotent() {
        let store = Store::open_in_memory().unwrap();
        // Running migrate again must be a no-op (version already at target).
        store.migrate().unwrap();
        let v: i64 = store
            .lock()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn commit_batches_inserts_and_advances_offset() {
        let store = Store::open_in_memory().unwrap();
        let batch = NormalizedBatch {
            session: Some(session("cc:s1")),
            events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("hello world"))],
        };
        let inserted = store.commit_batches("/f.jsonl", 100, vec![batch]).unwrap();
        assert_eq!(inserted.len(), 1);
        assert_eq!(store.get_offset("/f.jsonl").unwrap(), 100);

        let sessions = store.list_sessions(None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].event_count, 1);
        assert_eq!(sessions[0].title.as_deref(), Some("hello world"));
    }

    #[test]
    fn duplicate_events_are_absorbed() {
        let store = Store::open_in_memory().unwrap();
        let mk = || NormalizedBatch {
            session: Some(session("cc:s1")),
            events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("hi"))],
        };
        let first = store.commit_batches("/f.jsonl", 10, vec![mk()]).unwrap();
        let second = store.commit_batches("/f.jsonl", 20, vec![mk()]).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 0, "re-seen event must be ignored");
        // Offset still advances even when nothing new was inserted.
        assert_eq!(store.get_offset("/f.jsonl").unwrap(), 20);
        assert_eq!(store.session_events("cc:s1", 200, None).unwrap().len(), 1);
    }

    #[test]
    fn unknown_events_without_uuid_are_kept() {
        let store = Store::open_in_memory().unwrap();
        let batch = NormalizedBatch {
            session: Some(session("cc:s1")),
            events: vec![ev("cc:s1", EventKind::Unknown, None, None)],
        };
        let inserted = store.commit_batches("/f.jsonl", 5, vec![batch]).unwrap();
        assert_eq!(inserted.len(), 1);
    }

    #[test]
    fn open_creates_db_file_with_schema_and_0600() {
        let dir = std::env::temp_dir().join(format!("eridian-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = dir.join("nested").join("eridian.db");
        let store = Store::open(&db).unwrap();
        assert!(db.exists(), "db file should be created");
        // schema applied
        let v: i64 = store
            .lock()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // 0600 perms (owner rw only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&db).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "db must be 0600, got {mode:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizer_reset_clears_stale_data() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f.jsonl",
                10,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("hi"))],
                }],
            )
            .unwrap();
        // Simulate a DB written by an older normalizer (no marker → version 0).
        store.reset_if_normalizer_changed().unwrap();
        assert_eq!(
            store.list_sessions(None).unwrap().len(),
            0,
            "stale data must be cleared on normalizer change"
        );
        assert_eq!(
            store.get_offset(NORMALIZER_MARKER).unwrap() as i64,
            NORMALIZER_VERSION,
            "marker must be updated to current version"
        );
        // Second call is a no-op (marker already current).
        store
            .commit_batches(
                "/g.jsonl",
                5,
                vec![NormalizedBatch {
                    session: Some(session("cc:s2")),
                    events: vec![],
                }],
            )
            .unwrap();
        store.reset_if_normalizer_changed().unwrap();
        assert_eq!(
            store.list_sessions(None).unwrap().len(),
            1,
            "unchanged version must not wipe data"
        );
    }

    #[test]
    fn session_without_timestamp_does_not_get_now_fallback() {
        // Control lines (mode, ai-title, …) carry no timestamp. They must not
        // bump a session's updated_at to "now" — that would make historical
        // sessions look live during backfill.
        let store = Store::open_in_memory().unwrap();
        let mut s = session("cc:s1");
        s.started_at = None;
        s.updated_at = None;
        let batch = NormalizedBatch {
            session: Some(s),
            events: vec![],
        };
        store.commit_batches("/f.jsonl", 1, vec![batch]).unwrap();
        let rows = store.list_sessions(None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].updated_at, None, "must stay NULL, not now()");
        assert!(!rows[0].live, "a session with no timestamp is not live");
    }

    #[test]
    fn fts_query_sanitizes() {
        assert_eq!(to_fts_query("partition").as_deref(), Some("partition*"));
        assert_eq!(to_fts_query("foo bar").as_deref(), Some("foo* bar*"));
        assert_eq!(to_fts_query("  \t  ").as_deref(), None);
        // FTS special chars are stripped, not passed through.
        assert_eq!(to_fts_query("a\"(b)").as_deref(), Some("ab*"));
    }

    #[test]
    fn search_finds_events_across_agents() {
        let store = Store::open_in_memory().unwrap();
        let mut cc = session("cc:s1");
        cc.agent = AgentKind::ClaudeCode;
        let mut oc = session("oc:s2");
        oc.agent = AgentKind::OpenCode;
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    NormalizedBatch {
                        session: Some(cc),
                        events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("discuss partition strategy"))],
                    },
                    NormalizedBatch {
                        session: Some(oc),
                        events: vec![ev("oc:s2", EventKind::Assistant, Some("a1"), Some("the partition key is month"))],
                    },
                ],
            )
            .unwrap();

        let hits = store.search_events("partition", 20).unwrap();
        assert_eq!(hits.len(), 2, "should match across both agents");
        let agents: std::collections::HashSet<&str> = hits.iter().map(|h| h.agent.as_str()).collect();
        assert!(agents.contains("claude-code") && agents.contains("opencode"));
        assert!(hits.iter().all(|h| h.snippet.contains("partition")));

        // Empty / junk query → no results, no error.
        assert!(store.search_events("   ", 20).unwrap().is_empty());
    }

    #[test]
    fn reconcile_source_alive_flips_when_transcript_purged() {
        let store = Store::open_in_memory().unwrap();
        // A real temp file stands in for the transcript on disk.
        let dir = std::env::temp_dir();
        let path = dir.join(format!("eridian_test_{}.jsonl", std::process::id()));
        std::fs::write(&path, b"{}").unwrap();
        let sess = NormalizedSession {
            id: "cc:arch".into(),
            agent: AgentKind::ClaudeCode,
            project_path: Some("/proj".into()),
            title: None,
            model: None,
            git_branch: None,
            started_at: Some("2026-08-08T10:00:00Z".into()),
            updated_at: Some("2026-08-08T11:00:00Z".into()),
            is_subagent: false,
            parent_session_id: None,
            source_ref: Some(path.to_string_lossy().to_string()),
        };
        store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(sess), events: vec![] }])
            .unwrap();

        // File present → alive stays 1, nothing changes.
        assert_eq!(store.reconcile_source_alive().unwrap(), 0);
        assert!(store.list_sessions(None).unwrap()[0].source_alive);

        // Purge the transcript → next reconcile flips the flag to archived.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(store.reconcile_source_alive().unwrap(), 1);
        assert!(!store.list_sessions(None).unwrap()[0].source_alive);

        // Idempotent while it stays gone.
        assert_eq!(store.reconcile_source_alive().unwrap(), 0);
    }

    #[test]
    fn session_subagents_clips_to_parent_window() {
        let store = Store::open_in_memory().unwrap();
        let mk_session = |id: &str, sub: bool, project: &str, start: &str, end: &str, parent: Option<&str>| {
            NormalizedSession {
                id: id.into(),
                agent: AgentKind::ClaudeCode,
                project_path: Some(project.into()),
                title: None,
                model: None,
                git_branch: None,
                started_at: Some(start.into()),
                updated_at: Some(end.into()),
                is_subagent: sub,
                parent_session_id: parent.map(String::from),
                source_ref: None,
            }
        };
        let mk_ev = |sid: &str, uuid: &str, ts: &str| NormalizedEvent {
            session_id: sid.into(),
            ts: Some(ts.into()),
            kind: EventKind::Assistant,
            role: None,
            text: Some("x".into()),
            tool_name: None,
            tool_input_json: None,
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: Some(uuid.into()),
            parent_uuid: None,
            tool_use_id: None,
            raw_json: "{}".into(),
        };
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    NormalizedBatch {
                        session: Some(mk_session("cc:p", false, "/proj", "2026-08-08T10:00:00Z", "2026-08-08T11:00:00Z", None)),
                        events: vec![mk_ev("cc:p", "p1", "2026-08-08T10:05:00Z")],
                    },
                    // Real child of cc:p; file spans weeks but only 1 event in window.
                    NormalizedBatch {
                        session: Some(mk_session("cc:sub", true, "/proj", "2026-07-01T00:00:00Z", "2026-08-20T00:00:00Z", Some("cc:p"))),
                        events: vec![
                            mk_ev("cc:sub", "s0", "2026-08-08T09:00:00Z"), // before
                            mk_ev("cc:sub", "s1", "2026-08-08T10:30:00Z"), // in window
                            mk_ev("cc:sub", "s2", "2026-08-08T12:00:00Z"), // after
                        ],
                    },
                    // Different parent → not a child of cc:p.
                    NormalizedBatch {
                        session: Some(mk_session("cc:other", true, "/proj", "2026-08-08T10:00:00Z", "2026-08-08T11:00:00Z", Some("cc:zzz"))),
                        events: vec![mk_ev("cc:other", "o1", "2026-08-08T10:30:00Z")],
                    },
                ],
            )
            .unwrap();

        let links = store.session_subagents("cc:p").unwrap();
        assert_eq!(links.len(), 1, "only the in-window, same-project subagent");
        assert_eq!(links[0].id, "cc:sub");
        assert_eq!(links[0].events_in_window, 1, "only the 10:30 event counts");
        assert_eq!(links[0].event_count, 3, "total across the whole file");
        assert_eq!(links[0].window_start.as_deref(), Some("2026-08-08T10:30:00Z"));
    }

    #[test]
    fn session_changes_aggregates_files_commands_risk() {
        let store = Store::open_in_memory().unwrap();
        let tool = |uuid: &str, name: &str, input: &str| NormalizedEvent {
            session_id: "cc:s1".into(),
            ts: Some("2026-08-08T00:00:00Z".into()),
            kind: EventKind::ToolCall,
            role: Some("assistant".into()),
            text: None,
            tool_name: Some(name.into()),
            tool_input_json: Some(input.into()),
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: Some(uuid.into()),
            parent_uuid: None,
            tool_use_id: None,
            raw_json: "{}".into(),
        };
        let batch = NormalizedBatch {
            session: Some(session("cc:s1")),
            events: vec![
                tool("t1", "Write", r#"{"file_path":"/proj/a.rs","content":"fn main(){}"}"#),
                tool("t2", "Bash", r#"{"command":"rm -rf /tmp/x"}"#),
                tool("t3", "Read", r#"{"file_path":"/proj/b.rs"}"#),
            ],
        };
        store.commit_batches("/f.jsonl", 1, vec![batch]).unwrap();

        let ch = store.session_changes("cc:s1").unwrap();
        assert_eq!(ch.files.len(), 2, "a.rs (write) + b.rs (read)");
        let a = ch.files.iter().find(|f| f.path == "/proj/a.rs").unwrap();
        assert_eq!(a.writes, 1);
        assert!(a.changes[0].preview.as_deref().unwrap().contains("fn main"));
        assert_eq!(ch.commands.len(), 1);
        assert_eq!(ch.commands[0].risk, "danger");
        assert_eq!(ch.risk.danger, 1, "rm -rf");
        assert_eq!(ch.risk.notable, 1, "the write");
        assert_eq!(ch.risk.safe, 1, "the read");
    }

    #[test]
    fn title_truncates_long_prompts() {
        let long = "x".repeat(200);
        let t = truncate_title(&long);
        assert_eq!(t.chars().count(), TITLE_MAX + 1); // + ellipsis
        assert!(t.ends_with('…'));
    }

    // ── Phase 2: token/usage rollups, retention, reconcile helpers ────────────

    // Event with explicit timestamp + token usage (assistant turn).
    fn tok_ev(session: &str, uuid: &str, ts: &str, tin: Option<i64>, tout: Option<i64>) -> NormalizedEvent {
        NormalizedEvent {
            session_id: session.to_string(),
            ts: Some(ts.to_string()),
            kind: EventKind::Assistant,
            role: Some("assistant".to_string()),
            text: Some("x".to_string()),
            tool_name: None,
            tool_input_json: None,
            tool_result_json: None,
            tokens_in: tin,
            tokens_out: tout,
            source_uuid: Some(uuid.to_string()),
            parent_uuid: None,
            tool_use_id: None,
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    fn list_sessions_rolls_up_tokens_and_context() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![
                        tok_ev("cc:s1", "e1", "2026-08-08T10:00:00Z", Some(100), Some(10)),
                        tok_ev("cc:s1", "e2", "2026-08-08T10:01:00Z", Some(300), Some(20)),
                        // latest token-bearing turn = e3 (150) → context_tokens
                        tok_ev("cc:s1", "e3", "2026-08-08T10:02:00Z", Some(150), Some(30)),
                        // a later event WITHOUT tokens must not become context
                        ev("cc:s1", EventKind::ToolResult, Some("e4"), Some("r")),
                    ],
                }],
            )
            .unwrap();
        let s = &store.list_sessions(None).unwrap()[0];
        assert_eq!(s.tokens_in, 550); // 100+300+150
        assert_eq!(s.tokens_out, 60); // 10+20+30
        assert_eq!(s.context_tokens, 150); // latest turn with tokens, not the peak
        assert_eq!(s.peak_tokens_in, 300); // max single-turn input
    }

    #[test]
    fn usage_by_day_sums_per_day_chronologically() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![
                        tok_ev("cc:s1", "a", "2026-08-07T09:00:00Z", Some(100), Some(1)),
                        tok_ev("cc:s1", "b", "2026-08-07T18:00:00Z", Some(50), Some(2)),
                        tok_ev("cc:s1", "c", "2026-08-08T09:00:00Z", Some(200), Some(3)),
                    ],
                }],
            )
            .unwrap();
        let days = store.usage_by_day(30, None, None).unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].date, "2026-08-07"); // chronological
        assert_eq!(days[0].tokens_in, 150);
        assert_eq!(days[1].date, "2026-08-08");
        assert_eq!(days[1].tokens_in, 200);
        assert_eq!(days[1].tokens_out, 3);
    }

    #[test]
    fn retention_early_out_when_under_cap() {
        let store = Store::open_in_memory().unwrap();
        store.set_settings(Settings { backfill_file_limit: None, max_sessions_per_agent: Some(10), catalog_fetch_enabled: false }).unwrap();
        store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(session("cc:s1")), events: vec![] }])
            .unwrap();
        assert_eq!(store.enforce_retention().unwrap(), 0); // nothing exceeds cap
        assert_eq!(store.list_sessions(None).unwrap().len(), 1);
    }

    #[test]
    fn retention_prunes_oldest_and_all_its_events_chunked() {
        let store = Store::open_in_memory().unwrap();
        // keep only 1 per agent
        store.set_settings(Settings { backfill_file_limit: None, max_sessions_per_agent: Some(1), catalog_fetch_enabled: false }).unwrap();

        let mut old = session("cc:old");
        old.updated_at = Some("2026-08-01T00:00:00Z".to_string());
        let mut new = session("cc:new");
        new.updated_at = Some("2026-08-09T00:00:00Z".to_string());
        // Seed the OLD session with >4000 events to exercise chunked deletion.
        let old_events: Vec<NormalizedEvent> = (0..4100)
            .map(|i| ev("cc:old", EventKind::Assistant, Some(&format!("o{i}")), Some("x")))
            .collect();
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    NormalizedBatch { session: Some(old), events: old_events },
                    NormalizedBatch { session: Some(new), events: vec![ev("cc:new", EventKind::User, Some("n1"), Some("hi"))] },
                ],
            )
            .unwrap();

        assert_eq!(store.enforce_retention().unwrap(), 1); // pruned the old one
        let rows = store.list_sessions(None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "cc:new");
        // All of cc:old's events are gone (chunked delete completed).
        let conn = store.lock();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM events WHERE session_id = 'cc:old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn opencode_session_updated_maps_oc_only() {
        let store = Store::open_in_memory().unwrap();
        let mut oc = session("oc:1");
        oc.agent = AgentKind::OpenCode;
        oc.updated_at = Some("2026-08-08T12:00:00Z".to_string());
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    NormalizedBatch { session: Some(oc), events: vec![] },
                    NormalizedBatch { session: Some(session("cc:1")), events: vec![] },
                ],
            )
            .unwrap();
        let m = store.opencode_session_updated().unwrap();
        assert_eq!(m.get("oc:1").map(String::as_str), Some("2026-08-08T12:00:00Z"));
        assert!(!m.contains_key("cc:1")); // claude-code excluded
    }

    // Tool-call event with a name + input JSON (drives session_changes).
    fn tool_ev(session: &str, uuid: &str, ts: &str, name: &str, input: &str) -> NormalizedEvent {
        NormalizedEvent {
            session_id: session.to_string(),
            ts: Some(ts.to_string()),
            kind: EventKind::ToolCall,
            role: Some("assistant".to_string()),
            text: None,
            tool_name: Some(name.to_string()),
            tool_input_json: Some(input.to_string()),
            tool_result_json: None,
            tokens_in: None,
            tokens_out: None,
            source_uuid: Some(uuid.to_string()),
            parent_uuid: None,
            tool_use_id: None,
            raw_json: "{}".to_string(),
        }
    }

    #[test]
    fn session_changes_aggregates_files_commands_and_risk() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![
                        tool_ev("cc:s1", "e1", "2026-08-08T10:00:00Z", "Bash", r#"{"command":"ls -la"}"#),
                        tool_ev("cc:s1", "e2", "2026-08-08T10:01:00Z", "Write", r#"{"file_path":"/proj/a.rs","content":"fn main(){}"}"#),
                        tool_ev("cc:s1", "e3", "2026-08-08T10:02:00Z", "Read", r#"{"file_path":"/proj/a.rs"}"#),
                    ],
                }],
            )
            .unwrap();
        let ch = store.session_changes("cc:s1").unwrap();
        assert_eq!(ch.commands.len(), 1);
        assert!(ch.commands[0].command.contains("ls -la"));
        // a.rs touched by both write and read → one file row with writes+reads
        let a = ch.files.iter().find(|f| f.path == "/proj/a.rs").unwrap();
        assert_eq!(a.writes, 1);
        assert_eq!(a.reads, 1);
        assert!(ch.risk.danger + ch.risk.notable + ch.risk.safe >= 3);
        assert_eq!(ch.files_total, ch.files.len() as i64);
    }

    #[test]
    fn search_events_matches_across_text_and_sanitizes_query() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("investigate the partition strategy"))],
                }],
            )
            .unwrap();
        let hits = store.search_events("partition", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("partition"));
        // junk / empty queries don't error (sanitizer handles them)
        assert!(store.search_events("   ", 20).unwrap().is_empty());
        let _ = store.search_events("\"unbalanced", 20).unwrap(); // must not panic
    }

    #[test]
    fn session_events_pages_newest_first() {
        let store = Store::open_in_memory().unwrap();
        let evs: Vec<NormalizedEvent> = (0..5)
            .map(|i| ev("cc:s1", EventKind::User, Some(&format!("u{i}")), Some("hi")))
            .collect();
        store
            .commit_batches("/f", 1, vec![NormalizedBatch { session: Some(session("cc:s1")), events: evs }])
            .unwrap();
        let page1 = store.session_events("cc:s1", 2, None).unwrap();
        assert_eq!(page1.len(), 2);
        // newest first → ids descending
        assert!(page1[0].id > page1[1].id);
        let page2 = store.session_events("cc:s1", 2, Some(page1[1].id)).unwrap();
        assert!(page2.iter().all(|e| e.id < page1[1].id));
    }

    #[test]
    fn ingest_status_counts_and_activity() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![tok_ev("cc:s1", "e1", "2026-08-08T10:00:00Z", Some(10), Some(2))],
                }],
            )
            .unwrap();
        let st = store.ingest_status().unwrap();
        assert!(st.claude_code_events >= 1);
        let acts = store.session_activity("cc:s1").unwrap();
        assert!(!acts.is_empty());
    }

    #[test]
    fn settings_roundtrip_and_backfill_limit() {
        let store = Store::open_in_memory().unwrap();
        let s = store
            .set_settings(Settings { backfill_file_limit: Some(50), max_sessions_per_agent: None, catalog_fetch_enabled: false })
            .unwrap();
        assert_eq!(s.backfill_file_limit, Some(50));
        assert_eq!(store.settings().backfill_file_limit, Some(50));
        assert_eq!(store.backfill_file_limit(), Some(50));
        // 0 / negative → treated as "no limit"
        store
            .set_settings(Settings { backfill_file_limit: Some(0), max_sessions_per_agent: Some(0), catalog_fetch_enabled: false })
            .unwrap();
        assert_eq!(store.backfill_file_limit(), None);
    }

    #[test]
    fn db_info_and_clear_all() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![ev("cc:s1", EventKind::User, Some("u1"), Some("hi"))],
                }],
            )
            .unwrap();
        let info = store.db_info().unwrap();
        assert_eq!(info.sessions, 1);
        assert!(info.events >= 1);

        store.clear_all().unwrap();
        assert_eq!(store.list_sessions(None).unwrap().len(), 0);
        assert_eq!(store.db_info().unwrap().events, 0);
    }

    #[test]
    fn catalog_fetch_defaults_off_and_roundtrips() {
        let s = Store::open_in_memory().unwrap();
        assert!(!s.catalog_fetch_enabled());
        // Old settings.json without the field must still parse to false.
        let old: Settings =
            serde_json::from_str(r#"{"backfill_file_limit":10,"max_sessions_per_agent":5}"#).unwrap();
        assert!(!old.catalog_fetch_enabled);
    }

    #[test]
    fn session_skills_detects_skill_tool_and_command_tag() {
        let store = Store::open_in_memory().unwrap();
        store
            .commit_batches(
                "/f",
                1,
                vec![NormalizedBatch {
                    session: Some(session("cc:s1")),
                    events: vec![
                        tool_ev("cc:s1", "e1", "2026-08-08T10:00:00Z", "Skill", r#"{"command":"brainstorming"}"#),
                        tool_ev("cc:s1", "e2", "2026-08-08T10:01:00Z", "Skill", r#"{"command":"brainstorming"}"#),
                        ev("cc:s1", EventKind::User, Some("u1"), Some("<command-name>/sample-review</command-name>")),
                    ],
                }],
            )
            .unwrap();
        let runs = store.session_skills("cc:s1").unwrap();
        let skill = runs.iter().find(|r| r.kind == "skill").unwrap();
        assert_eq!(skill.name, "brainstorming");
        assert_eq!(skill.count, 2); // aggregated
        let cmd = runs.iter().find(|r| r.kind == "command").unwrap();
        assert_eq!(cmd.name, "sample-review");
    }

    #[test]
    fn subagent_parents_counts_children() {
        let store = Store::open_in_memory().unwrap();
        let mut child = session("cc:sub");
        child.is_subagent = true;
        child.parent_session_id = Some("cc:p".to_string());
        store
            .commit_batches(
                "/f",
                1,
                vec![
                    NormalizedBatch { session: Some(session("cc:p")), events: vec![] },
                    NormalizedBatch { session: Some(child), events: vec![] },
                ],
            )
            .unwrap();
        let parents = store.subagent_parents().unwrap();
        let p = parents.iter().find(|x| x.session_id == "cc:p").unwrap();
        assert_eq!(p.count, 1);
    }
}
