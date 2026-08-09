import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

// Checks GitHub Releases for a newer signed build on startup and offers a
// one-click update. No-op in dev / when the updater isn't configured.
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    check()
      .then((u) => {
        if (!cancelled && u) {
          setUpdate(u);
          setPhase("available");
        }
      })
      .catch(() => {
        /* offline / not configured / dev — stay silent */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed || phase === "idle") return null;

  const install = async () => {
    try {
      setPhase("downloading");
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) setPct(Math.round((got / total) * 100));
        } else if (e.event === "Finished") setPct(100);
      });
      setPhase("ready");
      await relaunch();
    } catch {
      setPhase("error");
    }
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-dot" aria-hidden />
      <span className="update-text">
        {phase === "available" && (
          <>
            Update available — <strong>{update.version}</strong>
            {update.currentVersion ? ` (you have ${update.currentVersion})` : ""}.
          </>
        )}
        {phase === "downloading" && <>Downloading update… {pct}%</>}
        {phase === "ready" && <>Update installed — restarting…</>}
        {phase === "error" && <>Update failed. Try again later or download from Releases.</>}
      </span>
      <span className="update-actions">
        {phase === "available" && (
          <button className="update-btn primary" onClick={install}>
            Update &amp; restart
          </button>
        )}
        {phase === "error" && (
          <button className="update-btn primary" onClick={install}>
            Retry
          </button>
        )}
        {phase !== "downloading" && phase !== "ready" && (
          <button className="update-btn" onClick={() => setDismissed(true)}>
            Later
          </button>
        )}
      </span>
    </div>
  );
}
