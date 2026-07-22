use crate::TranscriptionCoordinator;
use crate::tray::{TrayIconState, change_tray_icon};
use crate::utils;
use log::debug;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;

use crate::managers::audio::AudioRecordingManager;

mod app_profile;
mod misc_actions;
mod pinned_foreground;
mod post_process;
mod transcribe;

use misc_actions::{
    CancelAction, PostProcessingProfileSwapAction, ReadAloudAction, RepasteAction,
    SkipPostProcessingAction, TransformAction,
};
use transcribe::TranscribeAction;

const WAKEWORD_RECORDING_START_TIMEOUT: Duration = Duration::from_secs(2);

type RecordingTransitionSignal = (Mutex<u64>, Condvar);

#[derive(Clone, serde::Serialize)]
pub(super) struct RecordingErrorEvent {
    pub(super) error_type: String,
    pub(super) detail: Option<String>,
}

/// Single-slot memory of the most recent dictation transcription, read back by the
/// re-paste hotkey (`RepasteAction`). Deliberately ONE slot (the shortcut's
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

pub(crate) fn request_post_processing_skip(app: &AppHandle, restore_focus: bool) -> bool {
    post_process::request_post_processing_skip(app, restore_focus)
}

/// Wake the dictation post-processing watcher to re-check its escape flags
/// (Alt+S skip / session cancel). See `post_process::notify_post_processing_escape`.
pub(crate) fn notify_post_processing_escape() {
    post_process::notify_post_processing_escape();
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
        Arc::new(TranscribeAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
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
    map.insert(
        "post_processing_profile_swap".to_string(),
        Arc::new(PostProcessingProfileSwapAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "skip_post_processing".to_string(),
        Arc::new(SkipPostProcessingAction) as Arc<dyn ShortcutAction>,
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
    let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
        crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
        return;
    };
    let audio = Arc::clone(&audio);
    let recording_signal = audio.recording_transition_signal();
    let app = app.clone();

    std::thread::spawn(move || {
        let Some(recording_generation) = wait_for_active_recording_generation(
            &recording_signal,
            WAKEWORD_RECORDING_START_TIMEOUT,
            || {
                let generation = audio.recording_generation();
                audio
                    .is_active_recording_generation(generation)
                    .then_some(generation)
            },
        ) else {
            crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(&app);
            return;
        };

        std::thread::sleep(timeout);
        if audio.is_active_recording_generation(recording_generation)
            && !audio.speech_seen_since_recording_start()
            && let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>()
        {
            coord.request_silence_stop("transcribe", recording_generation);
        }
    });
}

/// Wait for recorder startup on its transition callback. The monotonic epoch closes the
/// predicate-to-park race: a transition between the state check and the signal lock is observed
/// as an epoch change, so no notification can be lost. The timeout is a failure backstop, not a
/// polling cadence.
fn wait_for_active_recording_generation(
    signal: &RecordingTransitionSignal,
    timeout: Duration,
    mut active_generation: impl FnMut() -> Option<u64>,
) -> Option<u64> {
    let started = Instant::now();
    let (epoch, wake) = signal;
    let mut observed_epoch = *lock_recover(epoch);

    loop {
        if let Some(generation) = active_generation() {
            return Some(generation);
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return None;
        }

        // Never hold the signal mutex while consulting recorder state: recorder startup takes
        // its state lock before pulsing this signal. Comparing epochs after the predicate check
        // preserves the wake without inverting that lock order.
        let guard = lock_recover(epoch);
        if *guard != observed_epoch {
            observed_epoch = *guard;
            drop(guard);
            continue;
        }
        let guard = wait_timeout_recover(wake, guard, timeout - elapsed);
        observed_epoch = *guard;
        drop(guard);
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_timeout_recover<'a, T>(
    wake: &Condvar,
    guard: std::sync::MutexGuard<'a, T>,
    timeout: Duration,
) -> std::sync::MutexGuard<'a, T> {
    match wake.wait_timeout(guard, timeout) {
        Ok((guard, _)) => guard,
        Err(poisoned) => poisoned.into_inner().0,
    }
}

#[cfg(test)]
mod tests {
    use super::{RecordingTransitionSignal, lock_recover, wait_for_active_recording_generation};
    use std::sync::{Arc, Condvar, Mutex, mpsc};
    use std::time::Duration;

    fn pulse(signal: &RecordingTransitionSignal) {
        let (epoch, wake) = signal;
        let mut epoch = lock_recover(epoch);
        *epoch = epoch.wrapping_add(1);
        drop(epoch);
        wake.notify_all();
    }

    #[test]
    fn wakeword_start_wait_wakes_on_recording_transition() {
        let signal: Arc<RecordingTransitionSignal> = Arc::new((Mutex::new(0), Condvar::new()));
        let generation = Arc::new(Mutex::new(None));
        let waiter_signal = Arc::clone(&signal);
        let waiter_generation = Arc::clone(&generation);
        let (checked_tx, checked_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let waiter = std::thread::spawn(move || {
            let mut checked = false;
            let result = wait_for_active_recording_generation(
                &waiter_signal,
                Duration::from_secs(2),
                || {
                    let generation = *lock_recover(&waiter_generation);
                    if !checked {
                        checked = true;
                        checked_tx.send(()).unwrap();
                    }
                    generation
                },
            );
            done_tx.send(result).unwrap();
        });

        checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        *lock_recover(&generation) = Some(17);
        pulse(&signal);

        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some(17)
        );
        waiter.join().unwrap();
    }

    #[test]
    fn wakeword_start_wait_does_not_lose_transition_before_park() {
        let signal: Arc<RecordingTransitionSignal> = Arc::new((Mutex::new(0), Condvar::new()));
        let generation = Arc::new(Mutex::new(None));
        let waiter_signal = Arc::clone(&signal);
        let waiter_generation = Arc::clone(&generation);
        let (checked_tx, checked_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let waiter = std::thread::spawn(move || {
            let mut first_check = true;
            let result = wait_for_active_recording_generation(
                &waiter_signal,
                Duration::from_secs(2),
                || {
                    let generation = *lock_recover(&waiter_generation);
                    if first_check {
                        first_check = false;
                        checked_tx.send(()).unwrap();
                        continue_rx.recv().unwrap();
                    }
                    generation
                },
            );
            done_tx.send(result).unwrap();
        });

        checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        *lock_recover(&generation) = Some(23);
        pulse(&signal);
        continue_tx.send(()).unwrap();

        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some(23)
        );
        waiter.join().unwrap();
    }

    #[test]
    fn wakeword_start_wait_rechecks_recording_predicate_after_each_transition() {
        let signal: Arc<RecordingTransitionSignal> = Arc::new((Mutex::new(0), Condvar::new()));
        let state = Arc::new(Mutex::new((31, false)));
        let waiter_signal = Arc::clone(&signal);
        let waiter_state = Arc::clone(&state);
        let (checked_tx, checked_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();

        let waiter = std::thread::spawn(move || {
            let mut checks = 0;
            let result = wait_for_active_recording_generation(
                &waiter_signal,
                Duration::from_secs(2),
                || {
                    checks += 1;
                    checked_tx.send(checks).unwrap();
                    let (generation, is_recording) = *lock_recover(&waiter_state);
                    is_recording.then_some(generation)
                },
            );
            done_tx.send(result).unwrap();
        });

        checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        pulse(&signal);
        checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        *lock_recover(&state) = (31, true);
        pulse(&signal);
        checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Some(31)
        );
        waiter.join().unwrap();
    }
}
