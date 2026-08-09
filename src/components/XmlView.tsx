import { useMemo, useState } from "react";
import { formatBody, unescapeInline } from "../lib/format";

// Renders an XML message body (e.g. claude-mem <observation>) as a collapsible
// field tree. Falls back to pretty-printed text if it doesn't parse as XML.
export function XmlView({ xml }: { xml: string }) {
  const root = useMemo(() => {
    try {
      const doc = new DOMParser().parseFromString(xml.trim(), "application/xml");
      if (doc.querySelector("parsererror")) return null;
      return doc.documentElement;
    } catch {
      return null;
    }
  }, [xml]);

  if (!root) return <pre className="code">{formatBody(xml)}</pre>;
  return (
    <div className="xml-tree">
      <XmlNode el={root} depth={0} />
    </div>
  );
}

function XmlNode({ el, depth }: { el: Element; depth: number }) {
  const children = Array.from(el.children);
  const [open, setOpen] = useState(depth < 4);
  const name = el.tagName;

  if (children.length === 0) {
    const { pre, text } = renderLeaf(el.textContent ?? "");
    if (!text) return null;
    return (
      <div className="xml-leaf">
        <span className="xml-key">{name}</span>
        {pre ? <pre className="code xml-pre">{text}</pre> : <span className="xml-val">{text}</span>}
      </div>
    );
  }

  return (
    <div className="xml-node">
      <button className="xml-head" onClick={() => setOpen((v) => !v)}>
        <span className="disclosure-caret">{open ? "▾" : "▸"}</span>
        <span className="xml-key">{name}</span>
        {!open && <span className="xml-count muted">{children.length}</span>}
      </button>
      {open && (
        <div className="xml-children">
          {children.map((c, i) => (
            <XmlNode key={i} el={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// A leaf value: unescape, and pretty-print embedded JSON (often the case for
// <parameters> that hold an escaped JSON string).
function renderLeaf(raw: string): { pre: boolean; text: string } {
  const un = unescapeInline(raw).trim();
  const inner = un.replace(/^"|"$/g, "");
  if (inner.startsWith("{") || inner.startsWith("[")) {
    try {
      return { pre: true, text: JSON.stringify(JSON.parse(inner), null, 2) };
    } catch {
      /* not valid JSON — fall through */
    }
  }
  return { pre: un.includes("\n"), text: un };
}
