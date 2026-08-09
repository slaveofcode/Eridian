//! Pure inspection heuristics over normalized tool-call events. Turns a
//! (tool_name, tool_input_json) pair into a file change and/or a risk verdict.
//!
//! Everything here is a HEURISTIC, labeled as such in the UI — never presented
//! as ground truth. Computed on read so the rules can evolve without re-ingest.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Safe,
    Notable,
    Danger,
}

impl Risk {
    pub fn as_str(&self) -> &'static str {
        match self {
            Risk::Safe => "safe",
            Risk::Notable => "notable",
            Risk::Danger => "danger",
        }
    }
    pub fn rank(&self) -> u8 {
        match self {
            Risk::Safe => 0,
            Risk::Notable => 1,
            Risk::Danger => 2,
        }
    }
    /// Rank of a risk given by its string form ("danger"/"notable"/"safe").
    pub fn rank_str(s: &str) -> u8 {
        match s {
            "danger" => 2,
            "notable" => 1,
            _ => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOp {
    Write,
    Edit,
    Read,
}

impl FileOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileOp::Write => "write",
            FileOp::Edit => "edit",
            FileOp::Read => "read",
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub op: FileOp,
    /// Content (Write) or a compact old→new diff (Edit). None for Read.
    pub preview: Option<String>,
}

const PREVIEW_MAX: usize = 2000;

fn truncate(s: &str) -> String {
    if s.len() <= PREVIEW_MAX {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(PREVIEW_MAX).collect();
        out.push_str("\n… (truncated)");
        out
    }
}

/// First present string among candidate keys.
fn field<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| input.get(k).and_then(Value::as_str))
}

/// Classify a shell command into a risk tier with a short reason.
pub fn classify_command(cmd: &str) -> (Risk, String) {
    let c = cmd.to_lowercase();
    let danger = [
        ("rm -rf", "recursive force delete"),
        ("rm -fr", "recursive force delete"),
        ("git push --force", "force push"),
        ("git push -f", "force push"),
        ("git reset --hard", "hard reset"),
        ("git clean -fd", "force clean"),
        ("sudo ", "elevated privileges"),
        ("chmod ", "permission change"),
        ("chown ", "ownership change"),
        ("mkfs", "format filesystem"),
        (" dd ", "raw disk write"),
        ("drop table", "drop table"),
        ("drop database", "drop database"),
        ("truncate ", "truncate"),
        (":(){", "fork bomb"),
    ];
    for (needle, reason) in danger {
        if c.contains(needle) {
            return (Risk::Danger, reason.to_string());
        }
    }
    // curl|sh / wget|sh style remote execution
    if (c.contains("curl") || c.contains("wget")) && (c.contains("| sh") || c.contains("| bash")) {
        return (Risk::Danger, "pipe remote script to shell".to_string());
    }

    let notable = [
        ("git commit", "commit"),
        ("git push", "push"),
        ("git checkout", "checkout"),
        ("git rebase", "rebase"),
        ("git merge", "merge"),
        ("npm install", "install deps"),
        ("pnpm install", "install deps"),
        ("pnpm add", "install deps"),
        ("yarn add", "install deps"),
        ("cargo install", "install deps"),
        ("pip install", "install deps"),
        ("brew install", "install deps"),
        ("docker ", "docker"),
        ("kubectl ", "kubectl"),
        ("curl ", "network access"),
        ("wget ", "network access"),
    ];
    for (needle, reason) in notable {
        if c.contains(needle) {
            return (Risk::Notable, reason.to_string());
        }
    }
    (Risk::Safe, "read-only / local".to_string())
}

/// Classify a tool call into a risk tier with a short reason.
pub fn classify_tool(tool_name: &str, input: &Value) -> (Risk, String) {
    match tool_name.to_lowercase().as_str() {
        "bash" | "shell" | "run" => {
            let cmd = field(input, &["command", "cmd", "script"]).unwrap_or("");
            classify_command(cmd)
        }
        "write" => {
            let path = field(input, &["file_path", "filePath", "path"]).unwrap_or("");
            if is_sensitive_path(path) {
                (Risk::Notable, "writes sensitive file".to_string())
            } else {
                (Risk::Notable, "writes file".to_string())
            }
        }
        "edit" | "multiedit" | "notebookedit" | "apply_patch" | "patch" => {
            (Risk::Notable, "edits file".to_string())
        }
        "read" | "grep" | "glob" | "ls" | "list" | "webfetch" | "websearch" => {
            (Risk::Safe, "read-only".to_string())
        }
        other => (Risk::Safe, other.to_string()),
    }
}

/// If this tool call is a Skill invocation, return the skill name.
/// Reliable: Claude Code emits a `tool_use` with name "Skill" and
/// `input.command` = the skill (also accept `skill`/`name` defensively).
pub fn detect_skill_run(tool_name: &str, input: &Value) -> Option<String> {
    if !tool_name.eq_ignore_ascii_case("skill") {
        return None;
    }
    field(input, &["command", "skill", "name"]).map(|s| s.to_string())
}

/// If this text is a slash-command invocation, return the command name (no
/// leading '/'). Heuristic: parses the UNDOCUMENTED `<command-name>` tag Claude
/// Code injects for slash commands — treat as best-effort, may change.
pub fn detect_command_run(text: &str) -> Option<String> {
    let start = text.find("<command-name>")? + "<command-name>".len();
    let end = text[start..].find("</command-name>")? + start;
    let name = text[start..end].trim().trim_start_matches('/').trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn is_sensitive_path(path: &str) -> bool {
    let p = path.to_lowercase();
    p.ends_with(".env")
        || p.contains("/.env")
        || p.contains("secret")
        || p.contains("credential")
        || p.contains("id_rsa")
        || p.contains(".pem")
}

/// Extract a file change from a tool call, if the tool touches a file.
pub fn extract_file_change(tool_name: &str, input: &Value) -> Option<FileChange> {
    let name = tool_name.to_lowercase();
    let path = field(input, &["file_path", "filePath", "path"])?.to_string();
    match name.as_str() {
        "write" => Some(FileChange {
            path,
            op: FileOp::Write,
            preview: field(input, &["content", "contents", "text"]).map(truncate),
        }),
        "edit" => {
            let old = field(input, &["old_string", "oldString", "old"]).unwrap_or("");
            let new = field(input, &["new_string", "newString", "new"]).unwrap_or("");
            Some(FileChange {
                path,
                op: FileOp::Edit,
                preview: Some(truncate(&mini_diff(old, new))),
            })
        }
        "multiedit" => {
            let mut diff = String::new();
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for e in edits {
                    let old = field(e, &["old_string", "oldString", "old"]).unwrap_or("");
                    let new = field(e, &["new_string", "newString", "new"]).unwrap_or("");
                    diff.push_str(&mini_diff(old, new));
                    diff.push('\n');
                }
            }
            Some(FileChange {
                path,
                op: FileOp::Edit,
                preview: Some(truncate(diff.trim_end())),
            })
        }
        "read" => Some(FileChange {
            path,
            op: FileOp::Read,
            preview: None,
        }),
        _ => None,
    }
}

/// Compact unified-ish diff: each old line prefixed '-', each new line '+'.
fn mini_diff(old: &str, new: &str) -> String {
    let mut out = String::new();
    for line in old.lines() {
        out.push_str("- ");
        out.push_str(line);
        out.push('\n');
    }
    for line in new.lines() {
        out.push_str("+ ");
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dangerous_commands_flagged() {
        for (cmd, _) in [
            ("rm -rf /tmp/x", ""),
            ("sudo apt install foo", ""),
            ("git push --force origin main", ""),
            ("git reset --hard HEAD~3", ""),
            ("curl https://x.sh | sh", ""),
            ("chmod 777 file", ""),
        ] {
            assert_eq!(classify_command(cmd).0, Risk::Danger, "cmd: {cmd}");
        }
    }

    #[test]
    fn notable_commands_flagged() {
        assert_eq!(classify_command("git commit -m x").0, Risk::Notable);
        assert_eq!(classify_command("pnpm install").0, Risk::Notable);
        assert_eq!(classify_command("curl https://api.example.com").0, Risk::Notable);
    }

    #[test]
    fn safe_commands_are_safe() {
        for cmd in ["ls -la", "cat file.txt", "git status", "grep foo .", "cargo test"] {
            assert_eq!(classify_command(cmd).0, Risk::Safe, "cmd: {cmd}");
        }
    }

    #[test]
    fn classify_tool_routes_bash_to_command() {
        let (r, _) = classify_tool("Bash", &json!({"command": "rm -rf x"}));
        assert_eq!(r, Risk::Danger);
        assert_eq!(classify_tool("Read", &json!({"file_path": "a"})).0, Risk::Safe);
        assert_eq!(classify_tool("Write", &json!({"file_path": "a"})).0, Risk::Notable);
        assert_eq!(
            classify_tool("Write", &json!({"file_path": "/x/.env"})).0,
            Risk::Notable
        );
    }

    #[test]
    fn extract_write_captures_content() {
        let fc = extract_file_change("Write", &json!({"file_path": "/a.rs", "content": "fn main(){}"}))
            .unwrap();
        assert_eq!(fc.path, "/a.rs");
        assert_eq!(fc.op, FileOp::Write);
        assert_eq!(fc.preview.as_deref(), Some("fn main(){}"));
    }

    #[test]
    fn extract_edit_produces_diff() {
        let fc = extract_file_change(
            "Edit",
            &json!({"file_path": "/a.rs", "old_string": "let x = 1;", "new_string": "let x = 2;"}),
        )
        .unwrap();
        assert_eq!(fc.op, FileOp::Edit);
        let d = fc.preview.unwrap();
        assert!(d.contains("- let x = 1;"), "diff: {d}");
        assert!(d.contains("+ let x = 2;"), "diff: {d}");
    }

    #[test]
    fn extract_multiedit_combines_diffs() {
        let fc = extract_file_change(
            "MultiEdit",
            &json!({"file_path": "/a", "edits": [
                {"old_string": "a", "new_string": "b"},
                {"old_string": "c", "new_string": "d"}
            ]}),
        )
        .unwrap();
        let d = fc.preview.unwrap();
        assert!(d.contains("- a") && d.contains("+ b") && d.contains("- c") && d.contains("+ d"));
    }

    #[test]
    fn opencode_lowercase_tools_work() {
        assert_eq!(classify_tool("bash", &json!({"command": "sudo x"})).0, Risk::Danger);
        let fc = extract_file_change("write", &json!({"filePath": "/a", "content": "x"})).unwrap();
        assert_eq!(fc.path, "/a");
    }

    #[test]
    fn non_file_tool_returns_none() {
        assert!(extract_file_change("Bash", &json!({"command": "ls"})).is_none());
    }

    #[test]
    fn detect_skill_run_reads_command() {
        assert_eq!(detect_skill_run("Skill", &json!({"command": "brainstorming"})).as_deref(), Some("brainstorming"));
        assert_eq!(detect_skill_run("skill", &json!({"skill": "mem-search"})).as_deref(), Some("mem-search"));
        assert!(detect_skill_run("Bash", &json!({"command": "ls"})).is_none());
        assert!(detect_skill_run("Skill", &json!({})).is_none());
    }

    #[test]
    fn detect_command_run_parses_tag() {
        assert_eq!(detect_command_run("<command-name>/sample-review</command-name>").as_deref(), Some("sample-review"));
        assert_eq!(detect_command_run("noise <command-name>foo</command-name> tail").as_deref(), Some("foo"));
        assert!(detect_command_run("plain user message").is_none());
        assert!(detect_command_run("<command-name></command-name>").is_none());
    }
}
