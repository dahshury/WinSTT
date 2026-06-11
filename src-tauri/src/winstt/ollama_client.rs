use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;

use crate::winstt::llm::{
    build_loopback_ollama_api_url, parse_chat_stream_line, validate_loopback_ollama_endpoint,
    OllamaStreamState, OLLAMA_NUM_CTX,
};

/// Direct Ollama HTTP client for WinSTT's app-specific API contract.
pub struct OllamaClient {
    http: reqwest::Client,
    caps_cache: Mutex<HashMap<String, OllamaCapabilities>>,
}

impl OllamaClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            caps_cache: Mutex::new(HashMap::new()),
        }
    }

    /// True iff an Ollama server answers at the endpoint (`GET /api/version`).
    pub async fn detect(&self, endpoint: &str) -> bool {
        let Ok(url) = build_loopback_ollama_api_url(endpoint, "/api/version") else {
            return false;
        };
        self.http
            .get(url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Load or refresh a model through `/api/generate` with an empty prompt.
    pub async fn warmup_model(
        &self,
        endpoint: &str,
        model: &str,
        keep_alive: serde_json::Value,
        timeout: Duration,
    ) -> OllamaLoadResult {
        let url = match build_loopback_ollama_api_url(endpoint, "/api/generate") {
            Ok(url) => url,
            Err(err) => return OllamaLoadResult::Transport(err),
        };
        let response = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "model": model,
                "prompt": "",
                "stream": false,
                "keep_alive": keep_alive,
                // Load with the SAME context the chat path requests. Ollama
                // reloads a model whenever `num_ctx` differs from the loaded
                // instance, so a default-ctx warmup would leave every real
                // dictation paying the full model reload it was meant to avoid.
                "options": { "num_ctx": OLLAMA_NUM_CTX },
            }))
            .timeout(timeout)
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(err) => return OllamaLoadResult::Transport(err.to_string()),
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return OllamaLoadResult::Http { status, body };
        }

        let _ = response.bytes().await;
        OllamaLoadResult::Ok
    }

    /// Unload a warmed model through `/api/generate` with `keep_alive: 0`.
    pub async fn unload_model(&self, endpoint: &str, model: &str, timeout: Duration) {
        let url = match build_loopback_ollama_api_url(endpoint, "/api/generate") {
            Ok(url) => url,
            Err(err) => {
                log::debug!("[llm] Ollama evict skipped for invalid endpoint: {err}");
                return;
            }
        };
        let result = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "model": model,
                "prompt": "",
                "stream": false,
                "keep_alive": 0,
            }))
            .timeout(timeout)
            .send()
            .await;
        if let Err(err) = result {
            log::debug!("[llm] Ollama evict failed for {model}: {err}");
        }
    }

    /// Probe `/api/show` for a model's capabilities, caching by endpoint + model.
    pub async fn capabilities(
        &self,
        endpoint: &str,
        model: &str,
    ) -> Result<OllamaCapabilities, String> {
        let normalized_endpoint = validate_loopback_ollama_endpoint(endpoint)?;
        let cache_key = format!("{normalized_endpoint}\0{model}");
        if let Some(hit) = self
            .caps_cache
            .lock()
            .ok()
            .and_then(|m| m.get(&cache_key).cloned())
        {
            return Ok(hit);
        }

        let url = build_loopback_ollama_api_url(endpoint, "/api/show")?;
        let resp = self
            .http
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
            m.insert(cache_key, caps.clone());
        }
        Ok(caps)
    }

    /// POST `/api/chat`, drain the NDJSON stream, and fold chunks into state.
    pub async fn stream_chat<F, D>(
        &self,
        endpoint: &str,
        body: serde_json::Value,
        is_cancelled: F,
        mut on_thinking_delta: D,
    ) -> Result<OllamaStreamState, String>
    where
        F: Fn() -> bool + Send,
        D: FnMut(&str) + Send,
    {
        let url = build_loopback_ollama_api_url(endpoint, "/api/chat")?;
        let resp = self
            .http
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

        let mut state = OllamaStreamState::default();
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        let mut cancelled = false;
        while let Some(chunk) = stream.next().await {
            if is_cancelled() {
                cancelled = true;
                break;
            }
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(nl) = buf.find('\n') {
                let line: String = buf.drain(..=nl).collect();
                if let Some(c) = parse_chat_stream_line(&line) {
                    let deltas = state.apply_chunk(&c);
                    if let Some(t) = deltas.thinking {
                        on_thinking_delta(&t);
                    }
                }
            }
        }
        // A cancelled stream holds only a partial response — for a structured
        // `format` request that is a JSON fragment like `{` or `{"text`. Returning
        // it as success makes the caller paste that scaffolding (the dictation
        // session is NOT cancelled here — only this request id is). Surface
        // cancellation as an error so the caller fails soft to the original text.
        if cancelled {
            return Err("Ollama chat cancelled".to_string());
        }
        if let Some(c) = parse_chat_stream_line(&buf) {
            state.apply_chunk(&c);
        }
        Ok(state)
    }

    /// List local Ollama models (`/api/tags`). Returns the raw model ids.
    pub async fn list_models(&self, endpoint: &str) -> Result<Vec<String>, String> {
        let json = self.tags_json(endpoint).await?;
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

    /// List local Ollama models as full detail rows plus capability enrichment.
    pub async fn list_models_detailed(
        &self,
        endpoint: &str,
    ) -> Result<Vec<OllamaModelInfo>, String> {
        let json = self.tags_json(endpoint).await?;
        let mut models = parse_ollama_tags(&json);
        for m in &mut models {
            if let Ok(caps) = self.capabilities(endpoint, &m.name).await {
                if !caps.capabilities.is_empty() {
                    m.capabilities = Some(caps.capabilities);
                }
                m.context_length = caps.context_length;
            }
        }
        Ok(models)
    }

    async fn tags_json(&self, endpoint: &str) -> Result<serde_json::Value, String> {
        let url = build_loopback_ollama_api_url(endpoint, "/api/tags")?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Ollama /api/tags failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama /api/tags HTTP {}", resp.status().as_u16()));
        }
        resp.json()
            .await
            .map_err(|e| format!("Ollama /api/tags parse: {e}"))
    }

    /// Delete a local Ollama model (`DELETE /api/delete { model }`).
    pub async fn delete(&self, endpoint: &str, model: &str) -> (bool, Option<String>) {
        let url = match build_loopback_ollama_api_url(endpoint, "/api/delete") {
            Ok(url) => url,
            Err(err) => return (false, Some(err)),
        };
        match self
            .http
            .delete(url)
            .json(&serde_json::json!({ "model": model }))
            .timeout(Duration::from_secs(15))
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

    /// Stream a model pull, coalescing per-layer Ollama progress into one bar.
    pub async fn pull_stream<F, E>(
        &self,
        endpoint: &str,
        model: &str,
        is_cancelled: F,
        mut emit: E,
    ) -> PullOutcome
    where
        F: Fn() -> bool + Send,
        E: FnMut(serde_json::Value) + Send,
    {
        let url = match build_loopback_ollama_api_url(endpoint, "/api/pull") {
            Ok(url) => url,
            Err(err) => {
                emit(pull_progress_json(
                    model,
                    "error",
                    None,
                    None,
                    None,
                    None,
                    Some(&err),
                ));
                return PullOutcome::Error(err);
            }
        };
        let resp = match self
            .http
            .post(url)
            .json(&serde_json::json!({ "model": model, "stream": true, "insecure": false }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("Ollama /api/pull failed: {e}");
                emit(pull_progress_json(
                    model,
                    "error",
                    None,
                    None,
                    None,
                    None,
                    Some(&msg),
                ));
                return PullOutcome::Error(msg);
            }
        };
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            let msg = format!("Ollama /api/pull HTTP {status}: {body}");
            emit(pull_progress_json(
                model,
                "error",
                None,
                None,
                None,
                None,
                Some(&msg),
            ));
            return PullOutcome::Error(msg);
        }

        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        let mut success = false;
        let mut last_error: Option<String> = None;
        let mut layers = PullLayers::default();

        loop {
            if is_cancelled() {
                return PullOutcome::Cancelled;
            }
            let Some(chunk) = stream.next().await else {
                break;
            };
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    let msg = format!("Ollama /api/pull stream error: {e}");
                    emit(pull_progress_json(
                        model,
                        "error",
                        None,
                        None,
                        None,
                        None,
                        Some(&msg),
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
                if let Some((status, payload)) = parse_pull_line(model, trimmed, &mut layers) {
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
                    emit(payload);
                }
            }
            if is_cancelled() {
                return PullOutcome::Cancelled;
            }
        }

        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            if let Some((status, payload)) = parse_pull_line(model, trimmed, &mut layers) {
                if status == "success" {
                    success = true;
                }
                emit(payload);
            }
        }

        if success {
            PullOutcome::Success
        } else {
            let msg =
                last_error.unwrap_or_else(|| "Pull did not complete successfully".to_string());
            emit(pull_progress_json(
                model,
                "error",
                None,
                None,
                None,
                None,
                Some(&msg),
            ));
            PullOutcome::Error(msg)
        }
    }
}

pub enum OllamaLoadResult {
    Ok,
    Http { status: u16, body: String },
    Transport(String),
}

/// Outcome of a streaming pull.
pub enum PullOutcome {
    Success,
    Cancelled,
    Error(String),
}

/// One Ollama model's capabilities (from `/api/show`).
#[derive(Clone, Debug, Default)]
pub struct OllamaCapabilities {
    pub capabilities: Vec<String>,
    pub supports_thinking: bool,
    pub supports_tools: bool,
    pub context_length: Option<u64>,
}

/// One Ollama model row as parsed from `/api/tags` plus enriched capabilities.
#[derive(Clone, Debug, Default)]
pub struct OllamaModelInfo {
    pub name: String,
    pub size: Option<i64>,
    pub modified_at: Option<String>,
    pub details: Option<OllamaModelDetails>,
    pub capabilities: Option<Vec<String>>,
    pub context_length: Option<u64>,
}

/// Per-model detail metadata (`/api/tags` `details` object).
#[derive(Clone, Debug, Default)]
pub struct OllamaModelDetails {
    pub format: Option<String>,
    pub family: Option<String>,
    pub families: Option<Vec<String>>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

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
        context_length: None,
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

fn parse_ollama_show(json: &serde_json::Value) -> OllamaCapabilities {
    let capabilities = json
        .get("capabilities")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let supports_thinking = capabilities.iter().any(|v| v == "thinking");
    let supports_tools = capabilities.iter().any(|v| v == "tools");
    let context_length = json
        .get("model_info")
        .and_then(|mi| mi.as_object())
        .and_then(|obj| {
            obj.iter()
                .find(|(k, _)| k.ends_with(".context_length"))
                .and_then(|(_, v)| v.as_u64())
        });
    OllamaCapabilities {
        capabilities,
        supports_thinking,
        supports_tools,
        context_length,
    }
}

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

#[derive(Default)]
struct PullLayers {
    by_digest: HashMap<String, (i64, i64)>,
}

impl PullLayers {
    fn record(&mut self, digest: Option<&str>, completed: Option<i64>, total: Option<i64>) {
        if let (Some(d), Some(t)) = (digest, total) {
            if t > 0 {
                let c = completed.unwrap_or(0).clamp(0, t);
                self.by_digest.insert(d.to_string(), (c, t));
            }
        }
    }

    fn aggregate(&self) -> Option<(i64, i64)> {
        if self.by_digest.is_empty() {
            return None;
        }
        let (mut completed, mut total) = (0i64, 0i64);
        for (c, t) in self.by_digest.values() {
            completed += c;
            total += t;
        }
        Some((completed, total))
    }
}

fn parse_pull_line(
    model: &str,
    line: &str,
    layers: &mut PullLayers,
) -> Option<(&'static str, serde_json::Value)> {
    let json: serde_json::Value = serde_json::from_str(line).ok()?;
    let status_text = json.get("status").and_then(|s| s.as_str()).unwrap_or("");
    let status = classify_pull_status(status_text);
    let completed = json.get("completed").and_then(serde_json::Value::as_i64);
    let total = json.get("total").and_then(serde_json::Value::as_i64);
    let digest = json.get("digest").and_then(|d| d.as_str());
    let error = json.get("error").and_then(|e| e.as_str());

    layers.record(digest, completed, total);
    let (agg_completed, agg_total) = match (status, layers.aggregate()) {
        ("success", Some((_, t))) => (Some(t), Some(t)),
        (_, Some((c, t))) => (Some(c), Some(t)),
        (_, None) => (completed, total),
    };

    let payload = pull_progress_json(
        model,
        status,
        Some(status_text),
        digest,
        agg_completed,
        agg_total,
        error,
    );
    Some((status, payload))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_show_detects_thinking_and_ctx() {
        let json = serde_json::json!({
            "capabilities": ["completion", "thinking", "tools"],
            "model_info": { "qwen3.context_length": 32768u64 }
        });
        let caps = parse_ollama_show(&json);
        assert!(caps.supports_thinking);
        assert!(caps.supports_tools);
        assert_eq!(
            caps.capabilities,
            vec![
                "completion".to_string(),
                "thinking".to_string(),
                "tools".to_string()
            ]
        );
        assert_eq!(caps.context_length, Some(32768));
    }

    #[test]
    fn parse_show_non_thinking_model() {
        let json = serde_json::json!({ "capabilities": ["completion"] });
        let caps = parse_ollama_show(&json);
        assert!(!caps.supports_thinking);
        assert!(!caps.supports_tools);
        assert_eq!(caps.capabilities, vec!["completion".to_string()]);
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
        let v = pull_progress_json(
            "m",
            "downloading",
            Some("pulling x"),
            None,
            Some(50),
            Some(100),
            None,
        );
        assert_eq!(v.get("percent").and_then(|p| p.as_f64()), Some(50.0));
        assert_eq!(
            v.get("status").and_then(|s| s.as_str()),
            Some("downloading")
        );
        assert_eq!(v.get("model").and_then(|s| s.as_str()), Some("m"));
    }

    #[test]
    fn pull_layers_sum_across_digests() {
        let mut layers = PullLayers::default();
        layers.record(Some("sha256:a"), Some(50), Some(100));
        layers.record(Some("sha256:b"), Some(200), Some(400));
        assert_eq!(layers.aggregate(), Some((250, 500)));
    }

    #[test]
    fn pull_layers_clamp_and_ignore_undigested() {
        let mut layers = PullLayers::default();
        layers.record(Some("sha256:x"), Some(250), Some(100));
        layers.record(None, Some(10), Some(20));
        layers.record(Some("sha256:y"), Some(5), None);
        assert_eq!(layers.aggregate(), Some((100, 100)));
    }

    #[test]
    fn parse_pull_line_reports_aggregate_not_per_layer() {
        let mut layers = PullLayers::default();
        let cfg = serde_json::json!({
            "status": "pulling cfg", "digest": "sha256:cfg", "total": 1000, "completed": 1000
        })
        .to_string();
        let gguf = serde_json::json!({
            "status": "pulling gguf", "digest": "sha256:gguf", "total": 4_000_000_000i64, "completed": 0
        })
        .to_string();
        parse_pull_line("m", &cfg, &mut layers);
        let (_, payload) = parse_pull_line("m", &gguf, &mut layers).unwrap();
        assert!(payload.get("percent").and_then(|p| p.as_f64()).unwrap() < 1.0);
    }

    #[test]
    fn parse_pull_line_success_forces_full_bar() {
        let mut layers = PullLayers::default();
        let dl = serde_json::json!({
            "status": "pulling gguf", "digest": "sha256:gguf", "total": 100, "completed": 40
        })
        .to_string();
        parse_pull_line("m", &dl, &mut layers);
        let success = serde_json::json!({ "status": "success" }).to_string();
        let (_, payload) = parse_pull_line("m", &success, &mut layers).unwrap();
        assert_eq!(payload.get("percent").and_then(|p| p.as_f64()), Some(100.0));
    }
}
