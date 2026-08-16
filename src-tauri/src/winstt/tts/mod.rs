// Reference: server/src/synthesizer/ (Kokoro-ONNX hexagonal subsystem),
//   frontend/src/shared/config/settings-schema.ts (ttsSettingsSchema).
//
// TtsManager + 54-voice Kokoro catalog + sentence-splitter + per-sentence streaming + cancel +
// cloud ElevenLabs (reqwest). The local engine is the REAL in-process Kokoro-82M ONNX engine in
// `kokoro.rs` (on OUR ort 2.0.0-rc.12); G2P is `phonemize.rs` (espeak-ng CLI, process-separated).
//
// ⚠️ LICENSING. The DEFAULT build shells out to the system `espeak-ng`
// binary (process separation = "mere aggregation" → main binary stays non-GPL). The engine code is
// compiled-in (no kokoroxide; we run the ONNX directly), so there is NO 30 MB engine pack — only the
// two model FILES download on first use.
//
// Wire contract to the renderer (identical for local + cloud so the Web-Audio playback queue is
// source-agnostic — features/tts-playback):
//   tts:chunk { request_id, sample_rate, seq, is_final, format, channels, pcm }
// where format == "f32le" (raw mono f32, local Kokoro) | "mp3" (cloud, renderer decodeAudioData's).

pub mod audio8;
pub mod catalog;
pub mod chatterbox;
pub mod kitten;
pub mod kokoro;
pub mod local_engines;
pub mod neutts;
pub mod omnivoice;
pub mod orpheus;
pub mod phonemize;
pub mod piper;
pub mod qwen3_tts;
pub mod spark;
pub mod supertonic;

mod cloud;
mod download;
mod local;
mod openrouter;
mod provider;
mod sampling;
mod service;
mod splitter;
#[cfg(test)]
mod tests;
mod types;
mod voices;

pub use self::cloud::{
    CLOUD_OUTPUT_FORMAT, CloudSynthesisRequest, CloudVoice, CloudVoiceSettings,
    ELEVENLABS_SUBSCRIPTION_URL, ELEVENLABS_TTS_BASE, ELEVENLABS_VOICES_URL, ElevenLabsEngine,
    build_cloud_body, build_cloud_url, classify_cloud_status, parse_cloud_voices,
    parse_detail_status,
};
pub use self::download::{DownloadControl, DownloadError, download_kokoro_assets};
pub use self::kokoro::{KOKORO_SAMPLE_RATE, KokoroConfig, KokoroEngine};
pub use self::local::KokoroLocalEngine;
pub use self::openrouter::OpenRouterTtsEngine;
pub use self::service::{
    TtsChunkPayload, TtsEventEmitter, TtsManager, TtsSource, tts_error_category,
};
pub use self::splitter::{DEFAULT_MAX_SENTENCE_LEN, split_sentences};
pub use self::types::{
    CLOUD_MAX_SPEED, CLOUD_MIN_SPEED, ChunkSink, Format, Gender, LocalTtsConfig, MAX_SPEED,
    MAX_SYNTHESIS_CHARS, MIN_SPEED, SentenceAudio, SynthesisChunk, TtsDevice, TtsEngine, TtsError,
    TtsResult, VoiceInfo, clamp_cloud_speed, clamp_speed, clamp_speed_to_range,
};
pub use self::voices::{
    KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES, voice_by_id, voices_for_language,
};

/// Per-model TTS cache dir (`%LOCALAPPDATA%/winstt/tts/<model-id>/`). This is the
/// single source of truth shared by the download manager (which fetches into it)
/// and the engine builder (which loads from it) — they MUST agree, so both delegate
/// here rather than duplicating the path layout.
pub fn cache_dir(app: &tauri::AppHandle, model_id: &str) -> std::path::PathBuf {
    crate::portable::app_data_dir(app)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("tts")
        .join(model_id)
}
