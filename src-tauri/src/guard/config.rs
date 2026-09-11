//! guard.json read/write. Eridian is the SOLE writer; the Node hook only reads it.
//! Stored as opaque JSON (the engine owns the schema) with a built-in default so a
//! fresh install is functional.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// Default config mirroring the engine's defaults (see guard/src/config.mjs).
pub fn default_config() -> Value {
    json!({
        "version": 1,
        "enabled": true,
        "strictFailClosed": false,
        "promptOnCatch": false,
        "sizeCap": 262144,
        "decisions": [],
        "actions": {
            "secrets": "block",
            "pii": "warn",
            "exfiltration": "block",
            "dangerous": "warn",
            "commitIdentity": "block",
            "aiAuthorship": "block"
        },
        "denyList": { "workEmails": [], "workDomains": [], "workTerms": [] },
        "privateRemotes": [],
        "allowlists": { "paths": [], "patterns": [] }
    })
}

fn config_path(guard_dir: &Path) -> std::path::PathBuf {
    guard_dir.join("guard.json")
}

/// Read guard.json merged onto the defaults, so an older/partial file (e.g. one
/// written before `decisions`/`promptOnCatch` existed) still yields a COMPLETE
/// config — otherwise the UI crashes on a missing key. Missing/unparseable → defaults.
pub fn read_config(guard_dir: &Path) -> Value {
    let stored = fs::read_to_string(config_path(guard_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let mut cfg = default_config();
    if let Some(Value::Object(overlay)) = stored {
        merge_into(&mut cfg, &overlay);
    }
    cfg
}

/// Overlay `overlay` onto `base` in place: nested objects are deep-merged (so a
/// partial `actions` still keeps default categories); scalars/arrays are replaced.
fn merge_into(base: &mut Value, overlay: &serde_json::Map<String, Value>) {
    let Some(b) = base.as_object_mut() else { return };
    for (k, v) in overlay {
        match (b.get_mut(k), v) {
            (Some(existing @ Value::Object(_)), Value::Object(ov)) => {
                merge_into(existing, ov);
            }
            _ => {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Write guard.json atomically (temp file + rename), creating the guard dir.
pub fn write_config(guard_dir: &Path, cfg: &Value) -> Result<()> {
    fs::create_dir_all(guard_dir).context("create guard dir")?;
    let path = config_path(guard_dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(cfg)?).context("write temp config")?;
    fs::rename(&tmp, &path).context("rename temp config")?;
    Ok(())
}

/// Append a remembered decision (replacing any existing one with the same scope+key
/// so the latest choice wins). Mutates `cfg.decisions` in place.
pub fn append_decision(cfg: &mut Value, scope: &str, key: &str, action: &str) {
    let arr = match cfg.get_mut("decisions").and_then(|d| d.as_array_mut()) {
        Some(a) => a,
        None => {
            cfg["decisions"] = json!([]);
            cfg["decisions"].as_array_mut().unwrap()
        }
    };
    arr.retain(|d| !(d.get("scope") == Some(&json!(scope)) && d.get("key") == Some(&json!(key))));
    arr.push(json!({ "scope": scope, "key": key, "action": action }));
}

/// Remove a remembered decision by scope+key. No-op if absent.
pub fn remove_decision(cfg: &mut Value, scope: &str, key: &str) {
    if let Some(arr) = cfg.get_mut("decisions").and_then(|d| d.as_array_mut()) {
        arr.retain(|d| {
            !(d.get("scope") == Some(&json!(scope)) && d.get("key") == Some(&json!(key)))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_include_prompt_and_decisions() {
        let c = default_config();
        assert_eq!(c["promptOnCatch"], json!(false));
        assert_eq!(c["decisions"], json!([]));
    }

    #[test]
    fn append_decision_dedups_by_scope_key() {
        let mut c = default_config();
        append_decision(&mut c, "exact", "abc", "allow");
        append_decision(&mut c, "exact", "abc", "block"); // same scope+key → replace
        append_decision(&mut c, "rule", "secrets:openai", "allow");
        let arr = c["decisions"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["action"], json!("block")); // latest wins for exact/abc
        remove_decision(&mut c, "exact", "abc");
        assert_eq!(c["decisions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn partial_stored_config_is_merged_onto_defaults() {
        let dir = std::env::temp_dir().join(format!("guard-merge-{}", unique()));
        std::fs::create_dir_all(&dir).unwrap();
        // An old file: no `decisions`, no `promptOnCatch`, and a partial `actions`.
        std::fs::write(
            config_path(&dir),
            r#"{ "enabled": false, "actions": { "pii": "block" } }"#,
        )
        .unwrap();
        let c = read_config(&dir);
        assert_eq!(c["enabled"], json!(false)); // stored value kept
        assert_eq!(c["actions"]["pii"], json!("block")); // stored override kept
        assert_eq!(c["actions"]["secrets"], json!("block")); // default filled in
        assert_eq!(c["decisions"], json!([])); // missing key → default (was the crash)
        assert_eq!(c["promptOnCatch"], json!(false)); // missing key → default
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_config_returns_default() {
        let dir = tempdir();
        let cfg = read_config(&dir);
        assert_eq!(cfg["enabled"], json!(true));
        assert_eq!(cfg["actions"]["secrets"], json!("block"));
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempdir();
        let mut cfg = default_config();
        cfg["enabled"] = json!(false);
        cfg["actions"]["pii"] = json!("block");
        write_config(&dir, &cfg).unwrap();
        let got = read_config(&dir);
        assert_eq!(got["enabled"], json!(false));
        assert_eq!(got["actions"]["pii"], json!("block"));
    }

    fn tempdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("guard-cfg-{}", unique()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn unique() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }
}
