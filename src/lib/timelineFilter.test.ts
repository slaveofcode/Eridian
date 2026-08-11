import { describe, it, expect } from "vitest";
import { visibleEvents, pairToolEvents } from "./timelineFilter";
import type { EventRow } from "./types";

const ev = (id: number, kind: string): EventRow => ({ id, kind } as EventRow);
const tool = (id: number, kind: string, toolUseId: string | null): EventRow =>
  ({ id, kind, toolUseId } as EventRow);

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

describe("pairToolEvents", () => {
  it("merges a finished tool_result into its tool_call and drops the standalone", () => {
    const rows = [
      ev(1, "user"),
      tool(2, "tool_call", "t1"),
      tool(3, "tool_result", "t1"),
      ev(4, "assistant"),
    ];
    const items = pairToolEvents(rows);
    expect(items.map((i) => i.event.id)).toEqual([1, 2, 4]); // result 3 absorbed
    const call = items.find((i) => i.event.id === 2)!;
    expect(call.result?.id).toBe(3);
  });

  it("keeps a running tool_call (no result) with result=null", () => {
    const items = pairToolEvents([tool(2, "tool_call", "t1")]);
    expect(items).toHaveLength(1);
    expect(items[0].result).toBeNull();
  });

  it("renders an orphan tool_result standalone when its call is absent", () => {
    const items = pairToolEvents([tool(3, "tool_result", "t9")]);
    expect(items.map((i) => i.event.id)).toEqual([3]);
    expect(items[0].result).toBeNull();
  });

  it("falls back to FIFO pairing when tool_use_id is missing (legacy events)", () => {
    // call, result, call, result — no ids at all.
    const rows = [
      tool(1, "tool_call", null),
      tool(2, "tool_result", null),
      tool(3, "tool_call", null),
      tool(4, "tool_result", null),
    ];
    const items = pairToolEvents(rows);
    expect(items.map((i) => i.event.id)).toEqual([1, 3]); // both results absorbed
    expect(items[0].result?.id).toBe(2);
    expect(items[1].result?.id).toBe(4);
  });

  it("FIFO pairs parallel calls in order and leaves a trailing running call open", () => {
    const rows = [
      tool(1, "tool_call", null),
      tool(2, "tool_call", null),
      tool(3, "tool_result", null),
      tool(4, "tool_result", null),
      tool(5, "tool_call", null), // still running (no result)
    ];
    const items = pairToolEvents(rows);
    expect(items.map((i) => i.event.id)).toEqual([1, 2, 5]);
    expect(items[0].result?.id).toBe(3); // call1 → result1 (FIFO order)
    expect(items[1].result?.id).toBe(4); // call2 → result2
    expect(items[2].result).toBeNull(); // call5 still running
  });

  it("prefers id-based pairing over FIFO when ids are present", () => {
    // Ids present but out of order → still paired by id, not adjacency.
    const rows = [
      tool(1, "tool_call", "a"),
      tool(2, "tool_call", "b"),
      tool(3, "tool_result", "b"),
      tool(4, "tool_result", "a"),
    ];
    const items = pairToolEvents(rows);
    expect(items.map((i) => i.event.id)).toEqual([1, 2]);
    expect(items[0].result?.id).toBe(4); // a → a
    expect(items[1].result?.id).toBe(3); // b → b
  });
});
