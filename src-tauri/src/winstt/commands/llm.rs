// LLM commands. Source: frontend/electron/ipc/{llm,ollama,credentials}.ts.
// Wraps managers::LlmManager + winstt::llm.
//
// process_text (dictation cleanup) + process_transform (transform-on-selection)
// compose the system prompt via winstt::llm (preset + context + vocab layering)
// and run it over the configured provider: Ollama via the all-Rust streaming
// path (LlmManager::ollama_dictation/transform), OpenRouter via the OpenAI-
// compatible /api/v1/chat/completions structured-output path
// (LlmManager::openrouter_chat, with fallback model). Apple Intelligence
// soft-fails to the original text (macOS-only CLI; this is a Windows app).
//
// scan_ollama_models → OllamaScanResult (/api/tags + /api/show enrich).
// scan_openrouter_models → OpenRouterScanResult (/api/v1/models with stored key).
// ollama_detect/ollama_start → locate + spawn a local `ollama serve`.
// ollama_pull → stream /api/pull, emitting llm:pull-progress (cancel-aware).
// ollama_delete → DELETE /api/delete.
// verify_credential → the INTEGRATIONS_VERIFY seam: probe OpenAI/OpenRouter/
//   ElevenLabs and return { ok, code?, message? } (WinSTT error taxonomy code).

use std::sync::Arc;
use std::time::Duration;

use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use crate::winstt::cloud_stt::{
    classify_http_failure, classify_transport_error, is_elevenlabs_scoped_key_valid,
    CloudSttErrorCode,
};
use crate::winstt::llm::{
    self, build_dictation_system_prompt, build_system_prompt, merge_presets_with_custom_modifiers,
    PresetEntry as LlmPresetEntry, PresetKey as LlmPresetKey, PresetLevel as LlmPresetLevel,
    ThinkingEffort as LlmEffort, Vocab,
};
use crate::winstt::managers::llm_manager::{
    OllamaModelDetails as MgrDetails, OllamaModelInfo as MgrModel, OpenRouterModelInfo, PullOutcome,
};
use crate::winstt::managers::LlmManager;
use crate::winstt::settings_schema::{
    LlmProvider, PresetEntry as SettingsPreset, PresetKey as SettingsPresetKey,
    PresetLevel as SettingsLevel, ThinkingEffort as SettingsEffort, WinsttSettings,
};

use super::ollama_pull::{clear_pull_cancel, is_pull_cancelled};
use super::settings::read_settings;

// ── Renderer payload shapes (mirror spec/openapi.yaml exactly) ─────────────────

/// `OllamaModelDetails` (camelCase per spec).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelDetailsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub families: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization_level: Option<String>,
}

impl From<MgrDetails> for OllamaModelDetailsPayload {
    fn from(d: MgrDetails) -> Self {
        Self {
            format: d.format,
            family: d.family,
            families: d.families,
            parameter_size: d.parameter_size,
            quantization_level: d.quantization_level,
        }
    }
}

/// `OllamaModel` (camelCase per spec). Consumed by `OllamaScanResult.models[]`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelPayload {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<OllamaModelDetailsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

impl From<MgrModel> for OllamaModelPayload {
    fn from(m: MgrModel) -> Self {
        Self {
            name: m.name,
            size: m.size,
            modified_at: m.modified_at,
            details: m.details.map(Into::into),
            capabilities: m.capabilities,
        }
    }
}

/// `OllamaScanResult` — the shape `useLlmCatalogStore.scanModels()` consumes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaScanResultPayload {
    pub models: Vec<OllamaModelPayload>,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaDetectResult` — `{ installed, path? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaDetectResultPayload {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `{ started, error? }` — the `startOllama()` IPC result.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStartResultPayload {
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaPullResult` — `{ success, model, cancelled?, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullResultPayload {
    pub success: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OllamaDeleteResult` — `{ success, model, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaDeleteResultPayload {
    pub success: bool,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `OpenRouterModel` (snake_case keys per spec — NOT renamed).
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
pub struct OpenRouterModelPayload {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_parameters: Option<Vec<String>>,
}

impl From<OpenRouterModelInfo> for OpenRouterModelPayload {
    fn from(m: OpenRouterModelInfo) -> Self {
        Self {
            id: m.id,
            name: m.name,
            description: m.description,
            context_length: m.context_length,
            pricing: m.pricing,
            provider: m.provider,
            maker: m.maker,
            model_name: m.model_name,
            variant: m.variant,
            architecture: m.architecture,
            supported_parameters: m.supported_parameters,
        }
    }
}

/// `OpenRouterScanResult` — `{ models, reachable, error? }`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterScanResultPayload {
    pub models: Vec<OpenRouterModelPayload>,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Verify-credential outcome — `{ ok, code?, message? }`. The renderer's
/// verify-credentials feature reads `code === "network"` to split offline from
/// invalid, so `code` MUST be the WinSTT taxonomy string.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCredentialPayload {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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

    // Provider routing (mirrors runProcessText): OpenRouter via the OpenAI-
    // compatible chat endpoint, otherwise the all-Rust Ollama streaming path.
    // Apple Intelligence soft-fails to the original text — its CLI is macOS-only
    // and this is a Windows app (mirrors runAppleIntelligencePath's fail-soft).
    let answer = match settings.llm.dictation.base.provider {
        LlmProvider::Openrouter => {
            let api_key = settings.llm.openrouter_api_key.clone();
            let selection = settings.llm.dictation.base.openrouter_model.clone();
            let fallback = settings
                .llm
                .dictation
                .base
                .openrouter_fallback_model
                .clone();
            let user_prompt = llm::dictation_user_prompt(&text);
            run_openrouter_with_fallback(
                &mgr,
                &api_key,
                &selection,
                &fallback,
                &system_prompt,
                &user_prompt,
                &text,
                "dictation",
                &request_id,
            )
            .await
        }
        LlmProvider::AppleIntelligence => text.clone(),
        LlmProvider::Ollama => mgr
            .ollama_dictation(
                &endpoint,
                &model,
                &system_prompt,
                &text,
                effort,
                &request_id,
            )
            .await
            .unwrap_or_else(|err| {
                warn!(
                    "[llm][{request_id}] dictation Ollama model '{model}' failed; returning original text: {}",
                    llm::compact_error_for_log(&err)
                );
                text.clone()
            }),
    };

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

    let answer = match settings.llm.transforms.base.provider {
        LlmProvider::Openrouter => {
            let api_key = settings.llm.openrouter_api_key.clone();
            let selection = settings.llm.transforms.base.openrouter_model.clone();
            let fallback = settings
                .llm
                .transforms
                .base
                .openrouter_fallback_model
                .clone();
            let user_prompt = llm::transforms_user_prompt(&text);
            run_openrouter_with_fallback(
                &mgr,
                &api_key,
                &selection,
                &fallback,
                &system_prompt,
                &user_prompt,
                &text,
                &transform_id,
                &request_id,
            )
            .await
        }
        LlmProvider::AppleIntelligence => text.clone(),
        LlmProvider::Ollama => mgr
            .ollama_transform(
                &endpoint,
                &model,
                &system_prompt,
                &text,
                effort,
                &request_id,
            )
            .await
            .unwrap_or_else(|err| {
                warn!(
                    "[llm][{request_id}] transform '{}' Ollama model '{model}' failed; returning original text: {}",
                    transform_id,
                    llm::compact_error_for_log(&err)
                );
                text.clone()
            }),
    };
    Ok(answer)
}

/// Try the primary OpenRouter selection; on failure (and when a fallback is
/// configured), retry with the fallback model. On total failure, return the
/// original text. Mirrors `runOpenRouterWithFallback`.
async fn run_openrouter_with_fallback(
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    feature: &str,
    request_id: &str,
) -> String {
    match mgr
        .openrouter_chat(api_key, primary, system_prompt, user_prompt, text)
        .await
    {
        Ok(answer) => answer,
        Err(primary_err) if !fallback.is_empty() => {
            warn!(
                "[llm][{request_id}] {feature} OpenRouter primary model '{primary}' failed; trying fallback '{fallback}': {}",
                llm::compact_error_for_log(&primary_err)
            );
            match mgr
                .openrouter_chat(api_key, fallback, system_prompt, user_prompt, text)
                .await
            {
                Ok(answer) => answer,
                Err(fallback_err) => {
                    warn!(
                        "[llm][{request_id}] {feature} OpenRouter fallback model '{fallback}' failed; returning original text: {}",
                        llm::compact_error_for_log(&fallback_err)
                    );
                    text.to_string()
                }
            }
        }
        Err(primary_err) => {
            warn!(
                "[llm][{request_id}] {feature} OpenRouter model '{primary}' failed with no fallback; returning original text: {}",
                llm::compact_error_for_log(&primary_err)
            );
            text.to_string()
        }
    }
}

/// `scan_ollama_models` — `/api/tags` + `/api/show` capability enrich. Returns
/// the `OllamaScanResult` the picker store consumes (`{ models, reachable,
/// error? }`). A connection failure → `reachable: false`; an HTTP/parse error
/// → `reachable: true` with `error` set (the daemon answered, just badly) — this
/// drives the "Ollama not running" vs "Ollama errored" distinction in the UI.
#[tauri::command]
#[specta::specta]
pub async fn scan_ollama_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OllamaScanResultPayload, String> {
    let settings = read_settings(&app);
    let endpoint = settings.llm.endpoint.clone();
    let mgr = llm_manager.inner().clone();
    // A reachability ping first so a refused connection is reported as
    // `reachable: false` (the reference's `safeFetch` error path) rather than a
    // generic parse error.
    if !mgr.ollama_detect(&endpoint).await {
        return Ok(OllamaScanResultPayload {
            models: Vec::new(),
            reachable: false,
            error: Some(format!("Could not reach Ollama at {endpoint}")),
        });
    }
    match mgr.ollama_list_models_detailed(&endpoint).await {
        Ok(models) => Ok(OllamaScanResultPayload {
            models: models.into_iter().map(Into::into).collect(),
            reachable: true,
            error: None,
        }),
        Err(e) => Ok(OllamaScanResultPayload {
            models: Vec::new(),
            reachable: true,
            error: Some(e),
        }),
    }
}

/// `scan_openrouter_models` — `GET /api/v1/models` with the stored key. Returns
/// the `OpenRouterScanResult` (`{ models, reachable, error? }`) the picker store
/// consumes. Per-model `/endpoints` enrichment (provider rail / per-provider
/// pricing / quant chips) is not fanned out in v1 — the renderer renders the base
/// rows fine without it.
// TODO(openrouter-enrich): fan out per-model `/api/v1/models/{author}/{slug}/endpoints`
//   (concurrency-capped) to fill `endpoints[]` like `enrichOpenRouterModel` does.
#[tauri::command]
#[specta::specta]
pub async fn scan_openrouter_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter(&api_key).await;
    Ok(OpenRouterScanResultPayload {
        models: scan.models.into_iter().map(Into::into).collect(),
        reachable: scan.reachable,
        error: scan.error,
    })
}

/// `ollama_detect` — locate an `ollama` executable (PATH or default install
/// dirs). Returns `{ installed, path? }`. Mirrors `detectOllama` — the renderer's
/// "Install Ollama" banner keys off `installed`.
#[tauri::command]
#[specta::specta]
pub async fn ollama_detect(_app: AppHandle) -> Result<OllamaDetectResultPayload, String> {
    Ok(detect_ollama_executable().await)
}

/// `ollama_start` — best-effort launch of a local `ollama serve` and poll until
/// it binds (or times out). Returns `{ started, error? }`. Mirrors `startOllama`.
#[tauri::command]
#[specta::specta]
pub async fn ollama_start(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OllamaStartResultPayload, String> {
    let detected = detect_ollama_executable().await;
    let Some(path) = detected.path.filter(|_| detected.installed) else {
        return Ok(OllamaStartResultPayload {
            started: false,
            error: Some("Ollama is not installed".to_string()),
        });
    };
    if let Err(e) = spawn_ollama_serve(&path) {
        return Ok(OllamaStartResultPayload {
            started: false,
            error: Some(e),
        });
    }
    // Poll for the daemon to bind. Local Ollama usually boots in 1–2s; allow 10s.
    // The inter-attempt delay runs on the blocking pool (via `std::thread::sleep`)
    // so we don't depend on tokio's optional `time` feature being enabled.
    let settings = read_settings(&app);
    let endpoint = settings.llm.endpoint.clone();
    let mgr = llm_manager.inner().clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if mgr.ollama_detect(&endpoint).await {
            return Ok(OllamaStartResultPayload {
                started: true,
                error: None,
            });
        }
        let _ = tokio::task::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(500));
        })
        .await;
    }
    Ok(OllamaStartResultPayload {
        started: false,
        error: Some("Ollama started but did not bind within 10s".to_string()),
    })
}

/// `ollama_pull` — pull a model, streaming `llm:pull-progress` for every frame.
/// Honors the `ollama_cancel_pull` registry (polled between NDJSON frames).
/// Returns `OllamaPullResult` (`{ success, model, cancelled?, error? }`).
#[tauri::command]
#[specta::specta]
pub async fn ollama_pull(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    model: String,
) -> Result<OllamaPullResultPayload, String> {
    if let Err(e) = validate_model_name(&model) {
        return Ok(OllamaPullResultPayload {
            success: false,
            model,
            cancelled: None,
            error: Some(e),
        });
    }
    let settings = read_settings(&app);
    let endpoint = settings.llm.endpoint.clone();
    let mgr = llm_manager.inner().clone();

    // Leading "starting" frame (matches the reference broadcast).
    emit_pull_progress(
        &app,
        serde_json::json!({ "model": model.as_str(), "status": "pulling", "statusText": "starting" }),
    );

    let model_for_cancel = model.clone();
    let model_for_emit = model.clone();
    let outcome = mgr
        .ollama_pull_stream(&endpoint, &model, || is_pull_cancelled(&model_for_cancel))
        .await;
    clear_pull_cancel(&model);

    match outcome {
        PullOutcome::Success => Ok(OllamaPullResultPayload {
            success: true,
            model,
            cancelled: None,
            error: None,
        }),
        PullOutcome::Cancelled => {
            emit_pull_progress(
                &app,
                serde_json::json!({ "model": model_for_emit, "status": "cancelled" }),
            );
            Ok(OllamaPullResultPayload {
                success: false,
                model,
                cancelled: Some(true),
                error: None,
            })
        }
        PullOutcome::Error(msg) => Ok(OllamaPullResultPayload {
            success: false,
            model,
            cancelled: None,
            error: Some(msg),
        }),
    }
}

/// `ollama_delete` — delete a local model (`DELETE /api/delete`). Returns
/// `OllamaDeleteResult` (`{ success, model, error? }`).
#[tauri::command]
#[specta::specta]
pub async fn ollama_delete(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    model: String,
) -> Result<OllamaDeleteResultPayload, String> {
    if let Err(e) = validate_model_name(&model) {
        return Ok(OllamaDeleteResultPayload {
            success: false,
            model,
            error: Some(e),
        });
    }
    let settings = read_settings(&app);
    let endpoint = settings.llm.endpoint.clone();
    let mgr = llm_manager.inner().clone();
    let (success, error) = mgr.ollama_delete(&endpoint, &model).await;
    Ok(OllamaDeleteResultPayload {
        success,
        model,
        error,
    })
}

/// `verify_credential` — the ONE renderer verify seam (`INTEGRATIONS_VERIFY`).
/// Probes the provider's cheap GET endpoint with the user-typed key and returns
/// `{ ok, code?, message? }` (the WinSTT taxonomy `code`). Covers OpenAI,
/// ElevenLabs AND OpenRouter; the renderer routes all three through this channel.
/// Side-effect-free: never persists the key. Mirrors `credentials.ts`.
#[tauri::command]
#[specta::specta]
pub async fn verify_credential(
    _app: AppHandle,
    provider: String,
    api_key: String,
) -> Result<VerifyCredentialPayload, String> {
    let probe = match provider.as_str() {
        "openai" => VerifyProbe::OpenAi,
        "openrouter" => VerifyProbe::OpenRouter,
        "elevenlabs" => VerifyProbe::ElevenLabs,
        _ => {
            return Ok(VerifyCredentialPayload {
                ok: false,
                code: Some(CloudSttErrorCode::ProviderError.as_str().to_string()),
                message: Some("Invalid verify payload".to_string()),
            });
        }
    };
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(VerifyCredentialPayload {
            ok: false,
            code: Some(CloudSttErrorCode::Auth.as_str().to_string()),
            message: Some("API key is empty".to_string()),
        });
    }
    Ok(probe_verify(probe, key).await)
}

// ── verify probe (shared OpenAI/OpenRouter/ElevenLabs classification) ──────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum VerifyProbe {
    OpenAi,
    OpenRouter,
    ElevenLabs,
}

impl VerifyProbe {
    fn url(self) -> &'static str {
        match self {
            VerifyProbe::OpenAi => "https://api.openai.com/v1/models",
            VerifyProbe::OpenRouter => "https://openrouter.ai/api/v1/auth/key",
            VerifyProbe::ElevenLabs => "https://api.elevenlabs.io/v1/user",
        }
    }
}

async fn probe_verify(probe: VerifyProbe, api_key: &str) -> VerifyCredentialPayload {
    let client = reqwest::Client::new();
    let mut rb = client.get(probe.url()).timeout(Duration::from_secs(10));
    rb = match probe {
        VerifyProbe::ElevenLabs => rb.header("xi-api-key", api_key),
        VerifyProbe::OpenAi | VerifyProbe::OpenRouter => rb.bearer_auth(api_key),
    };
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                return VerifyCredentialPayload {
                    ok: true,
                    code: None,
                    message: None,
                };
            }
            // A scoped ElevenLabs key 401s on /v1/user yet is valid for TTS.
            if probe == VerifyProbe::ElevenLabs && is_elevenlabs_scoped_key_valid(status, &body) {
                return VerifyCredentialPayload {
                    ok: true,
                    code: None,
                    message: None,
                };
            }
            let err = classify_http_failure(status, &body, None);
            VerifyCredentialPayload {
                ok: false,
                code: Some(err.code.as_str().to_string()),
                message: Some(err.message),
            }
        }
        Err(e) => {
            let err = classify_transport_error(&e.to_string());
            VerifyCredentialPayload {
                ok: false,
                code: Some(err.code.as_str().to_string()),
                message: Some(err.message),
            }
        }
    }
}

// ── Ollama executable detection + spawn (mirrors detectOllama / startOllama) ──

pub(crate) async fn detect_ollama_executable() -> OllamaDetectResultPayload {
    // Detection shells out + touches the filesystem; do it on the blocking pool
    // so the async runtime isn't stalled (and we avoid relying on tokio's
    // optional `process`/`fs` features — `std` is always available).
    tokio::task::spawn_blocking(detect_ollama_executable_blocking)
        .await
        .unwrap_or(OllamaDetectResultPayload {
            installed: false,
            path: None,
        })
}

fn detect_ollama_executable_blocking() -> OllamaDetectResultPayload {
    // 1. PATH lookup (`where` on Windows, `which` elsewhere).
    let lookup = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(lookup);
    cmd.arg("ollama");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = stdout.lines().map(str::trim).find(|l| !l.is_empty()) {
                return OllamaDetectResultPayload {
                    installed: true,
                    path: Some(line.to_string()),
                };
            }
        }
    }
    // 2. Default install locations (Windows).
    for candidate in ollama_default_paths() {
        if std::fs::metadata(&candidate).is_ok() {
            return OllamaDetectResultPayload {
                installed: true,
                path: Some(candidate),
            };
        }
    }
    OllamaDetectResultPayload {
        installed: false,
        path: None,
    }
}

fn ollama_default_paths() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(format!("{local}\\Programs\\Ollama\\ollama.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        out.push(format!("{pf}\\Ollama\\ollama.exe"));
    }
    out
}

pub(crate) fn spawn_ollama_serve(exec_path: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exec_path);
    cmd.arg("serve");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS so the serve survives + stays hidden.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn()
        .map(|_child| ())
        .map_err(|e| format!("Failed to start Ollama: {e}"))
}

/// Mirror of `VALID_PULL_NAME_RE` in llm.ts.
fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty() {
        return Err("Model name is required".to_string());
    }
    let valid = model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'));
    if valid {
        Ok(())
    } else {
        Err("Model name contains invalid characters".to_string())
    }
}

/// Broadcast an `llm:pull-progress` event to all renderers (the plain channel the
/// reused `onOllamaPullProgress` listener parses).
fn emit_pull_progress(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("llm:pull-progress", payload);
}

// ── settings → vocab / replacement-pairs ──────────────────────────────────

fn build_vocab(settings: &WinsttSettings) -> Vocab {
    let dictionary: Vec<String> = settings.dictionary.iter().map(|d| d.term.clone()).collect();
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
