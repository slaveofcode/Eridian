//! Cold-import of OpenCode sessions straight from its on-disk SQLite store
//! (`~/.local/share/opencode/opencode.db`). This makes OpenCode history visible
//! in Eridian even when the `opencode serve` process is down — the live SSE/poll
//! ingest only has data while the server is running.
//!
//! Guardrail: the OpenCode DB is agent data — opened strictly READ-ONLY, never
//! written, never migrated. We only read `session`, `message`, and `part`.

use crate::ingest::opencode::normalize_message_obj;
use crate::normalize::{AgentKind, NormalizedBatch, NormalizedSession};
use crate::store::Store;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

fn opencode_db_path() -> Option<std::path::PathBuf> {
    let p = dirs::home_dir()?.join(".local/share/opencode/opencode.db");
    p.exists().then_some(p)
}

fn ms_to_iso(ms: Option<i64>) -> Option<String> {
    ms.and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.to_rfc3339())
}

/// The `session.model` column is sometimes a JSON object ({"id":…,"providerID":…})
/// rather than a bare id. Extract the id; otherwise return the string as-is.
fn model_id(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                return id.to_string();
            }
        }
    }
    raw.to_string()
}

/// (total sessions in opencode.db, how many are new/updated vs the store).
/// Cheap — reads only the `session` table. `(0, 0)` if the DB isn't present.
pub fn cold_status(store: &Store) -> Result<(usize, usize)> {
    let Some(db) = opencode_db_path() else {
        return Ok((0, 0));
    };
    cold_status_from(store, &db)
}

fn cold_status_from(store: &Store, db: &std::path::Path) -> Result<(usize, usize)> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut stmt = conn.prepare("SELECT id, time_updated FROM session")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))?;
    let rows: Vec<(String, Option<i64>)> = rows.collect::<rusqlite::Result<_>>()?;
    let existing = store.opencode_session_updated().unwrap_or_default();
    let total = rows.len();
    let mut pending = 0usize;
    for (id, updated) in rows {
        let cur = ms_to_iso(updated);
        match (existing.get(&format!("oc:{id}")), &cur) {
            (Some(prev), Some(c)) if prev.as_str() >= c.as_str() => {}
            _ => pending += 1,
        }
    }
    Ok((total, pending))
}

/// Import all OpenCode sessions from the local DB. Returns the number of
/// sessions imported. Best-effort: any error is returned to the caller, which
/// logs and continues (never crash ingest on bad input).
pub fn cold_import(store: &Store) -> Result<usize> {
    let Some(db) = opencode_db_path() else {
        tracing::info!("opencode.db not found; cold-import skipped");
        return Ok(0);
    };
    cold_import_from(store, &db)
}

fn cold_import_from(store: &Store, db: &std::path::Path) -> Result<usize> {
    // READ-ONLY. NO_MUTEX is safe: this connection is used only on this thread.
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut sess_stmt = conn.prepare(
        "SELECT id, parent_id, directory, path, title, model, time_created, time_updated
         FROM session",
    )?;
    struct SessRow {
        id: String,
        parent_id: Option<String>,
        directory: Option<String>,
        path: Option<String>,
        title: Option<String>,
        model: Option<String>,
        created: Option<i64>,
        updated: Option<i64>,
    }
    let sessions: Vec<SessRow> = sess_stmt
        .query_map([], |r| {
            Ok(SessRow {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                directory: r.get(2)?,
                path: r.get(3)?,
                title: r.get(4)?,
                model: r.get(5)?,
                created: r.get(6)?,
                updated: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut msg_stmt =
        conn.prepare("SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created, id")?;
    let mut part_stmt =
        conn.prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created, id")?;

    // Incremental skip: sessions already imported with an equal-or-newer
    // updated_at need no re-parse (avoids re-reading thousands of events every
    // boot — the live ingest may also have newer data, so never downgrade).
    let existing = store.opencode_session_updated().unwrap_or_default();

    let mut imported = 0usize;
    let mut skipped = 0usize;
    for s in &sessions {
        let updated_iso = ms_to_iso(s.updated);
        if let (Some(prev), Some(cur)) = (existing.get(&format!("oc:{}", s.id)), &updated_iso) {
            if prev.as_str() >= cur.as_str() {
                skipped += 1;
                continue; // already up to date
            }
        }
        let session = NormalizedSession {
            id: format!("oc:{}", s.id),
            agent: AgentKind::OpenCode,
            project_path: s.directory.clone().or_else(|| s.path.clone()),
            title: s.title.clone(),
            model: s.model.as_deref().map(model_id),
            git_branch: None,
            started_at: ms_to_iso(s.created),
            updated_at: updated_iso.clone(),
            is_subagent: s.parent_id.is_some(),
            parent_session_id: s.parent_id.as_ref().map(|p| format!("oc:{p}")),
            source_ref: Some(s.id.clone()),
        };
        let mut batches = vec![NormalizedBatch { session: Some(session), events: vec![] }];

        // messages → assembled { info, parts } → reuse the live normalizer.
        let msgs: Vec<(String, String)> = msg_stmt
            .query_map([&s.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (mid, mdata) in msgs {
            let mut info: Value = match serde_json::from_str(&mdata) {
                Ok(v) => v,
                Err(_) => continue, // unparseable message → skip, don't crash
            };
            // The message id is a DB column, not in `data`. Inject it so the
            // normalizer builds unique per-part source_uuids ("{mid}#{i}") —
            // otherwise every message collides on "#0/#1/…" and dedups away.
            if let Some(obj) = info.as_object_mut() {
                obj.insert("id".into(), Value::String(mid.clone()));
            }
            let parts: Vec<Value> = part_stmt
                .query_map([&mid], |r| r.get::<_, String>(0))?
                .filter_map(|d| d.ok())
                .filter_map(|d| serde_json::from_str::<Value>(&d).ok())
                .collect();

            // User prompt text lives in text parts (not message.data); synthesize
            // it into `info.text` so the user branch of the normalizer sees it.
            if info.get("role").and_then(Value::as_str) == Some("user")
                && info.get("text").is_none()
            {
                let text: String = parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !text.is_empty() {
                    if let Some(obj) = info.as_object_mut() {
                        obj.insert("text".into(), Value::String(text));
                    }
                }
            }

            let assembled = json!({ "info": info, "parts": parts });
            let batch = normalize_message_obj(&s.id, &assembled);
            if !batch.events.is_empty() {
                batches.push(batch);
            }
        }

        store.commit_batches("opencode:cold", 1, batches)?;
        imported += 1;
    }

    tracing::info!(imported, skipped, "opencode cold-import complete");
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    // Build a minimal synthetic opencode.db (session/message/part) so the import
    // path is covered without the real on-disk DB. Returns the db file path.
    fn make_db() -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("eridian_oc_{}_{}.db", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
               directory TEXT, path TEXT, title TEXT, model TEXT,
               time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT,
               time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
               time_created INTEGER, data TEXT);",
        )
        .unwrap();
        // One session with a user turn (text in a part) + an assistant turn.
        c.execute(
            "INSERT INTO session VALUES('s1','p','',NULL,'/proj','Demo','minimax',1000,2000)",
            [],
        )
        .unwrap();
        // user message: role in data, text lives in a text part
        c.execute(
            "INSERT INTO message VALUES('m1','s1',1000,'{\"role\":\"user\",\"time\":{\"created\":1000}}')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO part VALUES('pt1','m1','s1',1000,'{\"type\":\"text\",\"text\":\"hello world\"}')",
            [],
        )
        .unwrap();
        // assistant message with a text part
        c.execute(
            "INSERT INTO message VALUES('m2','s1',1100,'{\"role\":\"assistant\",\"time\":{\"created\":1100}}')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO part VALUES('pt2','m2','s1',1100,'{\"type\":\"text\",\"text\":\"hi there\"}')",
            [],
        )
        .unwrap();
        path
    }

    #[test]
    fn cold_import_from_synthetic_db() {
        let store = Store::open_in_memory().unwrap();
        let db = make_db();
        let n = cold_import_from(&store, &db).unwrap();
        assert_eq!(n, 1);

        let sessions = store.list_sessions(None).unwrap();
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "oc:s1");
        assert_eq!(s.agent, "opencode");
        assert_eq!(s.title.as_deref(), Some("Demo"));
        // user text assembled from the text part; assistant text present → 2 events,
        // and unique source_uuids (message-id injected) mean no dedup loss.
        assert_eq!(s.event_count, 2);
        let title_ev = store.session_events("oc:s1", 10, None).unwrap();
        assert!(title_ev.iter().any(|e| e.text.as_deref() == Some("hello world")));
        assert!(title_ev.iter().any(|e| e.text.as_deref() == Some("hi there")));

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn cold_status_and_incremental_skip() {
        let store = Store::open_in_memory().unwrap();
        let db = make_db();

        // Before import: 1 total, 1 pending.
        assert_eq!(cold_status_from(&store, &db).unwrap(), (1, 1));

        // After import: still 1 total, 0 pending (unchanged updated_at).
        cold_import_from(&store, &db).unwrap();
        assert_eq!(cold_status_from(&store, &db).unwrap(), (1, 0));

        // Re-import is a no-op (session skipped as up-to-date).
        assert_eq!(cold_import_from(&store, &db).unwrap(), 0);

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn cold_import_handles_subagent_and_bad_message() {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("eridian_oc2_{}_{}.db", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
               directory TEXT, path TEXT, title TEXT, model TEXT,
               time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT,
               time_created INTEGER, data TEXT);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
               time_created INTEGER, data TEXT);",
        )
        .unwrap();
        // subagent session (parent_id set) + one good + one unparseable message
        c.execute("INSERT INTO session VALUES('c1','p','par','/d',NULL,'Child','m',1,2)", []).unwrap();
        c.execute("INSERT INTO message VALUES('gm','c1',1,'{\"role\":\"assistant\",\"time\":{\"created\":1}}')", []).unwrap();
        c.execute("INSERT INTO part VALUES('gp','gm','c1',1,'{\"type\":\"text\",\"text\":\"ok\"}')", []).unwrap();
        c.execute("INSERT INTO message VALUES('bm','c1',2,'not json')", []).unwrap(); // must be skipped

        let store = Store::open_in_memory().unwrap();
        assert_eq!(cold_import_from(&store, &path).unwrap(), 1);
        let s = &store.list_sessions(None).unwrap()[0];
        assert!(s.is_subagent);
        assert_eq!(s.parent_session_id.as_deref(), Some("oc:par"));
        assert_eq!(s.event_count, 1); // good message only; bad one skipped

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    #[ignore = "reads the real ~/.local/share/opencode/opencode.db"]
    fn cold_import_real() {
        let store = Store::open_in_memory().unwrap();
        let n = cold_import(&store).unwrap();
        assert!(n > 0, "expected some opencode sessions");
        let sessions = store.list_sessions(None).unwrap();
        assert!(sessions.iter().any(|s| s.agent == "opencode"), "no opencode sessions");
        let total_events: i64 = sessions.iter().map(|s| s.event_count).sum();
        assert!(total_events > 0, "expected events from messages/parts");
        eprintln!("cold-import: {n} sessions, {total_events} events");
    }
}
