import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventRow, SessionRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import {
  projectName,
  relativeTime,
  formatTokens,
  contextPct,
  contextLimit,
  cleanTitle,
  cleanModel,
} from "../lib/format";
import { EventCard } from "./EventCard";
import { ChangesTab } from "./ChangesTab";
import { VirtualList, type VirtualHandle } from "./VirtualList";
import { visibleEvents, pairToolEvents, GROUP_OF } from "../lib/timelineFilter";

type Tab = "timeline" | "changes";

// Group event kinds into the filter chips shown above the timeline.
function crumbLabel(s: SessionRow): string {
  const t = s.title ? cleanTitle(s.title) : projectName(s.projectPath);
  return t.length > 32 ? t.slice(0, 32) + "…" : t;
}

const GROUP_ORDER = ["prompt", "assistant", "thinking", "tools", "system", "summary"];
const GROUP_LABEL: Record<string, string> = {
  prompt: "Prompts",
  assistant: "Assistant",
  thinking: "Thinking",
  tools: "Tools",
  system: "System",
  summary: "Summary",
};

export function Timeline({
  session,
  events,
  loading,
  focusEventId,
  tab,
  onTabChange,
  trail = [],
  onNavTo,
  onOpenSubagent,
  onOpenFile,
  onBack,
  canGoBack = false,
}: {
  session: SessionRow | null;
  events: EventRow[];
  loading: boolean;
  focusEventId?: number | null;
  tab: Tab;
  onTabChange: (t: Tab) => void;
  trail?: SessionRow[];
  onNavTo?: (index: number) => void;
  onOpenSubagent: (id: string) => void;
  onOpenFile: (path: string) => void;
  onBack?: () => void;
  canGoBack?: boolean;
}) {
  const [atBottom, setAtBottom] = useState(true);
  const [atTop, setAtTop] = useState(true);
  const vh = useRef<VirtualHandle | null>(null);
  const bottomAnchored = useRef(true);
  const [showMeta, setShowMeta] = useState(true);
  const [showUnknown, setShowUnknown] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const metaCount = useMemo(() => events.filter((e) => e.kind === "meta").length, [events]);
  const unknownCount = useMemo(
    () => events.filter((e) => e.kind === "unknown").length,
    [events]
  );
  const groupCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) {
      const g = GROUP_OF[e.kind];
      if (g) m[g] = (m[g] ?? 0) + 1;
    }
    return m;
  }, [events]);
  const shown = useMemo(
    () => visibleEvents(events, { showMeta, showUnknown, activeKinds }),
    [events, showMeta, showUnknown, activeKinds]
  );
  // Merge finished tool_call+tool_result pairs into single cards.
  const renderItems = useMemo(() => pairToolEvents(shown), [shown]);

  const toggleKind = (g: string) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // Edge state from the virtual list drives the nav overlay + bottom-anchoring
  // (live appends autoscroll only while the user is pinned to the bottom).
  const onEdges = useCallback((e: { atTop: boolean; atBottom: boolean }) => {
    setAtTop(e.atTop);
    setAtBottom(e.atBottom);
    bottomAnchored.current = e.atBottom;
  }, []);

  const scrollToLatest = () => {
    vh.current?.scrollToBottom();
    bottomAnchored.current = true;
    setAtBottom(true);
  };
  const scrollToFirst = () => {
    vh.current?.scrollToTop();
    bottomAnchored.current = false;
  };
  const scrollPrev = () => vh.current?.pageUp();

  // Live-append autoscroll — only when pinned to bottom and not mid-drill-in.
  useEffect(() => {
    if (bottomAnchored.current && focusEventId == null) vh.current?.scrollToBottom();
  }, [events, focusEventId]);

  // Jumping from search / shell drill-in: reveal the target (timeline tab, no
  // kind filter, meta/unknown shown if needed).
  const scrolledFor = useRef<number | null>(null);
  useEffect(() => {
    if (focusEventId == null) return;
    setActiveKinds(new Set());
    // A fresh drill-in must win over the "snap to latest" autoscroll.
    bottomAnchored.current = false;
    const target = events.find((e) => e.id === focusEventId);
    if (target?.kind === "meta") setShowMeta(true);
    if (target?.kind === "unknown") setShowUnknown(true);
  }, [focusEventId, events]);
  // Scroll the focused item to center via the virtual list (reliable at any
  // depth, unlike scrollIntoView on a not-yet-laid-out card).
  useEffect(() => {
    if (focusEventId == null) return;
    if (scrolledFor.current === focusEventId) return;
    const idx = renderItems.findIndex(
      (it) => it.event.id === focusEventId || it.result?.id === focusEventId
    );
    if (idx >= 0) {
      vh.current?.scrollToIndex(idx, 0.5);
      scrolledFor.current = focusEventId;
    }
  }, [focusEventId, renderItems]);


  if (!session) {
    return (
      <section className="timeline empty">
        <p className="muted">Select a session to view its timeline.</p>
      </section>
    );
  }

  const accent = AGENT_ACCENT[session.agent];
  const ctxPct = contextPct(session.contextTokens, session.model, session.peakTokensIn);
  // Raw provider id (strip Eridian's cc:/oc: namespace) + a resume command.
  const rawId = session.id.replace(/^(cc:|oc:)/, "");
  const resumeCmd =
    session.agent === "claude-code"
      ? `claude --resume ${rawId}`
      : session.agent === "opencode"
        ? `opencode --session ${rawId}`
        : null;
  const copy = (label: string, text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {});
  };
  return (
    <section className={`timeline${session.isSubagent ? " is-subagent" : ""}`}>
      {(canGoBack || session.isSubagent || trail.length > 0) && (
        <div className="subagent-crumb">
          {canGoBack && (
            <button className="crumb-up" onClick={onBack} title="Back to previous view">
              ←
            </button>
          )}
          {(session.isSubagent || trail.length > 0) && (
            <>
              <span className="crumb-tag">subagent</span>
              {trail.map((a, i) => (
                <span key={a.id} className="crumb-item">
                  <button
                    className="crumb-seg"
                    onClick={() => onNavTo?.(i)}
                    title={a.title ?? projectName(a.projectPath)}
                  >
                    {crumbLabel(a)}
                  </button>
                  <span className="crumb-sep">›</span>
                </span>
              ))}
              <span
                className="crumb-current"
                title={session.title ?? projectName(session.projectPath)}
              >
                {crumbLabel(session)}
              </span>
            </>
          )}
        </div>
      )}
      <header className="timeline-head" style={{ ["--accent" as string]: accent }}>
        <div>
          <h2>{session.title ? cleanTitle(session.title) : projectName(session.projectPath)}</h2>
          <div className="timeline-meta muted">
            <span style={{ color: accent }} title={`Agent: ${session.agent}`}>
              {session.agent}
            </span>
            {session.isSubagent && <span className="tag">subagent</span>}
            {session.model && (
              <span className="meta-model" title={`Model: ${cleanModel(session.model)}`}>
                {cleanModel(session.model)}
              </span>
            )}
            {session.gitBranch && (
              <span title={`Git branch: ${session.gitBranch}`}>⎇ {session.gitBranch}</span>
            )}
            {session.projectPath && (
              <span title={`Project directory: ${session.projectPath}`}>
                {projectName(session.projectPath)}
              </span>
            )}
            <span title="Normalized records in this session — user/assistant messages, thinking, tool calls & results, system events">
              {session.eventCount} events
            </span>
            {(session.tokensIn > 0 || session.tokensOut > 0) && (
              <span title="Total input / output tokens across this session" className="num">
                {formatTokens(session.tokensIn)} in · {formatTokens(session.tokensOut)} out
              </span>
            )}
            {ctxPct != null && (
              <span
                className={`ctx-badge${ctxPct >= 80 ? " hot" : ""}`}
                title={`latest turn ${session.contextTokens.toLocaleString()} input tokens ≈ ${ctxPct}% of ~${contextLimit(
                  session.model,
                  session.peakTokensIn
                ).toLocaleString()}-token context (heuristic; drops after compaction)`}
              >
                ctx ~{ctxPct}%
              </span>
            )}
            <span>updated {relativeTime(session.updatedAt)}</span>
            {!session.sourceAlive && (
              <span
                className="tag archived"
                title="Original transcript JSONL no longer on disk — data preserved in Eridian"
              >
                archived — source purged
              </span>
            )}
          </div>
          <div className="session-id-row">
            <span className="sid-label">session id</span>
            <code className="sid-value" title={`Eridian id: ${session.id}`}>{rawId}</code>
            <button className="sid-copy" onClick={() => copy("id", rawId)} title="Copy session id">
              {copied === "id" ? "copied ✓" : "⧉ id"}
            </button>
            {resumeCmd && (
              <button
                className="sid-copy"
                onClick={() => copy("cmd", resumeCmd)}
                title={`Copy resume command — ${resumeCmd}`}
              >
                {copied === "cmd" ? "copied ✓" : "⧉ resume cmd"}
              </button>
            )}
          </div>
        </div>
        <div className="timeline-head-right">
          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "timeline"}
              className={`tab${tab === "timeline" ? " on" : ""}`}
              onClick={() => onTabChange("timeline")}
            >
              Timeline
            </button>
            <button
              role="tab"
              aria-selected={tab === "changes"}
              className={`tab${tab === "changes" ? " on" : ""}`}
              onClick={() => onTabChange("changes")}
            >
              Changes
            </button>
          </div>
          {session.live && <span className="live-dot" style={{ background: accent }} />}
        </div>
      </header>

      {tab === "timeline" && (
        <div className="kind-chips">
          <button
            className={`chip${activeKinds.size === 0 ? " on" : ""}`}
            onClick={() => setActiveKinds(new Set())}
          >
            All
          </button>
          {GROUP_ORDER.filter((g) => groupCounts[g]).map((g) => (
            <button
              key={g}
              className={`chip${activeKinds.has(g) ? " on" : ""}`}
              onClick={() => toggleKind(g)}
              aria-pressed={activeKinds.has(g)}
            >
              {GROUP_LABEL[g]} <span className="num chip-n">{groupCounts[g]}</span>
            </button>
          ))}
          {metaCount > 0 && (
            <button
              className={`chip meta-chip${showMeta ? " on" : ""}`}
              onClick={() => setShowMeta((v) => !v)}
              aria-pressed={showMeta}
              title="Agent control/metadata lines (mode, attachments, snapshots, …)"
            >
              {showMeta ? "hide" : "show"} meta <span className="num chip-n">{metaCount}</span>
            </button>
          )}
          {unknownCount > 0 && (
            <button
              className={`chip meta-chip${showUnknown ? " on" : ""}`}
              onClick={() => setShowUnknown((v) => !v)}
              aria-pressed={showUnknown}
              title="Unparseable / unrecognized records (raw kept in DB)"
            >
              {showUnknown ? "hide" : "show"} unknown{" "}
              <span className="num chip-n">{unknownCount}</span>
            </button>
          )}
          <button
            className={`chip expand-chip${expandAll ? " on" : ""}`}
            onClick={() => setExpandAll((v) => !v)}
            aria-pressed={expandAll}
            title="Expand every input / result / thinking block (large blocks stay capped)"
          >
            {expandAll ? "collapse all" : "expand all"}
          </button>
        </div>
      )}

      {tab === "changes" ? (
        <ChangesTab session={session} onSelectSession={onOpenSubagent} onOpenFile={onOpenFile} />
      ) : loading ? (
        <div className="timeline-scroll">
          <div className="skeletons" aria-hidden>
            {[72, 120, 48, 96].map((h, i) => (
              <div key={i} className="skeleton" style={{ height: h }} />
            ))}
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="timeline-scroll">
          <p className="muted pad">
            {events.length === 0
              ? "No events in this session."
              : "Nothing matches the current filters."}
          </p>
        </div>
      ) : (
        <VirtualList
          className="timeline-scroll"
          items={renderItems}
          getKey={(item) => item.event.id}
          estimate={140}
          overscan={8}
          handleRef={vh}
          onEdges={onEdges}
          renderItem={(item) => {
            // Focus lands on the call card whether the drilled event is the
            // call itself or its (now-merged) result.
            const isFocus =
              item.event.id === focusEventId || item.result?.id === focusEventId;
            return (
              <div className={isFocus ? "event-focus" : undefined}>
                <EventCard
                  event={item.event}
                  pairedResult={item.result}
                  onOpenFile={onOpenFile}
                  defaultExpanded={expandAll}
                  focused={isFocus}
                />
              </div>
            );
          }}
        />
      )}

      {tab === "timeline" && !(atTop && atBottom) && (
        <div className="timeline-nav" role="group" aria-label="Timeline navigation">
          <button onClick={scrollToFirst} disabled={atTop} title="Jump to first (oldest)">
            ⤒ first
          </button>
          <button onClick={scrollPrev} disabled={atTop} title="Page up">
            ↑ prev
          </button>
          <button onClick={scrollToLatest} disabled={atBottom} title="Jump to latest (newest)">
            ↓ latest
          </button>
        </div>
      )}
    </section>
  );
}
