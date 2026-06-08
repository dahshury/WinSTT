#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::settings::{get_settings, AppSettings, APPLE_INTELLIGENCE_PROVIDER_ID};
use crate::winstt::context::ContextMode;
use crate::winstt::llm::DictationSideEffects;
use crate::winstt::managers::{ContextManager, LlmManager};
use crate::winstt::settings_schema::{LlmProvider, RecordingMode, WinsttSettings};
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, warn};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tauri::Manager;

use super::LlmProcessingGuard;

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

/// Telemetry captured while the LLM post-processes a transcription, surfaced in
/// the history footer (model + how long it took + generation speed). `model` is
/// the configured model id (the renderer derives the maker logo from it);
/// `completion_tokens` is `None` when the provider didn't report `usage`.
pub(crate) struct PostProcessMeta {
    pub model: String,
    pub duration_ms: i64,
    pub completion_tokens: Option<i64>,
}

async fn post_process_transcription(
    app: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
) -> Option<(String, PostProcessMeta)> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            debug!("Post-processing skipped because no prompt is selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            debug!(
                "Post-processing skipped because prompt '{}' was not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );
    let _processing = LlmProcessingGuard::new(app);

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Disable reasoning for providers where post-processing rarely benefits from it.
    // - custom: top-level reasoning_effort (works for local OpenAI-compat servers)
    // - openrouter: nested reasoning object; exclude:true also keeps reasoning text
    //   out of the response so it can't pollute structured-output JSON parsing
    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(crate::llm_client::ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    // Wall-clock for the LLM round-trip — the footer's "processing time", and
    // the denominator for tokens/s. Started right before the request so it
    // excludes the (negligible) prompt assembly above.
    let started = Instant::now();
    let build_meta = |completion_tokens: Option<i64>| PostProcessMeta {
        model: model.clone(),
        duration_ms: started.elapsed().as_millis() as i64,
        completion_tokens,
    };

    if provider.supports_structured_output {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(&prompt);
        let user_content = transcription.to_string();

        // Handle Apple Intelligence separately since it uses native Swift APIs
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !apple_intelligence::check_apple_intelligence_availability() {
                    debug!(
                        "Apple Intelligence selected but not currently available on this device"
                    );
                    return None;
                }

                let token_limit = model.trim().parse::<i32>().unwrap_or(0);
                return match apple_intelligence::process_text_with_system_prompt(
                    &system_prompt,
                    &user_content,
                    token_limit,
                ) {
                    Ok(result) => {
                        if result.trim().is_empty() {
                            debug!("Apple Intelligence returned an empty response");
                            None
                        } else {
                            let result = strip_invisible_chars(&result);
                            debug!(
                                "Apple Intelligence post-processing succeeded. Output length: {} chars",
                                result.len()
                            );
                            // Apple Intelligence runs on-device via Swift APIs and
                            // exposes no token usage — report model + duration only.
                            Some((result, build_meta(None)))
                        }
                    }
                    Err(err) => {
                        error!("Apple Intelligence post-processing failed: {}", err);
                        None
                    }
                };
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                debug!("Apple Intelligence provider selected on unsupported platform");
                return None;
            }
        }

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            reasoning_effort.clone(),
            reasoning.clone(),
        )
        .await
        {
            Ok((Some(content), tokens)) => {
                // Parse the JSON response to extract the transcription field
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = strip_invisible_chars(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Some((result, build_meta(tokens)));
                        } else {
                            error!("Structured output response missing 'transcription' field");
                            return Some((strip_invisible_chars(&content), build_meta(tokens)));
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}. Returning raw content.",
                            e
                        );
                        return Some((strip_invisible_chars(&content), build_meta(tokens)));
                    }
                }
            }
            Ok((None, _)) => {
                error!("LLM API response has no content");
                return None;
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        reasoning_effort,
        reasoning,
    )
    .await
    {
        Ok((Some(content), tokens)) => {
            let content = strip_invisible_chars(&content);
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some((content, build_meta(tokens)))
        }
        Ok((None, _)) => {
            error!("LLM API response has no content");
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            None
        }
    }
}

fn dictation_llm_model(settings: &WinsttSettings) -> String {
    let base = &settings.llm.dictation.base;
    match base.provider {
        LlmProvider::Openrouter => base.openrouter_model.trim().to_string(),
        LlmProvider::AppleIntelligence | LlmProvider::Ollama => base.model.trim().to_string(),
    }
}

fn has_winstt_dictation_model(settings: &WinsttSettings) -> bool {
    let base = &settings.llm.dictation.base;
    match base.provider {
        LlmProvider::Openrouter => !settings.llm.openrouter_api_key.trim().is_empty(),
        LlmProvider::AppleIntelligence | LlmProvider::Ollama => !base.model.trim().is_empty(),
    }
}

fn should_run_winstt_dictation_llm(settings: &WinsttSettings) -> bool {
    settings.llm.dictation.enabled
        && settings.general.recording_mode != RecordingMode::Listen
        && has_winstt_dictation_model(settings)
}

pub(super) fn should_run_winstt_dictation_llm_from_app(app: &AppHandle) -> bool {
    let settings = crate::winstt::commands::settings::read_settings(app);
    should_run_winstt_dictation_llm(&settings)
}

fn capture_winstt_dictation_context(app: &AppHandle, settings: &WinsttSettings) -> String {
    if !settings.general.context_awareness {
        return String::new();
    }

    let Some(context) = app.try_state::<Arc<ContextManager>>() else {
        debug!("Context awareness is enabled but ContextManager is unavailable");
        return String::new();
    };

    context.capture_fragment(
        ContextMode::Tree,
        settings.general.context_app_mode,
        &settings.general.context_deny_list,
        &settings.general.context_allow_list,
    )
}

/// Returns `(cleaned_text, telemetry, dictionary_fixes)` where `dictionary_fixes`
/// is the count of deterministic replacement-pair substitutions applied by the
/// cleanup pass (persisted for the History "AI Impact" stat).
async fn process_winstt_dictation_llm(
    app: &AppHandle,
    settings: &WinsttSettings,
    transcription: &str,
) -> Option<(String, PostProcessMeta, i64, DictationSideEffects)> {
    let Some(llm_manager) = app.try_state::<Arc<LlmManager>>() else {
        warn!("Dictation LLM is enabled but LlmManager is unavailable");
        return None;
    };

    let context = capture_winstt_dictation_context(app, settings);
    let model = dictation_llm_model(settings);
    let started = Instant::now();

    match crate::winstt::commands::llm::process_dictation_text(
        app,
        llm_manager.inner().clone(),
        transcription.to_string(),
        context,
    )
    .await
    {
        Ok(result) => Some((
            result.text,
            PostProcessMeta {
                model,
                duration_ms: started.elapsed().as_millis() as i64,
                completion_tokens: None,
            },
            result.dictionary_fixes as i64,
            result.side_effects,
        )),
        Err(err) => {
            error!("Dictation LLM post-processing failed: {}", err);
            None
        }
    }
}

async fn maybe_convert_chinese_variant(
    selected_language: &str,
    transcription: &str,
) -> Option<String> {
    // Check if language is set to Simplified or Traditional Chinese. The language is sourced
    // from WinsttSettings.model.language (the single language store) by the caller — AppSettings
    // .selected_language is no longer written by the WinSTT renderer, so reading it here would
    // mean this zh-variant conversion never fired.
    let is_simplified = selected_language == "zh-Hans";
    let is_traditional = selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2tw
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

fn chinese_variant_language(model: &crate::winstt::settings_schema::ModelSettings) -> Option<&str> {
    if model.auto_detect_language || model.language_candidates.len() > 1 {
        return None;
    }
    model
        .language_candidates
        .first()
        .map(String::as_str)
        .or(Some(model.language.as_str()))
        .filter(|language| *language == "zh-Hans" || *language == "zh-Hant")
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    /// JSON telemetry of the LLM pass (`{model, processingMs, tokens}`), or
    /// `None` when no LLM ran (raw transcript, Chinese-variant convert, or
    /// snippet-only expansion). Persisted to `transcription_history.llm_meta`
    /// and reshaped into the history footer's model/duration/speed chips.
    pub llm_meta: Option<String>,
    /// Number of dictionary replacement-pair substitutions the dictation
    /// cleanup applied. `None` when no cleanup pass ran (so legacy/raw entries
    /// stay NULL rather than a misleading 0); persisted to
    /// `transcription_history.dictionary_fixes` for the "AI Impact" stat.
    pub dictionary_fixes: Option<i64>,
    /// Fixed LLM-classified history category, when available.
    pub history_tag: Option<String>,
    /// Fixed privacy marker categories. Raw sensitive values are never stored.
    pub privacy_markers: Vec<String>,
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    if transcription.trim().is_empty() {
        return ProcessedTranscription {
            final_text: String::new(),
            post_processed_text: None,
            post_process_prompt: None,
            post_process_requested: false,
            llm_meta: None,
            dictionary_fixes: None,
            history_tag: None,
            privacy_markers: Vec::new(),
        };
    }

    let settings = get_settings(app);
    let winstt_settings = crate::winstt::commands::settings::read_settings(app);
    let winstt_dictation_llm = should_run_winstt_dictation_llm(&winstt_settings);
    let post_process_requested = post_process || winstt_dictation_llm;
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;
    let mut llm_meta: Option<String> = None;
    let mut dictionary_fixes: Option<i64> = None;
    let mut history_tag: Option<String> = None;
    let mut privacy_markers: Vec<String> = Vec::new();

    // Source the language from the picker settings. In candidate mode, only a single selected
    // Chinese script variant is strong enough to run OpenCC; multi-candidate auto must not.
    if let Some(converted_text) = match chinese_variant_language(&winstt_settings.model) {
        Some(selected_language) => {
            maybe_convert_chinese_variant(selected_language, transcription).await
        }
        None => None,
    } {
        final_text = converted_text;
    }

    if winstt_dictation_llm {
        if let Some((processed_text, meta, dict_fixes, side_effects)) =
            process_winstt_dictation_llm(app, &winstt_settings, &final_text).await
        {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;
            dictionary_fixes = Some(dict_fixes);
            history_tag = side_effects.history_tag;
            privacy_markers = side_effects.privacy_markers;
            llm_meta = serde_json::to_string(&serde_json::json!({
                "model": meta.model,
                "processingMs": meta.duration_ms,
                "tokens": meta.completion_tokens,
                "learnedProperNounCount": side_effects.learned_proper_nouns.len(),
                "learnedSnippetCount": side_effects.learned_snippets.len(),
                "suggestedModifierCount": side_effects.suggested_modifier_presets.len(),
            }))
            .ok();
        }
    } else if post_process {
        if let Some((processed_text, meta)) =
            post_process_transcription(app, &settings, &final_text).await
        {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;
            // Stash the model/timing/tokens for the history footer. `tokens`
            // serializes to null when the provider reported no usage.
            llm_meta = serde_json::to_string(&serde_json::json!({
                "model": meta.model,
                "processingMs": meta.duration_ms,
                "tokens": meta.completion_tokens,
            }))
            .ok();

            if let Some(prompt_id) = &settings.post_process_selected_prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| &prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    }

    if post_processed_text.is_none() && final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    // WinSTT snippet expansion: deterministic fuzzy trigger→expansion on the finalized
    // text — the LAST step before paste (mirrors applyPostProcessing's replaceWithSnippets,
    // after dictionary correction). Uses the warm in-memory cache; no-op when no snippets.
    if let Some(snippets) = app.try_state::<Arc<crate::winstt::snippets::SnippetsManager>>() {
        let expanded = snippets.expand_cached(&final_text);
        if expanded != final_text {
            final_text = expanded;
            post_processed_text = Some(final_text.clone());
        }
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
        post_process_requested,
        llm_meta,
        dictionary_fixes,
        history_tag,
        privacy_markers,
    }
}
