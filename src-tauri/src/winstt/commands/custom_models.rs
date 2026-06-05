// Source (authoritative):
// frontend/electron/ipc/custom-models.ts + docs/archive/port/10_frontend_port_plan.md §6 (WU-11).
//
// The Settings → Models "Open custom-models folder" button sends
// `CUSTOM_MODELS_OPEN_FOLDER`. The adapter (native-bridge-adapter.ts) routes it as
// `{ kind: "plugin", plugin: "opener:custom-models" }`, whose handler INVOKES the
// Tauri command `open_custom_models_folder`, then hands the returned absolute path
// to `@tauri-apps/plugin-opener`'s `openPath`. So this command must RETURN THE PATH
// (a String) rather than shelling out — the actual reveal stays inside the
// capability-gated opener plugin, mirroring how `diag_open_logs_folder` works.
//
// Path: `<appData>/models/custom` — the same per-user directory the Python server
// scanned via `--custom-models-dir` in the reference build (`getCustomModelsFolder`
// = `path.join(userData, "models", "custom")`). We resolve it portable-aware so it
// matches wherever the model cache lives in this build. Created lazily so the
// first-ever click reveals an existing (if empty) folder rather than failing on a
// not-yet-created dir.
//
// HARD-RULE-safe: NEW file under winstt/commands/. No manager, no lib.rs
// `.manage(...)` edit — pure fs + portable path resolution.

use tauri::AppHandle;

/// `open_custom_models_folder` — return the absolute path of the per-user
/// custom-models directory (`<appData>/models/custom`), creating it if absent. The
/// renderer's opener-plugin route reveals it in the OS file manager. Mirrors
/// `getCustomModelsFolder` + `handleOpenCustomModelsFolder` in `custom-models.ts`.
#[tauri::command]
#[specta::specta]
pub fn open_custom_models_folder(app: AppHandle) -> String {
    let dir = crate::portable::resolve_app_data(&app, "models/custom")
        .unwrap_or_else(|_| std::path::PathBuf::from("models/custom"));
    // Lazily create so a first-run click reveals an existing (empty) folder rather
    // than the opener plugin failing on a non-existent path.
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().into_owned()
}
