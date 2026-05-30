// PORT IMPL — drafted against real APIs, pending compile.
// Source: server/src/synthesizer/ (Kokoro-ONNX hexagonal subsystem),
//   frontend/electron/ipc/{tts.ts,tts-cloud.ts,tts-reader.ts,tts-hotkey.ts},
//   frontend/src/shared/config/settings-schema.ts (ttsSettingsSchema),
//   app/PORT/06_tts.md, docs.rs/reqwest (blocking client, POST, GET).
//
// TtsManager + 54-voice Kokoro catalog + sentence-splitter + per-sentence streaming + cancel +
// cloud ElevenLabs (reqwest). The local engine is the REAL in-process Kokoro-82M ONNX engine in
// `kokoro.rs` (on OUR ort 2.0.0-rc.12); G2P is `phonemize.rs` (espeak-ng CLI, process-separated).
//
// ⚠️ LICENSING — see PORT/06_tts.md §1. The DEFAULT build shells out to the system `espeak-ng`
// binary (process separation = "mere aggregation" → main binary stays non-GPL). The engine code is
// compiled-in (no kokoroxide; we run the ONNX directly), so there is NO 30 MB engine pack — only the
// two model FILES download on first use.
//
// Wire contract to the renderer (identical for local + cloud so the Web-Audio playback queue is
// source-agnostic — features/tts-playback):
//   tts://chunk { request_id, sample_rate, seq, is_final, format, channels, pcm }
// where format == "f32le" (raw mono f32, local Kokoro) | "mp3" (cloud, renderer decodeAudioData's).

#![allow(dead_code)]

pub mod kokoro;
pub mod phonemize;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub use self::kokoro::{KokoroConfig, KokoroDevice, KokoroEngine, KOKORO_SAMPLE_RATE};

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

/// One slice of synthesized audio, emitted as the stream proceeds.
/// `audio` is 1-D mono f32 PCM at `sample_rate` (for `Format::F32le`);
/// `encoded` carries the mp3 byte payload (for `Format::Mp3`, cloud).
/// `seq` is monotonic per request; `is_final` flags the last chunk of the whole
/// read so the renderer queue `markComplete()`s exactly once.
#[derive(Clone, Debug)]
pub struct SynthesisChunk {
    pub audio: Arc<[f32]>,
    pub encoded: Arc<[u8]>,
    pub sample_rate: u32,
    pub seq: u64,
    pub is_final: bool,
    pub format: Format,
    pub channels: u8,
}

impl SynthesisChunk {
    pub fn f32le(audio: Vec<f32>, sample_rate: u32, seq: u64, is_final: bool) -> Self {
        Self {
            audio: audio.into(),
            encoded: Arc::from(&[][..]),
            sample_rate,
            seq,
            is_final,
            format: Format::F32le,
            channels: 1,
        }
    }

    pub fn mp3(encoded: Vec<u8>, seq: u64, is_final: bool) -> Self {
        Self {
            audio: Arc::from(&[][..]),
            encoded: encoded.into(),
            // 0 → the mp3 container carries the rate; the renderer reads it.
            sample_rate: 0,
            seq,
            is_final,
            format: Format::Mp3,
            channels: 1,
        }
    }
}

/// Playback-queue format tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    F32le,
    Mp3,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::F32le => "f32le",
            Format::Mp3 => "mp3",
        }
    }
}

/// One available voice — surfaced to the renderer voice picker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Exact lang string the Kokoro engine accepts (`en-us`, `cmn`, `pt-br`, …).
    pub language: &'static str,
    pub gender: Gender,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gender {
    Female,
    Male,
}

impl Gender {
    pub fn as_str(self) -> &'static str {
        match self {
            Gender::Female => "female",
            Gender::Male => "male",
        }
    }
}

// ---------------------------------------------------------------------------
// Config + clamps + constants
// ---------------------------------------------------------------------------

/// Synthesizer configuration. `device` is NOT a standalone TTS setting in WinSTT
/// — TTS shares the main STT model's device (`model.device`); the host wires
/// that value in (memory `project_tts_device_follows_model_device`).
#[derive(Clone, Debug)]
pub struct LocalTtsConfig {
    pub cache_dir: PathBuf,
    pub model_filename: String,
    pub voices_filename: String,
    pub voice: String,
    pub lang: String,
    pub speed: f32,
    pub device: TtsDevice,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsDevice {
    Auto,
    DirectMl,
    Cpu,
}

impl TtsDevice {
    fn to_kokoro(self) -> KokoroDevice {
        match self {
            TtsDevice::Auto => KokoroDevice::Auto,
            TtsDevice::DirectMl => KokoroDevice::DirectMl,
            TtsDevice::Cpu => KokoroDevice::Cpu,
        }
    }
}

impl Default for LocalTtsConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::new(),
            model_filename: "kokoro-v1.0.fp16.onnx".to_string(),
            voices_filename: "voices-v1.0.bin".to_string(),
            voice: "af_heart".to_string(),
            lang: "en-us".to_string(),
            speed: 1.0,
            device: TtsDevice::Auto,
        }
    }
}

impl LocalTtsConfig {
    fn to_kokoro_config(&self) -> KokoroConfig {
        KokoroConfig {
            cache_dir: self.cache_dir.clone(),
            model_filename: self.model_filename.clone(),
            voices_filename: self.voices_filename.clone(),
            device: self.device.to_kokoro(),
        }
    }
}

/// Local Kokoro speed multiplier range (WinSTT: 0.5..2.0).
pub const MIN_SPEED: f32 = 0.5;
pub const MAX_SPEED: f32 = 2.0;
/// Cloud (ElevenLabs) speed multiplier range (WinSTT: 0.7..1.2).
pub const CLOUD_MIN_SPEED: f32 = 0.7;
pub const CLOUD_MAX_SPEED: f32 = 1.2;
/// Defends against a known Kokoro phoneme-overflow on huge inputs.
pub const MAX_SYNTHESIS_CHARS: usize = 8000;

/// Clamp a local-Kokoro speed request into the supported range.
pub fn clamp_speed(speed: f32) -> f32 {
    speed.clamp(MIN_SPEED, MAX_SPEED)
}

/// Clamp a cloud (ElevenLabs) speed request into the supported range.
pub fn clamp_cloud_speed(speed: f32) -> f32 {
    speed.clamp(CLOUD_MIN_SPEED, CLOUD_MAX_SPEED)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum TtsError {
    /// Engine model download could not finish (network).
    Download(String),
    /// Download/synthesis was paused cooperatively (resume via re-init).
    Paused,
    /// User cancelled — distinct from a real failure.
    Cancelled,
    /// ONNX session create / inference / G2P failure.
    Engine(String),
    /// Cloud HTTP / auth / quota error (human-readable, already classified).
    Cloud(String),
    /// Bad input (empty text, unknown voice, etc.).
    Invalid(String),
}

impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TtsError::Download(m) => write!(f, "TTS download failed: {m}"),
            TtsError::Paused => write!(f, "TTS install paused"),
            TtsError::Cancelled => write!(f, "TTS cancelled"),
            TtsError::Engine(m) => write!(f, "TTS engine error: {m}"),
            TtsError::Cloud(m) => write!(f, "{m}"),
            TtsError::Invalid(m) => write!(f, "invalid TTS request: {m}"),
        }
    }
}

impl std::error::Error for TtsError {}

pub type TtsResult<T> = Result<T, TtsError>;

// ---------------------------------------------------------------------------
// Chunk sink + engine port
// ---------------------------------------------------------------------------

/// A consumer-cancellable sink the engine pushes chunks into. The host bridges
/// `push` to a Tauri `tts://chunk` event and polls `is_cancelled` between
/// sentences (the cooperative cancel point, like the Python `should_cancel`).
pub trait ChunkSink: Send {
    /// Forward one chunk. Returns `false` if the consumer is gone → stop producing.
    fn push(&self, chunk: SynthesisChunk) -> bool;
    /// True once the consumer requested cancellation — polled between sentences.
    fn is_cancelled(&self) -> bool;
}

/// The streaming TTS engine port. ONE impl per backend (`KokoroLocalEngine`
/// local, `ElevenLabsEngine` cloud). Methods are blocking — the host runs them
/// on a dedicated thread so the UI loop never stalls on download / session create.
pub trait TtsEngine: Send + Sync {
    /// Synthesize ONE sentence, pushing chunk(s) to `sink`. The manager handles
    /// sentence-splitting + final-chunk tagging; the engine just renders one
    /// piece. `speed` is pre-clamped by the manager.
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio>;

    /// Default streaming wrapper: render one sentence and push it as a single
    /// chunk to `sink`. The manager handles per-sentence seq + final tagging.
    /// Engines that can stream sub-sentence audio may override this.
    fn synthesize_stream(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        let chunk = match self.synthesize_sentence(text, voice, lang, speed)? {
            SentenceAudio::F32le { samples, sample_rate } => {
                SynthesisChunk::f32le(samples, sample_rate, 0, false)
            }
            SentenceAudio::Mp3 { bytes } => SynthesisChunk::mp3(bytes, 0, false),
        };
        sink.push(chunk);
        Ok(())
    }

    /// Every voice this engine can render (local → static catalog; cloud → empty).
    fn list_voices(&self) -> Vec<VoiceInfo>;

    /// True once loaded (local: session ready; cloud: key present).
    fn is_ready(&self) -> bool;

    /// Force the model download + session load NOW (blocking, idempotent).
    fn warm_up(&self) -> TtsResult<()>;

    /// Release native resources. Idempotent.
    fn shutdown(&self);
}

/// The rendered audio for one sentence, format-tagged so the manager knows how
/// to wrap it into a `SynthesisChunk`.
pub enum SentenceAudio {
    /// Raw mono f32 PCM at `sample_rate` (local Kokoro).
    F32le { samples: Vec<f32>, sample_rate: u32 },
    /// Encoded mp3 bytes (cloud ElevenLabs).
    Mp3 { bytes: Vec<u8> },
}

// ---------------------------------------------------------------------------
// Local Kokoro engine adapter (wraps the real ort engine in kokoro.rs)
// ---------------------------------------------------------------------------

/// Local in-process Kokoro-82M engine. Delegates to `kokoro::KokoroEngine`
/// (real ort inference); this adapter maps its errors into `TtsError` and
/// ensures the model assets are present (via the resumable downloader) before
/// the first synthesis.
pub struct KokoroLocalEngine {
    engine: KokoroEngine,
    config: LocalTtsConfig,
}

impl KokoroLocalEngine {
    pub fn new(config: LocalTtsConfig) -> Self {
        let engine = KokoroEngine::new(config.to_kokoro_config());
        Self { engine, config }
    }

    /// Ensure both model files are on disk, downloading (resumable) if missing.
    /// Reuses the same progress-callback shape as the STT downloader so the
    /// renderer's progress UI is identical. Called from `warm_up` /first synth.
    fn ensure_assets(&self) -> TtsResult<()> {
        let kcfg = self.config.to_kokoro_config();
        if kcfg.assets_present() {
            return Ok(());
        }
        // Host wires a real progress/cancel sink; here we run a blocking download.
        download_kokoro_assets(&kcfg, None).map_err(|e| match e {
            DownloadError::Cancelled => TtsError::Cancelled,
            DownloadError::Paused => TtsError::Paused,
            DownloadError::Network(m) => TtsError::Download(m),
        })
    }
}

impl TtsEngine for KokoroLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(SentenceAudio::F32le {
                samples: Vec::new(),
                sample_rate: KOKORO_SAMPLE_RATE,
            });
        }
        if trimmed.chars().count() > MAX_SYNTHESIS_CHARS {
            return Err(TtsError::Invalid(format!(
                "text exceeds {MAX_SYNTHESIS_CHARS} chars"
            )));
        }
        self.ensure_assets()?;
        let effective_voice = if voice.is_empty() { &self.config.voice } else { voice };
        let effective_lang = if lang.is_empty() { &self.config.lang } else { lang };
        let samples = self
            .engine
            .synthesize(trimmed, effective_voice, effective_lang, clamp_speed(speed))
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: KOKORO_SAMPLE_RATE,
        })
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        KOKORO_VOICE_CATALOG.to_vec()
    }

    fn is_ready(&self) -> bool {
        self.engine.is_ready()
    }

    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_assets()?;
        self.engine.warm_up().map_err(|e| TtsError::Engine(e.to_string()))
    }

    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Asset download (resumable; mirrors asset_downloader.py + the STT slice).
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DownloadError {
    Cancelled,
    Paused,
    Network(String),
}

/// Cooperative download controls (the host implements these against its
/// pause/cancel UI + a Tauri progress event). Mirrors the Python
/// `(on_progress, should_pause, should_cancel)` triple.
pub trait DownloadControl: Send + Sync {
    fn on_progress(&self, fraction: f64, downloaded: u64, total: u64);
    fn should_pause(&self) -> bool {
        false
    }
    fn should_cancel(&self) -> bool {
        false
    }
}

/// Download the two Kokoro model files into `cfg.cache_dir`, resumable via HTTP
/// Range (`.partial` → atomic rename). Returns once both are present.
///
/// Blocking wrapper around the async reqwest client via
/// `tauri::async_runtime::block_on` — the existing reqwest dep enables only
/// `json`/`stream`/`multipart` (no `blocking` feature), and the command layer
/// already runs every TTS call on a `spawn_blocking` worker, so blocking on the
/// shared runtime here is safe (we are never on the async pump). Matches the
/// Python `download_with_progress` semantics (`.partial` + Range resume + the
/// pause/cancel cooperative checks).
///
/// SPIKE: the STT slice will ship a shared `asset_downloader.rs` with the exact
/// `.partial`/Range/pause logic; once it lands, delegate to it (one downloader
/// in the app) instead of this self-contained copy.
pub fn download_kokoro_assets(
    cfg: &KokoroConfig,
    control: Option<&dyn DownloadControl>,
) -> Result<(), DownloadError> {
    let jobs = [
        (kokoro::model_url(), cfg.model_path()),
        (kokoro::voices_url(), cfg.voices_path()),
    ];
    let client = reqwest::Client::builder()
        .user_agent("WinSTT/0.1")
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;

    for (url, target) in jobs {
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DownloadError::Network(e.to_string()))?;
        }
        download_one(&client, &url, &target, control)?;
    }
    Ok(())
}

/// Stream one URL → `target` with Range resume + pause/cancel. Blocking shim
/// over the async body.
fn download_one(
    client: &reqwest::Client,
    url: &str,
    target: &std::path::Path,
    control: Option<&dyn DownloadControl>,
) -> Result<(), DownloadError> {
    use std::io::Write;
    use tauri::async_runtime::block_on;

    let partial = target.with_extension("partial");
    let resume_from = partial.metadata().map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let mut resp = block_on(req.send()).map_err(|e| DownloadError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(DownloadError::Network(format!("HTTP {status} for {url}")));
    }
    // If the server ignored Range (200 not 206), restart cleanly.
    let resuming = resume_from > 0 && status.as_u16() == 206;
    let mut downloaded = if resuming { resume_from } else { 0 };
    let total = resp.content_length().map(|cl| downloaded + cl).unwrap_or(0);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(true)
        .truncate(!resuming)
        .open(&partial)
        .map_err(|e| DownloadError::Network(e.to_string()))?;

    loop {
        if let Some(c) = control {
            if c.should_cancel() {
                drop(file);
                let _ = std::fs::remove_file(&partial);
                return Err(DownloadError::Cancelled);
            }
            if c.should_pause() {
                // leave .partial for the next resume
                return Err(DownloadError::Paused);
            }
        }
        // `chunk()` reads the next body frame; None = done.
        let next = block_on(resp.chunk()).map_err(|e| DownloadError::Network(e.to_string()))?;
        let Some(bytes) = next else { break };
        file.write_all(&bytes).map_err(|e| DownloadError::Network(e.to_string()))?;
        downloaded += bytes.len() as u64;
        if let Some(c) = control {
            let frac = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
            c.on_progress(frac, downloaded, total);
        }
    }
    drop(file);
    std::fs::rename(&partial, target).map_err(|e| DownloadError::Network(e.to_string()))?;
    if let Some(c) = control {
        c.on_progress(1.0, downloaded, downloaded);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cloud ElevenLabs engine (reqwest)
// ---------------------------------------------------------------------------

/// ElevenLabs voice-settings tuning, read from the encrypted store per call.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoiceSettings {
    pub stability: f32,
    pub similarity: f32,
    pub style: f32,
    pub speaker_boost: bool,
    pub speed: f32,
}

impl Default for CloudVoiceSettings {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity: 0.75,
            style: 0.0,
            speaker_boost: true,
            speed: 1.0,
        }
    }
}

/// Inputs for one cloud synthesis call.
#[derive(Clone, Debug)]
pub struct CloudSynthesisRequest {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub text: String,
    pub settings: CloudVoiceSettings,
}

pub const ELEVENLABS_TTS_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
pub const ELEVENLABS_VOICES_URL: &str = "https://api.elevenlabs.io/v2/voices?page_size=100";
pub const ELEVENLABS_SUBSCRIPTION_URL: &str = "https://api.elevenlabs.io/v1/user/subscription";
/// mp3 is the ONLY format available on every ElevenLabs tier (raw pcm 402s on free).
pub const CLOUD_OUTPUT_FORMAT: &str = "mp3_44100_128";

/// Build the JSON request body for `POST /v1/text-to-speech/{voice_id}`.
/// REAL CODE — unit-tested. Field names are ElevenLabs' on-wire snake_case.
pub fn build_cloud_body(req: &CloudSynthesisRequest) -> serde_json::Value {
    serde_json::json!({
        "text": req.text,
        "model_id": req.model_id,
        "voice_settings": {
            "stability": req.settings.stability,
            "similarity_boost": req.settings.similarity,
            "style": req.settings.style,
            "use_speaker_boost": req.settings.speaker_boost,
            "speed": clamp_cloud_speed(req.settings.speed),
        }
    })
}

/// Full POST URL for a voice id, with the tier-safe output format.
pub fn build_cloud_url(voice_id: &str) -> String {
    format!("{ELEVENLABS_TTS_BASE}/{voice_id}?output_format={CLOUD_OUTPUT_FORMAT}")
}

/// Classify an ElevenLabs HTTP status + optional `detail.status` body field into
/// a human-readable reason. Mirrors `tts-cloud.ts` HTTP_STATUS_MESSAGE +
/// memory `project_elevenlabs_scoped_key_verify` (a scoped key missing
/// `voices_read` is NOT an invalid key). REAL CODE — tested.
pub fn classify_cloud_status(status: u16, detail_status: Option<&str>) -> String {
    if let Some(d) = detail_status {
        match d {
            "quota_exceeded" => return "ElevenLabs: character quota exceeded".to_string(),
            "missing_permissions" => {
                return "ElevenLabs: this API key is missing a required permission".to_string()
            }
            "invalid_api_key" => return "ElevenLabs: invalid API key".to_string(),
            "voice_not_found" => return "ElevenLabs: voice not found".to_string(),
            _ => {}
        }
    }
    match status {
        401 | 403 => "ElevenLabs: invalid API key".to_string(),
        402 => "ElevenLabs: this voice needs a paid plan (cloned & professional voices require a subscription)".to_string(),
        429 => "ElevenLabs: rate limited".to_string(),
        s => format!("ElevenLabs error: HTTP {s}"),
    }
}

/// Pull the `detail.status` discriminator out of an ElevenLabs error body, if
/// present (the body shape is `{"detail": {"status": "...", "message": "..."}}`
/// OR `{"detail": "..."}`). REAL CODE — tested.
pub fn parse_detail_status(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("detail")?
        .get("status")?
        .as_str()
        .map(|s| s.to_string())
}

/// One live ElevenLabs voice (from `/v2/voices`). Surfaced to the renderer
/// cloud-voice picker (includes the account's cloned voices).
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub category: Option<String>,
    pub preview_url: Option<String>,
}

/// Parse a `/v2/voices` JSON body into `CloudVoice`s. REAL CODE — tested.
pub fn parse_cloud_voices(body: &str) -> Vec<CloudVoice> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.get("voices").and_then(|x| x.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|entry| {
            let id = entry.get("voice_id")?.as_str()?.to_string();
            let name = entry
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let language = entry
                .get("labels")
                .and_then(|l| l.get("language"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let category = entry
                .get("category")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let preview_url = entry
                .get("preview_url")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            Some(CloudVoice {
                id,
                name,
                language,
                category,
                preview_url,
            })
        })
        .collect()
}

/// Cloud engine. `synthesize_sentence` POSTs `build_cloud_body` via reqwest and
/// returns the mp3 bytes as ONE chunk (ElevenLabs convert is one-shot).
///
/// Uses the async `reqwest::Client` driven by `tauri::async_runtime::block_on`
/// (the existing reqwest dep has no `blocking` feature; the command layer runs
/// every cloud call on a `spawn_blocking` worker so blocking here is safe).
pub struct ElevenLabsEngine {
    client: reqwest::Client,
    api_key: String,
    model_id: String,
    settings: CloudVoiceSettings,
    ready: AtomicBool,
}

impl ElevenLabsEngine {
    pub fn new(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        let ready = AtomicBool::new(!api_key.is_empty());
        Self {
            client: reqwest::Client::new(),
            api_key,
            model_id,
            settings,
            ready,
        }
    }

    /// Fetch the live `/v2/voices` list (includes cloned voices). The host calls
    /// this for the cloud-voice picker (not via `list_voices`, which is static).
    pub fn fetch_voices(&self) -> TtsResult<Vec<CloudVoice>> {
        use tauri::async_runtime::block_on;
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        let resp = block_on(
            self.client
                .get(ELEVENLABS_VOICES_URL)
                .header("xi-api-key", &self.api_key)
                .send(),
        )
        .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices request failed: {e}")))?;
        let status = resp.status().as_u16();
        let body = block_on(resp.text())
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices read failed: {e}")))?;
        if !(200..300).contains(&status) {
            return Err(TtsError::Cloud(classify_cloud_status(
                status,
                parse_detail_status(&body).as_deref(),
            )));
        }
        Ok(parse_cloud_voices(&body))
    }

    /// Fetch a CDN preview mp3 for a voice (no character credits). Refuses any
    /// non-https URL (trust-boundary check, PORT/06_tts.md §4).
    pub fn fetch_preview(&self, preview_url: &str) -> TtsResult<Vec<u8>> {
        use tauri::async_runtime::block_on;
        if !preview_url.starts_with("https://") {
            return Err(TtsError::Cloud("refusing non-https preview url".into()));
        }
        let resp = block_on(self.client.get(preview_url).send())
            .map_err(|e| TtsError::Cloud(format!("preview fetch failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(TtsError::Cloud(format!("preview HTTP {}", resp.status())));
        }
        block_on(resp.bytes())
            .map(|b| b.to_vec())
            .map_err(|e| TtsError::Cloud(format!("preview read failed: {e}")))
    }
}

impl TtsEngine for ElevenLabsEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        if voice.is_empty() {
            return Err(TtsError::Cloud("No ElevenLabs voice selected".into()));
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(SentenceAudio::Mp3 { bytes: Vec::new() });
        }
        use tauri::async_runtime::block_on;
        let req = CloudSynthesisRequest {
            api_key: self.api_key.clone(),
            voice_id: voice.to_string(),
            model_id: self.model_id.clone(),
            text: trimmed.to_string(),
            settings: CloudVoiceSettings {
                speed: clamp_cloud_speed(speed),
                ..self.settings.clone()
            },
        };
        let resp = block_on(
            self.client
                .post(build_cloud_url(voice))
                .header("xi-api-key", &self.api_key)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(&build_cloud_body(&req))
                .send(),
        )
        .map_err(|e| TtsError::Cloud(format!("ElevenLabs request failed: {e}")))?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let body = block_on(resp.text()).unwrap_or_default();
            return Err(TtsError::Cloud(classify_cloud_status(
                status,
                parse_detail_status(&body).as_deref(),
            )));
        }
        let bytes = block_on(resp.bytes())
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs read failed: {e}")))?
            .to_vec();
        Ok(SentenceAudio::Mp3 { bytes })
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        // Cloud voices come from a live GET /v2/voices fetch, not the static catalog.
        Vec::new()
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn warm_up(&self) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        Ok(())
    }

    fn shutdown(&self) {
        self.ready.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// TtsManager — host-facing facade (engine selection, sentence streaming, cancel)
// ---------------------------------------------------------------------------

/// Which source the user picked (`tts.source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsSource {
    Local,
    Cloud,
}

/// Facade the Tauri command layer calls. Owns the active engine, serializes
/// synthesis, and drives sentence-by-sentence reads under one parent request id
/// (gap-free playback). Mirrors `tts_handler.py` (server) + `tts-reader.ts`.
pub struct TtsManager {
    source: TtsSource,
    engine: Arc<dyn TtsEngine>,
    /// Per-request cancel flags (set by a stop gesture / STT override / app exit).
    cancelled: std::sync::Mutex<HashMap<String, bool>>,
    /// Monotonic request-id counter (the command layer correlates the chunk
    /// stream + cancel by this id).
    next_id: AtomicU64,
}

impl TtsManager {
    pub fn new(source: TtsSource, engine: Arc<dyn TtsEngine>) -> Self {
        Self {
            source,
            engine,
            cancelled: std::sync::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// A fresh, process-unique request id (`tts-<n>`). The renderer uses it to
    /// correlate the `tts://chunk` stream and to cancel the read.
    pub fn next_request_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("tts-{n}")
    }

    /// Build a manager for the local Kokoro engine.
    pub fn local(config: LocalTtsConfig) -> Self {
        Self::new(TtsSource::Local, Arc::new(KokoroLocalEngine::new(config)))
    }

    /// Build a manager for the cloud ElevenLabs engine.
    pub fn cloud(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        Self::new(
            TtsSource::Cloud,
            Arc::new(ElevenLabsEngine::new(api_key, model_id, settings)),
        )
    }

    pub fn source(&self) -> TtsSource {
        self.source
    }

    pub fn engine(&self) -> Arc<dyn TtsEngine> {
        self.engine.clone()
    }

    /// Voice catalog for the renderer picker. Local → static 54-voice catalog;
    /// cloud → live `/v2/voices` (host fetches separately, not via this method).
    pub fn list_voices(&self) -> Vec<VoiceInfo> {
        self.engine.list_voices()
    }

    /// Force engine warm-up off the UI thread (download + session create / key
    /// check). Idempotent.
    pub fn warm_up(&self) -> TtsResult<()> {
        self.engine.warm_up()
    }

    /// Mark a request cancelled — polled between sentences in `read_aloud`.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancelled.lock() {
            map.insert(request_id.to_string(), true);
        }
    }

    /// Cancel every in-flight read (stop-all gesture / STT force-stop / exit).
    pub fn cancel_all(&self) {
        if let Ok(mut map) = self.cancelled.lock() {
            for v in map.values_mut() {
                *v = true;
            }
        }
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|m| m.get(request_id).copied().unwrap_or(false))
            .unwrap_or(true)
    }

    /// Read `text` aloud sentence-by-sentence under ONE `request_id` so the
    /// renderer plays it gap-free. `get_speed` is sampled per sentence (a
    /// mid-read speed change applies to the NEXT sentence; the playing one
    /// finishes at its own speed — re-synthesis, not playbackRate, so pitch
    /// stays natural). Mirrors `runSentenceRead` in tts-reader.ts.
    ///
    /// The LAST emitted chunk is flagged `is_final` (we delay one chunk to know
    /// which is last, mirroring the Python adapter). Returns `Cancelled` if a
    /// stop gesture fired between sentences. Empty / whitespace text → Ok no-op.
    pub fn read_aloud(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        let sentences = split_sentences(text, DEFAULT_MAX_SENTENCE_LEN);
        if sentences.is_empty() {
            // Nothing to say — still resolve cleanly so the renderer queue closes.
            self.clear_cancel(request_id);
            return Ok(());
        }

        let mut seq: u64 = 0;
        // Delay-one-chunk buffer so the final chunk can carry is_final = true.
        let mut pending: Option<SynthesisChunk> = None;

        for sentence in &sentences {
            if self.is_cancelled(request_id) || sink.is_cancelled() {
                self.clear_cancel(request_id);
                return Err(TtsError::Cancelled);
            }
            let speed = self.clamp_for_source(get_speed());
            let rendered = self.engine.synthesize_sentence(sentence, voice, lang, speed)?;
            let chunk = match rendered {
                SentenceAudio::F32le { samples, sample_rate } => {
                    if samples.is_empty() {
                        continue; // silent sentence → skip (no empty chunk)
                    }
                    SynthesisChunk::f32le(samples, sample_rate, seq, false)
                }
                SentenceAudio::Mp3 { bytes } => {
                    if bytes.is_empty() {
                        continue;
                    }
                    SynthesisChunk::mp3(bytes, seq, false)
                }
            };
            // Flush the previously-pending chunk (NOT final — another came after).
            if let Some(prev) = pending.take() {
                if !sink.push(prev) {
                    self.clear_cancel(request_id);
                    return Err(TtsError::Cancelled);
                }
            }
            pending = Some(chunk);
            seq += 1;
        }

        // Emit the last chunk with is_final = true.
        if let Some(mut last) = pending.take() {
            last.is_final = true;
            if !sink.push(last) {
                self.clear_cancel(request_id);
                return Err(TtsError::Cancelled);
            }
        }
        self.clear_cancel(request_id);
        Ok(())
    }

    fn clamp_for_source(&self, speed: f32) -> f32 {
        match self.source {
            TtsSource::Local => clamp_speed(speed),
            TtsSource::Cloud => clamp_cloud_speed(speed),
        }
    }

    fn clear_cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancelled.lock() {
            map.remove(request_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri-event bridge — the sink-less entry point the command layer calls.
//
// The renderer's Web-Audio playback queue is byte-identical to WinSTT's Electron
// contract; only the transport swaps (`IPC.TTS_CHUNK` → the `tts://chunk` Tauri
// event). `read_aloud_emit` drives `read_aloud` with a sink that forwards each
// chunk as a `tts://chunk` event and fires the lifecycle events around it.
// ---------------------------------------------------------------------------

/// The `tts://chunk` event payload — the exact JSON field shape the renderer
/// playback queue already consumes (PORT/06_tts.md §1). `pcm` carries the f32le
/// samples re-interpreted as bytes (local) or the encoded mp3 bytes (cloud).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TtsChunkPayload {
    pub request_id: String,
    pub sample_rate: u32,
    pub seq: u64,
    pub is_final: bool,
    pub format: &'static str,
    pub channels: u8,
    /// f32le bytes (little-endian) for local, or mp3 container bytes for cloud.
    pub pcm: Vec<u8>,
}

impl TtsChunkPayload {
    fn from_chunk(request_id: &str, chunk: &SynthesisChunk) -> Self {
        let pcm = match chunk.format {
            Format::F32le => {
                // pack f32 samples as little-endian bytes
                let mut bytes = Vec::with_capacity(chunk.audio.len() * 4);
                for s in chunk.audio.iter() {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                bytes
            }
            Format::Mp3 => chunk.encoded.to_vec(),
        };
        Self {
            request_id: request_id.to_string(),
            sample_rate: chunk.sample_rate,
            seq: chunk.seq,
            is_final: chunk.is_final,
            format: chunk.format.as_str(),
            channels: chunk.channels,
            pcm,
        }
    }
}

/// Minimal emitter the host implements over Tauri's event bus. Keeps `mod.rs`
/// free of a hard `tauri` event-API dependency at this boundary (the command
/// layer wires a real `AppHandle`-backed impl) and makes the bridge unit-testable.
pub trait TtsEventEmitter: Send + Sync {
    /// Emit one `tts://chunk` event.
    fn emit_chunk(&self, payload: &TtsChunkPayload);
    /// Emit a lifecycle event (`tts://started` / `tts://completed` /
    /// `tts://failed`) by name with a JSON payload.
    fn emit_lifecycle(&self, event: &str, payload: serde_json::Value);
}

/// A `ChunkSink` that forwards chunks to a `TtsEventEmitter` as `tts://chunk`
/// events and polls a shared cancel flag (set by `TtsManager::cancel*`). The
/// manager's own per-request cancel map is the authority; this flag mirrors a
/// renderer-side "discard" that arrived after the sink was created.
struct EmitSink<'a> {
    request_id: String,
    emitter: &'a dyn TtsEventEmitter,
    cancel: &'a std::sync::atomic::AtomicBool,
}

impl ChunkSink for EmitSink<'_> {
    fn push(&self, chunk: SynthesisChunk) -> bool {
        if self.cancel.load(Ordering::Acquire) {
            return false;
        }
        let payload = TtsChunkPayload::from_chunk(&self.request_id, &chunk);
        self.emitter.emit_chunk(&payload);
        true
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
}

impl TtsManager {
    /// Sink-less read: drive `read_aloud`, forwarding chunks to `emitter` as
    /// `tts://chunk` events and firing `tts://started` / `tts://completed` /
    /// `tts://failed` around the run. This is the entry point the Tauri command
    /// layer calls (it already runs on a `spawn_blocking` worker). `get_speed`
    /// is sampled per sentence (mid-read speed change → next sentence).
    pub fn read_aloud_emit(
        &self,
        request_id: &str,
        text: &str,
        voice: &str,
        lang: &str,
        get_speed: impl Fn() -> f32,
        emitter: &dyn TtsEventEmitter,
    ) {
        let started = std::time::Instant::now();
        emitter.emit_lifecycle(
            "tts://started",
            serde_json::json!({ "request_id": request_id }),
        );
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let sink = EmitSink {
            request_id: request_id.to_string(),
            emitter,
            cancel: &cancel,
        };
        let result = self.read_aloud(request_id, text, voice, lang, get_speed, &sink);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(()) => emitter.emit_lifecycle(
                "tts://completed",
                serde_json::json!({
                    "request_id": request_id,
                    "cancelled": false,
                    "elapsed_ms": elapsed_ms,
                }),
            ),
            Err(TtsError::Cancelled) => emitter.emit_lifecycle(
                "tts://completed",
                serde_json::json!({
                    "request_id": request_id,
                    "cancelled": true,
                    "elapsed_ms": elapsed_ms,
                }),
            ),
            Err(e) => emitter.emit_lifecycle(
                "tts://failed",
                serde_json::json!({
                    "request_id": request_id,
                    "reason": e.to_string(),
                    "category": tts_error_category(&e),
                }),
            ),
        }
    }
}

/// Coarse error category for the renderer's failure pill (mirrors WinSTT's
/// `category` field: NETWORK / ENGINE / CLOUD / INPUT).
pub fn tts_error_category(e: &TtsError) -> &'static str {
    match e {
        TtsError::Download(_) | TtsError::Paused => "NETWORK",
        TtsError::Engine(_) => "ENGINE",
        TtsError::Cloud(_) => "CLOUD",
        TtsError::Invalid(_) => "INPUT",
        TtsError::Cancelled => "CANCELLED",
    }
}

// ===========================================================================
// REAL, DETERMINISTIC DATA + LOGIC (compilable + unit-tested)
// ===========================================================================

/// The 54-voice Kokoro v1.0 catalog across 9 languages. Verbatim port of
/// `server/src/synthesizer/infrastructure/voice_catalog.py` — the `id` and
/// `language` strings are EXACTLY what the Kokoro engine accepts.
pub const KOKORO_VOICE_CATALOG: &[VoiceInfo] = &[
    // American English — Female (11)
    VoiceInfo { id: "af_heart",   label: "Heart (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_alloy",   label: "Alloy (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_aoede",   label: "Aoede (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_bella",   label: "Bella (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_jessica", label: "Jessica (US)", language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_kore",    label: "Kore (US)",    language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_nicole",  label: "Nicole (US)",  language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_nova",    label: "Nova (US)",    language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_river",   label: "River (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_sarah",   label: "Sarah (US)",   language: "en-us", gender: Gender::Female },
    VoiceInfo { id: "af_sky",     label: "Sky (US)",     language: "en-us", gender: Gender::Female },
    // American English — Male (9)
    VoiceInfo { id: "am_adam",    label: "Adam (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_echo",    label: "Echo (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_eric",    label: "Eric (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_fenrir",  label: "Fenrir (US)",  language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_liam",    label: "Liam (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_michael", label: "Michael (US)", language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_onyx",    label: "Onyx (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_puck",    label: "Puck (US)",    language: "en-us", gender: Gender::Male },
    VoiceInfo { id: "am_santa",   label: "Santa (US)",   language: "en-us", gender: Gender::Male },
    // British English — Female (4)
    VoiceInfo { id: "bf_alice",    label: "Alice (UK)",    language: "en-gb", gender: Gender::Female },
    VoiceInfo { id: "bf_emma",     label: "Emma (UK)",     language: "en-gb", gender: Gender::Female },
    VoiceInfo { id: "bf_isabella", label: "Isabella (UK)", language: "en-gb", gender: Gender::Female },
    VoiceInfo { id: "bf_lily",     label: "Lily (UK)",     language: "en-gb", gender: Gender::Female },
    // British English — Male (4)
    VoiceInfo { id: "bm_daniel", label: "Daniel (UK)", language: "en-gb", gender: Gender::Male },
    VoiceInfo { id: "bm_fable",  label: "Fable (UK)",  language: "en-gb", gender: Gender::Male },
    VoiceInfo { id: "bm_george", label: "George (UK)", language: "en-gb", gender: Gender::Male },
    VoiceInfo { id: "bm_lewis",  label: "Lewis (UK)",  language: "en-gb", gender: Gender::Male },
    // Japanese (5)
    VoiceInfo { id: "jf_alpha",      label: "Alpha (JP)",      language: "ja", gender: Gender::Female },
    VoiceInfo { id: "jf_gongitsune", label: "Gongitsune (JP)", language: "ja", gender: Gender::Female },
    VoiceInfo { id: "jf_nezumi",     label: "Nezumi (JP)",     language: "ja", gender: Gender::Female },
    VoiceInfo { id: "jf_tebukuro",   label: "Tebukuro (JP)",   language: "ja", gender: Gender::Female },
    VoiceInfo { id: "jm_kumo",       label: "Kumo (JP)",       language: "ja", gender: Gender::Male },
    // Mandarin Chinese (8)
    VoiceInfo { id: "zf_xiaobei",  label: "Xiaobei (ZH)",  language: "cmn", gender: Gender::Female },
    VoiceInfo { id: "zf_xiaoni",   label: "Xiaoni (ZH)",   language: "cmn", gender: Gender::Female },
    VoiceInfo { id: "zf_xiaoxiao", label: "Xiaoxiao (ZH)", language: "cmn", gender: Gender::Female },
    VoiceInfo { id: "zf_xiaoyi",   label: "Xiaoyi (ZH)",   language: "cmn", gender: Gender::Female },
    VoiceInfo { id: "zm_yunjian",  label: "Yunjian (ZH)",  language: "cmn", gender: Gender::Male },
    VoiceInfo { id: "zm_yunxi",    label: "Yunxi (ZH)",    language: "cmn", gender: Gender::Male },
    VoiceInfo { id: "zm_yunxia",   label: "Yunxia (ZH)",   language: "cmn", gender: Gender::Male },
    VoiceInfo { id: "zm_yunyang",  label: "Yunyang (ZH)",  language: "cmn", gender: Gender::Male },
    // Spanish (3)
    VoiceInfo { id: "ef_dora",  label: "Dora (ES)",  language: "es", gender: Gender::Female },
    VoiceInfo { id: "em_alex",  label: "Alex (ES)",  language: "es", gender: Gender::Male },
    VoiceInfo { id: "em_santa", label: "Santa (ES)", language: "es", gender: Gender::Male },
    // French (1)
    VoiceInfo { id: "ff_siwis", label: "Siwis (FR)", language: "fr", gender: Gender::Female },
    // Hindi (4)
    VoiceInfo { id: "hf_alpha", label: "Alpha (HI)", language: "hi", gender: Gender::Female },
    VoiceInfo { id: "hf_beta",  label: "Beta (HI)",  language: "hi", gender: Gender::Female },
    VoiceInfo { id: "hm_omega", label: "Omega (HI)", language: "hi", gender: Gender::Male },
    VoiceInfo { id: "hm_psi",   label: "Psi (HI)",   language: "hi", gender: Gender::Male },
    // Italian (2)
    VoiceInfo { id: "if_sara",   label: "Sara (IT)",   language: "it", gender: Gender::Female },
    VoiceInfo { id: "im_nicola", label: "Nicola (IT)", language: "it", gender: Gender::Male },
    // Brazilian Portuguese (3)
    VoiceInfo { id: "pf_dora",  label: "Dora (BR)",  language: "pt-br", gender: Gender::Female },
    VoiceInfo { id: "pm_alex",  label: "Alex (BR)",  language: "pt-br", gender: Gender::Male },
    VoiceInfo { id: "pm_santa", label: "Santa (BR)", language: "pt-br", gender: Gender::Male },
];

/// The 9 languages surfaced to the renderer language picker.
pub const SUPPORTED_LANGUAGES: &[(&str, &str)] = &[
    ("en-us", "English (US)"),
    ("en-gb", "English (UK)"),
    ("ja", "Japanese"),
    ("cmn", "Mandarin"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("it", "Italian"),
    ("pt-br", "Portuguese (BR)"),
];

/// Look up a voice by id (renderer-selected voice validation).
pub fn voice_by_id(id: &str) -> Option<&'static VoiceInfo> {
    KOKORO_VOICE_CATALOG.iter().find(|v| v.id == id)
}

/// Voices belonging to a language code (UI grouping).
pub fn voices_for_language(lang: &str) -> Vec<&'static VoiceInfo> {
    KOKORO_VOICE_CATALOG.iter().filter(|v| v.language == lang).collect()
}

// --- Sentence splitter (verbatim port of tts-reader.ts splitSentences) ------

/// Cap an over-long sentence so one giant clause can't block the whole read.
pub const DEFAULT_MAX_SENTENCE_LEN: usize = 240;

/// Split `text` into sentence-sized chunks for sequential synthesis. Splits
/// after sentence-ending punctuation (`. ! ?`, optionally a closing quote /
/// bracket) and hard-caps over-long sentences at `max_len`. Blank input → `[]`.
/// Verbatim behavioral port of `splitSentences` in tts-reader.ts.
pub fn split_sentences(text: &str, max_len: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let rough = rough_split(trimmed);
    let pieces = if rough.is_empty() {
        vec![trimmed.to_string()]
    } else {
        rough
    };
    let mut out: Vec<String> = Vec::new();
    for piece in pieces {
        let sentence = piece.trim();
        if sentence.is_empty() {
            continue;
        }
        if sentence.chars().count() <= max_len {
            out.push(sentence.to_string());
        } else {
            out.extend(chunk_long_sentence(sentence, max_len));
        }
    }
    out
}

/// Equivalent of the JS regex `/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g`.
fn rough_split(s: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_terminator(c) {
            while i < chars.len() && is_terminator(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            while i < chars.len() && is_closer(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            while i < chars.len() && chars[i].is_whitespace() {
                current.push(chars[i]);
                i += 1;
            }
            pieces.push(std::mem::take(&mut current));
        } else {
            current.push(c);
            i += 1;
        }
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

fn is_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?')
}

fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | ')' | ']')
}

/// Break `long` into ≤`max_len` pieces on whitespace boundaries. Verbatim port
/// of `chunkLongSentence`.
fn chunk_long_sentence(long: &str, max_len: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in long.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };
        if candidate.chars().count() <= max_len {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        if word.chars().count() > max_len {
            let wchars: Vec<char> = word.chars().collect();
            let mut i = 0;
            while i < wchars.len() {
                let end = (i + max_len).min(wchars.len());
                out.push(wchars[i..end].iter().collect());
                i = end;
            }
            current.clear();
        } else {
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

// ===========================================================================
// Tests (deterministic logic + streaming sequencing with a fake engine)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // --- catalog invariants ---

    #[test]
    fn catalog_has_54_voices() {
        assert_eq!(KOKORO_VOICE_CATALOG.len(), 54);
    }

    #[test]
    fn catalog_has_9_languages() {
        assert_eq!(SUPPORTED_LANGUAGES.len(), 9);
    }

    #[test]
    fn every_catalog_language_is_in_supported_languages() {
        let supported: std::collections::HashSet<&str> =
            SUPPORTED_LANGUAGES.iter().map(|(c, _)| *c).collect();
        for v in KOKORO_VOICE_CATALOG {
            assert!(supported.contains(v.language), "voice {} has unlisted language {}", v.id, v.language);
        }
    }

    #[test]
    fn every_supported_language_has_at_least_one_voice() {
        for (code, _) in SUPPORTED_LANGUAGES {
            assert!(KOKORO_VOICE_CATALOG.iter().any(|v| v.language == *code), "language {code} has no voices");
        }
    }

    #[test]
    fn voice_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for v in KOKORO_VOICE_CATALOG {
            assert!(seen.insert(v.id), "duplicate voice id {}", v.id);
        }
    }

    #[test]
    fn default_voice_exists() {
        assert!(voice_by_id("af_heart").is_some());
    }

    #[test]
    fn per_language_counts_match_winstt() {
        let expected = [
            ("en-us", 20), ("en-gb", 8), ("ja", 5), ("cmn", 8),
            ("es", 3), ("fr", 1), ("hi", 4), ("it", 2), ("pt-br", 3),
        ];
        for (lang, count) in expected {
            assert_eq!(voices_for_language(lang).len(), count, "language {lang} count mismatch");
        }
    }

    // --- speed clamps ---

    #[test]
    fn local_speed_clamps_to_0_5_2_0() {
        assert_eq!(clamp_speed(0.1), 0.5);
        assert_eq!(clamp_speed(1.0), 1.0);
        assert_eq!(clamp_speed(3.0), 2.0);
    }

    #[test]
    fn cloud_speed_clamps_to_0_7_1_2() {
        assert_eq!(clamp_cloud_speed(0.1), 0.7);
        assert_eq!(clamp_cloud_speed(1.0), 1.0);
        assert_eq!(clamp_cloud_speed(5.0), 1.2);
    }

    // --- sentence splitter parity with tts-reader.ts ---

    #[test]
    fn split_blank_is_empty() {
        assert!(split_sentences("", DEFAULT_MAX_SENTENCE_LEN).is_empty());
        assert!(split_sentences("   \n  ", DEFAULT_MAX_SENTENCE_LEN).is_empty());
    }

    #[test]
    fn split_three_sentences() {
        let out = split_sentences("Hello there. How are you? I am fine!", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["Hello there.", "How are you?", "I am fine!"]);
    }

    #[test]
    fn split_keeps_trailing_unterminated_run() {
        let out = split_sentences("First. Then this", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["First.", "Then this"]);
    }

    #[test]
    fn split_consumes_trailing_quote_after_terminator() {
        let out = split_sentences("He said \"hi.\" Then left.", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["He said \"hi.\"", "Then left."]);
    }

    #[test]
    fn split_collapses_multiple_terminators() {
        let out = split_sentences("Wait?! Really.", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["Wait?!", "Really."]);
    }

    #[test]
    fn split_caps_overlong_sentence_on_word_boundary() {
        let long = "abcdefghi ".repeat(10);
        let out = split_sentences(long.trim(), 20);
        assert!(out.len() > 1);
        for chunk in &out {
            assert!(chunk.chars().count() <= 20, "chunk too long: {chunk:?}");
        }
    }

    #[test]
    fn split_hard_splits_single_overlong_word() {
        let word = "x".repeat(50);
        let out = split_sentences(&word, 20);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].chars().count(), 20);
        assert_eq!(out[2].chars().count(), 10);
    }

    #[test]
    fn split_no_terminator_returns_whole() {
        let out = split_sentences("just a plain phrase", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["just a plain phrase"]);
    }

    // --- cloud request builder + classifier + parsers ---

    #[test]
    fn cloud_url_includes_voice_and_safe_format() {
        let url = build_cloud_url("voice123");
        assert!(url.contains("/voice123?"));
        assert!(url.contains("output_format=mp3_44100_128"));
    }

    #[test]
    fn cloud_body_maps_snake_case_and_clamps_speed() {
        let req = CloudSynthesisRequest {
            api_key: "k".into(),
            voice_id: "v".into(),
            model_id: "eleven_multilingual_v2".into(),
            text: "hi".into(),
            settings: CloudVoiceSettings {
                stability: 0.5,
                similarity: 0.75,
                style: 0.1,
                speaker_boost: true,
                speed: 5.0,
            },
        };
        let body = build_cloud_body(&req);
        assert_eq!(body["text"], "hi");
        assert_eq!(body["model_id"], "eleven_multilingual_v2");
        let vs = &body["voice_settings"];
        assert_eq!(vs["similarity_boost"], 0.75);
        assert_eq!(vs["use_speaker_boost"], true);
        // f32 1.2 serializes as 1.2000000476837158 in JSON — compare with tolerance.
        assert!(
            (vs["speed"].as_f64().unwrap() - 1.2).abs() < 1e-4,
            "speed ~1.2, got {}",
            vs["speed"]
        );
    }

    #[test]
    fn cloud_status_classification_by_http() {
        assert!(classify_cloud_status(401, None).contains("invalid API key"));
        assert!(classify_cloud_status(402, None).contains("paid plan"));
        assert!(classify_cloud_status(429, None).contains("rate limited"));
        assert!(classify_cloud_status(500, None).contains("HTTP 500"));
    }

    #[test]
    fn cloud_status_classification_prefers_detail_status() {
        // a scoped key missing voices_read 401s with missing_permissions — NOT invalid
        assert!(classify_cloud_status(401, Some("missing_permissions")).contains("missing a required permission"));
        assert!(classify_cloud_status(402, Some("quota_exceeded")).contains("quota exceeded"));
        assert!(classify_cloud_status(404, Some("voice_not_found")).contains("voice not found"));
    }

    #[test]
    fn parse_detail_status_reads_nested_field() {
        let body = r#"{"detail":{"status":"quota_exceeded","message":"over quota"}}"#;
        assert_eq!(parse_detail_status(body).as_deref(), Some("quota_exceeded"));
        // string-form detail → no status
        assert_eq!(parse_detail_status(r#"{"detail":"oops"}"#), None);
        assert_eq!(parse_detail_status("not json"), None);
    }

    #[test]
    fn parse_cloud_voices_maps_fields() {
        let body = r#"{"voices":[
            {"voice_id":"abc","name":"Rachel","category":"premade",
             "labels":{"language":"en"},"preview_url":"https://cdn/x.mp3"},
            {"voice_id":"def","name":"Custom"}
        ]}"#;
        let voices = parse_cloud_voices(body);
        assert_eq!(voices.len(), 2);
        assert_eq!(voices[0].id, "abc");
        assert_eq!(voices[0].name, "Rachel");
        assert_eq!(voices[0].language.as_deref(), Some("en"));
        assert_eq!(voices[0].preview_url.as_deref(), Some("https://cdn/x.mp3"));
        assert_eq!(voices[1].id, "def");
        assert!(voices[1].language.is_none());
    }

    #[test]
    fn parse_cloud_voices_handles_garbage() {
        assert!(parse_cloud_voices("not json").is_empty());
        assert!(parse_cloud_voices("{}").is_empty());
    }

    // --- cloud engine guards ---

    #[test]
    fn cloud_engine_rejects_missing_key_and_voice() {
        let eng = ElevenLabsEngine::new(String::new(), "m".into(), CloudVoiceSettings::default());
        assert!(matches!(eng.synthesize_sentence("hi", "v", "en", 1.0), Err(TtsError::Cloud(_))));
        let eng2 = ElevenLabsEngine::new("key".into(), "m".into(), CloudVoiceSettings::default());
        assert!(matches!(eng2.synthesize_sentence("hi", "", "en", 1.0), Err(TtsError::Cloud(_))));
    }

    #[test]
    fn cloud_engine_refuses_non_https_preview() {
        let eng = ElevenLabsEngine::new("key".into(), "m".into(), CloudVoiceSettings::default());
        assert!(matches!(eng.fetch_preview("http://insecure/x.mp3"), Err(TtsError::Cloud(_))));
    }

    #[test]
    fn cloud_engine_is_ready_only_with_key() {
        assert!(!ElevenLabsEngine::new(String::new(), "m".into(), CloudVoiceSettings::default()).is_ready());
        assert!(ElevenLabsEngine::new("k".into(), "m".into(), CloudVoiceSettings::default()).is_ready());
    }

    // --- streaming sequencing (fake engine, no ort/network) ---

    /// A fake engine that returns one short f32 buffer per non-empty sentence.
    struct FakeEngine {
        calls: StdMutex<Vec<String>>,
    }
    impl FakeEngine {
        fn new() -> Self {
            Self { calls: StdMutex::new(Vec::new()) }
        }
    }
    impl TtsEngine for FakeEngine {
        fn synthesize_sentence(&self, text: &str, _v: &str, _l: &str, _s: f32) -> TtsResult<SentenceAudio> {
            self.calls.lock().unwrap().push(text.to_string());
            Ok(SentenceAudio::F32le { samples: vec![0.1, 0.2, 0.3], sample_rate: KOKORO_SAMPLE_RATE })
        }
        fn list_voices(&self) -> Vec<VoiceInfo> {
            KOKORO_VOICE_CATALOG.to_vec()
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn warm_up(&self) -> TtsResult<()> {
            Ok(())
        }
        fn shutdown(&self) {}
    }

    struct CollectSink {
        chunks: StdMutex<Vec<SynthesisChunk>>,
        cancel: AtomicBool,
    }
    impl CollectSink {
        fn new() -> Self {
            Self { chunks: StdMutex::new(Vec::new()), cancel: AtomicBool::new(false) }
        }
    }
    impl ChunkSink for CollectSink {
        fn push(&self, chunk: SynthesisChunk) -> bool {
            self.chunks.lock().unwrap().push(chunk);
            true
        }
        fn is_cancelled(&self) -> bool {
            self.cancel.load(Ordering::Acquire)
        }
    }

    #[test]
    fn read_aloud_emits_one_chunk_per_sentence_with_final_flag() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let sink = CollectSink::new();
        mgr.read_aloud("rq1", "One. Two. Three.", "af_heart", "en-us", || 1.0, &sink).unwrap();
        let chunks = sink.chunks.lock().unwrap();
        assert_eq!(chunks.len(), 3);
        // seq is monotonic 0,1,2
        assert_eq!(chunks.iter().map(|c| c.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        // only the last is final
        assert!(!chunks[0].is_final);
        assert!(!chunks[1].is_final);
        assert!(chunks[2].is_final);
        // format + sample rate
        assert_eq!(chunks[0].format, Format::F32le);
        assert_eq!(chunks[0].sample_rate, KOKORO_SAMPLE_RATE);
    }

    #[test]
    fn read_aloud_empty_text_is_noop() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let sink = CollectSink::new();
        mgr.read_aloud("rq", "   ", "af_heart", "en-us", || 1.0, &sink).unwrap();
        assert!(sink.chunks.lock().unwrap().is_empty());
    }

    #[test]
    fn read_aloud_cancel_between_sentences_returns_cancelled() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let sink = CollectSink::new();
        // cancel up front → first iteration sees it and bails before any synth
        mgr.cancel("rq");
        let res = mgr.read_aloud("rq", "One. Two.", "af_heart", "en-us", || 1.0, &sink);
        assert!(matches!(res, Err(TtsError::Cancelled)));
        assert!(sink.chunks.lock().unwrap().is_empty());
    }

    #[test]
    fn read_aloud_sink_cancel_stops_production() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let sink = CollectSink::new();
        sink.cancel.store(true, Ordering::Release);
        let res = mgr.read_aloud("rq", "One. Two.", "af_heart", "en-us", || 1.0, &sink);
        assert!(matches!(res, Err(TtsError::Cancelled)));
    }

    #[test]
    fn cancel_all_marks_inflight_requests() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        mgr.cancel("a");
        mgr.cancel_all();
        assert!(mgr.is_cancelled("a"));
    }

    #[test]
    fn next_request_id_is_unique_and_prefixed() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let a = mgr.next_request_id();
        let b = mgr.next_request_id();
        assert!(a.starts_with("tts-"));
        assert_ne!(a, b);
    }

    // --- emitter bridge ---

    struct RecordingEmitter {
        chunks: StdMutex<Vec<TtsChunkPayload>>,
        lifecycle: StdMutex<Vec<(String, serde_json::Value)>>,
    }
    impl RecordingEmitter {
        fn new() -> Self {
            Self { chunks: StdMutex::new(Vec::new()), lifecycle: StdMutex::new(Vec::new()) }
        }
    }
    impl TtsEventEmitter for RecordingEmitter {
        fn emit_chunk(&self, payload: &TtsChunkPayload) {
            self.chunks.lock().unwrap().push(payload.clone());
        }
        fn emit_lifecycle(&self, event: &str, payload: serde_json::Value) {
            self.lifecycle.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[test]
    fn read_aloud_emit_fires_started_chunks_and_completed() {
        let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
        let emitter = RecordingEmitter::new();
        mgr.read_aloud_emit("rq", "One. Two.", "af_heart", "en-us", || 1.0, &emitter);
        let chunks = emitter.chunks.lock().unwrap();
        assert_eq!(chunks.len(), 2);
        // f32le pcm bytes = 3 samples * 4 bytes
        assert_eq!(chunks[0].pcm.len(), 12);
        assert_eq!(chunks[0].format, "f32le");
        assert!(chunks[1].is_final);
        let life = emitter.lifecycle.lock().unwrap();
        assert_eq!(life[0].0, "tts://started");
        assert_eq!(life.last().unwrap().0, "tts://completed");
        assert_eq!(life.last().unwrap().1["cancelled"], false);
    }

    #[test]
    fn tts_chunk_payload_packs_f32_little_endian() {
        let chunk = SynthesisChunk::f32le(vec![1.0, -1.0], KOKORO_SAMPLE_RATE, 0, true);
        let p = TtsChunkPayload::from_chunk("rq", &chunk);
        assert_eq!(p.pcm.len(), 8);
        // 1.0f32 LE = 00 00 80 3F
        assert_eq!(&p.pcm[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&p.pcm[4..8], &(-1.0f32).to_le_bytes());
        assert!(p.is_final);
        assert_eq!(p.format, "f32le");
    }

    #[test]
    fn error_category_mapping() {
        assert_eq!(tts_error_category(&TtsError::Download("x".into())), "NETWORK");
        assert_eq!(tts_error_category(&TtsError::Engine("x".into())), "ENGINE");
        assert_eq!(tts_error_category(&TtsError::Cloud("x".into())), "CLOUD");
        assert_eq!(tts_error_category(&TtsError::Invalid("x".into())), "INPUT");
        assert_eq!(tts_error_category(&TtsError::Cancelled), "CANCELLED");
    }
}
