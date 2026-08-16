// LLM commands. Wraps managers::LlmManager + winstt::llm.
//
// process_text (dictation cleanup) + process_transform (transform-on-selection)
// compose the system prompt via winstt::llm (preset + context + vocab layering)
// and run it over the configured provider: Ollama via the all-Rust streaming
// path (LlmManager::ollama_dictation/transform), OpenRouter via the OpenAI-
// compatible /api/v1/chat/completions structured-output path
// (LlmManager::openrouter_chat, with fallback model), Apple Intelligence via
// the native Swift bridge (`apple_intelligence_chat`, macOS ARM64).
//
// ollama_refresh_models → OllamaScanResult (/api/tags + /api/show enrich).
// openrouter_refresh_models → OpenRouterScanResult (/api/v1/models with stored key).
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

pub(crate) mod conversions;
mod ollama_proc;
mod payloads;
mod verify;

use std::sync::Arc;
use std::time::Duration;

use log::warn;
use tauri::{AppHandle, Emitter, State};

use crate::winstt::cloud_stt::{
    CloudSttErrorCode, CloudSttProvider, classify_cloud_failure_message, emit_cloud_failure,
};
use crate::winstt::llm::{self, DictationSideEffects, Vocab};
use crate::winstt::managers::LlmManager;
use crate::winstt::managers::llm_manager::PullOutcome;
use crate::winstt::observability::IssueBuilder;
use crate::winstt::settings_schema::{LlmProvider, WinsttSettings};

use super::ollama_pull::{clear_pull_cancel, pull_cancel_token};
use super::settings::read_settings;

use conversions::{dictation_presets, openrouter_options, to_llm_effort, transforms_presets};
use ollama_proc::{emit_pull_progress, validate_model_name};
use verify::{VerifyProbe, probe_verify, resolve_verify_api_key};

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
pub(crate) use ollama_proc::{
    authorize_ollama_model_management_label, detect_ollama_executable, spawn_ollama_serve,
    stop_winstt_spawned_ollama,
};

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

fn normalize_llm_text_output(text: &str) -> String {
    // Explode any inline enumeration the model emitted onto one line (layout
    // only — see `winstt::llm::explode_inline_lists`), then strip trailing
    // whitespace from each line.
    llm::explode_inline_lists(text)
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Run one Apple Intelligence request over the Swift bridge (macOS ARM64).
/// This is the ONE Apple provider entry for the unified LLM pipeline —
/// dictation, transforms, and the playground preview all route here. Non-Apple
/// builds and unavailable devices return `Err` so each caller applies its own
/// fail policy (dictation fail-softs to the original text; transforms/preview
/// surface the failure).
///
/// The bridge call is a synchronous on-device inference; callers run inside
/// async commands, matching how the retired legacy path invoked it.
pub(crate) fn apple_intelligence_chat(
    system_prompt: &str,
    user_prompt: &str,
    max_output_tokens: Option<i64>,
) -> Result<String, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        if !crate::apple_intelligence::check_apple_intelligence_availability() {
            return Err("Apple Intelligence is not available on this device".to_string());
        }
        let max_tokens = max_output_tokens.unwrap_or(0).clamp(0, i64::from(i32::MAX)) as i32;
        let answer = crate::apple_intelligence::process_text_with_system_prompt(
            system_prompt,
            user_prompt,
            max_tokens,
        )?;
        if answer.trim().is_empty() {
            return Err("Apple Intelligence returned an empty response".to_string());
        }
        Ok(answer)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (system_prompt, user_prompt, max_output_tokens);
        Err("Apple Intelligence requires an Apple Silicon Mac".to_string())
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "observability records keep domain/provider/model/request context together"
)]
fn record_llm_issue(
    app: &AppHandle,
    area: &str,
    operation: &str,
    summary: &str,
    detail: &str,
    provider: &str,
    model: &str,
    request_id: &str,
    feature: &str,
    user_visible: bool,
    extra_context: &[(&str, &str)],
) {
    let compact = llm::compact_error_for_log(detail);
    let mut issue = IssueBuilder::new(area, operation, summary)
        .detail(compact)
        .provider(provider.to_string())
        .user_visible(user_visible);
    if !model.trim().is_empty() {
        issue = issue.model_id(model.to_string());
    }
    if !request_id.trim().is_empty() {
        issue = issue.request_id(request_id.to_string());
    }
    if !feature.trim().is_empty() {
        issue = issue.context("feature", feature.to_string());
    }
    for (key, value) in extra_context {
        if !value.trim().is_empty() {
            issue = issue.context(*key, (*value).to_string());
        }
    }
    issue.record(Some(app));
}

/// Records an OpenRouter catalog-scan failure as a user-visible `cloud`/`openrouter`
/// issue, deriving the detail from `error` (falling back to `default_detail` when the
/// scan reported unreachable without a message). Shared by the three
/// `openrouter_refresh_*_models` commands, which differ only in `operation`,
/// `summary`, `default_detail`, and `feature`.
fn record_openrouter_scan_failure(
    app: &AppHandle,
    operation: &str,
    summary: &str,
    default_detail: &str,
    feature: &str,
    error: Option<&str>,
) {
    let detail = error.unwrap_or(default_detail);
    record_llm_issue(
        app,
        "cloud",
        operation,
        summary,
        detail,
        "openrouter",
        "",
        "",
        feature,
        true,
        &[],
    );
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
    let settings = read_settings(&app);
    process_dictation_text(&app, llm_manager.inner().clone(), text, context, &settings)
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
    pub failsoft_error: Option<String>,
    /// Token usage + USD cost of the cloud LLM pass, when the provider
    /// reported usage (OpenRouter). `None` for local providers.
    pub llm_usage: Option<crate::winstt::managers::LlmRunUsage>,
}

pub(crate) async fn process_dictation_text(
    app: &AppHandle,
    llm_manager: Arc<LlmManager>,
    text: String,
    context: String,
    settings: &WinsttSettings,
) -> Result<DictationProcessResult, String> {
    let presets = dictation_presets(settings);
    let vocab = build_vocab(settings);
    let tier_model = ollama_tier_model(
        settings.llm.dictation.base.provider,
        &settings.llm.dictation.base.model,
    );
    let system_prompt =
        llm::build_dictation_system_prompt_for_model(&presets, &context, &vocab, tier_model);
    let user_prompt = llm::dictation_user_prompt_for_presets(&presets, &text);
    let effort = to_llm_effort(settings.llm.dictation.base.thinking_effort);

    let mgr = llm_manager;
    let request_id = mgr.next_request_id();
    let endpoint = settings.llm.endpoint.clone();
    let model = settings.llm.dictation.base.model.clone();
    let _processing = LlmCommandProcessingGuard::new(app);

    // Provider routing (mirrors runProcessText): OpenRouter via the OpenAI-
    // compatible chat endpoint, otherwise the all-Rust Ollama streaming path.
    // Apple Intelligence soft-fails to the original text in this command path
    // until the native provider is wired into the unified LLM manager.
    let mut side_effects = DictationSideEffects::default();
    let mut failsoft_error: Option<String> = None;
    let mut llm_usage: Option<crate::winstt::managers::LlmRunUsage> = None;
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
            let outcome = run_openrouter_with_fallback(
                &mgr,
                OpenRouterFallbackRequest {
                    app,
                    api_key: &api_key,
                    primary: &selection,
                    fallback: &fallback,
                    system_prompt: &system_prompt,
                    user_prompt: &user_prompt,
                    text: &text,
                    feature: "dictation",
                    request_id: &request_id,
                    timeout_ms: settings.llm.timeout,
                    options: openrouter_options(&settings.llm.dictation.base),
                },
            )
            .await;
            failsoft_error = outcome.failsoft_error;
            // The chat parked its usage/cost on the manager's ledger under this
            // request id (the fallback attempt reuses the id, so this reads
            // whichever attempt actually produced the answer).
            llm_usage = mgr.take_llm_usage(&request_id);
            outcome.text
        }
        LlmProvider::AppleIntelligence => match apple_intelligence_chat(
            &system_prompt,
            &user_prompt,
            settings.llm.dictation.base.max_output_tokens,
        ) {
            Ok(answer) => answer,
            Err(err) => {
                let compact = llm::compact_error_for_log(&err);
                warn!(
                    "[llm][{request_id}] dictation Apple Intelligence failed; returning original text: {compact}"
                );
                record_llm_issue(
                    app,
                    "llm",
                    "dictation",
                    "Apple Intelligence dictation post-processing failed; original text was kept",
                    &compact,
                    "apple_intelligence",
                    "",
                    &request_id,
                    "dictation",
                    true,
                    &[],
                );
                failsoft_error = Some(format!("Apple Intelligence failed: {compact}"));
                text.clone()
            }
        },
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
                let compact = llm::compact_error_for_log(&err);
                warn!(
                    "[llm][{request_id}] dictation Ollama model '{model}' failed; returning original text: {}",
                    compact
                );
                record_llm_issue(
                    app,
                    "llm",
                    "dictation",
                    "LLM dictation post-processing failed; original text was kept",
                    &compact,
                    "ollama",
                    &model,
                    &request_id,
                    "dictation",
                    true,
                    &[],
                );
                failsoft_error = Some(format!("Ollama model '{model}' failed: {compact}"));
                text.clone()
            }
        },
    };

    // Vocabulary words + replacement pairs are fed to the model as structured prompt blocks
    // (`build_dictation_system_prompt`) so it corrects them WITH context. Replacement pairs are ALSO
    // enforced by a deterministic post-pass on the model's output in `actions::post_process` (the
    // schema's documented safety net), which is where their count is folded into `dictionary_fixes` —
    // so this stage reports 0 and never double-counts.
    let text = normalize_llm_text_output(&answer);
    Ok(DictationProcessResult {
        text,
        dictionary_fixes: 0,
        side_effects,
        failsoft_error,
        llm_usage,
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
    let system_prompt = llm::build_system_prompt_tiered(
        &presets,
        ollama_tier_model(
            settings.llm.transforms.base.provider,
            &settings.llm.transforms.base.model,
        )
        .is_some_and(llm::is_lite_ollama_model),
    );
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
                    app: &app,
                    api_key: &api_key,
                    primary: &selection,
                    fallback: &fallback,
                    system_prompt: &system_prompt,
                    user_prompt: &user_prompt,
                    text: &text,
                    feature: &transform_id,
                    request_id: &request_id,
                    timeout_ms: settings.llm.timeout,
                    options: openrouter_options(&settings.llm.transforms.base),
                },
            )
            .await
            .text
        }
        LlmProvider::AppleIntelligence => apple_intelligence_chat(
            &system_prompt,
            &user_prompt,
            settings.llm.transforms.base.max_output_tokens,
        )
        .unwrap_or_else(|err| {
            let compact = llm::compact_error_for_log(&err);
            warn!(
                "[llm][{request_id}] transform '{transform_id}' Apple Intelligence failed; returning original text: {compact}"
            );
            record_llm_issue(
                &app,
                "llm",
                "transform",
                "Apple Intelligence transform failed; original text was kept",
                &compact,
                "apple_intelligence",
                "",
                &request_id,
                &transform_id,
                true,
                &[],
            );
            text.clone()
        }),
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
                let compact = llm::compact_error_for_log(&err);
                warn!(
                    "[llm][{request_id}] transform '{}' Ollama model '{model}' failed; returning original text: {}",
                    transform_id,
                    compact
                );
                record_llm_issue(
                    &app,
                    "llm",
                    "transform",
                    "LLM transform failed; original text was kept",
                    &compact,
                    "ollama",
                    &model,
                    &request_id,
                    &transform_id,
                    true,
                    &[],
                );
                text.clone()
            }),
    };
    // Same layout normalization as the dictation path: explode inline
    // enumerations to real newlines + trim trailing whitespace.
    Ok(normalize_llm_text_output(&answer))
}

/// Try the primary OpenRouter selection; on failure (and when a fallback is
/// configured), retry with the fallback model. On total failure, return the
/// original text. Mirrors `runOpenRouterWithFallback`.
struct OpenRouterFallbackRequest<'a> {
    app: &'a AppHandle,
    api_key: &'a str,
    primary: &'a str,
    fallback: &'a str,
    system_prompt: &'a str,
    user_prompt: &'a str,
    text: &'a str,
    feature: &'a str,
    request_id: &'a str,
    timeout_ms: i64,
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

struct OpenRouterFallbackOutcome {
    text: String,
    failsoft_error: Option<String>,
}

impl OpenRouterFallbackOutcome {
    fn success(text: String) -> Self {
        Self {
            text,
            failsoft_error: None,
        }
    }

    fn failsoft(text: &str, error: String) -> Self {
        Self {
            text: text.to_string(),
            failsoft_error: Some(error),
        }
    }
}

async fn run_openrouter_with_fallback(
    mgr: &Arc<LlmManager>,
    request: OpenRouterFallbackRequest<'_>,
) -> OpenRouterFallbackOutcome {
    let OpenRouterFallbackRequest {
        app,
        api_key,
        primary,
        fallback,
        system_prompt,
        user_prompt,
        text,
        feature,
        request_id,
        timeout_ms,
        options,
    } = request;

    match run_openrouter_attempt(
        mgr,
        OpenRouterAttempt {
            api_key,
            model: primary,
            system_prompt,
            user_prompt,
            text,
            options: options.clone(),
            request_id,
            timeout_ms,
        },
    )
    .await
    {
        Ok(answer) => OpenRouterFallbackOutcome::success(answer),
        Err(err) if err == llm::OPENROUTER_CANCELLED => {
            OpenRouterFallbackOutcome::success(text.to_string())
        }
        Err(primary_err)
            if !fallback.is_empty()
                && should_try_openrouter_fallback(&classify_cloud_failure_message(
                    &primary_err,
                )) =>
        {
            warn!(
                "[llm][{request_id}] {feature} OpenRouter primary model '{primary}' failed; trying fallback '{fallback}': {}",
                llm::compact_error_for_log(&primary_err)
            );
            record_llm_issue(
                app,
                "llm",
                "openrouter_primary",
                "OpenRouter primary LLM request failed; fallback will be tried",
                &primary_err,
                "openrouter",
                primary,
                request_id,
                feature,
                false,
                &[("fallbackModel", fallback)],
            );
            match run_openrouter_attempt(
                mgr,
                OpenRouterAttempt {
                    api_key,
                    model: fallback,
                    system_prompt,
                    user_prompt,
                    text,
                    options,
                    request_id,
                    timeout_ms,
                },
            )
            .await
            {
                Ok(answer) => OpenRouterFallbackOutcome::success(answer),
                Err(fallback_err) => {
                    warn!(
                        "[llm][{request_id}] {feature} OpenRouter fallback model '{fallback}' failed; returning original text: {}",
                        llm::compact_error_for_log(&fallback_err)
                    );
                    emit_openrouter_failsoft_notice(app, feature, &fallback_err);
                    let compact = llm::compact_error_for_log(&fallback_err);
                    record_llm_issue(
                        app,
                        "llm",
                        "openrouter_fallback",
                        "OpenRouter fallback LLM request failed; original text was kept",
                        &fallback_err,
                        "openrouter",
                        fallback,
                        request_id,
                        feature,
                        true,
                        &[("primaryModel", primary)],
                    );
                    OpenRouterFallbackOutcome::failsoft(
                        text,
                        format!(
                            "OpenRouter fallback model '{fallback}' failed after primary model '{primary}' failed: {compact}"
                        ),
                    )
                }
            }
        }
        Err(primary_err) => {
            warn!(
                "[llm][{request_id}] {feature} OpenRouter model '{primary}' failed with no usable fallback; returning original text: {}",
                llm::compact_error_for_log(&primary_err)
            );
            emit_openrouter_failsoft_notice(app, feature, &primary_err);
            let compact = llm::compact_error_for_log(&primary_err);
            record_llm_issue(
                app,
                "llm",
                "openrouter_request",
                "OpenRouter LLM request failed; original text was kept",
                &primary_err,
                "openrouter",
                primary,
                request_id,
                feature,
                true,
                &[],
            );
            OpenRouterFallbackOutcome::failsoft(
                text,
                format!("OpenRouter model '{primary}' failed: {compact}"),
            )
        }
    }
}

pub(crate) struct OpenRouterAttempt<'a> {
    pub(crate) api_key: &'a str,
    pub(crate) model: &'a str,
    pub(crate) system_prompt: &'a str,
    pub(crate) user_prompt: &'a str,
    pub(crate) text: &'a str,
    pub(crate) options: llm::OpenRouterRequestOptions,
    pub(crate) request_id: &'a str,
    pub(crate) timeout_ms: i64,
}

fn should_try_openrouter_fallback(code: &CloudSttErrorCode) -> bool {
    !matches!(
        code,
        CloudSttErrorCode::Auth
            | CloudSttErrorCode::KeyMissing
            | CloudSttErrorCode::Network
            | CloudSttErrorCode::Timeout
            | CloudSttErrorCode::Aborted
    )
}

pub(crate) async fn run_openrouter_attempt(
    mgr: &Arc<LlmManager>,
    attempt: OpenRouterAttempt<'_>,
) -> Result<String, String> {
    let OpenRouterAttempt {
        api_key,
        model,
        system_prompt,
        user_prompt,
        text,
        options,
        request_id,
        timeout_ms,
    } = attempt;
    match llm::with_llm_request_timeout(
        timeout_ms,
        mgr.openrouter_chat(
            api_key,
            model,
            system_prompt,
            user_prompt,
            text,
            options,
            Some(request_id),
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            mgr.clear_cancel(request_id);
            Err(format!(
                "OpenRouter request timed out after {}ms",
                llm::llm_request_timeout(timeout_ms).as_millis()
            ))
        }
    }
}

fn emit_openrouter_failsoft_notice(app: &AppHandle, feature: &str, err: &str) {
    let code = classify_cloud_failure_message(err);
    let compact = llm::compact_error_for_log(err);
    let message = if feature == "dictation" {
        format!("OpenRouter post-processing failed; pasted the original transcription. {compact}")
    } else {
        format!("OpenRouter transform failed; kept the original text. {compact}")
    };
    emit_cloud_failure(app, CloudSttProvider::OpenRouter, code, message, None);
}
/// `ollama_refresh_models` — `/api/tags` + `/api/show` capability enrich. Returns
/// the `OllamaScanResult` the picker store consumes (`{ models, reachable,
/// error? }`). A connection failure → `reachable: false`; an HTTP/parse error
/// → `reachable: true` with `error` set (the daemon answered, just badly) — this
/// drives the "Ollama not running" vs "Ollama errored" distinction in the UI.
#[tauri::command]
#[specta::specta]
pub async fn ollama_refresh_models(
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
        let detail = format!("Could not reach Ollama at {endpoint}");
        record_llm_issue(
            &app,
            "llm",
            "ollama_catalog_refresh",
            "Ollama model catalog refresh could not reach the daemon",
            &detail,
            "ollama",
            "",
            "",
            "catalog",
            true,
            &[],
        );
        return Ok(OllamaScanResultPayload {
            models: Vec::new(),
            reachable: false,
            error: Some(detail),
        });
    }
    match mgr.ollama_list_models_detailed(&endpoint).await {
        Ok(models) => {
            let models: Vec<OllamaModelPayload> = models.into_iter().map(Into::into).collect();
            // Broadcast the fresh catalog to EVERY window (`llm:catalog`, the
            // channel each window's llm-catalog store already subscribes to).
            // Each window otherwise only sees its OWN scans, so a delete/pull
            // done in the detached picker left the settings window — and its
            // deleted-model reconcile effect — looking at a stale list: the
            // removed model stayed "selected" until that window rescanned.
            let _ = app.emit("llm:catalog", serde_json::json!({ "models": &models }));
            Ok(OllamaScanResultPayload {
                models,
                reachable: true,
                error: None,
            })
        }
        Err(e) => {
            record_llm_issue(
                &app,
                "llm",
                "ollama_catalog_refresh",
                "Ollama model catalog refresh failed",
                &e,
                "ollama",
                "",
                "",
                "catalog",
                true,
                &[],
            );
            Ok(OllamaScanResultPayload {
                models: Vec::new(),
                reachable: true,
                error: Some(e),
            })
        }
    }
}

/// `openrouter_refresh_models` — `GET /api/v1/models` with the stored key, then a
/// concurrency-capped per-model `/endpoints` fan-out (provider rail / per-provider
/// pricing / quant / feature chips). Returns the `OpenRouterScanResult`
/// (`{ models, reachable, error? }`) the picker store consumes. Each `/endpoints`
/// fetch fails soft, so enrichment never blanks the catalog.
#[tauri::command]
#[specta::specta]
pub async fn openrouter_refresh_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_enriched(&api_key).await;
    if !scan.reachable || scan.error.is_some() {
        record_openrouter_scan_failure(
            &app,
            "openrouter_catalog_refresh",
            "OpenRouter model catalog refresh failed",
            "OpenRouter catalog was unreachable",
            "catalog",
            scan.error.as_deref(),
        );
    }
    Ok(OpenRouterScanResultPayload {
        models: scan.models.into_iter().map(Into::into).collect(),
        reachable: scan.reachable,
        error: scan.error,
    })
}

/// `openrouter_refresh_stt_models` - the transcription subset of the OpenRouter
/// catalog for the cloud STT picker. Reuses the shared catalog fetch with
/// `output_modalities=transcription`, enriches those rows with endpoint/provider
/// details when OpenRouter exposes them, then maps them to the STT picker shape.
#[tauri::command]
#[specta::specta]
pub async fn openrouter_refresh_stt_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterSttScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_transcription_enriched(&api_key).await;
    if !scan.reachable || scan.error.is_some() {
        record_openrouter_scan_failure(
            &app,
            "openrouter_stt_catalog_refresh",
            "OpenRouter STT model catalog refresh failed",
            "OpenRouter STT catalog was unreachable",
            "stt_catalog",
            scan.error.as_deref(),
        );
    }
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

/// `openrouter_refresh_tts_models` — the speech (TTS) subset of the OpenRouter
/// catalog for the cloud TTS picker. REUSES `scan_openrouter` via
/// `scan_openrouter_speech`, keeping only `output_modalities: ["speech"]` rows,
/// mapped to the lean `{ id, name }` shape. Mirrors `openrouter_refresh_stt_models`.
#[tauri::command]
#[specta::specta]
pub async fn openrouter_refresh_tts_models(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<OpenRouterTtsScanResultPayload, String> {
    let settings = read_settings(&app);
    let api_key = settings.llm.openrouter_api_key.clone();
    let mgr = llm_manager.inner().clone();
    let scan = mgr.scan_openrouter_speech(&api_key).await;
    if !scan.reachable || scan.error.is_some() {
        record_openrouter_scan_failure(
            &app,
            "openrouter_tts_catalog_refresh",
            "OpenRouter TTS model catalog refresh failed",
            "OpenRouter TTS catalog was unreachable",
            "tts_catalog",
            scan.error.as_deref(),
        );
    }
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
        let detail = "Ollama is not installed";
        record_llm_issue(
            &app,
            "llm",
            "ollama_start",
            "Ollama could not start because it is not installed",
            detail,
            "ollama",
            "",
            "",
            "daemon",
            true,
            &[],
        );
        return Ok(OllamaStartResultPayload {
            started: false,
            error: Some(detail.to_string()),
        });
    };
    if let Err(e) = spawn_ollama_serve(&path) {
        record_llm_issue(
            &app,
            "llm",
            "ollama_start",
            "Ollama daemon failed to start",
            &e,
            "ollama",
            "",
            "",
            "daemon",
            true,
            &[("path", path.as_str())],
        );
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
    let detail = "Ollama started but did not bind within 10s";
    record_llm_issue(
        &app,
        "llm",
        "ollama_start",
        "Ollama daemon did not become reachable after start",
        detail,
        "ollama",
        "",
        "",
        "daemon",
        true,
        &[("endpoint", endpoint.as_str())],
    );
    Ok(OllamaStartResultPayload {
        started: false,
        error: Some(detail.to_string()),
    })
}

/// `ollama_pull` — pull a model, streaming `llm:pull-progress` for every frame.
/// Honors the `ollama_cancel_pull` registry (awaitable token — cancel aborts the
/// drain instantly). Returns `OllamaPullResult` (`{ success, model, cancelled?, error? }`).
#[tauri::command]
#[specta::specta]
pub async fn ollama_pull(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    webview: tauri::WebviewWindow,
    model: String,
) -> Result<OllamaPullResultPayload, String> {
    if let Err(e) = authorize_ollama_model_management_label(webview.label(), "pull Ollama model") {
        return Ok(OllamaPullResultPayload {
            success: false,
            model,
            cancelled: None,
            error: Some(e),
        });
    }
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

    // A cancel issued after a previous pull loop already ended leaves its flag
    // set with nothing to consume it — without this reset the NEXT pull of the
    // model would start with an already-cancelled token and instantly read as
    // "paused" to the user.
    clear_pull_cancel(&model);

    // Leading "starting" frame (matches the reference broadcast).
    emit_pull_progress(
        &app,
        serde_json::json!({ "model": model.as_str(), "status": "pulling", "statusText": "starting" }),
    );

    let model_for_emit = model.clone();
    let cancel = pull_cancel_token(&model);
    let outcome = mgr.ollama_pull_stream(&endpoint, &model, &cancel).await;
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
        PullOutcome::Error(msg) => {
            record_llm_issue(
                &app,
                "llm_download",
                "ollama_pull",
                "Ollama model pull failed",
                &msg,
                "ollama",
                &model,
                "",
                "model_download",
                true,
                &[("endpoint", endpoint.as_str())],
            );
            Ok(OllamaPullResultPayload {
                success: false,
                model,
                cancelled: None,
                error: Some(msg),
            })
        }
    }
}

/// `ollama_delete` — delete a local model (`DELETE /api/delete`). Returns
/// `OllamaDeleteResult` (`{ success, model, error? }`).
#[tauri::command]
#[specta::specta]
pub async fn ollama_delete(
    app: AppHandle,
    llm_manager: State<'_, Arc<LlmManager>>,
    webview: tauri::WebviewWindow,
    model: String,
) -> Result<OllamaDeleteResultPayload, String> {
    if let Err(e) = authorize_ollama_model_management_label(webview.label(), "delete Ollama model")
    {
        return Ok(OllamaDeleteResultPayload {
            success: false,
            model,
            error: Some(e),
        });
    }
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
    if !success && let Some(detail) = error.as_deref() {
        record_llm_issue(
            &app,
            "llm",
            "ollama_delete",
            "Ollama model delete failed",
            detail,
            "ollama",
            &model,
            "",
            "model_management",
            true,
            &[("endpoint", endpoint.as_str())],
        );
    }
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

/// The exact system/user scaffolding a real dictation request sends, built with
/// an EMPTY transcript and EMPTY context. The warm-up sends this once through
/// `/api/chat` so llama.cpp caches the static prompt prefix — the transcript is
/// interpolated at the very END of the user prompt, so a real dictation then
/// only prefills the spoken words instead of paying the full system-prompt
/// ingest on the user's first phrase. Lives in the commands layer because the
/// preset/effort conversions are `pub(super)` here.
pub(crate) struct DictationPromptPrimeInputs {
    pub dictionary_auto_add_enabled: bool,
    pub effort: llm::ThinkingEffort,
    pub system_prompt: String,
    pub user_prompt: String,
}

pub(crate) fn dictation_prompt_prime_inputs(
    settings: &WinsttSettings,
) -> DictationPromptPrimeInputs {
    let presets = dictation_presets(settings);
    let vocab = build_vocab(settings);
    DictationPromptPrimeInputs {
        dictionary_auto_add_enabled: settings.llm.dictation.dictionary_auto_add_enabled,
        effort: to_llm_effort(settings.llm.dictation.base.thinking_effort),
        system_prompt: llm::build_dictation_system_prompt_for_model(
            &presets,
            "",
            &vocab,
            ollama_tier_model(
                settings.llm.dictation.base.provider,
                &settings.llm.dictation.base.model,
            ),
        ),
        user_prompt: llm::dictation_user_prompt_for_presets(&presets, ""),
    }
}

/// The Ollama model name prompt tiering keys on, or `None` when the feature
/// runs a cloud provider / has no model configured (cloud models always get
/// the full-tier prompt and envelope).
pub(crate) fn ollama_tier_model(provider: LlmProvider, model: &str) -> Option<&str> {
    let trimmed = model.trim();
    (matches!(provider, LlmProvider::Ollama) && !trimmed.is_empty()).then_some(trimmed)
}

pub(crate) fn build_vocab(settings: &WinsttSettings) -> Vocab {
    // Per-section offload toggles (Vocabulary tab): when the user routes a section away from the
    // LLM, its block is omitted from the prompt entirely and the deterministic path owns it — the
    // encoder model for dictionary terms, the fuzzy expander for snippets. Replacement pairs ride
    // with the dictionary toggle prompt-wise, but are deterministically re-applied post-pass
    // either way (`actions::post_process`).
    let dictionary: Vec<String> = if settings.general.llm_handles_dictionary {
        // Vocabulary words = entries WITHOUT a replacement (canonical spellings). Replacement-pair
        // entries are surfaced only in the <replacement-pairs> block, so their misheard `term` is
        // not also listed as a "preferred term".
        settings
            .dictionary
            .iter()
            .filter(|d| d.replacement.as_deref().map_or("", str::trim).is_empty())
            .map(|d| d.term.clone())
            .collect()
    } else {
        Vec::new()
    };
    let snippets: Vec<(String, String)> = if settings.general.llm_handles_snippets {
        settings
            .snippets
            .iter()
            .map(|s| (s.trigger.clone(), s.expansion.clone()))
            .collect()
    } else {
        Vec::new()
    };
    Vocab {
        dictionary,
        replacement_pairs: if settings.general.llm_handles_dictionary {
            replacement_pairs(settings)
        } else {
            Vec::new()
        },
        snippets,
    }
}

/// Replacement pairs are the dictionary entries that carry a replacement value. A whitespace-only
/// replacement counts as ABSENT (trimmed), matching how `build_vocab` and `actions::post_process`
/// classify vocab-vs-pair — otherwise the same entry would be both a vocab word (trimmed → empty)
/// and a pair that rewrites the term to blanks.
pub(crate) fn replacement_pairs(settings: &WinsttSettings) -> Vec<(String, String)> {
    settings
        .dictionary
        .iter()
        .filter_map(|d| {
            d.replacement
                .as_ref()
                .filter(|r| !r.trim().is_empty())
                .map(|r| (d.term.clone(), r.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::settings_schema::{DictionaryEntry, SnippetEntry};

    fn settings_with_vocab() -> WinsttSettings {
        WinsttSettings {
            dictionary: vec![
                DictionaryEntry {
                    id: "1".into(),
                    term: "Ollama".into(),
                    auto_added: None,
                    replacement: None,
                },
                DictionaryEntry {
                    id: "2".into(),
                    term: "github".into(),
                    auto_added: None,
                    replacement: Some("GitHub".into()),
                },
            ],
            snippets: vec![SnippetEntry {
                id: "3".into(),
                trigger: "my email".into(),
                expansion: "user@example.com".into(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn vocab_fully_injected_when_llm_handles_both_sections() {
        let s = settings_with_vocab();
        assert!(s.general.llm_handles_dictionary);
        assert!(s.general.llm_handles_snippets);
        let vocab = build_vocab(&s);
        assert_eq!(vocab.dictionary, vec!["Ollama".to_string()]);
        assert_eq!(
            vocab.replacement_pairs,
            vec![("github".to_string(), "GitHub".to_string())]
        );
        assert_eq!(
            vocab.snippets,
            vec![("my email".to_string(), "user@example.com".to_string())]
        );
    }

    #[test]
    fn dictionary_offload_keeps_terms_and_pairs_out_of_the_prompt() {
        let mut s = settings_with_vocab();
        s.general.llm_handles_dictionary = false;
        let vocab = build_vocab(&s);
        assert!(vocab.dictionary.is_empty());
        assert!(vocab.replacement_pairs.is_empty());
        // Snippets are governed by their own toggle and stay injected.
        assert_eq!(vocab.snippets.len(), 1);
    }

    #[test]
    fn snippet_offload_keeps_snippets_out_of_the_prompt() {
        let mut s = settings_with_vocab();
        s.general.llm_handles_snippets = false;
        let vocab = build_vocab(&s);
        assert!(vocab.snippets.is_empty());
        // Dictionary is governed by its own toggle and stays injected.
        assert_eq!(vocab.dictionary.len(), 1);
        assert_eq!(vocab.replacement_pairs.len(), 1);
    }
}
