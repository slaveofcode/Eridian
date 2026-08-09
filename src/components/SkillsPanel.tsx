import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AuditRow, SkillRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { auditSummary, statusLabel, worstSeverity } from "../lib/catalogUi";
import { CatalogPanel } from "./CatalogPanel";

// Read-only view of skills discovered across agents (Claude Code user/plugin,
// OpenCode), grouped by agent, plus a Discover tab to browse public catalogs.
export function SkillsPanel({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [tab, setTab] = useState<"installed" | "discover">("installed");
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSkills()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // Audit is best-effort enrichment; failure just omits status chips.
    api.skillsAudit().then(setAudit).catch(() => {});
  }, []);

  // Look up an installed skill's audit result by its SKILL.md path.
  const auditByPath = useMemo(() => {
    const m = new Map<string, AuditRow>();
    for (const a of audit) m.set(a.installedPath, a);
    return m;
  }, [audit]);
  const summary = useMemo(() => auditSummary(audit), [audit]);

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
          plugins, OpenCode), plus a catalog to discover more.
        </p>
        <div className="cat-tabbar">
          <button
            className={`cat-tab${tab === "installed" ? " on" : ""}`}
            onClick={() => setTab("installed")}
          >
            Installed
          </button>
          <button
            className={`cat-tab${tab === "discover" ? " on" : ""}`}
            onClick={() => setTab("discover")}
          >
            Discover
          </button>
        </div>
        {tab === "installed" && (
          <>
            {summary && <div className="cat-summary">{summary}</div>}
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
          </>
        )}
      </header>

      {tab === "discover" ? (
        <CatalogPanel kind="skill" onOpenFile={onOpenFile} />
      ) : (
        <>
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
                    <th>Status</th>
                    <th>Description</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s, i) => {
                    const a = auditByPath.get(s.source);
                    const sev = a ? worstSeverity(a.flags) : null;
                    const rowId = `${s.source}#${i}`;
                    const hasCmds = !!(a?.updateCommand || a?.removeCommand);
                    return (
                      <SkillRowView
                        key={rowId}
                        row={s}
                        audit={a}
                        sev={sev}
                        open={expanded === rowId}
                        hasCmds={hasCmds}
                        onOpenFile={onOpenFile}
                        onToggle={() =>
                          setExpanded(expanded === rowId ? null : rowId)
                        }
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// One installed-skill row plus an expandable drawer holding its copyable
// update/remove commands (when the audit produced any).
function SkillRowView({
  row,
  audit,
  sev,
  open,
  hasCmds,
  onOpenFile,
  onToggle,
}: {
  row: SkillRow;
  audit: AuditRow | undefined;
  sev: string | null;
  open: boolean;
  hasCmds: boolean;
  onOpenFile: (path: string) => void;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="skill-tr">
        <td onClick={() => onOpenFile(row.source)} title="Open SKILL.md">
          <span className="agent-pill">
            <span className="mcp-dot" style={{ background: AGENT_ACCENT[row.agent] }} />
            {row.agent}
          </span>
        </td>
        <td onClick={() => onOpenFile(row.source)}>{row.scope}</td>
        <td className="mcp-name" onClick={() => onOpenFile(row.source)}>
          {row.name}
        </td>
        <td>
          {audit ? (
            <span className={`cat-status st-${audit.status}`}>
              {statusLabel(audit.status)}
              {sev && <span className={`cat-sev-dot sev-${sev}`} title="heuristic flag" />}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
          {hasCmds && (
            <button className="cat-expand" onClick={onToggle} title="Show commands">
              {open ? "▾" : "▸"}
            </button>
          )}
        </td>
        <td className="skill-desc-cell" onClick={() => onOpenFile(row.source)}>
          <DescCell text={row.description} />
        </td>
        <td className="mcp-source muted" title={row.source}>
          {shorten(row.source)}
        </td>
      </tr>
      {open && hasCmds && (
        <tr className="skill-drawer-tr">
          <td colSpan={6}>
            <div className="cat-cmds">
              {audit?.updateCommand && (
                <CopyCmd text={audit.updateCommand} label="copy update" />
              )}
              {audit?.removeCommand && (
                <CopyCmd text={audit.removeCommand} label="copy remove" />
              )}
            </div>
            {audit && audit.flags.length > 0 && (
              <ul className="cat-flags">
                {audit.flags.map((f, i) => (
                  <li key={i} className={`cat-flag sev-${f.severity}`} title="heuristic — not a verdict">
                    <span className="cat-flag-dot" /> {f.reason}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function CopyCmd({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="cat-copy"
      title={text}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "copied ✓" : label}
    </button>
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
