//! Interactive-prompt handshake (Eridian side). The hook drops a request in
//! `guard/prompt/pending/`; a watcher acks it (so the hook knows Eridian is alive),
//! emits it to the UI, and floats the window to the front. The `guard_prompt_respond`
//! command then writes `response/<id>.json` (atomically) which unblocks the hook.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub fn prompt_dir(guard_dir: &Path) -> PathBuf {
    guard_dir.join("prompt")
}

/// Ack a pending request so the hook keeps waiting (vs. falling back to a block).
pub fn write_ack(pdir: &Path, id: &str) -> Result<()> {
    let d = pdir.join("ack");
    fs::create_dir_all(&d).ok();
    fs::write(d.join(format!("{id}.json")), b"{}").context("write ack")?;
    Ok(())
}

/// Write the user's decision atomically (temp + rename) so the hook never reads a
/// half-written file.
pub fn write_response(pdir: &Path, id: &str, action: &str) -> Result<()> {
    let d = pdir.join("response");
    fs::create_dir_all(&d).ok();
    let tmp = d.join(format!("{id}.json.tmp"));
    let dst = d.join(format!("{id}.json"));
    fs::write(&tmp, serde_json::to_vec(&json!({ "id": id, "action": action }))?)?;
    fs::rename(&tmp, &dst).context("write response")?;
    Ok(())
}

/// Poll `pending/` for new requests: ack, emit to the UI, and raise the window.
/// Best-effort; never panics the thread.
pub fn spawn_watcher(app: tauri::AppHandle, guard_dir: PathBuf) {
    std::thread::Builder::new()
        .name("guard-prompt".into())
        .spawn(move || {
            let pdir = prompt_dir(&guard_dir);
            let pending = pdir.join("pending");
            let mut seen: HashSet<String> = HashSet::new();
            loop {
                if let Ok(entries) = fs::read_dir(&pending) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) != Some("json") {
                            continue;
                        }
                        let id = match path.file_stem().and_then(|s| s.to_str()) {
                            Some(s) => s.to_string(),
                            None => continue,
                        };
                        if seen.contains(&id) {
                            continue;
                        }
                        if let Ok(txt) = fs::read_to_string(&path) {
                            if let Ok(req) = serde_json::from_str::<Value>(&txt) {
                                let _ = write_ack(&pdir, &id);
                                let _ = app.emit("eridian://guard-prompt", &req);
                                raise_window(&app);
                                seen.insert(id);
                            }
                        }
                    }
                }
                // forget ids whose pending file is gone, so a later reuse re-emits
                seen.retain(|id| pending.join(format!("{id}.json")).exists());
                std::thread::sleep(Duration::from_millis(250));
            }
        })
        .ok();
}

/// Float the main window above everything and focus it — the "interrupt".
pub fn raise_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

/// Release always-on-top once the prompt is resolved.
pub fn lower_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_and_response_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "guard-prompt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let pdir = prompt_dir(&dir);
        write_ack(&pdir, "id1").unwrap();
        assert!(pdir.join("ack/id1.json").exists());
        write_response(&pdir, "id1", "allow").unwrap();
        let body = fs::read_to_string(pdir.join("response/id1.json")).unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["action"], json!("allow"));
        assert_eq!(v["id"], json!("id1"));
        fs::remove_dir_all(&dir).ok();
    }
}
