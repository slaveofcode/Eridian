import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AuditRow, McpServerRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { auditSummary, statusLabel, worstSeverity } from "../lib/catalogUi";
import { CatalogPanel } from "./CatalogPanel";

// Read-only MCP config panel: what MCP servers each agent has configured,
// parsed from the on-disk config files, plus a Discover tab (MCP Registry).
export function McpPanel({ onOpenFile }: { onOpenFile: (path: string, find?: string) => void }) {
  const [tab, setTab] = useState<"installed" | "discover">("installed");
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMcpServers()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    api.mcpAudit().then(setAudit).catch(() => {});
  }, []);

  // Audit is keyed by server name (MCP config has no single canonical path).
  const auditByName = useMemo(() => {
    const m = new Map<string, AuditRow>();
    for (const a of audit) m.set(a.name, a);
    return m;
  }, [audit]);
  const summary = useMemo(() => auditSummary(audit), [audit]);

  return (
    <section className="mcp-panel">
      <header className="mcp-header">
        <h2>MCP servers</h2>
        <p className="muted">
          Read-only, parsed from on-disk config (~/.claude.json, project .mcp.json,
          opencode.json). Secrets masked. Account- and plugin-provided servers
          (claude.ai, plugins) live outside these files and aren’t shown.
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
        {tab === "installed" && summary && <div className="cat-summary">{summary}</div>}
      </header>

      {tab === "discover" ? (
        <CatalogPanel kind="mcpServer" onOpenFile={onOpenFile} />
      ) : (
        <>
          {loading && <p className="muted pad">Reading config…</p>}
          {error && <p className="error pad">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="muted pad">No MCP servers configured.</p>
          )}
          {rows.length > 0 && (
            <div className="mcp-table-wrap">
              <table className="mcp-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Scope</th>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Transport</th>
                    <th>Target</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const a = auditByName.get(r.name);
                    const sev = a ? worstSeverity(a.flags) : null;
                    const rowId = `${r.name}#${i}`;
                    const hasCmds = !!(a?.updateCommand || a?.removeCommand);
                    return (
                      <McpRowView
                        key={rowId}
                        row={r}
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

function McpRowView({
  row,
  audit,
  sev,
  open,
  hasCmds,
  onOpenFile,
  onToggle,
}: {
  row: McpServerRow;
  audit: AuditRow | undefined;
  sev: string | null;
  open: boolean;
  hasCmds: boolean;
  onOpenFile: (path: string, find?: string) => void;
  onToggle: () => void;
}) {
  const openSrc = () => onOpenFile(row.source, `"${row.name}"`);
  return (
    <>
      <tr className="skill-tr">
        <td onClick={openSrc} title={`Open ${shorten(row.source)} at ${row.name}`}>
          <span className="agent-pill">
            <span className="mcp-dot" style={{ background: AGENT_ACCENT[row.agent] }} />
            {row.agent}
          </span>
        </td>
        <td onClick={openSrc}>{row.scope}</td>
        <td className="mcp-name" onClick={openSrc}>
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
        <td onClick={openSrc}>
          <span className="mcp-transport">{row.transport}</span>
        </td>
        <td className="mcp-target" title={row.target} onClick={openSrc}>
          {row.target}
        </td>
        <td className="mcp-source muted" title={row.source}>
          {shorten(row.source)}
        </td>
      </tr>
      {open && hasCmds && (
        <tr className="skill-drawer-tr">
          <td colSpan={7}>
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

function shorten(path: string): string {
  const home = path.match(/\/Users\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}
