import type { EventRow } from "./types";

/** Conversation kinds → filter-chip group. `meta`/`unknown` are handled
 *  separately (their own toggles), so they are intentionally absent here. */
export const GROUP_OF: Record<string, string> = {
  user: "prompt",
  assistant: "assistant",
  thinking: "thinking",
  tool_call: "tools",
  tool_result: "tools",
  system: "system",
  summary: "summary",
};

export interface VisibleOpts {
  showMeta: boolean;
  showUnknown: boolean;
  activeKinds: Set<string>;
}

/** Which events to render given the meta/unknown toggles and the active kind
 *  chips. `meta` and `unknown` are gated only by their own toggles; the chips
 *  restrict conversation kinds only. */
export function visibleEvents(events: EventRow[], opts: VisibleOpts): EventRow[] {
  const { showMeta, showUnknown, activeKinds } = opts;
  return events.filter((e) => {
    if (e.kind === "meta") return showMeta;
    if (e.kind === "unknown") return showUnknown;
    return activeKinds.size === 0 || activeKinds.has(GROUP_OF[e.kind]);
  });
}
