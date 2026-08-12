import { describe, it, expect } from "vitest";
import { formatDuration, elapsedSecs, riskClass } from "./commandsUi";

describe("formatDuration", () => {
  it("formats null, seconds, minutes, hours", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(4)).toBe("4s");
    expect(formatDuration(63)).toBe("1m 3s");
    expect(formatDuration(7325)).toBe("2h 2m");
  });
});

describe("elapsedSecs", () => {
  it("computes whole seconds from an ISO start to nowMs", () => {
    const start = "2026-08-11T00:00:00Z";
    const now = Date.parse("2026-08-11T00:00:05Z");
    expect(elapsedSecs(start, now)).toBe(5);
  });
  it("returns null for a missing/unparseable start", () => {
    expect(elapsedSecs(null, 1)).toBeNull();
    expect(elapsedSecs("nope", 1)).toBeNull();
  });
  it("never returns negative", () => {
    const start = "2026-08-11T00:00:10Z";
    const now = Date.parse("2026-08-11T00:00:05Z");
    expect(elapsedSecs(start, now)).toBe(0);
  });
});

describe("riskClass", () => {
  it("maps known risks, defaults to safe", () => {
    expect(riskClass("danger")).toBe("danger");
    expect(riskClass("notable")).toBe("notable");
    expect(riskClass("safe")).toBe("safe");
    expect(riskClass("weird")).toBe("safe");
  });
});
