//! Pure helpers over shell tool-call events. No DB, no I/O — unit-tested.

use serde_json::Value;

/// True for the shell-running tools across both agents.
pub fn is_shell_tool(tool_name: &str) -> bool {
    matches!(tool_name.to_lowercase().as_str(), "bash" | "shell" | "run")
}

/// Extract the command string from a tool_call input JSON.
pub fn command_of(tool_input_json: Option<&str>) -> Option<String> {
    let v: Value = serde_json::from_str(tool_input_json?).ok()?;
    for k in ["command", "cmd", "script"] {
        if let Some(s) = v.get(k).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Whole seconds between two ISO-8601 timestamps, if both parse and end ≥ start.
pub fn duration_secs(start_iso: Option<&str>, end_iso: Option<&str>) -> Option<i64> {
    use chrono::{DateTime, Utc};
    let s = start_iso?.parse::<DateTime<Utc>>().ok()?;
    let e = end_iso?.parse::<DateTime<Utc>>().ok()?;
    let d = (e - s).num_seconds();
    (d >= 0).then_some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_tools_matched_case_insensitively() {
        for t in ["bash", "Bash", "SHELL", "run"] {
            assert!(is_shell_tool(t), "{t}");
        }
        for t in ["read", "write", "grep"] {
            assert!(!is_shell_tool(t), "{t}");
        }
    }

    #[test]
    fn command_extracted_from_variants() {
        assert_eq!(command_of(Some(r#"{"command":"git status"}"#)).as_deref(), Some("git status"));
        assert_eq!(command_of(Some(r#"{"script":"ls -la"}"#)).as_deref(), Some("ls -la"));
        assert_eq!(command_of(Some(r#"{"other":"x"}"#)), None);
        assert_eq!(command_of(Some("not json")), None);
        assert_eq!(command_of(None), None);
    }

    #[test]
    fn duration_computed_and_guarded() {
        assert_eq!(
            duration_secs(Some("2026-08-11T00:00:00Z"), Some("2026-08-11T00:00:03Z")),
            Some(3)
        );
        // end before start → None (never a negative duration)
        assert_eq!(
            duration_secs(Some("2026-08-11T00:00:05Z"), Some("2026-08-11T00:00:00Z")),
            None
        );
        assert_eq!(duration_secs(Some("bad"), Some("2026-08-11T00:00:00Z")), None);
        assert_eq!(duration_secs(None, None), None);
    }
}
