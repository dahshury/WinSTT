use crate::managers::audio::AudioRecordingManager;
use crate::managers::model::{EngineType, ModelManager};
use crate::settings::{
    get_settings, ModelUnloadTimeout, OrtAcceleratorSetting, WhisperAcceleratorSetting,
};
use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use specta::Type;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
// The ONLY `crate::winstt::*` symbols this inherited Handy core names (audit #14): the engine
// type (`Transcriber`) the `LoadedEngine::Winstt` arm boxes, and the backend trait surface the
// core delegates every WinSTT-specific step to. All WinSTT logic lives behind `SttBackend`.
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::stt::{
    BackendRoute, SttBackend, SttResult, Transcriber as WinsttTranscriber, WinsttSttBackend,
};
use transcribe_rs::{
    onnx::{
        canary::CanaryModel,
        cohere::CohereModel,
        gigaam::GigaAMModel,
        moonshine::{MoonshineModel, MoonshineVariant, StreamingModel},
        parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity},
        sense_voice::{SenseVoiceModel, SenseVoiceParams},
        Quantization,
    },
    whisper_cpp::{WhisperEngine, WhisperInferenceParams},
    SpeechModel, TranscribeOptions,
};

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

fn generic_realtime_language(language: &str) -> Option<String> {
    let trimmed = language.trim();
    if trimmed.is_empty() || trimmed == "auto" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn transcribe_rs_language(language: &str) -> Option<String> {
    generic_realtime_language(language).map(|normalized| {
        if normalized == "zh-Hans" || normalized == "zh-Hant" {
            "zh".to_string()
        } else {
            normalized
        }
    })
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

fn sense_voice_realtime_language(language: &str) -> Option<String> {
    match language.trim() {
        "zh" | "zh-Hans" | "zh-Hant" => Some("zh".to_string()),
        "en" => Some("en".to_string()),
        "ja" => Some("ja".to_string()),
        "ko" => Some("ko".to_string()),
        "yue" => Some("yue".to_string()),
        _ => None,
    }
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
    Whisper(WhisperEngine),
    Parakeet(ParakeetModel),
    Moonshine(MoonshineModel),
    MoonshineStreaming(StreamingModel),
    SenseVoice(SenseVoiceModel),
    GigaAM(GigaAMModel),
    Canary(CanaryModel),
    Cohere(CohereModel),
    /// WinSTT unified ort-ONNX engine — whisper / lite-whisper / distil / crisper (and, as
    /// `stt::families` lands, the remaining families). The ONLY path that loads WinSTT's exact
    /// ONNX exports + lite-whisper (transcribe-rs's Whisper is GGML and cannot). Proven via the
    /// STT spike (`src/bin/stt_spike.rs`; see project memory). `Box<dyn Transcriber>` is `Send`.
    Winstt(Box<dyn WinsttTranscriber>),
}

impl LoadedEngine {
    fn shutdown(&mut self) {
        match self {
            LoadedEngine::Winstt(engine) => engine.shutdown(),
            _ => {}
        }
    }
}

/// What a single decode produced inside the panic-guarded closure. The transcribe-rs (GGML)
/// arms return a `Raw` `TranscriptionResult` that the core still post-processes (custom words +
/// filler). The WinSTT arm's decode is owned by [`crate::winstt::stt::SttBackend::decode`], which
/// ALSO does the WinSTT-arm post-processing — so it returns a `Final` string the core must NOT
/// post-process again (avoids double-processing; audit #14 risk 3).
enum TranscribeOutcome {
    /// transcribe-rs arm — core applies its generic custom-words + filler post-processing.
    Raw(transcribe_rs::TranscriptionResult),
    /// WinSTT arm — already fully post-processed by the backend; pass through verbatim.
    Final(String),
}

// The WinSTT-specific helpers `engine_kind_for`, `normalize_winstt_language`,
// and `peak_normalize` used to live HERE in the inherited Handy core. They were moved into
// `crate::winstt::stt::backend` (audit #14) — the core now reaches them only through the
// `SttBackend` trait, restoring the one-way dependency edge (winstt → core, never the reverse).

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
        let mut is_loading = self
            .is_loading
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

fn is_degenerate_decode_error(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains(WHISPER_GARBAGE_MARKER) || msg.contains("degenerate Whisper decode")
}

#[derive(Clone)]
pub struct TranscriptionManager {
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    model_manager: Arc<ModelManager>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<AtomicU64>,
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
    /// inherited Handy core stops reaching sideways into `crate::winstt::*` — restoring the
    /// one-way dependency edge that keeps upstream Handy merges of this file tractable.
    backend: Arc<dyn SttBackend>,
    /// Freshest realtime full-buffer decode, for the final-paste reuse fast path. The realtime
    /// worker writes it each tick (`cache_realtime_reuse`); the final path consumes it once on PTT
    /// release (`try_reuse_realtime`) to skip a redundant re-decode of audio the live engine
    /// already transcribed. `None` whenever live transcription is off or the recording changed.
    realtime_reuse: Arc<Mutex<Option<RealtimeReuse>>>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle, model_manager: Arc<ModelManager>) -> Result<Self> {
        let manager = Self {
            engine: Arc::new(Mutex::new(None)),
            model_manager,
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(AtomicU64::new(Self::now_ms())),
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

                    let settings = get_settings(&app_handle_cloned);
                    let timeout = settings.model_unload_timeout;

                    // Skip Immediately — that variant is handled by
                    // maybe_unload_immediately() after each transcription.
                    // Treating it as 0s here would unload the model mid-recording.
                    if timeout == ModelUnloadTimeout::Immediately {
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

                    if let Some(limit_seconds) = timeout.to_seconds() {
                        let last = manager_cloned.last_activity.load(Ordering::Relaxed);
                        let now_ms = TranscriptionManager::now_ms();
                        let idle_ms = now_ms.saturating_sub(last);
                        let limit_ms = limit_seconds * 1000;

                        if idle_ms > limit_ms {
                            // idle -> unload
                            if manager_cloned.is_model_loaded() {
                                let unload_start = std::time::Instant::now();
                                info!(
                                    "Model idle for {}s (limit: {}s), unloading",
                                    idle_ms / 1000,
                                    limit_seconds
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
            *manager.watcher_handle.lock().unwrap() = Some(handle);
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
            BackendRoute::Catalog | BackendRoute::None => current_matches && self.is_model_loaded(),
        }
    }

    fn spawn_warmup_if_needed(&self, model_id: &str) {
        if self.backend.route_of(model_id) == BackendRoute::Cloud || self.is_model_warm(model_id) {
            return;
        }
        let me = self.clone();
        thread::spawn(move || me.warmup());
    }

    /// Atomically check whether a model load is in progress and, if not, mark
    /// one as starting. Returns a [`LoadingGuard`] whose [`Drop`] impl will
    /// clear the flag and wake waiters. Returns `None` if a load is already in
    /// progress.
    pub fn try_start_loading(&self) -> Option<LoadingGuard> {
        let mut is_loading = self.lock_is_loading();
        if *is_loading {
            return None;
        }
        *is_loading = true;
        Some(LoadingGuard {
            is_loading: self.is_loading.clone(),
            loading_condvar: self.loading_condvar.clone(),
        })
    }

    pub fn unload_model(&self) -> Result<()> {
        let unload_start = std::time::Instant::now();
        debug!("Starting to unload model");

        let mut old_engine = {
            let mut engine = self.lock_engine();
            engine.take()
        };
        if let Some(engine) = old_engine.as_mut() {
            engine.shutdown();
        }
        {
            let mut current_model = self.lock_current_model();
            *current_model = None;
        }
        self.clear_warmed_model();

        // Emit unloaded event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );

        let unload_duration = unload_start.elapsed();
        debug!(
            "Model unloaded manually (took {}ms)",
            unload_duration.as_millis()
        );
        Ok(())
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

    /// Unloads the model immediately if the setting is enabled and the model is loaded
    pub fn maybe_unload_immediately(&self, context: &str) {
        let settings = get_settings(&self.app_handle);
        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately
            && self.is_model_loaded()
        {
            info!("Immediately unloading model after {}", context);
            if let Err(e) = self.unload_model() {
                warn!("Failed to immediately unload model: {}", e);
            }
        }
    }

    pub fn load_model(&self, model_id: &str) -> Result<()> {
        let load_start = std::time::Instant::now();
        debug!("Starting to load model: {}", model_id);

        // Emit loading started event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: None,
                error: None,
            },
        );

        let model_info = self
            .model_manager
            .get_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        if !model_info.is_downloaded {
            let error_msg = "Model not downloaded";
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: Some(error_msg.to_string()),
                },
            );
            return Err(anyhow::anyhow!(error_msg));
        }

        let model_path = self.model_manager.get_model_path(model_id)?;

        // Create appropriate engine based on model type
        let emit_loading_failed = |error_msg: &str| {
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: Some(error_msg.to_string()),
                },
            );
        };

        // If a WinSTT ORT engine is resident, free its sessions before the legacy loader builds
        // another local engine. The WinSTT catalog path already does this after offline resolve;
        // this keeps the fallback Handy path from overlapping DirectML/ORT sessions.
        let old_engine = {
            let mut engine = self.lock_engine();
            if matches!(engine.as_ref(), Some(LoadedEngine::Winstt(_))) {
                engine.take()
            } else {
                None
            }
        };
        if let Some(mut engine) = old_engine {
            info!(
                "[stt] shutting down resident WinSTT engine before loading legacy model '{model_id}'"
            );
            engine.shutdown();
            {
                let mut current_model = self.lock_current_model();
                *current_model = None;
            }
            self.clear_warmed_model();
        }

        let loaded_engine = match model_info.engine_type {
            EngineType::Whisper => {
                let engine = WhisperEngine::load(&model_path).map_err(|e| {
                    let error_msg = format!("Failed to load whisper model {}: {}", model_id, e);
                    emit_loading_failed(&error_msg);
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Whisper(engine)
            }
            EngineType::Parakeet => {
                let engine =
                    ParakeetModel::load(&model_path, &Quantization::Int8).map_err(|e| {
                        let error_msg =
                            format!("Failed to load parakeet model {}: {}", model_id, e);
                        emit_loading_failed(&error_msg);
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::Parakeet(engine)
            }
            EngineType::Moonshine => {
                let engine = MoonshineModel::load(
                    &model_path,
                    MoonshineVariant::Base,
                    &Quantization::default(),
                )
                .map_err(|e| {
                    let error_msg = format!("Failed to load moonshine model {}: {}", model_id, e);
                    emit_loading_failed(&error_msg);
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Moonshine(engine)
            }
            EngineType::MoonshineStreaming => {
                let engine = StreamingModel::load(&model_path, 0, &Quantization::default())
                    .map_err(|e| {
                        let error_msg = format!(
                            "Failed to load moonshine streaming model {}: {}",
                            model_id, e
                        );
                        emit_loading_failed(&error_msg);
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::MoonshineStreaming(engine)
            }
            EngineType::SenseVoice => {
                let engine =
                    SenseVoiceModel::load(&model_path, &Quantization::Int8).map_err(|e| {
                        let error_msg =
                            format!("Failed to load SenseVoice model {}: {}", model_id, e);
                        emit_loading_failed(&error_msg);
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::SenseVoice(engine)
            }
            EngineType::GigaAM => {
                let engine = GigaAMModel::load(&model_path, &Quantization::Int8).map_err(|e| {
                    let error_msg = format!("Failed to load gigaam model {}: {}", model_id, e);
                    emit_loading_failed(&error_msg);
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::GigaAM(engine)
            }
            EngineType::Canary => {
                let engine = CanaryModel::load(&model_path, &Quantization::Int8).map_err(|e| {
                    let error_msg = format!("Failed to load canary model {}: {}", model_id, e);
                    emit_loading_failed(&error_msg);
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Canary(engine)
            }
            EngineType::Cohere => {
                let engine = CohereModel::load(&model_path, &Quantization::Int8).map_err(|e| {
                    let error_msg = format!("Failed to load cohere model {}: {}", model_id, e);
                    emit_loading_failed(&error_msg);
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Cohere(engine)
            }
        };

        // Update the current engine and model ID. A new engine starts cold even when the id is the
        // same (same-model quant/device reload), so invalidate the warm marker only after the
        // replacement engine has been built successfully.
        self.clear_warmed_model();
        let mut old_engine = {
            let mut engine = self.lock_engine();
            engine.replace(loaded_engine)
        };
        if let Some(engine) = old_engine.as_mut() {
            engine.shutdown();
        }
        {
            let mut current_model = self.lock_current_model();
            *current_model = Some(model_id.to_string());
        }

        // Reset idle timer so the watcher doesn't immediately unload a just-loaded model
        self.touch_activity();

        // Emit loading completed event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(model_info.name.clone()),
                error: None,
            },
        );

        let load_duration = load_start.elapsed();
        debug!(
            "Successfully loaded transcription model: {} (took {}ms)",
            model_id,
            load_duration.as_millis()
        );
        Ok(())
    }

    /// The model the user actually selected. The WinSTT picker (`winstt_settings.model.model`)
    /// is the source of truth; fall back to Handy's `selected_model` (cloud ids / first-run).
    fn desired_model_id(&self) -> String {
        let winstt = self.backend.selected_model_id(&self.app_handle);
        if !winstt.trim().is_empty() {
            winstt
        } else {
            get_settings(&self.app_handle).selected_model
        }
    }

    /// Reconcile the loaded engine to the user's selected model. Loads it if nothing is loaded
    /// OR swaps if a *different* model is loaded (the previous early-return-if-loaded blocked
    /// model switching). WinSTT-catalog ids load through the unified ort engine
    /// (`load_winstt_model`); anything else falls back to Handy's transcribe-rs `load_model`.
    pub fn initiate_model_load(&self) {
        // Cheap pre-check WITHOUT claiming the loading flag: nothing to do if we're already on
        // the selected model. (try_start_loading below is the real, atomic gate.)
        let desired = self.desired_model_id();
        if self.is_model_loaded() && self.get_current_model().as_deref() == Some(desired.as_str()) {
            return; // already on the selected model
        }
        // PANIC-SAFE claim of the loading flag. The `LoadingGuard` is MOVED into the worker
        // thread so its Drop clears `is_loading` + wakes condvar waiters on EVERY exit of the
        // thread — including a panic in `dispatch_load`. (See `load_model_blocking` for why a
        // stuck `is_loading` permanently wedges the PTT pipeline.)
        let guard = match self.try_start_loading() {
            Some(g) => g,
            None => return, // a load is already in flight; it picks up the latest selection
        };
        let self_clone = self.clone();
        thread::spawn(move || {
            let _guard = guard; // RAII: clears is_loading + notifies on return OR panic.
            let desired = self_clone.desired_model_id();
            // Failure-atomic: dispatch_load does NOT unload up front — a failed resolve/build
            // leaves the previous engine resident (re-emitting loading_completed for it). Wrap in
            // catch_unwind so a build panic can't escape and abort the thread before the guard's
            // Drop runs (it would still run on unwind, but this keeps the log clean + explicit).
            let _ = catch_unwind(AssertUnwindSafe(|| {
                if let Err(e) = self_clone.dispatch_load(&desired, None) {
                    error!("Failed to load model '{}': {}", desired, e);
                }
            }));
        });
    }

    /// Dispatch a load to the right backend by id namespace, FAILURE-ATOMICALLY: never unload the
    /// currently-resident engine up front. Cloud ids have no local engine (mark current + free any
    /// local engine, since the switch to cloud can't fail). WinSTT-catalog ids go through
    /// `load_winstt_model`, which resolves the file set OFFLINE first and only unloads the old
    /// engine once that succeeds (the Windows DLL race forbids two live ort sessions). transcribe-rs
    /// ids go through `load_model`, which builds-then-installs (overwriting the old engine) — GGML,
    /// no session race. On any error, the previously-loaded model is still resident, so we re-emit
    /// `loading_completed` for it so the picker chip clears on a model the user can still dictate with.
    fn dispatch_load(&self, model_id: &str, quantization_override: Option<&str>) -> Result<()> {
        // Snapshot the still-resident model BEFORE attempting the swap, for the rollback re-emit.
        let previous = self.get_current_model();

        let result = match self.backend.route_of(model_id) {
            BackendRoute::Cloud => {
                // Cloud STT id (provider:model): no local engine. Free any resident local engine
                // and mark the cloud id current + ready so transcribe() routes to the backend's
                // cloud method.
                if self.is_model_loaded() {
                    let _ = self.unload_model();
                }
                {
                    let mut current = self.lock_current_model();
                    *current = Some(model_id.to_string());
                }
                self.touch_activity();
                Ok(())
            }
            BackendRoute::Catalog => self.load_winstt_model(model_id, quantization_override),
            BackendRoute::None => self.load_model(model_id),
        };

        if result.is_err() {
            self.reemit_resident_after_failed_swap(previous.as_deref());
        }
        result
    }

    /// After a FAILED swap, re-emit `loading_completed` for the model still resident (if any) so
    /// the renderer's picker clears its "Switching…" chip on a model the user can still dictate
    /// with — rather than being stuck on the failed target. No-op when nothing is loaded.
    fn reemit_resident_after_failed_swap(&self, previous: Option<&str>) {
        if !self.is_model_loaded() {
            return; // genuinely nothing resident (e.g. cold first-load failure)
        }
        let model_id = match self
            .get_current_model()
            .or_else(|| previous.map(str::to_string))
        {
            Some(id) => id,
            None => return,
        };
        // Best-effort display name (catalog → display, else the raw id).
        let model_name = self.backend.display_name_for(&model_id);
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id),
                model_name: Some(model_name),
                error: None,
            },
        );
    }

    /// Synchronous load to a SPECIFIC `model_id` (the picker's choice, threaded through from
    /// `set_winstt_model` → `perform_model_swap`) that RETURNS the real load error so the swap
    /// orchestrator can emit `stt:model-swap-failed` (rollback + toast) instead of swallowing it.
    /// Mirrors Handy's `switch_active_model(model_id)` + the body of `initiate_model_load`, but
    /// blocking and id-EXPLICIT — it must NOT re-read settings (the renderer's persist of
    /// `model.model` is debounced, so a re-read would load the stale/default "tiny" and "succeed").
    /// Runs on the swap orchestrator's own thread, so it never blocks the Tauri command thread.
    pub fn load_model_blocking(&self, model_id: &str) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, false, None)
    }

    pub fn load_model_blocking_with_quantization(
        &self,
        model_id: &str,
        quantization_override: Option<&str>,
    ) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, false, quantization_override)
    }

    /// Same as [`Self::load_model_blocking`], but intentionally rebuilds even when `model_id` is
    /// already current. Used for same-model load-input changes such as quantization/device swaps.
    pub fn reload_model_blocking(&self, model_id: &str) -> std::result::Result<(), String> {
        self.load_model_blocking_inner(model_id, true, None)
    }

    fn load_model_blocking_inner(
        &self,
        model_id: &str,
        force_reload: bool,
        quantization_override: Option<&str>,
    ) -> std::result::Result<(), String> {
        let model_id = model_id.trim();
        if model_id.is_empty() {
            return Err("model id is empty".to_string());
        }

        loop {
            if !force_reload && self.is_model_ready_for(model_id) {
                self.spawn_warmup_if_needed(model_id);
                return Ok(());
            }

            // PANIC-SAFE: claim the loading flag through the RAII `LoadingGuard`. Its Drop clears
            // `is_loading` and wakes any `transcribe()` blocked on the load condvar on EVERY exit —
            // normal return, early return, OR a panic in `dispatch_load`.
            let guard = match self.try_start_loading() {
                Some(g) => g,
                None => {
                    // Another swap/warm path is already doing the expensive work. Wait for it
                    // instead of returning a false "already loading" failure; if it loaded our
                    // target, reuse the warmed/loaded engine, otherwise claim the slot and try.
                    self.wait_for_loading_to_finish();
                    continue;
                }
            };

            // FAILURE-ATOMIC: dispatch_load never unloads the resident engine up front — a failed
            // resolve/build leaves the previous model dictatable (and re-emits loading_completed),
            // instead of the old unload-first path that left NOTHING loaded on a network blip.
            // catch_unwind turns a build panic into an Err so the swap orchestrator can emit
            // `model-swap-failed` (rollback + toast) instead of the worker thread dying silently.
            let outcome: Result<()> = match catch_unwind(AssertUnwindSafe(|| {
                self.dispatch_load(model_id, quantization_override)
            })) {
                Ok(r) => r,
                Err(_) => Err(anyhow::anyhow!(
                    "model load panicked while building the engine"
                )),
            };
            // Clear `is_loading` (and wake waiters) BEFORE spawning the warmup so the warm decode's
            // own load-condvar wait passes immediately instead of blocking on our own guard.
            drop(guard);
            // Warm the freshly-loaded engine so the first post-swap decode isn't cold (DML kernel
            // JIT), but detach it so the swap completes on LOAD. The warm-state guard makes this
            // idempotent when settings/save and explicit swap paths both request warmup.
            if outcome.is_ok() {
                self.spawn_warmup_if_needed(model_id);
            }
            return outcome.map_err(|e| {
                error!("Failed to load model '{model_id}': {e}");
                e.to_string()
            });
        }
    }

    /// Eagerly compile the loaded engine's kernels with a dummy 1s-silence decode so the FIRST
    /// real PTT decode is WARM — no cold DirectML kernel JIT serialized on the release path (the
    /// dominant cause of the port feeling ~10x slower than the reference on the first dictation). Mirrors
    /// the reference server's `RecorderService.warmup` (decodes `np.zeros(16000)` at boot). Only the
    /// WinSTT ort/DirectML engine pays cold-JIT; the transcribe-rs (GGML) engines don't, so we warm
    /// just that arm. Best-effort: a warmup failure must never break dictation.
    pub fn warmup(&self) {
        // Wait out any in-flight LOAD (we must not warm a half-built engine), but do NOT hold
        // `is_loading` for the warm decode — that was the bug: a real dictation that raced in
        // WAITED on transcribe()'s loading condvar even though the engine was fully loaded and
        // ready, serializing the user's decode behind a cold ~1s warmup. Instead we only set the
        // separate `warming` flag and yield the engine to any real decode via `try_lock`.
        self.wait_for_loading_to_finish();
        let Some(model_id) = self.get_current_model() else {
            return;
        };
        if self.is_model_warm(&model_id) {
            debug!("[stt] warmup skipped — model '{model_id}' is already warm");
            return;
        }
        if !self.is_model_loaded() {
            return; // cloud id, or load failed — nothing local to warm
        }

        if self
            .warming
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            debug!("[stt] warmup skipped — another warmup is already running");
            return;
        }
        // Clear `warming` on EVERY exit path (early return / panic) via RAII.
        let warming_guard = WarmingGuard(&self.warming);

        // PREEMPTABLE: grab the engine with `try_lock`, NOT a blocking `lock()`. If a real
        // transcribe() already holds it, the warmup yields (the user's decode IS the warmup) —
        // it never blocks the dictation path. Hold the lock for the dummy decode itself; a real
        // decode that arrives after we grab the lock waits only on the engine mutex (not the
        // load condvar), and there's nothing to gain by warming twice.
        let mut engine_guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => {
                debug!("[stt] warmup yielded — a real decode is using the engine");
                return;
            }
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        };
        // Decode dummy silence DIRECTLY (the backend's warmup bypasses the RMS silence-gate that
        // would reject all-zeros). Keep the engine IN the guard — a panic is caught and the engine
        // is left resident (matching transcribe()'s catch_unwind discipline; only differs in that
        // we don't take() it out). The WinSTT-specific dummy-decode body lives in the backend
        // (audit #14); this core owns only the `try_lock` preemption + `catch_unwind`.
        let warmup_result: std::result::Result<(), anyhow::Error> =
            if let Some(LoadedEngine::Winstt(e)) = engine_guard.as_mut() {
                let backend = self.backend.clone();
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    backend.warmup(e.as_mut())
                })) {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("WinSTT warmup panicked")),
                }
            } else if engine_guard.is_some() {
                // The legacy transcribe-rs arms do not need an explicit kernel warmup, so consider
                // their resident engine warm for scheduling purposes.
                Ok(())
            } else {
                Ok(())
            };
        drop(engine_guard);

        if let Err(err) = warmup_result {
            let degenerate = is_degenerate_decode_error(&err);
            warn!("[stt] engine warmup failed for '{model_id}': {err}");
            if degenerate {
                warn!(
                    "[stt] recycling '{model_id}' after DirectML degenerate decode during warmup"
                );
                drop(warming_guard);
                if let Err(reload_err) = self.load_model_blocking_inner(&model_id, true, None) {
                    error!(
                        "[stt] CPU fallback reload failed for '{model_id}' after degenerate warmup: {reload_err}"
                    );
                }
            }
            return;
        }

        self.mark_model_warmed_if_current(&model_id);
        self.touch_activity();
        log::info!("[stt] engine warmup complete for '{model_id}'");
    }

    /// Load a WinSTT-catalog model through the unified ort-ONNX engine (the proven STT spike
    /// path). The WinSTT-specific work — catalog resolution, effective-quant + provider-list
    /// policy, the offline HF file-set resolve, and the engine build — is owned by the
    /// [`SttBackend`] (audit #14). This core keeps ONLY the generic engine-lifecycle
    /// orchestration: the `model-state-changed` events, the failure-atomic unload-AFTER-resolve
    /// ordering (no two live ORT sessions), and installing the built engine into the mutex.
    ///
    /// TWO-PHASE (failure-atomic): `resolve_catalog` resolves the file set OFFLINE without
    /// building any ORT session or touching the resident engine. ONLY once that succeeds do we
    /// free the old engine (the Windows DLL race forbids two live ort sessions) and `build_resolved`
    /// the new one. A failed resolve returns `Err` with the old engine STILL RESIDENT — the caller
    /// re-emits `loading_completed` for it so the picker chip clears on a model the user can still
    /// dictate with.
    fn load_winstt_model(&self, model_id: &str, quantization_override: Option<&str>) -> Result<()> {
        let load_start = std::time::Instant::now();

        // Best-effort display name (catalog → display, else raw id) for the events. The backend's
        // `resolve_catalog`/`build_resolved` return the authoritative name in the spec, but the
        // `loading_started`/`loading_failed`-on-resolve events fire before/around that, so derive
        // it up front from the same catalog source.
        let display_name = self.backend.display_name_for(model_id);

        let emit_failed = |msg: &str, model_name: &str| {
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_name.to_string()),
                    error: Some(msg.to_string()),
                },
            );
        };

        // emit loading_started (parity with the Handy path's event surface) — BEFORE the resolve,
        // matching the original ordering so the picker chip shows "Switching…" immediately.
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(display_name.clone()),
                error: None,
            },
        );

        // PHASE 1 — offline resolve (no ORT session, leaves the resident engine untouched). On
        // failure the old engine is still resident; emit loading_failed with the best-effort name.
        let spec =
            match self
                .backend
                .resolve_catalog(&self.app_handle, model_id, quantization_override)
            {
                Ok(spec) => spec,
                Err(e) => {
                    let msg = e.to_string();
                    emit_failed(&msg, &display_name);
                    return Err(e);
                }
            };

        // FAILURE-ATOMIC SWAP: now that the file set is verified present on disk (resolve
        // succeeded), the build is essentially guaranteed — so it's safe to free the OLD engine's
        // ORT sessions HERE. We CANNOT build the new one first (the Windows DLL race forbids two
        // live ort sessions). If resolve had failed we'd have returned above with the old engine
        // still resident.
        if self.is_model_loaded() {
            let _ = self.unload_model();
        }

        // PHASE 2 — build the engine from the resolved spec.
        let (engine, display_name) = match self.backend.build_resolved(spec) {
            Ok(built) => built,
            Err(e) => {
                let msg = e.to_string();
                emit_failed(&msg, &display_name);
                return Err(e);
            }
        };

        self.clear_warmed_model();
        {
            let mut guard = self.lock_engine();
            *guard = Some(LoadedEngine::Winstt(engine));
        }
        {
            let mut current = self.lock_current_model();
            *current = Some(model_id.to_string());
        }
        self.touch_activity();

        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(display_name),
                error: None,
            },
        );
        info!(
            "Loaded WinSTT model '{}' in {}ms",
            model_id,
            load_start.elapsed().as_millis()
        );
        Ok(())
    }

    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.lock_current_model();
        current_model.clone()
    }

    pub fn transcribe(&self, audio: Vec<f32>) -> Result<String> {
        let request_id = next_transcription_request_id();

        #[cfg(debug_assertions)]
        if std::env::var("HANDY_FORCE_TRANSCRIPTION_FAILURE").is_ok() {
            error!("[stt][{request_id}] simulated transcription failure requested");
            return Err(anyhow::anyhow!(
                "Simulated transcription failure (HANDY_FORCE_TRANSCRIPTION_FAILURE)"
            ));
        }

        // Update last activity timestamp
        self.touch_activity();

        let st = std::time::Instant::now();

        debug!("[stt][{request_id}] audio_samples={}", audio.len());

        if audio.is_empty() {
            debug!("[stt][{request_id}] empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok(String::new());
        }

        // ── SILENCE GATE (all engine paths: cloud / transcribe-rs / winstt-catalog) ──
        // A recording can be NON-empty yet carry NO actual speech — pure silence / room
        // tone (the Silero VAD at threshold 0.3 keeps near-silent frames on some mics), or
        // a dead Bluetooth/A2DP/virtual device emitting a constant DC offset. Fed to
        // Whisper, that makes the greedy decoder HALLUCINATE phantom text — observed as a
        // pasted "Thank you." on pure silence (rms≈0.00004), and as a ">12s wall of garbled
        // multilingual text" for the DC-offset dead-mic case. Reject both: an empty result
        // makes the caller emit `no_audio_detected` (actions.rs) → honest "no audio" pill.
        //
        // Gate on DC-immune AC energy (`SILENCE_AC_FLOOR`, empirically between real speech
        // and silence — see the const) OR the DC-dominated dead-device fingerprint. The
        // earlier gate required `rms < 0.0008 AND dc_dominated`, which let GENUINE digital
        // silence through (rms≈0, mean≈0 → not DC-dominated) — the "Thank you." bug. Audio
        // here is RAW (pre-`peak_normalize`).
        if is_silent_recording(&audio) {
            let rms = dc_immune_rms(&audio);
            debug!(
                "[stt][{request_id}] silent recording skipped; rms={rms:.6}; ac_floor={SILENCE_AC_FLOOR}"
            );
            debug!(
                "Recording RMS {rms:.6} below speech floor (ac_floor {SILENCE_AC_FLOOR}) — \
                 no audio (skipping decode)"
            );
            self.maybe_unload_immediately("silent audio");
            return Ok(String::new());
        }

        // The user's selected model (WinSTT picker is the source of truth; falls back to Handy's
        // `selected_model` for cloud ids / first-run). `desired_model_id` reads the picker store
        // through the backend (audit #14) — the core no longer touches `WinsttSettings` directly.
        let desired = self.desired_model_id();

        // ── Cloud STT route ──────────────────────────────────────────────
        // When the selected model carries a cloud prefix (openai:/elevenlabs:), there is NO
        // local engine — ship the captured audio to the provider. The WinSTT-specific round-trip
        // (CloudSttManager call + the nested-runtime block_in_place/block_on branch + the cloud
        // dictionary/filler post-processing) is owned by the backend (audit #14). The core only
        // decides to take the cloud path here — BEFORE the engine lock, since cloud ids have no
        // LoadedEngine — and unloads any resident local engine after.
        if self.backend.route_of(&desired) == BackendRoute::Cloud {
            let filtered = match self
                .backend
                .cloud_transcribe(&self.app_handle, &desired, &audio)
            {
                Ok(text) => text,
                Err(e) => {
                    error!(
                        "[stt][{request_id}] cloud transcription failed for model '{desired}': {e}"
                    );
                    return Err(e);
                }
            };
            self.maybe_unload_immediately("cloud transcription");
            return Ok(filtered);
        }

        let local_audio = local_final_decode_audio_with_silence(&audio);
        debug!(
            "[stt][{request_id}] local_final_decode_samples={} final_silence_pad_ms={}",
            local_audio.len(),
            LOCAL_FINAL_DECODE_SILENCE_PAD_MS
        );

        // Check if model is loaded, if not try to load it
        {
            // If the model is loading, wait for it to complete.
            let mut is_loading = self.lock_is_loading();
            while *is_loading {
                is_loading = self
                    .loading_condvar
                    .wait(is_loading)
                    .unwrap_or_else(|poisoned| {
                        warn!(
                        "[stt][{request_id}] is_loading mutex poisoned while waiting; recovering"
                    );
                        poisoned.into_inner()
                    });
            }

            let engine_guard = self.lock_engine();
            if engine_guard.is_none() {
                error!(
                    "[stt][{request_id}] no loaded transcription engine for selected model '{desired}'"
                );
                return Err(anyhow::anyhow!("Model is not loaded for transcription."));
            }
        }

        // AppSettings is still the source for the transcribe-rs (GGML) Whisper arm's
        // `translate_to_english` / `custom_words` (initial-prompt seed) and for `app_language`
        // (the final filler-filter locale). Read it ONCE here. LANGUAGE is NOT read from here —
        // it lives solely in WinsttSettings.model.language, read via the backend (see below).
        let settings = get_settings(&self.app_handle);

        // Language is owned by ONE store: WinsttSettings.model.language (the picker is the source
        // of truth, read through the backend — audit #14). Validate it against the selected model's
        // supported languages, falling back to auto-detect if unsupported. (WinSTT-catalog models
        // aren't in `model_manager` — its lookup returns None → "supports everything" → the picker
        // already constrained the UI.)
        let picker_language = self.backend.picker_language(&self.app_handle);
        let raw_language = picker_language.trim();
        let validated_language = if raw_language.is_empty() || raw_language == "auto" {
            "auto".to_string()
        } else {
            let is_supported = self
                .model_manager
                .get_model_info(&desired)
                .map(|info| {
                    info.supported_languages.is_empty()
                        || info.supported_languages.contains(&raw_language.to_string())
                })
                .unwrap_or(true);

            if is_supported {
                raw_language.to_string()
            } else {
                warn!(
                    "[stt][{request_id}] language '{}' not supported by selected model '{desired}', falling back to auto-detect",
                    raw_language
                );
                "auto".to_string()
            }
        };

        // The WinSTT-arm engine inputs (language / translate / initial-prompt) AND that arm's
        // post-processing (custom words + filler) are owned by the backend's `decode` (audit #14),
        // which reads them from the picker store itself — so there is no `winstt_opts` to build
        // here anymore. Handles the backend's `decode` needs are captured into the closure below.
        let backend = self.backend.clone();
        let app_handle = self.app_handle.clone();

        // Perform transcription with the appropriate engine.
        // We use catch_unwind to prevent engine panics from poisoning the mutex,
        // which would make the app hang indefinitely on subsequent operations.
        let result = {
            let mut engine_guard = self.lock_engine();

            // Take the engine out so we own it during transcription.
            // If the engine panics, we simply don't put it back (effectively unloading it)
            // instead of poisoning the mutex.
            let mut engine = match engine_guard.take() {
                Some(e) => e,
                None => {
                    error!(
                        "[stt][{request_id}] engine unavailable after load wait for selected model '{desired}'"
                    );
                    return Err(anyhow::anyhow!(
                        "Model failed to load after auto-load attempt. Please check your model settings."
                    ));
                }
            };

            // Release the lock before transcribing — no mutex held during the engine call
            drop(engine_guard);

            let transcribe_result = catch_unwind(AssertUnwindSafe(
                || -> Result<TranscribeOutcome> {
                    // WinSTT arm — the backend owns the decode AND the post-processing, returning
                    // the FINAL text (audit #14 risk 3: the core must NOT post-process it again).
                    // Borrow `&mut dyn Transcriber` from the engine the core already took out of the
                    // mutex; the backend never locks it.
                    if let LoadedEngine::Winstt(winstt_engine) = &mut engine {
                        return backend
                            .decode(&app_handle, winstt_engine.as_mut(), &local_audio)
                            .map(TranscribeOutcome::Final);
                    }
                    // transcribe-rs (GGML) arms — produce a Raw result the core post-processes.
                    match &mut engine {
                        LoadedEngine::Whisper(whisper_engine) => {
                            let whisper_language = if validated_language == "auto" {
                                None
                            } else {
                                let normalized = if validated_language == "zh-Hans"
                                    || validated_language == "zh-Hant"
                                {
                                    "zh".to_string()
                                } else {
                                    validated_language.clone()
                                };
                                Some(normalized)
                            };

                            let params = WhisperInferenceParams {
                                language: whisper_language,
                                translate: settings.translate_to_english,
                                initial_prompt: if settings.custom_words.is_empty() {
                                    None
                                } else {
                                    Some(settings.custom_words.join(", "))
                                },
                                ..Default::default()
                            };

                            whisper_engine
                                .transcribe_with(&local_audio, &params)
                                .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))
                        }
                        LoadedEngine::Parakeet(parakeet_engine) => {
                            let params = ParakeetParams {
                                timestamp_granularity: Some(TimestampGranularity::Segment),
                                ..Default::default()
                            };
                            parakeet_engine
                                .transcribe_with(&local_audio, &params)
                                .map_err(|e| {
                                    anyhow::anyhow!("Parakeet transcription failed: {}", e)
                                })
                        }
                        LoadedEngine::Moonshine(moonshine_engine) => moonshine_engine
                            .transcribe(&local_audio, &TranscribeOptions::default())
                            .map_err(|e| anyhow::anyhow!("Moonshine transcription failed: {}", e)),
                        LoadedEngine::MoonshineStreaming(streaming_engine) => streaming_engine
                            .transcribe(&local_audio, &TranscribeOptions::default())
                            .map_err(|e| {
                                anyhow::anyhow!("Moonshine streaming transcription failed: {}", e)
                            }),
                        LoadedEngine::SenseVoice(sense_voice_engine) => {
                            let language = match validated_language.as_str() {
                                "zh" | "zh-Hans" | "zh-Hant" => Some("zh".to_string()),
                                "en" => Some("en".to_string()),
                                "ja" => Some("ja".to_string()),
                                "ko" => Some("ko".to_string()),
                                "yue" => Some("yue".to_string()),
                                _ => None,
                            };
                            let params = SenseVoiceParams {
                                language,
                                use_itn: Some(true),
                            };
                            sense_voice_engine
                                .transcribe_with(&local_audio, &params)
                                .map_err(|e| {
                                    anyhow::anyhow!("SenseVoice transcription failed: {}", e)
                                })
                        }
                        LoadedEngine::GigaAM(gigaam_engine) => gigaam_engine
                            .transcribe(&local_audio, &TranscribeOptions::default())
                            .map_err(|e| anyhow::anyhow!("GigaAM transcription failed: {}", e)),
                        LoadedEngine::Canary(canary_engine) => {
                            let lang = if validated_language == "auto" {
                                None
                            } else {
                                Some(validated_language.clone())
                            };
                            let options = TranscribeOptions {
                                language: lang,
                                translate: settings.translate_to_english,
                                ..Default::default()
                            };
                            canary_engine
                                .transcribe(&local_audio, &options)
                                .map_err(|e| anyhow::anyhow!("Canary transcription failed: {}", e))
                        }
                        LoadedEngine::Cohere(cohere_engine) => {
                            let lang = if validated_language == "auto" {
                                None
                            } else if validated_language == "zh-Hans"
                                || validated_language == "zh-Hant"
                            {
                                Some("zh".to_string())
                            } else {
                                Some(validated_language.clone())
                            };
                            let options = TranscribeOptions {
                                language: lang,
                                ..Default::default()
                            };
                            cohere_engine
                                .transcribe(&local_audio, &options)
                                .map_err(|e| anyhow::anyhow!("Cohere transcription failed: {}", e))
                        }
                        // The WinSTT arm was handled by the early `return` above (backend.decode);
                        // it cannot reach this transcribe-rs match.
                        LoadedEngine::Winstt(_) => unreachable!(
                            "WinSTT arm is dispatched to backend.decode before the transcribe-rs match"
                        ),
                    }
                    .map(TranscribeOutcome::Raw)
                },
            ));

            match transcribe_result {
                Ok(inner_result) => {
                    if let Err(e) = &inner_result {
                        if is_degenerate_decode_error(e) {
                            error!(
                                "[stt][{request_id}] transcription failed for model '{desired}': {e}"
                            );
                            warn!(
                                "[stt][{request_id}] dropping corrupted engine for model '{desired}' after degenerate decode; next load will recycle DirectML unless repeated failures trigger CPU fallback"
                            );
                            engine.shutdown();
                            {
                                let mut current_model = self
                                    .current_model_id
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                *current_model = None;
                            }
                            self.clear_warmed_model();
                            let detail = e.to_string();
                            let _ = self.app_handle.emit(
                                "model-state-changed",
                                ModelStateEvent {
                                    event_type: "unloaded".to_string(),
                                    model_id: None,
                                    model_name: None,
                                    error: Some(detail.clone()),
                                },
                            );
                            return Err(anyhow::anyhow!(detail));
                        }
                    }
                    // Success or normal error — put the engine back
                    let mut engine_guard = self.lock_engine();
                    *engine_guard = Some(engine);
                    inner_result.map_err(|e| {
                        error!(
                            "[stt][{request_id}] transcription failed for model '{desired}': {e}"
                        );
                        e
                    })?
                }
                Err(panic_payload) => {
                    // Engine panicked — do NOT put it back (it's in an unknown state).
                    // The engine is dropped here, effectively unloading it.
                    let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!(
                        "[stt][{request_id}] transcription engine panicked for model '{desired}': {}. Model has been unloaded.",
                        panic_msg
                    );
                    engine.shutdown();

                    // Clear the model ID so it will be reloaded on next attempt
                    {
                        let mut current_model = self
                            .current_model_id
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        *current_model = None;
                    }
                    self.clear_warmed_model();

                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "unloaded".to_string(),
                            model_id: None,
                            model_name: None,
                            error: Some(format!("Engine panicked: {}", panic_msg)),
                        },
                    );

                    return Err(anyhow::anyhow!(
                        "Transcription engine panicked: {}. The model has been unloaded and will reload on next attempt.",
                        panic_msg
                    ));
                }
            }
        };

        // Post-processing. The WinSTT arm already post-processed inside `backend.decode` (audit
        // #14 risk 3: do NOT post-process it again). Only the Raw (transcribe-rs) arms run the
        // core's generic custom-words + filler pass below.
        let filtered_result = match result {
            TranscribeOutcome::Final(text) => text,
            TranscribeOutcome::Raw(raw) => {
                // The WinSTT-picker post-processing (dictionary custom-words + filler) is owned by
                // the backend (audit #14). Skip the custom-words correction for (transcribe-rs)
                // Whisper since those custom words are already passed as the initial_prompt.
                let is_whisper = self
                    .model_manager
                    .get_model_info(&desired)
                    .map(|info| matches!(info.engine_type, EngineType::Whisper))
                    .unwrap_or(false);
                self.backend
                    .postprocess_transcribe_rs(&self.app_handle, &raw.text, is_whisper)
            }
        };

        let et = std::time::Instant::now();
        let translation_note = if settings.translate_to_english {
            " (translated)"
        } else {
            ""
        };
        let final_result = filtered_result;
        let output_chars = final_result.chars().count();
        self.mark_model_warmed_if_current(&desired);

        info!(
            "[stt][{request_id}] transcription completed in {}ms{} model='{}' output_chars={} output_empty={}",
            (et - st).as_millis(),
            translation_note,
            desired,
            output_chars,
            output_chars == 0
        );

        self.maybe_unload_immediately("transcription");

        Ok(final_result)
    }

    /// Realtime live-preview decode: ONE raw pass for the live transcription overlay.
    ///
    /// Ported from the reference server's `_transcribe_realtime_window` /
    /// `_safe_transcribe` (recorder_service.py:2765-2781). Key contract:
    ///
    /// * NON-BLOCKING on the engine — `try_lock` only. If the engine mutex is contended
    ///   (a batch decode holds it) OR no engine is loaded (`None`, or `take()`n out mid-batch),
    ///   return `None` immediately. Blocking here would stall the final batch decode on PTT
    ///   release (the worst-case latency the spec calls out). A skipped tick is normal: the
    ///   worker simply publishes nothing this iteration and tries again.
    /// * PEEK, never `take()` — the guard borrows the engine in place via `match &mut *guard`,
    ///   so a racing batch `transcribe()`'s `engine_guard.take()` still works the instant this
    ///   releases the lock. The lock is held only for the decode itself, which is acceptable
    ///   precisely because the worker bails (returns `None`) the moment a batch decode wants it.
    /// * WinSTT (ort/whisper-DML) engine ONLY — realtime is whisper/ort for now (single
    ///   shared engine; there is NO separate realtime engine). Any other `LoadedEngine` arm
    ///   returns `None`.
    /// * RAW text only — no silence gate, no history, no custom-words/filler/post-processing.
    ///   The stabilizer + assembly happen in the realtime worker.
    /// * `catch_unwind` around the decode (mirrors the batch path) so a realtime panic can't
    ///   poison the worker; returns `None` on panic.
    ///
    /// REUSES THE MAIN ENGINE: there is deliberately no second realtime engine in this port —
    /// do not wire one. The the reference server's separate realtime transcriber maps to this single
    /// in-proc engine, shared with the batch path under the same mutex.
    pub fn transcribe_realtime(&self, audio: &[f32], language: Option<&str>) -> Option<String> {
        if audio.is_empty() {
            return None;
        }
        // Silence backstop (same floor as the batch gate): a low-AC-energy window is the
        // ambient/silence the Silero VAD let through — decoding it makes Whisper hallucinate
        // ("Thank you.") into the LIVE PREVIEW, which would reveal the pill on silence.
        // Return None so the watermark/preview pick up no phantom text.
        if dc_immune_rms(audio) < SILENCE_AC_FLOOR {
            return None;
        }
        // Non-blocking: bail the instant the engine is busy (batch decode), but RECOVER
        // from poison instead of treating it like contention. The previous `Err(_) =>
        // return None` collapsed `Poisoned` into the WouldBlock case, so a single panic
        // (which poisons the mutex) wedged live preview forever — every subsequent tick
        // saw a poisoned lock and returned None. Mirror `lock_engine`: WouldBlock skips
        // the tick (a batch decode owns the lock), Poisoned is recovered via
        // `into_inner()` so realtime keeps working after a one-off panic.
        let mut guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => return None, // batch decode owns it — skip
            Err(std::sync::TryLockError::Poisoned(p)) => {
                warn!("Engine mutex poisoned by a previous panic, recovering (realtime)");
                p.into_inner()
            }
        };

        // The WinSTT-arm realtime decode (peak-normalize + configured-language opts) is owned by
        // the backend (audit #14). The core keeps only the `try_lock` non-blocking + poison
        // recovery + `catch_unwind` discipline. The backend borrows `&mut dyn Transcriber` in
        // place (PEEK, never `take()`); it must NOT lock the mutex.
        let backend = self.backend.clone();
        let settings = get_settings(&self.app_handle);
        let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match &mut *guard {
                Some(LoadedEngine::Winstt(e)) => {
                    backend.decode_realtime(e.as_mut(), audio, language)
                }
                Some(LoadedEngine::Whisper(whisper_engine)) => {
                    let whisper_language = language.and_then(transcribe_rs_language);
                    let params = WhisperInferenceParams {
                        language: whisper_language,
                        translate: settings.translate_to_english,
                        initial_prompt: if settings.custom_words.is_empty() {
                            None
                        } else {
                            Some(settings.custom_words.join(", "))
                        },
                        ..Default::default()
                    };
                    whisper_engine
                        .transcribe_with(audio, &params)
                        .ok()
                        .map(|raw| raw.text)
                }
                Some(LoadedEngine::Parakeet(parakeet_engine)) => {
                    let params = ParakeetParams {
                        timestamp_granularity: Some(TimestampGranularity::Segment),
                        ..Default::default()
                    };
                    parakeet_engine
                        .transcribe_with(audio, &params)
                        .ok()
                        .map(|raw| raw.text)
                }
                Some(LoadedEngine::Moonshine(moonshine_engine)) => moonshine_engine
                    .transcribe(audio, &TranscribeOptions::default())
                    .ok()
                    .map(|raw| raw.text),
                Some(LoadedEngine::MoonshineStreaming(streaming_engine)) => streaming_engine
                    .transcribe(audio, &TranscribeOptions::default())
                    .ok()
                    .map(|raw| raw.text),
                Some(LoadedEngine::SenseVoice(sense_voice_engine)) => {
                    let params = SenseVoiceParams {
                        language: language.and_then(sense_voice_realtime_language),
                        use_itn: Some(true),
                    };
                    sense_voice_engine
                        .transcribe_with(audio, &params)
                        .ok()
                        .map(|raw| raw.text)
                }
                Some(LoadedEngine::GigaAM(gigaam_engine)) => gigaam_engine
                    .transcribe(audio, &TranscribeOptions::default())
                    .ok()
                    .map(|raw| raw.text),
                Some(LoadedEngine::Canary(canary_engine)) => {
                    let options = TranscribeOptions {
                        language: language.and_then(generic_realtime_language),
                        translate: settings.translate_to_english,
                        ..Default::default()
                    };
                    canary_engine
                        .transcribe(audio, &options)
                        .ok()
                        .map(|raw| raw.text)
                }
                Some(LoadedEngine::Cohere(cohere_engine)) => {
                    let options = TranscribeOptions {
                        language: language.and_then(transcribe_rs_language),
                        ..Default::default()
                    };
                    cohere_engine
                        .transcribe(audio, &options)
                        .ok()
                        .map(|raw| raw.text)
                }
                // No local engine loaded, or taken out by a batch decode.
                _ => None,
            }
        }));

        let text = match decoded {
            Ok(text) => text,
            Err(_) => {
                warn!("Realtime decode panicked — skipping tick");
                None
            }
        };
        drop(guard);
        if text.is_some() {
            if let Some(model_id) = self.get_current_model() {
                self.mark_model_warmed_if_current(&model_id);
            }
        }
        text
    }

    /// Capability peek for final-reuse policy. This blocks because final reuse runs on the
    /// transcription blocking pool after release; waiting here lets any in-flight realtime
    /// `stream_accept` finish and publish its covered-sample cache before finalization consumes it.
    fn loaded_capabilities(&self) -> LoadedTranscriptionCapabilities {
        let guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (capability peek)");
            p.into_inner()
        });
        match &*guard {
            Some(LoadedEngine::Winstt(e)) => {
                let kind = e.kind();
                LoadedTranscriptionCapabilities {
                    final_reuse_safe: kind.final_reuse_safe(),
                    native_streaming: e.supports_native_streaming(),
                }
            }
            Some(_) | None => LoadedTranscriptionCapabilities::CONSERVATIVE,
        }
    }

    fn run_native_stream_finalize(
        engine: &mut Option<LoadedEngine>,
        tail: &[f32],
    ) -> Option<SttResult<String>> {
        match engine {
            Some(LoadedEngine::Winstt(e)) if e.supports_native_streaming() => {
                if !tail.is_empty() {
                    if let Err(err) = e.stream_accept(tail) {
                        return Some(Err(err));
                    }
                }
                Some(e.stream_finalize())
            }
            _ => None,
        }
    }

    /// Feed any final tail samples the realtime tick did not see, then flush the loaded
    /// native-streaming engine's right context and return its final stream text.
    /// This is deliberately blocking and is called from the transcription blocking pool: after
    /// release, final paste should wait for the engine's own end-of-stream callback instead of
    /// guessing a fixed microphone hold-open duration.
    fn finalize_native_stream_text(&self, tail: &[f32]) -> Option<String> {
        let started = std::time::Instant::now();
        let final_tail = native_stream_final_tail_with_silence(tail);
        info!(
            "[realtime-final] native stream finalizing captured_tail_samples={} silence_pad_ms={} fed_tail_samples={} fed_tail_ms={}",
            tail.len(),
            NATIVE_STREAM_FINAL_SILENCE_PAD_MS,
            final_tail.len(),
            (final_tail.len() as f32 / NATIVE_STREAM_SAMPLE_RATE as f32 * 1000.0).round() as u64
        );
        let mut guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (stream_finalize)");
            p.into_inner()
        });
        let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::run_native_stream_finalize(&mut guard, &final_tail)
        }));
        let text = match decoded {
            Ok(Some(Ok(text))) => text,
            Ok(Some(Err(err))) => {
                warn!("Native stream finalize failed: {err}");
                return None;
            }
            Ok(None) => return None,
            Err(_) => {
                warn!("Native stream finalize panicked");
                return None;
            }
        };
        drop(guard);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            info!(
                "[realtime-final] native stream finalized in {}ms final_chars={}",
                started.elapsed().as_millis(),
                trimmed.chars().count()
            );
            Some(trimmed.to_string())
        }
    }

    /// Peek whether the loaded engine does NATIVE streaming (carries cross-chunk cache state so the
    /// realtime worker can feed only new samples per tick). `Some(true/false)` when an engine is
    /// loaded; `None` when none is loaded yet OR the lock is contended (caller keeps probing / uses
    /// the window path). Non-blocking.
    pub fn realtime_native_streaming(&self) -> Option<bool> {
        match self.engine.try_lock() {
            Ok(guard) => match &*guard {
                Some(LoadedEngine::Winstt(e)) => Some(e.supports_native_streaming()),
                // realtime is WinSTT-arm-only; any other loaded engine → window path (returns
                // nothing from transcribe_realtime, so the preview is simply empty for it).
                Some(_) => Some(false),
                None => None,
            },
            Err(_) => None,
        }
    }

    /// Feed the next chunk of NEW 16 kHz samples into the loaded native-streaming engine (cache
    /// carried internally) and return the incremental text. NON-BLOCKING (`try_lock`, like
    /// `transcribe_realtime`): a contended lock yields [`RealtimeStreamOutcome::Skipped`] so the
    /// worker retries the same samples next tick instead of dropping them. A non-streaming engine
    /// yields [`RealtimeStreamOutcome::NotStreaming`]. `catch_unwind` so a decode panic can't wedge
    /// the worker.
    pub fn stream_accept_realtime(
        &self,
        generation: u64,
        covered: usize,
        new_samples: &[f32],
    ) -> RealtimeStreamOutcome {
        if new_samples.is_empty() {
            return RealtimeStreamOutcome::Text(RealtimeStreamText::interim(String::new()));
        }
        let mut guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => return RealtimeStreamOutcome::Skipped,
            Err(std::sync::TryLockError::Poisoned(p)) => {
                warn!("Engine mutex poisoned by a previous panic, recovering (stream_accept)");
                p.into_inner()
            }
        };
        let decoded =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &mut *guard {
                Some(LoadedEngine::Winstt(e)) if e.supports_native_streaming() => {
                    Some(e.stream_accept(new_samples))
                }
                _ => None,
            }));
        let (outcome, did_decode, cache_text) = match decoded {
            Ok(Some(Ok(update))) => {
                let text = update.text;
                (
                    RealtimeStreamOutcome::Text(RealtimeStreamText {
                        text: text.clone(),
                        is_final: update.is_final,
                    }),
                    true,
                    Some(text),
                )
            }
            Ok(Some(Err(err))) => {
                warn!("Native stream decode failed; retrying same samples: {err}");
                (RealtimeStreamOutcome::Skipped, false, None)
            }
            Ok(None) => (RealtimeStreamOutcome::NotStreaming, false, None),
            Err(_) => {
                warn!("Native stream decode panicked; retrying same samples");
                (RealtimeStreamOutcome::Skipped, false, None)
            }
        };
        if let Some(raw_text) = cache_text {
            info!(
                "[realtime-final] cached native stream generation={} covered_samples={} chars={}",
                generation,
                covered,
                raw_text.chars().count()
            );
            *self.realtime_reuse.lock().unwrap() = Some(RealtimeReuse {
                generation,
                covered,
                raw_text,
            });
        }
        drop(guard);
        if did_decode {
            if let Some(model_id) = self.get_current_model() {
                self.mark_model_warmed_if_current(&model_id);
            }
        }
        outcome
    }

    /// Zero the loaded native-streaming engine's stream state (new utterance). No-op for a
    /// non-streaming or unloaded engine. This waits for any in-flight final decode so a quick
    /// release+re-press cannot carry the previous stream's text/cache into the new recording.
    pub fn stream_reset_realtime(&self) {
        let mut guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (stream_reset)");
            p.into_inner()
        });
        if let Some(LoadedEngine::Winstt(e)) = &mut *guard {
            if e.supports_native_streaming() {
                e.stream_reset();
            }
        }
    }

    /// Cache the latest realtime full-buffer decode for the final-paste reuse fast path. Called by
    /// the realtime worker after each successful full-buffer decode; overwrites any prior entry
    /// (only the freshest, most-complete decode matters). Empty text is never cached (so reuse can
    /// never resurrect a blank/silent tick).
    pub fn cache_realtime_reuse(&self, generation: u64, covered: usize, raw_text: &str) {
        if raw_text.trim().is_empty() {
            return;
        }
        *self.realtime_reuse.lock().unwrap() = Some(RealtimeReuse {
            generation,
            covered,
            raw_text: raw_text.to_string(),
        });
    }

    /// Drop the realtime-reuse cache without promoting it to the final transcript.
    /// Preview-before-pasting needs a fresh batch decode so the editable/rewrite
    /// surface starts from the main finalization path, not the live preview cache.
    pub fn clear_realtime_reuse(&self) {
        let _ = self.realtime_reuse.lock().unwrap().take();
    }

    /// Satisfy the FINAL transcription by REUSING the realtime worker's last full-buffer decode —
    /// avoiding a redundant re-decode of audio the live engine already transcribed (the live decode
    /// used the same engine on the same growing buffer, so it == the final decode sans
    /// post-processing). Returns the post-processed final text when ALL hold:
    ///   * a cached decode exists for THIS recording `generation`,
    ///   * the whole recording is not silent (defer to `transcribe`'s silence gate otherwise — the
    ///     realtime path skips that gate and may have hallucinated on near-silence), and
    ///   * for non-native streaming, the audio past what the cached decode covered carries no speech.
    ///     Native-streaming engines receive that tail before finalizing the stream.
    ///
    /// Returns `None` (→ caller does a fresh `transcribe`) otherwise. The cache is consumed either
    /// way so a stale decode can't leak into the next recording.
    pub fn try_reuse_realtime(&self, generation: u64, samples: &[f32]) -> Option<String> {
        // Context-dependent engines (attention enc-dec: Whisper/Canary/Cohere) must re-decode with
        // proper VAD-segmentation — the chunked realtime watermark text has arbitrary cut points and
        // is lower quality than a clean-boundary final. Only the frame-synchronous (CTC / transducer
        // / native-streaming) families, which carry no cross-utterance text context, reuse the live
        // output.
        let capabilities = self.loaded_capabilities();
        // Consume the cache after the capability wait above. For native streaming, that wait also
        // lets an in-flight realtime `stream_accept` publish the newest covered sample count before
        // finalization computes and feeds the remaining tail.
        let entry = self.realtime_reuse.lock().unwrap().take()?;
        if !capabilities.final_reuse_safe {
            return None;
        }
        if entry.generation != generation {
            return None;
        }
        // Whole-recording silence → let the batch path's gate emit the honest "no audio".
        if is_silent_recording(samples) {
            return None;
        }
        // Trailing audio the realtime decode never saw (last partial chunk + extra-buffer tail).
        // Native-streaming engines can accept that tail before finalizing. Window-redecode engines
        // cannot, so speech-bearing tail must fall back to a fresh final decode.
        let covered = entry.covered.min(samples.len());
        let tail = &samples[covered..];
        info!(
            "[realtime-final] reuse candidate generation={} native={} covered_samples={} total_samples={} tail_samples={} cached_chars={}",
            generation,
            capabilities.native_streaming,
            covered,
            samples.len(),
            tail.len(),
            entry.raw_text.chars().count()
        );
        let raw_text = if capabilities.native_streaming {
            let finalized = if tail.is_empty() {
                self.finalize_native_stream_text(tail)
                    .unwrap_or_else(|| entry.raw_text.clone())
            } else {
                self.finalize_native_stream_text(tail)?
            };
            if !tail.is_empty()
                && finalized.chars().count() <= entry.raw_text.chars().count()
                && dc_immune_rms(tail) >= SILENCE_AC_FLOOR
            {
                info!(
                    "[realtime-final] native stream final text did not grow despite speech-bearing tail; falling back to fresh decode"
                );
                return None;
            }
            finalized
        } else {
            if !tail.is_empty() && dc_immune_rms(tail) >= SILENCE_AC_FLOOR {
                return None;
            }
            entry.raw_text
        };
        // A reuse hit IS a completed transcription — keep the idle-unload watcher from evicting the
        // engine out from under an actively-dictating user (the `transcribe` path it bypasses is
        // where `touch_activity` normally runs).
        self.touch_activity();
        // Same cleanup the WinSTT `decode` path applies, so reuse == a fresh decode would produce.
        let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
        let app_language = get_settings(&self.app_handle).app_language;
        Some(crate::winstt::stt::backend::winstt_postprocess(
            &raw_text,
            &ws,
            &app_language,
        ))
    }
}

/// Apply the user's accelerator preferences to the transcribe-rs global atomics.
/// Called on startup and whenever the user changes the setting.
pub fn apply_accelerator_settings(app: &tauri::AppHandle) {
    use transcribe_rs::accel;

    let settings = get_settings(app);

    let whisper_pref = match settings.whisper_accelerator {
        WhisperAcceleratorSetting::Auto => accel::WhisperAccelerator::Auto,
        WhisperAcceleratorSetting::Cpu => accel::WhisperAccelerator::CpuOnly,
        WhisperAcceleratorSetting::Gpu => accel::WhisperAccelerator::Gpu,
    };
    accel::set_whisper_accelerator(whisper_pref);
    accel::set_whisper_gpu_device(settings.whisper_gpu_device);
    info!(
        "Whisper accelerator set to: {}, gpu_device: {}",
        whisper_pref,
        if settings.whisper_gpu_device == accel::GPU_DEVICE_AUTO {
            "auto".to_string()
        } else {
            settings.whisper_gpu_device.to_string()
        }
    );

    let ort_pref = match settings.ort_accelerator {
        OrtAcceleratorSetting::Auto => accel::OrtAccelerator::Auto,
        OrtAcceleratorSetting::Cpu => accel::OrtAccelerator::CpuOnly,
        OrtAcceleratorSetting::Cuda => accel::OrtAccelerator::Cuda,
        OrtAcceleratorSetting::DirectMl => accel::OrtAccelerator::DirectMl,
        OrtAcceleratorSetting::Rocm => accel::OrtAccelerator::Rocm,
    };
    accel::set_ort_accelerator(ort_pref);
    info!("ORT accelerator set to: {}", ort_pref);
}

#[derive(Serialize, Clone, Debug, Type)]
pub struct GpuDeviceOption {
    pub id: i32,
    pub name: String,
    pub total_vram_mb: usize,
}

static GPU_DEVICES: OnceLock<Vec<GpuDeviceOption>> = OnceLock::new();

fn cached_gpu_devices() -> &'static [GpuDeviceOption] {
    use transcribe_rs::whisper_cpp::gpu::list_gpu_devices;

    GPU_DEVICES.get_or_init(|| {
        // ggml's Vulkan backend uses FMA3 instructions internally.
        // On older CPUs without FMA3 (e.g. Sandy Bridge Xeons) this causes
        // a SIGILL crash that cannot be caught. Skip enumeration entirely
        // on those CPUs — GPU-accelerated whisper won't work there anyway.
        #[cfg(target_arch = "x86_64")]
        if !std::arch::is_x86_feature_detected!("fma") {
            warn!("CPU lacks FMA3 support — skipping GPU device enumeration");
            return Vec::new();
        }

        list_gpu_devices()
            .into_iter()
            .map(|d| GpuDeviceOption {
                id: d.id,
                name: d.name,
                total_vram_mb: d.total_vram / (1024 * 1024),
            })
            .collect()
    })
}

#[derive(Serialize, Clone, Debug, Type)]
pub struct AvailableAccelerators {
    pub whisper: Vec<String>,
    pub ort: Vec<String>,
    pub gpu_devices: Vec<GpuDeviceOption>,
}

/// Return which accelerators are compiled into this build.
pub fn get_available_accelerators() -> AvailableAccelerators {
    use transcribe_rs::accel::OrtAccelerator;

    let ort_options: Vec<String> = OrtAccelerator::available()
        .into_iter()
        .map(|a| a.to_string())
        .collect();

    let whisper_options = vec!["auto".to_string(), "cpu".to_string(), "gpu".to_string()];

    AvailableAccelerators {
        whisper: whisper_options,
        ort: ort_options,
        gpu_devices: cached_gpu_devices().to_vec(),
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
        if let Some(handle) = self.watcher_handle.lock().unwrap().take() {
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
    // `crate::winstt::stt::backend` (audit #14). The source-level guard below stays here because
    // it asserts a property of THIS file's text.

    /// Single-store-per-field guard (audit finding "Dual settings source-of-truth"): the
    /// transcribe path must read `language` from WinsttSettings.model.language ONLY, never
    /// from the AppSettings language field. This source-level assertion fails if the removed
    /// dual read is reintroduced into this file's hot path. The forbidden identifier is
    /// assembled at runtime so the test's own source doesn't trip the check.
    #[test]
    fn transcribe_path_does_not_read_appsettings_language() {
        let src = include_str!("transcription.rs");
        let forbidden = format!("selected_{}", "language");
        assert!(
            !src.contains(&forbidden),
            "transcription.rs must not read the AppSettings language field — language is owned \
             solely by WinsttSettings.model.language (see crate::winstt::stt::backend)"
        );
    }

    // ── silence gate: AC-energy floor separates speech from silence ─────────────
    // Real values logged by the app's `[silence-gate]` on this hardware: silence /
    // Whisper-hallucination clips ("Thank you.") measured rms ≤ 0.0014; real speech
    // recordings measured rms ≥ 0.0074. The 0.003 floor must reject the former and pass
    // the latter — regression guard for the "Thank you. on silence" bug.

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
