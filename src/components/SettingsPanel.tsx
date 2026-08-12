import { useEffect, useRef, useState } from "react";
import { api, onIngestProgress } from "../lib/api";
import type { DbInfo, IngestProgress, Settings } from "../lib/types";
import { ConfirmModal } from "./ConfirmModal";
import { AboutUpdates } from "./AboutUpdates";

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
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [catalogFetch, setCatalogFetch] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const loadInfo = () => api.dbInfo().then(setInfo).catch(() => {});
  const lastRefetch = useRef(0);
  useEffect(() => {
    loadInfo();
    api.getSettings().then((s) => {
      setCatalogFetch(s.catalogFetchEnabled);
      setFileLimit(s.backfillFileLimit != null ? String(s.backfillFileLimit) : "");
      setMaxPerAgent(s.maxSessionsPerAgent != null ? String(s.maxSessionsPerAgent) : "");
    });

    // Keep the Database card (size/sessions/events) in step with the ingest for
    // the WHOLE duration of a rebuild — not a fixed timer that expires mid-run.
    // Backfill emits progress ~7/s; throttle the (COUNT-heavy) refetch to ~1/s,
    // and do a final read on the terminal event so we land on the true totals.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const onProgress = (p: IngestProgress) => {
      const terminal = p.done || p.phase === "watching";
      if (terminal) {
        lastRefetch.current = Date.now();
        loadInfo();
        setRebuilding(false);
      } else if (Date.now() - lastRefetch.current >= 1000) {
        lastRefetch.current = Date.now();
        loadInfo();
      }
    };
    onIngestProgress(onProgress).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const parse = (v: string): number | null => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = async () => {
    const next: Settings = {
      backfillFileLimit: parse(fileLimit),
      maxSessionsPerAgent: parse(maxPerAgent),
      catalogFetchEnabled: catalogFetch,
    };
    await api.setSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    loadInfo();
  };

  // Persist the network toggle immediately — it's a switch, not a form field, so
  // it must not wait on the Ingest "Save settings" button (that was the bug: the
  // box looked on but market_refresh still saw it off).
  const persistCatalogToggle = async (enabled: boolean) => {
    setCatalogFetch(enabled);
    try {
      await api.setSettings({
        backfillFileLimit: parse(fileLimit),
        maxSessionsPerAgent: parse(maxPerAgent),
        catalogFetchEnabled: enabled,
      });
      if (enabled) await refreshCatalogs();
    } catch {
      /* revert the visual state if the save failed */
      setCatalogFetch(!enabled);
    }
  };

  const refreshCatalogs = async () => {
    setRefreshing(true);
    try {
      const cat = await api.marketRefresh();
      setFetchedAt(cat.fetchedAt);
    } catch {
      /* fetch errors surface in the catalog view as a stale-cache banner */
    } finally {
      setRefreshing(false);
    }
  };

  // Native confirm()/alert() don't work in the Tauri WKWebView (JS dialogs
  // aren't wired), so use the in-app modal instead.
  const rebuild = async () => {
    setConfirmRebuild(false);
    setRebuilding(true);
    // Re-ingest runs on a background thread. The onIngestProgress subscription
    // (mount effect) refreshes the card as it runs and clears `rebuilding` on the
    // terminal event — however long the rebuild takes. On dispatch failure, don't
    // leave the button stuck spinning.
    try {
      await api.rebuildDb();
      loadInfo(); // immediate read so the cleared counts show right away
    } catch {
      setRebuilding(false);
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

      <AboutUpdates />

      <div className="settings-block">
        <h3>Database</h3>
        {/* Always render the grid — never gate the whole card on `info`, or a
            transient dbInfo miss (e.g. during an app restart / mid-rebuild) blanks
            it entirely. Show placeholders until the first read resolves. */}
        <dl className="server-detail settings-db">
          <div className="db-location">
            <dt>Location</dt>
            <dd className="settings-path">{info?.path ?? "…"}</dd>
          </div>
          <div>
            <dt>Size on disk</dt>
            <dd className="num">{info ? formatBytes(info.sizeBytes) : "…"}</dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd className="num">{info ? info.sessions.toLocaleString() : "…"}</dd>
          </div>
          <div>
            <dt>Events</dt>
            <dd className="num">{info ? info.events.toLocaleString() : "…"}</dd>
          </div>
        </dl>
        <div className="settings-actions">
          <button
            className="settings-btn danger"
            onClick={() => setConfirmRebuild(true)}
            disabled={rebuilding}
          >
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

      <div className="settings-block">
        <h3>Network</h3>
        <label className="settings-field settings-toggle">
          <span className="settings-label">
            <input
              type="checkbox"
              checked={catalogFetch}
              onChange={(e) => persistCatalogToggle(e.target.checked)}
            />{" "}
            Allow read-only catalog fetches
          </span>
          <span className="muted settings-hint">
            Off by default. When on, Eridian makes GET-only requests to{" "}
            <code>registry.modelcontextprotocol.io</code>,{" "}
            <code>api.github.com</code> and{" "}
            <code>raw.githubusercontent.com</code> to download public catalog
            metadata for the Skills and MCP “Discover” tabs. Nothing is ever
            uploaded; responses are cached locally. Enabling this reveals your IP
            and request timing to those hosts. Applies immediately.
          </span>
        </label>
        <div className="settings-actions">
          <button
            className="settings-btn"
            onClick={refreshCatalogs}
            disabled={!catalogFetch || refreshing}
          >
            {refreshing ? "refreshing…" : "Refresh catalogs"}
          </button>
          <span className="muted settings-hint">
            {fetchedAt
              ? `Last fetched ${new Date(fetchedAt).toLocaleString()}`
              : "Fetches the latest catalogs into the local cache."}
          </span>
        </div>
      </div>

      {confirmRebuild && (
        <ConfirmModal
          title="Rebuild the local database?"
          confirmLabel="Rebuild from disk"
          cancelLabel="Cancel"
          busy={rebuilding}
          onConfirm={rebuild}
          onCancel={() => setConfirmRebuild(false)}
          body={
            <>
              <p>
                Wipes Eridian’s derived cache and re-ingests every transcript from disk
                with the current parser. Your agent files are never modified.
              </p>
              <p className="muted">This can take a minute on a large history.</p>
            </>
          }
        />
      )}
    </section>
  );
}
