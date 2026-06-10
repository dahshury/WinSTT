//! Plain general / output / audio settings-mutation Tauri commands.
//!
//! All per-field setters were removed once the renderer migrated to the bulk
//! `winstt_set_settings` path (the single canonical write path); what remains
//! here exposes platform data the renderer reads directly.

#[tauri::command]
#[specta::specta]
pub fn get_available_typing_tools() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        crate::clipboard::get_available_typing_tools()
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec!["auto".to_string()]
    }
}
