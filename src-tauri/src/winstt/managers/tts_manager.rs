// Tauri-state wrapper around winstt::tts.
//
// The `tts` slice already defines the engine port (`TtsEngine`), the local Kokoro
// + cloud ElevenLabs engines, the 54-voice catalog, sentence splitter, and the
// HTTP helpers (voices / subscription / preview). This wrapper is the *Tauri-state*
// object: constructed with `new(&AppHandle)`, it re-picks the active engine from
// `tts.source` (+ voice/lang/key/tuning), bridges synthesis chunks to the
// `tts:chunk` event, fires the `tts:started`/`tts:completed`/`tts:failed`
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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::cloud_stt::{
    CloudSttProvider, classify_cloud_failure_message, emit_cloud_failure,
};
use crate::winstt::managers::tts_download_manager::{TtsDownloadErr, TtsDownloadManager};
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::settings_schema::{
    DeviceType, TtsCloudProvider, TtsSource as SettingsTtsSource, WinsttSettings,
};
use crate::winstt::settings_store::{read_settings, read_settings_raw};
use crate::winstt::sync_ext::MutexExt;
use crate::winstt::tts::catalog::{self, TtsEngineId};
use crate::winstt::tts::local_engines::{
    AUDIO8_VOICES, Audio8LocalEngine, CHATTERBOX_VOICES, ChatterboxLocalEngine, KITTEN_VOICES,
    KittenLocalEngine, NEUTTS_VOICE_INFOS, NeuTtsLocalEngine, OMNIVOICE_VOICES,
    ORPHEUS_VOICE_INFOS, OmniVoiceLocalEngine, OrpheusLocalEngine, PiperLocalEngine,
    QWEN3TTS_CUSTOMVOICE_VOICES, QWEN3TTS_VOICES, Qwen3TtsLocalEngine, SPARK_VOICE_INFOS,
    SUPERTONIC_VOICES, SparkLocalEngine, SupertonicLocalEngine, piper_voice_infos,
};
use crate::winstt::tts::phonemize::{
    ESPEAK_RUNTIME_COMPONENT_ID, ESPEAK_RUNTIME_COMPONENT_LABEL, EspeakCliPhonemizer, Phonemizer,
    ensure_espeak_runtime, espeak_runtime_available, espeak_runtime_pack,
};
use crate::winstt::tts::qwen3_tts::Qwen3TtsVoiceMode;
use crate::winstt::tts::supertonic::SUPERTONIC_LANGUAGES;
use crate::winstt::tts::{
    CloudVoiceSettings, DEFAULT_MAX_SENTENCE_LEN, ELEVENLABS_SUBSCRIPTION_URL,
    ELEVENLABS_VOICES_URL, ElevenLabsEngine, KOKORO_VOICE_CATALOG, KokoroLocalEngine,
    LocalTtsConfig, OpenRouterTtsEngine, SUPPORTED_LANGUAGES, SynthesisChunk, TtsDevice, TtsEngine,
    TtsError, TtsResult, TtsSource, VoiceInfo, clamp_cloud_speed, clamp_speed_to_range,
    classify_cloud_status, parse_cloud_voices, parse_detail_status, split_sentences,
};

mod chunk_sink;
mod payloads;

use chunk_sink::{CapturedTtsAudio, EmitChunkSink, TtsAudioCapture, chunk_payload};
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
    /// In-flight read cancellation. Each read holds the SAME `CancellationToken`
    /// its sink polls between chunks, so a `cancel` fires it mid-read.
    cancelled: CancelRegistry,
    seq: AtomicU64,
    /// Serializes synthesis (Kokoro sessions are not re-entrant).
    synth_lock: Mutex<()>,
    /// Live read-aloud speed (f32 bits). `read_aloud` samples this PER SENTENCE so
    /// the pill's mid-read speed change (`tts_set_speed`) applies to the NEXT
    /// sentence at natural pitch ("next-sentence" — `tts.ts` `handleSetSpeed`).
    current_speed: AtomicU32,
    /// Local-model idle tracking shared with the global model unload timeout.
    active_reads: AtomicU32,
    last_used_at: Mutex<Instant>,
    idle_unload_timeout: crate::settings::AtomicModelUnloadTimeout,
    idle_watcher_started: AtomicBool,
    /// Lifecycle edge for the idle watcher. The atomics / engine readiness stay
    /// the source of truth; this only tells the watcher to recompute its exact
    /// deadline after use, policy, load, or shutdown changes that state.
    idle_state_changed: tokio::sync::Notify,
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

const OPENROUTER_PREVIEW_TEXT: &str = "This is a WinSTT voice preview.";

fn tts_idle_unload_duration(timeout: crate::settings::ModelUnloadTimeout) -> Option<Duration> {
    timeout.to_seconds().map(Duration::from_secs)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TtsIdleWatcherAction {
    WaitForChange,
    WaitUntil(Instant),
    Unload,
}

fn tts_idle_watcher_action(
    timeout: crate::settings::ModelUnloadTimeout,
    active_reads: u32,
    local_model_ready: bool,
    last_used_at: Instant,
    now: Instant,
) -> TtsIdleWatcherAction {
    if active_reads != 0 || !local_model_ready {
        return TtsIdleWatcherAction::WaitForChange;
    }
    let Some(max_idle) = tts_idle_unload_duration(timeout) else {
        return TtsIdleWatcherAction::WaitForChange;
    };
    let Some(deadline) = last_used_at.checked_add(max_idle) else {
        return TtsIdleWatcherAction::WaitForChange;
    };
    if deadline <= now {
        TtsIdleWatcherAction::Unload
    } else {
        TtsIdleWatcherAction::WaitUntil(deadline)
    }
}

fn tts_engine_key(source: TtsSource, fingerprint: &str) -> String {
    format!("tts:{source:?}:{fingerprint}")
}

/// Precision the engine loads for `model_id`: the persisted `tts.quantization`
/// when it's a concrete pick the model actually publishes, else the catalog
/// default. Shared by the engine build and the asset-ensure so the files that
/// get downloaded are the files that get loaded (only Qwen3-TTS ships a ladder).
/// How a Qwen3-TTS catalog row reads `tts.voice`. The VoiceDesign checkpoint has no
/// preset bank (`voice_design: true`, `num_voices: 0`) and treats it as an instruct
/// prompt; every other Qwen3-TTS row is a CustomVoice checkpoint whose `voice` names one
/// of its preset timbres. Driven off the catalog facets so a future checkpoint needs no
/// code change here.
fn qwen3_tts_voice_mode(model_id: &str) -> Qwen3TtsVoiceMode {
    match catalog::find(model_id) {
        Some(entry) if entry.voice_design => Qwen3TtsVoiceMode::DesignPrompt,
        _ => Qwen3TtsVoiceMode::PresetSpeaker,
    }
}

fn resolve_selected_quant(model_id: &str, settings_quant: &str) -> String {
    match catalog::find(model_id) {
        Some(entry) if !settings_quant.is_empty() && entry.quant(settings_quant).is_some() => {
            settings_quant.to_string()
        }
        Some(entry) => entry.default_quant().to_string(),
        None => settings_quant.to_string(),
    }
}

/// Resolve which cloud-TTS provider to ACTUALLY use. The persisted
/// `tts.cloud.provider` can outlive its key — the renderer defaults the field to
/// `elevenlabs` before any key exists, and a key can later be removed — so
/// trusting it verbatim strands read-aloud on an unreachable provider (the bug:
/// `provider = elevenlabs` while only an OpenRouter key is set made every read
/// fail "no ElevenLabs API key", and the hotkey path do nothing). Honour the
/// persisted choice when its key is present; otherwise fall back to whichever
/// provider IS keyed. Mirrors the renderer's `cloudProvider` resolution so the
/// engine the backend builds matches the picker the user sees. Neither keyed →
/// keep the persisted value so the engine surfaces the matching "add a key"
/// error instead of silently picking one.
fn effective_cloud_provider(s: &WinsttSettings) -> TtsCloudProvider {
    let eleven_keyed = !s.integrations.elevenlabs.api_key.trim().is_empty();
    let openrouter_keyed = !s.llm.openrouter_api_key.trim().is_empty();
    match s.tts.cloud.provider {
        TtsCloudProvider::Openrouter if openrouter_keyed => TtsCloudProvider::Openrouter,
        TtsCloudProvider::Elevenlabs if eleven_keyed => TtsCloudProvider::Elevenlabs,
        _ if openrouter_keyed => TtsCloudProvider::Openrouter,
        _ if eleven_keyed => TtsCloudProvider::Elevenlabs,
        other => other,
    }
}

/// Whether a system `espeak-ng` CLI is on PATH (cross-platform). Probes the same
/// binary the CLI phonemizer would shell out to (honoring `ESPEAK_NG_BIN` /
/// `WINSTT_ESPEAK_NG`) via a cheap `--version` call. Used to relax the espeak
/// gate for CLI-capable engines (Kokoro/Kitten) when the in-process shared lib is
/// absent, so the engine's CLI fallback can run instead of dropping the request.
fn espeak_cli_available() -> bool {
    EspeakCliPhonemizer::default().is_available()
}

/// Plain-string event (mirrors `tts:failed`): cloud TTS is unreachable AND no local voice pack is
/// installed to fall back to. The renderer localizes `reason` and surfaces an offline notice.
pub const TTS_UNAVAILABLE: &str = "tts:unavailable";

/// The smallest fully-cached local TTS model to fall back to when cloud is offline, or `None` when
/// no local voice pack is installed. Synchronous — TTS cache state is a plain on-disk file check
/// (`TtsDownloadManager::is_present`), no HF scan needed.
/// Write a captured read-aloud session into the recordings dir and return the
/// basename to store on the history row. Local f32 streams become an i16 WAV at
/// the engine's own rate; cloud mp3 streams are written verbatim. Returns
/// `None` (row saved without audio) when the write fails.
fn write_tts_capture(
    recordings_dir: &std::path::Path,
    captured: CapturedTtsAudio,
) -> Option<String> {
    // Millis + payload size disambiguates back-to-back runs without a counter.
    let stamp = now_ms();
    let (file_name, write_result) = match captured.format {
        crate::winstt::tts::Format::F32le => {
            let name = format!("tts-{stamp}-{}.wav", captured.pcm.len());
            let result = crate::audio_toolkit::save_wav_file_with_spec(
                recordings_dir.join(&name),
                &captured.pcm,
                captured.sample_rate,
                captured.channels,
            )
            .map_err(|e| e.to_string());
            (name, result)
        }
        crate::winstt::tts::Format::Mp3 => {
            let name = format!("tts-{stamp}-{}.mp3", captured.mp3.len());
            let result = std::fs::write(recordings_dir.join(&name), &captured.mp3)
                .map_err(|e| e.to_string());
            (name, result)
        }
    };
    match write_result {
        Ok(()) => Some(file_name),
        Err(err) => {
            log::warn!("[tts] failed to save session audio {file_name}: {err}");
            None
        }
    }
}

fn resolve_local_tts_fallback(app: &AppHandle) -> Option<String> {
    let dl = app.state::<Arc<TtsDownloadManager>>();
    let mut best: Option<(u64, &'static str)> = None;
    for entry in catalog::TTS_CATALOG {
        for q in entry.quants {
            if dl.is_present(entry.id, q.id) && best.is_none_or(|(size, _)| q.size_bytes < size) {
                best = Some((q.size_bytes, entry.id));
            }
        }
    }
    best.map(|(_, id)| id.to_string())
}

struct ActiveTtsUseGuard<'a> {
    manager: &'a TtsManager,
    source: TtsSource,
}

impl<'a> ActiveTtsUseGuard<'a> {
    fn new(manager: &'a TtsManager, source: TtsSource) -> Self {
        manager.active_reads.fetch_add(1, Ordering::AcqRel);
        manager.notify_idle_state_changed();
        Self { manager, source }
    }
}

impl Drop for ActiveTtsUseGuard<'_> {
    fn drop(&mut self) {
        self.manager.active_reads.fetch_sub(1, Ordering::AcqRel);
        self.manager.record_model_used_now();
        if matches!(self.source, TtsSource::Local) && self.manager.idle_unload_is_immediate() {
            self.manager.unload_active_local_model("immediate timeout");
        }
        self.manager.notify_idle_state_changed();
    }
}

impl TtsManager {
    pub fn new(app: &AppHandle) -> Self {
        // Start with a placeholder local Kokoro engine; the first real call
        // reloads source/voice/key via `ensure_engine`. Live speed is different:
        // the hotkey reads the atomic directly, so seed it from persisted settings.
        let engine: Arc<dyn TtsEngine> =
            Arc::new(KokoroLocalEngine::new(LocalTtsConfig::default()));
        let persisted = read_settings_raw(app);
        let idle_unload_timeout = crate::winstt::commands::settings::core_timeout_from_winstt(
            persisted.global.model_unload_timeout,
        );
        let current_speed =
            clamp_speed_to_range(Self::configured_speed_from(&persisted), (0.4, 2.0));
        Self {
            app: app.clone(),
            active: Mutex::new(ActiveEngine {
                source: TtsSource::Local,
                fingerprint: String::new(),
                engine,
            }),
            cancelled: CancelRegistry::new(),
            seq: AtomicU64::new(1),
            synth_lock: Mutex::new(()),
            current_speed: AtomicU32::new(current_speed.to_bits()),
            active_reads: AtomicU32::new(0),
            last_used_at: Mutex::new(Instant::now()),
            idle_unload_timeout: crate::settings::AtomicModelUnloadTimeout::new(
                idle_unload_timeout,
            ),
            idle_watcher_started: AtomicBool::new(false),
            idle_state_changed: tokio::sync::Notify::new(),
            lifecycle: ModelSwapCoordinator::new(),
            // Shared pooled client (cheap Arc clone) — voice catalog /
            // subscription fetches ride the same ElevenLabs connections as the
            // synthesis engines.
            http: crate::winstt::net::http_client().clone(),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("tts-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Set the live read-aloud speed (clamped). Applies to the active read's
    /// UPCOMING sentences and to every subsequent read until changed. The store
    /// write (`tts.speed` / `tts.cloud.speed`) is the settings command's job.
    pub fn set_speed(&self, speed: f32) {
        // Store the union of local engine ranges. The active engine performs the
        // final per-sentence clamp below; pre-clamping to Kokoro's 0.5 floor made
        // Supertonic's supported 0.4 setting unreachable from the hotkey path.
        self.current_speed.store(
            clamp_speed_to_range(speed, (0.4, 2.0)).to_bits(),
            Ordering::Relaxed,
        );
    }

    /// The live read-aloud speed sampled by `read_aloud` per sentence.
    pub fn current_speed(&self) -> f32 {
        f32::from_bits(self.current_speed.load(Ordering::Relaxed))
    }

    /// Speed persisted for the currently selected source. The read-aloud hotkey
    /// samples `current_speed`, so startup and settings-save paths must seed it
    /// from this exact source-specific field rather than always starting at 1.0.
    pub(crate) fn configured_speed_from(settings: &WinsttSettings) -> f32 {
        match settings.tts.source {
            SettingsTtsSource::Local => settings.tts.speed as f32,
            SettingsTtsSource::Cloud => settings.tts.cloud.speed as f32,
        }
    }

    pub fn start_idle_watcher(self: &Arc<Self>) {
        if self.idle_watcher_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                // Register the wake before reading state. A notification racing
                // the snapshot is then either delivered to this waiter or kept
                // as a permit, so no lifecycle edge can be lost.
                let state_changed = manager.idle_state_changed.notified();
                match manager.idle_watcher_action() {
                    TtsIdleWatcherAction::WaitForChange => state_changed.await,
                    TtsIdleWatcherAction::WaitUntil(deadline) => {
                        tokio::select! {
                            () = tokio::time::sleep_until(deadline.into()) => {}
                            () = state_changed => {}
                        }
                    }
                    TtsIdleWatcherAction::Unload => {
                        let unloading = Arc::clone(&manager);
                        if let Err(err) = tauri::async_runtime::spawn_blocking(move || {
                            unloading.unload_active_local_model("idle timeout");
                        })
                        .await
                        {
                            log::warn!("[tts] idle unload task failed: {err}");
                        }
                    }
                }
            }
        });
    }

    fn notify_idle_state_changed(&self) {
        self.idle_state_changed.notify_one();
    }

    fn record_model_used_now(&self) {
        *self.last_used_at.lock_recover() = Instant::now();
    }

    fn mark_model_used(&self) {
        self.record_model_used_now();
        self.notify_idle_state_changed();
    }

    fn idle_watcher_action(&self) -> TtsIdleWatcherAction {
        let local_model_ready = self.active.lock().is_ok_and(|active| {
            matches!(active.source, TtsSource::Local) && active.engine.is_ready()
        });
        tts_idle_watcher_action(
            self.idle_unload_timeout.load(),
            self.active_reads.load(Ordering::Acquire),
            local_model_ready,
            *self.last_used_at.lock_recover(),
            Instant::now(),
        )
    }

    fn idle_unload_is_immediate(&self) -> bool {
        self.idle_unload_timeout.load() == crate::settings::ModelUnloadTimeout::Immediately
    }

    pub fn update_idle_unload_timeout(&self, timeout: crate::settings::ModelUnloadTimeout) {
        self.idle_unload_timeout.store(timeout);
        if timeout == crate::settings::ModelUnloadTimeout::Immediately {
            self.unload_active_local_model("immediate timeout");
        }
        self.notify_idle_state_changed();
    }

    fn unload_active_local_model(&self, reason: &str) {
        if self.active_reads.load(Ordering::Acquire) != 0 {
            return;
        }
        let started = Instant::now();
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
        log::debug!("[tts] local model session dropped ({reason})");
        crate::log_model_duration(&format!("tts unload active local ({reason})"), started);
    }

    /// User-requested model removal must drop local TTS sessions even if a read was
    /// active; the normal idle path intentionally waits for active reads.
    pub fn unload_active_local_model_for_cleanup(&self, reason: &str) {
        self.cancel_all();
        let started = Instant::now();
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
        log::debug!("[tts] local model session dropped ({reason})");
        crate::log_model_duration(&format!("tts unload active local ({reason})"), started);
    }

    // ── settings ───────────────────────────────────────────────────────────

    /// True when TTS is enabled in settings. The reference `handleSpeak` throws
    /// `"TTS is disabled in settings"` when this is false.
    pub fn is_enabled(&self) -> bool {
        read_settings_raw(&self.app).tts.enabled
    }

    /// True when synthesis should be served by ElevenLabs cloud (not Kokoro).
    pub fn is_cloud_source(&self) -> bool {
        matches!(
            read_settings_raw(&self.app).tts.source,
            SettingsTtsSource::Cloud
        )
    }

    fn read_tts_runtime_settings(&self) -> WinsttSettings {
        let settings = read_settings_raw(&self.app);
        if matches!(settings.tts.source, SettingsTtsSource::Cloud) {
            read_settings(&self.app)
        } else {
            settings
        }
    }

    /// Resolve the local Kokoro config from settings (voice / lang / speed +
    /// the STT model device, which TTS shares — memory
    /// `project_tts_device_follows_model_device`). `model.device` is `Auto`
    /// (DirectML with CPU fallback) or `Cpu`. Kokoro now lives under its catalog
    /// id's per-model cache dir (`tts/kokoro-82m/`), same as the other engines.
    fn local_config_from(&self, settings: &WinsttSettings) -> LocalTtsConfig {
        let device = match settings.model.device {
            DeviceType::Cpu => TtsDevice::Cpu,
            DeviceType::Auto => TtsDevice::Auto,
        };
        LocalTtsConfig {
            cache_dir: self.model_cache_dir(&settings.tts.model),
            voice: settings.tts.voice.clone(),
            lang: settings.tts.lang.clone(),
            speed: settings.tts.speed as f32,
            device,
            ..LocalTtsConfig::default()
        }
    }

    /// Resolve OpenRouter cloud-TTS inputs: the SHARED `llm.openrouterApiKey` +
    /// the selected `tts.cloud.openrouterModel`. Voice is passed per-call.
    fn openrouter_tts_config(&self) -> (String, String) {
        let s = read_settings(&self.app);
        (s.llm.openrouter_api_key, s.tts.cloud.openrouter_model)
    }

    /// Change-detector for a cloud credential. The fingerprint below is logged
    /// (engine swap at INFO / warm-up lines) and lands in the shareable diagnostic
    /// bundle, so the key itself must never appear in it — same discipline as
    /// `settings_transfer::redact_secret`. A truncated digest is enough: the
    /// fingerprint is only ever compared for equality, in memory, within one
    /// process (`ActiveEngine.fingerprint` + the `lifecycle` warm map), so it is
    /// never persisted and needs no migration.
    fn secret_tag(key: &str) -> String {
        let key = key.trim();
        if key.is_empty() {
            return "nokey".to_string();
        }
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(key.as_bytes());
        digest[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Fingerprint the engine-relevant settings so `ensure_engine` rebuilds only
    /// when construction-time inputs actually change. Local voice/lang/speed and
    /// cloud voice/speed are passed per call. ElevenLabs tuning parameters are
    /// captured by the engine constructor, so they are part of its fingerprint.
    fn engine_fingerprint_from(settings: &WinsttSettings) -> (TtsSource, String) {
        let device_tag = match settings.model.device {
            DeviceType::Cpu => "cpu",
            DeviceType::Auto => "auto",
        };
        match settings.tts.source {
            SettingsTtsSource::Local => (
                TtsSource::Local,
                // Quant is part of the fingerprint so a quant swap (only Qwen3-TTS
                // ships a ladder today) rebuilds the engine; other engines carry an
                // empty quant, leaving their fingerprint unchanged. `clone_ref_text` is
                // included so editing a Spark clone reference transcript rebuilds the
                // engine (it's a construction-time field); empty for every other engine,
                // so their fingerprint is unaffected. `voice_instruct` likewise, for the
                // rows whose prompt carries a dedicated instruct span (OmniVoice).
                format!(
                    "local|{}|{device_tag}|{}|{}|{}",
                    settings.tts.model,
                    settings.tts.quantization,
                    settings.tts.clone_ref_text,
                    settings.tts.voice_instruct
                ),
            ),
            SettingsTtsSource::Cloud => match effective_cloud_provider(settings) {
                TtsCloudProvider::Elevenlabs => (
                    TtsSource::Cloud,
                    format!(
                        "cloud|elevenlabs|{}|{}|{}|{}|{}|{}",
                        Self::secret_tag(&settings.integrations.elevenlabs.api_key),
                        settings.tts.cloud.model,
                        settings.tts.cloud.stability,
                        settings.tts.cloud.similarity,
                        settings.tts.cloud.style,
                        settings.tts.cloud.speaker_boost
                    ),
                ),
                TtsCloudProvider::Openrouter => (
                    TtsSource::Cloud,
                    format!(
                        "cloud|openrouter|{}|{}",
                        Self::secret_tag(&settings.llm.openrouter_api_key),
                        settings.tts.cloud.openrouter_model
                    ),
                ),
            },
        }
    }

    /// Per-model cache dir (`%LOCALAPPDATA%/winstt/tts/<model-id>/`) — matches the
    /// TTS download manager's layout so the engine loads what the manager fetched.
    fn model_cache_dir(&self, model_id: &str) -> PathBuf {
        crate::winstt::tts::cache_dir(&self.app, model_id)
    }

    /// Build the local engine for the selected `tts.model` catalog id. Kokoro keeps
    /// its existing cache layout (`local_config`); the new ONNX engines load from
    /// their per-model cache dir (populated by the TTS download manager).
    fn build_local_engine_for(&self, settings: &WinsttSettings) -> Arc<dyn TtsEngine> {
        let model_id = settings.tts.model.clone();
        match catalog::find(&model_id).map(|e| e.engine) {
            Some(TtsEngineId::Kitten) => Arc::new(KittenLocalEngine::new(
                self.model_cache_dir(&model_id),
                catalog::kitten_model_file(&model_id),
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
            // Chatterbox (multilingual / turbo / nano): the persisted `tts.quantization`
            // picks the rung; the per-graph filenames for that rung come from the catalog
            // (each export quantizes its four graphs independently — nano mixes three
            // precisions in one set).
            Some(TtsEngineId::Chatterbox) => Arc::new(ChatterboxLocalEngine::new(
                self.model_cache_dir(&model_id),
                &model_id,
                &resolve_selected_quant(&model_id, &settings.tts.quantization),
            )),
            // Qwen3-TTS Voice Design: the persisted `tts.quantization` selects the
            // weights precision (int4|fp16|fp32); empty falls back to the catalog's
            // default quant (int4). The engine treats `tts.voice` as the design prompt.
            Some(TtsEngineId::Qwen3Tts) => Arc::new(Qwen3TtsLocalEngine::new(
                self.model_cache_dir(&model_id),
                resolve_selected_quant(&model_id, &settings.tts.quantization),
                qwen3_tts_voice_mode(&model_id),
            )),
            // Orpheus (3B Llama → SNAC) + Spark (Qwen0.5B → BiCodec): CPU-pinned LLM-codec
            // engines that load their ONNX from the per-model cache dir populated by the
            // download manager. `tts.voice` = preset voice id (Orpheus) / gender (Spark).
            Some(TtsEngineId::Orpheus) => {
                Arc::new(OrpheusLocalEngine::new(self.model_cache_dir(&model_id)))
            }
            Some(TtsEngineId::Spark) => Arc::new(SparkLocalEngine::new(
                self.model_cache_dir(&model_id),
                settings.tts.clone_ref_text.clone(),
            )),
            // NeuTTS-2e (Qwen3 → NeuCodec): the persisted `tts.quantization` picks the rung
            // (int8|fp32), which selects BOTH the backbone graph and the matching NeuCodec
            // decoder. `tts.voice` is a `{speaker}-{emotion}` id.
            Some(TtsEngineId::NeuTts) => Arc::new(NeuTtsLocalEngine::new(
                self.model_cache_dir(&model_id),
                resolve_selected_quant(&model_id, &settings.tts.quantization),
            )),
            // OmniVoice: single fp32 rung, so no quant plumbing. `tts.voice` is either the
            // "default" sentinel or a reference-clip path; `tts.clone_ref_text` carries that
            // clip's transcript and is already part of the engine fingerprint, so editing the
            // transcript rebuilds the engine.
            Some(TtsEngineId::OmniVoice) => Arc::new(OmniVoiceLocalEngine::new(
                self.model_cache_dir(&model_id),
                settings.tts.clone_ref_text.clone(),
                settings.tts.voice_instruct.clone(),
            )),
            // Audio8: single int4 rung, so no quant plumbing. `tts.voice` is either the
            // "default" sentinel or a reference-clip path; `tts.clone_ref_text` carries the
            // clip's transcript (the DualAR prompt needs it) and is already part of the
            // engine fingerprint, so editing the transcript rebuilds the engine.
            Some(TtsEngineId::Audio8) => Arc::new(Audio8LocalEngine::new(
                self.model_cache_dir(&model_id),
                settings.tts.clone_ref_text.clone(),
            )),
            // Kokoro (and any unknown id) → the existing Kokoro engine + cache.
            _ => Arc::new(KokoroLocalEngine::new(self.local_config_from(settings))),
        }
    }

    fn selected_local_engine_needs_espeak_for(settings: &WinsttSettings) -> bool {
        let model_id = &settings.tts.model;
        let engine = catalog::find(model_id).map_or(TtsEngineId::Kokoro, |e| e.engine);
        matches!(
            engine,
            TtsEngineId::Kokoro | TtsEngineId::Kitten | TtsEngineId::Piper
        )
    }

    /// Whether the selected engine can fall back to a system `espeak-ng` CLI (or
    /// the Null phonemizer) when the in-process shared lib is absent. Kokoro and
    /// Kitten build their G2P via `default_phonemizer()` (lib → CLI → null), so a
    /// CLI on PATH is enough. Piper phonemizes exclusively through the shared lib
    /// (`EspeakLibPhonemizer`), so it always needs the lib.
    fn selected_engine_accepts_cli_for(settings: &WinsttSettings) -> bool {
        let model_id = &settings.tts.model;
        let engine = catalog::find(model_id).map_or(TtsEngineId::Kokoro, |e| e.engine);
        matches!(engine, TtsEngineId::Kokoro | TtsEngineId::Kitten)
    }

    fn ensure_espeak_runtime_for_settings(
        &self,
        settings: &WinsttSettings,
        emit_install_events: bool,
    ) -> TtsResult<()> {
        if !Self::selected_local_engine_needs_espeak_for(settings) || espeak_runtime_available() {
            return Ok(());
        }
        // No in-process shared lib. Where there's a pinned runtime pack (Windows)
        // we keep downloading it — the in-process lib is faster than a per-sentence
        // subprocess. Only where there's no downloadable pack (Unix) do Kokoro/Kitten
        // degrade to a system `espeak-ng` CLI (their phonemizer's built-in fallback),
        // which satisfies the runtime with no download — the common case where
        // `apt install espeak-ng` ships the CLI even when the -dev .so is absent.
        // Piper has no CLI fallback and always needs the lib, so it skips this and
        // falls through to the install-required signal.
        if espeak_runtime_pack().is_none()
            && Self::selected_engine_accepts_cli_for(settings)
            && espeak_cli_available()
        {
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
    fn ensure_local_model_assets_for(&self, settings: &WinsttSettings) -> TtsResult<()> {
        let model_id = settings.tts.model.clone();
        if catalog::find(&model_id).is_none() {
            return Ok(());
        }
        // Fetch the SELECTED precision's files, not the catalog default — a quant
        // swap (Qwen3-TTS int4→fp16) must download the picked variant, otherwise
        // the engine loads a file set the ensure step never fetched.
        let quant_owned = resolve_selected_quant(&model_id, &settings.tts.quantization);
        let quant = quant_owned.as_str();
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
    fn ensure_engine_for(
        &self,
        settings: &WinsttSettings,
    ) -> (TtsSource, Arc<dyn TtsEngine>, String) {
        let (source, fingerprint) = Self::engine_fingerprint_from(settings);
        let mut a = self.active.lock_recover();
        let mut outgoing: Option<Arc<dyn TtsEngine>> = None;
        let mut swap_started: Option<Instant> = None;
        let mut had_previous_engine = false;
        if a.fingerprint != fingerprint || a.source != source {
            swap_started = Some(Instant::now());
            let old_fp = a.fingerprint.clone();
            let old_source = a.source;
            had_previous_engine = !old_fp.is_empty();
            self.lifecycle
                .clear_warm(&tts_engine_key(old_source, &old_fp));
            let engine: Arc<dyn TtsEngine> = match source {
                TtsSource::Local => self.build_local_engine_for(settings),
                TtsSource::Cloud => {
                    let provider = effective_cloud_provider(settings);
                    match provider {
                        // Trim to match `secret_tag`, which fingerprints the TRIMMED
                        // key: otherwise a key pasted with stray whitespace builds an
                        // engine whose header carries it, and deleting the whitespace
                        // later leaves the fingerprint unchanged — no rebuild, broken
                        // engine until restart. `effective_cloud_provider` already
                        // decides "keyed" on the trimmed form.
                        TtsCloudProvider::Elevenlabs => Arc::new(ElevenLabsEngine::new(
                            settings.integrations.elevenlabs.api_key.trim().to_string(),
                            settings.tts.cloud.model.clone(),
                            CloudVoiceSettings {
                                stability: settings.tts.cloud.stability as f32,
                                similarity: settings.tts.cloud.similarity as f32,
                                style: settings.tts.cloud.style as f32,
                                speaker_boost: settings.tts.cloud.speaker_boost,
                                speed: settings.tts.cloud.speed as f32,
                            },
                        )),
                        TtsCloudProvider::Openrouter => Arc::new(OpenRouterTtsEngine::new(
                            settings.llm.openrouter_api_key.trim().to_string(),
                            settings.tts.cloud.openrouter_model.clone(),
                        )),
                    }
                }
            };
            // Swap the new engine in and hold the PREVIOUS one so we can free its
            // native ORT session(s) explicitly below — a Chatterbox graph is ~1.6 GB
            // resident, so relying on `Arc`-drop alone would leave the old model
            // wandering in memory if any in-flight synthesis clone still holds a ref.
            if had_previous_engine {
                log::info!(
                    "[tts] engine swap ({old_source:?} '{old_fp}' -> {source:?} '{fingerprint}'); unloading previous model"
                );
            } else {
                log::debug!("[tts] selected initial engine ({source:?} '{fingerprint}')");
            }
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
            if had_previous_engine {
                log::debug!("[tts] previous engine session dropped (unloaded)");
            }
            if let Some(started) = swap_started {
                crate::log_model_duration("tts engine swap", started);
            }
            self.notify_idle_state_changed();
        }
        result
    }

    pub fn source(&self) -> TtsSource {
        self.active.lock().map_or(TtsSource::Local, |a| a.source)
    }

    // ── voice catalogs ──────────────────────────────────────────────────────

    /// `{ voices, languages }` — the `TtsVoiceCatalog` the local picker renders
    /// (mirrors the reference `handleListVoices`, which returns `{ voices, languages }`).
    pub fn list_voices_catalog(&self, model_id: Option<String>) -> VoiceCatalogPayload {
        // Pick the voice set for the requested (or currently-selected) local model.
        let model_id = model_id.unwrap_or_else(|| read_settings_raw(&self.app).tts.model);
        let selected_engine = catalog::find(&model_id).map(|e| e.engine);
        let voices_src: Vec<VoiceInfo> = match selected_engine {
            Some(TtsEngineId::Kitten) => KITTEN_VOICES.to_vec(),
            // Piper exposes its full curated multilingual voice list (one good voice
            // per language); each voice downloads on demand when selected.
            Some(TtsEngineId::Piper) => piper_voice_infos(),
            Some(TtsEngineId::Supertonic) => SUPERTONIC_VOICES.to_vec(),
            Some(TtsEngineId::Chatterbox) => CHATTERBOX_VOICES.to_vec(),
            // Voice Design has no preset voices — one "Default" entry; the real voice
            // comes from the prompt stored in `tts.voice` (the UI swaps the voice
            // dropdown for a "Design voice" prompt affordance). Custom Voice DOES ship a
            // preset bank (9 timbres), so it renders a normal voice dropdown.
            Some(TtsEngineId::Qwen3Tts) => match qwen3_tts_voice_mode(&model_id) {
                Qwen3TtsVoiceMode::PresetSpeaker => QWEN3TTS_CUSTOMVOICE_VOICES.to_vec(),
                Qwen3TtsVoiceMode::DesignPrompt => QWEN3TTS_VOICES.to_vec(),
            },
            Some(TtsEngineId::Orpheus) => ORPHEUS_VOICE_INFOS.to_vec(),
            Some(TtsEngineId::Spark) => SPARK_VOICE_INFOS.to_vec(),
            // 4 speakers x 7 emotions as flat `{speaker}-{emotion}` ids — see NEUTTS_VOICE_INFOS.
            Some(TtsEngineId::NeuTts) => NEUTTS_VOICE_INFOS.to_vec(),
            // No preset bank — one sentinel entry; the real voice comes from a reference
            // clip, which the ZeroShotAudioText cloning facet surfaces in the dropdown.
            Some(TtsEngineId::OmniVoice) => OMNIVOICE_VOICES.to_vec(),
            Some(TtsEngineId::Audio8) => AUDIO8_VOICES.to_vec(),
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
        let started = std::time::Instant::now();
        let result = self
            .http
            .get(ELEVENLABS_VOICES_URL)
            .header("xi-api-key", &key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;
        crate::winstt::cloud_metrics::record(
            "elevenlabs",
            "tts_voices",
            started.elapsed(),
            result.as_ref().err().map(|e| e.to_string()).as_deref(),
        );
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
        let started = std::time::Instant::now();
        let result = self
            .http
            .get(ELEVENLABS_SUBSCRIPTION_URL)
            .header("xi-api-key", &key)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await;
        crate::winstt::cloud_metrics::record(
            "elevenlabs",
            "tts_subscription",
            started.elapsed(),
            result.as_ref().err().map(|e| e.to_string()).as_deref(),
        );
        let resp = match result {
            Ok(r) if r.status().is_success() => r,
            _ => {
                return CloudSubscriptionPayload {
                    tier: None,
                    credits_exhausted: false,
                };
            }
        };
        /// Typed `/v1/user/subscription` body — just the fields the tier gate reads.
        #[derive(serde::Deserialize)]
        struct SubscriptionResponse {
            tier: Option<String>,
            character_count: Option<u64>,
            character_limit: Option<u64>,
            #[serde(default)]
            can_extend_character_limit: bool,
        }
        let sub: SubscriptionResponse = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                // Keep the fail-soft default (never wrongly block cloud TTS), but surface
                // the parse failure so subscription-schema drift is diagnosable.
                log::warn!("[tts] cloud_subscription response parse failed: {e}");
                return CloudSubscriptionPayload {
                    tier: None,
                    credits_exhausted: false,
                };
            }
        };
        let credits_exhausted = matches!(
            (sub.character_count, sub.character_limit),
            (Some(u), Some(l)) if u >= l
        ) && !sub.can_extend_character_limit;
        CloudSubscriptionPayload {
            tier: sub.tier,
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
        let settings = read_settings_raw(&self.app);
        // Cloud source has nothing local to install — never gate it on disk files.
        if matches!(settings.tts.source, SettingsTtsSource::Cloud) {
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
        let model_id = settings.tts.model;
        let Some(entry) = catalog::find(&model_id) else {
            return DownloadEstimatePayload {
                already_installed: false,
                components: Vec::new(),
                total_bytes: 0,
                unavailable: true,
            };
        };
        // Gate on the SELECTED precision so an fp16 pick isn't reported as
        // "installed" just because the default int4 files happen to be on disk.
        let quant_owned = resolve_selected_quant(&model_id, &settings.tts.quantization);
        let quant = quant_owned.as_str();
        let dl = self.app.state::<Arc<TtsDownloadManager>>();
        let installed = dl.is_present(&model_id, quant);
        let total = entry.quant(quant).map_or(0, |q| q.size_bytes);
        let mut components = Vec::new();
        let mut unavailable = false;
        if matches!(
            entry.engine,
            TtsEngineId::Kokoro | TtsEngineId::Kitten | TtsEngineId::Piper
        ) {
            // Kokoro/Kitten can run off a system espeak-ng CLI when no shared lib
            // AND no downloadable pack is present; Piper needs the lib. Count the
            // CLI as "installed" for the CLI-capable engines so the estimate
            // doesn't demand a nonexistent runtime pack on Unix. Where a pack
            // exists (Windows) the CLI never masks the download.
            let runtime_bytes = espeak_runtime_pack().map_or(0, |p| p.size_bytes);
            let cli_fallback = espeak_runtime_pack().is_none()
                && matches!(entry.engine, TtsEngineId::Kokoro | TtsEngineId::Kitten)
                && espeak_cli_available();
            let runtime_installed = espeak_runtime_available() || cli_fallback;
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
        let warm_started = Instant::now();
        loop {
            let settings = self.read_tts_runtime_settings();
            let (target_source, target_fingerprint) = Self::engine_fingerprint_from(&settings);
            let target_key = tts_engine_key(target_source, &target_fingerprint);
            if self.lifecycle.is_warm(&target_key) {
                log::debug!("[tts] warm-up skipped -- engine '{target_key}' is already warm");
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
                self.ensure_espeak_runtime_for_settings(&settings, true)?;
            }
            let (source, engine, engine_key) = self.ensure_engine_for(&settings);
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
                if let Err(e) = self.ensure_local_model_assets_for(&settings) {
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
                    log::debug!("[tts] warm-up yielded -- real synthesis is using '{engine_key}'");
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
                    // FULL warm-up: `engine.warm_up()` only loads the ONNX graph.
                    // Run one tiny REAL synthesis so the first user read doesn't
                    // pay the kernel-JIT / arena-allocation cost (the "warm up the
                    // compute path, not just VRAM" requirement). Local only —
                    // cloud has no local graph. Non-fatal: the model is loaded
                    // regardless; a failed warm pass just means the first real
                    // read pays the compute-warm cost. Empty voice/lang ⇒ the
                    // engine uses its configured defaults.
                    if matches!(source, TtsSource::Local) {
                        let synth_started = Instant::now();
                        match engine.synthesize_sentence("Warm up.", "", "", 1.0) {
                            Ok(_) => {
                                crate::log_model_duration("tts warm-up synthesis", synth_started)
                            }
                            Err(e) => log::debug!(
                                "[tts] warm-up synthesis pass skipped (graph loaded): {e}"
                            ),
                        }
                    }
                    self.lifecycle.mark_warm(engine_key);
                    crate::log_model_duration("tts warm-up", warm_started);
                    if matches!(source, TtsSource::Local) {
                        self.emit_event(
                            "tts:install-status",
                            serde_json::json!({ "phase": "ready" }),
                        );
                    }
                    return Ok(());
                }
                Err(e) => {
                    crate::log_model_duration("tts warm-up failed", warm_started);
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

    fn cancel_flag(&self, request_id: &str) -> CancellationToken {
        self.cancelled.cancel_token(request_id)
    }

    /// Register `request_id` as in-flight BEFORE synthesis starts, and hand back
    /// its awaitable cancel token.
    ///
    /// `cancel_all` can only mark ids the registry already knows, and a read's id
    /// is otherwise first tracked inside [`Self::read_aloud`]. Anything the caller
    /// does between minting the id and calling `read_aloud` — the inline-tag LLM
    /// round-trip, which can run for the full 60 s voice-LLM timeout — is
    /// therefore uncancellable unless the caller reserves the id here first: Escape
    /// would tear the pill down and the read would still start when the round-trip
    /// finally returned. `select!`ing on the returned token also drops that
    /// in-flight request instead of leaving it running.
    pub fn track_request(&self, request_id: &str) -> CancellationToken {
        self.cancel_flag(request_id)
    }

    /// Has `request_id` been cancelled? Fails SAFE (a poisoned lock reads as
    /// cancelled) — the caller's next step is to start speaking.
    pub fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled.is_cancelled(request_id, true)
    }

    /// Stop tracking a request that will never run (reserved with
    /// [`Self::track_request`], then abandoned), so its id is not held forever.
    pub fn release_request(&self, request_id: &str) {
        self.drop_request(request_id);
    }

    /// Cancel one in-flight read. Fires the shared `CancellationToken` the active
    /// read's sink polls AND optimistically emits a cancelled `tts:completed` so
    /// the renderer's Web Audio queue stops IMMEDIATELY (the cooperative token is a
    /// no-op when generation already finished and the audio is only buffered
    /// client-side, but the buffered audio must still stop). Mirrors `tts.ts`
    /// `cancel(requestId)`.
    pub fn cancel(&self, request_id: &str) {
        self.cancelled.cancel(request_id);
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
        // Snapshot the in-flight ids BEFORE cancelling so each gets its terminal
        // `tts:completed`.
        let ids = self.cancelled.active_ids();
        self.cancelled.cancel_all();
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
        self.cancelled.clear(request_id);
    }

    pub fn fail_request(&self, request_id: &str, reason: &str) {
        self.drop_request(request_id);
        self.record_failure(
            "synthesis",
            "TTS synthesis failed",
            request_id,
            reason,
            None,
            None,
        );
        self.emit_event(
            "tts:failed",
            serde_json::json!({ "requestId": request_id, "reason": reason }),
        );
    }

    fn record_failure(
        &self,
        operation: &str,
        summary: &str,
        request_id: &str,
        reason: &str,
        source: Option<&str>,
        duration_ms: Option<u64>,
    ) {
        let mut issue = crate::winstt::observability::IssueBuilder::new("tts", operation, summary)
            .detail(reason.to_string())
            .request_id(request_id.to_string());
        if let Some(source) = source {
            issue = issue.context("source", source.to_string());
        }
        if let Some(duration_ms) = duration_ms {
            issue = issue.duration_ms(duration_ms);
        }
        issue.record(Some(&self.app));
    }

    fn emit_cloud_tts_failure(&self, provider: CloudSttProvider, context: &str, err: &TtsError) {
        let reason = err.to_string();
        let code = classify_cloud_failure_message(&reason);
        emit_cloud_failure(
            &self.app,
            provider,
            code,
            format!("{context} failed: {reason}"),
            None,
        );
    }

    /// Offline + no-local notice: cloud TTS is unreachable and there is no cached local voice to
    /// fall back to. The renderer localizes `reason` and shows an offline notice on the island.
    fn emit_tts_unavailable(&self, provider: CloudSttProvider, reason: &str) {
        let _ = self.app.emit(
            TTS_UNAVAILABLE,
            serde_json::json!({
                "pipeline": "tts",
                "reason": reason,
                "provider": provider.id(),
            }),
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
    /// renderer plays it gap-free. Each chunk forwards to `tts:chunk`. `get_speed`
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
        let settings = self.read_tts_runtime_settings();

        // Enabled-gate (the reference throws `ValidationError("TTS is disabled …")`).
        if !settings.tts.enabled {
            self.drop_request(request_id);
            self.record_failure(
                "synthesis",
                "TTS request could not start",
                request_id,
                "TTS is disabled in settings",
                None,
                None,
            );
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

        // ── Offline pre-gate (mirrors the STT record-start gate) ──────────
        // A cloud TTS whose provider is currently believed offline either falls back to a cached
        // local voice (so read-aloud keeps working with no internet), or — with no local model
        // installed — surfaces an offline notice instead of a doomed cloud round-trip. Proactive:
        // only fires once the provider is KNOWN offline (a prior failure armed the connectivity
        // watch, which also drives the renderer's auto-revert of `tts.source` to Local).
        let mut settings = settings;
        let mut voice = voice;
        if matches!(settings.tts.source, SettingsTtsSource::Cloud) {
            let provider = match effective_cloud_provider(&settings) {
                TtsCloudProvider::Elevenlabs => CloudSttProvider::ElevenLabs,
                TtsCloudProvider::Openrouter => CloudSttProvider::OpenRouter,
            };
            if crate::winstt::cloud_stt::provider_appears_offline(provider) {
                match resolve_local_tts_fallback(&self.app) {
                    Some(local_model) => {
                        log::warn!(
                            "cloud TTS provider '{}' offline; falling back to local model '{local_model}'",
                            provider.id()
                        );
                        settings.tts.source = SettingsTtsSource::Local;
                        settings.tts.model = local_model;
                        // Ignore the cloud voice id — use the local model's default voice.
                        voice = "";
                    }
                    None => {
                        self.drop_request(request_id);
                        self.emit_event(
                            "tts:started",
                            serde_json::json!({ "requestId": request_id }),
                        );
                        self.emit_tts_unavailable(provider, "offline_no_local");
                        self.record_failure(
                            "synthesis",
                            "TTS request could not start",
                            request_id,
                            "cloud provider offline and no local voice installed",
                            Some("cloud"),
                            None,
                        );
                        self.emit_event(
                            "tts:failed",
                            serde_json::json!({ "requestId": request_id, "reason": "offline_no_local" }),
                        );
                        return;
                    }
                }
            }
        }

        let started = std::time::Instant::now();
        self.emit_event(
            "tts:started",
            serde_json::json!({ "requestId": request_id }),
        );

        if !matches!(settings.tts.source, SettingsTtsSource::Cloud)
            && let Err(e) = self.ensure_espeak_runtime_for_settings(&settings, true)
        {
            self.drop_request(request_id);
            self.record_failure(
                "engine_runtime",
                "TTS engine runtime setup failed",
                request_id,
                &e.to_string(),
                Some("local"),
                Some(started.elapsed().as_millis() as u64),
            );
            self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            );
            return;
        }

        let (source, engine, engine_key) = self.ensure_engine_for(&settings);
        let cloud_failure_provider = if matches!(source, TtsSource::Cloud) {
            Some(match effective_cloud_provider(&settings) {
                TtsCloudProvider::Elevenlabs => CloudSttProvider::ElevenLabs,
                TtsCloudProvider::Openrouter => CloudSttProvider::OpenRouter,
            })
        } else {
            None
        };
        // Auto-download the selected local model's assets (with progress) before
        // synthesizing — mirrors the STT first-use download. Kokoro self-downloads.
        if matches!(source, TtsSource::Local)
            && let Err(e) = self.ensure_local_model_assets_for(&settings)
        {
            self.drop_request(request_id);
            self.record_failure(
                "model_download",
                "TTS local model assets could not be prepared",
                request_id,
                &e.to_string(),
                Some("local"),
                Some(started.elapsed().as_millis() as u64),
            );
            self.emit_event(
                "tts:failed",
                serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
            );
            return;
        }
        // Fill voice/lang from settings when the caller omitted them (the renderer's
        // `ttsSpeak` passes them, but the hotkey path may not).
        let (eff_voice, eff_lang) = match source {
            TtsSource::Local => (
                if voice.is_empty() {
                    settings.tts.voice.clone()
                } else {
                    voice.to_string()
                },
                if lang.is_empty() {
                    settings.tts.lang.clone()
                } else {
                    lang.to_string()
                },
            ),
            TtsSource::Cloud => (
                if voice.is_empty() {
                    match effective_cloud_provider(&settings) {
                        TtsCloudProvider::Elevenlabs => settings.tts.cloud.voice.clone(),
                        TtsCloudProvider::Openrouter => settings.tts.cloud.openrouter_voice.clone(),
                    }
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
            if let Err(e) = dl.ensure_voice(&settings.tts.model, &eff_voice) {
                self.drop_request(request_id);
                self.record_failure(
                    "voice_download",
                    "TTS voice download failed",
                    request_id,
                    &format!("voice download failed: {e}"),
                    Some("local"),
                    Some(started.elapsed().as_millis() as u64),
                );
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
                self.record_failure(
                    "synthesis",
                    "TTS synthesis lock failed",
                    request_id,
                    "tts synth lock poisoned",
                    Some(match source {
                        TtsSource::Local => "local",
                        TtsSource::Cloud => "cloud",
                    }),
                    Some(started.elapsed().as_millis() as u64),
                );
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
            seq: AtomicU64::new(0),
            // Capture the session's audio for history playback only when history
            // is on — otherwise the accumulator never allocates.
            capture: read_settings_raw(&self.app)
                .general
                .history_enabled
                .then(TtsAudioCapture::new),
            sentence: AtomicU64::new(0),
        };
        let sentences = split_sentences(text, DEFAULT_MAX_SENTENCE_LEN);
        // Publish the script BEFORE the first sample is synthesized: the overlay
        // island shows the text the moment the pill appears (during the synthesis
        // wait), then highlights it word-by-word as the chunks for each sentence
        // land. These are the FINAL sentences — post-modifiers, post-inline-tags —
        // so what is displayed is exactly what is spoken.
        self.emit_event(
            "tts:script",
            serde_json::json!({ "requestId": request_id, "sentences": sentences }),
        );
        let mut result: TtsResult<()> = Ok(());
        for (index, sentence) in sentences.iter().enumerate() {
            if cancel.is_cancelled() {
                result = Err(TtsError::Cancelled);
                break;
            }
            // Every chunk this sentence produces is stamped with its script index
            // (see `EmitChunkSink::sentence`).
            sink.sentence.store(index as u64, Ordering::Relaxed);
            // Clamp to the ACTIVE engine's declared range: local engines expose
            // their own floor/ceiling (Supertonic 0.4..1.3, others 0.5..2.0) via
            // `speed_range()` — the generic 0.5 floor would otherwise pre-clip
            // Supertonic's wider 0.4 before its internal clamp ever runs. Cloud
            // keeps the ElevenLabs/OpenRouter 0.7..1.2 range.
            let speed = match source {
                TtsSource::Local => clamp_speed_to_range(get_speed(), engine.speed_range()),
                TtsSource::Cloud => clamp_cloud_speed(get_speed()),
            };
            if let Err(e) = engine.synthesize_stream(sentence, &eff_voice, &eff_lang, speed, &sink)
            {
                result = Err(e);
                break;
            }
        }
        self.drop_request(request_id);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        // Persist the run to TTS history (with cloud cost when available) —
        // drains the engine's per-session usage even when history is off so a
        // later run can't inherit this one's billing telemetry. The captured
        // session audio rides along so the row is replayable from the History
        // tab (partial audio from a cancelled run is still saved — that's what
        // actually played).
        let captured_audio = sink.capture.as_ref().and_then(TtsAudioCapture::take);
        self.persist_tts_history_run(
            &settings,
            source,
            &eff_voice,
            text,
            elapsed_ms,
            engine.as_ref(),
            result.is_ok(),
            captured_audio,
        );
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
            Err(e) => {
                let source_label = match source {
                    TtsSource::Local => "local",
                    TtsSource::Cloud => "cloud",
                };
                if let Some(provider) = cloud_failure_provider {
                    self.emit_cloud_tts_failure(provider, "Cloud TTS", e);
                }
                self.record_failure(
                    "synthesis",
                    "TTS synthesis failed",
                    request_id,
                    &e.to_string(),
                    Some(source_label),
                    Some(elapsed_ms),
                );
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
                );
            }
        }
    }

    /// Persist one finished read-aloud run to `tts_history`. Local runs record
    /// characters only (no cost); cloud runs record whatever actually billed —
    /// including cancelled/failed sessions whose earlier sentences completed.
    /// OpenRouter costs resolve EXACTLY via `/generation` (per-sentence
    /// generation ids); ElevenLabs costs are published-rate estimates.
    #[expect(
        clippy::too_many_arguments,
        reason = "persistence mirrors the read-aloud session's fields"
    )]
    fn persist_tts_history_run(
        &self,
        settings: &WinsttSettings,
        source: TtsSource,
        voice: &str,
        text: &str,
        elapsed_ms: u64,
        engine: &dyn TtsEngine,
        completed: bool,
        captured_audio: Option<CapturedTtsAudio>,
    ) {
        // Drain FIRST (even when history is off) so the engine's session
        // accumulator never leaks into the next run.
        let usage = engine.take_session_usage();
        if !read_settings_raw(&self.app).general.history_enabled {
            return;
        }
        let model = match source {
            TtsSource::Local => settings.tts.model.clone(),
            TtsSource::Cloud => match effective_cloud_provider(settings) {
                TtsCloudProvider::Elevenlabs => {
                    format!("elevenlabs:{}", settings.tts.cloud.model)
                }
                TtsCloudProvider::Openrouter => {
                    format!("openrouter:{}", settings.tts.cloud.openrouter_model)
                }
            },
        };
        let (characters, estimated_cost, generation_ids) = match usage {
            Some(usage) => (
                usage.characters,
                usage.estimated_cost_usd,
                usage.generation_ids,
            ),
            // Local engines report no usage; record the full text only when
            // the session completed (a cancelled local run billed nothing and
            // its rendered share is unknown).
            None if completed => (text.chars().count() as i64, 0.0, Vec::new()),
            None => return,
        };
        if characters == 0 && generation_ids.is_empty() {
            return;
        }

        let app = self.app.clone();
        let api_key = settings.llm.openrouter_api_key.clone();
        let text = text.to_string();
        let voice = (!voice.trim().is_empty()).then(|| voice.to_string());
        tauri::async_runtime::spawn(async move {
            // Persist the row NOW (with the client-side estimate when that's
            // all the provider gives); the exact OpenRouter cost is filled in
            // by the patient lookup below — generation records can take
            // minutes to become queryable, and the row shouldn't wait.
            let (cost_usd, cost_is_estimate) = if estimated_cost > 0.0 {
                (Some(estimated_cost), true)
            } else {
                (None, false)
            };
            let Some(hm) = app.try_state::<Arc<crate::managers::history::HistoryManager>>() else {
                log::warn!("[tts] history manager unavailable; TTS run not persisted");
                return;
            };
            // Write the session audio into the recordings dir first so the row
            // is born replayable. A failed write degrades to a row without audio.
            let audio_file_name = captured_audio
                .and_then(|captured| write_tts_capture(hm.recordings_dir(), captured));
            let entry = match hm.save_tts_entry(
                text,
                model,
                voice,
                characters,
                Some(elapsed_ms.min(i64::MAX as u64) as i64),
                cost_usd,
                cost_is_estimate,
                audio_file_name,
            ) {
                Ok(entry) => {
                    crate::winstt::commands::history::emit_tts_history_added(&app, &entry);
                    entry
                }
                Err(err) => {
                    log::warn!("[tts] failed to save TTS history entry: {err}");
                    return;
                }
            };
            if generation_ids.is_empty() {
                return;
            }
            if let Some((total, all_resolved)) =
                resolve_openrouter_generation_costs(&api_key, &generation_ids).await
            {
                let hm = hm.inner().clone();
                match hm.update_tts_entry_cost(entry.id, total, !all_resolved) {
                    Ok(updated) => {
                        // Re-emit as an upsert: the store replaces the row by id.
                        crate::winstt::commands::history::emit_tts_history_added(&app, &updated);
                    }
                    Err(err) => {
                        log::warn!("[tts] failed to update TTS history entry cost: {err}");
                    }
                }
            }
        });
    }

    fn openrouter_preview_bytes(&self, model: &str, voice: &str, speed: f32) -> TtsResult<Vec<u8>> {
        let (api_key, _) = self.openrouter_tts_config();
        let engine = OpenRouterTtsEngine::new(api_key, model.to_string());
        engine.fetch_preview(voice, OPENROUTER_PREVIEW_TEXT, speed)
    }

    /// Play a model-scoped OpenRouter voice preview via a short live
    /// `/audio/speech` synthesis.
    pub fn read_openrouter_preview(&self, request_id: &str, model: &str, voice: &str, speed: f32) {
        let cancel = self.cancel_flag(request_id);
        let started = std::time::Instant::now();
        self.emit_event(
            "tts:started",
            serde_json::json!({ "requestId": request_id }),
        );

        let model = model.trim();
        let voice = voice.trim();
        let result = if model.is_empty() {
            Err(TtsError::Cloud(
                "No OpenRouter speech model selected".to_string(),
            ))
        } else if voice.is_empty() {
            Err(TtsError::Cloud("No OpenRouter voice selected".to_string()))
        } else {
            self.openrouter_preview_bytes(model, voice, speed)
        };

        let was_cancelled = cancel.is_cancelled();
        self.drop_request(request_id);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(bytes) if !was_cancelled && !bytes.is_empty() => {
                // Previews emit no `tts:script`, so the island shows no text for them — the
                // sentence index is a placeholder the renderer never resolves.
                let payload = chunk_payload(request_id, &SynthesisChunk::mp3(bytes, 0, true), 0);
                let _ = self.app.emit("tts:chunk", payload);
                self.emit_event(
                    "tts:completed",
                    serde_json::json!({ "requestId": request_id, "cancelled": false, "elapsedMs": elapsed_ms }),
                );
            }
            Ok(_) => self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": request_id, "cancelled": was_cancelled, "elapsedMs": elapsed_ms }),
            ),
            Err(e) => {
                self.emit_cloud_tts_failure(
                    CloudSttProvider::OpenRouter,
                    "OpenRouter TTS preview",
                    &e,
                );
                self.record_failure(
                    "openrouter_preview",
                    "OpenRouter TTS preview failed",
                    request_id,
                    &e.to_string(),
                    Some("cloud"),
                    Some(elapsed_ms),
                );
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
                );
            }
        }
    }

    /// Play a cloud voice's FREE pre-generated sample (`preview_url`) instead of
    /// synthesizing — browsing voices costs no ElevenLabs credits. Fetches the mp3
    /// (key-free, https-only) and forwards it as ONE `tts:chunk` (mp3) under the
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
        let was_cancelled = cancel.is_cancelled();
        self.drop_request(request_id);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(bytes) if !was_cancelled && !bytes.is_empty() => {
                // Previews emit no `tts:script`, so the island shows no text for them — the
                // sentence index is a placeholder the renderer never resolves.
                let payload = chunk_payload(request_id, &SynthesisChunk::mp3(bytes, 0, true), 0);
                let _ = self.app.emit("tts:chunk", payload);
                self.emit_event(
                    "tts:completed",
                    serde_json::json!({ "requestId": request_id, "cancelled": false, "elapsedMs": elapsed_ms }),
                );
            }
            Ok(_) => self.emit_event(
                "tts:completed",
                serde_json::json!({ "requestId": request_id, "cancelled": was_cancelled, "elapsedMs": elapsed_ms }),
            ),
            Err(e) => {
                self.record_failure(
                    "cloud_preview",
                    "TTS cloud preview clip failed",
                    request_id,
                    &e.to_string(),
                    Some("cloud"),
                    Some(elapsed_ms),
                );
                self.emit_event(
                    "tts:failed",
                    serde_json::json!({ "requestId": request_id, "reason": e.to_string() }),
                );
            }
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

/// How long to keep polling OpenRouter for a session's generation records.
/// The records are ingested asynchronously on OpenRouter's side and have been
/// observed to lag several MINUTES behind the request, so the schedule backs
/// off patiently instead of hammering: ~2s → 5s → 10s → 30s → 60s → 2m → 5m.
const GENERATION_LOOKUP_DELAYS_SECS: &[u64] = &[2, 5, 10, 30, 60, 120, 300];

/// Resolve OpenRouter generation ids to their exact billed USD via
/// `GET /api/v1/generation?id=…`, summing across the session's sentences.
/// Returns `(total, all_resolved)` — a partial sum (some ids never resolved)
/// is surfaced as an estimate — or `None` when nothing resolved.
async fn resolve_openrouter_generation_costs(
    api_key: &str,
    generation_ids: &[String],
) -> Option<(f64, bool)> {
    if api_key.trim().is_empty() {
        return None;
    }
    let client = crate::winstt::net::http_client();
    let mut costs: Vec<Option<f64>> = vec![None; generation_ids.len()];
    for delay_secs in GENERATION_LOOKUP_DELAYS_SECS {
        tokio::time::sleep(Duration::from_secs(*delay_secs)).await;
        for (idx, id) in generation_ids.iter().enumerate() {
            if costs[idx].is_some() {
                continue;
            }
            let resp = client
                .get(format!("https://openrouter.ai/api/v1/generation?id={id}"))
                .bearer_auth(api_key)
                .timeout(Duration::from_secs(10))
                .send()
                .await;
            let Ok(resp) = resp else { continue };
            if !resp.status().is_success() {
                continue;
            }
            let Ok(json) = resp.json::<serde_json::Value>().await else {
                continue;
            };
            costs[idx] = json
                .get("data")
                .and_then(|d| d.get("total_cost"))
                .and_then(|c| c.as_f64())
                .filter(|c| c.is_finite() && *c >= 0.0);
        }
        if costs.iter().all(|c| c.is_some()) {
            break;
        }
    }
    let resolved = costs.iter().flatten().count();
    if resolved == 0 {
        for id in generation_ids {
            log::warn!("[tts] OpenRouter generation {id} cost lookup failed");
        }
        return None;
    }
    let total: f64 = costs.iter().flatten().sum();
    Some((total, resolved == generation_ids.len()))
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

    #[test]
    fn tts_idle_watcher_uses_the_exact_monotonic_deadline() {
        let last_used_at = Instant::now();
        let before_deadline = last_used_at + Duration::from_secs(4);
        assert_eq!(
            tts_idle_watcher_action(
                ModelUnloadTimeout::Sec15,
                0,
                true,
                last_used_at,
                before_deadline,
            ),
            TtsIdleWatcherAction::WaitUntil(last_used_at + Duration::from_secs(15))
        );
        assert_eq!(
            tts_idle_watcher_action(
                ModelUnloadTimeout::Sec15,
                0,
                true,
                last_used_at,
                last_used_at + Duration::from_secs(15),
            ),
            TtsIdleWatcherAction::Unload
        );
    }

    #[test]
    fn tts_idle_watcher_parks_until_relevant_lifecycle_changes() {
        let last_used_at = Instant::now();
        let now = last_used_at + Duration::from_secs(60);
        assert_eq!(
            tts_idle_watcher_action(ModelUnloadTimeout::Never, 0, true, last_used_at, now),
            TtsIdleWatcherAction::WaitForChange
        );
        assert_eq!(
            tts_idle_watcher_action(ModelUnloadTimeout::Sec15, 1, true, last_used_at, now),
            TtsIdleWatcherAction::WaitForChange
        );
        assert_eq!(
            tts_idle_watcher_action(ModelUnloadTimeout::Sec15, 0, false, last_used_at, now),
            TtsIdleWatcherAction::WaitForChange
        );
        assert_eq!(
            tts_idle_watcher_action(ModelUnloadTimeout::Immediately, 0, true, last_used_at, now,),
            TtsIdleWatcherAction::Unload
        );
    }

    fn settings_with_keys(
        persisted: TtsCloudProvider,
        eleven: &str,
        openrouter: &str,
    ) -> WinsttSettings {
        let mut s = WinsttSettings::default();
        s.tts.cloud.provider = persisted;
        s.integrations.elevenlabs.api_key = eleven.to_string();
        s.llm.openrouter_api_key = openrouter.to_string();
        s
    }

    #[test]
    fn effective_cloud_provider_honours_persisted_when_keyed() {
        // Both keyed → keep the persisted choice (either direction).
        assert_eq!(
            effective_cloud_provider(&settings_with_keys(
                TtsCloudProvider::Elevenlabs,
                "el-key",
                "or-key"
            )),
            TtsCloudProvider::Elevenlabs
        );
        assert_eq!(
            effective_cloud_provider(&settings_with_keys(
                TtsCloudProvider::Openrouter,
                "el-key",
                "or-key"
            )),
            TtsCloudProvider::Openrouter
        );
    }

    #[test]
    fn effective_cloud_provider_falls_back_to_the_keyed_one() {
        // THE BUG: persisted elevenlabs (renderer default) but only OpenRouter
        // keyed → must route to OpenRouter, not fail "no ElevenLabs key".
        assert_eq!(
            effective_cloud_provider(&settings_with_keys(
                TtsCloudProvider::Elevenlabs,
                "   ",
                "or-key"
            )),
            TtsCloudProvider::Openrouter
        );
        // Symmetric: persisted openrouter, only ElevenLabs keyed → ElevenLabs.
        assert_eq!(
            effective_cloud_provider(&settings_with_keys(
                TtsCloudProvider::Openrouter,
                "el-key",
                ""
            )),
            TtsCloudProvider::Elevenlabs
        );
    }

    #[test]
    fn effective_cloud_provider_keeps_persisted_when_neither_keyed() {
        // Nothing keyed → keep persisted so the engine raises the matching
        // "add a key" error rather than silently picking a provider.
        assert_eq!(
            effective_cloud_provider(&settings_with_keys(TtsCloudProvider::Elevenlabs, "", "")),
            TtsCloudProvider::Elevenlabs
        );
    }

    const ELEVEN_TEST_KEY: &str = "sk_super_secret_value";
    const OPENROUTER_TEST_KEY: &str = "sk-or-v1-super-secret-value";

    fn cloud_fingerprint(
        persisted: TtsCloudProvider,
        eleven: &str,
        openrouter: &str,
    ) -> (TtsSource, String) {
        let mut s = settings_with_keys(persisted, eleven, openrouter);
        s.tts.source = SettingsTtsSource::Cloud;
        TtsManager::engine_fingerprint_from(&s)
    }

    #[test]
    fn cloud_fingerprint_never_carries_the_plaintext_api_key() {
        // The fingerprint is logged at INFO on every engine swap and is copied
        // verbatim into the shareable diagnostic bundle, so an opened key must
        // not survive into it.
        let (source, eleven) = cloud_fingerprint(TtsCloudProvider::Elevenlabs, ELEVEN_TEST_KEY, "");
        assert_eq!(source, TtsSource::Cloud);
        assert!(
            !eleven.contains(ELEVEN_TEST_KEY),
            "elevenlabs key leaked into fingerprint: {eleven}"
        );
        let (_, openrouter) =
            cloud_fingerprint(TtsCloudProvider::Openrouter, "", OPENROUTER_TEST_KEY);
        assert!(
            !openrouter.contains(OPENROUTER_TEST_KEY),
            "openrouter key leaked into fingerprint: {openrouter}"
        );
    }

    #[test]
    fn cloud_fingerprint_still_rebuilds_on_a_key_rotation() {
        // Rebuild semantics are what the digest has to preserve: `ensure_engine_for`
        // only compares fingerprints, so a rotated key must still force a rebuild
        // while an unchanged key must not.
        let (_, before) = cloud_fingerprint(TtsCloudProvider::Elevenlabs, ELEVEN_TEST_KEY, "");
        let (_, again) = cloud_fingerprint(TtsCloudProvider::Elevenlabs, ELEVEN_TEST_KEY, "");
        let (_, rotated) = cloud_fingerprint(TtsCloudProvider::Elevenlabs, "sk_rotated_value", "");
        assert_eq!(before, again);
        assert_ne!(before, rotated);

        let (_, or_before) =
            cloud_fingerprint(TtsCloudProvider::Openrouter, "", OPENROUTER_TEST_KEY);
        let (_, or_again) =
            cloud_fingerprint(TtsCloudProvider::Openrouter, "", OPENROUTER_TEST_KEY);
        let (_, or_rotated) =
            cloud_fingerprint(TtsCloudProvider::Openrouter, "", "sk-or-v1-rotated-value");
        assert_eq!(or_before, or_again);
        assert_ne!(or_before, or_rotated);
    }

    #[test]
    fn elevenlabs_fingerprint_rebuilds_for_constructor_voice_settings() {
        let mut base = settings_with_keys(TtsCloudProvider::Elevenlabs, ELEVEN_TEST_KEY, "");
        base.tts.source = SettingsTtsSource::Cloud;
        let (_, before) = TtsManager::engine_fingerprint_from(&base);

        let mut stability = base.clone();
        stability.tts.cloud.stability = 0.2;
        assert_ne!(before, TtsManager::engine_fingerprint_from(&stability).1);

        let mut similarity = base.clone();
        similarity.tts.cloud.similarity = 0.4;
        assert_ne!(before, TtsManager::engine_fingerprint_from(&similarity).1);

        let mut style = base.clone();
        style.tts.cloud.style = 0.3;
        assert_ne!(before, TtsManager::engine_fingerprint_from(&style).1);

        let mut boost = base;
        boost.tts.cloud.speaker_boost = false;
        assert_ne!(before, TtsManager::engine_fingerprint_from(&boost).1);
    }

    #[test]
    fn configured_hotkey_speed_tracks_the_active_source() {
        let mut settings = WinsttSettings::default();
        settings.tts.source = SettingsTtsSource::Local;
        settings.tts.speed = 0.4;
        settings.tts.cloud.speed = 1.15;
        assert_eq!(TtsManager::configured_speed_from(&settings), 0.4);

        settings.tts.source = SettingsTtsSource::Cloud;
        assert_eq!(TtsManager::configured_speed_from(&settings), 1.15);
    }

    #[test]
    fn secret_tag_marks_an_absent_key_without_hashing_it() {
        // An unset key is not a secret — keep it readable so the "no key yet"
        // fingerprint stays diagnosable, and keep it distinct from any digest.
        assert_eq!(TtsManager::secret_tag(""), "nokey");
        assert_eq!(TtsManager::secret_tag("   "), "nokey");
        // Truncated SHA-256: 8 bytes → 16 lowercase hex chars, and surrounding
        // whitespace must not change the tag (the key itself is trimmed).
        let tag = TtsManager::secret_tag(ELEVEN_TEST_KEY);
        assert_eq!(tag.len(), 16);
        assert!(
            tag.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(tag, TtsManager::secret_tag("  sk_super_secret_value  "));
    }
}
