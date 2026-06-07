//! genai-backed cloud LLM transport, shared by the two cloud code paths:
//!   - `crate::llm_client` — the multi-provider post-processing path in
//!     `actions.rs` (OpenAI / Z.AI / OpenRouter / Anthropic / Groq / Cerebras /
//!     AWS Bedrock-Mantle / Custom).
//!   - `winstt::managers::llm_manager::openrouter_chat` — the dictation /
//!     transform path (OpenRouter only, now STREAMED so reasoning deltas reach
//!     the pill).
//!
//! Local Ollama is intentionally NOT routed here. genai's Ollama adapter speaks
//! only `/api/chat`, `/api/embed`, `/api/tags`, hard-codes `format:"json"`, and
//! does not merge `extra_body`, so it cannot express the native `format`
//! side-channel schema, `keep_alive`, the `think` knob, warmup/unload, or
//! `/api/show`/`/api/pull`/`/api/delete`. The native REST client in
//! `winstt::ollama_client` therefore stays authoritative for the local path.
//!
//! Provider → adapter mapping: `anthropic` uses genai's NATIVE Anthropic
//! Messages API (`/v1/messages`, with `x-api-key` + `anthropic-version` and a
//! model-derived `max_tokens` supplied automatically); every other provider
//! uses the OpenAI-compatible adapter pointed at its own `base_url`.

use std::sync::OnceLock;

use genai::adapter::AdapterKind;
use genai::chat::{ChatOptions, ChatRequest, ChatStreamEvent};
use genai::resolver::{AuthData, Endpoint};
use genai::{Client, ModelIden, ServiceTarget};
use tokio_util::sync::CancellationToken;

/// Returned by [`run_chat_stream`] when the caller's [`CancellationToken`] fired
/// before the stream finished. The genai stream is dropped at that point, which
/// aborts the in-flight HTTP request.
pub const CANCELLED: &str = "winstt:cloud-llm-cancelled";

/// Process-wide genai client. The default client carries no provider config of
/// its own — every call passes a fully-resolved [`ServiceTarget`], so one shared
/// client serves all providers. Cheap to clone internally; we hand out a `&'static`.
fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(Client::default)
}

/// Map a WinSTT `PostProcessProvider` id to a genai adapter. Anthropic is the
/// only provider that gets its native protocol; all OpenAI-compatible providers
/// (incl. OpenRouter, Groq, Z.AI, Cerebras, Bedrock-Mantle, Custom) share the
/// OpenAI adapter pointed at their own `base_url` — byte-for-byte the same wire
/// shape the hand-rolled client produced.
pub fn adapter_kind_for(provider_id: &str) -> AdapterKind {
    match provider_id {
        "anthropic" => AdapterKind::Anthropic,
        _ => AdapterKind::OpenAI,
    }
}

/// Ensure the base URL ends with a single `/`. The OpenAI adapter composes the
/// chat URL with `reqwest::Url::parse(base).join("chat/completions")`, and
/// `Url::join` REPLACES the last path segment when the base lacks a trailing
/// slash (e.g. `…/v1` + `chat/completions` → `…/chat/completions`, dropping
/// `v1`). The Anthropic adapter uses `format!("{base}messages")`. Both require
/// the trailing slash, so we normalize here.
fn normalize_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim();
    if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    }
}

/// Build a fully-resolved [`ServiceTarget`] (endpoint + auth + model) so genai
/// bypasses model-name inference and env-var auth and uses exactly these values.
/// An empty `api_key` still yields `AuthData::Key("")` (the OpenAI adapter sends
/// `Authorization: Bearer `, which local OpenAI-compatible servers ignore) — this
/// matches the old client's "no key required for custom" behavior.
pub fn service_target(adapter: AdapterKind, base_url: &str, api_key: &str, model: &str) -> ServiceTarget {
    ServiceTarget {
        endpoint: Endpoint::from_owned(normalize_base_url(base_url)),
        auth: AuthData::from_single(api_key.to_string()),
        model: ModelIden::new(adapter, model.to_string()),
    }
}

/// Non-streamed chat. Returns `(content, completion_tokens)` mirroring the old
/// `send_chat_completion_with_schema` contract: `content` is `None` when the
/// response carried no text; `completion_tokens` is the provider-reported output
/// token count (absent → `None`). `Err` on transport / HTTP / decode failure so
/// callers can fall through (e.g. structured → legacy in `actions.rs`).
pub async fn run_chat(
    target: ServiceTarget,
    request: ChatRequest,
    options: ChatOptions,
) -> Result<(Option<String>, Option<i64>), String> {
    let resp = client()
        .exec_chat(target, request, Some(&options))
        .await
        .map_err(|e| e.to_string())?;
    let tokens = resp.usage.completion_tokens.map(i64::from);
    let content = resp.into_first_text();
    Ok((content, tokens))
}

/// Streamed chat. Accumulates assistant text chunks into the returned `String`,
/// forwards each reasoning/thinking delta to `on_reasoning` (drives the
/// `llm-reasoning-delta` pill), and reports captured output tokens from the
/// stream-end usage. Requires `options.with_capture_usage(true)` for the token
/// count to be populated.
///
/// `cancel` aborts the request mid-flight: both the initial connect and every
/// inter-chunk wait are `select!`ed against `cancel.cancelled()`, so a cancel
/// (per-id or `cancel_all`, e.g. from the overlay X / model swap) returns
/// [`CANCELLED`] and drops the genai stream — which tears down the underlying
/// HTTP request. Pass an un-cancelled `CancellationToken::new()` for no-cancel.
pub async fn run_chat_stream(
    target: ServiceTarget,
    request: ChatRequest,
    options: ChatOptions,
    cancel: CancellationToken,
    mut on_reasoning: impl FnMut(&str),
) -> Result<(String, Option<i64>), String> {
    use futures_util::StreamExt;

    let mut resp = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(CANCELLED.to_string()),
        res = client().exec_chat_stream(target, request, Some(&options)) => {
            res.map_err(|e| e.to_string())?
        }
    };

    let mut content = String::new();
    let mut tokens: Option<i64> = None;
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(CANCELLED.to_string()),
            event = resp.stream.next() => {
                let Some(event) = event else { break };
                match event.map_err(|e| e.to_string())? {
                    ChatStreamEvent::Chunk(chunk) => content.push_str(&chunk.content),
                    ChatStreamEvent::ReasoningChunk(chunk) => on_reasoning(&chunk.content),
                    ChatStreamEvent::End(end) => {
                        if let Some(usage) = end.captured_usage {
                            tokens = usage.completion_tokens.map(i64::from);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok((content, tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_maps_to_native_adapter() {
        assert!(matches!(adapter_kind_for("anthropic"), AdapterKind::Anthropic));
    }

    #[test]
    fn other_providers_map_to_openai_compat() {
        for id in ["openai", "openrouter", "groq", "zai", "cerebras", "bedrock_mantle", "custom"] {
            assert!(
                matches!(adapter_kind_for(id), AdapterKind::OpenAI),
                "provider {id} should use the OpenAI-compat adapter"
            );
        }
    }

    #[test]
    fn base_url_gets_one_trailing_slash() {
        // Missing slash → appended (so Url::join keeps the /v1 segment).
        assert_eq!(normalize_base_url("https://api.openai.com/v1"), "https://api.openai.com/v1/");
        // Already-slashed → unchanged (no double slash).
        assert_eq!(normalize_base_url("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/");
        // Whitespace trimmed.
        assert_eq!(normalize_base_url("  https://api.z.ai/api/paas/v4  "), "https://api.z.ai/api/paas/v4/");
    }
}
