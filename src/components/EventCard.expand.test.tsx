import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventCard } from "./EventCard";
import type { EventRow } from "../lib/types";

const toolResult = (result: string): EventRow =>
  ({ id: 1, kind: "tool_result", toolResultJson: JSON.stringify(result) } as EventRow);

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
