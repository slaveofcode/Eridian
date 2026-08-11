import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ShellPanel } from "./ShellPanel";

vi.mock("../lib/api", () => ({
  api: {
    runningCommands: vi.fn().mockResolvedValue([
      {
        eventId: 1,
        sessionId: "cc:s",
        agent: "claude-code",
        sessionTitle: "proj",
        command: "cargo test",
        risk: "safe",
        startedAt: "2026-08-11T00:00:00Z",
      },
    ]),
    commandHistory: vi.fn().mockResolvedValue({ rows: [], nextBeforeId: null }),
    commandOutput: vi.fn().mockResolvedValue("output"),
  },
  onEventsAppended: vi.fn().mockResolvedValue(() => {}),
  onSessionsUpdated: vi.fn().mockResolvedValue(() => {}),
}));

describe("ShellPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a running command", async () => {
    render(<ShellPanel onDrillIn={() => {}} />);
    await waitFor(() => expect(screen.getByText("cargo test")).toBeTruthy());
  });
});
