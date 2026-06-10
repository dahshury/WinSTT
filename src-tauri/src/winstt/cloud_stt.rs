// Cloud STT pure layer. Source: frontend/electron/ipc/stt-cloud.ts +
// frontend/electron/ipc/credentials.ts + entities/cloud-stt-provider/model/catalog.ts.
//
// Cloud STT: reqwest JSON+base64 POST to OpenRouter /audio/transcriptions and
// multipart POST to ElevenLabs /v1/speech-to-text. In WinSTT-the reference the Python pipeline's
// RemoteTranscriber adapter sends the WAV bytes to the main process over WS;
// in the Rust/Tauri port there is NO Python and NO WS â€” the
// TranscriptionManager calls `CloudSttManager::transcribe` directly when the
// active model is a cloud model (`openrouter:*` / `elevenlabs:*`). This module exposes the
// pure classification + request-shape layer, and the upload itself lives in
// `managers::CloudSttManager`.
//
// Ported faithfully:
//   - Provider audio byte limits (bail BEFORE the upload). [PROVIDER_AUDIO_LIMIT_BYTES]
//   - HTTP-status â†’ typed error code taxonomy. [HTTP_STATUS_ERROR_CODE]
//   - ElevenLabs scoped-key 401 `missing_permissions` = VALID auth, not a bad
//     key. [isElevenLabsScopedKeyValid / credentials.ts]
//   - retry-after parsing for rate limits.
//   - per-call provider instance (key reflects current store value).
//   - the `<provider>:<id>` model-id convention (settings_schema ModelSettings.model)
//     and the curated cloud catalog the picker renders. [CLOUD_CATALOG / catalog.ts]

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// Cloud STT providers. Mirrors `CloudSttProvider`.
///
/// OpenAI was removed as a direct cloud STT provider â€” its transcription models
/// (whisper-1 / gpt-4o-transcribe) are all served by OpenRouter as `openai/*`,
/// so the direct integration was redundant. ElevenLabs stays (its Scribe model
/// is NOT on OpenRouter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudSttProvider {
    ElevenLabs,
    /// OpenRouter's dedicated transcription endpoint (`/api/v1/audio/transcriptions`).
    /// Unlike ElevenLabs the model list is DYNAMIC (fetched + filtered by
    /// `output_modalities=transcription`) and the key is shared with the LLM
    /// post-process path (`settings.llm.openrouter_api_key`), not `integrations.*`.
    OpenRouter,
}

impl CloudSttProvider {
    pub fn id(self) -> &'static str {
        match self {
            CloudSttProvider::ElevenLabs => "elevenlabs",
            CloudSttProvider::OpenRouter => "openrouter",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "elevenlabs" => Some(CloudSttProvider::ElevenLabs),
            "openrouter" => Some(CloudSttProvider::OpenRouter),
            _ => None,
        }
    }

    /// Transcription endpoint. ElevenLabs: /v1/speech-to-text (scribe_v1).
    /// OpenRouter: /api/v1/audio/transcriptions (OpenAI-compatible JSON+base64).
    pub fn endpoint(self) -> &'static str {
        match self {
            CloudSttProvider::ElevenLabs => "https://api.elevenlabs.io/v1/speech-to-text",
            CloudSttProvider::OpenRouter => "https://openrouter.ai/api/v1/audio/transcriptions",
        }
    }

    /// The auth-check probe endpoint (cheapest no-cost GET). Mirrors
    /// probeUrlFor in credentials.ts.
    pub fn verify_endpoint(self) -> &'static str {
        match self {
            CloudSttProvider::ElevenLabs => "https://api.elevenlabs.io/v1/user",
            CloudSttProvider::OpenRouter => "https://openrouter.ai/api/v1/auth/key",
        }
    }
}

/// Typed cloud-STT error code. Mirrors `CloudSttErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudSttErrorCode {
    Auth,
    Network,
    RateLimit,
    KeyMissing,
    AudioTooLarge,
    ProviderError,
    Aborted,
    Timeout,
}

impl CloudSttErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CloudSttErrorCode::Auth => "auth",
            CloudSttErrorCode::Network => "network",
            CloudSttErrorCode::RateLimit => "rate_limit",
            CloudSttErrorCode::KeyMissing => "key_missing",
            CloudSttErrorCode::AudioTooLarge => "audio_too_large",
            CloudSttErrorCode::ProviderError => "provider_error",
            CloudSttErrorCode::Aborted => "aborted",
            CloudSttErrorCode::Timeout => "timeout",
        }
    }

    /// Whether this code should surface a renderer toast. `aborted` is a
    /// user-initiated cancel and is suppressed. Mirrors NOTIFICATION_ROUTE.
    pub fn should_notify(self) -> bool {
        !matches!(self, CloudSttErrorCode::Aborted)
    }
}

/// Map the internal taxonomy code to the renderer fan-out token the
/// `native-bridge-adapter` `shouldDeliver` routes on. `timeout` and
/// `audio_too_large` have no dedicated WinSTT channel, so they ride the
/// network / provider channels respectively. `aborted` is suppressed by callers.
pub fn cloud_error_fanout_code(code: CloudSttErrorCode) -> &'static str {
    match code {
        CloudSttErrorCode::Auth => "auth_failed",
        CloudSttErrorCode::Network | CloudSttErrorCode::Timeout => "network_error",
        CloudSttErrorCode::KeyMissing => "key_missing",
        CloudSttErrorCode::RateLimit => "rate_limited",
        CloudSttErrorCode::AudioTooLarge | CloudSttErrorCode::ProviderError => "provider_error",
        CloudSttErrorCode::Aborted => "provider_error",
    }
}

#[derive(Debug, Clone)]
pub struct CloudSttError {
    pub code: CloudSttErrorCode,
    pub message: String,
    pub retry_after_seconds: Option<f64>,
}

impl CloudSttError {
    pub fn new(code: CloudSttErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_seconds: None,
        }
    }

    fn with_retry(mut self, retry: Option<f64>) -> Self {
        self.retry_after_seconds = retry;
        self
    }
}

/// Successful transcription payload. Mirrors `TranscribePayload`.
#[derive(Debug, Clone)]
pub struct CloudTranscription {
    pub text: String,
    pub language: Option<String>,
    pub duration_seconds: Option<f64>,
}

/// Provider hard limits (uncompressed audio BYTES). Bail BEFORE shipping
/// bytes. Mirrors PROVIDER_AUDIO_LIMIT_BYTES.
///   ElevenLabs: 1 GB  (scribe_v1)
pub fn provider_audio_limit_bytes(provider: CloudSttProvider) -> u64 {
    match provider {
        CloudSttProvider::ElevenLabs => 1024 * 1024 * 1024,
        // OpenRouter doesn't publish a uniform cap; the dominant backends
        // (Whisper-class) cap at 25 MB, so use that as the safe pre-flight limit.
        CloudSttProvider::OpenRouter => 25 * 1024 * 1024,
    }
}

pub fn exceeds_audio_limit(provider: CloudSttProvider, byte_len: u64) -> bool {
    byte_len > provider_audio_limit_bytes(provider)
}

/// Map an HTTP status to a typed error code. Mirrors HTTP_STATUS_ERROR_CODE
/// + fallbackStatusCode (no status â‡’ network; unknown status â‡’ provider).
pub fn classify_status(status: Option<u16>) -> CloudSttErrorCode {
    match status {
        Some(401) | Some(403) => CloudSttErrorCode::Auth,
        Some(413) => CloudSttErrorCode::AudioTooLarge,
        Some(429) => CloudSttErrorCode::RateLimit,
        Some(_) => CloudSttErrorCode::ProviderError,
        None => CloudSttErrorCode::Network,
    }
}

/// Parse a `retry-after` header value into a positive finite seconds count.
/// Mirrors parseRetryAfter.
pub fn parse_retry_after(value: Option<&str>) -> Option<f64> {
    let n: f64 = value?.trim().parse().ok()?;
    if n.is_finite() && n > 0.0 {
        Some(n)
    } else {
        None
    }
}

/// True when an ElevenLabs 401 body signals a valid-but-scoped key (status
/// `missing_permissions` inside `detail`). Mirrors isElevenLabsScopedKeyValid:
/// the credential is still valid for what it IS scoped to, so verify/auth
/// must treat it as OK, not "invalid key". `invalid_api_key` â‡’ genuinely bad.
pub fn is_elevenlabs_scoped_key_valid(status: u16, body: &str) -> bool {
    if status != 401 {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("detail")
                .and_then(|d| d.get("status"))
                .and_then(|s| s.as_str())
                .map(|s| s == "missing_permissions")
        })
        .unwrap_or(false)
}

/// Classify a failed HTTP response (status + body + headers) into a typed
/// error, honoring the ElevenLabs scoped-key special-case at the call site
/// (callers should check `is_elevenlabs_scoped_key_valid` BEFORE classifying
/// for the verify path; the transcribe path 401 is always auth).
pub fn classify_http_failure(
    status: u16,
    body: &str,
    retry_after_header: Option<&str>,
) -> CloudSttError {
    let code = classify_status(Some(status));
    let suffix = if body.is_empty() {
        String::new()
    } else {
        // cap body slice like buildFailureFromBody (200 chars)
        let snippet: String = body.chars().take(200).collect();
        format!(": {snippet}")
    };
    CloudSttError::new(code, format!("HTTP {status}{suffix}"))
        .with_retry(parse_retry_after(retry_after_header))
}

/// Map a transport/network error string into a typed error. Mirrors the
/// `isNetworkLikeError` regex fallthrough (TypeError / fetch-failed patterns).
pub fn classify_transport_error(message: &str) -> CloudSttError {
    const NETWORK_PATTERNS: &[&str] = &[
        "ENETUNREACH",
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EAI_AGAIN",
        "fetch failed",
        "dns error",
        "connection refused",
        "timed out",
        "operation timed out",
    ];
    let lower = message.to_lowercase();
    let is_network = NETWORK_PATTERNS
        .iter()
        .any(|p| lower.contains(&p.to_lowercase()));
    let code = if is_network {
        CloudSttErrorCode::Network
    } else {
        CloudSttErrorCode::ProviderError
    };
    CloudSttError::new(code, message.to_string())
}

/// Best-effort taxonomy for cloud error strings produced outside the STT upload
/// path (LLM post-processing and cloud TTS). Keeps all cloud surfaces reporting
/// the same renderer codes: auth, key_missing, network, rate_limit, provider.
pub fn classify_cloud_failure_message(message: &str) -> CloudSttErrorCode {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not configured")
        || lower.contains("no api key")
        || lower.contains("api key is empty")
        || lower.contains("api key is required")
    {
        return CloudSttErrorCode::KeyMissing;
    }
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("invalid api key")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("missing required permission")
        || lower.contains("authentication")
        || lower.contains("missing permissions")
    {
        return CloudSttErrorCode::Auth;
    }
    if lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("rate limited")
        || lower.contains("too many requests")
        || lower.contains("quota exceeded")
    {
        return CloudSttErrorCode::RateLimit;
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("deadline")
        || lower.contains("elapsed")
    {
        return CloudSttErrorCode::Timeout;
    }
    if matches!(
        classify_transport_error(message).code,
        CloudSttErrorCode::Network
    ) || lower.contains("error sending request")
        || lower.contains("network")
        || lower.contains("failed to lookup address")
        || lower.contains("tcp connect error")
        || lower.contains("connection closed")
    {
        return CloudSttErrorCode::Network;
    }
    CloudSttErrorCode::ProviderError
}

/// Emit the single code-discriminated cloud error channel. The renderer fans it
/// out into auth/network/key/rate/provider toasts. Non-STT cloud surfaces reuse
/// this so users see one consistent cloud-failure language.
pub fn emit_cloud_failure(
    app: &AppHandle,
    provider: CloudSttProvider,
    code: CloudSttErrorCode,
    message: impl Into<String>,
    retry_after_seconds: Option<f64>,
) {
    if !code.should_notify() {
        return;
    }
    let mut payload = serde_json::Map::new();
    payload.insert(
        "code".into(),
        serde_json::json!(cloud_error_fanout_code(code)),
    );
    payload.insert("provider".into(), serde_json::json!(provider.id()));
    payload.insert("message".into(), serde_json::json!(message.into()));
    if let Some(retry) = retry_after_seconds {
        payload.insert("retryAfter".into(), serde_json::json!(retry));
    }
    let _ = app.emit("stt:cloud-error", serde_json::Value::Object(payload));
    if matches!(
        code,
        CloudSttErrorCode::Network | CloudSttErrorCode::Timeout
    ) {
        trigger_connectivity_watch(app, provider);
    }
}

fn provider_label(provider: CloudSttProvider) -> &'static str {
    match provider {
        CloudSttProvider::ElevenLabs => "ElevenLabs",
        CloudSttProvider::OpenRouter => "OpenRouter",
    }
}

fn connectivity_probe_url(provider: CloudSttProvider) -> &'static str {
    match provider {
        CloudSttProvider::ElevenLabs => "https://api.elevenlabs.io/v1/models",
        CloudSttProvider::OpenRouter => "https://openrouter.ai/api/v1/models",
    }
}

fn connectivity_watch_registry() -> &'static Mutex<HashSet<&'static str>> {
    static ACTIVE: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Trigger-based provider connectivity monitor. It starts only after a
/// network-like cloud failure, polls the provider host briefly, and emits an
/// online event once any HTTP response is reachable again. HTTP 4xx still means
/// "internet/provider reachable"; only transport errors keep it offline.
pub fn trigger_connectivity_watch(app: &AppHandle, provider: CloudSttProvider) {
    let provider_id = provider.id();
    {
        let Ok(mut active) = connectivity_watch_registry().lock() else {
            return;
        };
        if !active.insert(provider_id) {
            return;
        }
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let label = provider_label(provider);
        let _ = app.emit(
            "cloud:connectivity",
            serde_json::json!({
                "provider": provider.id(),
                "status": "offline",
                "message": format!("{label} cloud connectivity is unavailable. WinSTT will keep checking and will use cloud again when the connection returns."),
            }),
        );

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let mut restored = false;
        for _ in 0..24 {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if client
                .get(connectivity_probe_url(provider))
                .send()
                .await
                .is_ok()
            {
                restored = true;
                break;
            }
        }

        if restored {
            let _ = app.emit(
                "cloud:connectivity",
                serde_json::json!({
                    "provider": provider.id(),
                    "status": "online",
                    "message": format!("{label} cloud connectivity is back. The next cloud request will run normally."),
                }),
            );
        }

        if let Ok(mut active) = connectivity_watch_registry().lock() {
            active.remove(provider.id());
        }
    });
}

/// The transcribe request. `audio_wav` is the raw WAV bytes (16k mono i16,
/// the format WinSTT captures). `media_type` is the multipart content
/// type (e.g. "audio/wav").
#[derive(Debug, Clone)]
pub struct CloudTranscribeRequest {
    pub provider: CloudSttProvider,
    pub model_id: String,
    pub api_key: String,
    pub language: Option<String>,
    pub media_type: String,
    pub audio_wav: Vec<u8>,
}

/// Pre-flight validation: key present + within the provider audio limit.
/// Runs BEFORE any network call so the failure is fast and free. Mirrors
/// assertModelAvailable + assertAudioWithinLimit (the KEY_MISSING /
/// AUDIO_TOO_LARGE sentinels).
pub fn preflight(req: &CloudTranscribeRequest) -> Result<(), CloudSttError> {
    if req.api_key.trim().is_empty() {
        return Err(CloudSttError::new(
            CloudSttErrorCode::KeyMissing,
            "No API key configured",
        ));
    }
    if exceeds_audio_limit(req.provider, req.audio_wav.len() as u64) {
        return Err(CloudSttError::new(
            CloudSttErrorCode::AudioTooLarge,
            format!("Utterance exceeds {} upload limit", req.provider.id()),
        ));
    }
    Ok(())
}

/// 90s ceiling for a single transcribe round-trip. Mirrors
/// CLOUD_TRANSCRIBE_TIMEOUT_MS. The upload itself (multipart POST, timeout,
/// per-request cancel token, taxonomy) lives in `managers::CloudSttManager`.
pub const CLOUD_TRANSCRIBE_TIMEOUT_SECS: u64 = 90;

// â”€â”€ `<provider>:<id>` model-id convention + curated cloud catalog â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The picker persists the prefixed `<provider>:<id>` into `model.model`
// (settings_schema ModelSettings.model). `providerOf` / `split_model_id`
// recover the provider + bare provider model id at the boundary. The reused
// React renderer renders the cloud picker straight from its own hardcoded
// `CLOUD_CATALOG` (entities/cloud-stt-provider/model/catalog.ts) â€” it never
// queries the backend for cloud rows â€” so `CLOUD_CATALOG` below is the
// backend-side mirror, kept BYTE-IDENTICAL to the renderer's curated table
// (used to default + validate a cloud id and available for any future
// enumerate-cloud-models command). Crucially it is NOT folded into the local
// STT catalog (`catalog_data.json` / `catalog_rows`): those rows carry
// local-engine editorial fields (quants / sizes / WER / RTFx) the picker's
// local grid requires, and cloud models have none.

/// One curated cloud STT model. Mirrors the renderer's `CloudModel`
/// (entities/cloud-stt-provider/model/catalog.ts).
#[derive(Debug, Clone, Copy)]
pub struct CloudModel {
    /// Bare provider model id (appended to the provider prefix verbatim, e.g.
    /// `whisper-1` â†’ `openai:whisper-1`).
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    /// The provider's default pick (sits first in the picker / `default_cloud_model_id`).
    pub is_default: bool,
}

/// ElevenLabs cloud STT models. Mirrors `CURATED_CLOUD_MODELS.elevenlabs` âˆª
/// `GENERATED_CLOUD_MODEL_IDS.elevenlabs`.
pub const ELEVENLABS_CLOUD_MODELS: &[CloudModel] = &[
    CloudModel {
        id: "scribe_v1",
        display_name: "Scribe v1",
        description: "ElevenLabs transcription, multilingual.",
        is_default: true,
    },
    CloudModel {
        id: "scribe_v1_experimental",
        display_name: "Scribe v1 (experimental)",
        description: "Latest experimental Scribe build.",
        is_default: false,
    },
];

/// The curated cloud STT catalog for `provider` (the renderer's `CLOUD_CATALOG[provider]`).
/// OpenRouter has NO curated catalog â€” its transcription models are fetched live
/// (`openrouter_refresh_stt_models`) and filtered by `output_modalities=transcription`,
/// so the picker drives selection there. The backend only ever receives a concrete
/// `openrouter:<id>` the renderer already resolved.
pub fn cloud_models_for(provider: CloudSttProvider) -> &'static [CloudModel] {
    match provider {
        CloudSttProvider::ElevenLabs => ELEVENLABS_CLOUD_MODELS,
        CloudSttProvider::OpenRouter => &[],
    }
}

/// Recover the provider from a prefixed `<provider>:<id>` model id, or `None`
/// for a local-catalog / custom id. Mirrors `providerOf` (catalog.ts).
pub fn provider_of(model_id: &str) -> Option<CloudSttProvider> {
    if model_id.starts_with("elevenlabs:") {
        Some(CloudSttProvider::ElevenLabs)
    } else if model_id.starts_with("openrouter:") {
        Some(CloudSttProvider::OpenRouter)
    } else {
        None
    }
}

/// Split a prefixed `<provider>:<id>` model id into `(provider, bare_id)`.
/// Returns `None` when `model_id` carries no known cloud prefix. The bare id is
/// what goes into the multipart `model` / `model_id` field.
pub fn split_model_id(model_id: &str) -> Option<(CloudSttProvider, String)> {
    let provider = provider_of(model_id)?;
    let bare = model_id
        .split_once(':')
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_default();
    Some((provider, bare))
}

/// The default `<provider>:<id>` for a provider â€” the `is_default` entry, else
/// the first. Mirrors `defaultCloudModelId` (catalog.ts).
pub fn default_cloud_model_id(provider: CloudSttProvider) -> String {
    let models = cloud_models_for(provider);
    let chosen = models
        .iter()
        .find(|m| m.is_default)
        .or_else(|| models.first());
    match chosen {
        Some(m) => format!("{}:{}", provider.id(), m.id),
        None => provider.id().to_string(),
    }
}

/// Encode 16 kHz mono f32 samples (the WinSTT capture format) into an
/// in-memory WAV byte buffer for the multipart upload. Mirrors
/// `audio_toolkit::save_wav_file` but writes to a `Vec<u8>` (Cursor) instead of
/// a file so the bytes never hit disk. 16-bit PCM, 16 kHz, mono.
pub fn samples_to_wav_bytes(samples: &[f32]) -> Result<Vec<u8>, CloudSttError> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io::Cursor;

    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let byte_capacity = 44usize.saturating_add(samples.len().saturating_mul(2));
    let mut cursor = Cursor::new(Vec::<u8>::with_capacity(byte_capacity));
    {
        let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
            CloudSttError::new(CloudSttErrorCode::ProviderError, format!("wav init: {e}"))
        })?;
        for &sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let s16 = (clamped * i16::MAX as f32) as i16;
            writer.write_sample(s16).map_err(|e| {
                CloudSttError::new(CloudSttErrorCode::ProviderError, format!("wav write: {e}"))
            })?;
        }
        writer.finalize().map_err(|e| {
            CloudSttError::new(
                CloudSttErrorCode::ProviderError,
                format!("wav finalize: {e}"),
            )
        })?;
    }
    Ok(cursor.into_inner())
}

/// Parse a provider transcription JSON body into the common payload.
/// OpenAI verbose_json: { text, language, duration }. ElevenLabs:
/// { text, language_code?, â€¦ }. OpenRouter: { text, usage: { seconds, â€¦ } }.
/// Mirrors buildTranscribeResult.
pub fn parse_transcription_json(
    provider: CloudSttProvider,
    json: &serde_json::Value,
) -> CloudTranscription {
    let text = json
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let language = match provider {
        // OpenRouter's dedicated endpoint returns only text + usage; no language
        // field is documented, so this is best-effort and usually None.
        CloudSttProvider::OpenRouter => json.get("language").and_then(|l| l.as_str()),
        CloudSttProvider::ElevenLabs => json
            .get("language_code")
            .or_else(|| json.get("language"))
            .and_then(|l| l.as_str()),
    }
    .map(str::to_string);
    let duration_seconds = match provider {
        CloudSttProvider::OpenRouter => json
            .get("usage")
            .and_then(|u| u.get("seconds"))
            .and_then(|d| d.as_f64()),
        _ => json.get("duration").and_then(|d| d.as_f64()),
    };
    CloudTranscription {
        text,
        language,
        duration_seconds,
    }
}

/// Result of a credential-verify probe (the GET probe path). Mirrors
/// VerifyCredentialResult.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyResult {
    Ok,
    Failed {
        code: CloudSttErrorCode,
        message: String,
    },
}

/// Classify a verify-probe response. Honors the ElevenLabs scoped-key
/// special-case. Mirrors probeProvider's success/scoped/failure branches.
pub fn classify_verify(provider: CloudSttProvider, status: u16, body: &str) -> VerifyResult {
    if (200..300).contains(&status) {
        return VerifyResult::Ok;
    }
    if provider == CloudSttProvider::ElevenLabs && is_elevenlabs_scoped_key_valid(status, body) {
        return VerifyResult::Ok;
    }
    let err = classify_http_failure(status, body, None);
    VerifyResult::Failed {
        code: err.code,
        message: err.message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_roundtrip() {
        assert_eq!(
            CloudSttProvider::from_id("elevenlabs"),
            Some(CloudSttProvider::ElevenLabs)
        );
        assert_eq!(
            CloudSttProvider::from_id("openrouter"),
            Some(CloudSttProvider::OpenRouter)
        );
        // OpenAI was removed as a direct provider (now served via openrouter:openai/*).
        assert_eq!(CloudSttProvider::from_id("openai"), None);
        assert_eq!(CloudSttProvider::from_id("azure"), None);
    }

    #[test]
    fn audio_limits_match_spec() {
        assert_eq!(
            provider_audio_limit_bytes(CloudSttProvider::OpenRouter),
            25 * 1024 * 1024
        );
        assert_eq!(
            provider_audio_limit_bytes(CloudSttProvider::ElevenLabs),
            1024 * 1024 * 1024
        );
        assert!(exceeds_audio_limit(
            CloudSttProvider::OpenRouter,
            26 * 1024 * 1024
        ));
        assert!(!exceeds_audio_limit(
            CloudSttProvider::OpenRouter,
            10 * 1024 * 1024
        ));
    }

    #[test]
    fn status_taxonomy() {
        assert_eq!(classify_status(Some(401)), CloudSttErrorCode::Auth);
        assert_eq!(classify_status(Some(403)), CloudSttErrorCode::Auth);
        assert_eq!(classify_status(Some(413)), CloudSttErrorCode::AudioTooLarge);
        assert_eq!(classify_status(Some(429)), CloudSttErrorCode::RateLimit);
        assert_eq!(classify_status(Some(500)), CloudSttErrorCode::ProviderError);
        assert_eq!(classify_status(None), CloudSttErrorCode::Network);
    }

    #[test]
    fn retry_after_parsing() {
        assert_eq!(parse_retry_after(Some("12")), Some(12.0));
        assert_eq!(parse_retry_after(Some("1.5")), Some(1.5));
        assert_eq!(parse_retry_after(Some("0")), None);
        assert_eq!(parse_retry_after(Some("-3")), None);
        assert_eq!(parse_retry_after(Some("abc")), None);
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn elevenlabs_scoped_key_is_valid() {
        let body = r#"{"detail":{"status":"missing_permissions","message":"x"}}"#;
        assert!(is_elevenlabs_scoped_key_valid(401, body));
        // genuinely bad key
        let bad = r#"{"detail":{"status":"invalid_api_key"}}"#;
        assert!(!is_elevenlabs_scoped_key_valid(401, bad));
        // wrong status
        assert!(!is_elevenlabs_scoped_key_valid(403, body));
    }

    #[test]
    fn verify_classifies_scoped_key_as_ok() {
        let body = r#"{"detail":{"status":"missing_permissions"}}"#;
        assert_eq!(
            classify_verify(CloudSttProvider::ElevenLabs, 401, body),
            VerifyResult::Ok
        );
        // a non-ElevenLabs 401 is a hard auth failure
        match classify_verify(CloudSttProvider::OpenRouter, 401, "bad") {
            VerifyResult::Failed { code, .. } => assert_eq!(code, CloudSttErrorCode::Auth),
            _ => panic!("expected failure"),
        }
        assert_eq!(
            classify_verify(CloudSttProvider::OpenRouter, 200, "{}"),
            VerifyResult::Ok
        );
    }

    #[test]
    fn http_failure_caps_body_and_carries_retry() {
        let big_body = "x".repeat(500);
        let err = classify_http_failure(429, &big_body, Some("30"));
        assert_eq!(err.code, CloudSttErrorCode::RateLimit);
        assert_eq!(err.retry_after_seconds, Some(30.0));
        // body snippet capped at 200 chars + "HTTP 429: " prefix
        assert!(err.message.len() < 250);
    }

    #[test]
    fn transport_error_network_vs_provider() {
        assert_eq!(
            classify_transport_error("ECONNREFUSED").code,
            CloudSttErrorCode::Network
        );
        assert_eq!(
            classify_transport_error("fetch failed").code,
            CloudSttErrorCode::Network
        );
        assert_eq!(
            classify_transport_error("weird internal bug").code,
            CloudSttErrorCode::ProviderError
        );
    }

    #[test]
    fn cloud_failure_message_taxonomy_covers_common_provider_edges() {
        assert_eq!(
            classify_cloud_failure_message("OpenRouter speech request failed: dns error"),
            CloudSttErrorCode::Network
        );
        assert_eq!(
            classify_cloud_failure_message("HTTP error. Status: 429 Too Many Requests"),
            CloudSttErrorCode::RateLimit
        );
        assert_eq!(
            classify_cloud_failure_message("OpenRouter API key not configured"),
            CloudSttErrorCode::KeyMissing
        );
        assert_eq!(
            classify_cloud_failure_message("OpenRouter request timed out after 5s"),
            CloudSttErrorCode::Timeout
        );
        assert_eq!(
            classify_cloud_failure_message("model is not available"),
            CloudSttErrorCode::ProviderError
        );
    }

    #[test]
    fn preflight_rejects_missing_key_and_oversize() {
        let big = vec![0u8; 26 * 1024 * 1024];
        let req = CloudTranscribeRequest {
            provider: CloudSttProvider::OpenRouter,
            model_id: "openai/whisper-1".into(),
            api_key: "".into(),
            language: None,
            media_type: "audio/wav".into(),
            audio_wav: vec![],
        };
        assert_eq!(
            preflight(&req).unwrap_err().code,
            CloudSttErrorCode::KeyMissing
        );

        let req2 = CloudTranscribeRequest {
            api_key: "sk-xxx".into(),
            audio_wav: big,
            ..req.clone()
        };
        assert_eq!(
            preflight(&req2).unwrap_err().code,
            CloudSttErrorCode::AudioTooLarge
        );

        let req3 = CloudTranscribeRequest {
            api_key: "sk-xxx".into(),
            audio_wav: vec![0u8; 1000],
            ..req
        };
        assert!(preflight(&req3).is_ok());
    }

    #[test]
    fn parse_elevenlabs_language_code() {
        let json = serde_json::json!({ "text": "bonjour", "language_code": "fr" });
        let out = parse_transcription_json(CloudSttProvider::ElevenLabs, &json);
        assert_eq!(out.text, "bonjour");
        assert_eq!(out.language.as_deref(), Some("fr"));
    }

    #[test]
    fn openrouter_provider_roundtrip_and_endpoints() {
        assert_eq!(
            CloudSttProvider::from_id("openrouter"),
            Some(CloudSttProvider::OpenRouter)
        );
        assert_eq!(CloudSttProvider::OpenRouter.id(), "openrouter");
        assert_eq!(
            CloudSttProvider::OpenRouter.endpoint(),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        );
        // Dynamic catalog: no curated rows.
        assert!(cloud_models_for(CloudSttProvider::OpenRouter).is_empty());
        assert_eq!(
            provider_audio_limit_bytes(CloudSttProvider::OpenRouter),
            25 * 1024 * 1024
        );
    }

    #[test]
    fn openrouter_prefix_splits_slashed_model_id() {
        // OpenRouter ids carry a maker slash (e.g. microsoft/mai-transcribe-1.5);
        // split_model_id peels only the provider prefix at the FIRST colon.
        assert_eq!(
            provider_of("openrouter:microsoft/mai-transcribe-1.5"),
            Some(CloudSttProvider::OpenRouter)
        );
        assert_eq!(
            split_model_id("openrouter:microsoft/mai-transcribe-1.5"),
            Some((
                CloudSttProvider::OpenRouter,
                "microsoft/mai-transcribe-1.5".to_string()
            ))
        );
    }

    #[test]
    fn parse_openrouter_usage_seconds() {
        // OpenRouter's dedicated endpoint: { text, usage: { seconds, â€¦ } }.
        let json = serde_json::json!({
            "text": "hello from openrouter",
            "usage": { "seconds": 9.2, "total_tokens": 113 }
        });
        let out = parse_transcription_json(CloudSttProvider::OpenRouter, &json);
        assert_eq!(out.text, "hello from openrouter");
        assert_eq!(out.duration_seconds, Some(9.2));
        assert_eq!(out.language, None);
    }

    #[test]
    fn aborted_is_suppressed_from_notify() {
        assert!(!CloudSttErrorCode::Aborted.should_notify());
        assert!(CloudSttErrorCode::Auth.should_notify());
        assert!(CloudSttErrorCode::Network.should_notify());
    }

    #[test]
    fn provider_of_recognizes_cloud_prefixes() {
        assert_eq!(
            provider_of("elevenlabs:scribe_v1"),
            Some(CloudSttProvider::ElevenLabs)
        );
        assert_eq!(
            provider_of("openrouter:openai/whisper-1"),
            Some(CloudSttProvider::OpenRouter)
        );
        // OpenAI is no longer a direct provider â€” `openai:` is now an unknown prefix.
        assert_eq!(provider_of("openai:whisper-1"), None);
        // local-catalog ids + custom ids carry no prefix.
        assert_eq!(provider_of("tiny"), None);
        assert_eq!(provider_of("nemo-canary-1b-v2"), None);
        assert_eq!(provider_of("alphacep/vosk-model-ru"), None);
    }

    #[test]
    fn split_model_id_peels_the_bare_provider_id() {
        assert_eq!(
            split_model_id("openrouter:openai/gpt-4o-transcribe"),
            Some((
                CloudSttProvider::OpenRouter,
                "openai/gpt-4o-transcribe".to_string()
            ))
        );
        assert_eq!(
            split_model_id("elevenlabs:scribe_v1_experimental"),
            Some((
                CloudSttProvider::ElevenLabs,
                "scribe_v1_experimental".to_string()
            ))
        );
        assert_eq!(split_model_id("tiny"), None);
    }

    #[test]
    fn default_cloud_model_matches_curated_catalog() {
        // Mirrors catalog.ts: elevenlabs default = scribe_v1.
        assert_eq!(
            default_cloud_model_id(CloudSttProvider::ElevenLabs),
            "elevenlabs:scribe_v1"
        );
    }

    #[test]
    fn cloud_catalog_mirrors_renderer() {
        // Exactly one default per curated provider; ids match the renderer's CLOUD_CATALOG.
        let el = cloud_models_for(CloudSttProvider::ElevenLabs);
        assert_eq!(el.iter().filter(|m| m.is_default).count(), 1);
        assert!(el.iter().any(|m| m.id == "scribe_v1"));
        // OpenRouter has no curated catalog (dynamic scan).
        assert!(cloud_models_for(CloudSttProvider::OpenRouter).is_empty());
    }

    #[test]
    fn wav_bytes_are_a_valid_riff_container() {
        // 0.1s of silence at 16 kHz mono â†’ a parseable WAV with a RIFF/WAVE header.
        let samples = vec![0.0f32; 1600];
        let bytes = samples_to_wav_bytes(&samples).expect("encode");
        assert!(bytes.len() > 44, "must include 44-byte header + data");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // Round-trips through hound's reader at the expected spec.
        let reader =
            hound::WavReader::new(std::io::Cursor::new(bytes)).expect("reparse wav header");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(reader.len(), 1600);
    }
}
