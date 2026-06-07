// DirectML degenerate-decode garbage tracking: the per-model strike counter that gates the
// CPU fallback, the block predicate consumed by `backend.rs`, and the dominant-repeated-token
// detector that classifies a decode as garbage. Split out of `whisper.rs` (engine core stays
// there); these are self-free helpers that take all inputs as parameters.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub(super) const DML_PROVIDER_LABEL: &str = "DmlExecutionProvider";
pub(super) const DML_DEGENERATE_BLOCK_THRESHOLD: usize = 2;

static DML_DEGENERATE_MODELS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DegenerateDecodeStats {
    generated_len: usize,
    dominant_token: i64,
    dominant_count: usize,
    dominant_fraction: f32,
}

pub(crate) fn directml_degenerate_model_blocked(model_id: &str) -> bool {
    DML_DEGENERATE_MODELS
        .get()
        .and_then(|models| {
            models
                .lock()
                .ok()
                .map(|models| models.get(model_id).copied().unwrap_or(0))
        })
        .map(|count| count >= DML_DEGENERATE_BLOCK_THRESHOLD)
        .unwrap_or(false)
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

pub(super) fn detect_degenerate_decode(
    tokens: &[i64],
    prompt_len: usize,
    eos: i64,
) -> Option<DegenerateDecodeStats> {
    let generated = &tokens[prompt_len.min(tokens.len())..];
    if tokens.last() == Some(&eos) || generated.len() < 32 {
        return None;
    }

    let mut counts: HashMap<i64, usize> = HashMap::new();
    for &token in generated {
        *counts.entry(token).or_default() += 1;
    }
    let (dominant_token, dominant_count) = counts
        .iter()
        .max_by_key(|(_, count)| **count)
        .map(|(token, count)| (*token, *count))
        .unwrap_or((-1, 0));
    let dominant_fraction = dominant_count as f32 / generated.len().max(1) as f32;
    if dominant_fraction >= 0.5 {
        Some(DegenerateDecodeStats {
            generated_len: generated.len(),
            dominant_token,
            dominant_count,
            dominant_fraction,
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degenerate_decode_detector_flags_repeated_token_cap_without_eos() {
        let mut tokens = vec![1, 2, 3, 4];
        tokens.extend(std::iter::repeat_n(1097, 40));

        let stats = detect_degenerate_decode(&tokens, 4, 99).unwrap();

        assert_eq!(stats.generated_len, 40);
        assert_eq!(stats.dominant_token, 1097);
        assert_eq!(stats.dominant_count, 40);
        assert_eq!(stats.dominant_fraction, 1.0);
    }

    #[test]
    fn degenerate_decode_detector_ignores_eos_terminated_repetition() {
        let mut tokens = vec![1, 2, 3, 4];
        tokens.extend(std::iter::repeat_n(1097, 40));
        tokens.push(99);

        assert_eq!(detect_degenerate_decode(&tokens, 4, 99), None);
    }

    #[test]
    fn degenerate_decode_detector_ignores_varied_token_cap() {
        let mut tokens = vec![1, 2, 3, 4];
        tokens.extend(100..164);

        assert_eq!(detect_degenerate_decode(&tokens, 4, 99), None);
    }
}
