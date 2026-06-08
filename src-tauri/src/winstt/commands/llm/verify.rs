// The `verify_credential` provider-key probe internals (shared OpenRouter /
// ElevenLabs classification). Split out of the `llm` command root; the
// `#[tauri::command] verify_credential` entry STAYS in the root (`llm.rs`) — the
// codebase keeps every command's `#[tauri::command]` in its module root so the
// macro-generated `__cmd__*` wrapper resolves at the registered command path —
// and drives these `pub(super)` helpers.

use std::time::Duration;

use tauri::AppHandle;

use crate::winstt::cloud_stt::{
    classify_http_failure, classify_transport_error, is_elevenlabs_scoped_key_valid,
};

use super::payloads::VerifyCredentialPayload;
use crate::winstt::commands::settings::{read_settings, SECRET_PRESENT_SENTINEL};

// ── verify probe (shared OpenAI/OpenRouter/ElevenLabs classification) ──────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum VerifyProbe {
    OpenRouter,
    ElevenLabs,
}

pub(super) fn resolve_verify_api_key(app: &AppHandle, probe: VerifyProbe, api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed != SECRET_PRESENT_SENTINEL {
        return trimmed.to_string();
    }
    let settings = read_settings(app);
    match probe {
        VerifyProbe::OpenRouter => settings.llm.openrouter_api_key,
        VerifyProbe::ElevenLabs => settings.integrations.elevenlabs.api_key,
    }
}

impl VerifyProbe {
    fn url(self) -> &'static str {
        match self {
            VerifyProbe::OpenRouter => "https://openrouter.ai/api/v1/auth/key",
            VerifyProbe::ElevenLabs => "https://api.elevenlabs.io/v1/user",
        }
    }
}

pub(super) async fn probe_verify(probe: VerifyProbe, api_key: &str) -> VerifyCredentialPayload {
    let client = reqwest::Client::new();
    let mut rb = client.get(probe.url()).timeout(Duration::from_secs(10));
    rb = match probe {
        VerifyProbe::ElevenLabs => rb.header("xi-api-key", api_key),
        VerifyProbe::OpenRouter => rb.bearer_auth(api_key),
    };
    match rb.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                return VerifyCredentialPayload {
                    ok: true,
                    code: None,
                    message: None,
                };
            }
            // A scoped ElevenLabs key 401s on /v1/user yet is valid for TTS.
            if probe == VerifyProbe::ElevenLabs && is_elevenlabs_scoped_key_valid(status, &body) {
                return VerifyCredentialPayload {
                    ok: true,
                    code: None,
                    message: None,
                };
            }
            let err = classify_http_failure(status, &body, None);
            VerifyCredentialPayload {
                ok: false,
                code: Some(err.code.as_str().to_string()),
                message: Some(err.message),
            }
        }
        Err(e) => {
            let err = classify_transport_error(&e.to_string());
            VerifyCredentialPayload {
                ok: false,
                code: Some(err.code.as_str().to_string()),
                message: Some(err.message),
            }
        }
    }
}
