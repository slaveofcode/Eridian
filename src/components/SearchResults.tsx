import type { SearchResult } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { relativeTime } from "../lib/format";

export function SearchResults({
  query,
  results,
  loading,
  onSelect,
}: {
  query: string;
  results: SearchResult[];
  loading: boolean;
  onSelect: (r: SearchResult) => void;
}) {
  return (
    <div className="search-results">
      <div className="search-head muted">
        {loading ? "searching…" : `${results.length} match${results.length === 1 ? "" : "es"} for “${query}”`}
      </div>
      {!loading && results.length === 0 && (
        <p className="muted pad">No events match “{query}”.</p>
      )}
      {results.map((r) => {
        const accent = AGENT_ACCENT[r.agent];
        return (
          <button key={r.id} className="search-row" onClick={() => onSelect(r)}>
            <span className="agent-bar" style={{ background: accent }} aria-hidden />
            <div className="search-main">
              <div className="search-row-head">
                <span className="search-kind">{r.kind}</span>
                <span className="search-session" style={{ color: accent }}>
                  {r.sessionTitle ?? r.sessionId}
                </span>
                <span className="search-time muted num">{relativeTime(r.ts)}</span>
              </div>
              <div className="search-snippet">
                <Snippet text={r.snippet} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// FTS snippet marks matches with ⟦…⟧ — render those highlighted.
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(⟦[^⟧]*⟧)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("⟦") && p.endsWith("⟧") ? (
          <mark key={i}>{p.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}
