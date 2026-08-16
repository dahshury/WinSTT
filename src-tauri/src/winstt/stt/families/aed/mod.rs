// Attention-encoder-decoder + Granite + streaming-CTC engines:
//   * `CohereEngine` (merged decoder, fp16 KV-cache dtype + logits f32-promote),
//   * `GraniteArEngine` / `GraniteNarEngine` (Granite-Speech AR / NAR),
//   * `CanaryEngine` (NeMo AED with the `decoder_mems` loop),
//   * `ToneEngine` (T-one streaming CTC over raw 8 kHz int32 signal, no mel).
//
// Lifted verbatim out of the old monolithic `families.rs`; depends only on the shared `support`
// layer (incl. the `KvTensor` enum) and the `frontend` featurizers, never on a peer engine.
//
// This is the MODULE ROOT for the `families/aed/` directory module: one engine impl per file
// (cohere, granite_ar, granite_nar, canary, tone). The per-engine files reach the shared layers via
// `use super::*` (the re-exports below), so no caller outside this module changed — the public paths
// `aed::CohereEngine` / `aed::CanaryEngine` / `aed::ToneEngine` and the `pub(super)`
// `aed::{GraniteArEngine, GraniteNarEngine, canary_prompt_tokens, COHERE_LANGUAGES}` are unchanged.

// Shared imports re-exported for the per-engine submodules (`use super::*`). Mirrors the imports the
// old single-file `aed.rs` pulled in (`super::super::{…}`, `super::frontend`, `super::support::*`).
pub(super) use super::super::{
    EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription, ctc_greedy_collapse,
};
pub(super) use super::{frontend, support::*};

mod ark_asr;
mod audio8;
mod canary;
mod cohere;
mod granite_ar;
mod granite_nar;
mod qwen3;
mod tone;
mod vibevoice;

// `canary_prompt_tokens` / `COHERE_LANGUAGES` are consumed only by the `#[cfg(test)]` pure-logic
// tests in `families.rs`; gate the re-exports to the same builds so the lib build has no unused
// import (the originals were `pub(super)` definitions, which the dead-code lint already exempts).
pub(super) use ark_asr::ArkAsrEngine;
pub(super) use audio8::Audio8AsrEngine;
pub use canary::CanaryEngine;
#[cfg(test)]
pub(super) use canary::canary_prompt_tokens;
#[cfg(test)]
pub(super) use cohere::COHERE_LANGUAGES;
pub use cohere::CohereEngine;
pub(super) use granite_ar::GraniteArEngine;
pub(super) use granite_nar::GraniteNarEngine;
pub(super) use qwen3::Qwen3AsrEngine;
pub use tone::ToneEngine;
pub(super) use vibevoice::VibeVoiceEngine;
