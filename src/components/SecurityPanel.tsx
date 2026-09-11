import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type {
  GuardCategory,
  GuardConfig,
  GuardStatus,
  Remediation,
  SecurityFinding,
} from "../lib/types";
import {
  CATEGORY_ORDER,
  categoryLabel,
  nextAction,
  parseList,
  formatList,
  filterFindings,
  remediationPrompt,
} from "../lib/securityUi";

const copy = (text: string) => {
  navigator.clipboard?.writeText(text).catch(() => {});
};

// Read-only control + review surface for the security guard. Blocking happens in
// the Claude Code hook; this page toggles it, configures per-category actions +
// deny-lists, and reviews (redacted) findings with remediation.
export function SecurityPanel() {
  const [status, setStatus] = useState<GuardStatus | null>(null);
  const [config, setConfig] = useState<GuardConfig | null>(null);
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catFilter, setCatFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");

  const load = useCallback(() => {
    api.guardStatus().then(setStatus).catch(() => {});
    api.guardGetConfig().then(setConfig).catch(() => {});
    api.securityFindings(200).then(setFindings).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = (next: GuardConfig) => {
    setConfig(next);
    api.guardSetConfig(next).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const runInstall = async () => {
    setBusy(true);
    try {
      await api.guardInstall();
    } finally {
      setBusy(false);
      load();
    }
  };
  const runUninstall = async () => {
    setBusy(true);
    try {
      await api.guardUninstall();
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!config || !status) {
    return (
      <section className="security-page">
        <p className="muted pad">Loading…</p>
      </section>
    );
  }

  const cycle = (cat: GuardCategory) =>
    save({ ...config, actions: { ...config.actions, [cat]: nextAction(config.actions[cat]) } });
  const setDeny = (key: keyof GuardConfig["denyList"], text: string) =>
    save({ ...config, denyList: { ...config.denyList, [key]: parseList(text) } });

  const shown = filterFindings(findings, { category: catFilter, status: statusFilter });
  const installLabel =
    status.status === "stalePath" ? "Repair hook" : "Install hook";

  return (
    <section className="security-page">
      <header className="mcp-header">
        <h2>Security guard</h2>
        <p className="muted">
          Blocks or flags secrets, PII, exfiltration, dangerous commands, and
          commit-hygiene issues during agentic coding — via a Claude Code hook.
          Eridian writes only its own data plus one scoped hook entry.
        </p>
      </header>

      <div className="settings-block">
        <h3>Status</h3>
        <div className="sec-row">
          <label className="sec-toggle">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => save({ ...config, enabled: e.target.checked })}
            />
            <span>Guard {config.enabled ? "enabled" : "disabled"}</span>
          </label>
          <span className={`sec-badge sec-${status.status}`}>
            {status.status === "installed"
              ? "Hook installed"
              : status.status === "stalePath"
                ? "Hook stale"
                : "Hook not installed"}
          </span>
        </div>
        <div className="sec-row">
          <label className="sec-toggle">
            <input
              type="checkbox"
              checked={!!config.promptOnCatch}
              onChange={(e) => save({ ...config, promptOnCatch: e.target.checked })}
            />
            <span>Prompt me on catch — ask Accept / Skip in the moment</span>
          </label>
        </div>
        <div className="settings-actions">
          {status.status !== "installed" && (
            <button className="settings-btn accent" onClick={runInstall} disabled={busy}>
              {installLabel}
            </button>
          )}
          {status.installed && (
            <button className="settings-btn" onClick={runInstall} disabled={busy}>
              Reinstall
            </button>
          )}
          {status.status !== "notInstalled" && (
            <button className="settings-btn danger" onClick={runUninstall} disabled={busy}>
              Uninstall hook
            </button>
          )}
        </div>
        <p className="settings-hint">
          Hook: <code>{status.hookCommand}</code>
        </p>
      </div>

      <div className="settings-block">
        <h3>Categories {saved && <span className="soon">saved</span>}</h3>
        <p className="settings-hint">Click a category to cycle Block → Warn → Off.</p>
        <div className="sec-cats">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              className={`sec-cat sec-act-${config.actions[cat]}`}
              onClick={() => cycle(cat)}
            >
              <span className="sec-cat-name">{categoryLabel(cat)}</span>
              <span className="sec-cat-action">{config.actions[cat]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-block">
        <h3>Deny-list — commit identity</h3>
        <div className="sec-deny">
          {(["workEmails", "workDomains", "workTerms"] as const).map((k) => (
            <label key={k} className="settings-field">
              <span>
                {k === "workEmails"
                  ? "Work emails"
                  : k === "workDomains"
                    ? "Work domains"
                    : "Work terms"}
              </span>
              <textarea
                rows={3}
                defaultValue={formatList(config.denyList[k])}
                placeholder="one per line"
                onBlur={(e) => setDeny(k, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="settings-block">
        <h3>Remembered decisions</h3>
        {(config.decisions ?? []).length === 0 ? (
          <p className="muted">
            None yet. Check “remember” on a prompt and your choice appears here.
          </p>
        ) : (
          <ul className="sec-decisions">
            {(config.decisions ?? []).map((d, i) => (
              <li key={`${d.scope}:${d.key}:${i}`}>
                <span className={`sec-tag act-${d.action === "block" ? "block" : "warn"}`}>
                  {d.action}
                </span>
                <span className="sec-dec-scope">
                  {d.scope === "exact" ? "exact" : "rule"}
                </span>
                <code className="sec-dec-key">{d.key}</code>
                <button
                  className="sec-copy"
                  onClick={() =>
                    api.guardForgetDecision(d.scope, d.key).then(load).catch(() => {})
                  }
                >
                  forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings-block">
        <h3>Findings</h3>
        <div className="sec-filters">
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="all">All categories</option>
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {["open", "remediated", "ignored", "accepted", "all"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="settings-btn" onClick={load}>
            Refresh
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="muted">No findings match.</p>
        ) : (
          <ul className="sec-findings">
            {shown.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                onStatus={(st) => api.updateFindingStatus(f.id, st).then(load).catch(() => {})}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FindingRow({
  f,
  onStatus,
}: {
  f: SecurityFinding;
  onStatus: (status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rem, setRem] = useState<Remediation | null>(null);

  const toggle = () => {
    const n = !open;
    setOpen(n);
    if (n && !rem) api.guardRemediation(f.category, f.rule).then(setRem).catch(() => {});
  };

  return (
    <li className={`sec-finding sev-${f.severity}`}>
      <button className="sec-finding-head" onClick={toggle} aria-expanded={open}>
        <span className="sec-caret">{open ? "▾" : "▸"}</span>
        <span className={`sec-tag act-${f.action}`}>{f.action}</span>
        <span className="sec-fcat">{categoryLabel(f.category)}</span>
        <span className="sec-preview">{f.maskedPreview}</span>
        <span className={`sec-status st-${f.status}`}>{f.status}</span>
      </button>
      {open && (
        <div className="sec-finding-body">
          <div className="sec-meta muted">
            {f.rule}
            {f.location ? ` · ${f.location}` : ""}
            {f.ts ? ` · ${f.ts}` : ""}
          </div>
          {rem ? (
            <>
              <p>{rem.guidance}</p>
              {rem.commands.map((c, i) => (
                <div key={i} className="sec-cmd">
                  <code>{c}</code>
                  <button className="sec-copy" onClick={() => copy(c)}>
                    copy
                  </button>
                </div>
              ))}
              <button
                className="settings-btn"
                onClick={() => copy(remediationPrompt(f, rem.guidance))}
              >
                Copy “hand to Claude Code” prompt
              </button>
            </>
          ) : (
            <p className="muted">Loading remediation…</p>
          )}
          <div className="settings-actions">
            {f.status !== "ignored" && (
              <button className="settings-btn" onClick={() => onStatus("ignored")}>
                Ignore
              </button>
            )}
            {f.status !== "accepted" && (
              <button className="settings-btn" onClick={() => onStatus("accepted")}>
                Accept risk
              </button>
            )}
            {f.status !== "open" && (
              <button className="settings-btn" onClick={() => onStatus("open")}>
                Reopen
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
