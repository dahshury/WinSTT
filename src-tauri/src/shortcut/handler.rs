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
    // WinSTT port: the BACKEND is the single authority for hotkey dispatch (Handy-style).
    // The transcribe binding's accelerator drives the recorder DIRECTLY on the hotkey thread —
    // both PTT and TOGGLE branch straight into the coordinator here, killing the WebView2
    // round-trip that was the "~2s from hotkey to listening" bug AND the double-dispatch that
    // relied on the Stage machine deduping a race (the renderer used to ALSO call set_microphone
    // for ptt/toggle). The `hotkey:pressed` / `hotkey:released` events below are now PURELY for
    // renderer UI state (pressed/active pill); the renderer no longer issues set_microphone for
    // ptt/toggle (see use-push-to-talk.ts). LISTEN & WAKEWORD stay renderer/server-driven — they
    // transcribe SYSTEM audio / fire on a wake event, not the mic hotkey, so we must NOT start a
    // mic recording for them here; the renderer/loopback path owns those. Mode is read once from
    // the in-memory store (no secret-decrypt) so the press path stays fast.
    if is_transcribe_binding(binding_id) {
        use crate::winstt::commands::hotkey::HotkeyEvents;
        use crate::winstt::settings_schema::RecordingMode;

        match crate::winstt::commands::settings::recording_mode(app) {
            // PTT: press starts, release stops (the key hold IS the recording boundary).
            RecordingMode::Ptt => {
                if let Some(coordinator) = app.try_state::<crate::TranscriptionCoordinator>() {
                    coordinator.send_input("transcribe", "", is_pressed, true);
                }
            }
            // TOGGLE: only the PRESS matters — the coordinator's Stage machine flips
            // Idle↔Recording on each `is_pressed:true, push_to_talk:false` (start on the first
            // press, stop on the next). Releases are ignored so a hold doesn't toggle twice.
            RecordingMode::Toggle => {
                if is_pressed {
                    if let Some(coordinator) = app.try_state::<crate::TranscriptionCoordinator>() {
                        coordinator.send_input("transcribe", "", true, false);
                    }
                }
            }
            // LISTEN / WAKEWORD: server-driven (system-audio loopback / wake event). The mic
            // hotkey must NOT start a recording for them — leave dispatch to the renderer/server.
            RecordingMode::Listen | RecordingMode::Wakeword => {}
        }

        // UI-only: the renderer's hotkey store reflects pressed/active for the pill. No
        // set_microphone is issued by the renderer for ptt/toggle anymore (single authority).
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
