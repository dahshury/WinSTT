// DRAFT PORT — not yet compiled. Source: server/src/synthesizer/ (Kokoro-ONNX hexagonal subsystem),
// frontend/electron/ipc/{tts.ts,tts-cloud.ts,tts-reader.ts,tts-hotkey.ts}, and the WinSTT settings
// schema (frontend/src/shared/config/settings-schema.ts ttsSettingsSchema).
//
// ⚠️ LICENSING — READ PORT/06_tts.md §1 BEFORE TOUCHING THE LOCAL ENGINE.
// The in-process Kokoro choice cargo-links a Kokoro crate (e.g. `kokorox`/`kokoroxide`) whose phonemizer
// statically links espeak-ng (GPL-v3). That makes the WHOLE Tauri binary GPL-v3. If WinSTT must stay
// proprietary, switch the local path to the SIDECAR variant (a separately-downloaded GPL process talking
// over stdio/IPC, see PORT/06_tts.md §"Sidecar fallback") OR a pure-Rust-phonemizer crate (e.g. `any-tts`,
// which ships an in-tree espeak-rs-compatible phonemizer — verify its license at compile time). The trait
// below is engine-agnostic precisely so the engine can be swapped without touching call sites.
//
// This file is a SPEC + trait/interface STUB for the heavy ML/native subsystem (Kokoro ONNX session,
// espeak phonemization, gap-free streaming). The DETERMINISTIC parts that we CAN write and test without a
// compiler — the 54-voice / 9-language catalog, the sentence splitter, the speed clamp, the cloud request
// body builder — are real code with `#[cfg(test)]` unit tests at the bottom. The native engine wiring is a
// stub returning `TtsError::NotImplemented` until the build loop is live.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Public DTOs (mirror server/src/synthesizer/domain/ports/synthesizer.py)
// ---------------------------------------------------------------------------

/// One slice of synthesized audio, emitted as the stream proceeds.
///
/// Mirrors Python `SynthesisChunk`: `audio` is 1-D f32 PCM at `sample_rate`;
/// `seq` is monotonic per stream; `is_final` flags the last chunk so the
/// renderer's playback queue can `markComplete()` exactly once.
///
/// Wire contract to the renderer (identical for local + cloud so the Web-Audio
/// playback queue is source-agnostic — see frontend/.../features/tts-playback):
///   `{ request_id, sample_rate, seq, is_final, format, channels, pcm }`
/// where `format` is `"f32le"` for the local Kokoro path (raw mono f32) and
/// `"mp3"` for the cloud path (encoded container the renderer decodeAudioData's).
#[derive(Clone, Debug)]
pub struct SynthesisChunk {
    /// 1-D mono PCM. For `Format::F32le` these are the float samples directly;
    /// for `Format::Mp3` this is the encoded byte payload (re-interpreted).
    pub audio: Arc<[f32]>,
    /// Raw encoded bytes when `format == Mp3` (cloud). Empty for f32le.
    pub encoded: Arc<[u8]>,
    pub sample_rate: u32,
    pub seq: u64,
    pub is_final: bool,
    pub format: Format,
    pub channels: u8,
}

/// Playback-queue format tag. `F32le` = raw mono float PCM (local Kokoro);
/// `Mp3` = encoded container the renderer decodes via Web Audio (cloud).
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
/// Mirrors Python `VoiceInfo`. `gender` is informational (UI grouping only).
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
// Config (mirrors SynthesizerConfig + ttsSettingsSchema)
// ---------------------------------------------------------------------------

/// Synthesizer configuration. Defaults mirror WinSTT's
/// `server/src/synthesizer/domain/config.py` and the renderer
/// `ttsSettingsSchema`. `device` is NOT a standalone TTS setting in WinSTT —
/// TTS shares the main STT model's device (`model.device`); the host wires that
/// value in here (see memory `project_tts_device_follows_model_device`).
#[derive(Clone, Debug)]
pub struct LocalTtsConfig {
    /// `%LOCALAPPDATA%/winstt/tts/kokoro` (resolved by the host). Both the
    /// `.onnx` and `voices-v1.0.bin` live here.
    pub cache_dir: PathBuf,
    /// Default `kokoro-v1.0.fp16.onnx` — 163 MB, near-fp32 quality.
    pub model_filename: String,
    /// Default `voices-v1.0.bin` (~27 MB, all 54 voicepacks).
    pub voices_filename: String,
    pub voice: String,
    pub lang: String,
    /// Clamped to [MIN_SPEED, MAX_SPEED] before reaching the engine.
    pub speed: f32,
    /// Mirrors STT device policy. `Auto`/`DirectMl` → CPU fallback on failure.
    /// Kokoro is small (82M) and DirectML-safe (unlike the int8 STT families),
    /// so it follows the model device with a graceful CPU demotion.
    pub device: TtsDevice,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsDevice {
    Auto,
    DirectMl,
    Cpu,
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

/// Clamp range for the local Kokoro speed multiplier (WinSTT: 0.5..2.0).
pub const MIN_SPEED: f32 = 0.5;
pub const MAX_SPEED: f32 = 2.0;
/// Cloud (ElevenLabs) speed multiplier range (WinSTT: 0.7..1.2).
pub const CLOUD_MIN_SPEED: f32 = 0.7;
pub const CLOUD_MAX_SPEED: f32 = 1.2;
/// Defends against a known Kokoro phoneme-overflow IndexError on huge inputs.
pub const MAX_SYNTHESIS_CHARS: usize = 8000;
/// Kokoro v1.0 emits 24 kHz mono.
pub const KOKORO_SAMPLE_RATE: u32 = 24_000;

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
    /// Native engine path not yet ported (stub guard).
    NotImplemented,
    /// Engine pack / model download could not finish (network).
    Download(String),
    /// Download/synthesis was paused cooperatively (resume via re-init).
    Paused,
    /// User cancelled — distinct from a real failure.
    Cancelled,
    /// ONNX session create / inference failure.
    Engine(String),
    /// Cloud HTTP / auth / quota error (human-readable, already classified).
    Cloud(String),
    /// Bad input (empty text, unknown voice, etc.).
    Invalid(String),
}

impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TtsError::NotImplemented => write!(f, "TTS engine not yet implemented (DRAFT PORT)"),
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
// Engine port (the heavy ML subsystem — STUB, do not speculatively implement)
// ---------------------------------------------------------------------------

/// A consumer-cancellable stream of synthesis chunks.
///
/// The local Kokoro engine yields one chunk per sentence (so playback starts
/// early); the cloud engine yields one encoded chunk per request. The host
/// drains this and re-tags each chunk onto the parent `request_id` (see the
/// sentence-reader contract). A `cancel` token stops iteration at the next
/// chunk boundary — the engine MUST release in-flight native work there.
///
/// Implemented as a trait-object channel rather than `async-trait` so the
/// engine can push from a blocking ORT thread without an async runtime in the
/// inference loop (matches the WinSTT rule: never run model load/inference on
/// the async pump). The host bridges this to Tauri events.
pub trait ChunkSink: Send {
    /// Forward one chunk to the renderer. Returns `false` if the consumer is
    /// gone / cancelled and the engine should stop producing.
    fn push(&self, chunk: SynthesisChunk) -> bool;
    /// True once the consumer requested cancellation — polled between sentences.
    fn is_cancelled(&self) -> bool;
}

/// The streaming TTS engine port. ONE implementation per backend
/// (`KokoroEngine` local, `ElevenLabsEngine` cloud). Mirrors Python
/// `ISpeechSynthesizer` (synthesize_stream / list_voices / is_ready / warm_up /
/// shutdown) but pushes via `ChunkSink` instead of returning an async iterator.
///
/// NOTE: methods are intentionally blocking. The host runs them on a dedicated
/// thread (`std::thread` / Tauri `async_runtime::spawn_blocking`) so the UI
/// event loop never stalls on the ~190 MB first-run download or session create.
pub trait TtsEngine: Send + Sync {
    /// Synthesize `text` with `voice`/`lang`/`speed`, pushing chunks to `sink`.
    /// Splits into sentences internally for the local path. Honors `sink`
    /// cancellation at sentence boundaries. Speed is pre-clamped by the host.
    fn synthesize_stream(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()>;

    /// Every voice this engine can render.
    fn list_voices(&self) -> Vec<VoiceInfo>;

    /// True once the ONNX session + voicepacks are loaded (local) or the key is
    /// present (cloud).
    fn is_ready(&self) -> bool;

    /// Force the engine-pack download + ONNX session load NOW (blocking,
    /// idempotent). Raises on failure; no-op once ready. The host runs this off
    /// the UI thread. Cloud impls treat this as a key-presence check.
    fn warm_up(&self) -> TtsResult<()>;

    /// Release native resources. Idempotent.
    fn shutdown(&self);
}

// ---------------------------------------------------------------------------
// Local Kokoro engine (STUB — heavy native/ML, ported in the build loop)
// ---------------------------------------------------------------------------

/// Local in-process Kokoro-82M ONNX engine.
///
/// ⚠️ The concrete impl cargo-links a Kokoro crate that statically links
/// espeak-ng (GPL-v3) → see file header + PORT/06_tts.md. The trait boundary
/// keeps this swappable for the sidecar / pure-Rust variant.
///
/// IMPLEMENTATION PLAN (build loop — do NOT speculatively write the body now):
///  1. On-demand assets: download `kokoro-v1.0.fp16.onnx` (163 MB) + voicepacks
///     `voices-v1.0.bin` (27 MB) from the upstream kokoro-onnx model-files-v1.0
///     release into `cache_dir`. Resumable (HTTP Range) — port WinSTT's
///     asset_downloader.rs semantics (`.partial` → atomic rename; pause/cancel).
///     This is SIMPLER than WinSTT's sys.path support-pack: the engine is a Rust
///     dependency, so there is NO 30 MB engine-pack download — only the two
///     model files. (Inventory 05_tts.md §7 mechanism does not apply in Rust.)
///  2. ort 2.0.0-rc.12 `Session::builder()`:
///       - `TtsDevice::Cpu`         → `CPUExecutionProvider`
///       - `TtsDevice::DirectMl`    → `DirectMLExecutionProvider` (Kokoro is
///         DirectML-SAFE; it is NOT in the int8 DML-incompatible STT families)
///       - `TtsDevice::Auto`        → try DirectML, fall back to CPU on session
///         create failure (graceful demotion, like WinSTT's CUDA→CPU path)
///     Reuse the STT slice's EP-resolution helper so there is ONE ort init path.
///  3. Phonemization: espeak-ng (via the Kokoro crate's bundled phonemizer) →
///     phoneme ids. KEEP it engine-internal; do not re-implement.
///  4. Stream: split `text` into sentences (`split_sentences`, real code below),
///     synthesize each, push a `SynthesisChunk { format: F32le, seq, is_final }`
///     per sentence so the renderer plays gap-free under one parent request_id.
///     Delay one chunk so the LAST can be flagged `is_final`.
///  5. Serialize concurrent calls behind a `Mutex` (Kokoro sessions are not
///     re-entrant — mirrors the Python `_synth_lock`).
pub struct KokoroEngine {
    config: LocalTtsConfig,
    // session: Option<ort::session::Session>,   // build loop
    // voicepacks: HashMap<String, Vec<f32>>,    // build loop (loaded from voices bin)
    // phonemizer: <bundled by the Kokoro crate>,
    ready: std::sync::atomic::AtomicBool,
}

impl KokoroEngine {
    pub fn new(config: LocalTtsConfig) -> Self {
        Self {
            config,
            ready: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Resolve the EP for `device`, with `Auto`/`DirectMl` demoting to CPU on
    /// failure. STUB — delegates to the shared STT EP resolver in the build loop.
    fn resolve_provider(&self) -> TtsDevice {
        // Build loop: probe DirectML availability via the shared ort helper.
        match self.config.device {
            TtsDevice::Cpu => TtsDevice::Cpu,
            // Auto/DirectMl resolved at session-create with CPU fallback.
            other => other,
        }
    }
}

impl TtsEngine for KokoroEngine {
    fn synthesize_stream(
        &self,
        text: &str,
        _voice: &str,
        _lang: &str,
        _speed: f32,
        _sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(()); // empty text → nothing to say (matches WinSTT)
        }
        if trimmed.chars().count() > MAX_SYNTHESIS_CHARS {
            return Err(TtsError::Invalid(format!(
                "text exceeds {MAX_SYNTHESIS_CHARS} chars"
            )));
        }
        // STUB: real impl ensures assets, loads the ort session, phonemizes per
        // sentence, and pushes F32le chunks. See IMPLEMENTATION PLAN above.
        Err(TtsError::NotImplemented)
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        KOKORO_VOICE_CATALOG.to_vec()
    }

    fn is_ready(&self) -> bool {
        self.ready.load(std::sync::atomic::Ordering::Acquire)
    }

    fn warm_up(&self) -> TtsResult<()> {
        // STUB: download assets + create ort session, then set `ready`.
        Err(TtsError::NotImplemented)
    }

    fn shutdown(&self) {
        self.ready.store(false, std::sync::atomic::Ordering::Release);
        // STUB: drop the ort session (Drop releases the native handle).
    }
}

// ---------------------------------------------------------------------------
// Cloud ElevenLabs engine (reqwest /v1/text-to-speech) — request builder is
// REAL CODE + tested; the network round-trip is a thin stub.
// ---------------------------------------------------------------------------

/// ElevenLabs voice-settings tuning, read from the encrypted store per call.
/// Mirrors `tts.cloud.*` in the WinSTT settings schema.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoiceSettings {
    /// 0..1
    pub stability: f32,
    /// 0..1 → ElevenLabs `similarity_boost`
    pub similarity: f32,
    /// 0..1
    pub style: f32,
    /// → ElevenLabs `use_speaker_boost`
    pub speaker_boost: bool,
    /// 0.7..1.2 → ElevenLabs `voice_settings.speed`
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
    /// ElevenLabs `voice_id` (account voice, incl. cloned).
    pub voice_id: String,
    /// Streaming-PCM-capable model id (default `eleven_multilingual_v2`).
    pub model_id: String,
    pub text: String,
    pub settings: CloudVoiceSettings,
}

/// ElevenLabs Create-Speech endpoint for a given voice id.
/// `output_format` is a query param. We request mp3 by default because raw
/// `pcm_*` is gated behind the Pro tier and 402s on free/starter keys (verified
/// against ElevenLabs docs + WinSTT's tts-cloud.ts comment). The renderer
/// decodes the mp3 via Web Audio, so no decoder is needed on this side.
pub const ELEVENLABS_TTS_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
pub const ELEVENLABS_VOICES_URL: &str = "https://api.elevenlabs.io/v2/voices?page_size=100";
/// mp3 is the ONLY format available on every ElevenLabs tier.
pub const CLOUD_OUTPUT_FORMAT: &str = "mp3_44100_128";

/// Build the JSON request body for `POST /v1/text-to-speech/{voice_id}`.
/// REAL CODE (pure, deterministic) so it is unit-testable without the network.
/// Field names are ElevenLabs' on-wire snake_case. `speed` is folded into
/// `voice_settings` (ElevenLabs accepts it there).
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

/// Classify an ElevenLabs HTTP status into a human-readable reason. Mirrors
/// `tts-cloud.ts` HTTP_STATUS_MESSAGE. REAL CODE — tested.
pub fn classify_cloud_status(status: u16) -> String {
    match status {
        401 | 403 => "ElevenLabs: invalid API key".to_string(),
        402 => "ElevenLabs: this voice needs a paid plan (cloned & professional voices require a subscription)".to_string(),
        429 => "ElevenLabs: rate limited".to_string(),
        s => format!("ElevenLabs error: HTTP {s}"),
    }
}

/// Cloud engine. The synthesis call uses `reqwest` to POST the body from
/// `build_cloud_body` and stream the response bytes back as ONE `Mp3` chunk
/// (ElevenLabs convert is one-shot; the renderer decodes it). STUB body — the
/// pure builder/classifier above are the tested parts.
pub struct ElevenLabsEngine {
    // client: reqwest::Client,        // build loop
    api_key: String,
    model_id: String,
    settings: CloudVoiceSettings,
}

impl ElevenLabsEngine {
    pub fn new(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        Self {
            api_key,
            model_id,
            settings,
        }
    }
}

impl TtsEngine for ElevenLabsEngine {
    fn synthesize_stream(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
        _sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        if voice.is_empty() {
            return Err(TtsError::Cloud("No ElevenLabs voice selected".into()));
        }
        let _req = CloudSynthesisRequest {
            api_key: self.api_key.clone(),
            voice_id: voice.to_string(),
            model_id: self.model_id.clone(),
            text: text.to_string(),
            settings: CloudVoiceSettings {
                speed: clamp_cloud_speed(speed),
                ..self.settings.clone()
            },
        };
        // STUB: reqwest POST build_cloud_url(voice) with build_cloud_body(&_req),
        // header xi-api-key, then push one Mp3 SynthesisChunk { is_final: true }.
        Err(TtsError::NotImplemented)
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        // Cloud voices come from a live GET /v2/voices fetch in the host, not the
        // static catalog (cloned voices appear there). Empty here by design.
        Vec::new()
    }

    fn is_ready(&self) -> bool {
        !self.api_key.is_empty()
    }

    fn warm_up(&self) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        Ok(())
    }

    fn shutdown(&self) {}
}

// ---------------------------------------------------------------------------
// TtsManager — the host-facing facade (engine selection, sentence streaming,
// cancel). Engine selection + the sentence drive are REAL; the per-sentence
// synthesis delegates to the engine (stub for now).
// ---------------------------------------------------------------------------

/// Which source the user picked (`tts.source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsSource {
    Local,
    Cloud,
}

/// Facade the Tauri command layer calls. Owns the active engine, serializes
/// synthesis, and drives sentence-by-sentence reads under one parent request id
/// (gap-free playback). Mirrors the responsibilities split across WinSTT's
/// `tts_handler.py` (server) + `tts-reader.ts`/`tts.ts` (Electron main).
pub struct TtsManager {
    source: TtsSource,
    engine: Arc<dyn TtsEngine>,
    /// Per-request cancel flags (set by a stop gesture / STT override / app exit).
    cancelled: std::sync::Mutex<HashMap<String, bool>>,
}

impl TtsManager {
    pub fn new(source: TtsSource, engine: Arc<dyn TtsEngine>) -> Self {
        Self {
            source,
            engine,
            cancelled: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn source(&self) -> TtsSource {
        self.source
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
    /// renderer plays it gap-free. `speed` is sampled per sentence (a mid-read
    /// speed change applies to the NEXT sentence; the playing one finishes at
    /// its own speed — re-synthesis, not playbackRate, so pitch stays natural).
    /// Mirrors `runSentenceRead` in tts-reader.ts.
    ///
    /// STUB-aware: returns the engine's `NotImplemented` until the build loop,
    /// but the sentence sequencing + cancel polling are real and tested via
    /// `split_sentences`.
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
        for sentence in sentences {
            if self.is_cancelled(request_id) || sink.is_cancelled() {
                return Err(TtsError::Cancelled);
            }
            let speed = clamp_speed(get_speed());
            self.engine
                .synthesize_stream(&sentence, voice, lang, speed, sink)?;
        }
        if let Ok(mut map) = self.cancelled.lock() {
            map.remove(request_id);
        }
        Ok(())
    }
}

// ===========================================================================
// REAL, DETERMINISTIC DATA + LOGIC (compilable + unit-tested)
// ===========================================================================

/// The 54-voice Kokoro v1.0 catalog across 9 languages. Verbatim port of
/// `server/src/synthesizer/infrastructure/voice_catalog.py` — the `id` and
/// `language` strings are EXACTLY what the Kokoro engine accepts (do not
/// re-case or re-map them). Source of truth: hexgrad/Kokoro-82M VOICES.md v1.0.
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
/// `(code, label)` — verbatim from `voice_catalog.py SUPPORTED_LANGUAGES`.
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
    KOKORO_VOICE_CATALOG
        .iter()
        .filter(|v| v.language == lang)
        .collect()
}

// --- Sentence splitter (verbatim port of tts-reader.ts splitSentences) ------

/// Cap an over-long sentence so one giant clause can't block the whole read.
pub const DEFAULT_MAX_SENTENCE_LEN: usize = 240;

/// Split `text` into sentence-sized chunks for sequential synthesis. Splits
/// after sentence-ending punctuation (`. ! ?`, optionally a closing quote /
/// bracket) and hard-caps over-long sentences at `max_len`. Blank input → `[]`.
/// Trailing text with no terminator becomes its own chunk. Char-based length
/// (Unicode-safe), matching the JS `.length` only for the BMP — close enough
/// for the cap (it just bounds synthesis size, not correctness).
///
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

/// Equivalent of the JS regex `/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g`: accumulate
/// non-terminator chars, then on hitting a terminator run, consume that run plus
/// any trailing close-quote/bracket plus whitespace, and emit a piece. A final
/// un-terminated run is its own piece. Pure char-scan (no regex dep).
fn rough_split(s: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_terminator(c) {
            // consume the full terminator run
            while i < chars.len() && is_terminator(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            // trailing close-quote / bracket
            while i < chars.len() && is_closer(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            // trailing whitespace
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

/// Break `long` into ≤`max_len` pieces on whitespace boundaries (never mid-word
/// unless a single word exceeds `max_len`, then hard-split). Verbatim port of
/// `chunkLongSentence`.
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
            // hard-split a single over-long word into max_len char slices
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
// Tests (deterministic logic only — run with `cargo test` once Rust is up)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(
                supported.contains(v.language),
                "voice {} has unlisted language {}",
                v.id,
                v.language
            );
        }
    }

    #[test]
    fn every_supported_language_has_at_least_one_voice() {
        for (code, _) in SUPPORTED_LANGUAGES {
            assert!(
                KOKORO_VOICE_CATALOG.iter().any(|v| v.language == *code),
                "language {code} has no voices"
            );
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
        // (lang, expected count) from voice_catalog.py
        let expected = [
            ("en-us", 20),
            ("en-gb", 8),
            ("ja", 5),
            ("cmn", 8),
            ("es", 3),
            ("fr", 1),
            ("hi", 4),
            ("it", 2),
            ("pt-br", 3),
        ];
        for (lang, count) in expected {
            assert_eq!(
                voices_for_language(lang).len(),
                count,
                "language {lang} count mismatch"
            );
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
        // 10 words of 9 chars (+spaces) ≈ 99 chars; cap at 20 → multiple chunks.
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
        assert_eq!(out.len(), 3); // 20 + 20 + 10
        assert_eq!(out[0].chars().count(), 20);
        assert_eq!(out[2].chars().count(), 10);
    }

    #[test]
    fn split_no_terminator_returns_whole() {
        let out = split_sentences("just a plain phrase", DEFAULT_MAX_SENTENCE_LEN);
        assert_eq!(out, vec!["just a plain phrase"]);
    }

    // --- cloud request builder ---

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
                speed: 5.0, // out of range → clamps to 1.2
            },
        };
        let body = build_cloud_body(&req);
        assert_eq!(body["text"], "hi");
        assert_eq!(body["model_id"], "eleven_multilingual_v2");
        let vs = &body["voice_settings"];
        assert_eq!(vs["similarity_boost"], 0.75);
        assert_eq!(vs["use_speaker_boost"], true);
        assert_eq!(vs["speed"], 1.2);
    }

    #[test]
    fn cloud_status_classification() {
        assert!(classify_cloud_status(401).contains("invalid API key"));
        assert!(classify_cloud_status(402).contains("paid plan"));
        assert!(classify_cloud_status(429).contains("rate limited"));
        assert!(classify_cloud_status(500).contains("HTTP 500"));
    }

    // --- engine stub guards (until the build loop fills them in) ---

    #[test]
    fn kokoro_empty_text_is_ok_noop() {
        let eng = KokoroEngine::new(LocalTtsConfig::default());
        struct NullSink;
        impl ChunkSink for NullSink {
            fn push(&self, _c: SynthesisChunk) -> bool {
                true
            }
            fn is_cancelled(&self) -> bool {
                false
            }
        }
        // empty text → Ok(()) (matches WinSTT), non-empty → NotImplemented stub
        assert!(eng
            .synthesize_stream("", "af_heart", "en-us", 1.0, &NullSink)
            .is_ok());
        assert!(matches!(
            eng.synthesize_stream("hello", "af_heart", "en-us", 1.0, &NullSink),
            Err(TtsError::NotImplemented)
        ));
    }

    #[test]
    fn cloud_engine_rejects_missing_key_and_voice() {
        let eng = ElevenLabsEngine::new(String::new(), "m".into(), CloudVoiceSettings::default());
        struct NullSink;
        impl ChunkSink for NullSink {
            fn push(&self, _c: SynthesisChunk) -> bool {
                true
            }
            fn is_cancelled(&self) -> bool {
                false
            }
        }
        assert!(matches!(
            eng.synthesize_stream("hi", "v", "en", 1.0, &NullSink),
            Err(TtsError::Cloud(_))
        ));
        let eng2 =
            ElevenLabsEngine::new("key".into(), "m".into(), CloudVoiceSettings::default());
        assert!(matches!(
            eng2.synthesize_stream("hi", "", "en", 1.0, &NullSink),
            Err(TtsError::Cloud(_))
        ));
    }
}
