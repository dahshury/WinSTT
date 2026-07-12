// Recording-mode runtime transition: stop backend-owned capture/session state that
// the OLD `general.recordingMode` no longer owns once a settings hot-swap moves to a
// different mode. Mirrors the arm/disarm shape of `settings/wakeword.rs`, but only
// covers LEAVING a mode — the backend never auto-starts a mode's runtime:
//   * entering Listen stays renderer-driven (the renderer calls `start_listen` once
//     the user picks listen mode + a native-streaming model);
//   * entering Wakeword is already covered by `apply_wakeword_runtime_settings`.
//
// Before this handler existed, the WASAPI loopback consumer thread (`LoopbackManager`)
// only stopped when the renderer separately sent `stop_listen` — a save that flipped
// `recordingMode` away from `Listen` (e.g. via keyboard shortcut cycling or another
// window) left system-audio capture, decoding, and `stt:audio-level`/`stt:vad-*`
// emission running with no owner. Symmetrically, leaving Ptt/Toggle while a
// mic-driven dictation session is in flight left the recorder running with nothing
// to finalize it.

use tauri::{AppHandle, Manager};

use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordingModeTransition {
    Noop,
    /// Left `Listen` for any other mode: stop WASAPI loopback capture.
    StopListen,
    /// Left `Ptt`/`Toggle` for a mode that doesn't drive the same hotkey-triggered
    /// recorder (Listen/Wakeword): cancel an in-flight dictation session, if any.
    StopDictationSession,
}

fn recording_mode_transition(
    previous: &WinsttSettings,
    next: &WinsttSettings,
) -> RecordingModeTransition {
    let prev_mode = previous.general.recording_mode;
    let next_mode = next.general.recording_mode;
    if prev_mode == next_mode {
        return RecordingModeTransition::Noop;
    }

    if prev_mode == RecordingMode::Listen {
        return RecordingModeTransition::StopListen;
    }

    let left_hotkey_driven_mode = matches!(prev_mode, RecordingMode::Ptt | RecordingMode::Toggle)
        && !matches!(next_mode, RecordingMode::Ptt | RecordingMode::Toggle);
    if left_hotkey_driven_mode {
        return RecordingModeTransition::StopDictationSession;
    }

    RecordingModeTransition::Noop
}

pub(super) fn apply_recording_mode_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }

    match recording_mode_transition(previous, next) {
        RecordingModeTransition::Noop => {}
        RecordingModeTransition::StopListen => stop_listen_on_mode_change(app),
        RecordingModeTransition::StopDictationSession => {
            stop_dictation_session_on_mode_change(app);
        }
    }
}

/// Reuses the exact same idempotent stop path `stop_listen`/onboarding deactivation
/// call (`stop_listen_runtime`): it no-ops safely if the renderer already sent
/// `stop_listen` for this session (`LoopbackManager::stop` is idempotent, and the
/// `stt:recording-stop`/`stt:vad-stop` emissions are gated on `was_capturing`), and
/// keeps emitting `stt:loopback-stopped` unconditionally so the renderer's listen
/// pill always resets.
fn stop_listen_on_mode_change(app: &AppHandle) {
    let Some(loopback) =
        app.try_state::<std::sync::Arc<crate::winstt::managers::LoopbackManager>>()
    else {
        log::warn!("[recording-mode] cannot stop listen mode: LoopbackManager is not managed");
        return;
    };
    crate::winstt::commands::listen::stop_listen_runtime(app, loopback.inner().as_ref());
    log::info!("[recording-mode] left Listen mode via settings hot-swap; loopback capture stopped");
}

/// Reuses the app's ONE centralized cancel path (`crate::utils::cancel_current_operation`,
/// the same one `cancel_current_operation`/Escape/overlay-X drive) instead of a parallel
/// stop mechanism, so mode-change teardown gets the exact same recorder-cancel + tray/
/// overlay reset + cloud-operation abort + coordinator notification as a user-initiated
/// cancel. Emits `stt:session-aborted` on an actual cancel so the renderer resets
/// toggle/visualizer/pill state, mirroring `winstt::commands::cancel::cancel_current_operation`.
fn stop_dictation_session_on_mode_change(app: &AppHandle) {
    if !crate::transcription_coordinator::is_dictation_pipeline_active() {
        return;
    }
    if crate::utils::cancel_current_operation(app) {
        SttEvents::session_aborted(app);
        log::info!(
            "[recording-mode] left Ptt/Toggle mode via settings hot-swap with an active \
             dictation session; cancelled it"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_mode(mode: RecordingMode) -> WinsttSettings {
        let mut settings = WinsttSettings::default();
        settings.general.recording_mode = mode;
        settings
    }

    #[test]
    fn noop_when_mode_is_unchanged() {
        let prev = with_mode(RecordingMode::Ptt);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::Noop
        );
    }

    #[test]
    fn stops_listen_when_leaving_listen_for_ptt() {
        let prev = with_mode(RecordingMode::Listen);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::StopListen
        );
    }

    #[test]
    fn stops_listen_when_leaving_listen_for_wakeword() {
        let prev = with_mode(RecordingMode::Listen);
        let next = with_mode(RecordingMode::Wakeword);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::StopListen
        );
    }

    #[test]
    fn stops_dictation_session_when_leaving_ptt_for_listen() {
        let prev = with_mode(RecordingMode::Ptt);
        let next = with_mode(RecordingMode::Listen);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::StopDictationSession
        );
    }

    #[test]
    fn stops_dictation_session_when_leaving_toggle_for_wakeword() {
        let prev = with_mode(RecordingMode::Toggle);
        let next = with_mode(RecordingMode::Wakeword);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::StopDictationSession
        );
    }

    #[test]
    fn noops_between_ptt_and_toggle() {
        let prev = with_mode(RecordingMode::Ptt);
        let next = with_mode(RecordingMode::Toggle);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::Noop
        );

        let prev = with_mode(RecordingMode::Toggle);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::Noop
        );
    }

    #[test]
    fn noop_when_leaving_wakeword() {
        // Wakeword's own disarm is handled by `apply_wakeword_runtime_settings`;
        // this handler must not double-act on it.
        let prev = with_mode(RecordingMode::Wakeword);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::Noop
        );
    }
}
