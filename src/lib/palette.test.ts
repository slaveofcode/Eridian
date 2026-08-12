import { describe, it, expect } from "vitest";
import { seriesColor, SERIES_PALETTE } from "./palette";

describe("seriesColor", () => {
  it("gives distinct colors for the first N series", () => {
    const colors = SERIES_PALETTE.map((_, i) => seriesColor(i));
    expect(new Set(colors).size).toBe(SERIES_PALETTE.length);
  });

  it("wraps past the end and handles negatives", () => {
    expect(seriesColor(SERIES_PALETTE.length)).toBe(seriesColor(0));
    expect(seriesColor(-1)).toBe(SERIES_PALETTE[SERIES_PALETTE.length - 1]);
  });
});
