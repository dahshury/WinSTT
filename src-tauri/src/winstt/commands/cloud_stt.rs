// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md §2 + lib_wiring.md §3,
// frontend/electron/ipc/{stt-cloud,credentials}.ts. Wraps managers::CloudSttManager.
//
// Cloud-STT credential verify + cancel commands. The actual transcribe call is
// invoked internally by the TranscriptionManager when the active model is a cloud
// model (model.sttSource == "cloud") — it is NOT a renderer command. These two
// commands cover the picker's "verify key" button and the cancel gesture.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::cloud_stt::{CloudSttProvider, VerifyResult};
use crate::winstt::managers::CloudSttManager;

/// Verify-credential outcome surfaced to the renderer.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCredentialPayload {
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

impl From<VerifyResult> for VerifyCredentialPayload {
    fn from(r: VerifyResult) -> Self {
        match r {
            VerifyResult::Ok => VerifyCredentialPayload {
                ok: true,
                code: None,
                message: None,
            },
            VerifyResult::Failed { code, message } => VerifyCredentialPayload {
                ok: false,
                code: Some(code.as_str().to_string()),
                message: Some(message),
            },
        }
    }
}

/// `verify_cloud_stt_credential` — probe the provider's cheap GET endpoint,
/// honoring the ElevenLabs scoped-key special-case.
#[tauri::command]
#[specta::specta]
pub async fn verify_cloud_stt_credential(
    cloud: State<'_, Arc<CloudSttManager>>,
    provider: String,
    api_key: String,
) -> Result<VerifyCredentialPayload, String> {
    let provider_enum = CloudSttProvider::from_id(&provider)
        .ok_or_else(|| format!("unknown cloud STT provider: {provider}"))?;
    let mgr = cloud.inner().clone();
    let result = mgr.verify_credential(provider_enum, &api_key).await;
    Ok(result.into())
}

/// `cloud_stt_cancel` — abort an in-flight cloud transcribe (model swap / quit).
#[tauri::command]
#[specta::specta]
pub fn cloud_stt_cancel(cloud: State<'_, Arc<CloudSttManager>>, request_id: String) {
    cloud.cancel(&request_id);
}
