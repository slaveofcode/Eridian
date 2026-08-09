//! Read-only Skills & MCP catalog engine.
//!
//! Layers: `fetch` (allowlisted GET + cache), `local` (plugin-cache skill source),
//! `skills`/`mcp` (per-kind normalize + lint + advisor), `compare` (installed vs
//! catalog audit). Nothing here ever writes to agent data; remote fetches are
//! opt-in (`Store::catalog_fetch_enabled`, default off) and allowlisted.

// DTOs/helpers are wired up incrementally across the catalog tasks; drop this
// once the engine + commands consume everything (Task 15 verification).
#![allow(dead_code)]

pub mod skills;

/// A heuristic safety flag on a catalog item or installed entry. ALWAYS surfaced
/// as heuristic in the UI — never presented as a definitive verdict.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFlag {
    pub severity: String, // "info" | "notable" | "danger"
    pub reason: String,
}

/// A copyable command the user runs themselves — Eridian never executes it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallCommand {
    pub agent: String,   // "claude-code" | "opencode"
    pub action: String,  // "install" | "update" | "remove"
    pub command: String,
}

/// One browseable catalog entry (skill or MCP server). Detail fields for the
/// other kind are simply `None` — one flat shape, one TS interface.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub kind: String,       // "skill" | "mcpServer"
    pub source_id: String,  // "local:<marketplace>" | "remote:anthropics-skills" | "remote:mcp-registry"
    pub source_label: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub agents: Vec<String>,
    pub installed: bool,
    // skill detail
    pub plugin: Option<String>,
    pub content_hash: Option<String>,
    pub readme_excerpt: Option<String>,
    // mcp detail
    pub package_kind: Option<String>, // "npm" | "pypi" | "docker" | "remote"
    pub transport: Option<String>,
    pub homepage: Option<String>,
    // computed
    pub flags: Vec<CatalogFlag>,
    pub install_commands: Vec<InstallCommand>,
}

/// A catalog source shown in the UI's Sources strip.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketSource {
    pub id: String,
    pub kind: String, // "localCache" | "remote"
    pub label: String,
    pub enabled: bool,
}

/// The whole browseable catalog returned to the UI.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub items: Vec<CatalogItem>,
    pub sources: Vec<MarketSource>,
    pub fetched_at: Option<String>,
}

/// One installed item's audit result (status + heuristic flags + copy commands).
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub kind: String,
    pub agent: String,
    pub scope: String,
    pub name: String,
    pub installed_path: String,
    pub status: String, // "upToDate" | "updateAvailable" | "localOnly" | "unknownOrigin"
    pub flags: Vec<CatalogFlag>,
    pub update_command: Option<String>,
    pub remove_command: Option<String>,
}
