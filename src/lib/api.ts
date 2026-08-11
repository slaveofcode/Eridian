// All backend access goes through this module — components never import
// @tauri-apps/api directly. Commands are added here as milestones land them:
//   M0/M1: listSessions, sessionEvents, ingestStatus + live subscriptions
//   M3:    searchEvents, listMcpServers

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ActivityBucket,
  SkillRun,
  AppendedPayload,
  DbInfo,
  FileContent,
  FileCommit,
  ImageData,
  IngestProgress,
  IngestStatus,
  DayUsage,
  UsageBreakdown,
  ColdImportStatus,
  EventRow,
  McpServerRow,
  SearchResult,
  Settings,
  SessionChanges,
  SessionFilter,
  ServerLog,
  SessionRow,
  SkillRow,
  SubagentLink,
  SubagentParent,
  Catalog,
  AuditRow,
  RunningCommandRow,
  CommandHistoryPage,
} from "./types";

export const api = {
  listSessions: (filter?: SessionFilter) =>
    invoke<SessionRow[]>("list_sessions", { filter }),

  sessionEvents: (sessionId: string, limit = 200, beforeId?: number) =>
    invoke<EventRow[]>("session_events", { sessionId, limit, beforeId }),

  sessionEventsAround: (sessionId: string, eventId: number, before = 200, after = 100) =>
    invoke<EventRow[]>("session_events_around", { sessionId, eventId, before, after }),

  ingestStatus: () => invoke<IngestStatus>("ingest_status"),

  usageByDay: (days = 30, model?: string, agent?: string) =>
    invoke<DayUsage[]>("usage_by_day", { days, model, agent }),
  usageBreakdown: (days = 30) => invoke<UsageBreakdown>("usage_breakdown", { days }),

  opencodeColdStatus: () => invoke<ColdImportStatus>("opencode_cold_status"),
  opencodeColdImport: () => invoke<number>("opencode_cold_import"),

  sessionChanges: (sessionId: string) =>
    invoke<SessionChanges>("session_changes", { sessionId }),

  sessionSubagents: (sessionId: string) =>
    invoke<SubagentLink[]>("session_subagents", { sessionId }),

  subagentParents: () => invoke<SubagentParent[]>("subagent_parents"),

  sessionActivity: (sessionId: string) =>
    invoke<ActivityBucket[]>("session_activity", { sessionId }),

  sessionSkills: (sessionId: string) =>
    invoke<SkillRun[]>("session_skills", { sessionId }),

  searchEvents: (query: string, limit = 60) =>
    invoke<SearchResult[]>("search_events", { query, limit }),

  listMcpServers: () => invoke<McpServerRow[]>("list_mcp_servers"),
  listSkills: () => invoke<SkillRow[]>("list_skills"),
  marketCatalog: () => invoke<Catalog>("market_catalog"),
  marketRefresh: () => invoke<Catalog>("market_refresh"),
  skillsAudit: () => invoke<AuditRow[]>("skills_audit"),
  mcpAudit: () => invoke<AuditRow[]>("mcp_audit"),

  runningCommands: () => invoke<RunningCommandRow[]>("running_commands"),
  commandHistory: (beforeId?: number, limit = 100) =>
    invoke<CommandHistoryPage>("command_history", { beforeId, limit }),
  commandOutput: (eventId: number) =>
    invoke<string | null>("command_output", { eventId }),

  startOpencode: () => invoke<void>("start_opencode"),
  stopOpencode: () => invoke<void>("stop_opencode"),
  opencodeLogs: () => invoke<string[]>("opencode_logs"),
  opencodeManaged: () => invoke<boolean>("opencode_managed"),
  forceKillOpencode: () => invoke<void>("force_kill_opencode"),

  readFile: (path: string) => invoke<FileContent>("read_file", { path }),

  readImage: (path: string) => invoke<ImageData>("read_image", { path }),

  fileHistory: (path: string) => invoke<FileCommit[]>("file_history", { path }),
  fileAtCommit: (path: string, sha: string) =>
    invoke<FileContent>("file_at_commit", { path, sha }),

  dbInfo: () => invoke<DbInfo>("db_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  rebuildDb: () => invoke<void>("rebuild_db"),
};

export function onServerLog(
  cb: (p: ServerLog) => void
): Promise<UnlistenFn> {
  return listen<ServerLog>("eridian://server-log", (e) => cb(e.payload));
}

// ── live subscriptions ─────────────────────────────────────────────────────

export function onSessionsUpdated(cb: () => void): Promise<UnlistenFn> {
  return listen("eridian://sessions-updated", () => cb());
}

export function onEventsAppended(
  cb: (p: AppendedPayload) => void
): Promise<UnlistenFn> {
  return listen<AppendedPayload>("eridian://events-appended", (e) =>
    cb(e.payload)
  );
}

export function onIngestProgress(
  cb: (p: IngestProgress) => void
): Promise<UnlistenFn> {
  return listen<IngestProgress>("eridian://ingest-progress", (e) => cb(e.payload));
}
