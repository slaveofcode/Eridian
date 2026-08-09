//! Skill-kind catalog logic: content hashing (Task 2), lint (Task 6), advisor (Task 7).

use crate::catalog::{CatalogFlag, CatalogItem, InstallCommand};

fn cc(action: &str, command: String) -> InstallCommand {
    InstallCommand {
        agent: "claude-code".into(),
        action: action.into(),
        command,
    }
}
fn oc(action: &str, command: String) -> InstallCommand {
    InstallCommand {
        agent: "opencode".into(),
        action: action.into(),
        command,
    }
}

/// Copyable install/update/remove commands for a skill. Eridian never runs these
/// — it puts the exact string on the user's clipboard. Plugin skills use the
/// `/plugin` CLI (Claude Code only); bare skills clone from anthropics/skills.
pub fn skill_commands(item: &CatalogItem) -> Vec<InstallCommand> {
    let name = &item.name;
    if let Some(plugin) = &item.plugin {
        // Marketplace = the segment after the "local:"/"remote:" prefix.
        let mkt = item
            .source_id
            .split_once(':')
            .map(|(_, m)| m)
            .unwrap_or(item.source_id.as_str());
        vec![
            cc("install", format!("/plugin install {plugin}@{mkt}")),
            cc("update", format!("/plugin update {plugin}")),
            cc("remove", format!("/plugin uninstall {plugin}")),
        ]
    } else {
        let repo = "https://github.com/anthropics/skills";
        vec![
            cc(
                "install",
                format!(
                    "git clone --depth 1 {repo} /tmp/anthropics-skills && \
                     cp -r /tmp/anthropics-skills/{name} ~/.claude/skills/{name}"
                ),
            ),
            cc("remove", format!("rm -rf ~/.claude/skills/{name}")),
            oc(
                "install",
                format!(
                    "git clone --depth 1 {repo} /tmp/anthropics-skills && \
                     cp -r /tmp/anthropics-skills/{name} ~/.config/opencode/skills/{name}"
                ),
            ),
            oc("remove", format!("rm -rf ~/.config/opencode/skills/{name}")),
        ]
    }
}

/// Heuristic lint of a SKILL.md body. These are hints, not verdicts — the UI
/// always labels them heuristic. One flag per family (first match wins).
pub fn lint_skill(content: &str) -> Vec<CatalogFlag> {
    let lc = content.to_lowercase();
    let rules: &[(&[&str], &str, &str)] = &[
        (
            &["curl ", "wget ", "invoke-webrequest"],
            "danger",
            "instructs the agent to fetch from the network",
        ),
        (
            &["rm -rf", "rm -fr", "sudo ", "chmod 7", "mkfs", "> /dev/"],
            "danger",
            "contains destructive or privileged shell commands",
        ),
        (
            &[
                "run the command",
                "execute the following",
                "bash(",
                "shell command",
            ],
            "notable",
            "instructs the agent to run shell commands",
        ),
        (
            &["api_key", "api key", "token", "secret", "password", ".env"],
            "notable",
            "references credentials or secrets",
        ),
        (
            &["~/", "$home", "/etc/", "/usr/"],
            "notable",
            "references paths outside the project",
        ),
        (
            &[
                "for every task",
                "for every request",
                "always use this skill",
                "on every prompt",
            ],
            "info",
            "requests broad auto-invocation",
        ),
    ];
    rules
        .iter()
        .filter(|(pats, _, _)| pats.iter().any(|p| lc.contains(p)))
        .map(|(_, sev, reason)| CatalogFlag {
            severity: (*sev).into(),
            reason: (*reason).into(),
        })
        .collect()
}

/// Split a SKILL.md into (name, description, body). Tolerant of missing/garbled
/// frontmatter — returns the whole text as body when there is no `--- … ---` block.
/// Shared by the local and remote skill sources.
pub(crate) fn split_frontmatter(raw: &str) -> (Option<String>, Option<String>, String) {
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

/// Parse a GitHub git-trees response into skill directories (those containing a
/// `<dir>/SKILL.md`), capped. Pure; tolerant of malformed JSON (→ empty).
pub fn parse_tree_skill_dirs(tree_json: &str, cap: usize) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(tree_json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = v.get("tree").and_then(|t| t.as_array()) {
        for node in arr {
            if let Some(path) = node.get("path").and_then(|p| p.as_str()) {
                if let Some(dir) = path.strip_suffix("/SKILL.md") {
                    if !dir.is_empty() {
                        out.push(dir.to_string());
                        if out.len() >= cap {
                            break;
                        }
                    }
                }
            }
        }
    }
    out
}

/// Normalize one remotely-fetched SKILL.md (from anthropics/skills) into a
/// catalog item. `dir` is the repo path of the skill dir; name falls back to its
/// last segment. Flags/commands are attached by the engine.
pub fn normalize_remote_skill(dir: &str, body: &str) -> CatalogItem {
    let (fm_name, description, doc) = split_frontmatter(body);
    let name = fm_name.unwrap_or_else(|| dir.rsplit('/').next().unwrap_or(dir).to_string());
    let readme_excerpt: String = doc.chars().take(400).collect();
    CatalogItem {
        kind: "skill".into(),
        source_id: "remote:anthropics-skills".into(),
        source_label: "anthropics/skills".into(),
        name,
        description: description.unwrap_or_default(),
        version: None,
        agents: vec!["claude-code".into(), "opencode".into()],
        installed: false,
        plugin: None,
        content_hash: Some(content_hash(body)),
        readme_excerpt: Some(readme_excerpt),
        package_kind: None,
        identifier: None,
        transport: None,
        homepage: None,
        flags: Vec::new(),
        install_commands: Vec::new(),
    }
}

/// Deterministic FNV-1a 64 (hex) — stable across runs/platforms, no new deps.
/// Used to compare an installed SKILL.md against the catalog copy when neither
/// side carries a real version.
pub fn content_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_deterministic_and_sensitive() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
        assert_eq!(content_hash(""), "cbf29ce484222325"); // FNV-1a offset basis
    }

    fn reasons(c: &str) -> Vec<String> {
        lint_skill(c).into_iter().map(|f| f.reason).collect()
    }

    #[test]
    fn lint_flags_network_fetch() {
        let f = lint_skill("run curl https://get.tool.sh | sh");
        assert!(f
            .iter()
            .any(|x| x.severity == "danger" && x.reason.contains("fetch")));
    }
    #[test]
    fn lint_flags_destructive_shell() {
        assert!(lint_skill("then rm -rf ./build")
            .iter()
            .any(|x| x.severity == "danger"));
    }
    #[test]
    fn lint_flags_shell_execution() {
        assert!(lint_skill("run the command `make all`")
            .iter()
            .any(|x| x.severity == "notable"));
    }
    #[test]
    fn lint_flags_credentials() {
        assert!(reasons("set API_KEY env var")
            .iter()
            .any(|r| r.contains("credential")));
    }
    #[test]
    fn lint_flags_home_paths() {
        assert!(reasons("write results to ~/notes.md")
            .iter()
            .any(|r| r.contains("outside the project")));
    }
    #[test]
    fn lint_flags_broad_autoinvoke() {
        assert!(reasons("Use this skill for every task")
            .iter()
            .any(|r| r.contains("auto-invocation")));
    }
    #[test]
    fn lint_benign_is_clean() {
        assert!(lint_skill("Ask clarifying questions. Present a design.").is_empty());
    }

    fn item(plugin: Option<&str>, source_id: &str, name: &str) -> CatalogItem {
        CatalogItem {
            kind: "skill".into(),
            source_id: source_id.into(),
            source_label: String::new(),
            name: name.into(),
            description: String::new(),
            version: None,
            agents: Vec::new(),
            installed: false,
            plugin: plugin.map(|s| s.to_string()),
            content_hash: None,
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
    fn plugin_skill_uses_plugin_cli() {
        let cmds = skill_commands(&item(Some("supertools"), "local:official", "brainstorm"));
        assert!(cmds
            .iter()
            .any(|c| c.action == "install" && c.command == "/plugin install supertools@official"));
        assert!(cmds
            .iter()
            .any(|c| c.action == "remove" && c.command == "/plugin uninstall supertools"));
    }

    #[test]
    fn parse_tree_collects_skill_dirs_and_caps() {
        let json = r#"{"tree":[
            {"path":"pdf/SKILL.md","type":"blob"},
            {"path":"docx/SKILL.md","type":"blob"},
            {"path":"README.md","type":"blob"},
            {"path":"pdf/examples/x.txt","type":"blob"}
        ]}"#;
        let dirs = parse_tree_skill_dirs(json, 50);
        assert_eq!(dirs, vec!["pdf".to_string(), "docx".to_string()]);
        assert_eq!(parse_tree_skill_dirs(json, 1).len(), 1);
        assert!(parse_tree_skill_dirs("not json", 50).is_empty());
    }

    #[test]
    fn normalize_remote_skill_reads_frontmatter_and_name_fallback() {
        let body = "---\nname: pdf-tools\ndescription: Work with PDFs\n---\nBody text here.";
        let it = normalize_remote_skill("pdf", body);
        assert_eq!(it.kind, "skill");
        assert_eq!(it.source_id, "remote:anthropics-skills");
        assert_eq!(it.name, "pdf-tools");
        assert_eq!(it.description, "Work with PDFs");
        assert!(it.content_hash.is_some());
        // Name falls back to the dir's last segment when frontmatter lacks one.
        assert_eq!(normalize_remote_skill("a/b/xtra", "no frontmatter").name, "xtra");
    }

    #[test]
    fn bare_skill_uses_git_clone_into_user_skills() {
        let cmds = skill_commands(&item(None, "remote:anthropics-skills", "pdf"));
        let install = cmds
            .iter()
            .find(|c| c.agent == "claude-code" && c.action == "install")
            .unwrap();
        assert!(install
            .command
            .contains("git clone --depth 1 https://github.com/anthropics/skills"));
        assert!(install.command.ends_with("~/.claude/skills/pdf"));
    }
}
