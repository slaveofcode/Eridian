//! Managed install/uninstall of Eridian's OWN scoped `PreToolUse` hook entry in
//! `~/.claude/settings.json`. This is the single authorized exception to the
//! read-only-`~/.claude` guardrail: it touches ONLY our entry (identified by a
//! command that points at Eridian's guard hook), backs the file up first, and writes
//! atomically. It never touches transcripts/session data or any other settings key.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const MATCHER: &str = "Bash|Write|Edit|MultiEdit";

#[derive(Debug, PartialEq, Eq)]
pub enum HookStatus {
    Installed,
    NotInstalled,
    StalePath,
}

/// Ours = a hook command that points at Eridian's guard hook.
fn is_ours(cmd: &str) -> bool {
    cmd.contains("hook.mjs") && cmd.contains("eridian")
}

fn our_entry(command: &str) -> Value {
    json!({ "matcher": MATCHER, "hooks": [ { "type": "command", "command": command } ] })
}

fn group_is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(is_ours)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Splice our entry in (idempotent): drop any existing ours, add a fresh one.
/// Everything else in `settings` is preserved.
pub fn splice_hook(settings: &mut Value, command: &str) {
    if !settings.is_object() {
        *settings = json!({});
    }
    let obj = settings.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();
    let pre = hooks_obj.entry("PreToolUse").or_insert_with(|| json!([]));
    if !pre.is_array() {
        *pre = json!([]);
    }
    let arr = pre.as_array_mut().unwrap();
    arr.retain(|g| !group_is_ours(g));
    arr.push(our_entry(command));
}

/// Remove our entry (idempotent), pruning containers we created if left empty.
pub fn remove_hook(settings: &mut Value) {
    let Some(obj) = settings.as_object_mut() else {
        return;
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    if let Some(pre) = hooks.get_mut("PreToolUse").and_then(|p| p.as_array_mut()) {
        pre.retain(|g| !group_is_ours(g));
        if pre.is_empty() {
            hooks.remove("PreToolUse");
        }
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
}

/// Our hook's status vs the `expected` command.
pub fn hook_status(settings: &Value, expected: &str) -> HookStatus {
    let groups = settings
        .get("hooks")
        .and_then(|h| h.get("PreToolUse"))
        .and_then(|p| p.as_array());
    let Some(groups) = groups else {
        return HookStatus::NotInstalled;
    };
    let ours: Vec<&str> = groups
        .iter()
        .filter(|g| group_is_ours(g))
        .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
        .flatten()
        .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
        .filter(|c| is_ours(c))
        .collect();
    if ours.is_empty() {
        HookStatus::NotInstalled
    } else if ours.contains(&expected) {
        HookStatus::Installed
    } else {
        HookStatus::StalePath
    }
}

// ── IO wrappers ──────────────────────────────────────────────────────────────

fn read_settings(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn write_settings_atomic(path: &Path, v: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let tmp = path.with_extension("json.eridian-tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(v)?).context("write temp settings")?;
    fs::rename(&tmp, path).context("rename temp settings")?;
    Ok(())
}

fn backup(path: &Path, backup_dir: &Path) -> Result<()> {
    if path.exists() {
        fs::create_dir_all(backup_dir).ok();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        fs::copy(path, backup_dir.join(format!("settings-backup-{stamp}.json")))
            .context("backup settings")?;
    }
    Ok(())
}

/// Back up, splice our entry, write atomically.
pub fn install(settings_path: &Path, backup_dir: &Path, command: &str) -> Result<()> {
    backup(settings_path, backup_dir)?;
    let mut settings = read_settings(settings_path);
    splice_hook(&mut settings, command);
    write_settings_atomic(settings_path, &settings)
}

/// Back up, remove our entry, write atomically. No-op if the file doesn't exist.
pub fn uninstall(settings_path: &Path, backup_dir: &Path) -> Result<()> {
    if !settings_path.exists() {
        return Ok(());
    }
    backup(settings_path, backup_dir)?;
    let mut settings = read_settings(settings_path);
    remove_hook(&mut settings);
    write_settings_atomic(settings_path, &settings)
}

/// Read-only status check.
pub fn status(settings_path: &Path, expected: &str) -> HookStatus {
    hook_status(&read_settings(settings_path), expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "node /home/u/Library/Application Support/com.velmlabs.eridian/guard/src/hook.mjs";

    #[test]
    fn splice_is_idempotent_and_preserves_other_keys() {
        let mut s = json!({
            "model": "opus",
            "hooks": { "PreToolUse": [
                { "matcher": "Read", "hooks": [ { "type": "command", "command": "other-tool" } ] }
            ] }
        });
        splice_hook(&mut s, CMD);
        splice_hook(&mut s, CMD); // twice → still one of ours
        let arr = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "our entry added once, other entry preserved");
        assert_eq!(s["model"], json!("opus"), "unrelated keys preserved");
        assert_eq!(hook_status(&s, CMD), HookStatus::Installed);
    }

    #[test]
    fn remove_takes_only_ours() {
        let mut s = json!({
            "hooks": { "PreToolUse": [
                { "matcher": "Read", "hooks": [ { "type": "command", "command": "other-tool" } ] }
            ] }
        });
        splice_hook(&mut s, CMD);
        remove_hook(&mut s);
        let arr = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["hooks"][0]["command"], json!("other-tool"));
    }

    #[test]
    fn status_reports_stale_path() {
        let mut s = json!({});
        splice_hook(&mut s, "node /old/path/com.velmlabs.eridian/guard/src/hook.mjs");
        assert_eq!(hook_status(&s, CMD), HookStatus::StalePath);
    }

    #[test]
    fn status_not_installed_when_absent() {
        assert_eq!(hook_status(&json!({}), CMD), HookStatus::NotInstalled);
    }

    #[test]
    fn install_uninstall_roundtrip_on_disk_with_backup() {
        let dir = std::env::temp_dir().join(format!("guard-inst-{}", stamp()));
        fs::create_dir_all(&dir).unwrap();
        let settings = dir.join("settings.json");
        let backups = dir.join("backups");
        fs::write(&settings, r#"{"model":"opus"}"#).unwrap();

        install(&settings, &backups, CMD).unwrap();
        assert_eq!(status(&settings, CMD), HookStatus::Installed);
        // unrelated key preserved
        let v = read_settings(&settings);
        assert_eq!(v["model"], json!("opus"));
        // a backup exists
        assert!(fs::read_dir(&backups).unwrap().count() >= 1);

        uninstall(&settings, &backups).unwrap();
        assert_eq!(status(&settings, CMD), HookStatus::NotInstalled);
        assert_eq!(read_settings(&settings)["model"], json!("opus"));

        fs::remove_dir_all(&dir).ok();
    }

    fn stamp() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
