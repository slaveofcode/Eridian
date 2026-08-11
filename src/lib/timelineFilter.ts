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

/** A timeline row: a normal event, or a tool_call carrying its paired result. */
export interface RenderItem {
  event: EventRow;
  result: EventRow | null;
}

/** Merge each finished tool_result into its tool_call (paired by `toolUseId`):
 *  the call carries the result and the standalone result row is dropped. A
 *  running call (no result yet) keeps `result: null`; an orphan result whose
 *  call isn't in the list renders on its own. Input order is preserved. */
export function pairToolEvents(events: EventRow[]): RenderItem[] {
  const resultByUse = new Map<string, EventRow>();
  for (const e of events) {
    if (e.kind === "tool_result" && e.toolUseId) resultByUse.set(e.toolUseId, e);
  }
  const absorbed = new Set<number>();
  for (const e of events) {
    if (e.kind === "tool_call" && e.toolUseId) {
      const r = resultByUse.get(e.toolUseId);
      if (r) absorbed.add(r.id);
    }
  }
  const items: RenderItem[] = [];
  for (const e of events) {
    if (e.kind === "tool_result" && absorbed.has(e.id)) continue;
    if (e.kind === "tool_call" && e.toolUseId) {
      items.push({ event: e, result: resultByUse.get(e.toolUseId) ?? null });
    } else {
      items.push({ event: e, result: null });
    }
  }
  return items;
}
