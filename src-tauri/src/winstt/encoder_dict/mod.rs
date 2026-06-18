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
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::{Duration, Instant};

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
    }
}
