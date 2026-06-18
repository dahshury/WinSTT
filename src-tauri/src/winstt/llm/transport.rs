// Provider transport options.
//
// OpenRouter request extras + reasoning/verbosity/max-tokens support
// detection + ReasoningSink trait, and Ollama endpoint/URL normalization +
// loopback validation. (OpenRouter and endpoint helpers are both small,
// self-contained, provider-config concerns.)

use std::net::IpAddr;

/// Sink for live reasoning/answer deltas (the recording pill). The Ollama
/// transport calls this per chunk. Implemented in the manager as a thin
/// `app.emit("llm:reasoning-delta", …)` wrapper.
pub trait ReasoningSink: Send {
    fn on_delta(&self, delta: &str);
}

// ─────────────────────── OpenRouter extra-body ────────────────────────
//
// OpenRouter rides the OpenAI-compatible client (send_chat_completion_with_schema).
// These are the two WinSTT-specific request extras (response-healing plugin +
// provider pinning) that go in the request body. Mirrors
// OPENROUTER_DICTATION_PROVIDER_OPTIONS + buildModelOptions in llm.ts.

/// Sentinel error returned by `LlmManager::openrouter_chat` when the request was
/// aborted (overlay X / model swap → `cancel_all`). The fallback wrappers treat
/// it specially: a user cancel must NOT trigger the fallback-model retry — it
/// just yields the original text (the surrounding dictation/transform is being
/// torn down anyway).
pub const OPENROUTER_CANCELLED: &str = "winstt:openrouter-cancelled";

/// OpenRouter runtime parameters selected in the model picker.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenRouterRequestOptions {
    pub reasoning_effort: Option<String>,
    pub verbosity: Option<String>,
    pub max_output_tokens: Option<i64>,
}

impl OpenRouterRequestOptions {
    pub fn has_any_runtime_param(&self) -> bool {
        self.reasoning_effort.is_some()
            || self.verbosity.is_some()
            || self.max_output_tokens.is_some()
    }
}

/// Build the OpenRouter-specific body extras: the `response-healing` plugin
/// (server-side JSON repair) and, when a specific provider slug is chosen,
/// pin to it with fallbacks disabled.
pub fn openrouter_extra_body(provider_slug: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "plugins": [ { "id": "response-healing" } ]
    });
    if let Some(slug) = provider_slug {
        if !slug.is_empty() {
            body["provider"] = serde_json::json!({
                "order": [slug],
                "allow_fallbacks": false
            });
        }
    }
    body
}

fn openrouter_supported_has(supported_parameters: Option<&[String]>, key: &str) -> bool {
    supported_parameters.is_some_and(|params| params.iter().any(|p| p == key))
}

fn is_openrouter_reasoning_model_id(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    if id.ends_with(":thinking") {
        return true;
    }
    id.contains("/o1")
        || id.contains("/o3")
        || id.contains("/o4")
        || id.contains("-reasoning")
        || id.contains("/reasoning")
        || id.contains("-thinking")
        || id.contains("/thinking")
        || id.contains("-think")
        || id.contains("/think")
        || id.contains("-reasoner")
        || id.contains("/reasoner")
}

pub fn openrouter_supports_reasoning(
    model_id: &str,
    supported_parameters: Option<&[String]>,
) -> bool {
    openrouter_supported_has(supported_parameters, "reasoning")
        || openrouter_supported_has(supported_parameters, "include_reasoning")
        || is_openrouter_reasoning_model_id(model_id)
}

pub fn openrouter_supports_verbosity(supported_parameters: Option<&[String]>) -> bool {
    openrouter_supported_has(supported_parameters, "verbosity")
}

pub fn openrouter_supports_max_tokens(supported_parameters: Option<&[String]>) -> bool {
    openrouter_supported_has(supported_parameters, "max_tokens")
}

pub fn apply_openrouter_runtime_options(
    body: &mut serde_json::Value,
    model_id: &str,
    supported_parameters: Option<&[String]>,
    options: &OpenRouterRequestOptions,
) {
    if !options.has_any_runtime_param() {
        return;
    }
    let Some(map) = body.as_object_mut() else {
        return;
    };
    if let Some(effort) = options
        .reasoning_effort
        .as_deref()
        .filter(|_| openrouter_supports_reasoning(model_id, supported_parameters))
    {
        // `"off"` disables reasoning for models that allow toggling it
        // (`reasoning: { enabled: false }`); the graded levels ride the
        // OpenAI-style `effort` field. Models with mandatory reasoning ignore
        // the disable and keep reasoning — an upstream constraint, not ours.
        let reasoning = if effort == "off" {
            serde_json::json!({ "enabled": false })
        } else {
            serde_json::json!({ "effort": effort })
        };
        map.insert("reasoning".to_string(), reasoning);
    }
    if let Some(verbosity) = options
        .verbosity
        .as_deref()
        .filter(|_| openrouter_supports_verbosity(supported_parameters))
    {
        map.insert("verbosity".to_string(), serde_json::json!(verbosity));
    }
    if let Some(max_tokens) = options
        .max_output_tokens
        .filter(|_| openrouter_supports_max_tokens(supported_parameters))
    {
        map.insert("max_tokens".to_string(), serde_json::json!(max_tokens));
    }
}

/// Split an OpenRouter model selection (`model` or `model@provider`) into
/// (model_id, provider_slug). Mirrors parseModelSelection. The renderer
/// encodes the chosen provider as a `@`-suffixed slug.
pub fn parse_model_selection(selection: &str) -> (String, Option<String>) {
    match selection.rsplit_once('@') {
        Some((model, slug)) if !slug.is_empty() => (model.to_string(), Some(slug.to_string())),
        Some((model, _)) => (model.to_string(), None),
        _ => (selection.to_string(), None),
    }
}

// ───────────────────────── ollama endpoint ────────────────────────────
//
// Ported from ollama-endpoint.ts. Normalizes a user-entered endpoint
// (strips trailing /api, /v1, slashes) and builds an /api/<x> URL.

/// Normalize an Ollama endpoint: strip trailing slashes and any trailing
/// `/api` or `/v1` segments. Mirrors normalizeOllamaEndpoint.
pub fn normalize_ollama_endpoint(endpoint: &str) -> String {
    let mut s = endpoint.trim().trim_end_matches('/').to_string();
    loop {
        let lower = s.to_lowercase();
        if lower.ends_with("/api") {
            s.truncate(s.len() - 4);
        } else if lower.ends_with("/v1") {
            s.truncate(s.len() - 3);
        } else {
            break;
        }
        s = s.trim_end_matches('/').to_string();
    }
    s
}

/// Build an /api/<path> URL on the normalized endpoint. Mirrors buildOllamaApiUrl.
///
/// NOT SSRF-safe: this performs NO host validation — it interpolates whatever
/// `endpoint` it is given straight into the request URL. Callers MUST validate
/// or otherwise trust the host before using the result. Production code MUST
/// instead use `build_loopback_ollama_api_url`, which rejects any non-loopback
/// host (and credentials / non-http schemes) via `validate_loopback_ollama_endpoint`.
/// `pub(crate)` (not `pub`) so this can never become a public unvalidated entry point.
/// It currently has no production callers — only the unit test below exercises it — so it is
/// gated behind `#[cfg(test)]` to keep the unvalidated path out of the shipped binary entirely.
#[cfg(test)]
pub(crate) fn build_ollama_api_url(endpoint: &str, api_path: &str) -> String {
    let base = normalize_ollama_endpoint(endpoint);
    let path = if api_path.starts_with('/') {
        api_path.to_string()
    } else {
        format!("/{api_path}")
    };
    format!("{}{}", base.trim_end_matches('/'), path)
}

pub fn validate_loopback_ollama_endpoint(endpoint: &str) -> Result<String, String> {
    let normalized = normalize_ollama_endpoint(endpoint);
    if normalized.is_empty() {
        return Err("Ollama endpoint is required".to_string());
    }

    let url = reqwest::Url::parse(&normalized)
        .map_err(|_| "Ollama endpoint must be a valid http:// or https:// URL".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("Ollama endpoint must use http:// or https://".to_string()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Ollama endpoint must not include credentials".to_string());
    }
    let Some(host) = url.host_str() else {
        return Err("Ollama endpoint must include a loopback host".to_string());
    };
    if !is_loopback_ollama_host(host) {
        return Err("Ollama endpoint must point to localhost or a loopback IP".to_string());
    }
    Ok(normalized)
}

pub fn build_loopback_ollama_api_url(endpoint: &str, api_path: &str) -> Result<String, String> {
    let base = validate_loopback_ollama_endpoint(endpoint)?;
    let path = if api_path.starts_with('/') {
        api_path.to_string()
    } else {
        format!("/{api_path}")
    };
    Ok(format!("{}{}", base.trim_end_matches('/'), path))
}

fn is_loopback_ollama_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── openrouter helpers ──

    #[test]
    fn openrouter_extra_body_always_has_healing() {
        let body = openrouter_extra_body(None);
        assert_eq!(body["plugins"][0]["id"], "response-healing");
        assert!(body.get("provider").is_none());
    }

    #[test]
    fn openrouter_extra_body_pins_provider() {
        let body = openrouter_extra_body(Some("deepinfra"));
        assert_eq!(body["provider"]["order"][0], "deepinfra");
        assert_eq!(
            body["provider"]["allow_fallbacks"],
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn model_selection_splits_provider_slug() {
        assert_eq!(
            parse_model_selection("anthropic/claude@deepinfra"),
            (
                "anthropic/claude".to_string(),
                Some("deepinfra".to_string())
            )
        );
        assert_eq!(
            parse_model_selection("openrouter/auto"),
            ("openrouter/auto".to_string(), None)
        );
    }

    #[test]
    fn model_selection_preserves_empty_or_dangling_provider() {
        assert_eq!(parse_model_selection(""), ("".to_string(), None));
        assert_eq!(
            parse_model_selection("anthropic/claude@"),
            ("anthropic/claude".to_string(), None)
        );
    }

    #[test]
    fn openrouter_runtime_options_are_support_gated() {
        let supported = vec![
            "reasoning".to_string(),
            "verbosity".to_string(),
            "max_tokens".to_string(),
        ];
        let options = OpenRouterRequestOptions {
            reasoning_effort: Some("high".to_string()),
            verbosity: Some("low".to_string()),
            max_output_tokens: Some(512),
        };
        let mut body = serde_json::json!({ "model": "openai/o3-mini" });
        apply_openrouter_runtime_options(&mut body, "openai/o3-mini", Some(&supported), &options);

        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["verbosity"], "low");
        assert_eq!(body["max_tokens"], 512);

        let mut unsupported = serde_json::json!({ "model": "openai/gpt-4o" });
        apply_openrouter_runtime_options(&mut unsupported, "openai/gpt-4o", Some(&[]), &options);
        assert!(unsupported.get("reasoning").is_none());
        assert!(unsupported.get("verbosity").is_none());
        assert!(unsupported.get("max_tokens").is_none());
    }

    #[test]
    fn openrouter_reasoning_off_disables_reasoning() {
        // `"off"` turns into `reasoning: { enabled: false }`, never an effort.
        let supported = vec!["reasoning".to_string()];
        let options = OpenRouterRequestOptions {
            reasoning_effort: Some("off".to_string()),
            verbosity: None,
            max_output_tokens: None,
        };
        let mut body = serde_json::json!({ "model": "qwen/qwen3-thinking" });
        apply_openrouter_runtime_options(
            &mut body,
            "qwen/qwen3-thinking",
            Some(&supported),
            &options,
        );
        assert_eq!(body["reasoning"]["enabled"], serde_json::Value::Bool(false));
        assert!(body["reasoning"].get("effort").is_none());

        // A non-reasoning model drops it entirely — no spurious disable field.
        let mut plain = serde_json::json!({ "model": "openai/gpt-4o" });
        apply_openrouter_runtime_options(&mut plain, "openai/gpt-4o", Some(&[]), &options);
        assert!(plain.get("reasoning").is_none());
    }

    // ── ollama endpoint normalization ──

    #[test]
    fn normalize_strips_api_and_v1_and_slashes() {
        assert_eq!(
            normalize_ollama_endpoint("http://localhost:11434/api/"),
            "http://localhost:11434"
        );
        assert_eq!(
            normalize_ollama_endpoint("http://localhost:11434/v1"),
            "http://localhost:11434"
        );
        assert_eq!(
            normalize_ollama_endpoint("http://host/api/v1/"),
            "http://host"
        );
    }

    #[test]
    fn build_api_url_appends_path() {
        assert_eq!(
            build_ollama_api_url("http://localhost:11434/api", "/api/chat"),
            "http://localhost:11434/api/chat"
        );
    }

    #[test]
    fn loopback_endpoint_validation_allows_localhost_and_loopback_ips() {
        assert_eq!(
            validate_loopback_ollama_endpoint("http://localhost:11434/api").unwrap(),
            "http://localhost:11434"
        );
        assert!(validate_loopback_ollama_endpoint("http://127.0.0.1:11434").is_ok());
        assert!(validate_loopback_ollama_endpoint("http://[::1]:11434").is_ok());
    }

    #[test]
    fn loopback_endpoint_validation_rejects_remote_hosts() {
        assert!(validate_loopback_ollama_endpoint("https://example.com").is_err());
        assert!(validate_loopback_ollama_endpoint("http://192.168.1.10:11434").is_err());
        assert!(validate_loopback_ollama_endpoint("http://10.0.0.5:11434").is_err());
    }

    #[test]
    fn loopback_endpoint_validation_rejects_credentials_and_bad_schemes() {
        assert!(validate_loopback_ollama_endpoint("http://user:pass@localhost:11434").is_err());
        assert!(validate_loopback_ollama_endpoint("file://localhost/tmp").is_err());
        assert!(validate_loopback_ollama_endpoint("localhost:11434").is_err());
    }

    #[test]
    fn loopback_api_url_appends_path_after_validation() {
        assert_eq!(
            build_loopback_ollama_api_url("http://localhost:11434/v1/", "api/tags").unwrap(),
            "http://localhost:11434/api/tags"
        );
    }
}
