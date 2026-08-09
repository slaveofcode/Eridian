import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "./hooks";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 200));
    expect(result.current).toBe("a");
  });

  it("updates only after the delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    expect(result.current).toBe("a"); // not yet
    act(() => vi.advanceTimersByTime(199));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("b"); // after delay
  });

  it("resets the timer on rapid changes", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    act(() => vi.advanceTimersByTime(150));
    rerender({ v: "c" });
    act(() => vi.advanceTimersByTime(150));
    expect(result.current).toBe("a"); // still debouncing
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("c"); // latest wins
  });
});
