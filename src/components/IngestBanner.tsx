import type { IngestProgress } from "../lib/types";

// Thin progress strip shown while the first backfill fills the durable archive.
// Hidden once we reach the steady "watching" state.
export function IngestBanner({ progress }: { progress: IngestProgress | null }) {
  if (!progress || progress.phase === "watching") return null;
  const pct =
    progress.filesTotal > 0
      ? Math.round((progress.filesDone / progress.filesTotal) * 100)
      : 0;
  return (
    <div className="ingest-banner" role="status" aria-live="polite">
      <div className="ingest-bar-track">
        <div className="ingest-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="ingest-text muted">
        Backfilling archive · <span className="num">{progress.filesDone}</span>/
        <span className="num">{progress.filesTotal}</span> files ·{" "}
        <span className="num">{progress.events.toLocaleString()}</span> events
      </div>
    </div>
  );
}
