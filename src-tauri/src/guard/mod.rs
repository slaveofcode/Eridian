//! Security-guard integration: Eridian controls + reviews the standalone Node
//! detection engine (bundled under `guard/`, copied to app-data at runtime). Eridian
//! writes ONLY its own app-data guard dir and — the one authorized exception to the
//! read-only-against-`~/.claude` guardrail — its own scoped `PreToolUse` entry in
//! `~/.claude/settings.json` (see `install`). Transcripts/sessions are never written.

pub mod config;
pub mod findings;
pub mod install;
pub mod remediation;

use std::path::{Path, PathBuf};

/// The guard subdir inside Eridian's app-data dir (holds the copied engine,
/// `guard.json`, and `findings.ndjson`).
pub fn guard_dir(app_data: &Path) -> PathBuf {
    app_data.join("guard")
}

/// The command Claude Code should run for the hook: `node <app_data>/guard/src/hook.mjs`.
pub fn hook_command(app_data: &Path) -> String {
    let hook = guard_dir(app_data).join("src").join("hook.mjs");
    format!("node {}", hook.display())
}
