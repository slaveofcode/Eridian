// Secrets & API-key detector. Known provider formats (definitive) plus a generic
// high-entropy rule that only fires for a secret-ish variable assignment — with the
// env-reference / placeholder / hash guards from util that keep the blocking gate
// from crying wolf. Findings carry only a masked preview, never the raw value.

import { shannonEntropy, mask, looksLikeEnvRef, isPlaceholder } from "../util.mjs";

// Anthropic before OpenAI so the more specific rule wins the shared `sk-…` span.
const KNOWN = [
  { rule: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "openai", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "github-token", re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { rule: "github-fine-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { rule: "gitlab-pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "stripe-key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { rule: "private-key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
];

// name (secret-ish) = "value" (no spaces, 16-80 chars)
const ASSIGN =
  /(\w*(?:secret|token|password|passwd|pwd|apikey|api_key|api|auth|credential)\w*)\s*[:=]\s*["'`]?([^"'`\s]{16,80})["'`]?/gi;

function hasDiverseCharset(v) {
  let classes = 0;
  if (/[a-z]/.test(v)) classes++;
  if (/[A-Z]/.test(v)) classes++;
  if (/[0-9]/.test(v)) classes++;
  if (/[^A-Za-z0-9]/.test(v)) classes++;
  return classes >= 2;
}

/** @returns {Array<{category,severity,rule,maskedPreview,location}>} */
export function detectSecrets(text) {
  const s = String(text ?? "");
  const findings = [];
  const seen = new Set(); // raw values already flagged, for dedupe

  const add = (raw, rule) => {
    if (seen.has(raw)) return;
    seen.add(raw);
    findings.push({
      category: "secrets",
      severity: "high",
      rule,
      maskedPreview: rule === "private-key" ? "PRIVATE KEY block" : mask(raw),
      location: null,
    });
  };

  for (const { rule, re } of KNOWN) {
    for (const m of s.matchAll(re)) {
      const raw = m[0];
      if (looksLikeEnvRef(raw) || isPlaceholder(raw)) continue;
      add(raw, rule);
    }
  }

  for (const m of s.matchAll(ASSIGN)) {
    const value = m[2];
    if (!value || value.length < 16) continue;
    if (looksLikeEnvRef(value) || isPlaceholder(value)) continue;
    if (/^[0-9a-f]{7,64}$/i.test(value)) continue; // git sha / md5 / sha-256
    if ([...seen].some((v) => v.includes(value) || value.includes(v))) continue;
    if (shannonEntropy(value) < 3.5) continue;
    if (!hasDiverseCharset(value)) continue;
    add(value, "generic-entropy");
  }

  return findings;
}
