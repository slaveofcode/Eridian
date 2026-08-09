import { useEffect, useRef, useState } from "react";
import { api, onServerLog } from "../lib/api";
import type { IngestStatus } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";

// Dedicated page for agent servers Eridian can connect to and manage. Explains
// what each server is for and its live status, with start/stop controls.
export function ServersPanel({
  status,
  onStart,
  onStop,
}: {
  status: IngestStatus | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const connected = status?.opencodeConnected ?? false;
  const [logs, setLogs] = useState<string[]>([]);
  const [managed, setManaged] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  // Only servers Eridian started are stoppable — never the user's own server.
  // Poll while the page is open so start/stop and connection transitions reflect.
  useEffect(() => {
    let alive = true;
    const check = () => api.opencodeManaged().then((m) => alive && setManaged(m));
    check();
    const t = setInterval(check, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const start = () => {
    onStart();
    setTimeout(() => api.opencodeManaged().then(setManaged), 1500);
  };
  const stop = () => {
    onStop();
    setTimeout(() => api.opencodeManaged().then(setManaged), 800);
  };

  useEffect(() => {
    let un: (() => void) | undefined;
    let mounted = true;
    api.opencodeLogs().then((l) => mounted && setLogs(l));
    onServerLog((p) => setLogs((prev) => [...prev, p.line].slice(-500))).then((u) => {
      if (mounted) un = u;
      else u();
    });
    return () => {
      mounted = false;
      un?.();
    };
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [logs]);
  return (
    <section className="servers-page">
      <header className="mcp-header">
        <h2>Servers</h2>
        <p className="muted">
          Local agent servers Eridian connects to and manages. Starting one lets
          Eridian ingest that agent’s sessions.
        </p>
      </header>

      <article className="server-card">
        <div className="server-card-head">
          <span
            className={`server-dot${connected || managed ? " on" : ""}`}
            style={connected || managed ? { background: AGENT_ACCENT.opencode } : undefined}
            aria-hidden
          />
          <h3>OpenCode</h3>
          <span className={`server-status ${connected || managed ? "up" : "down"}`}>
            {connected
              ? managed
                ? "● connected · managed by Eridian"
                : "● connected · external"
              : managed
                ? "◍ starting… · managed by Eridian"
                : "○ not running"}
          </span>
          <div className="server-card-actions">
            {!connected && !managed && (
              <button className="server-btn start" onClick={start}>
                start
              </button>
            )}
            {managed && (
              <button className="server-btn" onClick={stop}>
                stop
              </button>
            )}
            {connected && !managed && (
              <>
                <span className="server-external" title="Started outside Eridian (or an orphan from a previous run)">
                  external
                </span>
                <button
                  className="server-btn danger"
                  title="Force-kill whatever is listening on :4096"
                  onClick={async () => {
                    if (!confirm("Force-kill the process on :4096? Use this to reclaim an orphaned/external opencode server, then press start to let Eridian manage it.")) return;
                    await api.forceKillOpencode();
                    setTimeout(() => api.opencodeManaged().then(setManaged), 800);
                  }}
                >
                  force kill
                </button>
              </>
            )}
          </div>
        </div>

        <p className="server-purpose">
          OpenCode’s local HTTP server (<code>opencode serve</code>). Eridian
          bootstraps its sessions over REST and live-tails new events via SSE.
          While it’s down, OpenCode sessions can’t be ingested.
        </p>

        <dl className="server-detail">
          <div>
            <dt>Endpoint</dt>
            <dd className="num">http://localhost:4096</dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>REST bootstrap + SSE live tail</dd>
          </div>
          <div>
            <dt>Events ingested</dt>
            <dd className="num">{(status?.opencodeEvents ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Managed by</dt>
            <dd>{managed ? "Eridian (child process)" : connected ? "external process" : "—"}</dd>
          </div>
        </dl>

        <div className="term-head muted">
          LIVE OUTPUT {logs.length > 0 && <span className="num">· {logs.length} lines</span>}
        </div>
        <div className="terminal">
          {logs.length === 0 ? (
            <span className="term-empty">
              No output yet. Press “start” to run the server — its stdout/stderr streams here.
            </span>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="term-line">
                {l}
              </div>
            ))
          )}
          <div ref={logEnd} />
        </div>
      </article>

      <p className="muted servers-more">
        More agent servers will appear here as they’re supported.
      </p>
    </section>
  );
}
