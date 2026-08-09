# Changelog

All notable changes to Eridian are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [0.1.0] — 2026-08-09

First public release — a local, read-only desktop dashboard that unifies your
**Claude Code** and **OpenCode** sessions.

### Added

- **Unified sessions.** Claude Code ingested live via a filesystem watcher + byte-offset
  tail; OpenCode via REST bootstrap + SSE, plus a read-only cold-import from `opencode.db`
  so history shows even when the server is down. Plugin-generated sessions (e.g.
  claude-mem) are grouped in their own section.
- **Timeline.** Per-kind cards (prompt / assistant / thinking / tool call + result /
  system), Markdown + XML rendering, inline image previews, kind-filter chips, token &
  context-fill badges, and one-click copy of the session id or a `--resume` command.
- **Change inspection.** Per session, split into Subagents / Commands / Files tabs:
  GitHub-style diffs, syntax-highlighted full-content previews, CLI commands with
  heuristic risk tags (danger / notable / safe), a subagent activity graph, and a
  session activity graph. Large sessions paginate.
- **Skill & command detection.** Surfaces which skills and slash commands ran in a
  session.
- **File viewer with git time-travel.** Open any file, skill, or config: syntax
  highlighting + line numbers, Markdown source/rendered toggle, image rendering,
  copy-path, and a history picker to view the file at any past commit.
- **Full-text search** (FTS5) across every agent's history, with jump-to-event.
- **Token usage view** — per-day input/output chart over 7/30/90 days.
- **MCP & Skills panels** — read-only, parsed from on-disk config with secrets masked;
  click a row to open the source.
- **Server control** — start / stop / force-kill an Eridian-managed `opencode serve`
  with live stdout.
- **Durable archive** — retains sessions after the agent purges its source transcript
  ("archived — source purged" badge); configurable retention and rebuild-from-disk.
- **Automatic updates** — signed in-app updates via GitHub Releases.
- **Layout** — drag-resizable sidebar & session list, pinned sessions, ops-console theme.

### Security & privacy

- Strictly **read-only** against agent data; the only write action is starting/stopping
  an OpenCode server you launch yourself.
- **Local only** — no telemetry, no update checks beyond the signed release feed, no
  network calls except to a local OpenCode server.
- Transcript bodies are never logged; the local database is created `0600`.

### Known limitations

- Builds are not OS-code-signed: macOS Gatekeeper shows "damaged" and Windows SmartScreen
  warns about an unrecognized app — see the README to open them either way.

[0.1.0]: https://github.com/slaveofcode/Eridian/releases/tag/v0.1.0
