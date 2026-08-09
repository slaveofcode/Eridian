import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DiffView, editDiff } from "./DiffView";

describe("editDiff", () => {
  it("returns null for non-edit tools or bad input", () => {
    expect(editDiff("Bash", "{}")).toBeNull();
    expect(editDiff(null, "{}")).toBeNull();
    expect(editDiff("Edit", null)).toBeNull();
    expect(editDiff("Edit", "not json")).toBeNull();
  });

  it("builds -/+ lines for a single Edit", () => {
    const d = editDiff("Edit", JSON.stringify({ old_string: "a\nb", new_string: "a\nc" }));
    expect(d).toBe("- a\n- b\n+ a\n+ c");
  });

  it("accepts camelCase keys", () => {
    const d = editDiff("edit", JSON.stringify({ oldString: "x", newString: "y" }));
    expect(d).toBe("- x\n+ y");
  });

  it("concatenates MultiEdit edits", () => {
    const d = editDiff(
      "MultiEdit",
      JSON.stringify({ edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })
    );
    expect(d).toBe("- a\n+ b\n- c\n+ d");
  });
});

describe("DiffView", () => {
  it("classifies add/del/context rows", () => {
    const { container } = render(<DiffView text={"+ added\n- removed\ncontext"} />);
    expect(container.querySelectorAll(".diff-line.add").length).toBe(1);
    expect(container.querySelectorAll(".diff-line.del").length).toBe(1);
    expect(container.querySelectorAll(".diff-line.ctx").length).toBe(1);
    expect(container.querySelector(".diff-line.add .diff-code")?.textContent).toBe("added");
  });
});
