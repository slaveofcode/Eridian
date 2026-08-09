//! Read-only MCP config reader. Parses the Claude Code and OpenCode config
//! locations into a uniform table. Tolerant: an unreadable/invalid file is
//! skipped with a warning, never an error. Secrets are masked — this is a
//! read-only panel and config bodies are sensitive.

use crate::commands::McpServerRow;
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

pub fn read_all() -> Result<Vec<McpServerRow>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    Ok(scan_home(&home))
}

/// Parse all MCP config under a home dir. Split out so it's testable against a
/// temp home tree (read_all supplies the real one).
fn scan_home(home: &Path) -> Vec<McpServerRow> {
    let mut out = Vec::new();

    // Claude Code: ~/.claude.json — user-scope mcpServers + per-project ones.
    let claude_json = home.join(".claude.json");
    if let Some(v) = read_json_tolerant(&claude_json) {
        let src = claude_json.display().to_string();
        collect_claude(v.get("mcpServers"), "user", &src, &mut out);
        if let Some(projects) = v.get("projects").and_then(Value::as_object) {
            for (path, pcfg) in projects {
                collect_claude(pcfg.get("mcpServers"), "project", path, &mut out);
            }
        }
    }
    // Some setups keep mcpServers in ~/.claude/settings.json.
    let settings = home.join(".claude").join("settings.json");
    if let Some(v) = read_json_tolerant(&settings) {
        collect_claude(v.get("mcpServers"), "user", &settings.display().to_string(), &mut out);
    }

    // OpenCode: ~/.config/opencode/opencode.json(c) → "mcp".
    for fname in ["opencode.json", "opencode.jsonc"] {
        let p = home.join(".config").join("opencode").join(fname);
        if let Some(v) = read_json_tolerant(&p) {
            if let Some(mcp) = v.get("mcp").and_then(Value::as_object) {
                let src = p.display().to_string();
                for (name, cfg) in mcp {
                    out.push(opencode_row(name, cfg, &src));
                }
            }
        }
    }

    out.sort_by(|a, b| (a.agent.as_str(), a.name.as_str()).cmp(&(b.agent.as_str(), b.name.as_str())));
    out
}

fn collect_claude(ms: Option<&Value>, scope: &str, source: &str, out: &mut Vec<McpServerRow>) {
    if let Some(obj) = ms.and_then(Value::as_object) {
        for (name, cfg) in obj {
            out.push(claude_row(name, cfg, scope, source));
        }
    }
}

fn claude_row(name: &str, cfg: &Value, scope: &str, source: &str) -> McpServerRow {
    let declared = cfg.get("type").and_then(Value::as_str);
    let url = cfg.get("url").and_then(Value::as_str);
    let command = cfg.get("command").and_then(Value::as_str);
    let (transport, target) = shape(declared, url, command, cfg.get("args"));
    McpServerRow {
        agent: "claude-code".into(),
        scope: scope.into(),
        name: name.into(),
        transport,
        target,
        source: source.into(),
    }
}

fn opencode_row(name: &str, cfg: &Value, source: &str) -> McpServerRow {
    // OpenCode: type "local" → stdio (command array), "remote" → http (url).
    let declared = match cfg.get("type").and_then(Value::as_str) {
        Some("local") => Some("stdio"),
        Some("remote") => Some("http"),
        other => other,
    };
    let url = cfg.get("url").and_then(Value::as_str);
    // command may be a string or an array; normalize.
    let cmd_string;
    let command = match cfg.get("command") {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(Value::Array(a)) => {
            cmd_string = a
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            Some(cmd_string.as_str())
        }
        _ => None,
    };
    let (transport, target) = shape(declared, url, command, cfg.get("args"));
    McpServerRow {
        agent: "opencode".into(),
        scope: "user".into(),
        name: name.into(),
        transport,
        target,
        source: source.into(),
    }
}

/// Decide transport + a masked target from the available fields.
fn shape(
    declared: Option<&str>,
    url: Option<&str>,
    command: Option<&str>,
    args: Option<&Value>,
) -> (String, String) {
    if let Some(u) = url {
        let transport = match declared {
            Some("sse") => "sse",
            _ => "http",
        };
        return (transport.into(), mask_target(&strip_query(u)));
    }
    if let Some(c) = command {
        let mut full = c.to_string();
        if let Some(arr) = args.and_then(Value::as_array) {
            for a in arr {
                if let Some(s) = a.as_str() {
                    full.push(' ');
                    full.push_str(s);
                }
            }
        }
        return ("stdio".into(), mask_target(&full));
    }
    (declared.unwrap_or("unknown").into(), String::new())
}

fn strip_query(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}

/// Mask obvious secrets in a target string (key=…, token=…, sk-/ghp_/xox prefixes).
fn mask_target(s: &str) -> String {
    s.split_whitespace()
        .map(mask_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn mask_token(tok: &str) -> String {
    if let Some((k, _v)) = tok.split_once('=') {
        let kl = k.to_lowercase();
        if ["key", "token", "secret", "password", "apikey", "auth"]
            .iter()
            .any(|w| kl.contains(w))
        {
            return format!("{k}=***");
        }
    }
    for prefix in ["sk-", "ghp_", "github_pat_", "xox", "Bearer"] {
        if tok.starts_with(prefix) {
            return "***".to_string();
        }
    }
    tok.to_string()
}

/// Read + parse JSON, tolerating JSONC comments. None on any failure (warns).
fn read_json_tolerant(path: &Path) -> Option<Value> {
    if !path.exists() {
        return None;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(path = %path.display(), "mcp config read failed: {e}");
            return None;
        }
    };
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        return Some(v);
    }
    match serde_json::from_str::<Value>(&strip_jsonc(&raw)) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!(path = %path.display(), "mcp config parse failed: {e}");
            None
        }
    }
}

/// Remove // line and /* */ block comments, respecting string literals.
fn strip_jsonc(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let (mut in_str, mut escaped) = (false, false);
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_http_server_uses_url_and_masks_query() {
        let row = claude_row(
            "grafana",
            &json!({"type": "http", "url": "https://mcp.example.com/sse?apiKey=secret123", "headers": {}}),
            "user",
            "/x/.claude.json",
        );
        assert_eq!(row.transport, "http");
        assert_eq!(row.target, "https://mcp.example.com/sse");
        assert_eq!(row.agent, "claude-code");
    }

    #[test]
    fn claude_stdio_server_joins_command_args() {
        let row = claude_row(
            "local",
            &json!({"command": "npx", "args": ["-y", "some-mcp"]}),
            "project",
            "/proj",
        );
        assert_eq!(row.transport, "stdio");
        assert_eq!(row.target, "npx -y some-mcp");
        assert_eq!(row.scope, "project");
    }

    #[test]
    fn opencode_local_is_stdio() {
        let row = opencode_row(
            "clickhouse",
            &json!({"type": "local", "command": ["uvx", "mcp-clickhouse"]}),
            "/x/opencode.json",
        );
        assert_eq!(row.agent, "opencode");
        assert_eq!(row.transport, "stdio");
        assert_eq!(row.target, "uvx mcp-clickhouse");
    }

    #[test]
    fn secrets_are_masked() {
        assert_eq!(mask_token("token=abc123"), "token=***");
        assert_eq!(mask_token("sk-abcdef"), "***");
        assert_eq!(mask_token("--flag"), "--flag");
    }

    #[test]
    fn mask_token_covers_key_variants_and_prefixes() {
        for kv in ["APIKEY=x", "PASSWORD=y", "authToken=z", "MY_SECRET=q"] {
            assert!(mask_token(kv).ends_with("=***"), "should mask {kv}");
        }
        for tok in ["ghp_abc", "github_pat_abc", "xoxb-abc", "Bearer abc"] {
            // only the leading token matches the prefix rule
            let first = tok.split(' ').next().unwrap();
            assert_eq!(mask_token(first), "***", "should mask {first}");
        }
        assert_eq!(mask_token("plainvalue"), "plainvalue"); // untouched
    }

    #[test]
    fn mask_target_masks_each_whitespace_token() {
        let masked = mask_target("run --env API_KEY=abc --url https://ok.dev");
        assert!(masked.contains("API_KEY=***"));
        assert!(masked.contains("https://ok.dev")); // non-secret kept
    }

    #[test]
    fn scan_home_reads_claude_and_opencode_configs() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let home = std::env::temp_dir().join(format!("eridian_mcphome_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"ctx":{"type":"http","url":"https://a.b/mcp"}},
                "projects":{"/p":{"mcpServers":{"local":{"command":"npx","args":["-y","x"]}}}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".config").join("opencode").join("opencode.jsonc"),
            r#"{ // jsonc
                "mcp": { "ch": { "type": "local", "command": ["uvx", "mcp-ch"] } } }"#,
        )
        .unwrap();

        let rows = scan_home(&home);
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"ctx")); // user http
        assert!(names.contains(&"local")); // project stdio
        assert!(names.contains(&"ch")); // opencode
        let ch = rows.iter().find(|r| r.name == "ch").unwrap();
        assert_eq!(ch.agent, "opencode");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn jsonc_comments_stripped_but_urls_kept() {
        let src = r#"{
          // a comment
          "mcp": { "x": { "type": "remote", "url": "https://a.b/c" } } /* trailing */
        }"#;
        let v: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(
            v.pointer("/mcp/x/url").and_then(Value::as_str),
            Some("https://a.b/c")
        );
    }
}
