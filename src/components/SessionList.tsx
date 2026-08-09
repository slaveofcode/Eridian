import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { projectName, relativeTime, cleanTitle, cleanModel } from "../lib/format";
import { useDebouncedValue } from "../lib/hooks";

const ROW_H = 68; // fixed row height enables cheap windowing
const OVERSCAN = 6;

// Memoized: while a live timeline streams, App re-renders often but the list's
// props (sessions/activeId) don't change — skip those re-renders.
export const SessionList = memo(SessionListImpl);

function SessionListImpl({
  sessions,
  activeId,
  onSelect,
  onOpenChanges,
  subagentCounts,
  pinned,
  onTogglePin,
}: {
  sessions: SessionRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpenChanges: (id: string) => void;
  subagentCounts?: Map<string, number>;
  pinned: Set<string>;
  onTogglePin: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 120).trim().toLowerCase();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const rafPending = useRef(false);

  // Coalesce scroll events to at most one state update per animation frame.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      setScrollTop(el.scrollTop);
    });
  };

  const filtered = useMemo(() => {
    const base = !debounced
      ? sessions
      : sessions.filter((s) => {
          const hay = `${s.title ?? ""} ${s.projectPath ?? ""} ${s.model ?? ""} ${s.gitBranch ?? ""} ${s.agent}`.toLowerCase();
          return hay.includes(debounced);
        });
    // Pinned sessions float to the top (stable within each group).
    if (pinned.size === 0) return base;
    const pin: SessionRow[] = [];
    const rest: SessionRow[] = [];
    for (const s of base) (pinned.has(s.id) ? pin : rest).push(s);
    return pin.length ? [...pin, ...rest] : base;
  }, [sessions, debounced, pinned]);

  // Measure the scroll viewport once and on resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard nav: ↑/↓ and j/k move selection through the filtered list.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    const dir =
      e.key === "ArrowDown" || e.key === "j"
        ? 1
        : e.key === "ArrowUp" || e.key === "k"
          ? -1
          : 0;
    if (dir === 0) return;
    e.preventDefault();
    const idx = filtered.findIndex((s) => s.id === activeId);
    const next = idx < 0 ? 0 : Math.min(filtered.length - 1, Math.max(0, idx + dir));
    const target = filtered[next];
    if (target) {
      onSelect(target.id);
      ensureVisible(next);
    }
  };

  const ensureVisible = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight)
      el.scrollTop = bottom - el.clientHeight;
  };

  const total = filtered.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);
  const slice = filtered.slice(start, end);

  return (
    <div className="session-pane">
      <div className="session-filter">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          spellCheck={false}
        />
        <span className="filter-count muted">
          {debounced ? `${total}/${sessions.length}` : sessions.length}
        </span>
      </div>

      <div
        className="session-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="listbox"
        aria-label="Sessions"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {total === 0 ? (
          <p className="muted pad">
            {sessions.length === 0
              ? "No sessions yet. Start a Claude Code session and it will appear here."
              : `No sessions match "${query}".`}
          </p>
        ) : (
          <div className="vlist" style={{ height: total * ROW_H }}>
            <div className="vlist-window" style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {slice.map((s) => (
                <SessionRowItem
                  key={s.id}
                  s={s}
                  selected={s.id === activeId}
                  onSelect={onSelect}
                  onOpenChanges={onOpenChanges}
                  subagents={subagentCounts?.get(s.id) ?? 0}
                  pinned={pinned.has(s.id)}
                  onTogglePin={onTogglePin}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRowItem({
  s,
  selected,
  onSelect,
  onOpenChanges,
  subagents,
  pinned,
  onTogglePin,
}: {
  s: SessionRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpenChanges: (id: string) => void;
  subagents: number;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) {
  const accent = AGENT_ACCENT[s.agent];
  const label = s.title ? cleanTitle(s.title) : projectName(s.projectPath);
  return (
    <button
      role="option"
      aria-selected={selected}
      className={`session-row${selected ? " selected" : ""}${s.live ? " is-live" : ""}${pinned ? " pinned" : ""}`}
      style={{ height: ROW_H }}
      onClick={() => onSelect(s.id)}
    >
      <span className="agent-bar" style={{ background: accent }} aria-hidden />
      <span
        className={`pin-btn${pinned ? " on" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={pinned ? "Unpin session" : "Pin session"}
        title={pinned ? "Unpin" : "Pin to top"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(s.id);
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill={pinned ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      </span>
      <div className="session-main">
        <div className="session-title" title={label}>
          {s.live && <span className="live-dot-sm" style={{ background: accent }} aria-hidden />}
          {label}
          {s.isSubagent && <span className="tag">subagent</span>}
          {!s.sourceAlive && (
            <span className="tag archived" title="Source JSONL purged — data preserved in Eridian">
              archived
            </span>
          )}
        </div>
        <div className="session-sub muted" title={s.projectPath ?? ""}>
          {projectName(s.projectPath)}
          {s.model && <span className="dotsep">· {cleanModel(s.model)}</span>}
        </div>
        <div className="session-foot muted">
          <span className="num">{s.eventCount} ev</span>
          <span className="num">{relativeTime(s.updatedAt)}</span>
          {subagents > 0 && (
            <span
              className="tag subagent-badge"
              role="button"
              tabIndex={0}
              title={`${subagents} subagent(s) — open the Changes tab flow graph`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenChanges(s.id);
              }}
            >
              ⑂ {subagents}
            </span>
          )}
          {s.gitBranch && <span className="branch">⎇ {s.gitBranch}</span>}
        </div>
      </div>
    </button>
  );
}
