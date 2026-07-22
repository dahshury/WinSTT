use crate::managers::audio::AudioRecordingManager;
use crate::settings::ModelUnloadTimeout;
use crate::winstt::settings_schema::RecordingMode;
use crate::winstt::sync_ext::MutexExt;
use anyhow::Result;
use log::{debug, info, warn};
use serde::Serialize;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
// The ONLY `crate::winstt::*` symbols this legacy core names (audit #14): the engine
// type (`Transcriber`) the `LoadedEngine::Winstt` arm boxes, and the backend trait surface the
// core delegates every WinSTT-specific step to. All WinSTT logic lives behind `SttBackend`.
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::stt::{
    BackendRoute, SttBackend, Transcriber as WinsttTranscriber, WinsttSttBackend,
};

// The behavior of `TranscriptionManager` is split across sibling files of this module: each adds
// an additional `impl TranscriptionManager` block (same type, same module tree), so they share the
// struct's private fields and the private accessor methods below with ZERO visibility leakage.
mod decode;
mod load;
mod realtime;

mod accel;
// Re-export the accelerator free functions / DTOs so external callers keep reaching them at
// `crate::managers::transcription::{apply_accelerator_settings, get_available_accelerators,
// AvailableAccelerators, GpuDeviceOption}` (lib.rs, shortcut/mod.rs).
pub use accel::{AvailableAccelerators, apply_accelerator_settings, get_available_accelerators};

/// Single-pass mean + DC-immune RMS (AC energy) over a recording. One traversal computes
/// Σx and Σx² in f64 (variance = E[x²] − mean², clamped at 0 against rounding), replacing
/// the previous three full passes (mean, then a second mean inside the RMS helper, then
/// the residual pass) — this runs on the FULL buffer per batch decode and again on the
/// growing buffer every realtime tick. The f64 accumulators are also strictly more
/// accurate than the old f32 running sums on long recordings.
fn audio_energy_stats(audio: &[f32]) -> (f32, f32) {
    if audio.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    for &x in audio {
        let x = f64::from(x);
        sum += x;
        sum_sq += x * x;
    }
    let n = audio.len() as f64;
    let mean = sum / n;
    let variance = (sum_sq / n - mean * mean).max(0.0);
    (mean as f32, variance.sqrt() as f32)
}

/// DC-immune RMS (AC energy): subtract the mean (constant offset) first so a dead
/// device's constant DC bias doesn't read as signal, then RMS the residual. Shared by
/// the batch silence gate AND the realtime worker so both reject windows with no
/// decodable speech energy — below this Whisper hallucinates phantom text ("Thank you.")
/// on the silence the Silero VAD (threshold 0.3) lets through.
pub(crate) fn dc_immune_rms(audio: &[f32]) -> f32 {
    audio_energy_stats(audio).1
}

/// AC-energy floor separating real speech from silence / room-tone / Whisper-on-silence
/// hallucinations. Empirically (this repo's own recordings, logged via `[silence-gate]`):
/// real speech recordings measure RMS ≥ ~0.0074; silence + hallucinated "Thank you."
/// clips measure ≤ ~0.0014. 0.003 sits cleanly between, with headroom below the quietest
/// real speech for soft talkers / distant mics. Applied on BOTH silence-gate paths: the
/// no-mask path (file / cloud) measures it over the whole buffer; the mask path (mic / PTT)
/// measures it DC-immune over the mask's SPEECH frames only (see
/// [`is_silent_recording_with_mask`]), so captured silence can't dilute a soft speaker below
/// it — while the hallucination band (≤ ~0.0014) still can't slip past. The floor MUST NOT be
/// lowered on the mask path: Silero-at-0.3 false-fires speech frames onto near-silent audio, so
/// a lower floor would let hallucinated "Thank you." clips through to the model.
pub(crate) const SILENCE_AC_FLOOR: f32 = 0.003;

/// The DC offset must exceed the AC RMS by this factor to be classed "all offset, no audio"
/// (the dead/virtual-mic fingerprint that makes Whisper emit a wall of garbled text).
const DC_DOMINANCE_RATIO: f32 = 10.0;
const NATIVE_STREAM_FINAL_SILENCE_PAD_MS: usize = 2000;
const NATIVE_STREAM_SAMPLE_RATE: usize = 16_000;

static TRANSCRIPTION_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_transcription_request_id() -> String {
    format!(
        "stt-{}",
        TRANSCRIPTION_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// True when a recording carries no decodable speech. This is the user's gold-standard gate:
/// silence must never reach the model, but we never get there by decoding everything.
///
/// With a per-frame capture `speech_mask` (mic path — capture is now ungated, so the buffer carries
/// its own silence), a clip is rejected iff (a) the mask contains ZERO speech frames, OR (b) the
/// DC-dominated dead/virtual-mic fingerprint, OR (c) the DC-immune RMS OF THE MASK'S SPEECH FRAMES
/// is below [`SILENCE_AC_FLOOR`]. Measuring the floor over the SPEECH frames — not the whole (now
/// silence-diluted) buffer — is what lets the mask path share the SAME 0.003 floor as the no-mask
/// path without dropping a soft speaker in a long, mostly-silent recording: captured silence can't
/// pull the speech-frame RMS below the floor. The floor MUST stay at 0.003, NOT lower: Silero-at-0.3
/// false-fires on near-silent frames, so a hallucinated "Thank you." clip (whole-clip RMS ≈ 0.0014,
/// uniform → speech-frame RMS ≈ 0.0014) carries speech frames in the mask; only a floor at/above
/// 0.003 rejects that band, whereas a lower floor lets it through to the model to be re-hallucinated.
///
/// Without a mask (file / cloud), the legacy behavior is kept exactly: reject iff whole-buffer RMS
/// is below [`SILENCE_AC_FLOOR`] OR DC-dominated. Shared by the batch silence gate AND the
/// realtime-reuse guard (a reused live decode must NOT paste hallucinated text over what the gate
/// would otherwise have rejected). Audio is RAW (pre-`peak_normalize`).
pub(crate) fn is_silent_recording_with_mask(audio: &[f32], speech_mask: Option<&[bool]>) -> bool {
    if audio.is_empty() {
        return true;
    }
    let (mean, rms) = audio_energy_stats(audio);
    let dc_dominated = mean.abs() > rms * DC_DOMINANCE_RATIO;
    match speech_mask {
        Some(mask) => {
            let no_speech = !mask.iter().any(|&speech| speech);
            if no_speech || dc_dominated {
                return true;
            }
            speech_masked_rms(audio, mask) < SILENCE_AC_FLOOR
        }
        None => rms < SILENCE_AC_FLOOR || dc_dominated,
    }
}

/// DC-immune AC RMS measured ONLY over the frames the capture `mask` flags as speech (frame size
/// [`VAD_FRAME_SAMPLES`]; a trailing partial frame past the mask is ignored). Used by the mask-path
/// dead-air gate so a genuine soft speaker's energy is judged where the VAD claims speech, not
/// averaged against the captured silence that now surrounds it. Returns 0 when no speech frame maps
/// to any samples.
fn speech_masked_rms(audio: &[f32], mask: &[bool]) -> f32 {
    let frame = crate::audio_toolkit::vad::VAD_FRAME_SAMPLES;
    let mut speech: Vec<f32> = Vec::new();
    for (i, &is_speech) in mask.iter().enumerate() {
        if !is_speech {
            continue;
        }
        let lo = i * frame;
        if lo >= audio.len() {
            break;
        }
        let hi = ((i + 1) * frame).min(audio.len());
        speech.extend_from_slice(&audio[lo..hi]);
    }
    if speech.is_empty() {
        return 0.0;
    }
    dc_immune_rms(&speech)
}

fn native_stream_final_tail_with_silence(tail: &[f32]) -> Vec<f32> {
    native_stream_final_tail_capped(tail, 0)
}

/// Trailing real silence (in samples) at the END of a capture, derived from its per-frame speech
/// mask — the count of consecutive non-speech frames at the tail × frame size. Used to shrink the
/// native-stream finalize pad by the right-context silence the encoder ALREADY captured (capture is
/// ungated now, so a recording that trailed off into silence carries it).
fn trailing_silence_samples_from_mask(speech_mask: &[bool]) -> usize {
    let trailing_frames = speech_mask
        .iter()
        .rev()
        .take_while(|&&speech| !speech)
        .count();
    trailing_frames * crate::audio_toolkit::vad::VAD_FRAME_SAMPLES
}

/// Native-stream finalize tail padded to flush the streaming encoder's right context, appending
/// only the SHORTFALL: `max(0, 2000 ms − already_silent_samples)`. `already_silent_samples` is the
/// trailing real silence the capture already carries (0 on the no-mask path → the full 2000 ms, the
/// unchanged legacy behavior); a recording that ended in ≥ 2000 ms of captured silence gets no pad.
fn native_stream_final_tail_capped(tail: &[f32], already_silent_samples: usize) -> Vec<f32> {
    let target = NATIVE_STREAM_SAMPLE_RATE * NATIVE_STREAM_FINAL_SILENCE_PAD_MS / 1000;
    let pad_samples = target.saturating_sub(already_silent_samples);
    let mut padded = Vec::with_capacity(tail.len() + pad_samples);
    padded.extend_from_slice(tail);
    padded.resize(padded.len() + pad_samples, 0.0);
    padded
}

/// One cached realtime full-buffer decode, kept so the FINAL paste can reuse it instead of
/// re-decoding the same audio. The realtime worker already decoded the whole growing buffer with
/// the SAME engine, so when the user stops talking the last live decode == the final decode (sans
/// post-processing). See [`TranscriptionManager::cache_realtime_reuse`] / `try_reuse_realtime`.
#[derive(Clone, Debug)]
struct RealtimeReuse {
    /// Recording generation this decode belongs to (guards against reusing a previous take's text).
    generation: u64,
    /// Samples the cached decode covered (the live-mirror length at decode time).
    covered: usize,
    /// RAW engine text (pre-post-processing) of the full-buffer realtime decode.
    raw_text: String,
}

#[derive(Clone, Copy, Debug)]
struct LoadedTranscriptionCapabilities {
    /// Whether realtime text can be promoted to the final paste without re-decoding.
    final_reuse_safe: bool,
    /// Whether realtime accepts only new samples through a stateful/native stream.
    native_streaming: bool,
}

impl LoadedTranscriptionCapabilities {
    const CONSERVATIVE: Self = Self {
        final_reuse_safe: false,
        native_streaming: false,
    };
}

/// Outcome of one realtime native-streaming tick (see
/// [`TranscriptionManager::stream_accept_realtime`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RealtimeStreamText {
    pub text: String,
    pub is_final: bool,
}

impl RealtimeStreamText {
    fn interim(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_final: false,
        }
    }
}

pub enum RealtimeStreamOutcome {
    /// Decoded incremental text so far (possibly empty) with official-style finality metadata.
    Text(RealtimeStreamText),
    /// The engine mutex is held by a batch decode — retry next tick WITHOUT advancing the fed
    /// watermark (the same new samples are re-fed next time).
    Skipped,
    /// The loaded engine is not a native-streaming engine — the caller should use the
    /// window-redecode preview path instead.
    NotStreaming,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelStateEvent {
    pub event_type: String,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub error: Option<String>,
}

/// Outcome of one [`TranscriptionManager::warmup`] attempt — lets the swap
/// orchestrator's [`TranscriptionManager::wait_until_warm`] decide whether the
/// engine is settled (warm / failed / nothing local) or still in flux (another
/// warm or a recovery reload in flight) and worth re-checking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SttWarmupOutcome {
    /// The dummy-silence decode ran and the model is marked warm.
    Warmed,
    /// The model was already warm — nothing to do.
    AlreadyWarm,
    /// No current model, or nothing local to warm (cloud id / failed load).
    NothingToWarm,
    /// Another warmup holds the flag, a real decode holds the engine (that
    /// decode IS the warm), or a degenerate-decode recovery reload is running —
    /// the state will settle shortly; re-check after the warm lifecycle signal.
    InFlight,
    /// This warm attempt owned the warming flag but yielded to a contended engine. Its own guard
    /// publishes one edge; the engine owner's release publishes the edge the waiter needs.
    EngineInFlight,
    /// The dummy decode failed and no recovery is running; waiting longer will
    /// not make the engine warmer.
    Failed,
}

enum LoadedEngine {
    /// WinSTT unified ort-ONNX engine. This is the only local STT execution path; unknown
    /// model ids are rejected before load.
    Winstt(Box<dyn WinsttTranscriber>),
}

impl LoadedEngine {
    fn shutdown(&mut self) {
        match self {
            LoadedEngine::Winstt(engine) => engine.shutdown(),
        }
    }
}

/// Wake-up edge for the idle-unload watcher. The generation makes notifications durable across
/// the small gap between evaluating the lifecycle state and entering `Condvar::wait*`.
#[derive(Default)]
struct IdleWatcherSignal {
    generation: Mutex<u64>,
    condvar: Condvar,
}

impl IdleWatcherSignal {
    fn notify(&self) {
        let mut generation = self.generation.lock_recover();
        *generation = generation.wrapping_add(1);
        self.condvar.notify_all();
    }

    /// Serialize a lifecycle state mutation with the idle watcher's final predicate check.
    /// Callers must acquire any subordinate state locks only inside `update` so the global order
    /// remains lifecycle -> is_loading -> engine -> recording-state -> activity.
    fn update<R>(&self, mutate: impl FnOnce() -> R) -> R {
        let mut generation = self.generation.lock_recover();
        let result = mutate();
        *generation = generation.wrapping_add(1);
        self.condvar.notify_all();
        result
    }
}

/// RAII guard that clears the `is_loading` flag and notifies waiters on drop.
/// Ensures the loading flag is always reset, even on early returns or panics.
pub struct LoadingGuard {
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
    idle_watcher_signal: Arc<IdleWatcherSignal>,
}

impl Drop for LoadingGuard {
    fn drop(&mut self) {
        // Recover a poisoned lock so the loading flag is always cleared (uniform
        // with the manager's poison-recovery discipline); never panic in a Drop.
        self.idle_watcher_signal.update(|| {
            let mut is_loading = self.is_loading.lock_recover();
            *is_loading = false;
            self.loading_condvar.notify_all();
        });
    }
}

/// Generation-counted condition signal for synchronous warm-state waiters. Snapshotting the
/// generation before a warm attempt makes a release durable even when it lands just before the
/// waiter enters `Condvar::wait_timeout_while`.
#[derive(Default)]
struct WarmWaitSignal {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl WarmWaitSignal {
    fn signal(&self) {
        let mut generation = self.generation.lock_recover();
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }

    fn observe(&self) -> u64 {
        *self.generation.lock_recover()
    }

    fn wait_for_change_after(&self, observed: u64, timeout: Duration) -> bool {
        let generation = self.generation.lock_recover();
        if *generation != observed {
            return true;
        }
        let (generation, _) = self
            .changed
            .wait_timeout_while(generation, timeout, |generation| *generation == observed)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation != observed
    }

    fn wait_for_change_after_blocking(&self, observed: u64) {
        let generation = self.generation.lock_recover();
        if *generation != observed {
            return;
        }
        drop(
            self.changed
                .wait_while(generation, |generation| *generation == observed)
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    }

    /// Wait until the current warmup owner settles or another lifecycle edge makes the caller's
    /// target stale. The predicate is checked while holding the generation lock, so a guard that
    /// clears `warming` immediately before signaling cannot slip through the check/wait gap.
    fn wait_while_warming(&self, warming: &AtomicBool, timeout: Duration) -> bool {
        let generation = self.generation.lock_recover();
        if !warming.load(Ordering::Acquire) {
            return true;
        }
        let observed = *generation;
        let (generation, _) = self
            .changed
            .wait_timeout_while(generation, timeout, |generation| {
                *generation == observed && warming.load(Ordering::Acquire)
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation != observed || !warming.load(Ordering::Acquire)
    }

    /// Wait for the engine owner that preempted a warm attempt. Holding the generation lock while
    /// probing the mutex closes the release-before-wait race: `EngineGuard` unlocks the engine
    /// first, then takes this lock to publish its edge.
    fn wait_for_engine_return(
        &self,
        engine: &Mutex<Option<LoadedEngine>>,
        timeout: Duration,
    ) -> bool {
        let generation = self.generation.lock_recover();
        match engine.try_lock() {
            Ok(guard) if guard.is_some() => {
                drop(guard);
                return true;
            }
            // Batch transcription temporarily takes the logical engine out of the mutex. Its
            // return (or fatal removal/current-model clear) publishes the lifecycle edge below.
            Ok(guard) => drop(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                drop(poisoned.into_inner());
                return true;
            }
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        let observed = *generation;
        let (generation, _) = self
            .changed
            .wait_timeout_while(generation, timeout, |generation| *generation == observed)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation != observed
    }
}

/// Manager-owned engine guard. Its drop unlocks first, then publishes the reliable release edge
/// that a preempted warmup waits for.
struct EngineGuard<'a> {
    guard: Option<MutexGuard<'a, Option<LoadedEngine>>>,
    warm_wait_signal: Arc<WarmWaitSignal>,
}

impl Deref for EngineGuard<'_> {
    type Target = Option<LoadedEngine>;

    fn deref(&self) -> &Self::Target {
        self.guard.as_deref().expect("engine guard must be present")
    }
}

impl DerefMut for EngineGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard
            .as_deref_mut()
            .expect("engine guard must be present")
    }
}

impl Drop for EngineGuard<'_> {
    fn drop(&mut self) {
        drop(self.guard.take());
        self.warm_wait_signal.signal();
    }
}

/// Release publisher for lifecycle code that owns only the raw shared engine mutex.
struct WarmReleaseGuard(Arc<WarmWaitSignal>);

impl Drop for WarmReleaseGuard {
    fn drop(&mut self) {
        self.0.signal();
    }
}

/// RAII guard that clears the `warming` flag and wakes waiters on drop, including every early
/// return and caught-panic path.
struct WarmingGuard {
    warming: Arc<AtomicBool>,
    warm_wait_signal: Arc<WarmWaitSignal>,
}

impl Drop for WarmingGuard {
    fn drop(&mut self) {
        self.warming.store(false, Ordering::Release);
        self.warm_wait_signal.signal();
    }
}

const WHISPER_GARBAGE_MARKER: &str = "[whisper-garbage]";
const STT_IDLE_UNLOAD_NEVER_SECS: u64 = u64::MAX;

fn encode_stt_idle_unload_timeout(timeout: ModelUnloadTimeout) -> u64 {
    timeout.to_seconds().unwrap_or(STT_IDLE_UNLOAD_NEVER_SECS)
}

struct IdleWatcherContext {
    app_handle: AppHandle,
    engine: Weak<Mutex<Option<LoadedEngine>>>,
    current_model_id: Weak<Mutex<Option<String>>>,
    active_providers: Weak<Mutex<Option<Vec<String>>>>,
    last_activity: Weak<Mutex<Instant>>,
    model_unload_timeout_secs: Weak<AtomicU64>,
    listen_mode_resident: Weak<AtomicBool>,
    shutdown_signal: Weak<AtomicBool>,
    is_loading: Weak<Mutex<bool>>,
    model_lifecycle: Weak<ModelSwapCoordinator>,
    signal: Arc<IdleWatcherSignal>,
    warm_wait_signal: Arc<WarmWaitSignal>,
}

impl IdleWatcherContext {
    fn is_recording(&self) -> bool {
        self.app_handle
            .try_state::<Arc<AudioRecordingManager>>()
            .is_some_and(|audio| audio.is_recording())
    }

    /// Returns the exact time until the next idle deadline. `None` means there is no deadline and
    /// the watcher can sleep until a lifecycle notification arrives.
    fn next_wait(&self) -> Option<Duration> {
        let engine = self.engine.upgrade()?;
        let timeout = self.model_unload_timeout_secs.upgrade()?;
        let listen_mode = self.listen_mode_resident.upgrade()?;
        let is_loading = self.is_loading.upgrade()?;
        let last_activity = self.last_activity.upgrade()?;

        let timeout_secs = timeout.load(Ordering::Acquire);
        if listen_mode.load(Ordering::Acquire)
            || timeout_secs == 0
            || timeout_secs == STT_IDLE_UNLOAD_NEVER_SECS
            || *is_loading.lock_recover()
            || self.is_recording()
        {
            return None;
        }
        let release = WarmReleaseGuard(self.warm_wait_signal.clone());
        let engine_empty = engine.lock_recover().is_none();
        drop(release); // the temporary engine guard has already unlocked
        if engine_empty {
            return None;
        }

        let timeout = Duration::from_secs(timeout_secs);
        let deadline = *last_activity.lock_recover() + timeout;
        Some(deadline.saturating_duration_since(Instant::now()))
    }

    /// Re-check every unload precondition while owning the engine lock, so an activity signal
    /// delivered at the deadline cannot unload a model that has just become busy.
    fn unload_if_still_idle(&self) {
        let Some(engine) = self.engine.upgrade() else {
            return;
        };
        let Some(timeout) = self.model_unload_timeout_secs.upgrade() else {
            return;
        };
        let Some(listen_mode) = self.listen_mode_resident.upgrade() else {
            return;
        };
        let Some(is_loading) = self.is_loading.upgrade() else {
            return;
        };
        let Some(last_activity) = self.last_activity.upgrade() else {
            return;
        };

        // Serialize the final predicate check with every activity/policy mutation. Keep the
        // established subordinate lock order
        // lifecycle -> is_loading -> engine -> recording-state -> activity.
        let _lifecycle = self.signal.generation.lock_recover();
        let loading = is_loading.lock_recover();
        // Declared first so it publishes after the engine guard unlocks on every return path.
        let _release = WarmReleaseGuard(self.warm_wait_signal.clone());
        let mut engine = engine.lock_recover();
        let timeout_secs = timeout.load(Ordering::Acquire);
        if engine.is_none()
            || *loading
            || listen_mode.load(Ordering::Acquire)
            || timeout_secs == 0
            || timeout_secs == STT_IDLE_UNLOAD_NEVER_SECS
            || self.is_recording()
        {
            return;
        }

        let last = *last_activity.lock_recover();
        let deadline = last + Duration::from_secs(timeout_secs);
        let now = Instant::now();
        if now < deadline {
            return;
        }

        let mut old_engine = engine.take();
        drop(loading);
        drop(engine);
        let idle_for = now.saturating_duration_since(last);
        let unload_start = Instant::now();
        info!(
            "Model idle for {}s (limit: {}s), unloading",
            idle_for.as_secs(),
            timeout_secs
        );
        if let Some(engine) = old_engine.as_mut() {
            engine.shutdown();
        }
        if let Some(current_model_id) = self.current_model_id.upgrade() {
            *current_model_id.lock_recover() = None;
        }
        if let Some(active_providers) = self.active_providers.upgrade() {
            *active_providers.lock_recover() = None;
        }
        if let Some(model_lifecycle) = self.model_lifecycle.upgrade() {
            model_lifecycle.clear_all_warm();
        }
        let _ = self.app_handle.emit(
            crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );
        info!(
            "Model unloaded due to inactivity (took {}ms)",
            unload_start.elapsed().as_millis()
        );
        crate::log_model_duration("stt idle unload", unload_start);
    }

    fn run(self) {
        debug!("Idle watcher thread started");
        let mut observed_generation = *self.signal.generation.lock_recover();
        while let Some(shutdown) = self.shutdown_signal.upgrade() {
            if shutdown.load(Ordering::Acquire) {
                break;
            }

            let wait = self.next_wait();
            if wait.is_some_and(|duration| duration.is_zero()) {
                self.unload_if_still_idle();
                continue;
            }

            let mut generation = self.signal.generation.lock_recover();
            if *generation != observed_generation {
                observed_generation = *generation;
                continue;
            }
            generation = match wait {
                Some(duration) => {
                    let (guard, _) = self
                        .signal
                        .condvar
                        .wait_timeout(generation, duration)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    guard
                }
                None => self
                    .signal
                    .condvar
                    .wait(generation)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            };
            observed_generation = *generation;
        }
        debug!("Idle watcher thread shutting down gracefully");
    }
}

fn is_degenerate_decode_error(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains(WHISPER_GARBAGE_MARKER) || msg.contains("degenerate Whisper decode")
}

/// True when a decode error means the GPU/accelerator device was lost, reset, or suspended —
/// a DirectML/D3D12 device-removal (driver TDR reset, the GPU being reset by another process,
/// or a system sleep/wake transition). DXGI surfaces these as `DXGI_ERROR_DEVICE_REMOVED`
/// (`887A0005`) / `DEVICE_HUNG` (`887A0006`) / `DEVICE_RESET` (`887A0007`), and ORT bubbles up
/// the literal "The GPU device instance has been suspended" / "GetDeviceRemovedReason" text.
///
/// Once this fires the ONNX Runtime session bound to that device is permanently dead, so reusing
/// the loaded engine would fail identically forever. The decode path drops the engine and clears
/// the resident/warmed model so the NEXT transcription rebuilds a fresh session on a new DML
/// device. Kept DISTINCT from `is_degenerate_decode_error`: device loss is environmental and
/// usually transient, so — unlike a degenerate decode — it must NOT count toward the DirectML →
/// CPU demotion (a single sleep/wake should not permanently drop the user onto CPU). The full
/// error chain is flattened (`{err:#}`) and lowercased so we match regardless of nesting/case.
fn is_device_lost_error(err: &anyhow::Error) -> bool {
    let msg = format!("{err:#}").to_ascii_lowercase();
    msg.contains("device instance has been suspended")
        || msg.contains("device has been removed")
        || msg.contains("device has been reset")
        || msg.contains("getdeviceremovedreason")
        || msg.contains("887a0005") // DXGI_ERROR_DEVICE_REMOVED
        || msg.contains("887a0006") // DXGI_ERROR_DEVICE_HUNG
        || msg.contains("887a0007") // DXGI_ERROR_DEVICE_RESET
}

/// Resources whose teardown must happen exactly once, after the final manager clone disappears.
/// `Arc` runs this value's `Drop` for the single thread that releases its last strong reference,
/// avoiding the check-then-act race inherent in observing `Arc::strong_count` from manager drops.
struct TranscriptionManagerLifecycle {
    shutdown_signal: Arc<AtomicBool>,
    idle_watcher_signal: Arc<IdleWatcherSignal>,
    watcher_handle: Mutex<Option<thread::JoinHandle<()>>>,
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    warm_wait_signal: Arc<WarmWaitSignal>,
}

impl Drop for TranscriptionManagerLifecycle {
    fn drop(&mut self) {
        self.shutdown_signal.store(true, Ordering::Release);
        self.idle_watcher_signal.notify();

        if let Some(handle) = self.watcher_handle.lock_recover().take() {
            match handle.join() {
                Err(e) => warn!("Failed to join idle watcher thread: {:?}", e),
                Ok(()) => debug!("Idle watcher thread joined successfully"),
            }
        }

        let _release = WarmReleaseGuard(self.warm_wait_signal.clone());
        let mut engine = self.engine.lock_recover().take();
        if let Some(engine) = engine.as_mut() {
            engine.shutdown();
        }
    }
}

#[derive(Clone)]
pub struct TranscriptionManager {
    /// The only owner of watcher/engine teardown. Cloning the manager clones this `Arc`; Rust runs
    /// the lifecycle's `Drop` exactly once when the final manager clone is released.
    lifecycle: Arc<TranscriptionManagerLifecycle>,
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    /// The loaded engine's ACTUAL ORT execution providers, snapshotted at install time (see
    /// `initiate_model_load`) and cleared on unload. Kept OUTSIDE the engine mutex so the runtime
    /// chip can read it while a decode owns the engine. This is what lets the GPU/CPU footer chip
    /// tell the truth for DML-incompatible engines that `override_dml_to_cpu_for_kind` routed to
    /// CPU despite a GPU device setting.
    active_providers: Arc<Mutex<Option<Vec<String>>>>,
    last_activity: Arc<Mutex<Instant>>,
    model_unload_timeout_secs: Arc<AtomicU64>,
    listen_mode_resident: Arc<AtomicBool>,
    idle_watcher_signal: Arc<IdleWatcherSignal>,
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
    /// True while a post-swap kernel WARMUP decode is running. Distinct from `is_loading`
    /// (which gates real loads): a real decode does NOT wait on `warming`, so the user's
    /// dictation can preempt a cold warmup instead of being serialized behind it. A racing
    /// `transcribe()` simply wins the engine mutex; warmup `try_lock`s and yields when the
    /// engine is busy.
    warming: Arc<AtomicBool>,
    /// Wakes the blocking swap orchestrator when a warmup owner settles, an engine owner
    /// releases, or the resident/warm model lifecycle changes.
    warm_wait_signal: Arc<WarmWaitSignal>,
    /// Shared warm-state tracker for the currently-resident model. The heavyweight load gate stays
    /// in `is_loading`; this coordinator records whether that resident engine has paid warmup.
    model_lifecycle: Arc<ModelSwapCoordinator>,
    /// The WinSTT-owned STT backend (audit #14). Every WinSTT-specific load/decode/cloud step
    /// (catalog resolve+build, the unified ort engine decode + post-processing, the cloud
    /// round-trip, language/dictionary/filler from the picker store) is delegated here so this
    /// legacy core stops reaching sideways into `crate::winstt::*`, restoring the
    /// one-way dependency edge between the core and WinSTT feature modules.
    backend: Arc<dyn SttBackend>,
    /// Freshest realtime full-buffer decode, for the final-paste reuse fast path. The realtime
    /// worker writes it each tick (`cache_realtime_reuse`); the final path consumes it once on PTT
    /// release (`try_reuse_realtime`) to skip a redundant re-decode of audio the live engine
    /// already transcribed. `None` whenever live transcription is off or the recording changed.
    realtime_reuse: Arc<Mutex<Option<RealtimeReuse>>>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let runtime_settings = crate::winstt::settings_store::read_settings_raw(app_handle);
        let model_unload_timeout = crate::winstt::commands::settings::core_timeout_from_winstt(
            runtime_settings.global.model_unload_timeout,
        );
        let listen_mode_resident = runtime_settings.general.recording_mode == RecordingMode::Listen;
        let engine = Arc::new(Mutex::new(None));
        let shutdown_signal = Arc::new(AtomicBool::new(false));
        let idle_watcher_signal = Arc::new(IdleWatcherSignal::default());
        let warm_wait_signal = Arc::new(WarmWaitSignal::default());
        let lifecycle = Arc::new(TranscriptionManagerLifecycle {
            shutdown_signal,
            idle_watcher_signal: idle_watcher_signal.clone(),
            watcher_handle: Mutex::new(None),
            engine: engine.clone(),
            warm_wait_signal: warm_wait_signal.clone(),
        });
        let manager = Self {
            lifecycle,
            engine,
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            active_providers: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            model_unload_timeout_secs: Arc::new(AtomicU64::new(encode_stt_idle_unload_timeout(
                model_unload_timeout,
            ))),
            listen_mode_resident: Arc::new(AtomicBool::new(listen_mode_resident)),
            idle_watcher_signal,
            is_loading: Arc::new(Mutex::new(false)),
            loading_condvar: Arc::new(Condvar::new()),
            warming: Arc::new(AtomicBool::new(false)),
            warm_wait_signal,
            model_lifecycle: Arc::new(ModelSwapCoordinator::new()),
            backend: Arc::new(WinsttSttBackend),
            realtime_reuse: Arc::new(Mutex::new(None)),
        };

        // The watcher owns only weak lifecycle references, so it cannot keep the manager alive.
        // Every relevant state transition notifies its condvar; the only timeout is the exact
        // configured idle deadline.
        {
            let watcher = IdleWatcherContext {
                app_handle: app_handle.clone(),
                engine: Arc::downgrade(&manager.engine),
                current_model_id: Arc::downgrade(&manager.current_model_id),
                active_providers: Arc::downgrade(&manager.active_providers),
                last_activity: Arc::downgrade(&manager.last_activity),
                model_unload_timeout_secs: Arc::downgrade(&manager.model_unload_timeout_secs),
                listen_mode_resident: Arc::downgrade(&manager.listen_mode_resident),
                shutdown_signal: Arc::downgrade(&manager.lifecycle.shutdown_signal),
                is_loading: Arc::downgrade(&manager.is_loading),
                model_lifecycle: Arc::downgrade(&manager.model_lifecycle),
                signal: manager.idle_watcher_signal.clone(),
                warm_wait_signal: manager.warm_wait_signal.clone(),
            };
            let handle = thread::spawn(move || watcher.run());
            *manager.lifecycle.watcher_handle.lock_recover() = Some(handle);
        }

        Ok(manager)
    }

    /// Lock the engine mutex, recovering from poison if a previous transcription panicked.
    fn lock_engine(&self) -> EngineGuard<'_> {
        let guard = self.engine.lock().unwrap_or_else(|poisoned| {
            warn!("Engine mutex was poisoned by a previous panic, recovering");
            poisoned.into_inner()
        });
        EngineGuard {
            guard: Some(guard),
            warm_wait_signal: self.warm_wait_signal.clone(),
        }
    }

    /// Non-blocking engine acquisition for warm/realtime paths. A `None` result is paired with
    /// the current owner's [`EngineGuard`] release notification.
    fn try_lock_engine(&self) -> Option<EngineGuard<'_>> {
        let guard = match self.engine.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => return None,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                warn!("Engine mutex was poisoned by a previous panic, recovering");
                poisoned.into_inner()
            }
        };
        Some(EngineGuard {
            guard: Some(guard),
            warm_wait_signal: self.warm_wait_signal.clone(),
        })
    }

    pub(crate) fn observe_engine_lifecycle(&self) -> u64 {
        self.warm_wait_signal.observe()
    }

    pub(crate) fn wait_for_realtime_conditions_change(
        &self,
        observed: u64,
        timeout: Option<Duration>,
    ) {
        match timeout {
            Some(timeout) => {
                self.warm_wait_signal
                    .wait_for_change_after(observed, timeout);
            }
            None => self
                .warm_wait_signal
                .wait_for_change_after_blocking(observed),
        }
    }

    /// Wake the realtime worker when a non-engine predicate it shares with the
    /// engine lifecycle changes (window focus, settings, or recording state).
    /// The generation counter makes this a durable edge, so a change that lands
    /// just before the worker parks is still observed.
    pub(crate) fn notify_realtime_conditions_changed(&self) {
        self.warm_wait_signal.signal();
    }

    /// Lock the `is_loading` flag, recovering from poison — uniform with `lock_engine`
    /// so a panic on any sibling lock doesn't strand the load/swap state machine.
    fn lock_is_loading(&self) -> MutexGuard<'_, bool> {
        self.is_loading.lock().unwrap_or_else(|poisoned| {
            warn!("is_loading mutex was poisoned by a previous panic, recovering");
            poisoned.into_inner()
        })
    }

    /// Lock the `current_model_id` slot, recovering from poison — uniform with
    /// `lock_engine`.
    fn lock_current_model(&self) -> MutexGuard<'_, Option<String>> {
        self.current_model_id.lock().unwrap_or_else(|poisoned| {
            warn!("current_model_id mutex was poisoned by a previous panic, recovering");
            poisoned.into_inner()
        })
    }

    fn clear_warmed_model(&self) {
        self.model_lifecycle.clear_all_warm();
        self.warm_wait_signal.signal();
    }

    fn is_model_warm(&self, model_id: &str) -> bool {
        self.model_lifecycle.is_warm(model_id)
    }

    /// Authoritative warm-state read for command responses. Cloud models have no local kernel
    /// warmup and are ready as soon as their route is selected.
    pub fn is_model_warm_for(&self, model_id: &str) -> bool {
        self.backend.route_of(model_id) == BackendRoute::Cloud || self.is_model_warm(model_id)
    }

    fn mark_model_warmed_if_current(&self, model_id: &str) {
        if self.backend.route_of(model_id) == BackendRoute::Cloud || !self.is_model_loaded() {
            return;
        }
        let current = self.lock_current_model();
        if current.as_deref() == Some(model_id) {
            self.model_lifecycle.mark_warm(model_id);
            self.warm_wait_signal.signal();
        }
    }

    fn wait_for_loading_to_finish(&self) {
        let mut is_loading = self.lock_is_loading();
        while *is_loading {
            is_loading = self
                .loading_condvar
                .wait(is_loading)
                .unwrap_or_else(|poisoned| {
                    warn!("is_loading mutex poisoned while waiting; recovering");
                    poisoned.into_inner()
                });
        }
    }

    pub fn is_model_loaded(&self) -> bool {
        let engine = self.lock_engine();
        engine.is_some()
    }

    /// The loaded engine's actual ORT execution providers (e.g.
    /// `["CPUExecutionProvider"]` for a DML-incompatible model routed to CPU on a GPU box).
    /// `None` when no local engine is resident — callers fall back to the persisted-device
    /// derivation. Reads the install-time snapshot, NOT the engine mutex, so it never blocks
    /// behind an in-flight decode.
    pub fn active_engine_providers(&self) -> Option<Vec<String>> {
        if self.lock_current_model().is_none() {
            return None;
        }
        self.active_providers.lock_recover().clone()
    }

    /// Record (or clear) the resident engine's provider snapshot. Called by the load path at
    /// install and by `unload_model`.
    pub(crate) fn set_active_engine_providers(&self, providers: Option<Vec<String>>) {
        *self.active_providers.lock_recover() = providers;
    }

    /// Whether model weights are currently being resolved/built. Exposed to the
    /// runtime snapshot so renderers can distinguish a usable shell from a
    /// speech engine that is still coming online.
    pub fn is_model_loading(&self) -> bool {
        *self.lock_is_loading()
    }

    /// Whether the loaded engine is paying its one-time kernel warmup cost.
    /// Real dictation may preempt this work, but the UI should still describe
    /// the engine as preparing until the background warmup settles.
    pub fn is_model_warming(&self) -> bool {
        self.warming.load(Ordering::Acquire)
    }

    fn is_model_ready_for(&self, model_id: &str) -> bool {
        let current_matches = self.get_current_model().as_deref() == Some(model_id);
        match self.backend.route_of(model_id) {
            BackendRoute::Cloud => current_matches,
            BackendRoute::Catalog => current_matches && self.is_model_loaded(),
            BackendRoute::Unsupported => false,
        }
    }

    /// Reset the idle timer to now.
    fn touch_activity(&self) {
        self.idle_watcher_signal.update(|| {
            *self.last_activity.lock_recover() = Instant::now();
        });
    }

    /// Recording start/stop is a lifecycle callback for the idle deadline. Both edges count as
    /// activity; this keeps the model resident for the whole capture and starts a fresh deadline
    /// when capture finishes without making the watcher poll recording state.
    pub(crate) fn recording_activity_changed(&self) {
        self.touch_activity();
    }

    fn idle_unload_timeout_secs(&self) -> u64 {
        self.model_unload_timeout_secs.load(Ordering::Acquire)
    }

    pub(crate) fn update_runtime_policy(
        &self,
        timeout: ModelUnloadTimeout,
        listen_mode_resident: bool,
    ) {
        self.idle_watcher_signal.update(|| {
            self.model_unload_timeout_secs
                .store(encode_stt_idle_unload_timeout(timeout), Ordering::Release);
            let previous_listen_mode = self
                .listen_mode_resident
                .swap(listen_mode_resident, Ordering::AcqRel);
            if previous_listen_mode != listen_mode_resident {
                // Leaving Listen mode starts a new idle period instead of inheriting an
                // arbitrarily old timestamp; entering it also records the residency activity.
                *self.last_activity.lock_recover() = Instant::now();
            }
        });
    }

    pub(crate) fn listen_mode_forces_model_resident(&self) -> bool {
        self.listen_mode_resident.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    // NOTE: the WinSTT language-normalization unit test moved with `normalize_winstt_language` to
    // `crate::winstt::stt::backend` (audit #14). The source-level guard for the transcribe hot path
    // lives next to `transcribe()` in `decode.rs`.

    // ── silence gate: AC-energy floor separates speech from silence ─────────────
    // Real values logged by the app's `[silence-gate]` on this hardware: silence /
    // Whisper-hallucination clips ("Thank you.") measured rms ≤ 0.0014; real speech
    // recordings measured rms ≥ 0.0074. The 0.003 floor must reject the former and pass
    // the latter — regression guard for the "Thank you. on silence" bug.

    #[test]
    fn warm_wait_signal_wakes_on_release_edge() {
        let signal = std::sync::Arc::new(super::WarmWaitSignal::default());
        let observed = signal.observe();
        let publisher = signal.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            publisher.signal();
        });

        assert!(signal.wait_for_change_after(observed, std::time::Duration::from_secs(1)));
        thread.join().unwrap();
    }

    #[test]
    fn warm_wait_signal_preserves_edge_before_wait_begins() {
        let signal = super::WarmWaitSignal::default();
        let observed = signal.observe();
        signal.signal();

        assert!(signal.wait_for_change_after(observed, std::time::Duration::from_secs(1)));
    }

    #[test]
    fn device_lost_error_is_classified_but_degenerate_is_not() {
        // The exact suspended-GPU chain observed in the field (nemo-parakeet VAD-segment path).
        let suspended = anyhow::anyhow!(
            "WinSTT VAD-segment transcription failed: inference failed: encoder run: \
             ExecutionProvider.cpp(952) Exception(1065) 887A0005 The GPU device instance has \
             been suspended. Use GetDeviceRemovedReason to determine the appropriate action."
        );
        assert!(super::is_device_lost_error(&suspended));
        // Device loss must NOT be misread as a degenerate decode (different recovery: no CPU demotion).
        assert!(!super::is_degenerate_decode_error(&suspended));

        // A degenerate Whisper decode is the other fatal class — and is NOT a device-loss.
        let degenerate = anyhow::anyhow!("[whisper-garbage] degenerate Whisper decode detected");
        assert!(super::is_degenerate_decode_error(&degenerate));
        assert!(!super::is_device_lost_error(&degenerate));

        // An ordinary, recoverable decode error is neither — the engine is kept loaded.
        let ordinary = anyhow::anyhow!("inference failed: enc tensor: shape mismatch");
        assert!(!super::is_device_lost_error(&ordinary));
        assert!(!super::is_degenerate_decode_error(&ordinary));
    }

    #[test]
    fn dc_immune_rms_is_zero_on_constant_dc_offset() {
        // A dead Bluetooth/virtual mic emits a constant offset (no AC). Subtracting the
        // mean leaves zero residual → rms 0, well under the floor.
        let dead_mic = vec![0.5_f32; 4800];
        let rms = super::dc_immune_rms(&dead_mic);
        assert!(
            rms < 1e-6,
            "constant DC must read as ~0 AC energy, got {rms}"
        );
        assert!(rms < super::SILENCE_AC_FLOOR);
    }

    #[test]
    fn silence_floor_rejects_observed_silence_and_passes_observed_speech() {
        // Synthesize signals at the measured RMS levels (a sine carries rms = amp/√2).
        let synth = |target_rms: f32| -> Vec<f32> {
            let amp = target_rms * std::f32::consts::SQRT_2;
            (0..4800)
                .map(|i| amp * (i as f32 * 0.2).sin())
                .collect::<Vec<f32>>()
        };
        // Observed silence/hallucination levels → must be BELOW the floor.
        for &silent in &[0.000_043_f32, 0.001_381] {
            let rms = super::dc_immune_rms(&synth(silent));
            assert!(
                rms < super::SILENCE_AC_FLOOR,
                "silence rms {rms} must be rejected by floor {}",
                super::SILENCE_AC_FLOOR
            );
        }
        // Observed real-speech levels → must be ABOVE the floor (not clipped).
        for &speech in &[0.007_443_f32, 0.013_537, 0.025_773] {
            let rms = super::dc_immune_rms(&synth(speech));
            assert!(
                rms >= super::SILENCE_AC_FLOOR,
                "speech rms {rms} must pass floor {}",
                super::SILENCE_AC_FLOOR
            );
        }
    }

    #[test]
    fn native_stream_final_tail_appends_silence_pad_after_captured_audio() {
        let tail = vec![0.1_f32, -0.2, 0.3];
        let padded = super::native_stream_final_tail_with_silence(&tail);
        let expected_pad =
            super::NATIVE_STREAM_SAMPLE_RATE * super::NATIVE_STREAM_FINAL_SILENCE_PAD_MS / 1000;

        assert_eq!(&padded[..tail.len()], tail.as_slice());
        assert_eq!(padded.len(), tail.len() + expected_pad);
        assert!(padded[tail.len()..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn native_stream_final_tail_pads_only_the_shortfall() {
        let tail = vec![0.1_f32, -0.2, 0.3];
        let full =
            super::NATIVE_STREAM_SAMPLE_RATE * super::NATIVE_STREAM_FINAL_SILENCE_PAD_MS / 1000;
        // Capture already carried 500 ms of trailing silence → only the 1500 ms shortfall is added.
        let already = super::NATIVE_STREAM_SAMPLE_RATE * 500 / 1000;
        let padded = super::native_stream_final_tail_capped(&tail, already);
        assert_eq!(padded.len(), tail.len() + (full - already));
        // ≥ 2000 ms of captured silence → no pad at all.
        let over = super::native_stream_final_tail_capped(&tail, full + 10_000);
        assert_eq!(over.len(), tail.len());
        // Zero already-silent == the legacy full pad.
        assert_eq!(
            super::native_stream_final_tail_capped(&tail, 0).len(),
            tail.len() + full
        );
    }

    #[test]
    fn trailing_silence_from_mask_counts_tail_non_speech_frames() {
        let frame = crate::audio_toolkit::vad::VAD_FRAME_SAMPLES;
        // 3 trailing non-speech frames after a speech run.
        let mask = [true, true, false, false, false];
        assert_eq!(super::trailing_silence_samples_from_mask(&mask), 3 * frame);
        // Ends in speech → zero trailing silence.
        assert_eq!(super::trailing_silence_samples_from_mask(&[false, true]), 0);
        // All silence → every frame counts.
        assert_eq!(
            super::trailing_silence_samples_from_mask(&[false, false]),
            2 * frame
        );
        assert_eq!(super::trailing_silence_samples_from_mask(&[]), 0);
    }

    #[test]
    fn mask_gate_rejects_hallucination_band_and_dead_air_but_passes_real_speech() {
        let synth = |target_rms: f32| -> Vec<f32> {
            let amp = target_rms * std::f32::consts::SQRT_2;
            (0..4800)
                .map(|i| amp * (i as f32 * 0.2).sin())
                .collect::<Vec<f32>>()
        };
        // A hallucination-band clip (rms 0.0014 — the measured "Thank you." level, cf. the fixture
        // in `silence_floor_rejects_observed_silence_and_passes_observed_speech`) with speech frames
        // in the mask must be REJECTED on the mask path: Silero-at-0.3 false-fires speech frames onto
        // near-silent audio, so a speech-frame mask alone can't be trusted — the 0.003 floor still
        // gates it, exactly as on the no-mask path. A lower floor here would re-open this band and
        // paste hallucinated "Thank you." over what should be silence.
        let hallucination = synth(0.0014);
        let speech_mask = vec![true, true, true];
        assert!(super::is_silent_recording_with_mask(
            &hallucination,
            Some(&speech_mask)
        ));
        // …and WITHOUT a mask (file/cloud), the same clip is rejected by the 0.003 floor too.
        assert!(super::is_silent_recording_with_mask(&hallucination, None));

        // Genuine soft-but-real speech (rms 0.006, above the 0.003 floor) with speech frames PASSES.
        let real_speech = synth(0.006);
        assert!(!super::is_silent_recording_with_mask(
            &real_speech,
            Some(&[true, true, true])
        ));

        // Genuine dead-air below the floor is rejected even if a stray VAD frame is set.
        let dead_air = synth(0.00004);
        assert!(super::is_silent_recording_with_mask(
            &dead_air,
            Some(&[true])
        ));

        // A mask with no speech frames is rejected regardless of energy (all-noise, no speech).
        let loud = synth(0.02);
        assert!(super::is_silent_recording_with_mask(
            &loud,
            Some(&[false, false, false])
        ));
        // The same loud clip WITH a speech frame passes.
        assert!(!super::is_silent_recording_with_mask(&loud, Some(&[true])));

        // DC-dominated dead-mic is rejected on either path.
        let dc: Vec<f32> = vec![0.5; 4800];
        assert!(super::is_silent_recording_with_mask(&dc, Some(&[true])));
        assert!(super::is_silent_recording_with_mask(&dc, None));
    }

    #[test]
    fn mask_gate_keeps_soft_speaker_diluted_by_long_captured_silence() {
        // Capture is ungated: a long PTT hold with one soft word (~0.006 RMS over one frame) then
        // silence has a WHOLE-BUFFER RMS below the hard floor, yet the masked speech frame carries
        // real energy. Measuring energy over the SPEECH frames keeps the speaker from being dropped.
        let f = crate::audio_toolkit::vad::VAD_FRAME_SAMPLES;
        let amp = 0.006_f32 * std::f32::consts::SQRT_2;
        let mut audio: Vec<f32> = (0..f).map(|i| amp * (i as f32 * 0.3).sin()).collect();
        audio.resize(f * 201, 0.0); // 200 frames of trailing captured silence
        let mut mask = vec![false; 201];
        mask[0] = true;

        // Whole-buffer RMS is below the 0.003 floor — the no-mask (whole-buffer) gate would have
        // rejected this clip…
        let (_, whole_rms) = super::audio_energy_stats(&audio);
        assert!(
            whole_rms < super::SILENCE_AC_FLOOR,
            "diluted whole-buffer RMS should sit below the floor, got {whole_rms}"
        );
        // …but the speech-frame energy is well above it, so the mask path keeps the clip: measuring
        // the SAME 0.003 floor over the speech frames only is what saves the soft speaker.
        assert!(super::speech_masked_rms(&audio, &mask) >= super::SILENCE_AC_FLOOR);
        assert!(!super::is_silent_recording_with_mask(&audio, Some(&mask)));
    }
}
