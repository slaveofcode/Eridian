// Shared helpers for the detection engine: entropy scoring, secret redaction, the
// false-positive guards (env references and placeholders), and a one-way signature
// for remembered decisions. Node built-ins only.

import { createHash } from "node:crypto";

/** Stable, one-way signature of a raw value — lets "remember this exact match" key
 *  on a secret/command WITHOUT ever storing the raw value (honors redaction). */
export function sig(raw) {
  return createHash("sha256").update(String(raw ?? "")).digest("hex").slice(0, 16);
}

/** Shannon entropy in bits/char over the string's character distribution. */
export function shannonEntropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const count of freq.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Redact a secret to a masked preview — a tiny prefix, an ellipsis, a short tail.
 *  Never returns enough to reconstruct the value (honors "never log bodies"). */
export function mask(secret) {
  const s = String(secret ?? "");
  if (s.length > 8) return `${s.slice(0, 2)}…${s.slice(-4)}`;
  if (s.length > 2) return `…${s.slice(-2)}`;
  return "…";
}

const ENV_REF_PATTERNS = [
  /\$\{\{\s*secrets\.[\w.-]+\s*\}\}/i, // GitHub Actions ${{ secrets.X }}
  /process\.env\.[\w]+/, // Node process.env.X
  /\bos\.environ(?:\.get)?\(?['"]?[\w]+/, // Python os.environ["X"]
  /\$\{[\w.]+\}/, // ${VAR}
  /\$[A-Za-z_]\w*/, // $VAR
];

/** True when the text is an environment-variable *reference* — the correct way to
 *  use a secret, so it must never be flagged as an exposed secret. */
export function looksLikeEnvRef(s) {
  const t = String(s ?? "");
  return ENV_REF_PATTERNS.some((re) => re.test(t));
}

const PLACEHOLDER_PATTERNS = [
  /your[-_ ].*here/i,
  /^x{3,}$/i,
  /\bchangeme\b/i,
  /\bexample\b/i,
  /\bplaceholder\b/i,
  /\bdummy\b/i,
  /\bredacted\b/i,
];

/** True when the value is an obvious placeholder, not a real secret. */
export function isPlaceholder(s) {
  const t = String(s ?? "");
  return PLACEHOLDER_PATTERNS.some((re) => re.test(t));
}
