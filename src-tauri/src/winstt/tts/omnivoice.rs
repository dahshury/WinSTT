// OmniVoice (k2-fsa) — 646-language NON-AUTOREGRESSIVE masked-refinement TTS.
//
// This is architecturally unlike every other engine in this tree. There is no
// autoregressive decode and NO KV CACHE — attention is fully bidirectional, so each of
// the 32 refinement steps is a COMPLETE forward pass over the whole sequence
// (style/text prefix + reference frames + target frames), and classifier-free guidance
// doubles the batch. A prefix KV cache is impossible even in principle here: with
// bidirectional attention the prefix hidden states depend on the target positions,
// which change every step.
//
// MEASURED on this box (i9-12900KF, quiet machine, high priority, fp32, warm) with
// `examples/omnivoice_step_probe.rs`; per-step min over 3 rounds, x32 steps, 3 s target:
//
//   reference clip | L   | CPU EP RTF | DirectML RTF
//   ---------------|-----|------------|-------------
//   none           | 111 |   3.37x    |    1.70x
//   3 s   (75 fr)  | 198 |   6.45x    |    2.61x
//   10 s (250 fr)  | 391 |  13.70x    |    3.02x
//   12.5 s (313 fr)| 484 |  17.04x    |    3.41x
//
// Achieved throughput is ~610 GFLOP/s on the CPU EP (flat across L), so cost is
// essentially `O(num_step * L^2)` with `L` INCLUDING the reference frames. Two
// consequences that are load-bearing for the product:
//   * a long reference clip taxes EVERY sentence, forever — it is not a one-time cost;
//   * an over-estimated duration is paid for quadratically, so `estimate_duration`
//     must not add slack.
// CPU-pinned like the other LLM-class engines (DirectML is measurably ~2.5x faster and
// numerically agrees with the CPU EP to ~1e-6 relative, but is left unvalidated for
// audio quality in v1 — see the probe example).
//
// Export set is a HYBRID and deliberately so:
//   * `omnivoice_step.onnx` (+ `.data`) from the WebGPU-demo asset repo — the only
//     export that keeps the 4-D bidirectional `[B,1,L,L]` mask. VERIFIED bidirectional
//     empirically: perturbing a LATER target frame changes an EARLIER frame's logits
//     (max|dlogit| = 2.27 vs 0 for a causal graph).
//   * `audio_tokenizer/{acoustic,semantic,quantizer}_encoder.onnx` + `higgs_decoder.onnx`
//     from onnx-community — the waveform->codes path the demo export lacks, which is what
//     makes runtime cloning possible.
//
// CROSS-EXPORT CODE-SPACE COMPATIBILITY IS PROVEN, not assumed. The hybrid only works if
// export B's quantizer emits codes in the index space export A's `audio_embeddings.weight`
// was trained against. Validated against the demo's published golden reference
// (`manh_dung_natural_warm_vi.bb5865a10855f6b573.omnivoice-ref.json`, produced by export
// A's own Python pipeline): encoding the same mp3 through export B's three encoders here
// yields 313 frames (exactly the published count) and **92.21% bit-exact codes**
// (2309/2504), with agreement falling monotonically from 99.4% on codebook 0 to ~85% on
// codebooks 6-7. That gradient is the expected signature of fp32 drift through the RVQ's
// Euclidean argmin — a hard decision boundary where near-ties flip and the error compounds
// into later residual stages — not of a permuted or re-indexed codebook, which would score
// at chance (~0.1%).

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::sampling::{SplitMix64Rng, UniformF64};

// ── constants ───────────────────────────────────────────────────────────────────

pub const OMNIVOICE_SAMPLE_RATE: u32 = 24_000;
/// `hop_length = prod(downsampling_ratios [8,5,4,2,3]) = 960`; `24000 / 960 = 25`.
pub const OMNIVOICE_FRAME_RATE: usize = 25;
const HOP_LENGTH: usize = 960;
/// HuBERT branch runs at 16 kHz; the 24->16 kHz hop is the only resample we own.
const SEMANTIC_SAMPLE_RATE: u32 = 16_000;

const CODEBOOKS: usize = 8;
/// Valid codes are `0..=1023`; `1024` is `audio_mask_id`.
const AUDIO_VOCAB: usize = 1025;
const MASK_ID: i64 = 1024;

// Generation defaults — identical in the demo runtime and upstream Python.
const NUM_STEP: usize = 32;
const GUIDANCE_SCALE: f32 = 2.0;
const T_SHIFT: f64 = 0.1;
const LAYER_PENALTY_FACTOR: f32 = 5.0;
const POSITION_TEMPERATURE: f32 = 5.0;
// NOTE: the upstream manifest's `classTemperature` default is 0.0, which makes the
// top-10%/Gumbel TOKEN-sampling branch dead code — `pred` is a pure argmax, and only
// POSITION selection is stochastic at defaults. The token-sampling path is therefore
// deliberately not implemented (see `select_positions`); no constant is carried for it.

const TAIL_BUFFER_SEC: f64 = 0.25;
const PAD_DURATION_SEC: f64 = 0.1;
const FADE_DURATION_SEC: f64 = 0.1;
/// Reference-side RMS target: the clip is scaled up to this only when it is quieter.
const REF_RMS_TARGET: f64 = 0.1;
/// -50 dBFS as a linear per-sample amplitude.
const SILENCE_THRESHOLD: f32 = 0.003_162_277_6;

/// Fixed so a `warm_up`/`shutdown` cycle does not change the voice. Sentence-to-sentence
/// timbre consistency comes from the REFERENCE CLIP, not from this seed.
const RNG_SEED: u64 = 0x0111_c01c_e5ee_d001;

/// The 13 non-verbal tags. NOT special tokens — ordinary ASCII BPE. The only thing that
/// makes them work is per-segment isolation, which kills cross-boundary merges.
pub const OMNIVOICE_TAGS: &[&str] = &[
    "laughter",
    "sigh",
    "confirmation-en",
    "question-en",
    "question-ah",
    "question-oh",
    "question-ei",
    "question-yi",
    "surprise-ah",
    "surprise-oh",
    "surprise-wa",
    "surprise-yo",
    "dissatisfaction-hnn",
];

/// The seven tokens `omnivoice/training/builder.py` appends to the Qwen3 vocabulary.
/// VERIFIED by Range-GET of `k2-fsa/OmniVoice/tokenizer.json`'s `added_tokens` array:
/// they occupy 151669..=151675 in exactly this order.
const SPECIAL_TOKENS: &[&str] = &[
    "<|denoise|>",
    "<|lang_start|>",
    "<|lang_end|>",
    "<|instruct_start|>",
    "<|instruct_end|>",
    "<|text_start|>",
    "<|text_end|>",
];

/// WinSTT language code -> OmniVoice language id. The string between `<|lang_start|>`
/// and `<|lang_end|>` is the "OmniVoice ID" column, which is ISO 639-1 where one exists
/// and ISO 639-3 otherwise — English is `en`, NOT `eng`. Anything unmapped degrades to
/// the literal sentinel `None` (language-agnostic mode), which upstream's
/// `_resolve_language` also does rather than raising.
const LANG_MAP: &[(&str, &str)] = &[
    ("en-us", "en"),
    ("en-gb", "en"),
    ("ja", "ja"),
    ("cmn", "zh"),
    ("es", "es"),
    ("fr", "fr"),
    ("hi", "hi"),
    ("it", "it"),
    ("pt-br", "pt"),
];

/// The literal 4-char sentinel a trained empty lang/instruct slot expects. NEVER emit an
/// empty span — `None` is a trained token sequence, absence is not.
const NONE_SENTINEL: &str = "None";

// ── errors ──────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum OmniVoiceError {
    Session(String),
    Tokenizer(String),
    Reference(String),
    Inference(String),
}

impl std::fmt::Display for OmniVoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OmniVoiceError::Session(m) => write!(f, "omnivoice session: {m}"),
            OmniVoiceError::Tokenizer(m) => write!(f, "omnivoice tokenizer: {m}"),
            OmniVoiceError::Reference(m) => write!(f, "omnivoice reference: {m}"),
            OmniVoiceError::Inference(m) => write!(f, "omnivoice inference: {m}"),
        }
    }
}

pub type OmniVoiceResult<T> = Result<T, OmniVoiceError>;

fn cpu_session(path: &Path, engine: &str) -> OmniVoiceResult<Session> {
    super::provider::cpu_session(
        path,
        "OmniVoice is a CPU-pinned bidirectional masked-refinement engine (DirectML unvalidated)",
        engine,
    )
    .map_err(OmniVoiceError::Session)
}

// ── text assembly ───────────────────────────────────────────────────────────────

/// Upstream `_combine_text`, character-exact. Runs on the RAW text; the
/// `<|text_start|>`/`<|text_end|>` literals are wrapped AFTER, so these transforms never
/// touch the tag literals.
///
/// Three Rust traps encoded here:
///   * `[\r\n]+` is DELETED, not replaced with a space — `"a\nb"` becomes `"ab"`.
///   * the `[ \t]+ -> " "` collapse runs BEFORE the CJK rule; reversing them changes
///     `"中文 \t English"`.
///   * the CJK rule uses a LOOKBEHIND upstream, which the `regex` crate cannot express,
///     so it is hand-rolled: drop any whitespace run whose immediately preceding OR
///     following char is a CJK ideograph.
pub fn combine_text(ref_text: Option<&str>, text: &str) -> String {
    let joined = match ref_text {
        Some(r) if !r.trim().is_empty() => format!("{} {}", r.trim(), text.trim()),
        _ => text.trim().to_string(),
    };
    // [\r\n]+ -> "" (deleted)
    let no_newlines: String = joined
        .chars()
        .filter(|c| *c != '\r' && *c != '\n')
        .collect();
    // fullwidth parens only — do NOT extend this set, upstream does not.
    let parens: String = no_newlines
        .chars()
        .map(|c| match c {
            '（' => '(',
            '）' => ')',
            other => other,
        })
        .collect();
    // [ \t]+ -> " "
    let mut collapsed = String::with_capacity(parens.len());
    let mut in_space = false;
    for c in parens.chars() {
        if c == ' ' || c == '\t' {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    // Drop whitespace adjacent to a CJK ideograph (the hand-rolled lookbehind|lookahead).
    let chars: Vec<char> = collapsed.chars().collect();
    let mut out = String::with_capacity(collapsed.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let start = i;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            let prev_cjk = start
                .checked_sub(1)
                .and_then(|p| chars.get(p))
                .is_some_and(|c| is_cjk(*c));
            let next_cjk = chars.get(i).is_some_and(|c| is_cjk(*c));
            if !prev_cjk && !next_cjk {
                out.extend(&chars[start..i]);
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn is_cjk(c: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&c)
}

/// Map a WinSTT language code onto the OmniVoice id, or the literal `None` sentinel.
fn omnivoice_lang(lang: &str) -> &'static str {
    let key = lang.trim().to_ascii_lowercase();
    LANG_MAP
        .iter()
        .find(|(w, _)| *w == key)
        .map_or(NONE_SENTINEL, |(_, o)| *o)
}

/// Build the style span. `<|denoise|>` is CONDITIONAL on reference codes being present
/// (not on `ref_text`), and empty lang/instruct become the literal string `None` — both
/// verified against the demo runtime and upstream `_prepare_inference_inputs`.
fn build_style(has_reference: bool, lang: &str, instruct: Option<&str>) -> String {
    let denoise = if has_reference { "<|denoise|>" } else { "" };
    let lang_str = omnivoice_lang(lang);
    let instruct_str = instruct
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(NONE_SENTINEL);
    format!(
        "{denoise}<|lang_start|>{lang_str}<|lang_end|><|instruct_start|>{instruct_str}<|instruct_end|>"
    )
}

/// Byte offsets of every `[tag]` occurrence, for the 13 known tags only.
/// Case-sensitive, lowercase, no whitespace tolerance inside the brackets.
fn nonverbal_spans(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some(rel) = text[i + 1..].find(']')
        {
            let inner = &text[i + 1..i + 1 + rel];
            if OMNIVOICE_TAGS.contains(&inner) {
                spans.push((i, i + rel + 2));
                i += rel + 2;
                continue;
            }
        }
        i += 1;
    }
    spans
}

/// Tokenize with each non-verbal tag encoded IN ISOLATION so BPE can never merge it into
/// the surrounding language context (upstream: "to guarantee consistent token IDs
/// regardless of surrounding language context").
fn tokenize_with_nonverbal_tags(tok: &Tokenizer, text: &str) -> OmniVoiceResult<Vec<u32>> {
    let encode = |s: &str| -> OmniVoiceResult<Vec<u32>> {
        if s.is_empty() {
            return Ok(Vec::new());
        }
        tok.encode(s, false)
            .map(|e| e.get_ids().to_vec())
            .map_err(|e| OmniVoiceError::Tokenizer(format!("encode: {e}")))
    };
    let mut ids = Vec::new();
    let mut last_end = 0usize;
    for (start, end) in nonverbal_spans(text) {
        if start > last_end {
            ids.extend(encode(&text[last_end..start])?);
        }
        ids.extend(encode(&text[start..end])?);
        last_end = end;
    }
    if last_end < text.len() {
        ids.extend(encode(&text[last_end..])?);
    }
    Ok(ids)
}

// ── duration ────────────────────────────────────────────────────────────────────

/// `frames = max(1, round((duration_sec + 0.25) * 25))`.
fn frames_for(duration_sec: f64) -> usize {
    let f = ((duration_sec + TAIL_BUFFER_SEC) * OMNIVOICE_FRAME_RATE as f64).round();
    (f as usize).max(1)
}

/// Demo-grade heuristic (upstream ships a `duration.py` we could not read). Two
/// deliberate divergences from the JS, both documented:
///   * the JS guards the reference-calibrated branch on a field its own reference object
///     never carries, making that branch dead code in the browser. Ours carries `frames`,
///     so we activate it — it is the better estimate.
///   * upstream's whitespace word count clobbers the CJK path, so we gate on `!has_cjk`.
fn estimate_duration(text: &str, reference: Option<&ReferencePrompt>) -> f64 {
    let clean = combine_text(None, text);
    if clean.is_empty() {
        return 1.2;
    }
    let has_cjk = clean.chars().any(is_cjk);
    let punct = clean
        .chars()
        .filter(|c| ",.!?;:，。！？；：".contains(*c))
        .count() as f64;
    let words = clean.split_whitespace().count() as f64;
    let mut secs = if has_cjk {
        clean.chars().filter(|c| is_cjk(*c)).count() as f64 / 4.4
    } else {
        words / 2.75
    };
    if let Some(r) = reference {
        let ref_words = r.ref_text.split_whitespace().count();
        if ref_words > 2 && r.frames > 0 && !has_cjk {
            let ref_secs = r.frames as f64 / (r.frame_rate.max(1) as f64);
            let ref_wps = ref_words as f64 / ref_secs.max(0.1);
            secs = words / ref_wps.max(1.6);
        }
    }
    (secs + punct * 0.14 + 0.35).max(0.8)
}

// ── unmasking schedule ──────────────────────────────────────────────────────────

/// Flow-matching-shifted cumulative unmask fractions, differenced into per-step counts.
///
/// `t' = s*t / (1 + (s-1)*t)` with `s = 0.1` over `num_step + 1` denominators. `ceil` on
/// every non-final step guarantees >= 1 token per step, and the final step takes whatever
/// remains, so the schedule sums to EXACTLY `total` and every position is filled once.
///
/// The result is strongly back-loaded by construction (at defaults the last step commits
/// ~37% of all tokens in one shot). That falls out of `denom = num_step + 1` combined
/// with `t_shift < 1`; it is reproduced faithfully rather than "fixed".
fn build_schedule(total: usize, num_step: usize, t_shift: f64) -> Vec<usize> {
    let denom = (num_step + 1) as f64;
    let times: Vec<f64> = (0..=(num_step + 1))
        .map(|i| {
            let t = i as f64 / denom;
            (t_shift * t) / (1.0 + (t_shift - 1.0) * t)
        })
        .collect();
    let mut remaining = total;
    let mut sched = Vec::with_capacity(num_step);
    for step in 0..num_step {
        let amount = if step + 1 == num_step {
            remaining
        } else {
            let want = ((total as f64) * (times[step + 1] - times[step])).ceil();
            (want.max(0.0) as usize).min(remaining)
        };
        sched.push(amount);
        remaining -= amount;
    }
    sched
}

/// In-place log-softmax over a logits row.
fn log_softmax_in_place(v: &mut [f32]) {
    let m = v.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if !m.is_finite() {
        return;
    }
    let sum: f32 = v.iter().map(|x| (x - m).exp()).sum();
    let ls = sum.ln();
    for x in v.iter_mut() {
        *x = *x - m - ls;
    }
}

/// Standard Gumbel(0,1) draw via inverse CDF.
fn sample_gumbel(rng: &mut SplitMix64Rng) -> f32 {
    let u = rng.next_f64().clamp(1e-10, 1.0 - 1e-10);
    -((-u.ln()).ln()) as f32
}

// ── reference prompt ────────────────────────────────────────────────────────────

/// A reference clip reduced to audio codes + the scalars the generation needs.
///
/// Deliberately the SAME schema the demo Space publishes as
/// `<name>.<hash>.omnivoice-ref.json`, so a shipped golden file is a drop-in fixture and
/// our on-disk cache is inspectable with the same tooling.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ReferencePrompt {
    pub schema_version: u32,
    pub ref_text: String,
    pub sample_rate: u32,
    pub frame_rate: usize,
    pub codebooks: usize,
    pub frames: usize,
    pub duration_sec: f64,
    pub ref_rms: f64,
    /// `[8][frames]`, CODEBOOK-MAJOR, values `0..=1023`.
    pub audio_tokens: Vec<Vec<i16>>,
}

impl ReferencePrompt {
    fn validate(&self) -> OmniVoiceResult<()> {
        if self.codebooks != CODEBOOKS || self.audio_tokens.len() != CODEBOOKS {
            return Err(OmniVoiceError::Reference(format!(
                "expected {CODEBOOKS} codebooks, got {}",
                self.audio_tokens.len()
            )));
        }
        if self.frames == 0 {
            return Err(OmniVoiceError::Reference("zero reference frames".into()));
        }
        for (c, row) in self.audio_tokens.iter().enumerate() {
            if row.len() != self.frames {
                return Err(OmniVoiceError::Reference(format!(
                    "codebook {c} has {} frames, expected {}",
                    row.len(),
                    self.frames
                )));
            }
            if let Some(bad) = row.iter().find(|v| !(0..MASK_ID as i16).contains(v)) {
                return Err(OmniVoiceError::Reference(format!(
                    "codebook {c} carries out-of-range code {bad}"
                )));
            }
        }
        Ok(())
    }
}

/// Identifies a cached reference so an edited clip or transcript re-encodes.
#[derive(Clone, PartialEq, Eq, Debug)]
struct RefCacheKey {
    path: String,
    mtime: u64,
    len: u64,
    ref_text: String,
}

impl RefCacheKey {
    fn for_clip(path: &Path, ref_text: &str) -> Self {
        let (mtime, len) = std::fs::metadata(path).map_or((0, 0), |m| {
            let mt = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            (mt, m.len())
        });
        Self {
            path: path.to_string_lossy().to_string(),
            mtime,
            len,
            ref_text: ref_text.to_string(),
        }
    }

    /// Stable filename component. FNV-1a over the key fields — this only has to avoid
    /// collisions within one user's cache dir, not resist an adversary.
    fn hash(&self) -> String {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for part in [
            self.path.as_str(),
            self.ref_text.as_str(),
            &self.mtime.to_string(),
            &self.len.to_string(),
        ] {
            for b in part.as_bytes() {
                h ^= u64::from(*b);
                h = h.wrapping_mul(0x1000_0000_01b3);
            }
        }
        format!("{h:016x}")
    }
}

/// The three ENCODE-ONLY graphs. Loaded on demand and DROPPED as soon as the codes exist
/// — `semantic_encoder` alone is 436 MB fp32 and is never needed at synthesis time.
struct TokenizerStack {
    acoustic: Session,
    semantic: Session,
    quantizer: Session,
}

// ── engine ──────────────────────────────────────────────────────────────────────

pub struct OmniVoiceEngine {
    step: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    cache_dir: PathBuf,
    rng: SplitMix64Rng,
    reference: Option<(RefCacheKey, ReferencePrompt)>,
}

impl OmniVoiceEngine {
    pub fn load(
        step_path: &Path,
        decoder_path: &Path,
        tokenizer_path: &Path,
        cache_dir: &Path,
    ) -> OmniVoiceResult<Self> {
        let step = cpu_session(step_path, "OmniVoice step")?;
        let decoder = cpu_session(decoder_path, "OmniVoice codec decoder")?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            OmniVoiceError::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;
        // The seven OmniVoice tokens must all resolve. We assert PRESENCE, not the exact
        // ids: a tokenizer that resolves all seven at different ids still works, and
        // hard-failing on the value would brick the engine for no reason. `None` is the
        // real failure — it means the shipped tokenizer is not an OmniVoice tokenizer and
        // the style span would silently BPE into garbage.
        let mut resolved = Vec::with_capacity(SPECIAL_TOKENS.len());
        for name in SPECIAL_TOKENS {
            let id = tokenizer.token_to_id(name).ok_or_else(|| {
                OmniVoiceError::Tokenizer(format!(
                    "tokenizer.json is missing the OmniVoice special token {name}"
                ))
            })?;
            resolved.push((*name, id));
        }
        log::debug!("[tts] omnivoice special tokens: {resolved:?}");

        Ok(Self {
            step,
            decoder,
            tokenizer,
            cache_dir: cache_dir.to_path_buf(),
            rng: SplitMix64Rng::new(RNG_SEED),
            reference: None,
        })
    }

    /// True when the three encode-only graphs are on disk, i.e. runtime cloning is
    /// possible. Mirrors Spark's `cloning_ready` so a partial cache fails LOUDLY rather
    /// than silently synthesizing an unrelated voice.
    pub fn cloning_ready(&self) -> bool {
        ["acoustic_encoder", "semantic_encoder", "quantizer_encoder"]
            .iter()
            .all(|g| self.tokenizer_stack_path(g).is_file())
    }

    fn tokenizer_stack_path(&self, graph: &str) -> PathBuf {
        self.cache_dir
            .join("audio_tokenizer")
            .join(format!("{graph}.onnx"))
    }

    fn load_tokenizer_stack(&self) -> OmniVoiceResult<TokenizerStack> {
        Ok(TokenizerStack {
            acoustic: cpu_session(
                &self.tokenizer_stack_path("acoustic_encoder"),
                "OmniVoice acoustic encoder",
            )?,
            semantic: cpu_session(
                &self.tokenizer_stack_path("semantic_encoder"),
                "OmniVoice semantic encoder",
            )?,
            quantizer: cpu_session(
                &self.tokenizer_stack_path("quantizer_encoder"),
                "OmniVoice quantizer",
            )?,
        })
    }

    // ── reference encoding ──────────────────────────────────────────────────────

    /// Resolve the reference prompt for `clip_path`, hitting (in order) the in-memory
    /// slot, the on-disk JSON cache, then the three encoder graphs.
    ///
    /// This caching is ARCHITECTURALLY MANDATORY, not an optimisation: `read_aloud`
    /// splits text into sentences and calls `synthesize_sentence` once per sentence, so
    /// re-encoding would re-run ~655 MB of encoder graphs for every sentence.
    pub fn ensure_reference(
        &mut self,
        clip: &[f32],
        clip_path: &Path,
        ref_text: &str,
    ) -> OmniVoiceResult<ReferencePrompt> {
        let key = RefCacheKey::for_clip(clip_path, ref_text);
        if let Some((cached_key, prompt)) = &self.reference
            && *cached_key == key
        {
            return Ok(prompt.clone());
        }
        let disk = self.reference_cache_path(&key);
        if let Some(prompt) = std::fs::read_to_string(&disk)
            .ok()
            .and_then(|s| serde_json::from_str::<ReferencePrompt>(&s).ok())
            .filter(|p| p.validate().is_ok() && p.ref_text == ref_text)
        {
            self.reference = Some((key, prompt.clone()));
            return Ok(prompt);
        }
        if !self.cloning_ready() {
            return Err(OmniVoiceError::Reference(
                "OmniVoice audio-tokenizer graphs are not downloaded for this model".into(),
            ));
        }
        let prompt = self.encode_reference(clip, ref_text)?;
        if let Some(parent) = disk.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&prompt) {
            let _ = std::fs::write(&disk, json);
        }
        self.reference = Some((key, prompt.clone()));
        Ok(prompt)
    }

    fn reference_cache_path(&self, key: &RefCacheKey) -> PathBuf {
        self.cache_dir
            .join("reference_cache")
            .join(format!("{}.omnivoice-ref.json", key.hash()))
    }

    /// Faithful inline port of upstream `create_voice_clone_prompt`.
    ///
    /// ORDERING IS LOAD-BEARING: `ref_rms` is measured over the WHOLE resampled mono clip
    /// BEFORE any trim or silence removal, because the output-gain branch in
    /// `post_process` is its exact mirror.
    ///
    /// Step 4 of the upstream sequence (`trim_long_audio` when `ref_text is None`) is
    /// deliberately SKIPPED: upstream skips it whenever a transcript is user-provided,
    /// "otherwise the trimmed audio will no longer match the full transcript", and WinSTT
    /// always has a transcript.
    fn encode_reference(&self, clip: &[f32], ref_text: &str) -> OmniVoiceResult<ReferencePrompt> {
        if clip.is_empty() {
            return Err(OmniVoiceError::Reference("reference clip is empty".into()));
        }
        // 2. ref_rms over the whole clip, before anything else touches it.
        let ref_rms = (clip
            .iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum::<f64>()
            / clip.len() as f64)
            .sqrt();
        // 3. normalise UP only — a clip already at >= 0.1 is fed unscaled.
        let mut x: Vec<f32> = if ref_rms > 0.0 && ref_rms < REF_RMS_TARGET {
            let g = (REF_RMS_TARGET / ref_rms) as f32;
            clip.iter().map(|s| s * g).collect()
        } else {
            clip.to_vec()
        };
        // 5. edge + interior silence removal.
        x = remove_silence(&x, OMNIVOICE_SAMPLE_RATE);
        if x.is_empty() {
            return Err(OmniVoiceError::Reference(
                "Reference audio is empty after silence removal.".into(),
            ));
        }
        // 6. hop-length alignment (the codec consumes whole 960-sample hops).
        let clip_size = x.len() % HOP_LENGTH;
        if clip_size > 0 {
            x.truncate(x.len() - clip_size);
        }
        if x.is_empty() {
            return Err(OmniVoiceError::Reference(
                "Reference audio is too short after hop-length alignment.".into(),
            ));
        }
        let duration_sec = x.len() as f64 / f64::from(OMNIVOICE_SAMPLE_RATE);
        // 7. the ONLY resample we own: 24 kHz -> 16 kHz for the HuBERT branch.
        let x16 = resample_to_16k(&x);

        let mut stack = self.load_tokenizer_stack()?;
        // 8. acoustic_encoder(waveform_24k[1,1,T]) -> acoustic_features[1,256,T_a]
        let acoustic = run_single_f32(
            &mut stack.acoustic,
            "waveform_24k",
            vec![1, 1, x.len()],
            x.clone(),
        )?;
        // 9. semantic_encoder(waveform_16k[1,T]) -> semantic_features[1,768,T_s].
        //    NOTE the 2-D input: no channel axis, unlike the acoustic branch.
        let semantic =
            run_single_f32(&mut stack.semantic, "waveform_16k", vec![1, x16.len()], x16)?;
        // 10. trim BOTH to min(T_a, T_s) when they disagree.
        let t_a = *acoustic.0.last().unwrap_or(&0);
        let t_s = *semantic.0.last().unwrap_or(&0);
        let t = t_a.min(t_s);
        if t == 0 {
            return Err(OmniVoiceError::Reference(
                "reference encoders produced zero frames".into(),
            ));
        }
        let acoustic = trim_last_axis(&acoustic, 256, t);
        let semantic = trim_last_axis(&semantic, 768, t);

        // 11. quantizer_encoder(acoustic, semantic) -> codes[8,1,T] int64, 0..=1023.
        let codes = {
            let a = tensor_f32(vec![1, 256, t], acoustic)?;
            let s = tensor_f32(vec![1, 768, t], semantic)?;
            let out = stack
                .quantizer
                .run(ort::inputs! { "acoustic_features" => a, "semantic_features" => s })
                .map_err(|e| OmniVoiceError::Inference(format!("quantizer_encoder: {e}")))?;
            let (shape, data) = out["codes"]
                .try_extract_tensor::<i64>()
                .map_err(|e| OmniVoiceError::Inference(format!("extract codes: {e}")))?;
            let frames = *shape.last().unwrap_or(&0) as usize;
            let mut rows = (0..CODEBOOKS)
                .map(|_| Vec::with_capacity(frames))
                .collect::<Vec<_>>();
            for (c, row) in rows.iter_mut().enumerate() {
                for f in 0..frames {
                    row.push(data[c * frames + f] as i16);
                }
            }
            (rows, frames)
        };
        // `stack` (655 MB of encode-only graphs) drops here.
        drop(stack);

        let prompt = ReferencePrompt {
            schema_version: 1,
            ref_text: ref_text.to_string(),
            sample_rate: OMNIVOICE_SAMPLE_RATE,
            frame_rate: OMNIVOICE_FRAME_RATE,
            codebooks: CODEBOOKS,
            frames: codes.1,
            duration_sec,
            ref_rms,
            audio_tokens: codes.0,
        };
        prompt.validate()?;
        Ok(prompt)
    }

    // ── synthesis ───────────────────────────────────────────────────────────────

    /// Render one sentence. `reference` is `None` for the (much faster, but not
    /// voice-stable) no-clip path. `instruct` is the natural-language style
    /// instruction filling the `<|instruct_start|>…<|instruct_end|>` span; `None`
    /// (or blank) emits the trained `None` sentinel that [`build_style`] documents.
    pub fn synthesize(
        &mut self,
        text: &str,
        lang: &str,
        reference: Option<&ReferencePrompt>,
        instruct: Option<&str>,
    ) -> OmniVoiceResult<Vec<f32>> {
        let has_ref = reference.is_some();
        // 1. style span, then the text span with the reference transcript prepended
        //    INSIDE the same <|text_start|> block, joined by a single space.
        let style = build_style(has_ref, lang, instruct);
        let style_ids = self
            .tokenizer
            .encode(style.as_str(), false)
            .map(|e| e.get_ids().to_vec())
            .map_err(|e| OmniVoiceError::Tokenizer(format!("style encode: {e}")))?;
        let full = combine_text(reference.map(|r| r.ref_text.as_str()), text);
        let wrapped = format!("<|text_start|>{full}<|text_end|>");
        let text_ids = tokenize_with_nonverbal_tags(&self.tokenizer, &wrapped)?;

        let prefix_len = style_ids.len() + text_ids.len();
        let ref_frames = reference.map_or(0, |r| r.frames);
        let target_frames = frames_for(estimate_duration(text, reference));
        let seq = prefix_len + ref_frames + target_frames;

        let tokens = self.run_steps(
            &style_ids,
            &text_ids,
            reference,
            prefix_len,
            ref_frames,
            target_frames,
            seq,
        )?;
        let audio = self.decode_codes(&tokens, target_frames)?;
        Ok(post_process(
            audio,
            OMNIVOICE_SAMPLE_RATE,
            reference.map(|r| r.ref_rms),
        ))
    }

    /// The 32-step masked-refinement loop.
    #[allow(clippy::too_many_arguments)]
    fn run_steps(
        &mut self,
        style_ids: &[u32],
        text_ids: &[u32],
        reference: Option<&ReferencePrompt>,
        prefix_len: usize,
        ref_frames: usize,
        target_frames: usize,
        seq: usize,
    ) -> OmniVoiceResult<Vec<i32>> {
        // `max_len == seq_len` is MANDATORY, not incidental. The graph's attention mask is
        // a `+1.0/+0.0` additive bonus (a bool input cast to float), so it cannot hard-mask
        // — padding beyond the real sequence would BLEED into the conditional row.
        let batch = if GUIDANCE_SCALE != 0.0 { 2 } else { 1 };

        // ── one-time tensor construction; only `input_ids` mutates across steps ──
        let mut input_ids = vec![MASK_ID; batch * CODEBOOKS * seq];
        // Row 0, style+text prefix. The graph reads text positions from `input_ids[:,0,t]`
        // ONLY, but replicating across all 8 rows matches the reference and is harmless.
        for (t, id) in style_ids.iter().chain(text_ids.iter()).enumerate() {
            for c in 0..CODEBOOKS {
                input_ids[c * seq + t] = i64::from(*id);
            }
        }
        // Row 0, reference region: raw 0..=1023 per codebook. The per-codebook offsets
        // [0,1025,...,7175] are BAKED INTO THE GRAPH as a constant — do not pre-offset.
        if let Some(r) = reference {
            for c in 0..CODEBOOKS {
                for t in 0..ref_frames {
                    input_ids[c * seq + prefix_len + t] = i64::from(r.audio_tokens[c][t]);
                }
            }
        }
        // `audio_mask` is true over reference AND target frames, false over the prefix.
        // Constant across all 32 steps.
        let mut audio_mask = vec![false; batch * seq];
        for slot in audio_mask.iter_mut().take(seq).skip(prefix_len) {
            *slot = true;
        }
        // `attention_mask` row 0 is ALL true. Constant across all 32 steps.
        let mut attn = vec![false; batch * seq * seq];
        for slot in attn.iter_mut().take(seq * seq) {
            *slot = true;
        }
        if batch == 2 {
            // Row 1 is NOT a null-text branch — it is the target block ALONE, moved to
            // position 0, with everything else deleted. Its outputs at >= target_frames
            // are never read.
            for t in 0..target_frames {
                audio_mask[seq + t] = true;
            }
            for row in 0..target_frames {
                for col in 0..target_frames {
                    attn[seq * seq + row * seq + col] = true;
                }
            }
            // Diagonal fill over the inert pad rows. Cosmetic with an additive mask (no
            // softmax row can be all -inf, so there is no NaN to avoid) — emitted for
            // fidelity with the reference.
            for pos in target_frames..seq {
                attn[seq * seq + pos * seq + pos] = true;
            }
        }

        let sched = build_schedule(target_frames * CODEBOOKS, NUM_STEP, T_SHIFT);
        let mut tokens = vec![MASK_ID as i32; CODEBOOKS * target_frames];
        let mut pred = vec![0i32; CODEBOOKS * target_frames];
        let mut scores = vec![0f32; CODEBOOKS * target_frames];
        // Target region offsets differ per row: row 0 holds it after the prefix and the
        // reference, row 1 holds it at position 0.
        let cond_off = prefix_len + ref_frames;

        for (step, take) in sched.iter().enumerate() {
            let logits = {
                let ids = tensor_i64(vec![batch, CODEBOOKS, seq], input_ids.clone())?;
                let am = tensor_bool(vec![batch, seq], audio_mask.clone())?;
                let at = tensor_bool(vec![batch, 1, seq, seq], attn.clone())?;
                let out = self
                    .step
                    .run(ort::inputs! {
                        "input_ids" => ids,
                        "audio_mask" => am,
                        "attention_mask" => at,
                    })
                    .map_err(|e| OmniVoiceError::Inference(format!("step {step}: {e}")))?;
                let (_, data) = out["logits"]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| OmniVoiceError::Inference(format!("extract logits: {e}")))?;
                data.to_vec()
            };

            let mut comb = [0f32; AUDIO_VOCAB];
            let mut uncond = [0f32; AUDIO_VOCAB];
            for c in 0..CODEBOOKS {
                for t in 0..target_frames {
                    let idx = c * target_frames + t;
                    copy_logits(&logits, &mut comb, 0, c, cond_off + t, seq);
                    log_softmax_in_place(&mut comb);
                    if batch == 2 {
                        copy_logits(&logits, &mut uncond, 1, c, t, seq);
                        log_softmax_in_place(&mut uncond);
                        // CFG in LOG-PROB space: (1+w)*log p_c - w*log p_u.
                        for v in 0..AUDIO_VOCAB {
                            comb[v] += GUIDANCE_SCALE * (comb[v] - uncond[v]);
                        }
                        // Renormalise — REQUIRED. `scores` is compared ACROSS positions,
                        // so unnormalised values would make position selection meaningless.
                        log_softmax_in_place(&mut comb);
                    }
                    // Ban the mask token AFTER renormalising.
                    comb[MASK_ID as usize] = f32::NEG_INFINITY;
                    let mut best = 0usize;
                    let mut best_v = f32::NEG_INFINITY;
                    for (v, p) in comb.iter().enumerate() {
                        if *p > best_v {
                            best_v = *p;
                            best = v;
                        }
                    }
                    // `scores` is the MAX post-CFG log-probability. With
                    // class_temperature == 0 that coincides with the log-prob of `pred`.
                    scores[idx] = best_v;
                    pred[idx] = best as i32;
                }
            }

            let chosen = self.select_positions(&tokens, &mut scores, *take, target_frames);
            for i in chosen {
                tokens[i] = pred[i];
            }
            // Write the committed codes back into BOTH rows, at their different offsets.
            write_generated(&mut input_ids, &tokens, 0, cond_off, seq, target_frames);
            if batch == 2 {
                write_generated(&mut input_ids, &tokens, 1, 0, seq, target_frames);
            }
        }

        if let Some(bad) = tokens.iter().find(|v| !(0..MASK_ID as i32).contains(v)) {
            return Err(OmniVoiceError::Inference(format!(
                "schedule left an uncommitted code {bad} — the codec decoder would crash"
            )));
        }
        Ok(tokens)
    }

    /// Gumbel-top-k position selection = sampling `k` positions WITHOUT replacement from
    /// `softmax(score / T)`. This is the ONLY stochasticity in the pipeline at defaults.
    ///
    /// SCORE-SHAPING ORDER IS LOAD-BEARING: layer penalty -> freeze filter -> divide by
    /// temperature -> add Gumbel. The `layer_penalty_factor` applies to the POSITION score
    /// only, never to token logits; it enforces coarse-to-fine residual-VQ ordering
    /// (codebook 0 unmasks first, then 1, ...). Because it lands BEFORE the
    /// `/position_temperature` division, its effective magnitude in Gumbel units is
    /// `c * 1.0` — large relative to Gumbel sigma ~1.28 but not dominant, so occasional
    /// out-of-order commits happen BY DESIGN.
    ///
    /// Only STILL-MASKED indices are considered, which both implements the "once
    /// committed, permanently frozen" rule and sidesteps the reference JS's NaN
    /// comparator (two `-Infinity` entries compare as NaN there).
    fn select_positions(
        &mut self,
        tokens: &[i32],
        scores: &mut [f32],
        take: usize,
        target_frames: usize,
    ) -> Vec<usize> {
        let mut candidates: Vec<usize> = Vec::with_capacity(tokens.len());
        for c in 0..CODEBOOKS {
            for t in 0..target_frames {
                let idx = c * target_frames + t;
                if tokens[idx] != MASK_ID as i32 {
                    continue;
                }
                scores[idx] -= c as f32 * LAYER_PENALTY_FACTOR;
                if POSITION_TEMPERATURE > 0.0 {
                    scores[idx] = scores[idx] / POSITION_TEMPERATURE + sample_gumbel(&mut self.rng);
                }
                candidates.push(idx);
            }
        }
        let k = take.min(candidates.len());
        candidates.sort_unstable_by(|a, b| {
            scores[*b]
                .partial_cmp(&scores[*a])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(k);
        candidates
    }

    /// `higgs_decoder(codes[8,1,F]) -> waveform_24k[1,1,F*960]`. CODEBOOK-MAJOR input:
    /// the demo export's own decoder takes `[1,8,T]` instead, and with `B == 1` the two
    /// are shape-compatible but TRANSPOSED, so feeding the wrong one produces garbage
    /// without erroring. One convention, pinned here.
    fn decode_codes(&mut self, tokens: &[i32], frames: usize) -> OmniVoiceResult<Vec<f32>> {
        let data: Vec<i64> = tokens.iter().map(|v| i64::from(*v)).collect();
        let t = tensor_i64(vec![CODEBOOKS, 1, frames], data)?;
        let out = self
            .decoder
            .run(ort::inputs! { "codes" => t })
            .map_err(|e| OmniVoiceError::Inference(format!("higgs_decoder: {e}")))?;
        let (_, samples) = out["waveform_24k"]
            .try_extract_tensor::<f32>()
            .map_err(|e| OmniVoiceError::Inference(format!("extract waveform: {e}")))?;
        Ok(samples.to_vec())
    }
}

// ── ORT plumbing ────────────────────────────────────────────────────────────────

fn tensor_i64(shape: Vec<usize>, data: Vec<i64>) -> OmniVoiceResult<SessionInputValue<'static>> {
    let t = Tensor::from_array((shape, data.into_boxed_slice()))
        .map_err(|e| OmniVoiceError::Inference(format!("i64 tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

fn tensor_bool(shape: Vec<usize>, data: Vec<bool>) -> OmniVoiceResult<SessionInputValue<'static>> {
    let t = Tensor::from_array((shape, data.into_boxed_slice()))
        .map_err(|e| OmniVoiceError::Inference(format!("bool tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

fn tensor_f32(shape: Vec<usize>, data: Vec<f32>) -> OmniVoiceResult<SessionInputValue<'static>> {
    let t = Tensor::from_array((shape, data.into_boxed_slice()))
        .map_err(|e| OmniVoiceError::Inference(format!("f32 tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

/// Run a one-input/one-output f32 graph, returning `(shape, data)`.
fn run_single_f32(
    sess: &mut Session,
    input: &str,
    shape: Vec<usize>,
    data: Vec<f32>,
) -> OmniVoiceResult<(Vec<usize>, Vec<f32>)> {
    let t = tensor_f32(shape, data)?;
    let name: Cow<'static, str> = Cow::Owned(input.to_string());
    let out = sess
        .run(vec![(name, t)])
        .map_err(|e| OmniVoiceError::Inference(format!("{input}: {e}")))?;
    let (s, d) = out[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| OmniVoiceError::Inference(format!("extract {input} output: {e}")))?;
    Ok((s.iter().map(|v| *v as usize).collect(), d.to_vec()))
}

/// Truncate a `[1, channels, T]` feature map to its first `keep` frames.
fn trim_last_axis(src: &(Vec<usize>, Vec<f32>), channels: usize, keep: usize) -> Vec<f32> {
    let t = *src.0.last().unwrap_or(&0);
    if t == keep {
        return src.1.clone();
    }
    let mut out = Vec::with_capacity(channels * keep);
    for c in 0..channels {
        let base = c * t;
        out.extend_from_slice(&src.1[base..base + keep]);
    }
    out
}

/// Copy one `[b, c, t, :]` logits row out of the flat `[B, 8, L, 1025]` output.
fn copy_logits(
    logits: &[f32],
    dst: &mut [f32; AUDIO_VOCAB],
    b: usize,
    c: usize,
    t: usize,
    seq: usize,
) {
    let off = ((b * CODEBOOKS + c) * seq + t) * AUDIO_VOCAB;
    dst.copy_from_slice(&logits[off..off + AUDIO_VOCAB]);
}

/// Write the codebook-major `tokens` buffer into batch row `b`'s target region.
fn write_generated(
    ids: &mut [i64],
    tokens: &[i32],
    b: usize,
    start: usize,
    seq: usize,
    frames: usize,
) {
    for c in 0..CODEBOOKS {
        for t in 0..frames {
            ids[(b * CODEBOOKS + c) * seq + start + t] = i64::from(tokens[c * frames + t]);
        }
    }
}

// ── audio helpers ───────────────────────────────────────────────────────────────

/// Band-limited 24 kHz -> 16 kHz downsample (windowed sinc, cutoff at the 8 kHz output
/// Nyquist). Linear interpolation would alias everything above 8 kHz back into the band,
/// and the RVQ stage downstream is a Euclidean argmin — a HARD decision boundary — so
/// aliasing there flips individual codes rather than degrading gracefully.
fn resample_to_16k(src: &[f32]) -> Vec<f32> {
    let ratio = f64::from(SEMANTIC_SAMPLE_RATE) / f64::from(OMNIVOICE_SAMPLE_RATE);
    if src.is_empty() {
        return Vec::new();
    }
    let out_len = ((src.len() as f64) * ratio).round() as usize;
    // Half-width in INPUT samples; the sinc is stretched by 1/ratio because we are
    // decimating (cutoff must sit at the OUTPUT Nyquist, not the input's).
    const LOBES: f64 = 8.0;
    let scale = ratio.min(1.0);
    let half = (LOBES / scale).ceil() as isize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let center = i as f64 / ratio;
        let base = center.floor() as isize;
        let mut acc = 0f64;
        let mut norm = 0f64;
        for k in (base - half)..=(base + half) {
            if k < 0 || k as usize >= src.len() {
                continue;
            }
            let dist = (k as f64 - center) * scale;
            let w = sinc(dist) * blackman(dist / LOBES);
            acc += f64::from(src[k as usize]) * w;
            norm += w;
        }
        out.push(if norm.abs() > 1e-12 {
            (acc / norm) as f32
        } else {
            0.0
        });
    }
    out
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// Blackman window over `t in [-1, 1]`; zero outside.
fn blackman(t: f64) -> f64 {
    if t.abs() > 1.0 {
        return 0.0;
    }
    let a = std::f64::consts::PI * (t + 1.0);
    0.42 - 0.5 * a.cos() + 0.08 * (2.0 * a).cos()
}

/// Per-sample loud/quiet bitmap against a -50 dBFS absolute threshold — no windowing,
/// no RMS, matching the reference.
fn loud_map(audio: &[f32]) -> Vec<bool> {
    audio.iter().map(|s| s.abs() > SILENCE_THRESHOLD).collect()
}

/// Reference-side silence removal — upstream `remove_silence(mid_sil=200 ms,
/// lead_sil=100 ms, trail_sil=200 ms)`, i.e. pydub
/// `split_on_silence(min_silence_len=mid_sil, keep_silence=mid_sil)` followed by
/// `remove_silence_edges(lead_sil, trail_sil)`.
///
/// Two things here were MEASURED against the demo's published golden reference
/// (`manh_dung_natural_warm_vi`, 12.52 s -> 313 frames), not reasoned:
///   * the edge margins are ASYMMETRIC — 100 ms leading, 200 ms trailing. Using 100 ms on
///     both ends yields 310 frames.
///   * the interior cap is `2 * mid_sil`, not `mid_sil`: pydub's `keep_silence` retains
///     that much padding on EACH side of a split, so a gap between two kept segments keeps
///     up to 400 ms, and a gap shorter than `min_silence_len` is never split and survives
///     whole. Both collapse to `min(run, 2 * mid_sil)`. Capping at 200 ms yields 293.
///
/// Together they reproduce the golden 313 frames exactly.
fn remove_silence(audio: &[f32], sr: u32) -> Vec<f32> {
    const MID_SIL_SEC: f64 = 0.2;
    trim_and_cap_silence(audio, sr, 0.1, 0.2, 2.0 * MID_SIL_SEC)
}

/// Output-side variant — the demo runtime's `removeLongSilence`: symmetric 100 ms edge
/// margins and a 500 ms interior cap, applied per-sample. A different function with a
/// different source from the reference-side one above; do not merge their constants.
fn remove_long_silence(audio: &[f32], sr: u32) -> Vec<f32> {
    trim_and_cap_silence(audio, sr, 0.1, 0.1, 0.5)
}

fn trim_and_cap_silence(
    audio: &[f32],
    sr: u32,
    lead_sec: f64,
    trail_sec: f64,
    max_mid_sec: f64,
) -> Vec<f32> {
    if audio.is_empty() {
        return Vec::new();
    }
    let lead = (lead_sec * f64::from(sr)).round() as usize;
    let trail = (trail_sec * f64::from(sr)).round() as usize;
    let max_mid = (max_mid_sec * f64::from(sr)).round() as usize;
    let loud = loud_map(audio);
    let Some(first) = loud.iter().position(|v| *v) else {
        // No sample is loud anywhere — return the input untouched rather than nothing.
        return audio.to_vec();
    };
    let last = loud.iter().rposition(|v| *v).unwrap_or(first);
    let start = first.saturating_sub(lead);
    let end = (last + trail + 1).min(audio.len());

    let mut out: Vec<f32> = Vec::with_capacity(end - start);
    let mut i = start;
    while i < end {
        let run_start = i;
        let is_loud = loud[i];
        while i < end && loud[i] == is_loud {
            i += 1;
        }
        let run = &audio[run_start..i];
        if is_loud {
            out.extend_from_slice(run);
        } else {
            // Interior quiet runs are truncated; the leading/trailing ones were already
            // bounded by the `keep` margin above.
            out.extend_from_slice(&run[..run.len().min(max_mid)]);
        }
    }
    if out.is_empty() { audio.to_vec() } else { out }
}

fn normalize_peak(audio: &mut [f32], target: f32) {
    let peak = audio.iter().fold(0f32, |m, s| m.max(s.abs()));
    if peak < 1e-6 {
        return;
    }
    let g = target / peak;
    for s in audio.iter_mut() {
        *s *= g;
    }
}

/// Prepend/append `pad` zeros and apply a linear fade in/out over `fade` samples.
fn fade_and_pad(audio: Vec<f32>, sr: u32, pad_sec: f64, fade_sec: f64) -> Vec<f32> {
    let pad = (pad_sec * f64::from(sr)).round() as usize;
    let fade = (fade_sec * f64::from(sr)).round() as usize;
    let len = audio.len();
    let mut out = vec![0f32; len + 2 * pad];
    out[pad..pad + len].copy_from_slice(&audio);
    // `k <= 1` means the factor is 1 everywhere, i.e. no fade at all.
    let k = fade.min(len / 2);
    if k > 1 {
        for i in 0..k {
            // Ramps 0 -> 1 across the first `k` samples and, mirrored, 1 -> 0 across the
            // last `k`. Both loops index `i` outward from their own edge, so the tail is
            // the exact reverse of the head.
            let f = i as f32 / (k - 1) as f32;
            out[pad + i] *= f;
            out[pad + len - 1 - i] *= f;
        }
    }
    out
}

/// The reference aliases buffers here (`remove_long_silence` may return its input, after
/// which the gain loops mutate the decoder output in place). We own the buffer instead.
///
/// The `ref_rms >= 0.1` no-op is NOT a bug: the reference waveform was normalised to RMS
/// 0.1 only when its rms was BELOW 0.1, so a clip already at >= 0.1 was fed unscaled and
/// the output must not be un-scaled. The two branches are exact mirrors.
fn post_process(audio: Vec<f32>, sr: u32, ref_rms: Option<f64>) -> Vec<f32> {
    let mut audio = remove_long_silence(&audio, sr);
    match ref_rms {
        Some(r) if r > 0.0 && r < REF_RMS_TARGET => {
            let g = (r / REF_RMS_TARGET) as f32;
            for s in &mut audio {
                *s *= g;
            }
        }
        Some(_) => {}
        None => normalize_peak(&mut audio, 0.5),
    }
    fade_and_pad(audio, sr, PAD_DURATION_SEC, FADE_DURATION_SEC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_text_deletes_newlines_and_collapses_tabs() {
        assert_eq!(combine_text(None, "a\nb"), "ab");
        assert_eq!(combine_text(None, "a \t b"), "a b");
        assert_eq!(combine_text(None, "（hi）"), "(hi)");
    }

    #[test]
    fn combine_text_drops_whitespace_adjacent_to_cjk() {
        assert_eq!(combine_text(None, "中文 English"), "中文English");
        assert_eq!(combine_text(None, "English 中文"), "English中文");
        // Non-CJK neighbours keep their single space.
        assert_eq!(combine_text(None, "one two"), "one two");
    }

    #[test]
    fn combine_text_prepends_reference_with_one_space() {
        assert_eq!(combine_text(Some(" ref "), " text "), "ref text");
        assert_eq!(combine_text(Some("   "), "text"), "text");
    }

    #[test]
    fn style_span_gates_denoise_on_reference_and_uses_none_sentinel() {
        assert_eq!(
            build_style(false, "en-us", None),
            "<|lang_start|>en<|lang_end|><|instruct_start|>None<|instruct_end|>"
        );
        assert_eq!(
            build_style(true, "en-us", None),
            "<|denoise|><|lang_start|>en<|lang_end|><|instruct_start|>None<|instruct_end|>"
        );
        // Unmapped languages degrade to the literal sentinel, never an empty span.
        assert!(build_style(false, "sw", None).contains("<|lang_start|>None<|lang_end|>"));
    }

    #[test]
    fn language_map_is_omnivoice_ids_not_iso_639_3() {
        assert_eq!(omnivoice_lang("en-us"), "en");
        assert_eq!(omnivoice_lang("en-gb"), "en");
        assert_eq!(omnivoice_lang("cmn"), "zh");
        assert_eq!(omnivoice_lang("pt-br"), "pt");
        assert_eq!(omnivoice_lang("klingon"), "None");
    }

    #[test]
    fn nonverbal_spans_match_only_the_thirteen_tags() {
        let spans = nonverbal_spans("a [laughter] b [nope] c [sigh]");
        assert_eq!(spans.len(), 2);
        assert_eq!(
            &"a [laughter] b [nope] c [sigh]"[spans[0].0..spans[0].1],
            "[laughter]"
        );
        assert_eq!(
            &"a [laughter] b [nope] c [sigh]"[spans[1].0..spans[1].1],
            "[sigh]"
        );
        // Case-sensitive and whitespace-intolerant.
        assert!(nonverbal_spans("[Laughter] [ sigh ]").is_empty());
    }

    #[test]
    fn schedule_sums_to_total_and_is_back_loaded() {
        for frames in [25usize, 81, 200] {
            let total = frames * CODEBOOKS;
            let sched = build_schedule(total, NUM_STEP, T_SHIFT);
            assert_eq!(sched.len(), NUM_STEP);
            assert_eq!(sched.iter().sum::<usize>(), total, "frames={frames}");
            // Every non-final step commits at least one token (the `ceil`).
            assert!(sched[..NUM_STEP - 1].iter().all(|n| *n >= 1));
            // The final step carries the largest share by a wide margin.
            let last = sched[NUM_STEP - 1];
            assert!(
                last > total / 4,
                "frames={frames} last={last} total={total}"
            );
        }
    }

    #[test]
    fn schedule_matches_the_reference_three_second_vector() {
        // 3 s -> 81 frames -> 648 tokens; the reference runtime produces exactly this.
        let sched = build_schedule(648, NUM_STEP, T_SHIFT);
        assert_eq!(
            sched,
            vec![
                3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6, 6, 7, 8, 9, 9, 11, 12, 14, 16, 18, 22,
                26, 32, 40, 52, 70, 238
            ]
        );
    }

    #[test]
    fn frames_for_adds_the_tail_buffer() {
        assert_eq!(frames_for(3.0), 81); // (3.00 + 0.25) * 25
        assert_eq!(frames_for(0.0), 6);
        assert_eq!(frames_for(-5.0), 1); // clamped, never zero
    }

    #[test]
    fn log_softmax_normalises() {
        let mut v = [1.0f32, 2.0, 3.0];
        log_softmax_in_place(&mut v);
        let sum: f32 = v.iter().map(|x| x.exp()).sum();
        assert!((sum - 1.0).abs() < 1e-5, "sum={sum}");
    }

    #[test]
    fn resample_24k_to_16k_preserves_length_ratio_and_dc() {
        let src = vec![0.5f32; 4800]; // 200 ms @ 24 kHz
        let out = resample_to_16k(&src);
        assert_eq!(out.len(), 3200);
        // A constant signal must survive a normalised windowed-sinc unchanged.
        let mid = out[out.len() / 2];
        assert!((mid - 0.5).abs() < 1e-3, "mid={mid}");
    }

    #[test]
    fn fade_and_pad_zero_pads_and_ramps_the_edges() {
        let audio = vec![1.0f32; 4800];
        let out = fade_and_pad(audio, 24_000, 0.1, 0.1);
        assert_eq!(out.len(), 4800 + 4800); // 2400 pad each side
        assert_eq!(out[0], 0.0);
        assert_eq!(*out.last().unwrap(), 0.0);
        // First real sample sits at the start of the fade -> silent.
        assert_eq!(out[2400], 0.0);
        assert_eq!(out[out.len() - 2401], 0.0);
        // The middle is untouched.
        assert!((out[4800] - 1.0).abs() < 1e-6);
    }

    /// The reference-side edge margins are ASYMMETRIC (100 ms lead, 200 ms trail) and the
    /// interior cap is 400 ms. All three were derived by matching the demo's published
    /// golden reference frame count (313); 100/100/200 gives 293 and 100/100/400 gives 310.
    /// Pinned here because the golden mp3 is not in-tree, so nothing else would catch a
    /// silent regression of these constants.
    #[test]
    fn reference_silence_removal_keeps_more_tail_than_head() {
        let sr = 24_000u32;
        // 0.5 s of silence, 0.1 s of tone, 0.5 s of silence.
        let mut audio = vec![0.0f32; 12_000];
        audio.extend(std::iter::repeat_n(0.5f32, 2_400));
        audio.extend(std::iter::repeat_n(0.0f32, 12_000));
        let out = remove_silence(&audio, sr);
        // lead 2400 + tone 2400 + trail 4800 (the inclusive `last` is already counted).
        assert_eq!(out.len(), 2_400 + 2_400 + 4_800);

        // The output-side variant keeps symmetric 100 ms margins instead.
        let out2 = remove_long_silence(&audio, sr);
        assert_eq!(out2.len(), 2_400 + 2_400 + 2_400);
    }

    /// A 300 ms interior gap must survive WHOLE: pydub's `keep_silence` retains 200 ms on
    /// each side of a split, so the binding cap is 400 ms, not 200 ms.
    #[test]
    fn reference_silence_removal_preserves_a_300ms_interior_gap() {
        let sr = 24_000u32;
        let mut audio = vec![0.5f32; 2_400];
        audio.extend(std::iter::repeat_n(0.0f32, 7_200)); // 300 ms
        audio.extend(std::iter::repeat_n(0.5f32, 2_400));
        let out = remove_silence(&audio, sr);
        assert_eq!(out.len(), audio.len(), "300 ms gap must not be truncated");
        // A 600 ms gap IS capped, at 400 ms.
        let mut long_gap = vec![0.5f32; 2_400];
        long_gap.extend(std::iter::repeat_n(0.0f32, 14_400)); // 600 ms
        long_gap.extend(std::iter::repeat_n(0.5f32, 2_400));
        assert_eq!(remove_silence(&long_gap, sr).len(), 2_400 + 9_600 + 2_400);
    }

    #[test]
    fn silence_removal_returns_input_when_everything_is_quiet() {
        let quiet = vec![0.0f32; 1000];
        assert_eq!(remove_silence(&quiet, 24_000).len(), 1000);
    }

    #[test]
    fn silence_removal_caps_interior_gaps() {
        let sr = 24_000u32;
        let mut audio = vec![0.5f32; 2400];
        audio.extend(std::iter::repeat_n(0.0f32, sr as usize)); // 1 s of silence
        audio.extend(std::iter::repeat_n(0.5f32, 2400));
        let out = remove_long_silence(&audio, sr);
        // 0.5 s interior cap: 2400 + 12000 + 2400.
        assert_eq!(out.len(), 2400 + 12_000 + 2400);
    }

    #[test]
    fn post_process_no_reference_normalises_peak() {
        let audio = vec![0.2f32; 4800];
        let out = post_process(audio, 24_000, None);
        let peak = out.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((peak - 0.5).abs() < 1e-3, "peak={peak}");
    }

    #[test]
    fn post_process_quiet_reference_reapplies_the_original_gain() {
        // A reference at rms 0.05 was scaled UP by 2x on the way in, so the output is
        // scaled back DOWN by 0.5. A reference already at >= 0.1 is left alone.
        let audio = vec![0.4f32; 4800];
        let quiet = post_process(audio.clone(), 24_000, Some(0.05));
        let loud = post_process(audio, 24_000, Some(0.2));
        let mid_q = quiet[quiet.len() / 2];
        let mid_l = loud[loud.len() / 2];
        assert!((mid_q - 0.2).abs() < 1e-3, "mid_q={mid_q}");
        assert!((mid_l - 0.4).abs() < 1e-3, "mid_l={mid_l}");
    }

    #[test]
    fn reference_prompt_validation_rejects_bad_shapes_and_codes() {
        let ok = ReferencePrompt {
            schema_version: 1,
            ref_text: "hi".into(),
            sample_rate: OMNIVOICE_SAMPLE_RATE,
            frame_rate: OMNIVOICE_FRAME_RATE,
            codebooks: CODEBOOKS,
            frames: 2,
            duration_sec: 0.08,
            ref_rms: 0.1,
            audio_tokens: vec![vec![1i16, 2]; CODEBOOKS],
        };
        assert!(ok.validate().is_ok());

        let mut ragged = ok.clone();
        ragged.audio_tokens[3] = vec![1];
        assert!(ragged.validate().is_err());

        let mut masked = ok.clone();
        masked.audio_tokens[0] = vec![MASK_ID as i16, 2];
        assert!(masked.validate().is_err());

        let mut short = ok;
        short.audio_tokens.truncate(4);
        assert!(short.validate().is_err());
    }

    #[test]
    fn write_generated_places_rows_at_their_offsets() {
        let (seq, frames) = (10usize, 2usize);
        let mut ids = vec![MASK_ID; 2 * CODEBOOKS * seq];
        let tokens: Vec<i32> = (0..(CODEBOOKS * frames) as i32).collect();
        write_generated(&mut ids, &tokens, 0, 5, seq, frames);
        write_generated(&mut ids, &tokens, 1, 0, seq, frames);
        // Row 0 codebook 2, frame 1 -> flat ((0*8+2)*10 + 5 + 1).
        assert_eq!(ids[2 * seq + 6], i64::from(tokens[2 * frames + 1]));
        // Row 1 puts the same code at offset 0.
        assert_eq!(
            ids[(CODEBOOKS + 2) * seq + 1],
            i64::from(tokens[2 * frames + 1])
        );
    }

    #[test]
    fn estimate_duration_uses_the_reference_speaking_rate() {
        let text = "one two three four five six";
        let bare = estimate_duration(text, None);
        // A reference speaking 4 words in 8 s (0.5 wps) must stretch the estimate.
        let slow = ReferencePrompt {
            schema_version: 1,
            ref_text: "a b c d".into(),
            sample_rate: OMNIVOICE_SAMPLE_RATE,
            frame_rate: OMNIVOICE_FRAME_RATE,
            codebooks: CODEBOOKS,
            frames: 200,
            duration_sec: 8.0,
            ref_rms: 0.1,
            audio_tokens: vec![vec![0i16; 200]; CODEBOOKS],
        };
        assert!(estimate_duration(text, Some(&slow)) > bare);
    }
}
