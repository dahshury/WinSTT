// LoopbackManager — Listen-mode lifecycle for system-audio transcription.
//
// Source of truth: server/src/stt_server/loopback.py (LoopbackCapture._capture_loop +
// recorder.feed_audio's VAD-gated continuous transcription) and
// server/src/stt_server/control_handler.py (_handle_start_loopback / _handle_stop_loopback).
//
// Listen mode transcribes SYSTEM audio (a call, a YouTube lecture), not the mic. The native
// WASAPI capture lives in `winstt::loopback::LoopbackCapture` (render endpoint, shared-mode
// loopback) and delivers 16 kHz mono f32 frames over an mpsc channel, already AGC'd. This
// manager owns:
//
//   * the capture lifecycle (start/stop, idempotent, serialized — concurrent WASAPI start/stop
//     crash the backend),
//   * a consumer thread that feeds continuous loopback audio to the selected native-streaming
//     `TranscriptionManager` model while using VAD only for UI activity state.
//
// Why the manager owns the consumer (not the recorder): cpal's `AudioRecorder` is mic-only and
// hotkey-driven; loopback is a second, continuous producer with its own VAD endpoint loop. Per
// the Python (`recorder.feed_audio`), the loopback audio feeds the SAME transcriber but never the
// mic stream. Mirroring that, this manager is a self-contained second pipeline that reuses the
// shared `TranscriptionManager` from Tauri state.
//
// start() is NON-BLOCKING (spawns the capture thread + consumer thread and returns) so it never
// stalls the Tauri async command loop — the antipattern the project memory flags for
// `start_loopback`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::managers::history::HistoryManager;
use crate::managers::transcription::{RealtimeStreamOutcome, TranscriptionManager};

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
use crate::audio_toolkit::vad::{
    SileroVad, SmoothedVad, VAD_FRAME_SAMPLES, VadFrame, VoiceActivityDetector,
};
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::events::names;
use crate::winstt::diarize::DiarizationManager;
use crate::winstt::loopback::mic_capture::MicrophoneCapture;
use crate::winstt::loopback::{DeviceInfo, LoopbackCapture};
use crate::winstt::settings_store::read_settings_raw;
use crate::winstt::sync_ext::MutexExt;

/// Silence (seconds) after speech that clears the current loopback live caption.
const POST_SPEECH_SILENCE_DURATION: f64 = 2.0;

/// Hard cap for the in-memory consumer buffer when transcription falls behind. This buffer holds
/// only samples not yet discarded from the continuous stream; keeping several minutes here prevents
/// short CPU/GPU stalls from turning into dropped captions during long media playback.
const LISTEN_MAX_BUFFER_SECONDS: f64 = 300.0;

/// Grace period before a stalled render device is considered idle. This is a
/// one-shot deadline after the last frame, not a periodic consumer wake-up.
const LOOPBACK_IDLE_GRACE: Duration = Duration::from_millis(200);

/// The VAD consumes 30 ms frames; when a render device stops delivering
/// zero-filled frames, the consumer advances the outstanding silence by the
/// exact remaining VAD-frame duration in one deadline.
const VAD_FRAME_DURATION: Duration = Duration::from_millis(30);

/// Loopback needs much more permissive VAD than close-talk mic dictation: system audio is often
/// normalized, compressed, mixed with music/effects, or quieter than microphone speech. This
/// mirrors the RealtimeSTT stereo-mix example's `silero_sensitivity=0.05`.
const LOOPBACK_VAD_SPEECH_THRESHOLD: f32 = 0.05;

// The 30 ms frame size (`VAD_FRAME_SAMPLES`) stays shared with the mic path from
// `audio_toolkit::vad` so the two pipelines keep the same timing unit.

/// SmoothedVad onset/hangover/prefill frame counts — same tuning the mic recorder
/// applies (`create_audio_recorder` in managers/audio.rs wraps SileroVad in
/// `SmoothedVad::new(.., 15, 15, 2)`), so loopback gets the SAME onset debounce +
/// hangover tail instead of the bare per-frame Silero decision it used before.
const VAD_PREFILL_FRAMES: usize = 15;
const VAD_HANGOVER_FRAMES: usize = 15;
const VAD_ONSET_FRAMES: usize = 2;

/// Minimum speech (samples) before a flush is worth transcribing — drops sub-VAD
/// blips (a single click / notification chime) that would otherwise spawn an
/// empty-text transcription. ~150 ms at 16 kHz.
const MIN_SPEECH_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) * 150 / 1000;

/// Lowest feed cadence for native streaming models without an explicit latency token.
const LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS: usize = 160;
const LISTEN_NATIVE_STREAM_MIN_FEED_MS: usize = 80;
const LISTEN_NATIVE_STREAM_MAX_FEED_MS: usize = 1120;

/// Soft roll target for listen-mode UI commits. The model stream stays continuous; these thresholds
/// only decide when accumulated text is emitted as a caption row.
const LISTEN_STREAM_ROLL_SECONDS: f64 = 12.0;
const LISTEN_STREAM_ROLL_HARD_SECONDS: f64 = 20.0;
const LISTEN_STREAM_ROLL_CHARS: usize = 360;
const LISTEN_STREAM_ROLL_HARD_CHARS: usize = 720;

/// Diarization turn-break roll: when the diarizer reports that the CURRENT caption
/// span already contains two distinct speakers (each with at least this much labeled
/// speech), the row is committed at the next preview tick instead of waiting for the
/// 12–20 s soft roll — otherwise one row mixes two voices and its majority label
/// colors the wrong half. 0.5 s = the engine's own min embeddable turn, the earliest
/// a second voice can be labeled at all; lower would only add noise, higher only lag.
const DIAR_TURN_BREAK_MIN_EACH_SECONDS: f64 = 0.5;
/// Don't turn-break-commit ultra-short fragments; give the row a moment to carry text.
const DIAR_TURN_BREAK_MIN_SPAN_SECONDS: f64 = 1.0;

/// Committed caption lines of the CURRENT listen session, accumulated by the
/// consumer and persisted to history on stop.
type SessionLines = Arc<Mutex<ListenSessionState>>;

/// Transcript state of the CURRENT listen session: the committed caption
/// lines plus the in-flight (uncommitted) realtime preview. Shared between
/// the consumer thread (writer) and the manager's snapshot/finalize surface
/// (the History tab's live session card reads it over IPC).
#[derive(Default)]
struct ListenSessionState {
    lines: Vec<String>,
    live_preview: String,
}

/// One audio frame arriving at the listen consumer, tagged by producer.
enum ListenFrame {
    Loopback(Vec<f32>),
    Mic(Vec<f32>),
}

/// Skew allowance before a lone stream is flushed unmixed: if one source
/// stalls (WASAPI loopback can stop delivering during render silence) the
/// other must not back up behind it forever.
const MIX_MAX_SKEW_SAMPLES: usize = VAD_FRAME_SAMPLES * 10; // 300 ms
/// Hard cap per mixer buffer; beyond this the oldest samples are dropped.
const MIX_MAX_BUFFER_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) * 10; // 10 s

/// Sums the loopback and microphone streams into one mono 16 kHz stream for
/// the mic-mix listen toggle.
///
/// Both producers already emit AGC'd 16 kHz mono f32 in 30 ms frames, so the
/// mixer only has to align them: while both buffers hold a full frame, pop one
/// from each and sum (clamped). When one side holds more than
/// [`MIX_MAX_SKEW_SAMPLES`] while the other can't fill a frame, the surplus
/// side is drained ALONE — fully, so that when the stalled side resumes the
/// two streams re-align fresh instead of mixing against a stale backlog.
/// (Clock drift between two hardware devices also lands here eventually; the
/// one-time flush skips the drifted surplus and re-aligns.)
struct ListenMixer {
    loopback: VecDeque<f32>,
    mic: VecDeque<f32>,
}

impl ListenMixer {
    fn new() -> Self {
        Self {
            loopback: VecDeque::new(),
            mic: VecDeque::new(),
        }
    }

    fn push_loopback(&mut self, samples: &[f32]) {
        self.loopback.extend(samples.iter().copied());
        Self::cap(&mut self.loopback);
    }

    fn push_mic(&mut self, samples: &[f32]) {
        self.mic.extend(samples.iter().copied());
        Self::cap(&mut self.mic);
    }

    fn cap(buf: &mut VecDeque<f32>) {
        if buf.len() > MIX_MAX_BUFFER_SAMPLES {
            let drop = buf.len() - MIX_MAX_BUFFER_SAMPLES;
            buf.drain(..drop);
        }
    }

    fn pop_frame(buf: &mut VecDeque<f32>) -> Vec<f32> {
        buf.drain(..VAD_FRAME_SAMPLES).collect()
    }

    /// Every 30 ms frame that is ready to leave the mixer right now.
    fn drain_ready(&mut self) -> Vec<Vec<f32>> {
        let mut out = Vec::new();
        loop {
            if self.loopback.len() >= VAD_FRAME_SAMPLES && self.mic.len() >= VAD_FRAME_SAMPLES {
                let a = Self::pop_frame(&mut self.loopback);
                let b = Self::pop_frame(&mut self.mic);
                out.push(
                    a.iter()
                        .zip(b.iter())
                        .map(|(&x, &y)| (x + y).clamp(-1.0, 1.0))
                        .collect(),
                );
            } else if self.loopback.len() > MIX_MAX_SKEW_SAMPLES {
                while self.loopback.len() >= VAD_FRAME_SAMPLES {
                    out.push(Self::pop_frame(&mut self.loopback));
                }
            } else if self.mic.len() > MIX_MAX_SKEW_SAMPLES {
                while self.mic.len() >= VAD_FRAME_SAMPLES {
                    out.push(Self::pop_frame(&mut self.mic));
                }
            } else {
                break;
            }
        }
        out
    }
}

/// One realtime preview tick's cumulative text, stamped with the listen-session
/// clock. The turn-split path uses these to reconstruct "what had been said by
/// time T": when the (lagging) diarizer reports a speaker turn at T, the snapshot
/// at-or-before T is the commit prefix and everything after stays live.
#[derive(Clone)]
struct TickSnapshot {
    clock_sec: f64,
    raw_text: String,
    total_len: usize,
}

/// Bounded tick-snapshot history (~80 s at the fastest preview cadence).
const MAX_TICK_SNAPSHOTS: usize = 256;

struct LoopbackRealtimeState {
    generation: u64,
    fed_len: usize,
    committed_fed_len: usize,
    committed_text: String,
    last_raw_text: String,
    last_emit_text: String,
    last_preview: Instant,
    snapshots: VecDeque<TickSnapshot>,
}

impl LoopbackRealtimeState {
    fn new() -> Self {
        Self {
            generation: 1,
            fed_len: 0,
            committed_fed_len: 0,
            committed_text: String::new(),
            last_raw_text: String::new(),
            last_emit_text: String::new(),
            last_preview: Instant::now(),
            snapshots: VecDeque::new(),
        }
    }

    fn reset_stream(&mut self, transcription: &TranscriptionManager) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.fed_len = 0;
        self.committed_fed_len = 0;
        self.committed_text.clear();
        self.last_raw_text.clear();
        self.last_emit_text.clear();
        self.last_preview = Instant::now();
        self.snapshots.clear();
        transcription.stream_reset_realtime();
    }

    fn forget_buffered_prefix(&mut self, samples: usize) {
        self.fed_len = self.fed_len.saturating_sub(samples);
        self.committed_fed_len = self.committed_fed_len.saturating_sub(samples);
        for snap in &mut self.snapshots {
            snap.total_len = snap.total_len.saturating_sub(samples);
        }
        self.last_emit_text.clear();
        self.last_preview = Instant::now();
    }

    fn uncommitted_text(&self, raw_text: &str) -> String {
        uncommitted_realtime_text(&self.committed_text, raw_text)
    }

    fn mark_committed(&mut self, raw_text: &str, total_len: usize) {
        self.committed_text = raw_text.trim().to_string();
        self.committed_fed_len = total_len;
        self.last_emit_text.clear();
    }

    fn record_snapshot(&mut self, clock_sec: f64, raw_text: &str, total_len: usize) {
        self.snapshots.push_back(TickSnapshot {
            clock_sec,
            raw_text: raw_text.to_string(),
            total_len,
        });
        while self.snapshots.len() > MAX_TICK_SNAPSHOTS {
            self.snapshots.pop_front();
        }
    }

    /// Latest snapshot at-or-before `boundary` on the session clock.
    fn snapshot_at_or_before(&self, boundary: f64) -> Option<&TickSnapshot> {
        self.snapshots
            .iter()
            .rev()
            .find(|snap| snap.clock_sec <= boundary)
    }

    /// Drop snapshots covered by a boundary commit (later ones stay valid — their
    /// raw text extends the newly committed prefix).
    fn drop_snapshots_through(&mut self, boundary: f64) {
        while self
            .snapshots
            .front()
            .is_some_and(|snap| snap.clock_sec <= boundary)
        {
            self.snapshots.pop_front();
        }
    }

    /// A FULL commit makes every recorded snapshot a prefix of the committed text
    /// — useless for future splits; drop them all.
    fn clear_snapshots(&mut self) {
        self.snapshots.clear();
    }
}

/// Tracks the Listen-session clock (sample-count based, so it matches the audio
/// actually delivered) and the span covered by the caption row currently being
/// accumulated. Each committed row is labeled with the majority speaker the
/// diarizer identified over that span; the span then restarts at "now".
struct DiarSpan {
    manager: Option<Arc<DiarizationManager>>,
    clock_sec: f64,
    span_start_sec: f64,
}

impl DiarSpan {
    fn new(manager: Option<Arc<DiarizationManager>>) -> Self {
        Self {
            manager,
            clock_sec: 0.0,
            span_start_sec: 0.0,
        }
    }

    /// Reset the diarizer's per-session state at Listen start.
    fn begin_session(&self) {
        if let Some(m) = &self.manager
            && m.is_active()
        {
            m.begin_session();
        }
    }

    /// Feed one captured chunk and advance the session clock by its duration.
    fn feed(&mut self, chunk: &[f32]) {
        if let Some(m) = &self.manager
            && m.is_active()
        {
            m.feed(chunk, self.clock_sec);
        }
        self.clock_sec += chunk.len() as f64 / WHISPER_SAMPLE_RATE as f64;
    }

    /// Majority speaker over the span accumulated since the last commit, then
    /// restart the span at the current clock. `None` when diarization is off or
    /// nothing labeled overlaps the span (the row renders uncolored).
    fn take_speaker(&mut self) -> Option<i32> {
        let speaker = self
            .manager
            .as_ref()
            .filter(|m| m.is_active())
            .and_then(|m| m.dominant_speaker_for_span(self.span_start_sec, self.clock_sec));
        self.span_start_sec = self.clock_sec;
        speaker
    }

    /// When the diarizer says the CURRENT caption span already contains a speaker
    /// turn, returns the turn's boundary time. The preview publisher SPLITS the
    /// caption there — commit the pre-boundary text under its own speaker, keep
    /// the post-boundary words live — so each row stays one voice without ever
    /// slowing the stream down.
    fn turn_boundary(&self) -> Option<f64> {
        if self.clock_sec - self.span_start_sec < DIAR_TURN_BREAK_MIN_SPAN_SECONDS {
            return None;
        }
        let boundary = self
            .manager
            .as_ref()
            .filter(|m| m.is_active())?
            .turn_boundary_for_span(
                self.span_start_sec,
                self.clock_sec,
                DIAR_TURN_BREAK_MIN_EACH_SECONDS,
            )?;
        // A boundary hugging the span start yields an empty prefix — no split.
        (boundary > self.span_start_sec + 0.3).then_some(boundary)
    }

    /// Majority speaker over `[span_start, boundary]` only, then advance the span
    /// start to the boundary — the post-boundary audio belongs to the NEXT row.
    fn take_speaker_until(&mut self, boundary: f64) -> Option<i32> {
        let speaker = self
            .manager
            .as_ref()
            .filter(|m| m.is_active())
            .and_then(|m| m.dominant_speaker_for_span(self.span_start_sec, boundary));
        self.span_start_sec = boundary;
        speaker
    }
}

pub struct LoopbackManager {
    app: AppHandle,
    /// Shared transcription engine — injected at construction (the same
    /// `Arc<TranscriptionManager>` Tauri manages). Listen mode feeds final chunks
    /// here, mirroring how mic dictation reuses the one engine. Previously resolved
    /// per-call via `app.try_state`; injection makes the dependency explicit and
    /// drops the fallible state lookups on the hot path.
    transcription: Arc<TranscriptionManager>,
    /// True while loopback capture is running (listen mode active).
    capturing: AtomicBool,
    /// Serializes the complete start/stop transaction. Model loading and device
    /// opening happen before a start is committed, so a concurrent stop must
    /// wait and then tear down that exact session; concurrent starts likewise
    /// cannot both pass the initial idle check.
    lifecycle: Mutex<()>,
    /// The native WASAPI capture (render endpoint, shared-mode loopback). Owned
    /// behind a mutex so start/stop are serialized.
    capture: Mutex<LoopbackCapture>,
    /// Resolved device for the current loopback session.
    active_device: Mutex<Option<DeviceInfo>>,
    /// Handle to the consumer/transcription thread; joined on stop.
    consumer: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Signals the consumer thread to stop (it also exits when the capture
    /// channel closes, but this lets stop() interrupt a silent stretch promptly).
    stop_flag: Arc<AtomicBool>,
    /// Optional microphone capture for the "also listen to my microphone"
    /// toggle. Started only when the session requests it; mixed into the
    /// loopback stream by the consumer.
    mic: Mutex<MicrophoneCapture>,
    /// Committed caption lines of the current session; persisted to history on
    /// stop (source = "listen").
    session_lines: SessionLines,
    /// Model the current session runs on — recorded on the history row.
    session_model_id: Mutex<Option<String>>,
}

impl LoopbackManager {
    pub fn new(app: &AppHandle, transcription: Arc<TranscriptionManager>) -> Self {
        Self {
            app: app.clone(),
            transcription,
            capturing: AtomicBool::new(false),
            lifecycle: Mutex::new(()),
            capture: Mutex::new(LoopbackCapture::new()),
            active_device: Mutex::new(None),
            consumer: Mutex::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
            mic: Mutex::new(MicrophoneCapture::new()),
            session_lines: Arc::new(Mutex::new(ListenSessionState::default())),
            session_model_id: Mutex::new(None),
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::Acquire)
    }

    /// Resolve the bundled Silero VAD model path (same resource the mic recorder
    /// loads in `AudioRecordingManager::preload_vad`).
    fn vad_path(&self) -> Result<String, String> {
        self.app
            .path()
            .resolve(
                "resources/models/silero_vad_v4.onnx",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("failed to resolve VAD path: {e}"))?
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "VAD path is not valid UTF-8".to_string())
    }

    /// Begin loopback capture: open the WASAPI render endpoint, then spawn the
    /// consumer thread that VAD-gates + transcribes the system-audio stream.
    /// When `capture_microphone` is set, a cpal mic session is opened alongside
    /// and the consumer mixes both into one mono stream (a mic-open failure
    /// logs and degrades to loopback-only rather than failing the session).
    /// Idempotent (a second call while active is a no-op). Non-blocking.
    pub fn start(
        &self,
        device_id: Option<String>,
        model_id: String,
        capture_microphone: bool,
    ) -> Result<DeviceInfo, String> {
        let _lifecycle = self.lifecycle.lock_recover();
        if self.is_capturing() {
            if let Some(info) = self.active_device.lock_recover().clone() {
                return Ok(info);
            }
            return Err("loopback capture is already active".to_string());
        }
        // Build the VAD up front so a missing model fails the start cleanly
        // (before we open the audio backend). Wrap Silero in SmoothedVad with the
        // SAME prefill/hangover/onset tuning the mic recorder uses so listen-mode
        // endpointing matches dictation (onset debounce + hangover tail), not a raw
        // per-frame decision.
        let vad_path = self.vad_path()?;
        let silero = SileroVad::new(&vad_path, LOOPBACK_VAD_SPEECH_THRESHOLD)
            .map_err(|e| format!("failed to create Silero VAD: {e}"))?;
        let vad: Box<dyn VoiceActivityDetector> = Box::new(SmoothedVad::new(
            Box::new(silero),
            VAD_PREFILL_FRAMES,
            VAD_HANGOVER_FRAMES,
            VAD_ONSET_FRAMES,
        ));

        self.stop_flag.store(false, Ordering::Release);

        // Listen mode must run on an explicit native-streaming model. Load it
        // before opening capture so a missing/corrupt cache fails cleanly.
        self.transcription.load_model_blocking(&model_id)?;

        // Fresh session transcript (persisted to history on stop).
        *self.session_lines.lock_recover() = ListenSessionState::default();
        *self.session_model_id.lock_recover() = Some(model_id);

        // Producers push tagged frames; the consumer mixes (or passes through).
        let (frame_tx, frame_rx) = mpsc::channel::<ListenFrame>();
        // 16 kHz mono f32 frames flow from the capture thread into a forwarder
        // that tags them (the capture API's sink type stays `Vec<f32>`).
        let (loop_tx, loop_rx) = mpsc::channel::<Vec<f32>>();

        // Open WASAPI loopback (resolves device + surfaces open errors here).
        let started_device = {
            let mut capture = self.capture.lock_recover();
            capture
                .start(device_id, loop_tx)
                .map_err(|e| format!("failed to start loopback capture: {e}"))?
        };
        *self.active_device.lock_recover() = Some(started_device.clone());

        let loop_forward_tx = frame_tx.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("listen-loopback-forward".into())
            .spawn(move || {
                for chunk in loop_rx.iter() {
                    if loop_forward_tx.send(ListenFrame::Loopback(chunk)).is_err() {
                        break;
                    }
                }
            })
        {
            self.capture.lock_recover().stop();
            *self.active_device.lock_recover() = None;
            return Err(format!("failed to spawn loopback forwarder: {e}"));
        }

        // Optional microphone leg. A mic failure never takes down the session —
        // the toggle degrades to loopback-only with a logged warning.
        let mut mix_microphone = false;
        if capture_microphone {
            let (mic_tx, mic_rx) = mpsc::channel::<Vec<f32>>();
            let preferred = read_settings_raw(&self.app).audio.input_device_priority;
            match self.mic.lock_recover().start(preferred, mic_tx) {
                Ok(name) => {
                    log::info!("[listen] microphone mix enabled device='{name}'");
                    let mic_forward_tx = frame_tx.clone();
                    match std::thread::Builder::new()
                        .name("listen-mic-forward".into())
                        .spawn(move || {
                            for chunk in mic_rx.iter() {
                                if mic_forward_tx.send(ListenFrame::Mic(chunk)).is_err() {
                                    break;
                                }
                            }
                        }) {
                        Ok(_) => mix_microphone = true,
                        Err(e) => {
                            log::warn!("[listen] failed to spawn mic forwarder: {e}");
                            self.mic.lock_recover().stop();
                        }
                    }
                }
                Err(err) => log::warn!(
                    "[listen] microphone mix requested but the mic could not be opened: {err}; continuing with system audio only"
                ),
            }
        }
        // The consumer's channel disconnects once every forwarder has exited.
        drop(frame_tx);

        // Spawn the consumer/transcription loop. The diarization manager rides
        // along when registered; the consumer feeds it audio only while its
        // engine is active (runtime toggle), so an off toggle costs nothing.
        let app = self.app.clone();
        let transcription = self.transcription.clone();
        let stop_flag = self.stop_flag.clone();
        let session_lines = self.session_lines.clone();
        let diarization = self
            .app
            .try_state::<Arc<DiarizationManager>>()
            .map(|s| s.inner().clone());
        // The cascade models are session-scoped: build them now (async, quiet)
        // when the toggle is armed, instead of keeping them resident from app
        // start. `DiarSpan::feed` no-ops until the build lands, so early audio
        // simply renders unlabeled.
        if let Some(diarization) = &diarization
            && read_settings_raw(&self.app).general.speaker_diarization
        {
            diarization.ensure_active_for_session();
        }
        let handle = std::thread::Builder::new()
            .name("loopback-consumer".into())
            .spawn(move || {
                consumer_loop(
                    app,
                    transcription,
                    frame_rx,
                    stop_flag,
                    vad,
                    diarization,
                    mix_microphone,
                    session_lines,
                );
            })
            .map_err(|e| {
                // Roll back the capture if the consumer thread couldn't spawn.
                self.mic.lock_recover().stop();
                self.capture.lock_recover().stop();
                *self.active_device.lock_recover() = None;
                format!("failed to spawn loopback consumer: {e}")
            })?;

        *self.consumer.lock_recover() = Some(handle);
        self.capturing.store(true, Ordering::Release);

        self.emit_session_snapshot();
        Ok(started_device)
    }

    /// Stop loopback capture + the consumer thread, then persist the finished
    /// session's transcript to history. Idempotent.
    pub fn stop(&self) {
        let _lifecycle = self.lifecycle.lock_recover();
        self.stop_flag.store(true, Ordering::Release);
        self.capturing.store(false, Ordering::Release);

        // Stop both producers first; their forwarders drain and exit, which
        // closes the consumer's channel so its recv() returns and the thread
        // winds down (finalizing the last segment into the session transcript).
        self.mic.lock_recover().stop();
        self.capture.lock_recover().stop();
        *self.active_device.lock_recover() = None;

        if let Some(handle) = self.consumer.lock_recover().take() {
            let _ = handle.join();
        }

        // Diarization is a per-session runtime: free its ONNX sessions when
        // listening ends (the persisted toggle stays on; the next session
        // rebuilds them via `ensure_active_for_session`).
        if let Some(diarization) = self.app.try_state::<Arc<DiarizationManager>>() {
            diarization.shutdown();
        }

        self.persist_session();
        self.emit_session_snapshot();
    }

    /// Save the finished session's committed captions as one history row
    /// (source = "listen"). No-op for empty sessions, when history is
    /// disabled, or when the history manager is gone (app shutdown).
    fn persist_session(&self) {
        let lines: Vec<String> = {
            let mut state = self.session_lines.lock_recover();
            state.live_preview.clear();
            std::mem::take(&mut state.lines)
        };
        let model_id = self.session_model_id.lock_recover().take();
        self.persist_lines(lines, model_id);
    }

    /// Broadcast the authoritative session snapshot after every transcript or
    /// lifecycle mutation. The History renderer takes one initial command
    /// snapshot, then stays current exclusively through this push channel.
    fn emit_session_snapshot(&self) {
        emit_listen_session_snapshot(&self.app, &self.session_lines, self.is_capturing());
    }

    /// The current session's transcript state for the History tab's live card:
    /// `(capturing, committed lines, in-flight preview)`.
    pub fn session_snapshot(&self) -> (bool, Vec<String>, String) {
        let state = self.session_lines.lock_recover();
        (
            self.is_capturing(),
            state.lines.clone(),
            state.live_preview.clone(),
        )
    }

    /// Persist the session-SO-FAR as its own history row WITHOUT stopping the
    /// session: the committed lines are cut into an entry and the running
    /// session continues accumulating from empty (any in-flight caption lands
    /// in the next entry once it commits). Returns `true` when a row was
    /// saved. No-op when the session is idle or has no committed lines yet.
    pub fn finalize_session(&self) -> bool {
        if !self.is_capturing() {
            return false;
        }
        let lines: Vec<String> = std::mem::take(&mut self.session_lines.lock_recover().lines);
        let model_id = self.session_model_id.lock_recover().clone();
        let saved = self.persist_lines(lines, model_id);
        self.emit_session_snapshot();
        saved
    }

    /// Shared writer for stop-finalize and finalize-now: one history row per
    /// non-empty transcript. Returns whether a row was saved.
    fn persist_lines(&self, lines: Vec<String>, model_id: Option<String>) -> bool {
        let transcript = lines.join("\n");
        if transcript.trim().is_empty() {
            return false;
        }
        if !read_settings_raw(&self.app).general.history_enabled {
            log::debug!("[listen] history disabled; listen session not persisted");
            return false;
        }
        let Some(history) = self.app.try_state::<Arc<HistoryManager>>() else {
            log::warn!("[listen] history manager unavailable; listen session not persisted");
            return false;
        };
        match history.save_entry(
            // No session audio is kept on disk — captions only.
            String::new(),
            transcript,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            model_id,
            None,
            None,
            false,
            Some("listen".to_string()),
        ) {
            Ok(_) => true,
            Err(err) => {
                log::warn!("[listen] failed to persist listen session: {err}");
                false
            }
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

impl Drop for LoopbackManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The Listen-mode consumer: feed the 16 kHz mono f32 stream continuously into the native
/// streaming model, keep capture responsive, and use VAD only to drive the visual active/idle
/// state. Listen mode never runs the mic dictation finalizer: no paste, no final post-processing
/// pass. With `mix_microphone` set, loopback and mic frames are summed into one
/// mono stream by [`ListenMixer`] before entering the pipeline.
#[expect(
    clippy::too_many_arguments,
    reason = "the consumer wiring mirrors the session's producer/output legs; grouping them would only add indirection"
)]
fn consumer_loop(
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    rx: Receiver<ListenFrame>,
    stop_flag: Arc<AtomicBool>,
    mut vad: Box<dyn VoiceActivityDetector>,
    diarization: Option<Arc<DiarizationManager>>,
    mix_microphone: bool,
    session_lines: SessionLines,
) {
    // How many consecutive silence frames close an utterance.
    let silence_frames_to_end = ((POST_SPEECH_SILENCE_DURATION * 1000.0) / 30.0).round() as usize;
    let max_buffer_samples = samples_for_seconds(LISTEN_MAX_BUFFER_SECONDS);

    let mut diar_span = DiarSpan::new(diarization);
    diar_span.begin_session();

    let mut speech: Vec<f32> = Vec::new();
    // Re-frame buffer: the capture emits 30 ms frames, but guard against a
    // partial frame arriving (resampler flush) by carrying a remainder.
    let mut frame_acc: Vec<f32> = Vec::new();
    let mut in_speech = false;
    let mut silence_frames = 0usize;
    let mut realtime = LoopbackRealtimeState::new();
    // Tracks whether the last `audio_level` emission (real chunk or idle tick) was
    // already the 0.0 floor, so a silent stretch emits the zero ONCE on the
    // non-zero → zero transition instead of every 200 ms recv timeout for as long as
    // the silence lasts (each emit also drives `on_tray_audio_level`). Starts `true`
    // — no level has been emitted yet, so there is nothing to re-announce as zero.
    let mut audio_level_is_zero = true;
    let mut mixer = mix_microphone.then(ListenMixer::new);
    let mut last_frame_received = Instant::now();
    transcription.stream_reset_realtime();

    loop {
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        let transcript_pending = transcript_finalization_pending(
            speech.len(),
            in_speech,
            &realtime.last_raw_text,
            &realtime.last_emit_text,
        );
        let deadline = next_consumer_deadline(
            last_frame_received,
            audio_level_is_zero,
            in_speech,
            silence_frames,
            silence_frames_to_end,
            transcript_pending,
        );

        // Once all idle work is settled, wait for a real producer callback (or
        // channel close on stop). A timed receive exists only while a concrete
        // zero-level, silence, or transcript-finalization deadline is pending.
        let received = match deadline {
            Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let chunks: Vec<Vec<f32>> = match received {
            Ok(frame) => {
                last_frame_received = Instant::now();
                match (mixer.as_mut(), frame) {
                    (Some(mixer), ListenFrame::Loopback(chunk)) => {
                        mixer.push_loopback(&chunk);
                        mixer.drain_ready()
                    }
                    (Some(mixer), ListenFrame::Mic(chunk)) => {
                        mixer.push_mic(&chunk);
                        mixer.drain_ready()
                    }
                    (None, ListenFrame::Loopback(chunk)) => vec![chunk],
                    // Mic frames without the mixer can only be a start/stop race —
                    // drop them rather than interleave unmixed audio.
                    (None, ListenFrame::Mic(_)) => Vec::new(),
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                if !audio_level_is_zero
                    && deadline_reached(now, last_frame_received, LOOPBACK_IDLE_GRACE)
                {
                    SttEvents::audio_level(&app, 0.0);
                    audio_level_is_zero = true;
                }
                let silence_due = in_speech
                    && silence_deadline(last_frame_received, silence_frames, silence_frames_to_end)
                        .is_some_and(|deadline| now >= deadline);
                let transcript_due = !in_speech
                    && transcript_pending
                    && deadline_reached(now, last_frame_received, LOOPBACK_IDLE_GRACE);
                if silence_due
                    || (transcript_due
                        && speech.len() >= MIN_SPEECH_SAMPLES
                        && !realtime.last_raw_text.trim().is_empty())
                {
                    finish_realtime_segment(
                        &app,
                        &transcription,
                        &mut speech,
                        &mut realtime,
                        &mut in_speech,
                        &mut silence_frames,
                        &mut diar_span,
                        &session_lines,
                    );
                } else if transcript_due && !realtime.last_emit_text.is_empty() {
                    commit_last_realtime_text(
                        &app,
                        &mut realtime,
                        speech.len(),
                        &mut diar_span,
                        &session_lines,
                    );
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };

        for chunk in chunks {
            // Scalar level for the reused renderer's audio visualizer (onAudioLevel).
            let level = chunk
                .iter()
                .copied()
                .fold(0.0f32, |m, s| m.max(s.abs()))
                .clamp(0.0, 1.0);
            SttEvents::audio_level(&app, level);
            audio_level_is_zero = level <= 0.0;

            // Diarizer rides the same continuous stream; its clock is sample-count
            // based so caption spans and speaker segments share one timebase.
            diar_span.feed(&chunk);

            frame_acc.extend_from_slice(&chunk);

            // Process whole 30 ms frames.
            while frame_acc.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = frame_acc.drain(0..VAD_FRAME_SAMPLES).collect();
                speech.extend_from_slice(&frame);
                let vad_frame = vad.push_frame(&frame).unwrap_or(VadFrame::Noise);

                if let VadFrame::Speech(_) = vad_frame {
                    if !in_speech {
                        in_speech = true;
                        SttEvents::vad_start(&app);
                    }
                    silence_frames = 0;
                } else if in_speech {
                    silence_frames += 1;
                    if silence_frames >= silence_frames_to_end {
                        finish_realtime_segment(
                            &app,
                            &transcription,
                            &mut speech,
                            &mut realtime,
                            &mut in_speech,
                            &mut silence_frames,
                            &mut diar_span,
                            &session_lines,
                        );
                    }
                }
                let dropped = enforce_buffer_cap(&mut speech, max_buffer_samples);
                if dropped > 0 {
                    realtime.forget_buffered_prefix(dropped);
                }
                // VAD no longer gates model input; it only controls active/idle UI state.
            }

            publish_native_realtime_preview_if_due(
                &app,
                &transcription,
                &mut speech,
                &mut realtime,
                &mut diar_span,
                &session_lines,
            );
        }
    }

    if in_speech || speech.len() >= MIN_SPEECH_SAMPLES {
        finish_realtime_segment(
            &app,
            &transcription,
            &mut speech,
            &mut realtime,
            &mut in_speech,
            &mut silence_frames,
            &mut diar_span,
            &session_lines,
        );
    } else {
        clear_realtime_preview(&app);
    }
}

fn samples_for_seconds(seconds: f64) -> usize {
    ((seconds * WHISPER_SAMPLE_RATE as f64).round() as usize).max(1)
}

fn samples_for_millis(ms: usize) -> usize {
    ((ms * WHISPER_SAMPLE_RATE as usize) / 1000).max(1)
}

fn transcript_finalization_pending(
    speech_len: usize,
    in_speech: bool,
    last_raw_text: &str,
    last_emit_text: &str,
) -> bool {
    !in_speech
        && ((speech_len >= MIN_SPEECH_SAMPLES && !last_raw_text.trim().is_empty())
            || !last_emit_text.is_empty())
}

fn consumer_is_fully_settled(
    audio_level_is_zero: bool,
    in_speech: bool,
    transcript_pending: bool,
) -> bool {
    audio_level_is_zero && !in_speech && !transcript_pending
}

fn silence_deadline(
    last_frame_received: Instant,
    silence_frames: usize,
    silence_frames_to_end: usize,
) -> Option<Instant> {
    let remaining_frames = silence_frames_to_end.saturating_sub(silence_frames);
    last_frame_received.checked_add(VAD_FRAME_DURATION.saturating_mul(remaining_frames as u32))
}

fn next_consumer_deadline(
    last_frame_received: Instant,
    audio_level_is_zero: bool,
    in_speech: bool,
    silence_frames: usize,
    silence_frames_to_end: usize,
    transcript_pending: bool,
) -> Option<Instant> {
    if consumer_is_fully_settled(audio_level_is_zero, in_speech, transcript_pending) {
        return None;
    }

    let idle_deadline = (!audio_level_is_zero || transcript_pending)
        .then(|| last_frame_received.checked_add(LOOPBACK_IDLE_GRACE))
        .flatten();
    let pending_silence_deadline = in_speech
        .then(|| silence_deadline(last_frame_received, silence_frames, silence_frames_to_end))
        .flatten();

    match (idle_deadline, pending_silence_deadline) {
        (Some(idle), Some(silence)) => Some(idle.min(silence)),
        (deadline, None) | (None, deadline) => deadline,
    }
}

fn deadline_reached(now: Instant, last_frame_received: Instant, delay: Duration) -> bool {
    last_frame_received
        .checked_add(delay)
        .is_some_and(|deadline| now >= deadline)
}

fn streaming_latency_ms_from_id(model_id: &str) -> Option<usize> {
    model_id
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter_map(|token| token.strip_suffix("ms"))
        .filter_map(|value| value.parse::<usize>().ok())
        .next()
}

fn listen_native_stream_feed_samples(model_id: Option<&str>) -> usize {
    let latency_ms = model_id
        .map(crate::winstt::catalog::canonical_model_id)
        .and_then(streaming_latency_ms_from_id)
        .unwrap_or(LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS)
        .clamp(
            LISTEN_NATIVE_STREAM_MIN_FEED_MS,
            LISTEN_NATIVE_STREAM_MAX_FEED_MS,
        );
    samples_for_millis(latency_ms)
}

fn native_realtime_ready_to_publish(
    speech_len: usize,
    fed_len: usize,
    last_preview_elapsed: Duration,
    interval: Duration,
    feed_samples: usize,
    force: bool,
) -> bool {
    if speech_len < MIN_SPEECH_SAMPLES || speech_len <= fed_len {
        return false;
    }
    if force {
        return true;
    }
    speech_len - fed_len >= feed_samples && last_preview_elapsed >= interval
}

#[expect(
    clippy::too_many_arguments,
    reason = "segment finalization threads the consumer's per-session state through; grouping would only add indirection"
)]
fn finish_realtime_segment(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
    in_speech: &mut bool,
    silence_frames: &mut usize,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
) {
    let committed = finalize_realtime_segment(
        app,
        transcription,
        speech,
        realtime,
        diar_span,
        session_lines,
    );
    if !committed {
        clear_realtime_preview(app);
    }
    realtime.reset_stream(transcription);
    if *in_speech {
        SttEvents::vad_stop(app);
    }
    *in_speech = false;
    *silence_frames = 0;
}

fn enforce_buffer_cap(speech: &mut Vec<f32>, max_samples: usize) -> usize {
    if speech.len() <= max_samples {
        return 0;
    }
    let drop = speech.len() - max_samples;
    speech.drain(..drop);
    log::warn!(
        "[loopback] transcription is falling behind; dropped {:.1}s of buffered audio",
        drop as f64 / WHISPER_SAMPLE_RATE as f64
    );
    drop
}

fn clear_realtime_preview(app: &AppHandle) {
    SttEvents::realtime_stabilized(app, "");
    SttEvents::realtime_text(app, "");
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn uncommitted_realtime_text(committed: &str, raw_text: &str) -> String {
    let raw = raw_text.trim();
    let committed = committed.trim();
    if raw.is_empty() || raw == committed {
        return String::new();
    }
    if committed.is_empty() {
        return raw.to_string();
    }
    if let Some(rest) = raw.strip_prefix(committed) {
        return rest.trim_start().to_string();
    }

    let raw_normalized = collapse_whitespace(raw);
    let committed_normalized = collapse_whitespace(committed);
    if raw_normalized == committed_normalized {
        return String::new();
    }
    if let Some(rest) = raw_normalized.strip_prefix(&committed_normalized) {
        return rest.trim_start().to_string();
    }

    let raw_words: Vec<&str> = raw_normalized.split_whitespace().collect();
    let committed_words: Vec<&str> = committed_normalized.split_whitespace().collect();
    let max_overlap = raw_words.len().min(committed_words.len());
    for overlap in (1..=max_overlap).rev() {
        if committed_words[committed_words.len() - overlap..] == raw_words[..overlap] {
            return raw_words[overlap..].join(" ");
        }
    }

    raw_normalized
}

fn listen_realtime_interval(app: &AppHandle) -> Duration {
    let settings = read_settings_raw(app);
    Duration::from_secs_f64(listen_realtime_interval_seconds(
        settings.quality.realtime_processing_pause,
    ))
}

fn listen_realtime_interval_seconds(configured: f64) -> f64 {
    configured.max(0.01)
}

fn ends_on_realtime_boundary(text: &str) -> bool {
    text.trim_end()
        .chars()
        .last()
        .is_some_and(|c| matches!(c, '.' | '!' | '?' | ',' | ';' | ':' | ')' | ']' | '}'))
}

fn should_roll_realtime_segment(text: &str, samples: usize) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let chars = trimmed.chars().count();
    if chars >= LISTEN_STREAM_ROLL_HARD_CHARS
        || samples >= samples_for_seconds(LISTEN_STREAM_ROLL_HARD_SECONDS)
    {
        return true;
    }

    (chars >= LISTEN_STREAM_ROLL_CHARS
        || samples >= samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS))
        && ends_on_realtime_boundary(trimmed)
}

/// Record one committed caption line on the session transcript. Speaker-
/// labeled when diarization identified one, so the persisted session (and any
/// later post-processing over it) keeps who-said-what.
fn push_session_line(session_lines: &SessionLines, text: &str, speaker: Option<i32>) {
    let line = match speaker {
        Some(speaker) => format!("Speaker {}: {}", speaker + 1, text),
        None => text.to_string(),
    };
    let mut state = session_lines.lock_recover();
    state.lines.push(line);
    // The committed line supersedes whatever preview was accumulating.
    state.live_preview.clear();
}

fn emit_listen_session_snapshot(app: &AppHandle, session_lines: &SessionLines, active: bool) {
    let (lines, live_preview) = {
        let state = session_lines.lock_recover();
        (state.lines.clone(), state.live_preview.clone())
    };
    let _ = app.emit(
        names::LISTEN_SESSION_CHANGED,
        serde_json::json!({
            "active": active,
            "lines": lines,
            "livePreview": live_preview,
        }),
    );
}

fn commit_realtime_segment(
    app: &AppHandle,
    realtime: &mut LoopbackRealtimeState,
    text: &str,
    total_len: usize,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
) {
    let delta = realtime.uncommitted_text(text);
    let trimmed = delta.trim();
    if !trimmed.is_empty() {
        let speaker = diar_span.take_speaker();
        SttEvents::listen_sentence(app, trimmed, speaker);
        push_session_line(session_lines, trimmed, speaker);
        emit_listen_session_snapshot(app, session_lines, true);
    }
    realtime.mark_committed(text, total_len);
    realtime.clear_snapshots();
    clear_realtime_preview(app);
}

/// Split the live caption at a diarizer-detected speaker turn: commit ONLY the
/// text spoken before `boundary` (reconstructed from the tick snapshot at-or-
/// before that time), labeled by the pre-boundary span's own speaker; the
/// post-boundary words stay in the live preview and start the next row. This is
/// the "reform once a speaker is detected" behavior — the diarizer lags real
/// time by its analysis window, so the split lands a few seconds after the turn
/// but never mixes two voices into one committed row and never stalls the stream.
fn split_commit_at_turn(
    app: &AppHandle,
    realtime: &mut LoopbackRealtimeState,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
    boundary: f64,
    raw_now: &str,
    total_len: usize,
) {
    let Some(snap) = realtime.snapshot_at_or_before(boundary).cloned() else {
        // No snapshot reaches back to the boundary (stream restarted since) —
        // fall back to committing the whole span as one row.
        commit_realtime_segment(app, realtime, raw_now, total_len, diar_span, session_lines);
        return;
    };
    let delta = realtime.uncommitted_text(&snap.raw_text);
    let trimmed = delta.trim().to_string();
    let speaker = diar_span.take_speaker_until(boundary);
    if !trimmed.is_empty() {
        SttEvents::listen_sentence(app, &trimmed, speaker);
        push_session_line(session_lines, &trimmed, speaker);
        emit_listen_session_snapshot(app, session_lines, true);
        realtime.mark_committed(&snap.raw_text, snap.total_len);
        clear_realtime_preview(app);
    }
    realtime.drop_snapshots_through(boundary);
}

fn commit_last_realtime_text(
    app: &AppHandle,
    realtime: &mut LoopbackRealtimeState,
    total_len: usize,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
) {
    if realtime.last_raw_text.trim().is_empty() && realtime.last_emit_text.trim().is_empty() {
        return;
    }
    let raw = if realtime.last_raw_text.trim().is_empty() {
        realtime.last_emit_text.clone()
    } else {
        realtime.last_raw_text.clone()
    };
    commit_realtime_segment(app, realtime, &raw, total_len, diar_span, session_lines);
}

fn finalize_realtime_segment(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
) -> bool {
    if speech.len() < MIN_SPEECH_SAMPLES {
        speech.clear();
        return false;
    }

    let total_len = speech.len();
    let tail_start = realtime.fed_len.min(total_len);
    let tail = &speech[tail_start..];
    let final_text = transcription
        .stream_finalize_realtime_blocking(tail)
        .or_else(|| {
            let last = realtime.last_raw_text.trim();
            (!last.is_empty()).then(|| last.to_string())
        });
    speech.clear();

    let Some(text) = final_text else {
        return false;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let delta = realtime.uncommitted_text(trimmed);
    let committed = !delta.trim().is_empty();
    if committed {
        let speaker = diar_span.take_speaker();
        SttEvents::realtime_stabilized_with_final(app, delta.trim(), true);
        SttEvents::realtime_text_with_final(app, delta.trim(), true);
        SttEvents::listen_sentence(app, delta.trim(), speaker);
        push_session_line(session_lines, delta.trim(), speaker);
        emit_listen_session_snapshot(app, session_lines, true);
    }
    realtime.mark_committed(trimmed, 0);
    committed
}

fn publish_native_realtime_preview_if_due(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
    diar_span: &mut DiarSpan,
    session_lines: &SessionLines,
) {
    let feed_samples =
        listen_native_stream_feed_samples(transcription.get_current_model().as_deref());
    if !native_realtime_ready_to_publish(
        speech.len(),
        realtime.fed_len,
        realtime.last_preview.elapsed(),
        listen_realtime_interval(app),
        feed_samples,
        false,
    ) {
        return;
    }
    let total_len = speech.len();
    let new_tail = &speech[realtime.fed_len..];
    realtime.last_preview = Instant::now();

    match transcription.stream_accept_realtime_blocking(realtime.generation, total_len, new_tail) {
        RealtimeStreamOutcome::Text(update) => {
            realtime.fed_len = total_len;
            let text = update.text.trim().to_string();
            realtime.last_raw_text = text.clone();
            // Stamp this tick for the turn-split path: "this much text existed
            // at this session time".
            realtime.record_snapshot(diar_span.clock_sec, &text, total_len);
            let visible_text = realtime.uncommitted_text(&text);
            if update.is_final || visible_text != realtime.last_emit_text {
                realtime.last_emit_text = visible_text.clone();
                SttEvents::realtime_stabilized_with_final(app, &visible_text, update.is_final);
                SttEvents::realtime_text_with_final(app, &visible_text, update.is_final);
                // Mirror and push the in-flight preview for the History tab's
                // live session card.
                session_lines.lock_recover().live_preview = visible_text.clone();
                emit_listen_session_snapshot(app, session_lines, true);
            }
            // A diarizer-detected speaker TURN inside the current span REFORMS
            // the live caption immediately: the pre-boundary text commits as its
            // own speaker's row and the preview keeps only the post-turn words.
            // Waiting for the 12–20 s soft roll would mix two voices into one
            // majority-labeled row.
            if !update.is_final
                && let Some(boundary) = diar_span.turn_boundary()
            {
                split_commit_at_turn(
                    app,
                    realtime,
                    diar_span,
                    session_lines,
                    boundary,
                    &text,
                    total_len,
                );
                return;
            }
            let samples_since_commit = total_len.saturating_sub(realtime.committed_fed_len);
            let should_roll = should_roll_realtime_segment(&visible_text, samples_since_commit);
            let reset_after_roll = should_roll && ends_on_realtime_boundary(&visible_text);
            if update.is_final || should_roll {
                commit_realtime_segment(app, realtime, &text, total_len, diar_span, session_lines);
                if reset_after_roll {
                    speech.clear();
                    realtime.reset_stream(transcription);
                }
            }
        }
        RealtimeStreamOutcome::Skipped => {}
        RealtimeStreamOutcome::NotStreaming => {
            log::warn!("[loopback] selected realtime model does not expose native streaming");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_frames_threshold_matches_two_seconds() {
        // 2.0 s / 30 ms = ~67 frames.
        let frames = ((POST_SPEECH_SILENCE_DURATION * 1000.0) / 30.0).round() as usize;
        assert_eq!(frames, 67);
    }

    #[test]
    fn vad_frame_is_thirty_ms_at_16k() {
        assert_eq!(VAD_FRAME_SAMPLES, 480);
    }

    #[test]
    fn min_speech_is_150ms() {
        assert_eq!(MIN_SPEECH_SAMPLES, 2400);
    }

    #[test]
    fn fully_settled_consumer_has_no_deadline() {
        let now = Instant::now();
        assert!(consumer_is_fully_settled(true, false, false));
        assert_eq!(next_consumer_deadline(now, true, false, 0, 67, false), None);
    }

    #[test]
    fn each_pending_idle_action_keeps_consumer_unsettled() {
        assert!(!consumer_is_fully_settled(false, false, false));
        assert!(!consumer_is_fully_settled(true, true, false));
        assert!(!consumer_is_fully_settled(true, false, true));
    }

    #[test]
    fn consumer_deadline_targets_exact_nearest_pending_action() {
        let now = Instant::now();
        assert_eq!(
            next_consumer_deadline(now, false, false, 0, 67, false),
            now.checked_add(LOOPBACK_IDLE_GRACE)
        );
        assert_eq!(
            next_consumer_deadline(now, true, false, 0, 67, true),
            now.checked_add(LOOPBACK_IDLE_GRACE)
        );

        // Seven 30 ms VAD frames remain: the exact silence deadline is 210 ms,
        // rather than another periodic 200 ms polling tick.
        assert_eq!(
            next_consumer_deadline(now, true, true, 60, 67, false),
            now.checked_add(Duration::from_millis(210))
        );

        // The zero-level deadline wins when it precedes the remaining silence.
        assert_eq!(
            next_consumer_deadline(now, false, true, 0, 67, false),
            now.checked_add(LOOPBACK_IDLE_GRACE)
        );
    }

    #[test]
    fn transcript_deadline_exists_only_for_finalizable_idle_text() {
        assert!(!transcript_finalization_pending(
            MIN_SPEECH_SAMPLES,
            true,
            "pending text",
            "pending text"
        ));
        assert!(transcript_finalization_pending(
            MIN_SPEECH_SAMPLES,
            false,
            "pending text",
            ""
        ));
        assert!(transcript_finalization_pending(
            0,
            false,
            "",
            "emitted preview"
        ));
        assert!(!transcript_finalization_pending(0, false, "", ""));
    }

    #[test]
    fn listen_buffer_cap_keeps_five_minutes() {
        assert_eq!(samples_for_seconds(LISTEN_MAX_BUFFER_SECONDS), 4_800_000);
    }

    #[test]
    fn uncommitted_realtime_text_returns_suffix_for_cumulative_stream() {
        assert_eq!(
            uncommitted_realtime_text("hello there", "hello there general kenobi"),
            "general kenobi"
        );
    }

    #[test]
    fn uncommitted_realtime_text_handles_whitespace_and_word_overlap() {
        assert_eq!(
            uncommitted_realtime_text("the quick brown fox", "brown fox jumps over the lazy dog"),
            "jumps over the lazy dog"
        );
        assert_eq!(
            uncommitted_realtime_text("the quick brown fox", "the   quick brown fox"),
            ""
        );
    }

    #[test]
    fn listen_stream_soft_roll_waits_for_text_boundary() {
        assert!(!should_roll_realtime_segment(
            "this segment is still mid phrase",
            samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS)
        ));
        assert!(should_roll_realtime_segment(
            "this segment reached a sentence boundary.",
            samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS)
        ));
    }

    #[test]
    fn listen_stream_hard_roll_does_not_wait_forever() {
        assert!(should_roll_realtime_segment(
            "still no punctuation but this has gone on long enough",
            samples_for_seconds(LISTEN_STREAM_ROLL_HARD_SECONDS)
        ));
    }

    #[test]
    fn loopback_vad_uses_stereo_mix_sensitivity() {
        assert_eq!(LOOPBACK_VAD_SPEECH_THRESHOLD, 0.05);
    }

    #[test]
    fn tick_snapshots_reconstruct_text_at_turn_boundary() {
        let mut rt = LoopbackRealtimeState::new();
        rt.record_snapshot(1.0, "hello", 16_000);
        rt.record_snapshot(2.0, "hello there", 32_000);
        rt.record_snapshot(3.0, "hello there general", 48_000);

        // Latest snapshot at-or-before the boundary wins.
        assert_eq!(
            rt.snapshot_at_or_before(2.5).map(|s| s.raw_text.as_str()),
            Some("hello there")
        );
        // A boundary predating every snapshot has nothing to offer.
        assert!(rt.snapshot_at_or_before(0.5).is_none());

        // Boundary commit: prefix commits, LATER snapshots survive (their raw
        // text extends the new committed prefix), covered ones drop.
        rt.mark_committed("hello there", 32_000);
        rt.drop_snapshots_through(2.5);
        assert_eq!(rt.snapshots.len(), 1);
        assert_eq!(rt.uncommitted_text("hello there general"), "general");

        // A full commit invalidates the whole history.
        rt.clear_snapshots();
        assert!(rt.snapshot_at_or_before(10.0).is_none());
    }

    #[test]
    fn tick_snapshots_track_buffer_prefix_drops_and_stay_bounded() {
        let mut rt = LoopbackRealtimeState::new();
        for i in 0..(MAX_TICK_SNAPSHOTS + 8) {
            rt.record_snapshot(i as f64, "text", 10_000 + i);
        }
        assert_eq!(rt.snapshots.len(), MAX_TICK_SNAPSHOTS);
        rt.forget_buffered_prefix(5_000);
        assert!(rt.snapshots.iter().all(|s| s.total_len >= 5_000 + 8));
    }

    #[test]
    fn listen_realtime_interval_honors_configured_pause() {
        assert_eq!(listen_realtime_interval_seconds(0.02), 0.02);
        assert_eq!(listen_realtime_interval_seconds(0.5), 0.5);
        assert_eq!(listen_realtime_interval_seconds(0.0), 0.01);
    }

    #[test]
    fn streaming_latency_parses_from_catalog_and_repo_ids() {
        assert_eq!(
            streaming_latency_ms_from_id("streaming-nemotron-en-560ms-int8"),
            Some(560)
        );
        assert_eq!(
            streaming_latency_ms_from_id(
                "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-1120ms-int8-2026-04-25"
            ),
            Some(1120)
        );
        assert_eq!(streaming_latency_ms_from_id("zipformer-en"), None);
    }

    #[test]
    fn listen_feed_samples_follow_canonical_model_latency() {
        // Each concrete latency row feeds at ITS OWN chunk latency (clamped to
        // the [MIN, MAX] feed window). Latency is the speed-vs-accuracy control
        // and must NOT collapse to a single canonical window — see the design
        // note on `catalog::canonical_model_id`. An already-int8 id is canonical
        // (idempotent), so the parsed `<n>ms` token is the feed window.
        assert_eq!(
            listen_native_stream_feed_samples(Some("streaming-nemotron-3.5-multi-1120ms-int8")),
            samples_for_millis(1120)
        );
        assert_eq!(
            listen_native_stream_feed_samples(Some("streaming-parakeet-unified-en-560ms-int8")),
            samples_for_millis(560)
        );
        assert_eq!(
            listen_native_stream_feed_samples(Some("zipformer-en")),
            samples_for_millis(LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS)
        );
    }

    #[test]
    fn listen_mixer_sums_aligned_frames() {
        let mut mixer = ListenMixer::new();
        mixer.push_loopback(&vec![0.25; VAD_FRAME_SAMPLES]);
        assert!(mixer.drain_ready().is_empty(), "waits for the mic leg");
        mixer.push_mic(&vec![0.5; VAD_FRAME_SAMPLES]);
        let out = mixer.drain_ready();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), VAD_FRAME_SAMPLES);
        assert!(out[0].iter().all(|&s| (s - 0.75).abs() < 1e-6));
    }

    #[test]
    fn listen_mixer_clamps_summed_peaks() {
        let mut mixer = ListenMixer::new();
        mixer.push_loopback(&vec![0.9; VAD_FRAME_SAMPLES]);
        mixer.push_mic(&vec![0.9; VAD_FRAME_SAMPLES]);
        let out = mixer.drain_ready();
        assert!(out[0].iter().all(|&s| s <= 1.0));
    }

    #[test]
    fn listen_mixer_flushes_a_stalled_leg_after_skew_allowance() {
        let mut mixer = ListenMixer::new();
        // Mic keeps producing while the loopback leg stalls (render silence).
        mixer.push_mic(&vec![0.1; MIX_MAX_SKEW_SAMPLES]);
        assert!(
            mixer.drain_ready().is_empty(),
            "within the skew allowance the mic waits for loopback"
        );
        mixer.push_mic(&vec![0.1; VAD_FRAME_SAMPLES]);
        let out = mixer.drain_ready();
        // Flushes FULLY so a resuming loopback re-aligns fresh.
        assert_eq!(out.len(), MIX_MAX_SKEW_SAMPLES / VAD_FRAME_SAMPLES + 1);
        assert!(mixer.mic.is_empty());
    }

    #[test]
    fn listen_mixer_caps_runaway_buffers() {
        let mut mixer = ListenMixer::new();
        mixer.push_loopback(&vec![0.1; MIX_MAX_BUFFER_SAMPLES + 4800]);
        assert_eq!(mixer.loopback.len(), MIX_MAX_BUFFER_SAMPLES);
    }

    #[test]
    fn session_lines_are_speaker_labeled_when_diarized() {
        let session: SessionLines = Arc::new(Mutex::new(ListenSessionState::default()));
        session.lock_recover().live_preview = "hi ba".to_string();
        push_session_line(&session, "hello there", None);
        push_session_line(&session, "hi back", Some(1));
        let state = session.lock_recover();
        assert_eq!(state.lines, vec!["hello there", "Speaker 2: hi back"]);
        // A committed line supersedes the accumulating preview.
        assert_eq!(state.live_preview, "");
    }

    #[test]
    fn native_realtime_waits_for_model_sized_feed() {
        let interval = Duration::from_millis(10);
        let elapsed = Duration::from_millis(50);
        let feed = samples_for_millis(1120);
        assert!(!native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + samples_for_millis(30),
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            false
        ));
        assert!(native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + feed,
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            false
        ));
        assert!(native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + samples_for_millis(30),
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            true
        ));
    }
}
