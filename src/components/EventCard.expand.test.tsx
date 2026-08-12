import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventCard } from "./EventCard";
import type { EventRow } from "../lib/types";

const toolResult = (result: string): EventRow =>
  ({ id: 1, kind: "tool_result", toolResultJson: JSON.stringify(result) } as EventRow);

const bashCall = (cmd: string): EventRow =>
  ({
    id: 2,
    kind: "tool_call",
    toolName: "Bash",
    toolInputJson: JSON.stringify({ command: cmd }),
    toolUseId: "t1",
  } as EventRow);

describe("EventCard merged tool call + result", () => {
  it("renders both input and paired result when focused", () => {
    render(
      <EventCard
        event={bashCall("git status")}
        pairedResult={toolResult("on branch develop")}
        focused
      />
    );
    expect(screen.getByText(/git status/)).toBeTruthy();
    expect(screen.getByText(/on branch develop/)).toBeTruthy();
  });

  it("shows a running indicator when there is no paired result", () => {
    render(<EventCard event={bashCall("cargo test")} pairedResult={null} />);
    expect(screen.getByText(/running…/)).toBeTruthy();
  });

  it("shows a placeholder for empty thinking", () => {
    const thinking = { id: 3, kind: "thinking", text: "  " } as EventRow;
    render(<EventCard event={thinking} defaultExpanded />);
    expect(screen.getByText(/no thinking text captured/)).toBeTruthy();
  });
});

describe("EventCard expand-all + cap", () => {
  it("renders the result body when defaultExpanded is true", () => {
    render(<EventCard event={toolResult("hello-output")} defaultExpanded />);
    expect(screen.getByText(/hello-output/)).toBeTruthy();
  });

  it("does not render the result body when collapsed", () => {
    render(<EventCard event={toolResult("hidden-output")} defaultExpanded={false} />);
    expect(screen.queryByText(/hidden-output/)).toBeNull();
  });

  it("caps a huge body and offers show-full-block", () => {
    const huge = "x".repeat(20000);
    render(<EventCard event={toolResult(huge)} defaultExpanded />);
    expect(screen.getByText(/show full block/)).toBeTruthy();
  });
});
