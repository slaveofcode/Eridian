import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  onEventsAppended,
  onIngestProgress,
  onSessionsUpdated,
} from "./lib/api";
import type {
  EventRow,
  IngestProgress,
  IngestStatus,
  SearchResult,
  SessionRow,
  ColdImportStatus,
} from "./lib/types";
import { useDebouncedValue } from "./lib/hooks";
import { useNavStack } from "./lib/navStack";
import { AgentColumn } from "./components/AgentColumn";
import { SessionList } from "./components/SessionList";
import { Timeline } from "./components/Timeline";
import { IngestBanner } from "./components/IngestBanner";
import { SearchResults } from "./components/SearchResults";
import { McpPanel } from "./components/McpPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { ShellPanel } from "./components/ShellPanel";
import { UsagePanel } from "./components/UsagePanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { ServersPanel } from "./components/ServersPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileMenu } from "./components/ProfileMenu";
import { FileViewer } from "./components/FileViewer";
import { ConfirmModal } from "./components/ConfirmModal";
import "./App.css";

function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [subagentCounts, setSubagentCounts] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [firstLoad, setFirstLoad] = useState(true); // until first list resolves
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [changesSignal, setChangesSignal] = useState(0);
  // Browser-like navigation history: `navigate` pushes a back entry, `back`
  // restores the previous state. Holds tiny descriptors only (ids/anchors).
  const { nav, canGoBack, navigate, back } = useNavStack({
    view: "sessions",
    activeId: null,
    agentFilter: null,
    trail: [],
    focusEventId: null,
  });
  const { view, activeId, agentFilter, focusEventId } = nav;
  const navStack = nav.trail; // subagent ancestry
  const [viewer, setViewer] = useState<{ path: string; find?: string } | null>(null);
  // Stable identity: this reaches every memoized EventCard — a fresh closure per
  // render would defeat the memo and re-render the whole live timeline.
  const openFile = useCallback((path: string, find?: string) => setViewer({ path, find }), []);
  // Pinned sessions (persisted) — surfaced at the top of the list.
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("eridian.pinned") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const togglePin = (id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem("eridian.pinned", JSON.stringify([...next]));
      return next;
    });

  const [coldPrompt, setColdPrompt] = useState<ColdImportStatus | null>(null);
  const [coldBusy, setColdBusy] = useState(false);
  const coldAskedRef = useRef(false); // ask at most once per app run

  // User-resizable columns (persisted): agent sidebar + session list.
  const clampInit = (key: string, def: number, min: number, max: number) => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  };
  const [sideWidth, setSideWidth] = useState(() => clampInit("eridian.sideWidth", 172, 140, 320));
  const [listWidth, setListWidth] = useState(() => clampInit("eridian.listWidth", 320, 220, 720));
  const [dragging, setDragging] = useState<null | "side" | "list">(null);
  const makeResize =
    (which: "side" | "list") => (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(which);
      const startX = e.clientX;
      const [startW, set, key, min, max] =
        which === "side"
          ? ([sideWidth, setSideWidth, "eridian.sideWidth", 140, 320] as const)
          : ([listWidth, setListWidth, "eridian.listWidth", 220, 720] as const);
      const onMove = (m: MouseEvent) =>
        set(Math.min(max, Math.max(min, startW + (m.clientX - startX))));
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setDragging(null);
        set((w) => {
          localStorage.setItem(key, String(w));
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  const debouncedQuery = useDebouncedValue(query.trim(), 200);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const statusRef = useRef<IngestStatus | null>(null);
  statusRef.current = status;

  // Offer a (confirmed) OpenCode cold-import when the server is down and the
  // local opencode.db has history we haven't imported. Wait a few seconds first
  // so a starting server isn't misread as "down". Ask at most once per run.
  useEffect(() => {
    const t = setTimeout(async () => {
      if (coldAskedRef.current || statusRef.current?.opencodeConnected) return;
      try {
        const cs = await api.opencodeColdStatus();
        if (cs.available && cs.pending > 0) {
          coldAskedRef.current = true;
          setColdPrompt(cs);
        }
      } catch {
        /* no local opencode.db — nothing to offer */
      }
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  const runColdImport = async () => {
    setColdBusy(true);
    try {
      await api.opencodeColdImport();
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    } finally {
      setColdBusy(false);
      setColdPrompt(null);
    }
  };

  const refreshSessions = useCallback(async () => {
    try {
      const [rows, st, parents] = await Promise.all([
        api.listSessions(),
        api.ingestStatus(),
        api.subagentParents(),
      ]);
      setSessions(rows);
      setStatus(st);
      setSubagentCounts(new Map(parents.map((p) => [p.sessionId, p.count])));
    } catch (e) {
      setError(String(e));
    } finally {
      setFirstLoad(false);
    }
  }, []);

  // Register live subscriptions exactly once. Handlers read fresh values via
  // refs, so the effect never needs to re-run (which would churn/leak listeners).
  useEffect(() => {
    let mounted = true;
    const unsubs: UnlistenFn[] = [];
    const keep = (u: UnlistenFn) => (mounted ? unsubs.push(u) : u());

    // Coalesce the refetch storm from rapid live events into ≤1 per 400ms.
    let lastRun = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const throttledRefresh = () => {
      const now = Date.now();
      // The list is for navigation, not the live view (the timeline is) — a
      // slightly coarser cadence halves refetch cost with no real UX loss.
      const wait = 800 - (now - lastRun);
      if (wait <= 0) {
        lastRun = now;
        void refreshSessions();
      } else if (!timer) {
        timer = setTimeout(() => {
          lastRun = Date.now();
          timer = null;
          void refreshSessions();
        }, wait);
      }
    };

    void refreshSessions();
    onSessionsUpdated(throttledRefresh).then(keep);
    onIngestProgress((p) => setProgress(p)).then(keep);
    onEventsAppended((p) => {
      if (p.sessionId !== activeIdRef.current) return;
      setEvents((prev) => mergeEvents(prev, p.events));
    }).then(keep);

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!activeId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    // Drill-in (focusEventId set) → load the window AROUND the target so an
    // event outside the recent 300 (e.g. a long-running command) is present and
    // scroll-able. Otherwise load the most-recent window. Both end chronological.
    const load =
      focusEventId != null
        ? api.sessionEventsAround(activeId, focusEventId)
        : api.sessionEvents(activeId, 300).then((rows) => rows.slice().reverse());
    load
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoadingEvents(false));
    return () => {
      cancelled = true;
    };
  }, [activeId, focusEventId]);

  // Run FTS search when the debounced query changes.
  useEffect(() => {
    if (!debouncedQuery) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api
      .searchEvents(debouncedQuery)
      .then((r) => !cancelled && setResults(r))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // Select a top-level session (list/search) — resets the drill-in trail.
  const selectSession = (id: string) =>
    navigate({ ...nav, view: "sessions", activeId: id, trail: [], focusEventId: null });

  const openResult = (r: SearchResult) =>
    navigate({ ...nav, view: "sessions", activeId: r.sessionId, trail: [], focusEventId: r.id });

  // Shell view drill-in → jump to the source event in its session timeline.
  const openCommand = (sessionId: string, eventId: number) =>
    navigate({ ...nav, view: "sessions", activeId: sessionId, trail: [], focusEventId: eventId });

  // Clicking a session's subagent badge → open it on the Changes tab.
  const openChanges = (id: string) => {
    navigate({ ...nav, view: "sessions", activeId: id, trail: [], focusEventId: null });
    setChangesSignal((x) => x + 1);
  };

  // Drill into a (sub)agent from a flow graph — push the current session onto
  // the trail so we can walk back through an arbitrarily deep chain.
  const openSubagent = (id: string) =>
    navigate(
      activeId && id !== activeId
        ? { ...nav, activeId: id, trail: [...nav.trail, activeId] }
        : { ...nav, activeId: id }
    );
  // Jump to an ancestor at trail index i (truncates everything after it).
  const navTo = (i: number) => {
    const target = navStack[i];
    if (target) navigate({ ...nav, activeId: target, trail: navStack.slice(0, i) });
  };
  const trail = useMemo(
    () =>
      navStack
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionRow => !!s),
    [navStack, sessions]
  );

  const startOpencode = async () => {
    try {
      await api.startOpencode();
    } catch (e) {
      setError(String(e));
    }
    // The ingest loop connects within a couple seconds; nudge a status refresh.
    setTimeout(() => void refreshSessions(), 2500);
  };
  const stopOpencode = async () => {
    try {
      await api.stopOpencode();
    } catch (e) {
      setError(String(e));
    }
    setTimeout(() => void refreshSessions(), 800);
  };

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  );
  // Subagents nest under their parent; claude-mem observer sessions are a
  // background agent, not the user's work — both are kept out of the main list
  // (subagents reachable via the Changes tree; observers via their own category).
  const topLevel = useMemo(
    () => sessions.filter((s) => !s.isSubagent && !isBackground(s)),
    [sessions]
  );
  // Count only the live sessions actually shown in the list (top-level, not
  // subagents/observer) so the header matches what the user sees.
  const liveCount = useMemo(() => topLevel.filter((s) => s.live).length, [topLevel]);
  // Plugin-origin sessions grouped by exact plugin name (for the PLUGINS section).
  const pluginGroups = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) {
      if (s.isSubagent) continue;
      const pl = pluginOf(s);
      if (pl) m.set(pl, (m.get(pl) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [sessions]);
  const listedSessions = useMemo(() => {
    if (agentFilter?.startsWith("plugin:")) {
      const name = agentFilter.slice("plugin:".length);
      return sessions.filter((s) => !s.isSubagent && pluginOf(s) === name);
    }
    if (agentFilter) return topLevel.filter((s) => s.agent === agentFilter);
    return topLevel;
  }, [topLevel, sessions, agentFilter]);

  // Show a full-panel "building history" state instead of a blank/empty list
  // while the very first load or a full re-ingest (NORMALIZER bump) runs.
  const backfilling = !!progress && progress.phase !== "watching";
  const historyLoading = sessions.length === 0 && (firstLoad || backfilling) && !debouncedQuery;

  return (
    <div className="app">
      <header
        className="app-bar"
        onMouseDown={(e) => {
          // Drag the window from empty header space; ignore interactive controls
          // and secondary buttons. Programmatic startDragging is more reliable
          // than data-tauri-drag-region in this webview.
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("input, button, a, select, textarea")) return;
          void getCurrentWindow().startDragging();
        }}
      >
        <h1>Eridian</h1>
        <div className="app-nav">
          <input
            className="global-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all events…"
            aria-label="Search all events"
            spellCheck={false}
          />
          <div className="view-tabs">
            {(["sessions", "shell", "mcp", "skills", "usage"] as const).map((v) => (
              <button
                key={v}
                className={`view-tab${view === v ? " on" : ""}`}
                onClick={() => navigate({ ...nav, view: v })}
              >
                {v === "mcp" ? "MCP" : v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="app-status muted">
          {status && (
            <>
              <Stat label="sessions" value={sessions.length} />
              <Stat label="cc events" value={status.claudeCodeEvents.toLocaleString()} />
              <Stat label="live" value={liveCount} accent={liveCount > 0} />
            </>
          )}
          {error && <span className="error" title={error}>· error</span>}
        </div>
        <ProfileMenu onOpenSettings={() => navigate({ ...nav, view: "settings" })} />
      </header>

      <UpdateBanner />
      <IngestBanner progress={progress} />

      <div
        className="app-body"
        style={{
          ["--side-w" as string]: `${sideWidth}px`,
          ["--list-w" as string]: `${listWidth}px`,
        }}
      >
        <AgentColumn
          sessions={topLevel}
          plugins={pluginGroups}
          selected={view === "sessions" ? agentFilter : null}
          onSelect={(a) => navigate({ ...nav, agentFilter: a, view: "sessions" })}
          opencodeConnected={status?.opencodeConnected ?? false}
          onOpenServers={() => navigate({ ...nav, view: "servers" })}
          serversActive={view === "servers"}
        />

        <div
          className={`col-resizer${dragging === "side" ? " dragging" : ""}`}
          onMouseDown={makeResize("side")}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize sidebar"
        />

        {view === "shell" ? (
          <div className="panel-span">
            <ShellPanel onDrillIn={openCommand} />
          </div>
        ) : view === "mcp" ? (
          <div className="panel-span">
            <McpPanel onOpenFile={openFile} />
          </div>
        ) : view === "skills" ? (
          <div className="panel-span">
            <SkillsPanel onOpenFile={openFile} />
          </div>
        ) : view === "usage" ? (
          <div className="panel-span">
            <UsagePanel />
          </div>
        ) : view === "settings" ? (
          <div className="panel-span">
            <SettingsPanel />
          </div>
        ) : view === "servers" ? (
          <div className="panel-span">
            <ServersPanel status={status} onStart={startOpencode} onStop={stopOpencode} />
          </div>
        ) : (
          historyLoading ? (
            <HistoryLoading progress={progress} />
          ) : (
            <>
              {debouncedQuery ? (
                <SearchResults
                  query={debouncedQuery}
                  results={results}
                  loading={searching}
                  onSelect={openResult}
                />
              ) : (
                <SessionList
                  sessions={listedSessions}
                  activeId={activeId}
                  onSelect={selectSession}
                  onOpenChanges={openChanges}
                  subagentCounts={subagentCounts}
                  pinned={pinned}
                  onTogglePin={togglePin}
                />
              )}
              <div
                className={`col-resizer${dragging === "list" ? " dragging" : ""}`}
                onMouseDown={makeResize("list")}
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize"
              />
              <Timeline
                session={activeSession}
                events={events}
                loading={loadingEvents}
                focusEventId={focusEventId}
                changesSignal={changesSignal}
                trail={trail}
                onNavTo={navTo}
                onOpenSubagent={openSubagent}
                onOpenFile={openFile}
                onBack={back}
                canGoBack={canGoBack}
              />
            </>
          )
        )}
      </div>

      {viewer && (
        <FileViewer path={viewer.path} find={viewer.find} onClose={() => setViewer(null)} />
      )}

      {coldPrompt && (
        <ConfirmModal
          title="Import local OpenCode history?"
          confirmLabel={`Import ${coldPrompt.pending} session${coldPrompt.pending === 1 ? "" : "s"}`}
          cancelLabel="Not now"
          busy={coldBusy}
          onConfirm={runColdImport}
          onCancel={() => setColdPrompt(null)}
          body={
            <>
              <p>
                The OpenCode server isn’t running, so live sync is unavailable. Eridian can
                load <strong>{coldPrompt.pending}</strong> session
                {coldPrompt.pending === 1 ? "" : "s"} (of {coldPrompt.total}) directly from its
                local database.
              </p>
              <p className="muted">
                Read-only — Eridian never modifies <code>opencode.db</code>. You can also start
                the server from the Servers page for live updates.
              </p>
            </>
          }
        />
      )}
    </div>
  );
}

// Full-panel state shown on first launch / full re-ingest so the window never
// looks blank while the durable archive is being (re)built from disk.
function HistoryLoading({ progress }: { progress: IngestProgress | null }) {
  const pct =
    progress && progress.filesTotal > 0
      ? Math.round((progress.filesDone / progress.filesTotal) * 100)
      : null;
  return (
    <div className="history-loading">
      <div className="history-loading-inner">
        <div className="spinner" aria-hidden />
        <h2>Building your history…</h2>
        <p className="muted">
          Eridian is reading your agent transcripts into its local archive. This
          only takes a while the first time (or after an upgrade) — it’s fast
          afterward.
        </p>
        {progress && (
          <>
            <div className="history-bar-track">
              <div
                className="history-bar-fill"
                style={{ width: pct != null ? `${pct}%` : "40%" }}
              />
            </div>
            <p className="muted num history-loading-stat">
              {progress.filesDone.toLocaleString()}
              {progress.filesTotal > 0 ? ` / ${progress.filesTotal.toLocaleString()}` : ""} files ·{" "}
              {progress.events.toLocaleString()} events
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <span className={`stat${accent ? " accent" : ""}`}>
      <span className="stat-value num">{value}</span>
      <span className="stat-label">{label}</span>
    </span>
  );
}

// A session created by a plugin (not the user's own work). Returns the exact
// plugin name, or null. claude-mem runs background sessions under ~/.claude-mem;
// other plugins' sessions live under ~/.claude/plugins/<name>/. Grouped under
// the "PLUGINS" sidebar section, kept out of the main list.
function pluginOf(s: SessionRow): string | null {
  const p = s.projectPath ?? "";
  if (p.includes("/.claude-mem/")) return "claude-mem";
  const m = p.match(/\/\.claude\/plugins\/(?:cache\/)?([^/]+)/);
  return m ? m[1] : null;
}
function isBackground(s: SessionRow): boolean {
  return pluginOf(s) !== null;
}

// Bound the live timeline so a marathon session can't grow the DOM without end.
const MAX_TIMELINE = 1000;

/** Append newly-arrived events, skipping any id already present (idempotent UI). */
function mergeEvents(prev: EventRow[], incoming: EventRow[]): EventRow[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return prev;
  const merged = [...prev, ...fresh].sort((a, b) => a.id - b.id);
  // Keep the most recent window; older rows reload on reselect.
  return merged.length > MAX_TIMELINE ? merged.slice(-MAX_TIMELINE) : merged;
}

export default App;
