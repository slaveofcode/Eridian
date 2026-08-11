import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { computeRange, offsetOf, totalHeight } from "../lib/virtualList";

export interface VirtualHandle {
  /** Scroll item `index` into view; `align` = fraction of the viewport from the
   *  top where the item's TOP should sit (0 = flush top, 0.1 = a little below). */
  scrollToIndex: (index: number, align?: number) => void;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  pageUp: () => void;
}

type Key = string | number;

/** Hand-rolled variable-height virtual list (zero-dep). Renders only the items
 *  near the viewport; measures real heights via ResizeObserver and corrects the
 *  scroll offset so scroll-to-index lands precisely despite estimated heights. */
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimate = 140,
  overscan = 6,
  handleRef,
  onEdges,
  onUserScroll,
  className,
}: {
  items: T[];
  getKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  estimate?: number;
  overscan?: number;
  handleRef?: MutableRefObject<VirtualHandle | null>;
  onEdges?: (e: { atTop: boolean; atBottom: boolean }) => void;
  /** Fired when the *user* scrolls (not our programmatic scroll). */
  onUserScroll?: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heightMap = useRef(new Map<Key, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((x) => x + 1), []);
  const programmatic = useRef(false);
  const pending = useRef<{ index: number; align: number; passes: number } | null>(null);

  const heights = items.map((it, i) => heightMap.current.get(getKey(it, i)) ?? estimate);
  const total = totalHeight(heights);
  const range = computeRange(heights, scrollTop, viewport, overscan);

  const setSize = useCallback(
    (key: Key, h: number) => {
      if (h > 0 && Math.abs((heightMap.current.get(key) ?? -1) - h) > 0.5) {
        heightMap.current.set(key, h);
        rerender();
      }
    },
    [rerender]
  );

  // Track the scroll container's height.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const set = () => setViewport(el.clientHeight || 600);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Correct the scroll offset after heights are measured, so scroll-to-index
  // lands on the real position (estimates shift it on the first pass).
  useLayoutEffect(() => {
    const p = pending.current;
    const el = scrollRef.current;
    if (!p || !el) return;
    // Prefer the target's ACTUAL rendered position (exact, independent of the
    // estimated heights of the cards above it). If it isn't rendered yet, jump
    // to the estimated offset to bring it into range, then correct next pass.
    const node = el.querySelector<HTMLElement>(`[data-vindex="${p.index}"]`);
    const align = p.align * el.clientHeight;
    let target: number;
    if (node) {
      const contentTop = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      target = contentTop - align;
    } else {
      target = offsetOf(heights, p.index) - align;
    }
    target = Math.max(0, target);
    const prev = el.scrollTop;
    programmatic.current = true;
    el.scrollTop = target;
    p.passes += 1;
    // Done once we've landed precisely on the real node, or after a safety cap.
    if ((node && Math.abs(target - prev) < 2) || p.passes > 12) pending.current = null;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    onEdges?.({
      atTop: el.scrollTop < 40,
      atBottom: el.scrollTop + el.clientHeight >= total - 80,
    });
    if (programmatic.current) {
      programmatic.current = false;
    } else if (!pending.current) {
      onUserScroll?.();
    }
  };

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      scrollToIndex: (index, align = 0.1) => {
        pending.current = { index, align, passes: 0 };
        rerender(); // kick the correction effect
      },
      scrollToBottom: () => {
        const el = scrollRef.current;
        if (el) {
          programmatic.current = true;
          el.scrollTop = el.scrollHeight;
        }
      },
      scrollToTop: () => {
        const el = scrollRef.current;
        if (el) {
          programmatic.current = true;
          el.scrollTop = 0;
        }
      },
      pageUp: () => {
        const el = scrollRef.current;
        if (el) el.scrollBy({ top: -Math.round(el.clientHeight * 0.9), behavior: "smooth" });
      },
    };
  }, [handleRef, rerender]);

  const visible = items.slice(range.start, range.end);
  return (
    <div className={className} ref={scrollRef} onScroll={onScroll}>
      <div style={{ height: range.padTop }} aria-hidden />
      {visible.map((it, i) => {
        const index = range.start + i;
        const key = getKey(it, index);
        return (
          <Measured key={key} mkey={key} index={index} onSize={setSize}>
            {renderItem(it, index)}
          </Measured>
        );
      })}
      <div style={{ height: range.padBottom }} aria-hidden />
    </div>
  );
}

function Measured({
  mkey,
  index,
  onSize,
  children,
}: {
  mkey: Key;
  index: number;
  onSize: (key: Key, h: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onSize(mkey, el.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onSize(mkey, el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mkey, onSize]);
  return (
    <div ref={ref} data-vindex={index}>
      {children}
    </div>
  );
}
