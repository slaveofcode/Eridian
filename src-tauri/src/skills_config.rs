//! Read-only skills reader. Discovers SKILL.md files across agents and parses
//! their frontmatter (name + description). Tolerant: unreadable files skipped.

use crate::commands::SkillRow;
use anyhow::Result;
use std::path::Path;
use walkdir::WalkDir;

pub fn read_all() -> Result<Vec<SkillRow>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    Ok(collect_from_roots(&[
        home.join(".claude").join("skills"),
        home.join(".claude").join("plugins").join("cache"),
        home.join(".config").join("opencode").join("skills"),
    ]))
}

/// Walk the given roots for SKILL.md files → parsed rows, deduped by (agent,name).
/// Split out so it's testable against a temp tree (read_all just supplies the
/// real home-dir roots).
fn collect_from_roots(roots: &[std::path::PathBuf]) -> Vec<SkillRow> {
    let mut out = Vec::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root)
            .max_depth(8)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if p.file_name()
                .map(|n| n.eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false)
            {
                if let Some(row) = parse_skill(p) {
                    out.push(row);
                }
            }
        }
    }
    // Dedupe by (agent, name) — plugin caches can hold multiple versions.
    out.sort_by(|a, b| {
        (a.agent.as_str(), a.name.to_lowercase()).cmp(&(b.agent.as_str(), b.name.to_lowercase()))
    });
    out.dedup_by(|a, b| a.agent == b.agent && a.name == b.name);
    out
}

fn parse_skill(path: &Path) -> Option<SkillRow> {
    let raw = std::fs::read_to_string(path).ok()?;
    let (mut name, mut description) = (None, None);
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = Some(unquote(v));
                } else if let Some(v) = line.strip_prefix("description:") {
                    description = Some(unquote(v));
                }
            }
        }
    }
    let path_s = path.to_string_lossy().to_string();
    let agent = if path_s.contains("/opencode/") {
        "opencode"
    } else {
        "claude-code"
    };
    let scope = if path_s.contains("/plugins/") {
        "plugin"
    } else {
        "user"
    };
    let name = name.unwrap_or_else(|| {
        path.parent()
            .and_then(|d| d.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "skill".into())
    });
    Some(SkillRow {
        agent: agent.into(),
        scope: scope.into(),
        name,
        description: description.unwrap_or_default(),
        source: path_s,
    })
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
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    // Create a unique temp dir containing `<dir>/SKILL.md` with `body`, return
    // the SKILL.md path. `dir` lets the caller embed path markers (e.g. plugins).
    fn write_skill(rel_dir: &str, body: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("eridian_skill_{}_{}", std::process::id(), n));
        let dir = base.join(rel_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("SKILL.md");
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn unquote_strips_wrappers_and_unescapes() {
        assert_eq!(unquote(" plain "), "plain");
        assert_eq!(unquote("\"double\""), "double");
        assert_eq!(unquote("'single'"), "single");
        assert_eq!(unquote(r#""a \"b\" c""#), r#"a "b" c"#);
        assert_eq!(unquote(""), "");
    }

    #[test]
    fn parse_skill_reads_frontmatter() {
        let p = write_skill(
            "my-skill",
            "---\nname: cool-skill\ndescription: does cool things\n---\n# Body\n",
        );
        let row = parse_skill(&p).expect("should parse");
        assert_eq!(row.name, "cool-skill");
        assert_eq!(row.description, "does cool things");
        assert_eq!(row.agent, "claude-code");
        assert_eq!(row.scope, "user");
        assert_eq!(row.source, p.to_string_lossy());
    }

    #[test]
    fn parse_skill_detects_opencode_and_plugin() {
        let oc = write_skill(".config/opencode/skills/x", "---\nname: oc\n---\n");
        assert_eq!(parse_skill(&oc).unwrap().agent, "opencode");

        let plug = write_skill(".claude/plugins/cache/foo/y", "---\nname: p\n---\n");
        let row = parse_skill(&plug).unwrap();
        assert_eq!(row.agent, "claude-code");
        assert_eq!(row.scope, "plugin");
    }

    #[test]
    fn parse_skill_falls_back_to_dir_name_without_frontmatter() {
        let p = write_skill("fallback-name", "no frontmatter here\n");
        let row = parse_skill(&p).unwrap();
        assert_eq!(row.name, "fallback-name");
        assert_eq!(row.description, "");
    }

    #[test]
    fn parse_skill_missing_file_is_none() {
        let missing = std::env::temp_dir().join("eridian_no_such_skill_zzz/SKILL.md");
        assert!(parse_skill(&missing).is_none());
    }

    #[test]
    fn collect_from_roots_walks_and_dedupes() {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("eridian_roots_{}_{}", std::process::id(), n));
        // two plugin-cache versions of the same skill → deduped to one
        for ver in ["v1", "v2"] {
            let d = root.join("plugins").join(ver).join("dup");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), "---\nname: dup\n---\n").unwrap();
        }
        let solo = root.join("solo");
        std::fs::create_dir_all(&solo).unwrap();
        std::fs::write(solo.join("SKILL.md"), "---\nname: solo\n---\n").unwrap();

        let rows = collect_from_roots(&[root.clone(), root.join("nonexistent")]);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"dup") && names.contains(&"solo"));
        assert_eq!(rows.iter().filter(|r| r.name == "dup").count(), 1, "deduped");
    }
}
