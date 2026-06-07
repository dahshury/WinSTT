// Source: docs/archive/port/07_llm_cloud_context_longtail.md §1,
// frontend/electron/ipc/llm.ts + ollama.ts. Wraps winstt::llm (pure prompt/leakage logic).
//
// LlmManager owns LLM orchestration, request ids, cancellation, and renderer events.
// Ollama's raw HTTP transport lives in winstt::ollama_client.
// The pure prompt composition + CoT-leakage/salvage + Ollama body builders all
// live in `winstt::llm`; this manager is the stateful, async, app-aware shell.
//
// Connection values (endpoint / api key) are read from the persisted settings via
// `settings::get_settings` at call time so a key change takes effect with no restart
// (hot-swap path). Ollama keep-alive follows the shared model lifetime setting.
//
// The four loosely-coupled concerns hung off `LlmManager` live in submodules, each
// a further `impl LlmManager` block sharing the struct's private fields:
//   - `warmup`       — the Ollama warmup lifecycle (periodic loop, reachability,
//                      eviction, per-model warmup, status publishing).
//   - `ollama_chat`  — the Ollama chat path (capabilities, dictation/transform,
//                      streaming, list/detect/delete/pull).
//   - `openrouter`   — the self-contained OpenRouter provider.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::commands::settings::read_settings;
use crate::winstt::llm::{self, ollama_keep_alive_from_core_timeout};
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::ollama_client::OllamaClient;
pub use crate::winstt::ollama_client::{
    OllamaCapabilities, OllamaModelDetails, OllamaModelInfo, PullOutcome,
};

mod ollama_chat;
mod openrouter;
mod warmup;

pub use openrouter::{OpenRouterEndpointInfo, OpenRouterModelInfo, OpenRouterScan};

const OLLAMA_WARMUP_INTERVAL: Duration = Duration::from_secs(4 * 60);
const OLLAMA_WARMUP_TIMEOUT: Duration = Duration::from_secs(120);
const OLLAMA_EVICT_TIMEOUT: Duration = Duration::from_secs(5);
const OLLAMA_BOOT_WAIT: Duration = Duration::from_secs(10);
const OLLAMA_RECENT_WARM_SKIP: Duration = Duration::from_secs(30);
const LLM_WARMUP_PASS_KEY: &str = "llm:warmup-pass";

/// Thin emit sink that forwards live reasoning deltas to the renderer pill.
/// Mirrors the `llm-reasoning-delta` plain-string event (07_* §4b).
struct EmitReasoningSink {
    app: AppHandle,
    request_id: String,
}

impl llm::ReasoningSink for EmitReasoningSink {
    fn on_delta(&self, delta: &str) {
        let _ = self.app.emit(
            "llm-reasoning-delta",
            serde_json::json!({ "requestId": self.request_id, "delta": delta }),
        );
    }
}

/// All-Rust LLM post-processing manager.
pub struct LlmManager {
    app: AppHandle,
    client: reqwest::Client,
    ollama: OllamaClient,
    /// Cancelled request ids — the Ollama drain loop checks this between chunks.
    cancelled: CancelRegistry,
    /// Monotonic request-id source for fire-and-emit calls without a renderer id.
    seq: AtomicU64,
    /// Guards the app-lifetime periodic keep-alive loop against duplicate startup wiring.
    warmup_loop_started: AtomicBool,
    /// Coalesces Ollama warmup passes and tracks models this process warmed.
    lifecycle: ModelSwapCoordinator,
    /// OpenRouter `supported_parameters` from the latest model scan. The chat
    /// path uses this to avoid sending unsupported model-specific controls.
    openrouter_supported_parameters: Mutex<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Default)]
pub struct LlmChatOutput {
    pub text: String,
    pub side_effects: llm::DictationSideEffects,
}

impl LlmManager {
    pub fn new(app: &AppHandle) -> Self {
        let client = reqwest::Client::new();
        Self {
            app: app.clone(),
            client: client.clone(),
            ollama: OllamaClient::new(client),
            cancelled: CancelRegistry::new(),
            seq: AtomicU64::new(1),
            warmup_loop_started: AtomicBool::new(false),
            lifecycle: ModelSwapCoordinator::new(),
            openrouter_supported_parameters: Mutex::new(HashMap::new()),
        }
    }

    pub fn next_request_id(&self) -> String {
        format!("llm-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }

    /// Mark a request cancelled (a model swap / new dictation aborts the prior).
    pub fn cancel(&self, request_id: &str) {
        self.cancelled.cancel(request_id);
    }

    pub fn cancel_all(&self) {
        self.cancelled.cancel_all();
    }

    fn track_cancel(&self, request_id: &str) {
        self.cancelled.track(request_id);
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled.is_cancelled(request_id, false)
    }

    fn clear_cancel(&self, request_id: &str) {
        self.cancelled.clear(request_id);
    }

    fn ollama_keep_alive(&self) -> serde_json::Value {
        let timeout = read_settings(&self.app).global.model_unload_timeout;
        let timeout = crate::winstt::commands::settings::core_timeout_from_winstt(timeout);
        ollama_keep_alive_from_core_timeout(timeout)
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}
