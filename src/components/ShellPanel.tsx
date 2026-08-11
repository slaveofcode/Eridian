import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, onEventsAppended, onSessionsUpdated } from "../lib/api";
import type { RunningCommandRow, CommandHistoryRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { formatClock, relativeTime } from "../lib/format";
import { formatDuration, elapsedSecs, riskClass } from "../lib/commandsUi";

type Tab = "running" | "history";

export function ShellPanel({
  onDrillIn,
}: {
  onDrillIn: (sessionId: string, eventId: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("running");
  return (
    <section className="shell-panel">
      <div className="shell-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "running"}
          className={`tab${tab === "running" ? " on" : ""}`}
          onClick={() => setTab("running")}
        >
          Running
        </button>
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`tab${tab === "history" ? " on" : ""}`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>
      {tab === "running" ? (
        <RunningList onDrillIn={onDrillIn} />
      ) : (
        <HistoryList onDrillIn={onDrillIn} />
      )}
    </section>
  );
}

function RunningList({ onDrillIn }: { onDrillIn: (s: string, e: number) => void }) {
  const [rows, setRows] = useState<RunningCommandRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    api.runningCommands().then(setRows).catch(() => {});
  }, []);

  // Register live refresh once; debounce the ingest storm to ≤1 refetch / 700ms.
  useEffect(() => {
    let mounted = true;
    const unsubs: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bounced = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 700);
    };
    refresh();
    onEventsAppended(bounced).then((u) => (mounted ? unsubs.push(u) : u()));
    onSessionsUpdated(bounced).then((u) => (mounted ? unsubs.push(u) : u()));
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      unsubs.forEach((u) => u());
    };
  }, [refresh]);

  // ONE clock for every running row's elapsed label — no per-row timers.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (rows.length === 0) {
    return <p className="muted pad">No shell commands running right now.</p>;
  }
  return (
    <div className="shell-list">
      {rows.map((r) => (
        <RunningRow key={r.eventId} row={r} now={now} onDrillIn={onDrillIn} />
      ))}
    </div>
  );
}

const RunningRow = memo(function RunningRow({
  row,
  now,
  onDrillIn,
}: {
  row: RunningCommandRow;
  now: number;
  onDrillIn: (s: string, e: number) => void;
}) {
  const secs = elapsedSecs(row.startedAt, now);
  return (
    <button
      className="shell-row running"
      onClick={() => onDrillIn(row.sessionId, row.eventId)}
      title="Open in the session timeline"
    >
      <span className="shell-spinner" aria-hidden />
      <span className={`risk-dot ${riskClass(row.risk)}`} />
      <code className="shell-cmd">{row.command}</code>
      <span className="shell-meta" style={{ color: AGENT_ACCENT[row.agent] }}>
        {row.sessionTitle ?? row.sessionId}
      </span>
      <span className="shell-elapsed num">{formatDuration(secs)}</span>
    </button>
  );
});

function HistoryList({ onDrillIn }: { onDrillIn: (s: string, e: number) => void }) {
  const [rows, setRows] = useState<CommandHistoryRow[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedOnce = useRef(false);

  const loadMore = useCallback((before?: number) => {
    setLoading(true);
    api
      .commandHistory(before, 100)
      .then((page) => {
        setRows((prev) => (before == null ? page.rows : [...prev, ...page.rows]));
        setNextBeforeId(page.nextBeforeId);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    loadMore(undefined);
  }, [loadMore]);

  if (!loading && rows.length === 0) {
    return <p className="muted pad">No finished shell commands yet.</p>;
  }
  return (
    <div className="shell-list">
      {rows.map((r) => (
        <HistoryRow key={r.eventId} row={r} onDrillIn={onDrillIn} />
      ))}
      {nextBeforeId != null && (
        <button
          className="shell-more"
          disabled={loading}
          onClick={() => loadMore(nextBeforeId)}
        >
          {loading ? "loading…" : "load more"}
        </button>
      )}
    </div>
  );
}

const HistoryRow = memo(function HistoryRow({
  row,
  onDrillIn,
}: {
  row: CommandHistoryRow;
  onDrillIn: (s: string, e: number) => void;
}) {
  const [output, setOutput] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && output == null) {
      api
        .commandOutput(row.eventId)
        .then((o) => setOutput(o ?? "(no output)"))
        .catch(() => {});
    }
  };
  return (
    <div className="shell-hist">
      <div className="shell-row">
        <button className="shell-disclosure" onClick={toggle} title="Show output">
          {open ? "▾" : "▸"}
        </button>
        <span className={`risk-dot ${riskClass(row.risk)}`} />
        <code className="shell-cmd">{row.command}</code>
        <span className="shell-meta" style={{ color: AGENT_ACCENT[row.agent] }}>
          {row.agent}
        </span>
        <span
          className="shell-elapsed num"
          title={row.startedAt ? formatClock(row.startedAt) : ""}
        >
          {formatDuration(row.durationSecs)}
        </span>
        <button
          className="shell-open"
          onClick={() => onDrillIn(row.sessionId, row.eventId)}
          title="Open in the session timeline"
        >
          ⤢
        </button>
      </div>
      {open && <pre className="shell-output code">{output ?? "loading…"}</pre>}
      {row.startedAt && <span className="shell-when muted">{relativeTime(row.startedAt)}</span>}
    </div>
  );
});
