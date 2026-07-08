// Sampling helpers for the Qwen3-TTS talker — a faithful Rust port of the numpy
// sampling logic in the reference `inference.py`:
//   * `_apply_repetition_penalty` (inference.py L58-64)
//   * `_sample`                    (inference.py L67-87)
//
// The reference computes everything in f64 (`logits.astype(np.float64)`), so we
// mirror that: every helper here operates on `f64` and the caller promotes the
// f32 ONNX logits row to f64 once before calling. Greedy (`do_sample == false`
// || `temperature <= 0`) is `argmax`, which is what the parity tests exercise
// (100% greedy parity with PyTorch per STATUS.md).
//
// RNG NOTE / DEVIATION from BUILD_PLAN §"Sampling": the plan suggested the `rand`
// crate for `rng.choice`. `rand` is NOT a direct dependency of this crate and this
// stream owns only tts/*.rs (not Cargo.toml), so instead of adding a dependency we
// ship a tiny self-contained SplitMix64 PRNG here, seeded per synthesis call. It
// draws a uniform f64 in [0,1) and we do inverse-CDF selection — the same
// "sample an index with probability `p`" contract as numpy's `rng.choice(n, p=probs)`
// (inference.py L87). Production sampling is not required to be bit-identical to
// numpy's Mersenne/PCG stream; only greedy is parity-checked.

/// Minimal float RNG contract: a uniform draw in `[0, 1)`. Implemented by
/// [`SplitMix64Rng`]; kept as a trait so `sample`/`sample_categorical` are
/// testable with a deterministic stub.
pub trait UniformF64 {
    /// Next uniform f64 in `[0.0, 1.0)`.
    fn next_f64(&mut self) -> f64;
}

/// SplitMix64 — a tiny, well-distributed 64-bit PRNG (public domain, Vigna). Used
/// only for production categorical sampling; seeded per-call so a fixed seed gives
/// a reproducible voice.
pub struct SplitMix64Rng {
    state: u64,
}

impl SplitMix64Rng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        // Reference SplitMix64 step.
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

impl UniformF64 for SplitMix64Rng {
    #[inline]
    fn next_f64(&mut self) -> f64 {
        // Top 53 bits → f64 mantissa, matching the usual `u64 -> [0,1)` recipe.
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
}

/// `argmax` over an f64 logit row (greedy decode). Ties resolve to the first max,
/// matching numpy's `np.argmax` (inference.py L70).
pub fn argmax(logits: &[f64]) -> usize {
    let mut best = 0usize;
    let mut best_v = f64::NEG_INFINITY;
    for (i, &x) in logits.iter().enumerate() {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    best
}

/// `_apply_repetition_penalty` (inference.py L58-64). For each *unique* previously
/// sampled id `i`: `logits[i] = logits[i] * penalty if logits[i] < 0 else logits[i] / penalty`.
/// No-op when `penalty == 1.0` or `prev_ids` is empty.
pub fn apply_repetition_penalty(logits: &mut [f64], prev_ids: &[i64], penalty: f64) {
    if penalty == 1.0 || prev_ids.is_empty() {
        return;
    }
    // `sorted(set(...))` in the reference only dedups (order is irrelevant to the
    // element-wise update); a bounds-checked pass over the ids is equivalent.
    let mut seen = std::collections::HashSet::with_capacity(prev_ids.len());
    for &id in prev_ids {
        if id < 0 || (id as usize) >= logits.len() || !seen.insert(id) {
            continue;
        }
        let idx = id as usize;
        let sc = logits[idx];
        logits[idx] = if sc < 0.0 { sc * penalty } else { sc / penalty };
    }
}

/// `logits / max(temperature, 1e-6)` (inference.py L71). Caller guarantees this is
/// only reached on the sampling path (`temperature > 0`).
pub fn apply_temperature(logits: &mut [f64], temperature: f64) {
    let t = temperature.max(1e-6);
    for v in logits.iter_mut() {
        *v /= t;
    }
}

/// Top-k on **logits** (inference.py L72-75): keep the k largest, set the rest to
/// `-inf`. `kth = np.partition(logits, -k)[-k]`; `logits[logits < kth] = -inf`.
/// No-op when `top_k == 0`. `k` is clamped to the row length.
pub fn top_k_filter(logits: &mut [f64], top_k: usize) {
    if top_k == 0 {
        return;
    }
    let k = top_k.min(logits.len());
    if k == 0 {
        return;
    }
    // `np.partition(logits, -k)[-k]` = the k-th largest value. Copy + sort desc and
    // read index k-1 (row width ~3072, so this is cheap and avoids a custom
    // quickselect). Values strictly below the threshold are suppressed; ties at the
    // threshold are kept, exactly like `logits < kth`.
    let mut sorted: Vec<f64> = logits.to_vec();
    sorted.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let kth = sorted[k - 1];
    for v in logits.iter_mut() {
        if *v < kth {
            *v = f64::NEG_INFINITY;
        }
    }
}

/// Softmax over logits → probabilities (inference.py L76-78: subtract max, `exp`,
/// normalize). Any `-inf` logit maps to probability 0.
pub fn softmax(logits: &[f64]) -> Vec<f64> {
    let max = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut probs: Vec<f64> = logits
        .iter()
        .map(|&x| {
            let d = x - max;
            if d == f64::NEG_INFINITY { 0.0 } else { d.exp() }
        })
        .collect();
    let sum: f64 = probs.iter().sum();
    if sum > 0.0 {
        for p in probs.iter_mut() {
            *p /= sum;
        }
    }
    probs
}

/// Top-p (nucleus) on **probabilities** (inference.py L79-86): sort probs desc,
/// take the smallest prefix whose cumulative mass reaches `top_p`
/// (`cut = searchsorted(csum, top_p) + 1`), zero the rest, renormalize. No-op when
/// `top_p >= 1.0`.
pub fn top_p_filter(probs: &mut [f64], top_p: f64) {
    if top_p >= 1.0 {
        return;
    }
    // order = argsort(probs) descending.
    let mut order: Vec<usize> = (0..probs.len()).collect();
    order.sort_unstable_by(|&a, &b| {
        probs[b]
            .partial_cmp(&probs[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // cut = np.searchsorted(csum, top_p) + 1  (left side: first index with csum >= top_p, then +1).
    let mut csum = 0.0f64;
    let mut searchsorted = order.len();
    for (rank, &idx) in order.iter().enumerate() {
        csum += probs[idx];
        if csum >= top_p {
            searchsorted = rank;
            break;
        }
    }
    let cut = (searchsorted + 1).min(order.len());
    // Zero everything outside the kept prefix.
    for &idx in &order[cut..] {
        probs[idx] = 0.0;
    }
    let sum: f64 = probs.iter().sum();
    if sum > 0.0 {
        for p in probs.iter_mut() {
            *p /= sum;
        }
    }
}

/// `rng.choice(len(probs), p=probs)` (inference.py L87) via inverse-CDF using a
/// single uniform draw. `probs` must be normalized (sums to ~1). Returns the last
/// non-zero index if the draw overshoots due to fp rounding.
pub fn sample_categorical<R: UniformF64>(probs: &[f64], rng: &mut R) -> usize {
    let r = rng.next_f64();
    let mut acc = 0.0f64;
    let mut last_nonzero = 0usize;
    for (i, &p) in probs.iter().enumerate() {
        if p > 0.0 {
            last_nonzero = i;
        }
        acc += p;
        if r < acc {
            return i;
        }
    }
    last_nonzero
}

/// Full `_sample` (inference.py L67-87). Order is EXACT:
///   1. greedy short-circuit: `!do_sample || temperature <= 0` → `argmax`
///   2. temperature scaling (on logits)
///   3. top-k on logits
///   4. softmax → probs
///   5. top-p on probs
///   6. categorical draw
///
/// The caller applies `suppress` + repetition penalty to the logits BEFORE calling
/// this (matching the reference, which mutates `first` then calls `_sample`).
pub fn sample<R: UniformF64>(
    logits: &[f64],
    do_sample: bool,
    top_k: usize,
    top_p: f64,
    temperature: f64,
    rng: &mut R,
) -> usize {
    if !do_sample || temperature <= 0.0 {
        return argmax(logits);
    }
    let mut work = logits.to_vec();
    apply_temperature(&mut work, temperature);
    top_k_filter(&mut work, top_k);
    let mut probs = softmax(&work);
    top_p_filter(&mut probs, top_p);
    sample_categorical(&probs, rng)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic stub RNG returning a fixed uniform value, for reproducible
    /// categorical-selection assertions.
    struct FixedRng(f64);
    impl UniformF64 for FixedRng {
        fn next_f64(&mut self) -> f64 {
            self.0
        }
    }

    #[test]
    fn greedy_picks_argmax() {
        let logits = [0.1_f64, 2.5, -1.0, 2.5, 0.3];
        // do_sample=false → argmax (first max on ties = index 1).
        assert_eq!(sample(&logits, false, 50, 1.0, 0.9, &mut FixedRng(0.5)), 1);
        // temperature <= 0 also forces greedy regardless of do_sample.
        assert_eq!(sample(&logits, true, 50, 0.0, 0.0, &mut FixedRng(0.5)), 1);
        assert_eq!(argmax(&logits), 1);
    }

    #[test]
    fn top_k_shrinks_support() {
        let mut logits = [1.0_f64, 2.0, 3.0, 4.0, 5.0];
        top_k_filter(&mut logits, 2);
        // Only the top 2 (values 4.0, 5.0) survive; the rest are -inf.
        let kept: Vec<usize> = logits
            .iter()
            .enumerate()
            .filter(|(_, v)| v.is_finite())
            .map(|(i, _)| i)
            .collect();
        assert_eq!(kept, vec![3, 4]);
    }

    #[test]
    fn top_p_shrinks_support() {
        // A peaked distribution: index 0 already exceeds top_p=0.6.
        let mut probs = [0.7_f64, 0.2, 0.06, 0.04];
        top_p_filter(&mut probs, 0.6);
        // Only the nucleus (index 0) keeps mass; it renormalizes to 1.0.
        assert!(probs[0] > 0.999);
        assert_eq!(probs[1], 0.0);
        assert_eq!(probs[2], 0.0);
        assert_eq!(probs[3], 0.0);
    }

    #[test]
    fn repetition_penalty_matches_reference() {
        // sc < 0 → *penalty (more negative); sc >= 0 → /penalty (smaller).
        let mut logits = [2.0_f64, -2.0, 5.0];
        apply_repetition_penalty(&mut logits, &[0, 1, 0], 2.0);
        assert!((logits[0] - 1.0).abs() < 1e-12); // 2.0 / 2.0
        assert!((logits[1] + 4.0).abs() < 1e-12); // -2.0 * 2.0
        assert!((logits[2] - 5.0).abs() < 1e-12); // untouched
        // penalty == 1.0 is a no-op.
        let mut same = [1.0_f64, 2.0];
        apply_repetition_penalty(&mut same, &[0, 1], 1.0);
        assert_eq!(same, [1.0, 2.0]);
    }

    #[test]
    fn softmax_normalizes_and_zeros_neg_inf() {
        let probs = softmax(&[0.0_f64, f64::NEG_INFINITY, 0.0]);
        let sum: f64 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-12);
        assert_eq!(probs[1], 0.0);
        assert!((probs[0] - 0.5).abs() < 1e-12);
    }

    #[test]
    fn categorical_inverse_cdf_selects_bucket() {
        let probs = [0.25_f64, 0.25, 0.5];
        // r just below 0.25 → index 0; r=0.3 (in [0.25,0.5)) → index 1; r=0.9 → index 2.
        assert_eq!(sample_categorical(&probs, &mut FixedRng(0.1)), 0);
        assert_eq!(sample_categorical(&probs, &mut FixedRng(0.3)), 1);
        assert_eq!(sample_categorical(&probs, &mut FixedRng(0.9)), 2);
    }

    #[test]
    fn splitmix64_is_deterministic_and_in_range() {
        let mut a = SplitMix64Rng::new(42);
        let mut b = SplitMix64Rng::new(42);
        for _ in 0..1000 {
            let x = a.next_f64();
            assert_eq!(x, b.next_f64());
            assert!((0.0..1.0).contains(&x));
        }
    }
}
