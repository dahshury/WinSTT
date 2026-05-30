// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_llm_cloud_context_longtail.md §1,
// frontend/electron/ipc/llm.ts + ollama.ts. Wraps winstt::llm (pure prompt/leakage logic).
//
// LlmManager owns the reqwest client, the Ollama `/api/show` capability cache,
// in-flight chat cancel tokens, and the dictation/transform compose entry points.
// The pure prompt composition + CoT-leakage/salvage + Ollama body builders all
// live in `winstt::llm`; this manager is the stateful, async, app-aware shell.
//
// Connection values (endpoint / api key) are read from the persisted settings via
// `settings::get_settings` at call time so a key change takes effect with no restart
// (hot-swap path). The model warm-up loop (`keep_alive=30m`) keeps Ollama hot.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::winstt::llm::{
    self, build_ollama_api_url, build_ollama_chat_body, dictation_user_prompt, finalize_chat_answer,
    parse_chat_stream_line, transforms_user_prompt, OllamaStreamState, ReasoningSink, ThinkingEffort,
};

/// One Ollama model's capabilities (from `/api/show`). Cached so the per-dictation
/// path doesn't re-probe whether the model can `think` on every request.
#[derive(Clone, Debug, Default)]
pub struct OllamaCapabilities {
    pub supports_thinking: bool,
    pub context_length: Option<u64>,
}

/// Thin emit sink that forwards live reasoning deltas to the renderer pill.
/// Mirrors the `llm-reasoning-delta` plain-string event (07_* §4b).
struct EmitReasoningSink {
    app: AppHandle,
    request_id: String,
}

impl llm::ReasoningSink for EmitReasoningSink {
    fn on_delta(&self, delta: &str) {
        let _ = self.app.emit(
            "llm-reasoning-delta",
            serde_json::json!({ "requestId": self.request_id, "delta": delta }),
        );
    }
}

/// All-Rust LLM post-processing manager.
pub struct LlmManager {
    app: AppHandle,
    client: reqwest::Client,
    /// `/api/show` capability cache keyed by Ollama model id.
    caps_cache: Mutex<HashMap<String, OllamaCapabilities>>,
    /// Cancelled request ids — the Ollama drain loop checks this between chunks.
    cancelled: Mutex<HashMap<String, bool>>,
    /// Monotonic request-id source for fire-and-emit calls without a renderer id.
    seq: AtomicU64,
}

impl LlmManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            client: reqwest::Client::new(),
            caps_cache: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("llm-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Mark a request cancelled (a model swap / new dictation aborts the prior).
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancelled.lock() {
            map.insert(request_id.to_string(), true);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut map) = self.cancelled.lock() {
            for v in map.values_mut() {
                *v = true;
            }
        }
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|m| m.get(request_id).copied().unwrap_or(false))
            .unwrap_or(false)
    }

    fn clear_cancel(&self, request_id: &str) {
        if let Ok(mut map) = self.cancelled.lock() {
            map.remove(request_id);
        }
    }

    // ── Ollama capability probe (`/api/show`) ──────────────────────────────

    /// Probe `/api/show` for a model's capabilities, caching the result.
    /// `endpoint` is the user's Ollama base URL.
    pub async fn ollama_capabilities(
        &self,
        endpoint: &str,
        model: &str,
    ) -> Result<OllamaCapabilities, String> {
        if let Some(hit) = self
            .caps_cache
            .lock()
            .ok()
            .and_then(|m| m.get(model).cloned())
        {
            return Ok(hit);
        }
        let url = build_ollama_api_url(endpoint, "/api/show");
        let resp = self
            .client
            .post(url)
            .json(&serde_json::json!({ "model": model }))
            .send()
            .await
            .map_err(|e| format!("Ollama /api/show failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama /api/show HTTP {}", resp.status().as_u16()));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Ollama /api/show parse: {e}"))?;
        let caps = parse_ollama_show(&json);
        if let Ok(mut m) = self.caps_cache.lock() {
            m.insert(model.to_string(), caps.clone());
        }
        Ok(caps)
    }

    // ── dictation / transform compose ──────────────────────────────────────

    /// Compose the dictation cleanup over Ollama. `system_prompt` is built by the
    /// caller via `winstt::llm::build_dictation_system_prompt` (so context + vocab
    /// are folded in once). Streams reasoning deltas + returns the final answer.
    pub async fn ollama_dictation(
        &self,
        endpoint: &str,
        model: &str,
        system_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        request_id: &str,
    ) -> Result<String, String> {
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let body = build_ollama_chat_body(
            model,
            system_prompt,
            &dictation_user_prompt(text),
            text.len(),
            caps.supports_thinking,
            effort,
        );
        self.stream_ollama_chat(endpoint, body, text, request_id)
            .await
    }

    /// Run a transform-on-selection over Ollama (system prompt is the transform's
    /// own preset body; no context/vocab folding).
    pub async fn ollama_transform(
        &self,
        endpoint: &str,
        model: &str,
        system_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        request_id: &str,
    ) -> Result<String, String> {
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let body = build_ollama_chat_body(
            model,
            system_prompt,
            &transforms_user_prompt(text),
            text.len(),
            caps.supports_thinking,
            effort,
        );
        self.stream_ollama_chat(endpoint, body, text, request_id)
            .await
    }

    /// POST `/api/chat` (stream=true), drain NDJSON, fold via OllamaStreamState,
    /// emit reasoning deltas, finalize the answer. `fallback` is the original text.
    async fn stream_ollama_chat(
        &self,
        endpoint: &str,
        body: serde_json::Value,
        fallback: &str,
        request_id: &str,
    ) -> Result<String, String> {
        use futures_util::StreamExt;

        let url = build_ollama_api_url(endpoint, "/api/chat");
        let resp = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama POST failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama HTTP {status}: {t}"));
        }

        let sink = EmitReasoningSink {
            app: self.app.clone(),
            request_id: request_id.to_string(),
        };
        let mut state = OllamaStreamState::default();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if self.is_cancelled(request_id) {
                break;
            }
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                if let Some(c) = parse_chat_stream_line(&line) {
                    let deltas = state.apply_chunk(&c);
                    if let Some(t) = deltas.thinking {
                        sink.on_delta(&t);
                    }
                }
            }
        }
        if let Some(c) = parse_chat_stream_line(&buf) {
            state.apply_chunk(&c);
        }
        self.clear_cancel(request_id);

        if let Some(err) = state.error {
            return Err(format!("Ollama stream error: {err}"));
        }
        let (answer, reasoning) = finalize_chat_answer(&state.content, fallback);
        if let Some(r) = reasoning {
            if !r.is_empty() {
                let _ = self.app.emit(
                    "llm-reasoning-delta",
                    serde_json::json!({ "requestId": request_id, "delta": r }),
                );
            }
        }
        Ok(answer)
    }

    /// List local Ollama models (`/api/tags`). Returns the raw model ids.
    pub async fn ollama_list_models(&self, endpoint: &str) -> Result<Vec<String>, String> {
        let url = build_ollama_api_url(endpoint, "/api/tags");
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Ollama /api/tags failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama /api/tags HTTP {}", resp.status().as_u16()));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Ollama /api/tags parse: {e}"))?;
        let models = json
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }

    /// True iff an Ollama server answers at the endpoint (`GET /` returns 200).
    pub async fn ollama_detect(&self, endpoint: &str) -> bool {
        let url = build_ollama_api_url(endpoint, "/api/version");
        self.client
            .get(url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

/// Parse `/api/show` JSON into capabilities. Ollama exposes a `capabilities`
/// array (containing `"thinking"` for reasoning models) and a flattened
/// `model_info` with `*.context_length`.
fn parse_ollama_show(json: &serde_json::Value) -> OllamaCapabilities {
    let supports_thinking = json
        .get("capabilities")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().any(|v| v.as_str() == Some("thinking")))
        .unwrap_or(false);
    let context_length = json
        .get("model_info")
        .and_then(|mi| mi.as_object())
        .and_then(|obj| {
            obj.iter()
                .find(|(k, _)| k.ends_with(".context_length"))
                .and_then(|(_, v)| v.as_u64())
        });
    OllamaCapabilities {
        supports_thinking,
        context_length,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_show_detects_thinking_and_ctx() {
        let json = serde_json::json!({
            "capabilities": ["completion", "thinking"],
            "model_info": { "qwen3.context_length": 32768u64 }
        });
        let caps = parse_ollama_show(&json);
        assert!(caps.supports_thinking);
        assert_eq!(caps.context_length, Some(32768));
    }

    #[test]
    fn parse_show_non_thinking_model() {
        let json = serde_json::json!({ "capabilities": ["completion"] });
        let caps = parse_ollama_show(&json);
        assert!(!caps.supports_thinking);
        assert_eq!(caps.context_length, None);
    }
}
