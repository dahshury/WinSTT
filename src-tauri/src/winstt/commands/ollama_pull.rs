// Reference: frontend/electron/ipc/llm.ts.
//
// The pull-cancel + warmup-status commands. The mutable state they read/write (the
// pull-cancel set and the last warmup snapshot) lives on `OllamaManager` (managed
// state); commands take `State<'_, Arc<OllamaManager>>`. The few context-free callers
// in `llm.rs::ollama_pull` and `llm_manager::warmup` reach the same manager through
// the thin free functions below, which delegate to the process-global handle:
//
//   - ollama_cancel_pull    → LLM_CANCEL_PULL_MODEL  → returns { cancelled: bool }
//   - llm_warmup_status     → LLM_GET_WARMUP_STATUS  → returns LlmWarmupStatus | null
//   - llm_retry_warmup      → re-runs a warmup pass, then returns the snapshot
//
// CANCEL CONTRACT: `ollama_pull` (in llm.rs, wired against `LlmManager::ollama_pull_stream`'s
// streaming `POST /api/pull` drain) calls `is_pull_cancelled(&model)` between NDJSON chunks and aborts
// the stream when it returns true, then `clear_pull_cancel(&model)`. The pull-progress event it emits is
// the plain `llm:pull-progress` channel carrying an `OllamaPullProgress` payload (shape below mirrors
// spec/openapi.yaml so the reused renderer's `onOllamaPullProgress` listener parses it unchanged).
//
// WARMUP CONTRACT: `llm_manager::warmup` publishes a snapshot via `set_warmup_status` / clears it via
// `clear_warmup_status` (and emits `llm:warmup-status`). `llm_warmup_status` returns the last
// snapshot, or `null` before any pass has run (the renderer treats `null` as "no info, hide the banner").

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::managers::ollama_manager::global as ollama_manager;
use crate::winstt::managers::{LlmManager, OllamaManager};

use super::llm::authorize_ollama_model_management_label;

// ── Pull-cancel registry (state lives on `OllamaManager`; the streaming pull drain
// polls it). The free functions below delegate to the process-global manager so the
// context-free callers in `llm.rs::ollama_pull` and `llm_manager::warmup` keep their
// signatures. The B4 `lock_recover` poison policy is preserved inside the manager.

/// True if the given model's pull has been cancelled. The streaming pull loop in `ollama_pull`
/// checks this between NDJSON chunks.
pub fn is_pull_cancelled(model: &str) -> bool {
    ollama_manager().is_pull_cancelled(model)
}

/// Clear a model's cancel flag once the pull loop has torn down (or completed).
pub fn clear_pull_cancel(model: &str) {
    ollama_manager().clear_pull_cancel(model);
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

/// Publish the latest warmup snapshot. Delegates to the process-global manager so
/// `llm_manager::warmup` keeps its context-free signature.
pub fn set_warmup_status(status: LlmWarmupStatus) {
    ollama_manager().set_warmup_status(status);
}

/// Clear the warmup snapshot (renderer treats `null` as "no info, hide the banner").
pub fn clear_warmup_status() {
    ollama_manager().clear_warmup_status();
}

// ── Commands ────────────────────────────────────────────────────────────────────

/// `ollama_cancel_pull` → `LLM_CANCEL_PULL_MODEL`. Flags the model's in-flight pull for the
/// streaming drain in `ollama_pull` to abort. Returns `{ cancelled: true }` on registration.
#[tauri::command]
#[specta::specta]
pub fn ollama_cancel_pull(
    ollama_manager: State<'_, Arc<OllamaManager>>,
    webview: tauri::WebviewWindow,
    model: String,
) -> Result<CancelPullResult, String> {
    authorize_ollama_model_management_label(webview.label(), "cancel Ollama model pull")?;
    ollama_manager.mark_pull_cancelled(&model);
    Ok(CancelPullResult { cancelled: true })
}

/// `llm_warmup_status` → `LLM_GET_WARMUP_STATUS`. Last warmup snapshot, or `null` when no
/// warmup pass has published one yet (renderer hides the banner on `null`).
#[tauri::command]
#[specta::specta]
pub fn llm_warmup_status(
    ollama_manager: State<'_, Arc<OllamaManager>>,
) -> Result<Option<LlmWarmupStatus>, String> {
    Ok(ollama_manager.warmup_status())
}

/// `llm_retry_warmup` → user-triggered retry for the inline warmup banner.
/// Runs the same coalesced warmup pass as the periodic loop, then returns the
/// latest snapshot so the settings UI updates even if it missed the event.
#[tauri::command]
#[specta::specta]
pub async fn llm_retry_warmup(
    llm_manager: State<'_, Arc<LlmManager>>,
    ollama_manager: State<'_, Arc<OllamaManager>>,
) -> Result<Option<LlmWarmupStatus>, String> {
    llm_manager.warm_enabled_models().await;
    Ok(ollama_manager.warmup_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_registry_round_trips() {
        // Exercise the manager directly so the test does not share the process-global.
        let mgr = OllamaManager::new();
        let model = "llama3.2:1b";
        assert!(!mgr.is_pull_cancelled(model));
        mgr.mark_pull_cancelled(model);
        assert!(mgr.is_pull_cancelled(model));
        mgr.clear_pull_cancel(model);
        assert!(!mgr.is_pull_cancelled(model));
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
        let mgr = OllamaManager::new();
        mgr.set_warmup_status(LlmWarmupStatus {
            endpoint: "http://localhost:11434".into(),
            in_progress: false,
            models: Vec::new(),
            ollama_installed: false,
            reachable: false,
            timestamp: 1.0,
        });
        assert!(mgr.warmup_status().is_some());

        mgr.clear_warmup_status();

        assert!(mgr.warmup_status().is_none());
    }
}
