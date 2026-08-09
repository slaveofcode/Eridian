import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Catalog, CatalogItem, CatalogKind, InstallCommand } from "../lib/types";
import { filterCatalog, groupBySource, worstSeverity } from "../lib/catalogUi";
import { Markdown } from "./Markdown";

// Small copy-to-clipboard button, mirroring the app's existing copy pattern.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="cat-copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title={text}
    >
      {done ? "copied ✓" : label}
    </button>
  );
}

function FlagList({ item }: { item: CatalogItem }) {
  if (item.flags.length === 0) return null;
  return (
    <ul className="cat-flags">
      {item.flags.map((f, i) => (
        <li key={i} className={`cat-flag sev-${f.severity}`} title="heuristic — not a verdict">
          <span className="cat-flag-dot" /> {f.reason}
        </li>
      ))}
    </ul>
  );
}

// The "Discover" tab body, shared by the Skills and MCP pages via `kind`.
export function CatalogPanel({
  kind,
}: {
  kind: CatalogKind;
  onOpenFile?: (path: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .marketCatalog()
      .then((c) => !cancelled && setCatalog(c))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const items = (catalog?.items ?? []).filter((i) => i.kind === kind);
    return groupBySource(filterCatalog(items, query));
  }, [catalog, kind, query]);

  const remoteSources = catalog?.sources.filter((s) => s.kind === "remote") ?? [];
  const anyRemoteEnabled = remoteSources.some((s) => s.enabled);
  const totalForKind = (catalog?.items ?? []).filter((i) => i.kind === kind).length;

  if (loading) return <p className="muted pad">Loading catalog…</p>;
  if (error) return <p className="error pad">{error}</p>;

  return (
    <div className="cat-discover">
      <div className="cat-sources">
        {catalog?.sources.map((s) => (
          <span
            key={s.id}
            className={`cat-source-chip${s.enabled ? "" : " off"}`}
            title={
              s.enabled
                ? s.label
                : "Enable read-only catalog fetches in Settings → Network"
            }
          >
            {s.label}
            {!s.enabled && " (off)"}
          </span>
        ))}
      </div>

      <input
        className="skills-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter catalog…"
        aria-label="Filter catalog"
        spellCheck={false}
      />

      {totalForKind === 0 && !anyRemoteEnabled && (
        <div className="cat-empty">
          <p>
            Nothing to browse yet. Enable <strong>read-only catalog fetches</strong>{" "}
            in Settings → Network to discover{" "}
            {kind === "skill" ? "skills" : "MCP servers"} from public catalogs, or
            browse the web directories below.
          </p>
          <LinkOuts kind={kind} />
        </div>
      )}

      {groups.map((g) => (
        <div key={g.source} className="cat-group">
          <h4 className="cat-group-h">{g.label}</h4>
          {g.items.map((item) => {
            const id = `${item.sourceId}/${item.name}`;
            const open = openId === id;
            const sev = worstSeverity(item.flags);
            return (
              <div key={id} className="cat-row-wrap">
                <button
                  className="cat-row"
                  onClick={() => setOpenId(open ? null : id)}
                >
                  <span className="cat-name">{item.name}</span>
                  {item.version && <span className="cat-ver">{item.version}</span>}
                  <span className="cat-desc muted">{item.description}</span>
                  {item.installed && <span className="cat-installed">✓ installed</span>}
                  {sev && <span className={`cat-sev-dot sev-${sev}`} title="heuristic flag" />}
                </button>
                {open && (
                  <div className="cat-drawer">
                    {item.readmeExcerpt && <Markdown text={item.readmeExcerpt} />}
                    <FlagList item={item} />
                    <CommandButtons commands={item.installCommands} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {catalog?.fetchedAt && (
        <p className="muted cat-fetched">
          Catalog fetched {new Date(catalog.fetchedAt).toLocaleString()}
        </p>
      )}
      {totalForKind > 0 && <LinkOuts kind={kind} />}
    </div>
  );
}

function CommandButtons({ commands }: { commands: InstallCommand[] }) {
  if (commands.length === 0) return null;
  return (
    <div className="cat-cmds">
      {commands.map((c, i) => (
        <CopyButton key={i} text={c.command} label={`copy ${c.agent} ${c.action}`} />
      ))}
    </div>
  );
}

function LinkOuts({ kind }: { kind: CatalogKind }) {
  const links =
    kind === "skill"
      ? [
          ["anthropics/skills", "https://github.com/anthropics/skills"],
          ["skillsclaude.org", "https://skillsclaude.org"],
        ]
      : [
          ["MCP Registry", "https://registry.modelcontextprotocol.io"],
          ["mcp.so", "https://mcp.so"],
        ];
  return (
    <div className="cat-linkouts muted">
      Browse more:{" "}
      {links.map(([label, url], i) => (
        <span key={url}>
          {i > 0 && " · "}
          <a href={url} target="_blank" rel="noreferrer">
            {label}
          </a>
        </span>
      ))}
    </div>
  );
}
