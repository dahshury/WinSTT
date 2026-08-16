use crate::TranscriptionCoordinator;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use crate::shortcut;
use log::debug;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub use crate::clipboard::*;
pub use crate::tray::*;
pub use crate::winstt::commands::overlay::{hide_recording_overlay, show_recording_overlay};

/// Whether listen mode owns the tray's recording animation right now. Listen runs
/// off the loopback endpoint rather than [`AudioRecordingManager`], so the dictation
/// cancel path sees "nothing active" while the visualizer is legitimately live.
fn listen_mode_is_capturing(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::winstt::managers::LoopbackManager>>()
        .is_some_and(|loopback| loopback.is_capturing())
}

/// Centralized cancellation function that can be called from anywhere in the app.
/// Handles cancelling both recording and transcription operations and updates UI state.
pub fn cancel_current_operation(app: &AppHandle) -> bool {
    debug!("Initiating operation cancellation");

    let audio_manager = app.state::<Arc<AudioRecordingManager>>();
    let recording_was_active = audio_manager.is_recording();
    let cancelled_through = crate::transcription_coordinator::cancel_current_dictation_session();
    let dictation_was_active = recording_was_active || cancelled_through.is_some();

    if !dictation_was_active {
        debug!("No active dictation operation to cancel");
        // Nothing to cancel, but this is also the app's ONLY user-reachable reset
        // (Escape / the overlay X). If a lifecycle event went missing the tray can be
        // animating a take that the pipeline already forgot about — in which case
        // every automatic path has, by definition, already failed. Repaint the static
        // idle icon so the user is never left with a permanently spinning tray.
        // Listen mode is genuinely capturing while the coordinator reads idle, so it
        // keeps its animation.
        if !listen_mode_is_capturing(app) {
            change_tray_icon(app, crate::tray::TrayIconState::Idle);
        }
        unregister_cancel_shortcut_if_idle(app);
        return false;
    }

    audio_manager.cancel_recording();

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

    debug!("Operation cancellation completed; returned to idle state");
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
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.to_lowercase() == "wayland")
}

/// Check if running on KDE Plasma desktop environment
#[cfg(target_os = "linux")]
pub fn is_kde_plasma() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|v| v.to_uppercase().contains("KDE"))
        || std::env::var("KDE_SESSION_VERSION").is_ok()
}

/// Check if running on KDE Plasma with Wayland
#[cfg(target_os = "linux")]
pub fn is_kde_wayland() -> bool {
    is_wayland() && is_kde_plasma()
}
