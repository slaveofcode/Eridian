// Pure helpers for the Security view — kept out of the component so they're unit
// tested (and in the coverage gate). No Tauri/DOM here.

import type { GuardAction, GuardCategory, SecurityFinding } from "./types";

export const CATEGORY_LABELS: Record<GuardCategory, string> = {
  secrets: "Secrets & API keys",
  pii: "PII",
  exfiltration: "Exfiltration",
  dangerous: "Dangerous commands",
  commitIdentity: "Commit identity leak",
  aiAuthorship: "AI authorship leak",
};

export const CATEGORY_ORDER: GuardCategory[] = [
  "secrets",
  "pii",
  "exfiltration",
  "dangerous",
  "commitIdentity",
  "aiAuthorship",
];

/** Human label for a category id (falls back to the raw id, e.g. "guard-error"). */
export function categoryLabel(cat: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[cat] ?? cat;
}

/** Cycle a category action Block → Warn → Off → Block (click-to-cycle control). */
export function nextAction(a: GuardAction): GuardAction {
  return a === "block" ? "warn" : a === "warn" ? "off" : "block";
}

/** Split a textarea into a clean list (trimmed, non-empty, comma or newline split). */
export function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Render a list back into a newline-joined textarea value. */
export function formatList(items: string[]): string {
  return (items ?? []).join("\n");
}

/** Filter findings by category and/or status ("all" = no filter on that axis). */
export function filterFindings(
  findings: SecurityFinding[],
  opts: { category?: string; status?: string }
): SecurityFinding[] {
  const cat = opts.category && opts.category !== "all" ? opts.category : null;
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  return findings.filter(
    (f) => (!cat || f.category === cat) && (!status || f.status === status)
  );
}

/** A ready-to-paste remediation prompt for a coding agent ("hand to Claude Code"). */
export function remediationPrompt(f: SecurityFinding, guidance: string): string {
  const where = f.location ? ` (at ${f.location})` : "";
  return (
    `Security finding to fix — ${categoryLabel(f.category)}${where}: ${f.rule}. ` +
    `${guidance} Then re-run the affected command so Eridian's guard can re-scan and ` +
    `confirm it's resolved.`
  );
}
