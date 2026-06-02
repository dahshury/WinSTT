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
use crate::winstt::stt::{
    BackendRoute, SttBackend, Transcriber as WinsttTranscriber, WinsttSttBackend,
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

// The WinSTT-specific helpers `engine_kind_for`, `family_policy_slug`, `normalize_winstt_language`,
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
        let mut is_loading = self.is_loading.lock().unwrap();
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
    /// The WinSTT-owned STT backend (audit #14). Every WinSTT-specific load/decode/cloud step
    /// (catalog resolve+build, the unified ort engine decode + post-processing, the cloud
    /// round-trip, language/dictionary/filler from the picker store) is delegated here so this
    /// inherited Handy core stops reaching sideways into `crate::winstt::*` — restoring the
    /// one-way dependency edge that keeps upstream Handy merges of this file tractable.
    backend: Arc<dyn SttBackend>,
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
            backend: Arc::new(WinsttSttBackend),
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
                        .map_or(false, |a| a.is_recording());
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

    pub fn is_model_loaded(&self) -> bool {
        let engine = self.lock_engine();
        engine.is_some()
    }

    /// Atomically check whether a model load is in progress and, if not, mark
    /// one as starting. Returns a [`LoadingGuard`] whose [`Drop`] impl will
    /// clear the flag and wake waiters. Returns `None` if a load is already in
    /// progress.
    pub fn try_start_loading(&self) -> Option<LoadingGuard> {
        let mut is_loading = self.is_loading.lock().unwrap();
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

        {
            let mut engine = self.lock_engine();
            // Dropping the engine frees all resources
            *engine = None;
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = None;
        }

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
            .unwrap()
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

        // Update the current engine and model ID
        {
            let mut engine = self.lock_engine();
            *engine = Some(loaded_engine);
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
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
        let mut is_loading = self.is_loading.lock().unwrap();
        if *is_loading {
            return; // a load is already in flight; it picks up the latest selection
        }
        let desired = self.desired_model_id();
        if self.is_model_loaded() && self.get_current_model().as_deref() == Some(desired.as_str()) {
            return; // already on the selected model
        }

        *is_loading = true;
        drop(is_loading);
        let self_clone = self.clone();
        thread::spawn(move || {
            let desired = self_clone.desired_model_id();
            // Failure-atomic: dispatch_load does NOT unload up front — a failed resolve/build
            // leaves the previous engine resident (re-emitting loading_completed for it).
            if let Err(e) = self_clone.dispatch_load(&desired) {
                error!("Failed to load model '{}': {}", desired, e);
            }
            let mut is_loading = self_clone.is_loading.lock().unwrap();
            *is_loading = false;
            self_clone.loading_condvar.notify_all();
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
    fn dispatch_load(&self, model_id: &str) -> Result<()> {
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
                    let mut current = self.current_model_id.lock().unwrap();
                    *current = Some(model_id.to_string());
                }
                self.touch_activity();
                Ok(())
            }
            BackendRoute::Catalog => self.load_winstt_model(model_id),
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
        let model_id = match self.get_current_model().or_else(|| previous.map(str::to_string)) {
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
        {
            let mut is_loading = self.is_loading.lock().unwrap();
            if *is_loading {
                return Err("Model load already in progress".to_string());
            }
            *is_loading = true;
        }
        // FAILURE-ATOMIC: dispatch_load never unloads the resident engine up front — a failed
        // resolve/build leaves the previous model dictatable (and re-emits its loading_completed),
        // instead of the old unload-first path that left NOTHING loaded on a network blip.
        let outcome: Result<()> = self.dispatch_load(model_id);
        {
            let mut is_loading = self.is_loading.lock().unwrap();
            *is_loading = false;
            self.loading_condvar.notify_all();
        }
        // Warm the freshly-loaded engine so the first post-swap decode isn't cold (DML kernel JIT) —
        // but do it on a DETACHED thread so the swap completes (chip clears) on LOAD, not after the
        // cold warm-decode. (TranscriptionManager is Clone — the clone shares the Arc'd state.)
        if outcome.is_ok() {
            let me = self.clone();
            thread::spawn(move || me.warmup());
        }
        outcome.map_err(|e| {
            error!("Failed to load model '{model_id}': {e}");
            e.to_string()
        })
    }

    /// Eagerly compile the loaded engine's kernels with a dummy 1s-silence decode so the FIRST
    /// real PTT decode is WARM — no cold DirectML kernel JIT serialized on the release path (the
    /// dominant cause of the port feeling ~10x slower than Electron on the first dictation). Mirrors
    /// the Electron server's `RecorderService.warmup` (decodes `np.zeros(16000)` at boot). Only the
    /// WinSTT ort/DirectML engine pays cold-JIT; the transcribe-rs (GGML) engines don't, so we warm
    /// just that arm. Best-effort: a warmup failure must never break dictation.
    pub fn warmup(&self) {
        // Wait out any in-flight LOAD (we must not warm a half-built engine), but do NOT hold
        // `is_loading` for the warm decode — that was the bug: a real dictation that raced in
        // WAITED on transcribe()'s loading condvar even though the engine was fully loaded and
        // ready, serializing the user's decode behind a cold ~1s warmup. Instead we only set the
        // separate `warming` flag and yield the engine to any real decode via `try_lock`.
        {
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }
        }
        if !self.is_model_loaded() {
            return; // cloud id, or load failed — nothing local to warm
        }

        self.warming.store(true, Ordering::SeqCst);
        // Clear `warming` on EVERY exit path (early return / panic) via RAII.
        let _warming_guard = WarmingGuard(&self.warming);

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
        if let Some(LoadedEngine::Winstt(e)) = engine_guard.as_mut() {
            let backend = self.backend.clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                backend.warmup(e.as_mut());
            }));
        }
        drop(engine_guard);
        self.touch_activity();
        log::info!("[stt] engine warmup complete");
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
    fn load_winstt_model(&self, model_id: &str) -> Result<()> {
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
        let spec = match self.backend.resolve_catalog(&self.app_handle, model_id) {
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

        {
            let mut guard = self.lock_engine();
            *guard = Some(LoadedEngine::Winstt(engine));
        }
        {
            let mut current = self.current_model_id.lock().unwrap();
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
        let current_model = self.current_model_id.lock().unwrap();
        current_model.clone()
    }

    pub fn transcribe(&self, audio: Vec<f32>) -> Result<String> {
        #[cfg(debug_assertions)]
        if std::env::var("HANDY_FORCE_TRANSCRIPTION_FAILURE").is_ok() {
            return Err(anyhow::anyhow!(
                "Simulated transcription failure (HANDY_FORCE_TRANSCRIPTION_FAILURE)"
            ));
        }

        // Update last activity timestamp
        self.touch_activity();

        let st = std::time::Instant::now();

        debug!("Audio vector length: {}", audio.len());

        if audio.is_empty() {
            debug!("Empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok(String::new());
        }

        // ── SILENCE GATE (all engine paths: cloud / transcribe-rs / winstt-catalog) ──
        // A recording can be NON-empty yet carry NO actual audio — e.g. a Bluetooth
        // headset mic in A2DP mode, or a muted/virtual device. Such a dead device emits a
        // constant DC offset (raw |peak| nonzero) with ZERO real signal energy. Fed to
        // Whisper, that silence makes the greedy decoder HALLUCINATE hundreds of garbage
        // tokens until max_length (the observed ">12s wall of garbled multilingual text").
        // Reject ONLY that signature: an empty result makes the caller emit
        // `no_audio_detected` (actions.rs) → honest "no audio" pill, not garbage.
        //
        // SCOPED, not a blanket amplitude floor: the previous `rms < 0.0025` floor also
        // dropped genuinely quiet speech (a soft talker / distant mic). Instead trip only on
        // the DC-dominated dead-device fingerprint — vanishing AC energy (DC-immune RMS) AND
        // a DC offset that dwarfs whatever AC remains. Real (even quiet) speech has AC > DC
        // and an RMS well above the noise floor; a dead virtual mic has AC ≈ 0 with a large
        // constant |mean|. Audio here is RAW (pre-`peak_normalize`).
        let n = audio.len() as f32;
        let mean = audio.iter().copied().sum::<f32>() / n;
        let rms = (audio.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n).sqrt();
        // AC floor: below this there is no decodable speech energy at all. DC-dominated:
        // the constant offset is at least an order of magnitude above the AC RMS, i.e. the
        // signal is "all offset, no audio" — the dead/virtual-mic fingerprint.
        const SILENCE_AC_FLOOR: f32 = 0.0008;
        const DC_DOMINANCE_RATIO: f32 = 10.0;
        let dc_dominated = mean.abs() > rms * DC_DOMINANCE_RATIO;
        log::debug!(
            "[silence-gate] rms={rms:.6} mean={mean:.6} dc_dominated={dc_dominated} \
             (ac_floor {SILENCE_AC_FLOOR})"
        );
        if rms < SILENCE_AC_FLOOR && dc_dominated {
            debug!(
                "Recording RMS {rms:.6} with DC offset {mean:.6} matches dead/virtual-mic \
                 signature — no audio (skipping decode)"
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
            let filtered = self.backend.cloud_transcribe(&self.app_handle, &desired, &audio)?;
            self.maybe_unload_immediately("cloud transcription");
            return Ok(filtered);
        }

        // Check if model is loaded, if not try to load it
        {
            // If the model is loading, wait for it to complete.
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }

            let engine_guard = self.lock_engine();
            if engine_guard.is_none() {
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
                    "Language '{}' not supported by current model, falling back to auto-detect",
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
                            .decode(&app_handle, winstt_engine.as_mut(), &audio)
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
                                .transcribe_with(&audio, &params)
                                .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))
                        }
                        LoadedEngine::Parakeet(parakeet_engine) => {
                            let params = ParakeetParams {
                                timestamp_granularity: Some(TimestampGranularity::Segment),
                                ..Default::default()
                            };
                            parakeet_engine
                                .transcribe_with(&audio, &params)
                                .map_err(|e| {
                                    anyhow::anyhow!("Parakeet transcription failed: {}", e)
                                })
                        }
                        LoadedEngine::Moonshine(moonshine_engine) => moonshine_engine
                            .transcribe(&audio, &TranscribeOptions::default())
                            .map_err(|e| anyhow::anyhow!("Moonshine transcription failed: {}", e)),
                        LoadedEngine::MoonshineStreaming(streaming_engine) => streaming_engine
                            .transcribe(&audio, &TranscribeOptions::default())
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
                                .transcribe_with(&audio, &params)
                                .map_err(|e| {
                                    anyhow::anyhow!("SenseVoice transcription failed: {}", e)
                                })
                        }
                        LoadedEngine::GigaAM(gigaam_engine) => gigaam_engine
                            .transcribe(&audio, &TranscribeOptions::default())
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
                                .transcribe(&audio, &options)
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
                                .transcribe(&audio, &options)
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
                    // Success or normal error — put the engine back
                    let mut engine_guard = self.lock_engine();
                    *engine_guard = Some(engine);
                    inner_result?
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
                        "Transcription engine panicked: {}. Model has been unloaded.",
                        panic_msg
                    );

                    // Clear the model ID so it will be reloaded on next attempt
                    {
                        let mut current_model = self
                            .current_model_id
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        *current_model = None;
                    }

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
        info!(
            "Transcription completed in {}ms{}",
            (et - st).as_millis(),
            translation_note
        );

        let final_result = filtered_result;

        if final_result.is_empty() {
            info!("Transcription result is empty");
        } else {
            info!("Transcription result: {}", final_result);
        }

        self.maybe_unload_immediately("transcription");

        Ok(final_result)
    }

    /// Realtime live-preview decode: ONE raw pass for the live transcription overlay.
    ///
    /// Ported from the Electron server's `_transcribe_realtime_window` /
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
    /// do not wire one. The Electron server's separate realtime transcriber maps to this single
    /// in-proc engine, shared with the batch path under the same mutex.
    pub fn transcribe_realtime(&self, audio: &[f32], language: Option<&str>) -> Option<String> {
        if audio.is_empty() {
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
        let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match &mut *guard {
                Some(LoadedEngine::Winstt(e)) => {
                    backend.decode_realtime(e.as_mut(), audio, language)
                }
                // No engine loaded, taken out by a batch decode, or a non-ort engine arm:
                // realtime is whisper/ort-only for now.
                _ => None,
            }
        }));

        match decoded {
            Ok(text) => text,
            Err(_) => {
                warn!("Realtime decode panicked — skipping tick");
                None
            }
        }
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
}
