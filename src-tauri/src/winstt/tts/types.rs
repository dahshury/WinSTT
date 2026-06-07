use std::path::PathBuf;
use std::sync::Arc;

use super::kokoro::{KokoroConfig, KokoroDevice};

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
    /// Subdir holding the per-voice raw `.bin` files (onnx-community layout).
    pub voices_dir: String,
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
            model_filename: "model_fp16.onnx".to_string(),
            voices_dir: "voices".to_string(),
            voice: "af_heart".to_string(),
            lang: "en-us".to_string(),
            speed: 1.0,
            device: TtsDevice::Auto,
        }
    }
}

impl LocalTtsConfig {
    /// Public view of the derived Kokoro engine config (cache dir + filenames +
    /// device) so the host can stat the asset paths for the download estimate.
    pub fn to_kokoro_config_pub(&self) -> KokoroConfig {
        self.to_kokoro_config()
    }

    pub(super) fn to_kokoro_config(&self) -> KokoroConfig {
        KokoroConfig {
            cache_dir: self.cache_dir.clone(),
            model_filename: self.model_filename.clone(),
            voices_dir: self.voices_dir.clone(),
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

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    /// Engine model download could not finish (network).
    #[error("TTS download failed: {0}")]
    Download(String),
    /// Download/synthesis was paused cooperatively (resume via re-init).
    #[error("TTS install paused")]
    Paused,
    /// User cancelled — distinct from a real failure.
    #[error("TTS cancelled")]
    Cancelled,
    /// ONNX session create / inference / G2P failure.
    #[error("TTS engine error: {0}")]
    Engine(String),
    /// Cloud HTTP / auth / quota error (human-readable, already classified).
    #[error("{0}")]
    Cloud(String),
    /// Bad input (empty text, unknown voice, etc.).
    #[error("invalid TTS request: {0}")]
    Invalid(String),
}

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
            SentenceAudio::F32le {
                samples,
                sample_rate,
            } => SynthesisChunk::f32le(samples, sample_rate, 0, false),
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
