// Dangerous-command detector: destructive or security-weakening shell. Defaults to
// Warn (the engine stamps the action). Rules are deliberately conservative to keep
// the blocking gate low-friction.

const RM_FORCE_RECURSIVE = /-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\b[\s\S]*-f\b/i;
const RM_DANGER_TARGET = /\s(?:\/|~|\*|\$HOME)(?:\s|\/|$)/;

const RULES = [
  {
    rule: "remote-exec",
    re: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python[0-9.]*)\b/i,
  },
  { rule: "chmod-777", re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*0?777\b/ },
  {
    rule: "tls-disabled",
    re: /--insecure\b|(?:^|\s)-k\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|verify\s*=\s*False|rejectUnauthorized\s*:\s*false/i,
  },
  {
    rule: "git-destructive",
    re: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\s+(?:[\s\S]*--force\b|-f\b)/i,
  },
];

/** @returns {Array<{category,severity,rule,maskedPreview,location}>} */
export function detectDangerous(text) {
  const s = String(text ?? "");
  const findings = [];
  const push = (rule) =>
    findings.push({
      category: "dangerous",
      severity: "medium",
      rule,
      maskedPreview: rule,
      location: null,
    });

  if (/\brm\b/.test(s) && RM_FORCE_RECURSIVE.test(s) && RM_DANGER_TARGET.test(s)) {
    push("rm-rf");
  }
  for (const { rule, re } of RULES) if (re.test(s)) push(rule);
  return findings;
}
