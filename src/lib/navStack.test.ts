import { describe, it, expect } from "vitest";
import { navReducer, NAV_CAP, type NavState, type NavHistory } from "./navStack";

const base: NavState = {
  view: "sessions",
  activeId: null,
  agentFilter: null,
  trail: [],
  focusEventId: null,
};
const start: NavHistory = { current: base, past: [] };

describe("navReducer", () => {
  it("navigate pushes current onto past and sets the new current", () => {
    const next = { ...base, view: "mcp" as const };
    const s = navReducer(start, { type: "navigate", next });
    expect(s.current).toEqual(next);
    expect(s.past).toEqual([base]);
  });

  it("back pops the last past entry and restores it", () => {
    const mid = { ...base, view: "mcp" as const };
    const s1 = navReducer(start, { type: "navigate", next: mid });
    const s2 = navReducer(s1, { type: "navigate", next: { ...base, view: "skills" } });
    const s3 = navReducer(s2, { type: "back" });
    expect(s3.current).toEqual(mid);
    expect(s3.past).toEqual([base]);
  });

  it("back on empty history is a no-op", () => {
    const s = navReducer(start, { type: "back" });
    expect(s).toEqual(start);
  });

  it("replace swaps current without touching past", () => {
    const s1 = navReducer(start, { type: "navigate", next: { ...base, view: "mcp" } });
    const s2 = navReducer(s1, { type: "replace", next: { ...base, view: "skills" } });
    expect(s2.current.view).toBe("skills");
    expect(s2.past).toEqual([base]);
  });

  it("past is bounded to NAV_CAP entries (oldest dropped)", () => {
    let s = start;
    for (let i = 0; i < NAV_CAP + 10; i++) {
      s = navReducer(s, { type: "navigate", next: { ...base, activeId: `s${i}` } });
    }
    expect(s.past.length).toBe(NAV_CAP);
    // oldest surviving entry is the (11th) push, not the very first
    expect(s.past[0].activeId).toBe("s9");
  });
});
