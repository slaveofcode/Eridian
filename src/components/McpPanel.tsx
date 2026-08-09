import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { McpServerRow } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";

// Read-only MCP config panel: what MCP servers each agent has configured,
// parsed from the on-disk config files. No editing.
export function McpPanel({ onOpenFile }: { onOpenFile: (path: string, find?: string) => void }) {
  const [rows, setRows] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMcpServers()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="mcp-panel">
      <header className="mcp-header">
        <h2>MCP servers</h2>
        <p className="muted">
          Read-only, parsed from on-disk config (~/.claude.json, project .mcp.json,
          opencode.json). Secrets masked. Account- and plugin-provided servers
          (claude.ai, plugins) live outside these files and aren’t shown.
        </p>
      </header>
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
                <th>Transport</th>
                <th>Target</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  className="skill-tr"
                  onClick={() => onOpenFile(r.source, `"${r.name}"`)}
                  title={`Open ${shorten(r.source)} at ${r.name}`}
                >
                  <td>
                    <span className="agent-pill">
                      <span className="mcp-dot" style={{ background: AGENT_ACCENT[r.agent] }} />
                      {r.agent}
                    </span>
                  </td>
                  <td>{r.scope}</td>
                  <td className="mcp-name">{r.name}</td>
                  <td>
                    <span className="mcp-transport">{r.transport}</span>
                  </td>
                  <td className="mcp-target" title={r.target}>{r.target}</td>
                  <td className="mcp-source muted" title={r.source}>{shorten(r.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function shorten(path: string): string {
  const home = path.match(/\/Users\/[^/]+/);
  return home ? path.replace(home[0], "~") : path;
}
