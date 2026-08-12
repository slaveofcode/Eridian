// Categorical palette for data series (e.g. per-model usage bars) on the dark
// ops-console background. Hues are moderately saturated and kept ≥3:1 against
// the panel background (WCAG contrast-data). Series always carry a text label
// too, so colour is never the only signal (WCAG color-not-only).
export const SERIES_PALETTE = [
  "#e8956b", // amber (matches the app accent)
  "#6ea8fe", // blue
  "#4ec9a5", // teal
  "#b48ef0", // violet
  "#e879a8", // pink
  "#56c9d6", // cyan
  "#d8b45a", // gold
  "#8bc46a", // lime
  "#ef7a6d", // coral
  "#9aa7ff", // periwinkle
  "#d98cc0", // rose
  "#7fb0c9", // steel
] as const;

/** Distinct colour for a series at `index` (wraps if beyond the palette). */
export function seriesColor(index: number): string {
  const n = SERIES_PALETTE.length;
  return SERIES_PALETTE[((index % n) + n) % n];
}
