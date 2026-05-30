// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md §1 + lib_wiring.md §3,
// frontend/electron/ipc/{llm,ollama}.ts. Wraps managers::LlmManager + winstt::llm.
//
// LLM commands. process_text (dictation cleanup) + process_transform
// (transform-on-selection) compose the system prompt via winstt::llm (preset +
// context + vocab layering) and run it over the configured provider. Ollama is
// the all-Rust streaming path (LlmManager); OpenRouter rides Handy's
// OpenAI-compatible llm_client (SPIKE seam). The scan/detect/pull/delete/verify
// commands wrap the manager's `/api/*` helpers.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use crate::winstt::llm::{
    self, build_dictation_system_prompt, build_system_prompt, merge_presets_with_custom_modifiers,
    PresetEntry as LlmPresetEntry, PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel,
    ThinkingEffort as LlmEffort, Vocab,
};
use crate::winstt::managers::LlmManager;
use crate::winstt::settings_schema::{
    PresetEntry as SettingsPreset, PresetKey as SettingsPresetKey, PresetLevel as SettingsLevel,
    ThinkingEffort as SettingsEffort, WinsttSettings,
};

use super::settings::read_settings;

/// One discovered provider model surfaced to the picker.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelInfo {
    pub id: String,
    pub label: String,
    pub supports_thinking: bool,
}

// ── settings → prompt-shape conversions (the thin `From` the spec calls for) ──

fn to_llm_level(level: SettingsLevel) -> LlmPresetLevel {
    match level {
        SettingsLevel::Light => LlmPresetLevel::Light,
        SettingsLevel::Medium => LlmPresetLevel::Medium,
        SettingsLevel::High => LlmPresetLevel::High,
    }
}

fn to_llm_key(key: SettingsPresetKey) -> LlmPresetKey {
    match key {
        SettingsPresetKey::Neutral => LlmPresetKey::Neutral,
        SettingsPresetKey::Formal => LlmPresetKey::Formal,
        SettingsPresetKey::Friendly => LlmPresetKey::Friendly,
        SettingsPresetKey::Technical => LlmPresetKey::Technical,
        SettingsPresetKey::Casual => LlmPresetKey::Casual,
        SettingsPresetKey::Concise => LlmPresetKey::Concise,
        SettingsPresetKey::Summarize => LlmPresetKey::Summarize,
        SettingsPresetKey::Reorder => LlmPresetKey::Reorder,
        SettingsPresetKey::Restructure => LlmPresetKey::Restructure,
        SettingsPresetKey::RewordForClarity => LlmPresetKey::RewordForClarity,
        SettingsPresetKey::Translate => LlmPresetKey::Translate,
    }
}

fn to_llm_preset(p: &SettingsPreset) -> LlmPresetEntry {
    LlmPresetEntry::Builtin {
        key: to_llm_key(p.key),
        level: p.level.map(to_llm_level),
        target_lang: p.target_lang.clone(),
    }
}

fn to_llm_effort(e: SettingsEffort) -> LlmEffort {
    match e {
        SettingsEffort::Off => LlmEffort::Off,
        SettingsEffort::Low => LlmEffort::Low,
        SettingsEffort::Medium => LlmEffort::Medium,
        SettingsEffort::High => LlmEffort::High,
    }
}

/// Build the prompt-shape preset list (builtins + enabled custom modifiers) from
/// the persisted dictation settings.
fn dictation_presets(settings: &WinsttSettings) -> Vec<LlmPresetEntry> {
    let builtins: Vec<LlmPresetEntry> = settings
        .llm
        .dictation
        .presets
        .iter()
        .map(to_llm_preset)
        .collect();
    let customs: Vec<llm::CustomModifier> = settings
        .llm
        .dictation
        .custom_modifiers
        .iter()
        .map(|m| llm::CustomModifier {
            id: m.id.clone(),
            name: m.name.clone(),
            prompt: m.prompt.clone(),
            enabled: m.enabled,
            levels_enabled: m.levels_enabled,
            level: m.level.map(to_llm_level),
        })
        .collect();
    merge_presets_with_custom_modifiers(&builtins, &customs)
}

/// `process_text` — dictation cleanup/compose. Composes the full system prompt
/// (presets + context + vocab) and runs it over the configured provider.
/// `context` is the formatted UIA fragment (may be empty).
#[tauri::command]
#[specta::specta]
pub async fn process_text(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    text: String,
    context: String,
) -> Result<String, String> {
    let settings = read_settings(&app);
    let presets = dictation_presets(&settings);
    let vocab = build_vocab(&settings);
    let system_prompt = build_dictation_system_prompt(&presets, &context, &vocab);
    let effort = to_llm_effort(settings.llm.dictation.base.thinking_effort);

    let mgr = llm_manager.inner().clone();
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.dictation.base.model.clone();

    // All-Rust path: Ollama. OpenRouter routes through Handy's llm_client (SPIKE).
    let answer = mgr
        .ollama_dictation(&endpoint, &model, &system_prompt, &text, effort, &request_id)
        .await
        .unwrap_or_else(|_| text.clone());

    // Deterministic replacement-pair safety net (guaranteed fire).
    let pairs = replacement_pairs(&settings);
    Ok(llm::apply_replacement_pairs(&answer, &pairs))
}

/// `process_transform` — apply a transform's preset body to the selection.
#[tauri::command]
#[specta::specta]
pub async fn process_transform(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    text: String,
    transform_id: String,
) -> Result<String, String> {
    let settings = read_settings(&app);
    // Resolve the transform's own preset body (no context/vocab folding).
    let presets: Vec<LlmPresetEntry> = settings
        .llm
        .transforms
        .presets
        .iter()
        .map(to_llm_preset)
        .collect();
    let system_prompt = build_system_prompt(&presets);
    let effort = to_llm_effort(settings.llm.transforms.base.thinking_effort);

    let mgr = llm_manager.inner().clone();
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.transforms.base.model.clone();
    let _ = transform_id;

    let answer = mgr
        .ollama_transform(&endpoint, &model, &system_prompt, &text, effort, &request_id)
        .await
        .unwrap_or_else(|_| text.clone());
    Ok(answer)
}

/// `scan_ollama_models` — `/api/tags` + `/api/show` capability enrich.
#[tauri::command]
#[specta::specta]
pub async fn scan_ollama_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<Vec<LlmModelInfo>, String> {
    let settings = read_settings(&app);
    let endpoint = settings.llm.endpoint.clone();
    let mgr = llm_manager.inner().clone();
    let ids = mgr.ollama_list_models(&endpoint).await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let caps = mgr
            .ollama_capabilities(&endpoint, &id)
            .await
            .unwrap_or_default();
        out.push(LlmModelInfo {
            id: id.clone(),
            label: id,
            supports_thinking: caps.supports_thinking,
        });
    }
    Ok(out)
}

/// `scan_openrouter_models` — `/v1/models` + `/endpoints` enrich.
/// SPIKE: reqwest the OpenRouter catalog with the stored key; map id/label.
#[tauri::command]
#[specta::specta]
pub async fn scan_openrouter_models(_app: AppHandle) -> Result<Vec<LlmModelInfo>, String> {
    // SPIKE: GET https://openrouter.ai/api/v1/models (+ per-model /endpoints).
    Ok(Vec::new())
}

/// `ollama_detect` — whether an Ollama server answers at the endpoint.
#[tauri::command]
#[specta::specta]
pub async fn ollama_detect(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<bool, String> {
    let settings = read_settings(&app);
    let mgr = llm_manager.inner().clone();
    Ok(mgr.ollama_detect(&settings.llm.endpoint).await)
}

/// `ollama_start` — best-effort launch of a local Ollama server.
/// SPIKE: `std::process::Command::new("ollama").arg("serve")` (windowsHide) when
/// detection fails; returns whether it is reachable after a short wait.
#[tauri::command]
#[specta::specta]
pub async fn ollama_start(_app: AppHandle) -> Result<bool, String> {
    // SPIKE: spawn `ollama serve` detached, poll /api/version. No-op default.
    Ok(false)
}

/// `ollama_pull` — pull a model, streaming progress (NOT OpenAI-compatible).
/// SPIKE: POST /api/pull (stream=true), drain the NDJSON `{status,total,completed}`
/// progress, emit `ollama-pull-progress`. Returns when the pull completes.
#[tauri::command]
#[specta::specta]
pub async fn ollama_pull(_app: AppHandle, model: String) -> Result<(), String> {
    let _ = model;
    // SPIKE: stream /api/pull progress (ollama-rs `pull_model_stream` or reqwest).
    Err("ollama pull streaming not yet wired (spike)".to_string())
}

/// `ollama_delete` — delete a local model (`DELETE /api/delete`).
/// SPIKE: reqwest DELETE /api/delete { name }.
#[tauri::command]
#[specta::specta]
pub async fn ollama_delete(_app: AppHandle, model: String) -> Result<(), String> {
    let _ = model;
    Err("ollama delete not yet wired (spike)".to_string())
}

/// `verify_credential` — verify an OpenAI / OpenRouter / ElevenLabs key.
/// SPIKE: probe the provider's cheap GET endpoint (OpenRouter /api/v1/key,
/// OpenAI /v1/models). ElevenLabs verification lives in the cloud_stt commands.
#[tauri::command]
#[specta::specta]
pub async fn verify_credential(
    _app: AppHandle,
    provider: String,
    api_key: String,
) -> Result<bool, String> {
    let _ = (provider, api_key);
    // SPIKE: route per-provider probe; reuse cloud_stt::classify_verify for shape.
    Ok(false)
}

// ── settings → vocab / replacement-pairs ──────────────────────────────────

fn build_vocab(settings: &WinsttSettings) -> Vocab {
    let dictionary: Vec<String> = settings
        .dictionary
        .iter()
        .map(|d| d.term.clone())
        .collect();
    let snippets: Vec<(String, String)> = settings
        .snippets
        .iter()
        .map(|s| (s.trigger.clone(), s.expansion.clone()))
        .collect();
    Vocab {
        dictionary,
        replacement_pairs: replacement_pairs(settings),
        snippets,
    }
}

/// Replacement pairs are the dictionary entries that carry a replacement value.
fn replacement_pairs(settings: &WinsttSettings) -> Vec<(String, String)> {
    settings
        .dictionary
        .iter()
        .filter_map(|d| {
            d.replacement
                .as_ref()
                .filter(|r| !r.is_empty())
                .map(|r| (d.term.clone(), r.clone()))
        })
        .collect()
}
