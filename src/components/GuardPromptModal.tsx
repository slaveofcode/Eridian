import { useState } from "react";
import { api } from "../lib/api";
import type { GuardPromptRequest } from "../lib/types";
import { categoryLabel } from "../lib/securityUi";

// Interrupting modal shown when the guard catches a block in interactive mode. The
// backend has already raised the window; this asks Accept/Skip with an optional
// remember (exact match or whole rule).
export function GuardPromptModal({
  req,
  onDone,
}: {
  req: GuardPromptRequest;
  onDone: () => void;
}) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState<"exact" | "rule">("exact");
  const [busy, setBusy] = useState(false);
  const f = req.finding;

  const respond = async (action: "allow" | "block") => {
    setBusy(true);
    const key = scope === "exact" ? f.sig ?? "" : `${f.category}:${f.rule}`;
    try {
      await api.guardPromptRespond(req.id, action, remember, scope, key);
    } catch {
      /* backend will time out and block safely */
    } finally {
      onDone();
    }
  };

  return (
    <div className="guard-prompt-overlay" role="dialog" aria-modal="true">
      <div className="guard-prompt">
        <div className="gp-head">
          <span className="gp-badge">Security guard</span>
          <span className="gp-cat">{categoryLabel(f.category)}</span>
        </div>
        <p className="gp-desc">
          A <strong>{f.toolName ?? "tool"}</strong> action was caught:{" "}
          <code>{f.rule}</code> — <code>{f.maskedPreview}</code>
          {req.more > 0 ? ` (+${req.more} more)` : ""}
        </p>
        {f.cwd && <p className="gp-meta muted">{f.cwd}</p>}

        <label className="gp-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember my choice for</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "exact" | "rule")}
            disabled={!remember}
          >
            <option value="exact">this exact match</option>
            <option value="rule">this rule ({categoryLabel(f.category)})</option>
          </select>
        </label>

        <div className="gp-actions">
          <button
            className="settings-btn danger"
            disabled={busy}
            onClick={() => respond("block")}
          >
            Skip (block)
          </button>
          <button
            className="settings-btn accent"
            disabled={busy}
            onClick={() => respond("allow")}
          >
            Accept (allow)
          </button>
        </div>
      </div>
    </div>
  );
}
