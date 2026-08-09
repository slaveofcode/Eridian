import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders headings (shifted down), paragraphs, and inline styles", () => {
    const { container } = render(
      <Markdown text={"# Title\n\nplain **bold** and *em* and `code` and [x](https://a.b)"} />
    );
    // '#' → h3 (shifted two levels)
    expect(container.querySelector("h3.md-h")?.textContent).toBe("Title");
    expect(container.querySelector("p.md-p strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("code.md-inline-code")?.textContent).toBe("code");
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://a.b");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<Markdown text={"- a\n- b\n\n1. one\n2. two"} />);
    expect(container.querySelectorAll("ul.md-list li").length).toBe(2);
    expect(container.querySelectorAll("ol.md-list li").length).toBe(2);
  });

  it("renders blockquotes and fenced code (via CodeView container)", () => {
    const { container } = render(
      <Markdown text={"> quoted\n\n```js\nconst a = 1;\n```"} />
    );
    expect(container.querySelector("blockquote.md-quote")?.textContent).toContain("quoted");
    expect(container.querySelector(".md-code")).toBeTruthy();
    // fenced JS gets tokenized by CodeView
    expect(container.querySelector(".md-code .tok-key")?.textContent).toBe("const");
  });
});
