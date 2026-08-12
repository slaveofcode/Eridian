import { useCallback, useReducer } from "react";
import type { Agent } from "./types";

export type View = "sessions" | "shell" | "mcp" | "skills" | "usage" | "servers" | "settings";
export type AgentFilter = Agent | `plugin:${string}` | null;
export type SessionTab = "timeline" | "changes";

/** The complete navigation state at one point in time. Holds only identifiers
 *  and anchors — never loaded content — so the whole history stays tiny. */
export interface NavState {
  view: View;
  activeId: string | null;
  agentFilter: AgentFilter;
  trail: string[]; // subagent ancestry (parent ids, oldest→newest)
  focusEventId: number | null;
  /** Which session sub-view (Timeline vs Changes) — restored on back. */
  tab: SessionTab;
}

export interface NavHistory {
  current: NavState;
  past: NavState[];
}

export type NavAction =
  | { type: "navigate"; next: NavState }
  | { type: "back" }
  | { type: "replace"; next: NavState };

/** Bound the back-stack; browsing can't grow it without end. */
export const NAV_CAP = 50;

export function navReducer(state: NavHistory, action: NavAction): NavHistory {
  switch (action.type) {
    case "navigate": {
      const past = [...state.past, state.current];
      return {
        current: action.next,
        past: past.length > NAV_CAP ? past.slice(past.length - NAV_CAP) : past,
      };
    }
    case "back": {
      if (state.past.length === 0) return state;
      const past = state.past.slice(0, -1);
      const current = state.past[state.past.length - 1];
      return { current, past };
    }
    case "replace":
      return { current: action.next, past: state.past };
  }
}

/** Owns navigation state as a browser-like history. `navigate` pushes a back
 *  entry; `back` restores the previous state; `replace` swaps without a push.
 *  navigate/back/replace are stable identities (safe to pass to memoized rows). */
export function useNavStack(initial: NavState) {
  const [state, dispatch] = useReducer(navReducer, { current: initial, past: [] });
  const navigate = useCallback((next: NavState) => dispatch({ type: "navigate", next }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const replace = useCallback((next: NavState) => dispatch({ type: "replace", next }), []);
  return { nav: state.current, canGoBack: state.past.length > 0, navigate, back, replace };
}
