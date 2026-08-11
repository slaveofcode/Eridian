// Mirrors the Rust DTOs exactly (serde camelCase). Keep in lockstep with
// src-tauri/src/commands.rs and normalize.rs.

export type Agent = "claude-code" | "opencode";

export type EventKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "system"
  | "summary"
  | "meta"
  | "unknown";

export interface SessionRow {
  id: string;
  agent: Agent;
  projectPath: string | null;
  title: string | null;
  model: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  isSubagent: boolean;
  parentSessionId: string | null;
  sourceAlive: boolean;
  eventCount: number;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  peakTokensIn: number;
  live: boolean;
}

export interface RunningCommandRow {
  eventId: number;
  sessionId: string;
  agent: Agent;
  sessionTitle: string | null;
  command: string;
  risk: string;
  startedAt: string | null;
}

export interface CommandHistoryRow {
  eventId: number;
  sessionId: string;
  agent: Agent;
  command: string;
  risk: string;
  status: string;
  durationSecs: number | null;
  startedAt: string | null;
}

export interface CommandHistoryPage {
  rows: CommandHistoryRow[];
  nextBeforeId: number | null;
}

export interface DayUsage {
  date: string; // YYYY-MM-DD
  tokensIn: number;
  tokensOut: number;
}

export interface ImageData {
  dataUrl: string;
  sizeBytes: number;
}

export interface FileCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string; // ISO-8601
  subject: string;
}

export interface SkillRun {
  kind: "skill" | "command";
  name: string;
  ts: string | null;
  count: number;
}

export interface ColdImportStatus {
  available: boolean;
  total: number;
  pending: number;
}

export interface EventRow {
  id: number;
  sessionId: string;
  ts: string | null;
  kind: EventKind;
  role: string | null;
  text: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  toolResultJson: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface IngestStatus {
  claudeCodeFiles: number;
  claudeCodeEvents: number;
  opencodeConnected: boolean;
  opencodeEvents: number;
  lastActivityAt: string | null;
}

export interface SessionFilter {
  agent?: Agent;
  project?: string;
  includeSubagents?: boolean;
}

export interface AppendedPayload {
  sessionId: string;
  events: EventRow[];
}

export interface IngestProgress {
  phase: "backfilling" | "watching";
  filesDone: number;
  filesTotal: number;
  events: number;
  done: boolean;
}

export type Risk = "safe" | "notable" | "danger";

export interface FileChangeDetail {
  op: "write" | "edit" | "read";
  ts: string | null;
  preview: string | null;
  risk: Risk;
}

export interface FileChangeRow {
  path: string;
  writes: number;
  edits: number;
  reads: number;
  lastTs: string | null;
  risk: Risk;
  changes: FileChangeDetail[];
}

export interface CommandRow {
  command: string;
  ts: string | null;
  risk: Risk;
  reason: string;
}

export interface RiskSummary {
  danger: number;
  notable: number;
  safe: number;
}

export interface SessionChanges {
  files: FileChangeRow[];
  commands: CommandRow[];
  risk: RiskSummary;
  filesTotal: number;
  commandsTotal: number;
}

export interface ActivityBucket {
  ts: string;
  total: number;
  tools: number;
}

export interface SubagentLink {
  id: string;
  agent: Agent;
  title: string | null;
  eventCount: number;
  windowStart: string | null;
  windowEnd: string | null;
  eventsInWindow: number;
  live: boolean;
}

export interface SubagentParent {
  sessionId: string;
  count: number;
}

export interface SearchResult {
  id: number;
  sessionId: string;
  agent: Agent;
  sessionTitle: string | null;
  kind: EventKind;
  ts: string | null;
  snippet: string;
}

export interface ServerLog {
  server: string;
  line: string;
}

export interface McpServerRow {
  agent: Agent;
  scope: "user" | "project";
  name: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  target: string;
  source: string;
}

export interface SkillRow {
  agent: Agent;
  scope: "user" | "plugin" | "project";
  name: string;
  description: string;
  source: string;
}

export interface Settings {
  backfillFileLimit: number | null;
  maxSessionsPerAgent: number | null;
  catalogFetchEnabled: boolean;
}

// ── catalog (Skills & MCP marketplace) — mirrors src-tauri/src/catalog ───────

export type CatalogKind = "skill" | "mcpServer";
export type FlagSeverity = "info" | "notable" | "danger";
export type AuditStatus =
  | "upToDate"
  | "updateAvailable"
  | "localOnly"
  | "unknownOrigin";

export interface CatalogFlag {
  severity: FlagSeverity;
  reason: string;
}

export interface InstallCommand {
  agent: string; // "claude-code" | "opencode"
  action: string; // "install" | "update" | "remove"
  command: string;
}

export interface CatalogItem {
  kind: CatalogKind;
  sourceId: string;
  sourceLabel: string;
  name: string;
  description: string;
  version: string | null;
  agents: string[];
  installed: boolean;
  plugin: string | null;
  contentHash: string | null;
  readmeExcerpt: string | null;
  packageKind: string | null;
  identifier: string | null;
  transport: string | null;
  homepage: string | null;
  flags: CatalogFlag[];
  installCommands: InstallCommand[];
}

export interface MarketSource {
  id: string;
  kind: "localCache" | "remote";
  label: string;
  enabled: boolean;
}

export interface Catalog {
  items: CatalogItem[];
  sources: MarketSource[];
  fetchedAt: string | null;
}

export interface AuditRow {
  kind: CatalogKind;
  agent: string;
  scope: string;
  name: string;
  installedPath: string;
  status: AuditStatus;
  flags: CatalogFlag[];
  updateCommand: string | null;
  removeCommand: string | null;
}

export interface FileContent {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface DbInfo {
  path: string;
  sizeBytes: number;
  sessions: number;
  events: number;
}

// Agent identity accents (see PLAN.md §6). Used *only* as identity.
export const AGENT_ACCENT: Record<Agent, string> = {
  "claude-code": "#E8825A",
  opencode: "#3ECF8E",
};
