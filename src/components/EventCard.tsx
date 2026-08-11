import { memo, useEffect, useState } from "react";
import type { EventRow } from "../lib/types";
import { api } from "../lib/api";
import { formatBody, formatClock, formatTokens, isStructured, isImagePath } from "../lib/format";
import { XmlView } from "./XmlView";
import { Markdown } from "./Markdown";
import { DiffView, editDiff } from "./DiffView";

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// A block never fully mounts just because "expand all" is on: render at most
// BLOCK_RENDER_CAP characters, reveal the rest only on explicit click. This is
// the memory backstop for a 100k+ token tool body.
const BLOCK_RENDER_CAP = 16000;

function CappedPre({ text, className = "code" }: { text: string; className?: string }) {
  const [full, setFull] = useState(false);
  if (full || text.length <= BLOCK_RENDER_CAP) {
    return <pre className={className}>{text}</pre>;
  }
  return (
    <>
      <pre className={className}>{text.slice(0, BLOCK_RENDER_CAP)}</pre>
      <button className="disclosure" onClick={() => setFull(true)}>
        show full block ({(text.length - BLOCK_RENDER_CAP).toLocaleString()} more chars)
      </button>
    </>
  );
}

// Pull "[Image: source: <path>]" references out of a message body (Claude Code
// records pasted images this way). Returns the text with those tokens removed
// plus the image paths to render inline.
function extractImageRefs(text: string | null): { clean: string; paths: string[] } {
  if (!text) return { clean: "", paths: [] };
  const paths: string[] = [];
  const clean = text
    .replace(/\[Image:\s*source:\s*([^\]]+?)\s*\]/gi, (m, p) => {
      const path = String(p).trim();
      if (isImagePath(path)) {
        paths.push(path);
        return "";
      }
      return m;
    })
    .trim();
  return { clean, paths };
}

// Inline image preview for a referenced path — loads a data URL, shows nothing
// intrusive if the file is gone. Click opens it full in the viewer.
function ImageInline({ path, onOpenFile }: { path: string; onOpenFile?: (p: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setErr(false);
    api
      .readImage(path)
      .then((d) => !cancelled && setSrc(d.dataUrl))
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div className="img-inline-block">
      {src ? (
        <img
          className="img-inline"
          src={src}
          alt={baseName(path)}
          title="click to open"
          onClick={() => onOpenFile?.(path)}
        />
      ) : err ? (
        <div className="img-inline-missing muted">🖼 image no longer on disk</div>
      ) : (
        <div className="img-inline-loading muted">loading image…</div>
      )}
      {/* always show the path so it's identifiable whether or not the file exists */}
      <code className="img-inline-path" title={path} onClick={() => src && onOpenFile?.(path)}>
        {path}
      </code>
    </div>
  );
}

// Pull the target file path out of a tool-call input (Edit/Write/Read/
// MultiEdit → file_path, NotebookEdit → notebook_path) so we can offer to
// open it in the built-in viewer.
function filePathOf(json?: string | null): string | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    const p = o?.file_path ?? o?.notebook_path ?? o?.path;
    return typeof p === "string" && p.trim() ? p : null;
  } catch {
    return null;
  }
}

// Per-kind timeline card. Thinking is collapsed by default; tool input/result
// are collapsible; assistant/user text renders inline.
// Memoized: the live timeline re-renders its parent on every merge (≤5/s); with
// stable row identities and a stable onOpenFile, existing cards must not re-do
// their markdown/XML/diff formatting work.
export const EventCard = memo(function EventCard({
  event,
  onOpenFile,
  defaultExpanded = false,
}: {
  event: EventRow;
  onOpenFile?: (path: string) => void;
  defaultExpanded?: boolean;
}) {
  switch (event.kind) {
    case "user":
      return <TextCard event={event} kindLabel="prompt" accentClass="k-user" onOpenFile={onOpenFile} />;
    case "assistant":
      return (
        <TextCard event={event} kindLabel="assistant" accentClass="k-assistant" onOpenFile={onOpenFile} />
      );
    case "thinking":
      return <ThinkingCard event={event} defaultExpanded={defaultExpanded} />;
    case "tool_call":
      return <ToolCallCard event={event} onOpenFile={onOpenFile} defaultExpanded={defaultExpanded} />;
    case "tool_result":
      return <ToolResultCard event={event} defaultExpanded={defaultExpanded} />;
    case "summary":
      return <TextCard event={event} kindLabel="summary" accentClass="k-summary" />;
    case "system":
      return <TextCard event={event} kindLabel="system" accentClass="k-system" />;
    case "meta":
      return <MetaRow event={event} />;
    default:
      return <UnknownCard event={event} defaultExpanded={defaultExpanded} />;
  }
});

function CardShell({
  event,
  kindLabel,
  accentClass,
  children,
}: {
  event: EventRow;
  kindLabel: string;
  accentClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`event-card ${accentClass}`}>
      <div className="event-head">
        <span className="event-kind">{kindLabel}</span>
        <span className="event-time">{formatClock(event.ts)}</span>
        <UsageBadge event={event} />
      </div>
      {children}
    </div>
  );
}

function UsageBadge({ event }: { event: EventRow }) {
  if (event.tokensIn == null && event.tokensOut == null) return null;
  return (
    <span className="usage">
      {event.tokensIn != null && <span title="input tokens">↓{formatTokens(event.tokensIn)}</span>}
      {event.tokensOut != null && <span title="output tokens">↑{formatTokens(event.tokensOut)}</span>}
    </span>
  );
}

function TextCard({
  event,
  kindLabel,
  accentClass,
  onOpenFile,
}: {
  event: EventRow;
  kindLabel: string;
  accentClass: string;
  onOpenFile?: (path: string) => void;
}) {
  const { clean, paths } = extractImageRefs(event.text);
  const isXml = !!clean && clean.trimStart().startsWith("<");
  const structured = isStructured(clean);
  const hasText = clean.length > 0;
  return (
    <CardShell event={event} kindLabel={kindLabel} accentClass={accentClass}>
      {isXml ? (
        <XmlView xml={clean} />
      ) : structured ? (
        <pre className="code">{formatBody(clean)}</pre>
      ) : hasText ? (
        <Markdown text={clean} />
      ) : paths.length === 0 ? (
        <div className="event-body">
          <em className="muted">(empty)</em>
        </div>
      ) : null}
      {paths.map((p, i) => (
        <ImageInline key={i} path={p} onOpenFile={onOpenFile} />
      ))}
    </CardShell>
  );
}

function ThinkingCard({
  event,
  defaultExpanded = false,
}: {
  event: EventRow;
  defaultExpanded?: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  return (
    <CardShell event={event} kindLabel="thinking" accentClass="k-thinking">
      <button className="disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} thinking
      </button>
      {open && <CappedPre text={event.text ?? ""} className="code dim" />}
    </CardShell>
  );
}

function ToolCallCard({
  event,
  onOpenFile,
  defaultExpanded = false,
}: {
  event: EventRow;
  onOpenFile?: (path: string) => void;
  defaultExpanded?: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  const diff = editDiff(event.toolName, event.toolInputJson);
  const filePath = filePathOf(event.toolInputJson);
  return (
    <CardShell event={event} kindLabel="tool call" accentClass="k-tool">
      <div className="tool-name-row">
        <span className="tool-name">{event.toolName ?? "tool"}</span>
        {filePath && onOpenFile && (
          <button
            className="file-open"
            onClick={() => onOpenFile(filePath)}
            title={`Open ${filePath}`}
          >
            ⤢ open file
          </button>
        )}
      </div>
      {/* Edit/MultiEdit → show a review-style diff, expanded by default. */}
      {diff ? (
        <DiffView text={diff} />
      ) : (
        event.toolInputJson && (
          <>
            <button className="disclosure" onClick={() => setOpen((v) => !v)}>
              {open ? "▾" : "▸"} input
            </button>
            {open && <CappedPre text={formatBody(event.toolInputJson)} />}
          </>
        )
      )}
    </CardShell>
  );
}

function ToolResultCard({
  event,
  defaultExpanded = false,
}: {
  event: EventRow;
  defaultExpanded?: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  return (
    <CardShell event={event} kindLabel="tool result" accentClass="k-tool">
      <button className="disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} result
      </button>
      {open && <CappedPre text={formatBody(event.toolResultJson)} />}
    </CardShell>
  );
}

// Compact single-line row for agent control/metadata (hidden by default).
function MetaRow({ event }: { event: EventRow }) {
  return (
    <div className="meta-row">
      <span className="event-time">{formatClock(event.ts)}</span>
      <span className="meta-text">{event.text ?? "meta"}</span>
    </div>
  );
}

function UnknownCard({
  event,
  defaultExpanded = false,
}: {
  event: EventRow;
  defaultExpanded?: boolean;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  return (
    <CardShell event={event} kindLabel="unknown" accentClass="k-unknown">
      <button className="disclosure" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} raw
      </button>
      {open && <CappedPre text={event.text ?? "(no parsed body — see raw in DB)"} />}
    </CardShell>
  );
}
