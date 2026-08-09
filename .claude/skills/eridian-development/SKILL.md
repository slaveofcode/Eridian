---
name: eridian-development
description: Use when developing, reviewing, or releasing the Eridian app (this repo) — the guardrails, commands, conventions, git-flow, commit rules, and release process to keep every change aligned.
---

# Eridian development

Eridian is a local, **read-only** desktop dashboard (Tauri 2 + Rust core / React + TS)
for AI coding agents (Claude Code + OpenCode). Follow this on every change. Deeper
detail: `CONTRIBUTING.md`, `CLAUDE.md`, `PLAN.md`.

## Guardrails (never violate)

1. **Read-only against agent data.** Never write/rename/truncate under `~/.claude/`,
   `~/.config/opencode/`, `~/.local/share/opencode/`. Files opened read-only; the
   OpenCode DB uses `SQLITE_OPEN_READ_ONLY`. Eridian writes only its own app-data dir.
   Sole exception: starting/stopping an Eridian-*managed* `opencode serve` (localhost,
   user-invoked).
2. **Never crash ingest on bad input** → store `kind="unknown"` + raw, `tracing::warn!`
   (path/offset only), continue. No `unwrap()/expect()` in ingest/command paths; use
   `anyhow::Result` + `?`.
3. **Transcripts are sensitive** — never log event/message bodies, tool inputs/outputs,
   or `raw_json`. Log paths/counts/offsets/durations only. DB is `0600`.
4. **Local only** — no network except `http://localhost:<opencode_port>`; no telemetry.
5. **No dependencies without stating why.** Frontend renders zero-dep (own Markdown +
   syntax highlighter) — no highlight.js/shiki/Tailwind.

## Commands (run before every commit)

```bash
pnpm tauri dev                     # run the app
pnpm test        pnpm test:cov     # frontend tests (Vitest) + coverage gate
pnpm exec tsc --noEmit             # frontend typecheck
pnpm build                         # frontend build
cd src-tauri && cargo test         # Rust tests
cargo clippy -- -D warnings        # Rust lint
cargo cov-gate                     # Rust coverage gate (≥90%); rm target/llvm-cov-target after
```

Keep both coverage gates green (logic modules ≥90%).

## Conventions

- **Change normalizer output → bump `NORMALIZER_VERSION`** in `store.rs` (store drops its
  derived cache and re-ingests on next launch).
- **Format change → add a fixture first** in `src-tauri/fixtures/`, then fix.
- **Rules of Hooks:** every `useState/useEffect/useRef/useMemo` goes **above** any early
  `return` — TS won't catch a conditional hook; it blanks the UI at runtime.
- Timestamps stored ISO-8601 UTC. Single writer; `commit_batches` writes events + offset
  atomically; `insert_event` dedups on a globally-unique `source_uuid`.
- Subagent↔parent links are **real** (sidechain `sessionId`) — never revert to heuristics.
  Risk tags **are** heuristic — keep them labeled as such in the UI.
- UI reads only through Tauri commands (`src/lib/api.ts`); never touch agent files from
  the frontend. New Tauri command → register in `lib.rs`.

## Git & commits

- **git-flow:** production `main`, develop `develop`; work on `develop` / `feature/*`;
  releases via `release/*`. Origin `git@github.com:slaveofcode/Eridian.git`.
- **Conventional Commits.**
- **NEVER add any Claude/AI attribution or contributor to commits** — no
  `Co-Authored-By`, no "Generated with…", no AI author/committer identity, in the
  message body, trailers, or metadata. (Referencing "Claude Code" as the *supported
  agent* in a message is fine, e.g. "Claude Code ingest".)

## Public-repo hygiene (security — this repo is public)

- **Commit identity is `Kresna <slaveofcode@users.noreply.github.com>`** (set in this
  repo's local git config). Never commit with a work/employer email.
- **No employer/work identifiers anywhere** — not in code, config, tests, fixtures,
  commit messages, or docs: no employer email domains or URLs, no work-machine
  usernames or absolute home paths, no internal tool/skill/ticket names, no
  chat-platform app ids/secrets. Use neutral placeholders in tests (e.g.
  `sample-review`). Do not list the concrete forbidden terms in this repo either —
  the deny-list itself would leak them; it lives in private session memory.
- **Never paste raw command/tool output into commit messages** — `claude mcp list`,
  server lists, env dumps, connection strings. Summarize the verification result
  instead. (This once leaked internal MCP URLs + a chat-platform app secret into a
  public commit; it forced a full history rewrite.)
- **Bundle identifier is `com.velmlabs.eridian`** — never revert it to anything
  containing a personal/work handle.
- **Before pushing**, scan the outgoing range:
  `git log origin/develop.. -p | grep -iE "kresna@|cli_[a-z0-9]{10,}|(api[_-]?key|secret|token)\s*[:=]"`
  plus the private deny-list terms — any hit blocks the push until scrubbed
  (amend/rebase, don't stack a "remove" commit: the leak would stay in history).

## Releasing (every release needs a CHANGELOG entry)

1. **Update `CHANGELOG.md`** — add `## [x.y.z] — YYYY-MM-DD` (Added/Changed/Fixed/Security).
2. Bump version in `src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`
   (keep in sync).
3. git-flow to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. `.github/workflows/release.yml` builds macOS (arm+intel) + Linux + Windows, signs
   updater artifacts, writes `latest.json`, creates a **draft** release → review
   bundles, publish.
5. Signing: repo secret `TAURI_SIGNING_PRIVATE_KEY` (private key at `~/.tauri/eridian-
   updater.key`); no password secret (key has none; GitHub rejects empty secrets).
   Public key lives in `tauri.conf.json` → `plugins.updater.pubkey`.
