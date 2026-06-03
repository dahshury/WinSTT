use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use log::{debug, error, warn};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(30);

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
    },
    SilenceStop {
        binding_id: String,
        recording_generation: u64,
    },
    ProcessingFinished,
}

/// Pipeline lifecycle, owned exclusively by the coordinator thread.
enum Stage {
    Idle,
    Recording(String), // binding_id
    Processing,
}

/// Serialises all transcription lifecycle events through a single thread
/// to eliminate race conditions between keyboard shortcuts, signals, and
/// the async transcribe-paste pipeline.
pub struct TranscriptionCoordinator {
    tx: Sender<Command>,
}

pub fn is_transcribe_binding(id: &str) -> bool {
    id == "transcribe" || id == "transcribe_with_post_process"
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

            while let Ok(cmd) = rx.recv() {
                // Process EACH command inside catch_unwind. `start`/`stop` run the synchronous
                // action body (open mic, tray/overlay, emits) on THIS thread — if any of that
                // panics (e.g. a flaky audio device faulting in cpal while a recorder lock is
                // held), the panic must NOT kill the dispatch thread. A dead dispatch thread was
                // a permanent "PTT does nothing until the app is restarted" wedge: the hotkey
                // events still arrived but nothing consumed them. On a caught panic we snap the
                // Stage back to Idle so the very next press records again.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_command(
                        &app,
                        cmd,
                        &mut stage,
                        &mut last_press,
                        &mut processing_since,
                    );
                }));
                if let Err(e) = outcome {
                    error!("Transcription coordinator recovered from a panic in command handling: {e:?}");
                    stage = Stage::Idle;
                    processing_since = None;
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

    pub fn notify_cancel(&self, recording_was_active: bool) {
        if self
            .tx
            .send(Command::Cancel {
                recording_was_active,
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

    pub fn notify_processing_finished(&self) {
        if self.tx.send(Command::ProcessingFinished).is_err() {
            warn!("Transcription coordinator channel closed");
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
) {
    match cmd {
        Command::Input {
            binding_id,
            hotkey_string,
            is_pressed,
            push_to_talk,
        } => {
            // Debounce rapid-fire press events (key repeat / double-tap).
            // Releases always pass through for push-to-talk.
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
                    && matches!(&*stage, Stage::Recording(id) if id == &binding_id)
                {
                    stop(app, stage, &binding_id, &hotkey_string);
                    *processing_since = Some(Instant::now());
                }
            } else if is_pressed {
                match &*stage {
                    Stage::Idle => {
                        start(app, stage, &binding_id, &hotkey_string);
                    }
                    Stage::Recording(id) if id == &binding_id => {
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
        } => {
            // Don't reset during processing — wait for the pipeline to finish.
            if !matches!(stage, Stage::Processing)
                && (recording_was_active || matches!(stage, Stage::Recording(_)))
            {
                *stage = Stage::Idle;
                *processing_since = None;
                crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
            }
        }
        Command::SilenceStop {
            binding_id,
            recording_generation,
        } => {
            recover_wedged_stage(app, stage, processing_since);
            if matches!(&*stage, Stage::Recording(id) if id == &binding_id)
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
        Command::ProcessingFinished => {
            *stage = Stage::Idle;
            *processing_since = None;
            crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
        }
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
        Stage::Recording(_) if !recorder_is_recording(app) => {
            debug!("Coordinator self-heal: Recording stage but recorder idle → Idle");
            *stage = Stage::Idle;
            *processing_since = None;
        }
        Stage::Processing
            if processing_since.is_some_and(|t| t.elapsed() >= PROCESSING_WEDGE_TIMEOUT) =>
        {
            warn!(
                "Coordinator self-heal: stuck in Processing for >{}s → Idle",
                PROCESSING_WEDGE_TIMEOUT.as_secs()
            );
            *stage = Stage::Idle;
            *processing_since = None;
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
        *stage = Stage::Recording(binding_id.to_string());
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
    *stage = Stage::Processing;
}
