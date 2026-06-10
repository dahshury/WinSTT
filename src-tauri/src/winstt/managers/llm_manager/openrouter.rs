// Self-contained OpenRouter provider: catalog model structs, the per-model
// `supported_parameters` cache, the structured-output chat stream, the catalog
// scan, and all the free parsers. The only cross-provider link is
// `scan_openrouter` feeding the param cache. A fourth `impl LlmManager` block
// sharing the struct's private fields.

use super::{EmitReasoningSink, LlmManager};
use crate::winstt::llm::{
    self, apply_openrouter_runtime_options, OpenRouterRequestOptions, ReasoningSink,
};

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
    pub supported_voices: Option<Vec<String>>,
    /// Per-provider hosting endpoints, filled by the catalog scan's concurrency-
    /// capped `/endpoints` fan-out (the picker's provider rail / pricing / quant /
    /// feature chips). `None` until enriched; a soft fetch failure leaves it `None`.
    pub endpoints: Option<Vec<OpenRouterEndpointInfo>>,
}

/// One hosting endpoint for an OpenRouter model (from
/// `/api/v1/models/{author}/{slug}/endpoints`). Field names mirror the picker
/// contract (`OpenRouterEndpoint`) one-for-one. `pricing` stays opaque JSON like
/// the model-level `pricing`.
#[derive(Clone, Debug, Default)]
pub struct OpenRouterEndpointInfo {
    pub name: String,
    pub model_name: String,
    pub context_length: i64,
    pub pricing: serde_json::Value,
    pub provider_name: String,
    pub tag: String,
    pub max_completion_tokens: Option<i64>,
    pub supported_parameters: Option<Vec<String>>,
    pub quantization: Option<String>,
    pub status: Option<i64>,
    pub uptime_last_30m: Option<f64>,
}

pub struct OpenRouterScan {
    pub reachable: bool,
    pub models: Vec<OpenRouterModelInfo>,
    pub error: Option<String>,
}

/// Max in-flight `/endpoints` detail requests during catalog enrichment. Mirrors
/// `OPENROUTER_ENRICHMENT_CONCURRENCY` in llm.ts — the full catalog is 300+ models
/// so an uncapped fan-out would hammer OpenRouter into 429s.
const OPENROUTER_ENRICHMENT_CONCURRENCY: usize = 10;

fn openrouter_models_url(output_modality: Option<&str>) -> reqwest::Url {
    let mut url = reqwest::Url::parse("https://openrouter.ai/api/v1/models")
        .expect("static OpenRouter models URL is valid");
    if let Some(modality) = output_modality {
        url.query_pairs_mut()
            .append_pair("output_modalities", modality);
    }
    url
}

impl LlmManager {
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

    /// Run a dictation/transform over OpenRouter's OpenAI-compatible
    /// `/api/v1/chat/completions`. `api_key` is the stored OpenRouter key,
    /// `selection` is the `model[@providerSlug]` picker value (`""` → auto).
    /// Requests a `{ "text": "..." }` JSON object via `response_format` so the
    /// answer is plain transformed text, then extracts the `text` field.
    /// Mirrors `processWithOpenRouter` (structured output via generateObject).
    /// Returns the cleaned text, or the fallback on any failure.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the OpenRouter request surface + the optional reasoning-delta sink"
    )]
    pub async fn openrouter_chat(
        &self,
        api_key: &str,
        selection: &str,
        system_prompt: &str,
        user_prompt: &str,
        fallback: &str,
        options: OpenRouterRequestOptions,
        request_id: Option<&str>,
    ) -> Result<String, String> {
        use genai::chat::{ChatMessage, ChatOptions, ChatRequest, JsonSpec};

        if api_key.is_empty() {
            return Err("OpenRouter API key is required".to_string());
        }
        let (model_id, provider_slug) = llm::parse_model_selection(selection);
        let model = if model_id.is_empty() {
            "openrouter/auto".to_string()
        } else {
            model_id
        };

        // Non-standard OpenRouter request fields ride genai's `extra_body`, which
        // the OpenAI-compat adapter merges verbatim into the payload — so the wire
        // shape stays identical to the old hand-built body: `reasoning {effort}`,
        // `verbosity`, `max_tokens` (each individually support-gated against the
        // per-model `supported_parameters` cache), plus the response-healing
        // plugin and the optional hard provider pin.
        let mut extra = serde_json::json!({});
        let supported_parameters = self
            .openrouter_supported_parameters(api_key, &model, &options)
            .await;
        apply_openrouter_runtime_options(
            &mut extra,
            &model,
            supported_parameters.as_deref(),
            &options,
        );
        if let serde_json::Value::Object(ref mut map) = extra {
            let eb = llm::openrouter_extra_body(provider_slug.as_deref());
            if let Some(plugins) = eb.get("plugins") {
                map.insert("plugins".to_string(), plugins.clone());
            }
            if let Some(provider) = eb.get("provider") {
                map.insert("provider".to_string(), provider.clone());
            }
        }

        // Strict `{ "text": "..." }` structured-output envelope (mirrors
        // generateObject); extract_openrouter_text parses it after the stream.
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"],
            "additionalProperties": false
        });

        let request = ChatRequest::new(vec![ChatMessage::user(user_prompt.to_string())])
            .with_system(system_prompt.to_string());

        let mut chat_options = ChatOptions::default()
            .with_temperature(0.3)
            .with_response_format(JsonSpec::new("TransformedText", schema))
            .with_capture_usage(true)
            .with_extra_headers([
                ("HTTP-Referer", "https://github.com/dahshury/WinSTT"),
                ("X-Title", "WinSTT"),
            ]);
        if extra.as_object().is_some_and(|m| !m.is_empty()) {
            chat_options = chat_options.with_extra_body(extra);
        }

        let target = crate::cloud_llm::service_target(
            genai::adapter::AdapterKind::OpenAI,
            "https://openrouter.ai/api/v1",
            api_key,
            &model,
        );

        // Stream the answer; forward reasoning/thinking deltas to the pill via the
        // `llm:reasoning-delta` event when a request id is supplied (dictation +
        // preview). The structured `{text}` envelope is accumulated across content
        // chunks and parsed at the end exactly as before.
        let sink = request_id.map(|rid| EmitReasoningSink {
            app: self.app.clone(),
            request_id: rid.to_string(),
        });
        // Awaitable cancel: cancel_all() (overlay X / model swap) or cancel(id)
        // fires this token, and run_chat_stream drops the genai stream to abort
        // the in-flight HTTP request mid-flight. No request id → never cancels.
        let cancel = match request_id {
            Some(rid) => self.cancelled.cancel_token(rid),
            None => tokio_util::sync::CancellationToken::new(),
        };
        let result = crate::cloud_llm::run_chat_stream(
            target,
            request,
            chat_options,
            cancel.clone(),
            |delta| {
                if let Some(sink) = sink.as_ref() {
                    sink.on_delta(delta);
                }
            },
        )
        .await;
        if let Some(rid) = request_id {
            self.cancelled.clear(rid);
        }
        if cancel.is_cancelled() {
            return Err(llm::OPENROUTER_CANCELLED.to_string());
        }
        let (content, _tokens) = result?;

        Ok(extract_openrouter_text(&content, fallback))
    }

    /// Scan the default OpenRouter text catalog (`GET /api/v1/models`) with the
    /// stored key. Returns `(reachable, models, error)`. Models carry
    /// id/name/description/context_length/pricing/maker/model_name/variant/
    /// architecture/supported_parameters so the picker rows render. This is the
    /// LEAN scan (no `/endpoints` fan-out); `scan_openrouter_enriched` adds that
    /// for the picker, while the in-chat lazy `supported_parameters` lookup uses
    /// this lean path.
    pub async fn scan_openrouter(&self, api_key: &str) -> OpenRouterScan {
        self.scan_openrouter_with_output_modality(api_key, None)
            .await
    }

    async fn scan_openrouter_with_output_modality(
        &self,
        api_key: &str,
        output_modality: Option<&str>,
    ) -> OpenRouterScan {
        let mut rb = self
            .client
            .get(openrouter_models_url(output_modality))
            .timeout(std::time::Duration::from_secs(15))
            .header("HTTP-Referer", "https://github.com/dahshury/WinSTT")
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

    /// The transcription subset of the catalog. REUSES the lean `scan_openrouter`
    /// fetch + parse (NO second HTTP path / no duplicate parser) and just keeps
    /// the rows whose `architecture.output_modalities` advertises `transcription`
    /// — the dedicated `/audio/transcriptions`-capable models the cloud STT
    /// picker offers. The command maps these to lean `{id,name}` rows.
    pub async fn scan_openrouter_transcription(&self, api_key: &str) -> OpenRouterScan {
        let mut scan = self
            .scan_openrouter_with_output_modality(api_key, Some("transcription"))
            .await;
        if scan.error.is_none() {
            scan.models.retain(model_outputs_transcription);
        }
        scan
    }

    /// Transcription scan plus per-model `/endpoints` enrichment. The STT
    /// catalog is small compared with the full text catalog, so enriching it is
    /// cheap and lets the cloud STT picker show OpenRouter's provider choices
    /// when the endpoint detail API exposes them.
    pub async fn scan_openrouter_transcription_enriched(&self, api_key: &str) -> OpenRouterScan {
        let mut scan = self.scan_openrouter_transcription(api_key).await;
        if scan.error.is_none() && !scan.models.is_empty() {
            self.enrich_models_with_endpoints(api_key, &mut scan.models)
                .await;
        }
        scan
    }

    /// The speech (TTS) subset of the catalog. Like `scan_openrouter_transcription`
    /// but keeps `output_modalities ∋ "speech"` rows — the dedicated
    /// `/audio/speech` models the cloud TTS picker offers. The speech models are
    /// NOT present in the default `/models` listing — they surface only under the
    /// server-side `?output_modalities=speech` filter — so this MUST pass the
    /// modality query (mirrors `scan_openrouter_transcription`). Filtering the
    /// unfiltered full catalog client-side returns ZERO rows (the bug this fixes:
    /// the picker stayed permanently disabled with no voices). The client-side
    /// `retain` stays as defense-in-depth, identical to the transcription path.
    pub async fn scan_openrouter_speech(&self, api_key: &str) -> OpenRouterScan {
        let mut scan = self
            .scan_openrouter_with_output_modality(api_key, Some("speech"))
            .await;
        if scan.error.is_none() {
            scan.models.retain(model_outputs_speech);
        }
        scan
    }

    /// Catalog scan + per-model `/endpoints` enrichment. Used by the picker
    /// (`openrouter_refresh_models`); the lean `scan_openrouter` (no fan-out) backs
    /// the in-chat lazy `supported_parameters` lookup so a dictation never fires
    /// 300+ endpoint requests.
    pub async fn scan_openrouter_enriched(&self, api_key: &str) -> OpenRouterScan {
        let mut scan = self.scan_openrouter(api_key).await;
        if scan.error.is_none() && !scan.models.is_empty() {
            self.enrich_models_with_endpoints(api_key, &mut scan.models)
                .await;
        }
        scan
    }

    /// Fan out `/api/v1/models/{author}/{slug}/endpoints` (capped at
    /// [`OPENROUTER_ENRICHMENT_CONCURRENCY`]) to fill each model's `endpoints[]`
    /// and upgrade its truncated listing description. Each fetch fails soft, so a
    /// single 429/timeout leaves that model un-enriched rather than erroring the
    /// scan. Mirrors `enrichOpenRouterModelsWithEndpoints`.
    async fn enrich_models_with_endpoints(
        &self,
        api_key: &str,
        models: &mut [OpenRouterModelInfo],
    ) {
        use futures_util::StreamExt;

        let work: Vec<(usize, String, String)> = models
            .iter()
            .enumerate()
            .filter_map(|(i, m)| parse_model_id_for_detail(&m.id).map(|(a, s)| (i, a, s)))
            .collect();
        if work.is_empty() {
            return;
        }

        let details: Vec<(usize, Option<String>, Vec<OpenRouterEndpointInfo>)> =
            futures_util::stream::iter(work)
                .map(|(index, author, slug)| {
                    let client = self.client.clone();
                    let key = api_key.to_string();
                    async move {
                        let (desc, eps) =
                            fetch_model_endpoints(&client, &key, &author, &slug).await;
                        (index, desc, eps)
                    }
                })
                .buffer_unordered(OPENROUTER_ENRICHMENT_CONCURRENCY)
                .collect()
                .await;

        for (index, desc, eps) in details {
            if !eps.is_empty() {
                models[index].endpoints = Some(eps);
            }
            if let Some(desc) = desc {
                models[index].description =
                    pick_longer_description(models[index].description.as_deref(), &desc);
            }
        }
    }
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

/// True when a parsed catalog row advertises `transcription` in
/// `architecture.output_modalities` — i.e. it's served by OpenRouter's dedicated
/// `/audio/transcriptions` endpoint. Operates on the already-parsed
/// [`OpenRouterModelInfo`] (whose `architecture` is the raw JSON object) so the
/// transcription scan reuses `scan_openrouter`'s fetch + parse rather than a
/// second pass. A row with no `output_modalities` array is excluded (we're
/// filtering the FULL catalog, so unknown ⇒ not a transcription model).
fn model_outputs_transcription(m: &OpenRouterModelInfo) -> bool {
    model_outputs(m, "transcription")
}

/// True when a parsed catalog row advertises `speech` in
/// `architecture.output_modalities` — i.e. it's a `/audio/speech` (TTS) model.
fn model_outputs_speech(m: &OpenRouterModelInfo) -> bool {
    model_outputs(m, "speech")
}

fn model_outputs(m: &OpenRouterModelInfo, modality: &str) -> bool {
    m.architecture
        .as_ref()
        .and_then(|a| a.get("output_modalities"))
        .and_then(|o| o.as_array())
        .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some(modality)))
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
        supported_voices: m
            .get("supported_voices")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            }),
        endpoints: None,
    })
}

/// Split a model id (`author/slug` or `author/slug:variant`) into the parts
/// needed for the `/models/{author}/{slug}/endpoints` URL. `None` when the id
/// lacks both an author and a slug (`openrouter/auto`, malformed ids → no detail
/// page). Mirrors `parseModelIdForDetail`.
fn parse_model_id_for_detail(id: &str) -> Option<(String, String)> {
    let author_slug = id.split(':').next().filter(|s| !s.is_empty())?;
    let parts: Vec<&str> = author_slug.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    let author = parts[0];
    let slug = parts[1..].join("/");
    if author.is_empty() || slug.is_empty() {
        return None;
    }
    Some((author.to_string(), slug))
}

/// Prefer the fuller description: the listing blurb is often truncated (trailing
/// `...`/`…`); the `/endpoints` detail carries the complete one. Mirrors
/// `pickLongerDescription` — prefer the non-truncated, else the longer string.
fn pick_longer_description(listing: Option<&str>, detail: &str) -> Option<String> {
    let Some(listing) = listing else {
        return Some(detail.to_string());
    };
    if detail.is_empty() {
        return Some(listing.to_string());
    }
    let truncated = |s: &str| s.ends_with("...") || s.ends_with('…');
    let pick = if truncated(listing) && !truncated(detail) {
        detail
    } else if truncated(detail) && !truncated(listing) {
        listing
    } else if detail.len() > listing.len() {
        detail
    } else {
        listing
    };
    Some(pick.to_string())
}

/// Parse the `{ data: { description?, endpoints? } }` per-model endpoints payload.
/// Mirrors `openRouterEndpointsResponseSchema`.
fn parse_openrouter_endpoints_detail(
    json: &serde_json::Value,
) -> (Option<String>, Vec<OpenRouterEndpointInfo>) {
    let data = json.get("data");
    let description = data
        .and_then(|d| d.get("description"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let endpoints = data
        .and_then(|d| d.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|arr| arr.iter().filter_map(parse_openrouter_endpoint).collect())
        .unwrap_or_default();
    (description, endpoints)
}

/// Parse one endpoint row. Mirrors `openRouterEndpointSchema`. Requires `name`;
/// other fields default so a slightly-off row still renders rather than dropping.
fn parse_openrouter_endpoint(m: &serde_json::Value) -> Option<OpenRouterEndpointInfo> {
    let name = str_field(m, "name")?;
    Some(OpenRouterEndpointInfo {
        name,
        model_name: str_field(m, "model_name").unwrap_or_default(),
        context_length: m
            .get("context_length")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        pricing: m
            .get("pricing")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        provider_name: str_field(m, "provider_name").unwrap_or_default(),
        tag: str_field(m, "tag").unwrap_or_default(),
        max_completion_tokens: m
            .get("max_completion_tokens")
            .and_then(serde_json::Value::as_i64),
        supported_parameters: m
            .get("supported_parameters")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            }),
        quantization: str_field(m, "quantization"),
        status: m.get("status").and_then(serde_json::Value::as_i64),
        uptime_last_30m: m.get("uptime_last_30m").and_then(serde_json::Value::as_f64),
    })
}

/// Fetch one model's `/endpoints` detail. Fails soft (returns `(None, [])`) on any
/// transport/HTTP/parse error so a single 429 never blanks the catalog.
async fn fetch_model_endpoints(
    client: &reqwest::Client,
    api_key: &str,
    author: &str,
    slug: &str,
) -> (Option<String>, Vec<OpenRouterEndpointInfo>) {
    let url = format!("https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints");
    let mut rb = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .header("HTTP-Referer", "https://github.com/dahshury/WinSTT")
        .header("X-Title", "WinSTT");
    if !api_key.is_empty() {
        rb = rb.bearer_auth(api_key);
    }
    let Ok(resp) = rb.send().await else {
        return (None, Vec::new());
    };
    if !resp.status().is_success() {
        return (None, Vec::new());
    }
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return (None, Vec::new());
    };
    parse_openrouter_endpoints_detail(&json)
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
            return fallback.to_string();
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
    fn transcription_catalog_uses_output_modality_query() {
        assert_eq!(
            openrouter_models_url(None).as_str(),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            openrouter_models_url(Some("transcription")).as_str(),
            "https://openrouter.ai/api/v1/models?output_modalities=transcription"
        );
    }

    #[test]
    fn transcription_filter_reuses_catalog_parse() {
        // The transcription scan reuses `parse_openrouter_models` (the LLM fetch)
        // and keeps only `output_modalities: ["transcription"]` rows. Filtering the
        // FULL catalog, a non-transcription model (text out) and an architecture-less
        // row are both dropped.
        let json = serde_json::json!({
            "data": [
                {
                    "id": "microsoft/mai-transcribe-1.5",
                    "name": "Microsoft: MAI-Transcribe 1.5",
                    "architecture": {
                        "input_modalities": ["audio"],
                        "output_modalities": ["transcription"]
                    }
                },
                {
                    "id": "openai/gpt-4o",
                    "name": "GPT-4o",
                    "architecture": { "output_modalities": ["text"] }
                },
                { "id": "some/no-arch-model", "name": "No Arch" }
            ]
        });
        let mut models = parse_openrouter_models(&json);
        models.retain(model_outputs_transcription);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["microsoft/mai-transcribe-1.5"]);
        assert_eq!(models[0].name, "Microsoft: MAI-Transcribe 1.5");
    }

    #[test]
    fn speech_filter_keeps_supported_voices() {
        let json = serde_json::json!({
            "data": [
                {
                    "id": "microsoft/mai-voice-2",
                    "name": "Microsoft: MAI-Voice-2",
                    "architecture": {
                        "input_modalities": ["text"],
                        "output_modalities": ["speech"]
                    },
                    "supported_voices": [
                        "en-US-Harper:MAI-Voice-2",
                        "es-MX-Valeria:MAI-Voice-2"
                    ]
                },
                {
                    "id": "openai/gpt-4o",
                    "name": "GPT-4o",
                    "architecture": { "output_modalities": ["text"] }
                }
            ]
        });
        let mut models = parse_openrouter_models(&json);
        models.retain(model_outputs_speech);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "microsoft/mai-voice-2");
        let voices = models[0].supported_voices.as_ref().expect("voices");
        assert_eq!(
            voices,
            &vec![
                "en-US-Harper:MAI-Voice-2".to_string(),
                "es-MX-Valeria:MAI-Voice-2".to_string(),
            ]
        );
    }

    #[test]
    fn empty_structured_text_uses_fallback_without_leaking_json() {
        assert_eq!(extract_openrouter_text(r#"{"text":""}"#, ""), "");
        assert_eq!(
            extract_openrouter_text(r#"{"text":""}"#, "original text"),
            "original text"
        );
    }
}
