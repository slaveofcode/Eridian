import { createElement, Fragment, type ReactNode } from "react";
import { CodeView, langForName } from "./CodeView";

// Minimal, dependency-free Markdown renderer for chat message bodies. Renders to
// React nodes (no HTML injection). Covers the common cases in agent transcripts:
// fenced code, headings, lists, blockquotes, and inline code/bold/italic/links.
export function Markdown({ text }: { text: string }) {
  return <div className="md">{parseBlocks(text)}</div>;
}

function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => key++;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(
        <div className="md-code" key={k()}>
          <CodeView text={body.join("\n")} lang={langForName(fence[1])} gutter={false} />
        </div>
      );
      continue;
    }

    // heading (shift down a couple levels: # → h3, so chrome stays dominant)
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const tag = `h${Math.min(heading[1].length + 2, 6)}`;
      out.push(createElement(tag, { className: "md-h", key: k() }, inlineNodes(heading[2])));
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push(
        <blockquote className="md-quote" key={k()}>
          {inlineNodes(body.join("\n"))}
        </blockquote>
      );
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      out.push(
        <ul className="md-list" key={k()}>
          {items.map((it, j) => (
            <li key={j}>{inlineNodes(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(
        <ol className="md-list" key={k()}>
          {items.map((it, j) => (
            <li key={j}>{inlineNodes(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph: consecutive plain lines (line breaks preserved via pre-wrap)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(
      <p className="md-p" key={k()}>
        {inlineNodes(para.join("\n"))}
      </p>
    );
  }
  return out;
}

// Inline: `code`, **bold**, *italic*, [text](url). No HTML injection.
function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] != null) {
      nodes.push(
        <code className="md-inline-code" key={key++}>
          {m[1]}
        </code>
      );
    } else if (m[2] != null) {
      nodes.push(<strong key={key++}>{m[2]}</strong>);
    } else if (m[3] != null) {
      nodes.push(<em key={key++}>{m[3]}</em>);
    } else if (m[4] != null) {
      nodes.push(
        <a href={m[5]} target="_blank" rel="noreferrer" key={key++}>
          {m[4]}
        </a>
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return nodes;
}
