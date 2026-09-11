//! Ingest the hook's `findings.ndjson` into the `security_findings` table (byte-offset
//! tail, like the transcript ingester) and install the bundled engine into app-data.

use anyhow::{Context, Result};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::commands::SecurityFindingRow;
use crate::store::Store;

const FINDINGS_SOURCE: &str = "guard:findings";

/// Tail findings.ndjson from the stored offset, insert complete new lines (INSERT OR
/// IGNORE dedups), and advance the offset. Malformed lines are skipped, not fatal.
pub fn ingest_findings(store: &Store, path: &Path) -> Result<usize> {
    let offset = store.get_offset(FINDINGS_SOURCE)?;
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(0),
    };
    let len = f.metadata()?.len();
    if len < offset {
        store.set_offset(FINDINGS_SOURCE, 0)?; // truncated/rotated → restart
        return Ok(0);
    }
    if len == offset {
        return Ok(0);
    }
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => return Ok(0), // no complete line yet
    };

    let mut inserted = 0usize;
    for line in buf[..consumed].split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(line);
        match serde_json::from_str::<SecurityFindingRow>(&s) {
            Ok(row) => {
                if store.insert_finding(&row).unwrap_or(false) {
                    inserted += 1;
                }
            }
            Err(_) => tracing::warn!("guard: skipping unparseable findings line"),
        }
    }
    store.set_offset(FINDINGS_SOURCE, offset + consumed as u64)?;
    Ok(inserted)
}

/// Copy the bundled engine (`src/**.mjs`) into the app-data guard dir and ensure a
/// default guard.json exists. Idempotent; engine files are always refreshed (Eridian
/// is the source of truth for the rules).
pub fn install_engine(resource_guard: &Path, guard_dir: &Path) -> Result<()> {
    let dest_src = guard_dir.join("src");
    fs::create_dir_all(&dest_src).context("create guard/src")?;
    copy_mjs_recursive(&resource_guard.join("src"), &dest_src)?;
    if !guard_dir.join("guard.json").exists() {
        crate::guard::config::write_config(guard_dir, &crate::guard::config::default_config())?;
    }
    Ok(())
}

fn copy_mjs_recursive(from: &Path, to: &Path) -> Result<()> {
    if !from.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let p = entry.path();
        let dest = to.join(entry.file_name());
        if p.is_dir() {
            fs::create_dir_all(&dest).ok();
            copy_mjs_recursive(&p, &dest)?;
        } else if p.extension().and_then(|e| e.to_str()) == Some("mjs") {
            fs::copy(&p, &dest).with_context(|| format!("copy {}", p.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn tmp(prefix: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn finding_line(id: &str, category: &str) -> String {
        format!(
            r#"{{"id":"{id}","ts":"2026-01-01T00:00:00Z","sessionId":"s1","category":"{category}","severity":"high","action":"block","rule":"r","maskedPreview":"sk-…1234"}}"#
        )
    }

    #[test]
    fn ingest_inserts_new_lines_and_advances_offset() {
        let store = Store::open_in_memory().unwrap();
        let dir = tmp("guard-find");
        let path = dir.join("findings.ndjson");
        fs::write(&path, format!("{}\n{}\n", finding_line("a", "secrets"), finding_line("b", "pii"))).unwrap();

        assert_eq!(ingest_findings(&store, &path).unwrap(), 2);
        assert_eq!(ingest_findings(&store, &path).unwrap(), 0); // offset advanced

        // append one more → only it is ingested; dedup keeps ids unique
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        writeln!(f, "{}", finding_line("c", "dangerous")).unwrap();
        assert_eq!(ingest_findings(&store, &path).unwrap(), 1);

        let rows = store.list_findings(50).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.status == "open"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let store = Store::open_in_memory().unwrap();
        let dir = tmp("guard-bad");
        let path = dir.join("findings.ndjson");
        fs::write(&path, format!("not json\n{}\n", finding_line("ok", "secrets"))).unwrap();
        assert_eq!(ingest_findings(&store, &path).unwrap(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_engine_copies_mjs_and_writes_default_config() {
        let res = tmp("guard-res");
        fs::create_dir_all(res.join("src/detectors")).unwrap();
        fs::write(res.join("src/hook.mjs"), "// hook").unwrap();
        fs::write(res.join("src/detectors/secrets.mjs"), "// secrets").unwrap();
        fs::write(res.join("src/notes.txt"), "ignore me").unwrap();

        let gdir = tmp("guard-dest");
        install_engine(&res, &gdir).unwrap();

        assert!(gdir.join("src/hook.mjs").exists());
        assert!(gdir.join("src/detectors/secrets.mjs").exists());
        assert!(!gdir.join("src/notes.txt").exists(), "non-mjs not copied");
        assert!(gdir.join("guard.json").exists(), "default config written");
        fs::remove_dir_all(&res).ok();
        fs::remove_dir_all(&gdir).ok();
    }
}
