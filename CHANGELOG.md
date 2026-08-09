# Changelog

All notable changes to Eridian are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [0.2.0] — 2026-08-10

Adds a read-only **Skills & MCP catalog** so you can discover, audit, and get
install commands for skills and MCP servers — without Eridian ever writing to agent
data or uploading anything.

### Added

- **Skills & MCP “Discover” tabs.** Both pages gain an Installed | Discover split.
  Discover browses your local plugin-cache skills always, and — only if you opt in —
  the public [anthropics/skills](https://github.com/anthropics/skills) repo and the
  official [MCP Registry](https://registry.modelcontextprotocol.io). Everything is
  read-only: Eridian shows details, flags, and a copyable install/update/remove
  command — you run it.
- **Installed audit.** Installed skills and MCP servers show an update status
  (up to date / update available / local only / unknown origin), heuristic safety
  flags (clearly labelled heuristic), and copyable update/remove commands.
- **Opt-in catalog fetching.** A new Settings → Network toggle (default **off**)
  allows GET-only requests to a compiled-in allowlist —
  `registry.modelcontextprotocol.io`, `api.github.com`, `raw.githubusercontent.com` —
  to download public catalog metadata. Nothing is uploaded; responses are cached
  locally for 24h with a manual “Refresh catalogs” button.
- **In-app updates from the profile menu.** The menu now shows the running version
  and, when a newer signed release exists, an “Update to v…” action that downloads,
  installs, and relaunches.

### Changed

- Profile menu shows `Eridian v<version>` and update status; removed the placeholder
  “Connect to cloud” entry.

### Security & privacy

- Catalog browsing is the only non-localhost network path, is off by default,
  GET-only, allowlisted, and never uploads anything. Guardrails otherwise unchanged:
  strictly read-only against agent data, no telemetry, DB `0600`.

## [0.1.1] — 2026-08-09

Patch release fixing a serious memory-growth regression in the live timeline.

### Fixed

- **Live-timeline memory blowup & freeze.** During busy sessions (especially Claude Code
  runs with many subagents), each live event batch re-rendered every card in the open
  timeline — up to ~1000 cards, several times per second — re-doing all Markdown, XML,
  diff, and syntax-highlighting work. This saturated the webview thread (UI freeze),
  outran the browser garbage collector (multi-GB memory attributed to Eridian), and could
  end in the webview process being killed and reloaded. `EventCard` is now memoized and
  the file-open callback is stable, so existing cards stay inert on live appends and only
  newly-arrived events render. A regression test guards the render cost.

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

[0.2.0]: https://github.com/slaveofcode/Eridian/releases/tag/v0.2.0
[0.1.1]: https://github.com/slaveofcode/Eridian/releases/tag/v0.1.1
[0.1.0]: https://github.com/slaveofcode/Eridian/releases/tag/v0.1.0
