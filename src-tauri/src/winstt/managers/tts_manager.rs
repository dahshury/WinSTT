// PORT IMPL — Source: docs/archive/port/06_tts.md + lib_wiring.md §2,
// frontend/electron/ipc/{tts,tts-reader,tts-cloud}.ts. Tauri-state wrapper around winstt::tts.
//
// The `tts` slice already defines the engine port (`TtsEngine`), the local Kokoro
// + cloud ElevenLabs engines, the 54-voice catalog, sentence splitter, and the
// HTTP helpers (voices / subscription / preview). This wrapper is the *Tauri-state*
// object: constructed with `new(&AppHandle)`, it re-picks the active engine from
// `tts.source` (+ voice/lang/key/tuning), bridges synthesis chunks to the
// `tts://chunk` event, fires the `tts:started`/`tts:completed`/`tts:failed`
// lifecycle, and owns the per-request cancel set.
//
// 1:1 with the reference `tts.ts` orchestrator:
//   - handleSpeak → read_aloud (enabled-gate + source-aware engine + settings
//     fallbacks for voice/lang/speed)
//   - handleCloudPreview → read_preview_url
//   - handleListVoices → list_voices_catalog ({ voices, languages })
//   - handleCloudListVoices → list_cloud_voices ({ voices, error })
//   - handleCloudSubscription → cloud_subscription ({ tier, creditsExhausted })
//   - handleDownloadEstimate → download_estimate ({ alreadyInstalled, components,
//     totalBytes, unavailable? })
//   - cancel / cancel_all / handleSetSpeed → cancel / cancel_all / set_speed

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::commands::settings::read_settings;
use crate::winstt::managers::tts_download_manager::{TtsDownloadErr, TtsDownloadManager};
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::settings_schema::{DeviceType, TtsSource as SettingsTtsSource};
use crate::winstt::tts::catalog::{self, TtsEngineId};
use crate::winstt::tts::local_engines::{
    piper_voice_infos, ChatterboxLocalEngine, KittenLocalEngine, PiperLocalEngine,
    SupertonicLocalEngine, CHATTERBOX_VOICES, KITTEN_VOICES, SUPERTONIC_VOICES,
};
use crate::winstt::tts::phonemize::{
    ensure_espeak_runtime, espeak_runtime_available, espeak_runtime_pack,
    ESPEAK_RUNTIME_COMPONENT_ID, ESPEAK_RUNTIME_COMPONENT_LABEL,
};
use crate::winstt::tts::supertonic::SUPERTONIC_LANGUAGES;
use crate::winstt::tts::{
    clamp_speed, classify_cloud_status, parse_cloud_voices, parse_detail_status, split_sentences,
    CloudVoiceSettings, ElevenLabsEngine, KokoroLocalEngine, LocalTtsConfig, SynthesisChunk,
    TtsDevice, TtsEngine, TtsError, TtsResult, TtsSource, VoiceInfo, DEFAULT_MAX_SENTENCE_LEN,
    ELEVENLABS_SUBSCRIPTION_URL, ELEVENLABS_VOICES_URL, KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES,
};

mod chunk_sink;
mod payloads;

use chunk_sink::{chunk_payload, kitten_model_filename, EmitChunkSink};
pub use payloads::*;

/// Live engine + the source it was built for + the settings it was built from.
/// Re-picked (lazily, per call) when `tts.source` / voice / key changes — so the
/// command layer never has to remember to call `reload_engine`.
struct ActiveEngine {
    source: TtsSource,
    /// Fingerprint of the settings the engine was built from. When this changes
    /// (source / cloud key / model / device), we rebuild the engine.
    fingerprint: String,
    engine: Arc<dyn TtsEngine>,
}

/// Tauri-state TTS manager. Owns the active engine, serializes synthesis, drives
/// sentence-by-sentence reads, and forwards chunks to the renderer.
pub struct TtsManager {
    app: AppHandle,
    active: Mutex<ActiveEngine>,
    /// request_id → shared cancel flag. The flag is the SAME `Arc<AtomicBool>` the
    /// active read's sink polls between chunks, so a `cancel` flips it mid-read.
    cancelled: Mutex<HashMap<String, Arc<AtomicBool>>>,
    seq: AtomicU64,
    /// Serializes synthesis (Kokoro sessions are not re-entrant).
    synth_lock: Mutex<()>,
    /// Live read-aloud speed (f32 bits). `read_aloud` samples this PER SENTENCE so
    /// the pill's mid-read speed change (`tts_set_speed`) applies to the NEXT
    /// sentence at natural pitch ("next-sentence" — `tts.ts` `handleSetSpeed`).
    current_speed: AtomicU32,
    /// Local-model idle tracking shared with the global model unload timeout.
    active_reads: AtomicU32,
    last_used_ms: AtomicU64,
    idle_watcher_started: AtomicBool,
    /// Coalesces TTS engine warmups by engine fingerprint and remembers resident warm sessions.
    lifecycle: ModelSwapCoordinator,
    /// Shared reqwest client for the cloud catalog / subscription GETs.
    http: reqwest::Client,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn tts_idle_unload_duration(timeout: crate::settings::ModelUnloadTimeout) -> Option<Duration> {
    timeout.to_seconds().map(Duration::from_secs)
}

fn tts_engine_key(source: TtsSource, fingerprint: &str) -> String {
    format!("tts:{source:?}:{fingerprint}")
}

struct ActiveTtsUseGuard<'a> {
    manager: &'a TtsManager,
    source: TtsSource,
}

impl<'a> ActiveTtsUseGuard<'a> {
    fn new(manager: &'a TtsManager, source: TtsSource) -> Self {
        manager.active_reads.fetch_add(1, Ordering::AcqRel);
        Self { manager, source }
    }
}

impl Drop for ActiveTtsUseGuard<'_> {
    fn drop(&mut self) {
        self.manager.active_reads.fetch_sub(1, Ordering::AcqRel);
        self.manager.mark_model_used();
        if matches!(self.source, TtsSource::Local)
            && crate::settings::get_settings(&self.manager.app).model_unload_timeout
                == crate::settings::ModelUnloadTimeout::Immediately
        {
            self.manager.unload_active_local_model("immediate timeout");
        }
    }
}

impl TtsManager {
    pub fn new(app: &AppHandle) -> Self {
        // Default to a local Kokoro engine; the first real call reloads from
        // settings (source + voice + key) via `ensure_engine`.
        let engine: Arc<dyn TtsEngine> =
            Arc::new(KokoroLocalEngine::new(LocalTtsConfig::default()));
        Self {
            app: app.clone(),
            active: Mutex::new(ActiveEngine {
                source: TtsSource::Local,
                fingerprint: String::new(),
                engine,
            }),
            cancelled: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            synth_lock: Mutex::new(()),
            current_speed: AtomicU32::new(1.0_f32.to_bits()),
            active_reads: AtomicU32::new(0),
            last_used_ms: AtomicU64::new(now_ms()),
            idle_watcher_started: AtomicBool::new(false),
            lifecycle: ModelSwapCoordinator::new(),
            http: reqwest::Client::new(),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("tts-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Set the live read-aloud speed (clamped). Applies to the active read's
    /// UPCOMING sentences and to every subsequent read until changed. The store
    /// write (`tts.speed` / `tts.cloud.speed`) is the settings command's job.
    pub fn set_speed(&self, speed: f32) {
        self.current_speed
            .store(clamp_speed(speed).to_bits(), Ordering::Relaxed);
    }

    /// The live read-aloud speed sampled by `read_aloud` per sentence.
    pub fn current_speed(&self) -> f32 {
        f32::from_bits(self.current_speed.load(Ordering::Relaxed))
    }

    pub fn start_idle_watcher(self: &Arc<Self>) {
        if self.idle_watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            let timeout = crate::settings::get_settings(&manager.app).model_unload_timeout;
            let Some(max_idle) = tts_idle_unload_duration(timeout) else {
                continue;
            };
            if max_idle.is_zero() || manager.active_reads.load(Ordering::Acquire) != 0 {
                continue;
            }
            let idle_for = Duration::from_millis(
                now_ms().saturating_sub(manager.last_used_ms.load(Ordering::Acquire)),
            );
            if idle_for >= max_idle {
                manager.unload_active_local_model("idle timeout");
            }
        });
    }

    fn mark_model_used(&self) {
        self.last_used_ms.store(now_ms(), Ordering::Release);
    }

    fn unload_active_local_model(&self, reason: &str) {
        if self.active_reads.load(Ordering::Acquire) != 0 {
            return;
        }
        let (engine, warm_key) = {
            let Ok(active) = self.active.lock() else {
                return;
            };
            if !matches!(active.source, TtsSource::Local) || !active.engine.is_ready() {
                return;
            }
            (
                active.engine.clone(),
                tts_engine_key(active.source, &active.fingerprint),
            )
        };
        engine.shutdown();
        self.lifecycle.clear_warm(&warm_key);
        self.mark_model_used();
        log::info!("[tts] local model session dropped ({reason})");
    }

    /// User-requested model removal must drop local TTS sessions even if a read was
    /// active; the normal idle path intentionally waits for active reads.
    pub fn unload_active_local_model_for_cleanup(&self, reason: &str) {
        self.cancel_all();
        let (engine, warm_key) = {
            let Ok(active) = self.active.lock() else {
                return;
            };
            if !matches!(active.source, TtsSource::Local) {
                return;
            }
            (
                active.engine.clone(),
                tts_engine_key(active.source, &active.fingerprint),
            )
        };
        engine.shutdown();
        self.lifecycle.clear_warm(&warm_key);
        self.mark_model_used();
        log::info!("[tts] local model session dropped ({reason})");
    }

    // ── settings ───────────────────────────────────────────────────────────

    /// True when TTS is enabled in settings. The the reference `handleSpeak` throws
    /// `"TTS is disabled in settings"` when this is false.
    pub fn is_enabled(&self) -> bool {
        read_settings(&self.app).tts.enabled
    }

    /// True when synthesis should be served by ElevenLabs cloud (not Kokoro).
    pub fn is_cloud_source(&self) -> bool {
        matches!(
            read_settings(&self.app).tts.source,
            SettingsTtsSource::Cloud
        )
    }

    /// Resolve the local Kokoro config from settings (voice / lang / speed +
    /// the STT model device, which TTS shares — memory
    /// `project_tts_device_follows_model_device`). `model.device` is `Auto`
    /// (DirectML with CPU fallback) or `Cpu`. Kokoro now lives under its catalog
    /// id's per-model cache dir (`tts/kokoro-82m/`), same as the other engines.
    fn local_config(&self) -> LocalTtsConfig {
        let s = read_settings(&self.app);
        let device = match s.model.device {
            DeviceType::Cpu => TtsDevice::Cpu,
            DeviceType::Auto => TtsDevice::Auto,
        };
        LocalTtsConfig {
            cache_dir: self.model_cache_dir(&s.tts.model),
            voice: s.tts.voice,
            lang: s.tts.lang,
            speed: s.tts.speed as f32,
            device,
            ..LocalTtsConfig::default()
        }
    }

    /// Resolve cloud (ElevenLabs) inputs from settings: the shared
    /// `integrations.elevenlabs.apiKey` + `tts.cloud.*` tuning.
    fn cloud_config(&self) -> (String, String, CloudVoiceSettings) {
        let s = read_settings(&self.app);
        let key = s.integrations.elevenlabs.api_key;
        let model = s.tts.cloud.model;
        let settings = CloudVoiceSettings {
            stability: s.tts.cloud.stability as f32,
            similarity: s.tts.cloud.similarity as f32,
            style: s.tts.cloud.style as f32,
            speaker_boost: s.tts.cloud.speaker_boost,
            speed: s.tts.cloud.speed as f32,
        };
        (key, model, settings)
    }

    /// Fingerprint the engine-relevant settings so `ensure_engine` rebuilds only
    /// when the source / key / model / device actually changes (voice/lang/speed
    /// are passed per-call to the engine, so they don't force a rebuild).
    fn engine_fingerprint(&self) -> (TtsSource, String) {
        let s = read_settings(&self.app);
        let device_tag = match s.model.device {
            DeviceType::Cpu => "cpu",
            DeviceType::Auto => "auto",
        };
        match s.tts.source {
            SettingsTtsSource::Local => (
                TtsSource::Local,
                format!("local|{}|{device_tag}", s.tts.model),
            ),
            SettingsTtsSource::Cloud => (
                TtsSource::Cloud,
                format!(
                    "cloud|{}|{}",
                    s.integrations.elevenlabs.api_key, s.tts.cloud.model
                ),
            ),
        }
    }

    /// Per-model cache dir (`%LOCALAPPDATA%/winstt/tts/<model-id>/`) — matches the
    /// TTS download manager's layout so the engine loads what the manager fetched.
    fn model_cache_dir(&self, model_id: &str) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tts")
            .join(model_id)
    }

    /// Build the local engine for the selected `tts.model` catalog id. Kokoro keeps
    /// its existing cache layout (`local_config`); the new ONNX engines load from
    /// their per-model cache dir (populated by the TTS download manager).
    fn build_local_engine(&self) -> Arc<dyn TtsEngine> {
        let model_id = read_settings(&self.app).tts.model;
        match catalog::find(&model_id).map(|e| e.engine) {
            Some(TtsEngineId::Kitten) => Arc::new(KittenLocalEngine::new(
                self.model_cache_dir(&model_id),
                kitten_model_filename(&model_id),
            )),
            // Piper is ONE multilingual model whose voice (`tts.voice`) selects which
            // `{stem}.onnx` to load; the engine lazily warms per-voice and the
            // download manager fetches the selected voice's files on demand.
            Some(TtsEngineId::Piper) => {
                Arc::new(PiperLocalEngine::new(self.model_cache_dir(&model_id)))
            }
            Some(TtsEngineId::Supertonic) => {
                Arc::new(SupertonicLocalEngine::new(self.model_cache_dir(&model_id)))
            }
            Some(TtsEngineId::Chatterbox) => {
                Arc::new(ChatterboxLocalEngine::new(self.model_cache_dir(&model_id)))
            }
            // Kokoro (and any unknown id) → the existing Kokoro engine + cache.
            _ => Arc::new(KokoroLocalEngine::new(self.local_config())),
        }
    }

    fn selected_local_engine_needs_espeak(&self) -> bool {
        let model_id = read_settings(&self.app).tts.model;
        let engine = catalog::find(&model_id)
            .map(|e| e.engine)
            .unwrap_or(TtsEngineId::Kokoro);
        matches!(
            engine,
            TtsEngineId::Kokoro | TtsEngineId::Kitten | TtsEngineId::Piper
        )
    }

    fn ensure_espeak_runtime_for_selected_model(&self, emit_install_events: bool) -> TtsResult<()> {
        if !self.selected_local_engine_needs_espeak() || espeak_runtime_available() {
            return Ok(());
        }
        if emit_install_events {
            self.emit_event(
                "tts:install-status",
                serde_json::json!({ "phase": "engine" }),
            );
            self.emit_event("tts:model-download-start", serde_json::json!({}));
        }
        let app = self.app.clone();
        let result = ensure_espeak_runtime(|progress, downloaded, total| {
            if emit_install_events {
                let _ = app.emit(
                    "tts:model-download-progress",
                    serde_json::json!({
                        "progress": progress,
                        "downloadedBytes": downloaded,
                        "totalBytes": total,
                    }),
                );
            }
        });
        match result {
            Ok(_) => {
                if emit_install_events {
                    self.emit_event(
                        "tts:model-download-complete",
                        serde_json::json!({ "cancelled": false }),
                    );
                }
                Ok(())
            }
            Err(e) => {
                let reason = format!("eSpeak NG runtime install failed: {e}");
                if emit_install_events {
                    self.emit_event(
                        "tts:model-download-complete",
                        serde_json::json!({ "cancelled": false }),
                    );
                    self.emit_event(
                        "tts:install-failed",
                        serde_json::json!({
                            "reason": reason,
                            "category": "INSTALL_REQUIRED",
                        }),
                    );
                }
                Err(TtsError::Download(reason))
            }
        }
    }

    /// Ensure the selected local model's assets are on disk, downloading via the
    /// TTS download manager (emitting progress) if missing. Kokoro self-downloads
    /// inside its own engine, so it is skipped here.
    fn ensure_local_model_assets(&self) -> TtsResult<()> {
        let model_id = read_settings(&self.app).tts.model;
        let Some(entry) = catalog::find(&model_id) else {
            return Ok(());
        };
        let quant = entry.default_quant();
        let dl = self.app.state::<Arc<TtsDownloadManager>>();
        if dl.is_present(&model_id, quant) {
            return Ok(());
        }
        dl.download_blocking(&model_id, quant, true)
            .map_err(|e| match e {
                TtsDownloadErr::Cancelled => TtsError::Cancelled,
                TtsDownloadErr::Paused => TtsError::Paused,
                other => TtsError::Download(other.to_string()),
            })?;
        let _ = self.app.emit(
            "tts:model-cache-changed",
            serde_json::json!({ "modelId": model_id }),
        );
        Ok(())
    }

    /// Lazily (re)build the active engine to match the current settings. Returns
    /// the engine + its source. Cheap when nothing changed (fingerprint match).
    fn ensure_engine(&self) -> (TtsSource, Arc<dyn TtsEngine>, String) {
        let (source, fingerprint) = self.engine_fingerprint();
        let mut a = self.active.lock().expect("tts active engine lock");
        let mut outgoing: Option<Arc<dyn TtsEngine>> = None;
        if a.fingerprint != fingerprint || a.source != source {
            let old_fp = a.fingerprint.clone();
            let old_source = a.source;
            self.lifecycle
                .clear_warm(&tts_engine_key(old_source, &old_fp));
            let engine: Arc<dyn TtsEngine> = match source {
                TtsSource::Local => self.build_local_engine(),
                TtsSource::Cloud => {
                    let (key, model, settings) = self.cloud_config();
                    Arc::new(ElevenLabsEngine::new(key, model, settings))
                }
            };
            // Swap the new engine in and hold the PREVIOUS one so we can free its
            // native ORT session(s) explicitly below — a Chatterbox graph is ~1.6 GB
            // resident, so relying on `Arc`-drop alone would leave the old model
            // wandering in memory if any in-flight synthesis clone still holds a ref.
            log::info!(
                "[tts] engine swap ({old_source:?} '{old_fp}' → {source:?} '{fingerprint}') — unloading previous model"
            );
            outgoing = Some(std::mem::replace(&mut a.engine, engine));
            a.source = source;
            a.fingerprint = fingerprint;
        }
        let result = (
            a.source,
            a.engine.clone(),
            tts_engine_key(a.source, &a.fingerprint),
        );
        // Release the active lock BEFORE shutting the old engine down: `shutdown()`
        // takes the engine's own inner lock and may briefly wait on an in-flight
        // synthesis, which must not also be holding `active`.
        drop(a);
        if let Some(old) = outgoing {
            // Deterministically drop the loaded session NOW (sets the engine's inner
            // state to None behind its own lock); a stale clone simply lazily re-warms
            // instead of pinning the previous model's memory.
            old.shutdown();
            log::info!("[tts] previous engine session dropped (unloaded)");
        }
        result
    }

    pub fn source(&self) -> TtsSource {
        self.active
            .lock()
            .map(|a| a.source)
            .unwrap_or(TtsSource::Local)
    }

    // ── voice catalogs ──────────────────────────────────────────────────────

    /// Raw 54-voice list (used by the bare-array command if any).
    pub fn list_voices(&self) -> Vec<VoiceInfo> {
        KOKORO_VOICE_CATALOG.to_vec()
    }

    /// `{ voices, languages }` — the `TtsVoiceCatalog` the local picker renders
    /// (mirrors the reference `handleListVoices`, which returns `{ voices, languages }`).
    pub fn list_voices_catalog(&self, model_id: Option<String>) -> VoiceCatalogPayload {
        // Pick the voice set for the requested (or currently-selected) local model.
        let model_id = model_id.unwrap_or_else(|| read_settings(&self.app).tts.model);
        let selected_engine = catalog::find(&model_id).map(|e| e.engine);
        let voices_src: Vec<VoiceInfo> = match selected_engine {
            Some(TtsEngineId::Kitten) => KITTEN_VOICES.to_vec(),
            // Piper exposes its full curated multilingual voice list (one good voice
            // per language); each voice downloads on demand when selected.
            Some(TtsEngineId::Piper) => piper_voice_infos(),
            Some(TtsEngineId::Supertonic) => SUPERTONIC_VOICES.to_vec(),
            Some(TtsEngineId::Chatterbox) => CHATTERBOX_VOICES.to_vec(),
            _ => KOKORO_VOICE_CATALOG.to_vec(),
        };
        let voices = voices_src
            .iter()
            .map(|v| LocalVoicePayload {
                id: v.id.to_string(),
                label: v.label.to_string(),
                language: v.language.to_string(),
                gender: v.gender.as_str().to_string(),
            })
            .collect();
        let language_src = match selected_engine {
            Some(TtsEngineId::Supertonic) => SUPERTONIC_LANGUAGES,
            _ => SUPPORTED_LANGUAGES,
        };
        let languages = language_src
            .iter()
            .map(|(code, label)| LanguagePayload {
                code: code.to_string(),
                label: label.to_string(),
            })
            .collect();
        VoiceCatalogPayload { voices, languages }
    }

    /// Live ElevenLabs `GET /v2/voices` (includes the account's cloned voices).
    /// Never throws across the IPC boundary — returns `{ voices: [], error }` when
    /// the key is missing / invalid / the request fails (mirrors the reference
    /// `handleCloudListVoices`).
    pub async fn list_cloud_voices(&self) -> CloudVoiceCatalogPayload {
        let key = read_settings(&self.app).integrations.elevenlabs.api_key;
        if key.is_empty() {
            return CloudVoiceCatalogPayload {
                voices: Vec::new(),
                error: Some("ElevenLabs API key not configured".to_string()),
            };
        }
        let result = self
            .http
            .get(ELEVENLABS_VOICES_URL)
            .header("xi-api-key", &key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;
        let resp = match result {
            Ok(r) => r,
            Err(e) => {
                return CloudVoiceCatalogPayload {
                    voices: Vec::new(),
                    error: Some(format!("ElevenLabs voices request failed: {e}")),
                };
            }
        };
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return CloudVoiceCatalogPayload {
                voices: Vec::new(),
                error: Some(classify_cloud_status(
                    status,
                    parse_detail_status(&body).as_deref(),
                )),
            };
        }
        let voices = parse_cloud_voices(&body)
            .into_iter()
            .map(|v| CloudVoicePayload {
                id: v.id,
                name: v.name,
                language: v.language,
                category: v.category.unwrap_or_else(|| "premade".to_string()),
                preview_url: v.preview_url,
            })
            .collect();
        CloudVoiceCatalogPayload {
            voices,
            error: None,
        }
    }

    /// `GET /v1/user/subscription` → `{ tier, creditsExhausted }`. Both default to
    /// "unknown / false" on a missing-scope key or request failure so we never
    /// wrongly block cloud TTS on data we couldn't read (mirrors the reference
    /// `handleCloudSubscription`). `creditsExhausted` is true only when the monthly
    /// character quota is spent AND can't overflow (`can_extend_character_limit`).
    pub async fn cloud_subscription(&self) -> CloudSubscriptionPayload {
        let key = read_settings(&self.app).integrations.elevenlabs.api_key;
        if key.is_empty() {
            return CloudSubscriptionPayload {
                tier: None,
                credits_exhausted: false,
            };
        }
        let result = self
            .http
            .get(ELEVENLABS_SUBSCRIPTION_URL)
            .header("xi-api-key", &key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;
        let resp = match result {
            Ok(r) if r.status().is_success() => r,
            _ => {
                return CloudSubscriptionPayload {
                    tier: None,
                    credits_exhausted: false,
                };
            }
        };
        let json: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => {
                return CloudSubscriptionPayload {
                    tier: None,
                    credits_exhausted: false,
                };
            }
        };
        let tier = json
            .get("tier")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let used = json.get("character_count").and_then(|v| v.as_u64());
        let limit = json.get("character_limit").and_then(|v| v.as_u64());
        let can_extend = json
            .get("can_extend_character_limit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let credits_exhausted =
            matches!((used, limit), (Some(u), Some(l)) if u >= l) && !can_extend;
        CloudSubscriptionPayload {
            tier,
            credits_exhausted,
        }
    }

    // ── install / download estimate ─────────────────────────────────────────

    /// Side-effect-free estimate of what enabling LOCAL Kokoro TTS will download:
    /// the two model files (`kokoro-v1.0.fp16.onnx`, `voices-v1.0.bin`). Mirrors
    /// the reference `handleDownloadEstimate` shape (`{ alreadyInstalled, components,
    /// totalBytes, unavailable? }`). Cloud has no local engine, so it reports
    /// `alreadyInstalled: true` with no components.
    pub async fn download_estimate(&self) -> DownloadEstimatePayload {
        // Cloud source has nothing local to install — never gate it on disk files.
        if self.is_cloud_source() {
            return DownloadEstimatePayload {
                already_installed: true,
                components: Vec::new(),
                total_bytes: 0,
                unavailable: false,
            };
        }
        // Estimate from the TTS catalog (per-model HF download size), the espeak
        // runtime pack (when the selected engine needs it), and the download
        // manager's on-disk cache state for the SELECTED model.
        let model_id = read_settings(&self.app).tts.model;
        let Some(entry) = catalog::find(&model_id) else {
            return DownloadEstimatePayload {
                already_installed: false,
                components: Vec::new(),
                total_bytes: 0,
                unavailable: true,
            };
        };
        let quant = entry.default_quant();
        let dl = self.app.state::<Arc<TtsDownloadManager>>();
        let installed = dl.is_present(&model_id, quant);
        let total = entry.quant(quant).map(|q| q.size_bytes).unwrap_or(0);
        let mut components = Vec::new();
        let mut unavailable = false;
        if matches!(
            entry.engine,
            TtsEngineId::Kokoro | TtsEngineId::Kitten | TtsEngineId::Piper
        ) {
            let runtime_installed = espeak_runtime_available();
            let runtime_bytes = espeak_runtime_pack().map(|p| p.size_bytes).unwrap_or(0);
            unavailable = !runtime_installed && espeak_runtime_pack().is_none();
            components.push(DownloadComponent {
                id: ESPEAK_RUNTIME_COMPONENT_ID.to_string(),
                label: ESPEAK_RUNTIME_COMPONENT_LABEL.to_string(),
                bytes: runtime_bytes,
                installed: runtime_installed,
            });
        }
        components.push(DownloadComponent {
            id: model_id.clone(),
            label: entry.display_name.to_string(),
            bytes: total,
            installed,
        });
        let total_bytes = components
            .iter()
            .filter(|c| !c.installed)
            .map(|c| c.bytes)
            .sum();
        DownloadEstimatePayload {
            already_installed: components.iter().all(|c| c.installed),
            components,
            total_bytes,
            unavailable,
        }
    }

    /// Force engine warm-up off the UI thread (download + session create / key
    /// check). Cloud is a no-op warm-up (key check only). The command runs this
    /// via `spawn_blocking`.
    pub fn warm_up(&self) -> TtsResult<()> {
        loop {
            let (target_source, target_fingerprint) = self.engine_fingerprint();
            let target_key = tts_engine_key(target_source, &target_fingerprint);
            if self.lifecycle.is_warm(&target_key) {
                log::debug!("[tts] warm-up skipped — engine '{target_key}' is already warm");
                return Ok(());
            }
            let Some(_claim) = self.lifecycle.try_claim(target_key.clone()) else {
                self.lifecycle.wait_for_idle(&target_key);
                if self.lifecycle.is_warm(&target_key) {
                    return Ok(());
                }
                continue;
            };

            // Cloud has no local graph to warm; `warm_up` just checks the key.
            if matches!(target_source, TtsSource::Local) {
                self.ensure_espeak_runtime_for_selected_model(true)?;
            }
            let (source, engine, engine_key) = self.ensure_engine();
            if engine_key != target_key {
                // Settings changed while the warm claim was being prepared. Drop the claim and
                // restart against the new fingerprint instead of warming a stale engine.
                continue;
            }
            if self.lifecycle.is_warm(&engine_key) {
                return Ok(());
            }
            if matches!(source, TtsSource::Local) {
                // Download the selected model's assets (with progress) before loading.
                self.emit_event(
                    "tts:install-status",
                    serde_json::json!({ "phase": "model" }),
                );
                if let Err(e) = self.ensure_local_model_assets() {
                    self.emit_event(
                        "tts:install-failed",
                        serde_json::json!({ "reason": e.to_string(), "category": "NETWORK" }),
                    );
                    return Err(e);
                }
            }
            let _synth_guard = match self.synth_lock.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    log::debug!("[tts] warm-up yielded — real synthesis is using '{engine_key}'");
                    self.lifecycle.mark_warm(engine_key);
                    return Ok(());
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    let err =
                        TtsError::Engine("tts synth lock poisoned during warm-up".to_string());
                    if matches!(source, TtsSource::Local) {
                        self.emit_event(
                            "tts:install-failed",
                            serde_json::json!({ "reason": err.to_string(), "category": "ENGINE" }),
                        );
                    }
                    return Err(err);
                }
            };
            let _active_use = ActiveTtsUseGuard::new(self, source);
            match engine.warm_up() {
                Ok(()) => {
                    self.lifecycle.mark_warm(engine_key);
                    if matches!(source, TtsSource::Local) {
                        self.emit_event(
                            "tts:install-status",
                            serde_json::json!({ "phase": "ready" }),
                        );
                    }
                    return Ok(());
                }
                Err(e) => {
                    if matches!(source, TtsSource::Local) {
                        self.emit_event(
                            "tts:install-failed",
                            serde_json::json!({ "reason": e.to_string(), "category": "ENGINE" }),
                        );
                    }
                    return Err(e);
                }
            }
        }
    }

    // ── cancellation ────────────────────────────────────────────────────────

    fn cancel_flag(&self, request_id: &str) -> Arc<AtomicBool> {
        let mut m = self.cancelled.lock().expect("tts cancel lock");
        m.entry(request_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Cancel one in-flight read. Flips the shared cooperative flag the active
    /// read's sink polls AND optimistically emits a cancelled `tts:completed` so
    /// the renderer's Web Audio queue stops IMMEDIATELY (the cooperative flag is a
    /// no-op when generation already finished and the audio is only buffered
    /// client-side, but the buffered audio must still stop). Mirrors `tts.ts`
    /// `cancel(requestId)`.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(m) = self.cancelled.lock() {
            if let Some(flag) = m.get(request_id) {
                flag.store(true, Ordering::Release);
            }
        }
        self.emit_event(
            "tts:completed",
            serde_json::json!({ "requestId": request_id, "cancelled": true, "elapsedMs": null }),
        );
    }

    /// Cancel every in-flight read (STT force-stop / app exit / the stop gesture).
    /// Emits a cancelled `tts:completed` per tracked request plus a wildcard (empty
    /// id) so a queue that never saw a `tts:started` still stops. Mirrors `tts.ts`
    /// `cancel()` (no id).
    pub fn cancel_all(&self) {
        let ids: Vec<String> = if let Ok(m) = self.cancelled.lock() {
            for flag in m.values() {
                flag.store(true, Ordering::Release);
            }
            m.keys().cloned().collect()
        } else {
            Vec::new()
        };
        for id in ids {
            self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": id, "cancelled": true, "elapsedMs": null }),
            );
        }
        // Wildcard fallback for the case where no id was ever tracked (the stop
        // gesture fires before the first `tts:started`).
        self.emit_event(
            "tts:completed",
            serde_json::json!({ "requestId": "", "cancelled": true, "elapsedMs": null }),
        );
    }

    fn drop_request(&self, request_id: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.remove(request_id);
        }
    }

    pub fn fail_request(&self, request_id: &str, reason: &str) {
        self.drop_request(request_id);
        self.emit_event(
            "tts:failed",
            serde_json::json!({ "requestId": request_id, "reason": reason }),
        );
    }

    // ── lifecycle emit ──────────────────────────────────────────────────────

    /// Emit a plain lifecycle event with the EXACT WinSTT IPC shape (camelCase
    /// keys) so the reused renderer's `onTtsStarted`/`onTtsCompleted`/`onTtsFailed`
    /// listeners fire unchanged. The adapter maps `TTS_STARTED`→`tts:started`, etc.
    fn emit_event(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    // ── reads ───────────────────────────────────────────────────────────────

    /// Read `text` aloud sentence-by-sentence under ONE `request_id` so the
    /// renderer plays it gap-free. Each chunk forwards to `tts://chunk`. `get_speed`
    /// is sampled per sentence (mid-read speed change → NEXT sentence). Blocking —
    /// the command runs it on a worker.
    ///
    /// Enforces the reference `handleSpeak` contract: throws (emits `tts:failed`)
    /// when TTS is disabled; routes synthesis to the active source's engine (local
    /// Kokoro or cloud ElevenLabs); fills voice/lang from settings when the call
    /// omits them. Emits exactly one terminal `tts:completed` / `tts:failed` after
    /// `tts:started`.
    pub fn read_aloud(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
    ) {
        // Register a shared cancel flag BEFORE `tts:started` so a cancel arriving
        // immediately after start flips THIS read's flag (and `cancel_all` lists it).
        let cancel = self.cancel_flag(request_id);

        // Enabled-gate (the reference throws `ValidationError("TTS is disabled …")`).
        if !self.is_enabled() {
            self.drop_request(request_id);
            self.emit_event(
                "tts:started",
                serde_json::json!({ "requestId": request_id }),
            );
            self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": "TTS is disabled in settings" }),
            );
            return;
        }

        let started = std::time::Instant::now();
        self.emit_event(
            "tts:started",
            serde_json::json!({ "requestId": request_id }),
        );

        if !self.is_cloud_source() {
            if let Err(e) = self.ensure_espeak_runtime_for_selected_model(true) {
                self.drop_request(request_id);
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
                );
                return;
            }
        }

        let (source, engine, engine_key) = self.ensure_engine();
        // Auto-download the selected local model's assets (with progress) before
        // synthesizing — mirrors the STT first-use download. Kokoro self-downloads.
        if matches!(source, TtsSource::Local) {
            if let Err(e) = self.ensure_local_model_assets() {
                self.drop_request(request_id);
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
                );
                return;
            }
        }
        // Fill voice/lang from settings when the caller omitted them (the renderer's
        // `ttsSpeak` passes them, but the hotkey path may not).
        let s = read_settings(&self.app);
        let (eff_voice, eff_lang) = match source {
            TtsSource::Local => (
                if voice.is_empty() {
                    s.tts.voice.clone()
                } else {
                    voice.to_string()
                },
                if lang.is_empty() {
                    s.tts.lang.clone()
                } else {
                    lang.to_string()
                },
            ),
            TtsSource::Cloud => (
                if voice.is_empty() {
                    s.tts.cloud.voice.clone()
                } else {
                    voice.to_string()
                },
                String::new(),
            ),
        };

        // Lazily fetch the requested local voice if it wasn't in the (small) model
        // download — Kokoro ships only its default voice and pulls the other 53
        // per-voice on first use. No-op for already-cached voices, cloning models,
        // and the bundled-voice engines. A fetch failure surfaces as a synth failure
        // rather than silently producing nothing (the prior "voice doesn't respond").
        if matches!(source, TtsSource::Local) {
            let dl = self.app.state::<Arc<TtsDownloadManager>>();
            if let Err(e) = dl.ensure_voice(&s.tts.model, &eff_voice) {
                self.drop_request(request_id);
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": format!("voice download failed: {e}") }),
                );
                return;
            }
        }

        let _active_use = ActiveTtsUseGuard::new(self, source);

        let _guard = match self.synth_lock.lock() {
            Ok(g) => g,
            Err(_) => {
                self.drop_request(request_id);
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": "tts synth lock poisoned" }),
                );
                return;
            }
        };

        let sink = EmitChunkSink {
            app: self.app.clone(),
            request_id: request_id.to_string(),
            cancelled: cancel.clone(),
            last_chunk: Mutex::new(None),
            seq: AtomicU64::new(0),
        };
        let sentences = split_sentences(text, DEFAULT_MAX_SENTENCE_LEN);
        let mut result: TtsResult<()> = Ok(());
        for sentence in sentences {
            if cancel.load(Ordering::Acquire) {
                result = Err(TtsError::Cancelled);
                break;
            }
            let speed = clamp_speed(get_speed());
            if let Err(e) = engine.synthesize_stream(&sentence, &eff_voice, &eff_lang, speed, &sink)
            {
                result = Err(e);
                break;
            }
        }
        // Flush the held-back final chunk with is_final=true (so the renderer queue
        // markComplete()s exactly once at the true end of the read).
        sink.flush_final();

        self.drop_request(request_id);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match &result {
            Ok(()) => {
                self.lifecycle.mark_warm(engine_key);
                self.emit_event(
                    "tts:completed",
                    serde_json::json!({ "requestId": request_id, "cancelled": false, "elapsedMs": elapsed_ms }),
                );
            }
            Err(TtsError::Cancelled) => self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": request_id, "cancelled": true, "elapsedMs": elapsed_ms }),
            ),
            Err(e) => self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            ),
        }
    }

    /// Play a cloud voice's FREE pre-generated sample (`preview_url`) instead of
    /// synthesizing — browsing voices costs no ElevenLabs credits. Fetches the mp3
    /// (key-free, https-only) and forwards it as ONE `tts://chunk` (mp3) under the
    /// same `tts:started`/`tts:completed`/`tts:failed` lifecycle a real read uses.
    /// Mirrors `tts.ts` `handleCloudPreview` + `previewCloudClip`. Blocking — the
    /// command runs it on a worker.
    pub fn read_preview_url(&self, request_id: &str, preview_url: &str) {
        let cancel = self.cancel_flag(request_id);
        let started = std::time::Instant::now();
        self.emit_event(
            "tts:started",
            serde_json::json!({ "requestId": request_id }),
        );

        // The CDN preview is key-free; build a throwaway cloud engine for the https
        // GET (it refuses non-https). No synth lock — this is a plain download.
        let engine = ElevenLabsEngine::new(
            String::new(),
            "eleven_multilingual_v2".to_string(),
            CloudVoiceSettings::default(),
        );
        let result = engine.fetch_preview(preview_url);
        let was_cancelled = cancel.load(Ordering::Acquire);
        self.drop_request(request_id);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(bytes) if !was_cancelled && !bytes.is_empty() => {
                let payload = chunk_payload(request_id, &SynthesisChunk::mp3(bytes, 0, true));
                let _ = self.app.emit("tts://chunk", payload);
                self.emit_event(
                    "tts:completed",
                    serde_json::json!({ "requestId": request_id, "cancelled": false, "elapsedMs": elapsed_ms }),
                );
            }
            Ok(_) => self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": request_id, "cancelled": was_cancelled, "elapsedMs": elapsed_ms }),
            ),
            Err(e) => self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            ),
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ModelUnloadTimeout;

    #[test]
    fn tts_idle_unload_duration_uses_shared_core_timeout_table() {
        assert_eq!(tts_idle_unload_duration(ModelUnloadTimeout::Never), None);
        assert_eq!(
            tts_idle_unload_duration(ModelUnloadTimeout::Immediately),
            Some(Duration::from_secs(0))
        );
        assert_eq!(
            tts_idle_unload_duration(ModelUnloadTimeout::Min5),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            tts_idle_unload_duration(ModelUnloadTimeout::Hour1),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            tts_idle_unload_duration(ModelUnloadTimeout::Sec15),
            Some(Duration::from_secs(15))
        );
    }
}
