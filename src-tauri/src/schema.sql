-- Eridian schema. Applied via PRAGMA user_version gate.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,          -- namespaced: 'cc:<uuid>' | 'oc:<id>'
  agent             TEXT NOT NULL,             -- 'claude-code' | 'opencode'
  project_path      TEXT,                      -- cwd from transcript / opencode project
  title             TEXT,                      -- first user prompt (truncated) or agent title
  model             TEXT,
  git_branch        TEXT,
  started_at        TEXT,                      -- ISO-8601 UTC
  updated_at        TEXT,
  is_subagent       INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,                      -- nullable; heuristic for cc sidechains
  source_ref        TEXT,                      -- jsonl path (cc) | api session id (oc)
  source_alive      INTEGER NOT NULL DEFAULT 1 -- 0 when source purged (archive badge)
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  ts               TEXT,                       -- ISO-8601 UTC
  kind             TEXT NOT NULL,              -- user|assistant|thinking|tool_call|tool_result|system|summary|unknown
  role             TEXT,
  text             TEXT,                       -- human-readable body (message text, etc.)
  tool_name        TEXT,
  tool_input_json  TEXT,
  tool_result_json TEXT,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  source_uuid      TEXT,                       -- cc line uuid / oc part-message id
  parent_uuid      TEXT,
  tool_use_id      TEXT,                       -- correlate tool_call ↔ tool_result
  raw_json         TEXT NOT NULL               -- always keep the original record
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
-- Covering index for list_sessions' per-session token/count rollup: lets the
-- COUNT/SUM/MAX aggregate run index-only (no per-row table lookups), which
-- otherwise made the (main-thread) list query scan the whole events table.
CREATE INDEX IF NOT EXISTS idx_events_usage ON events(session_id, tokens_in, tokens_out);
-- Partial index for "latest turn with token usage" (context-fill %): scans only
-- token-bearing rows (assistant turns), not every event.
CREATE INDEX IF NOT EXISTS idx_events_last_token ON events(session_id, id) WHERE tokens_in IS NOT NULL;
-- Idempotency: a source record may be seen twice (backfill overlap, SSE replay).
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_source
  ON events(session_id, source_uuid, kind) WHERE source_uuid IS NOT NULL;
-- Pair a tool_call with its tool_result (and find in-flight shell commands).
CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(tool_use_id) WHERE tool_use_id IS NOT NULL;
-- Time-ranged token rollups (usage_by_day / usage_breakdown) scan by ts.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts) WHERE ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest_state (
  source      TEXT PRIMARY KEY,               -- absolute file path (cc) | 'opencode:<base_url>'
  byte_offset INTEGER NOT NULL DEFAULT 0,     -- cc: resume offset; oc: unused (0)
  meta_json   TEXT,                           -- oc: last event cursor etc.
  updated_at  TEXT NOT NULL
);

-- Full-text search over event text + tool names (external content table).
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, tool_name,
  content='events', content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, tool_name)
  VALUES (new.id, coalesce(new.text,''), coalesce(new.tool_name,''));
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, tool_name)
  VALUES ('delete', old.id, coalesce(old.text,''), coalesce(old.tool_name,''));
END;

-- Stays 2: the events.tool_use_id column/index rides on the NORMALIZER_VERSION
-- reset (drop+recreate), not this gate (see store.rs SCHEMA_VERSION note).
PRAGMA user_version = 2;
