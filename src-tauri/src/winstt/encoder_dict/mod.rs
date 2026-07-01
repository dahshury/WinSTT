//! Encoder (masked-LM) dictionary corrector — the NON-LLM dictation fallback.
//!
//! When LLM cleanup is OFF, the dictionary still works IF the user has opted to download the
//! on-device model: an mmBERT masked-LM decides, in context, whether a transcribed word is a
//! mis-hearing of a vocabulary term and snaps it ("veet" -> "Vite") while leaving correctly-heard
//! words alone ("video" stays). When LLM cleanup is ON, the LLM owns the dictionary and this is
//! skipped. The ~310 MB model is downloaded via the managed [`download`] flow (start/pause/resume),
//! NOT silently — until it's present, this path is a no-op.
//!
//! Validated (see `tools/bench/eval_*`): mmBERT-base int8, rank rule K≈600 — 85% recall, 0 false
//! positives on the held-out adversarial set, ~24 ms/utterance CPU.

pub mod download;
pub mod engine;
pub mod phonetics;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use engine::EncoderDict;
pub use engine::DEFAULT_RANK_K;

/// Local filenames the model is stored under (in the app-data `encoder-dict` dir).
pub(crate) const MODEL_FILENAME: &str = "model_int8.onnx";
pub(crate) const TOKENIZER_FILENAME: &str = "tokenizer.json";
const CORRECTION_TIMEOUT_MS: u64 = 2_000;
const ENGINE_LOCK_TIMEOUT_MS: u64 = 500;

/// Loaded engine, created once after the model is present. `None` until then.
static ENGINE: OnceLock<Mutex<Option<EncoderDict>>> = OnceLock::new();

fn lock_engine<'a>(
    cell: &'a Mutex<Option<EncoderDict>>,
    context: &str,
) -> Option<MutexGuard<'a, Option<EncoderDict>>> {
    let started = Instant::now();
    log::info!("[encoder-dict] lock_start context={context}");
    loop {
        match cell.try_lock() {
            Ok(guard) => {
                log::info!(
                    "[encoder-dict] lock_complete context={context} duration_ms={}",
                    started.elapsed().as_millis()
                );
                return Some(guard);
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                log::warn!("[encoder-dict] lock poisoned in {context}; recovering");
                return Some(poisoned.into_inner());
            }
            Err(TryLockError::WouldBlock) => {
                if started.elapsed() >= Duration::from_millis(ENGINE_LOCK_TIMEOUT_MS) {
                    log::warn!(
                        "[encoder-dict] lock_timeout context={context} duration_ms={}",
                        started.elapsed().as_millis()
                    );
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

/// Directory the encoder model + tokenizer live in.
pub(crate) fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .ok()
        .map(|d| d.join("encoder-dict"))
}

/// Both files present on disk → the fallback is usable.
pub fn is_model_present(app: &AppHandle) -> bool {
    let Some(dir) = model_dir(app) else {
        return false;
    };
    dir.join(MODEL_FILENAME).is_file() && dir.join(TOKENIZER_FILENAME).is_file()
}

/// Drop the loaded engine from memory (after the model files are removed) so a later re-download
/// reloads fresh instead of serving the stale in-memory session.
pub fn clear_loaded() {
    if let Some(cell) = ENGINE.get() {
        *cell.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

// ── Idle-unload lifecycle ───────────────────────────────────────────────────
// The ~310 MB encoder session is held in the global `ENGINE` cell until the
// feature is disabled or the model files are removed. Without an idle watcher it
// would linger in RAM for the whole session — STT and TTS both honor the shared
// `model_unload_timeout`, so the dictionary encoder must too. `Never` keeps it
// resident; `Immediately` drops it after each correction; finite policies drop
// it after that many idle seconds.
const ENCODER_IDLE_NEVER_SECS: u64 = u64::MAX;
static ENCODER_IDLE_SECS: AtomicU64 = AtomicU64::new(ENCODER_IDLE_NEVER_SECS);
static ENCODER_LAST_USED_MS: AtomicU64 = AtomicU64::new(0);
static ENCODER_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn touch_encoder_used() {
    ENCODER_LAST_USED_MS.store(now_ms(), Ordering::Release);
}

fn encoder_is_loaded() -> bool {
    ENGINE
        .get()
        .is_some_and(|cell| cell.lock().is_ok_and(|g| g.is_some()))
}

/// True iff the configured policy is `Immediately` (drop the session right after
/// each correction).
fn encoder_idle_is_immediate() -> bool {
    ENCODER_IDLE_SECS.load(Ordering::Acquire) == 0
}

/// Pure decision: should the idle watcher drop the session for this policy +
/// idle span? `Never` (`u64::MAX`) and `Immediately` (`0`) are NOT handled here
/// (kept resident / dropped inline after each use, respectively); finite
/// policies drop once idle exceeds the limit.
fn idle_unload_due(secs: u64, idle_ms: u64) -> bool {
    secs != ENCODER_IDLE_NEVER_SECS && secs != 0 && idle_ms >= secs.saturating_mul(1000)
}

/// Update the encoder's idle-unload policy from the shared `model_unload_timeout`
/// setting. `Immediately` drops the session NOW (it reloads on the next
/// correction); finite policies are enforced by [`start_idle_watcher`]; `Never`
/// keeps it resident. Mirrors `TtsManager::update_idle_unload_timeout`.
pub fn update_idle_unload_timeout(timeout: crate::settings::ModelUnloadTimeout) {
    let secs = timeout.to_seconds().unwrap_or(ENCODER_IDLE_NEVER_SECS);
    ENCODER_IDLE_SECS.store(secs, Ordering::Release);
    if secs == 0 {
        clear_loaded();
        log::info!("[encoder-dict] session dropped (immediate unload policy)");
    }
}

/// Spawn the idle watcher that drops the resident encoder session once it has
/// gone unused for the configured `model_unload_timeout`. Idempotent (safe to
/// call every boot). Mirrors the STT/TTS idle watchers so the on-device
/// dictionary model honors the same unload policy instead of lingering forever.
pub fn start_idle_watcher() {
    if ENCODER_WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(5));
        let secs = ENCODER_IDLE_SECS.load(Ordering::Acquire);
        // Nothing loaded → nothing to drop (also covers Never/Immediately, which
        // never leave a finite-idle session for the watcher to reap).
        if !encoder_is_loaded() {
            continue;
        }
        let idle_ms = now_ms().saturating_sub(ENCODER_LAST_USED_MS.load(Ordering::Acquire));
        if idle_unload_due(secs, idle_ms) {
            clear_loaded();
            log::info!("[encoder-dict] session dropped (idle timeout {secs}s)");
        }
    });
}

/// Load the engine into memory (if the model is present) and run one warm-up inference, so the first
/// real correction is fast. Blocking (model load + a forward pass) — call from a blocking context.
/// Idempotent: a no-op load when already cached, but always re-warms cheaply.
pub fn preload_blocking(app: &AppHandle) {
    if !is_model_present(app) {
        return;
    }
    let Some(dir) = model_dir(app) else {
        return;
    };
    let model_path = dir.join(MODEL_FILENAME);
    let tok_path = dir.join(TOKENIZER_FILENAME);
    let cell = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        match EncoderDict::load(&model_path, &tok_path) {
            Ok(mut e) => {
                e.warm();
                *guard = Some(e);
                log::info!("[encoder-dict] model preloaded + warmed");
            }
            Err(e) => log::warn!("[encoder-dict] preload failed, skipping: {e}"),
        }
    } else if let Some(e) = guard.as_mut() {
        e.warm();
    }
    // Count the load/warm as a "use" so the idle watcher starts its countdown
    // from NOW — otherwise `last_used` stays 0 (epoch) and the freshly preloaded
    // model looks infinitely idle and is dropped on the watcher's first poll.
    touch_encoder_used();
}

/// Fire-and-forget [`preload_blocking`] on a background thread, so callers (app startup, the
/// toggle-on command, a finished download) don't block. Uses a plain OS thread (not a tokio blocking
/// task) so it's safe to call from the bootstrap path, which isn't inside a tokio runtime.
pub fn preload_async(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || preload_blocking(&app));
}

/// Correct vocabulary `terms` in `text` using the masked-LM fallback. No-op (returns `text`) when
/// the model isn't downloaded yet, or on any load/inference error (fail-soft).
pub async fn correct_vocabulary(
    app: &AppHandle,
    text: &str,
    terms: &[String],
    rank_k: usize,
) -> String {
    if terms.is_empty() || text.trim().is_empty() || !is_model_present(app) {
        return text.to_string();
    }
    touch_encoder_used();
    log::info!(
        "[encoder-dict] correction_start chars={} terms={} rank_k={rank_k}",
        text.chars().count(),
        terms.len()
    );
    let Some(dir) = model_dir(app) else {
        return text.to_string();
    };
    let model_path = dir.join(MODEL_FILENAME);
    let tok_path = dir.join(TOKENIZER_FILENAME);

    let text_owned = text.to_string();
    let terms_owned = terms.to_vec();
    let fallback = text.to_string();
    let correction_started = Instant::now();
    let task = tokio::task::spawn_blocking(move || {
        let blocking_started = Instant::now();
        let cell = ENGINE.get_or_init(|| Mutex::new(None));
        let Some(mut guard) = lock_engine(cell, "correction") else {
            return text_owned;
        };
        if guard.is_none() {
            let load_started = Instant::now();
            log::info!("[encoder-dict] load_start");
            match EncoderDict::load(&model_path, &tok_path) {
                Ok(e) => {
                    log::info!(
                        "[encoder-dict] load_complete duration_ms={}",
                        load_started.elapsed().as_millis()
                    );
                    *guard = Some(e);
                }
                Err(e) => {
                    log::warn!("[encoder-dict] load failed, skipping: {e}");
                    return text_owned;
                }
            }
        }
        match guard.as_mut() {
            Some(e) => {
                let infer_started = Instant::now();
                log::info!("[encoder-dict] infer_start");
                let corrected = e.correct(&text_owned, &terms_owned, rank_k);
                log::info!(
                    "[encoder-dict] infer_complete duration_ms={} changed={} total_blocking_ms={}",
                    infer_started.elapsed().as_millis(),
                    corrected != text_owned,
                    blocking_started.elapsed().as_millis()
                );
                corrected
            }
            None => text_owned,
        }
    });

    let result =
        match tokio::time::timeout(Duration::from_millis(CORRECTION_TIMEOUT_MS), task).await {
            Ok(Ok(corrected)) => {
                log::info!(
                    "[encoder-dict] correction_complete duration_ms={} changed={}",
                    correction_started.elapsed().as_millis(),
                    corrected != fallback
                );
                corrected
            }
            Ok(Err(err)) => {
                log::warn!("[encoder-dict] correction task failed, skipping: {err}");
                fallback
            }
            Err(_) => {
                log::warn!(
                    "[encoder-dict] correction_timeout duration_ms={} returning_original=true",
                    correction_started.elapsed().as_millis()
                );
                fallback
            }
        };
    // `Immediately` policy: drop the ~310 MB session right after the correction
    // (it reloads on the next use), mirroring STT/TTS immediate unload.
    if encoder_idle_is_immediate() {
        clear_loaded();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ModelUnloadTimeout;

    #[test]
    fn never_and_immediately_are_not_watcher_unloads() {
        // Never keeps the session forever; Immediately is dropped inline after
        // each correction — neither is the watcher's job, regardless of idle.
        assert!(!idle_unload_due(ENCODER_IDLE_NEVER_SECS, u64::MAX));
        assert!(!idle_unload_due(0, u64::MAX));
    }

    #[test]
    fn finite_policy_unloads_only_after_the_idle_limit() {
        // 2-minute policy: not due at 119s idle, due at exactly 120s and beyond.
        let secs = ModelUnloadTimeout::Min2.to_seconds().unwrap();
        assert_eq!(secs, 120);
        assert!(!idle_unload_due(secs, 119_000));
        assert!(idle_unload_due(secs, 120_000));
        assert!(idle_unload_due(secs, 600_000));
    }

    #[test]
    fn fifteen_second_debug_policy_maps_and_fires() {
        let secs = ModelUnloadTimeout::Sec15.to_seconds().unwrap();
        assert_eq!(secs, 15);
        assert!(!idle_unload_due(secs, 14_999));
        assert!(idle_unload_due(secs, 15_000));
    }

    #[test]
    fn never_timeout_maps_to_the_resident_sentinel() {
        assert_eq!(
            ModelUnloadTimeout::Never
                .to_seconds()
                .unwrap_or(ENCODER_IDLE_NEVER_SECS),
            ENCODER_IDLE_NEVER_SECS
        );
    }
}
