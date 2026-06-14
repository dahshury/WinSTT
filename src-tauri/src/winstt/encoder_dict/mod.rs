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
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

pub use engine::DEFAULT_RANK_K;
use engine::EncoderDict;

/// Local filenames the model is stored under (in the app-data `encoder-dict` dir).
pub(crate) const MODEL_FILENAME: &str = "model_int8.onnx";
pub(crate) const TOKENIZER_FILENAME: &str = "tokenizer.json";

/// Loaded engine, created once after the model is present. `None` until then.
static ENGINE: OnceLock<Mutex<Option<EncoderDict>>> = OnceLock::new();

/// Directory the encoder model + tokenizer live in.
pub(crate) fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app).ok().map(|d| d.join("encoder-dict"))
}

/// Both files present on disk → the fallback is usable.
pub fn is_model_present(app: &AppHandle) -> bool {
    let Some(dir) = model_dir(app) else {
        return false;
    };
    dir.join(MODEL_FILENAME).is_file() && dir.join(TOKENIZER_FILENAME).is_file()
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
    let Some(dir) = model_dir(app) else {
        return text.to_string();
    };
    let model_path = dir.join(MODEL_FILENAME);
    let tok_path = dir.join(TOKENIZER_FILENAME);

    let text_owned = text.to_string();
    let terms_owned = terms.to_vec();
    let fallback = text.to_string();
    tokio::task::spawn_blocking(move || {
        let cell = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            match EncoderDict::load(&model_path, &tok_path) {
                Ok(e) => *guard = Some(e),
                Err(e) => {
                    log::warn!("[encoder-dict] load failed, skipping: {e}");
                    return text_owned;
                }
            }
        }
        match guard.as_mut() {
            Some(e) => e.correct(&text_owned, &terms_owned, rank_k),
            None => text_owned,
        }
    })
    .await
    .unwrap_or(fallback)
}
