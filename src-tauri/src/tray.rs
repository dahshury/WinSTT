use crate::managers::history::{HistoryEntry, HistoryManager};
use log::{error, info, warn};
use std::sync::Arc;
use tauri::image::Image;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrayIconState {
    Idle,
    Recording,
    Transcribing,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
    Colored, // Pink/colored theme for Linux
}

/// Gets the current app theme, with Linux defaulting to Colored theme
pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    if cfg!(target_os = "linux") {
        // On Linux, always use the colored theme
        AppTheme::Colored
    } else {
        // On other platforms, map system theme to our app theme
        if let Some(main_window) = app.get_webview_window("main") {
            match main_window.theme().unwrap_or(Theme::Dark) {
                Theme::Light => AppTheme::Light,
                Theme::Dark => AppTheme::Dark,
                _ => AppTheme::Dark, // Default fallback
            }
        } else {
            AppTheme::Dark
        }
    }
}

/// Gets the appropriate icon path for the given theme and state
pub fn get_icon_path(theme: AppTheme, state: TrayIconState) -> &'static str {
    match (theme, state) {
        // Dark theme uses light icons
        (AppTheme::Dark, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Dark, TrayIconState::Recording) => "resources/tray_recording.png",
        (AppTheme::Dark, TrayIconState::Transcribing) => "resources/tray_transcribing.png",
        // Light theme uses dark icons
        (AppTheme::Light, TrayIconState::Idle) => "resources/tray_idle_dark.png",
        (AppTheme::Light, TrayIconState::Recording) => "resources/tray_recording_dark.png",
        (AppTheme::Light, TrayIconState::Transcribing) => "resources/tray_transcribing_dark.png",
        // Colored theme (Linux) reuses WinSTT's idle/recording/transcribing marks
        (AppTheme::Colored, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Colored, TrayIconState::Recording) => "resources/recording.png",
        (AppTheme::Colored, TrayIconState::Transcribing) => "resources/transcribing.png",
    }
}

pub(crate) fn paint_static_tray_icon(app: &AppHandle, icon: TrayIconState) {
    let Some(tray) = app.try_state::<TrayIcon>() else {
        return;
    };
    let theme = get_current_theme(app);
    let icon_path = get_icon_path(theme, icon);
    let resolved = match app
        .path()
        .resolve(icon_path, tauri::path::BaseDirectory::Resource)
    {
        Ok(path) => path,
        Err(err) => {
            error!("Failed to resolve tray icon path '{icon_path}': {err}");
            return;
        }
    };
    match Image::from_path(&resolved) {
        Ok(image) => {
            let _ = tray.set_icon(Some(image));
        }
        Err(err) => {
            error!("Failed to load tray icon '{}': {err}", resolved.display());
        }
    }

    // Update menu based on state
    update_tray_menu(app, &icon, None);
}

pub fn change_tray_icon(app: &AppHandle, icon: TrayIconState) {
    match icon {
        TrayIconState::Idle => crate::tray_indicator::on_idle(app),
        TrayIconState::Recording | TrayIconState::Transcribing => {
            // Recording/transcribing pixels are owned by tray_indicator's live
            // animation. Updating only the menu/tooltip avoids flashing the static
            // red PNG before the first visualizer frame is painted.
            update_tray_menu(app, &icon, None);
        }
    }
}

pub fn set_tray_visualizer_style_from_general(
    general: &crate::winstt::settings_schema::GeneralSettings,
) {
    crate::tray_indicator::set_visualizer_style_from_general(general);
}

pub fn sync_tray_visualizer_style_from_settings(app: &AppHandle) {
    crate::tray_indicator::sync_visualizer_style_from_settings(app);
}

pub fn on_tray_recording_start(app: &AppHandle) {
    update_tray_menu(app, &TrayIconState::Recording, None);
    crate::tray_indicator::on_recording_start(app);
}

pub fn on_tray_recording_stop(app: &AppHandle) {
    crate::tray_indicator::on_recording_stop(app);
}

pub fn on_tray_audio_level(_app: &AppHandle, level: f32) {
    crate::tray_indicator::on_audio_level(level);
}

pub fn on_tray_transcription_start(app: &AppHandle) {
    update_tray_menu(app, &TrayIconState::Transcribing, None);
    crate::tray_indicator::on_transcribing_start(app);
}

pub fn on_tray_transcription_stop(app: &AppHandle) {
    crate::tray_indicator::on_transcribing_stop(app);
}

pub fn on_tray_idle(app: &AppHandle) {
    crate::tray_indicator::on_idle(app);
}

pub fn on_llm_thinking_start(app: &AppHandle) {
    update_tray_menu(app, &TrayIconState::Transcribing, None);
    crate::tray_indicator::on_llm_thinking_start(app);
}

pub fn on_llm_thinking_stop(app: &AppHandle) {
    crate::tray_indicator::on_llm_thinking_stop(app);
}

pub fn tray_tooltip() -> String {
    version_label()
}

fn version_label() -> String {
    if cfg!(debug_assertions) {
        format!("WinSTT v{} (Dev)", env!("CARGO_PKG_VERSION"))
    } else {
        format!("WinSTT v{}", env!("CARGO_PKG_VERSION"))
    }
}

pub fn update_tray_menu(app: &AppHandle, state: &TrayIconState, locale: Option<&str>) {
    // AUDIT #19: WinSTT shows its OWN transparent HTML tray menu (lib.rs
    // `on_tray_icon_event` → toggle_tray_menu_at_physical; labels are translated in the
    // renderer). Handy's native OS context menu is NOT attached — and previously this
    // function still BUILT every MenuItem/Submenu/CheckMenuItem (looping all downloaded
    // models) on every state transition only to drop it with `let _ = menu;`. That whole
    // construction block has been removed; only the icon-template + tooltip refresh
    // remain (the state/locale args are kept for signature stability and future use).
    let _ = state;
    let _ = locale;

    let tray = app.state::<TrayIcon>();
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(version_label()));
}

// The post-processed text wins over the raw transcription when present (matches
// what the user sees in the history pane). Shared by `copy_last_transcript` and tests.
fn last_transcript_text(entry: &HistoryEntry) -> &str {
    entry
        .post_processed_text
        .as_deref()
        .unwrap_or(&entry.transcription_text)
}

pub fn set_tray_visibility(app: &AppHandle, visible: bool) {
    let tray = app.state::<TrayIcon>();
    if let Err(e) = tray.set_visible(visible) {
        error!("Failed to set tray visibility: {}", e);
    } else {
        info!("Tray visibility set to: {}", visible);
    }
}

/// Copy the most recent *completed* transcription to the system clipboard. Invoked
/// by the HTML tray menu's "Copy Last Transcript" item. Reads the history DB directly,
/// so it works whether or not the STT server is connected. Returns `false` when there's
/// no completed entry, its text is empty, or the clipboard write fails (the menu can
/// surface that), `true` once the text lands on the clipboard.
#[tauri::command]
#[specta::specta]
pub fn copy_last_transcript(app: AppHandle) -> bool {
    let history_manager = app.state::<Arc<HistoryManager>>();
    let entry = match history_manager.get_latest_completed_entry() {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            warn!("No completed transcription history entries available for tray copy.");
            return false;
        }
        Err(err) => {
            error!(
                "Failed to fetch last completed transcription entry: {}",
                err
            );
            return false;
        }
    };

    let text = last_transcript_text(&entry);
    if text.trim().is_empty() {
        warn!("Last completed transcription is empty; skipping tray copy.");
        return false;
    }

    if let Err(err) = app.clipboard().write_text(text) {
        error!("Failed to copy last transcript to clipboard: {}", err);
        return false;
    }

    info!("Copied last transcript to clipboard via tray.");
    true
}

#[cfg(test)]
mod tests {
    use super::last_transcript_text;
    use crate::managers::history::HistoryEntry;

    fn build_entry(transcription: &str, post_processed: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: 1,
            file_name: "winstt-1.wav".to_string(),
            timestamp: 0,
            saved: false,
            title: "Recording".to_string(),
            transcription_text: transcription.to_string(),
            post_processed_text: post_processed.map(|text| text.to_string()),
            post_process_prompt: None,
            post_process_requested: false,
            llm_meta: None,
            dictionary_fixes: None,
            history_tag: None,
            privacy_markers_json: None,
            stt_model: None,
        }
    }

    #[test]
    fn uses_post_processed_text_when_available() {
        let entry = build_entry("raw", Some("processed"));
        assert_eq!(last_transcript_text(&entry), "processed");
    }

    #[test]
    fn falls_back_to_raw_transcription() {
        let entry = build_entry("raw", None);
        assert_eq!(last_transcript_text(&entry), "raw");
    }
}
