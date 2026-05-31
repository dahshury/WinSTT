// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md §2,
// frontend/electron/ipc/stt-cloud.ts + credentials.ts. Wraps winstt::cloud_stt.
//
// CloudSttManager owns the reqwest client + the in-flight transcribe cancel set.
// It implements the multipart upload sketch from cloud_stt.rs against real
// reqwest, and routes verify/transcribe through the pure classification helpers
// already drafted there (status taxonomy, EL scoped-key handling, retry-after).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::winstt::cloud_stt::{
    classify_http_failure, classify_transport_error, classify_verify, parse_transcription_json,
    preflight, CloudSttError, CloudSttErrorCode, CloudSttProvider, CloudTranscribeRequest,
    CloudTranscription, VerifyResult, CLOUD_TRANSCRIBE_TIMEOUT_SECS,
};

pub struct CloudSttManager {
    app: AppHandle,
    client: reqwest::Client,
    /// request_id → cancelled. A model swap / quit aborts in-flight uploads.
    cancelled: Mutex<HashMap<String, bool>>,
}

impl CloudSttManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            client: reqwest::Client::new(),
            cancelled: Mutex::new(HashMap::new()),
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.insert(request_id.to_string(), true);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut m) = self.cancelled.lock() {
            for v in m.values_mut() {
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

    fn clear(&self, request_id: &str) {
        if let Ok(mut m) = self.cancelled.lock() {
            m.remove(request_id);
        }
    }

    /// Emit the single code-discriminated cloud error channel (07_* §4b).
    /// `aborted` is suppressed (user-initiated cancel).
    ///
    /// The renderer's `CloudSttErrorToasts` fan-out (electron-tauri-adapter
    /// `shouldDeliver`) routes ONE `stt-cloud-error` event to one of the five
    /// WinSTT channels by matching the payload `code` against the fan-out tokens
    /// `auth_failed | network_error | key_missing | rate_limited | provider_error`.
    /// So we emit the FAN-OUT token (not the raw taxonomy `auth`/`network`/…) and
    /// include `provider` + `retryAfter` exactly like the Electron handler's
    /// `notifyRenderer` payload.
    fn emit_error(&self, provider: CloudSttProvider, err: &CloudSttError) {
        if !err.code.should_notify() {
            return;
        }
        let fanout = fanout_code(err.code);
        let mut payload = serde_json::Map::new();
        payload.insert("code".into(), serde_json::json!(fanout));
        payload.insert("provider".into(), serde_json::json!(provider.id()));
        payload.insert("message".into(), serde_json::json!(err.message));
        if let Some(retry) = err.retry_after_seconds {
            payload.insert("retryAfter".into(), serde_json::json!(retry));
        }
        let _ = self
            .app
            .emit("stt-cloud-error", serde_json::Value::Object(payload));
    }

    /// Transcribe one utterance via the cloud provider. Honors the pre-flight
    /// guards (key + size), the per-request cancel token, the 90s ceiling, and
    /// the typed error taxonomy. On error, emits `stt-cloud-error` and returns it.
    pub async fn transcribe(
        &self,
        request_id: &str,
        req: CloudTranscribeRequest,
    ) -> Result<CloudTranscription, CloudSttError> {
        let provider = req.provider;
        if let Err(e) = preflight(&req) {
            self.emit_error(provider, &e);
            return Err(e);
        }
        if self.is_cancelled(request_id) {
            self.clear(request_id);
            return Err(CloudSttError::new(CloudSttErrorCode::Aborted, "cancelled"));
        }

        let result = self.do_upload(req).await;
        self.clear(request_id);
        if let Err(ref e) = result {
            self.emit_error(provider, e);
        }
        result
    }

    async fn do_upload(&self, req: CloudTranscribeRequest) -> Result<CloudTranscription, CloudSttError> {
        let part = reqwest::multipart::Part::bytes(req.audio_wav.clone())
            .file_name("audio.wav")
            .mime_str(&req.media_type)
            .map_err(|e| CloudSttError::new(CloudSttErrorCode::ProviderError, e.to_string()))?;

        let mut form = reqwest::multipart::Form::new().part("file", part);
        match req.provider {
            CloudSttProvider::OpenAi => {
                form = form
                    .text("model", req.model_id.clone())
                    .text("response_format", "verbose_json");
                if let Some(lang) = req.language.clone() {
                    if !lang.is_empty() {
                        form = form.text("language", lang);
                    }
                }
            }
            CloudSttProvider::ElevenLabs => {
                form = form.text("model_id", req.model_id.clone());
                if let Some(lang) = req.language.clone() {
                    if !lang.is_empty() {
                        form = form.text("language_code", lang);
                    }
                }
            }
        }

        let mut rb = self
            .client
            .post(req.provider.endpoint())
            .multipart(form)
            .timeout(Duration::from_secs(CLOUD_TRANSCRIBE_TIMEOUT_SECS));
        rb = match req.provider {
            CloudSttProvider::OpenAi => rb.bearer_auth(&req.api_key),
            CloudSttProvider::ElevenLabs => rb.header("xi-api-key", &req.api_key),
        };

        let resp = rb
            .send()
            .await
            .map_err(|e| classify_transport_error(&e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let retry = resp
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned);
            let body = resp.text().await.unwrap_or_default();
            return Err(classify_http_failure(status, &body, retry.as_deref()));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudSttError::new(CloudSttErrorCode::ProviderError, e.to_string()))?;
        Ok(parse_transcription_json(req.provider, &json))
    }

    /// Verify a credential against the cheap GET probe endpoint. Honors the
    /// ElevenLabs scoped-key special-case (a 401 `missing_permissions` is VALID).
    pub async fn verify_credential(
        &self,
        provider: CloudSttProvider,
        api_key: &str,
    ) -> VerifyResult {
        if api_key.trim().is_empty() {
            return VerifyResult::Failed {
                code: CloudSttErrorCode::KeyMissing,
                message: "No API key configured".into(),
            };
        }
        let mut rb = self
            .client
            .get(provider.verify_endpoint())
            .timeout(Duration::from_secs(15));
        rb = match provider {
            CloudSttProvider::OpenAi => rb.bearer_auth(api_key),
            CloudSttProvider::ElevenLabs => rb.header("xi-api-key", api_key),
        };
        match rb.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                // classify_verify honors the ElevenLabs scoped-key special-case.
                classify_verify(provider, status, &body)
            }
            Err(e) => {
                let err = classify_transport_error(&e.to_string());
                VerifyResult::Failed {
                    code: err.code,
                    message: err.message,
                }
            }
        }
    }
}

/// Map the internal taxonomy code to the renderer fan-out token the
/// `electron-tauri-adapter` `shouldDeliver` routes on. `timeout` and
/// `audio_too_large` have no dedicated WinSTT channel, so they ride the
/// network / provider channels respectively (matching the Electron
/// `ERROR_CODE_CHANNEL` mapping). `aborted` never reaches here (suppressed
/// by `should_notify`).
fn fanout_code(code: CloudSttErrorCode) -> &'static str {
    match code {
        CloudSttErrorCode::Auth => "auth_failed",
        CloudSttErrorCode::Network | CloudSttErrorCode::Timeout => "network_error",
        CloudSttErrorCode::KeyMissing => "key_missing",
        CloudSttErrorCode::RateLimit => "rate_limited",
        CloudSttErrorCode::AudioTooLarge | CloudSttErrorCode::ProviderError => "provider_error",
        // Unreachable (suppressed earlier) — default to provider_error.
        CloudSttErrorCode::Aborted => "provider_error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fanout_tokens_match_adapter() {
        assert_eq!(fanout_code(CloudSttErrorCode::Auth), "auth_failed");
        assert_eq!(fanout_code(CloudSttErrorCode::Network), "network_error");
        assert_eq!(fanout_code(CloudSttErrorCode::Timeout), "network_error");
        assert_eq!(fanout_code(CloudSttErrorCode::KeyMissing), "key_missing");
        assert_eq!(fanout_code(CloudSttErrorCode::RateLimit), "rate_limited");
        assert_eq!(
            fanout_code(CloudSttErrorCode::ProviderError),
            "provider_error"
        );
        assert_eq!(
            fanout_code(CloudSttErrorCode::AudioTooLarge),
            "provider_error"
        );
    }
}
