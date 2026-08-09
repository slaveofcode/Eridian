import { useEffect, useRef, useState } from "react";

// Top-right profile menu. Houses Settings today; a home for future user options
// (feedback, telemetry, cloud sync).
export function ProfileMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="profile" ref={ref}>
      <button
        className="profile-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Profile & settings"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="8" r="4" fill="currentColor" />
          <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <div className="profile-head">
            <span className="profile-name">Local profile</span>
            <span className="profile-sub muted">this machine</span>
          </div>
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
          <button className="profile-item disabled" disabled>
            Connect to cloud <span className="soon">soon</span>
          </button>
        </div>
      )}
    </div>
  );
}
