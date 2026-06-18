// Wraps winstt::llm (pure prompt/leakage logic).
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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::commands::settings::{core_timeout_from_winstt, read_settings_raw};
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

// Warmup-loop tick. Each tick retries the boot warm until Ollama is reachable,
// and — ONLY under the "never unload" policy — re-warms so the model survives
// an Ollama restart/eviction. Finite policies are deliberately left to count
// down from the last real use (a periodic re-warm would reset them forever).
const OLLAMA_WARMUP_INTERVAL: Duration = Duration::from_secs(60);
const OLLAMA_WARMUP_TIMEOUT: Duration = Duration::from_secs(120);
const OLLAMA_EVICT_TIMEOUT: Duration = Duration::from_secs(5);
const OLLAMA_BOOT_WAIT: Duration = Duration::from_secs(10);
const OLLAMA_RECENT_WARM_SKIP: Duration = Duration::from_secs(30);
const LLM_WARMUP_PASS_KEY: &str = "llm:warmup-pass";
const CORE_TIMEOUT_NEVER: u8 = 0;
const CORE_TIMEOUT_IMMEDIATELY: u8 = 1;
const CORE_TIMEOUT_MIN2: u8 = 2;
const CORE_TIMEOUT_MIN5: u8 = 3;
const CORE_TIMEOUT_MIN10: u8 = 4;
const CORE_TIMEOUT_MIN15: u8 = 5;
const CORE_TIMEOUT_HOUR1: u8 = 6;
const CORE_TIMEOUT_SEC15: u8 = 7;

fn encode_core_timeout(timeout: crate::settings::ModelUnloadTimeout) -> u8 {
    match timeout {
        crate::settings::ModelUnloadTimeout::Never => CORE_TIMEOUT_NEVER,
        crate::settings::ModelUnloadTimeout::Immediately => CORE_TIMEOUT_IMMEDIATELY,
        crate::settings::ModelUnloadTimeout::Min2 => CORE_TIMEOUT_MIN2,
        crate::settings::ModelUnloadTimeout::Min5 => CORE_TIMEOUT_MIN5,
        crate::settings::ModelUnloadTimeout::Min10 => CORE_TIMEOUT_MIN10,
        crate::settings::ModelUnloadTimeout::Min15 => CORE_TIMEOUT_MIN15,
        crate::settings::ModelUnloadTimeout::Hour1 => CORE_TIMEOUT_HOUR1,
        crate::settings::ModelUnloadTimeout::Sec15 => CORE_TIMEOUT_SEC15,
    }
}

fn decode_core_timeout(code: u8) -> crate::settings::ModelUnloadTimeout {
    match code {
        CORE_TIMEOUT_NEVER => crate::settings::ModelUnloadTimeout::Never,
        CORE_TIMEOUT_IMMEDIATELY => crate::settings::ModelUnloadTimeout::Immediately,
        CORE_TIMEOUT_MIN2 => crate::settings::ModelUnloadTimeout::Min2,
        CORE_TIMEOUT_MIN5 => crate::settings::ModelUnloadTimeout::Min5,
        CORE_TIMEOUT_MIN10 => crate::settings::ModelUnloadTimeout::Min10,
        CORE_TIMEOUT_MIN15 => crate::settings::ModelUnloadTimeout::Min15,
        CORE_TIMEOUT_HOUR1 => crate::settings::ModelUnloadTimeout::Hour1,
        CORE_TIMEOUT_SEC15 => crate::settings::ModelUnloadTimeout::Sec15,
        _ => crate::settings::ModelUnloadTimeout::default(),
    }
}

/// Thin emit sink that forwards live reasoning deltas to the renderer pill.
/// Mirrors the `llm:reasoning-delta` plain-string event (07_* §4b).
struct EmitReasoningSink {
    app: AppHandle,
    request_id: String,
}

impl llm::ReasoningSink for EmitReasoningSink {
    fn on_delta(&self, delta: &str) {
        let _ = self.app.emit(
            "llm:reasoning-delta",
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
    /// Cached shared unload policy for Ollama `keep_alive`, updated by settings runtime hooks.
    ollama_keep_alive_timeout: AtomicU8,
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
        let timeout = core_timeout_from_winstt(read_settings_raw(app).global.model_unload_timeout);
        Self {
            app: app.clone(),
            client: client.clone(),
            ollama: OllamaClient::new(client),
            cancelled: CancelRegistry::new(),
            seq: AtomicU64::new(1),
            warmup_loop_started: AtomicBool::new(false),
            ollama_keep_alive_timeout: AtomicU8::new(encode_core_timeout(timeout)),
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

    pub(crate) fn clear_cancel(&self, request_id: &str) {
        self.cancelled.clear(request_id);
    }

    fn ollama_keep_alive(&self) -> serde_json::Value {
        let timeout = decode_core_timeout(self.ollama_keep_alive_timeout.load(Ordering::Acquire));
        ollama_keep_alive_from_core_timeout(timeout)
    }

    pub(crate) fn update_model_unload_timeout(&self, timeout: crate::settings::ModelUnloadTimeout) {
        self.ollama_keep_alive_timeout
            .store(encode_core_timeout(timeout), Ordering::Release);
    }

    fn ollama_keep_alive_refresh_enabled(&self) -> bool {
        self.ollama_keep_alive_timeout.load(Ordering::Acquire) == CORE_TIMEOUT_NEVER
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}
