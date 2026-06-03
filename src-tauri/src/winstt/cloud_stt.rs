// Cloud STT pure layer. Source: frontend/electron/ipc/stt-cloud.ts +
// frontend/electron/ipc/credentials.ts + entities/cloud-stt-provider/model/catalog.ts.
//
// Cloud STT: reqwest multipart POST to OpenAI /v1/audio/transcriptions and
// ElevenLabs /v1/speech-to-text. In WinSTT-the reference the Python pipeline's
// RemoteTranscriber adapter sends the WAV bytes to the main process over WS;
// in the Rust/Tauri port there is NO Python and NO WS — the
// TranscriptionManager calls `CloudSttManager::transcribe` directly when the
// active model is a cloud model (`openai:…` / `elevenlabs:…`), exactly the way
// Handy's in-process flow calls `transcribe-rs`. So this module exposes the
// pure classification + request-shape layer, and the upload itself lives in
// `managers::CloudSttManager`.
//
// Ported faithfully:
//   - Provider audio byte limits (bail BEFORE the upload). [PROVIDER_AUDIO_LIMIT_BYTES]
//   - HTTP-status → typed error code taxonomy. [HTTP_STATUS_ERROR_CODE]
//   - ElevenLabs scoped-key 401 `missing_permissions` = VALID auth, not a bad
//     key. [isElevenLabsScopedKeyValid / credentials.ts]
//   - retry-after parsing for rate limits.
//   - per-call provider instance (key reflects current store value).
//   - the `<provider>:<id>` model-id convention (settings_schema ModelSettings.model)
//     and the curated cloud catalog the picker renders. [CLOUD_CATALOG / catalog.ts]

/// Cloud STT providers. Mirrors `CloudSttProvider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudSttProvider {
    OpenAi,
    ElevenLabs,
}

impl CloudSttProvider {
    pub fn id(self) -> &'static str {
        match self {
            CloudSttProvider::OpenAi => "openai",
            CloudSttProvider::ElevenLabs => "elevenlabs",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "openai" => Some(CloudSttProvider::OpenAi),
            "elevenlabs" => Some(CloudSttProvider::ElevenLabs),
            _ => None,
        }
    }

    /// Transcription endpoint. OpenAI: /v1/audio/transcriptions (Whisper +
    /// gpt-4o-*-transcribe). ElevenLabs: /v1/speech-to-text (scribe_v1).
    pub fn endpoint(self) -> &'static str {
        match self {
            CloudSttProvider::OpenAi => "https://api.openai.com/v1/audio/transcriptions",
            CloudSttProvider::ElevenLabs => "https://api.elevenlabs.io/v1/speech-to-text",
        }
    }

    /// The auth-check probe endpoint (cheapest no-cost GET). Mirrors
    /// probeUrlFor in credentials.ts.
    pub fn verify_endpoint(self) -> &'static str {
        match self {
            CloudSttProvider::OpenAi => "https://api.openai.com/v1/models",
            CloudSttProvider::ElevenLabs => "https://api.elevenlabs.io/v1/user",
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
///   OpenAI:     25 MB (whisper-1 + gpt-4o-*-transcribe)
///   ElevenLabs: 1 GB  (scribe_v1)
pub fn provider_audio_limit_bytes(provider: CloudSttProvider) -> u64 {
    match provider {
        CloudSttProvider::OpenAi => 25 * 1024 * 1024,
        CloudSttProvider::ElevenLabs => 1024 * 1024 * 1024,
    }
}

pub fn exceeds_audio_limit(provider: CloudSttProvider, byte_len: u64) -> bool {
    byte_len > provider_audio_limit_bytes(provider)
}

/// Map an HTTP status to a typed error code. Mirrors HTTP_STATUS_ERROR_CODE
/// + fallbackStatusCode (no status ⇒ network; unknown status ⇒ provider).
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
/// must treat it as OK, not "invalid key". `invalid_api_key` ⇒ genuinely bad.
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

/// The transcribe request. `audio_wav` is the raw WAV bytes (16k mono i16,
/// the format WinSTT/Handy capture). `media_type` is the multipart content
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

// ── `<provider>:<id>` model-id convention + curated cloud catalog ─────────
//
// The picker persists the prefixed `<provider>:<id>` into `model.model`
// (settings_schema ModelSettings.model). `providerOf` / `split_model_id`
// recover the provider + bare provider model id at the boundary. The reused
// React renderer renders the cloud picker straight from its own hardcoded
// `CLOUD_CATALOG` (entities/cloud-stt-provider/model/catalog.ts) — it never
// queries the backend for cloud rows — so `CLOUD_CATALOG` below is the
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
    /// `whisper-1` → `openai:whisper-1`).
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    /// The provider's default pick (sits first in the picker / `default_cloud_model_id`).
    pub is_default: bool,
}

/// OpenAI cloud STT models. Curated metadata fused with the AI SDK's generated
/// id union; mirrors `CURATED_CLOUD_MODELS.openai` ∪ `GENERATED_CLOUD_MODEL_IDS.openai`.
///
/// NOTE: dated `gpt-4o-*-transcribe` snapshots and `gpt-4o-transcribe-diarize`
/// are intentionally absent — the AI SDK / our upload posts
/// `response_format=verbose_json`, which only `whisper-1` and the two base
/// `gpt-4o` aliases accept (catalog.ts header).
pub const OPENAI_CLOUD_MODELS: &[CloudModel] = &[
    CloudModel {
        id: "gpt-4o-mini-transcribe",
        display_name: "GPT-4o mini transcribe",
        description: "Fast and cheap general-purpose transcription.",
        is_default: true,
    },
    CloudModel {
        id: "gpt-4o-transcribe",
        display_name: "GPT-4o transcribe",
        description: "Higher-accuracy GPT-4o transcription.",
        is_default: false,
    },
    CloudModel {
        id: "whisper-1",
        display_name: "Whisper v1",
        description: "Legacy Whisper hosted model.",
        is_default: false,
    },
];

/// ElevenLabs cloud STT models. Mirrors `CURATED_CLOUD_MODELS.elevenlabs` ∪
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
pub fn cloud_models_for(provider: CloudSttProvider) -> &'static [CloudModel] {
    match provider {
        CloudSttProvider::OpenAi => OPENAI_CLOUD_MODELS,
        CloudSttProvider::ElevenLabs => ELEVENLABS_CLOUD_MODELS,
    }
}

/// Recover the provider from a prefixed `<provider>:<id>` model id, or `None`
/// for a local-catalog / custom id. Mirrors `providerOf` (catalog.ts).
pub fn provider_of(model_id: &str) -> Option<CloudSttProvider> {
    if model_id.starts_with("openai:") {
        Some(CloudSttProvider::OpenAi)
    } else if model_id.starts_with("elevenlabs:") {
        Some(CloudSttProvider::ElevenLabs)
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

/// The default `<provider>:<id>` for a provider — the `is_default` entry, else
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

/// Encode 16 kHz mono f32 samples (the WinSTT/Handy capture format) into an
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
    let mut cursor = Cursor::new(Vec::<u8>::new());
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
/// { text, language_code?, … }. Mirrors buildTranscribeResult.
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
        CloudSttProvider::OpenAi => json.get("language").and_then(|l| l.as_str()),
        CloudSttProvider::ElevenLabs => json
            .get("language_code")
            .or_else(|| json.get("language"))
            .and_then(|l| l.as_str()),
    }
    .map(str::to_string);
    let duration_seconds = json.get("duration").and_then(|d| d.as_f64());
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
            CloudSttProvider::from_id("openai"),
            Some(CloudSttProvider::OpenAi)
        );
        assert_eq!(
            CloudSttProvider::from_id("elevenlabs"),
            Some(CloudSttProvider::ElevenLabs)
        );
        assert_eq!(CloudSttProvider::from_id("azure"), None);
    }

    #[test]
    fn audio_limits_match_spec() {
        assert_eq!(
            provider_audio_limit_bytes(CloudSttProvider::OpenAi),
            25 * 1024 * 1024
        );
        assert_eq!(
            provider_audio_limit_bytes(CloudSttProvider::ElevenLabs),
            1024 * 1024 * 1024
        );
        assert!(exceeds_audio_limit(
            CloudSttProvider::OpenAi,
            26 * 1024 * 1024
        ));
        assert!(!exceeds_audio_limit(
            CloudSttProvider::OpenAi,
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
        // openai 401 is a hard auth failure
        match classify_verify(CloudSttProvider::OpenAi, 401, "bad") {
            VerifyResult::Failed { code, .. } => assert_eq!(code, CloudSttErrorCode::Auth),
            _ => panic!("expected failure"),
        }
        assert_eq!(
            classify_verify(CloudSttProvider::OpenAi, 200, "{}"),
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
    fn preflight_rejects_missing_key_and_oversize() {
        let big = vec![0u8; 26 * 1024 * 1024];
        let req = CloudTranscribeRequest {
            provider: CloudSttProvider::OpenAi,
            model_id: "whisper-1".into(),
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
    fn parse_openai_verbose_json() {
        let json = serde_json::json!({
            "text": "hello there",
            "language": "english",
            "duration": 2.5
        });
        let out = parse_transcription_json(CloudSttProvider::OpenAi, &json);
        assert_eq!(out.text, "hello there");
        assert_eq!(out.language.as_deref(), Some("english"));
        assert_eq!(out.duration_seconds, Some(2.5));
    }

    #[test]
    fn parse_elevenlabs_language_code() {
        let json = serde_json::json!({ "text": "bonjour", "language_code": "fr" });
        let out = parse_transcription_json(CloudSttProvider::ElevenLabs, &json);
        assert_eq!(out.text, "bonjour");
        assert_eq!(out.language.as_deref(), Some("fr"));
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
            provider_of("openai:whisper-1"),
            Some(CloudSttProvider::OpenAi)
        );
        assert_eq!(
            provider_of("elevenlabs:scribe_v1"),
            Some(CloudSttProvider::ElevenLabs)
        );
        // local-catalog ids + custom ids carry no prefix.
        assert_eq!(provider_of("tiny"), None);
        assert_eq!(provider_of("nemo-canary-1b-v2"), None);
        assert_eq!(provider_of("alphacep/vosk-model-ru"), None);
    }

    #[test]
    fn split_model_id_peels_the_bare_provider_id() {
        assert_eq!(
            split_model_id("openai:gpt-4o-transcribe"),
            Some((CloudSttProvider::OpenAi, "gpt-4o-transcribe".to_string()))
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
        // Mirrors catalog.ts: openai default = gpt-4o-mini-transcribe, elevenlabs = scribe_v1.
        assert_eq!(
            default_cloud_model_id(CloudSttProvider::OpenAi),
            "openai:gpt-4o-mini-transcribe"
        );
        assert_eq!(
            default_cloud_model_id(CloudSttProvider::ElevenLabs),
            "elevenlabs:scribe_v1"
        );
    }

    #[test]
    fn cloud_catalog_mirrors_renderer() {
        // Exactly one default per provider; ids match the renderer's CLOUD_CATALOG.
        let openai = cloud_models_for(CloudSttProvider::OpenAi);
        assert_eq!(openai.iter().filter(|m| m.is_default).count(), 1);
        assert!(openai.iter().any(|m| m.id == "whisper-1"));
        assert!(openai.iter().any(|m| m.id == "gpt-4o-transcribe"));
        let el = cloud_models_for(CloudSttProvider::ElevenLabs);
        assert_eq!(el.iter().filter(|m| m.is_default).count(), 1);
        assert!(el.iter().any(|m| m.id == "scribe_v1"));
    }

    #[test]
    fn wav_bytes_are_a_valid_riff_container() {
        // 0.1s of silence at 16 kHz mono → a parseable WAV with a RIFF/WAVE header.
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
