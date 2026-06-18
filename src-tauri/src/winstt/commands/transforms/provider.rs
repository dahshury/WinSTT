// Provider routing for the transform/preview LLM calls: dispatch to
// Apple-Intelligence soft-fail / OpenRouter (with fallback) / Ollama streaming.
//
// Extracted verbatim from the transforms module root (mirrors
// llm.rs::process_transform → runProcessText).

use std::sync::Arc;

use tauri::AppHandle;

use crate::winstt::llm::{self, ThinkingEffort as LlmEffort};
use crate::winstt::managers::LlmManager;
use crate::winstt::observability::IssueBuilder;
use crate::winstt::settings_schema::{LlmProvider, WinsttSettings};

use super::convert::openrouter_options;

// ── provider routing (mirrors llm.rs::process_transform → runProcessText) ───────

/// Run the composed transforms `system_prompt` over `text` on the feature's
/// CONFIGURED provider. Returns the transformed text on success, or `Err(reason)`
/// on a hard provider failure (the caller surfaces it via `transforms:failed`).
///
/// Routing mirrors `runProcessText` in llm.ts exactly:
///   - Apple Intelligence → soft-fail to the original text in this command path.
///   - OpenRouter → OpenAI-compatible structured-output chat with fallback model.
///   - Ollama → the all-Rust streaming `/api/chat` path.
#[expect(
    clippy::too_many_arguments,
    reason = "provider routing mirrors the configured transform request surface"
)]
pub(super) async fn run_transform_provider(
    app: &AppHandle,
    mgr: &Arc<LlmManager>,
    settings: &WinsttSettings,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    effort: LlmEffort,
    model: &str,
) -> Result<String, String> {
    match settings.llm.transforms.base.provider {
        // Apple Intelligence soft-fails here until the native provider is wired
        // into the unified transform pipeline.
        LlmProvider::AppleIntelligence => Ok(text.to_string()),
        LlmProvider::Openrouter => {
            let api_key = settings.llm.openrouter_api_key.clone();
            let selection = settings.llm.transforms.base.openrouter_model.clone();
            let fallback = settings
                .llm
                .transforms
                .base
                .openrouter_fallback_model
                .clone();
            let request_id = mgr.next_request_id();
            // OpenRouter's structured-output path already returns the fallback
            // text on a total failure (never throws across the boundary), so the
            // pipeline can paste-replace with the original on a dead provider.
            Ok(run_openrouter_with_fallback(
                app,
                mgr,
                &api_key,
                &selection,
                &fallback,
                system_prompt,
                user_prompt,
                text,
                &request_id,
                openrouter_options(&settings.llm.transforms.base),
            )
            .await)
        }
        LlmProvider::Ollama => {
            let endpoint = settings.llm.endpoint.clone();
            let request_id = mgr.next_request_id();
            match mgr
                .ollama_transform(
                    &endpoint,
                    model,
                    system_prompt,
                    user_prompt,
                    text,
                    effort,
                    &request_id,
                )
                .await
            {
                Ok(answer) => Ok(answer),
                Err(err) => {
                    record_transform_issue(
                        app,
                        "transform",
                        "LLM transform failed",
                        &err,
                        "ollama",
                        model,
                        &request_id,
                        &[("endpoint", endpoint.as_str())],
                    );
                    Err(err)
                }
            }
        }
    }
}

/// Try the primary OpenRouter selection; on failure (and when a fallback is
/// configured), retry with the fallback model. On total failure, return the
/// original text. Mirrors `runOpenRouterWithFallback` (and llm.rs's copy).
#[expect(
    clippy::too_many_arguments,
    reason = "fallback routing mirrors the OpenRouter request surface and fallback policy"
)]
async fn run_openrouter_with_fallback(
    app: &AppHandle,
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    request_id: &str,
    options: llm::OpenRouterRequestOptions,
) -> String {
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
        Err(primary_err) if primary_err == llm::OPENROUTER_CANCELLED => text.to_string(),
        Err(primary_err) if !fallback.is_empty() => {
            record_transform_issue(
                app,
                "openrouter_primary",
                "OpenRouter transform primary model failed; fallback will be tried",
                &primary_err,
                "openrouter",
                primary,
                request_id,
                &[("fallbackModel", fallback)],
            );
            mgr.openrouter_chat(
                api_key,
                fallback,
                system_prompt,
                user_prompt,
                text,
                options,
                Some(request_id),
            )
            .await
            .unwrap_or_else(|fallback_err| {
                record_transform_issue(
                    app,
                    "openrouter_fallback",
                    "OpenRouter transform fallback model failed; original text was kept",
                    &fallback_err,
                    "openrouter",
                    fallback,
                    request_id,
                    &[("primaryModel", primary)],
                );
                text.to_string()
            })
        }
        Err(primary_err) => {
            record_transform_issue(
                app,
                "openrouter_request",
                "OpenRouter transform failed; original text was kept",
                &primary_err,
                "openrouter",
                primary,
                request_id,
                &[],
            );
            text.to_string()
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "observability records provider/model/request context without allocating an options struct"
)]
fn record_transform_issue(
    app: &AppHandle,
    operation: &str,
    summary: &str,
    detail: &str,
    provider: &str,
    model: &str,
    request_id: &str,
    extra_context: &[(&str, &str)],
) {
    let compact = llm::compact_error_for_log(detail);
    let mut issue = IssueBuilder::new("llm", operation, summary)
        .detail(compact)
        .provider(provider.to_string())
        .request_id(request_id.to_string())
        .context("feature", "transforms");
    if !model.trim().is_empty() {
        issue = issue.model_id(model.to_string());
    }
    for (key, value) in extra_context {
        if !value.trim().is_empty() {
            issue = issue.context(*key, (*value).to_string());
        }
    }
    issue.record(Some(app));
}

/// Preview-specific OpenRouter routing. Unlike the runtime transform path, the
/// playground must surface provider failures instead of making them look like
/// "the model decided not to change anything".
#[expect(
    clippy::too_many_arguments,
    reason = "preview fallback routing mirrors the OpenRouter request surface and fallback policy"
)]
pub(super) async fn run_openrouter_preview_with_fallback(
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    feature: &str,
    request_id: &str,
    options: llm::OpenRouterRequestOptions,
) -> Result<String, String> {
    match mgr
        .openrouter_chat(
            api_key,
            primary,
            system_prompt,
            user_prompt,
            "",
            options.clone(),
            Some(request_id),
        )
        .await
    {
        Ok(answer) if !answer.trim().is_empty() => Ok(answer),
        Ok(_) if !fallback.is_empty() => {
            log::warn!(
                "[llm][{request_id}] preview {feature} OpenRouter primary model '{primary}' returned no text; trying fallback '{fallback}'"
            );
            mgr.openrouter_chat(
                api_key,
                fallback,
                system_prompt,
                user_prompt,
                "",
                options.clone(),
                Some(request_id),
            )
                .await
                .and_then(|answer| {
                    if answer.trim().is_empty() {
                        Err(format!(
                            "OpenRouter fallback model '{fallback}' returned no transformed text"
                        ))
                    } else {
                        Ok(answer)
                    }
                })
                .map_err(|fallback_err| {
                    format!(
                        "OpenRouter primary model '{primary}' returned no transformed text; fallback model '{fallback}' failed: {}",
                        llm::compact_error_for_log(&fallback_err)
                    )
                })
        }
        Ok(_) => Err(format!(
            "OpenRouter model '{primary}' returned no transformed text"
        )),
        // User aborted (overlay X / model swap): surface as cancelled, no fallback.
        Err(err) if err == llm::OPENROUTER_CANCELLED => Err("Cancelled".to_string()),
        Err(primary_err) if !fallback.is_empty() => {
            log::warn!(
                "[llm][{request_id}] preview {feature} OpenRouter primary model '{primary}' failed; trying fallback '{fallback}': {}",
                llm::compact_error_for_log(&primary_err)
            );
            mgr.openrouter_chat(
                api_key,
                fallback,
                system_prompt,
                user_prompt,
                "",
                options,
                Some(request_id),
            )
                .await
                .and_then(|answer| {
                    if answer.trim().is_empty() {
                        Err(format!(
                            "OpenRouter fallback model '{fallback}' returned no transformed text"
                        ))
                    } else {
                        Ok(answer)
                    }
                })
                .map_err(|fallback_err| {
                    format!(
                        "OpenRouter primary model '{primary}' failed: {}; fallback model '{fallback}' failed: {}",
                        llm::compact_error_for_log(&primary_err),
                        llm::compact_error_for_log(&fallback_err)
                    )
                })
        }
        Err(primary_err) => Err(format!(
            "OpenRouter model '{primary}' failed: {}",
            llm::compact_error_for_log(&primary_err)
        )),
    }
}
