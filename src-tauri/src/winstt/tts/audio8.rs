// Audio8 TTS Preview 0.6B — faithful Rust port of the official ONNX runtime
// (github.com/Audio8-AI/Audio8_TTS `onnx_runtime/arktts_runtime/{runtime,prompt,registration}.py`,
// weights `Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4`, Apache-2.0).
//
// DualAR architecture (Fish-Audio-S2-style): a 24-layer SLOW transformer predicts one
// semantic token per audio frame; a 4-layer FAST transformer then predicts the frame's
// remaining 9 codec codebooks conditioned on the slow hidden state; an fp16 neural codec
// decodes the 10-codebook frames to 44.1 kHz mono (2048 samples per frame, ~21.5 fps).
//
// Cloning is ZERO-SHOT-WITH-TRANSCRIPT: the reference clip is encoded ONCE by a separate
// 414 MB fp16 codec ENCODER (`registration/codec_encoder_fp16.onnx`) into `[10, T]` codes
// that are spliced into EVERY sentence's prompt next to the reference transcript — so the
// encode result is cached in memory + on disk exactly like OmniVoice's `ReferencePrompt`
// (re-encoding per sentence would reload 414 MB per sentence). The encoder session itself
// is loaded on demand and dropped as soon as the codes exist.
//
// KV caches are the torch-static-cache shape: full `[1, 2, 2048, 64]` fp16 buffers held
// HOST-side, fed as owned tensors each step; the graph returns per-position deltas
// (`outputs[2..]`) that this port writes back at `input_pos` — upstream's
// `_update_caches`. Positions are always one contiguous run (prefill `0..L`, then single
// steps), which the writeback exploits.
//
// CPU-pinned: upstream ships a CPUExecutionProvider-only runtime ("no CUDA requirement");
// fp16 KV + int4 MatMul on DML is unvalidated territory (see the per-engine DML matrix).
// The two INT4 AR sessions load through [`audio8_ar_session`], which prefers a locally
// derived `accuracy_level=1` copy of each graph so WEIGHT PREPACKING can stay ON; the
// shipped `accuracy_level=4` graph trips a pyke-build MLAS bug and is only ever opened
// with prepacking disabled, as the fallback. See [`ensure_accuracy_level_1_graph`].

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use half::f16;
use ndarray::{Array1, Array3, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::{Tensor, TensorRef};
use tokenizers::Tokenizer;

use super::provider::{cpu_session, cpu_session_with_intra_threads};
use super::sampling::{SplitMix64Rng, sample_categorical, softmax};
use crate::winstt::stt::{Accelerator, configure_session};

/// CPU session for the two INT4 AR graphs, with weight PREPACKING DISABLED.
///
/// NOT an optimization preference — a correctness pin, and NOT version-transient:
/// pyke's static ORT builds mis-prepack this export's `MatMulNBits` int4 weights on
/// BOTH 1.24.2 (ort rc.12) and 1.28.0 (rc.13) — with prepacking on, the prefill
/// logits come out compressed and wrong (argmax 4010 / max 13.75 where the official
/// MS wheels give argmax 1278 / max 25.2 on byte-identical feeds) and the model
/// babbles a ~200 Hz hum to the 1024-frame cap, never emitting eos. Verified twice
/// per runtime on idle hardware; the official 1.24.2/1.24.4/1.26 wheels prepack the
/// same graph correctly, so the defect is specific to the pyke build's MLAS. With
/// `session.disable_prepacking=1` the logits match the reference runtime within fp16
/// noise and the STT round-trip is exact. Memory:
/// `project_audio8_tts_engine_and_ort_prepack_bug`.
fn audio8_int4_session(path: &Path) -> Result<Session, String> {
    let mut builder = configure_session(
        ort::session::builder::GraphOptimizationLevel::Level3,
        Some(intra_op_threads()),
        false,
        Some(&[Accelerator::Cpu]),
    )?;
    builder = builder
        .with_config_entry("session.disable_prepacking", "1")
        .map_err(|e| format!("disable_prepacking: {e}"))?;
    builder
        .commit_from_file(path)
        .map_err(|err| format!("commit_from_file {}: {err}", path.display()))
}

/// The same graph with PREPACKING ON — only ever handed an `accuracy_level=1` copy.
///
/// See [`ensure_accuracy_level_1_graph`] for why that combination is safe where
/// the shipped `accuracy_level=4` graph is not.
fn audio8_int4_session_prepacked(path: &Path) -> Result<Session, String> {
    configure_session(
        ort::session::builder::GraphOptimizationLevel::Level3,
        Some(intra_op_threads()),
        false,
        Some(&[Accelerator::Cpu]),
    )?
    .commit_from_file(path)
    .map_err(|err| format!("commit_from_file {}: {err}", path.display()))
}

/// Open one of the two INT4 AR graphs, preferring the fast path.
///
/// The shipped export sets `MatMulNBits.accuracy_level = 4`, which routes MLAS
/// through its `SQNBIT_CompInt8` prepack — the exact routine pyke's static ORT
/// build corrupts (see [`audio8_int4_session`]). Rewriting the attribute to `1`
/// selects `SQNBIT_CompFp32`, a DIFFERENT pack routine, so prepacking can be
/// turned back on. Measured on the official ORT wheel, fast_ar, 8 threads:
///
/// ```text
///   acc4 + no prepack (what we shipped)  213.48 ms   maxabs_err 0.0000 (reference)
///   acc4 + prepack                         5.47 ms   maxabs_err 1.0781
///   acc1 + prepack                        19.75 ms   maxabs_err 0.0312   <- 10.8x
/// ```
///
/// So acc1 costs ~3.6x the acc4 kernel but is 10.8x faster than shipping
/// unpacked, and it is markedly CLOSER to the reference than acc4-prepacked —
/// this trades no quality for the speed, it improves both.
///
/// Falls back to the shipped graph with prepacking disabled whenever anything is
/// off (patch failed, attribute count unexpected, session refused to open), so
/// the worst case is today's behavior rather than a hum. `WINSTT_AUDIO8_NO_PREPACK=1`
/// forces that fallback.
fn audio8_ar_session(path: &Path) -> Result<Session, String> {
    if std::env::var_os("WINSTT_AUDIO8_NO_PREPACK").is_some() {
        log::info!("[tts] audio8: prepacking disabled by WINSTT_AUDIO8_NO_PREPACK");
        return audio8_int4_session(path);
    }
    let fast_path = ensure_accuracy_level_1_graph(path)
        .and_then(|patched| {
            let session = audio8_int4_session_prepacked(&patched)?;
            log::debug!("[tts] audio8: prepacked acc1 graph {}", patched.display());
            Ok(session)
        })
        .inspect_err(|err| {
            log::warn!(
                "[tts] audio8: no prepacked acc1 graph for {} ({err}) — falling back to the \
                 shipped graph with prepacking disabled",
                path.display()
            );
        });
    match fast_path {
        Ok(session) => Ok(session),
        Err(_) => audio8_int4_session(path),
    }
}

/// `MatMulNBits.accuracy_level`, as this export serializes it — a fixed 23-byte run:
///
/// ```text
///   2a 15 0a 0e "accuracy_level" 18 <v> a0 01 02
///   |  |  |  |  |                |  |   |
///   |  |  |  |  |                |  |   +-- field 20 (type) = 2 (INT)
///   |  |  |  |  |                |  +------ the value varint
///   |  |  |  |  |                +--------- field 3 (i), varint
///   |  |  +--+--+------------------------- field 1 (name), length 14
///   |  +---------------------------------- AttributeProto, length 0x15 = 21
///   +------------------------------------- NodeProto field 5 (attribute)
/// ```
///
/// `ACC_NAME_THROUGH_I` is everything up to (not including) the value byte, and
/// `ACC_TYPE_TAG` is what must follow it.
const ACC_NAME_THROUGH_I: &[u8] = b"\x0a\x0eaccuracy_level\x18";
const ACC_TYPE_TAG: &[u8] = &[0xA0, 0x01, 0x02];

/// Node counts in the shipped export, so a graph that is not the one this port
/// pins refuses the patch instead of being silently half-rewritten.
const ACC_NODES_SLOW: usize = 121;
const ACC_NODES_FAST: usize = 21;

/// Rewrite every `accuracy_level` attribute in place, returning how many changed.
///
/// Length-preserving by construction: `1` and `4` are both single-byte varints,
/// so every enclosing protobuf length stays valid and the file needs no
/// reserialization — which also means the multi-hundred-MB external `.data`
/// sidecar is never read, rewritten, or even opened.
///
/// A match is only accepted when the value is a single-byte varint AND the INT
/// type tag follows it, so the literal string appearing anywhere else in the
/// file (a tensor name, say) cannot be mistaken for the attribute.
fn patch_accuracy_level(buf: &mut [u8], want: u8) -> usize {
    debug_assert!(want < 0x80, "value must stay a single-byte varint");
    let mut hits = 0;
    let mut at = 0;
    while let Some(found) = find_bytes(&buf[at..], ACC_NAME_THROUGH_I) {
        let value = at + found + ACC_NAME_THROUGH_I.len();
        let tail = value + 1;
        if buf.get(value).is_some_and(|v| *v < 0x80)
            && buf.get(tail..tail + ACC_TYPE_TAG.len()) == Some(ACC_TYPE_TAG)
        {
            buf[value] = want;
            hits += 1;
        }
        at = value;
    }
    hits
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Path of the derived `accuracy_level=1` graph for `original`, creating it if absent.
///
/// The copy lands NEXT TO the original (`slow_ar_int4.onnx` → `slow_ar_int4.acc1.onnx`)
/// because ONNX external-data references are resolved relative to the graph file:
/// keeping it in the same directory is what lets the ~290 MB `slow_ar_int4.onnx.data`
/// be shared rather than duplicated.
///
/// Written via a temp file + rename so a crash mid-write cannot leave a truncated
/// graph that would load as garbage — the same failure mode
/// [`crate::winstt::managers::tts_download_manager`] guards downloads against.
fn ensure_accuracy_level_1_graph(original: &Path) -> Result<PathBuf, String> {
    let stem = original
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("no file stem: {}", original.display()))?;
    let expected = match stem {
        "slow_ar_int4" => ACC_NODES_SLOW,
        "fast_ar_int4" => ACC_NODES_FAST,
        other => return Err(format!("unknown AR graph {other}")),
    };
    let derived = original.with_file_name(format!("{stem}.acc1.onnx"));
    let shipped_len = std::fs::metadata(original)
        .map_err(|e| format!("stat {}: {e}", original.display()))?
        .len();
    // A previously derived graph is reused only if it is byte-for-byte the same
    // SIZE as the shipped one — the patch cannot change the length, so anything
    // else is a truncated or stale file and gets rebuilt.
    if std::fs::metadata(&derived).is_ok_and(|m| m.len() == shipped_len) {
        return Ok(derived);
    }
    let mut buf =
        std::fs::read(original).map_err(|e| format!("read {}: {e}", original.display()))?;
    let hits = patch_accuracy_level(&mut buf, 1);
    if hits != expected {
        return Err(format!(
            "{stem}: patched {hits} accuracy_level attributes, expected {expected} — \
             this is not the export this port pins"
        ));
    }
    let tmp = derived.with_extension("onnx.tmp");
    std::fs::write(&tmp, &buf).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &derived).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", derived.display())
    })?;
    log::info!(
        "[tts] audio8: derived {} ({hits} MatMulNBits nodes at accuracy_level=1)",
        derived.display()
    );
    Ok(derived)
}

/// Intra-op threads for the AR graphs and the codec decoder.
///
/// Left unset, ORT spawns one thread per LOGICAL core (24 here) and every node
/// becomes a 24-way fork/join that waits on an E-core straggler. Upstream caps at
/// 5 (`ARKTTS_THREADS`, `onnx_runtime/arktts_runtime/cli.py`); we were the only
/// side not capping at all.
///
/// Measured on THESE graphs, i9-12900KF, official ORT 1.26 CPU EP, ms per `Run`:
///
/// ```text
///                       threads:  default    5      8     10     16
///   slow_ar, unpacked (today)     1527.6   561.9    —   329.1     —
///   slow_ar, prepacked             142.1     —    16.3   15.1   31.0
///   fast_ar, prepacked               2.46    —     1.41    —      —
///   codec decoder (6.5 s audio)  11453.0     —   3144.0    —      —
/// ```
///
/// 8 is the compromise: near-optimal for the slow AR in BOTH regimes (it is the
/// graph that dominates), optimal for the fast AR once prepacking is restored,
/// and 3.6x on the decoder, which becomes the bottleneck the moment the AR is
/// fixed. Today's unpacked fast AR actually prefers ORT's default (45.7 ms vs
/// 77.5 at 8) because its per-Run dequant is memory-bound and extra threads only
/// contend — that inversion disappears with prepacking, so it is not worth a
/// second constant.
///
/// Thread count cannot change the numbers: MLAS partitions a GEMM by N, not by K,
/// so accumulation order is untouched. The repo verified byte-identical STT
/// transcripts across counts when it tuned the same knob.
const INTRA_OP_THREADS: usize = 8;

/// [`INTRA_OP_THREADS`], overridable via `WINSTT_TTS_INTRA_THREADS` so
/// `tts_engine_bench` can sweep the count without a rebuild — the same knob
/// NeuTTS exposes. Clamped to the machine's parallelism so a 2-core box does not
/// over-subscribe.
fn intra_op_threads() -> usize {
    let cores = std::thread::available_parallelism().map_or(4, std::num::NonZeroUsize::get);
    std::env::var("WINSTT_TTS_INTRA_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(INTRA_OP_THREADS)
        .min(cores)
}

pub const AUDIO8_SAMPLE_RATE: u32 = 44_100;

// runtime_manifest.json (model_fingerprint 62dcff0a…) — inlined because this engine pins
// exactly one export; a future second precision would re-read these from the manifest.
const NUM_LAYERS: usize = 24;
const NUM_FAST_LAYERS: usize = 4;
const NUM_CODEBOOKS: usize = 10;
const N_LOCAL_HEADS: usize = 2;
const HEAD_DIM: usize = 64;
const MAX_SEQ_LEN: usize = 2048;
const CODEBOOK_SIZE: usize = 4096;
const SEMANTIC_BEGIN_ID: i64 = 151_678;
const IM_END_ID: i64 = 151_645;
/// `slow_logits_layout: semantic_then_eos` — the slow head emits 4096 semantic logits
/// then ONE eos logit (4097 total), already gathered; no full-vocab indexing needed.
const SLOW_LOGITS_SIZE: usize = CODEBOOK_SIZE + 1;
/// Codec frame hop at 44.1 kHz (2048 samples ≈ 46.4 ms per frame).
const CODEC_FRAME_SIZE: usize = 2048;

// Upstream `iter_codes` defaults; per-sentence synthesis never needs more than
// `max_seq_len - prompt_len` anyway (re-clamped below).
const MAX_NEW_TOKENS: usize = 1024;
const TEMPERATURE: f64 = 0.7;
const TOP_P: f64 = 0.9;
const TOP_K: usize = 50;
/// Fixed seed (upstream CLI default) — a reproducible voice beats a novel one per run.
const RNG_SEED: u64 = 42;
/// The slow sampler's repetition window: a semantic token equal to one of the last 10
/// is resampled at the "high" settings (temperature 1.0), upstream `previous[-10:]`.
const REPETITION_WINDOW: usize = 10;

#[derive(Debug)]
pub enum Audio8Error {
    Session(String),
    Inference(String),
    Tokenizer(String),
    Reference(String),
}

impl std::fmt::Display for Audio8Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Audio8Error::Session(m) => write!(f, "audio8 session: {m}"),
            Audio8Error::Inference(m) => write!(f, "audio8 inference: {m}"),
            Audio8Error::Tokenizer(m) => write!(f, "audio8 tokenizer: {m}"),
            Audio8Error::Reference(m) => write!(f, "audio8 reference: {m}"),
        }
    }
}

impl std::error::Error for Audio8Error {}

type Audio8Result<T> = Result<T, Audio8Error>;

// ── reference (cloned voice) ────────────────────────────────────────────────────

/// A reference clip reduced to codec codes + its transcript — everything the prompt
/// builder needs, cached in memory and as JSON on disk (same lifecycle as OmniVoice's
/// `ReferencePrompt`; schema is ours, upstream stores `codes.npy` + `meta.json`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Audio8Reference {
    pub schema_version: u32,
    pub ref_text: String,
    pub frames: usize,
    /// `[10][frames]`, CODEBOOK-MAJOR, values `0..4096`.
    pub codes: Vec<Vec<u16>>,
}

impl Audio8Reference {
    fn validate(&self) -> Audio8Result<()> {
        if self.codes.len() != NUM_CODEBOOKS {
            return Err(Audio8Error::Reference(format!(
                "expected {NUM_CODEBOOKS} codebooks, got {}",
                self.codes.len()
            )));
        }
        if self.frames == 0 {
            return Err(Audio8Error::Reference("zero reference frames".into()));
        }
        for (c, row) in self.codes.iter().enumerate() {
            if row.len() != self.frames {
                return Err(Audio8Error::Reference(format!(
                    "codebook {c} has {} frames, expected {}",
                    row.len(),
                    self.frames
                )));
            }
            if let Some(bad) = row.iter().find(|v| **v >= CODEBOOK_SIZE as u16) {
                return Err(Audio8Error::Reference(format!(
                    "codebook {c} carries out-of-range code {bad}"
                )));
            }
        }
        Ok(())
    }
}

/// Identifies a cached reference so an edited clip or transcript re-encodes.
/// Same fields + FNV-1a filename scheme as OmniVoice's `RefCacheKey`.
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

// ── prompt builder ──────────────────────────────────────────────────────────────

/// Collapse all whitespace runs to single spaces (upstream `clean_text`).
fn clean_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Prepend the `<|speaker:0|>` tag unless the transcript already carries one
/// (upstream `format_reference_text`; the substring probe stands in for its
/// `<\|speaker:\d+\|>` regex — user transcripts never contain the literal).
fn format_reference_text(text: &str) -> String {
    let cleaned = clean_text(text);
    if cleaned.contains("<|speaker:") {
        cleaned
    } else {
        format!("<|speaker:0|>{cleaned}")
    }
}

/// Build the `[1, 11, L]` packed prompt (upstream `PromptBuilder.build`): row 0 is the
/// chat-format token stream with the reference's codebook-0 codes lifted into semantic-id
/// space; rows 1..=10 carry the raw reference codes aligned under that span (zeros
/// elsewhere).
fn build_prompt(
    tokenizer: &Tokenizer,
    target_text: &str,
    reference: &Audio8Reference,
) -> Audio8Result<Array3<i64>> {
    let encode = |part: &str| -> Audio8Result<Vec<i64>> {
        Ok(tokenizer
            .encode(part, false)
            .map_err(|e| Audio8Error::Tokenizer(format!("encode: {e}")))?
            .get_ids()
            .iter()
            .map(|&id| i64::from(id))
            .collect())
    };
    // Encoded PER PART, exactly like upstream — a joined string would merge tokens
    // across part boundaries and shift the whole prompt.
    let prefix_parts = [
        "<|im_start|>system\n".to_string(),
        "convert the provided text to speech reference to the following:\n\nText:\n".to_string(),
        format_reference_text(&reference.ref_text),
        "\n\nSpeech:\n".to_string(),
    ];
    let suffix_parts = [
        "<|im_end|>\n".to_string(),
        "<|im_start|>user\n".to_string(),
        clean_text(target_text),
        "<|im_end|>\n".to_string(),
        "<|im_start|>assistant\n<|voice|>".to_string(),
    ];
    let mut prefix: Vec<i64> = Vec::new();
    for p in &prefix_parts {
        prefix.extend(encode(p)?);
    }
    let mut suffix: Vec<i64> = Vec::new();
    for p in &suffix_parts {
        suffix.extend(encode(p)?);
    }
    let frames = reference.frames;
    let len = prefix.len() + frames + suffix.len();
    if len >= MAX_SEQ_LEN {
        return Err(Audio8Error::Inference(format!(
            "prompt length {len} exceeds max sequence length {MAX_SEQ_LEN} \
             (reference {frames} frames + text)"
        )));
    }
    let mut values = Array3::<i64>::zeros((1, NUM_CODEBOOKS + 1, len));
    for (i, &t) in prefix.iter().enumerate() {
        values[(0, 0, i)] = t;
    }
    for (j, &c) in reference.codes[0].iter().enumerate() {
        values[(0, 0, prefix.len() + j)] = i64::from(c) + SEMANTIC_BEGIN_ID;
    }
    for (i, &t) in suffix.iter().enumerate() {
        values[(0, 0, prefix.len() + frames + i)] = t;
    }
    for (row, codes) in reference.codes.iter().enumerate() {
        for (j, &c) in codes.iter().enumerate() {
            values[(0, row + 1, prefix.len() + j)] = i64::from(c);
        }
    }
    Ok(values)
}

// ── sampling (upstream `_sample` / `_sample_semantic`) ──────────────────────────

/// Upstream `_sample`: mask by top-p + top-k computed over the RAW logits' softmax
/// ordering (top-1 always kept), THEN temperature-scale the surviving logits, softmax,
/// and draw. Note the order differs from the Qwen3 sampler in `sampling.rs` (which
/// scales before masking), so this is its own faithful port.
fn sample_audio8(
    logits: &[f64],
    temperature: f64,
    top_p: f64,
    top_k: usize,
    rng: &mut SplitMix64Rng,
) -> usize {
    // Ranks at or past `top_k` are masked unconditionally, so only the top `k` can ever
    // survive — the rest need no ordering. `select_nth_unstable_by` partitions in O(n)
    // and only those k get sorted, replacing a full 4097-element sort that ran 11x per
    // frame (~237 sorts per second of audio).
    if logits.is_empty() {
        return 0;
    }
    // `.max(1)` because rank 0 is force-kept regardless of `top_k` — upstream's
    // `remove[0] = False` — so the effective width is never zero.
    let k = top_k.max(1).min(logits.len());
    let mut head: Vec<usize> = (0..logits.len()).collect();
    // Descending by value, TIES BROKEN BY ASCENDING INDEX. The tie-break is explicit
    // because it is load-bearing here in a way it was not obvious to be before: these
    // logits arrive as fp16 (~11 mantissa bits), so exact ties among 4097 values in a
    // narrow range are common, not hypothetical. The previous full `sort_unstable_by`
    // left tied indices in an unspecified order, which a partial select has no reason
    // to reproduce; pinning the order makes the draw a total function of the logits
    // instead of of the sort implementation. Tied candidates carry equal probability,
    // so which one wins is quality-neutral either way.
    let desc = |a: &usize, b: &usize| {
        logits[*b]
            .partial_cmp(&logits[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    };
    if k < head.len() {
        head.select_nth_unstable_by(k - 1, desc);
        head.truncate(k);
    }
    head.sort_unstable_by(desc);

    // Softmax over ALL logits (upstream masks on the RAW distribution), needed only at
    // the surviving ranks. Two linear passes stand in for the sorted `softmax` call.
    let max = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let denominator: f64 = logits.iter().map(|&v| (v - max).exp()).sum();

    // `remove = (cumulative > top_p) | (rank >= top_k)`, rank 0 force-kept. Walked in
    // descending order, exactly as before, so the accumulation order is unchanged.
    let mut cumulative = 0.0f64;
    let mut survivors: Vec<usize> = Vec::with_capacity(k);
    for (rank, &idx) in head.iter().enumerate() {
        cumulative += (logits[idx] - max).exp() / denominator;
        if rank == 0 || cumulative <= top_p {
            survivors.push(idx);
        }
    }
    // Ascending index order: `sample_categorical` walks an inverse CDF, and every
    // non-survivor carries probability zero, so visiting only the survivors in index
    // order sees the identical running sum the full-width array would have produced.
    survivors.sort_unstable();

    let t = temperature.max(1e-5);
    let scaled: Vec<f64> = survivors.iter().map(|&i| logits[i] / t).collect();
    let probs = softmax(&scaled);
    let picked = sample_categorical(&probs, rng);
    survivors.get(picked).copied().unwrap_or(0)
}

// ── engine ──────────────────────────────────────────────────────────────────────

/// Host-side static KV cache: one `[1, heads, seq, head_dim]` fp16 array per key/value
/// per layer, in `[k0, v0, k1, v1, …]` order — matching the graph's delta-output order
/// so the writeback is a straight `zip`. Fed as OWNED tensors (cloned per step, like
/// Chatterbox's KV round-trip).
struct KvCaches {
    buffers: Vec<ArrayD<f16>>,
    shape: [usize; 4],
}

impl KvCaches {
    fn new(layers: usize, seq: usize) -> Self {
        let shape = [1, N_LOCAL_HEADS, seq, HEAD_DIM];
        Self {
            buffers: (0..2 * layers)
                .map(|_| ArrayD::from_elem(IxDyn(&shape), f16::ZERO))
                .collect(),
            shape,
        }
    }

    /// Write one graph delta `[1, heads, P, head_dim]` back at positions
    /// `pos_start..pos_start + p` (positions are always one contiguous run here).
    fn apply_delta(
        &mut self,
        index: usize,
        delta: &ArrayD<f16>,
        pos_start: usize,
    ) -> Audio8Result<()> {
        let dims = delta.shape();
        if dims.len() != 4 || dims[1] != self.shape[1] || dims[3] != self.shape[3] {
            return Err(Audio8Error::Inference(format!(
                "unexpected kv delta shape {dims:?}"
            )));
        }
        let p = dims[2];
        if pos_start + p > self.shape[2] {
            return Err(Audio8Error::Inference(format!(
                "kv delta writes past the cache: {pos_start}+{p} > {}",
                self.shape[2]
            )));
        }
        self.buffers[index]
            .slice_mut(ndarray::s![.., .., pos_start..pos_start + p, ..])
            .assign(delta);
        Ok(())
    }

    /// Zero every buffer, so one allocation can serve many independent runs.
    ///
    /// Equivalent to rebuilding via [`Self::new`]: that fills with `f16::ZERO` too, and
    /// the fast AR only ever writes positions `0..NUM_CODEBOOKS`, so a wipe leaves the
    /// same state a fresh cache would have.
    fn reset(&mut self) {
        for buf in &mut self.buffers {
            buf.fill(f16::ZERO);
        }
    }
}

pub struct Audio8Engine {
    slow: Session,
    fast: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    cache_dir: PathBuf,
    /// Graph output names in declaration order: `[logits, hidden, k0, v0, …]` (slow),
    /// `[logits, k0, v0, …]` (fast). Captured at load so the writeback never guesses.
    slow_outputs: Vec<String>,
    fast_outputs: Vec<String>,
    /// `[cache_key_0, cache_value_0, cache_key_1, …]` — the KV INPUT names, in the same
    /// `[k0, v0, …]` order as `buffers`. Built once at load because the frame loop feeds
    /// 48 (slow) + 8 (fast) of them per step: formatting them per call cost ~2,750
    /// `String` allocations per second of audio for names that never change.
    slow_cache_inputs: Vec<String>,
    fast_cache_inputs: Vec<String>,
    reference: Option<(RefCacheKey, Audio8Reference)>,
}

/// `[cache_key_0, cache_value_0, …]` for `layers` layers, matching `KvCaches::buffers`.
fn cache_input_names(layers: usize) -> Vec<String> {
    (0..2 * layers)
        .map(|i| {
            if i % 2 == 0 {
                format!("cache_key_{}", i / 2)
            } else {
                format!("cache_value_{}", i / 2)
            }
        })
        .collect()
}

impl Audio8Engine {
    pub fn load(
        slow_path: &Path,
        fast_path: &Path,
        decoder_path: &Path,
        tokenizer_path: &Path,
        cache_dir: &Path,
    ) -> Audio8Result<Self> {
        let slow = audio8_ar_session(slow_path).map_err(Audio8Error::Session)?;
        let fast = audio8_ar_session(fast_path).map_err(Audio8Error::Session)?;
        // The fp16 codec decoder has no int4 weights, so it keeps prepacking — but it
        // needs the SAME thread cap: decoding one sentence (140 frames ≈ 6.5 s of audio)
        // measured 11,453 ms at ORT's default vs 3,144 ms at 8 threads. Left uncapped it
        // becomes the bottleneck (RTF 1.76 on its own) the instant the AR graphs speed up.
        let decoder = cpu_session_with_intra_threads(
            decoder_path,
            "Audio8 codec decoder",
            "audio8",
            intra_op_threads(),
        )
        .map_err(Audio8Error::Session)?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            Audio8Error::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;
        // The chat-format specials must resolve as SINGLE tokens or the prompt silently
        // BPEs into garbage — assert presence up front, like OmniVoice.
        for name in ["<|im_start|>", "<|im_end|>", "<|voice|>"] {
            if tokenizer.token_to_id(name).is_none() {
                return Err(Audio8Error::Tokenizer(format!(
                    "tokenizer.json is missing the Audio8 special token {name}"
                )));
            }
        }
        let names = |s: &Session| {
            s.outputs()
                .iter()
                .map(|o| o.name().to_string())
                .collect::<Vec<_>>()
        };
        let slow_outputs = names(&slow);
        let fast_outputs = names(&fast);
        if slow_outputs.len() != 2 + 2 * NUM_LAYERS {
            return Err(Audio8Error::Session(format!(
                "slow AR declares {} outputs, expected {}",
                slow_outputs.len(),
                2 + 2 * NUM_LAYERS
            )));
        }
        if fast_outputs.len() != 1 + 2 * NUM_FAST_LAYERS {
            return Err(Audio8Error::Session(format!(
                "fast AR declares {} outputs, expected {}",
                fast_outputs.len(),
                1 + 2 * NUM_FAST_LAYERS
            )));
        }
        Ok(Self {
            slow,
            fast,
            decoder,
            tokenizer,
            cache_dir: cache_dir.to_path_buf(),
            slow_outputs,
            fast_outputs,
            slow_cache_inputs: cache_input_names(NUM_LAYERS),
            fast_cache_inputs: cache_input_names(NUM_FAST_LAYERS),
            reference: None,
        })
    }

    /// True when the registration encoder is on disk, i.e. a NEW reference clip can be
    /// encoded. Cached references keep working without it.
    pub fn cloning_ready(&self) -> bool {
        self.encoder_path().is_file()
    }

    fn encoder_path(&self) -> PathBuf {
        self.cache_dir
            .join("registration")
            .join("codec_encoder_fp16.onnx")
    }

    // ── reference encoding ──────────────────────────────────────────────────────

    /// Resolve the reference for `clip_path`, hitting (in order) the in-memory slot,
    /// the on-disk JSON cache, then the 414 MB encoder (loaded and dropped inline).
    ///
    /// `decode_clip` is called ONLY on a full miss and must yield 44.1 kHz mono. It is a
    /// closure rather than a `&[f32]` because both caches hit on essentially every
    /// sentence after the first, and the caller's decode re-reads, decodes and resamples
    /// up to 30 s of audio (~1.3 M samples) — work that was being thrown away once per
    /// sentence for the whole of a read-aloud.
    pub fn ensure_reference(
        &mut self,
        clip_path: &Path,
        ref_text: &str,
        decode_clip: impl FnOnce() -> Result<Vec<f32>, String>,
    ) -> Audio8Result<Audio8Reference> {
        let key = RefCacheKey::for_clip(clip_path, ref_text);
        if let Some((cached_key, reference)) = &self.reference
            && *cached_key == key
        {
            return Ok(reference.clone());
        }
        let disk = self
            .cache_dir
            .join("reference_cache")
            .join(format!("{}.audio8-ref.json", key.hash()));
        if let Some(reference) = std::fs::read_to_string(&disk)
            .ok()
            .and_then(|s| serde_json::from_str::<Audio8Reference>(&s).ok())
            .filter(|r| r.validate().is_ok() && r.ref_text == ref_text)
        {
            self.reference = Some((key, reference.clone()));
            return Ok(reference);
        }
        if !self.cloning_ready() {
            return Err(Audio8Error::Reference(
                "Audio8 voice-registration encoder is not downloaded for this model".into(),
            ));
        }
        let clip = decode_clip().map_err(Audio8Error::Reference)?;
        let reference = self.encode_reference(&clip, ref_text)?;
        if let Some(parent) = disk.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&reference) {
            let _ = std::fs::write(&disk, json);
        }
        self.reference = Some((key, reference.clone()));
        Ok(reference)
    }

    /// Upstream `registration.py`: mono clip at the codec rate, zero-padded to a
    /// multiple of the frame size, through the fp16 encoder → `[10, T]` codes.
    fn encode_reference(&self, clip: &[f32], ref_text: &str) -> Audio8Result<Audio8Reference> {
        if clip.is_empty() {
            return Err(Audio8Error::Reference("reference clip is empty".into()));
        }
        let ref_text = clean_text(ref_text);
        if ref_text.is_empty() {
            return Err(Audio8Error::Reference(
                "reference transcript is empty".into(),
            ));
        }
        let mut padded = clip.to_vec();
        let rem = padded.len() % CODEC_FRAME_SIZE;
        if rem != 0 {
            padded.resize(padded.len() + (CODEC_FRAME_SIZE - rem), 0.0);
        }
        // Loaded fresh and dropped at scope end — 414 MB that synthesis never needs.
        let mut encoder = cpu_session(&self.encoder_path(), "Audio8 codec encoder", "audio8")
            .map_err(Audio8Error::Session)?;
        let wants_f16 = encoder
            .inputs()
            .iter()
            .find(|i| i.name() == "audio")
            .and_then(|i| i.dtype().tensor_type())
            .is_some_and(|t| matches!(t, ort::value::TensorElementType::Float16));
        let audio_input: SessionInputValue<'_> = if wants_f16 {
            let a = ArrayD::from_shape_vec(
                IxDyn(&[1, 1, padded.len()]),
                padded.iter().map(|&v| f16::from_f32(v)).collect(),
            )
            .map_err(|e| Audio8Error::Inference(format!("audio shape: {e}")))?;
            Tensor::from_array(a)
                .map(SessionInputValue::from)
                .map_err(|e| Audio8Error::Inference(format!("audio tensor: {e}")))?
        } else {
            let a = ArrayD::from_shape_vec(IxDyn(&[1, 1, padded.len()]), padded)
                .map_err(|e| Audio8Error::Inference(format!("audio shape: {e}")))?;
            Tensor::from_array(a)
                .map(SessionInputValue::from)
                .map_err(|e| Audio8Error::Inference(format!("audio tensor: {e}")))?
        };
        let out_name = encoder
            .outputs()
            .first()
            .map(|o| o.name().to_string())
            .ok_or_else(|| Audio8Error::Session("encoder declares no outputs".into()))?;
        let outputs = encoder
            .run(vec![(Cow::Borrowed("audio"), audio_input)])
            .map_err(|e| Audio8Error::Inference(format!("codec encoder: {e}")))?;
        let (shape, data) = outputs[out_name.as_str()]
            .try_extract_tensor::<i64>()
            .map_err(|e| Audio8Error::Inference(format!("extract codes: {e}")))?;
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        // `[1, 10, T]` (or already `[10, T]`) — upstream squeezes the batch dim.
        let (codebooks, frames) = match dims.as_slice() {
            [1, c, t] => (*c, *t),
            [c, t] => (*c, *t),
            other => {
                return Err(Audio8Error::Reference(format!(
                    "encoder returned invalid code shape {other:?}"
                )));
            }
        };
        if codebooks != NUM_CODEBOOKS || frames == 0 {
            return Err(Audio8Error::Reference(format!(
                "encoder returned invalid codes: [{codebooks}, {frames}]"
            )));
        }
        let mut codes: Vec<Vec<u16>> = (0..NUM_CODEBOOKS)
            .map(|_| Vec::with_capacity(frames))
            .collect();
        for c in 0..NUM_CODEBOOKS {
            for t in 0..frames {
                let v = data[c * frames + t];
                if !(0..CODEBOOK_SIZE as i64).contains(&v) {
                    return Err(Audio8Error::Reference(format!(
                        "encoder emitted out-of-range code {v}"
                    )));
                }
                codes[c].push(v as u16);
            }
        }
        let reference = Audio8Reference {
            schema_version: 1,
            ref_text,
            frames,
            codes,
        };
        reference.validate()?;
        Ok(reference)
    }

    // ── generation ──────────────────────────────────────────────────────────────

    /// One slow-AR step: run `codes [1, 11, P]` at `positions`, write the KV deltas
    /// back, return (last-position logits `[4097]`, last hidden `[1, 1, D]` as f32).
    fn slow_step(
        &mut self,
        codes: &Array3<i64>,
        pos_start: usize,
        caches: &mut KvCaches,
    ) -> Audio8Result<(Vec<f64>, ArrayD<f16>)> {
        let p = codes.shape()[2];
        let positions: Vec<i64> = (pos_start..pos_start + p).map(|v| v as i64).collect();
        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(2 + caches.buffers.len());
            inputs.push((
                Cow::Borrowed("codes"),
                TensorRef::from_array_view(codes.view())
                    .map(SessionInputValue::from)
                    .map_err(|e| Audio8Error::Inference(format!("codes tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("input_pos"),
                Tensor::from_array(Array1::from_vec(positions))
                    .map(SessionInputValue::from)
                    .map_err(|e| Audio8Error::Inference(format!("input_pos tensor: {e}")))?,
            ));
            // Fed as VIEWS: these are 48 x [1,2,2048,64] fp16 buffers = 25 MB, and
            // cloning them per step was ~541 MB/s of pure memcpy for data ORT only
            // reads. `TensorRef` wraps the buffer in place (upstream feeds its numpy
            // arrays the same way); the deltas are written back after `run` returns.
            for (buf, name) in caches.buffers.iter().zip(&self.slow_cache_inputs) {
                inputs.push((
                    Cow::Borrowed(name.as_str()),
                    TensorRef::from_array_view(buf.view())
                        .map(SessionInputValue::from)
                        .map_err(|e| Audio8Error::Inference(format!("kv tensor: {e}")))?,
                ));
            }
            self.slow
                .run(inputs)
                .map_err(|e| Audio8Error::Inference(format!("slow AR: {e}")))?
        };
        // outputs[0] logits [1, P, 4097] → last position only, f64 for the sampler.
        let last = extract_last_row_f64(&outputs, &self.slow_outputs[0])?;
        if last.len() != SLOW_LOGITS_SIZE {
            return Err(Audio8Error::Inference(format!(
                "unexpected slow logits size {}, expected {SLOW_LOGITS_SIZE}",
                last.len()
            )));
        }
        // outputs[1] hidden [1, P, D] → keep only the last position as [1, 1, D], in the
        // graph's own f16 (the fast AR consumes f16).
        let hidden = extract_last_row_f16(&outputs, &self.slow_outputs[1])?;
        // outputs[2..] KV deltas in [k0, v0, …] order.
        let mut deltas: Vec<ArrayD<f16>> = Vec::with_capacity(2 * NUM_LAYERS);
        for name in &self.slow_outputs[2..] {
            deltas.push(extract_f16(&outputs, name)?);
        }
        drop(outputs);
        for (i, delta) in deltas.iter().enumerate() {
            caches.apply_delta(i, delta, pos_start)?;
        }
        Ok((last, hidden))
    }

    /// One fast-AR step: returns the `[4096]` codebook logits at this position.
    fn fast_step(
        &mut self,
        hidden: &ArrayD<f16>,
        token_id: i64,
        use_hidden: bool,
        position: usize,
        caches: &mut KvCaches,
    ) -> Audio8Result<Vec<f64>> {
        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(4 + caches.buffers.len());
            // `hidden` is already the graph's dtype and is IDENTICAL across all 10 fast
            // steps of a frame — fed as a view, so those 10 calls share one buffer
            // instead of rebuilding it each time.
            inputs.push((
                Cow::Borrowed("slow_hidden"),
                TensorRef::from_array_view(hidden.view())
                    .map(SessionInputValue::from)
                    .map_err(|e| Audio8Error::Inference(format!("slow_hidden tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("token_id"),
                Tensor::from_array(
                    ndarray::Array2::from_shape_vec((1, 1), vec![token_id])
                        .map_err(|e| Audio8Error::Inference(format!("token_id shape: {e}")))?,
                )
                .map(SessionInputValue::from)
                .map_err(|e| Audio8Error::Inference(format!("token_id tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("use_slow_hidden"),
                Tensor::from_array(Array1::from_vec(vec![use_hidden]))
                    .map(SessionInputValue::from)
                    .map_err(|e| Audio8Error::Inference(format!("use_slow_hidden tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("input_pos"),
                Tensor::from_array(Array1::from_vec(vec![position as i64]))
                    .map(SessionInputValue::from)
                    .map_err(|e| Audio8Error::Inference(format!("input_pos tensor: {e}")))?,
            ));
            for (buf, name) in caches.buffers.iter().zip(&self.fast_cache_inputs) {
                inputs.push((
                    Cow::Borrowed(name.as_str()),
                    TensorRef::from_array_view(buf.view())
                        .map(SessionInputValue::from)
                        .map_err(|e| Audio8Error::Inference(format!("fast kv tensor: {e}")))?,
                ));
            }
            self.fast
                .run(inputs)
                .map_err(|e| Audio8Error::Inference(format!("fast AR: {e}")))?
        };
        let last = extract_last_row_f64(&outputs, &self.fast_outputs[0])?;
        let mut deltas: Vec<ArrayD<f16>> = Vec::with_capacity(2 * NUM_FAST_LAYERS);
        for name in &self.fast_outputs[1..] {
            deltas.push(extract_f16(&outputs, name)?);
        }
        drop(outputs);
        for (i, delta) in deltas.iter().enumerate() {
            caches.apply_delta(i, delta, position)?;
        }
        Ok(last)
    }

    /// Upstream `_sample_semantic`: constrained to the 4096 semantic ids + im_end (the
    /// head already emits exactly that row), with the repetition-escape re-draw.
    fn sample_semantic(&self, logits: &[f64], previous: &[i64], rng: &mut SplitMix64Rng) -> i64 {
        let to_id = |index: usize| -> i64 {
            if index < CODEBOOK_SIZE {
                SEMANTIC_BEGIN_ID + index as i64
            } else {
                IM_END_ID
            }
        };
        let normal = to_id(sample_audio8(logits, TEMPERATURE, TOP_P, TOP_K, rng));
        let high = to_id(sample_audio8(logits, 1.0, 0.9, TOP_K, rng));
        if normal != IM_END_ID && previous.contains(&normal) {
            high
        } else {
            normal
        }
    }

    /// Generate the full `[10][frames]` code matrix for one sentence.
    fn generate_codes(
        &mut self,
        text: &str,
        reference: &Audio8Reference,
    ) -> Audio8Result<Vec<[i64; NUM_CODEBOOKS]>> {
        let prompt = build_prompt(&self.tokenizer, text, reference)?;
        let prompt_len = prompt.shape()[2];
        let max_new = MAX_NEW_TOKENS.min(MAX_SEQ_LEN - prompt_len);
        let mut rng = SplitMix64Rng::new(RNG_SEED);
        let mut slow_caches = KvCaches::new(NUM_LAYERS, MAX_SEQ_LEN);
        let (mut logits, mut hidden) = self.slow_step(&prompt, 0, &mut slow_caches)?;
        let mut previous: Vec<i64> = Vec::with_capacity(REPETITION_WINDOW);
        let mut frames: Vec<[i64; NUM_CODEBOOKS]> = Vec::with_capacity(max_new);
        // One fast cache for the whole sentence, wiped per frame. It was rebuilt from
        // scratch every frame — 8 fresh allocations ~21.5x per second of audio for a
        // buffer whose only required state is "all zeros".
        let mut fast_caches = KvCaches::new(NUM_FAST_LAYERS, NUM_CODEBOOKS);

        for step in 0..max_new {
            let semantic = self.sample_semantic(&logits, &previous, &mut rng);
            if semantic == IM_END_ID {
                break;
            }
            previous.push(semantic);
            if previous.len() > REPETITION_WINDOW {
                previous.remove(0);
            }
            fast_caches.reset();
            self.fast_step(&hidden, 0, true, 0, &mut fast_caches)?;
            let mut token = (semantic - SEMANTIC_BEGIN_ID).clamp(0, CODEBOOK_SIZE as i64 - 1);
            let mut frame = [0i64; NUM_CODEBOOKS];
            frame[0] = token;
            for fast_pos in 1..NUM_CODEBOOKS {
                let fast_logits =
                    self.fast_step(&hidden, token, false, fast_pos, &mut fast_caches)?;
                token = sample_audio8(&fast_logits, TEMPERATURE, TOP_P, TOP_K, &mut rng) as i64;
                if let Some(slot) = frame.get_mut(fast_pos) {
                    *slot = token;
                }
            }
            frames.push(frame);
            if step + 1 >= max_new {
                break;
            }
            // Next slow column: [semantic; frame] as [1, 11, 1] at the next position.
            let mut column = Array3::<i64>::zeros((1, NUM_CODEBOOKS + 1, 1));
            column[(0, 0, 0)] = semantic;
            for (row, &c) in frame.iter().enumerate() {
                column[(0, row + 1, 0)] = c;
            }
            let (l, h) = self.slow_step(&column, prompt_len + step, &mut slow_caches)?;
            logits = l;
            hidden = h;
        }
        if frames.is_empty() {
            return Err(Audio8Error::Inference(
                "model produced no codec frames".into(),
            ));
        }
        Ok(frames)
    }

    /// Decode `[10][frames]` codes to 44.1 kHz mono f32 (upstream `decode_codes`).
    fn decode_codes(&mut self, frames: &[[i64; NUM_CODEBOOKS]]) -> Audio8Result<Vec<f32>> {
        let t = frames.len();
        let mut codes = Array3::<i64>::zeros((1, NUM_CODEBOOKS, t));
        for (j, frame) in frames.iter().enumerate() {
            for (c, &v) in frame.iter().enumerate() {
                codes[(0, c, j)] = v;
            }
        }
        let tensor = Tensor::from_array(codes)
            .map_err(|e| Audio8Error::Inference(format!("codes tensor: {e}")))?;
        // Name captured before `run` mutably borrows the session.
        let out_name = self
            .decoder
            .outputs()
            .first()
            .map(|o| o.name().to_string())
            .ok_or_else(|| Audio8Error::Session("decoder declares no outputs".into()))?;
        let outputs = self
            .decoder
            .run(vec![(
                Cow::Borrowed("codes"),
                SessionInputValue::from(tensor),
            )])
            .map_err(|e| Audio8Error::Inference(format!("codec decoder: {e}")))?;
        let audio = extract_f32(&outputs, &out_name)?;
        Ok(audio
            .as_slice()
            .map_or_else(|| audio.iter().copied().collect(), <[f32]>::to_vec))
    }

    /// Synthesize one sentence with the given (already-encoded) reference voice.
    pub fn synthesize(
        &mut self,
        text: &str,
        reference: &Audio8Reference,
    ) -> Audio8Result<Vec<f32>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let frames = self.generate_codes(text, reference)?;
        self.decode_codes(&frames)
    }
}

// ── output extraction helpers ───────────────────────────────────────────────────

/// Extract a named float output as f32, accepting fp16 graphs (the int4 export emits
/// fp16 activations). Same contract as Chatterbox's `extract_f32`.
fn extract_f32(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Audio8Result<ArrayD<f32>> {
    if let Ok((shape, data)) = outputs[name].try_extract_tensor::<f32>() {
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        return ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
            .map_err(|e| Audio8Error::Inference(format!("shape {name}: {e}")));
    }
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f16>()
        .map_err(|e| Audio8Error::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.iter().map(|v| v.to_f32()).collect())
        .map_err(|e| Audio8Error::Inference(format!("shape {name}: {e}")))
}

/// Last row of a `[.., last_dim]` output as f64, WITHOUT materializing the tensor.
///
/// Prefill returns logits `[1, L, 4097]` with `L` ≈ 800 — 3.3 M floats, ~13 MB — of
/// which the sampler wants the final 4097. The old path converted and `to_vec()`d the
/// whole thing first. Reads the graph's own dtype (fp16 for this export) and converts
/// only the tail.
fn extract_last_row_f64(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Audio8Result<Vec<f64>> {
    if let Ok((shape, data)) = outputs[name].try_extract_tensor::<f16>() {
        let last = last_dim(shape.iter().next_back().copied(), name)?;
        return Ok(data[data.len() - last..]
            .iter()
            .map(|v| f64::from(v.to_f32()))
            .collect());
    }
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| Audio8Error::Inference(format!("extract {name}: {e}")))?;
    let last = last_dim(shape.iter().next_back().copied(), name)?;
    Ok(data[data.len() - last..]
        .iter()
        .map(|&v| f64::from(v))
        .collect())
}

/// Last row of a `[.., D]` output as a `[1, 1, D]` f16 array, without materializing the
/// tensor. f16 is the graph's OWN dtype for `slow_hidden`, and the fast AR consumes it
/// as f16 — the old path went f16 → f32 here and f32 → f16 back on each of the 10 fast
/// steps per frame, a lossless but wasted round-trip.
fn extract_last_row_f16(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Audio8Result<ArrayD<f16>> {
    let tail: Vec<f16> = if let Ok((shape, data)) = outputs[name].try_extract_tensor::<f16>() {
        let last = last_dim(shape.iter().next_back().copied(), name)?;
        data[data.len() - last..].to_vec()
    } else {
        let (shape, data) = outputs[name]
            .try_extract_tensor::<f32>()
            .map_err(|e| Audio8Error::Inference(format!("extract {name}: {e}")))?;
        let last = last_dim(shape.iter().next_back().copied(), name)?;
        data[data.len() - last..]
            .iter()
            .map(|&v| f16::from_f32(v))
            .collect()
    };
    let d = tail.len();
    ArrayD::from_shape_vec(IxDyn(&[1, 1, d]), tail)
        .map_err(|e| Audio8Error::Inference(format!("shape {name}: {e}")))
}

/// Width of a tensor's trailing dimension. Takes the value rather than the shape so the
/// helper does not have to name `ort`'s shape type, which moved between rc releases.
fn last_dim(last: Option<i64>, name: &str) -> Audio8Result<usize> {
    let last = last.ok_or_else(|| Audio8Error::Inference(format!("scalar output {name}")))?;
    usize::try_from(last).map_err(|_| Audio8Error::Inference(format!("bad {name} dim {last}")))
}

/// Extract a named output verbatim as f16 (KV deltas round-trip in the graph's dtype).
fn extract_f16(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Audio8Result<ArrayD<f16>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f16>()
        .map_err(|e| Audio8Error::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| Audio8Error::Inference(format!("shape {name}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_collapses_whitespace() {
        assert_eq!(clean_text("  a\n b\t\tc  "), "a b c");
        assert_eq!(clean_text(""), "");
    }

    #[test]
    fn reference_text_gains_a_speaker_tag_exactly_once() {
        assert_eq!(format_reference_text("hello"), "<|speaker:0|>hello");
        assert_eq!(
            format_reference_text("<|speaker:3|>already tagged"),
            "<|speaker:3|>already tagged"
        );
    }

    #[test]
    fn reference_validation_rejects_bad_shapes() {
        let good = Audio8Reference {
            schema_version: 1,
            ref_text: "hi".into(),
            frames: 2,
            codes: vec![vec![0u16, 1]; NUM_CODEBOOKS],
        };
        assert!(good.validate().is_ok());
        let mut wrong_rows = good.clone();
        wrong_rows.codes.pop();
        assert!(wrong_rows.validate().is_err());
        let mut ragged = good.clone();
        ragged.codes[3] = vec![0u16];
        assert!(ragged.validate().is_err());
        let mut out_of_range = good;
        out_of_range.codes[0][0] = CODEBOOK_SIZE as u16;
        assert!(out_of_range.validate().is_err());
        let empty = Audio8Reference {
            schema_version: 1,
            ref_text: "hi".into(),
            frames: 0,
            codes: vec![Vec::new(); NUM_CODEBOOKS],
        };
        assert!(empty.validate().is_err());
    }

    #[test]
    fn kv_delta_writeback_lands_at_the_given_positions() {
        let mut caches = KvCaches::new(1, 8);
        // Delta [1, 2, 2, 64] writing positions 3..5.
        let delta = ArrayD::from_shape_vec(
            IxDyn(&[1, N_LOCAL_HEADS, 2, HEAD_DIM]),
            (0..N_LOCAL_HEADS * 2 * HEAD_DIM)
                .map(|i| f16::from_f32(i as f32))
                .collect(),
        )
        .unwrap();
        caches.apply_delta(0, &delta, 3).unwrap();
        let buf = &caches.buffers[0];
        // head 0, position 3, dim 0 → delta (0, 0, 0) = 0.0
        assert_eq!(buf[[0, 0, 3, 0]].to_f32(), 0.0);
        // head 0, position 4, dim 1 → delta (0, 1, 1) = 65.0
        assert_eq!(buf[[0, 0, 4, 1]].to_f32(), 65.0);
        // head 1, position 3, dim 0 → delta (1, 0, 0) = 128.0
        assert_eq!(buf[[0, 1, 3, 0]].to_f32(), 128.0);
        // untouched positions stay zero.
        assert_eq!(buf[[0, 0, 0, 0]].to_f32(), 0.0);
        assert_eq!(buf[[0, 0, 5, 0]].to_f32(), 0.0);
        // Out-of-bounds write is rejected, not wrapped.
        assert!(caches.apply_delta(0, &delta, 7).is_err());
    }

    #[test]
    fn audio8_sampler_keeps_top1_and_respects_top_k() {
        let mut rng = SplitMix64Rng::new(1);
        // A spike: top-p removes everything but the winner → deterministic.
        let logits = vec![0.0f64, 20.0, 0.0, 0.0];
        for _ in 0..32 {
            assert_eq!(sample_audio8(&logits, 0.7, 0.9, 50, &mut rng), 1);
        }
        // top_k = 1 is greedy regardless of temperature.
        let logits = vec![1.0f64, 3.0, 2.0, 0.0];
        for _ in 0..32 {
            assert_eq!(sample_audio8(&logits, 5.0, 1.1, 1, &mut rng), 1);
        }
    }

    /// The exact 23-byte run the shipped export serializes for one attribute.
    fn attr(value: u8) -> Vec<u8> {
        let mut v = vec![0x2A, 0x15];
        v.extend_from_slice(ACC_NAME_THROUGH_I);
        v.push(value);
        v.extend_from_slice(ACC_TYPE_TAG);
        v
    }

    #[test]
    fn accuracy_level_patch_is_length_preserving_and_hits_every_attribute() {
        let mut buf = Vec::new();
        for _ in 0..3 {
            buf.extend_from_slice(
                b"
some/w8",
            );
            buf.extend_from_slice(&attr(4));
        }
        let before = buf.len();
        assert_eq!(patch_accuracy_level(&mut buf, 1), 3);
        // Length must not move: every enclosing protobuf length field depends on it.
        assert_eq!(buf.len(), before);
        assert_eq!(patch_accuracy_level(&mut buf.clone(), 1), 3, "idempotent");
        for window in buf.windows(ACC_NAME_THROUGH_I.len() + 1) {
            if window.starts_with(ACC_NAME_THROUGH_I) {
                assert_eq!(window[ACC_NAME_THROUGH_I.len()], 1);
            }
        }
    }

    #[test]
    fn accuracy_level_patch_ignores_the_name_outside_the_attribute_shape() {
        // The literal string as a TENSOR NAME (length-prefixed, no `i` field and
        // no INT type tag after it) must not be rewritten — that would corrupt
        // an unrelated part of the graph.
        let mut buf = b"
accuracy_leveljunk"
            .to_vec();
        let before = buf.clone();
        assert_eq!(patch_accuracy_level(&mut buf, 1), 0);
        assert_eq!(buf, before);

        // A multi-byte varint value is likewise not the shape we pin.
        let mut buf = Vec::new();
        buf.extend_from_slice(ACC_NAME_THROUGH_I);
        buf.extend_from_slice(&[0x80, 0x01]);
        buf.extend_from_slice(ACC_TYPE_TAG);
        let before = buf.clone();
        assert_eq!(patch_accuracy_level(&mut buf, 1), 0);
        assert_eq!(buf, before);
    }

    #[test]
    fn accuracy_level_patch_finds_adjacent_attributes() {
        // Two attributes back to back: the scan must not skip the second.
        let mut buf = attr(4);
        buf.extend_from_slice(&attr(4));
        assert_eq!(patch_accuracy_level(&mut buf, 1), 2);
    }

    #[test]
    fn derived_graph_is_refused_for_an_unknown_export() {
        // The node counts are the guard against silently half-patching a graph
        // that is not the export this port pins.
        let dir = std::env::temp_dir().join("winstt-audio8-acc1-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("slow_ar_int4.onnx");
        std::fs::write(&path, attr(4)).expect("write stub graph");
        let err = ensure_accuracy_level_1_graph(&path).expect_err("1 node is not 121");
        assert!(err.contains("expected 121"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The pre-optimization sampler, verbatim except for the tie-break, as the
    /// equivalence oracle: full descending sort, softmax over every logit, mask by
    /// cumulative top-p / top-k, divide by temperature, softmax the full width, draw.
    ///
    /// The one deliberate deviation is `.then(a.cmp(b))`. The shipped version used a
    /// bare `sort_unstable_by`, which orders tied logits arbitrarily — so comparing
    /// against it would be testing the sort implementation, not this optimization.
    /// Both sides pin the tie-break; what the test then proves is the real claim: that
    /// selecting the top `k` and sampling among the survivors picks the same token as
    /// sorting all 4097 and masking.
    fn sample_audio8_reference(
        logits: &[f64],
        temperature: f64,
        top_p: f64,
        top_k: usize,
        rng: &mut SplitMix64Rng,
    ) -> usize {
        let mut order: Vec<usize> = (0..logits.len()).collect();
        order.sort_unstable_by(|&a, &b| {
            logits[b]
                .partial_cmp(&logits[a])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.cmp(&b))
        });
        let sorted: Vec<f64> = order.iter().map(|&i| logits[i]).collect();
        let base = softmax(&sorted);
        let mut masked = logits.to_vec();
        let mut cumulative = 0.0f64;
        for (rank, &idx) in order.iter().enumerate() {
            cumulative += base[rank];
            if rank > 0 && (cumulative > top_p || rank >= top_k) {
                masked[idx] = f64::NEG_INFINITY;
            }
        }
        let t = temperature.max(1e-5);
        for v in masked.iter_mut() {
            *v /= t;
        }
        let probs = softmax(&masked);
        sample_categorical(&probs, rng)
    }

    #[test]
    fn top_k_selection_sampler_matches_the_full_sort_reference() {
        // The optimization replaces an O(n log n) sort of all 4097 logits with an O(n)
        // partial select. It must pick the SAME token for the same RNG stream, or the
        // model's output changes. Swept over the real vocab width and the real
        // (temperature, top_p, top_k) settings the engine uses, plus edge cases.
        // Deterministic pseudo-random logits (plain LCG, so the test owns its own
        // stream and never perturbs the sampler's).
        let mut bits: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move || {
            bits = bits.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            ((bits >> 11) as f64) * (1.0 / (1u64 << 53) as f64)
        };
        for case in 0..24 {
            let width = if case % 3 == 0 { SLOW_LOGITS_SIZE } else { 64 };
            // A realistic spread, and the clamp manufactures TIES at the top — the case
            // where a partial select and a full sort could most easily disagree.
            let logits: Vec<f64> = (0..width)
                .map(|_| (next() - 0.5) * 24.0)
                .map(|v| if v > 11.0 { 11.0 } else { v })
                .collect();
            for &(temp, top_p, top_k) in &[
                (TEMPERATURE, TOP_P, TOP_K),
                (1.0, 0.9, TOP_K),
                (0.7, 1.0, 1),
                (5.0, 0.5, 8),
                (1e-9, 0.9, 4096),
            ] {
                let mut a = SplitMix64Rng::new(RNG_SEED ^ case as u64);
                let mut b = SplitMix64Rng::new(RNG_SEED ^ case as u64);
                let got = sample_audio8(&logits, temp, top_p, top_k, &mut a);
                let want = sample_audio8_reference(&logits, temp, top_p, top_k, &mut b);
                assert_eq!(
                    got, want,
                    "case {case} width {width} temp {temp} top_p {top_p} top_k {top_k}"
                );
            }
        }
    }

    #[test]
    fn resetting_a_fast_cache_matches_allocating_a_fresh_one() {
        // The frame loop now reuses one fast cache instead of rebuilding it per frame;
        // that is only sound if a wipe is indistinguishable from a fresh allocation.
        let mut reused = KvCaches::new(NUM_FAST_LAYERS, NUM_CODEBOOKS);
        let delta = ArrayD::from_elem(IxDyn(&[1, N_LOCAL_HEADS, 1, HEAD_DIM]), f16::from_f32(0.5));
        for i in 0..reused.buffers.len() {
            reused.apply_delta(i, &delta, 3).expect("write delta");
        }
        reused.reset();
        let fresh = KvCaches::new(NUM_FAST_LAYERS, NUM_CODEBOOKS);
        assert_eq!(reused.shape, fresh.shape);
        assert_eq!(reused.buffers, fresh.buffers);
    }

    #[test]
    fn cache_input_names_pair_key_and_value_per_layer() {
        // The table is zipped positionally against `KvCaches::buffers`, so its order is
        // load-bearing: [k0, v0, k1, v1, …].
        let names = cache_input_names(3);
        assert_eq!(
            names,
            vec![
                "cache_key_0",
                "cache_value_0",
                "cache_key_1",
                "cache_value_1",
                "cache_key_2",
                "cache_value_2",
            ]
        );
        assert_eq!(names.len(), KvCaches::new(3, 4).buffers.len());
    }

    #[test]
    fn semantic_ids_map_back_into_codebook_range() {
        // The layout contract: index 4096 is the eos slot, everything below is
        // `SEMANTIC_BEGIN_ID + index`.
        assert_eq!(SLOW_LOGITS_SIZE, 4097);
        let begin_frame_code = SEMANTIC_BEGIN_ID - SEMANTIC_BEGIN_ID;
        assert_eq!(begin_frame_code, 0);
    }
}
