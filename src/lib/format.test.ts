import { describe, it, expect } from "vitest";
import {
  formatClock,
  relativeTime,
  projectName,
  prettyJson,
  formatTokens,
  contextLimit,
  contextPct,
  unescapeInline,
  prettyXml,
  formatBody,
  isStructured,
  cleanTitle,
  cleanModel,
  isImagePath,
} from "./format";

describe("isImagePath", () => {
  it("recognizes image extensions (case-insensitive)", () => {
    for (const p of ["/a/b.png", "x.JPG", "y.jpeg", "z.gif", "w.webp", "i.svg", "a.avif"])
      expect(isImagePath(p)).toBe(true);
  });
  it("rejects non-images", () => {
    expect(isImagePath("/a/b.ts")).toBe(false);
    expect(isImagePath("notes.md")).toBe(false);
  });
});

describe("cleanModel", () => {
  it("extracts id from a JSON model object", () => {
    expect(cleanModel('{"id":"deepseek-v4-pro","providerID":"deepseek"}')).toBe("deepseek-v4-pro");
  });
  it("passes bare model strings through", () => {
    expect(cleanModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(cleanModel(null)).toBe("");
    expect(cleanModel("{not json")).toBe("{not json");
  });
});

describe("cleanTitle", () => {
  it("extracts the command name from a slash-command envelope", () => {
    expect(
      cleanTitle("<command-message>sample-review</command-message> <command-name>/sample-review</command-name>")
    ).toBe("/sample-review");
    expect(cleanTitle("<command-name>foo</command-name>")).toBe("/foo");
    expect(cleanTitle("<command-message>bar</command-message>")).toBe("/bar");
  });
  it("labels local-command output", () => {
    expect(cleanTitle("<local-command-caveat>Caveat: …</local-command-caveat>")).toBe("(local command)");
  });
  it("passes normal titles through", () => {
    expect(cleanTitle("Build all phases")).toBe("Build all phases");
  });
});

describe("formatTokens", () => {
  it("scales k / M / B", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_300_000)).toBe("2.3M");
    expect(formatTokens(5_690_000_000)).toBe("5.69B");
    expect(formatTokens(null)).toBe("");
  });
  it("handles negatives", () => {
    expect(formatTokens(-1500)).toBe("-1.5k");
  });
});

describe("contextLimit", () => {
  it("defaults to 200k for claude", () => {
    expect(contextLimit("claude-opus-4-8")).toBe(200_000);
  });
  it("infers 1M tier when peak exceeds 200k", () => {
    expect(contextLimit("claude-opus-4-8", 379_000)).toBe(1_000_000);
  });
  it("recognizes explicit markers", () => {
    expect(contextLimit("claude-sonnet-1m")).toBe(1_000_000);
    expect(contextLimit("gemini-2.5-pro")).toBe(1_000_000);
    expect(contextLimit("gpt-4o")).toBe(128_000);
  });
});

describe("contextPct", () => {
  it("null when no context tokens", () => {
    expect(contextPct(0, "claude-opus-4-8")).toBeNull();
  });
  it("uses the peak-inferred tier and clamps to 100", () => {
    // 379k latest ÷ 1M tier (peak 379k) ≈ 38%
    expect(contextPct(379_000, "claude-opus-4-8", 379_000)).toBe(38);
    // over-full clamps
    expect(contextPct(250_000, "claude-opus-4-8", 250_000)).toBeLessThanOrEqual(100);
    // 200k tier
    expect(contextPct(100_000, "claude-opus-4-8")).toBe(50);
  });
});

describe("projectName", () => {
  it("returns the last path segment, placeholder when null", () => {
    expect(projectName("/Users/x/Projects/tools/gwt")).toBe("gwt");
    expect(projectName(null)).toBe("unknown project");
  });
});

describe("relativeTime", () => {
  it("formats deltas and handles null/invalid", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime("not-a-date")).toBe("—");
    const secs = new Date(Date.now() - 5000).toISOString();
    expect(relativeTime(secs)).toMatch(/s ago$/);
    const hrs = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(hrs)).toMatch(/h ago$/);
    const days = new Date(Date.now() - 3 * 86400_000).toISOString();
    expect(relativeTime(days)).toMatch(/d ago$/);
  });
});

describe("formatClock", () => {
  it("renders HH:MM:SS and tolerates null", () => {
    expect(formatClock(null)).toBe("");
    expect(formatClock("2026-08-08T10:20:30Z")).toMatch(/\d\d:\d\d/);
  });
});

describe("prettyJson / isStructured / formatBody", () => {
  it("pretty-prints valid json", () => {
    expect(prettyJson('{"a":1}')).toContain("\n");
    expect(prettyJson("not json")).toBe("not json"); // passthrough
    expect(prettyJson(null)).toBe("");
  });
  it("detects structured payloads", () => {
    expect(isStructured('{"a":1}')).toBe(true);
    expect(isStructured("[1,2]")).toBe(true);
    expect(isStructured("plain text")).toBe(false);
    expect(isStructured(null)).toBe(false);
  });
  it("formatBody pretties json and passes through prose", () => {
    expect(formatBody('{"a":1}')).toContain("\n");
    expect(formatBody("hello")).toBe("hello");
  });
});

describe("unescapeInline", () => {
  it("turns escape sequences into characters", () => {
    expect(unescapeInline("a\\nb")).toBe("a\nb");
    expect(unescapeInline('x\\"y')).toBe('x"y');
    expect(unescapeInline("a\\tb")).toBe("a  b"); // tab → two spaces (display)
    expect(unescapeInline("a\\\\b")).toBe("a\\b");
  });
});

describe("prettyXml", () => {
  it("indents tags and passes malformed through", () => {
    const out = prettyXml("<a><b>1</b></a>");
    expect(out).toContain("<b>");
    expect(typeof prettyXml("<unclosed")).toBe("string");
  });
});
