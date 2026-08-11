import { describe, it, expect } from "vitest";
import { visibleEvents } from "./timelineFilter";
import type { EventRow } from "./types";

const ev = (id: number, kind: string): EventRow => ({ id, kind } as EventRow);

const rows = [ev(1, "user"), ev(2, "assistant"), ev(3, "meta"), ev(4, "unknown"), ev(5, "tool_call")];

describe("visibleEvents", () => {
  it("shows meta when showMeta is true", () => {
    const out = visibleEvents(rows, { showMeta: true, showUnknown: false, activeKinds: new Set() });
    expect(out.map((e) => e.id)).toEqual([1, 2, 3, 5]);
  });

  it("hides meta when showMeta is false", () => {
    const out = visibleEvents(rows, { showMeta: false, showUnknown: false, activeKinds: new Set() });
    expect(out.map((e) => e.id)).toEqual([1, 2, 5]);
  });

  it("gates unknown independently of meta", () => {
    const out = visibleEvents(rows, { showMeta: true, showUnknown: true, activeKinds: new Set() });
    expect(out.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("active kind chips restrict conversation kinds but never meta/unknown", () => {
    const out = visibleEvents(rows, {
      showMeta: false,
      showUnknown: false,
      activeKinds: new Set(["tools"]),
    });
    expect(out.map((e) => e.id)).toEqual([5]);
  });
});
