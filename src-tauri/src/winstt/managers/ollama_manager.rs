// OllamaManager — owns the mutable Ollama scrape/pull state that previously lived
// as file-statics in `winstt/commands/{ollama_library,ollama_pull}.rs`.
//
// Folded in here (managed via `app.manage(Arc::new(OllamaManager::new()))` in
// `bootstrap/state.rs`, mirroring `LlmManager`):
//   - the three in-process scrape caches (search / tags / catalog) with their TTLs,
//   - the one shared `reqwest::Client` (connection pooling + consistent TLS),
//   - the burst-control fetch `Semaphore`,
//   - the in-flight pull-cancel set (B4 `lock_recover` policy preserved),
//   - the last warmup-status snapshot.
//
// The pure HTML parsing + the compiled-regex statics stay in `ollama_library.rs`
// (immutable — not state). Cache semantics/TTLs are byte-identical to the prior
// file-static implementation.
//
// CROSS-MODULE HANDLE: a process-global `OnceLock<Arc<OllamaManager>>` (set once at
// bootstrap) lets the few callers that have no `AppHandle`/`State` in scope
// (`llm.rs::ollama_pull`, `llm_manager::warmup`) reach the manager through the thin
// free functions re-exported from `ollama_pull.rs`. The `OnceLock` is a set-once
// handle, NOT a mutable cache — all mutable state lives on the `Arc<OllamaManager>`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

use crate::winstt::commands::ollama_library::{
    OllamaLibraryCatalogResult, OllamaLibrarySearchResult, OllamaLibraryTagsResult,
};
use crate::winstt::commands::ollama_pull::LlmWarmupStatus;
use crate::winstt::sync_ext::MutexExt;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
// Full library catalog rarely changes — hold it for an hour. Per-tag pages keep the shorter TTL.
const CATALOG_TTL: Duration = Duration::from_secs(60 * 60);

// ── Burst control ────────────────────────────────────────────────────────────────
// ollama.com sits behind Cloudflare, which resets excess concurrent connections
// from one client and stalls the queued ones past the timeout. Browsing the library
// fires many tag scrapes at once (one renderer `invoke` per row), so a single
// request always succeeds while the burst fails. Cap concurrency so a single request
// always succeeds.
const MAX_CONCURRENT_FETCHES: usize = 3;

struct CacheEntry<T> {
    value: T,
    expires_at: Instant,
}

/// Owns the mutable Ollama scrape/pull state (caches, shared client, fetch gate,
/// pull-cancel set, warmup snapshot). Registered as managed state in bootstrap.
pub struct OllamaManager {
    /// One shared client (connection pooling + consistent TLS) across catalog/search/tags scrapes.
    http: reqwest::Client,
    /// One shared concurrency slot pool across catalog/search/tags scrapes.
    fetch_gate: Semaphore,
    search_cache: Mutex<HashMap<String, CacheEntry<OllamaLibrarySearchResult>>>,
    tags_cache: Mutex<HashMap<String, CacheEntry<OllamaLibraryTagsResult>>>,
    catalog_cache: Mutex<Option<CacheEntry<OllamaLibraryCatalogResult>>>,
    /// Models whose in-flight pull was cancelled — the streaming pull drain polls this.
    pull_cancelled: Mutex<HashSet<String>>,
    /// Last published warmup snapshot (renderer reads it via `llm_warmup_status`).
    last_warmup_status: Mutex<Option<LlmWarmupStatus>>,
}

impl OllamaManager {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("failed to build reqwest client");
        Self {
            http,
            fetch_gate: Semaphore::new(MAX_CONCURRENT_FETCHES),
            search_cache: Mutex::new(HashMap::new()),
            tags_cache: Mutex::new(HashMap::new()),
            catalog_cache: Mutex::new(None),
            pull_cancelled: Mutex::new(HashSet::new()),
            last_warmup_status: Mutex::new(None),
        }
    }

    // ── HTTP access ──────────────────────────────────────────────────────────────

    pub(crate) fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub(crate) fn fetch_gate(&self) -> &Semaphore {
        &self.fetch_gate
    }

    // ── Scrape caches ────────────────────────────────────────────────────────────

    pub(crate) fn cache_get_search(&self, key: &str) -> Option<OllamaLibrarySearchResult> {
        let mut map = self.search_cache.lock_recover();
        match map.get(key) {
            Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    pub(crate) fn cache_set_search(&self, key: String, value: OllamaLibrarySearchResult) {
        self.search_cache.lock_recover().insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + CACHE_TTL,
            },
        );
    }

    pub(crate) fn cache_get_tags(&self, key: &str) -> Option<OllamaLibraryTagsResult> {
        let mut map = self.tags_cache.lock_recover();
        match map.get(key) {
            Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    pub(crate) fn cache_set_tags(&self, key: String, value: OllamaLibraryTagsResult) {
        self.tags_cache.lock_recover().insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + CACHE_TTL,
            },
        );
    }

    pub(crate) fn cache_get_catalog(&self) -> Option<OllamaLibraryCatalogResult> {
        let guard = self.catalog_cache.lock_recover();
        match guard.as_ref() {
            Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
            _ => None,
        }
    }

    pub(crate) fn cache_set_catalog(&self, value: OllamaLibraryCatalogResult) {
        *self.catalog_cache.lock_recover() = Some(CacheEntry {
            value,
            expires_at: Instant::now() + CATALOG_TTL,
        });
    }

    // ── Pull-cancel set (B4 `lock_recover` policy) ─────────────────────────────────

    /// Mark a model's in-flight pull as cancelled. Idempotent.
    pub fn mark_pull_cancelled(&self, model: &str) {
        self.pull_cancelled.lock_recover().insert(model.to_string());
    }

    /// True if the given model's pull has been cancelled. The streaming pull loop in
    /// `ollama_pull` checks this between NDJSON chunks.
    pub fn is_pull_cancelled(&self, model: &str) -> bool {
        self.pull_cancelled.lock_recover().contains(model)
    }

    /// Clear a model's cancel flag once the pull loop has torn down (or completed).
    pub fn clear_pull_cancel(&self, model: &str) {
        self.pull_cancelled.lock_recover().remove(model);
    }

    // ── Warmup snapshot ────────────────────────────────────────────────────────────

    pub fn set_warmup_status(&self, status: LlmWarmupStatus) {
        *self.last_warmup_status.lock_recover() = Some(status);
    }

    pub fn clear_warmup_status(&self) {
        *self.last_warmup_status.lock_recover() = None;
    }

    pub fn warmup_status(&self) -> Option<LlmWarmupStatus> {
        self.last_warmup_status.lock_recover().clone()
    }
}

impl Default for OllamaManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Process-global handle (one instance, lazily created) ─────────────────────────
// Lets `llm.rs::ollama_pull` and `llm_manager::warmup` reach the manager through the
// thin free functions in `ollama_pull.rs` without an `AppHandle`/`State` in scope.
// `bootstrap::state` resolves the SAME `Arc` via `global()` and registers it with
// `app.manage`, so the managed state and the global handle are one instance. Set-once
// handle, never a mutable cache.

static GLOBAL: OnceLock<Arc<OllamaManager>> = OnceLock::new();

/// The process-global `OllamaManager`, creating it on first use. `bootstrap::state`
/// calls this and `app.manage`s the returned `Arc` so the managed state and the
/// global handle are the same instance regardless of call ordering.
pub fn global() -> Arc<OllamaManager> {
    GLOBAL
        .get_or_init(|| Arc::new(OllamaManager::new()))
        .clone()
}
