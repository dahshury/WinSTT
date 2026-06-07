use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use crate::shortcut;
use crate::TranscriptionCoordinator;
use log::info;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

// Re-export all utility modules for easy access
pub use crate::clipboard::*;
pub use crate::tray::*;
pub use crate::winstt::commands::overlay::{hide_recording_overlay, show_recording_overlay};

/// Centralized cancellation function that can be called from anywhere in the app.
/// Handles cancelling both recording and transcription operations and updates UI state.
pub fn cancel_current_operation(app: &AppHandle) -> bool {
    info!("Initiating operation cancellation...");

    let audio_manager = app.state::<Arc<AudioRecordingManager>>();
    let recording_was_active = audio_manager.is_recording();
    let cancelled_through = crate::transcription_coordinator::cancel_current_dictation_session();
    let dictation_was_active = recording_was_active || cancelled_through.is_some();

    if !dictation_was_active {
        info!("No active dictation operation to cancel");
        unregister_cancel_shortcut_if_idle(app);
        return false;
    }

    // Cancel any ongoing recording
    audio_manager.cancel_recording();

    // Update tray icon and hide overlay
    change_tray_icon(app, crate::tray::TrayIconState::Idle);
    hide_recording_overlay(app);

    // Unload model if immediate unload is enabled
    let tm = app.state::<Arc<TranscriptionManager>>();
    tm.maybe_unload_immediately("cancellation");

    // Abort every in-flight cloud operation the overlay X / Esc should stop:
    // cloud STT uploads, cloud/local LLM dictation+transform chats, and cloud/
    // local TTS reads. Each manager's `cancel_all` fires the awaitable cancel
    // tokens so reqwest/genai futures are dropped mid-flight (not just stopped at
    // the next boundary).
    if let Some(cloud) = app.try_state::<Arc<crate::winstt::managers::CloudSttManager>>() {
        cloud.cancel_all();
    }
    if let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() {
        llm.cancel_all();
    }
    if let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() {
        tts.cancel_all();
    }

    // Notify coordinator so it can keep lifecycle state coherent.
    if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
        coordinator.notify_cancel(recording_was_active, cancelled_through.unwrap_or(0));
    }

    unregister_cancel_shortcut_if_idle(app);

    info!("Operation cancellation completed - returned to idle state");
    true
}

pub fn should_keep_cancel_shortcut_registered() -> bool {
    crate::transcription_coordinator::is_dictation_pipeline_active()
        || crate::winstt::commands::overlay::tts_overlay_is_active()
}

pub fn unregister_cancel_shortcut_if_idle(app: &AppHandle) {
    if !should_keep_cancel_shortcut_registered() {
        shortcut::unregister_cancel_shortcut(app);
    }
}

/// Check if using the Wayland display server protocol
#[cfg(target_os = "linux")]
pub fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.to_lowercase() == "wayland")
            .unwrap_or(false)
}

/// Check if running on KDE Plasma desktop environment
#[cfg(target_os = "linux")]
pub fn is_kde_plasma() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.to_uppercase().contains("KDE"))
        .unwrap_or(false)
        || std::env::var("KDE_SESSION_VERSION").is_ok()
}

/// Check if running on KDE Plasma with Wayland
#[cfg(target_os = "linux")]
pub fn is_kde_wayland() -> bool {
    is_wayland() && is_kde_plasma()
}
