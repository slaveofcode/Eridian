import { memo, useMemo } from "react";
import type { Agent, SessionRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";

const AGENT_LABEL: Record<Agent, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

interface AgentSummary {
  agent: Agent;
  count: number;
  live: number;
}

// Left column of agent categories, derived from the sessions actually present
// (hide-until-data). "All" plus one row per agent, each a filter with a live
// heartbeat. Replaces the thin activity rail.
type Filter = Agent | `plugin:${string}` | null;

export const AgentColumn = memo(function AgentColumn({
  sessions,
  plugins,
  selected,
  onSelect,
  opencodeConnected,
  onOpenServers,
  serversActive,
}: {
  sessions: SessionRow[];
  plugins: { name: string; count: number }[];
  selected: Filter;
  onSelect: (a: Filter) => void;
  opencodeConnected: boolean;
  onOpenServers: () => void;
  serversActive?: boolean;
}) {
  const summaries = useMemo<AgentSummary[]>(() => {
    const byAgent = new Map<Agent, AgentSummary>();
    for (const s of sessions) {
      const cur = byAgent.get(s.agent) ?? { agent: s.agent, count: 0, live: 0 };
      cur.count += 1;
      if (s.live) cur.live += 1;
      byAgent.set(s.agent, cur);
    }
    return [...byAgent.values()].sort((a, b) => b.count - a.count);
  }, [sessions]);

  const totalLive = summaries.reduce((n, s) => n + s.live, 0);

  return (
    <nav className="agent-col" aria-label="Agents">
      <div className="agent-col-head">AGENTS</div>
      <button
        className={`agent-item${selected === null ? " selected" : ""}`}
        onClick={() => onSelect(null)}
      >
        <span className="agent-swatch all" aria-hidden />
        <span className="agent-name">All</span>
        <span className="agent-count num">{sessions.length}</span>
        {totalLive > 0 && <span className="agent-live" aria-label={`${totalLive} live`} />}
      </button>

      {summaries.map((s) => {
        const accent = AGENT_ACCENT[s.agent];
        return (
          <button
            key={s.agent}
            className={`agent-item${selected === s.agent ? " selected" : ""}`}
            onClick={() => onSelect(s.agent)}
            style={{ ["--accent" as string]: accent }}
          >
            <span className="agent-swatch" style={{ background: accent }} aria-hidden />
            <span className="agent-name">{AGENT_LABEL[s.agent] ?? s.agent}</span>
            <span className="agent-count num">{s.count}</span>
            {s.live > 0 && (
              <span
                className="agent-live"
                style={{ background: accent }}
                aria-label={`${s.live} live`}
              />
            )}
          </button>
        );
      })}

      {plugins.length > 0 && (
        <>
          <div className="agent-col-head agent-col-sub">PLUGINS</div>
          {plugins.map((p) => {
            const key = `plugin:${p.name}` as const;
            return (
              <button
                key={p.name}
                className={`agent-item${selected === key ? " selected" : ""}`}
                onClick={() => onSelect(key)}
                title={`${p.name} — plugin-generated sessions (not your own work)`}
              >
                <span className="agent-swatch" style={{ background: "var(--muted)" }} aria-hidden />
                <span className="agent-name">{p.name}</span>
                <span className="agent-count num">{p.count}</span>
              </button>
            );
          })}
        </>
      )}

      <button
        className={`agent-col-head agent-col-sub servers-head${serversActive ? " active" : ""}`}
        onClick={onOpenServers}
      >
        SERVERS <span className="servers-open">details ›</span>
      </button>
      <button
        className={`server-row server-row-btn${serversActive ? " active" : ""}`}
        onClick={onOpenServers}
        title="Open server details"
      >
        <span
          className={`server-dot${opencodeConnected ? " on" : ""}`}
          style={opencodeConnected ? { background: AGENT_ACCENT.opencode } : undefined}
          aria-hidden
        />
        <span className="agent-name">OpenCode</span>
        <span className={`server-mini-status${opencodeConnected ? " on" : ""}`}>
          {opencodeConnected ? "connected" : "off"}
        </span>
      </button>

      {summaries.length === 0 && plugins.length === 0 && (
        <p className="agent-empty muted">No sessions yet.</p>
      )}
    </nav>
  );
});
