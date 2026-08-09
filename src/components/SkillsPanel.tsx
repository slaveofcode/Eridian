import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { SkillRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";

// Read-only view of skills discovered across agents (Claude Code user/plugin,
// OpenCode), grouped by agent.
export function SkillsPanel({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<string>("all");

  useEffect(() => {
    api
      .listSkills()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Per-agent counts for the tabs.
  const agents = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.agent, (m.get(r.agent) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (agent !== "all" && r.agent !== agent) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
    });
  }, [rows, query, agent]);

  return (
    <section className="mcp-panel">
      <header className="mcp-header">
        <h2>Skills</h2>
        <p className="muted">
          Read-only view of skills discovered across agents (Claude Code user +
          plugins, OpenCode).
        </p>
        <div className="skills-tabs">
          <button
            className={`chip${agent === "all" ? " on" : ""}`}
            onClick={() => setAgent("all")}
          >
            All <span className="num chip-n">{rows.length}</span>
          </button>
          {agents.map(([a, n]) => (
            <button
              key={a}
              className={`chip${agent === a ? " on" : ""}`}
              onClick={() => setAgent(a)}
            >
              <span
                className="chip-dot"
                style={{ background: AGENT_ACCENT[a as SkillRow["agent"]] }}
              />
              {a} <span className="num chip-n">{n}</span>
            </button>
          ))}
        </div>
        <input
          className="skills-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter skills…"
          aria-label="Filter skills"
          spellCheck={false}
        />
      </header>
      {loading && <p className="muted pad">Reading skills…</p>}
      {error && <p className="error pad">{error}</p>}
      {!loading && !error && filtered.length === 0 && (
        <p className="muted pad">No skills match.</p>
      )}
      {filtered.length > 0 && (
        <div className="mcp-table-wrap skills-table-wrap">
          <table className="mcp-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Scope</th>
                <th>Name</th>
                <th>Description</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={i} className="skill-tr" onClick={() => onOpenFile(s.source)} title="Open SKILL.md">
                  <td>
                    <span className="agent-pill">
                      <span className="mcp-dot" style={{ background: AGENT_ACCENT[s.agent] }} />
                      {s.agent}
                    </span>
                  </td>
                  <td>{s.scope}</td>
                  <td className="mcp-name">{s.name}</td>
                  <td className="skill-desc-cell">
                    <DescCell text={s.description} />
                  </td>
                  <td className="mcp-source muted" title={s.source}>{shorten(s.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Clamp long descriptions to 3 lines with an inline "see more" toggle.
// stopPropagation so expanding doesn't also open the SKILL.md file.
function DescCell({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 150;
  return (
    <>
      <div className={open || !long ? "skill-desc-text" : "skill-desc-text clamp"}>{text}</div>
      {long && (
        <button
          className="skill-see-more"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "see less" : "see more"}
        </button>
      )}
    </>
  );
}

function shorten(path: string): string {
  const home = path.match(/\/Users\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}
