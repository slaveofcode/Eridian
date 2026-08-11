import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { EventRow } from "../lib/types";

// Wrap the formatter the cards call during render so the test can count how
// many cards actually re-do formatting work on a parent re-render.
vi.mock("../lib/format", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/format")>();
  return { ...real, formatBody: vi.fn(real.formatBody) };
});

import { formatBody } from "../lib/format";
import { EventCard } from "./EventCard";

function row(id: number): EventRow {
  return {
    id,
    sessionId: "s1",
    ts: "2026-08-09T10:00:00Z",
    kind: "assistant",
    role: "assistant",
    text: JSON.stringify({ step: id }), // structured body → formatBody per render
    toolName: null,
    toolInputJson: null,
    toolResultJson: null,
    tokensIn: null,
    tokensOut: null,
    toolUseId: null,
  };
}

// Mirrors the Timeline map: a live events-appended merge re-renders the parent
// with a fresh array holding the SAME row identities plus the appended rows.
function List({ events, onOpenFile }: { events: EventRow[]; onOpenFile?: (p: string) => void }) {
  return (
    <>
      {events.map((e) => (
        <EventCard key={e.id} event={e} onOpenFile={onOpenFile} />
      ))}
    </>
  );
}

describe("EventCard live-append render cost", () => {
  it("re-renders only the appended card, not every existing card", () => {
    const rows = [row(1), row(2), row(3)];
    const onOpenFile = () => {};
    const { rerender } = render(<List events={rows} onOpenFile={onOpenFile} />);
    const before = vi.mocked(formatBody).mock.calls.length;
    expect(before).toBe(3); // sanity: each card formatted exactly once

    rerender(<List events={[...rows, row(4)]} onOpenFile={onOpenFile} />);
    const delta = vi.mocked(formatBody).mock.calls.length - before;
    // A 1000-card timeline receiving ~5 merges/sec must not re-format every
    // card on each merge — only the new card may do work.
    expect(delta).toBe(1);
  });
});
