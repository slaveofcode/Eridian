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
  const resultForCall = new Map<number, EventRow>(); // call.id → its result
  const absorbed = new Set<number>(); // result.id merged into a call

  // Pass 1 — exact pairing by tool_use_id (correct even when interleaved).
  const resultByUse = new Map<string, EventRow>();
  for (const e of events) {
    if (e.kind === "tool_result" && e.toolUseId) resultByUse.set(e.toolUseId, e);
  }
  for (const e of events) {
    if (e.kind === "tool_call" && e.toolUseId) {
      const r = resultByUse.get(e.toolUseId);
      if (r && !absorbed.has(r.id)) {
        resultForCall.set(e.id, r);
        absorbed.add(r.id);
      }
    }
  }

  // Pass 2 — FIFO fallback for events with no usable tool_use_id (legacy rows
  // ingested before id capture). Each still-unpaired result pairs with the
  // oldest still-unpaired call in document order. This is correct for
  // alternating and parallel calls, and leaves a trailing running call open.
  const pendingCalls: EventRow[] = [];
  for (const e of events) {
    if (e.kind === "tool_call") {
      if (!resultForCall.has(e.id)) pendingCalls.push(e);
    } else if (e.kind === "tool_result" && !absorbed.has(e.id)) {
      const call = pendingCalls.shift();
      if (call) {
        resultForCall.set(call.id, e);
        absorbed.add(e.id);
      }
    }
  }

  const items: RenderItem[] = [];
  for (const e of events) {
    if (e.kind === "tool_result" && absorbed.has(e.id)) continue;
    if (e.kind === "tool_call") {
      items.push({ event: e, result: resultForCall.get(e.id) ?? null });
    } else {
      items.push({ event: e, result: null });
    }
  }
  return items;
}
