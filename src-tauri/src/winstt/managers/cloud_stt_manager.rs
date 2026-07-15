// Cloud STT transport. Wraps winstt::cloud_stt's pure layer.
//
// CloudSttManager owns the reqwest client + the in-flight transcribe cancel set.
// It implements the multipart upload against real reqwest, and routes
// verify/transcribe through the pure classification helpers in `cloud_stt`
// (status taxonomy, EL scoped-key handling, retry-after). The live pipeline
// calls `transcribe_samples` from `TranscriptionManager::transcribe` when the
// selected model id carries a cloud prefix (`openai:` / `elevenlabs:`).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::cloud_stt::{
    CLOUD_TRANSCRIBE_TIMEOUT_SECS, CloudSttError, CloudSttErrorCode, CloudSttProvider,
    CloudTranscribeRequest, CloudTranscription, VerifyResult, classify_http_failure,
    classify_transport_error, classify_verify, default_cloud_model_id, emit_cloud_failure,
    parse_transcription_json, preflight, samples_to_wav_bytes, split_model_id,
};

/// Cost telemetry of the most recent successful cloud upload, consumed by the
/// dictation pipeline when it persists the history row (`take_last_run_cost`).
#[derive(Debug, Clone)]
pub struct CloudSttRunCost {
    pub cost_usd: f64,
    pub cost_is_estimate: bool,
}

pub struct CloudSttManager {
    app: AppHandle,
    client: reqwest::Client,
    /// request_id → cancelled. A model swap / quit aborts in-flight uploads.
    cancelled: CancelRegistry,
    /// Monotonic counter for auto-generated request ids (the live pipeline call
    /// path has no renderer-supplied id; the cancel command supplies its own).
    next_request: AtomicU64,
    /// Cost of the latest completed upload. Dictations are serialized (one
    /// final decode at a time), so a take-after-decode read is race-free in
    /// practice; `take` clears it so a later local decode can't inherit it.
    last_run_cost: Mutex<Option<CloudSttRunCost>>,
}

impl CloudSttManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            // Shared pooled client (cheap Arc clone) — reuses the same
            // connection pool as the TTS engines and verify probes.
            client: crate::winstt::net::http_client().clone(),
            cancelled: CancelRegistry::new(),
            next_request: AtomicU64::new(0),
            last_run_cost: Mutex::new(None),
        }
    }

    /// Take (and clear) the cost of the most recent successful cloud upload.
    pub fn take_last_run_cost(&self) -> Option<CloudSttRunCost> {
        self.last_run_cost
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    fn record_run_cost(&self, transcription: &CloudTranscription) {
        let Ok(mut slot) = self.last_run_cost.lock() else {
            return;
        };
        *slot = transcription.cost_usd.map(|cost_usd| CloudSttRunCost {
            cost_usd,
            cost_is_estimate: transcription.cost_is_estimate,
        });
    }

    fn next_request_id(&self) -> String {
        let n = self.next_request.fetch_add(1, Ordering::Relaxed);
        format!("cloud-stt-{n}")
    }

    pub fn cancel(&self, request_id: &str) {
        self.cancelled.cancel(request_id);
    }

    pub fn cancel_all(&self) {
        self.cancelled.cancel_all();
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled.is_cancelled(request_id, false)
    }

    fn clear(&self, request_id: &str) {
        self.cancelled.clear(request_id);
    }

    /// Emit the single code-discriminated cloud error channel (07_* §4b).
    /// `aborted` is suppressed (user-initiated cancel).
    ///
    /// The renderer's `CloudSttErrorToasts` fan-out routes ONE
    /// `stt:cloud-error` event to one of the five
    /// WinSTT channels by matching the payload `code` against the fan-out tokens
    /// `auth_failed | network_error | key_missing | rate_limited | provider_error`.
    /// So we emit the FAN-OUT token (not the raw taxonomy `auth`/`network`/…) and
    /// include `provider` + `retryAfter` exactly like the reference handler's
    /// `notifyRenderer` payload.
    fn emit_error(&self, provider: CloudSttProvider, err: &CloudSttError) {
        emit_cloud_failure(
            &self.app,
            provider,
            err.code,
            err.message.clone(),
            err.retry_after_seconds,
        );
    }

    /// Transcribe one utterance via the cloud provider. Honors the pre-flight
    /// guards (key + size), the per-request cancel token, the 90s ceiling, and
    /// the typed error taxonomy. On error, emits `stt:cloud-error` and returns it.
    pub async fn transcribe(
        &self,
        request_id: &str,
        req: CloudTranscribeRequest,
    ) -> Result<CloudTranscription, CloudSttError> {
        let cancel = self.cancelled.cancel_token(request_id);
        let provider = req.provider;
        if let Err(e) = preflight(&req) {
            self.clear(request_id);
            self.emit_error(provider, &e);
            return Err(e);
        }
        if self.is_cancelled(request_id) {
            self.clear(request_id);
            return Err(CloudSttError::new(CloudSttErrorCode::Aborted, "cancelled"));
        }

        let result = crate::winstt::cloud_metrics::timed(
            provider.id(),
            "stt_transcribe",
            self.do_upload(req, &cancel),
            |e: &CloudSttError| e.message.clone(),
        )
        .await;
        if self.is_cancelled(request_id) {
            self.clear(request_id);
            return Err(CloudSttError::new(CloudSttErrorCode::Aborted, "cancelled"));
        }
        self.clear(request_id);
        if let Err(ref e) = result {
            self.emit_error(provider, e);
        }
        result
    }

    /// LIVE pipeline entry point. Called from `TranscriptionManager::transcribe`
    /// when the selected model id carries a cloud prefix. Resolves the provider +
    /// bare model id from `model_id` (`<provider>:<id>`), pulls the matching API
    /// key supplied by the caller, encodes the 16 kHz mono f32 capture into an
    /// in-memory WAV, and runs the upload. Returns
    /// the transcript text (the contract `TranscriptionManager::transcribe`
    /// expects); on any failure it emits `stt:cloud-error` (via `transcribe`) and
    /// returns the typed error.
    ///
    /// `language`: the validated decode language (`None` = auto-detect). Mirrors
    /// the optional `language` / `language_code` multipart field.
    pub async fn transcribe_samples(
        &self,
        model_id: &str,
        samples: &[f32],
        language: Option<String>,
        api_key: String,
    ) -> Result<String, CloudSttError> {
        let (provider, bare_id) = split_model_id(model_id).ok_or_else(|| {
            CloudSttError::new(
                CloudSttErrorCode::ProviderError,
                format!("'{model_id}' is not a cloud STT model id"),
            )
        })?;

        // A bare `<provider>:` with no model picks the curated default (parity
        // with the renderer's `defaultCloudModelId`).
        let model_for_request = if bare_id.is_empty() {
            split_model_id(&default_cloud_model_id(provider))
                .map(|(_, id)| id)
                .unwrap_or(bare_id)
        } else {
            bare_id
        };

        // Encode BEFORE the preflight so the size guard sees the real byte count.
        let audio_wav = samples_to_wav_bytes(samples).inspect_err(|e| {
            self.emit_error(provider, e);
        })?;

        let req = CloudTranscribeRequest {
            provider,
            model_id: model_for_request,
            api_key,
            language,
            media_type: "audio/wav".into(),
            audio_wav,
        };

        let request_id = self.next_request_id();
        let result = self.transcribe(&request_id, req).await?;
        self.record_run_cost(&result);
        Ok(result.text)
    }

    async fn do_upload(
        &self,
        req: CloudTranscribeRequest,
        cancel: &CancellationToken,
    ) -> Result<CloudTranscription, CloudSttError> {
        // Destructure the owned request so the WAV buffer MOVES into the
        // multipart part instead of being cloned (utterances are multi-MB).
        let CloudTranscribeRequest {
            provider,
            model_id,
            api_key,
            language,
            media_type,
            audio_wav,
        } = req;
        let endpoint = provider.endpoint();
        let timeout = Duration::from_secs(CLOUD_TRANSCRIBE_TIMEOUT_SECS);
        let language = language.filter(|lang| !lang.is_empty());

        // ElevenLabs takes a multipart file upload. OpenRouter's dedicated
        // `/audio/transcriptions` endpoint is OpenAI-compatible but takes a JSON
        // body with the WAV bytes base64-encoded under `input_audio` (no
        // multipart). Both then share the send / status / parse / cancel logic below.
        let rb = match provider {
            CloudSttProvider::ElevenLabs => {
                let part = reqwest::multipart::Part::bytes(audio_wav)
                    .file_name("audio.wav")
                    .mime_str(&media_type)
                    .map_err(|e| {
                        CloudSttError::new(CloudSttErrorCode::ProviderError, e.to_string())
                    })?;
                let mut form = reqwest::multipart::Form::new()
                    .part("file", part)
                    .text("model_id", model_id);
                if let Some(lang) = language {
                    form = form.text("language_code", lang);
                }
                self.client
                    .post(endpoint)
                    .multipart(form)
                    .timeout(timeout)
                    .header("xi-api-key", &api_key)
            }
            CloudSttProvider::OpenRouter => {
                let mut b64 =
                    String::with_capacity(base64::encoded_len(audio_wav.len(), true).unwrap_or(0));
                STANDARD.encode_string(&audio_wav, &mut b64);
                let mut body = serde_json::json!({
                    "model": model_id,
                    "input_audio": { "data": b64, "format": "wav" },
                    // Opt into usage accounting so the response carries the
                    // exact billed cost (`usage.cost`) for the History footer.
                    "usage": { "include": true },
                });
                if let Some(lang) = language {
                    body["language"] = serde_json::Value::String(lang);
                }
                self.client
                    .post(endpoint)
                    .json(&body)
                    .timeout(timeout)
                    .bearer_auth(&api_key)
            }
        };

        // Race the whole upload against the per-request cancel token. On cancel
        // the upload future is dropped, which makes reqwest abort the in-flight
        // connection (the only way to cancel a reqwest request); return `Aborted`
        // so the toast is suppressed. cancel_all() (overlay X / model swap) and
        // cancel(id) both fire this token.
        let upload = async move {
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
            Ok(parse_transcription_json(provider, &json))
        };

        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                Err(CloudSttError::new(CloudSttErrorCode::Aborted, "cancelled"))
            }
            res = upload => res,
        }
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
            CloudSttProvider::OpenRouter => rb.bearer_auth(api_key),
            CloudSttProvider::ElevenLabs => rb.header("xi-api-key", api_key),
        };
        let started = std::time::Instant::now();
        let sent = rb.send().await;
        crate::winstt::cloud_metrics::record(
            provider.id(),
            "verify",
            started.elapsed(),
            sent.as_ref().err().map(|e| e.to_string()).as_deref(),
        );
        match sent {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::cloud_stt::cloud_error_fanout_code;

    /// The fan-out tokens the renderer's direct native event boundary routes on.
    /// Exercises the REAL mapping (`cloud_error_fanout_code`) rather than a
    /// test-local copy that could drift from it.
    #[test]
    fn fanout_tokens_match_adapter() {
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::Auth),
            "auth_failed"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::Network),
            "network_error"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::Timeout),
            "network_error"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::KeyMissing),
            "key_missing"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::RateLimit),
            "rate_limited"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::ProviderError),
            "provider_error"
        );
        assert_eq!(
            cloud_error_fanout_code(CloudSttErrorCode::AudioTooLarge),
            "provider_error"
        );
    }
}
