import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Top-right profile menu. Shows the running version, offers an in-place update
// when the signed release feed has a newer one, and houses Settings.
export function ProfileMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Read the running version and check the signed release feed once on load.
  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    setPhase("checking");
    check()
      .then((u) => !cancelled && setUpdate(u ?? null))
      .catch(() => {}) // offline / no endpoint in dev — stay silent
      .finally(() => !cancelled && setPhase((p) => (p === "checking" ? "idle" : p)));
    return () => {
      cancelled = true;
    };
  }, []);

  const doUpdate = async () => {
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

  const sub = update
    ? `update available — v${update.version}`
    : version
      ? "up to date · this machine"
      : "this machine";

  return (
    <div className="profile" ref={ref}>
      <button
        className={`profile-btn${update ? " has-update" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={update ? `Update available: v${update.version}` : "Profile & settings"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" fill="currentColor" />
        </svg>
        {update && <span className="profile-badge" aria-hidden />}
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <span className="profile-name">
              {version ? `Eridian v${version}` : "Eridian"}
            </span>
            <span className="profile-sub muted">{sub}</span>
          </div>

          {update && (
            <button
              className="profile-item profile-update"
              role="menuitem"
              onClick={doUpdate}
              disabled={phase === "installing"}
            >
              {phase === "installing"
                ? (note ?? "Updating…")
                : `Update to v${update.version}`}
            </button>
          )}

          <button
            className="profile-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <div className="profile-sep" />
          <button className="profile-item disabled" disabled>
            Send feedback <span className="soon">soon</span>
          </button>
        </div>
      )}
    </div>
  );
}
