import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { XmlView } from "./XmlView";

describe("XmlView", () => {
  it("falls back to <pre> for non-XML", () => {
    const { container } = render(<XmlView xml={"not xml at all"} />);
    expect(container.querySelector("pre.code")).toBeTruthy();
    expect(container.querySelector(".xml-tree")).toBeNull();
  });

  it("renders leaf key/value pairs", () => {
    const { container } = render(
      <XmlView xml={"<observation><title>Hello</title><body>World</body></observation>"} />
    );
    const keys = [...container.querySelectorAll(".xml-key")].map((e) => e.textContent);
    expect(keys).toContain("title");
    expect(container.querySelector(".xml-val")?.textContent).toBe("Hello");
  });

  it("pretty-prints embedded JSON leaves", () => {
    const { container } = render(
      <XmlView xml={'<x><parameters>{"a":1}</parameters></x>'} />
    );
    const pre = container.querySelector("pre.xml-pre");
    expect(pre?.textContent).toContain("\n"); // JSON.stringify indented
    expect(pre?.textContent).toContain('"a": 1');
  });

  it("collapses/expands parent nodes", () => {
    const { container } = render(
      <XmlView xml={"<root><child><leaf>v</leaf></child></root>"} />
    );
    const head = container.querySelector(".xml-head") as HTMLButtonElement;
    expect(container.querySelector(".xml-children")).toBeTruthy(); // open by default (depth<4)
    fireEvent.click(head);
    expect(container.querySelector(".xml-node > .xml-children")).toBeNull(); // collapsed
  });

  it("skips empty leaves", () => {
    const { container } = render(<XmlView xml={"<r><empty></empty><has>x</has></r>"} />);
    const keys = [...container.querySelectorAll(".xml-key")].map((e) => e.textContent);
    expect(keys).toContain("has");
    expect(keys).not.toContain("empty");
  });
});
