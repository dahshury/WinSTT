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
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

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
// This loop is legitimately periodic (not a convert-to-callback candidate):
// it self-heals against EXTERNAL state changes — Ollama restarting or evicting
// a model out from under us — for which Ollama emits no event.
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
// A warm-up `/api/generate` that takes at least this long indicates the model
// was COLD (a fresh llama.cpp instance with an empty prompt cache) — re-prime
// the dictation prompt prefix even if this process primed a previous residency
// (an external eviction/Ollama restart reset the server-side cache). A
// keep-alive refresh of an already-resident model returns in well under a
// second (~0.3-0.7s observed) and skips the redundant re-prime.
const OLLAMA_COLD_LOAD_PRIME_THRESHOLD: Duration = Duration::from_millis(1000);

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
    /// In-flight request cancellation — the Ollama drain and cloud chat paths
    /// hold each request's awaitable token and `select!` on it.
    cancelled: CancelRegistry,
    /// Monotonic request-id source for fire-and-emit calls without a renderer id.
    seq: AtomicU64,
    /// Guards the app-lifetime periodic keep-alive loop against duplicate startup wiring.
    warmup_loop_started: AtomicBool,
    /// Cached shared unload policy for Ollama `keep_alive`, updated by settings runtime hooks.
    ollama_keep_alive_timeout: crate::settings::AtomicModelUnloadTimeout,
    /// Latching app-shutdown signal. Background tasks await it directly while
    /// synchronous guards use `is_cancelled`, so shutdown never waits for a
    /// periodic timer to notice an atomic flag.
    shutdown: CancellationToken,
    /// Coalesces Ollama warmup passes and tracks models this process warmed.
    lifecycle: ModelSwapCoordinator,
    /// Models (by `llm_model_key`) whose dictation prompt-prefix has been primed
    /// into llama.cpp's KV cache this residency — by a warm-up prime or a real
    /// dictation. Cleared on eviction so a reload re-primes; a COLD load also
    /// re-primes regardless (an external eviction resets the server-side cache).
    primed_prompts: Mutex<std::collections::HashSet<String>>,
    /// OpenRouter `supported_parameters` from the latest model scan. The chat
    /// path uses this to avoid sending unsupported model-specific controls.
    openrouter_supported_parameters: Mutex<HashMap<String, Vec<String>>>,
    /// OpenRouter per-model pricing rates from the latest model scan, used to
    /// convert the chat stream's native token usage into per-run USD cost.
    openrouter_pricing: Mutex<HashMap<String, OpenRouterPricingRates>>,
    /// request_id → usage of that request's most recent completed OpenRouter
    /// chat. The dictation/transform pipelines take their entry right after the
    /// call returns; entries from callers that never collect (previews,
    /// benchmarks) are dropped by the size cap.
    llm_usage_ledger: Mutex<HashMap<String, LlmRunUsage>>,
}

/// OpenRouter pricing rates in USD per unit (per token for prompt/completion,
/// per request for `request`), parsed from the catalog's `pricing` object.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenRouterPricingRates {
    pub prompt: f64,
    pub completion: f64,
    pub request: f64,
}

/// Usage + cost of one completed cloud LLM chat, surfaced in the History
/// footer. Cost is computed from OpenRouter's native token accounting × the
/// catalog pricing — the documented billing formula (OpenRouter occasionally
/// applies small discounts, so treat it as accurate to ~1%).
#[derive(Debug, Clone, Default)]
pub struct LlmRunUsage {
    pub model: String,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct LlmChatOutput {
    pub text: String,
    pub side_effects: llm::DictationSideEffects,
}

impl LlmManager {
    pub fn new(app: &AppHandle) -> Self {
        // Shared pooled cloud client (cheap Arc clone) — OpenRouter catalog
        // scans ride the same connections as cloud STT/TTS.
        let client = crate::winstt::net::http_client().clone();
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
            shutdown: CancellationToken::new(),
            lifecycle: ModelSwapCoordinator::new(),
            primed_prompts: Mutex::new(std::collections::HashSet::new()),
            openrouter_supported_parameters: Mutex::new(HashMap::new()),
            openrouter_pricing: Mutex::new(HashMap::new()),
            llm_usage_ledger: Mutex::new(HashMap::new()),
        }
    }

    /// Take (and clear) the usage recorded for `request_id`'s most recent
    /// completed OpenRouter chat. `None` for local providers and failed runs.
    pub fn take_llm_usage(&self, request_id: &str) -> Option<LlmRunUsage> {
        self.llm_usage_ledger
            .lock()
            .ok()
            .and_then(|mut ledger| ledger.remove(request_id))
    }

    fn record_llm_usage(&self, request_id: &str, usage: LlmRunUsage) {
        let Ok(mut ledger) = self.llm_usage_ledger.lock() else {
            return;
        };
        // Callers that never collect (previews, benchmarks) would otherwise
        // grow the ledger forever; it only needs to survive the gap between a
        // chat returning and its pipeline reading the entry.
        if ledger.len() >= 64 {
            ledger.clear();
        }
        ledger.insert(request_id.to_string(), usage);
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
        self.shutdown.cancel();
        self.cancel_all();
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutdown.is_cancelled()
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
