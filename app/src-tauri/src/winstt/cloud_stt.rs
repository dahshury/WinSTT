// DRAFT PORT — not yet compiled. Source: frontend/electron/ipc/stt-cloud.ts +
// frontend/electron/ipc/credentials.ts
//
// Cloud STT: reqwest multipart POST to OpenAI /v1/audio/transcriptions and
// ElevenLabs /v1/speech-to-text. In WinSTT-Electron the Python pipeline's
// RemoteTranscriber adapter sends the WAV bytes to the main process over WS;
// in the Rust/Tauri port there is NO Python and NO WS — the
// TranscriptionManager calls this module directly when the active model is a
// cloud model (`openai:…` / `elevenlabs:…`), exactly the way Handy's
// in-process flow calls `transcribe-rs`. So this module is a plain async
// function returning `Result<CloudTranscription, CloudSttError>` rather than
// a WS request/response handler.
//
// Ported faithfully:
//   - Provider audio byte limits (bail BEFORE the upload). [PROVIDER_AUDIO_LIMIT_BYTES]
//   - HTTP-status → typed error code taxonomy. [HTTP_STATUS_ERROR_CODE]
//   - ElevenLabs scoped-key 401 `missing_permissions` = VALID auth, not a bad
//     key. [isElevenLabsScopedKeyValid / credentials.ts]
//   - retry-after parsing for rate limits.
//   - per-call provider instance (key reflects current store value).
//
// The actual multipart upload is the one heavy bit; the body shapes are
// documented and the transport is a thin reqwest call (DRAFT — wire the
// multipart form during the compile loop). All the classification +
// limit logic is pure and fully tested.

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

/// The transport. Behind a trait so the manager can inject a fake in tests.
/// Mirrors the AI SDK `experimental_transcribe` call, but as a direct
/// multipart POST (the Rust port has no AI SDK).
pub trait CloudTranscriber {
    fn transcribe(&self, req: &CloudTranscribeRequest) -> Result<CloudTranscription, CloudSttError>;
}

// ── reqwest multipart sketch (DRAFT — wire during compile loop) ────────
//
// pub struct ReqwestCloudTranscriber { client: reqwest::Client }
//
// impl CloudTranscriber for ReqwestCloudTranscriber {
//   fn transcribe(&self, req) -> Result<CloudTranscription, CloudSttError> {
//     preflight(req)?;                            // key + size, free + fast
//
//     // OpenAI /v1/audio/transcriptions multipart fields:
//     //   file=<wav bytes; filename audio.wav; mime req.media_type>
//     //   model=<req.model_id>          (whisper-1 | gpt-4o-mini-transcribe | …)
//     //   response_format=verbose_json  (gives language + duration)
//     //   language=<req.language>       (optional, ISO-639-1)
//     // Auth: header  Authorization: Bearer <api_key>
//     //
//     // ElevenLabs /v1/speech-to-text multipart fields:
//     //   file=<wav bytes>
//     //   model_id=<req.model_id>       (scribe_v1)
//     //   language_code=<req.language>  (optional)
//     // Auth: header  xi-api-key: <api_key>
//
//     let part = reqwest::multipart::Part::bytes(req.audio_wav.clone())
//         .file_name("audio.wav")
//         .mime_str(&req.media_type).map_err(|e| CloudSttError::new(ProviderError, e.to_string()))?;
//     let form = match req.provider {
//       OpenAi => reqwest::multipart::Form::new()
//           .part("file", part).text("model", req.model_id.clone())
//           .text("response_format", "verbose_json")
//           .opt_text("language", req.language.clone()),
//       ElevenLabs => reqwest::multipart::Form::new()
//           .part("file", part).text("model_id", req.model_id.clone())
//           .opt_text("language_code", req.language.clone()),
//     };
//     let mut rb = self.client.post(req.provider.endpoint())
//         .multipart(form).timeout(CLOUD_TRANSCRIBE_TIMEOUT);   // 90s
//     rb = match req.provider {
//       OpenAi => rb.bearer_auth(&req.api_key),
//       ElevenLabs => rb.header("xi-api-key", &req.api_key),
//     };
//     let resp = rb.send().await.map_err(|e| classify_transport_error(&e.to_string()))?;
//     if !resp.status().is_success() {
//       let status = resp.status().as_u16();
//       let retry = resp.headers().get("retry-after").and_then(|h| h.to_str().ok()).map(str::to_owned);
//       let body = resp.text().await.unwrap_or_default();
//       return Err(classify_http_failure(status, &body, retry.as_deref()));
//     }
//     let json: serde_json::Value = resp.json().await
//         .map_err(|e| CloudSttError::new(ProviderError, e.to_string()))?;
//     Ok(parse_transcription_json(req.provider, &json))
//   }
// }
//
// Timeout: 90s ceiling (CLOUD_TRANSCRIBE_TIMEOUT_MS). Cancellation: hold a
// per-request token in the manager so a model swap / quit aborts in-flight
// calls (mirrors inFlight + abortAllCloudTranscribes).

/// 90s ceiling for a single transcribe round-trip. Mirrors
/// CLOUD_TRANSCRIBE_TIMEOUT_MS.
pub const CLOUD_TRANSCRIBE_TIMEOUT_SECS: u64 = 90;

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
pub fn classify_verify(
    provider: CloudSttProvider,
    status: u16,
    body: &str,
) -> VerifyResult {
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
        assert_eq!(CloudSttProvider::from_id("openai"), Some(CloudSttProvider::OpenAi));
        assert_eq!(CloudSttProvider::from_id("elevenlabs"), Some(CloudSttProvider::ElevenLabs));
        assert_eq!(CloudSttProvider::from_id("azure"), None);
    }

    #[test]
    fn audio_limits_match_spec() {
        assert_eq!(provider_audio_limit_bytes(CloudSttProvider::OpenAi), 25 * 1024 * 1024);
        assert_eq!(provider_audio_limit_bytes(CloudSttProvider::ElevenLabs), 1024 * 1024 * 1024);
        assert!(exceeds_audio_limit(CloudSttProvider::OpenAi, 26 * 1024 * 1024));
        assert!(!exceeds_audio_limit(CloudSttProvider::OpenAi, 10 * 1024 * 1024));
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
        assert_eq!(classify_verify(CloudSttProvider::ElevenLabs, 401, body), VerifyResult::Ok);
        // openai 401 is a hard auth failure
        match classify_verify(CloudSttProvider::OpenAi, 401, "bad") {
            VerifyResult::Failed { code, .. } => assert_eq!(code, CloudSttErrorCode::Auth),
            _ => panic!("expected failure"),
        }
        assert_eq!(classify_verify(CloudSttProvider::OpenAi, 200, "{}"), VerifyResult::Ok);
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
        assert_eq!(classify_transport_error("ECONNREFUSED").code, CloudSttErrorCode::Network);
        assert_eq!(classify_transport_error("fetch failed").code, CloudSttErrorCode::Network);
        assert_eq!(classify_transport_error("weird internal bug").code, CloudSttErrorCode::ProviderError);
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
        assert_eq!(preflight(&req).unwrap_err().code, CloudSttErrorCode::KeyMissing);

        let req2 = CloudTranscribeRequest {
            api_key: "sk-xxx".into(),
            audio_wav: big,
            ..req.clone()
        };
        assert_eq!(preflight(&req2).unwrap_err().code, CloudSttErrorCode::AudioTooLarge);

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
}
