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
//
// The file is split into sibling submodules for navigability (behavior-preserving):
//   `payloads`     — renderer DTOs + `From` conversions (re-exported `pub`).
//   `conversions`  — settings → prompt-shape helpers (`pub(super)`).
//   `verify`       — the `verify_credential` provider-key probe internals
//                    (`VerifyProbe` / `resolve_verify_api_key` / `probe_verify`);
//                    the `#[tauri::command]` entry stays in this root.
//   `ollama_proc`  — Ollama exe detect/spawn + pull-name validation/emit.

mod conversions;
mod ollama_proc;
mod payloads;
mod verify;

use std::sync::Arc;
use std::time::Duration;

use log::warn;
use tauri::{AppHandle, Emitter, State};

use crate::winstt::cloud_stt::CloudSttErrorCode;
use crate::winstt::llm::{
    self, build_dictation_system_prompt, build_system_prompt, DictationSideEffects, Vocab,
};
use crate::winstt::managers::llm_manager::PullOutcome;
use crate::winstt::managers::LlmManager;
use crate::winstt::settings_schema::{LlmProvider, WinsttSettings};

use super::ollama_pull::{clear_pull_cancel, is_pull_cancelled};
use super::settings::read_settings;

use conversions::{dictation_presets, openrouter_options, to_llm_effort, transforms_presets};
use ollama_proc::{emit_pull_progress, validate_model_name};
use verify::{probe_verify, resolve_verify_api_key, VerifyProbe};

// Re-exports preserving the public `winstt::commands::llm::*` paths.
pub use payloads::{
    OllamaDeleteResultPayload, OllamaDetectResultPayload, OllamaModelDetailsPayload,
    OllamaModelPayload, OllamaPullResultPayload, OllamaScanResultPayload, OllamaStartResultPayload,
    OpenRouterModelPayload, OpenRouterScanResultPayload, OpenRouterSttModelPayload,
    OpenRouterSttScanResultPayload, OpenRouterTtsModelPayload, OpenRouterTtsScanResultPayload,
    VerifyCredentialPayload,
};
// `detect_ollama_executable` / `spawn_ollama_serve` are crate-internal and called
// by `managers::llm_manager` through `winstt::commands::llm::*`; the `pub(crate) use`
// both re-exports that path AND brings them into scope for the commands below.
pub(crate) use ollama_proc::{detect_ollama_executable, spawn_ollama_serve};

struct LlmCommandProcessingGuard {
    app: AppHandle,
}

impl LlmCommandProcessingGuard {
    fn new(app: &AppHandle) -> Self {
        crate::tray::on_llm_thinking_start(app);
        let _ = app.emit("llm:processing-start", ());
        Self { app: app.clone() }
    }
}

impl Drop for LlmCommandProcessingGuard {
    fn drop(&mut self) {
        let _ = self.app.emit("llm:processing-end", ());
        crate::tray::on_llm_thinking_stop(&self.app);
    }
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
    process_dictation_text(&app, llm_manager.inner().clone(), text, context)
        .await
        .map(|result| result.text)
}

/// Run the dictation cleanup pass and return the cleaned text together with the
/// number of deterministic dictionary replacement-pair substitutions applied
/// (the History "AI Impact" → dictionary-fixes stat). Callers that don't record
/// the stat (the `process_text` command) discard the count.
pub(crate) struct DictationProcessResult {
    pub text: String,
    pub dictionary_fixes: usize,
    pub side_effects: DictationSideEffects,
}

pub(crate) async fn process_dictation_text(
    app: &AppHandle,
    llm_manager: Arc<LlmManager>,
    text: String,
    context: String,
) -> Result<DictationProcessResult, String> {
    let settings = read_settings(app);
    let presets = dictation_presets(&settings);
    let vocab = build_vocab(&settings);
    let system_prompt = build_dictation_system_prompt(&presets, &context, &vocab);
    let user_prompt = llm::dictation_user_prompt_for_presets(&presets, &text);
    let effort = to_llm_effort(settings.llm.dictation.base.thinking_effort);

    let mgr = llm_manager;
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.dictation.base.model.clone();
    let _processing = LlmCommandProcessingGuard::new(app);

    // Provider routing (mirrors runProcessText): OpenRouter via the OpenAI-
    // compatible chat endpoint, otherwise the all-Rust Ollama streaming path.
    // Apple Intelligence soft-fails to the original text — its CLI is macOS-only
    // and this is a Windows app (mirrors runAppleIntelligencePath's fail-soft).
    let mut side_effects = DictationSideEffects::default();
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
            run_openrouter_with_fallback(
                &mgr,
                OpenRouterFallbackRequest {
                    api_key: &api_key,
                    primary: &selection,
                    fallback: &fallback,
                    system_prompt: &system_prompt,
                    user_prompt: &user_prompt,
                    text: &text,
                    feature: "dictation",
                    request_id: &request_id,
                    options: openrouter_options(&settings.llm.dictation.base),
                },
            )
            .await
        }
        LlmProvider::AppleIntelligence => text.clone(),
        LlmProvider::Ollama => match mgr
            .ollama_dictation(
                &endpoint,
                &model,
                &system_prompt,
                &user_prompt,
                &text,
                effort,
                settings.llm.dictation.dictionary_auto_add_enabled,
                &request_id,
            )
            .await
        {
            Ok(output) => {
                side_effects = output.side_effects;
                output.text
            }
            Err(err) => {
                warn!(
                    "[llm][{request_id}] dictation Ollama model '{model}' failed; returning original text: {}",
                    llm::compact_error_for_log(&err)
                );
                text.clone()
            }
        },
    };

    // Deterministic replacement-pair safety net (guaranteed fire). The
    // substitution count feeds the History "AI Impact" dictionary-fixes stat.
    let pairs = replacement_pairs(&settings);
    let (text, dictionary_fixes) = llm::apply_replacement_pairs_counted(&answer, &pairs);
    Ok(DictationProcessResult {
        text,
        dictionary_fixes,
        side_effects,
    })
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
    let presets = transforms_presets(&settings);
    let system_prompt = build_system_prompt(&presets);
    let user_prompt = llm::transforms_user_prompt_for_presets(&presets, &text);
    let effort = to_llm_effort(settings.llm.transforms.base.thinking_effort);

    let mgr = llm_manager.inner().clone();
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.transforms.base.model.clone();
    let _processing = LlmCommandProcessingGuard::new(&app);

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
            run_openrouter_with_fallback(
                &mgr,
                OpenRouterFallbackRequest {
                    api_key: &api_key,
                    primary: &selection,
                    fallback: &fallback,
                    system_prompt: &system_prompt,
                    user_prompt: &user_prompt,
                    text: &text,
                    feature: &transform_id,
                    request_id: &request_id,
                    options: openrouter_options(&settings.llm.transforms.base),
                },
            )
            .await
        }
        LlmProvider::AppleIntelligence => text.clone(),
        LlmProvider::Ollama => mgr
            .ollama_transform(
                &endpoint,
                &model,
                &system_prompt,
                &user_prompt,
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
struct OpenRouterFallbackRequest<'a> {
    api_key: &'a str,
    primary: &'a str,
    fallback: &'a str,
    system_prompt: &'a str,
    user_prompt: &'a str,
    text: &'a str,
    feature: &'a str,
    request_id: &'a str,
    options: llm::OpenRouterRequestOptions,
}

fn score_from_wer_percent(wer: f32) -> f32 {
    (1.0 - wer / 30.0).clamp(0.0, 1.0)
}

/// Normalized 0..1 guidance scores for OpenRouter STT rows. Accuracy uses
/// published WER where OpenRouter exposes one in the speech-to-text collection;
/// the remaining rows use conservative catalog-positioning estimates so the
/// cloud picker can show the same accuracy/speed trade-off as local models.
fn openrouter_stt_scores(id: &str) -> (f32, f32) {
    match id {
        "openai/whisper-large-v3" => (score_from_wer_percent(10.3), 0.65),
        "openai/whisper-large-v3-turbo" => (score_from_wer_percent(12.0), 0.86),
        "nvidia/parakeet-tdt-0.6b-v3" => (score_from_wer_percent(6.34), 0.82),
        "openai/gpt-4o-transcribe" => (0.92, 0.72),
        "microsoft/mai-transcribe-1.5" => (0.88, 0.88),
        "google/chirp-3" => (0.86, 0.80),
        "openai/gpt-4o-mini-transcribe" => (0.84, 0.82),
        "qwen/qwen3-asr-flash-2026-02-10" => (0.84, 0.90),
        "mistralai/voxtral-mini-transcribe" => (0.82, 0.84),
        "openai/whisper-1" => (0.78, 0.62),
        _ => (0.50, 0.50),
    }
}

/// Normalized 0..1 guidance scores for OpenRouter speech rows. OpenRouter does
/// not publish a common TTS benchmark table, so these mirror the local TTS
/// catalog's editorial quality/speed convention.
fn openrouter_tts_scores(id: &str) -> (f32, f32) {
    match id {
        "google/gemini-3.1-flash-tts-preview" => (0.90, 0.86),
        "hexgrad/kokoro-82m" => (0.90, 0.85),
        "microsoft/mai-voice-2" => (0.88, 0.78),
        "canopylabs/orpheus-3b-0.1-ft" => (0.86, 0.72),
        "sesame/csm-1b" => (0.84, 0.70),
        "x-ai/grok-voice-tts-1.0" => (0.84, 0.82),
        "mistralai/voxtral-mini-tts-2603" => (0.84, 0.82),
        "zyphra/zonos-v0.1-hybrid" => (0.82, 0.78),
        "zyphra/zonos-v0.1-transformer" => (0.80, 0.74),
        _ => (0.50, 0.50),
    }
}

async fn run_openrouter_with_fallback(
    mgr: &Arc<LlmManager>,
    request: OpenRouterFallbackRequest<'_>,
) -> String {
    let OpenRouterFallbackRequest {
        api_key,
        primary,
        fallback,
        system_prompt,
        user_prompt,
        text,
        feature,
        request_id,
        options,
    } = request;

    match mgr
        .openrouter_chat(
            api_key,
            primary,
            system_prompt,
            user_prompt,
            text,
            options.clone(),
            Some(request_id),
        )
        .await
    {
        Ok(answer) => answer,
        // User aborted (overlay X / model swap): paste the original and do NOT
        // run the fallback model — the dictation/transform is being torn down.
        Err(err) if err == llm::OPENROUTER_CANCELLED => text.to_string(),
        Err(primary_err) if !fallback.is_empty() => {
            warn!(
                "[llm][{request_id}] {feature} OpenRouter primary model '{primary}' failed; trying fallback '{fallback}': {}",
                llm::compact_error_for_log(&primary_err)
            );
            match mgr
                .openrouter_chat(
                    api_key,
                    fallback,
                    system_prompt,
                    user_prompt,
                    text,
                    options,
                    Some(request_id),
                )
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

/// `scan_openrouter_models` — `GET /api/v1/models` with the stored key, then a
/// concurrency-capped per-model `/endpoints` fan-out (provider rail / per-provider
/// pricing / quant / feature chips). Returns the `OpenRouterScanResult`
/// (`{ models, reachable, error? }`) the picker store consumes. Each `/endpoints`
/// fetch fails soft, so enrichment never blanks the catalog.
#[tauri::command]
#[specta::specta]
pub async fn scan_openrouter_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_enriched(&api_key).await;
    Ok(OpenRouterScanResultPayload {
        models: scan.models.into_iter().map(Into::into).collect(),
        reachable: scan.reachable,
        error: scan.error,
    })
}

/// `scan_openrouter_stt_models` - the transcription subset of the OpenRouter
/// catalog for the cloud STT picker. Reuses the shared catalog fetch with
/// `output_modalities=transcription`, enriches those rows with endpoint/provider
/// details when OpenRouter exposes them, then maps them to the STT picker shape.
#[tauri::command]
#[specta::specta]
pub async fn scan_openrouter_stt_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterSttScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_transcription_enriched(&api_key).await;
    Ok(OpenRouterSttScanResultPayload {
        models: scan
            .models
            .into_iter()
            .map(|m| {
                let (accuracy_score, speed_score) = openrouter_stt_scores(&m.id);
                OpenRouterSttModelPayload {
                    id: m.id,
                    name: m.name,
                    description: m.description,
                    pricing: m.pricing,
                    endpoints: m
                        .endpoints
                        .map(|eps| eps.into_iter().map(Into::into).collect()),
                    accuracy_score,
                    speed_score,
                }
            })
            .collect(),
        reachable: scan.reachable,
        error: scan.error,
    })
}

/// `scan_openrouter_tts_models` — the speech (TTS) subset of the OpenRouter
/// catalog for the cloud TTS picker. REUSES `scan_openrouter` via
/// `scan_openrouter_speech`, keeping only `output_modalities: ["speech"]` rows,
/// mapped to the lean `{ id, name }` shape. Mirrors `scan_openrouter_stt_models`.
#[tauri::command]
#[specta::specta]
pub async fn scan_openrouter_tts_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterTtsScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_speech(&api_key).await;
    Ok(OpenRouterTtsScanResultPayload {
        models: scan
            .models
            .into_iter()
            .map(|m| {
                let (quality_score, speed_score) = openrouter_tts_scores(&m.id);
                OpenRouterTtsModelPayload {
                    id: m.id,
                    name: m.name,
                    description: m.description,
                    pricing: m.pricing,
                    supported_voices: m.supported_voices.unwrap_or_default(),
                    quality_score,
                    speed_score,
                }
            })
            .collect(),
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
/// `{ ok, code?, message? }` (the WinSTT taxonomy `code`). Covers ElevenLabs AND
/// OpenRouter; the renderer routes both through this channel. (OpenAI was removed
/// as a direct cloud STT provider.) Side-effect-free: never persists the key.
#[tauri::command]
#[specta::specta]
pub async fn verify_credential(
    app: AppHandle,
    provider: String,
    api_key: String,
) -> Result<VerifyCredentialPayload, String> {
    let probe = match provider.as_str() {
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
    let key = resolve_verify_api_key(&app, probe, &api_key);
    let key = key.trim();
    if key.is_empty() {
        return Ok(VerifyCredentialPayload {
            ok: false,
            code: Some(CloudSttErrorCode::Auth.as_str().to_string()),
            message: Some("API key is empty".to_string()),
        });
    }
    Ok(probe_verify(probe, key).await)
}

// ── settings → vocab / replacement-pairs ──────────────────────────────────

pub(crate) fn build_vocab(settings: &WinsttSettings) -> Vocab {
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
pub(crate) fn replacement_pairs(settings: &WinsttSettings) -> Vec<(String, String)> {
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
