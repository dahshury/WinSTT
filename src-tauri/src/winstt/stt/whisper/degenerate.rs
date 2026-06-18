// DirectML degenerate-decode garbage tracking: the per-model strike counter that gates the
// CPU fallback and the block predicate consumed by `backend.rs`. Split out of `whisper.rs`
// (engine core stays there); these are self-free helpers that take all inputs as parameters.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub(super) const DML_PROVIDER_LABEL: &str = "DmlExecutionProvider";
pub(super) const DML_DEGENERATE_BLOCK_THRESHOLD: usize = 2;

static DML_DEGENERATE_MODELS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

pub(crate) fn directml_degenerate_model_blocked(model_id: &str) -> bool {
    DML_DEGENERATE_MODELS
        .get()
        .and_then(|models| {
            models
                .lock()
                .ok()
                .map(|models| models.get(model_id).copied().unwrap_or(0))
        })
        .is_some_and(|count| count >= DML_DEGENERATE_BLOCK_THRESHOLD)
}

pub(super) fn mark_directml_degenerate_model(model_id: &str) -> usize {
    let models = DML_DEGENERATE_MODELS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut models) = models.lock() {
        let count = models.entry(model_id.to_string()).or_default();
        *count += 1;
        *count
    } else {
        DML_DEGENERATE_BLOCK_THRESHOLD
    }
}
