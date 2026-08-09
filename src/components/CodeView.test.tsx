import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CodeView, langForPath, langForName, langLabel } from "./CodeView";

describe("langForPath / langForName / langLabel", () => {
  it("maps extensions", () => {
    expect(langForPath("a.ts")).toBe("js");
    expect(langForPath("a.tsx")).toBe("js");
    expect(langForPath("a.rs")).toBe("rust");
    expect(langForPath("a.py")).toBe("python");
    expect(langForPath("a.go")).toBe("go");
    expect(langForPath("a.json")).toBe("json");
    expect(langForPath("a.css")).toBe("css");
    expect(langForPath("a.sh")).toBe("shell");
    expect(langForPath("a.toml")).toBe("toml");
    expect(langForPath("a.yaml")).toBe("yaml");
    expect(langForPath("a.md")).toBe("markdown");
    expect(langForPath("a.unknownext")).toBe("plain");
  });
  it("maps fence hints", () => {
    expect(langForName("typescript")).toBe("js");
    expect(langForName("bash")).toBe("shell");
    expect(langForName("rust")).toBe("rust");
    expect(langForName("")).toBe("plain");
  });
  it("labels languages", () => {
    expect(langLabel("js")).toBe("TS / JS");
    expect(langLabel("markdown")).toBe("Markdown");
    expect(langLabel("plain")).toBe("Text");
  });
});

// Tokenization is exercised through the rendered component (token classes on spans).
describe("CodeView tokenization", () => {
  it("highlights JS strings, comments, keywords, numbers", () => {
    const src = `const x = 42; // note\nconst s = "hi";`;
    const { container } = render(<CodeView text={src} lang="js" />);
    expect(container.querySelector(".tok-key")?.textContent).toBe("const");
    expect(container.querySelector(".tok-com")?.textContent).toContain("// note");
    expect(container.querySelector(".tok-num")?.textContent).toBe("42");
    expect([...container.querySelectorAll(".tok-str")].some((e) => e.textContent === '"hi"')).toBe(true);
  });

  it("marks JSON property keys", () => {
    const { container } = render(<CodeView text={`{"key": 1}`} lang="json" />);
    expect(container.querySelector(".tok-prop")?.textContent).toBe('"key"');
  });

  it("renders line numbers by default and hides them when gutter=false", () => {
    const withGutter = render(<CodeView text={"a\nb"} lang="plain" />);
    expect(withGutter.container.querySelectorAll(".cv-ln").length).toBe(2);
    const flat = render(<CodeView text={"a\nb"} lang="plain" gutter={false} />);
    expect(flat.container.querySelectorAll(".cv-ln").length).toBe(0);
  });

  it("highlights markdown headings and fenced code state", () => {
    const md = "# Title\n```js\nconst a = 1;\n```\n- item";
    const { container } = render(<CodeView text={md} lang="markdown" />);
    // heading line → key; fence markers → com
    expect([...container.querySelectorAll(".tok-key")].some((e) => e.textContent?.startsWith("# "))).toBe(true);
    expect([...container.querySelectorAll(".tok-com")].some((e) => e.textContent?.includes("```"))).toBe(true);
  });

  it("focuses and highlights the line matching `find`", () => {
    const { container } = render(<CodeView text={"one\ntwo\nthree"} lang="plain" find="two" />);
    const on = container.querySelector(".cv-row.on");
    expect(on?.textContent).toContain("two");
  });

  it("carries block-comment state across lines", () => {
    const src = "code /* start\nstill comment\nend */ after";
    const { container } = render(<CodeView text={src} lang="rust" />);
    const coms = [...container.querySelectorAll(".tok-com")].map((e) => e.textContent);
    // the middle line is entirely inside the block comment
    expect(coms.some((t) => t === "still comment")).toBe(true);
  });

  it("renders a zero-width placeholder for empty lines", () => {
    const { container } = render(<CodeView text={"a\n\nb"} lang="plain" />);
    expect(container.querySelectorAll(".cv-row").length).toBe(3);
  });

  it("markdown: blockquote, hr, ordered list, inline link", () => {
    const md = "> quote\n\n---\n\n1. first\n\nsee [x](https://a.b)";
    const { container } = render(<CodeView text={md} lang="markdown" />);
    const coms = [...container.querySelectorAll(".tok-com")].map((e) => e.textContent);
    expect(coms.some((t) => t?.includes("> quote"))).toBe(true); // blockquote
    expect(coms.some((t) => t === "---")).toBe(true); // hr
    expect(container.querySelector(".tok-num")?.textContent).toBe("1."); // ordered marker
    expect([...container.querySelectorAll(".tok-prop")].some((e) => e.textContent?.includes("[x]"))).toBe(true); // link
  });
});
