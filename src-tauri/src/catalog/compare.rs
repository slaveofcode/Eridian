//! Audit: reconcile installed items against the catalog to derive an update
//! status, heuristic flags, and copyable update/remove commands. Pure — the file
//! reader is injected so it's fully testable without touching disk.

use crate::catalog::skills::{content_hash, lint_skill, skill_commands};
use crate::catalog::{AuditRow, CatalogItem};
use crate::commands::SkillRow;

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
