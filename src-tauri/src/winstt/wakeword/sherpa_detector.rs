// ═════════════════════════════════════════════════════════════════════════════
// 5. The detector — real sherpa-onnx 1.13.2 wiring (compiles unconditionally).
//
//    Mirrors `IWakeWordDetector`: `detect(chunk) -> WakeWordResult` + cleanup.
//    sherpa-onnx 1.13.2's KWS is a streaming OnlineStream model: build one
//    `KeywordSpotter` from the zipformer transducer + tokens, open ONE persistent
//    `OnlineStream` (loaded with the active keywords), then for each chunk
//    `accept_waveform` → drain `is_ready`/`decode` → poll `get_result`. A
//    non-empty `KeywordResult::keyword` is a HIT; we `reset` the stream to re-arm.
//    The matched LABEL string (the `@…` half) maps back to the keyword index via
//    the config's ordered `keywords` vector.
// ═════════════════════════════════════════════════════════════════════════════

use sherpa_onnx::{
    KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use super::config::WakeWordConfig;
use super::{normalize_keyword_label, path_string, path_string_lossy, WakeWordResult};

pub struct WakeWordDetector {
    spotter: KeywordSpotter,
    stream: OnlineStream,
    keywords: Vec<String>,
    /// KWS models are trained at 16 kHz mono; the manager resamples upstream.
    sample_rate: i32,
}

// Compatibility behavior: sherpa-onnx `KeywordSpotter` and `OnlineStream` both
// implement `Send + Sync` (verified in the crate's trait list, docs.rs 1.13.2),
// so `WakeWordDetector` is auto `Send + Sync`. Do not add a manual `unsafe impl`;
// it would conflict with the auto impl. The detector can live behind the
// manager's mutex and be fed from the audio-consumer thread.

impl WakeWordDetector {
    /// Build a live spotter + armed stream from a [`WakeWordConfig`].
    ///
    /// The keyword content comes from `config.keywords_content` (inline
    /// `create_stream_with_keywords`) when present — no temp file needed; the
    /// spotter's own `keywords_file`/`keywords_buf` provide the fallback set so
    /// `create()` always has at least the configured keywords.
    pub fn new(config: &WakeWordConfig) -> anyhow::Result<Self> {
        let transducer = OnlineTransducerModelConfig {
            encoder: Some(path_string(&config.model.encoder)?),
            decoder: Some(path_string(&config.model.decoder)?),
            joiner: Some(path_string(&config.model.joiner)?),
        };

        let model_config = OnlineModelConfig {
            transducer,
            tokens: Some(path_string(&config.model.tokens)?),
            num_threads: config.num_threads.unwrap_or(1).max(1),
            provider: Some(config.provider.as_sherpa_str().to_string()),
            debug: false,
            ..OnlineModelConfig::default()
        };

        // Start from the crate's Default (sr=16000, dim=80, paths=4, blanks=1) so
        // we only override what we mean to. `keywords_buf` carries the inline
        // content; `keywords_file` carries the on-disk path if the manager wrote one.
        let spotter_config = KeywordSpotterConfig {
            model_config,
            // Per-keyword `#threshold` in the content TIGHTENS this global floor.
            keywords_threshold: config.global_threshold(),
            keywords_score: config.default_boost(),
            keywords_file: config.keywords_file.as_deref().map(path_string_lossy),
            keywords_buf: config.keywords_inline().map(str::to_string),
            ..KeywordSpotterConfig::default()
        };

        let spotter = KeywordSpotter::create(&spotter_config)
            .ok_or_else(|| anyhow::anyhow!("failed to create sherpa-onnx KeywordSpotter"))?;

        // Open the persistent stream. Prefer the inline keyword content (lets the
        // active phrase set be swapped per-detector without rebuilding the spotter);
        // fall back to the config-baked keywords otherwise.
        let stream = match config.keywords_inline() {
            Some(content) if !content.trim().is_empty() => {
                spotter.create_stream_with_keywords(content)
            }
            _ => spotter.create_stream(),
        };

        Ok(WakeWordDetector {
            spotter,
            stream,
            keywords: config.keywords.clone(),
            sample_rate: 16_000,
        })
    }

    /// Feed one 16 kHz mono f32 chunk; report any detection.
    ///
    /// Streaming contract (real sherpa-onnx 1.13.2): push the chunk, drain the
    /// ready/decode loop, then poll the result. A non-empty `keyword` is a HIT;
    /// we immediately `reset` the stream so the next phrase starts clean (sherpa's
    /// KWS does NOT auto-reset — without this the spotter keeps re-reporting the
    /// same terminal state). On a match the engine returns the LABEL (the `@…`
    /// half of the keyword line); we resolve its index in the active list
    /// (`-1` if somehow unknown).
    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        if chunk.is_empty() {
            return WakeWordResult::none();
        }

        // 1. Feed audio. accept_waveform takes (sample_rate: i32, samples: &[f32]).
        self.stream.accept_waveform(self.sample_rate, chunk);

        // 2. Drain the decode loop for everything the new audio made ready.
        while self.spotter.is_ready(&self.stream) {
            self.spotter.decode(&self.stream);
        }

        // 3. Poll for a keyword. get_result returns None until a phrase fires.
        match self.spotter.get_result(&self.stream) {
            Some(result) if !result.keyword.trim().is_empty() => {
                let label = result.keyword;
                let idx = self.index_of(&label);
                let word = self.display_word_for_label(&label, idx);
                // Re-arm: clear the terminal state so we don't double-fire.
                self.spotter.reset(&self.stream);
                WakeWordResult::hit(idx, word)
            }
            _ => WakeWordResult::none(),
        }
    }

    /// Map a detected label back to its position in the active keyword list.
    fn index_of(&self, label: &str) -> i32 {
        let needle = normalize_keyword_label(label);
        self.keywords
            .iter()
            .position(|k| normalize_keyword_label(k) == needle)
            .map_or(-1, |p| p as i32)
    }

    fn display_word_for_label(&self, label: &str, index: i32) -> String {
        if index >= 0 {
            if let Some(keyword) = self.keywords.get(index as usize) {
                return keyword.clone();
            }
        }
        label.trim().replace('_', " ")
    }

    /// Number of active keywords this detector is armed for.
    pub fn keyword_count(&self) -> usize {
        self.keywords.len()
    }

    /// Reset the streaming state (drop any partial decode). Fail-soft.
    pub fn reset(&mut self) {
        self.spotter.reset(&self.stream);
    }

    /// No-op today (sherpa owns the session); kept for `IWakeWordDetector` parity.
    pub fn cleanup(&mut self) {}
}
