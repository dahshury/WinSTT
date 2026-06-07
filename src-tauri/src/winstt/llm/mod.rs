// Source: docs/archive/port/07_llm_cloud_context_longtail.md, frontend/electron/ipc/llm.ts,
// frontend/src/shared/lib/preset-prompts.ts, and frontend/src/shared/lib/ollama-endpoint.ts.
//
// Pure LLM post-processing for WinSTT. This module owns prompt composition,
// Ollama request-body construction, stream-state parsing/finalization,
// chain-of-thought leakage extraction, structured-envelope salvage, and
// OpenRouter request extras. Runtime Ollama HTTP lives in `winstt::ollama_client`;
// Tauri app orchestration and renderer events live in `winstt::managers::llm_manager`.
//
// Invariant honored: Canary/Cohere context-prompt slot is untrained, so the
// COMPOSE/context prefix is an LLM-cleanup concern, not an STT initial prompt.
// This module never feeds context into the transcriber.

use std::collections::BTreeMap;

mod answer;
mod file_tagging;
mod ollama_request;
mod prompts;
mod side_effects;
mod transport;

pub use answer::*;
pub use file_tagging::*;
pub use ollama_request::*;
pub use prompts::*;
pub use side_effects::*;
pub use transport::*;

/// Convenience: assemble the per-feature LLM config the pipeline runs on.
/// Mirrors FeatureLlmConfig (connection values — endpoint, api key — stay
/// store-sourced and are passed separately).
#[derive(Debug, Clone)]
pub struct FeatureLlmConfig {
    pub provider: String,
    pub model: String,
    pub openrouter_model: String,
    pub openrouter_fallback_model: String,
    pub thinking_effort: ThinkingEffort,
    pub presets: Vec<PresetEntry>,
    pub custom_modifiers: Vec<CustomModifier>,
}

/// The merged map a manager can hand around: provider → its default model.
/// (Convenience helper used by the settings reconciliation in the PORT doc.)
pub fn default_models_by_provider() -> BTreeMap<&'static str, &'static str> {
    let mut m = BTreeMap::new();
    m.insert("ollama", "");
    m.insert("openrouter", "openrouter/auto");
    m
}
