//! Read-only git access for the FileViewer "time machine": list the commits that
//! touched a file, and read the file's content at any of them.
//!
//! Guardrail: only `git rev-parse` / `git log` / `git show` are ever run, via
//! `std::process::Command` with `git -C <dir>` — never a shell, never a mutating
//! subcommand. This reads the user's repo; it never writes to it.

use crate::commands::{FileCommit, FileContent};
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_CONTENT: usize = 500_000; // matches read_file
const MAX_COMMITS: usize = 30;

/// Resolve the git repo root containing `path` and the path relative to it.
/// Returns None if `path` isn't inside a git work tree (or git is unavailable).
fn repo_and_relpath(path: &str) -> Option<(PathBuf, String)> {
    let p = Path::new(path);
    let dir = p.parent()?;
    let fname = p.file_name()?.to_string_lossy().to_string();
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // git returns the real (canonical) toplevel; canonicalize the file's dir too
    // so strip_prefix matches (e.g. macOS /var → /private/var symlink).
    let repo = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let real_dir = std::fs::canonicalize(dir).ok()?;
    let rel_dir = real_dir.strip_prefix(&repo).ok()?;
    let rel = if rel_dir.as_os_str().is_empty() {
        fname
    } else {
        format!("{}/{}", rel_dir.to_string_lossy(), fname)
    };
    Some((repo, rel))
}

/// Commits that touched `path`, newest first (capped). Empty on any error — the
/// UI simply hides the history control when there's nothing to show.
pub fn file_history(path: &str) -> Vec<FileCommit> {
    let Some((repo, rel)) = repo_and_relpath(path) else {
        return Vec::new();
    };
    // \x1f (unit separator) between fields — safe against subjects containing
    // spaces/pipes; one commit per line.
    let fmt = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["log", &format!("-n{MAX_COMMITS}"), &format!("--format={fmt}"), "--"])
        .arg(&rel)
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\u{1f}');
            Some(FileCommit {
                sha: f.next()?.to_string(),
                short_sha: f.next()?.to_string(),
                author: f.next()?.to_string(),
                date: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn valid_sha(sha: &str) -> bool {
    !sha.is_empty()
        && sha.len() <= 40
        && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The file's content at commit `sha` (read-only `git show`). Size-capped like
/// read_file. Errors (bad sha, commit gone, path absent at that commit) bubble
/// up so the viewer's FileError state can explain it.
pub fn file_at_commit(path: &str, sha: &str) -> Result<FileContent> {
    if !valid_sha(sha) {
        return Err(anyhow!("invalid commit id"));
    }
    let (repo, rel) = repo_and_relpath(path)
        .ok_or_else(|| anyhow!("not a git repository: {path}"))?;
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .arg("show")
        .arg(format!("{sha}:{rel}"))
        .output()
        .map_err(|e| anyhow!("git show failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("{}", err.trim()));
    }
    let mut buf = out.stdout;
    let size = buf.len() as i64;
    let truncated = buf.len() > MAX_CONTENT;
    buf.truncate(MAX_CONTENT);
    let short = &sha[..sha.len().min(8)];
    Ok(FileContent {
        path: format!("{path}@{short}"),
        content: String::from_utf8_lossy(&buf).to_string(),
        size_bytes: size,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git")
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn history_and_at_commit_roundtrip() {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let repo = std::env::temp_dir().join(format!("eridian_git_{}_{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "t@t"]);
        git(&repo, &["config", "user.name", "t"]);
        let file = repo.join("a.txt");
        std::fs::write(&file, "version one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        std::fs::write(&file, "version two\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "second"]);

        let path = file.to_string_lossy().to_string();
        let hist = file_history(&path);
        assert_eq!(hist.len(), 2, "two commits touched the file");
        assert_eq!(hist[0].subject, "second"); // newest first

        // file at the OLDER commit shows the first version
        let old = &hist[1];
        let fc = file_at_commit(&path, &old.sha).unwrap();
        assert_eq!(fc.content, "version one\n");
        assert!(fc.path.contains(&old.short_sha[..7.min(old.short_sha.len())]));

        // bad sha / non-repo → error / empty
        assert!(file_at_commit(&path, "zzzz").is_err());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn non_repo_returns_empty_history() {
        let p = std::env::temp_dir().join("eridian_nonrepo_zzz/x.txt");
        assert!(file_history(&p.to_string_lossy()).is_empty());
    }
}
