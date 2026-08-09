//! MCP-kind catalog logic: normalize the official MCP Registry, heuristic lint,
//! and copyable install/remove advisor. Parses the real registry shape:
//! `{ "servers": [ { "server": { name, description, version, packages[], remotes[] }, "_meta": … } ] }`.
//! Tolerant — malformed entries are skipped, never panic.

use crate::catalog::{CatalogFlag, CatalogItem, InstallCommand};
use serde_json::Value;

/// Normalize a `/v0/servers` registry response into catalog items.
pub fn normalize_registry(body: &str) -> Vec<CatalogItem> {
    let Ok(root) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(servers) = root.get("servers").and_then(|s| s.as_array()) {
        for entry in servers {
            // Each entry wraps the server under `server`; tolerate a flat entry too.
            let s = entry.get("server").unwrap_or(entry);
            if let Some(item) = normalize_one(s) {
                out.push(item);
            } else {
                tracing::warn!("skipping malformed MCP registry entry");
            }
        }
    }
    out
}

fn normalize_one(s: &Value) -> Option<CatalogItem> {
    let name = s.get("name").and_then(|v| v.as_str())?.to_string();
    let description = s
        .get("description")
        .or_else(|| s.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let base_version = s.get("version").and_then(|v| v.as_str()).map(str::to_string);

    let pkg = s
        .get("packages")
        .and_then(|p| p.as_array())
        .and_then(|a| a.first());

    let (package_kind, identifier, pkg_version, transport, env_names) = if let Some(p) = pkg {
        let reg = p.get("registryType").and_then(|v| v.as_str()).unwrap_or("");
        let kind = match reg {
            "oci" | "docker" => "docker",
            "pypi" => "pypi",
            "npm" => "npm",
            other => other,
        };
        let id = p.get("identifier").and_then(|v| v.as_str()).map(str::to_string);
        let pv = p.get("version").and_then(|v| v.as_str()).map(str::to_string);
        let tr = p
            .get("transport")
            .and_then(|t| t.get("type"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let env: Vec<String> = p
            .get("environmentVariables")
            .and_then(|e| e.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| e.get("name").and_then(|v| v.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        (Some(kind.to_string()), id, pv, tr, env)
    } else if let Some(r) = s
        .get("remotes")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
    {
        let url = r.get("url").and_then(|v| v.as_str()).map(str::to_string);
        let tr = r.get("type").and_then(|v| v.as_str()).map(str::to_string);
        (Some("remote".to_string()), url, None, tr, Vec::new())
    } else {
        (None, None, None, None, Vec::new())
    };

    let version = pkg_version.or(base_version);
    let homepage = s
        .get("repository")
        .and_then(|r| r.get("url"))
        .and_then(|v| v.as_str())
        .or_else(|| s.get("websiteUrl").and_then(|v| v.as_str()))
        .map(str::to_string);

    let mut item = CatalogItem {
        kind: "mcpServer".into(),
        source_id: "remote:mcp-registry".into(),
        source_label: "MCP Registry".into(),
        name,
        description,
        version,
        agents: vec!["claude-code".into(), "opencode".into()],
        installed: false,
        plugin: None,
        content_hash: None,
        readme_excerpt: None,
        package_kind,
        identifier,
        transport,
        homepage,
        flags: Vec::new(),
        install_commands: Vec::new(),
    };

    // Credential-env detection needs the raw entry → done here, not in lint_mcp.
    if env_names.iter().any(|n| {
        let u = n.to_uppercase();
        u.contains("KEY") || u.contains("TOKEN") || u.contains("SECRET") || u.contains("PASSWORD")
    }) {
        item.flags.push(CatalogFlag {
            severity: "notable".into(),
            reason: "requires credential env vars".into(),
        });
    }
    Some(item)
}

/// Heuristic lint over the CatalogItem-derivable fields. (Credential-env flags
/// are attached during normalization, which has the raw entry.)
pub fn lint_mcp(item: &CatalogItem) -> Vec<CatalogFlag> {
    let mut flags = Vec::new();
    let pkgish = matches!(item.package_kind.as_deref(), Some("npm" | "pypi" | "docker"));
    let unpinned = item
        .version
        .as_deref()
        .map(|v| v.eq_ignore_ascii_case("latest"))
        .unwrap_or(true);
    if pkgish && unpinned {
        flags.push(CatalogFlag {
            severity: "notable".into(),
            reason: "unpinned version (latest) — pin a specific version".into(),
        });
    }
    if item.package_kind.as_deref() == Some("remote") {
        flags.push(CatalogFlag {
            severity: "info".into(),
            reason: "third-party remote endpoint".into(),
        });
    }
    if item.transport.as_deref() == Some("stdio") {
        let shellish = item
            .identifier
            .as_deref()
            .map(|id| id.contains("sh -c") || id.contains("bash -c") || id.contains("curl ") || id.contains('|'))
            .unwrap_or(false);
        if shellish {
            flags.push(CatalogFlag {
                severity: "danger".into(),
                reason: "runs an arbitrary local shell command".into(),
            });
        } else {
            flags.push(CatalogFlag {
                severity: "info".into(),
                reason: "runs as a local process (stdio)".into(),
            });
        }
    }
    flags
}

/// Copyable install/remove commands. Eridian never runs them.
pub fn mcp_commands(item: &CatalogItem) -> Vec<InstallCommand> {
    let short = item.name.rsplit('/').next().unwrap_or(&item.name).to_string();
    let id = item.identifier.clone().unwrap_or_default();

    let cc = |action: &str, command: String| InstallCommand {
        agent: "claude-code".into(),
        action: action.into(),
        command,
    };
    let add = |run: String| cc("install", format!("claude mcp add {short} -- {run}"));

    let mut cmds = Vec::new();
    match item.package_kind.as_deref() {
        Some("npm") => cmds.push(add(format!("npx -y {id}"))),
        Some("pypi") => cmds.push(add(format!("uvx {id}"))),
        Some("docker") => cmds.push(add(format!("docker run -i --rm {id}"))),
        Some("remote") => cmds.push(cc(
            "install",
            format!("claude mcp add --transport http {short} {id}"),
        )),
        _ => {}
    }
    cmds.push(cc("remove", format!("claude mcp remove {short}")));

    let oc_command: Vec<&str> = match item.package_kind.as_deref() {
        Some("npm") => vec!["npx", "-y"],
        Some("pypi") => vec!["uvx"],
        Some("docker") => vec!["docker", "run", "-i", "--rm"],
        _ => vec![],
    };
    let oc_snippet = if item.package_kind.as_deref() == Some("remote") {
        format!(r#""mcp": {{ "{short}": {{ "type": "remote", "url": "{id}" }} }}"#)
    } else {
        let mut parts: Vec<String> = oc_command.iter().map(|s| format!("\"{s}\"")).collect();
        parts.push(format!("\"{id}\""));
        format!(
            r#""mcp": {{ "{short}": {{ "type": "local", "command": [{}] }} }}"#,
            parts.join(",")
        )
    };
    cmds.push(InstallCommand {
        agent: "opencode".into(),
        action: "install".into(),
        command: oc_snippet,
    });
    cmds
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npm_item(name: &str, id: &str, version: Option<&str>) -> CatalogItem {
        CatalogItem {
            kind: "mcpServer".into(),
            source_id: "remote:mcp-registry".into(),
            source_label: "MCP Registry".into(),
            name: name.into(),
            description: String::new(),
            version: version.map(|s| s.to_string()),
            agents: Vec::new(),
            installed: false,
            plugin: None,
            content_hash: None,
            readme_excerpt: None,
            package_kind: Some("npm".into()),
            identifier: Some(id.into()),
            transport: Some("stdio".into()),
            homepage: None,
            flags: Vec::new(),
            install_commands: Vec::new(),
        }
    }

    #[test]
    fn registry_fixture_normalizes() {
        let body = include_str!("../../fixtures/market/mcp_registry.json");
        let items = normalize_registry(body);
        assert!(!items.is_empty());
        let i = &items[0];
        assert_eq!(i.kind, "mcpServer");
        assert_eq!(i.source_id, "remote:mcp-registry");
        assert!(i.package_kind.is_some() || i.transport.is_some());
    }

    #[test]
    fn registry_malformed_entries_are_skipped() {
        let items = normalize_registry(
            r#"{"servers":[{"server":{"name":"ok/x","description":"d"}},{"server":{"nope":1}}]}"#,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "ok/x");
    }

    #[test]
    fn normalize_flags_credential_env() {
        let body = r#"{"servers":[{"server":{
            "name":"acme/db","description":"d",
            "packages":[{"registryType":"npm","identifier":"acme-db","version":"1.0.0",
              "transport":{"type":"stdio"},
              "environmentVariables":[{"name":"DB_API_KEY"}]}]
        }}]}"#;
        let items = normalize_registry(body);
        assert!(items[0]
            .flags
            .iter()
            .any(|f| f.reason.contains("credential")));
    }

    #[test]
    fn mcp_lint_flags_unpinned() {
        let latest = npm_item("acme/x", "acme-x", Some("latest"));
        assert!(lint_mcp(&latest)
            .iter()
            .any(|f| f.reason.contains("unpinned")));
        let none = npm_item("acme/x", "acme-x", None);
        assert!(lint_mcp(&none).iter().any(|f| f.reason.contains("unpinned")));
        let pinned = npm_item("acme/x", "acme-x", Some("1.2.3"));
        assert!(!lint_mcp(&pinned).iter().any(|f| f.reason.contains("unpinned")));
    }

    #[test]
    fn mcp_advisor_emits_claude_cli_and_opencode_snippet() {
        let cmds = mcp_commands(&npm_item("x", "@x/server", Some("1.0.0")));
        assert!(cmds
            .iter()
            .any(|c| c.agent == "claude-code"
                && c.action == "install"
                && c.command == "claude mcp add x -- npx -y @x/server"));
        assert!(cmds
            .iter()
            .any(|c| c.agent == "opencode" && c.command.contains("\"mcp\"")));
        assert!(cmds
            .iter()
            .any(|c| c.action == "remove" && c.command == "claude mcp remove x"));
    }
}
