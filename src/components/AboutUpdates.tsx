import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

const RELEASES_URL = "https://github.com/slaveofcode/Eridian/releases";

// About & Updates block for the Settings page: shows the running version and the
// signed-release status, and lets you re-check on demand (the profile menu only
// checks once at launch, so a release published while the app is open otherwise
// looks "up to date" until relaunch).
export function AboutUpdates() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const runCheck = async () => {
    setPhase("checking");
    setNote(null);
    try {
      const u = await check();
      setUpdate(u ?? null);
      setCheckedAt(new Date().toLocaleString());
    } catch (e) {
      setNote(`Couldn't reach the release feed: ${e}`);
    } finally {
      setPhase((p) => (p === "checking" ? "idle" : p));
    }
  };

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    if (!update) return;
    setPhase("installing");
    setNote("Downloading update…");
    try {
      await update.downloadAndInstall();
      setNote("Restarting…");
      await relaunch();
    } catch (e) {
      setNote(`Update failed: ${e}`);
      setPhase("idle");
    }
  };

  const status =
    phase === "checking"
      ? "Checking…"
      : update
        ? `Update available — v${update.version}`
        : checkedAt
          ? "You’re on the latest version"
          : "—";

  return (
    <div className="settings-block">
      <h3>About &amp; updates</h3>
      <dl className="server-detail settings-db">
        <div>
          <dt>Version</dt>
          <dd className="num">{version ? `v${version}` : "…"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className={update ? "upd-available" : undefined}>{status}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd className="muted">{checkedAt ?? "—"}</dd>
        </div>
      </dl>
      <div className="settings-actions">
        <button
          className="settings-btn"
          onClick={() => void runCheck()}
          disabled={phase !== "idle"}
        >
          {phase === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {update && (
          <button
            className="settings-btn accent"
            onClick={() => void install()}
            disabled={phase === "installing"}
          >
            {phase === "installing"
              ? (note ?? "Updating…")
              : `Download & install v${update.version}`}
          </button>
        )}
        <button
          className="settings-btn"
          onClick={() => void openUrl(RELEASES_URL).catch(() => {})}
        >
          Release notes
        </button>
      </div>
      {note && phase !== "installing" && <p className="muted settings-hint">{note}</p>}
    </div>
  );
}
