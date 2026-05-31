// PORT IMPL — Source: app/PORT/06_tts.md + lib_wiring.md §2,
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
// 1:1 with the Electron `tts.ts` orchestrator:
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

use tauri::{AppHandle, Emitter};

use crate::winstt::commands::settings::read_settings;
use crate::winstt::settings_schema::{DeviceType, TtsSource as SettingsTtsSource};
use crate::winstt::tts::{
    classify_cloud_status, clamp_speed, parse_cloud_voices, parse_detail_status, split_sentences,
    ChunkSink, CloudVoiceSettings, ElevenLabsEngine, Format, KokoroLocalEngine, LocalTtsConfig,
    SynthesisChunk, TtsDevice, TtsEngine, TtsError, TtsResult, TtsSource, VoiceInfo,
    DEFAULT_MAX_SENTENCE_LEN, ELEVENLABS_SUBSCRIPTION_URL, ELEVENLABS_VOICES_URL,
    KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES,
};

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

/// One cloud voice surfaced to the renderer cloud-voice picker — the EXACT
/// `CloudTtsVoice` wire shape (`{ id, name, language, category, previewUrl }`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoicePayload {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub category: String,
    pub preview_url: Option<String>,
}

/// `{ voices, error }` — the `CloudTtsVoiceCatalog` wire shape (`ttsCloudListVoices`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoiceCatalogPayload {
    pub voices: Vec<CloudVoicePayload>,
    pub error: Option<String>,
}

/// `{ tier, creditsExhausted }` — the `ttsCloudSubscription` wire shape.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscriptionPayload {
    pub tier: Option<String>,
    pub credits_exhausted: bool,
}

/// One install component — `{ id, label, bytes, installed }` (the estimate dialog).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadComponent {
    pub id: String,
    pub label: String,
    pub bytes: u64,
    pub installed: bool,
}

/// `{ alreadyInstalled, components, totalBytes, unavailable? }` —
/// the `TtsDownloadEstimatePayload` wire shape (`ttsDownloadEstimate`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEstimatePayload {
    pub already_installed: bool,
    pub components: Vec<DownloadComponent>,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "is_false")]
    pub unavailable: bool,
}

/// `skip_serializing_if` predicate so `unavailable: false` is omitted (the
/// renderer's `TtsDownloadEstimatePayload.unavailable` is optional).
fn is_false(b: &bool) -> bool {
    !*b
}

/// `{ voices, languages }` — the `TtsVoiceCatalog` wire shape (`listTtsVoices`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogPayload {
    pub voices: Vec<LocalVoicePayload>,
    pub languages: Vec<LanguagePayload>,
}

/// One local Kokoro voice — `{ id, label, language, gender }`.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoicePayload {
    pub id: String,
    pub label: String,
    pub language: String,
    pub gender: String,
}

/// One language `{ code, label }`.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePayload {
    pub code: String,
    pub label: String,
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
    /// Shared reqwest client for the cloud catalog / subscription GETs.
    http: reqwest::Client,
}

impl TtsManager {
    pub fn new(app: &AppHandle) -> Self {
        // Default to a local Kokoro engine; the first real call reloads from
        // settings (source + voice + key) via `ensure_engine`.
        let engine: Arc<dyn TtsEngine> = Arc::new(KokoroLocalEngine::new(LocalTtsConfig::default()));
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

    // ── settings ───────────────────────────────────────────────────────────

    /// True when TTS is enabled in settings. The Electron `handleSpeak` throws
    /// `"TTS is disabled in settings"` when this is false.
    pub fn is_enabled(&self) -> bool {
        read_settings(&self.app).tts.enabled
    }

    /// True when synthesis should be served by ElevenLabs cloud (not Kokoro).
    pub fn is_cloud_source(&self) -> bool {
        matches!(read_settings(&self.app).tts.source, SettingsTtsSource::Cloud)
    }

    fn cache_dir(&self) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tts")
            .join("kokoro")
    }

    /// Resolve the local Kokoro config from settings (voice / lang / speed +
    /// the STT model device, which TTS shares — memory
    /// `project_tts_device_follows_model_device`). `model.device` is `Auto`
    /// (DirectML with CPU fallback) or `Cpu`.
    fn local_config(&self) -> LocalTtsConfig {
        let s = read_settings(&self.app);
        let device = match s.model.device {
            DeviceType::Cpu => TtsDevice::Cpu,
            DeviceType::Auto => TtsDevice::Auto,
        };
        LocalTtsConfig {
            cache_dir: self.cache_dir(),
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
                format!("local|{device_tag}"),
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

    /// Lazily (re)build the active engine to match the current settings. Returns
    /// the engine + its source. Cheap when nothing changed (fingerprint match).
    fn ensure_engine(&self) -> (TtsSource, Arc<dyn TtsEngine>) {
        let (source, fingerprint) = self.engine_fingerprint();
        let mut a = self.active.lock().expect("tts active engine lock");
        if a.fingerprint != fingerprint || a.source != source {
            let engine: Arc<dyn TtsEngine> = match source {
                TtsSource::Local => Arc::new(KokoroLocalEngine::new(self.local_config())),
                TtsSource::Cloud => {
                    let (key, model, settings) = self.cloud_config();
                    Arc::new(ElevenLabsEngine::new(key, model, settings))
                }
            };
            a.source = source;
            a.fingerprint = fingerprint;
            a.engine = engine;
        }
        (a.source, a.engine.clone())
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
    /// (mirrors Electron `handleListVoices`, which returns `{ voices, languages }`).
    pub fn list_voices_catalog(&self) -> VoiceCatalogPayload {
        let voices = KOKORO_VOICE_CATALOG
            .iter()
            .map(|v| LocalVoicePayload {
                id: v.id.to_string(),
                label: v.label.to_string(),
                language: v.language.to_string(),
                gender: v.gender.as_str().to_string(),
            })
            .collect();
        let languages = SUPPORTED_LANGUAGES
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
    /// the key is missing / invalid / the request fails (mirrors Electron
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
        CloudVoiceCatalogPayload { voices, error: None }
    }

    /// `GET /v1/user/subscription` → `{ tier, creditsExhausted }`. Both default to
    /// "unknown / false" on a missing-scope key or request failure so we never
    /// wrongly block cloud TTS on data we couldn't read (mirrors Electron
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
        let tier = json.get("tier").and_then(|v| v.as_str()).map(str::to_string);
        let used = json.get("character_count").and_then(|v| v.as_u64());
        let limit = json.get("character_limit").and_then(|v| v.as_u64());
        let can_extend = json
            .get("can_extend_character_limit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let credits_exhausted = matches!((used, limit), (Some(u), Some(l)) if u >= l) && !can_extend;
        CloudSubscriptionPayload {
            tier,
            credits_exhausted,
        }
    }

    // ── install / download estimate ─────────────────────────────────────────

    /// Side-effect-free estimate of what enabling LOCAL Kokoro TTS will download:
    /// the two model files (`kokoro-v1.0.fp16.onnx`, `voices-v1.0.bin`). Mirrors
    /// Electron `handleDownloadEstimate` shape (`{ alreadyInstalled, components,
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
        let cfg = self.local_config().to_kokoro_config_pub();
        let model_present = cfg.model_path().exists();
        let voices_present = cfg.voices_path().exists();
        // Probe the remote content-length for each missing file (HEAD-equivalent
        // via a Range:0-0 GET → Content-Range total). Best-effort; a failed probe
        // marks the estimate unavailable so the dialog says "can't size this".
        let model_bytes = if model_present {
            Some(0)
        } else {
            self.remote_size(&crate::winstt::tts::kokoro::model_url()).await
        };
        let voices_bytes = if voices_present {
            Some(0)
        } else {
            self.remote_size(&crate::winstt::tts::kokoro::voices_url()).await
        };
        // Either probe failing (when the file is actually missing) means we
        // couldn't reach the internet to size the install.
        let unavailable = (!model_present && model_bytes.is_none())
            || (!voices_present && voices_bytes.is_none());
        let components = vec![
            DownloadComponent {
                id: "model".to_string(),
                label: "Kokoro voice model".to_string(),
                bytes: model_bytes.unwrap_or(0),
                installed: model_present,
            },
            DownloadComponent {
                id: "voices".to_string(),
                label: "Voicepacks".to_string(),
                bytes: voices_bytes.unwrap_or(0),
                installed: voices_present,
            },
        ];
        let total_bytes = components
            .iter()
            .filter(|c| !c.installed)
            .map(|c| c.bytes)
            .sum();
        DownloadEstimatePayload {
            already_installed: model_present && voices_present,
            components,
            total_bytes,
            unavailable,
        }
    }

    /// Probe a remote file's total byte size via a 1-byte Range GET (reads
    /// `Content-Range: bytes 0-0/<total>`), falling back to `Content-Length`.
    /// Returns `None` on any transport / header-parse failure.
    async fn remote_size(&self, url: &str) -> Option<u64> {
        let resp = self
            .http
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .ok()?;
        if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
            if let Some(total) = cr.to_str().ok().and_then(|s| s.rsplit('/').next()) {
                if let Ok(n) = total.trim().parse::<u64>() {
                    return Some(n);
                }
            }
        }
        resp.content_length()
    }

    /// Force engine warm-up off the UI thread (download + session create / key
    /// check). Cloud is a no-op warm-up (key check only). The command runs this
    /// via `spawn_blocking`.
    pub fn warm_up(&self) -> TtsResult<()> {
        // Cloud has no Kokoro engine to warm — `warm_up` just checks the key.
        let (_source, engine) = self.ensure_engine();
        engine.warm_up()
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
    /// Enforces the Electron `handleSpeak` contract: throws (emits `tts:failed`)
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

        // Enabled-gate (Electron throws `ValidationError("TTS is disabled …")`).
        if !self.is_enabled() {
            self.drop_request(request_id);
            self.emit_event("tts:started", serde_json::json!({ "requestId": request_id }));
            self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": "TTS is disabled in settings" }),
            );
            return;
        }

        let started = std::time::Instant::now();
        self.emit_event("tts:started", serde_json::json!({ "requestId": request_id }));

        let (source, engine) = self.ensure_engine();
        // Fill voice/lang from settings when the caller omitted them (the renderer's
        // `ttsSpeak` passes them, but the hotkey path may not).
        let s = read_settings(&self.app);
        let (eff_voice, eff_lang) = match source {
            TtsSource::Local => (
                if voice.is_empty() { s.tts.voice.clone() } else { voice.to_string() },
                if lang.is_empty() { s.tts.lang.clone() } else { lang.to_string() },
            ),
            TtsSource::Cloud => (
                if voice.is_empty() { s.tts.cloud.voice.clone() } else { voice.to_string() },
                String::new(),
            ),
        };

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
            if let Err(e) = engine.synthesize_stream(&sentence, &eff_voice, &eff_lang, speed, &sink) {
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
            Ok(()) => self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": request_id, "cancelled": false, "elapsedMs": elapsed_ms }),
            ),
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
        self.emit_event("tts:started", serde_json::json!({ "requestId": request_id }));

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

/// Build the `tts://chunk` event payload. `pcm` carries RAW BYTES the renderer
/// interprets PER FORMAT:
///   - "f32le": `new Float32Array(pcm)` reads it as little-endian f32 PCM.
///   - "mp3":   `decodeAudioData(pcm)` decodes the mp3 container.
/// (Serde serializes the `Vec<u8>` as a JSON number array; the adapter reshapes
/// it back to an `ArrayBuffer` — see WU-5 risks.)
fn chunk_payload(request_id: &str, chunk: &SynthesisChunk) -> serde_json::Value {
    let pcm_bytes: Vec<u8> = match chunk.format {
        Format::F32le => {
            let mut bytes = Vec::with_capacity(chunk.audio.len() * 4);
            for sample in chunk.audio.iter() {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            bytes
        }
        Format::Mp3 => chunk.encoded.to_vec(),
    };
    serde_json::json!({
        "requestId": request_id,
        "sampleRate": chunk.sample_rate,
        "seq": chunk.seq,
        "isFinal": chunk.is_final,
        "format": chunk.format.as_str(),
        "channels": chunk.channels,
        "pcm": pcm_bytes,
    })
}

/// A `ChunkSink` that emits each synthesized chunk to the renderer over the
/// `tts://chunk` event, with a DELAY-ONE-CHUNK buffer so the LAST chunk of the
/// whole read can carry `is_final = true` (the renderer's queue `markComplete()`s
/// exactly once on that flag). Polls a shared cancel flag between sentences.
struct EmitChunkSink {
    app: AppHandle,
    request_id: String,
    cancelled: Arc<AtomicBool>,
    /// The previously-pushed chunk, held back until the next one arrives so we can
    /// stamp `is_final` on the true last chunk.
    last_chunk: Mutex<Option<SynthesisChunk>>,
    /// Monotonic per-read seq for the chunk stream.
    seq: AtomicU64,
}

impl EmitChunkSink {
    fn emit(&self, chunk: &SynthesisChunk) {
        let _ = self.app.emit("tts://chunk", chunk_payload(&self.request_id, chunk));
    }

    /// Emit the held-back chunk (if any) with `is_final = true`. Called once at the
    /// end of a read so the renderer queue closes the request exactly once.
    fn flush_final(&self) {
        if let Ok(mut held) = self.last_chunk.lock() {
            if let Some(mut chunk) = held.take() {
                chunk.is_final = true;
                self.emit(&chunk);
            }
        }
    }
}

impl ChunkSink for EmitChunkSink {
    fn push(&self, mut chunk: SynthesisChunk) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        // Skip empty (silent) chunks so the renderer never schedules a zero-length
        // buffer — matches the facade's `samples.is_empty() → continue`.
        let empty = match chunk.format {
            Format::F32le => chunk.audio.is_empty(),
            Format::Mp3 => chunk.encoded.is_empty(),
        };
        if empty {
            return true;
        }
        chunk.seq = self.seq.fetch_add(1, Ordering::Relaxed);
        chunk.is_final = false;
        // Delay-one-chunk: flush the previously-held chunk (NOT final — another came
        // after), and hold THIS one until the next push / flush_final.
        if let Ok(mut held) = self.last_chunk.lock() {
            if let Some(prev) = held.replace(chunk) {
                self.emit(&prev);
            }
        }
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}
