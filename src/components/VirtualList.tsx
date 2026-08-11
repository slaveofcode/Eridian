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
  /** Scroll item `index` into view. align: 0=top, 0.5=center, 1=bottom. */
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
    const target = Math.max(
      0,
      offsetOf(heights, p.index) - el.clientHeight / 2 + (heights[p.index] ?? estimate) / 2
    );
    const prev = el.scrollTop;
    programmatic.current = true;
    el.scrollTop = target;
    p.passes += 1;
    if (Math.abs(target - prev) < 2 || p.passes > 8) pending.current = null;
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
      scrollToIndex: (index, align = 0.5) => {
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
          <Measured key={key} mkey={key} onSize={setSize}>
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
  onSize,
  children,
}: {
  mkey: Key;
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
  return <div ref={ref}>{children}</div>;
}
