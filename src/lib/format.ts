// Small display helpers. Pure, no side effects.

/** "3:04:15 PM" style clock for a timeline row. */
export function formatClock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Compact "2m ago" / "3h ago" relative time for the session list. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Tidy a session title that is actually a slash-command envelope Claude Code
 *  injects (e.g. "<command-message>x</command-message> <command-name>/x</...>")
 *  into a readable "/x". Non-command titles pass through unchanged. */
export function cleanTitle(raw: string): string {
  const cn = raw.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/i);
  if (cn) return "/" + cn[1].trim();
  const cm = raw.match(/<command-message>\s*\/?([^<]+?)\s*<\/command-message>/i);
  if (cm) return "/" + cm[1].trim();
  if (/<local-command-(stdout|caveat)>/i.test(raw)) return "(local command)";
  return raw;
}

/** A model field that's sometimes a JSON object ({"id":…,"providerID":…}) —
 *  show the bare model id. Non-JSON models pass through unchanged. */
export function cleanModel(raw: string | null): string {
  if (!raw) return "";
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o.id === "string") return o.id;
    } catch {
      /* not JSON — fall through */
    }
  }
  return raw;
}

/** True if the path looks like an image file the viewer can render. */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path.trim());
}

/** Last path segment of a project directory, for a tidy label. */
export function projectName(path: string | null): string {
  if (!path) return "unknown project";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Pretty-print a JSON string; fall back to the raw string if it won't parse. */
export function prettyJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function formatTokens(n: number | null): string {
  if (n == null) return "";
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Best-effort context-window size. Model names don't reliably encode the 1M
 *  tier (e.g. "claude-opus-4-8" can run on 1M), so we also infer from observed
 *  usage: if any turn exceeded ~200k input, the session must be on the 1M tier. */
export function contextLimit(model: string | null, peakTokensIn = 0): number {
  const m = (model ?? "").toLowerCase();
  if (peakTokensIn > 200_000) return 1_000_000; // observed → must be 1M tier
  if (/1m|\[1m\]|-1m/.test(m)) return 1_000_000;
  if (/gemini/.test(m)) return 1_000_000;
  if (/gpt-4o|gpt-4\.1|o1|o3/.test(m)) return 128_000;
  return 200_000; // Claude default
}

/** Percent of the context window filled by the LATEST turn, or null if unknown.
 *  Tier is picked from the session's peak so it stays correct after compaction. */
export function contextPct(
  contextTokens: number,
  model: string | null,
  peakTokensIn = 0
): number | null {
  if (!contextTokens || contextTokens <= 0) return null;
  return Math.min(100, Math.round((contextTokens / contextLimit(model, peakTokensIn)) * 100));
}

/** Turn escaped inline sequences (\n, \t, \", \\) into real characters for
 *  display. Lossy/display-only — never feed the result back as data. */
export function unescapeInline(s: string): string {
  return s
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** Lightweight XML pretty-printer (display heuristic, no dependency). */
export function prettyXml(xml: string): string {
  const withBreaks = xml.replace(/>\s*</g, ">\n<");
  const out: string[] = [];
  let depth = 0;
  for (const rawLine of withBreaks.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const isClose = /^<\//.test(line);
    const isSelfClose = /\/>$/.test(line);
    // <tag>inline text</tag> on one line — no depth change
    const isOneLine = /^<([\w:-]+)(\s[^>]*)?>.*<\/\1>$/.test(line);
    const isDecl = /^<[!?]/.test(line);
    if (isClose) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + line);
    const opensChild =
      /^<[\w:-]/.test(line) && !isClose && !isSelfClose && !isOneLine && !isDecl;
    if (opensChild) depth++;
  }
  return out.join("\n");
}

/** Format an event body / tool payload for human reading: pretty-print JSON or
 *  XML and unescape embedded sequences. Falls back to the raw text. */
export function formatBody(raw: string | null): string {
  if (!raw) return "";
  const t = raw.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    return unescapeInline(prettyJson(raw));
  }
  if (t.startsWith("<")) {
    return unescapeInline(prettyXml(raw));
  }
  if (raw.includes("\\n") || raw.includes('\\"')) {
    return unescapeInline(raw);
  }
  return raw;
}

/** True when a body is structured (XML/JSON) and benefits from formatting. */
export function isStructured(raw: string | null): boolean {
  if (!raw) return false;
  const t = raw.trimStart();
  if (t.startsWith("<") || t.startsWith("{")) return true;
  // A JSON array is structured — but a markdown link "[text](url)" is not.
  return t.startsWith("[") && !/^\[[^\]]+\]\(/.test(t);
}
