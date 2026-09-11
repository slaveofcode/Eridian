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
        "sizeCap": 262144,
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

/// Read guard.json, or the default if it's missing/unparseable.
pub fn read_config(guard_dir: &Path) -> Value {
    match fs::read_to_string(config_path(guard_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| default_config()),
        Err(_) => default_config(),
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

#[cfg(test)]
mod tests {
    use super::*;

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
