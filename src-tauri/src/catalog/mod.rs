//! Read-only Skills & MCP catalog engine.
//!
//! Layers: `fetch` (allowlisted GET + cache), `local` (plugin-cache skill source),
//! `skills`/`mcp` (per-kind normalize + lint + advisor), `compare` (installed vs
//! catalog audit). Nothing here ever writes to agent data; remote fetches are
//! opt-in (`Store::catalog_fetch_enabled`, default off) and allowlisted.

// DTOs/helpers are wired up incrementally across the catalog tasks; drop this
// once the engine + commands consume everything (Task 15 verification).
#![allow(dead_code)]

pub mod compare;
pub mod fetch;
pub mod local;
pub mod mcp;
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
    pub identifier: Option<String>,   // package id / remote url the advisor installs
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

// ── engine ──────────────────────────────────────────────────────────────────

use std::path::Path;

/// Cap on remote skill files fetched per refresh — bounds network + disk.
const REMOTE_SKILL_CAP: usize = 50;

/// Build the browseable catalog from the real plugin-cache root plus (if the
/// Settings toggle is on) the allowlisted remote sources.
pub async fn build_catalog(
    store: &crate::store::Store,
    force_refresh: bool,
) -> anyhow::Result<Catalog> {
    let root = dirs::home_dir()
        .map(|h| h.join(".claude").join("plugins").join("cache"))
        .unwrap_or_default();
    build_catalog_with_root(store, force_refresh, &root).await
}

/// Testable core: `plugins_root` is injected so tests run against a fixture tree
/// with no network (toggle off).
pub async fn build_catalog_with_root(
    store: &crate::store::Store,
    force_refresh: bool,
    plugins_root: &Path,
) -> anyhow::Result<Catalog> {
    let installed = crate::skills_config::read_all().unwrap_or_default();
    let installed_names: std::collections::HashSet<String> =
        installed.into_iter().map(|s| s.name).collect();

    let mut items = local::read_plugin_cache(plugins_root);
    for it in &mut items {
        annotate_skill(it, &installed_names);
    }

    let mut sources = vec![MarketSource {
        id: "local".into(),
        kind: "localCache".into(),
        label: "Local plugin cache".into(),
        enabled: true,
    }];

    let remote_enabled = store.catalog_fetch_enabled();
    sources.push(MarketSource {
        id: "remote:anthropics-skills".into(),
        kind: "remote".into(),
        label: "anthropics/skills".into(),
        enabled: remote_enabled,
    });

    let mut fetched_at = None;
    if remote_enabled {
        match fetch_anthropics_skills(store, force_refresh).await {
            Ok((remote_items, ts)) => {
                for mut it in remote_items {
                    annotate_skill(&mut it, &installed_names);
                    items.push(it);
                }
                fetched_at = ts;
            }
            Err(e) => tracing::warn!("anthropics/skills catalog fetch failed: {e:#}"),
        }
    }

    Ok(Catalog {
        items,
        sources,
        fetched_at,
    })
}

/// Mark installed + attach heuristic flags and copyable commands to a skill item.
fn annotate_skill(it: &mut CatalogItem, installed_names: &std::collections::HashSet<String>) {
    it.installed = installed_names.contains(&it.name);
    it.flags = skills::lint_skill(it.readme_excerpt.as_deref().unwrap_or_default());
    it.install_commands = skills::skill_commands(it);
}

/// Fetch + normalize the anthropics/skills catalog (thin I/O orchestration; the
/// parsing/normalizing logic it calls is unit-tested in `skills`).
async fn fetch_anthropics_skills(
    store: &crate::store::Store,
    force: bool,
) -> anyhow::Result<(Vec<CatalogItem>, Option<String>)> {
    let dir = fetch::cache_dir(store);
    let tree_url =
        "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1";
    let tree_json = cached_or_fetch(dir.as_deref(), "anthropics-skills-tree", tree_url, force).await?;
    let dirs = skills::parse_tree_skill_dirs(&tree_json, REMOTE_SKILL_CAP);

    let mut items = Vec::new();
    for d in dirs {
        let raw_url =
            format!("https://raw.githubusercontent.com/anthropics/skills/main/{d}/SKILL.md");
        let key = format!("anthropics-skills-{}", d.replace('/', "_"));
        match cached_or_fetch(dir.as_deref(), &key, &raw_url, force).await {
            Ok(body) => items.push(skills::normalize_remote_skill(&d, &body)),
            Err(e) => tracing::warn!(dir = %d, "remote skill fetch failed: {e:#}"),
        }
    }

    let ts = dir
        .as_deref()
        .and_then(|d| fetch::read_cache(d, "anthropics-skills-tree"))
        .map(|e| e.fetched_at);
    Ok((items, ts))
}

/// Return a fresh cache hit, else fetch and cache; on fetch failure fall back to
/// any stale cache so the UI degrades gracefully instead of erroring.
async fn cached_or_fetch(
    dir: Option<&Path>,
    key: &str,
    url: &str,
    force: bool,
) -> anyhow::Result<String> {
    let now = chrono::Utc::now();
    if !force {
        if let Some(dir) = dir {
            if let Some(entry) = fetch::read_cache(dir, key) {
                if fetch::is_fresh(&entry, now) {
                    return Ok(entry.body);
                }
            }
        }
    }
    match fetch::fetch_allowlisted(url).await {
        Ok(body) => {
            if let Some(dir) = dir {
                let _ = fetch::write_cache(dir, key, &body, now);
            }
            Ok(body)
        }
        Err(e) => {
            if let Some(dir) = dir {
                if let Some(entry) = fetch::read_cache(dir, key) {
                    tracing::warn!(key, "using stale catalog cache after fetch error: {e:#}");
                    return Ok(entry.body);
                }
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn build_catalog_local_only_when_toggle_off() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/market/plugins-cache");
        let cat = build_catalog_with_root(&store, false, &root).await.unwrap();
        assert_eq!(cat.items.len(), 3);
        assert!(cat.sources.iter().any(|s| s.kind == "localCache"));
        assert!(!cat.sources.iter().any(|s| s.kind == "remote" && s.enabled));
        // Local items carry copyable commands.
        assert!(cat.items.iter().all(|i| !i.install_commands.is_empty()));
    }
}
