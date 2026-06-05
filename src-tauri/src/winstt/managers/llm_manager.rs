// Source: docs/archive/port/07_llm_cloud_context_longtail.md §1,
// frontend/electron/ipc/llm.ts + ollama.ts. Wraps winstt::llm (pure prompt/leakage logic).
//
// LlmManager owns LLM orchestration, request ids, cancellation, and renderer events.
// Ollama's raw HTTP transport lives in winstt::ollama_client.
// The pure prompt composition + CoT-leakage/salvage + Ollama body builders all
// live in `winstt::llm`; this manager is the stateful, async, app-aware shell.
//
// Connection values (endpoint / api key) are read from the persisted settings via
// `settings::get_settings` at call time so a key change takes effect with no restart
// (hot-swap path). Ollama keep-alive follows the shared model lifetime setting.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::commands::ollama_pull::{
    set_warmup_status, LlmWarmupModelStatus, LlmWarmupOutcome, LlmWarmupStatus,
};
use crate::winstt::commands::settings::{enabled_ollama_models, read_settings};
use crate::winstt::llm::{
    self, apply_openrouter_runtime_options, build_ollama_chat_body_with_keep_alive,
    finalize_chat_answer, ollama_keep_alive_from_core_timeout, validate_loopback_ollama_endpoint,
    OpenRouterRequestOptions, ReasoningSink, ThinkingEffort,
};
use crate::winstt::model_swap::ModelSwapCoordinator;
pub use crate::winstt::ollama_client::{
    OllamaCapabilities, OllamaModelDetails, OllamaModelInfo, PullOutcome,
};
use crate::winstt::ollama_client::{OllamaClient, OllamaLoadResult};

const OLLAMA_WARMUP_INTERVAL: Duration = Duration::from_secs(4 * 60);
const OLLAMA_WARMUP_TIMEOUT: Duration = Duration::from_secs(120);
const OLLAMA_EVICT_TIMEOUT: Duration = Duration::from_secs(5);
const OLLAMA_BOOT_WAIT: Duration = Duration::from_secs(10);
const OLLAMA_RECENT_WARM_SKIP: Duration = Duration::from_secs(30);
const LLM_WARMUP_PASS_KEY: &str = "llm:warmup-pass";

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

fn warmup_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn llm_model_key(endpoint: &str, model: &str) -> String {
    format!("llm\0{endpoint}\0{model}")
}

fn llm_endpoint_prefix(endpoint: &str) -> String {
    format!("llm\0{endpoint}\0")
}

fn llm_model_from_key<'a>(key: &'a str, endpoint: &str) -> Option<&'a str> {
    key.strip_prefix(&llm_endpoint_prefix(endpoint))
}

fn is_loopback_ollama_endpoint(endpoint: &str) -> bool {
    validate_loopback_ollama_endpoint(endpoint).is_ok()
}

fn ensure_ollama_stream_has_content(state: &llm::OllamaStreamState) -> Result<(), String> {
    if !state.content.trim().is_empty() {
        return Ok(());
    }
    Err(format!(
        "Ollama returned no content (done={}, done_reason={}, thinking_chars={})",
        state.done,
        state.done_reason.as_deref().unwrap_or("none"),
        state.thinking.chars().count()
    ))
}

/// All-Rust LLM post-processing manager.
pub struct LlmManager {
    app: AppHandle,
    client: reqwest::Client,
    ollama: OllamaClient,
    /// Cancelled request ids — the Ollama drain loop checks this between chunks.
    cancelled: CancelRegistry,
    /// Monotonic request-id source for fire-and-emit calls without a renderer id.
    seq: AtomicU64,
    /// Guards the app-lifetime periodic keep-alive loop against duplicate startup wiring.
    warmup_loop_started: AtomicBool,
    /// Coalesces Ollama warmup passes and tracks models this process warmed.
    lifecycle: ModelSwapCoordinator,
    /// OpenRouter `supported_parameters` from the latest model scan. The chat
    /// path uses this to avoid sending unsupported model-specific controls.
    openrouter_supported_parameters: Mutex<HashMap<String, Vec<String>>>,
}

impl LlmManager {
    pub fn new(app: &AppHandle) -> Self {
        let client = reqwest::Client::new();
        Self {
            app: app.clone(),
            client: client.clone(),
            ollama: OllamaClient::new(client),
            cancelled: CancelRegistry::new(),
            seq: AtomicU64::new(1),
            warmup_loop_started: AtomicBool::new(false),
            lifecycle: ModelSwapCoordinator::new(),
            openrouter_supported_parameters: Mutex::new(HashMap::new()),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("llm-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    pub fn start_warmup_loop(self: &Arc<Self>) {
        if self
            .warmup_loop_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let mgr = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                mgr.warm_enabled_models().await;
                tokio::time::sleep(OLLAMA_WARMUP_INTERVAL).await;
            }
        });
    }

    pub async fn warm_enabled_models(&self) {
        let Some(_pass) = self.lifecycle.try_claim(LLM_WARMUP_PASS_KEY) else {
            return;
        };

        let settings = read_settings(&self.app);
        let endpoint = settings.llm.endpoint.clone();
        let models = enabled_ollama_models(&settings);
        if models.is_empty() {
            self.evict_stale_warmed_models(&endpoint, &[]).await;
            self.publish_warmup_status(LlmWarmupStatus {
                endpoint,
                in_progress: false,
                models: Vec::new(),
                ollama_installed: false,
                reachable: false,
                timestamp: warmup_timestamp(),
            });
            return;
        }

        self.cancel_all();
        let (reachable, ollama_installed) = self.ensure_ollama_reachable(&endpoint).await;
        if !reachable {
            self.publish_warmup_status(LlmWarmupStatus {
                endpoint,
                in_progress: false,
                models: models
                    .into_iter()
                    .map(|model| LlmWarmupModelStatus {
                        model,
                        outcome: LlmWarmupOutcome::Unreachable,
                        error_body: None,
                    })
                    .collect(),
                ollama_installed,
                reachable: false,
                timestamp: warmup_timestamp(),
            });
            return;
        }

        self.publish_warmup_status(LlmWarmupStatus {
            endpoint: endpoint.clone(),
            in_progress: true,
            models: models
                .iter()
                .map(|model| LlmWarmupModelStatus {
                    model: model.clone(),
                    outcome: LlmWarmupOutcome::Loading,
                    error_body: None,
                })
                .collect(),
            ollama_installed,
            reachable: true,
            timestamp: warmup_timestamp(),
        });

        self.evict_stale_warmed_models(&endpoint, &models).await;

        let keep_alive = self.ollama_keep_alive();
        let mut results = Vec::with_capacity(models.len());
        for model in &models {
            results.push(
                self.warmup_ollama_model(&endpoint, model, keep_alive.clone())
                    .await,
            );
        }

        self.publish_warmup_status(LlmWarmupStatus {
            endpoint,
            in_progress: false,
            models: results,
            ollama_installed,
            reachable: true,
            timestamp: warmup_timestamp(),
        });
    }

    /// Mark a request cancelled (a model swap / new dictation aborts the prior).
    pub fn cancel(&self, request_id: &str) {
        self.cancelled.cancel(request_id);
    }

    pub fn cancel_all(&self) {
        self.cancelled.cancel_all();
    }

    fn track_cancel(&self, request_id: &str) {
        self.cancelled.track(request_id);
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled.is_cancelled(request_id, false)
    }

    fn clear_cancel(&self, request_id: &str) {
        self.cancelled.clear(request_id);
    }

    fn ollama_keep_alive(&self) -> serde_json::Value {
        let timeout = read_settings(&self.app).global.model_unload_timeout;
        let timeout = crate::winstt::commands::settings::core_timeout_from_winstt(timeout);
        ollama_keep_alive_from_core_timeout(timeout)
    }

    async fn ensure_ollama_reachable(&self, endpoint: &str) -> (bool, bool) {
        if self.ollama_detect(endpoint).await {
            return (true, true);
        }
        if !is_loopback_ollama_endpoint(endpoint) {
            return (false, false);
        }
        let detected = crate::winstt::commands::llm::detect_ollama_executable().await;
        let Some(path) = detected.path else {
            return (false, detected.installed);
        };
        if let Err(err) = crate::winstt::commands::llm::spawn_ollama_serve(&path) {
            log::debug!("[llm] Ollama auto-start failed: {err}");
            return (false, true);
        }
        (self.wait_for_ollama(endpoint, OLLAMA_BOOT_WAIT).await, true)
    }

    async fn wait_for_ollama(&self, endpoint: &str, total: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + total;
        loop {
            if self.ollama_detect(endpoint).await {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn evict_stale_warmed_models(&self, endpoint: &str, active_models: &[String]) {
        let stale = self.stale_warmed_models(endpoint, active_models);
        for model in stale {
            self.unload_ollama_model(endpoint, &model).await;
            self.lifecycle.clear_warm(&llm_model_key(endpoint, &model));
        }
    }

    fn stale_warmed_models(&self, endpoint: &str, active_models: &[String]) -> Vec<String> {
        let active: HashSet<String> = active_models
            .iter()
            .map(|model| llm_model_key(endpoint, model))
            .collect();
        self.lifecycle
            .warm_keys()
            .into_iter()
            .filter(|key| key.starts_with(&llm_endpoint_prefix(endpoint)))
            .filter(|key| !active.contains(key))
            .filter_map(|key| llm_model_from_key(&key, endpoint).map(str::to_string))
            .collect()
    }

    async fn unload_ollama_model(&self, endpoint: &str, model: &str) {
        self.ollama
            .unload_model(endpoint, model, OLLAMA_EVICT_TIMEOUT)
            .await;
    }

    fn mark_ollama_model_warm(&self, endpoint: &str, model: &str) {
        if !model.trim().is_empty() {
            self.lifecycle.mark_warm(llm_model_key(endpoint, model));
        }
    }

    async fn warmup_ollama_model(
        &self,
        endpoint: &str,
        model: &str,
        keep_alive: serde_json::Value,
    ) -> LlmWarmupModelStatus {
        if model.trim().is_empty() {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Skipped,
                error_body: None,
            };
        }

        let model_key = llm_model_key(endpoint, model);
        if self
            .lifecycle
            .is_warm_within(&model_key, OLLAMA_RECENT_WARM_SKIP)
        {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Ok,
                error_body: None,
            };
        }
        let Some(_claim) = self.lifecycle.try_claim(model_key.clone()) else {
            return LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Loading,
                error_body: None,
            };
        };

        match self
            .ollama
            .warmup_model(endpoint, model, keep_alive, OLLAMA_WARMUP_TIMEOUT)
            .await
        {
            OllamaLoadResult::Ok => {
                self.lifecycle.mark_warm(model_key);
                log::debug!("[llm] Ollama warm-up OK: {model}");
                LlmWarmupModelStatus {
                    model: model.to_string(),
                    outcome: LlmWarmupOutcome::Ok,
                    error_body: None,
                }
            }
            OllamaLoadResult::Transport(err) => LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: LlmWarmupOutcome::Unreachable,
                error_body: Some(err),
            },
            OllamaLoadResult::Http { status, body } => LlmWarmupModelStatus {
                model: model.to_string(),
                outcome: if status == 404 {
                    LlmWarmupOutcome::ModelNotFound
                } else {
                    LlmWarmupOutcome::LoadFailed
                },
                error_body: if body.is_empty() { None } else { Some(body) },
            },
        }
    }

    fn publish_warmup_status(&self, status: LlmWarmupStatus) {
        set_warmup_status(status.clone());
        let _ = self.app.emit("llm:warmup-status", status);
    }

    fn remember_openrouter_supported_parameters(&self, models: &[OpenRouterModelInfo]) {
        let Ok(mut cache) = self.openrouter_supported_parameters.lock() else {
            return;
        };
        for model in models {
            if let Some(params) = &model.supported_parameters {
                cache.insert(model.id.clone(), params.clone());
            }
        }
    }

    fn cached_openrouter_supported_parameters(&self, model: &str) -> Option<Vec<String>> {
        self.openrouter_supported_parameters
            .lock()
            .ok()
            .and_then(|cache| cache.get(model).cloned())
    }

    async fn openrouter_supported_parameters(
        &self,
        api_key: &str,
        model: &str,
        options: &OpenRouterRequestOptions,
    ) -> Option<Vec<String>> {
        if !options.has_any_runtime_param() || model == "openrouter/auto" {
            return None;
        }
        if let Some(params) = self.cached_openrouter_supported_parameters(model) {
            return Some(params);
        }
        let scan = self.scan_openrouter(api_key).await;
        if scan.error.is_some() || scan.models.is_empty() {
            return None;
        }
        self.cached_openrouter_supported_parameters(model)
    }

    // ── Ollama capability probe (`/api/show`) ──────────────────────────────

    /// Probe `/api/show` for a model's capabilities, caching the result.
    /// `endpoint` is the user's Ollama base URL.
    pub async fn ollama_capabilities(
        &self,
        endpoint: &str,
        model: &str,
    ) -> Result<OllamaCapabilities, String> {
        self.ollama.capabilities(endpoint, model).await
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
        user_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        request_id: &str,
    ) -> Result<String, String> {
        self.track_cancel(request_id);
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let body = build_ollama_chat_body_with_keep_alive(
            model,
            system_prompt,
            user_prompt,
            text.len(),
            caps.supports_thinking,
            effort,
            self.ollama_keep_alive(),
        );
        let result = self
            .stream_ollama_chat(endpoint, body, text, request_id)
            .await;
        if result.is_ok() {
            self.mark_ollama_model_warm(endpoint, model);
        }
        result
    }

    /// Run a transform-on-selection over Ollama (system prompt is the transform's
    /// own preset body; no context/vocab folding).
    pub async fn ollama_transform(
        &self,
        endpoint: &str,
        model: &str,
        system_prompt: &str,
        user_prompt: &str,
        text: &str,
        effort: ThinkingEffort,
        request_id: &str,
    ) -> Result<String, String> {
        self.track_cancel(request_id);
        let caps = self
            .ollama_capabilities(endpoint, model)
            .await
            .unwrap_or_default();
        let body = build_ollama_chat_body_with_keep_alive(
            model,
            system_prompt,
            user_prompt,
            text.len(),
            caps.supports_thinking,
            effort,
            self.ollama_keep_alive(),
        );
        let result = self
            .stream_ollama_chat(endpoint, body, text, request_id)
            .await;
        if result.is_ok() {
            self.mark_ollama_model_warm(endpoint, model);
        }
        result
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
        let sink = EmitReasoningSink {
            app: self.app.clone(),
            request_id: request_id.to_string(),
        };
        let state = self
            .ollama
            .stream_chat(
                endpoint,
                body,
                || self.is_cancelled(request_id),
                |delta| {
                    sink.on_delta(delta);
                },
            )
            .await;
        self.clear_cancel(request_id);
        let state = state?;

        if let Some(err) = state.error {
            return Err(format!("Ollama stream error: {err}"));
        }
        ensure_ollama_stream_has_content(&state)?;
        // Surface any learned proper nouns the model emitted in the structured
        // envelope to the dictionary auto-add UI (mirrors broadcastLearnedProperNouns
        // → `llm-learned-proper-nouns`). Empty batches are dropped.
        let nouns = llm::extract_learned_proper_nouns(&state.content);
        if !nouns.is_empty() {
            let _ = self.app.emit(
                "llm-learned-proper-nouns",
                serde_json::json!({ "nouns": nouns }),
            );
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
        self.ollama.list_models(endpoint).await
    }

    /// True iff an Ollama server answers at the endpoint (`GET /api/version`).
    pub async fn ollama_detect(&self, endpoint: &str) -> bool {
        self.ollama.detect(endpoint).await
    }

    /// List local Ollama models (`/api/tags`) as full detail rows (name + size +
    /// modifiedAt + details + enriched capabilities). Mirrors `scanOllamaModels`
    /// in the reference handler: parse `/api/tags`, then per-model `/api/show` to
    /// fill `capabilities`. A single `/api/show` failure leaves that model's caps
    /// empty rather than poisoning the list.
    pub async fn ollama_list_models_detailed(
        &self,
        endpoint: &str,
    ) -> Result<Vec<OllamaModelInfo>, String> {
        self.ollama.list_models_detailed(endpoint).await
    }

    /// Delete a local Ollama model (`DELETE /api/delete { model }`). Returns
    /// `(success, error)`. Mirrors `deleteOllamaModel`.
    pub async fn ollama_delete(&self, endpoint: &str, model: &str) -> (bool, Option<String>) {
        self.ollama.delete(endpoint, model).await
    }

    /// Stream a model pull (`POST /api/pull`, stream=true), emitting
    /// `llm:pull-progress` for every coalesced NDJSON frame (broadcast to all
    /// windows via `self.app`). `is_cancelled` is polled between frames so the
    /// renderer's stop button aborts mid-stream. Mirrors `pullOllamaModel` +
    /// `readPullStream` in the reference handler.
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
        F: Fn() -> bool + Send,
    {
        self.ollama
            .pull_stream(endpoint, model, is_cancelled, |payload| {
                self.emit_pull(payload);
            })
            .await
    }

    /// Broadcast one `llm:pull-progress` frame to every renderer.
    fn emit_pull(&self, payload: serde_json::Value) {
        let _ = self.app.emit("llm:pull-progress", payload);
    }

    /// Run a dictation/transform over OpenRouter's OpenAI-compatible
    /// `/api/v1/chat/completions`. `api_key` is the stored OpenRouter key,
    /// `selection` is the `model[@providerSlug]` picker value (`""` → auto).
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
        options: OpenRouterRequestOptions,
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
        let supported_parameters = self
            .openrouter_supported_parameters(api_key, &model, &options)
            .await;
        apply_openrouter_runtime_options(
            &mut body,
            &model,
            supported_parameters.as_deref(),
            &options,
        );
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
        let scan = OpenRouterScan {
            reachable: true,
            models: parse_openrouter_models(&json),
            error: None,
        };
        self.remember_openrouter_supported_parameters(&scan.models);
        scan
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
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

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
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
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(stripped)
    {
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn empty_ollama_stream_is_provider_error() {
        let state = llm::OllamaStreamState {
            done: true,
            done_reason: Some("stop".to_string()),
            thinking: "reasoning only".to_string(),
            ..Default::default()
        };

        let err = ensure_ollama_stream_has_content(&state).unwrap_err();
        assert!(err.contains("Ollama returned no content"));
        assert!(err.contains("done_reason=stop"));
        assert!(err.contains("thinking_chars=14"));
    }

    #[test]
    fn non_empty_ollama_stream_is_usable() {
        let state = llm::OllamaStreamState {
            content: r#"{"text":"changed"}"#.to_string(),
            done: true,
            done_reason: Some("stop".to_string()),
            ..Default::default()
        };

        assert!(ensure_ollama_stream_has_content(&state).is_ok());
    }
}
