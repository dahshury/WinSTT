use super::download::{download_kokoro_assets, DownloadError};
use super::kokoro::{KokoroEngine, KOKORO_SAMPLE_RATE};
use super::types::{
    clamp_speed, LocalTtsConfig, SentenceAudio, TtsEngine, TtsError, TtsResult, VoiceInfo,
    MAX_SYNTHESIS_CHARS,
};
use super::voices::KOKORO_VOICE_CATALOG;

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
        let effective_voice = if voice.is_empty() {
            &self.config.voice
        } else {
            voice
        };
        let effective_lang = if lang.is_empty() {
            &self.config.lang
        } else {
            lang
        };
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
        self.engine
            .warm_up()
            .map_err(|e| TtsError::Engine(e.to_string()))
    }

    fn shutdown(&self) {
        self.engine.shutdown();
    }
}
