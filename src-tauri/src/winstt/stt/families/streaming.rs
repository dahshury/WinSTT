//! Shared streaming-STT scaffolding for the native ORT streaming engines.
//!
//! `NemoCtc`/`Zipformer` (`native_streaming.rs`) and `NemoRnnt` (`nemo_streaming.rs`) all carry the
//! same PCM ring + frame offsets and run the same chunk-readiness / trim / decode-join loop around
//! model-specific encoder/decoder calls. Those shared pieces live here so each engine keeps ONLY its
//! `run_chunk` / `run_encoder` + decode body. Behavior is identical to the per-engine copies; the
//! readiness rule, trim window, blank handling, and emission timing are unchanged.

use std::collections::BTreeMap;

use super::support::Vocab;
use crate::winstt::stt::{SttError, SttResult};

/// 16 kHz mono — the streaming featurizers assume this rate.
pub(super) const SAMPLE_RATE: usize = 16_000;
/// Silence appended on finalize so the encoder flushes the tail through its receptive field.
pub(super) const FINAL_SILENCE_PAD_MS: usize = 2_000;
/// Frames of feature pre-context retained when trimming the PCM ring (mirrors sherpa).
pub(super) const STREAM_FEATURE_PRE_CONTEXT_FRAMES: usize = 3;

/// Shared streaming cursor: the PCM ring + frame bookkeeping common to every native streaming engine.
///
/// Each engine embeds one of these inside its own stream-state struct and keeps its model-specific
/// cache tensors alongside it.
pub(super) struct StreamCursor {
    pub(super) pcm: Vec<f32>,
    pub(super) base_frame: usize,
    pub(super) next_chunk_frame: usize,
    pub(super) tokens: Vec<i64>,
    pub(super) frame_offset: usize,
    pub(super) num_trailing_blanks: usize,
}

impl StreamCursor {
    pub(super) fn new() -> Self {
        Self {
            pcm: Vec::new(),
            base_frame: 0,
            next_chunk_frame: 0,
            tokens: Vec::new(),
            frame_offset: 0,
            num_trailing_blanks: 0,
        }
    }

    /// `rel_start` of the next chunk within the current feature window (clamped at `base_frame`).
    pub(super) fn rel_start(&self) -> usize {
        self.next_chunk_frame.saturating_sub(self.base_frame)
    }

    /// Drop already-consumed PCM, retaining `STREAM_FEATURE_PRE_CONTEXT_FRAMES` of pre-context, and
    /// advance `base_frame` by the number of whole feature frames dropped. `hop` is the engine's
    /// feature hop in samples (NeMo vs Kaldi). No-op until there is at least one frame to drop.
    pub(super) fn trim_pcm(&mut self, hop: usize) {
        let keep_from_frame = self
            .next_chunk_frame
            .saturating_sub(STREAM_FEATURE_PRE_CONTEXT_FRAMES);
        if keep_from_frame <= self.base_frame {
            return;
        }
        let drop_frames = keep_from_frame - self.base_frame;
        let drop_samples = (drop_frames * hop).min(self.pcm.len());
        if drop_samples == 0 {
            return;
        }
        self.pcm.drain(..drop_samples);
        self.base_frame += drop_samples / hop;
    }

    /// Join the emitted token ids into text via the vocab, keeping only symbols accepted by
    /// `keep` (and dropping ids the vocab has no symbol for).
    pub(super) fn decode_text<F>(&self, vocab: &Vocab, keep: F) -> String
    where
        F: Fn(i64, &str) -> bool,
    {
        let syms: Vec<&str> = self
            .tokens
            .iter()
            .filter_map(|&id| vocab.get(id).map(|s| (id, s)))
            .filter(|&(id, s)| keep(id, s))
            .map(|(_, s)| s)
            .collect();
        super::support::join_and_normalize(&syms, vocab.lowercase_decoded)
    }
}

/// Streaming chunk-readiness rule. On `finalize`, the last partial window is consumed (`<=`);
/// otherwise it follows the official streaming rule `num_processed + ChunkSize < NumFramesReady`.
pub(super) fn chunk_ready(
    rel_start: usize,
    window: usize,
    available_frames: usize,
    finalize: bool,
) -> bool {
    let required_frames = rel_start + window;
    if finalize {
        required_frames <= available_frames
    } else {
        required_frames < available_frames
    }
}

/// `SAMPLE_RATE * FINAL_SILENCE_PAD_MS / 1000` samples of silence appended on finalize.
pub(super) fn final_silence_pad() -> Vec<f32> {
    vec![0.0; SAMPLE_RATE * FINAL_SILENCE_PAD_MS / 1000]
}

/// Parse a usize streaming-metadata value, with `what` naming the metadata flavour in error text.
pub(super) fn meta_usize(
    meta: &BTreeMap<String, String>,
    key: &str,
    what: &str,
) -> SttResult<usize> {
    meta.get(key)
        .ok_or_else(|| SttError::SessionCreate(format!("missing {what} metadata {key}")))?
        .parse::<usize>()
        .map_err(|e| SttError::SessionCreate(format!("parse metadata {key}: {e}")))
}
