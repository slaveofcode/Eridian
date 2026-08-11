// Pure math for a variable-height virtual list. No DOM — unit-tested. The
// component (VirtualList.tsx) measures real heights and feeds them here.

export interface VRange {
  /** First index to render (inclusive). */
  start: number;
  /** One past the last index to render (exclusive). */
  end: number;
  /** Spacer height above the rendered window. */
  padTop: number;
  /** Spacer height below the rendered window. */
  padBottom: number;
}

/** Sum of all item heights. */
export function totalHeight(heights: number[]): number {
  let t = 0;
  for (const h of heights) t += h;
  return t;
}

/** Pixel offset (distance from the top) of the item at `index`, clamped. */
export function offsetOf(heights: number[], index: number): number {
  const n = Math.min(Math.max(index, 0), heights.length);
  let o = 0;
  for (let i = 0; i < n; i++) o += heights[i];
  return o;
}

/** Index range whose items intersect [scrollTop, scrollTop+viewport], widened
 *  by `overscan` items on each side, plus the top/bottom spacer heights. */
export function computeRange(
  heights: number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): VRange {
  const n = heights.length;
  if (n === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  // First item whose bottom edge is past scrollTop.
  let offset = 0;
  let start = 0;
  while (start < n && offset + heights[start] <= scrollTop) {
    offset += heights[start];
    start++;
  }
  // Extend until we've covered the viewport height.
  let end = start;
  let covered = 0;
  while (end < n && covered < viewport) {
    covered += heights[end];
    end++;
  }
  // Widen by overscan.
  const s = Math.max(0, start - overscan);
  const e = Math.min(n, end + overscan);

  let padTop = 0;
  for (let i = 0; i < s; i++) padTop += heights[i];
  let padBottom = 0;
  for (let i = e; i < n; i++) padBottom += heights[i];
  return { start: s, end: e, padTop, padBottom };
}
