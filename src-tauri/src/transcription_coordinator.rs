use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use log::{debug, error, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(30);
const RELEASE_GRACE: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PttAction {
    Passthrough,
    DeferRelease,
    CancelRelease,
    IgnoreDuplicateRelease,
}

struct PendingRelease {
    binding_id: String,
    hotkey_string: String,
    session_id: u64,
    recording_generation: u64,
    deadline: Instant,
}

static CURRENT_DICTATION_SESSION: AtomicU64 = AtomicU64::new(0);
static CANCELLED_DICTATION_THROUGH: AtomicU64 = AtomicU64::new(0);
static DICTATION_PIPELINE_ACTIVE: AtomicBool = AtomicBool::new(false);

pub(crate) fn begin_dictation_session() -> u64 {
    let session_id = CURRENT_DICTATION_SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    DICTATION_PIPELINE_ACTIVE.store(true, Ordering::SeqCst);
    session_id
}

pub(crate) fn current_dictation_session() -> u64 {
    CURRENT_DICTATION_SESSION.load(Ordering::SeqCst)
}

pub(crate) fn cancel_current_dictation_session() -> Option<u64> {
    if !DICTATION_PIPELINE_ACTIVE.swap(false, Ordering::SeqCst) {
        return None;
    }
    let session_id = current_dictation_session();
    CANCELLED_DICTATION_THROUGH.fetch_max(session_id, Ordering::SeqCst);
    // Wake the post-processing watcher so an in-flight LLM cleanup is dropped
    // now instead of when its next cancellation-aware await resolves.
    crate::actions::notify_post_processing_escape();
    Some(session_id)
}

pub(crate) fn finish_dictation_session(session_id: u64) {
    if is_current_dictation_session(session_id) {
        DICTATION_PIPELINE_ACTIVE.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn is_dictation_pipeline_active() -> bool {
    DICTATION_PIPELINE_ACTIVE.load(Ordering::SeqCst)
}

pub(crate) fn is_dictation_session_cancelled(session_id: u64) -> bool {
    session_id != 0 && session_id <= CANCELLED_DICTATION_THROUGH.load(Ordering::SeqCst)
}

pub(crate) fn is_current_dictation_session(session_id: u64) -> bool {
    session_id != 0 && session_id == current_dictation_session()
}

/// Commands processed sequentially by the coordinator thread.
enum Command {
    Input {
        binding_id: String,
        hotkey_string: String,
        is_pressed: bool,
        push_to_talk: bool,
    },
    Cancel {
        recording_was_active: bool,
        cancelled_through: u64,
    },
    SilenceStop {
        binding_id: String,
        recording_generation: u64,
    },
    ProcessingFinished {
        session_id: u64,
    },
    /// A recording-mode change is a hard lifecycle boundary. If a mic capture is
    /// still open, stop it through the normal TranscribeAction finalizer so the
    /// captured audio continues through transcription/paste instead of being
    /// discarded. The acknowledgement is sent after the recorder has closed and
    /// the async transcription task has been launched.
    FinalizeRecordingModeChange {
        completed: Sender<()>,
    },
}

/// Pipeline lifecycle, owned exclusively by the coordinator thread.
enum Stage {
    Idle,
    Recording { binding_id: String, session_id: u64 },
    Processing { session_id: u64 },
}

enum CoordinatorWake {
    Command(Command),
    ReleaseDeadline,
    Disconnected,
}

fn classify_ptt_event(
    pending_release_binding: Option<&str>,
    is_pressed: bool,
    push_to_talk: bool,
    binding_id: &str,
    recording_binding: Option<&str>,
) -> PttAction {
    if !push_to_talk {
        return PttAction::Passthrough;
    }

    if is_pressed {
        if pending_release_binding == Some(binding_id) {
            PttAction::CancelRelease
        } else {
            PttAction::Passthrough
        }
    } else if recording_binding == Some(binding_id) {
        if pending_release_binding == Some(binding_id) {
            PttAction::IgnoreDuplicateRelease
        } else if pending_release_binding.is_none() {
            PttAction::DeferRelease
        } else {
            PttAction::Passthrough
        }
    } else {
        PttAction::Passthrough
    }
}

fn receive_next(
    rx: &Receiver<Command>,
    pending_release: Option<&PendingRelease>,
) -> CoordinatorWake {
    let Some(pending) = pending_release else {
        return match rx.recv() {
            Ok(command) => CoordinatorWake::Command(command),
            Err(_) => CoordinatorWake::Disconnected,
        };
    };

    match rx.recv_timeout(pending.deadline.saturating_duration_since(Instant::now())) {
        Ok(command) => CoordinatorWake::Command(command),
        Err(RecvTimeoutError::Timeout) => CoordinatorWake::ReleaseDeadline,
        Err(RecvTimeoutError::Disconnected) => CoordinatorWake::Disconnected,
    }
}

/// Serialises all transcription lifecycle events through a single thread
/// to eliminate race conditions between keyboard shortcuts, signals, and
/// the async transcribe-paste pipeline.
pub struct TranscriptionCoordinator {
    tx: Sender<Command>,
}

pub fn is_transcribe_binding(id: &str) -> bool {
    id == "transcribe"
}

impl TranscriptionCoordinator {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let mut stage = Stage::Idle;
            let mut last_press: Option<Instant> = None;
            // When we entered `Processing`, so a press arriving after the pipeline has been
            // stuck far longer than any real decode can self-heal instead of ignoring the
            // hotkey forever. See `recover_wedged_stage`.
            let mut processing_since: Option<Instant> = None;
            let mut pending_release: Option<PendingRelease> = None;

            loop {
                let wake = receive_next(&rx, pending_release.as_ref());
                if matches!(&wake, CoordinatorWake::Disconnected) {
                    break;
                }

                // Process EACH command inside catch_unwind. `start`/`stop` run the synchronous
                // action body (open mic, tray/overlay, emits) on THIS thread — if any of that
                // panics (e.g. a flaky audio device faulting in cpal while a recorder lock is
                // held), the panic must NOT kill the dispatch thread. A dead dispatch thread was
                // a permanent "PTT does nothing until the app is restarted" wedge: the hotkey
                // events still arrived but nothing consumed them. On a caught panic we snap the
                // Stage back to Idle so the very next press records again.
                let outcome =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match wake {
                        CoordinatorWake::Command(cmd) => handle_command(
                            &app,
                            cmd,
                            &mut stage,
                            &mut last_press,
                            &mut processing_since,
                            &mut pending_release,
                        ),
                        CoordinatorWake::ReleaseDeadline => expire_pending_release(
                            &app,
                            &mut stage,
                            &mut processing_since,
                            &mut pending_release,
                        ),
                        CoordinatorWake::Disconnected => {}
                    }));
                if let Err(e) = outcome {
                    error!(
                        "Transcription coordinator recovered from a panic in command handling: {e:?}"
                    );
                    stage = Stage::Idle;
                    processing_since = None;
                    pending_release = None;
                }
            }
            debug!("Transcription coordinator exited");
        });

        Self { tx }
    }

    /// Send a keyboard/signal input event for a transcribe binding.
    /// For signal-based toggles, use `is_pressed: true` and `push_to_talk: false`.
    pub fn send_input(
        &self,
        binding_id: &str,
        hotkey_string: &str,
        is_pressed: bool,
        push_to_talk: bool,
    ) {
        if self
            .tx
            .send(Command::Input {
                binding_id: binding_id.to_string(),
                hotkey_string: hotkey_string.to_string(),
                is_pressed,
                push_to_talk,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    pub fn notify_cancel(&self, recording_was_active: bool, cancelled_through: u64) {
        if self
            .tx
            .send(Command::Cancel {
                recording_was_active,
                cancelled_through,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    pub fn request_silence_stop(&self, binding_id: &str, recording_generation: u64) {
        if self
            .tx
            .send(Command::SilenceStop {
                binding_id: binding_id.to_string(),
                recording_generation,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    pub fn notify_processing_finished(&self, session_id: u64) {
        if self
            .tx
            .send(Command::ProcessingFinished { session_id })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    /// Close any active mic capture at a recording-mode boundary without
    /// cancelling its output. Waiting for the coordinator acknowledgement keeps
    /// a newly selected mode (especially Listen) from opening another capture
    /// before the old recorder has handed its audio to the normal paste pipeline.
    pub fn finalize_recording_mode_change(&self) {
        let (completed_tx, completed_rx) = mpsc::channel();
        if self
            .tx
            .send(Command::FinalizeRecordingModeChange {
                completed: completed_tx,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed during recording-mode change");
            return;
        }

        if completed_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            warn!(
                "Timed out waiting for active recording to finalize during recording-mode change"
            );
        }
    }
}

/// Handle one coordinator command, mutating the pipeline `stage` (and its bookkeeping). Pulled
/// out of the run loop so each call can be wrapped in `catch_unwind` — a panic in the
/// synchronous `start`/`stop` action body is then contained to one command instead of killing
/// the whole dispatch thread.
fn handle_command(
    app: &AppHandle,
    cmd: Command,
    stage: &mut Stage,
    last_press: &mut Option<Instant>,
    processing_since: &mut Option<Instant>,
    pending_release: &mut Option<PendingRelease>,
) {
    match cmd {
        Command::Input {
            binding_id,
            hotkey_string,
            is_pressed,
            push_to_talk,
        } => {
            if !push_to_talk && pending_release.take().is_some() {
                debug!("Cleared deferred PTT release before toggle input for '{binding_id}'");
            }

            let pending_release_binding = pending_release
                .as_ref()
                .map(|pending| pending.binding_id.as_str());
            let recording_binding = match &*stage {
                Stage::Recording { binding_id, .. } => Some(binding_id.as_str()),
                Stage::Idle | Stage::Processing { .. } => None,
            };

            match classify_ptt_event(
                pending_release_binding,
                is_pressed,
                push_to_talk,
                &binding_id,
                recording_binding,
            ) {
                PttAction::CancelRelease => {
                    let release_is_current = pending_release.as_ref().is_some_and(|pending| {
                        pending_release_matches_recording(
                            pending,
                            stage,
                            recorder_generation(app),
                            recorder_is_recording(app),
                        )
                    });
                    *pending_release = None;
                    if release_is_current {
                        debug!("Cancelled deferred PTT release for '{binding_id}'");
                        return;
                    }
                    debug!(
                        "Discarded stale deferred PTT release for '{binding_id}'; processing press"
                    );
                }
                PttAction::DeferRelease => {
                    let session_id = match &*stage {
                        Stage::Recording {
                            binding_id: recording_binding,
                            session_id,
                        } if recording_binding == &binding_id => Some(*session_id),
                        Stage::Idle | Stage::Recording { .. } | Stage::Processing { .. } => None,
                    };
                    if let (Some(session_id), Some(recording_generation)) =
                        (session_id, recorder_generation(app))
                    {
                        *pending_release = Some(PendingRelease {
                            binding_id,
                            hotkey_string,
                            session_id,
                            recording_generation,
                            deadline: Instant::now() + RELEASE_GRACE,
                        });
                        return;
                    }
                    debug!(
                        "Could not snapshot recording state for deferred PTT release; stopping immediately"
                    );
                }
                PttAction::IgnoreDuplicateRelease => {
                    debug!("Ignored duplicate deferred PTT release for '{binding_id}'");
                    return;
                }
                PttAction::Passthrough => {}
            }

            // Debounce rapid-fire press events (key repeat / double-tap).
            // Push-to-talk releases may be deferred above to absorb synthetic auto-repeat.
            if is_pressed {
                let now = Instant::now();
                if last_press.is_some_and(|t| now.duration_since(t) < DEBOUNCE) {
                    debug!("Debounced press for '{binding_id}'");
                    return;
                }
                *last_press = Some(now);
                // SELF-HEAL on every fresh press: if the Stage machine is wedged (we believe
                // we're recording but the recorder is idle, or we've sat in Processing far past
                // any real decode), reset to Idle so the press can start a recording.
                recover_wedged_stage(app, stage, processing_since);
            }

            if push_to_talk {
                if is_pressed && matches!(stage, Stage::Idle) {
                    start(app, stage, &binding_id, &hotkey_string);
                } else if !is_pressed
                    && matches!(&*stage, Stage::Recording { binding_id: id, .. } if id == &binding_id)
                {
                    stop(app, stage, &binding_id, &hotkey_string);
                    *processing_since = Some(Instant::now());
                }
            } else if is_pressed {
                match &*stage {
                    Stage::Idle => {
                        start(app, stage, &binding_id, &hotkey_string);
                    }
                    Stage::Recording { binding_id: id, .. } if id == &binding_id => {
                        stop(app, stage, &binding_id, &hotkey_string);
                        *processing_since = Some(Instant::now());
                    }
                    _ => {
                        debug!("Ignoring press for '{binding_id}': pipeline busy")
                    }
                }
            }
        }
        Command::Cancel {
            recording_was_active,
            cancelled_through,
        } => {
            *pending_release = None;
            // Escape cancels the active session immediately; stale workers self-suppress by id.
            let stage_cancelled = match stage {
                Stage::Recording { session_id, .. } | Stage::Processing { session_id } => {
                    *session_id != 0 && *session_id <= cancelled_through
                }
                Stage::Idle => false,
            };

            if recording_was_active || stage_cancelled {
                *stage = Stage::Idle;
                *processing_since = None;
                DICTATION_PIPELINE_ACTIVE.store(false, Ordering::SeqCst);
                crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
            }
        }
        Command::SilenceStop {
            binding_id,
            recording_generation,
        } => {
            clear_pending_release_for_stop(pending_release, &binding_id, recording_generation);
            recover_wedged_stage(app, stage, processing_since);
            if matches!(&*stage, Stage::Recording { binding_id: id, .. } if id == &binding_id)
                && recorder_generation(app) == Some(recording_generation)
                && silence_auto_stop_enabled(app)
            {
                stop(app, stage, &binding_id, "");
                *processing_since = Some(Instant::now());
            } else {
                debug!(
                    "Ignoring silence-stop for '{binding_id}': stage/generation/settings no longer match"
                );
            }
        }
        Command::ProcessingFinished { session_id } => {
            clear_pending_release_for_session(pending_release, session_id);
            if matches!(&*stage, Stage::Processing { session_id: id } if *id == session_id) {
                *stage = Stage::Idle;
                *processing_since = None;
                finish_dictation_session(session_id);
                crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
            }
        }
        Command::FinalizeRecordingModeChange { completed } => {
            *pending_release = None;
            recover_wedged_stage(app, stage, processing_since);

            let recording_binding = match &*stage {
                Stage::Recording { binding_id, .. } => Some(binding_id.clone()),
                Stage::Idle | Stage::Processing { .. } if recorder_is_recording(app) => {
                    // Defensive recovery for a recorder that outlived its stage.
                    // All mic dictation modes use this one binding.
                    warn!(
                        "Finalizing recorder with no matching coordinator Recording stage during mode change"
                    );
                    Some("transcribe".to_string())
                }
                Stage::Idle | Stage::Processing { .. } => None,
            };

            if let Some(binding_id) = recording_binding {
                stop(app, stage, &binding_id, "recording-mode-change");
                *processing_since = Some(Instant::now());
            }

            let _ = completed.send(());
        }
    }
}

fn pending_release_matches_recording(
    pending: &PendingRelease,
    stage: &Stage,
    recording_generation: Option<u64>,
    recorder_is_recording: bool,
) -> bool {
    recorder_is_recording
        && recording_generation == Some(pending.recording_generation)
        && matches!(
            stage,
            Stage::Recording {
                binding_id,
                session_id,
            } if binding_id == &pending.binding_id && *session_id == pending.session_id
        )
}

fn pending_release_matches_stop_request(
    pending: &PendingRelease,
    binding_id: &str,
    recording_generation: u64,
) -> bool {
    pending.binding_id == binding_id && pending.recording_generation == recording_generation
}

fn pending_release_matches_session(pending: &PendingRelease, session_id: u64) -> bool {
    pending.session_id == session_id
}

fn clear_pending_release_for_stop(
    pending_release: &mut Option<PendingRelease>,
    binding_id: &str,
    recording_generation: u64,
) {
    if pending_release.as_ref().is_some_and(|pending| {
        pending_release_matches_stop_request(pending, binding_id, recording_generation)
    }) {
        *pending_release = None;
    }
}

fn clear_pending_release_for_session(
    pending_release: &mut Option<PendingRelease>,
    session_id: u64,
) {
    if pending_release
        .as_ref()
        .is_some_and(|pending| pending_release_matches_session(pending, session_id))
    {
        *pending_release = None;
    }
}

fn expire_pending_release(
    app: &AppHandle,
    stage: &mut Stage,
    processing_since: &mut Option<Instant>,
    pending_release: &mut Option<PendingRelease>,
) {
    let Some(pending) = pending_release.take() else {
        return;
    };

    if pending_release_matches_recording(
        &pending,
        stage,
        recorder_generation(app),
        recorder_is_recording(app),
    ) {
        stop(app, stage, &pending.binding_id, &pending.hotkey_string);
        *processing_since = Some(Instant::now());
    } else {
        debug!(
            "Ignored stale deferred PTT release for '{}' (session={}, generation={})",
            pending.binding_id, pending.session_id, pending.recording_generation
        );
    }
}

/// Wedge-recovery threshold. A real PTT decode — even a cold DirectML kernel JIT or a cloud
/// round-trip — completes in well under this. If we're still in `Processing` past it when a
/// fresh press arrives, the pipeline lost its `ProcessingFinished` (a hung or dropped
/// transcribe) and we recover rather than ignoring the hotkey forever.
const PROCESSING_WEDGE_TIMEOUT: Duration = Duration::from_secs(45);

fn recorder_is_recording(app: &AppHandle) -> bool {
    app.try_state::<Arc<AudioRecordingManager>>()
        .is_some_and(|a| a.is_recording())
}

fn recorder_generation(app: &AppHandle) -> Option<u64> {
    app.try_state::<Arc<AudioRecordingManager>>()
        .map(|a| a.recording_generation())
}

fn silence_auto_stop_enabled(app: &AppHandle) -> bool {
    let settings = crate::winstt::commands::settings::read_settings_raw(app);
    crate::managers::audio::silence_auto_stop_delay(&settings).is_some()
}

/// Reset a wedged `stage` back to `Idle` so the next press can record. Two wedge shapes are
/// recovered: (1) `Recording` while the recorder is actually idle (a lost release/stop), and
/// (2) `Processing` held longer than any real decode (a lost `ProcessingFinished`, e.g. a
/// transcribe that hung). A legitimately in-flight pipeline (recorder still recording, or a
/// decode under the timeout) is left untouched, so normal serialize-during-processing behavior
/// is preserved.
fn recover_wedged_stage(
    app: &AppHandle,
    stage: &mut Stage,
    processing_since: &mut Option<Instant>,
) {
    match stage {
        Stage::Recording { .. } if !recorder_is_recording(app) => {
            debug!("Coordinator self-heal: Recording stage but recorder idle -> Idle");
            *stage = Stage::Idle;
            *processing_since = None;
            DICTATION_PIPELINE_ACTIVE.store(false, Ordering::SeqCst);
        }
        Stage::Processing { .. }
            if processing_since.is_some_and(|t| t.elapsed() >= PROCESSING_WEDGE_TIMEOUT) =>
        {
            warn!(
                "Coordinator self-heal: stuck in Processing for >{}s -> Idle",
                PROCESSING_WEDGE_TIMEOUT.as_secs()
            );
            *stage = Stage::Idle;
            *processing_since = None;
            DICTATION_PIPELINE_ACTIVE.store(false, Ordering::SeqCst);
        }
        _ => {}
    }
}

fn start(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.start(app, binding_id, hotkey_string);
    if app
        .try_state::<Arc<AudioRecordingManager>>()
        .is_some_and(|a| a.is_recording())
    {
        *stage = Stage::Recording {
            binding_id: binding_id.to_string(),
            session_id: current_dictation_session(),
        };
    } else {
        debug!("Start for '{binding_id}' did not begin recording; staying idle");
        crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
    }
}

fn stop(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.stop(app, binding_id, hotkey_string);
    *stage = Stage::Processing {
        session_id: current_dictation_session(),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_release(session_id: u64, recording_generation: u64) -> PendingRelease {
        PendingRelease {
            binding_id: "transcribe".to_string(),
            hotkey_string: String::new(),
            session_id,
            recording_generation,
            deadline: Instant::now() + RELEASE_GRACE,
        }
    }

    #[test]
    fn ptt_release_while_matching_recording_is_deferred() {
        let action = classify_ptt_event(None, false, true, "transcribe", Some("transcribe"));

        assert_eq!(action, PttAction::DeferRelease);
    }

    #[test]
    fn matching_repeat_press_cancels_deferred_release() {
        let action = classify_ptt_event(
            Some("transcribe"),
            true,
            true,
            "transcribe",
            Some("transcribe"),
        );

        assert_eq!(action, PttAction::CancelRelease);
    }

    #[test]
    fn duplicate_release_keeps_existing_grace_deadline() {
        let action = classify_ptt_event(
            Some("transcribe"),
            false,
            true,
            "transcribe",
            Some("transcribe"),
        );

        assert_eq!(action, PttAction::IgnoreDuplicateRelease);
    }

    #[test]
    fn different_binding_press_does_not_cancel_deferred_release() {
        let action = classify_ptt_event(
            Some("transcribe"),
            true,
            true,
            "other-transcribe",
            Some("transcribe"),
        );

        assert_eq!(action, PttAction::Passthrough);
    }

    #[test]
    fn toggle_inputs_are_not_classified_as_ptt_repeats() {
        let press = classify_ptt_event(
            Some("transcribe"),
            true,
            false,
            "transcribe",
            Some("transcribe"),
        );
        let release = classify_ptt_event(None, false, false, "transcribe", Some("transcribe"));

        assert_eq!(
            (press, release),
            (PttAction::Passthrough, PttAction::Passthrough)
        );
    }

    #[test]
    fn deferred_release_matches_only_its_session_and_generation() {
        let pending = pending_release(41, 7);
        let stage = Stage::Recording {
            binding_id: "transcribe".to_string(),
            session_id: 41,
        };

        assert!(pending_release_matches_recording(
            &pending,
            &stage,
            Some(7),
            true
        ));
    }

    #[test]
    fn stale_deferred_release_cannot_stop_new_session() {
        let pending = pending_release(41, 7);
        let stage = Stage::Recording {
            binding_id: "transcribe".to_string(),
            session_id: 42,
        };

        assert!(!pending_release_matches_recording(
            &pending,
            &stage,
            Some(8),
            true
        ));
    }

    #[test]
    fn stale_silence_stop_does_not_match_newer_deferred_release() {
        let mut pending = Some(pending_release(42, 8));

        clear_pending_release_for_stop(&mut pending, "transcribe", 7);

        assert!(pending.is_some());
    }

    #[test]
    fn matching_silence_stop_clears_deferred_release() {
        let mut pending = Some(pending_release(42, 8));

        clear_pending_release_for_stop(&mut pending, "transcribe", 8);

        assert!(pending.is_none());
    }

    #[test]
    fn stale_processing_completion_does_not_match_newer_deferred_release() {
        let mut pending = Some(pending_release(42, 8));

        clear_pending_release_for_session(&mut pending, 41);

        assert!(pending.is_some());
    }

    #[test]
    fn matching_processing_completion_clears_deferred_release() {
        let mut pending = Some(pending_release(42, 8));

        clear_pending_release_for_session(&mut pending, 42);

        assert!(pending.is_none());
    }

    #[test]
    fn expired_grace_wakes_coordinator_without_sleeping() {
        let (_tx, rx) = mpsc::channel();
        let mut pending = pending_release(1, 1);
        pending.deadline = Instant::now();

        let wake = receive_next(&rx, Some(&pending));

        assert!(matches!(wake, CoordinatorWake::ReleaseDeadline));
    }

    #[derive(Default)]
    struct ReleaseSequenceHarness {
        pending: bool,
        recording: bool,
        stops: usize,
    }

    impl ReleaseSequenceHarness {
        fn input(&mut self, is_pressed: bool) {
            let action = classify_ptt_event(
                self.pending.then_some("transcribe"),
                is_pressed,
                true,
                "transcribe",
                self.recording.then_some("transcribe"),
            );
            match action {
                PttAction::Passthrough if is_pressed => self.recording = true,
                PttAction::DeferRelease => self.pending = true,
                PttAction::CancelRelease => self.pending = false,
                PttAction::IgnoreDuplicateRelease | PttAction::Passthrough => {}
            }
        }

        fn expire_grace(&mut self) {
            if self.pending && self.recording {
                self.pending = false;
                self.recording = false;
                self.stops += 1;
            }
        }
    }

    #[test]
    fn windows_repeat_burst_does_not_create_a_false_stop() {
        // Windows global-hotkey backends may surface a release followed almost
        // immediately by an auto-repeat press while the physical key is still
        // held. The repeat cancels the deferred release; only the later genuine
        // key-up crosses the grace deadline and stops exactly once.
        let mut sim = ReleaseSequenceHarness::default();
        sim.input(true);
        sim.input(false);
        sim.input(true);
        sim.expire_grace();
        assert!(sim.recording);
        assert_eq!(sim.stops, 0);

        sim.input(false);
        sim.expire_grace();
        assert!(!sim.recording);
        assert_eq!(sim.stops, 1);
    }

    #[test]
    fn linux_duplicate_release_burst_stops_once_at_genuine_deadline() {
        // Linux/X11 backends can duplicate the release edge. A duplicate must
        // retain the original deadline rather than scheduling a second stop.
        let mut sim = ReleaseSequenceHarness::default();
        sim.input(true);
        sim.input(false);
        sim.input(false);
        assert!(sim.pending);
        sim.expire_grace();
        sim.expire_grace();
        assert!(!sim.recording);
        assert_eq!(sim.stops, 1);
    }
}
