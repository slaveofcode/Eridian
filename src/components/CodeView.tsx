import { createElement, useEffect, useMemo, useRef } from "react";

// Zero-dependency syntax highlighter + line-numbered editor view.
// Deliberately dependency-free (project guardrail: no new deps) — a small
// per-line scanner covers the languages we actually surface (JS/TS, Rust,
// Python, Go, JSON, shell, CSS, TOML/YAML) well enough for read-only review.

type LangKey =
  | "js"
  | "rust"
  | "python"
  | "go"
  | "json"
  | "css"
  | "shell"
  | "toml"
  | "yaml"
  | "markdown"
  | "plain";

interface LangCfg {
  line: string[]; // line-comment markers
  block: [string, string] | null; // block-comment delimiters
  quotes: string[]; // string delimiters
  keywords: Set<string>;
  props: boolean; // detect "key": (JSON / object literals / yaml)
}

const KW = (s: string) => new Set(s.split(/\s+/));

const JS_KW = KW(
  "const let var function return if else for while do switch case break continue new class extends super this import export from default async await yield try catch finally throw typeof instanceof in of void delete null undefined true false as type interface enum implements public private protected readonly static get set namespace declare abstract",
);
const RUST_KW = KW(
  "fn let mut const static struct enum trait impl for while loop if else match return pub use mod crate self super as where ref move box dyn async await unsafe extern type in continue break Some None Ok Err Result Option Vec String true false",
);
const PY_KW = KW(
  "def class return if elif else for while import from as pass break continue with try except finally raise lambda yield global nonlocal in is not and or None True False async await del assert",
);
const GO_KW = KW(
  "func package import var const type struct interface map chan go defer return if else for range switch case default break continue select nil true false make new len cap append string int bool error",
);

const CFG: Record<LangKey, LangCfg> = {
  js: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: JS_KW, props: true },
  rust: { line: ["//"], block: ["/*", "*/"], quotes: ['"'], keywords: RUST_KW, props: false },
  python: { line: ["#"], block: null, quotes: ['"', "'"], keywords: PY_KW, props: false },
  go: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "`"], keywords: GO_KW, props: false },
  json: { line: [], block: null, quotes: ['"'], keywords: KW("true false null"), props: true },
  css: { line: [], block: ["/*", "*/"], quotes: ['"', "'"], keywords: new Set(), props: false },
  shell: { line: ["#"], block: null, quotes: ['"', "'"], keywords: KW("if then else elif fi for while do done case esac function return export local echo cd exit"), props: false },
  toml: { line: ["#"], block: null, quotes: ['"', "'"], keywords: KW("true false"), props: true },
  yaml: { line: ["#"], block: null, quotes: ['"', "'"], keywords: KW("true false null yes no"), props: true },
  markdown: { line: [], block: null, quotes: [], keywords: new Set(), props: false },
  plain: { line: [], block: null, quotes: [], keywords: new Set(), props: false },
};

export function langForPath(path: string): LangKey {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      return "plain";
  }
}

// Map a fenced-code-block language hint (```typescript, ```bash, …) to a LangKey.
export function langForName(hint: string): LangKey {
  switch (hint.trim().toLowerCase()) {
    case "ts":
    case "tsx":
    case "typescript":
    case "js":
    case "jsx":
    case "javascript":
    case "mjs":
    case "cjs":
    case "node":
      return "js";
    case "rs":
    case "rust":
      return "rust";
    case "py":
    case "python":
      return "python";
    case "go":
    case "golang":
      return "go";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
    case "console":
      return "shell";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    default:
      return "plain";
  }
}

export function langLabel(lang: LangKey): string {
  const m: Record<LangKey, string> = {
    js: "TS / JS",
    rust: "Rust",
    python: "Python",
    go: "Go",
    json: "JSON",
    css: "CSS",
    shell: "Shell",
    toml: "TOML",
    yaml: "YAML",
    markdown: "Markdown",
    plain: "Text",
  };
  return m[lang];
}

type Tok = { t: string; c?: string }; // c = token class suffix (str/com/key/num/prop)

const isIdentStart = (ch: string) => /[A-Za-z_$]/.test(ch);
const isIdent = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
const isDigit = (ch: string) => ch >= "0" && ch <= "9";

// Tokenize a single line. `state.block` carries multi-line block-comment state.
function tokenizeLine(line: string, cfg: LangCfg, state: { block: boolean }): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      toks.push({ t: plain });
      plain = "";
    }
  };

  if (state.block && cfg.block) {
    const end = line.indexOf(cfg.block[1]);
    if (end === -1) {
      toks.push({ t: line, c: "com" });
      return toks;
    }
    toks.push({ t: line.slice(0, end + cfg.block[1].length), c: "com" });
    i = end + cfg.block[1].length;
    state.block = false;
  }

  while (i < line.length) {
    const ch = line[i];

    // line comment
    let lc: string | null = null;
    for (const m of cfg.line) if (line.startsWith(m, i)) { lc = m; break; }
    if (lc) {
      flush();
      toks.push({ t: line.slice(i), c: "com" });
      break;
    }

    // block comment
    if (cfg.block && line.startsWith(cfg.block[0], i)) {
      flush();
      const end = line.indexOf(cfg.block[1], i + cfg.block[0].length);
      if (end === -1) {
        toks.push({ t: line.slice(i), c: "com" });
        state.block = true;
        break;
      }
      toks.push({ t: line.slice(i, end + cfg.block[1].length), c: "com" });
      i = end + cfg.block[1].length;
      continue;
    }

    // string
    if (cfg.quotes.includes(ch)) {
      flush();
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === ch) { j++; break; }
        j++;
      }
      const str = line.slice(i, j);
      // property key: string immediately followed by ':'
      let isProp = false;
      if (cfg.props) {
        let k = j;
        while (k < line.length && (line[k] === " " || line[k] === "\t")) k++;
        if (line[k] === ":") isProp = true;
      }
      toks.push({ t: str, c: isProp ? "prop" : "str" });
      i = j;
      continue;
    }

    // number
    if (isDigit(ch) || (ch === "." && isDigit(line[i + 1] ?? ""))) {
      flush();
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j])) j++;
      toks.push({ t: line.slice(i, j), c: "num" });
      i = j;
      continue;
    }

    // identifier / keyword
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < line.length && isIdent(line[j])) j++;
      const word = line.slice(i, j);
      if (cfg.keywords.has(word)) {
        flush();
        toks.push({ t: word, c: "key" });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return toks;
}

// Markdown gets its own line-oriented scanner (headings, fences, quotes, list
// markers, inline code and links) — the code tokenizer doesn't fit prose.
function tokenizeMarkdownLine(line: string, state: { fence: boolean }): Tok[] {
  if (/^\s*(```|~~~)/.test(line)) {
    state.fence = !state.fence;
    return [{ t: line, c: "com" }];
  }
  if (state.fence) return [{ t: line, c: "str" }]; // fenced code body
  if (/^#{1,6}\s/.test(line)) return [{ t: line, c: "key" }]; // heading
  if (/^\s*>/.test(line)) return [{ t: line, c: "com" }]; // blockquote
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [{ t: line, c: "com" }]; // hr

  const toks: Tok[] = [];
  let i = 0;
  const lm = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/); // list marker
  if (lm) {
    if (lm[1]) toks.push({ t: lm[1] });
    toks.push({ t: lm[2], c: "num" });
    toks.push({ t: lm[3] });
    i = lm[0].length;
  }
  let plain = "";
  const flush = () => {
    if (plain) {
      toks.push({ t: plain });
      plain = "";
    }
  };
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        toks.push({ t: line.slice(i, end + 1), c: "str" });
        i = end + 1;
        continue;
      }
    }
    if (line[i] === "[") {
      const m = /^\[[^\]]*\]\([^)\s]+\)/.exec(line.slice(i));
      if (m) {
        flush();
        toks.push({ t: m[0], c: "prop" });
        i += m[0].length;
        continue;
      }
    }
    plain += line[i];
    i++;
  }
  flush();
  return toks;
}

const MAX_HL_LINES = 4000; // above this, skip highlighting to stay responsive

export function CodeView({
  text,
  lang,
  find,
  gutter = true,
}: {
  text: string;
  lang: LangKey;
  find?: string;
  gutter?: boolean;
}) {
  const lines = useMemo(() => text.split("\n"), [text]);

  // Line to focus: first line containing `find` (used by MCP jump-to-server).
  const focusLine = useMemo(() => {
    if (!find) return -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(find)) return i;
    return -1;
  }, [lines, find]);

  const rows = useMemo(() => {
    const cfg = CFG[lang];
    const highlight = lines.length <= MAX_HL_LINES && lang !== "plain";
    if (lang === "markdown") {
      const st = { fence: false };
      return lines.map((ln) => (highlight ? tokenizeMarkdownLine(ln, st) : [{ t: ln } as Tok]));
    }
    const state = { block: false };
    return lines.map((ln) => (highlight ? tokenizeLine(ln, cfg, state) : [{ t: ln } as Tok]));
  }, [lines, lang]);

  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusLine >= 0 && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center" });
    }
  }, [focusLine]);

  const gutterW = String(lines.length).length;

  return (
    <div
      className={`cv${gutter ? "" : " cv-flat"}`}
      style={{ ["--cv-gutter" as string]: `${gutterW + 1}ch` }}
    >
      {rows.map((toks, i) =>
        createElement(
          "div",
          {
            key: i,
            className: `cv-row${i === focusLine ? " on" : ""}`,
            ref: i === focusLine ? focusRef : undefined,
          },
          gutter ? createElement("span", { className: "cv-ln", "aria-hidden": true }, i + 1) : null,
          createElement(
            "code",
            { className: "cv-line" },
            toks.length === 0
              ? "​"
              : toks.map((tk, j) =>
                  tk.c ? createElement("span", { key: j, className: `tok-${tk.c}` }, tk.t) : tk.t,
                ),
          ),
        ),
      )}
    </div>
  );
}
