// Remembered decisions: a decision is { scope: "exact"|"rule", key, action:
// "allow"|"block" }. "exact" keys on the finding's sig (a hash of the raw match,
// never the value); "rule" keys on "<category>:<rule>".

/** The two keys a finding could be remembered under. */
export function decisionKeys(finding) {
  return {
    exact: finding.sig || null,
    rule: `${finding.category}:${finding.rule}`,
  };
}

/** The remembered action for a finding, or null if none is remembered. Exact wins
 *  over rule (more specific), and block wins over allow at the same scope (safer). */
export function matchDecision(finding, decisions = []) {
  const keys = decisionKeys(finding);
  const at = (scope, key) =>
    decisions
      .filter((d) => d && d.scope === scope && d.key === key)
      .map((d) => d.action);
  const exact = keys.exact ? at("exact", keys.exact) : [];
  if (exact.length) return exact.includes("block") ? "block" : "allow";
  const rule = at("rule", keys.rule);
  if (rule.length) return rule.includes("block") ? "block" : "allow";
  return null;
}

/**
 * Apply remembered decisions to engine findings.
 * - remembered "allow" → the block finding is dropped (user allowed this pattern).
 * - remembered "block" → kept (logged) but not surfaced for a prompt (silent block).
 * - no memory on a block finding → kept AND listed in blockUnresolved (needs a prompt).
 * Non-block (warn) findings are always kept.
 * @returns {{kept: object[], blockUnresolved: object[]}}
 */
export function applyRememberedDecisions(findings, decisions = []) {
  const kept = [];
  const blockUnresolved = [];
  for (const f of findings) {
    if (f.action !== "block") {
      kept.push(f);
      continue;
    }
    const remembered = matchDecision(f, decisions);
    if (remembered === "allow") continue; // drop — user allowed this pattern
    kept.push(f);
    if (remembered !== "block") blockUnresolved.push(f); // no memory → needs a decision
  }
  return { kept, blockUnresolved };
}
