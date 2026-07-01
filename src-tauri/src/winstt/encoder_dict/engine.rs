//! Masked-LM dictionary corrector — the NON-LLM fallback. Wraps an mmBERT (ModernBERT) ONNX
//! masked-LM and decides, per phonetic candidate, whether the originally-transcribed span is
//! contextually UNEXPECTED (mean token rank > K) and should snap to the dictionary term.
//!
//! This is a faithful port of the validated spike (`tools/bench/eval_encoder_dict.py` +
//! `eval_onnx_artifact.py`): mmBERT-base int8, rank rule, K≈600 — 85% recall, **0 false positives**
//! on the held-out adversarial set, ~24 ms/utterance on CPU. Scoring the ORIGINAL word's rank (never
//! the out-of-vocab brand) is what sidesteps OOV; the tight phonetic prefilter ([`super::phonetics`])
//! keeps garbage candidates out so even int8's coarser ranks stay false-positive-free.

use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array2, Axis};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::phonetics::candidates;

/// Default decision threshold (mean token rank above which the original span is "unexpected").
/// Tuned on the held-out eval for mmBERT-base int8; higher = more conservative (fewer replacements).
pub const DEFAULT_RANK_K: usize = 600;

pub struct EncoderDict {
    session: Session,
    tokenizer: Tokenizer,
    mask_id: i64,
}

impl EncoderDict {
    /// Load the ONNX masked-LM + its tokenizer.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow::anyhow!("load tokenizer {}: {e}", tokenizer_path.display()))?;
        let mask_id = tokenizer
            .token_to_id("<mask>")
            .context("tokenizer has no <mask> token")? as i64;
        let threads = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .clamp(1, 8);
        // `ort::Error` is not `Send+Sync`, so anyhow's `.context()` doesn't apply — map to strings.
        // CPU default (no explicit EP registration); Level3, no DML mem-pattern disable.
        let session = crate::winstt::stt::configure_session(
            GraphOptimizationLevel::Level3,
            Some(threads),
            false,
            None,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .commit_from_file(model_path)
        .map_err(|e| anyhow::anyhow!("commit_from_file {}: {e}", model_path.display()))?;
        Ok(Self {
            session,
            tokenizer,
            mask_id,
        })
    }

    /// Run a single throwaway forward pass so ONNX Runtime allocates its arena / compiles kernels.
    /// The first *real* correction then lands warm instead of paying the cold-start cost. Errors are
    /// swallowed — warming is best-effort.
    pub fn warm(&mut self) {
        let _ = self.mean_rank("warm up the dictation model", 0, 4);
    }

    /// Apply vocabulary corrections to `text`. Replacement PAIRS are NOT handled here — the caller
    /// applies those deterministically (they're unambiguous find→replace). Only vocabulary `terms`
    /// (canonical spellings, no replacement value) are context-judged. `rank_k` is the
    /// unexpectedness threshold (higher = more conservative).
    pub fn correct(&mut self, text: &str, terms: &[String], rank_k: usize) -> String {
        let rank_k = rank_k as f64;
        let cands = candidates(text, terms);
        let mut used: Vec<(usize, usize)> = Vec::new();
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        for c in cands {
            // Skip a candidate that overlaps one we've already decided (longest-span-first order).
            if used.iter().any(|&(a, b)| !(c.end <= a || c.start >= b)) {
                continue;
            }
            used.push((c.start, c.end));
            match self.mean_rank(text, c.start, c.end) {
                Some(rank) if rank > rank_k => edits.push((c.start, c.end, c.term)),
                _ => {}
            }
        }
        if edits.is_empty() {
            return text.to_string();
        }
        // Splice right-to-left so earlier byte offsets stay valid.
        edits.sort_by_key(|e| std::cmp::Reverse(e.0));
        let mut out = text.to_string();
        for (s, e, term) in edits {
            out.replace_range(s..e, &term);
        }
        out
    }

    /// Mean rank of the original span's tokens among the MLM's predictions for their masked slots.
    /// `0` = the model's top choice; a high value means the span is contextually unexpected. Returns
    /// `None` when the byte span maps to no content tokens.
    fn mean_rank(&mut self, text: &str, byte_start: usize, byte_end: usize) -> Option<f64> {
        let enc = self.tokenizer.encode(text, true).ok()?;
        let ids = enc.get_ids();
        let offsets = enc.get_offsets(); // CHARACTER offsets into `text` (verified)
                                         // Our candidate spans are BYTE offsets; the tokenizer reports CHAR offsets — convert.
        let char_start = text.get(..byte_start)?.chars().count();
        let char_end = text.get(..byte_end)?.chars().count();
        let span: Vec<usize> = offsets
            .iter()
            .enumerate()
            .filter(|(_, &(o0, o1))| !(o0 == 0 && o1 == 0) && o0 < char_end && o1 > char_start)
            .map(|(i, _)| i)
            .collect();
        if span.is_empty() {
            return None;
        }

        let l = ids.len();
        let r = span.len();
        let mut input_ids = Array2::<i64>::zeros((r, l));
        for (row, &ti) in span.iter().enumerate() {
            for (j, &id) in ids.iter().enumerate() {
                input_ids[[row, j]] = id as i64;
            }
            input_ids[[row, ti]] = self.mask_id;
        }
        let attention = Array2::<i64>::from_elem((r, l), 1i64);

        let in_ids = Tensor::from_array(input_ids).ok()?;
        let in_attn = Tensor::from_array(attention).ok()?;
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => in_ids,
                "attention_mask" => in_attn,
            ])
            .ok()?;
        let logits = extract_f32(&outputs[0])?; // [r, l, vocab]
        if logits.ndim() != 3 {
            return None;
        }

        let mut total = 0.0f64;
        for (row, &ti) in span.iter().enumerate() {
            let row_view = logits.index_axis(Axis(0), row); // [l, vocab]
            let dist = row_view.index_axis(Axis(0), ti); // [vocab]
            let true_logit = *dist.get(ids[ti] as usize)?;
            let rank = dist.iter().filter(|&&v| v > true_logit).count();
            total += rank as f64;
        }
        Some(total / r as f64)
    }
}

/// Extract a logits tensor as owned f32, promoting fp16 exports (so the same code path serves the
/// int8 and fp16 ONNX variants).
fn extract_f32(out: &ort::value::DynValue) -> Option<ndarray::ArrayD<f32>> {
    if let Ok(view) = out.try_extract_array::<f32>() {
        return Some(view.to_owned());
    }
    if let Ok(view) = out.try_extract_array::<half::f16>() {
        return Some(view.mapv(|v| v.to_f32()));
    }
    None
}
