// Speaker diarization runtime — NVIDIA Nemotron-3-Diarization (streaming
// Sortformer, up to 8 speakers, OpenMDW-1.1) on the `joosthel` ONNX export.
//
// `DiarizationManager` owns the whole lifecycle:
//   * the runtime toggle (`request_diarization_toggle`): downloads the int8 step
//     graph on first enable (~104 MB via the hf-hub cache, pinned revision), builds
//     + warms the CPU session on a worker, and emits the `stt:diarization-toggle-*`
//     lifecycle events the renderer's toggle store listens for (started →
//     completed/failed; a failure reverts the optimistic settings toggle in the
//     renderer).
//   * the feed path: Listen mode's loopback consumer pushes 16 kHz frames through
//     a bounded channel to a dedicated worker thread that runs the streaming engine
//     off the audio thread and publishes the speaker timeline snapshot.
//   * span queries: `dominant_speaker_for_span` labels each committed caption row
//     with the majority speaker over its time span.
//
// Nemotron replaced the pyannote-seg-3.0 + WeSpeaker + online-clustering cascade:
// one end-to-end model whose arrival-order speaker cache keeps identities stable
// for the whole session (no clustering heuristics) and scores overlapped speech.
// On 13 A/B clips (the 2-speaker playground pair + 11 MSDWild sessions, 2–10
// speakers, five languages) the Listen profile cut pooled DER from 43.5 % to 18.2 %
// (collar 0.25) and won 12 of 13; the one loss is a 10-speaker clip, above the
// model's 8-speaker cap. It costs ~2× the cascade's RAM (~190 MB vs ~95 MB peak
// working set) but ~30 % less CPU (RTF 0.20 vs 0.32 on two threads).
//
// Toggle idempotence mirrors the old server's `_diarization_toggle_target` guard
// (memory: project_listen_mode_architecture): a repeat request for an in-flight
// worker's target is a silent no-op; only a genuine flip supersedes. Without it the
// renderer's double-fire (on-connect push + settings change) would rebuild the
// sessions twice and the spurious failure would bounce the optimistic toggle.

mod nemotron;

// The engine is re-exported for the offline E2E harness
// (src-tauri/examples/diarize_e2e.rs); in-app consumers go through the manager.
pub use nemotron::{MAX_SPEAKERS, NemotronDiarizer, SpeakerSegment, StreamingProfile};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::sync_ext::MutexExt;

/// HF source of the ONNX export (`joosthel/Nemotron-3-Diarization-ONNX`, OpenMDW-1.1),
/// pinned to a commit so an upstream re-export can never swap the graph under us.
pub const MODEL_REPO: (&str, &str) = ("joosthel", "Nemotron-3-Diarization-ONNX");
pub const MODEL_REVISION: &str = "4a911fc3ca821b76a99fffd5ce5135bd1efca540";
/// Per-channel dynamic-int8 step graph (104 MB; DER within 0.03 of fp32 on AMI-test).
pub const MODEL_FILE: &str = "model.int8.onnx";
/// Silence embedding + geometry constants (`np.savez`).
pub const CONSTANTS_FILE: &str = "constants.npz";
/// Repos the retired pyannote-seg-3.0 + WeSpeaker cascade downloaded. Nothing loads
/// them any more; they stay listed so cleanup still clears caches left by older builds.
pub const LEGACY_REPOS: [(&str, &str); 2] = [
    ("onnx-community", "pyannote-segmentation-3.0"),
    ("csukuangfj", "speaker-embedding-models"),
];

/// Listen-mode chunk geometry (see `StreamingProfile::LIVE`).
const LIVE_PROFILE: StreamingProfile = StreamingProfile::LIVE;
/// Intra-op threads for the step session: keeps RTF far below 1 without starving
/// the STT engine that shares the CPU.
const INTRA_THREADS: usize = 2;

/// Bounded audio feed: 30 ms frames × 256 ≈ 7.7 s of backlog before frames drop.
const FEED_CHANNEL_CAP: usize = 256;

enum FeedMsg {
    Audio(Vec<f32>, f64),
    Reset,
    Stop,
}

struct EngineHandle {
    feed_tx: SyncSender<FeedMsg>,
    worker: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct ToggleState {
    /// Target of the in-flight toggle worker, if one is running.
    inflight_target: Option<bool>,
}

pub struct DiarizationManager {
    app: AppHandle,
    /// True once the engine is built, warmed, and accepting audio.
    active: AtomicBool,
    engine: Mutex<Option<EngineHandle>>,
    toggle: Mutex<ToggleState>,
    /// Latest timeline snapshot published by the worker.
    timeline: Arc<Mutex<Vec<SpeakerSegment>>>,
}

impl DiarizationManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            active: AtomicBool::new(false),
            engine: Mutex::new(None),
            toggle: Mutex::new(ToggleState::default()),
            timeline: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// True while the diarizer is built and consuming audio.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    /// Start a fresh diarization session (Listen start): clears the speaker cache,
    /// the session clock, and the published timeline.
    pub fn begin_session(&self) {
        self.timeline.lock_recover().clear();
        if let Some(handle) = self.engine.lock_recover().as_ref() {
            let _ = handle.feed_tx.try_send(FeedMsg::Reset);
        }
    }

    /// Feed one 16 kHz mono chunk at `abs_time_sec` on the Listen session clock.
    /// Non-blocking: when the worker falls behind, the frame is dropped (the engine
    /// zero-fills the gap, so timing stays exact).
    pub fn feed(&self, chunk: &[f32], abs_time_sec: f64) {
        if !self.is_active() {
            return;
        }
        if let Some(handle) = self.engine.lock_recover().as_ref() {
            match handle
                .feed_tx
                .try_send(FeedMsg::Audio(chunk.to_vec(), abs_time_sec))
            {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => {
                    log::warn!("[diarize] feed channel disconnected");
                }
            }
        }
    }

    /// Majority speaker over `[start, end]` (session-clock seconds), or `None`
    /// when nothing labeled overlaps the span yet.
    pub fn dominant_speaker_for_span(&self, start: f64, end: f64) -> Option<i32> {
        if !self.is_active() {
            return None;
        }
        let timeline = self.timeline.lock_recover();
        nemotron::dominant_speaker(&timeline, start, end)
    }

    /// When `[start, end]` already contains two distinct labeled speakers (each
    /// ≥ `min_each_sec` of overlap), returns the turn boundary time — the point
    /// where the caption row covering the span should be SPLIT so each side stays
    /// one voice. `None` while the span is single-voiced or diarization is off.
    pub fn turn_boundary_for_span(&self, start: f64, end: f64, min_each_sec: f64) -> Option<f64> {
        if !self.is_active() {
            return None;
        }
        let timeline = self.timeline.lock_recover();
        nemotron::span_turn_boundary(&timeline, start, end, min_each_sec)
    }

    /// True while a listen session is running — the only time the diarizer can
    /// actually consume audio. Resolved lazily off managed state so the toggle
    /// surface stays decoupled from the loopback manager's construction order.
    fn listen_session_active(&self) -> bool {
        self.app
            .try_state::<Arc<crate::winstt::managers::LoopbackManager>>()
            .is_some_and(|loopback| loopback.is_capturing())
    }

    /// Runtime toggle: build+warm (enable) or tear down (disable) the diarizer,
    /// emitting the `stt:diarization-toggle-*` lifecycle events. Idempotent for
    /// both committed and in-flight state.
    ///
    /// The diarization model is a LISTEN-session runtime: enabling the toggle
    /// outside a running session only ARMS it (acknowledged immediately so the
    /// renderer's spinner resolves) — the engine builds when a listen session
    /// starts (`ensure_active_for_session`) and tears down when it ends, so the
    /// model is never resident while the app sits in PTT/toggle/wakeword mode.
    pub fn request_toggle(self: &Arc<Self>, enabled: bool) {
        if enabled && !self.is_active() && !self.listen_session_active() {
            emit_started(&self.app, enabled);
            emit_completed(&self.app, enabled);
            return;
        }
        {
            let mut toggle = self.toggle.lock_recover();
            if toggle.inflight_target == Some(enabled) {
                return; // repeat for the in-flight target — silent no-op
            }
            if toggle.inflight_target.is_none() && self.is_active() == enabled {
                // Already committed: acknowledge so the renderer's spinner resolves.
                emit_started(&self.app, enabled);
                emit_completed(&self.app, enabled);
                return;
            }
            toggle.inflight_target = Some(enabled);
        }

        let manager = self.clone();
        let spawned = std::thread::Builder::new()
            .name("diarize-toggle".into())
            .spawn(move || {
                emit_started(&manager.app, enabled);
                let result = if enabled {
                    manager.activate()
                } else {
                    manager.deactivate();
                    Ok(())
                };
                match result {
                    Ok(()) => emit_completed(&manager.app, enabled),
                    Err(err) => {
                        log::error!("[diarize] toggle({enabled}) failed: {err}");
                        emit_failed(&manager.app, enabled, &err);
                    }
                }
                manager.toggle.lock_recover().inflight_target = None;
            });
        if spawned.is_err() {
            self.toggle.lock_recover().inflight_target = None;
            emit_failed(&self.app, enabled, "failed to spawn diarization worker");
        }
    }

    /// Build the engine for a STARTING listen session (the toggle is armed).
    /// Quiet — no lifecycle events, no toggle UI is waiting — and async: audio
    /// arriving before the build finishes simply isn't diarized (those early
    /// rows render unlabeled). Idempotent with the toggle worker.
    pub fn ensure_active_for_session(self: &Arc<Self>) {
        if self.is_active() {
            return;
        }
        {
            let mut toggle = self.toggle.lock_recover();
            if toggle.inflight_target == Some(true) {
                return;
            }
            toggle.inflight_target = Some(true);
        }
        let manager = self.clone();
        let spawned = std::thread::Builder::new()
            .name("diarize-session-warm".into())
            .spawn(move || {
                if let Err(err) = manager.activate() {
                    log::warn!("[diarize] session warm-up failed: {err}");
                }
                manager.toggle.lock_recover().inflight_target = None;
            });
        if spawned.is_err() {
            self.toggle.lock_recover().inflight_target = None;
        }
    }

    /// Tear down on app exit / listen-session end / mode teardown without
    /// emitting lifecycle events. The persisted setting is untouched — the
    /// next listen session rebuilds via `ensure_active_for_session`.
    pub fn shutdown(&self) {
        self.deactivate();
    }

    fn activate(&self) -> Result<(), String> {
        if self.is_active() {
            return Ok(());
        }
        let (model_path, constants_path) = download_models()?;
        let mut engine = NemotronDiarizer::new(
            &model_path,
            &constants_path,
            LIVE_PROFILE,
            crate::winstt::stt::Accelerator::Cpu,
            INTRA_THREADS,
        )
        .map_err(|e| format!("model_corrupt: {e}"))?;
        log::info!(
            "[diarize] nemotron ready (model={}, input latency {:.2}s)",
            model_path.display(),
            LIVE_PROFILE.latency_sec()
        );

        let (tx, rx) = std::sync::mpsc::sync_channel::<FeedMsg>(FEED_CHANNEL_CAP);
        let timeline = self.timeline.clone();
        let worker = std::thread::Builder::new()
            .name("diarize-worker".into())
            .spawn(move || {
                engine_loop(&mut engine, &rx, &timeline);
            })
            .map_err(|e| format!("failed to spawn diarization worker: {e}"))?;

        *self.engine.lock_recover() = Some(EngineHandle {
            feed_tx: tx,
            worker,
        });
        self.timeline.lock_recover().clear();
        self.active.store(true, Ordering::Release);
        Ok(())
    }

    fn deactivate(&self) {
        self.active.store(false, Ordering::Release);
        let handle = self.engine.lock_recover().take();
        if let Some(handle) = handle {
            let _ = handle.feed_tx.send(FeedMsg::Stop);
            let _ = handle.worker.join();
        }
        self.timeline.lock_recover().clear();
    }
}

impl Drop for DiarizationManager {
    fn drop(&mut self) {
        self.deactivate();
    }
}

/// The engine worker: drain the feed, run every ready chunk, publish the timeline.
/// Runs off the audio thread; inference latency here only delays speaker labels,
/// never audio capture or captions.
fn engine_loop(
    engine: &mut NemotronDiarizer,
    rx: &Receiver<FeedMsg>,
    timeline: &Arc<Mutex<Vec<SpeakerSegment>>>,
) {
    while let Ok(first) = rx.recv() {
        let mut reset = false;
        let mut stop = false;
        let mut ingest = |msg: FeedMsg, engine: &mut NemotronDiarizer| match msg {
            FeedMsg::Audio(chunk, abs) => engine.accept_audio(&chunk, abs),
            FeedMsg::Reset => reset = true,
            FeedMsg::Stop => stop = true,
        };
        ingest(first, engine);
        // Batch whatever else is queued so the encoder runs per chunk, not per frame.
        while let Ok(msg) = rx.try_recv() {
            ingest(msg, engine);
        }
        if stop {
            break;
        }
        if reset {
            engine.reset();
            timeline.lock_recover().clear();
            continue;
        }
        match engine.process_ready_chunks() {
            Ok(0) => {}
            Ok(n) => {
                *timeline.lock_recover() = engine.timeline_snapshot();
                log::debug!(
                    "[diarize] +{n} chunks (total {}, speakers {})",
                    engine.chunks_processed(),
                    engine.speaker_count()
                );
            }
            Err(err) => {
                // Fail-soft: diarization must never take down Listen mode. Log and
                // keep consuming; the captions simply stay unlabeled.
                log::error!("[diarize] chunk processing failed: {err}");
            }
        }
    }
}

/// Resolve the step graph + constants through the hf-hub cache at the pinned
/// revision (network only on a miss). Returns `(model_path, constants_path)`.
fn download_models() -> Result<(PathBuf, PathBuf), String> {
    tauri::async_runtime::block_on(async {
        use hf_hub::HFClient;
        let client = HFClient::new().map_err(|e| format!("network: hf client init: {e}"))?;
        let repo = client.model(MODEL_REPO.0.to_string(), MODEL_REPO.1.to_string());
        let download = |file: &'static str| {
            let repo = &repo;
            async move {
                repo.download_file()
                    .filename(file)
                    .revision(MODEL_REVISION)
                    .send()
                    .await
                    .map_err(|e| format!("network: download {file}: {e}"))
            }
        };
        let constants = download(CONSTANTS_FILE).await?;
        let model = download(MODEL_FILE).await?;
        Ok((model, constants))
    })
}

// ── Lifecycle event emitters (byte-identical payload shapes to the renderer's
//    DiarizationToggle*Payload interfaces in shared/api/ipc/models.ts) ──────────

fn emit_started(app: &AppHandle, enabled: bool) {
    let _ = app.emit(
        "stt:diarization-toggle-started",
        serde_json::json!({ "enabled": enabled }),
    );
}

fn emit_completed(app: &AppHandle, enabled: bool) {
    let message = if enabled {
        "Diarization enabled"
    } else {
        "Diarization disabled"
    };
    let _ = app.emit(
        "stt:diarization-toggle-completed",
        serde_json::json!({ "enabled": enabled, "message": message }),
    );
}

fn emit_failed(app: &AppHandle, enabled: bool, err: &str) {
    // The worker prefixes errors with a coarse category ("network:" for download
    // failures, "model_corrupt:" for session-build failures) that maps onto the
    // renderer's ModelSwapFailedCategory codes.
    let (category, detail) = match err.split_once(':') {
        Some((cat @ ("network" | "model_corrupt" | "out_of_memory"), rest)) => {
            (cat, rest.trim().to_string())
        }
        _ => ("network", err.to_string()),
    };
    let _ = app.emit(
        "stt:diarization-toggle-failed",
        serde_json::json!({
            "enabled": enabled,
            "category": category,
            "reason": err,
            "detail": detail,
        }),
    );
}
