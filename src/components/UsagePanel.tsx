import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { DayUsage, UsageBreakdown, UsageSlice } from "../lib/types";
import { formatTokens, cleanModel } from "../lib/format";

const RANGES = [7, 30, 90] as const;

// Per-day token usage across all sessions — a simple, honest rollup.
// Note: input tokens include cache reads (which repeat the context every turn),
// so "in" dwarfs "out"; we surface both and total per day.
export function UsagePanel() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<DayUsage[]>([]);
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([api.usageByDay(days), api.usageBreakdown(days)])
      .then(([r, b]) => {
        setRows(r);
        setBreakdown(b);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [days]);

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
        </div>
      </header>

      {loading && <p className="muted pad">Loading usage…</p>}
      {error && <p className="error pad">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="muted pad">No token usage recorded in this range.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <div className="usage-totals">
            <Total label="input" value={totalIn} accent="cc" />
            <Total label="output" value={totalOut} accent="oc" />
            <Total label="busiest day" value={peak} />
          </div>

          <div className="usage-chart" role="img" aria-label="daily token usage">
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
                    <div className="usage-seg out" style={{ height: `${100 - inPct}%` }} />
                    <div className="usage-seg in" style={{ height: `${inPct}%` }} />
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
              <Breakdown title="By model" slices={breakdown.byModel} label={(k) => cleanModel(k)} />
              <Breakdown title="By agent" slices={breakdown.byAgent} label={(k) => k} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Breakdown({
  title,
  slices,
  label,
}: {
  title: string;
  slices: UsageSlice[];
  label: (key: string) => string;
}) {
  const max = Math.max(1, ...slices.map((s) => s.tokensIn + s.tokensOut));
  if (slices.length === 0) return null;
  return (
    <div className="usage-breakdown">
      <h3>{title}</h3>
      <div className="usage-rows">
        {slices.map((s) => {
          const total = s.tokensIn + s.tokensOut;
          const w = (total / max) * 100;
          const inPct = total > 0 ? (s.tokensIn / total) * 100 : 0;
          return (
            <div
              key={s.key}
              className="usage-row"
              title={`${label(s.key)}\n${formatTokens(s.tokensIn)} in · ${formatTokens(
                s.tokensOut
              )} out · ${s.sessions} session${s.sessions === 1 ? "" : "s"}`}
            >
              <span className="usage-row-key" title={s.key}>
                {label(s.key)}
              </span>
              <span className="usage-row-track">
                <span className="usage-row-fill" style={{ width: `${w}%` }}>
                  <span className="usage-row-seg in" style={{ width: `${inPct}%` }} />
                  <span className="usage-row-seg out" style={{ width: `${100 - inPct}%` }} />
                </span>
              </span>
              <span className="usage-row-val num">{formatTokens(total)}</span>
              <span className="usage-row-sess muted num">{s.sessions}×</span>
            </div>
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
