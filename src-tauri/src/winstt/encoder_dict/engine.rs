//! Masked-LM dictionary verifier — the NON-LLM fallback's decision stage.
//!
//! Retrieval ([`super::index`]) proposes a bounded top-K of `(span → term)` candidates; this stage
//! decides which to accept using the masked-LM. The rule is a one-sided rank test:
//!
//! ```text
//!   accept  ⇔  rank(original | context) > K
//! ```
//!
//! Rank = the count of vocabulary logits scoring higher than the true token at its masked slot (0 =
//! the model's top pick; large = contextually surprising). Rank, not log-probability, is the load-
//! bearing choice: dictionary terms are proper nouns / brands RARE in the masked-LM's pretraining
//! ("Vite", "Supabase"), so scoring the ORIGINAL word's rank (never the OOV term's) is what sidesteps
//! the out-of-vocab problem — a real-but-rare term's own probability is meaningless here.
//!
//! Why one-sided and not "and the term fits better": measured on the real int8 model, comparing
//! `rank(term)` is actively wrong. A spliced-in brand token ranks FAR worse than a garbled mis-hearing
//! that decomposes into common subwords ("veet" rank 4697 vs "Vite" rank 118699), so any
//! term-vs-original comparison rejects every genuine fix (0% recall). The one-sided rule alone gives
//! 100% recall / 0 false positives on the adversarial set: a correctly-heard word has a LOW rank in
//! its real context ("video" in "watch the video" → rank 245) and never clears K, while a mis-hearing
//! is surprising and does. The false-positive protection that actually matters comes from RETRIEVAL
//! bounding (top-K, one edit per span) — not from a second rank comparison. (The comparison survives
//! as an env-gated experiment; see [`compare_enabled`].)
//!
//! Each span is scored by masking ALL its tokens at once (mean rank over the span), so a one-token
//! original and a multi-token span compare without intra-span leakage.

use std::path::Path;

use anyhow::{Context, Result};
use ndarray::{Array2, Axis};
use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::index::{DictIndex, EDIT_RATIO_MAX, edit_ratio, normalize};

/// Default rank threshold: the original span's mean token rank must exceed this to be considered a
/// mis-hearing. Tuned on the held-out eval for mmBERT-base int8; higher = more conservative.
/// Overridable at runtime via `WINSTT_DICT_RANK_K` for field calibration.
pub const DEFAULT_RANK_K: f64 = 600.0;

fn rank_k() -> f64 {
    std::env::var("WINSTT_DICT_RANK_K")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(DEFAULT_RANK_K)
}

/// Whether the comparative clause (`rank(term) < rank(original)`) is enforced. OFF by default.
///
/// Measured on the real int8 model, the comparison is actively harmful: dictionary terms are rare
/// brand/proper-noun tokens, so a spliced-in term ("Vite") ranks FAR worse than even a garbled
/// mis-hearing that decomposes into common subwords ("veet" → rank 4697 vs "Vite" → rank 118699).
/// The clause therefore rejects every genuine correction (0% recall). The one-sided `rank(original) >
/// K` rule alone gives 100% recall / 0 false positives on the adversarial set, because a
/// correctly-heard word has a LOW rank in its real context ("video" in "watch the video" → rank 245)
/// and never clears K. Kept as an env-gated experiment (`WINSTT_DICT_COMPARE=1`) for future recheck.
fn compare_enabled() -> bool {
    std::env::var("WINSTT_DICT_COMPARE").ok().as_deref() == Some("1")
}

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
        let _ = self.span_mean_rank("warm up the dictation model", 0, 4, DEFAULT_CONTEXT_BYTES);
    }

    /// Apply vocabulary corrections to `text`. Replacement PAIRS are handled deterministically by the
    /// caller; only vocabulary `index` terms (canonical spellings) are context-judged here.
    ///
    /// Retrieve → accept each candidate whose original span is contextually surprising
    /// (`rank(original) > K`) → greedily resolve overlapping spans by that rank (strongest first),
    /// splicing right-to-left with source-case restored. (With `WINSTT_DICT_COMPARE=1`, additionally
    /// require `rank(term) < rank(original)` — see [`compare_enabled`] for why that's off by default.)
    pub fn correct(&mut self, text: &str, index: &DictIndex, context_bytes: usize) -> String {
        let k = rank_k();
        let compare = compare_enabled();
        let cands = index.retrieve(text);
        if cands.is_empty() {
            return text.to_string();
        }

        // Score every candidate, keep those that clear the rank rule. `improvement` = how much better
        // the term fits (rank(original) − rank(term), or just rank(original) when the comparison is
        // off) — used to resolve overlapping spans.
        let debug = std::env::var("WINSTT_DICT_DEBUG").ok().as_deref() == Some("1");
        let mut scored: Vec<(usize, usize, String, f64)> = Vec::new();
        for c in cands {
            let Some((rank_orig, rank_term)) =
                self.candidate_ranks(text, c.start, c.end, &c.term, compare, context_bytes)
            else {
                continue;
            };
            let accept = rank_orig > k && (!compare || rank_term < rank_orig);
            if debug {
                eprintln!(
                    "[dict-debug] span={:?} term={:?} rank_orig={rank_orig:.0} rank_term={rank_term:.0} accept={accept}",
                    &text[c.start..c.end],
                    c.term
                );
            }
            if accept {
                let improvement = if compare {
                    rank_orig - rank_term
                } else {
                    rank_orig
                };
                scored.push((c.start, c.end, c.term, improvement));
            }
        }
        if scored.is_empty() {
            return text.to_string();
        }

        // Greedy by descending improvement; drop any candidate overlapping a stronger accepted edit.
        scored.sort_by(|a, b| b.3.total_cmp(&a.3));
        let mut used: Vec<(usize, usize)> = Vec::new();
        let mut edits: Vec<(usize, usize, String)> = Vec::new();
        for (start, end, term, _improvement) in scored {
            if used.iter().any(|&(a, b)| !(end <= a || start >= b)) {
                continue;
            }
            used.push((start, end));
            let cased = restore_case(&text[start..end], &term);
            edits.push((start, end, cased));
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

    /// `(rank(original), rank(term))` — mean token rank of the span as-is vs. with the term spliced
    /// in. `None` when either span maps to no content tokens (so the caller skips it). Re-applies the
    /// tight phonetic gate defensively — retrieval already enforced it, but a belt keeps accept honest.
    fn candidate_ranks(
        &mut self,
        text: &str,
        byte_start: usize,
        byte_end: usize,
        term: &str,
        compare: bool,
        context_bytes: usize,
    ) -> Option<(f64, f64)> {
        let span = text.get(byte_start..byte_end)?;
        let span_norm = normalize(span);
        let term_norm = normalize(term);
        // Defensive phonetic gate (mirrors retrieval): pass only when the pair is identical, a close
        // edit, or a metaphone homophone — never wildly unrelated. The rank rule then does the
        // semantic work of deciding whether an admitted pair actually warrants a swap.
        let phonetically_close = span_norm == term_norm
            || edit_ratio(&span_norm, &term_norm) < EDIT_RATIO_MAX
            || double_metaphone_equal(&span_norm, &term_norm);
        if !phonetically_close {
            return None;
        }

        let rank_orig = self.span_mean_rank(text, byte_start, byte_end, context_bytes)?;
        if !compare {
            // One-sided rule: term rank unused, so skip its forward pass. `f64::MIN` guarantees the
            // `rank_term < rank_orig` clause would pass, but the caller doesn't consult it when off.
            return Some((rank_orig, f64::MIN));
        }

        // Splice the term in and score the same slot (byte offsets: term starts where the span did).
        let mut spliced = String::with_capacity(text.len() - (byte_end - byte_start) + term.len());
        spliced.push_str(&text[..byte_start]);
        spliced.push_str(term);
        spliced.push_str(&text[byte_end..]);
        let term_byte_end = byte_start + term.len();
        let rank_term = self.span_mean_rank(&spliced, byte_start, term_byte_end, context_bytes)?;

        Some((rank_orig, rank_term))
    }

    /// Mean rank of the span's true tokens with the WHOLE span masked at once (no intra-span leakage,
    /// so spans of different token counts compare fairly). Rank = count of vocab logits above the true
    /// token's. `byte_start`/`byte_end` are BYTE offsets — matching `Tokenizer::encode`, whose offsets
    /// are BYTE-referential (`OffsetType::Byte`; `encode_char_offsets` would give char offsets). The
    /// old code converted to char offsets and compared them against these byte offsets, which silently
    /// scored the WRONG tokens for any multi-byte text (Arabic/accented) — correct only for ASCII.
    /// `None` when the span has no content tokens.
    ///
    /// Only a bounded LOCAL window around the span is fed to the model, not the whole `text`. A
    /// masked-LM's forward cost grows ~quadratically with sequence length, so scoring every candidate
    /// against a full paragraph made long dictations blow the correction timeout and silently return
    /// uncorrected (the exact "long sentence does nothing" bug). Local context is all the model needs
    /// to judge whether a word fits, so this makes per-candidate cost ~constant in paragraph length.
    fn span_mean_rank(
        &mut self,
        text: &str,
        byte_start: usize,
        byte_end: usize,
        context_bytes: usize,
    ) -> Option<f64> {
        let (w_start, w_end) = local_window(text, byte_start, byte_end, context_bytes);
        let window = text.get(w_start..w_end)?;
        let local_start = byte_start - w_start;
        let local_end = byte_end - w_start;

        let enc = self.tokenizer.encode(window, true).ok()?;
        let ids = enc.get_ids();
        let offsets = enc.get_offsets(); // BYTE offsets into `window` (OffsetType::Byte)
        let span: Vec<usize> = offsets
            .iter()
            .enumerate()
            .filter(|&(_, &(o0, o1))| !(o0 == 0 && o1 == 0) && o0 < local_end && o1 > local_start)
            .map(|(i, _)| i)
            .collect();
        if span.is_empty() {
            return None;
        }

        let l = ids.len();
        let mut input_ids = Array2::<i64>::zeros((1, l));
        for (j, &id) in ids.iter().enumerate() {
            input_ids[[0, j]] = id as i64;
        }
        for &ti in &span {
            input_ids[[0, ti]] = self.mask_id;
        }
        let attention = Array2::<i64>::from_elem((1, l), 1i64);

        let in_ids = Tensor::from_array(input_ids).ok()?;
        let in_attn = Tensor::from_array(attention).ok()?;
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => in_ids,
                "attention_mask" => in_attn,
            ])
            .ok()?;
        let logits = extract_f32(&outputs[0])?; // [1, l, vocab]
        if logits.ndim() != 3 {
            return None;
        }
        let row = logits.index_axis(Axis(0), 0); // [l, vocab]

        let mut total = 0.0f64;
        for &ti in &span {
            let dist = row.index_axis(Axis(0), ti); // [vocab]
            let true_logit = *dist.get(ids[ti] as usize)?;
            let rank = dist.iter().filter(|&&v| v > true_logit).count();
            total += rank as f64;
        }
        Some(total / span.len() as f64)
    }
}

/// Default bytes of context to keep on each side of the scored span (the fastest, least-context
/// setting). A masked-LM decides whether a word fits from LOCAL context, so ~a sentence clause each
/// side is ample while capping the sequence the model runs on — the lever that keeps long-paragraph
/// correction well under the timeout even under the CPU contention of live dictation. The user can
/// widen it (Vocabulary tab slider, `general.dictionary_context_chars`) to trade speed for catching
/// borderline corrections; this is the floor. Short sentences are never clipped (see [`local_window`]).
pub const DEFAULT_CONTEXT_BYTES: usize = 220;

/// A local `[start, end)` window around `[span_start, span_end)` within `text`, at most
/// `context_bytes` on each side. Truncation happens ONLY when the span is farther than that from an
/// edge — so a short sentence keeps ALL its context (no quality change from pre-windowing behavior);
/// only long paragraphs get clipped. A clipped edge snaps to a whitespace boundary where one exists
/// (so the window never starts/ends mid-word) and always to a valid UTF-8 char boundary.
fn local_window(
    text: &str,
    span_start: usize,
    span_end: usize,
    context_bytes: usize,
) -> (usize, usize) {
    let bytes = text.as_bytes();
    let lo = if span_start <= context_bytes {
        0 // near the start already — keep everything before the span
    } else {
        let lo_target = span_start - context_bytes;
        (lo_target..span_start)
            .find(|&i| text.is_char_boundary(i) && bytes[i].is_ascii_whitespace())
            .map_or_else(
                || {
                    (lo_target..=span_start)
                        .find(|&i| text.is_char_boundary(i))
                        .unwrap_or(span_start)
                },
                |ws| ws + 1,
            )
    };
    let hi = if span_end + context_bytes >= text.len() {
        text.len() // near the end already — keep everything after the span
    } else {
        let hi_target = span_end + context_bytes;
        (span_end..hi_target)
            .rev()
            .find(|&i| text.is_char_boundary(i) && bytes[i].is_ascii_whitespace())
            .unwrap_or_else(|| {
                (span_end..=hi_target)
                    .rev()
                    .find(|&i| text.is_char_boundary(i))
                    .unwrap_or(span_end)
            })
    };
    (lo, hi)
}

/// Whether two normalized strings share a Double Metaphone code (homophones). Empty codes (non-Latin)
/// never match, so this only ever ADMITS a Latin homophone — the edit gate covers everything else.
fn double_metaphone_equal(a: &str, b: &str) -> bool {
    let (pa, sa) = crate::winstt::snippets::phonetic::double_metaphone(a);
    if pa.is_empty() && sa.is_empty() {
        return false;
    }
    let (pb, sb) = crate::winstt::snippets::phonetic::double_metaphone(b);
    (!pa.is_empty() && (pa == pb || pa == sb)) || (!sa.is_empty() && (sa == pb || sa == sb))
}

/// Restore the SOURCE span's casing onto the canonical `term`, so a mid-sentence or sentence-start
/// substitution reads naturally without clobbering a brand's intentional casing:
///   * source ALL-CAPS (≥2 letters) → uppercase the term ("VEET" → "VITE");
///   * source Titlecase AND term is all-lowercase → capitalize the term's first letter ("Veet" →
///     "Kubernetes"-style: lowercase term "kubernetes" → "Kubernetes");
///   * otherwise keep the term verbatim, preserving intentional internal casing ("DirectML", "BaseUI").
fn restore_case(source: &str, term: &str) -> String {
    let src_letters: Vec<char> = source.chars().filter(|c| c.is_alphabetic()).collect();
    let all_caps = src_letters.len() >= 2 && src_letters.iter().all(|c| c.is_uppercase());
    if all_caps {
        return term.to_uppercase();
    }
    let src_title = src_letters.first().is_some_and(|c| c.is_uppercase())
        && src_letters.iter().skip(1).all(|c| c.is_lowercase());
    let term_all_lower = term
        .chars()
        .filter(|c| c.is_alphabetic())
        .all(|c| c.is_lowercase());
    if src_title && term_all_lower {
        let mut out = String::with_capacity(term.len());
        let mut chars = term.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
        return out;
    }
    term.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_case_all_caps() {
        assert_eq!(restore_case("VEET", "Vite"), "VITE");
    }

    #[test]
    fn restore_case_title_lowercase_term() {
        assert_eq!(restore_case("Veet", "kubernetes"), "Kubernetes");
    }

    #[test]
    fn restore_case_preserves_brand_casing() {
        // Lowercase source must NOT down-case an intentional-cased brand term.
        assert_eq!(restore_case("directml", "DirectML"), "DirectML");
        assert_eq!(restore_case("base you eye", "BaseUI"), "BaseUI");
    }

    #[test]
    fn restore_case_titlecase_keeps_mixed_term() {
        // Title-cased source but a mixed-case term → keep the term verbatim.
        assert_eq!(restore_case("Directml", "DirectML"), "DirectML");
    }

    #[test]
    fn metaphone_equality_detects_homophones() {
        assert!(double_metaphone_equal("veet", "vite"));
        assert!(double_metaphone_equal("video", "vite"));
        assert!(!double_metaphone_equal("please", "supabase"));
    }

    #[test]
    fn local_window_returns_full_range_for_short_text() {
        let t = "install veet today";
        let s = t.find("veet").unwrap();
        assert_eq!(
            local_window(t, s, s + 4, DEFAULT_CONTEXT_BYTES),
            (0, t.len())
        );
    }

    #[test]
    fn local_window_bounds_long_text_around_the_span() {
        let long = format!("{} veet {}", "word ".repeat(200), "more ".repeat(200));
        let s = long.find("veet").unwrap();
        let (lo, hi) = local_window(&long, s, s + 4, DEFAULT_CONTEXT_BYTES);
        // Window is bounded, contains the span, and both edges are valid char boundaries.
        assert!(lo <= s && hi >= s + 4);
        assert!(hi - lo <= 4 + 2 * DEFAULT_CONTEXT_BYTES + 8);
        assert!(long.is_char_boundary(lo) && long.is_char_boundary(hi));
        assert!(long[lo..hi].contains("veet"));
    }

    #[test]
    fn local_window_widens_with_a_larger_setting() {
        let long = format!("{} veet {}", "word ".repeat(200), "more ".repeat(200));
        let s = long.find("veet").unwrap();
        let narrow = local_window(&long, s, s + 4, 220);
        let wide = local_window(&long, s, s + 4, 1000);
        assert!(
            (wide.1 - wide.0) > (narrow.1 - narrow.0),
            "larger setting must read more context"
        );
    }

    #[test]
    fn local_window_is_char_boundary_safe_with_multibyte() {
        // Accented context on both sides must never split a 2-byte char.
        let long = format!("{} veet {}", "café ".repeat(120), "résumé ".repeat(120));
        let s = long.find("veet").unwrap();
        let (lo, hi) = local_window(&long, s, s + 4, DEFAULT_CONTEXT_BYTES);
        assert!(long.is_char_boundary(lo) && long.is_char_boundary(hi));
        let _ = &long[lo..hi]; // must not panic
    }
}
