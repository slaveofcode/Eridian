# Eridian — Design Notes (Unified Agent Session Dashboard)

> Design rationale and reference for the architecture, data sources, storage, and UI
> direction. For day-to-day guidance see [CONTRIBUTING.md](CONTRIBUTING.md); for an
> overview see [README.md](README.md). The original build milestones are kept at the
> bottom as history.

## 1. Goal

A local Tauri 2 desktop app that gives one live, reviewable view of everything my coding
agents are doing, starting with **Claude Code** and **OpenCode**:

- Session list across both agents (project, model, branch, last activity, live/idle)
- Full session timeline: user prompts, assistant messages, thinking, tool calls + results, token usage
- Subagent visibility (Claude Code sidechains grouped under their project)
- Live tail: new events appear in the UI within ~1s of the agent producing them
- Full-text search across all history (FTS5)
- Read-only MCP config panel: what MCP servers each agent has configured
- **Durable archive**: Eridian's own SQLite keeps history even after Claude Code's
  30-day `cleanupPeriodDays` purge deletes the source JSONL

### Non-goals (current)

- No config *writing* (no MCP sync, no key management) — strictly read-only against agent files
- No Codex / Gemini / Antigravity / Claude Desktop (adapters designed for, not built)
- No orchestration, no launching agents, no PTY embedding
- No Windows support yet (macOS + Linux only)
- No cloud anything

## 2. Architecture

```
┌─────────────────────────── Tauri 2 app ───────────────────────────┐
│  Rust core (src-tauri)                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────────┐  │
│  │ ClaudeCode   │   │ OpenCode     │   │ SQLite (rusqlite)     │  │
│  │ ingester     │   │ ingester     │──▶│ sessions / events /   │  │
│  │ notify watch │──▶│ REST + SSE   │   │ ingest_state / FTS5   │  │
│  │ JSONL tail   │   │ :4096        │   └───────────┬───────────┘  │
│  └──────┬───────┘   └──────┬───────┘               │              │
│         └─── normalize.rs (unified event model) ───┤              │
│                                                    ▼              │
│                    Tauri commands + emit("eridian://…")           │
├───────────────────────────────────────────────────────────────────┤
│  Frontend: React 18 + TypeScript + Vite + Tailwind               │
│  Agent rail │ Session list │ Timeline (live)  │ Search │ MCP tab  │
└───────────────────────────────────────────────────────────────────┘
```

Principles:

1. **Normalize at the edge.** Each ingester converts agent-specific records into the
   `NormalizedSession` / `NormalizedEvent` model (`src-tauri/src/normalize.rs`) as early
   as possible. The store, commands, and UI never see agent-specific shapes.
2. **Never trust the schema.** Agent file formats are undocumented and drift between
   builds. Parse into `serde_json::Value`, extract fields defensively, and when a line
   doesn't match expectations store it as `kind = "unknown"` with `raw` preserved.
   A parse failure must never crash or stall the ingest loop.
3. **The DB is the product.** Everything renders from Eridian's SQLite, never directly
   from agent files. This is what makes the archive durable and search possible.
4. **Adapters are pluggable.** `Ingester` is a trait; Codex/Gemini come later as new
   impls with zero changes to store/UI.

## 3. Data sources (verified against current builds — re-verify at build time)

### Claude Code (file-based)
- Transcripts: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` — append-only
  JSONL. Line fields include `type` (user/assistant/system/summary), `uuid`,
  `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`,
  `message.content[]` blocks (`text` / `tool_use` / `tool_result` / `thinking`),
  `message.usage.{input_tokens,output_tokens}`.
- Subagents: `subagents/agent-<agentId>.jsonl` next to the main session file; every line
  `isSidechain: true`. The sidechain's own `sessionId` field is its parent — Eridian uses
  that as a **real** parent link (not a heuristic).
- Config for MCP panel: `~/.claude/settings.json`, `~/.claude.json` (user-scope MCP),
  `<project>/.mcp.json`.
- Retention trap: transcripts auto-purged after `cleanupPeriodDays` (default 30). The
  first full backfill is therefore a feature, not just startup cost.

### OpenCode (API-based)
- Server: `opencode serve` → `http://localhost:4096`. OpenAPI spec at `GET /doc` —
  **verify route names against /doc at runtime/build time; they drift.**
- Bootstrap: session list + per-session messages via REST.
- Live: `GET /event` SSE stream (~19 event types: session.*, message.*, permission.*).
- Fallback if server not running: detect and show a call-to-action in the UI
  ("Start with `opencode serve`"). Optionally read `opencode.db` (SQLite,
  Projects→Sessions→Messages→Parts) as a cold-import path — stretch, not core.
- Config for MCP panel: `~/.config/opencode/opencode.json(c)` → `mcp` key.

## 4. Storage

Schema in `src-tauri/src/schema.sql`. Summary:

- `sessions` — namespaced ids (`cc:<uuid>`, `oc:<id>`), agent, project_path, title,
  model, git_branch, started_at/updated_at, is_subagent, parent_session_id (nullable),
  source_ref (file path or API id)
- `events` — session_id, ts, kind, role, text, tool_name, tool_input_json,
  tool_result_json, tokens_in/out, source_uuid, parent_uuid, raw_json
- `ingest_state` — per-source byte offsets for resumable tailing
- `events_fts` — FTS5 external-content table over (text, tool_name) with sync triggers

DB location: Tauri `app_data_dir()/eridian.db`, file mode 0600. Transcripts are
sensitive (they contain code and secrets that flowed through tools) — treat the DB
accordingly and never log event bodies.

## 5. Build history (delivered)

> Kept for context — the milestones below (M0–M4) are all shipped. Current
> capabilities and roadmap live in [README.md](README.md).

### M0 — Scaffold
- `pnpm create tauri-app@latest eridian` → react-ts template, Tauri 2.
- Add crates: `rusqlite` (bundled), `notify`, `tokio`, `serde`/`serde_json`, `reqwest`
  (stream feature), `eventsource-stream`, `futures-util`, `dirs`, `anyhow`,
  `thiserror`, `tracing`, `tracing-subscriber`, `chrono`.
- Migrations runner (embed schema.sql, `PRAGMA user_version` gate).
- ✅ Accept: `pnpm tauri dev` opens a window; DB file created with schema; `cargo test` green.

### M1 — Claude Code ingest + session UI (the core)
- `src-tauri/src/ingest/claude_code.rs`: initial backfill walk of
  `~/.claude/projects/**/*.jsonl` (+ `subagents/`), then notify-based live tail with
  byte-offset resume. Unit-test the line normalizer against fixture JSONL committed
  under `src-tauri/fixtures/` (capture real sessions, scrub content).
- Tauri commands (`src-tauri/src/commands.rs`): `list_sessions`, `session_events`,
  `ingest_status`; emit `eridian://sessions-updated` and `eridian://events-appended`.
- UI: agent rail + session list + timeline. Timeline renders per-kind cards
  (prompt / assistant / thinking collapsed by default / tool call with input+result
  collapsible / usage footer). Live badge when file activity < 60s old.
- ✅ Accept: run a real Claude Code session; events appear live in Eridian ≤1s; restart
  Eridian → no duplicates (offset resume works); malformed line fixture → stored as
  unknown, ingest continues.

### M2 — OpenCode ingest
- `src-tauri/src/ingest/opencode.rs`: health check → bootstrap sessions/messages →
  SSE subscribe with reconnect/backoff; normalize into same model.
- UI: OpenCode sessions interleave in the same list; server-down state shows CTA.
- ✅ Accept: run an OpenCode session; both agents visible side-by-side, live.

### M3 — Search + subagents + MCP panel
- FTS5 search command + search UI (query across both agents, jump to timeline position).
- Subagent grouping: sidechain sessions nest under their project group in the list,
  labeled "subagent"; show honest "linked by time heuristic" tooltip.
- MCP panel: parse the three Claude Code config locations + opencode.json; render
  read-only table (agent, server name, transport, command/url). No editing.
- ✅ Accept: search "partition" finds events across agents; MCP panel matches
  `claude mcp list` / opencode config reality.

### M4 — Stretch (only if M1–M3 solid)
- Cost/token rollups per session/day (from usage fields).
- Archive indicator: sessions whose source JSONL no longer exists get an "archived —
  source purged" badge (proves the durability story).
- Cold-import of `opencode.db`.

## 6. UI design direction (deliberate, not default)

Ops-console aesthetic — this is mission control for agents, so lean into instrument-panel
vernacular rather than a generic SaaS dashboard:

- **Palette**: near-black slate base (`#0B0E14`), panel `#11151D`, hairline `#1E2430`,
  text `#C9D1E0` / muted `#6B7689`. Agent identity accents used *only* as identity:
  Claude Code `#E8825A`, OpenCode `#3ECF8E`. One shared alert amber `#E7B75F`.
- **Type**: data is monospace-first — `JetBrains Mono` for timeline content, timestamps,
  tool names; `Space Grotesk` for chrome/headings. No serif display faces.
- **Signature element**: the *activity rail* — a thin vertical strip beside the session
  list where each live session shows a pulsing tick in its agent color, forming a
  heartbeat column of the whole fleet. Spend polish there; keep everything else quiet.
- Density over whitespace; collapsed-by-default detail; keyboard focus visible;
  respects reduced motion.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| JSONL/SSE schema drift | Value-based tolerant parsing; unknown-kind fallback; fixtures from real sessions; adapters versioned |
| Claude Code purges history | Backfill on first run; Eridian DB is authoritative archive |
| OpenCode routes change | Verify against `/doc`; route constants in one module; graceful degradation to db import |
| Risk tags are heuristic | Label honestly in UI; never present as ground truth. (Subagent↔parent links, by contrast, are real — from the sidechain `sessionId`.) |
| Sensitive data in DB | 0600 perms, no event bodies in logs, DB stays local |
| Watcher misses events (editor atomic writes etc.) | Offsets are per-file and idempotent; periodic 30s reconciliation sweep re-checks sizes vs offsets |

## 8. Later (keep adapters ready)

Codex (JSONL rollouts + session_index), Gemini CLI (OTel file outfile + tmp/chats +
shadow-git checkpoints), Antigravity (brain transcript_full.jsonl, best-effort),
Claude Desktop (MCP log tail), config *writing* / MCP sync, key management via OS
keychain, Windows.
