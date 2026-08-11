//! Eridian — local read-only dashboard for coding-agent sessions.
//! See CLAUDE.md for guardrails (read-only against agent data, never crash the
//! ingest loop, transcripts are sensitive → no bodies in logs, DB 0600).

mod catalog;
mod commands;
mod git_history;
mod ingest;
mod inspect;
mod mcp_config;
mod normalize;
mod shell;
mod skills_config;
mod store;

use anyhow::Context;
use tauri::Manager;

/// Current time as an ISO-8601 UTC string — the single timestamp format used
/// everywhere in the DB.
pub fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logs carry paths/counts/offsets only — never transcript bodies.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "eridian=info,warn".into()),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let store = open_store(app).context("open eridian store")?;
            store.attach_emitter(app.handle().clone());
            app.manage(store.clone());
            app.manage(commands::OpenCodeProc::default());
            let store_cc = store.clone();

            // Claude Code ingest runs on a dedicated thread: the fs watcher must
            // outlive setup(), and the drain loop blocks. A panic here must never
            // take down the app — log and let the UI keep serving the DB.
            std::thread::Builder::new()
                .name("cc-ingest".into())
                .spawn(move || {
                    if let Err(e) = ingest::claude_code::run(store_cc) {
                        tracing::error!("claude_code ingest stopped: {e:#}");
                    }
                })
                .context("spawn cc-ingest thread")?;

            // OpenCode cold-import (from local opencode.db) is NOT run
            // automatically — it's user-confirmed via the UI when the server is
            // down (commands::opencode_cold_status / opencode_cold_import).

            // OpenCode ingest: async task (health + bootstrap + SSE re-pull).
            ingest::opencode::spawn(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::session_events,
            commands::ingest_status,
            commands::usage_by_day,
            commands::opencode_cold_status,
            commands::opencode_cold_import,
            commands::session_changes,
            commands::session_subagents,
            commands::subagent_parents,
            commands::session_activity,
            commands::session_skills,
            commands::search_events,
            commands::list_mcp_servers,
            commands::list_skills,
            commands::market_catalog,
            commands::market_refresh,
            commands::skills_audit,
            commands::mcp_audit,
            commands::running_commands,
            commands::command_history,
            commands::command_output,
            commands::read_file,
            commands::read_image,
            commands::file_history,
            commands::file_at_commit,
            commands::start_opencode,
            commands::stop_opencode,
            commands::opencode_logs,
            commands::opencode_managed,
            commands::force_kill_opencode,
            commands::db_info,
            commands::get_settings,
            commands::set_settings,
            commands::rebuild_db,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the opencode child we started so it doesn't outlive Eridian.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(proc) = app.try_state::<commands::OpenCodeProc>() {
                    proc.kill_child();
                }
            }
        });
}

fn open_store(app: &tauri::App) -> anyhow::Result<store::Store> {
    let dir = app
        .path()
        .app_data_dir()
        .context("resolve app_data_dir")?;
    let db_path = dir.join("eridian.db");
    let s = store::Store::open(&db_path)?;
    tracing::info!(dir = %dir.display(), "opened eridian db");
    if let Ok(st) = s.ingest_status() {
        tracing::info!(cc_files = st.claude_code_files, "ingest status at boot");
    }
    Ok(s)
}
