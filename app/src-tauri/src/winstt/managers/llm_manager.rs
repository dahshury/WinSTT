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
        // Surface any learned proper nouns the model emitted in the structured
        // envelope to the dictionary auto-add UI (mirrors broadcastLearnedProperNouns
        // → `llm-learned-proper-nouns`). Empty batches are dropped.
        let nouns = llm::extract_learned_proper_nouns(&state.content);
        if !nouns.is_empty() {
            let _ = self
                .app
                .emit("llm-learned-proper-nouns", serde_json::json!({ "nouns": nouns }));
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

    /// True iff an Ollama server answers at the endpoint (`GET /api/version`).
    pub async fn ollama_detect(&self, endpoint: &str) -> bool {
        let url = build_ollama_api_url(endpoint, "/api/version");
        self.client
            .get(url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// List local Ollama models (`/api/tags`) as full detail rows (name + size +
    /// modifiedAt + details + enriched capabilities). Mirrors `scanOllamaModels`
    /// in the Electron handler: parse `/api/tags`, then per-model `/api/show` to
    /// fill `capabilities`. A single `/api/show` failure leaves that model's caps
    /// empty rather than poisoning the list.
    pub async fn ollama_list_models_detailed(
        &self,
        endpoint: &str,
    ) -> Result<Vec<OllamaModelInfo>, String> {
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
        let mut models = parse_ollama_tags(&json);
        // Enrich each model with its `/api/show` capability set. Concurrency is
        // fine to keep sequential here — the local daemon answers from metadata
        // cache and the model count is tiny.
        for m in &mut models {
            if let Ok(caps) = self.ollama_capabilities(endpoint, &m.name).await {
                if caps.supports_thinking {
                    // The renderer only consumes a small capability vocabulary;
                    // surface "thinking" so reasoning badges + think-gating work.
                    m.capabilities = Some(vec!["thinking".to_string()]);
                }
            }
        }
        Ok(models)
    }

    /// Delete a local Ollama model (`DELETE /api/delete { model }`). Returns
    /// `(success, error)`. Mirrors `deleteOllamaModel`.
    pub async fn ollama_delete(&self, endpoint: &str, model: &str) -> (bool, Option<String>) {
        let url = build_ollama_api_url(endpoint, "/api/delete");
        match self
            .client
            .delete(url)
            .json(&serde_json::json!({ "model": model }))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => (true, None),
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                (
                    false,
                    Some(format!("Ollama /api/delete HTTP {status}: {body}")),
                )
            }
            Err(e) => (false, Some(format!("Ollama /api/delete failed: {e}"))),
        }
    }

    /// Stream a model pull (`POST /api/pull`, stream=true), emitting
    /// `llm:pull-progress` for every coalesced NDJSON frame (broadcast to all
    /// windows via `self.app`). `is_cancelled` is polled between frames so the
    /// renderer's stop button aborts mid-stream. Mirrors `pullOllamaModel` +
    /// `readPullStream` in the Electron handler.
    ///
    /// Returns `PullOutcome` so the command can build the `OllamaPullResult`.
    /// (Emit is done internally rather than via a callback so the future stays
    /// `Send` for the Tauri command runtime — a `&dyn Fn` arg held across an
    /// `.await` would not be.)
    pub async fn ollama_pull_stream<F>(
        &self,
        endpoint: &str,
        model: &str,
        is_cancelled: F,
    ) -> PullOutcome
    where
        F: Fn() -> bool,
    {
        use futures_util::StreamExt;

        let url = build_ollama_api_url(endpoint, "/api/pull");
        let resp = match self
            .client
            .post(url)
            .json(&serde_json::json!({ "model": model, "stream": true, "insecure": false }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("Ollama /api/pull failed: {e}");
                self.emit_pull(pull_progress_json(model, "error", None, None, None, None, Some(&msg)));
                return PullOutcome::Error(msg);
            }
        };
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let msg = format!("Ollama /api/pull HTTP {status}: {body}");
            self.emit_pull(pull_progress_json(model, "error", None, None, None, None, Some(&msg)));
            return PullOutcome::Error(msg);
        }

        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        let mut success = false;
        let mut last_error: Option<String> = None;

        loop {
            if is_cancelled() {
                return PullOutcome::Cancelled;
            }
            let next = stream.next().await;
            let Some(chunk) = next else { break };
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    let msg = format!("Ollama /api/pull stream error: {e}");
                    self.emit_pull(pull_progress_json(
                        model, "error", None, None, None, None, Some(&msg),
                    ));
                    return PullOutcome::Error(msg);
                }
            };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some((status, payload)) = parse_pull_line(model, trimmed) {
                    if status == "success" {
                        success = true;
                    }
                    if let Some(err) = payload
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                    {
                        last_error = Some(err);
                    }
                    self.emit_pull(payload);
                }
            }
            if is_cancelled() {
                return PullOutcome::Cancelled;
            }
        }
        // Drain any trailing partial frame.
        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            if let Some((status, payload)) = parse_pull_line(model, trimmed) {
                if status == "success" {
                    success = true;
                }
                self.emit_pull(payload);
            }
        }

        if success {
            PullOutcome::Success
        } else {
            let msg = last_error.unwrap_or_else(|| "Pull did not complete successfully".to_string());
            self.emit_pull(pull_progress_json(model, "error", None, None, None, None, Some(&msg)));
            PullOutcome::Error(msg)
        }
    }

    /// Broadcast one `llm:pull-progress` frame to every renderer.
    fn emit_pull(&self, payload: serde_json::Value) {
        let _ = self.app.emit("llm:pull-progress", payload);
    }

    /// Run a dictation/transform over OpenRouter's OpenAI-compatible
    /// `/api/v1/chat/completions`. `api_key` is the stored OpenRouter key,
    /// `selection` is the `model[::providerSlug]` picker value (`""` → auto).
    /// Requests a `{ "text": "..." }` JSON object via `response_format` so the
    /// answer is plain transformed text, then extracts the `text` field.
    /// Mirrors `processWithOpenRouter` (structured output via generateObject).
    /// Returns the cleaned text, or the fallback on any failure.
    pub async fn openrouter_chat(
        &self,
        api_key: &str,
        selection: &str,
        system_prompt: &str,
        user_prompt: &str,
        fallback: &str,
    ) -> Result<String, String> {
        if api_key.is_empty() {
            return Err("OpenRouter API key is required".to_string());
        }
        let (model_id, provider_slug) = llm::parse_model_selection(selection);
        let model = if model_id.is_empty() {
            "openrouter/auto".to_string()
        } else {
            model_id
        };

        let mut body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt },
            ],
            "temperature": 0.3,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "TransformedText",
                    "strict": true,
                    "schema": {
                        "type": "object",
                        "properties": { "text": { "type": "string" } },
                        "required": ["text"],
                        "additionalProperties": false
                    }
                }
            }
        });
        // Provider routing + response-healing plugin (mirrors buildModelOptions +
        // OPENROUTER_DICTATION_PROVIDER_OPTIONS).
        if let serde_json::Value::Object(ref mut map) = body {
            let extra = llm::openrouter_extra_body(provider_slug.as_deref());
            if let Some(plugins) = extra.get("plugins") {
                map.insert("plugins".to_string(), plugins.clone());
            }
            if let Some(provider) = extra.get("provider") {
                map.insert("provider".to_string(), provider.clone());
            }
        }

        let resp = self
            .client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .bearer_auth(api_key)
            .header("HTTP-Referer", "https://github.com/dahshury/winstt")
            .header("X-Title", "WinSTT")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenRouter POST failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("OpenRouter HTTP {status}: {t}"));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("OpenRouter parse: {e}"))?;
        let content = json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        Ok(extract_openrouter_text(content, fallback))
    }

    /// Scan the OpenRouter catalog (`GET /api/v1/models`) with the stored key.
    /// Returns `(reachable, models, error)`. Models carry id/name/description/
    /// context_length/pricing/maker/model_name/variant/architecture/
    /// supported_parameters so the picker rows render. Per-model `/endpoints`
    /// enrichment is skipped for v1 (the renderer falls back to the base list);
    /// see the TODO below.
    pub async fn scan_openrouter(&self, api_key: &str) -> OpenRouterScan {
        let mut rb = self
            .client
            .get("https://openrouter.ai/api/v1/models")
            .timeout(std::time::Duration::from_secs(15))
            .header("HTTP-Referer", "https://github.com/dahshury/winstt")
            .header("X-Title", "WinSTT");
        if !api_key.is_empty() {
            rb = rb.bearer_auth(api_key);
        }
        let resp = match rb.send().await {
            Ok(r) => r,
            Err(e) => {
                return OpenRouterScan {
                    reachable: false,
                    models: Vec::new(),
                    error: Some(format!("OpenRouter unreachable: {e}")),
                };
            }
        };
        if !resp.status().is_success() {
            return OpenRouterScan {
                reachable: true,
                models: Vec::new(),
                error: Some(format!(
                    "OpenRouter /models returned HTTP {}",
                    resp.status().as_u16()
                )),
            };
        }
        let json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(e) => {
                return OpenRouterScan {
                    reachable: true,
                    models: Vec::new(),
                    error: Some(format!("OpenRouter parse: {e}")),
                };
            }
        };
        OpenRouterScan {
            reachable: true,
            models: parse_openrouter_models(&json),
            error: None,
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

/// Outcome of a streaming pull (drives the command's `OllamaPullResult`).
pub enum PullOutcome {
    Success,
    Cancelled,
    Error(String),
}

/// One Ollama model row as parsed from `/api/tags` (+ enriched capabilities).
/// Field names mirror the spec `OllamaModel` so serde camelCase serialization
/// matches the renderer's `OllamaScanResult.models[]`.
#[derive(Clone, Debug, Default)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size: Option<i64>,
    pub modified_at: Option<String>,
    pub details: Option<OllamaModelDetails>,
    pub capabilities: Option<Vec<String>>,
}

/// Per-model detail metadata (`/api/tags` `details` object). Mirrors the spec
/// `OllamaModelDetails`.
#[derive(Clone, Debug, Default)]
pub struct OllamaModelDetails {
    pub format: Option<String>,
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

/// One OpenRouter catalog model (the subset the picker rows consume).
#[derive(Clone, Debug, Default)]
pub struct OpenRouterModelInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub context_length: Option<i64>,
    pub pricing: Option<serde_json::Value>,
    pub provider: Option<String>,
    pub maker: Option<String>,
    pub model_name: Option<String>,
    pub variant: Option<String>,
    pub architecture: Option<serde_json::Value>,
    pub supported_parameters: Option<Vec<String>>,
}

pub struct OpenRouterScan {
    pub reachable: bool,
    pub models: Vec<OpenRouterModelInfo>,
    pub error: Option<String>,
}

/// Parse the `/api/tags` JSON into detail rows.
fn parse_ollama_tags(json: &serde_json::Value) -> Vec<OllamaModelInfo> {
    json.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().filter_map(parse_ollama_tags_model).collect())
        .unwrap_or_default()
}

fn parse_ollama_tags_model(m: &serde_json::Value) -> Option<OllamaModelInfo> {
    let name = m.get("name").and_then(|n| n.as_str())?.to_string();
    let size = m.get("size").and_then(serde_json::Value::as_i64);
    let modified_at = m
        .get("modified_at")
        .or_else(|| m.get("modifiedAt"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let details = m.get("details").and_then(parse_ollama_details);
    Some(OllamaModelInfo {
        name,
        size,
        modified_at,
        details,
        capabilities: None,
    })
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn parse_ollama_details(d: &serde_json::Value) -> Option<OllamaModelDetails> {
    let families = d.get("families").and_then(|f| f.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect::<Vec<_>>()
    });
    let out = OllamaModelDetails {
        format: str_field(d, "format"),
        family: str_field(d, "family"),
        families,
        parameter_size: str_field(d, "parameter_size"),
        quantization_level: str_field(d, "quantization_level"),
    };
    let any = out.format.is_some()
        || out.family.is_some()
        || out.families.is_some()
        || out.parameter_size.is_some()
        || out.quantization_level.is_some();
    if any {
        Some(out)
    } else {
        None
    }
}

/// Parse the OpenRouter `/api/v1/models` payload into picker rows. Mirrors
/// `enrichOpenRouterModel` (maker/model_name/variant split off the id).
fn parse_openrouter_models(json: &serde_json::Value) -> Vec<OpenRouterModelInfo> {
    json.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(parse_openrouter_model).collect())
        .unwrap_or_default()
}

const OPENROUTER_VARIANTS: [&str; 7] = [
    "free", "extended", "exacto", "nitro", "floor", "thinking", "online",
];

fn parse_openrouter_model(m: &serde_json::Value) -> Option<OpenRouterModelInfo> {
    let id = m.get("id").and_then(|v| v.as_str())?.to_string();
    let name = m
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let (maker, model_name, variant) = parse_maker_and_name(&id);
    Some(OpenRouterModelInfo {
        id,
        name,
        description: str_field(m, "description"),
        context_length: m.get("context_length").and_then(serde_json::Value::as_i64),
        pricing: m.get("pricing").filter(|v| !v.is_null()).cloned(),
        provider: Some("openrouter".to_string()),
        maker,
        model_name,
        variant,
        architecture: m.get("architecture").filter(|v| !v.is_null()).cloned(),
        supported_parameters: m
            .get("supported_parameters")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            }),
    })
}

/// Split `author/slug[:variant]` into (maker, model_name, variant). Mirrors
/// `parseMakerAndName` in llm.ts.
fn parse_maker_and_name(id: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut base = id;
    let mut variant: Option<String> = None;
    for v in OPENROUTER_VARIANTS {
        let suffix = format!(":{v}");
        if let Some(stripped) = id.strip_suffix(&suffix) {
            base = stripped;
            variant = Some(v.to_string());
            break;
        }
    }
    let parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => (None, None, variant),
        1 => (None, Some(parts[0].to_string()), variant),
        _ => {
            let maker = parts[0].trim_start_matches('~').to_string();
            (Some(maker), Some(parts[1..].join("/")), variant)
        }
    }
}

/// Coalesce a raw Ollama pull status string into one of the spec's stable
/// stages. Mirrors `classifyPullStatus` / `PULL_STATUS_PREFIXES`.
fn classify_pull_status(status_text: &str) -> &'static str {
    let lower = status_text.to_lowercase();
    if lower.starts_with("success") {
        "success"
    } else if lower.starts_with("pulling manifest") || lower.starts_with("retrieving") {
        "pulling"
    } else if lower.starts_with("pulling ") || lower.starts_with("downloading") {
        "downloading"
    } else if lower.starts_with("verifying") {
        "verifying"
    } else if lower.starts_with("writing") || lower.starts_with("removing") {
        "writing"
    } else {
        "pulling"
    }
}

/// Parse one NDJSON pull frame into `(coalesced_status, OllamaPullProgress json)`.
fn parse_pull_line(model: &str, line: &str) -> Option<(&'static str, serde_json::Value)> {
    let json: serde_json::Value = serde_json::from_str(line).ok()?;
    let status_text = json.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let status = classify_pull_status(status_text);
    let completed = json.get("completed").and_then(serde_json::Value::as_i64);
    let total = json.get("total").and_then(serde_json::Value::as_i64);
    let digest = json.get("digest").and_then(|d| d.as_str());
    let error = json.get("error").and_then(|e| e.as_str());
    let payload = pull_progress_json(
        model,
        status,
        Some(status_text),
        digest,
        completed,
        total,
        error,
    );
    Some((status, payload))
}

/// Build an `OllamaPullProgress`-shaped JSON value (camelCase, spec-faithful).
#[allow(clippy::too_many_arguments)]
fn pull_progress_json(
    model: &str,
    status: &str,
    status_text: Option<&str>,
    digest: Option<&str>,
    completed: Option<i64>,
    total: Option<i64>,
    error: Option<&str>,
) -> serde_json::Value {
    let percent = match (completed, total) {
        (Some(c), Some(t)) if t > 0 => Some(((c as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };
    let mut obj = serde_json::Map::new();
    obj.insert("model".into(), serde_json::json!(model));
    obj.insert("status".into(), serde_json::json!(status));
    if let Some(s) = status_text {
        obj.insert("statusText".into(), serde_json::json!(s));
    }
    if let Some(d) = digest {
        obj.insert("digest".into(), serde_json::json!(d));
    }
    if let Some(c) = completed {
        obj.insert("completed".into(), serde_json::json!(c));
    }
    if let Some(t) = total {
        obj.insert("total".into(), serde_json::json!(t));
    }
    if let Some(p) = percent {
        obj.insert("percent".into(), serde_json::json!(p));
    }
    if let Some(e) = error {
        obj.insert("error".into(), serde_json::json!(e));
    }
    serde_json::Value::Object(obj)
}

/// Extract the `text` field from an OpenRouter structured-output content string
/// (`{ "text": "..." }`). Strips markdown fences first (some providers wrap JSON
/// in ```json). Falls back to the raw trimmed content, then to `fallback` when
/// empty. Mirrors `repairOpenRouterText` + `result.object.text` extraction.
fn extract_openrouter_text(content: &str, fallback: &str) -> String {
    let trimmed = content.trim();
    let stripped = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(stripped) {
        if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
            let out = text.trim();
            if !out.is_empty() {
                return out.to_string();
            }
        }
    }
    // Not a JSON envelope (model ignored response_format) — use raw prose.
    if !stripped.is_empty() {
        return stripped.to_string();
    }
    fallback.to_string()
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

    #[test]
    fn parse_tags_extracts_name_size_details() {
        let json = serde_json::json!({
            "models": [
                {
                    "name": "llama3.2:1b",
                    "size": 1_300_000_000i64,
                    "modified_at": "2025-01-01T00:00:00Z",
                    "details": {
                        "format": "gguf",
                        "family": "llama",
                        "families": ["llama"],
                        "parameter_size": "1.2B",
                        "quantization_level": "Q4_K_M"
                    }
                }
            ]
        });
        let models = parse_ollama_tags(&json);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "llama3.2:1b");
        assert_eq!(models[0].size, Some(1_300_000_000));
        let d = models[0].details.as_ref().unwrap();
        assert_eq!(d.family.as_deref(), Some("llama"));
        assert_eq!(d.quantization_level.as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn maker_name_variant_split() {
        let (maker, name, variant) = parse_maker_and_name("anthropic/claude-3.5-sonnet:thinking");
        assert_eq!(maker.as_deref(), Some("anthropic"));
        assert_eq!(name.as_deref(), Some("claude-3.5-sonnet"));
        assert_eq!(variant.as_deref(), Some("thinking"));

        let (m2, n2, v2) = parse_maker_and_name("openrouter/auto");
        assert_eq!(m2.as_deref(), Some("openrouter"));
        assert_eq!(n2.as_deref(), Some("auto"));
        assert_eq!(v2, None);
    }

    #[test]
    fn classify_pull_status_stages() {
        assert_eq!(classify_pull_status("pulling manifest"), "pulling");
        assert_eq!(classify_pull_status("pulling 1a2b3c"), "downloading");
        assert_eq!(classify_pull_status("downloading"), "downloading");
        assert_eq!(classify_pull_status("verifying sha256"), "verifying");
        assert_eq!(classify_pull_status("writing manifest"), "writing");
        assert_eq!(classify_pull_status("success"), "success");
    }

    #[test]
    fn pull_progress_json_has_percent() {
        let v = pull_progress_json("m", "downloading", Some("pulling x"), None, Some(50), Some(100), None);
        assert_eq!(v.get("percent").and_then(|p| p.as_f64()), Some(50.0));
        assert_eq!(v.get("status").and_then(|s| s.as_str()), Some("downloading"));
        assert_eq!(v.get("model").and_then(|s| s.as_str()), Some("m"));
    }

    #[test]
    fn parse_openrouter_models_maps_rows() {
        let json = serde_json::json!({
            "data": [
                { "id": "openai/gpt-4o", "name": "GPT-4o", "context_length": 128000i64 }
            ]
        });
        let models = parse_openrouter_models(&json);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "openai/gpt-4o");
        assert_eq!(models[0].maker.as_deref(), Some("openai"));
        assert_eq!(models[0].context_length, Some(128000));
    }
}
