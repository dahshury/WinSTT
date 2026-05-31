// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md (Word-timestamps),
// server/src/recorder/infrastructure/word_aligner.py (the tiered native + use-our-words strategy),
// onnx-asr/src/onnx_asr/word_timestamps.py (DTW + median filter + alignment heads + word grouping).
//
// WordAligner lazily loads the `onnx-community/whisper-tiny_timestamped` ort session and runs
// cross-attention DTW to produce per-word start/end seconds for history playback (karaoke
// highlight). The session is loaded on the FIRST `align_words` call and kept warm.
//
// Strategy (mirrors the Python WordAligner.align):
//   1. NATIVE — the timestamped tiny Whisper export exposes `cross_attentions.*` outputs, so the
//      engine's `transcribe(return_word_timestamps=true)` yields per-word timings via DTW.
//   2. USE-OUR-WORDS — when a `known_text` is supplied (the history entry's effective transcript),
//      relabel the aligner's TIMED words onto OUR words via a SequenceMatcher-style diff
//      (`word_timestamps::map_timings_to_text`) so the highlighted words are exactly the ones the
//      user sees (zero drift from a second transcription). Empty `known_text` → the aligner's own
//      words are returned verbatim.

use std::sync::Arc;
use std::sync::Mutex;

use tauri::AppHandle;

use crate::winstt::stt::{self, WordResult};
use crate::winstt::word_timestamps::{self, MappedWord, WordTiming};

/// Multilingual tiny Whisper export exposing `cross_attentions.*` decoder outputs (what the DTW
/// needs). ~40 MB, HF-cached once. Matches `word_aligner.py::DEFAULT_ALIGN_MODEL`.
const DEFAULT_ALIGN_MODEL: &str = "onnx-community/whisper-tiny_timestamped";

pub struct WordAligner {
    app: AppHandle,
    model_manager: Arc<crate::managers::model::ModelManager>,
    /// Lazily-initialized cross-attention DTW engine. `None` until first use; `Some(None)` after a
    /// load FAILURE so we don't retry-storm on every play (documented degrade = no highlight). The
    /// inner `Option` distinguishes "never tried" from "tried and unavailable".
    engine: Mutex<Option<Option<Box<dyn stt::Transcriber>>>>,
}

impl WordAligner {
    pub fn new(app: &AppHandle, model_manager: Arc<crate::managers::model::ModelManager>) -> Self {
        Self {
            app: app.clone(),
            model_manager,
            engine: Mutex::new(None),
        }
    }

    /// Whether the alignment engine has been loaded yet.
    pub fn is_loaded(&self) -> bool {
        self.engine
            .lock()
            .map(|e| matches!(e.as_ref(), Some(Some(_))))
            .unwrap_or(false)
    }

    /// Produce per-word timings for `audio` (mono 16 kHz f32) given the known `text`. Lazily loads
    /// the timestamped whisper export on first call.
    ///
    /// Returns an empty vec when the alignment engine isn't available (the documented degrade:
    /// history playback falls back to no highlight, transcript intact).
    pub fn align_words(&self, audio: &[f32], text: &str) -> Result<Vec<WordResult>, String> {
        let mut guard = self.engine.lock().map_err(|_| "word aligner poisoned")?;
        if guard.is_none() {
            // First touch: attempt the load exactly once and cache the outcome (Some / Some(None)).
            *guard = Some(self.try_load_engine());
        }
        let Some(Some(engine)) = guard.as_mut() else {
            // Load failed earlier (or just now) → no highlight, text intact.
            return Ok(Vec::new());
        };

        // NATIVE: transcribe with word timestamps (cross-attention DTW). The timestamped export
        // exposes `cross_attentions.*`, so `transcribe` runs `align_words` internally and fills
        // `words`. Language is left auto (None) — the aligner detects it from the audio.
        let opts = stt::TranscribeOptions {
            return_word_timestamps: true,
            ..Default::default()
        };
        let timed: Vec<WordResult> = match engine.transcribe(audio, &opts) {
            Ok(t) => t.words.unwrap_or_default(),
            Err(e) => return Err(format!("word alignment failed: {e}")),
        };

        // USE-OUR-WORDS: relabel the aligner's timed words onto OUR transcript so the highlight
        // matches the exact words on screen. Empty `known_text` → return the aligner's own words.
        if text.trim().is_empty() {
            return Ok(timed);
        }
        Ok(Self::map_timings_to_known_text(&timed, text))
    }

    /// Relabel the aligner's TIMED words with OUR `known_text` words via the ported
    /// `map_timings_to_text` diff (port of `word_aligner.py::map_timings_to_text`). The result is
    /// exactly `known_text`'s whitespace-split words, in order, with monotonic times.
    fn map_timings_to_known_text(timed: &[WordResult], known_text: &str) -> Vec<WordResult> {
        let known_words: Vec<String> = known_text.split_whitespace().map(str::to_string).collect();
        if known_words.is_empty() {
            return Vec::new();
        }
        // Bridge `WordResult` (f32) → `word_timestamps::WordTiming` (f64, the diff's input shape).
        // Tokens are unused by `map_timings_to_text` (it keys on the normalized word text).
        let timings: Vec<WordTiming> = timed
            .iter()
            .map(|w| WordTiming {
                word: w.text.clone(),
                start: w.start as f64,
                end: w.end as f64,
                tokens: Vec::new(),
            })
            .collect();
        let mapped: Vec<MappedWord> = word_timestamps::map_timings_to_text(&timings, &known_words);
        mapped
            .into_iter()
            .map(|m| WordResult {
                text: m.text,
                start: m.start as f32,
                end: m.end as f32,
            })
            .collect()
    }

    /// Build the `onnx-community/whisper-tiny_timestamped` engine on CPU.
    ///
    /// Resolves the export through the unified resolver (cache-first; one network refetch when a
    /// shard is missing) and builds a `WhisperEngine` via `stt::build_engine`. CPU-only: word
    /// timestamps are an opt-in, post-commit feature (Whisper is 30 s-bounded and the encoder
    /// dominates), and CPU sidesteps the DML cross-attention output path. Returns `None` on any
    /// failure (missing model, resolve error, build error) — the caller degrades to no highlight.
    fn try_load_engine(&self) -> Option<Box<dyn stt::Transcriber>> {
        // Keep the model_manager handle referenced — the aligner shares the app's model namespace
        // for future custom-aligner overrides, but the timestamped export is resolved by repo id.
        let _ = &self.model_manager;

        let req = stt::resolver::ResolveRequest {
            model_id: DEFAULT_ALIGN_MODEL.to_string(),
            kind: stt::EngineKind::WhisperHf,
            effective_quant: stt::Quantization::Default,
            local_dir: None,
            // Cache-first; the resolver flips to a single network refetch on a cache miss /
            // incomplete shard (resolver::resolve §6).
            local_files_only: true,
        };

        let resolved = match tauri::async_runtime::block_on(stt::resolver::resolve(&req)) {
            Ok(r) => r,
            Err(e) => {
                if std::env::var("WINSTT_STT_DEBUG").is_ok() {
                    eprintln!("[word-aligner] resolve {DEFAULT_ALIGN_MODEL} failed: {e}");
                }
                return None;
            }
        };

        let cfg = stt::EngineConfig {
            model_name: DEFAULT_ALIGN_MODEL.to_string(),
            family: "whisper".to_string(),
            kind: stt::EngineKind::WhisperHf,
            resolved,
            // CPU-only (see fn doc). No GPU fallback entry needed.
            providers: vec![stt::Accelerator::Cpu],
            // Default (fp32) export → no fp16 workaround.
            whisper_fp16_workaround: false,
        };

        match stt::build_engine(cfg) {
            Ok(engine) => {
                // Only keep it if the export actually exposes cross-attention (else the words it
                // returns would always be empty — surface a clean "unavailable" instead).
                if engine.supports_word_timestamps() {
                    Some(engine)
                } else {
                    if std::env::var("WINSTT_STT_DEBUG").is_ok() {
                        eprintln!(
                            "[word-aligner] {DEFAULT_ALIGN_MODEL} loaded but exposes no cross_attentions.* — word timestamps unavailable"
                        );
                    }
                    None
                }
            }
            Err(e) => {
                if std::env::var("WINSTT_STT_DEBUG").is_ok() {
                    eprintln!("[word-aligner] build {DEFAULT_ALIGN_MODEL} failed: {e}");
                }
                None
            }
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_known_text_transfers_equal_words() {
        // "test that" timed → known "test this": "test" keeps its window, "this" inherits "that"'s.
        let timed = vec![
            WordResult { text: "test".into(), start: 0.0, end: 0.5 },
            WordResult { text: "that".into(), start: 0.5, end: 1.0 },
        ];
        let mapped = WordAligner::map_timings_to_known_text(&timed, "test this");
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].text, "test");
        assert!((mapped[0].start - 0.0).abs() < 1e-6);
        assert!((mapped[0].end - 0.5).abs() < 1e-6);
        assert_eq!(mapped[1].text, "this");
        // monotonic.
        assert!(mapped[1].start >= mapped[0].end - 1e-6);
    }

    #[test]
    fn map_known_text_empty_known_is_empty() {
        let timed = vec![WordResult { text: "a".into(), start: 0.0, end: 0.1 }];
        assert!(WordAligner::map_timings_to_known_text(&timed, "   ").is_empty());
    }

    #[test]
    fn map_known_text_no_timings_zeroes() {
        // No aligner output → known words at t=0 (honest, monotonic).
        let mapped = WordAligner::map_timings_to_known_text(&[], "hello world");
        assert_eq!(mapped.len(), 2);
        assert!(mapped.iter().all(|w| w.start == 0.0 && w.end == 0.0));
        assert_eq!(mapped[0].text, "hello");
        assert_eq!(mapped[1].text, "world");
    }
}
