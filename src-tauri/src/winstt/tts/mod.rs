// Reference: server/src/synthesizer/ (Kokoro-ONNX hexagonal subsystem),
//   frontend/electron/ipc/{tts.ts,tts-cloud.ts,tts-reader.ts,tts-hotkey.ts},
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

pub mod catalog;
pub mod chatterbox;
pub mod kitten;
pub mod kokoro;
pub mod local_engines;
pub mod phonemize;
pub mod piper;
pub mod supertonic;

mod cloud;
mod download;
mod local;
mod service;
mod splitter;
#[cfg(test)]
mod tests;
mod types;
mod voices;

pub use self::cloud::{
    build_cloud_body, build_cloud_url, classify_cloud_status, parse_cloud_voices,
    parse_detail_status, CloudSynthesisRequest, CloudVoice, CloudVoiceSettings, ElevenLabsEngine,
    CLOUD_OUTPUT_FORMAT, ELEVENLABS_SUBSCRIPTION_URL, ELEVENLABS_TTS_BASE, ELEVENLABS_VOICES_URL,
};
pub use self::download::{download_kokoro_assets, DownloadControl, DownloadError};
pub use self::kokoro::{KokoroConfig, KokoroDevice, KokoroEngine, KOKORO_SAMPLE_RATE};
pub use self::local::KokoroLocalEngine;
pub use self::service::{
    tts_error_category, TtsChunkPayload, TtsEventEmitter, TtsManager, TtsSource,
};
pub use self::splitter::{split_sentences, DEFAULT_MAX_SENTENCE_LEN};
pub use self::types::{
    clamp_cloud_speed, clamp_speed, ChunkSink, Format, Gender, LocalTtsConfig, SentenceAudio,
    SynthesisChunk, TtsDevice, TtsEngine, TtsError, TtsResult, VoiceInfo, CLOUD_MAX_SPEED,
    CLOUD_MIN_SPEED, MAX_SPEED, MAX_SYNTHESIS_CHARS, MIN_SPEED,
};
pub use self::voices::{
    voice_by_id, voices_for_language, KOKORO_VOICE_CATALOG, SUPPORTED_LANGUAGES,
};
