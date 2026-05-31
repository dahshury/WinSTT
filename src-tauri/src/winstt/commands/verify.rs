// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/10_frontend_port_plan.md
// (WU-7) + lib_wiring.md §3, frontend/electron/ipc/credentials.ts + frontend/electron/lib/
// cloud-provider-http.ts. Owns the ONE renderer verify seam (`integrations:verify`).
//
// The WinSTT renderer probes ALL THREE cloud credentials — OpenAI, ElevenLabs AND OpenRouter —
// through a SINGLE channel `INTEGRATIONS_VERIFY` (`integrations:verify`), expecting the response
// shape `{ ok: bool, code?: string, message?: string }`. The verify-credentials feature reads
// `code === "network"` to distinguish "couldn't reach the provider" (offline pill) from "key is
// wrong" (invalid pill), so the returned `code` MUST be the WinSTT taxonomy string
// (`auth | network | rate_limit | key_missing | provider_error`), never a bool.
//
// The pre-existing `winstt::commands::llm::verify_credential` returns `Result<bool, String>` (no
// code/message) and `winstt::commands::cloud_stt::verify_cloud_stt_credential` only covers
// OpenAI/ElevenLabs — neither matches the renderer's single-channel, full-payload, 3-provider
// contract. This command is the unified replacement the adapter routes `INTEGRATIONS_VERIFY` to.
//
// All classification is the SAME pure logic the cloud-STT transcribe path uses (status taxonomy,
// ElevenLabs scoped-key 401 `missing_permissions` = VALID, transport→network/provider split), so
// a verify verdict and a transcribe failure agree on the error code for the same response.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

use crate::winstt::cloud_stt::{
    classify_http_failure, classify_transport_error, is_elevenlabs_scoped_key_valid,
    CloudSttErrorCode,
};

/// 10s — verify is a single round-trip and shouldn't block the UI longer.
/// Mirrors VERIFY_TIMEOUT_MS in credentials.ts.
const VERIFY_TIMEOUT_SECS: u64 = 10;

/// Providers the verify-credentials channel accepts. The two cloud-STT providers
/// (`openai` / `elevenlabs`) plus `openrouter`, which is an LLM credential that
/// shares the same probe-and-classify shape. Mirrors `VerifiableProvider` /
/// `CloudHttpProvider` in cloud-provider-http.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerifiableProvider {
    OpenAi,
    ElevenLabs,
    OpenRouter,
}

impl VerifiableProvider {
    fn from_id(id: &str) -> Option<Self> {
        match id {
            "openai" => Some(VerifiableProvider::OpenAi),
            "elevenlabs" => Some(VerifiableProvider::ElevenLabs),
            "openrouter" => Some(VerifiableProvider::OpenRouter),
            _ => None,
        }
    }

    /// The cheapest auth-checking GET each provider exposes (no quota consumed,
    /// no audio uploaded). Mirrors probeUrlFor() in credentials.ts.
    ///   - OpenAI:     GET /v1/models
    ///   - OpenRouter: GET /api/v1/auth/key   (200 + key info on a valid Bearer)
    ///   - ElevenLabs: GET /v1/user
    fn probe_url(self) -> &'static str {
        match self {
            VerifiableProvider::OpenAi => "https://api.openai.com/v1/models",
            VerifiableProvider::OpenRouter => "https://openrouter.ai/api/v1/auth/key",
            VerifiableProvider::ElevenLabs => "https://api.elevenlabs.io/v1/user",
        }
    }

    /// Whether this provider is ElevenLabs (drives the scoped-key 401 special-case).
    fn is_elevenlabs(self) -> bool {
        matches!(self, VerifiableProvider::ElevenLabs)
    }
}

/// Verify-credential outcome surfaced to the renderer. Field names match the
/// WinSTT `VerifyResponse` interface (`{ ok, code?, message? }`) so the
/// verify-credentials feature + IntegrationsSettingsPanel consume it unchanged.
/// `code` is the WinSTT error taxonomy string — `network` maps to the "offline"
/// pill, anything else to "invalid".
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct VerifyCredentialResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl VerifyCredentialResponse {
    fn ok() -> Self {
        Self {
            ok: true,
            code: None,
            message: None,
        }
    }

    fn failed(code: CloudSttErrorCode, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: Some(code.as_str().to_string()),
            message: Some(message.into()),
        }
    }
}

/// Apply the provider's auth header to the request builder. OpenAI + OpenRouter
/// use standard Bearer auth; ElevenLabs uses a custom `xi-api-key` header.
/// Mirrors authHeadersFor() in cloud-provider-http.ts.
fn apply_auth(
    rb: reqwest::RequestBuilder,
    provider: VerifiableProvider,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        VerifiableProvider::ElevenLabs => rb.header("xi-api-key", api_key),
        VerifiableProvider::OpenAi | VerifiableProvider::OpenRouter => rb.bearer_auth(api_key),
    }
}

/// Classify a verify-probe HTTP response into the renderer payload, honoring the
/// ElevenLabs scoped-key special-case (a 401 `missing_permissions` body proves
/// the key authenticated — it merely lacks read scope on the probe endpoint).
/// Mirrors probeProvider()'s success / scoped / failure branches in credentials.ts.
fn classify_probe(
    provider: VerifiableProvider,
    status: u16,
    body: &str,
) -> VerifyCredentialResponse {
    if (200..300).contains(&status) {
        return VerifyCredentialResponse::ok();
    }
    if provider.is_elevenlabs() && is_elevenlabs_scoped_key_valid(status, body) {
        return VerifyCredentialResponse::ok();
    }
    let err = classify_http_failure(status, body, None);
    VerifyCredentialResponse::failed(err.code, err.message)
}

async fn probe(
    client: &reqwest::Client,
    provider: VerifiableProvider,
    api_key: &str,
) -> VerifyCredentialResponse {
    let rb = client
        .get(provider.probe_url())
        .timeout(Duration::from_secs(VERIFY_TIMEOUT_SECS));
    let rb = apply_auth(rb, provider, api_key);
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            classify_probe(provider, status, &body)
        }
        Err(e) => {
            // Transport failure (DNS / refused / timeout) → network so the
            // renderer shows the "could not verify" pill rather than "invalid".
            let err = classify_transport_error(&e.to_string());
            VerifyCredentialResponse::failed(err.code, err.message)
        }
    }
}

/// `verify_integration_credential` — the ONE renderer verify seam. Probes the
/// provider's cheap GET endpoint with the user-typed (possibly unsaved) key and
/// returns `{ ok, code?, message? }`. Side-effect-free: it never persists the key
/// (the renderer writes `verified`/`lastVerifiedAt` back through the settings
/// store on success). Covers OpenAI, ElevenLabs AND OpenRouter — the renderer
/// routes all three through the single `INTEGRATIONS_VERIFY` channel.
#[tauri::command]
#[specta::specta]
pub async fn verify_integration_credential(
    provider: String,
    api_key: String,
) -> Result<VerifyCredentialResponse, String> {
    let Some(provider) = VerifiableProvider::from_id(&provider) else {
        // Mirrors INVALID_PAYLOAD_RESULT in credentials.ts.
        return Ok(VerifyCredentialResponse::failed(
            CloudSttErrorCode::ProviderError,
            "Invalid verify payload",
        ));
    };
    if api_key.trim().is_empty() {
        return Ok(VerifyCredentialResponse::failed(
            CloudSttErrorCode::Auth,
            "API key is empty",
        ));
    }
    let client = reqwest::Client::new();
    Ok(probe(&client, provider, api_key.trim()).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_roundtrip_includes_openrouter() {
        assert_eq!(
            VerifiableProvider::from_id("openai"),
            Some(VerifiableProvider::OpenAi)
        );
        assert_eq!(
            VerifiableProvider::from_id("elevenlabs"),
            Some(VerifiableProvider::ElevenLabs)
        );
        assert_eq!(
            VerifiableProvider::from_id("openrouter"),
            Some(VerifiableProvider::OpenRouter)
        );
        assert_eq!(VerifiableProvider::from_id("azure"), None);
    }

    #[test]
    fn probe_urls_match_credentials_ts() {
        assert_eq!(
            VerifiableProvider::OpenAi.probe_url(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            VerifiableProvider::OpenRouter.probe_url(),
            "https://openrouter.ai/api/v1/auth/key"
        );
        assert_eq!(
            VerifiableProvider::ElevenLabs.probe_url(),
            "https://api.elevenlabs.io/v1/user"
        );
    }

    #[test]
    fn classify_probe_success_is_ok() {
        let r = classify_probe(VerifiableProvider::OpenAi, 200, "{}");
        assert!(r.ok);
        assert!(r.code.is_none());
    }

    #[test]
    fn classify_probe_openai_401_is_auth() {
        let r = classify_probe(VerifiableProvider::OpenAi, 401, "bad");
        assert!(!r.ok);
        assert_eq!(r.code.as_deref(), Some("auth"));
    }

    #[test]
    fn classify_probe_elevenlabs_scoped_key_is_ok() {
        let body = r#"{"detail":{"status":"missing_permissions"}}"#;
        let r = classify_probe(VerifiableProvider::ElevenLabs, 401, body);
        assert!(r.ok);
        // a genuinely bad EL key is still auth
        let bad = classify_probe(
            VerifiableProvider::ElevenLabs,
            401,
            r#"{"detail":{"status":"invalid_api_key"}}"#,
        );
        assert!(!bad.ok);
        assert_eq!(bad.code.as_deref(), Some("auth"));
    }

    #[test]
    fn classify_probe_rate_limit_carries_code() {
        let r = classify_probe(VerifiableProvider::OpenRouter, 429, "slow down");
        assert!(!r.ok);
        assert_eq!(r.code.as_deref(), Some("rate_limit"));
    }

    #[test]
    fn empty_key_is_not_network() {
        // Guards the renderer's offline-vs-invalid branch: an empty key must NOT
        // classify as `network` (that would show "could not verify" instead of
        // letting the feature short-circuit to the missing-key path).
        let r = VerifyCredentialResponse::failed(CloudSttErrorCode::Auth, "API key is empty");
        assert_eq!(r.code.as_deref(), Some("auth"));
    }
}
