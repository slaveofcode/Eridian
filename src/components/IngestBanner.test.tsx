import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { IngestBanner } from "./IngestBanner";
import type { IngestProgress } from "../lib/types";

const p = (o: Partial<IngestProgress>): IngestProgress => ({
  phase: "backfilling",
  filesDone: 0,
  filesTotal: 0,
  events: 0,
  done: false,
  ...o,
});

describe("IngestBanner", () => {
  it("shows the strip while backfilling is in flight", () => {
    const { container } = render(
      <IngestBanner progress={p({ filesDone: 3, filesTotal: 10, events: 42 })} />
    );
    expect(container.querySelector(".ingest-banner")).not.toBeNull();
    // 3/10 → 30% fill
    expect(
      (container.querySelector(".ingest-bar-fill") as HTMLElement)?.style.width
    ).toBe("30%");
  });

  it("hides when nothing is ingesting", () => {
    const { container } = render(<IngestBanner progress={null} />);
    expect(container.querySelector(".ingest-banner")).toBeNull();
  });

  it("hides in the steady watching state", () => {
    const { container } = render(<IngestBanner progress={p({ phase: "watching" })} />);
    expect(container.querySelector(".ingest-banner")).toBeNull();
  });

  // Regression: a finished rebuild emits its last event as
  // phase="backfilling" + done=true. The banner must clear on `done`, not only
  // on the "watching" phase — otherwise the strip is orphaned at "N/N files".
  it("hides on a terminal done event even if phase is still backfilling", () => {
    const { container } = render(
      <IngestBanner
        progress={p({ phase: "backfilling", filesDone: 1000, filesTotal: 1000, done: true })}
      />
    );
    expect(container.querySelector(".ingest-banner")).toBeNull();
  });
});
