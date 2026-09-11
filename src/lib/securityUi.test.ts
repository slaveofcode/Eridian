import { describe, it, expect } from "vitest";
import {
  categoryLabel,
  nextAction,
  parseList,
  formatList,
  filterFindings,
  remediationPrompt,
} from "./securityUi";
import type { SecurityFinding } from "./types";

const mk = (o: Partial<SecurityFinding>): SecurityFinding => ({
  id: "1",
  ts: null,
  sessionId: null,
  cwd: null,
  toolName: null,
  category: "secrets",
  severity: "high",
  action: "block",
  rule: "openai",
  maskedPreview: "sk-…1234",
  location: null,
  status: "open",
  ...o,
});

describe("securityUi", () => {
  it("labels known categories and falls back to the raw id", () => {
    expect(categoryLabel("secrets")).toBe("Secrets & API keys");
    expect(categoryLabel("guard-error")).toBe("guard-error");
  });

  it("cycles actions block → warn → off → block", () => {
    expect(nextAction("block")).toBe("warn");
    expect(nextAction("warn")).toBe("off");
    expect(nextAction("off")).toBe("block");
  });

  it("parses and formats lists", () => {
    expect(parseList(" a@x.com, b@y.com\n\n c ")).toEqual(["a@x.com", "b@y.com", "c"]);
    expect(parseList("")).toEqual([]);
    expect(formatList(["a", "b"])).toBe("a\nb");
    expect(formatList(undefined as unknown as string[])).toBe("");
  });

  it("filters findings by category and status", () => {
    const fs = [
      mk({ id: "1", category: "secrets", status: "open" }),
      mk({ id: "2", category: "pii", status: "open" }),
      mk({ id: "3", category: "secrets", status: "ignored" }),
    ];
    expect(filterFindings(fs, {}).length).toBe(3);
    expect(filterFindings(fs, { category: "secrets" }).map((f) => f.id)).toEqual(["1", "3"]);
    expect(filterFindings(fs, { status: "open" }).length).toBe(2);
    expect(filterFindings(fs, { category: "secrets", status: "open" }).map((f) => f.id)).toEqual(["1"]);
    expect(filterFindings(fs, { category: "all", status: "all" }).length).toBe(3);
  });

  it("builds a remediation prompt including location + guidance", () => {
    const p = remediationPrompt(mk({ location: "src/a.ts:5" }), "Rotate the key.");
    expect(p).toContain("Secrets & API keys");
    expect(p).toContain("src/a.ts:5");
    expect(p).toContain("Rotate the key.");
    expect(p).toContain("re-scan");
  });
});
