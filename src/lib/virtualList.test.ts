import { describe, it, expect } from "vitest";
import { computeRange, offsetOf, totalHeight } from "./virtualList";

// Ten items, 100px each → total 1000.
const heights = Array.from({ length: 10 }, () => 100);

describe("computeRange", () => {
  it("returns the window covering the viewport plus overscan", () => {
    // viewport [250,450] covers items 2,3,4; overscan 1 → render [1,5).
    const r = computeRange(heights, 250, 200, 1);
    expect(r.start).toBe(1);
    expect(r.end).toBe(5);
    expect(r.padTop).toBe(100); // item 0
    expect(r.padBottom).toBe(500); // items 5..9
  });

  it("clamps at the top", () => {
    const r = computeRange(heights, 0, 200, 2);
    expect(r.start).toBe(0);
    expect(r.padTop).toBe(0);
  });

  it("clamps at the bottom", () => {
    const r = computeRange(heights, 1000, 200, 2);
    expect(r.end).toBe(10);
    expect(r.padBottom).toBe(0);
  });

  it("handles an empty list", () => {
    const r = computeRange([], 0, 200, 2);
    expect(r).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
});

describe("offsetOf / totalHeight", () => {
  it("offsetOf sums preceding heights", () => {
    expect(offsetOf(heights, 0)).toBe(0);
    expect(offsetOf(heights, 3)).toBe(300);
    expect(offsetOf(heights, 100)).toBe(1000); // clamps
  });
  it("totalHeight sums all", () => {
    expect(totalHeight(heights)).toBe(1000);
    expect(totalHeight([])).toBe(0);
  });
});
