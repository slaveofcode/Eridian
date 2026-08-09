import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DbInfo, Settings } from "../lib/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function SettingsPanel() {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [fileLimit, setFileLimit] = useState<string>("");
  const [maxPerAgent, setMaxPerAgent] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const loadInfo = () => api.dbInfo().then(setInfo).catch(() => {});
  useEffect(() => {
    loadInfo();
    api.getSettings().then((s) => {
      setFileLimit(s.backfillFileLimit != null ? String(s.backfillFileLimit) : "");
      setMaxPerAgent(s.maxSessionsPerAgent != null ? String(s.maxSessionsPerAgent) : "");
    });
  }, []);

  const parse = (v: string): number | null => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = async () => {
    const next: Settings = {
      backfillFileLimit: parse(fileLimit),
      maxSessionsPerAgent: parse(maxPerAgent),
    };
    await api.setSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    loadInfo();
  };

  const rebuild = async () => {
    if (!confirm("Wipe Eridian's cache and re-ingest all history from disk? Agent files are untouched. This can take a minute.")) return;
    setRebuilding(true);
    try {
      await api.rebuildDb();
    } finally {
      setTimeout(() => {
        setRebuilding(false);
        loadInfo();
      }, 1500);
    }
  };

  return (
    <section className="settings-page">
      <header className="mcp-header">
        <h2>Settings</h2>
        <p className="muted">
          Manage Eridian’s local database and ingest. Eridian only ever reads
          agent files; its own DB is a rebuildable index.
        </p>
      </header>

      <div className="settings-block">
        <h3>Database</h3>
        {info && (
          <dl className="server-detail">
            <div>
              <dt>Location</dt>
              <dd className="settings-path">{info.path}</dd>
            </div>
            <div>
              <dt>Size on disk</dt>
              <dd className="num">{formatBytes(info.sizeBytes)}</dd>
            </div>
            <div>
              <dt>Sessions</dt>
              <dd className="num">{info.sessions.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd className="num">{info.events.toLocaleString()}</dd>
            </div>
          </dl>
        )}
        <div className="settings-actions">
          <button className="settings-btn danger" onClick={rebuild} disabled={rebuilding}>
            {rebuilding ? "rebuilding…" : "Rebuild from disk"}
          </button>
          <span className="muted settings-hint">
            Clears the cache and re-ingests every transcript with the current parser.
          </span>
        </div>
      </div>

      <div className="settings-block">
        <h3>Ingest</h3>
        <label className="settings-field">
          <span className="settings-label">Backfill file limit</span>
          <input
            type="number"
            min={1}
            value={fileLimit}
            onChange={(e) => setFileLimit(e.target.value)}
            placeholder="all files"
          />
          <span className="muted settings-hint">
            Cap how many transcript files the initial backfill reads (blank = all).
          </span>
        </label>
        <label className="settings-field">
          <span className="settings-label">Max sessions per agent</span>
          <input
            type="number"
            min={1}
            value={maxPerAgent}
            onChange={(e) => setMaxPerAgent(e.target.value)}
            placeholder="keep all"
          />
          <span className="muted settings-hint">
            Retention: keep only the N most-recent sessions per agent; older ones
            are pruned (blank = keep all).
          </span>
        </label>
        <div className="settings-actions">
          <button className="settings-btn" onClick={save}>
            {saved ? "saved ✓" : "Save settings"}
          </button>
        </div>
      </div>
    </section>
  );
}
