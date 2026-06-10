//! Multi-provider cloud LLM post-processing transport.
//!
//! The chat calls (`send_chat_completion` / `send_chat_completion_with_schema`)
//! now run on the shared genai-backed transport in [`crate::cloud_llm`]; this
//! module keeps the exact public signatures the `actions.rs` post-processing
//! path depends on, so its call sites are unchanged. Model listing
//! (`fetch_models`) stays a direct reqwest GET — genai only exposes an ids-only
//! listing on a separate path and we want the same `{data:[{id}]}` / bare-array
//! parsing as before.
//!
//! Reasoning is honored per provider exactly as before: `reasoning_effort` is
//! the OpenAI-style top-level keyword (used for `custom`); [`ReasoningConfig`]
//! is the OpenRouter-style nested `reasoning { effort, exclude }` object.

use crate::settings::PostProcessProvider;
use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, REFERER, USER_AGENT};
use serde_json::Value;

/// OpenRouter-style nested reasoning config (`reasoning: { effort, exclude }`).
/// Built by the caller (`actions.rs`) and forwarded into the request's
/// provider-specific extra body. `exclude: true` also keeps reasoning text out
/// of the response so it can't pollute structured-output JSON parsing.
#[derive(Debug, Clone, Default)]
pub struct ReasoningConfig {
    pub effort: Option<String>,
    pub exclude: Option<bool>,
}

/// Build headers for the model-listing GET. Chat auth/headers are handled by the
/// genai adapter (incl. Anthropic's `x-api-key` + `anthropic-version`); this is
/// used only by [`fetch_models`].
fn build_headers(provider: &PostProcessProvider, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    // Common headers
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://github.com/winstt/WinSTT"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("WinSTT/1.0 (+https://github.com/winstt/WinSTT)"),
    );
    headers.insert("X-Title", HeaderValue::from_static("WinSTT"));

    // Provider-specific auth headers
    if !api_key.is_empty() {
        if provider.id == "anthropic" {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|e| format!("Invalid API key header value: {}", e))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| format!("Invalid authorization header value: {}", e))?,
            );
        }
    }

    Ok(headers)
}

/// Create an HTTP client with provider-specific headers (for [`fetch_models`]).
fn create_client(provider: &PostProcessProvider, api_key: &str) -> Result<reqwest::Client, String> {
    let headers = build_headers(provider, api_key)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Send a chat completion request to the configured provider.
/// Returns `Ok((content, completion_tokens))` — `content` is `Some` on success
/// / `None` when the response has no content; `completion_tokens` is the output
/// token count when the provider reported usage (else `None`). `Err` on actual
/// errors (transport, HTTP, parsing, etc.).
pub async fn send_chat_completion(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    prompt: String,
    reasoning_effort: Option<String>,
    reasoning: Option<ReasoningConfig>,
) -> Result<(Option<String>, Option<i64>), String> {
    send_chat_completion_with_schema(
        provider,
        api_key,
        model,
        prompt,
        None,
        None,
        reasoning_effort,
        reasoning,
    )
    .await
}

/// Send a chat completion request with optional structured-output support.
/// When `json_schema` is provided, the request asks for a strict json_schema
/// structured output (`name: "transcription_output"`); `system_prompt` becomes
/// the system message when provided. `reasoning_effort` sets the OpenAI-style
/// top-level field (e.g. "none"); `reasoning` sets the OpenRouter-style nested
/// object (effort + exclude).
///
/// Anthropic runs over genai's native Messages API; every other provider over
/// the OpenAI-compatible adapter pointed at its own `base_url`.
#[expect(
    clippy::too_many_arguments,
    reason = "LLM request builder mirrors the provider API surface"
)]
pub async fn send_chat_completion_with_schema(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    user_content: String,
    system_prompt: Option<String>,
    json_schema: Option<Value>,
    reasoning_effort: Option<String>,
    reasoning: Option<ReasoningConfig>,
) -> Result<(Option<String>, Option<i64>), String> {
    use genai::chat::{ChatMessage, ChatOptions, ChatRequest, JsonSpec, ReasoningEffort};

    debug!(
        "Sending chat completion via genai to provider '{}' (model '{}')",
        provider.id, model
    );

    let adapter = crate::cloud_llm::adapter_kind_for(&provider.id);
    let target = crate::cloud_llm::service_target(adapter, &provider.base_url, &api_key, model);

    let mut request = ChatRequest::new(vec![ChatMessage::user(user_content)]);
    if let Some(system) = system_prompt {
        request = request.with_system(system);
    }

    let mut options = ChatOptions::default();
    if let Some(schema) = json_schema {
        options = options.with_response_format(JsonSpec::new("transcription_output", schema));
    }
    // OpenAI-style top-level reasoning_effort (e.g. "none" for custom servers).
    if let Some(effort) = reasoning_effort.as_deref() {
        if let Some(parsed) = ReasoningEffort::from_keyword(effort) {
            options = options.with_reasoning_effort(parsed);
        }
    }
    // OpenRouter-style nested reasoning object, merged into the request body.
    if let Some(rc) = reasoning {
        if let Some(extra) = openrouter_reasoning_extra_body(&rc) {
            options = options.with_extra_body(extra);
        }
    }

    crate::cloud_llm::run_chat(target, request, options).await
}

/// Build the `{ "reasoning": { effort?, exclude? } }` extra-body object for the
/// OpenRouter-style nested reasoning control. Returns `None` when neither field
/// is set (so no `reasoning` key is sent).
fn openrouter_reasoning_extra_body(rc: &ReasoningConfig) -> Option<Value> {
    let mut obj = serde_json::Map::new();
    if let Some(effort) = &rc.effort {
        obj.insert("effort".to_string(), Value::String(effort.clone()));
    }
    if let Some(exclude) = rc.exclude {
        obj.insert("exclude".to_string(), Value::Bool(exclude));
    }
    if obj.is_empty() {
        None
    } else {
        Some(serde_json::json!({ "reasoning": Value::Object(obj) }))
    }
}

/// Fetch available models from an OpenAI-compatible API.
/// Returns a list of model IDs.
pub async fn fetch_models(
    provider: &PostProcessProvider,
    api_key: String,
) -> Result<Vec<String>, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/models", base_url);

    debug!("Fetching models from: {}", url);

    let client = create_client(provider, &api_key)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!(
            "Model list request failed ({}): {}",
            status, error_text
        ));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = Vec::new();

    // Handle OpenAI format: { data: [ { id: "..." }, ... ] }
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for entry in data {
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            } else if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    // Handle array format: [ "model1", "model2", ... ]
    else if let Some(array) = parsed.as_array() {
        for entry in array {
            if let Some(model) = entry.as_str() {
                models.push(model.to_string());
            }
        }
    }

    Ok(models)
}
