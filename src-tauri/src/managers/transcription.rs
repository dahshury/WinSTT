use crate::managers::audio::AudioRecordingManager;
use crate::settings::ModelUnloadTimeout;
use crate::winstt::settings_schema::RecordingMode;
use crate::winstt::sync_ext::MutexExt;
use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
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
pub use accel::{apply_accelerator_settings, get_available_accelerators, AvailableAccelerators};

/// DC-immune RMS (AC energy): subtract the mean (constant offset) first so a dead
/// device's constant DC bias doesn't read as signal, then RMS the residual. Shared by
/// the batch silence gate AND the realtime worker so both reject windows with no
/// decodable speech energy — below this Whisper hallucinates phantom text ("Thank you.")
/// on the silence the Silero VAD (threshold 0.3) lets through.
pub(crate) fn dc_immune_rms(audio: &[f32]) -> f32 {
    let n = audio.len() as f32;
    if n == 0.0 {
        return 0.0;
    }
    let mean = audio.iter().copied().sum::<f32>() / n;
    (audio.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n).sqrt()
}

/// AC-energy floor separating real speech from silence / room-tone / Whisper-on-silence
/// hallucinations. Empirically (this repo's own recordings, logged via `[silence-gate]`):
/// real speech recordings measure RMS ≥ ~0.0074; silence + hallucinated "Thank you."
/// clips measure ≤ ~0.0014. 0.003 sits cleanly between, with headroom below the quietest
/// real speech for soft talkers / distant mics.
pub(crate) const SILENCE_AC_FLOOR: f32 = 0.003;

/// The DC offset must exceed the AC RMS by this factor to be classed "all offset, no audio"
/// (the dead/virtual-mic fingerprint that makes Whisper emit a wall of garbled text).
const DC_DOMINANCE_RATIO: f32 = 10.0;
const LOCAL_FINAL_DECODE_SILENCE_PAD_MS: usize = 700;
const NATIVE_STREAM_FINAL_SILENCE_PAD_MS: usize = 2000;
const NATIVE_STREAM_SAMPLE_RATE: usize = 16_000;

static TRANSCRIPTION_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_transcription_request_id() -> String {
    format!(
        "stt-{}",
        TRANSCRIPTION_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// True when a recording carries no decodable speech — either genuine silence/room-tone (AC RMS
/// below [`SILENCE_AC_FLOOR`]) or a DC-dominated dead/virtual-mic signal. Shared by the batch
/// silence gate AND the realtime-reuse guard (a reused live decode must NOT paste hallucinated
/// text over what the gate would otherwise have rejected). Audio is RAW (pre-`peak_normalize`).
pub(crate) fn is_silent_recording(audio: &[f32]) -> bool {
    if audio.is_empty() {
        return true;
    }
    let n = audio.len() as f32;
    let mean = audio.iter().copied().sum::<f32>() / n;
    let rms = dc_immune_rms(audio);
    let dc_dominated = mean.abs() > rms * DC_DOMINANCE_RATIO;
    rms < SILENCE_AC_FLOOR || dc_dominated
}

fn native_stream_final_tail_with_silence(tail: &[f32]) -> Vec<f32> {
    let pad_samples = NATIVE_STREAM_SAMPLE_RATE * NATIVE_STREAM_FINAL_SILENCE_PAD_MS / 1000;
    let mut padded = Vec::with_capacity(tail.len() + pad_samples);
    padded.extend_from_slice(tail);
    padded.resize(padded.len() + pad_samples, 0.0);
    padded
}

fn local_final_decode_audio_with_silence(audio: &[f32]) -> Vec<f32> {
    let pad_samples = NATIVE_STREAM_SAMPLE_RATE * LOCAL_FINAL_DECODE_SILENCE_PAD_MS / 1000;
    let mut padded = Vec::with_capacity(audio.len() + pad_samples);
    padded.extend_from_slice(audio);
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
/// RAII guard that clears the `is_loading` flag and notifies waiters on drop.
/// Ensures the loading flag is always reset, even on early returns or panics.
pub struct LoadingGuard {
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
}

impl Drop for LoadingGuard {
    fn drop(&mut self) {
        // Recover a poisoned lock so the loading flag is always cleared (uniform
        // with the manager's poison-recovery discipline); never panic in a Drop.
        let mut is_loading = self.is_loading.lock_recover();
        *is_loading = false;
        self.loading_condvar.notify_all();
    }
}

/// RAII guard that clears the `warming` flag on drop — so a post-swap warmup decode
/// always clears its in-progress marker, even on an early return or a caught panic.
struct WarmingGuard<'a>(&'a AtomicBool);

impl Drop for WarmingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

const WHISPER_GARBAGE_MARKER: &str = "[whisper-garbage]";
const STT_IDLE_UNLOAD_NEVER_SECS: u64 = u64::MAX;

fn encode_stt_idle_unload_timeout(timeout: ModelUnloadTimeout) -> u64 {
    timeout.to_seconds().unwrap_or(STT_IDLE_UNLOAD_NEVER_SECS)
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

#[derive(Clone)]
pub struct TranscriptionManager {
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<AtomicU64>,
    model_unload_timeout_secs: Arc<AtomicU64>,
    listen_mode_resident: Arc<AtomicBool>,
    shutdown_signal: Arc<AtomicBool>,
    watcher_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
    /// True while a post-swap kernel WARMUP decode is running. Distinct from `is_loading`
    /// (which gates real loads): a real decode does NOT wait on `warming`, so the user's
    /// dictation can preempt a cold warmup instead of being serialized behind it. A racing
    /// `transcribe()` simply wins the engine mutex; warmup `try_lock`s and yields when the
    /// engine is busy.
    warming: Arc<AtomicBool>,
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
        let manager = Self {
            engine: Arc::new(Mutex::new(None)),
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(AtomicU64::new(Self::now_ms())),
            model_unload_timeout_secs: Arc::new(AtomicU64::new(encode_stt_idle_unload_timeout(
                model_unload_timeout,
            ))),
            listen_mode_resident: Arc::new(AtomicBool::new(listen_mode_resident)),
            shutdown_signal: Arc::new(AtomicBool::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            is_loading: Arc::new(Mutex::new(false)),
            loading_condvar: Arc::new(Condvar::new()),
            warming: Arc::new(AtomicBool::new(false)),
            model_lifecycle: Arc::new(ModelSwapCoordinator::new()),
            backend: Arc::new(WinsttSttBackend),
            realtime_reuse: Arc::new(Mutex::new(None)),
        };

        // Start the idle watcher
        {
            let app_handle_cloned = app_handle.clone();
            let manager_cloned = manager.clone();
            let shutdown_signal = manager.shutdown_signal.clone();
            let handle = thread::spawn(move || {
                debug!("Idle watcher thread started");
                while !shutdown_signal.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(10)); // Check every 10 seconds

                    // Check shutdown signal again after sleep
                    if shutdown_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    if manager_cloned.listen_mode_forces_model_resident() {
                        manager_cloned.touch_activity();
                        continue;
                    }

                    // Skip Immediately — that variant is handled by
                    // maybe_unload_immediately() after each transcription.
                    // Treating it as 0s here would unload the model mid-recording.
                    let timeout_secs = manager_cloned.idle_unload_timeout_secs();
                    if timeout_secs == 0 {
                        continue;
                    }

                    // While recording, keep the idle timer fresh so the
                    // model is never unloaded mid-session.
                    let is_recording = app_handle_cloned
                        .try_state::<Arc<AudioRecordingManager>>()
                        .is_some_and(|a| a.is_recording());
                    if is_recording {
                        manager_cloned.touch_activity();
                        continue;
                    }

                    if timeout_secs != STT_IDLE_UNLOAD_NEVER_SECS {
                        let last = manager_cloned.last_activity.load(Ordering::Relaxed);
                        let now_ms = TranscriptionManager::now_ms();
                        let idle_ms = now_ms.saturating_sub(last);
                        let limit_ms = timeout_secs * 1000;

                        if idle_ms > limit_ms {
                            // idle -> unload
                            if manager_cloned.is_model_loaded() {
                                let unload_start = std::time::Instant::now();
                                info!(
                                    "Model idle for {}s (limit: {}s), unloading",
                                    idle_ms / 1000,
                                    timeout_secs
                                );
                                match manager_cloned.unload_model() {
                                    Ok(()) => {
                                        let unload_duration = unload_start.elapsed();
                                        info!(
                                            "Model unloaded due to inactivity (took {}ms)",
                                            unload_duration.as_millis()
                                        );
                                    }
                                    Err(e) => {
                                        error!("Failed to unload idle model: {}", e);
                                    }
                                }
                            }
                        }
                    }
                }
                debug!("Idle watcher thread shutting down gracefully");
            });
            *manager.watcher_handle.lock_recover() = Some(handle);
        }

        Ok(manager)
    }

    /// Lock the engine mutex, recovering from poison if a previous transcription panicked.
    fn lock_engine(&self) -> MutexGuard<'_, Option<LoadedEngine>> {
        self.engine.lock().unwrap_or_else(|poisoned| {
            warn!("Engine mutex was poisoned by a previous panic, recovering");
            poisoned.into_inner()
        })
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
    }

    fn is_model_warm(&self, model_id: &str) -> bool {
        self.model_lifecycle.is_warm(model_id)
    }

    fn mark_model_warmed_if_current(&self, model_id: &str) {
        if self.backend.route_of(model_id) == BackendRoute::Cloud || !self.is_model_loaded() {
            return;
        }
        let current = self.lock_current_model();
        if current.as_deref() == Some(model_id) {
            self.model_lifecycle.mark_warm(model_id);
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

    fn is_model_ready_for(&self, model_id: &str) -> bool {
        let current_matches = self.get_current_model().as_deref() == Some(model_id);
        match self.backend.route_of(model_id) {
            BackendRoute::Cloud => current_matches,
            BackendRoute::Catalog => current_matches && self.is_model_loaded(),
            BackendRoute::Unsupported => false,
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Reset the idle timer to now.
    fn touch_activity(&self) {
        self.last_activity.store(Self::now_ms(), Ordering::Relaxed);
    }

    fn idle_unload_timeout_secs(&self) -> u64 {
        self.model_unload_timeout_secs.load(Ordering::Acquire)
    }

    pub(crate) fn update_runtime_policy(
        &self,
        timeout: ModelUnloadTimeout,
        listen_mode_resident: bool,
    ) {
        self.model_unload_timeout_secs
            .store(encode_stt_idle_unload_timeout(timeout), Ordering::Release);
        self.listen_mode_resident
            .store(listen_mode_resident, Ordering::Release);
    }

    pub(crate) fn listen_mode_forces_model_resident(&self) -> bool {
        self.listen_mode_resident.load(Ordering::Acquire)
    }
}

impl Drop for TranscriptionManager {
    fn drop(&mut self) {
        // Skip shutdown unless this is the very last clone. TranscriptionManager
        // is cloned by initiate_model_load() and the watcher thread — those
        // clones dropping must not kill the watcher. The watcher thread holds
        // its own clone, so engine's strong_count is always >= 2 while the
        // watcher is alive. When it reaches 1, only this instance remains
        // and we can safely shut down.
        if Arc::strong_count(&self.engine) > 1 {
            return;
        }

        // Signal the watcher thread to shutdown
        self.shutdown_signal.store(true, Ordering::Relaxed);

        // Wait for the thread to finish gracefully
        if let Some(handle) = self.watcher_handle.lock_recover().take() {
            if let Err(e) = handle.join() {
                warn!("Failed to join idle watcher thread: {:?}", e);
            } else {
                debug!("Idle watcher thread joined successfully");
            }
        }

        let mut engine = {
            let mut guard = self.lock_engine();
            guard.take()
        };
        if let Some(engine) = engine.as_mut() {
            engine.shutdown();
        }
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
    fn local_final_decode_audio_appends_silence_pad_after_captured_audio() {
        let audio = vec![0.4_f32, -0.1, 0.2];
        let padded = super::local_final_decode_audio_with_silence(&audio);
        let expected_pad =
            super::NATIVE_STREAM_SAMPLE_RATE * super::LOCAL_FINAL_DECODE_SILENCE_PAD_MS / 1000;

        assert_eq!(&padded[..audio.len()], audio.as_slice());
        assert_eq!(padded.len(), audio.len() + expected_pad);
        assert!(padded[audio.len()..].iter().all(|sample| *sample == 0.0));
    }
}
