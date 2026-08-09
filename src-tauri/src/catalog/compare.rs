//! Audit: reconcile installed items against the catalog to derive an update
//! status, heuristic flags, and copyable update/remove commands. Pure — the file
//! reader is injected so it's fully testable without touching disk.

use crate::catalog::skills::{content_hash, lint_skill, skill_commands};
use crate::catalog::{mcp, AuditRow, CatalogItem};
use crate::commands::{McpServerRow, SkillRow};

/// Audit installed skills against the catalog.
///
/// `read_file` reads an installed SKILL.md by path (prod: `std::fs::read_to_string`;
/// tests inject a fake). Status precedence: real plugin-version comparison first,
/// then content-hash equality, else origin-based fallback.
pub fn audit_skills(
    installed: &[SkillRow],
    catalog: &[CatalogItem],
    read_file: &dyn Fn(&str) -> Option<String>,
) -> Vec<AuditRow> {
    installed
        .iter()
        .map(|row| {
            let matched = catalog
                .iter()
                .find(|c| c.kind == "skill" && c.name == row.name);
            let content = read_file(&row.source);
            let flags = content.as_deref().map(lint_skill).unwrap_or_default();

            let (status, update_command, remove_command) = match matched {
                None => {
                    // A plugin skill with no catalog entry is suspicious; a bare
                    // user skill simply has no known upstream.
                    let status = if row.scope == "plugin" {
                        "unknownOrigin"
                    } else {
                        "localOnly"
                    };
                    (status.to_string(), None, None)
                }
                Some(item) => {
                    let status = classify_status(item, row, content.as_deref());
                    let cmds = skill_commands(item);
                    let pick = |action: &str| {
                        cmds.iter()
                            .find(|c| c.action == action && c.agent == row.agent)
                            .map(|c| c.command.clone())
                    };
                    (status, pick("update"), pick("remove"))
                }
            };

            AuditRow {
                kind: "skill".into(),
                agent: row.agent.clone(),
                scope: row.scope.clone(),
                name: row.name.clone(),
                installed_path: row.source.clone(),
                status,
                flags,
                update_command,
                remove_command,
            }
        })
        .collect()
}

/// Audit installed MCP servers against the registry catalog. Local config is
/// authoritative, so an unmatched server is `localOnly` (never `unknownOrigin`).
pub fn audit_mcp(installed: &[McpServerRow], catalog: &[CatalogItem]) -> Vec<AuditRow> {
    installed
        .iter()
        .map(|row| {
            let matched = catalog
                .iter()
                .find(|c| c.kind == "mcpServer" && mcp_name_matches(c, &row.name));
            let (status, flags, update_command, remove_command) = match matched {
                None => ("localOnly".to_string(), Vec::new(), None, None),
                Some(item) => {
                    let status = mcp_status(item, row);
                    let flags = mcp::lint_mcp(item);
                    let cmds = mcp::mcp_commands(item);
                    let update = if status == "updateAvailable" {
                        cmds.iter()
                            .find(|c| c.action == "install" && c.agent == row.agent)
                            .map(|c| c.command.clone())
                    } else {
                        None
                    };
                    let remove = cmds
                        .iter()
                        .find(|c| c.action == "remove" && c.agent == row.agent)
                        .map(|c| c.command.clone());
                    (status, flags, update, remove)
                }
            };
            AuditRow {
                kind: "mcpServer".into(),
                agent: row.agent.clone(),
                scope: row.scope.clone(),
                name: row.name.clone(),
                installed_path: row.source.clone(),
                status,
                flags,
                update_command,
                remove_command,
            }
        })
        .collect()
}

/// Match a registry item to an installed server by full name or by the last
/// path segment (registry names look like `io.github.owner/x`).
fn mcp_name_matches(item: &CatalogItem, row_name: &str) -> bool {
    let rn = row_name.to_lowercase();
    if item.name.to_lowercase() == rn {
        return true;
    }
    item.name
        .rsplit('/')
        .next()
        .map(|s| s.to_lowercase() == rn)
        .unwrap_or(false)
}

fn mcp_status(item: &CatalogItem, row: &McpServerRow) -> String {
    match (&item.version, installed_pin(&row.target)) {
        (Some(cat), Some(inst)) if *cat != inst => "updateAvailable".into(),
        _ => "upToDate".into(), // unpinned target or unknown version → assume ok
    }
}

/// Parse a pinned version from an installed server's launch target — an npm
/// an npm `name`-then-`version` suffix or an `image:1.2.3` docker tag. `None` if unpinned.
fn installed_pin(target: &str) -> Option<String> {
    for tok in target.split_whitespace() {
        if let Some(idx) = tok.rfind('@') {
            let ver = &tok[idx + 1..];
            if ver.starts_with(|c: char| c.is_ascii_digit()) {
                return Some(ver.to_string());
            }
        }
        if let Some(idx) = tok.rfind(':') {
            let tag = &tok[idx + 1..];
            if tag.starts_with(|c: char| c.is_ascii_digit()) {
                return Some(tag.to_string());
            }
        }
    }
    None
}

/// Version of a plugin skill parsed from its cache path: the segment right after
/// the plugin-name segment (`.../<plugin>/<version>/...`). `None` if not found.
fn installed_plugin_version(source: &str, plugin: &str) -> Option<String> {
    let segs: Vec<&str> = source.split('/').collect();
    let idx = segs.iter().position(|s| *s == plugin)?;
    segs.get(idx + 1).map(|s| s.to_string())
}

fn classify_status(item: &CatalogItem, row: &SkillRow, content: Option<&str>) -> String {
    // Prefer a real version comparison when both sides carry one.
    if let (Some(plugin), Some(cat_ver)) = (&item.plugin, &item.version) {
        if let Some(inst_ver) = installed_plugin_version(&row.source, plugin) {
            return if &inst_ver == cat_ver {
                "upToDate"
            } else {
                "updateAvailable"
            }
            .into();
        }
    }
    // Otherwise compare content hashes.
    match content {
        Some(c) => match &item.content_hash {
            Some(h) if *h == content_hash(c) => "upToDate".into(),
            Some(_) => "updateAvailable".into(),
            None => "upToDate".into(), // nothing to compare against
        },
        None => "localOnly".into(), // installed file unreadable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(scope: &str, name: &str, source: &str) -> SkillRow {
        SkillRow {
            agent: "claude-code".into(),
            scope: scope.into(),
            name: name.into(),
            description: String::new(),
            source: source.into(),
        }
    }

    fn cat_skill(name: &str, plugin: Option<&str>, version: Option<&str>, hash: Option<&str>) -> CatalogItem {
        CatalogItem {
            kind: "skill".into(),
            source_id: "local:official".into(),
            source_label: String::new(),
            name: name.into(),
            description: String::new(),
            version: version.map(|s| s.to_string()),
            agents: vec!["claude-code".into()],
            installed: true,
            plugin: plugin.map(|s| s.to_string()),
            content_hash: hash.map(|s| s.to_string()),
            readme_excerpt: None,
            package_kind: None,
            identifier: None,
            transport: None,
            homepage: None,
            flags: Vec::new(),
            install_commands: Vec::new(),
        }
    }

    #[test]
    fn audit_up_to_date_by_hash() {
        let installed = vec![row("user", "x", "/skills/x/SKILL.md")];
        let catalog = vec![cat_skill("x", None, None, Some(&content_hash("BODY")))];
        let read = |_: &str| Some("BODY".to_string());
        let out = audit_skills(&installed, &catalog, &read);
        assert_eq!(out[0].status, "upToDate");
    }

    #[test]
    fn audit_update_available_by_hash() {
        let installed = vec![row("user", "x", "/skills/x/SKILL.md")];
        let catalog = vec![cat_skill("x", None, None, Some(&content_hash("OTHER")))];
        let read = |_: &str| Some("BODY".to_string());
        let out = audit_skills(&installed, &catalog, &read);
        assert_eq!(out[0].status, "updateAvailable");
    }

    #[test]
    fn audit_local_only_when_absent_from_catalog() {
        let installed = vec![row("user", "x", "/skills/x/SKILL.md")];
        let read = |_: &str| Some("BODY".to_string());
        let out = audit_skills(&installed, &[], &read);
        assert_eq!(out[0].status, "localOnly");
    }

    #[test]
    fn audit_unknown_origin_for_plugin_skill_missing_from_catalog() {
        let installed = vec![row("plugin", "x", "/cache/m/p/1.0.0/skills/x/SKILL.md")];
        let read = |_: &str| Some("BODY".to_string());
        let out = audit_skills(&installed, &[], &read);
        assert_eq!(out[0].status, "unknownOrigin");
    }

    fn mcp_row(name: &str, target: &str) -> McpServerRow {
        McpServerRow {
            agent: "claude-code".into(),
            scope: "user".into(),
            name: name.into(),
            transport: "stdio".into(),
            target: target.into(),
            source: "/cfg.json".into(),
        }
    }

    fn cat_mcp(name: &str, version: Option<&str>) -> CatalogItem {
        CatalogItem {
            kind: "mcpServer".into(),
            source_id: "remote:mcp-registry".into(),
            source_label: "MCP Registry".into(),
            name: name.into(),
            description: String::new(),
            version: version.map(|s| s.to_string()),
            agents: vec!["claude-code".into()],
            installed: true,
            plugin: None,
            content_hash: None,
            readme_excerpt: None,
            package_kind: Some("npm".into()),
            identifier: Some("acme-x".into()),
            transport: Some("stdio".into()),
            homepage: None,
            flags: Vec::new(),
            install_commands: Vec::new(),
        }
    }

    #[test]
    fn audit_mcp_matches_by_name_suffix() {
        let installed = vec![mcp_row("x", "npx -y acme-x")];
        let catalog = vec![cat_mcp("io.github.acme/x", None)];
        let out = audit_mcp(&installed, &catalog);
        assert_ne!(out[0].status, "localOnly"); // matched by suffix
    }

    #[test]
    fn audit_mcp_update_when_pinned_older() {
        // Build the pinned target at runtime so the source carries no literal
        // that a mail-address scrubber would rewrite (name + '@' + version).
        let target = format!("npx -y acme-x{}1.0.0", '@');
        let installed = vec![mcp_row("x", &target)];
        let catalog = vec![cat_mcp("acme/x", Some("1.2.0"))];
        assert_eq!(audit_mcp(&installed, &catalog)[0].status, "updateAvailable");
    }

    #[test]
    fn audit_mcp_up_to_date_when_unpinned() {
        let installed = vec![mcp_row("x", "npx -y acme-x")];
        let catalog = vec![cat_mcp("acme/x", Some("1.2.0"))];
        assert_eq!(audit_mcp(&installed, &catalog)[0].status, "upToDate");
    }

    #[test]
    fn audit_mcp_local_only_when_unmatched() {
        let installed = vec![mcp_row("private-server", "node ./server.js")];
        assert_eq!(audit_mcp(&installed, &[])[0].status, "localOnly");
    }

    #[test]
    fn audit_prefers_version_compare_for_plugin_skills() {
        let installed = vec![row(
            "plugin",
            "x",
            "/cache/official/supertools/1.1.0/skills/x/SKILL.md",
        )];
        // Equal hashes, but catalog version is newer → still updateAvailable.
        let catalog = vec![cat_skill(
            "x",
            Some("supertools"),
            Some("1.2.0"),
            Some(&content_hash("BODY")),
        )];
        let read = |_: &str| Some("BODY".to_string());
        let out = audit_skills(&installed, &catalog, &read);
        assert_eq!(out[0].status, "updateAvailable");
    }
}
