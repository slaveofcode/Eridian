import { useEffect } from "react";

// Small, dependency-free confirmation modal. Esc / backdrop click = cancel.
export function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="modal-btn primary" onClick={onConfirm} disabled={busy}>
            {busy ? "working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
