# Changelog

All notable changes to Eridian are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [0.3.5] — 2026-08-13

### Fixed

- **Drill-in highlight restored.** Clicking a Shell (or search) result again scrolls
  to the exact event and flashes it — the v0.3.2 scroll-anchoring was fighting the
  drill-in scroll and landing the focused card off-screen, so the highlight was
  missed. Anchoring now stands down while a scroll-to-index is in flight.
- **Subtler focus flash.** The highlight is now a thin amber ring with a soft halo
  that pulses once and fades, instead of a thick ring and a large bright glow.

## [0.3.4] — 2026-08-13

### Fixed

- **Friendlier update-check error.** When “Check for updates” can’t reach the
  release feed (e.g. a transient network blip), it now shows a concise, actionable
  message instead of the raw HTTP error and URL; the underlying error is logged to
  the console for debugging.

## [0.3.3] — 2026-08-13

### Added

- **About & updates in Settings.** A new section shows the running version, live
  update status, and last-checked time, with a **Check for updates** button that
  re-checks the signed release feed on demand (the profile menu only checks once at
  launch, so a release published while the app is open otherwise looked “up to
  date” until relaunch), an install action, and a link to the release notes.

## [0.3.2] — 2026-08-12

A review-clarity and smoothness release: meta lines now say what they are (and
expand to their raw payload), the timeline scrolls smoothly, and rebuild actually
reclaims disk. Still strictly read-only against agent data.

### Added

- **Meta lines say what they are.** Claude Code control lines are no longer
  collapsed to a single word — each `attachment` shows its kind and a detail
  (`attachment · hook_success · PreToolUse`, `· file · src/lib.rs`,
  `· skill_listing · 27`, `· deferred_tools_delta · +2/-1`), and `bridge session`
  / `last prompt` are labelled too.
- **Expandable raw payload.** Click any meta row to reveal its full, pretty-printed
  raw JSON — fetched lazily and size-capped, so nothing stays hidden and memory
  stays bounded.

### Changed

- **Rebuild reclaims disk.** “Rebuild from disk” (and the normalizer re-ingest) now
  `VACUUM`, so *size on disk* drops to near-zero and grows back with the backfill
  like the session/event counters, instead of staying pinned at the old footprint.
- **Text legibility.** Higher-contrast secondary text (now meets AA) and larger
  body/meta type, while keeping the ops-console look.
- The Settings Database card live-updates for the whole duration of a rebuild and
  no longer blanks during a transient refresh.

### Performance

- **Smooth timeline scrolling.** Scroll updates are coalesced to one per animation
  frame, row heights are measured in whole pixels, the list anchors the scroll when
  an off-screen row’s height corrects (no more “content pushed up”), and unmeasured
  rows use per-kind height estimates — together fixing the low-FPS scroll and jumps.

## [0.3.1] — 2026-08-12

A small patch fixing the progress banner after a manual rebuild.

### Fixed

- **Rebuild progress banner no longer sticks.** After a Settings → “Rebuild from
  disk”, the backfill strip could stay pinned at “N/N files” even though the
  rebuild had finished successfully — the rebuild path never emitted the terminal
  event that clears it (only the normal startup ingest did). Rebuild now emits that
  event on both success and failure, and the banner also clears on any terminal
  signal as a safeguard.

## [0.3.0] — 2026-08-12

A big inspection-and-visibility release: a new **Shell** view for shell commands, a
virtualized timeline with merged tool cards, browser-like navigation, and a richer
token-usage dashboard. Still strictly read-only against agent data.

### Added

- **Shell view** — a new top-level tab listing shell commands **running now** across
  all live sessions (command, session, live elapsed, risk) and a browsable **history**
  of finished ones (duration, risk, output on demand). Click any command to jump to it
  in the session timeline. Commands are paired to their results via a new `tool_use_id`
  correlation captured for both Claude Code and OpenCode.
- **Merged tool cards** — a tool call and its result render as one card once finished
  (input + result together), with a `running…` indicator while in flight.
- **Token-usage breakdowns** — the Usage page now breaks tokens down **by model** and
  **by agent** (ranked bars with an input/output split and session counts), each model
  in its own accessible color. Click a model or agent to filter the daily chart to just
  that series.
- **Expand-all** timeline toggle to open every input/result/thinking block at once
  (large blocks stay capped for memory safety).
- **Clickable PR/MR links** — the PR/MR system line now opens the pull/merge request in
  your browser (GitLab merge requests and GitHub pull requests both detected).

### Changed

- **Timeline is virtualized** — only the on-screen events render, so large and live
  sessions scroll smoothly. Drilling into a command scrolls precisely to it and flashes
  a fading highlight.
- **Browser-like back navigation** — the breadcrumb back button walks your actual
  history (subagent → parent, Shell/search → source) and restores the tab you came from;
  it only appears when you drilled in.
- **Meta events are shown by default** (with `unknown` on its own toggle).
- Tool input/result disclosures are now spaced pill toggles; the Settings **Rebuild
  from disk** action uses an in-app confirmation.

### Fixed

- Rebuild-from-disk and other confirmations now work in the app window (native browser
  dialogs are inert there).
- Usage queries are indexed and window-bounded — the daily rollup went from seconds to
  well under a second on a large archive, and the page updates in place instead of
  reloading.

### Performance

- New `events(ts)` index and bounded token-usage queries; timeline windowing and a
  single shared clock for live elapsed timers keep memory and re-renders bounded.

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

[0.3.5]: https://github.com/slaveofcode/Eridian/releases/tag/v0.3.5
[0.3.4]: https://github.com/slaveofcode/Eridian/releases/tag/v0.3.4
[0.3.3]: https://github.com/slaveofcode/Eridian/releases/tag/v0.3.3
[0.3.2]: https://github.com/slaveofcode/Eridian/releases/tag/v0.3.2
[0.3.1]: https://github.com/slaveofcode/Eridian/releases/tag/v0.3.1
[0.2.0]: https://github.com/slaveofcode/Eridian/releases/tag/v0.2.0
[0.1.1]: https://github.com/slaveofcode/Eridian/releases/tag/v0.1.1
[0.1.0]: https://github.com/slaveofcode/Eridian/releases/tag/v0.1.0
