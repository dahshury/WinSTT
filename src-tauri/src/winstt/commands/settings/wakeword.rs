// Wakeword runtime state machine: transition computation, arm/disarm against
// WakeWordManager + AudioRecordingManager, startup-arm + rearm entry points,
// recording-error emit.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};
use crate::winstt::settings_store::read_settings_raw;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WakewordRuntimeTransition {
    Noop,
    Arm,
    Disarm,
    Refresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WakewordArmReadiness {
    Ready,
    MissingModelBundle,
    DetectorUnavailable,
}

fn wakeword_arm_readiness(has_detector: bool, has_model_bundle: bool) -> WakewordArmReadiness {
    if has_detector {
        WakewordArmReadiness::Ready
    } else if !has_model_bundle {
        WakewordArmReadiness::MissingModelBundle
    } else {
        WakewordArmReadiness::DetectorUnavailable
    }
}

fn wakeword_runtime_transition(
    previous: Option<&WinsttSettings>,
    next: &WinsttSettings,
) -> WakewordRuntimeTransition {
    let next_is_wakeword = next.general.recording_mode == RecordingMode::Wakeword;
    let Some(previous) = previous else {
        return if next_is_wakeword {
            WakewordRuntimeTransition::Arm
        } else {
            WakewordRuntimeTransition::Noop
        };
    };

    let previous_is_wakeword = previous.general.recording_mode == RecordingMode::Wakeword;
    match (previous_is_wakeword, next_is_wakeword) {
        (false, true) => WakewordRuntimeTransition::Arm,
        (true, false) => WakewordRuntimeTransition::Disarm,
        (true, true)
            if wake_config_changed_while_in_wakeword(
                previous.general.recording_mode,
                next.general.recording_mode,
                previous,
                next,
            ) =>
        {
            WakewordRuntimeTransition::Refresh
        }
        _ => WakewordRuntimeTransition::Noop,
    }
}

pub(super) fn apply_wakeword_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }

    apply_wakeword_runtime_transition(app, wakeword_runtime_transition(Some(previous), next), next);
}

pub(crate) fn sync_wakeword_runtime_from_settings(app: &AppHandle) {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }

    let settings = read_settings_raw(app);
    apply_wakeword_runtime_transition(app, wakeword_runtime_transition(None, &settings), &settings);
}

pub(crate) fn sync_wakeword_runtime_from_settings_in_background(app: &AppHandle) {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }

    let app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("winstt-wakeword-startup-arm".to_string())
        .spawn(move || sync_wakeword_runtime_from_settings(&app))
    {
        log::warn!("[wakeword] failed to start startup arm thread: {err}");
    }
}

pub(crate) fn rearm_wakeword_runtime_if_active(app: &AppHandle) {
    let settings = read_settings_raw(app);
    if settings.general.recording_mode == RecordingMode::Wakeword {
        apply_wakeword_runtime_transition(app, WakewordRuntimeTransition::Arm, &settings);
    }
}

pub(crate) fn disarm_wakeword_runtime_for_onboarding(app: &AppHandle) {
    disarm_wakeword_runtime(app);
}

fn apply_wakeword_runtime_transition(
    app: &AppHandle,
    transition: WakewordRuntimeTransition,
    settings: &WinsttSettings,
) {
    match transition {
        WakewordRuntimeTransition::Noop => {}
        WakewordRuntimeTransition::Arm | WakewordRuntimeTransition::Refresh => {
            arm_wakeword_runtime(app, settings);
        }
        WakewordRuntimeTransition::Disarm => {
            disarm_wakeword_runtime(app);
        }
    }
}

fn arm_wakeword_runtime(app: &AppHandle, settings: &WinsttSettings) {
    let Some(wakeword) = app.try_state::<Arc<crate::winstt::managers::WakeWordManager>>() else {
        log::warn!("[wakeword] cannot arm: WakeWordManager is not managed");
        return;
    };
    let Some(audio) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>() else {
        log::warn!("[wakeword] cannot arm: AudioRecordingManager is not managed");
        wakeword.set_armed(false);
        return;
    };
    if audio.is_recording() {
        wakeword.set_armed(false);
        log::debug!("[wakeword] delaying arm until the active recording finishes");
        return;
    }

    if let Err(err) = wakeword.set_wake_word(
        &settings.general.wake_word,
        settings.general.wake_word_sensitivity as f32,
        settings.general.wake_word_timeout as f32,
    ) {
        log::warn!("[wakeword] failed to configure detector: {err}");
        wakeword.set_armed(false);
        return;
    }

    match wakeword_arm_readiness(wakeword.has_detector(), wakeword.has_model_bundle()) {
        WakewordArmReadiness::Ready => {}
        WakewordArmReadiness::MissingModelBundle => {
            wakeword.set_armed(false);
            if wakeword.start_model_bundle_download_if_missing() {
                log::info!(
                    "[wakeword] KWS model bundle missing; download started before microphone arm"
                );
            } else if wakeword.model_bundle_download_inflight() {
                log::debug!(
                    "[wakeword] KWS model bundle download already in progress; delaying arm"
                );
            } else {
                log::debug!(
                    "[wakeword] KWS model bundle is still unavailable; delaying microphone arm"
                );
            }
            return;
        }
        WakewordArmReadiness::DetectorUnavailable => {
            wakeword.set_armed(false);
            log::warn!(
                "[wakeword] detector unavailable for '{}' even though the KWS model bundle exists",
                settings.general.wake_word
            );
            return;
        }
    }

    if let Err(err) = audio.inner().ensure_wakeword_listening_stream() {
        let detail = err.to_string();
        log::warn!("[wakeword] failed to open microphone stream: {detail}");
        wakeword.set_armed(false);
        emit_recording_error(app, &detail);
        return;
    }

    wakeword.set_armed(true);
    let _ = app.emit("stt:wakeword-detection-start", ());
    log::info!(
        "[wakeword] listening for '{}' via live microphone stream",
        wakeword.current_phrase()
    );
}

fn disarm_wakeword_runtime(app: &AppHandle) {
    let mut stopped = false;
    if let Some(wakeword) = app.try_state::<Arc<crate::winstt::managers::WakeWordManager>>() {
        stopped |= wakeword.set_armed(false);
    }
    if let Some(audio) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>() {
        audio.inner().stop_wakeword_listening_stream_if_idle();
    }
    if stopped {
        let _ = app.emit("stt:wakeword-detection-end", ());
        log::info!("[wakeword] detection stopped");
    }
}

fn emit_recording_error(app: &AppHandle, detail: &str) {
    let error_type = if crate::audio_toolkit::is_microphone_access_denied(detail) {
        "microphone_permission_denied"
    } else if crate::audio_toolkit::is_no_input_device_error(detail) {
        "no_input_device"
    } else {
        "unknown"
    };
    let _ = app.emit(
        crate::winstt::commands::events::names::RECORDING_ERROR,
        serde_json::json!({
            "error_type": error_type,
            "detail": detail,
        }),
    );
}

/// Any of the wakeword CLI params (`wakeWord` / `wakeWordSensitivity` /
/// `wakeWordTimeout`) changed while staying in wakeword mode — the detector is built
/// once from these at bootstrap, so a change needs a rebuild.
fn wake_config_changed_while_in_wakeword(
    old_mode: RecordingMode,
    new_mode: RecordingMode,
    prev: &WinsttSettings,
    next: &WinsttSettings,
) -> bool {
    if old_mode != RecordingMode::Wakeword || new_mode != RecordingMode::Wakeword {
        return false;
    }
    prev.general.wake_word != next.general.wake_word
        || prev.general.wake_word_sensitivity != next.general.wake_word_sensitivity
        || prev.general.wake_word_timeout != next.general.wake_word_timeout
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wakeword_runtime_arms_on_startup_when_persisted_mode_is_wakeword() {
        let mut next = WinsttSettings::default();
        next.general.recording_mode = RecordingMode::Wakeword;

        assert_eq!(
            wakeword_runtime_transition(None, &next),
            WakewordRuntimeTransition::Arm
        );
    }

    #[test]
    fn wakeword_runtime_arms_when_entering_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Ptt;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Wakeword;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Arm
        );
    }

    #[test]
    fn wakeword_runtime_disarms_when_leaving_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Wakeword;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Ptt;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Disarm
        );
    }

    #[test]
    fn wakeword_runtime_refreshes_config_while_staying_in_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Wakeword;
        prev.general.wake_word = "alexa".into();
        let mut next = prev.clone();
        next.general.wake_word = "computer".into();

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Refresh
        );
    }

    #[test]
    fn wakeword_runtime_noops_for_non_wakeword_mode_changes() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Ptt;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Toggle;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Noop
        );
    }

    #[test]
    fn wakeword_arm_readiness_requires_detector_before_microphone() {
        assert_eq!(
            wakeword_arm_readiness(true, true),
            WakewordArmReadiness::Ready
        );
        assert_eq!(
            wakeword_arm_readiness(true, false),
            WakewordArmReadiness::Ready
        );
        assert_eq!(
            wakeword_arm_readiness(false, false),
            WakewordArmReadiness::MissingModelBundle
        );
        assert_eq!(
            wakeword_arm_readiness(false, true),
            WakewordArmReadiness::DetectorUnavailable
        );
    }
}
