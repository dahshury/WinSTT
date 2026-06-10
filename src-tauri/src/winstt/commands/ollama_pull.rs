// Reference: frontend/electron/ipc/llm.ts.
//
// Two commands that don't belong in the (already-landed) `commands/llm.rs` and that the
// existing `LlmManager` has no field for, so they live here behind a small module-local registry —
// keeps the HARD RULE intact (NEW file under winstt/commands/, no edits to llm.rs / llm_manager.rs):
//
//   - ollama_cancel_pull   → LLM_CANCEL_PULL_MODEL  → returns { cancelled: bool }
//   - llm_get_warmup_status → LLM_GET_WARMUP_STATUS → returns LlmWarmupStatus | null
//
// CANCEL CONTRACT: `ollama_pull` (in llm.rs; now wired against `LlmManager::ollama_pull_stream`'s
// streaming `POST /api/pull` drain) calls `is_pull_cancelled(&model)` between NDJSON chunks and aborts
// the stream when it returns true, then `clear_pull_cancel(&model)`. The pull-progress event it emits is
// the plain `llm:pull-progress` channel carrying an `OllamaPullProgress` payload (shape below mirrors
// spec/openapi.yaml so the reused renderer's `onOllamaPullProgress` listener parses it unchanged).
//
// WARMUP CONTRACT: the warmup broadcaster is WIP in WinSTT too (the renderer treats `null` as "no
// warmup info yet, hide the banner" — see frontend models.ts). We return `None` until the warmup
// loop in `LlmManager` is wired; the typed payload below lets that loop emit `llm:warmup-status`
// (plain event) and have this command return the last snapshot once a snapshot store is added.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::managers::LlmManager;
use crate::winstt::sync_ext::MutexExt;

use super::llm::authorize_ollama_model_management_label;

// ── Pull-cancel registry (module-local; consulted by the streaming pull drain) ──

static PULL_CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static LAST_WARMUP_STATUS: Lazy<Mutex<Option<LlmWarmupStatus>>> = Lazy::new(|| Mutex::new(None));

/// Mark a model's in-flight pull as cancelled. Idempotent.
pub fn mark_pull_cancelled(model: &str) {
    PULL_CANCELLED.lock_recover().insert(model.to_string());
}

/// True if the given model's pull has been cancelled. The streaming pull loop in `ollama_pull`
/// checks this between NDJSON chunks.
pub fn is_pull_cancelled(model: &str) -> bool {
    PULL_CANCELLED.lock_recover().contains(model)
}

/// Clear a model's cancel flag once the pull loop has torn down (or completed).
pub fn clear_pull_cancel(model: &str) {
    PULL_CANCELLED.lock_recover().remove(model);
}

// ── Pull-progress event payload (plain `llm:pull-progress`, mirrors spec) ────────

/// Coalesced status stage from the streaming `/api/pull` response.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OllamaPullProgressStatus {
    Pulling,
    Downloading,
    Verifying,
    Writing,
    Success,
    Error,
    Cancelled,
}

/// Streaming progress event for a model pull — emitted on the plain `llm:pull-progress` channel.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: OllamaPullProgressStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Warmup status payload (mirrors frontend models.ts LlmWarmupStatus) ───────────

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LlmWarmupOutcome {
    Ok,
    ModelNotFound,
    LoadFailed,
    Unreachable,
    Skipped,
    Loading,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmWarmupModelStatus {
    pub model: String,
    pub outcome: LlmWarmupOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_body: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmWarmupStatus {
    pub endpoint: String,
    pub in_progress: bool,
    pub models: Vec<LlmWarmupModelStatus>,
    pub ollama_installed: bool,
    pub reachable: bool,
    pub timestamp: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelPullResult {
    pub cancelled: bool,
}

pub fn set_warmup_status(status: LlmWarmupStatus) {
    if let Ok(mut last) = LAST_WARMUP_STATUS.lock() {
        *last = Some(status);
    }
}

pub fn clear_warmup_status() {
    if let Ok(mut last) = LAST_WARMUP_STATUS.lock() {
        *last = None;
    }
}

// ── Commands ────────────────────────────────────────────────────────────────────

/// `ollama_cancel_pull` → `LLM_CANCEL_PULL_MODEL`. Flags the model's in-flight pull for the
/// streaming drain in `ollama_pull` to abort. Returns `{ cancelled: true }` on registration.
#[tauri::command]
#[specta::specta]
pub fn ollama_cancel_pull(
    webview: tauri::WebviewWindow,
    model: String,
) -> Result<CancelPullResult, String> {
    authorize_ollama_model_management_label(webview.label(), "cancel Ollama model pull")?;
    mark_pull_cancelled(&model);
    Ok(CancelPullResult { cancelled: true })
}

/// `llm_get_warmup_status` → `LLM_GET_WARMUP_STATUS`. Last warmup snapshot, or `null` while the
/// warmup broadcaster is unwired (renderer hides the banner on `null`).
#[tauri::command]
#[specta::specta]
pub fn llm_get_warmup_status() -> Result<Option<LlmWarmupStatus>, String> {
    // No snapshot store yet — the warmup loop in LlmManager (07_*) will populate one and emit
    // `llm:warmup-status`. Until then, mirror WinSTT's WIP behavior: no info → null → banner hidden.
    Ok(LAST_WARMUP_STATUS.lock().ok().and_then(|last| last.clone()))
}

/// `llm_retry_warmup` → user-triggered retry for the inline warmup banner.
/// Runs the same coalesced warmup pass as the periodic loop, then returns the
/// latest snapshot so the settings UI updates even if it missed the event.
#[tauri::command]
#[specta::specta]
pub async fn llm_retry_warmup(
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<Option<LlmWarmupStatus>, String> {
    llm_manager.warm_enabled_models().await;
    llm_get_warmup_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_registry_round_trips() {
        let model = "llama3.2:1b";
        assert!(!is_pull_cancelled(model));
        mark_pull_cancelled(model);
        assert!(is_pull_cancelled(model));
        clear_pull_cancel(model);
        assert!(!is_pull_cancelled(model));
    }

    #[test]
    fn pull_status_serializes_lowercase() {
        let json = serde_json::to_string(&OllamaPullProgressStatus::Downloading).unwrap();
        assert_eq!(json, "\"downloading\"");
    }

    #[test]
    fn warmup_outcome_serializes_kebab() {
        let json = serde_json::to_string(&LlmWarmupOutcome::ModelNotFound).unwrap();
        assert_eq!(json, "\"model-not-found\"");
    }

    #[test]
    fn warmup_status_can_be_cleared_to_null() {
        set_warmup_status(LlmWarmupStatus {
            endpoint: "http://localhost:11434".into(),
            in_progress: false,
            models: Vec::new(),
            ollama_installed: false,
            reachable: false,
            timestamp: 1.0,
        });
        assert!(llm_get_warmup_status().unwrap().is_some());

        clear_warmup_status();

        assert!(llm_get_warmup_status().unwrap().is_none());
    }
}
