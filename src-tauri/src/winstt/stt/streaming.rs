//! Native streaming STT via sherpa-onnx's `OnlineRecognizer`.
//!
//! WHY this instead of hand-threading encoder cache tensors: the project ALREADY links
//! `sherpa-onnx` (for KWS wake-word + diarization), and its `OnlineRecognizer` natively streams the
//! cache-aware FastConformer / Zipformer / NeMo families — the cache-tensor threading + chunked
//! encode + greedy decode loop all live inside the sherpa C++ runtime (the exact runtime our
//! research specs were porting FROM). So one thin wrapper replaces ~800 lines of error-prone manual
//! `ort` cache plumbing, using a battle-tested implementation.
//!
//! It runs on sherpa-onnx's OWN onnxruntime (provider pinned to CPU here — the streaming conformer
//! encoders are DML-incompatible per our policy), entirely independent of our `ort` sessions and
//! the `build_session` / DML routing. The same engine serves BOTH paths:
//!   * `Transcriber::transcribe` (batch / PTT-final): a fresh stream fed the whole buffer +
//!     `input_finished` + decode loop → unlimited-length offline decode (no VAD-segment needed).
//!   * the streaming hooks (`stream_accept` / `stream_finalize` / `stream_reset`): a PERSISTENT
//!     stream fed only the new samples each realtime tick, carrying cache state across ticks.

use std::path::Path;

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use super::families::file;
use super::{
    EngineConfig, EngineKind, SttError, SttResult, TranscribeOptions, Transcriber, Transcription,
};

/// Which sherpa-onnx online model family to configure (selects the sub-config to fill).
#[derive(Clone, Copy, Debug)]
pub enum SherpaStreamFamily {
    /// encoder + decoder + joiner (streaming Zipformer2 transducer OR streaming NeMo RNN-T).
    Transducer,
    /// single `model.onnx` (streaming NeMo FastConformer CTC).
    NemoCtc,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Engine backed by `sherpa_onnx::OnlineRecognizer`. `Send + Sync` (the crate marks the recognizer
/// + stream so), held behind the core's engine mutex like every other `Transcriber`.
pub struct SherpaStreamingEngine {
    recognizer: OnlineRecognizer,
    kind: EngineKind,
    model_name: String,
    providers: Vec<String>,
    /// Persistent stream for the realtime path; `None` outside an active stream. The batch
    /// `transcribe` path uses its own throw-away stream so the two never interfere.
    stream: Option<OnlineStream>,
}

impl SherpaStreamingEngine {
    pub fn load(cfg: &EngineConfig, fam: SherpaStreamFamily) -> SttResult<Self> {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(2).clamp(1, 8))
            .unwrap_or(2) as i32;

        let mut config = OnlineRecognizerConfig::default();
        config.model_config.tokens = Some(path_str(file(&cfg.resolved, "vocab")?));
        config.model_config.num_threads = threads;
        // Sherpa's own provider — the streaming conformer encoders crash on DML (same class as the
        // non-streaming KaldiTransducer/Cohere), so CPU. This is independent of our `ort` providers.
        config.model_config.provider = Some("cpu".to_string());
        match fam {
            SherpaStreamFamily::Transducer => {
                config.model_config.transducer.encoder =
                    Some(path_str(file(&cfg.resolved, "encoder")?));
                config.model_config.transducer.decoder =
                    Some(path_str(file(&cfg.resolved, "decoder")?));
                config.model_config.transducer.joiner =
                    Some(path_str(file(&cfg.resolved, "joiner")?));
            }
            SherpaStreamFamily::NemoCtc => {
                config.model_config.nemo_ctc.model = Some(path_str(file(&cfg.resolved, "model")?));
            }
        }
        config.decoding_method = Some("greedy_search".to_string());
        // We drive utterance boundaries from our own Silero VAD / PTT, not sherpa's endpoint rules.
        config.enable_endpoint = false;

        let recognizer = OnlineRecognizer::create(&config).ok_or_else(|| {
            SttError::SessionCreate(format!(
                "sherpa OnlineRecognizer::create returned null for {}",
                cfg.model_name
            ))
        })?;

        Ok(Self {
            recognizer,
            kind: cfg.kind,
            model_name: cfg.model_name.clone(),
            providers: vec!["CPUExecutionProvider".to_string()],
            stream: None,
        })
    }

    /// Run every currently-ready decode step on `stream` and return the running hypothesis text.
    fn drain(&self, stream: &OnlineStream) -> String {
        while self.recognizer.is_ready(stream) {
            self.recognizer.decode(stream);
        }
        self.recognizer
            .get_result(stream)
            .map(|r| r.text)
            .unwrap_or_default()
    }
}

impl Transcriber for SherpaStreamingEngine {
    fn kind(&self) -> EngineKind {
        self.kind
    }
    fn model_name(&self) -> &str {
        &self.model_name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    /// Batch / PTT-final decode: stream the WHOLE buffer through a fresh stream → unlimited length,
    /// no 30 s cap (the sherpa runtime chunks internally).
    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(16_000, audio);
        stream.input_finished();
        let text = self.drain(&stream);
        Ok(Transcription {
            text: text.trim().to_string(),
            ..Default::default()
        })
    }

    fn supports_native_streaming(&self) -> bool {
        true
    }

    /// Feed a fresh 16 kHz tail into the live stream (cache carried internally) and return the text
    /// so far. The realtime worker calls this per tick with only the new samples.
    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<String> {
        if self.stream.is_none() {
            self.stream = Some(self.recognizer.create_stream());
        }
        let stream = self.stream.as_ref().expect("set above");
        stream.accept_waveform(16_000, pcm);
        Ok(self.drain(stream))
    }

    /// Flush trailing right-context (`input_finished`) and return the final text.
    fn stream_finalize(&mut self) -> SttResult<String> {
        let Some(stream) = self.stream.as_ref() else {
            return Ok(String::new());
        };
        stream.input_finished();
        Ok(self.drain(stream))
    }

    /// Start a fresh streaming session (new stream = zeroed cache state).
    fn stream_reset(&mut self) {
        self.stream = Some(self.recognizer.create_stream());
    }
}
