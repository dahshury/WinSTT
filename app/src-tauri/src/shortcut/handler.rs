//! Shared shortcut event handling logic
//!
//! This module contains the common logic for handling shortcut events,
//! used by both the Tauri and handy-keys implementations.

use log::warn;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use crate::transcription_coordinator::is_transcribe_binding;

/// Handle a shortcut event from either implementation.
///
/// This function contains the shared logic for:
/// - Looking up the action in ACTION_MAP
/// - Handling the cancel binding (only fires when recording)
/// - Handling push-to-talk mode (start on press, stop on release)
/// - Handling toggle mode (toggle state on press only)
///
/// # Arguments
/// * `app` - The Tauri app handle
/// * `binding_id` - The ID of the binding (e.g., "transcribe", "cancel")
/// * `hotkey_string` - The string representation of the hotkey
/// * `is_pressed` - Whether this is a key press (true) or release (false)
pub fn handle_shortcut_event(
    app: &AppHandle,
    binding_id: &str,
    hotkey_string: &str,
    is_pressed: bool,
) {
    // WinSTT port fork (WU-3 dictation): the transcribe binding's accelerator does
    // NOT drive the TranscribeAction directly. Instead the press/release of the
    // registered accelerator is surfaced to the renderer as the plain
    // `hotkey:pressed` / `hotkey:released` events; the renderer's usePushToTalk then
    // decides (per recording mode) whether to issue `set_microphone(true/false)`
    // (winstt_call_method), which routes back through the coordinator. This keeps
    // the renderer as the single source of truth for the 4 modes (ptt / toggle /
    // listen / wakeword) — listen & wakeword are server-driven and the renderer
    // deliberately suppresses set_microphone for them, so routing the hotkey
    // straight into the coordinator here would wrongly start a mic recording in
    // those modes AND double-record in ptt/toggle (the renderer ALSO calls
    // set_microphone). Emitting the events instead is the byte-compatible WinSTT
    // behaviour (frontend/electron/ipc/hotkey.ts → onHotkeyPressed/Released).
    if is_transcribe_binding(binding_id) {
        use crate::winstt::commands::hotkey::HotkeyEvents;
        if is_pressed {
            HotkeyEvents::pressed(app);
        } else {
            HotkeyEvents::released(app);
        }
        return;
    }

    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!(
            "No action defined in ACTION_MAP for shortcut ID '{}'. Shortcut: '{}', Pressed: {}",
            binding_id, hotkey_string, is_pressed
        );
        return;
    };

    // Cancel binding: only fires when recording and key is pressed
    if binding_id == "cancel" {
        let audio_manager = app.state::<Arc<AudioRecordingManager>>();
        if audio_manager.is_recording() && is_pressed {
            action.start(app, binding_id, hotkey_string);
        }
        return;
    }

    // Remaining bindings (e.g. "test") use simple start/stop on press/release.
    if is_pressed {
        action.start(app, binding_id, hotkey_string);
    } else {
        action.stop(app, binding_id, hotkey_string);
    }
}
