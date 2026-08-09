import { describe, it, expect } from "vitest";
import {
  filterCatalog,
  groupBySource,
  statusLabel,
  auditSummary,
  worstSeverity,
} from "./catalogUi";
import type { AuditRow, CatalogFlag, CatalogItem } from "./types";

function ci(over: Partial<CatalogItem>): CatalogItem {
  return {
    kind: "skill",
    sourceId: "local:official",
    sourceLabel: "Local plugin cache",
    name: "x",
    description: "",
    version: null,
    agents: [],
    installed: false,
    plugin: null,
    contentHash: null,
    readmeExcerpt: null,
    packageKind: null,
    identifier: null,
    transport: null,
    homepage: null,
    flags: [],
    installCommands: [],
    ...over,
  };
}

function ar(over: Partial<AuditRow>): AuditRow {
  return {
    kind: "skill",
    agent: "claude-code",
    scope: "user",
    name: "x",
    installedPath: "/x/SKILL.md",
    status: "upToDate",
    flags: [],
    updateCommand: null,
    removeCommand: null,
    ...over,
  };
}

describe("catalogUi", () => {
  it("filters by name and description, case-insensitive", () => {
    const items = [
      ci({ name: "brainstorm" }),
      ci({ name: "tdd", description: "Red green refactor" }),
    ];
    expect(filterCatalog(items, "GREEN").map((i) => i.name)).toEqual(["tdd"]);
    expect(filterCatalog(items, "")).toHaveLength(2);
  });

  it("groups by source preserving order", () => {
    const items = [
      ci({ sourceId: "a", sourceLabel: "A", name: "1" }),
      ci({ sourceId: "b", sourceLabel: "B", name: "2" }),
      ci({ sourceId: "a", sourceLabel: "A", name: "3" }),
    ];
    const groups = groupBySource(items);
    expect(groups.map((g) => g.source)).toEqual(["a", "b"]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("labels statuses", () => {
    expect(statusLabel("upToDate")).toBe("up to date");
    expect(statusLabel("updateAvailable")).toBe("update available");
    expect(statusLabel("localOnly")).toBe("local only");
    expect(statusLabel("unknownOrigin")).toBe("unknown origin");
  });

  it("summarizes updates and flags", () => {
    const flag: CatalogFlag = { severity: "danger", reason: "x" };
    expect(
      auditSummary([
        ar({ status: "updateAvailable" }),
        ar({ status: "updateAvailable" }),
        ar({ flags: [flag] }),
      ])
    ).toBe("2 updates available · 1 flagged");
    expect(auditSummary([ar({})])).toBe("");
    expect(auditSummary([ar({ status: "updateAvailable" })])).toBe(
      "1 update available"
    );
  });

  it("ranks severities", () => {
    expect(
      worstSeverity([
        { severity: "info", reason: "" },
        { severity: "danger", reason: "" },
      ])
    ).toBe("danger");
    expect(worstSeverity([{ severity: "notable", reason: "" }])).toBe("notable");
    expect(worstSeverity([])).toBeNull();
  });
});
