/** Human duration: null→"—", <60s→"Ns", <1h→"Nm Ss", else "Nh Nm". */
export function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** Whole seconds elapsed from an ISO start to nowMs; null if unparseable; never < 0. */
export function elapsedSecs(startedAtIso: string | null, nowMs: number): number | null {
  if (!startedAtIso) return null;
  const start = Date.parse(startedAtIso);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/** CSS suffix for a risk tier (defaults to "safe"). */
export function riskClass(risk: string): string {
  return risk === "danger" || risk === "notable" ? risk : "safe";
}
