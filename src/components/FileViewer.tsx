import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { FileContent, FileCommit, ImageData } from "../lib/types";
import { relativeTime, isImagePath } from "../lib/format";
import { Markdown } from "./Markdown";
import { CodeView, langForPath, langLabel } from "./CodeView";

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function formatBytes(n: number): string {
  if (n < 0) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function FileError({ path, error, onClose }: { path: string; error: string; onClose: () => void }) {
  const gone = /No such file|not found|os error 2/i.test(error);
  const worktree = /\/\.worktrees\/|\/worktrees\/|\/scratchpad\/|\/tmp\//.test(path);
  return (
    <div className="fv-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="fv-empty-icon" aria-hidden>
        <path
          d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M14 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <line x1="8.5" y1="15.5" x2="15.5" y2="15.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5" />
      </svg>
      <h3 className="fv-empty-title">{gone ? "File no longer exists" : "Couldn’t open this file"}</h3>
      <p className="fv-empty-msg">
        {gone && worktree ? (
          <>
            This file lived in a temporary <strong>git worktree</strong> or scratchpad the
            agent used and then removed. Eridian archived the change, but the file itself is
            gone from disk — the diff above is still available in the timeline.
          </>
        ) : gone ? (
          <>The file has been moved or deleted since the agent touched it. Eridian keeps the
          recorded change, but can’t show the current file.</>
        ) : (
          <>Eridian couldn’t read this file.</>
        )}
      </p>
      <code className="fv-empty-path">{path}</code>
      <details className="fv-empty-detail">
        <summary>error detail</summary>
        <code>{error}</code>
      </details>
      <button className="crumb-back fv-empty-back" onClick={onClose}>
        ← back to changes
      </button>
    </div>
  );
}

// Built-in full-file inspector — opens over the app with a back button so you
// can read a whole changed file / skill / config and return to keep reviewing.
// `find` scrolls to and highlights the first line containing that text
// (e.g. jumping straight to an MCP server's block in a config file).
export function FileViewer({
  path,
  find,
  onClose,
}: {
  path: string;
  find?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<FileContent | null>(null);
  const [image, setImage] = useState<ImageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Time machine: git commit history for this file + the selected version
  // (null = current on-disk).
  const [history, setHistory] = useState<FileCommit[]>([]);
  const [version, setVersion] = useState<FileCommit | null>(null);
  const [histOpen, setHistOpen] = useState(false);
  const isImage = isImagePath(path);

  // Fetch git history when the path changes (best-effort; empty hides the UI).
  // Images render current-on-disk only — skip history.
  useEffect(() => {
    setVersion(null);
    setHistOpen(false);
    if (isImage) {
      setHistory([]);
      return;
    }
    api.fileHistory(path).then(setHistory).catch(() => setHistory([]));
  }, [path, isImage]);

  // Load content: image → data URL; else text (current version or a commit).
  useEffect(() => {
    setData(null);
    setImage(null);
    setError(null);
    if (isImage) {
      api.readImage(path).then(setImage).catch((e) => setError(String(e)));
      return;
    }
    const load = version ? api.fileAtCommit(path, version.sha) : api.readFile(path);
    load.then(setData).catch((e) => setError(String(e)));
  }, [path, version, isImage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isMd = path.toLowerCase().endsWith(".md");
  const lang = langForPath(path);
  // Markdown defaults to source (line numbers + highlight); toggle to rendered.
  const [mdRendered, setMdRendered] = useState(false);
  const showRendered = isMd && mdRendered;
  const [copied, setCopied] = useState(false);
  const copyPath = () => {
    navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="file-viewer">
      <header className="file-viewer-head">
        <button className="crumb-up" onClick={onClose} title="Back (Esc)">
          ←
        </button>
        <span className="fv-name">{baseName(path)}</span>
        <span className="fv-path muted" title={path}>
          {path}
        </span>
        <button className="fv-copy" onClick={copyPath} title="Copy file path">
          {copied ? "copied ✓" : "⧉ path"}
        </button>
        {history.length > 0 && (
          <div className="fv-history">
            <button
              className={`fv-toggle-btn${!version ? " on" : ""}`}
              onClick={() => setVersion(null)}
              title="Current version on disk"
            >
              current
            </button>
            <div className="fv-hist-wrap">
              <button
                className={`fv-toggle-btn${version ? " on" : ""}`}
                onClick={() => setHistOpen((o) => !o)}
                title="View this file at a past commit"
              >
                {version ? `@${version.shortSha}` : "history"} ▾
              </button>
              {histOpen && (
                <div className="fv-hist-menu" role="menu">
                  {history.map((c) => (
                    <button
                      key={c.sha}
                      className={`fv-hist-item${version?.sha === c.sha ? " on" : ""}`}
                      onClick={() => {
                        setVersion(c);
                        setHistOpen(false);
                      }}
                      title={`${c.sha}\n${c.author} · ${c.date}`}
                    >
                      <span className="fv-hist-sha num">{c.shortSha}</span>
                      <span className="fv-hist-subj">{c.subject}</span>
                      <span className="fv-hist-date muted num">{relativeTime(c.date)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {data && isMd && (
          <div className="fv-toggle" role="group" aria-label="Markdown view">
            <button
              className={`fv-toggle-btn${!mdRendered ? " on" : ""}`}
              onClick={() => setMdRendered(false)}
            >
              source
            </button>
            <button
              className={`fv-toggle-btn${mdRendered ? " on" : ""}`}
              onClick={() => setMdRendered(true)}
            >
              rendered
            </button>
          </div>
        )}
        {isImage && <span className="fv-lang">Image</span>}
        {data && !showRendered && !isImage && <span className="fv-lang">{langLabel(lang)}</span>}
        {(data || image) && (
          <span className="fv-meta muted num">
            {formatBytes((data ?? image!).sizeBytes)}
            {data?.truncated ? " · truncated" : ""}
          </span>
        )}
      </header>
      <div className={`file-viewer-body${data && !showRendered ? " fv-code-body" : ""}`}>
        {error && <FileError path={path} error={error} onClose={onClose} />}
        {!data && !image && !error && <p className="muted pad">Loading…</p>}
        {image && (
          <div className="fv-image-wrap">
            <img className="fv-image" src={image.dataUrl} alt={baseName(path)} />
          </div>
        )}
        {data &&
          (showRendered ? (
            <div className="fv-md">
              <Markdown text={data.content} />
            </div>
          ) : (
            <CodeView text={data.content} lang={lang} find={find} />
          ))}
      </div>
    </div>
  );
}
