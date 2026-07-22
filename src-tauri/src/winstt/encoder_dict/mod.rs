//! Encoder (masked-LM) dictionary corrector — the NON-LLM dictation fallback.
//!
//! When LLM cleanup is OFF, the dictionary still works IF the user has opted to download the
//! on-device model: an mmBERT masked-LM decides, in context, whether a transcribed word is a
//! mis-hearing of a vocabulary term and snaps it ("veet" -> "Vite") while leaving correctly-heard
//! words alone ("video" stays). When LLM cleanup is ON, the LLM owns the dictionary and this is
//! skipped. The ~310 MB model is downloaded via the managed [`download`] flow (start/pause/resume),
//! NOT silently — until it's present, this path is a no-op.
//!
//! Architecture (retrieve-then-verify, à la NVIDIA SpellMapper / Microsoft CSC): [`index`] builds a
//! phonetic index over the dictionary and returns a BOUNDED top-K of `(span → term)` proposals per
//! utterance regardless of dictionary size; [`engine`] then judges each with the masked-LM (one-sided
//! `rank(original) > K` rule) and resolves overlapping spans to a single best edit. The old design
//! scored every phonetic collision INDEPENDENTLY, so its false-positive rate compounded with
//! dictionary size and its English-Soundex prefilter missed homophones + all non-Latin scripts. The
//! bounded top-K retrieval fixes the former; metaphone + character-n-gram retrieval fixes the latter.
//! Validated on the real int8 model (`examples/dict_eval`): 100% recall / 0 false positives on the
//! adversarial set at 50 terms, ~42 ms/utterance.

pub mod download;
pub mod engine;
pub mod index;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, MutexGuard};
use tauri::AppHandle;

pub use engine::DEFAULT_RANK_K;
use engine::{DEFAULT_CONTEXT_BYTES, EncoderDict};
use index::DictIndex;

/// Widest the user may set the context window (bytes each side); mirrors the zod/Rust validation.
const MAX_CONTEXT_BYTES: i64 = 1000;

/// Local filenames the model is stored under (in the app-data `encoder-dict` dir).
pub(crate) const MODEL_FILENAME: &str = "model_int8.onnx";
pub(crate) const TOKENIZER_FILENAME: &str = "tokenizer.json";
// Per-utterance fail-soft budget. Local-window scoring ([`engine`]) keeps a full paragraph's
// correction to a few hundred ms even at the top-K candidate cap, but real dictation runs it while
// the STT model / Ollama contend for CPU, so this leaves comfortable headroom before giving up and
// returning the text uncorrected.
const CORRECTION_TIMEOUT_MS: u64 = 3_000;
const ENGINE_LOCK_TIMEOUT_MS: u64 = 500;

/// Loaded engine, created once after the model is present. `None` until then.
static ENGINE: OnceLock<Mutex<Option<EncoderDict>>> = OnceLock::new();

/// Timed engine-lock acquisition. `parking_lot` parks this thread until the
/// current guard releases the mutex (or the exact deadline expires), avoiding
/// the previous 10 ms retry-sleep polling loop.
fn lock_engine<'a>(
    cell: &'a Mutex<Option<EncoderDict>>,
    context: &str,
) -> Option<MutexGuard<'a, Option<EncoderDict>>> {
    let started = Instant::now();
    log::debug!("[encoder-dict] lock_start context={context}");
    let guard = cell.try_lock_for(Duration::from_millis(ENGINE_LOCK_TIMEOUT_MS));
    if guard.is_some() {
        log::debug!(
            "[encoder-dict] lock_complete context={context} duration_ms={}",
            started.elapsed().as_millis()
        );
    } else {
        log::warn!(
            "[encoder-dict] lock_timeout context={context} duration_ms={}",
            started.elapsed().as_millis()
        );
    }
    guard
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
        *cell.lock() = None;
    }
    idle_signal().notify();
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
static ENCODER_CLOCK_EPOCH: OnceLock<Instant> = OnceLock::new();
static ENCODER_IDLE_SIGNAL: OnceLock<IdleSignal> = OnceLock::new();

/// Generation-based wakeup used by the idle watcher. Capturing the generation
/// before inspecting encoder state prevents a use or policy change from being
/// lost between the state check and the condvar wait.
struct IdleSignal {
    generation: StdMutex<u64>,
    changed: Condvar,
}

impl IdleSignal {
    fn new() -> Self {
        Self {
            generation: StdMutex::new(0),
            changed: Condvar::new(),
        }
    }

    fn generation(&self) -> u64 {
        *self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation = generation.wrapping_add(1);
        self.changed.notify_all();
    }

    fn wait_for_change(&self, observed: u64, timeout: Option<Duration>) -> u64 {
        let generation = self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *generation != observed {
            return *generation;
        }

        let generation = match timeout {
            Some(timeout) => {
                self.changed
                    .wait_timeout_while(generation, timeout, |current| *current == observed)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0
            }
            None => self
                .changed
                .wait_while(generation, |current| *current == observed)
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        };
        *generation
    }
}

fn idle_signal() -> &'static IdleSignal {
    ENCODER_IDLE_SIGNAL.get_or_init(IdleSignal::new)
}

fn now_ms() -> u64 {
    ENCODER_CLOCK_EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn touch_encoder_used() {
    ENCODER_LAST_USED_MS.store(now_ms(), Ordering::Release);
    idle_signal().notify();
}

fn finish_encoder_use() {
    touch_encoder_used();
    if encoder_idle_is_immediate() {
        clear_loaded();
    }
}

fn encoder_is_loaded() -> bool {
    ENGINE.get().is_some_and(|cell| cell.lock().is_some())
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
        log::debug!("[encoder-dict] session dropped (immediate unload policy)");
    } else {
        idle_signal().notify();
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
    std::thread::spawn(|| {
        let signal = idle_signal();
        let mut observed = signal.generation();
        loop {
            let secs = ENCODER_IDLE_SECS.load(Ordering::Acquire);
            let wait = if !encoder_is_loaded() || secs == ENCODER_IDLE_NEVER_SECS || secs == 0 {
                // No deadline exists until a load/use or policy change wakes us.
                None
            } else {
                let idle_ms = now_ms().saturating_sub(ENCODER_LAST_USED_MS.load(Ordering::Acquire));
                if idle_unload_due(secs, idle_ms) {
                    clear_loaded();
                    log::debug!("[encoder-dict] session dropped (idle timeout {secs}s)");
                    None
                } else {
                    let limit_ms = secs.saturating_mul(1000);
                    Some(Duration::from_millis(limit_ms.saturating_sub(idle_ms)))
                }
            };
            observed = signal.wait_for_change(observed, wait);
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
    let mut guard = cell.lock();
    if guard.is_none() {
        match EncoderDict::load(&model_path, &tok_path) {
            Ok(mut e) => {
                e.warm();
                *guard = Some(e);
                log::debug!("[encoder-dict] model preloaded and warmed");
            }
            Err(e) => log::warn!("[encoder-dict] preload failed, skipping: {e}"),
        }
    } else if let Some(e) = guard.as_mut() {
        e.warm();
    }
    // Count the load/warm as a "use" so the idle watcher starts its countdown
    // from NOW — otherwise `last_used` stays 0 (epoch) and the freshly preloaded
    // model looks infinitely idle and is dropped on the watcher's next wake.
    drop(guard);
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
pub async fn correct_vocabulary(app: &AppHandle, text: &str, terms: &[String]) -> String {
    if terms.is_empty() || text.trim().is_empty() || !is_model_present(app) {
        return text.to_string();
    }
    // Build the phonetic index off the model thread (pure, cheap); a term set that indexes to nothing
    // (all empty/whitespace) short-circuits before any inference.
    let index = DictIndex::build(terms);
    if index.is_empty() {
        return text.to_string();
    }
    // How much surrounding text the model reads per word (Vocabulary tab slider). Clamped to the
    // validated range so a hand-edited settings file can't feed a runaway sequence length.
    let context_bytes = crate::winstt::commands::settings::read_settings(app)
        .general
        .dictionary_context_chars
        .clamp(DEFAULT_CONTEXT_BYTES as i64, MAX_CONTEXT_BYTES) as usize;
    touch_encoder_used();
    log::debug!(
        "[encoder-dict] correction_start chars={} terms={}",
        text.chars().count(),
        terms.len()
    );
    let Some(dir) = model_dir(app) else {
        return text.to_string();
    };
    let model_path = dir.join(MODEL_FILENAME);
    let tok_path = dir.join(TOKENIZER_FILENAME);

    let text_owned = text.to_string();
    let fallback = text.to_string();
    let correction_started = Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let mut task = tokio::task::spawn_blocking(move || {
        let blocking_started = Instant::now();
        if worker_cancelled.load(Ordering::Acquire) {
            return text_owned;
        }
        let cell = ENGINE.get_or_init(|| Mutex::new(None));
        let Some(mut guard) = lock_engine(cell, "correction") else {
            return text_owned;
        };
        if worker_cancelled.load(Ordering::Acquire) {
            return text_owned;
        }
        if guard.is_none() {
            let load_started = Instant::now();
            log::debug!("[encoder-dict] load_start");
            match EncoderDict::load(&model_path, &tok_path) {
                Ok(e) => {
                    log::debug!(
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
        if worker_cancelled.load(Ordering::Acquire) {
            return text_owned;
        }
        match guard.as_mut() {
            Some(e) => {
                let infer_started = Instant::now();
                log::debug!("[encoder-dict] infer_start");
                let corrected = e.correct(&text_owned, &index, context_bytes);
                log::debug!(
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

    let completed =
        match tokio::time::timeout(Duration::from_millis(CORRECTION_TIMEOUT_MS), &mut task).await {
            Ok(Ok(corrected)) => {
                log::debug!(
                    "[encoder-dict] correction_complete duration_ms={} changed={}",
                    correction_started.elapsed().as_millis(),
                    corrected != fallback
                );
                Some(corrected)
            }
            Ok(Err(err)) => {
                log::warn!("[encoder-dict] correction task failed, skipping: {err}");
                Some(fallback.clone())
            }
            Err(_) => {
                cancelled.store(true, Ordering::Release);
                log::warn!(
                    "[encoder-dict] correction_timeout duration_ms={} returning_original=true",
                    correction_started.elapsed().as_millis()
                );
                // `spawn_blocking` cannot be force-aborted once inference has
                // begun. Keep its handle, request cancellation between phases,
                // and defer the eventual bookkeeping/unload to blocking-pool
                // cleanup after it actually releases the engine mutex. This
                // keeps the async runtime thread from synchronously waiting on
                // the timed-out inference through `clear_loaded()`.
                tokio::spawn(async move {
                    let _ = task.await;
                    if let Err(err) = tokio::task::spawn_blocking(finish_encoder_use).await {
                        log::warn!("[encoder-dict] timed-out cleanup task failed: {err}");
                    }
                });
                None
            }
        };
    if let Some(result) = completed {
        // Wake a watcher that may have observed `ENGINE` before the blocking
        // task loaded it, and measure idleness from completed use rather than
        // inference start. The initial touch still protects a queued use.
        finish_encoder_use();
        result
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, mpsc};

    use super::*;
    use crate::settings::ModelUnloadTimeout;

    #[test]
    fn idle_signal_wakes_waiter_on_notification() {
        let signal = Arc::new(IdleSignal::new());
        let observed = signal.generation();
        let waiter_signal = Arc::clone(&signal);
        let (started_tx, started_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiter_signal.wait_for_change(observed, Some(Duration::from_secs(1)))
        });

        started_rx.recv().unwrap();
        signal.notify();

        assert_ne!(waiter.join().unwrap(), observed);
    }

    #[test]
    fn timed_engine_lock_wakes_when_guard_releases() {
        let cell: Arc<Mutex<Option<EncoderDict>>> = Arc::new(Mutex::new(None));
        let held = cell.lock();
        let waiter_cell = Arc::clone(&cell);
        let (started_tx, started_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            lock_engine(&waiter_cell, "test").is_some()
        });

        started_rx.recv().unwrap();
        drop(held);

        assert!(waiter.join().unwrap());
    }

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
