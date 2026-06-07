use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils;
use crate::TranscriptionCoordinator;
use log::debug;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use crate::managers::audio::AudioRecordingManager;

mod misc_actions;
mod post_process;
mod transcribe;

use misc_actions::{CancelAction, ReadAloudAction, RepasteAction, TestAction, TransformAction};
use transcribe::TranscribeAction;

// Re-exported for external consumers (commands/history.rs) so the public paths
// `crate::actions::process_transcription_output` / `::ProcessedTranscription`
// stay valid after the split. `PostProcessMeta`/`ProcessedTranscription` were
// directly under `crate::actions` before the split; keep them reachable there.
pub(crate) use post_process::process_transcription_output;

#[derive(Clone, serde::Serialize)]
pub(super) struct RecordingErrorEvent {
    pub(super) error_type: String,
    pub(super) detail: Option<String>,
}

/// Single-slot memory of the most recent dictation transcription, read back by the
/// re-paste hotkey (`RepasteAction`). Ported from the reference's
/// `electron/lib/last-transcription.ts`: deliberately ONE slot (the shortcut's
/// contract is "paste the thing you just dictated"), not the full history store.
/// Set at the same point dictation auto-pastes the final text (`TranscribeAction::stop`).
static LAST_TRANSCRIPTION: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

/// Remember `text` as the most recent transcription. Whitespace-only / empty input
/// is ignored so a "no audio detected" pass can't blank the slot — the user still
/// wants the previous real transcript re-pastable (mirrors `setLastTranscription`).
pub(super) fn set_last_transcription(text: &str) {
    if text.trim().is_empty() {
        return;
    }
    if let Ok(mut slot) = LAST_TRANSCRIPTION.lock() {
        *slot = text.to_string();
    }
}

/// The last recorded transcription, or `""` when nothing has been dictated yet.
pub(super) fn last_transcription() -> String {
    LAST_TRANSCRIPTION
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or_default()
}

pub(super) fn cancelled_session_cleanup(app: &AppHandle, session_id: u64, phase: &str) -> bool {
    if !crate::transcription_coordinator::is_dictation_session_cancelled(session_id) {
        return false;
    }
    debug!("Dictation session {session_id} cancelled during {phase}; suppressing output");
    utils::hide_recording_overlay(app);
    change_tray_icon(app, TrayIconState::Idle);
    true
}

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
pub(super) struct FinishGuard {
    pub(super) app: AppHandle,
    pub(super) session_id: u64,
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        if crate::transcription_coordinator::is_current_dictation_session(self.session_id) {
            crate::transcription_coordinator::finish_dictation_session(self.session_id);
            utils::unregister_cancel_shortcut_if_idle(&self.app);
        }
        if let Some(c) = self.app.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished(self.session_id);
        }
    }
}

pub(super) struct LlmProcessingGuard {
    app: AppHandle,
}

impl LlmProcessingGuard {
    pub(super) fn new(app: &AppHandle) -> Self {
        crate::tray::on_llm_thinking_start(app);
        let _ = app.emit("llm:processing-start", ());
        Self { app: app.clone() }
    }
}

impl Drop for LlmProcessingGuard {
    fn drop(&mut self) {
        let _ = self.app.emit("llm:processing-end", ());
        crate::tray::on_llm_thinking_stop(&self.app);
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TranscribeAction { post_process: true }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transforms".to_string(),
        Arc::new(TransformAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "repaste".to_string(),
        Arc::new(RepasteAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "read_aloud".to_string(),
        Arc::new(ReadAloudAction) as Arc<dyn ShortcutAction>,
    );
    map
});

/// Start one dictation cycle from a wakeword hit. A wake-word detection acts exactly like a
/// toggle-press of the transcribe action: it begins a recording cycle that the recorder's
/// silence-endpoint stops. Bound to the `wake_word_detected` event in `initialize_core_logic`.
pub fn start_dictation_from_wakeword(app: &AppHandle) {
    if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
        coord.send_input("transcribe", "", true, false);
        schedule_wakeword_followup_timeout(app);
    } else {
        crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
    }
}

fn schedule_wakeword_followup_timeout(app: &AppHandle) {
    let settings = crate::winstt::commands::settings::read_settings_raw(app);
    let raw_seconds = settings.general.wake_word_timeout;
    let seconds = if raw_seconds.is_finite() {
        raw_seconds
    } else {
        5.0
    }
    .clamp(1.0, 30.0);
    let timeout = Duration::from_millis((seconds * 1000.0).round() as u64);
    let app = app.clone();

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let recording_generation = {
            let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
                return;
            };
            if !audio.is_recording() {
                crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(&app);
                return;
            }
            audio.recording_generation()
        };

        std::thread::sleep(timeout);
        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        if audio.is_recording()
            && audio.recording_generation() == recording_generation
            && !audio.speech_seen_since_recording_start()
        {
            if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
                coord.request_silence_stop("transcribe", recording_generation);
            }
        }
    });
}
