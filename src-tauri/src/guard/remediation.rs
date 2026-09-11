//! Pure remediation suggestions per finding category (tiers 1-2: guidance + copyable
//! commands). Eridian never applies these itself — it hands them to you / your coding
//! agent, then a re-scan confirms resolution.
//!
//! NOTE: no literal email addresses in this source — the public-repo scrubber rewrites
//! `local@domain` literals. Noreply addresses are described in prose instead.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remediation {
    pub guidance: String,
    pub commands: Vec<String>,
}

fn r(guidance: &str, commands: &[&str]) -> Remediation {
    Remediation {
        guidance: guidance.to_string(),
        commands: commands.iter().map(|c| c.to_string()).collect(),
    }
}

/// Guidance + copyable fixes for a finding.
pub fn remediation_for(category: &str, _rule: &str) -> Remediation {
    match category {
        "secrets" => r(
            "Rotate the exposed key with its provider, remove the literal, and reference \
             it via an environment variable instead. If it was committed, purge it from \
             history and rotate again.",
            &[
                "echo '.env' >> .gitignore",
                "git filter-repo --path <file-with-secret> --invert-paths   # then force-push + rotate",
            ],
        ),
        "commitIdentity" => r(
            "Use a non-work identity for public repos: set a repo-local GitHub noreply \
             address (from your GitHub email settings). If the leaking commit is unpushed, \
             amend its author.",
            &[
                "git config user.email <your GitHub noreply address>",
                "git commit --amend --reset-author --no-edit   # unpushed commits only",
            ],
        ),
        "aiAuthorship" => r(
            "Strip the AI-attribution trailer from the commit message, then add a \
             commit-msg guard so it can't recur.",
            &[
                "git commit --amend --no-edit   # after removing the trailer from the message",
                "git rebase -i <base>           # to strip it from multiple commits",
            ],
        ),
        "pii" => r(
            "Remove or redact the personal data; move it to a secure store, or replace it \
             with an obvious fake value in fixtures.",
            &[],
        ),
        "exfiltration" => r(
            "Never send secrets/PII off-machine. If it already happened, treat it as an \
             incident: rotate any exposed credentials and review exactly what was sent.",
            &[],
        ),
        "dangerous" => r(
            "Re-check the command's blast radius before running it: prefer scoped paths, \
             don't pipe remote scripts into a shell, and don't disable TLS verification.",
            &[],
        ),
        _ => r("Review this finding and remediate as appropriate.", &[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_category_has_guidance() {
        for cat in [
            "secrets",
            "pii",
            "exfiltration",
            "dangerous",
            "commitIdentity",
            "aiAuthorship",
            "unknown-x",
        ] {
            let rem = remediation_for(cat, "rule");
            assert!(!rem.guidance.is_empty(), "guidance for {cat}");
        }
    }

    #[test]
    fn secrets_and_commit_offer_commands() {
        assert!(!remediation_for("secrets", "openai").commands.is_empty());
        assert!(!remediation_for("commitIdentity", "x").commands.is_empty());
    }
}
