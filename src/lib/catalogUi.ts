// Pure UI derivations for the Skills/MCP catalog. No React, no I/O — kept here
// (and coverage-gated) so the components stay thin.

import type { AuditRow, CatalogFlag, CatalogItem, FlagSeverity } from "./types";

/** Case-insensitive filter over name + description. Empty query → all items. */
export function filterCatalog(items: CatalogItem[], query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q)
  );
}

export interface CatalogGroup {
  source: string;
  label: string;
  items: CatalogItem[];
}

/** Group items by their source, preserving first-seen order of sources. */
export function groupBySource(items: CatalogItem[]): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  const byId = new Map<string, CatalogGroup>();
  for (const item of items) {
    let g = byId.get(item.sourceId);
    if (!g) {
      g = { source: item.sourceId, label: item.sourceLabel, items: [] };
      byId.set(item.sourceId, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

/** Human-readable label for an audit status. */
export function statusLabel(s: AuditRow["status"]): string {
  switch (s) {
    case "upToDate":
      return "up to date";
    case "updateAvailable":
      return "update available";
    case "localOnly":
      return "local only";
    case "unknownOrigin":
      return "unknown origin";
  }
}

/** A one-line banner summarizing pending updates and flags. "" when nothing to say. */
export function auditSummary(rows: AuditRow[]): string {
  const updates = rows.filter((r) => r.status === "updateAvailable").length;
  const flagged = rows.filter((r) => r.flags.length > 0).length;
  const parts: string[] = [];
  if (updates > 0) parts.push(`${updates} update${updates === 1 ? "" : "s"} available`);
  if (flagged > 0) parts.push(`${flagged} flagged`);
  return parts.join(" · ");
}

const SEVERITY_RANK: Record<FlagSeverity, number> = {
  danger: 3,
  notable: 2,
  info: 1,
};

/** The most severe flag in a set, or null if none. */
export function worstSeverity(flags: CatalogFlag[]): FlagSeverity | null {
  let worst: FlagSeverity | null = null;
  for (const f of flags) {
    if (worst === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) {
      worst = f.severity;
    }
  }
  return worst;
}
