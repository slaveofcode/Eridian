import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Agent, DayUsage, UsageBreakdown, UsageSlice } from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { formatTokens, cleanModel } from "../lib/format";
import { seriesColor } from "../lib/palette";

const RANGES = [7, 30, 90] as const;

// Per-day token usage across all sessions — a simple, honest rollup.
// Note: input tokens include cache reads (which repeat the context every turn),
// so "in" dwarfs "out"; we surface both and total per day.
export function UsagePanel() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<DayUsage[]>([]);
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true); // blanking spinner (first load only)
  const [updating, setUpdating] = useState(false); // subtle in-place refetch (filter/range)
  const [error, setError] = useState<string | null>(null);
  const hasData = useRef(false);
  // A clicked model/agent series → the daily chart is filtered to just it.
  const [sel, setSel] = useState<{
    kind: "model" | "agent";
    key: string;
    color: string;
    label: string;
  } | null>(null);

  // Breakdown is always the unfiltered top series over the range. A failure
  // here must NOT blank the daily chart, so it keeps its own (ignored) error.
  useEffect(() => {
    api.usageBreakdown(days).then(setBreakdown).catch(() => setBreakdown(null));
  }, [days]);

  // Daily bars: filtered to the selected series when one is picked. Guarded by a
  // timeout so a non-responding backend (e.g. mid-rebuild) surfaces an actionable
  // error instead of hanging on "Loading…" forever.
  useEffect(() => {
    // Blank only on the first load; range/filter changes update in place so the
    // chart, totals, and breakdowns stay on screen (no full-page reload flash).
    if (hasData.current) setUpdating(true);
    else setLoading(true);
    setError(null);
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
      setLoading(false);
      setUpdating(false);
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          setError("Timed out loading usage — the backend may be rebuilding. Try restarting the dev server.")
        ),
      12000
    );
    api
      .usageByDay(days, sel?.kind === "model" ? sel.key : undefined, sel?.kind === "agent" ? sel.key : undefined)
      .then((r) =>
        settle(() => {
          setRows(r);
          hasData.current = true;
        })
      )
      .catch((e) => settle(() => setError(String(e))));
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [days, sel]);

  const toggle = (kind: "model" | "agent", key: string, color: string, label: string) =>
    setSel((cur) => (cur && cur.kind === kind && cur.key === key ? null : { kind, key, color, label }));

  const totalIn = useMemo(() => rows.reduce((n, r) => n + r.tokensIn, 0), [rows]);
  const totalOut = useMemo(() => rows.reduce((n, r) => n + r.tokensOut, 0), [rows]);
  const max = useMemo(
    () => Math.max(1, ...rows.map((r) => r.tokensIn + r.tokensOut)),
    [rows]
  );
  const peak = useMemo(() => rows.reduce((m, r) => Math.max(m, r.tokensIn + r.tokensOut), 0), [rows]);

  return (
    <section className="mcp-panel usage-panel">
      <header className="mcp-header">
        <h2>Token usage</h2>
        <p className="muted">
          Per-day tokens across all sessions. Input includes cache reads (the context is
          re-sent each turn), so it far exceeds output — this is usage, not billed cost.
        </p>
        <div className="usage-ranges">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`chip${days === r ? " on" : ""}`}
              onClick={() => setDays(r)}
            >
              {r}d
            </button>
          ))}
          {sel && (
            <button
              className="chip usage-filter-chip"
              onClick={() => setSel(null)}
              title="Clear filter — show all series"
            >
              <span className="usage-dot" style={{ background: sel.color }} aria-hidden />
              {sel.label}
              <span className="usage-filter-x" aria-hidden>
                ×
              </span>
            </button>
          )}
        </div>
      </header>

      {loading && rows.length === 0 && <p className="muted pad">Loading usage…</p>}
      {error && rows.length === 0 && <p className="error pad">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="muted pad">No token usage recorded in this range.</p>
      )}

      {rows.length > 0 && (
        <>
          <div className="usage-totals">
            <Total label="input" value={totalIn} accent="cc" />
            <Total label="output" value={totalOut} accent="oc" />
            <Total label="busiest day" value={peak} />
          </div>

          <div
            className={`usage-chart${updating ? " updating" : ""}`}
            role="img"
            aria-label="daily token usage"
          >
            {rows.map((r) => {
              const total = r.tokensIn + r.tokensOut;
              const h = (total / max) * 100;
              const inPct = total > 0 ? (r.tokensIn / total) * 100 : 0;
              return (
                <div
                  key={r.date}
                  className="usage-col"
                  title={`${r.date}\n${formatTokens(r.tokensIn)} in · ${formatTokens(r.tokensOut)} out`}
                >
                  <div className="usage-bar" style={{ height: `${h}%` }}>
                    <div
                      className="usage-seg out"
                      style={{
                        height: `${100 - inPct}%`,
                        ...(sel ? { background: sel.color, opacity: 0.4 } : {}),
                      }}
                    />
                    <div
                      className="usage-seg in"
                      style={{ height: `${inPct}%`, ...(sel ? { background: sel.color } : {}) }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="usage-axis muted">
            <span>{rows[0]?.date}</span>
            <span>{rows[rows.length - 1]?.date}</span>
          </div>
          <div className="usage-legend muted">
            <span>
              <span className="legend-dot in" /> input (incl. cache)
            </span>
            <span>
              <span className="legend-dot out" /> output
            </span>
          </div>

          {breakdown && (
            <div className="usage-breakdowns">
              <Breakdown
                title="By model"
                kind="model"
                slices={breakdown.byModel}
                label={(k) => cleanModel(k)}
                color={(_, i) => seriesColor(i)}
                selectedKey={sel?.kind === "model" ? sel.key : null}
                onToggle={toggle}
              />
              <Breakdown
                title="By agent"
                kind="agent"
                slices={breakdown.byAgent}
                label={(k) => k}
                color={(k, i) => AGENT_ACCENT[k as Agent] ?? seriesColor(i)}
                selectedKey={sel?.kind === "agent" ? sel.key : null}
                onToggle={toggle}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Breakdown({
  title,
  kind,
  slices,
  label,
  color,
  selectedKey,
  onToggle,
}: {
  title: string;
  kind: "model" | "agent";
  slices: UsageSlice[];
  label: (key: string) => string;
  color: (key: string, index: number) => string;
  selectedKey: string | null;
  onToggle: (kind: "model" | "agent", key: string, color: string, label: string) => void;
}) {
  const max = Math.max(1, ...slices.map((s) => s.tokensIn + s.tokensOut));
  if (slices.length === 0) return null;
  return (
    <div className="usage-breakdown">
      <h3>{title}</h3>
      <div className="usage-rows">
        {slices.map((s, i) => {
          const total = s.tokensIn + s.tokensOut;
          const w = (total / max) * 100;
          const inPct = total > 0 ? (s.tokensIn / total) * 100 : 0;
          const c = color(s.key, i);
          return (
            <button
              key={s.key}
              type="button"
              className={`usage-row${selectedKey === s.key ? " on" : ""}`}
              style={{ ["--row-color" as string]: c }}
              onClick={() => onToggle(kind, s.key, c, label(s.key))}
              aria-pressed={selectedKey === s.key}
              title={`${label(s.key)} — click to chart just this series\n${formatTokens(
                s.tokensIn
              )} in · ${formatTokens(s.tokensOut)} out · ${s.sessions} session${
                s.sessions === 1 ? "" : "s"
              }`}
            >
              <span className="usage-row-key" title={s.key}>
                <span className="usage-dot" style={{ background: c }} aria-hidden />
                {label(s.key)}
              </span>
              <span className="usage-row-track">
                {/* Each series is its own hue; the solid part is input, the
                    faded tail is output — proportion without a second colour. */}
                <span className="usage-row-fill" style={{ width: `${w}%` }}>
                  <span className="usage-row-seg" style={{ width: `${inPct}%`, background: c }} />
                  <span
                    className="usage-row-seg"
                    style={{ width: `${100 - inPct}%`, background: c, opacity: 0.4 }}
                  />
                </span>
              </span>
              <span className="usage-row-val num">{formatTokens(total)}</span>
              <span className="usage-row-sess muted num">{s.sessions}×</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Total({ label, value, accent }: { label: string; value: number; accent?: "cc" | "oc" }) {
  return (
    <div className="usage-total">
      <span className={`usage-total-value num${accent ? ` ${accent}` : ""}`}>{formatTokens(value)}</span>
      <span className="usage-total-label muted">{label}</span>
    </div>
  );
}
