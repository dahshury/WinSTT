// Recording-mode runtime transition: every change is a hard boundary for
// backend-owned capture/session state, in TWO halves.
//
// 1. TEARDOWN (synchronous, on the settings command thread, inside
//    `RecordingModeTransitionGuard`): stop Listen if it is live, finalize any
//    mic-driven dictation through the normal transcription/paste path, and
//    disarm the wake-word detector. Runtime state, rather than the previous mode
//    label, is authoritative: that also repairs a stale capture left behind by an
//    earlier or racing transition. This half must stay short — `start_listen`
//    waits on that guard, so holding it across a model load would deadlock.
//
// 2. PREPARATION (background worker, published as `recording:mode-transition`):
//    make the NEW mode actually able to transcribe before the UI unlocks. The
//    shared engine holds exactly one STT model, so a mode change that crosses
//    Listen swaps which model that is:
//      * Listen → Ptt/Toggle/Wakeword reloads the main model (otherwise the swap
//        happened lazily inside the first decode — the user finished a whole
//        utterance before anything came back);
//      * → Listen keeps its renderer-driven start (`start_listen` owns the device
//        + native-streaming model choice), so the worker hands the phase off to it
//        rather than duplicating that policy here;
//      * → Wakeword builds the KWS session on arm.
//    Ptt ↔ Toggle prepares nothing and settles immediately, so the UI never
//    flickers a spinner for a switch that costs nothing.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::TranscriptionCoordinator;
use crate::winstt::commands::mode_transition;
use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};
use crate::winstt::settings_store::read_settings_raw;

/// Ceiling on the renderer-driven Listen start. `start_listen` settles the phase
/// itself; this only exists so a renderer that never issues the call (it bailed on
/// the model gate, or the window went away mid-switch) can't strand the switcher
/// in a permanent spinner.
const LISTEN_HANDOFF_TIMEOUT: Duration = Duration::from_secs(90);

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
        RecordingModeTransition::FinalizeBoundary => {
            let from = previous.general.recording_mode;
            let to = next.general.recording_mode;
            finalize_mode_boundary(app, from);
            spawn_mode_preparation(app, from, to);
        }
    }
}

/// What the worker still owes the UI once `prepare_mode` returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreparationOutcome {
    /// The new mode can transcribe now.
    Ready,
    /// The phase was handed to `start_listen`, which settles it.
    AwaitingListenStart,
}

/// True when the shared STT engine has to change hands. Listen loads its
/// native-streaming model into the same slot the main model occupies, so only a
/// transition that crosses Listen actually costs a load — `ptt ↔ toggle ↔
/// wakeword` reuses whatever is already resident.
fn requires_main_model_reload(from: RecordingMode, to: RecordingMode) -> bool {
    from == RecordingMode::Listen && to != RecordingMode::Listen
}

fn spawn_mode_preparation(app: &AppHandle, from: RecordingMode, to: RecordingMode) {
    // Nothing to load: settle in-band so the switcher never flashes a spinner for
    // a free switch (and no thread is spawned for it either).
    if !(requires_main_model_reload(from, to)
        || to == RecordingMode::Listen
        || to == RecordingMode::Wakeword)
    {
        let generation = mode_transition::begin(app, from, to);
        mode_transition::complete(app, generation);
        return;
    }

    let generation = mode_transition::begin(app, from, to);
    let worker_app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("winstt-recording-mode-prepare".to_string())
        .spawn(
            move || match prepare_mode(&worker_app, from, to, generation) {
                Ok(PreparationOutcome::Ready) => {
                    mode_transition::complete(&worker_app, generation);
                }
                Ok(PreparationOutcome::AwaitingListenStart) => {
                    arm_listen_handoff_watchdog(&worker_app, generation);
                }
                Err(err) => mode_transition::fail(&worker_app, generation, err),
            },
        )
    {
        // Without a worker the phase would never settle, so fail it here rather
        // than leaving the mode switcher locked behind a spinner forever.
        mode_transition::fail(
            app,
            generation,
            format!("failed to start the recording-mode preparation worker: {err}"),
        );
    }
}

/// Prepare the runtime the new mode needs. Blocking — runs on the worker thread.
fn prepare_mode(
    app: &AppHandle,
    from: RecordingMode,
    to: RecordingMode,
    generation: u64,
) -> Result<PreparationOutcome, String> {
    if requires_main_model_reload(from, to) {
        ensure_dictation_model_ready(app, generation)?;
    }
    match to {
        // Renderer-driven: `useListenMode` issues `start_listen`, which loads the
        // native-streaming model and then settles this phase.
        RecordingMode::Listen => Ok(PreparationOutcome::AwaitingListenStart),
        RecordingMode::Wakeword => {
            super::wakeword::arm_wakeword_runtime_for_mode_change(app, &read_settings_raw(app));
            Ok(PreparationOutcome::Ready)
        }
        RecordingMode::Ptt | RecordingMode::Toggle => Ok(PreparationOutcome::Ready),
    }
}

/// Load the user's selected dictation model so the first press after the switch
/// records against a warm engine. Onboarding stays model-free, and a missing
/// TranscriptionManager is a startup-order problem, not a user-visible failure.
fn ensure_dictation_model_ready(app: &AppHandle, generation: u64) -> Result<(), String> {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return Ok(());
    }
    // One engine slot, two loaders — see `mode_transition::lock_model_preparation`.
    let _preparation = mode_transition::lock_model_preparation();
    // A newer switch claimed the engine while this one waited for the lock (the
    // user typed listen → ptt → listen faster than a load takes). It already owns
    // the UI phase, and loading the main model now would evict the streaming model
    // `start_listen` just installed.
    if !mode_transition::is_current_generation(generation) {
        log::debug!("[recording-mode] skipping a superseded dictation-model reload");
        return Ok(());
    }
    let Some(transcription) =
        app.try_state::<std::sync::Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        log::warn!("[recording-mode] cannot reload the dictation model: manager is not managed");
        return Ok(());
    };
    let transcription = std::sync::Arc::clone(transcription.inner());
    transcription.ensure_selected_model_loaded()?;
    transcription.warmup();
    Ok(())
}

/// Fail an inherited Listen phase that nobody ever claimed. Runs on its own timer
/// thread so the worker can return as soon as it has handed off.
fn arm_listen_handoff_watchdog(app: &AppHandle, generation: u64) {
    let app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("winstt-listen-handoff-watchdog".to_string())
        .spawn(move || {
            std::thread::sleep(LISTEN_HANDOFF_TIMEOUT);
            mode_transition::fail(
                &app,
                generation,
                "Listen mode did not finish starting. Check that a realtime model is downloaded.",
            );
        })
    {
        log::warn!("[recording-mode] failed to arm the listen handoff watchdog: {err}");
    }
}

/// Stop every capture surface owned by the old mode. Listen's stop joins its
/// consumer so the final streaming segment is committed and persisted. Dictation
/// goes through the coordinator's normal stop action, which closes the microphone
/// synchronously and lets transcription/post-processing/paste finish asynchronously.
fn finalize_mode_boundary(app: &AppHandle, from: RecordingMode) {
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

    // Wake-word disarm moved here from `apply_wakeword_runtime_settings`, which now
    // defers every mode-crossing arm/disarm to this boundary so the two handlers
    // can't race each other's microphone stream on the same settings patch.
    if from == RecordingMode::Wakeword {
        super::wakeword::disarm_wakeword_runtime_for_mode_change(app);
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
    fn only_transitions_crossing_listen_reload_the_main_model() {
        // Leaving Listen hands the shared engine slot back to the main model.
        assert!(requires_main_model_reload(
            RecordingMode::Listen,
            RecordingMode::Ptt
        ));
        assert!(requires_main_model_reload(
            RecordingMode::Listen,
            RecordingMode::Wakeword
        ));
        // Entering Listen is `start_listen`'s job, and the mic-driven modes all
        // share one already-resident model.
        assert!(!requires_main_model_reload(
            RecordingMode::Ptt,
            RecordingMode::Listen
        ));
        assert!(!requires_main_model_reload(
            RecordingMode::Ptt,
            RecordingMode::Toggle
        ));
        assert!(!requires_main_model_reload(
            RecordingMode::Toggle,
            RecordingMode::Wakeword
        ));
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
