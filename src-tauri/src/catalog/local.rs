//! Local skill source: reads the on-disk plugin cache (read-only) and turns each
//! `SKILL.md` into a `CatalogItem`. This is always available (no network).
//!
//! Real caches use two interchangeable layouts under the cache root:
//!   `<marketplace>/<plugin>/<version>/<skill>/SKILL.md`
//!   `<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md`
//! Both are handled by keying the skill name off SKILL.md's parent directory and
//! taking marketplace/plugin/version as the first three path segments.

use crate::catalog::{skills::content_hash, CatalogItem};
use std::path::{Path, PathBuf};

/// Parse every `SKILL.md` under `root` (the plugin cache dir) into catalog items.
/// Tolerant: an unreadable/short-path entry is skipped with a `warn!`, never a panic.
pub fn read_plugin_cache(root: &Path) -> Vec<CatalogItem> {
    let mut files = Vec::new();
    find_skill_files(root, &mut files);
    let mut out = Vec::new();
    for path in files {
        match parse_one(root, &path) {
            Some(item) => out.push(item),
            None => tracing::warn!(path = %path.display(), "skipping unparseable plugin skill"),
        }
    }
    out
}

fn find_skill_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            find_skill_files(&p, out);
        } else if p.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
            out.push(p);
        }
    }
}

fn parse_one(root: &Path, path: &Path) -> Option<CatalogItem> {
    let rel = path.strip_prefix(root).ok()?;
    let segs: Vec<&str> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    // Need at least marketplace/plugin/version/<skill>/SKILL.md.
    if segs.len() < 5 {
        return None;
    }
    let marketplace = segs[0];
    let plugin = segs[1];
    let version = segs[2];
    let skill_dir = segs[segs.len() - 2]; // parent dir of SKILL.md

    let raw = std::fs::read_to_string(path).ok()?;
    let (fm_name, description, body) = split_frontmatter(&raw);
    let name = fm_name.unwrap_or_else(|| skill_dir.to_string());
    let readme_excerpt: String = body.chars().take(400).collect();

    Some(CatalogItem {
        kind: "skill".into(),
        source_id: format!("local:{marketplace}"),
        source_label: format!("{marketplace} (local plugin cache)"),
        name,
        description: description.unwrap_or_default(),
        version: Some(version.to_string()),
        agents: vec!["claude-code".into()],
        installed: false,
        plugin: Some(plugin.to_string()),
        content_hash: Some(content_hash(&raw)),
        readme_excerpt: Some(readme_excerpt),
        package_kind: None,
        transport: None,
        homepage: None,
        flags: Vec::new(),
        install_commands: Vec::new(),
    })
}

/// Split a SKILL.md into (name, description, body). Tolerant of missing/garbled
/// frontmatter — returns the whole text as body when there is no `--- … ---` block.
fn split_frontmatter(raw: &str) -> (Option<String>, Option<String>, String) {
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let (mut name, mut description) = (None, None);
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = Some(unquote(v));
                } else if let Some(v) = line.strip_prefix("description:") {
                    description = Some(unquote(v));
                }
            }
            let after = &rest[end + "\n---".len()..];
            let body = after
                .trim_start_matches(['-', '\r', '\n'])
                .trim_start()
                .to_string();
            return (name, description, body);
        }
    }
    (None, None, raw.trim_start().to_string())
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    let s = s.strip_prefix('\'').unwrap_or(s);
    let s = s.strip_suffix('\'').unwrap_or(s);
    s.replace("\\\"", "\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/market/plugins-cache")
    }

    #[test]
    fn plugin_cache_parses_fixture_tree() {
        let items = read_plugin_cache(&fixture_root());
        assert_eq!(items.len(), 3);
        let b = items.iter().find(|i| i.name == "brainstorm").unwrap();
        assert_eq!(b.kind, "skill");
        assert_eq!(b.source_id, "local:official");
        assert_eq!(b.plugin.as_deref(), Some("supertools"));
        assert_eq!(b.version.as_deref(), Some("1.2.0"));
        assert!(b.content_hash.is_some());
        assert!(b.description.contains("designs"));
    }

    #[test]
    fn plugin_cache_missing_root_is_empty_not_error() {
        assert!(read_plugin_cache(Path::new("/nonexistent")).is_empty());
    }
}
