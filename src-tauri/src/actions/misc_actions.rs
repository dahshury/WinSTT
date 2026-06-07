use crate::utils;
use log::{debug, error};
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use super::{last_transcription, ShortcutAction};

// Cancel Action
pub(super) struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        if utils::cancel_current_operation(app) {
            crate::winstt::commands::dictation::SttEvents::session_aborted(app);
            return;
        }
        if crate::winstt::commands::tts::cancel_tts_playback_layer(app) {
            return;
        }
        utils::unregister_cancel_shortcut_if_idle(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Transform Action (WinSTT transforms.hotkey, default LCtrl+LShift+T): capture selection ->
// transform over the configured provider -> paste-replace -> emit transforms:applied.
pub(super) struct TransformAction;

impl ShortcutAction for TransformAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Single-shot on press. run_transform_pipeline does its own enabled-gate + failure
        // events and never errors past its boundary; spawn so the shortcut thread isn't
        // blocked by the LLM round-trip.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::winstt::commands::transforms::run_transform_pipeline(&app).await;
        });
    }
    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Re-paste Action (WinSTT general.repasteHotkey, default LCtrl+LShift+V): re-inject
// the most recent dictation transcription without re-dictating. handy-keys registers
// the combo with blocking, so the accelerator is consumed system-wide (the reference's
// "exclusive" globalShortcut semantics) — pressing it ONLY re-pastes, it does not also
// trigger the focused app's native binding for the same combo. Mirrors
// electron/ipc/repaste-hotkey.ts.
pub(super) struct RepasteAction;

impl ShortcutAction for RepasteAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        let text = last_transcription();
        if text.trim().is_empty() {
            debug!("RepasteAction: no transcription recorded yet — ignoring");
            return;
        }
        // This hotkey fires on key-DOWN while the user is STILL holding the combo
        // (LCtrl+LShift+V), and must paste the WHOLE block immediately — exactly like a
        // manual Ctrl+V — without waiting for release. A naive synthetic Ctrl+V can't do
        // that here: handy-keys' blocking hook (which doesn't filter injected events) sees
        // the synthetic `V` re-match the still-held Ctrl+Shift+V and SWALLOWS it, and the
        // held Shift would turn Ctrl+V into Ctrl+Shift+V. Fix (the standard clipboard-paste
        // dance, à la Espanso): inject key-UPs to release the held modifiers first — now
        // the combo no longer matches (so handy lets the synthetic `V` through) and the
        // paste reaches the app as a clean Ctrl+V. Then run the normal clipboard paste, so
        // the text drops in as ONE block via the user's configured paste method.
        // Run on a worker (off the hotkey/manager thread): Windows input synthesis +
        // clipboard are thread-safe, and pasting here avoids the idle-event-loop latency a
        // `run_on_main_thread` hop adds when no overlay is animating to pump the loop.
        let app = app.clone();
        std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            {
                crate::input::release_held_modifiers();
                // Let the foreground app process the modifier key-ups before the paste.
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            debug!(
                "RepasteAction: re-pasting last transcription ({} chars)",
                text.len()
            );
            // `replace=false` = the dictation paste variant (clipboard sandwich +
            // configured paste method + append_trailing_space + auto-submit), so a
            // re-paste is indistinguishable from the original dictation paste.
            #[cfg(target_os = "macos")]
            let result = crate::clipboard::paste_on_main_thread(&app, text, false);
            #[cfg(not(target_os = "macos"))]
            let result = crate::clipboard::paste(text, app.clone());
            if let Err(e) = result {
                error!("RepasteAction: paste failed: {e}");
            }
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Read-Aloud Action (WinSTT tts.hotkey, default LCtrl+Space): capture the active
// selection and read it aloud through the source-aware TTS pipeline (local Kokoro /
// cloud ElevenLabs). Single-shot on press. Mirrors electron/ipc/tts-hotkey.ts.
pub(super) struct ReadAloudAction;

impl ShortcutAction for ReadAloudAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Gate on tts.enabled BEFORE capturing the selection — selection capture can
        // fall back to a synthetic Ctrl+C (clipboard sandwich), which we must not fire
        // when TTS is off (mirrors tts-hotkey.ts `maybeFire` checking `isTtsEnabled`).
        let enabled = crate::winstt::commands::settings::read_settings(app)
            .tts
            .enabled;
        if !enabled {
            debug!("ReadAloudAction: TTS disabled — ignoring");
            return;
        }
        let app = app.clone();
        // Selection capture + blocking synthesis run off the hotkey thread.
        std::thread::spawn(move || {
            let text = crate::winstt::commands::transforms::capture_selection_text(&app);
            if text.trim().is_empty() {
                debug!("ReadAloudAction: no selection captured");
                let _ = app.emit(
                    "tts:failed",
                    serde_json::json!({ "requestId": "", "reason": "No text selected" }),
                );
                return;
            }
            let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
                return;
            };
            let mgr = tts.inner().clone();
            let rid = mgr.next_request_id();
            crate::winstt::commands::tts::reserve_tts_playback_layer(&app);
            // Empty voice/lang → the manager fills them from the active source's
            // settings (same as the `tts_speak_selection` command path). Speed is
            // sampled per sentence so a mid-read change applies to the next one.
            let speed_mgr = mgr.clone();
            mgr.read_aloud(&rid, &text, "", "", move || speed_mgr.current_speed());
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Test Action
pub(super) struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}
