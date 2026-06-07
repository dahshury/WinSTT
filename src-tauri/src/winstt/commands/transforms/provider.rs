// Provider routing for the transform/preview LLM calls: dispatch to
// Apple-Intelligence soft-fail / OpenRouter (with fallback) / Ollama streaming.
//
// Extracted verbatim from the transforms module root (mirrors
// llm.rs::process_transform → runProcessText).

use std::sync::Arc;

use crate::winstt::llm::{self, ThinkingEffort as LlmEffort};
use crate::winstt::managers::LlmManager;
use crate::winstt::settings_schema::{LlmProvider, WinsttSettings};

use super::convert::openrouter_options;

// ── provider routing (mirrors llm.rs::process_transform → runProcessText) ───────

/// Run the composed transforms `system_prompt` over `text` on the feature's
/// CONFIGURED provider. Returns the transformed text on success, or `Err(reason)`
/// on a hard provider failure (the caller surfaces it via `transforms:failed`).
///
/// Routing mirrors `runProcessText` in llm.ts exactly:
///   - Apple Intelligence → soft-fail to the original text (CLI is macOS-only;
///     this is a Windows app). NEVER errors.
///   - OpenRouter → OpenAI-compatible structured-output chat with fallback model.
///   - Ollama → the all-Rust streaming `/api/chat` path.
pub(super) async fn run_transform_provider(
    mgr: &Arc<LlmManager>,
    settings: &WinsttSettings,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
    effort: LlmEffort,
    model: &str,
) -> Result<String, String> {
    match settings.llm.transforms.base.provider {
        // Apple Intelligence is a soft-fail provider on Windows — paste the
        // original text rather than blocking the pipeline (mirrors
        // runAppleIntelligencePath's catch → return text).
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
            // OpenRouter's structured-output path already returns the fallback
            // text on a total failure (never throws across the boundary), so the
            // pipeline can paste-replace with the original on a dead provider.
            Ok(run_openrouter_with_fallback(
                mgr,
                &api_key,
                &selection,
                &fallback,
                system_prompt,
                user_prompt,
                text,
                openrouter_options(&settings.llm.transforms.base),
            )
            .await)
        }
        LlmProvider::Ollama => {
            let endpoint = settings.llm.endpoint.clone();
            let request_id = mgr.next_request_id();
            mgr.ollama_transform(
                &endpoint,
                model,
                system_prompt,
                user_prompt,
                text,
                effort,
                &request_id,
            )
            .await
        }
    }
}

/// Try the primary OpenRouter selection; on failure (and when a fallback is
/// configured), retry with the fallback model. On total failure, return the
/// original text. Mirrors `runOpenRouterWithFallback` (and llm.rs's copy).
#[allow(clippy::too_many_arguments)]
async fn run_openrouter_with_fallback(
    mgr: &Arc<LlmManager>,
    api_key: &str,
    primary: &str,
    fallback: &str,
    system_prompt: &str,
    user_prompt: &str,
    text: &str,
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
            None,
        )
        .await
    {
        Ok(answer) => answer,
        Err(_primary_err) if !fallback.is_empty() => mgr
            .openrouter_chat(
                api_key,
                fallback,
                system_prompt,
                user_prompt,
                text,
                options,
                None,
            )
            .await
            .unwrap_or_else(|_| text.to_string()),
        Err(_) => text.to_string(),
    }
}

/// Preview-specific OpenRouter routing. Unlike the runtime transform path, the
/// playground must surface provider failures instead of making them look like
/// "the model decided not to change anything".
#[allow(clippy::too_many_arguments)]
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
