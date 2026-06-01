use crate::audio_toolkit::{apply_custom_words, filter_transcription_output};
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
use crate::winstt::stt::Transcriber as WinsttTranscriber;
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

/// Catalog family → engine decode archetype. Returns `None` for families whose engine isn't
/// dispatched by `stt::build_engine` yet (Moonshine/Cohere/NeMo/Kaldi/GigaAM/T-One/Dolphin/
/// SenseVoice live in `stt::families` but aren't wired) so the swap surfaces a precise error
/// instead of silently doing nothing.
fn engine_kind_for(entry: &crate::winstt::catalog::ModelEntry) -> Option<crate::winstt::stt::EngineKind> {
    use crate::winstt::stt::EngineKind;
    let kind = crate::winstt::stt::cache_probe::engine_kind_for(
        entry.id,
        family_policy_slug(entry.family),
        entry.onnx_model_name,
    );
    // Gate on the resolved ENGINE KIND (not just family) — `Family::Nemo` spans both the
    // validated Canary (NemoAed) and the still-unvalidated parakeet CTC/TDT, so kind-level
    // gating lets Canary go live while parakeet stays disabled. Only kinds whose ONNX
    // numerics are spike-proven (transcribe JFK correctly) are enabled; the rest return a
    // clean "no Rust engine yet" error instead of silent garbage. Expand as each is spiked.
    //   WhisperHf     — proven (whisper-tiny/.en, lite-whisper-128mel, crisper) via the resolver.
    //   SenseVoiceCtc — proven (sense-voice-small) transcribes JFK with ITN punctuation.
    //   NemoAed       — proven (canary-180m-flash) full JFK w/ PnC: NeMo featurizer + mems carry.
    //   NemoCtc       — proven (parakeet-ctc-0.6b) JFK; NeMo featurizer reads mel count from the
    //                   model (parakeet=80, canary=128) + CTC greedy collapse.
    //   NemoTdt       — proven (parakeet-tdt-0.6b-v3) full JFK w/ PnC: transducer + predictor LSTM
    //                   state carry (input/output_states_1/2, advance on non-blank) + int32 targets
    //                   + TDT duration split.
    //   NemoRnnt      — same TransducerEngine path as NemoTdt minus the duration split (strict
    //                   subset) → validated by extension.
    // PENDING (drafted in stt::families): GigaAM (own featurizer, ru), Cohere (128-mel + fp16 KV),
    //   Kaldi/zipformer (sherpa glob), Dolphin/T-One (non-en audio), Moonshine (own engine file).
    let validated = matches!(
        kind,
        EngineKind::WhisperHf
            | EngineKind::SenseVoiceCtc
            | EngineKind::NemoAed
            | EngineKind::NemoCtc
            | EngineKind::NemoTdt
            | EngineKind::NemoRnnt
    );
    if validated {
        Some(kind)
    } else {
        None
    }
}

/// Catalog family → the policy slug string the `stt` helpers key on (mirrors the Python
/// `family` strings used by `resolve_quantization_auto` / `override_dml_to_cpu_for_family`).
fn family_policy_slug(family: crate::winstt::catalog::Family) -> &'static str {
    use crate::winstt::catalog::Family;
    match family {
        Family::Whisper => "whisper",
        Family::Moonshine => "moonshine",
        Family::Cohere => "cohere",
        Family::Nemo => "nemo",
        Family::SenseVoice => "sense_voice",
        Family::GigaAm => "gigaam",
        Family::Kaldi => "kaldi",
        Family::TOne => "t-one",
        Family::Dolphin => "dolphin",
        Family::Custom => "custom",
    }
}

/// Peak-normalize to 0.95 — the single audio-conditioning chokepoint the WinSTT engines expect
/// (mirrors Python `_peak_normalize`; the `Transcriber` contract says the caller conditions).
fn peak_normalize(audio: &[f32]) -> Vec<f32> {
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak <= 0.0 {
        return audio.to_vec();
    }
    let g = 0.95 / peak;
    audio.iter().map(|&x| x * g).collect()
}

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
        let winstt = crate::winstt::commands::settings::read_settings(&self.app_handle)
            .model
            .model;
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
            // Free the previous engine's ORT sessions before loading the next (Windows DLL race).
            if self_clone.is_model_loaded() {
                let _ = self_clone.unload_model();
            }
            let desired = self_clone.desired_model_id();
            let result = if crate::winstt::cloud_stt::provider_of(&desired).is_some() {
                // Cloud STT id (provider:model): no local engine. Mark it current + ready so
                // transcribe() routes to CloudSttManager; never call the local loader.
                {
                    let mut current = self_clone.current_model_id.lock().unwrap();
                    *current = Some(desired.clone());
                }
                self_clone.touch_activity();
                Ok(())
            } else if crate::winstt::catalog::find(&desired).is_some() {
                self_clone.load_winstt_model(&desired)
            } else {
                self_clone.load_model(&desired)
            };
            if let Err(e) = result {
                error!("Failed to load model '{}': {}", desired, e);
            }
            let mut is_loading = self_clone.is_loading.lock().unwrap();
            *is_loading = false;
            self_clone.loading_condvar.notify_all();
        });
    }

    /// Load a WinSTT-catalog model through the unified ort-ONNX engine (the proven STT spike
    /// path). Resolves the catalog entry → effective quant + provider list (device/quant
    /// settings + family policy) → HF file set → `winstt::stt::build_engine`. Deliberately
    /// bypasses Handy's transcribe-rs `ModelManager` registry (a different id namespace).
    fn load_winstt_model(&self, model_id: &str) -> Result<()> {
        use crate::winstt::catalog::Family;
        use crate::winstt::settings_schema::DeviceType;
        use crate::winstt::stt::resolver::{self, ResolveRequest};
        use crate::winstt::stt::{self, Accelerator, EngineConfig, Quantization};

        let load_start = std::time::Instant::now();
        let entry = crate::winstt::catalog::find(model_id)
            .ok_or_else(|| anyhow::anyhow!("model '{}' not in WinSTT catalog", model_id))?;
        let family_slug = family_policy_slug(entry.family);
        let kind = engine_kind_for(entry).ok_or_else(|| {
            anyhow::anyhow!(
                "model '{}' (family {:?}) has no Rust engine yet — only the Whisper family is wired",
                model_id,
                entry.family
            )
        })?;

        let settings = crate::winstt::commands::settings::read_settings(&self.app_handle);

        // device → primary accelerator (CPU vs the shipped GPU flavor)
        let primary = match settings.model.device {
            DeviceType::Cpu => Accelerator::Cpu,
            DeviceType::Auto => {
                if cfg!(windows) {
                    Accelerator::DirectMl
                } else {
                    Accelerator::Cpu
                }
            }
        };

        // requested quant from settings; auto-resolve the int8-preferred / fp16 policy
        let requested =
            Quantization::parse(settings.model.onnx_quantization.trim()).unwrap_or(Quantization::Default);
        let available: Vec<Quantization> = entry
            .available_quantizations
            .iter()
            .filter_map(|s| Quantization::parse(s))
            .collect();
        let effective =
            stt::resolve_quantization_auto(requested, primary, family_slug, entry.param_count, Some(&available));

        // provider list (primary + CPU fallback), then the DML-incompatible-family override.
        let providers = match primary {
            Accelerator::Cpu => vec![Accelerator::Cpu],
            other => vec![other, Accelerator::Cpu],
        };
        let providers = stt::override_dml_to_cpu_for_family(providers, family_slug);

        // emit loading_started (parity with the Handy path's event surface)
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(entry.display_name.to_string()),
                error: None,
            },
        );

        // resolve the on-disk file set (cache-first; one network refetch if a shard is missing)
        let req = ResolveRequest {
            model_id: entry.onnx_model_name.to_string(),
            kind,
            effective_quant: effective,
            local_dir: None,
            local_files_only: true,
        };
        let emit_failed = |msg: &str| {
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(entry.display_name.to_string()),
                    error: Some(msg.to_string()),
                },
            );
        };
        let resolved = tauri::async_runtime::block_on(resolver::resolve(&req)).map_err(|e| {
            let msg = format!("resolve {}: {}", model_id, e);
            emit_failed(&msg);
            anyhow::anyhow!(msg)
        })?;

        let whisper_fp16_workaround =
            matches!(entry.family, Family::Whisper) && effective == Quantization::Fp16;

        let cfg = EngineConfig {
            model_name: model_id.to_string(),
            family: family_slug.to_string(),
            kind,
            resolved,
            providers,
            whisper_fp16_workaround,
        };

        let engine = stt::build_engine(cfg).map_err(|e| {
            let msg = format!("build WinSTT engine for {}: {}", model_id, e);
            emit_failed(&msg);
            anyhow::anyhow!(msg)
        })?;

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
                model_name: Some(entry.display_name.to_string()),
                error: None,
            },
        );
        info!(
            "Loaded WinSTT model '{}' ({:?}/{:?}) in {}ms",
            model_id,
            kind,
            effective,
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
        // A recording can be NON-empty yet pure silence — e.g. a Bluetooth headset mic in
        // A2DP mode, or a muted/wrong device. Fed to Whisper, silence makes the greedy
        // decoder HALLUCINATE hundreds of garbage tokens until max_length (the observed
        // ">12s wall of garbled multilingual text"). Reject it like the empty case: an empty
        // result makes the caller emit `no_audio_detected` (actions.rs) → honest "no audio"
        // pill, not garbage.
        //
        // Use DC-IMMUNE RMS, not raw peak: a dead A2DP headset mic emits a constant DC offset
        // (raw |peak| nonzero) with ZERO actual audio — the FFT/spectrum reads 0.000 but a
        // raw-peak gate is fooled and lets it through. Removing the mean (DC) and taking RMS
        // measures real signal energy. Real speech RMS is ~0.01–0.1; silence/DC ≈ 0. Audio
        // here is RAW (pre-`peak_normalize`). The rms is logged so the threshold is tunable.
        let n = audio.len() as f32;
        let mean = audio.iter().copied().sum::<f32>() / n;
        let rms = (audio.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n).sqrt();
        const SILENCE_RMS_THRESHOLD: f32 = 0.0025;
        log::info!("[silence-gate] rms={rms:.6} mean={mean:.6} (threshold {SILENCE_RMS_THRESHOLD})");
        if rms < SILENCE_RMS_THRESHOLD {
            debug!("Recording RMS {rms:.6} below silence threshold — no audio (skipping decode)");
            self.maybe_unload_immediately("silent audio");
            return Ok(String::new());
        }

        // ── Cloud STT route ──────────────────────────────────────────────
        // When the selected model carries a cloud prefix (openai:/elevenlabs:), there is NO
        // local engine — ship the captured audio to the provider via CloudSttManager instead.
        // Mirrors the Electron RemoteTranscriber path (frontend/electron/ipc/stt-cloud.ts).
        {
            let desired = self.desired_model_id();
            if crate::winstt::cloud_stt::provider_of(&desired).is_some() {
                let cloud = self
                    .app_handle
                    .state::<std::sync::Arc<crate::winstt::managers::CloudSttManager>>()
                    .inner()
                    .clone();
                let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
                let language = {
                    let l = ws.model.language.trim();
                    if l.is_empty() || l == "auto" {
                        None
                    } else if l == "zh-Hans" || l == "zh-Hant" {
                        Some("zh".to_string())
                    } else {
                        Some(l.to_string())
                    }
                };
                let settings = get_settings(&self.app_handle);
                let text = tauri::async_runtime::block_on(cloud.transcribe_samples(&desired, &audio, language))
                    .map_err(|e| anyhow::anyhow!("Cloud STT failed ({}): {}", e.code.as_str(), e.message))?;
                // Cloud is never Whisper -> apply the WinSTT dictionary correction + filler filter.
                let dict: Vec<String> = ws
                    .dictionary
                    .iter()
                    .map(|d| d.term.clone())
                    .filter(|t| !t.trim().is_empty())
                    .collect();
                let corrected = if dict.is_empty() {
                    text
                } else {
                    apply_custom_words(&text, &dict, ws.general.word_correction_threshold)
                };
                let filler = if ws.general.filter_fillers && !ws.general.custom_filler_words.is_empty() {
                    Some(ws.general.custom_filler_words.clone())
                } else if ws.general.filter_fillers {
                    None
                } else {
                    Some(Vec::new())
                };
                let filtered = filter_transcription_output(&corrected, &settings.app_language, &filler);
                self.maybe_unload_immediately("cloud transcription");
                return Ok(filtered);
            }
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

        // Get current settings for configuration
        let settings = get_settings(&self.app_handle);

        // WinSTT dictionary bridge: the picker's dictionary (custom words) + fuzzy threshold +
        // filler list live in the WinSTT settings store, NOT Handy's `settings.custom_words`.
        // Read them here so the real fuzzy matcher + filler filter run on the user's ACTUAL list
        // (mirrors Electron set_parameter forwarding custom_words/threshold/filler to the recorder).
        let (winstt_custom_words, winstt_word_threshold, winstt_filler_words): (
            Vec<String>,
            f64,
            Option<Vec<String>>,
        ) = {
            let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
            let custom_words: Vec<String> = ws
                .dictionary
                .iter()
                .map(|d| d.term.clone())
                .filter(|t| !t.trim().is_empty())
                .collect();
            let threshold = ws.general.word_correction_threshold;
            // filter_fillers off -> Some([]) (no patterns); on+empty -> None (language default table).
            let filler = if ws.general.filter_fillers {
                if ws.general.custom_filler_words.is_empty() {
                    None
                } else {
                    Some(ws.general.custom_filler_words.clone())
                }
            } else {
                Some(Vec::new())
            };
            (custom_words, threshold, filler)
        };

        // Validate selected language against the model's supported languages.
        // If the language isn't supported, fall back to "auto" to prevent errors.
        let validated_language = if settings.selected_language == "auto" {
            "auto".to_string()
        } else {
            let is_supported = self
                .model_manager
                .get_model_info(&settings.selected_model)
                .map(|info| {
                    info.supported_languages.is_empty()
                        || info
                            .supported_languages
                            .contains(&settings.selected_language)
                })
                .unwrap_or(true);

            if is_supported {
                settings.selected_language.clone()
            } else {
                warn!(
                    "Language '{}' not supported by current model, falling back to auto-detect",
                    settings.selected_language
                );
                "auto".to_string()
            }
        };

        // WinSTT engine inputs come from the WinSTT settings store (the picker's source of
        // truth), not Handy's settings — derive them once here so the catch_unwind closure
        // stays free of `self` borrows. Ignored by the transcribe-rs engine arms.
        let winstt_opts = {
            let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
            let language = {
                let l = ws.model.language.trim();
                if l.is_empty() || l == "auto" {
                    None
                } else if l == "zh-Hans" || l == "zh-Hant" {
                    Some("zh".to_string())
                } else {
                    Some(l.to_string())
                }
            };
            let initial_prompt_text = {
                let p = ws.model.initial_prompt.trim();
                if p.is_empty() {
                    None
                } else {
                    Some(p.to_string())
                }
            };
            crate::winstt::stt::TranscribeOptions {
                language,
                translate: ws.model.translate_to_english,
                initial_prompt_text,
                ..Default::default()
            }
        };

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
                || -> Result<transcribe_rs::TranscriptionResult> {
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
                        LoadedEngine::Winstt(winstt_engine) => {
                            let conditioned = peak_normalize(&audio);
                            winstt_engine
                                .transcribe(&conditioned, &winstt_opts)
                                .map(|t| transcribe_rs::TranscriptionResult {
                                    text: t.text,
                                    segments: None,
                                })
                                .map_err(|e| anyhow::anyhow!("WinSTT transcription failed: {}", e))
                        }
                    }
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

        // Apply word correction if custom words are configured.
        // Skip for Whisper models since custom words are already passed as initial_prompt.
        let is_whisper = self
            .model_manager
            .get_model_info(&settings.selected_model)
            .map(|info| matches!(info.engine_type, EngineType::Whisper))
            .unwrap_or(false);

        let corrected_result = if !winstt_custom_words.is_empty() && !is_whisper {
            apply_custom_words(&result.text, &winstt_custom_words, winstt_word_threshold)
        } else {
            result.text
        };

        // Filter out filler words and hallucinations (WinSTT filler list / language default).
        let filtered_result = filter_transcription_output(
            &corrected_result,
            &settings.app_language,
            &winstt_filler_words,
        );

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
