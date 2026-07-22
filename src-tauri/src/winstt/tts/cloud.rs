use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::types::{
    ChunkSink, SentenceAudio, SynthesisChunk, TtsEngine, TtsError, TtsResult, TtsSessionUsage,
    VoiceInfo, clamp_cloud_speed,
};

const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;

/// Best-effort USD per character for ElevenLabs TTS. ElevenLabs bills plan
/// credits (~1 credit/char on the multilingual models) and returns no billed
/// amount per request; this converts characters to dollars at the Creator-plan
/// effective rate ($22 / 100k credits) so History can show an ESTIMATED cost.
pub const ELEVENLABS_TTS_USD_PER_CHAR: f64 = 22.0 / 100_000.0;

// ---------------------------------------------------------------------------
// Cloud ElevenLabs engine (reqwest)
// ---------------------------------------------------------------------------

/// ElevenLabs voice-settings tuning, read from the encrypted store per call.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoiceSettings {
    pub stability: f32,
    pub similarity: f32,
    pub style: f32,
    pub speaker_boost: bool,
    pub speed: f32,
}

impl Default for CloudVoiceSettings {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity: 0.75,
            style: 0.0,
            speaker_boost: true,
            speed: 1.0,
        }
    }
}

/// Inputs for one cloud synthesis call.
#[derive(Clone, Debug)]
pub struct CloudSynthesisRequest {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub text: String,
    pub settings: CloudVoiceSettings,
}

pub const ELEVENLABS_TTS_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
pub const ELEVENLABS_VOICES_URL: &str = "https://api.elevenlabs.io/v2/voices?page_size=100";
pub const ELEVENLABS_SUBSCRIPTION_URL: &str = "https://api.elevenlabs.io/v1/user/subscription";
/// mp3 is the ONLY format available on every ElevenLabs tier (raw pcm 402s on free).
pub const CLOUD_OUTPUT_FORMAT: &str = "mp3_44100_128";

/// Build the JSON request body for `POST /v1/text-to-speech/{voice_id}`.
/// Field names are ElevenLabs' on-wire snake_case.
pub fn build_cloud_body(req: &CloudSynthesisRequest) -> serde_json::Value {
    serde_json::json!({
        "text": req.text,
        "model_id": req.model_id,
        "voice_settings": {
            "stability": req.settings.stability,
            "similarity_boost": req.settings.similarity,
            "style": req.settings.style,
            "use_speaker_boost": req.settings.speaker_boost,
            "speed": clamp_cloud_speed(req.settings.speed),
        }
    })
}

/// Full POST URL for a voice id, with the tier-safe output format.
pub fn build_cloud_url(voice_id: &str) -> String {
    format!("{ELEVENLABS_TTS_BASE}/{voice_id}?output_format={CLOUD_OUTPUT_FORMAT}")
}

/// Classify an ElevenLabs HTTP status + optional `detail.status` body field into
/// a human-readable reason. Mirrors `tts-cloud.ts` HTTP_STATUS_MESSAGE +
/// memory `project_elevenlabs_scoped_key_verify` (a scoped key missing
/// `voices_read` is NOT an invalid key).
pub fn classify_cloud_status(status: u16, detail_status: Option<&str>) -> String {
    let detail = detail_status.unwrap_or_default().to_ascii_lowercase();
    let detail = detail.as_str();

    if matches!(detail, "quota_exceeded" | "not_enough_credits")
        || detail.contains("quota")
        || detail.contains("credit")
    {
        return "ElevenLabs: character quota exceeded or credits exhausted".to_string();
    }
    if matches!(detail, "too_many_concurrent_requests") || detail.contains("concurrent") {
        return "ElevenLabs: too many concurrent requests".to_string();
    }
    if detail.contains("rate_limit") || detail.contains("too_many_requests") {
        return "ElevenLabs: rate limited".to_string();
    }
    if matches!(detail, "invalid_api_key" | "missing_api_key") || detail.contains("api_key") {
        return "ElevenLabs: invalid or missing API key".to_string();
    }
    if matches!(detail, "missing_permissions" | "forbidden") || detail.contains("permission") {
        return "ElevenLabs: this API key is missing a required permission".to_string();
    }
    if matches!(detail, "voice_not_found" | "model_not_found")
        || detail.contains("voice_not_found")
        || detail.contains("model_not_found")
    {
        return "ElevenLabs: selected voice not found or model is no longer available".to_string();
    }
    if matches!(
        detail,
        "invalid_voice_settings" | "invalid_request" | "value_error" | "string_pattern_mismatch"
    ) || detail.contains("validation")
        || detail.contains("invalid")
    {
        return "ElevenLabs: invalid TTS request".to_string();
    }
    if detail.contains("unusual_activity") || detail.contains("blocked") {
        return "ElevenLabs: account or request temporarily blocked".to_string();
    }

    match status {
        400 | 422 => "ElevenLabs: invalid TTS request".to_string(),
        401 | 403 => "ElevenLabs: invalid API key or missing required permission".to_string(),
        402 => "ElevenLabs: paid plan, quota, or credits do not allow this request".to_string(),
        404 => "ElevenLabs: selected voice not found or model is no longer available".to_string(),
        408 => "ElevenLabs: request timed out".to_string(),
        409 => "ElevenLabs: request conflicts with the current resource state".to_string(),
        429 => "ElevenLabs: rate limited".to_string(),
        s @ 500..=599 => format!("ElevenLabs: provider is temporarily unavailable (HTTP {s})"),
        s => format!("ElevenLabs error: HTTP {s}"),
    }
}

/// Typed ElevenLabs error envelope. `detail` arrives object-shaped, as a bare
/// string, as a FastAPI validation array, or not at all depending on the edge —
/// the untagged enum captures all three shapes so the classifier never walks
/// untyped `serde_json::Value`s.
#[derive(Debug, serde::Deserialize)]
struct ElevenLabsErrorBody {
    detail: Option<ErrorDetail>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum ErrorDetail {
    Object(ErrorDetailObject),
    Text(String),
    Items(Vec<ErrorDetailItem>),
}

#[derive(Debug, serde::Deserialize)]
struct ErrorDetailObject {
    status: Option<String>,
    message: Option<String>,
}

/// One FastAPI validation-array entry (`{"type", "msg"}` / `{"status", "message"}`).
#[derive(Debug, serde::Deserialize)]
struct ErrorDetailItem {
    status: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    msg: Option<String>,
    message: Option<String>,
}

fn parse_error_detail(body: &str) -> Option<ErrorDetail> {
    serde_json::from_str::<ElevenLabsErrorBody>(body)
        .ok()?
        .detail
}

/// Pull the `detail.status` discriminator out of an ElevenLabs error body, if
/// present.
pub fn parse_detail_status(body: &str) -> Option<String> {
    match parse_error_detail(body)? {
        ErrorDetail::Object(object) => object.status,
        ErrorDetail::Text(_) => None,
        ErrorDetail::Items(items) => items.into_iter().find_map(|item| item.status.or(item.kind)),
    }
}

pub fn parse_detail_message(body: &str) -> Option<String> {
    match parse_error_detail(body)? {
        ErrorDetail::Object(object) => object.message,
        ErrorDetail::Text(message) => Some(message),
        ErrorDetail::Items(items) => items.into_iter().find_map(|item| item.msg.or(item.message)),
    }
}

pub fn classify_cloud_error_body(status: u16, body: &str) -> String {
    let detail_status = parse_detail_status(body);
    let detail_message = parse_detail_message(body);
    let mut message = classify_cloud_status(status, detail_status.as_deref());
    if let Some(detail_message) = detail_message {
        let detail_message = detail_message.trim();
        if !detail_message.is_empty() {
            message.push_str(": ");
            message.push_str(detail_message);
        }
    }
    message
}
/// One live ElevenLabs voice (from `/v2/voices`). Surfaced to the renderer
/// cloud-voice picker (includes the account's cloned voices).
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub category: Option<String>,
    pub preview_url: Option<String>,
}

/// Typed `/v2/voices` response. Entries are held as raw values and decoded
/// per-entry so one malformed voice is skipped instead of discarding the whole
/// catalog (parity with the old lenient hand-walk).
#[derive(Debug, serde::Deserialize)]
struct VoicesResponse {
    #[serde(default)]
    voices: Vec<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct VoiceEntry {
    voice_id: String,
    #[serde(default)]
    name: String,
    labels: Option<VoiceLabels>,
    category: Option<String>,
    preview_url: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct VoiceLabels {
    language: Option<String>,
}

impl From<VoiceEntry> for CloudVoice {
    fn from(entry: VoiceEntry) -> Self {
        Self {
            id: entry.voice_id,
            name: entry.name,
            language: entry.labels.and_then(|labels| labels.language),
            category: entry.category,
            preview_url: entry.preview_url,
        }
    }
}

/// Parse a `/v2/voices` JSON body into `CloudVoice`s.
pub fn parse_cloud_voices(body: &str) -> Vec<CloudVoice> {
    let response: VoicesResponse = match serde_json::from_str(body) {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    response
        .voices
        .into_iter()
        .filter_map(|entry| serde_json::from_value::<VoiceEntry>(entry).ok())
        .map(CloudVoice::from)
        .collect()
}

/// Cloud engine. `synthesize_sentence` POSTs `build_cloud_body` via reqwest and
/// returns the mp3 bytes as ONE chunk (ElevenLabs convert is one-shot).
///
/// Uses the async `reqwest::Client` driven by `tauri::async_runtime::block_on`
/// (the existing reqwest dep has no `blocking` feature; the command layer runs
/// every cloud call on a `spawn_blocking` worker so blocking here is safe).
pub struct ElevenLabsEngine {
    client: reqwest::Client,
    api_key: String,
    model_id: String,
    settings: CloudVoiceSettings,
    ready: AtomicBool,
    /// Per-session billing telemetry (characters + estimated USD) drained by
    /// the manager via `take_session_usage` after each read-aloud.
    usage: Mutex<TtsSessionUsage>,
}

impl ElevenLabsEngine {
    pub fn new(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        let ready = AtomicBool::new(!api_key.is_empty());
        Self {
            // Shared pooled client (cheap Arc clone): engines are rebuilt on
            // settings changes, and per-engine pools would re-handshake TLS to
            // api.elevenlabs.io every time.
            client: crate::winstt::net::http_client().clone(),
            api_key,
            model_id,
            settings,
            ready,
            usage: Mutex::new(TtsSessionUsage::default()),
        }
    }

    /// Fetch the live `/v2/voices` list (includes cloned voices). The host calls
    /// this for the cloud-voice picker (not via `list_voices`, which is static).
    pub fn fetch_voices(&self) -> TtsResult<Vec<CloudVoice>> {
        use tauri::async_runtime::block_on;
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        let fetch = async {
            let resp = self
                .client
                .get(ELEVENLABS_VOICES_URL)
                .header("xi-api-key", &self.api_key)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices request failed: {e}")))?;
            let status = resp.status().as_u16();
            let body = resp
                .text()
                .await
                .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices read failed: {e}")))?;
            if !(200..300).contains(&status) {
                return Err(TtsError::Cloud(classify_cloud_error_body(status, &body)));
            }
            Ok(parse_cloud_voices(&body))
        };
        block_on(crate::winstt::cloud_metrics::timed(
            "elevenlabs",
            "tts_voices",
            fetch,
            |e: &TtsError| e.to_string(),
        ))
    }

    /// Fetch a CDN preview mp3 for a voice (no character credits). Refuses any
    /// non-https URL and local/private destinations (trust-boundary check).
    pub fn fetch_preview(&self, preview_url: &str) -> TtsResult<Vec<u8>> {
        use tauri::async_runtime::block_on;
        let url = validate_preview_url(preview_url).map_err(TtsError::Cloud)?;
        // No-redirect client: a redirect would bypass validate_preview_url's
        // host/IP trust-boundary check.
        let client = crate::winstt::net::no_redirect_client().map_err(TtsError::Cloud)?;
        let fetch = async {
            let resp = client
                .get(url)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| TtsError::Cloud(format!("preview fetch failed: {e}")))?;
            if !resp.status().is_success() {
                return Err(TtsError::Cloud(format!("preview HTTP {}", resp.status())));
            }
            if resp
                .content_length()
                .is_some_and(|len| len > MAX_PREVIEW_BYTES as u64)
            {
                return Err(TtsError::Cloud("preview clip is too large".into()));
            }
            read_preview_limited(resp).await
        };
        block_on(crate::winstt::cloud_metrics::timed(
            "elevenlabs",
            "tts_preview",
            fetch,
            |e: &TtsError| e.to_string(),
        ))
    }
}

pub fn validate_preview_url(preview_url: &str) -> Result<reqwest::Url, String> {
    use std::net::ToSocketAddrs;

    let url = reqwest::Url::parse(preview_url).map_err(|_| "invalid preview url".to_string())?;
    if url.scheme() != "https" {
        return Err("refusing non-https preview url".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("refusing preview url with credentials".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "preview url has no host".to_string())?;
    if is_blocked_host_name(host) {
        return Err("refusing local preview url host".to_string());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "preview url has no port".to_string())?;
    let mut resolved_any = false;
    for addr in (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("preview host resolution failed: {e}"))?
    {
        resolved_any = true;
        if !is_public_ip(addr.ip()) {
            return Err("refusing local or private preview url address".to_string());
        }
    }
    if !resolved_any {
        return Err("preview host resolved to no addresses".to_string());
    }
    Ok(url)
}

async fn read_preview_limited(resp: reqwest::Response) -> TtsResult<Vec<u8>> {
    use futures_util::StreamExt;

    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| TtsError::Cloud(format!("preview read failed: {e}")))?;
        if out.len().saturating_add(chunk.len()) > MAX_PREVIEW_BYTES {
            return Err(TtsError::Cloud("preview clip is too large".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
}

fn is_documentation_ipv4(ip: std::net::Ipv4Addr) -> bool {
    matches!(
        ip.octets(),
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}

fn is_documentation_ipv6(ip: std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0x2001 && segments[1] == 0x0db8
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || is_documentation_ipv4(ip))
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(mapped));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || is_documentation_ipv6(ip))
        }
    }
}

impl ElevenLabsEngine {
    /// Build the per-call synthesis request, or `Ok(None)` for empty text (which
    /// renders as an empty mp3 chunk). `Err` on a missing key / voice.
    fn build_synthesis_request(
        &self,
        text: &str,
        voice: &str,
        speed: f32,
    ) -> TtsResult<Option<CloudSynthesisRequest>> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        if voice.is_empty() {
            return Err(TtsError::Cloud("No ElevenLabs voice selected".into()));
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(CloudSynthesisRequest {
            api_key: self.api_key.clone(),
            voice_id: voice.to_string(),
            model_id: self.model_id.clone(),
            text: trimmed.to_string(),
            settings: CloudVoiceSettings {
                speed: clamp_cloud_speed(speed),
                ..self.settings.clone()
            },
        }))
    }

    /// One-shot ElevenLabs convert -> mp3 bytes. Async so it can be raced against a
    /// cancel signal: dropping this future aborts the in-flight reqwest POST.
    async fn fetch_mp3(&self, req: &CloudSynthesisRequest, voice: &str) -> TtsResult<Vec<u8>> {
        crate::winstt::cloud_metrics::timed(
            "elevenlabs",
            "tts_speech",
            self.fetch_mp3_inner(req, voice),
            |e: &TtsError| e.to_string(),
        )
        .await
    }

    async fn fetch_mp3_inner(
        &self,
        req: &CloudSynthesisRequest,
        voice: &str,
    ) -> TtsResult<Vec<u8>> {
        let resp = self
            .client
            .post(build_cloud_url(voice))
            .header("xi-api-key", &self.api_key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&build_cloud_body(req))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs request failed: {e}")))?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let body = resp.text().await.unwrap_or_default();
            return Err(TtsError::Cloud(classify_cloud_error_body(status, &body)));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs read failed: {e}")))?
            .to_vec();
        // Billing telemetry: ElevenLabs returns no billed amount, so
        // accumulate the characters synthesized and the published-rate
        // estimate for the manager's History row.
        if let Ok(mut usage) = self.usage.lock() {
            let characters = req.text.chars().count() as i64;
            usage.characters += characters;
            usage.estimated_cost_usd += characters as f64 * ELEVENLABS_TTS_USD_PER_CHAR;
        }
        Ok(bytes)
    }
}

impl TtsEngine for ElevenLabsEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        use tauri::async_runtime::block_on;
        match self.build_synthesis_request(text, voice, speed)? {
            None => Ok(SentenceAudio::Mp3 { bytes: Vec::new() }),
            Some(req) => {
                let bytes = block_on(self.fetch_mp3(&req, voice))?;
                Ok(SentenceAudio::Mp3 { bytes })
            }
        }
    }

    /// Cloud override of the default wrapper: race the in-flight POST against the
    /// sink's cancel token (fired by `tts_cancel` / `cancel_all` -- the TTS island
    /// X or the dictation overlay X). On cancel the request future is dropped,
    /// which aborts the ElevenLabs HTTP call mid-flight instead of only stopping
    /// the next sentence.
    fn synthesize_stream(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        use tauri::async_runtime::block_on;
        let bytes = match self.build_synthesis_request(text, voice, speed)? {
            None => Vec::new(),
            Some(req) => {
                let cancel = sink.cancel_token();
                block_on(async {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => Err(TtsError::Cancelled),
                        res = self.fetch_mp3(&req, voice) => res,
                    }
                })?
            }
        };
        sink.push(SynthesisChunk::mp3(bytes, 0, false));
        Ok(())
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        // Cloud voices come from a live GET /v2/voices fetch, not the static catalog.
        Vec::new()
    }

    fn take_session_usage(&self) -> Option<TtsSessionUsage> {
        let mut usage = self.usage.lock().ok()?;
        let taken = std::mem::take(&mut *usage);
        if taken.is_empty() { None } else { Some(taken) }
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn warm_up(&self) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        Ok(())
    }

    fn shutdown(&self) {
        self.ready.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_preview_url_rejects_non_https() {
        let err = validate_preview_url("http://example.com/preview.mp3").unwrap_err();
        assert_eq!(err, "refusing non-https preview url");
    }

    #[test]
    fn validate_preview_url_rejects_loopback_and_private_hosts() {
        assert_eq!(
            validate_preview_url("https://localhost/preview.mp3").unwrap_err(),
            "refusing local preview url host"
        );
        assert_eq!(
            validate_preview_url("https://127.0.0.1/preview.mp3").unwrap_err(),
            "refusing local or private preview url address"
        );
        assert_eq!(
            validate_preview_url("https://10.0.0.2/preview.mp3").unwrap_err(),
            "refusing local or private preview url address"
        );
    }

    #[test]
    fn validate_preview_url_allows_public_https_ip_literal() {
        let url = validate_preview_url("https://8.8.8.8/preview.mp3").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("8.8.8.8"));
    }

    #[test]
    fn classify_elevenlabs_empty_400_body() {
        let message = classify_cloud_error_body(400, "");
        assert!(message.contains("invalid"));
    }

    #[test]
    fn classify_elevenlabs_validation_array_body() {
        let body = r#"{"detail":[{"type":"string_pattern_mismatch","msg":"String should match pattern"}]}"#;
        let message = classify_cloud_error_body(422, body);
        assert!(message.contains("invalid"));
        assert!(message.contains("String should match pattern"));
    }

    #[test]
    fn classify_elevenlabs_quota_detail_status() {
        let body = r#"{"detail":{"status":"quota_exceeded","message":"quota reached"}}"#;
        let message = classify_cloud_error_body(429, body);
        assert!(message.contains("quota"));
        assert!(message.contains("quota reached"));
    }
}
