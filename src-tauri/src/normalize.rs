//! Unified model every ingester normalizes into. The store/UI never see
//! agent-specific shapes. Keep this small and boring — it is the contract.
//!
//! A few helpers (e.g. `AgentKind::ns`) are consumed by adapters that land in
//! later milestones (M2 OpenCode); dead-code lint is silenced for the contract.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    ClaudeCode,
    OpenCode,
}

impl AgentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::OpenCode => "opencode",
        }
    }
    /// Session id namespace prefix — keeps ids collision-free across agents.
    pub fn ns(&self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "cc",
            AgentKind::OpenCode => "oc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
    System,
    Summary,
    /// Agent control/metadata lines (mode, permission, attachment, snapshots,
    /// image blocks, …). Real records, but not conversation — hidden by default.
    Meta,
    Unknown,
}

impl EventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventKind::User => "user",
            EventKind::Assistant => "assistant",
            EventKind::Thinking => "thinking",
            EventKind::ToolCall => "tool_call",
            EventKind::ToolResult => "tool_result",
            EventKind::System => "system",
            EventKind::Summary => "summary",
            EventKind::Meta => "meta",
            EventKind::Unknown => "unknown",
        }
    }
}

/// Upserted whenever an ingester learns something new about a session.
/// All Option fields use "last non-None wins" merge semantics in the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedSession {
    pub id: String, // "<ns>:<native id>"
    pub agent: AgentKind,
    pub project_path: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<String>, // ISO-8601 UTC
    pub updated_at: Option<String>,
    pub is_subagent: bool,
    pub parent_session_id: Option<String>,
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub session_id: String,
    pub ts: Option<String>,
    pub kind: EventKind,
    pub role: Option<String>,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input_json: Option<String>,
    pub tool_result_json: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub source_uuid: Option<String>,
    pub parent_uuid: Option<String>,
    /// Always keep the original record for forensics / re-normalization.
    pub raw_json: String,
}

/// One parsed source record can yield session metadata and/or multiple events
/// (e.g. a Claude Code assistant line with text + two tool_use blocks → 3 events).
#[derive(Debug, Default)]
pub struct NormalizedBatch {
    pub session: Option<NormalizedSession>,
    pub events: Vec<NormalizedEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_kind_strings_and_namespaces() {
        assert_eq!(AgentKind::ClaudeCode.as_str(), "claude-code");
        assert_eq!(AgentKind::OpenCode.as_str(), "opencode");
        assert_eq!(AgentKind::ClaudeCode.ns(), "cc");
        assert_eq!(AgentKind::OpenCode.ns(), "oc");
    }

    #[test]
    fn agent_kind_serde_is_kebab_case() {
        // NOTE: serde kebab-case renders OpenCode as "open-code"; the DB/query
        // form is as_str() = "opencode". The serde form isn't used for
        // persistence (ingesters build AgentKind directly, store writes as_str).
        assert_eq!(serde_json::to_string(&AgentKind::ClaudeCode).unwrap(), "\"claude-code\"");
        assert_eq!(serde_json::to_string(&AgentKind::OpenCode).unwrap(), "\"open-code\"");
        let back: AgentKind = serde_json::from_str("\"open-code\"").unwrap();
        assert_eq!(back, AgentKind::OpenCode);
    }

    #[test]
    fn event_kind_as_str_covers_all_variants() {
        let all = [
            (EventKind::User, "user"),
            (EventKind::Assistant, "assistant"),
            (EventKind::Thinking, "thinking"),
            (EventKind::ToolCall, "tool_call"),
            (EventKind::ToolResult, "tool_result"),
            (EventKind::System, "system"),
            (EventKind::Summary, "summary"),
            (EventKind::Meta, "meta"),
            (EventKind::Unknown, "unknown"),
        ];
        for (k, s) in all {
            assert_eq!(k.as_str(), s);
        }
    }
}
