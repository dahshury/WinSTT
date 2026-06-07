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
    vocab_is_uppercase, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription,
};

/// Which sherpa-onnx online model family to configure (selects the sub-config to fill).
#[derive(Clone, Copy, Debug)]
pub enum SherpaStreamFamily {
    /// encoder + decoder + joiner (streaming Zipformer2 transducer OR streaming NeMo RNN-T).
    Transducer,
    /// single `model.onnx` (streaming NeMo FastConformer CTC).
    NemoCtc,
}

// Match sherpa-onnx's documented online endpoint defaults. The previous 0.8s rules made
// dictation segments finalize/reset too early compared with the official examples.
const SHERPA_RULE1_MIN_TRAILING_SILENCE: f32 = 2.4;
const SHERPA_RULE2_MIN_TRAILING_SILENCE: f32 = 1.2;
const SHERPA_RULE3_MIN_UTTERANCE_LENGTH: f32 = 20.0;
const FINAL_SILENCE_PAD_MS: usize = 2000;
const STREAM_SAMPLE_RATE: usize = 16_000;

fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn final_silence_pad() -> Vec<f32> {
    vec![0.0; STREAM_SAMPLE_RATE * FINAL_SILENCE_PAD_MS / 1000]
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
    finalized_text: String,
    lowercase_decoded: bool,
}

impl SherpaStreamingEngine {
    pub fn load(cfg: &EngineConfig, fam: SherpaStreamFamily) -> SttResult<Self> {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(2).clamp(1, 8))
            .unwrap_or(2) as i32;

        let mut config = OnlineRecognizerConfig::default();
        let tokens_path = file(&cfg.resolved, "vocab")?;
        let lowercase_decoded = sherpa_tokens_are_uppercase(tokens_path)?;
        config.model_config.tokens = Some(path_str(tokens_path));
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
        // Keep sherpa's native endpointing enabled for live-stream final flags while PTT remains
        // held. WinSTT still owns recording lifetime; endpoint hits only mark/reset the internal
        // stream segment so the next live tick can continue cleanly.
        config.enable_endpoint = true;
        config.rule1_min_trailing_silence = SHERPA_RULE1_MIN_TRAILING_SILENCE;
        config.rule2_min_trailing_silence = SHERPA_RULE2_MIN_TRAILING_SILENCE;
        config.rule3_min_utterance_length = SHERPA_RULE3_MIN_UTTERANCE_LENGTH;

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
            finalized_text: String::new(),
            lowercase_decoded,
        })
    }

    /// Run every currently-ready decode step on `stream` and return the running hypothesis text.
    fn drain(&self, stream: &OnlineStream) -> String {
        while self.recognizer.is_ready(stream) {
            self.recognizer.decode(stream);
        }
        let text = self
            .recognizer
            .get_result(stream)
            .map(|r| r.text)
            .unwrap_or_default();
        normalize_sherpa_text(&text, self.lowercase_decoded)
    }

    fn append_finalized_text(&mut self, text: &str) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        if !self.finalized_text.is_empty()
            && !self
                .finalized_text
                .chars()
                .last()
                .is_some_and(char::is_whitespace)
        {
            self.finalized_text.push(' ');
        }
        self.finalized_text.push_str(trimmed);
    }

    fn joined_stream_text(&self, partial: &str) -> String {
        let partial = partial.trim();
        if self.finalized_text.is_empty() {
            return partial.to_string();
        }
        if partial.is_empty() {
            return self.finalized_text.clone();
        }
        format!("{} {}", self.finalized_text, partial)
    }
}

fn sherpa_tokens_are_uppercase(path: &Path) -> SttResult<bool> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| SttError::Tokenizer(format!("read vocab {}: {e}", path.display())))?;
    Ok(sherpa_tokens_text_is_uppercase(&raw))
}

fn sherpa_tokens_text_is_uppercase(raw: &str) -> bool {
    let symbols = parse_sherpa_token_symbols(raw);
    vocab_is_uppercase(symbols.iter().map(String::as_str))
}

fn parse_sherpa_token_symbols(raw: &str) -> Vec<String> {
    raw.lines().filter_map(parse_sherpa_token_symbol).collect()
}

fn parse_sherpa_token_symbol(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    let (id, symbol_parts) = parts.split_last()?;
    if symbol_parts.is_empty() || id.parse::<i64>().is_err() {
        return None;
    }
    Some(symbol_parts.join(" "))
}

fn normalize_sherpa_text(text: &str, lowercase: bool) -> String {
    if lowercase {
        text.to_lowercase()
    } else {
        text.to_string()
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
        stream.accept_waveform(16_000, &final_silence_pad());
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
    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if self.stream.is_none() {
            self.stream = Some(self.recognizer.create_stream());
        }
        let (partial, is_endpoint) = {
            let stream = self.stream.as_ref().expect("set above");
            stream.accept_waveform(16_000, pcm);
            let partial = self.drain(stream);
            (partial, self.recognizer.is_endpoint(stream))
        };
        if is_endpoint {
            self.append_finalized_text(&partial);
            if let Some(stream) = self.stream.as_ref() {
                self.recognizer.reset(stream);
            }
            return Ok(NativeStreamUpdate {
                text: self.finalized_text.clone(),
                is_final: true,
            });
        }
        Ok(NativeStreamUpdate::interim(
            self.joined_stream_text(&partial),
        ))
    }

    /// Flush trailing right-context (`input_finished`) and return the final text.
    fn stream_finalize(&mut self) -> SttResult<String> {
        let Some(stream) = self.stream.as_ref() else {
            return Ok(String::new());
        };
        stream.input_finished();
        let partial = self.drain(stream);
        Ok(self.joined_stream_text(&partial))
    }

    /// Start a fresh streaming session (new stream = zeroed cache state).
    fn stream_reset(&mut self) {
        self.stream = Some(self.recognizer.create_stream());
        self.finalized_text.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        final_silence_pad, normalize_sherpa_text, parse_sherpa_token_symbols,
        sherpa_tokens_text_is_uppercase, FINAL_SILENCE_PAD_MS, SHERPA_RULE1_MIN_TRAILING_SILENCE,
        SHERPA_RULE2_MIN_TRAILING_SILENCE, SHERPA_RULE3_MIN_UTTERANCE_LENGTH, STREAM_SAMPLE_RATE,
    };

    #[test]
    fn sherpa_endpoint_defaults_are_not_aggressive() {
        assert_eq!(SHERPA_RULE1_MIN_TRAILING_SILENCE, 2.4);
        assert_eq!(SHERPA_RULE2_MIN_TRAILING_SILENCE, 1.2);
        assert_eq!(SHERPA_RULE3_MIN_UTTERANCE_LENGTH, 20.0);
    }

    #[test]
    fn final_silence_pad_is_two_seconds_of_zero_audio() {
        let pad = final_silence_pad();

        assert_eq!(pad.len(), STREAM_SAMPLE_RATE * FINAL_SILENCE_PAD_MS / 1000);
        assert!(pad.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn sherpa_tokens_detect_zipformer_uppercase_vocab() {
        let raw = "<blk> 0\n<unk> 1\n\u{2581}THE 2\nQUICK 3\nBROWN 4\nFOX 5\n";

        assert!(sherpa_tokens_text_is_uppercase(raw));
    }

    #[test]
    fn sherpa_tokens_keep_mixed_case_vocab() {
        let raw = "<blk> 0\n<unk> 1\n\u{2581}the 2\nQuick 3\nbrown 4\n";

        assert!(!sherpa_tokens_text_is_uppercase(raw));
    }

    #[test]
    fn sherpa_token_parser_ignores_malformed_lines() {
        let raw = "<blk> 0\nbad line\n\u{2581}HELLO 12\n";

        assert_eq!(
            parse_sherpa_token_symbols(raw),
            vec!["<blk>".to_string(), "\u{2581}HELLO".to_string()]
        );
    }

    #[test]
    fn normalize_sherpa_text_lowercases_uppercase_vocab_output() {
        assert_eq!(
            normalize_sherpa_text("This Is Zipformer Text", true),
            "this is zipformer text"
        );
        assert_eq!(
            normalize_sherpa_text("This Is Zipformer Text", false),
            "This Is Zipformer Text"
        );
    }
}
