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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::winstt::cancel_registry::CancelRegistry;
use crate::winstt::commands::settings::core_timeout_from_winstt;
use crate::winstt::llm::{self, ollama_keep_alive_from_core_timeout};
use crate::winstt::model_swap::ModelSwapCoordinator;
use crate::winstt::ollama_client::OllamaClient;
pub use crate::winstt::ollama_client::{
    OllamaCapabilities, OllamaModelDetails, OllamaModelInfo, PullOutcome,
};
use crate::winstt::settings_store::read_settings_raw;

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
// After a warmup LOAD failure (e.g. the runner crashing because the model does
// not fit in VRAM), skip re-warming that model for this long so the 60s periodic
// loop doesn't churn the GPU with a ~28s crashing load every tick. After the
// backoff it tries once more (in case VRAM was freed); a success clears it.
const OLLAMA_LOAD_FAIL_BACKOFF: Duration = Duration::from_secs(300);
const LLM_WARMUP_PASS_KEY: &str = "llm:warmup-pass";
// A freshly-triggered warm (boot pass + on-toggle/on-select) retries on a short
// cadence instead of bailing once and waiting out the 60s periodic tick. The
// first attempt can lose the pass-claim to an in-flight periodic pass, or
// Ollama can be momentarily unreachable (just auto-spawned at boot, or busy
// unloading the previous model during a model switch). Without a retry the
// model stays cold until the next 60s tick — exactly the "first post-process is
// slow, the rest are fast" gap. ~8 × 1.5s ≈ 12s covers the Ollama spawn window
// and any switch contention; steady-state refresh stays on the 60s loop.
const OLLAMA_WARM_TRIGGER_ATTEMPTS: u32 = 8;
const OLLAMA_WARM_TRIGGER_RETRY_DELAY: Duration = Duration::from_millis(1500);

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
    ollama_keep_alive_timeout: crate::settings::AtomicModelUnloadTimeout,
    /// Stops background warmup/chat bookkeeping from starting new model loads
    /// once app shutdown begins.
    shutting_down: AtomicBool,
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
        // Ollama is ALWAYS a loopback endpoint, so it must NEVER go through a
        // system/VPN proxy. The default client honors HTTP(S)_PROXY/WinINET proxy
        // settings, which on a dev/corp machine can swallow 127.0.0.1 — the
        // reachability probe then fails (looks like Ollama is down) and WinSTT
        // spawns a redundant `ollama serve`. `no_proxy()` forces a direct loopback
        // connection; the bounded connect timeout makes a genuinely-dead endpoint
        // fail fast instead of hanging the probe. (The cloud `client` above keeps
        // proxy support — OpenRouter is remote and may need it.)
        let ollama_client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| client.clone());
        let timeout = core_timeout_from_winstt(read_settings_raw(app).global.model_unload_timeout);
        Self {
            app: app.clone(),
            client,
            ollama: OllamaClient::new(ollama_client),
            cancelled: CancelRegistry::new(),
            seq: AtomicU64::new(1),
            warmup_loop_started: AtomicBool::new(false),
            ollama_keep_alive_timeout: crate::settings::AtomicModelUnloadTimeout::new(timeout),
            shutting_down: AtomicBool::new(false),
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

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.cancel_all();
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
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
        ollama_keep_alive_from_core_timeout(self.ollama_keep_alive_timeout.load())
    }

    pub(crate) fn update_model_unload_timeout(&self, timeout: crate::settings::ModelUnloadTimeout) {
        self.ollama_keep_alive_timeout.store(timeout);
    }

    fn ollama_keep_alive_refresh_enabled(&self) -> bool {
        self.ollama_keep_alive_timeout.load() == crate::settings::ModelUnloadTimeout::Never
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}
