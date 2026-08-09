# CLAUDE.md — Eridian

Guidance for AI-assisted work in this repo. Human contributors: see
[CONTRIBUTING.md](CONTRIBUTING.md) (same rules, more detail) and [README.md](README.md).

## What this is
Local Tauri 2 desktop app: a unified **read-only** dashboard for AI coding agents
(currently Claude Code + OpenCode). Live timelines, per-session change inspection,
full-text search, a syntax-highlighted file viewer with git time-travel, and a durable
local archive. Keep the defensive parsing style when extending the ingesters, and never
weaken the guardrails below — they are the whole point of the project.

## Hard guardrails (never violate)
- **READ-ONLY against agent data.** Never write, rename, truncate, or lock anything
  under `~/.claude/`, `~/.config/opencode/`, `~/.local/share/opencode/`. Open files
  read-only (cold-import uses `SQLITE_OPEN_READ_ONLY`). Eridian writes only to its own
  app-data dir. **One allowed exception:** starting/stopping/force-killing an Eridian-
  *managed* `opencode serve` (localhost, user-invoked) — and only Eridian's own child.
- **Never crash the ingest loop on bad input.** Any unparseable line/event → store as
  `kind = "unknown"` with raw payload, `tracing::warn!` (path + offset only), continue.
  No `unwrap()`/`expect()` in ingest or command paths; use `anyhow::Result` + `?`.
- **Transcripts are sensitive.** Never log event/message bodies, tool inputs/outputs,
  or anything from `raw_json`. Log paths, counts, offsets, durations only. DB is 0600.
- **No new network destinations.** Only `http://localhost:<opencode_port>`. No
  telemetry, no update checks, nothing phones home.
- Don't add dependencies without stating why. Current deps beyond the scaffold:
  `rusqlite` (bundled), `notify`, `reqwest`, `eventsource-stream`, `tokio`, `anyhow`,
  `thiserror`, `serde`/`serde_json`, `chrono`, `dirs`, `tracing`. Frontend is zero-dep
  for rendering (own markdown + syntax highlighter) — no highlight.js/shiki/Tailwind.

## Stack & commands
- Tauri 2 (Rust stable, edition 2021) + React 18 + TypeScript strict + Vite +
  **hand-written CSS** (`src/App.css` — no Tailwind; deliberate, for the ops-console
  look). Package manager: pnpm.
- Dev: `pnpm tauri dev` · Rust tests: `cd src-tauri && cargo test` ·
  Lint: `cargo clippy -- -D warnings` and `pnpm tsc --noEmit` · Build: `pnpm build`.
- **Tests/coverage (≥90% on logic):** frontend `pnpm test` / `pnpm test:cov`
  (Vitest, jsdom; gate in `vitest.config.ts` over logic files). Rust
  `cd src-tauri && cargo test`; coverage `cargo cov` (summary) / `cargo cov-gate`
  (fails <90%) — aliases in `src-tauri/.cargo/config.toml`. The gate excludes
  bootstrap/IPC (`main.rs`, `lib.rs`, `commands.rs`) and the I/O-orchestration
  ingest files (`ingest/claude_code.rs` watcher, `ingest/opencode.rs` client) —
  their normalizers have unit tests; the run loops are integration-tested
  (`cargo test … -- --ignored`). ⚠ `cargo llvm-cov` builds a separate
  instrumented target (~2GB) — `rm -rf src-tauri/target/llvm-cov-target` after.
- **Git:** origin `git@github.com:slaveofcode/Eridian.git`; **git-flow** (production
  `main`, develop `develop`); work happens on `develop` (or `feature/*`).
  Conventional commits. **Do NOT add a `Co-Authored-By` trailer** (user preference).

## Architecture map (where things live)
Rust (`src-tauri/src/`):
- `store.rs` — SQLite store: `Mutex<Connection>`, migration runner (`PRAGMA
  user_version`), `NORMALIZER_VERSION` self-heal, atomic `commit_batches`, all read
  queries (`list_sessions` w/ token totals, `session_events`, `session_changes` [capped
  400 files], `session_subagents`, `search_events`, `usage_by_day`,
  `reconcile_source_alive`, retention).
- `normalize.rs` — the shared event model: `NormalizedSession/Event/Batch`, `EventKind`.
- `ingest/claude_code.rs` — JSONL backfill + notify watcher + byte-offset tail +
  reconciliation sweep; tolerant line normalizer; real subagent parent links via a
  sidechain's `sessionId`; `usage()` sums input+cache_read+cache_creation tokens.
- `ingest/opencode.rs` — REST bootstrap (per-project `/session?directory=`) + SSE +
  poll; `normalize_session_obj/normalize_message_obj/normalize_part` (reused by cold).
- `ingest/opencode_cold.rs` — read-only import from `opencode.db` (server-down history).
- `inspect.rs` — pure risk classify + file-change/diff extraction (heavily tested).
- `mcp_config.rs`, `skills_config.rs` — on-disk config readers (secret masking).
- `commands.rs` — Tauri command surface + DTOs (serde camelCase). `lib.rs` — setup,
  ingest threads, invoke handler, managed opencode child lifecycle.

Frontend (`src/`): `App.tsx` (view state + navigation), `lib/{types,api,format,hooks}.ts`
(types mirror Rust DTOs; all backend access via `api.ts`), `components/*` (Timeline,
EventCard, ChangesTab, DiffView, CodeView [zero-dep highlighter], FileViewer, Markdown,
XmlView, SessionList, AgentColumn, McpPanel, SkillsPanel, ServersPanel, SettingsPanel,
ProfileMenu, SearchResults). No state library.

## Working notes (learned the hard way)
- **Format change → new fixture first.** Normalizer tests live against
  `src-tauri/fixtures/` (scrubbed real sessions). When CC/OpenCode change shape, add a
  fixture, then fix.
- **Changing normalizer output → bump `NORMALIZER_VERSION`** (`store.rs`). On next
  launch the store drops its derived cache and re-ingests. It's currently `4`.
- **Rules of Hooks:** put every `useState/useEffect/useRef/useMemo` **above** any early
  `return` in a component — TypeScript won't catch a conditional hook; it blanks the UI.
- All timestamps stored ISO-8601 UTC. Single writer; all writes in transactions;
  `commit_batches` writes events + `ingest_state` offset atomically. `insert_event`
  dedups on `source_uuid` — make it globally unique (see the cold-import id injection).

## Things NOT to do
- Don't build config writing/sync, key management, or any Codex/Gemini adapter yet.
- Don't "fix" agent files or suggest chmod on them; surface findings in UI instead.
- Don't render from agent files directly; UI reads only from Eridian's DB/commands.
- Subagent↔parent links are now **real** (sidechain `sessionId`), not heuristic — keep
  them real; don't reintroduce project+time guessing. Risk tags remain heuristic (label
  them so).
- **This repo is public — no personal/work identifiers, ever.** Commit as
  `Kresna <slaveofcode@users.noreply.github.com>` (repo-local git config). No employer
  emails/URLs, machine usernames/paths, internal tool or ticket names, or pasted raw
  command output (server lists, env dumps, secrets) in code, tests, fixtures, docs, or
  commit messages. Full rules: `.claude/skills/eridian-development/SKILL.md`.
