# Contributing to Eridian

Thanks for your interest! Eridian is a local, read-only dashboard for AI coding agents.
The most important thing to understand before contributing is the **safety model** — it's
what makes the project trustworthy, and PRs that weaken it won't be merged.

## Non-negotiable guarantees

- **Read-only against agent data.** Never write, rename, truncate, or lock anything under
  `~/.claude/`, `~/.config/opencode/`, or `~/.local/share/opencode/`. Open files
  read-only; the OpenCode DB uses `SQLITE_OPEN_READ_ONLY`. Eridian writes only to its own
  app-data directory. The single allowed exception is starting/stopping/force-killing an
  Eridian-*managed* `opencode serve` (localhost, user-invoked) — and only Eridian's own
  child process.
- **Never crash ingest on bad input.** Any unparseable line/event becomes an event with
  `kind = "unknown"` plus the raw payload, a `tracing::warn!` (path + offset only), and
  processing continues. No `unwrap()`/`expect()` in ingest or command paths — use
  `anyhow::Result` + `?`.
- **Transcripts are sensitive.** Never log event/message bodies, tool inputs/outputs, or
  anything from `raw_json`. Log paths, counts, offsets, and durations only. The database
  is created `0600`.
- **Local only.** No new network destinations beyond `http://localhost:<opencode_port>`.
  No telemetry, no update checks.
- **No dependencies without justification.** State why in the PR. The frontend renders
  with zero runtime rendering deps (its own Markdown + syntax highlighter) — no
  highlight.js/shiki/Tailwind.

## Stack & commands

- **Tauri 2** (Rust, edition 2021) + **React 18** + **TypeScript** (strict) + **Vite** +
  hand-written CSS (`src/App.css`). Package manager: **pnpm**.

```bash
pnpm install
pnpm tauri dev                          # run the app
pnpm test  /  pnpm test:cov             # frontend tests (Vitest) + coverage gate
pnpm tsc --noEmit                       # frontend typecheck
pnpm build                              # frontend production build
cd src-tauri && cargo test              # Rust tests
cargo clippy -- -D warnings             # Rust lint
cargo cov  /  cargo cov-gate            # Rust coverage (cargo-llvm-cov; gate at 90%)
```

`cargo llvm-cov` builds a separate instrumented target (~2 GB) — run
`rm -rf src-tauri/target/llvm-cov-target` afterward if disk is tight.

## Architecture

Each ingester **normalizes at the edge** into one shared event model, then writes to a
single SQLite store; the UI reads only through Tauri commands.

**Rust (`src-tauri/src/`):**

- `normalize.rs` — the shared event model (`NormalizedSession/Event/Batch`, `EventKind`).
  This is the contract between ingesters and everything downstream; keep it small.
- `store.rs` — SQLite store: `Mutex<Connection>`, migration runner (`PRAGMA
  user_version`), `NORMALIZER_VERSION` self-heal, atomic `commit_batches`, and all read
  queries (sessions with token rollups, events, changes, subagents, search, usage-by-day,
  archive reconcile, retention).
- `ingest/claude_code.rs` — JSONL backfill + notify watcher + byte-offset tail +
  reconciliation sweep; tolerant line normalizer; real subagent parent links via a
  sidechain's `sessionId`.
- `ingest/opencode.rs` — REST bootstrap (per-project) + SSE + poll; the normalizers here
  are reused by the cold importer.
- `ingest/opencode_cold.rs` — read-only import from `opencode.db` (server-down history).
- `inspect.rs` — pure risk classification + file-change/diff extraction + skill/command
  detection (heavily unit-tested).
- `git_history.rs` — read-only `git log`/`git show` for the viewer's time-travel.
- `mcp_config.rs`, `skills_config.rs` — on-disk config readers (secret masking).
- `commands.rs` — the Tauri command surface + DTOs (serde `camelCase`).
- `lib.rs` — setup, ingest threads, invoke handler, managed OpenCode child lifecycle.

**Frontend (`src/`):** `App.tsx` (view state + navigation), `lib/{types,api,format,hooks}.ts`
(types mirror the Rust DTOs; all backend access via `api.ts`), and `components/*`
(Timeline, EventCard, ChangesTab, DiffView, CodeView, FileViewer, Markdown, XmlView,
SessionList, AgentColumn, McpPanel, SkillsPanel, ServersPanel, SettingsPanel, …). No state
library.

## Conventions

- **All timestamps** are stored as ISO-8601 UTC strings.
- **Single writer:** every write goes through a transaction; `commit_batches` writes
  events and the ingest offset atomically. `insert_event` dedups on a globally-unique
  `source_uuid`.
- **Changing normalizer output → bump `NORMALIZER_VERSION`** in `store.rs`. On next launch
  the store drops its derived cache and re-ingests (the DB is a rebuildable index).
- **Format changes start with a fixture.** Normalizer tests run against scrubbed real
  sessions in `src-tauri/fixtures/`. When an agent changes shape, add a fixture, then fix.
- **Rules of Hooks:** put every `useState/useEffect/useRef/useMemo` **above** any early
  `return` — TypeScript won't catch a conditional hook, and it blanks the UI at runtime.
- **Subagent↔parent links are real** (from the sidechain `sessionId`), not heuristic —
  keep them real. Risk tags *are* heuristic and are labeled as such in the UI.
- **Commits:** Conventional Commits. Do **not** add a `Co-Authored-By` trailer.

## Adding a new agent adapter (high level)

1. Write an ingester under `ingest/` that produces `NormalizedBatch`es — normalize the
   agent's format into the shared model; never crash on bad input.
2. Reuse the store's `commit_batches`; give each event a globally-unique `source_uuid`.
3. Add fixtures + normalizer unit tests.
4. Surface it in the UI via the existing agent-grouping (no bespoke rendering).

## Tests

New behavior is test-driven; tests for existing code are characterization tests that pin
current behavior. Aim to keep the coverage gate green (`pnpm test:cov`, `cargo cov-gate`).

## Releasing

Releases are built by `.github/workflows/release.yml` (macOS arm64 + Intel, Linux) and
published as a draft GitHub Release. Auto-update artifacts (`latest.json` + per-platform
`.sig`) are generated when the signing secrets are present.

**One-time setup (maintainer):**

1. Generate an updater keypair (keep the private key secret, out of the repo):
   ```bash
   pnpm tauri signer generate -w ~/.tauri/eridian-updater.key
   ```
2. Put the **public** key in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. Add the repository **secret** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of the private key file.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — **only if your key has a password.** If it
     doesn't (the default here), do **not** create this secret — GitHub rejects empty
     secret values, and the workflow already treats a missing one as no password.

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo slaveofcode/Eridian < ~/.tauri/eridian-updater.key
   ```

**Cutting a release:**

1. **Update [CHANGELOG.md](CHANGELOG.md)** — add a new `## [x.y.z] — YYYY-MM-DD` section
   (Added / Changed / Fixed / Security). Every release must have a changelog entry; the
   release notes link to it.
2. Bump the version in `src-tauri/tauri.conf.json`, `package.json`, and
   `src-tauri/Cargo.toml` (keep them in sync).
3. Merge to `main` (git-flow) and tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The workflow builds all platforms and creates a **draft** release — review the
   attached bundles + `latest.json`, then publish. Running apps will pick up the update
   on next launch.

> Bundles are currently **unsigned by the OS** (no Apple notarization / Windows
> Authenticode). The Tauri updater signature above is separate and always required — it's
> what makes auto-update secure.
