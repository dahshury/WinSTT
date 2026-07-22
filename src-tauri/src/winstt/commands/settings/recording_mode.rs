// Recording-mode runtime transition: every change is a hard boundary for
// backend-owned capture/session state. Mirrors the arm/disarm shape of
// `settings/wakeword.rs`, but only covers finalizing the OLD mode — the backend
// never auto-starts a mode's runtime:
//   * entering Listen stays renderer-driven (the renderer calls `start_listen` once
//     the user picks listen mode + a native-streaming model);
//   * entering Wakeword is already covered by `apply_wakeword_runtime_settings`.
//
// A mode change always stops Listen (if it happens to be live) and finalizes any
// mic-driven dictation through the normal transcription/paste path. Runtime state,
// rather than the previous mode label, is authoritative: that also repairs a stale
// capture left behind by an earlier or racing transition.

use tauri::{AppHandle, Manager};

use crate::TranscriptionCoordinator;
#[cfg(test)]
use crate::winstt::settings_schema::RecordingMode;
use crate::winstt::settings_schema::WinsttSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordingModeTransition {
    Noop,
    FinalizeBoundary,
}

fn recording_mode_transition(
    previous: &WinsttSettings,
    next: &WinsttSettings,
) -> RecordingModeTransition {
    let prev_mode = previous.general.recording_mode;
    let next_mode = next.general.recording_mode;
    if prev_mode == next_mode {
        RecordingModeTransition::Noop
    } else {
        RecordingModeTransition::FinalizeBoundary
    }
}

pub(super) fn apply_recording_mode_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    match recording_mode_transition(previous, next) {
        RecordingModeTransition::Noop => {}
        RecordingModeTransition::FinalizeBoundary => finalize_mode_boundary(app),
    }
}

/// Stop every capture surface owned by the old mode. Listen's stop joins its
/// consumer so the final streaming segment is committed and persisted. Dictation
/// goes through the coordinator's normal stop action, which closes the microphone
/// synchronously and lets transcription/post-processing/paste finish asynchronously.
fn finalize_mode_boundary(app: &AppHandle) {
    if let Some(loopback) =
        app.try_state::<std::sync::Arc<crate::winstt::managers::LoopbackManager>>()
    {
        crate::winstt::commands::listen::stop_listen_runtime(app, loopback.inner().as_ref());
    } else {
        log::warn!("[recording-mode] cannot reset listen mode: LoopbackManager is not managed");
    }

    if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
        coordinator.finalize_recording_mode_change();
    } else {
        log::warn!(
            "[recording-mode] cannot finalize dictation: TranscriptionCoordinator is not managed"
        );
    }

    log::info!("[recording-mode] finalized active capture state at mode boundary");
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
    fn finalizes_when_leaving_listen_for_ptt() {
        let prev = with_mode(RecordingMode::Listen);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }

    #[test]
    fn finalizes_when_leaving_listen_for_wakeword() {
        let prev = with_mode(RecordingMode::Listen);
        let next = with_mode(RecordingMode::Wakeword);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }

    #[test]
    fn finalizes_when_leaving_ptt_for_listen() {
        let prev = with_mode(RecordingMode::Ptt);
        let next = with_mode(RecordingMode::Listen);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }

    #[test]
    fn finalizes_when_leaving_toggle_for_wakeword() {
        let prev = with_mode(RecordingMode::Toggle);
        let next = with_mode(RecordingMode::Wakeword);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }

    #[test]
    fn finalizes_between_ptt_and_toggle() {
        let prev = with_mode(RecordingMode::Ptt);
        let next = with_mode(RecordingMode::Toggle);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );

        let prev = with_mode(RecordingMode::Toggle);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }

    #[test]
    fn finalizes_when_leaving_wakeword() {
        let prev = with_mode(RecordingMode::Wakeword);
        let next = with_mode(RecordingMode::Ptt);
        assert_eq!(
            recording_mode_transition(&prev, &next),
            RecordingModeTransition::FinalizeBoundary
        );
    }
}
