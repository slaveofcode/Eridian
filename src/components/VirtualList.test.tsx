import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VirtualList } from "./VirtualList";

describe("VirtualList", () => {
  it("renders the items in the estimated window", () => {
    const items = [{ id: 1, t: "alpha" }, { id: 2, t: "beta" }, { id: 3, t: "gamma" }];
    render(
      <VirtualList
        items={items}
        getKey={(it) => it.id}
        renderItem={(it) => <div>{it.t}</div>}
      />
    );
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
  });

  it("renders nothing for an empty list without crashing", () => {
    const { container } = render(
      <VirtualList items={[]} getKey={(_, i) => i} renderItem={() => <div>x</div>} />
    );
    expect(container.querySelector("div")).toBeTruthy();
  });
});
