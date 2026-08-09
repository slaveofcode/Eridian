import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type {
  ActivityBucket,
  CommandRow,
  FileChangeRow,
  Risk,
  SessionChanges,
  SessionRow,
  SubagentLink,
  SkillRun,
} from "../lib/types";
import { AGENT_ACCENT } from "../lib/types";
import { formatClock, relativeTime } from "../lib/format";
import { DiffView } from "./DiffView";
import { CodeView, langForPath } from "./CodeView";

const RISK_ICON: Record<Risk, string> = { danger: "▲", notable: "◆", safe: "•" };
const PAGE = 80; // rows rendered per "show more" step
type ChgTab = "subagents" | "commands" | "files";

function RiskBadge({ risk, label }: { risk: Risk; label?: string }) {
  return (
    <span className={`risk risk-${risk}`}>
      <span aria-hidden>{RISK_ICON[risk]}</span> {label ?? risk}
    </span>
  );
}

export function ChangesTab({
  session,
  onSelectSession,
  onOpenFile,
}: {
  session: SessionRow;
  onSelectSession: (id: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [subagents, setSubagents] = useState<SubagentLink[]>([]);
  const [activity, setActivity] = useState<ActivityBucket[]>([]);
  const [skills, setSkills] = useState<SkillRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [riskFilter, setRiskFilter] = useState<Risk | null>(null);
  // Which sub-tab is shown (Subagents / Commands / Files). null → use default.
  const [subtab, setSubtab] = useState<ChgTab | null>(null);
  const [heuristicOpen, setHeuristicOpen] = useState(false);
  // Render caps — huge sessions (50k+ events) return thousands of commands/
  // files; rendering them all at once freezes the main thread. Show a page at a
  // time. Reset when the session or active filter changes.
  const [cmdLimit, setCmdLimit] = useState(PAGE);
  const [fileLimit, setFileLimit] = useState(PAGE);
  useEffect(() => {
    setCmdLimit(PAGE);
    setFileLimit(PAGE);
  }, [session.id, riskFilter]);

  useEffect(() => {
    let cancelled = false;
    // Clear immediately so switching sessions shows the loader, not stale data.
    setChanges(null);
    setSubagents([]);
    setActivity([]);
    setSkills([]);
    setRiskFilter(null);
    setSubtab(null);
    setLoading(true);
    Promise.all([
      api.sessionChanges(session.id),
      api.sessionSubagents(session.id),
      api.sessionActivity(session.id),
      api.sessionSkills(session.id),
    ])
      .then(([c, s, a, sk]) => {
        if (cancelled) return;
        setChanges(c);
        setSubagents(s);
        setActivity(a);
        setSkills(sk);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // Snapshot on open/session-change — no heavy auto-refresh (it froze large
    // sessions). Reselect or toggle tabs to refresh.
  }, [session.id]);

  if (loading) {
    return (
      <div className="changes-scroll">
        <div className="skeletons" aria-hidden>
          {[40, 44, 120, 80, 200].map((h, i) => (
            <div key={i} className="skeleton" style={{ height: h }} />
          ))}
        </div>
      </div>
    );
  }
  const c = changes ?? {
    files: [],
    commands: [],
    risk: { danger: 0, notable: 0, safe: 0 },
    filesTotal: 0,
    commandsTotal: 0,
  };
  const nothing =
    c.files.length === 0 && c.commands.length === 0 && subagents.length === 0;

  const commands = riskFilter ? c.commands.filter((x) => x.risk === riskFilter) : c.commands;
  const files = riskFilter ? c.files.filter((x) => x.risk === riskFilter) : c.files;
  const toggle = (r: Risk) => setRiskFilter((cur) => (cur === r ? null : r));

  // Available sub-tabs (only those with content). Default: subagents → files →
  // commands. `active` falls back to the default when the chosen tab is empty.
  const avail: ChgTab[] = [];
  if (subagents.length > 0) avail.push("subagents");
  if (c.commands.length > 0) avail.push("commands");
  if (c.files.length > 0) avail.push("files");
  const defaultTab: ChgTab = subagents.length
    ? "subagents"
    : c.files.length
      ? "files"
      : "commands";
  const active: ChgTab = subtab && avail.includes(subtab) ? subtab : defaultTab;
  // Risk filter only applies to commands/files, not subagents.
  const filterable = active !== "subagents";

  return (
    <div className="changes-scroll">
      {/* risk FILTERS — apply to the commands/files tabs */}
      <section className="chg-filters">
        <span className="chg-menu-label">filter</span>
        <RiskChip risk="danger" n={c.risk.danger} active={riskFilter === "danger"} onClick={() => toggle("danger")} />
        <RiskChip risk="notable" n={c.risk.notable} active={riskFilter === "notable"} onClick={() => toggle("notable")} />
        <RiskChip risk="safe" n={c.risk.safe} active={riskFilter === "safe"} onClick={() => toggle("safe")} />
        {riskFilter && (
          <button className="risk-clear" onClick={() => setRiskFilter(null)}>
            clear filter
          </button>
        )}
        <span className="heuristic-wrap">
          <button
            className="heuristic heuristic-btn"
            onClick={() => setHeuristicOpen((v) => !v)}
            aria-expanded={heuristicOpen}
            title="How are these risk tags decided?"
          >
            heuristic ⓘ
          </button>
          {heuristicOpen && <HeuristicInfo onClose={() => setHeuristicOpen(false)} />}
        </span>
      </section>

      {activity.length > 1 && <ActivityGraph buckets={activity} />}

      {skills.length > 0 && <SkillsRun runs={skills} />}

      {nothing ? (
        <p className="muted pad">No file changes, commands, or subagents recorded for this session.</p>
      ) : (
        <>
          {/* sub-tab bar */}
          <div className="chg-subtabs" role="tablist">
            {avail.includes("subagents") && (
              <SubTab label="Subagents" n={subagents.length} on={active === "subagents"} onClick={() => setSubtab("subagents")} />
            )}
            {avail.includes("commands") && (
              <SubTab label="Commands" n={c.commandsTotal} on={active === "commands"} onClick={() => setSubtab("commands")} />
            )}
            {avail.includes("files") && (
              <SubTab label="Files changed" n={c.filesTotal} on={active === "files"} onClick={() => setSubtab("files")} />
            )}
          </div>

          {active === "subagents" && (
            <section className="chg-group">
              <p className="heuristic-line muted">
                child agents spawned by this session (linked via transcript) · activity clipped to its window
              </p>
              <SubagentGraph parent={session} subagents={subagents} onSelect={onSelectSession} />
            </section>
          )}

          {active === "commands" && (
            <section className="chg-group">
              {commands.slice(0, cmdLimit).map((cmd, i) => (
                <CommandItem key={i} cmd={cmd} />
              ))}
              <ShowMore total={commands.length} shown={cmdLimit} onMore={() => setCmdLimit((l) => l + PAGE * 3)} />
              {commands.length === 0 && filterable && <p className="muted pad">No {riskFilter} commands.</p>}
            </section>
          )}

          {active === "files" && (
            <section className="chg-group">
              <FileHeat files={files} />
              {files.slice(0, fileLimit).map((f) => (
                <FileRow key={f.path} file={f} onOpenFile={onOpenFile} />
              ))}
              <ShowMore total={files.length} shown={fileLimit} onMore={() => setFileLimit((l) => l + PAGE * 3)} />
              {!riskFilter && c.filesTotal > c.files.length && fileLimit >= files.length && (
                <p className="muted pad">
                  {c.filesTotal - c.files.length} more files not loaded — highest-risk kept, session
                  capped for performance.
                </p>
              )}
              {files.length === 0 && filterable && <p className="muted pad">No {riskFilter} files.</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// Skills (Skill tool — reliable) and slash-commands (heuristic tag) run in this
// session, as a compact chip strip.
function SkillsRun({ runs }: { runs: SkillRun[] }) {
  const skills = runs.filter((r) => r.kind === "skill");
  const commands = runs.filter((r) => r.kind === "command");
  return (
    <section className="skills-run">
      <span className="chg-menu-label">ran</span>
      {skills.map((r) => (
        <span key={`s:${r.name}`} className="run-chip run-skill" title={`Skill "${r.name}" · ${r.count}×`}>
          ⚡ {r.name}
          {r.count > 1 && <span className="num run-n">{r.count}</span>}
        </span>
      ))}
      {commands.map((r) => (
        <span
          key={`c:${r.name}`}
          className="run-chip run-command"
          title={`Slash command /${r.name} (heuristic — from <command-name> tag)`}
        >
          /{r.name}
          {r.count > 1 && <span className="num run-n">{r.count}</span>}
        </span>
      ))}
    </section>
  );
}

// Explains what the "heuristic" risk tags actually key on (see inspect.rs).
function HeuristicInfo({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="heuristic-pop-backdrop" onClick={onClose} />
      <div className="heuristic-pop" role="dialog">
        <p>
          Risk tags are a <strong>rule-based triage aid</strong>, not a security verdict —
          they match tool names and command substrings, with no understanding of intent.
          Verify before trusting.
        </p>
        <div className="hp-row">
          <span className="risk risk-danger">▲ danger</span>
          <span>
            <code>rm -rf</code>, <code>git push --force</code>, <code>git reset --hard</code>,{" "}
            <code>sudo</code>, <code>chmod</code>/<code>chown</code>, <code>mkfs</code>,{" "}
            <code>dd</code>, <code>drop table/database</code>, <code>truncate</code>, fork bomb,
            or <code>curl|wget … | sh</code>.
          </span>
        </div>
        <div className="hp-row">
          <span className="risk risk-notable">◆ notable</span>
          <span>
            any <strong>write/edit</strong>; <code>git commit/push/checkout/rebase/merge</code>;{" "}
            <code>*install</code> (npm/pnpm/yarn/cargo/pip/brew); <code>docker</code>,{" "}
            <code>kubectl</code>, <code>curl</code>/<code>wget</code>.
          </span>
        </div>
        <div className="hp-row">
          <span className="risk risk-safe">• safe</span>
          <span>
            read-only tools (<code>read/grep/glob/ls</code>, web fetch/search) and everything
            else.
          </span>
        </div>
        <p className="muted">
          e.g. <code>echo "rm -rf …"</code> would falsely read as danger — treat it as a
          "look here first" hint.
        </p>
      </div>
    </>
  );
}

// One sub-tab button in the Changes tab bar.
function SubTab({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button className={`chg-subtab${on ? " on" : ""}`} role="tab" aria-selected={on} onClick={onClick}>
      {label} <span className="num chg-subtab-n">{n}</span>
    </button>
  );
}

// "Showing N of M — show more" footer for capped lists.
function ShowMore({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (total <= shown) return null;
  const remaining = total - shown;
  return (
    <button className="chg-show-more" onClick={onMore}>
      show {Math.min(remaining, PAGE * 3)} more <span className="muted">· {remaining} hidden</span>
    </button>
  );
}

function RiskChip({
  risk,
  n,
  active,
  onClick,
}: {
  risk: Risk;
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`risk-chip risk-${risk}${active ? " active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      title={`Filter to ${risk} items`}
    >
      <span aria-hidden>{RISK_ICON[risk]}</span>
      <span className="num">{n}</span> {risk}
    </button>
  );
}

// Commands can be long one-liners — collapsed to one line, click to wrap/expand.
function CommandItem({ cmd }: { cmd: CommandRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`cmd-row${open ? " open" : ""}`}
      onClick={() => setOpen((v) => !v)}
      title={open ? "click to collapse" : "click to expand"}
    >
      <RiskBadge risk={cmd.risk} label={cmd.reason} />
      <code className="cmd-text">{cmd.command}</code>
      <span className="cmd-time num">{formatClock(cmd.ts)}</span>
    </div>
  );
}

// Ranked "hot files" bars by total touches — a readable file-touch map.
function FileHeat({ files }: { files: FileChangeRow[] }) {
  const ranked = useMemo(() => {
    const withTotal = files.map((f) => ({ f, total: f.writes + f.edits + f.reads }));
    withTotal.sort((a, b) => b.total - a.total);
    return withTotal.slice(0, 8);
  }, [files]);
  const max = ranked[0]?.total ?? 1;
  if (ranked.length < 2) return null;
  return (
    <div className="file-heat">
      {ranked.map(({ f, total }) => (
        <div key={f.path} className="heat-row" title={f.path}>
          <span className="heat-label">{baseName(f.path)}</span>
          <span className="heat-bar-wrap">
            <span className={`heat-bar risk-bg-${f.risk}`} style={{ width: `${(total / max) * 100}%` }} />
          </span>
          <span className="heat-n num">{total}</span>
        </div>
      ))}
    </div>
  );
}

function FileRow({
  file,
  onOpenFile,
}: {
  file: FileChangeRow;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ops = [
    file.writes > 0 ? `${file.writes}w` : "",
    file.edits > 0 ? `${file.edits}e` : "",
    file.reads > 0 ? `${file.reads}r` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="file-row">
      <div className="file-head-row">
        <button className="file-head" onClick={() => setOpen((v) => !v)}>
          <span className="disclosure-caret">{open ? "▾" : "▸"}</span>
          <RiskBadge risk={file.risk} label="" />
          <span className="file-path" title={file.path}>
            <span className="file-dir">{fileDir(file.path)}</span>
            <span className="file-name">{fileBase(file.path)}</span>
          </span>
          <span className="file-ops num">{ops}</span>
          <span className="file-time num">{relativeTime(file.lastTs)}</span>
        </button>
        <button
          className="file-open"
          title="Open full file in Eridian"
          onClick={() => onOpenFile(file.path)}
        >
          ⤢ open
        </button>
      </div>
      {open &&
        file.changes.map((ch, i) => (
          <div key={i} className="file-change">
            <div className="file-change-head muted">
              <span className="op-badge">{ch.op}</span>
              <span className="num">{formatClock(ch.ts)}</span>
            </div>
            {ch.preview &&
              (ch.op === "write" ? (
                // Full new content → syntax-highlight it (edits stay as diffs).
                <div className="file-change-code">
                  <CodeView text={ch.preview} lang={langForPath(file.path)} gutter={false} />
                </div>
              ) : (
                <DiffView text={ch.preview} />
              ))}
          </div>
        ))}
    </div>
  );
}

// Temporal flow of a session and its subagents on the PARENT's time axis. Each
// subagent bar is its activity clipped to the parent window, so you can see when
// each ran and how they overlap. Bars are clickable.
function SubagentGraph({
  parent,
  subagents,
  onSelect,
}: {
  parent: SessionRow;
  subagents: SubagentLink[];
  onSelect: (id: string) => void;
}) {
  // Axis = parent window (fall back to any subagent activity if unset).
  const stamps = [
    parent.startedAt,
    parent.updatedAt,
    ...subagents.flatMap((s) => [s.windowStart, s.windowEnd]),
  ]
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t));
  const min = stamps.length ? Math.min(...stamps) : 0;
  const max = stamps.length ? Math.max(...stamps) : 1;
  const span = Math.max(1, max - min);
  const bar = (start: string | null, end: string | null) => {
    const a = start ? Date.parse(start) : min;
    const b = end ? Date.parse(end) : max;
    const lo = Math.max(a, min);
    const hi = Math.min(b, max);
    return { left: ((lo - min) / span) * 100, width: Math.max(2, ((hi - lo) / span) * 100) };
  };

  const parentBar = bar(parent.startedAt, parent.updatedAt);
  return (
    <div>
      <div className="sa-axis muted">
        <span>{formatClock(parent.startedAt)}</span>
        <span>session window</span>
        <span>{formatClock(parent.updatedAt)}</span>
      </div>
      <div className="sa-graph">
        <div className="sa-lane" title={parent.title ?? parent.id}>
          <span className="sa-label parent">● this session</span>
          <div className="sa-track">
            <button
              className="sa-bar parent"
              style={{ left: `${parentBar.left}%`, width: `${parentBar.width}%`, background: AGENT_ACCENT[parent.agent] }}
              disabled
              aria-label="parent session"
            />
          </div>
          <span className="sa-meta num muted">{parent.eventCount} ev</span>
        </div>
        {subagents.map((s) => {
          const { left, width } = bar(s.windowStart, s.windowEnd);
          return (
            <div key={s.id} className="sa-lane" title={s.title ?? s.id}>
              <span className="sa-label">↳ {(s.title ?? s.id).slice(0, 44)}</span>
              <div className="sa-track">
                <button
                  className={`sa-bar${s.live ? " live" : ""}`}
                  style={{ left: `${left}%`, width: `${width}%`, background: AGENT_ACCENT[s.agent] }}
                  onClick={() => onSelect(s.id)}
                  aria-label={`open subagent ${s.title ?? s.id}`}
                  title={`${s.eventsInWindow} events in this window · ${s.eventCount} total`}
                />
              </div>
              <span className="sa-meta num muted">{s.eventsInWindow} ev</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActivityGraph({ buckets }: { buckets: ActivityBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.total), 1);
  const W = 100;
  const H = 32;
  const bw = W / buckets.length;
  return (
    <section className="activity">
      <div className="activity-title muted">activity · {buckets.length} min buckets</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="activity-svg" role="img" aria-label="event activity over time">
        {buckets.map((b, i) => {
          const h = (b.total / max) * H;
          const th = (b.tools / max) * H;
          return (
            <g key={i}>
              <rect x={i * bw} y={H - h} width={Math.max(bw - 0.4, 0.4)} height={h} className="act-total" />
              <rect x={i * bw} y={H - th} width={Math.max(bw - 0.4, 0.4)} height={th} className="act-tools" />
            </g>
          );
        })}
      </svg>
    </section>
  );
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function fileBase(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
// Directory portion, home→~, left-truncated with a leading … so the segment
// nearest the filename stays visible. Done in JS (LTR) — the old CSS `direction:
// rtl` ellipsis scrambled paths' punctuation (e.g. "…issue./~SKILL.md").
function fileDir(p: string): string {
  const i = p.lastIndexOf("/");
  const dir = (i > 0 ? p.slice(0, i + 1) : "").replace(/^\/Users\/[^/]+/, "~");
  const CAP = 54;
  return dir.length > CAP ? "…" + dir.slice(dir.length - CAP) : dir;
}
