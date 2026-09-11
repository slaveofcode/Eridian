// Exfiltration detector: a command that both sends data off-machine AND involves
// something sensitive (a secret/PII already found in the same command, or a
// sensitive file). Single-command heuristic — no cross-call taint tracking in v1.

const EGRESS =
  /\b(?:curl|wget|nc|ncat|telnet|scp|rsync)\b|\bgit\s+push\b|\bfetch\(|\baxios\./i;
const SENSITIVE_FILE =
  /\.env\b|\bid_rsa\b|\bid_ed25519\b|\bcredentials\b|\.pem\b|\.p12\b|\.pfx\b|secrets?\.(?:json|ya?ml|env)\b/i;

/**
 * @param {string} text
 * @param {Array<{category:string}>} priorFindings secrets/PII already detected here
 * @returns {Array<{category,severity,rule,maskedPreview,location}>}
 */
export function detectExfil(text, priorFindings = []) {
  const s = String(text ?? "");
  if (!EGRESS.test(s)) return [];
  const hasSecretOrPii = priorFindings.some(
    (f) => f.category === "secrets" || f.category === "pii"
  );
  const hasSensitiveFile = SENSITIVE_FILE.test(s);
  if (!hasSecretOrPii && !hasSensitiveFile) return [];
  return [
    {
      category: "exfiltration",
      severity: "high",
      rule: hasSensitiveFile ? "egress-sensitive-file" : "egress-with-secret",
      maskedPreview: "network egress of sensitive data",
      location: null,
    },
  ];
}
