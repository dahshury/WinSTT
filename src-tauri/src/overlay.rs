use tauri::AppHandle;

// ── WinSTT overlay redirection ──────────────────────────────────────────────────
//
// WinSTT port: the on-screen recording pill is the `overlay` WebviewWindow
// (windows/overlay.html — the React dynamic-island), NOT Handy's `recording_overlay`
// HTML. The renderer paints ALL content from the STT IPC events it already receives
// (stt:recording-start / realtime-update / stt:audio-level / …) via its Zustand
// stores, so the backend's only job is to SHOW / HIDE / POSITION that window in
// lock-step with the recording lifecycle. These entry points (the unchanged call
// sites in actions.rs + utils::cancel_current_operation) are therefore redirected to
// `winstt::commands::overlay`, which targets the correct window and applies the WinSTT
// suppression gates + position math (showRecordingOverlay / listen-mode /
// overlayPosition / overlayMode).
//
// AUDIT #9: Handy's separate `recording_overlay` WebView2 window (and its
// `create_recording_overlay` / `show_overlay_state` / `force_overlay_topmost` plumbing)
// is GONE. Every show path already redirected to the WinSTT `overlay` window, so that
// second window could never appear — yet it was still built at boot and received
// per-frame `emit_levels` on the ~94 Hz audio callback that no renderer listened to.
// All of that has been removed.

/// Shows the WinSTT recording overlay (gated by settings; positioned per mode).
pub fn show_recording_overlay(app_handle: &AppHandle) {
    crate::winstt::commands::overlay::show_recording_overlay(app_handle);
}

/// Transcribing state keeps the SAME pill on screen — the renderer's own stores
/// distinguish recording vs transcription/thinking, so there is no separate window
/// swap. Ensure the pill stays visible (a no-op when already shown).
pub fn show_transcribing_overlay(app_handle: &AppHandle) {
    crate::winstt::commands::overlay::show_recording_overlay(app_handle);
}

/// Post-processing (LLM cleanup) state likewise reuses the same pill; the renderer
/// shows its thinking indicator inside it. Keep the pill visible.
pub fn show_processing_overlay(app_handle: &AppHandle) {
    crate::winstt::commands::overlay::show_recording_overlay(app_handle);
}

/// Re-anchor the WinSTT overlay after a live overlayPosition / overlayMode change.
pub fn update_overlay_position(app_handle: &AppHandle) {
    crate::winstt::commands::overlay::reposition_overlay_if_visible(app_handle);
}

/// Hides the WinSTT recording overlay (emit hide-overlay → grace → hide window).
pub fn hide_recording_overlay(app_handle: &AppHandle) {
    crate::winstt::commands::overlay::hide_recording_overlay(app_handle);
}
