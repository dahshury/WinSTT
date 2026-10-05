// Audio8 TTS Preview 0.1B — WinSTT port of Audio8's OFFICIAL INT8 ONNX runtime.
//
// Model repo:   https://huggingface.co/Audio8/audio8-TTS-0.1B-ONNX-INT8 (Apache-2.0)
// Reference:    Audio8_TTS/onnx_runtime_0_1b_int8/arktts_runtime/{runtime,prompt,voices}.py
//
// Everything below is a faithful port of that runtime, so the graph contract lives here
// verbatim rather than being re-derived:
//
//   slow_ar_int8.onnx  in  codes[1,11,1] i64, position[1] i64, cache_keys[24,1,2,2048,64] f32,
//                          cache_values[…] f32, conv_states[24,1,896,4] f32,
//                          ssm_states[24,1,24,32,64] f32
//                      out logits[1,1,4097] f32, hidden[1,1,512] f32,
//                          key_delta[24,1,2,64], value_delta[24,1,2,64],
//                          next_conv_states[…], next_ssm_states[…]
//   fast_ar_int8.onnx  in  slow_hidden[1,1,512] f32, token_id[1,1] i64, use_slow_hidden[1] bool,
//                          input_pos[1] i64, cache_{key,value}_{0..3}[1,2,10,64] f32
//                      out logits[1,1,4096] f32, {key,value}_delta_{0..3}[1,2,1,64] f32
//   codec_decoder_fp16 in  codes[batch,10,frames] i64   out audio[batch,1,samples] f32
//
// Note the deltas: the slow graph's are 4-D (the sequence axis is squeezed out) and land at
// `cache[..., position, :]`, whereas the fast graph keeps one 4-D cache PER LAYER instead of
// 0.6B's stacked `[k0, v0, k1, v1, …]` list. That is why this is its own runtime and not a
// parameterisation of `audio8.rs` — the 0.6B INT4 graphs are mutually incompatible, as
// upstream's own `onnx_runtime/` vs `onnx_runtime_0_1b_int8/` split reflects.
//
// Unlike 0.6B, this repo SHIPS its reference voice (`reference_codes.npy` + the manifest's
// `reference_text`), so the DualAR prompt is always conditioned and the model is usable the
// moment the download finishes — no clip required. Runtime cloning would additionally need
// `registration/codec_encoder_fp16.onnx` (+414 MB), which WinSTT does not fetch.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ndarray::{Array1, Array2, Array3, ArrayD, Axis, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::{Tensor, TensorRef};
use tokenizers::Tokenizer;

use super::audio8::{
    Audio8Error, extract_f32, extract_last_row_f64, intra_op_threads, sample_audio8,
};
use super::provider::cpu_session_with_intra_threads;
use super::sampling::SplitMix64Rng;

type Result<T> = std::result::Result<T, Audio8Error>;

// ── pinned export contract ──────────────────────────────────────────────────────
//
// These mirror `runtime_manifest.json`. They are compile-time constants because the
// state buffers are fixed-shape, but `RuntimeManifest::verify` re-checks every one of
// them against the downloaded manifest at load time — so a future export that moves a
// dimension fails loudly here instead of producing silent garbage audio.

const MODEL_FINGERPRINT: &str = "audio8-tts-preview-0.1b-int8-v1";
const PRECISION: &str = "int8";
const CODEC_PRECISION: &str = "fp16";
const SLOW_LOGITS_LAYOUT: &str = "relative_semantic_then_eos";

const NUM_LAYERS: usize = 24;
const NUM_FAST_LAYERS: usize = 4;
const NUM_CODEBOOKS: usize = 10;
const N_LOCAL_HEADS: usize = 2;
const HEAD_DIM: usize = 64;
const FAST_HEAD_DIM: usize = 64;
const HIDDEN_SIZE: usize = 512;
const MAX_SEQ_LEN: usize = 2048;
const CODEBOOK_SIZE: usize = 4096;
const SEMANTIC_BEGIN_ID: i64 = 65_537;
const SEMANTIC_END_ID: i64 = 69_632;
const IM_END_ID: i64 = 4_096;
/// `relative_semantic_then_eos` — 4096 semantic logits then ONE eos logit.
const SLOW_LOGITS_SIZE: usize = CODEBOOK_SIZE + 1;

const MAMBA_D_CONV: usize = 4;
const MAMBA_D_SSM: usize = 768;
const MAMBA_D_STATE: usize = 64;
const MAMBA_D_HEAD: usize = 32;
const MAMBA_N_HEADS: usize = 24;
const MAMBA_N_GROUPS: usize = 1;
/// The Mamba convolution mixes `x`, `B` and `C`, so its cache is wider than `d_ssm`:
/// 768 + 2 * 1 * 64 = 896 (upstream hard-codes the 896 in `_empty_slow_state`).
const CONV_CHANNELS: usize = MAMBA_D_SSM + 2 * MAMBA_N_GROUPS * MAMBA_D_STATE;

// Upstream `iter_codes` defaults; re-clamped to the space left in the context below.
const MAX_NEW_TOKENS: usize = 1024;
const TEMPERATURE: f64 = 0.7;
const TOP_P: f64 = 0.9;
const TOP_K: usize = 50;
/// Upstream CLI default — a reproducible voice beats a novel one per run.
const RNG_SEED: u64 = 42;
/// Upstream `previous = previous[-10:]`: a semantic token equal to one of the last ten is
/// re-drawn at the "high" settings (temperature 1.0).
const REPETITION_WINDOW: usize = 10;

const MANIFEST_FILE: &str = "runtime_manifest.json";
const TOKENIZER_FILE: &str = "tokenizer/tokenizer.json";

const FAST_KEY_INPUTS: [&str; NUM_FAST_LAYERS] =
    ["cache_key_0", "cache_key_1", "cache_key_2", "cache_key_3"];
const FAST_VALUE_INPUTS: [&str; NUM_FAST_LAYERS] = [
    "cache_value_0",
    "cache_value_1",
    "cache_value_2",
    "cache_value_3",
];
const FAST_KEY_DELTAS: [&str; NUM_FAST_LAYERS] =
    ["key_delta_0", "key_delta_1", "key_delta_2", "key_delta_3"];
const FAST_VALUE_DELTAS: [&str; NUM_FAST_LAYERS] = [
    "value_delta_0",
    "value_delta_1",
    "value_delta_2",
    "value_delta_3",
];

// ── runtime manifest ────────────────────────────────────────────────────────────

/// The subset of `runtime_manifest.json` this port reads. Upstream resolves graph filenames
/// through the `*_models` maps with the singular keys as fallback, so the same two-step
/// lookup is reproduced rather than hard-coding the names.
#[derive(serde::Deserialize)]
struct RuntimeManifest {
    model_fingerprint: String,
    default_precision: String,
    #[serde(default)]
    available_precisions: Vec<String>,
    #[serde(default)]
    default_codec_precision: Option<String>,
    #[serde(default)]
    codec_models: BTreeMap<String, String>,
    #[serde(default)]
    slow_decode_models: BTreeMap<String, String>,
    #[serde(default)]
    fast_models: BTreeMap<String, String>,
    #[serde(default)]
    slow_decode_model: Option<String>,
    #[serde(default)]
    fast_model: Option<String>,
    #[serde(default = "default_reference_codes")]
    reference_codes: String,
    reference_text: String,

    sample_rate: u32,
    num_codebooks: usize,
    codebook_size: usize,
    semantic_begin_id: i64,
    semantic_end_id: i64,
    im_end_id: i64,
    slow_logits_layout: String,
    max_seq_len: usize,
    num_layers: usize,
    n_local_heads: usize,
    head_dim: usize,
    num_fast_layers: usize,
    fast_head_dim: usize,
    mamba_d_conv: usize,
    mamba_d_ssm: usize,
    mamba_d_state: usize,
    mamba_d_head: usize,
    mamba_n_heads: usize,
    mamba_n_groups: usize,
}

fn default_reference_codes() -> String {
    "reference_codes.npy".to_string()
}

impl RuntimeManifest {
    fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|err| Audio8Error::Session(format!("read {}: {err}", path.display())))?;
        let manifest: Self = serde_json::from_str(&text)
            .map_err(|err| Audio8Error::Session(format!("parse {}: {err}", path.display())))?;
        manifest.verify()?;
        Ok(manifest)
    }

    /// Every dimension this runtime bakes into a fixed-shape buffer, re-checked against the
    /// export that actually landed on disk.
    fn verify(&self) -> Result<()> {
        let mut bad: Vec<String> = Vec::new();
        let mut want = |name: &str, got: String, expect: String| {
            if got != expect {
                bad.push(format!("{name}={got} (expected {expect})"));
            }
        };
        want(
            "model_fingerprint",
            self.model_fingerprint.clone(),
            MODEL_FINGERPRINT.to_string(),
        );
        want(
            "slow_logits_layout",
            self.slow_logits_layout.clone(),
            SLOW_LOGITS_LAYOUT.to_string(),
        );
        for (name, got, expect) in [
            ("sample_rate", u64::from(self.sample_rate), 44_100),
            (
                "num_codebooks",
                self.num_codebooks as u64,
                NUM_CODEBOOKS as u64,
            ),
            (
                "codebook_size",
                self.codebook_size as u64,
                CODEBOOK_SIZE as u64,
            ),
            ("max_seq_len", self.max_seq_len as u64, MAX_SEQ_LEN as u64),
            ("num_layers", self.num_layers as u64, NUM_LAYERS as u64),
            (
                "n_local_heads",
                self.n_local_heads as u64,
                N_LOCAL_HEADS as u64,
            ),
            ("head_dim", self.head_dim as u64, HEAD_DIM as u64),
            (
                "num_fast_layers",
                self.num_fast_layers as u64,
                NUM_FAST_LAYERS as u64,
            ),
            (
                "fast_head_dim",
                self.fast_head_dim as u64,
                FAST_HEAD_DIM as u64,
            ),
            (
                "mamba_d_conv",
                self.mamba_d_conv as u64,
                MAMBA_D_CONV as u64,
            ),
            ("mamba_d_ssm", self.mamba_d_ssm as u64, MAMBA_D_SSM as u64),
            (
                "mamba_d_state",
                self.mamba_d_state as u64,
                MAMBA_D_STATE as u64,
            ),
            (
                "mamba_d_head",
                self.mamba_d_head as u64,
                MAMBA_D_HEAD as u64,
            ),
            (
                "mamba_n_heads",
                self.mamba_n_heads as u64,
                MAMBA_N_HEADS as u64,
            ),
            (
                "mamba_n_groups",
                self.mamba_n_groups as u64,
                MAMBA_N_GROUPS as u64,
            ),
        ] {
            want(name, got.to_string(), expect.to_string());
        }
        for (name, got, expect) in [
            (
                "semantic_begin_id",
                self.semantic_begin_id,
                SEMANTIC_BEGIN_ID,
            ),
            ("semantic_end_id", self.semantic_end_id, SEMANTIC_END_ID),
            ("im_end_id", self.im_end_id, IM_END_ID),
        ] {
            want(name, got.to_string(), expect.to_string());
        }
        if !self.available_precisions.is_empty()
            && !self.available_precisions.iter().any(|p| p == PRECISION)
        {
            bad.push(format!(
                "available_precisions={:?} (expected to contain {PRECISION})",
                self.available_precisions
            ));
        }
        if self.reference_text.trim().is_empty() {
            bad.push("reference_text is empty".to_string());
        }
        if bad.is_empty() {
            Ok(())
        } else {
            Err(Audio8Error::Session(format!(
                "{MANIFEST_FILE} does not describe the export this runtime pins: {}",
                bad.join(", ")
            )))
        }
    }

    fn precision(&self) -> &str {
        if self.default_precision.is_empty() {
            PRECISION
        } else {
            &self.default_precision
        }
    }

    fn slow_graph(&self) -> String {
        self.slow_decode_models
            .get(self.precision())
            .cloned()
            .or_else(|| self.slow_decode_model.clone())
            .unwrap_or_else(|| format!("slow_ar_{}.onnx", self.precision()))
    }

    fn fast_graph(&self) -> String {
        self.fast_models
            .get(self.precision())
            .cloned()
            .or_else(|| self.fast_model.clone())
            .unwrap_or_else(|| format!("fast_ar_{}.onnx", self.precision()))
    }

    fn codec_graph(&self) -> String {
        let precision = self
            .default_codec_precision
            .as_deref()
            .unwrap_or(CODEC_PRECISION);
        self.codec_models
            .get(precision)
            .cloned()
            .unwrap_or_else(|| format!("codec_decoder_{precision}.onnx"))
    }
}

// ── packaged reference voice ────────────────────────────────────────────────────

/// The repo's bundled voice: `reference_codes.npy` (`[10, T]`, codebook-major) plus the
/// transcript of the clip it was encoded from. Upstream materialises the identical pair as
/// `voices/default/{codes.npy,meta.json}` via `scripts/register_default_voice.py`; WinSTT
/// reads the shipped files directly since it registers no extra voices.
struct Reference {
    text: String,
    /// `[10][frames]`, values `0..4096`.
    codes: Vec<Vec<i64>>,
}

impl Reference {
    fn frames(&self) -> usize {
        self.codes.first().map_or(0, Vec::len)
    }
}

/// Minimal `.npy` reader for the one array this engine loads: a C-order 2-D signed
/// little-endian integer matrix. A crate for a 128-byte header would be a larger surface
/// than the parser itself, and every failure mode below is a corrupt or unexpected download
/// that must be reported rather than guessed at.
///
/// Deliberately not shared with `stt/families/aed/audio8.rs`'s reader: that one accepts ONLY
/// `<f4` and speaks `SttResult`, so unifying them would mean widening a narrow dtype gate and
/// coupling the two subsystems for forty lines.
fn read_npy_i64_2d(path: &Path) -> Result<Vec<Vec<i64>>> {
    let raw = std::fs::read(path)
        .map_err(|err| Audio8Error::Reference(format!("read {}: {err}", path.display())))?;
    let bad = |message: String| Audio8Error::Reference(format!("{}: {message}", path.display()));
    if raw.len() < 10 || &raw[..6] != b"\x93NUMPY" {
        return Err(bad("not a .npy file".into()));
    }
    let (header_len, body_start) = match raw[6] {
        1 => (usize::from(u16::from_le_bytes([raw[8], raw[9]])), 10),
        2..=3 => {
            if raw.len() < 12 {
                return Err(bad("truncated .npy header".into()));
            }
            (
                u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize,
                12,
            )
        }
        other => return Err(bad(format!(".npy format version {other} is unsupported"))),
    };
    let data_start = body_start + header_len;
    if raw.len() < data_start {
        return Err(bad("truncated .npy header".into()));
    }
    let header = String::from_utf8_lossy(&raw[body_start..data_start]).into_owned();

    let descr = npy_field(&header, "descr").ok_or_else(|| bad("no descr in header".into()))?;
    let width = match descr.as_str() {
        "<i8" | "|i8" => 8usize,
        "<i4" | "|i4" => 4,
        other => {
            return Err(bad(format!(
                "dtype {other} is not a little-endian int32/int64"
            )));
        }
    };
    if npy_field(&header, "fortran_order").as_deref() != Some("False") {
        return Err(bad("Fortran-ordered .npy is unsupported".into()));
    }
    let shape = npy_shape(&header).ok_or_else(|| bad("no shape in header".into()))?;
    let [rows, cols] = shape[..] else {
        return Err(bad(format!("expected a 2-D array, got {shape:?}")));
    };
    if raw.len() - data_start < rows * cols * width {
        return Err(bad(format!(
            "{} payload bytes for a [{rows}, {cols}] {descr} array",
            raw.len() - data_start
        )));
    }

    let mut out = vec![Vec::with_capacity(cols); rows];
    for (row, target) in out.iter_mut().enumerate() {
        for col in 0..cols {
            let at = data_start + (row * cols + col) * width;
            target.push(if width == 8 {
                i64::from_le_bytes(raw[at..at + 8].try_into().unwrap_or_default())
            } else {
                i64::from(i32::from_le_bytes(
                    raw[at..at + 4].try_into().unwrap_or_default(),
                ))
            });
        }
    }
    Ok(out)
}

/// `'name': <value>` out of the numpy header dict, unquoted if it was quoted.
fn npy_field(header: &str, name: &str) -> Option<String> {
    let rest = header.split_once(&format!("'{name}':"))?.1.trim_start();
    let value = match rest.as_bytes().first()? {
        quote @ (b'\'' | b'"') => rest[1..].split(char::from(*quote)).next()?,
        _ => rest.split([',', '}']).next()?.trim(),
    };
    Some(value.to_string())
}

fn npy_shape(header: &str) -> Option<Vec<usize>> {
    let rest = header.split_once("'shape':")?.1.trim_start();
    let inner = rest.strip_prefix('(')?.split(')').next()?;
    inner
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<usize>().ok())
        .collect()
}

// ── prompt builder (upstream `prompt.py`) ───────────────────────────────────────

/// Upstream `_CJK_RANGES`. Used only to decide whether a line break BETWEEN two CJK
/// characters is a real separator (it is not — CJK does not space its words, so a wrapped
/// line must be rejoined with nothing rather than with a space).
const CJK_RANGES: &[(char, char)] = &[
    ('\u{1100}', '\u{11ff}'),
    ('\u{2e80}', '\u{2fdf}'),
    ('\u{3000}', '\u{303f}'),
    ('\u{3040}', '\u{30ff}'),
    ('\u{3100}', '\u{31ff}'),
    ('\u{3400}', '\u{4dbf}'),
    ('\u{4e00}', '\u{9fff}'),
    ('\u{a960}', '\u{a97f}'),
    ('\u{ac00}', '\u{d7a3}'),
    ('\u{d7b0}', '\u{d7ff}'),
    ('\u{f900}', '\u{faff}'),
    ('\u{fe30}', '\u{fe4f}'),
    ('\u{ff01}', '\u{ff9f}'),
    ('\u{20000}', '\u{2fa1f}'),
];

fn is_cjk(ch: char) -> bool {
    CJK_RANGES.iter().any(|&(lo, hi)| ch >= lo && ch <= hi)
}

/// Python's `str.isspace()`, which — unlike Rust's `char::is_whitespace` — also counts the
/// four ASCII information separators.
fn py_is_space(ch: char) -> bool {
    ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
}

/// Upstream `_LINE_BREAK_RE`.
fn is_line_break(ch: char) -> bool {
    matches!(
        ch,
        '\r' | '\n' | '\u{b}' | '\u{c}' | '\u{1c}'..='\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

/// Non-whitespace characters in Unicode general category `C*`, which upstream's `clean_text`
/// drops before collapsing whitespace. `char::is_control` is only `Cc`, so the `Cf` (format)
/// and `Co` (private use) ranges are listed explicitly — those are the ones that actually
/// turn up in pasted text (BOM, zero-width joiners, bidi overrides) and that would otherwise
/// tokenise into audible junk. `Cn` (unassigned) needs the full Unicode tables and is not
/// worth a dependency; an unassigned codepoint reaching TTS costs at worst one stray token.
const FORMAT_RANGES: &[(char, char)] = &[
    ('\u{ad}', '\u{ad}'),
    ('\u{600}', '\u{605}'),
    ('\u{61c}', '\u{61c}'),
    ('\u{6dd}', '\u{6dd}'),
    ('\u{70f}', '\u{70f}'),
    ('\u{890}', '\u{891}'),
    ('\u{8e2}', '\u{8e2}'),
    ('\u{180e}', '\u{180e}'),
    ('\u{200b}', '\u{200f}'),
    ('\u{202a}', '\u{202e}'),
    ('\u{2060}', '\u{2064}'),
    ('\u{2066}', '\u{206f}'),
    ('\u{e000}', '\u{f8ff}'),
    ('\u{feff}', '\u{feff}'),
    ('\u{fff9}', '\u{fffb}'),
    ('\u{110bd}', '\u{110bd}'),
    ('\u{110cd}', '\u{110cd}'),
    ('\u{13430}', '\u{1343f}'),
    ('\u{1bca0}', '\u{1bca3}'),
    ('\u{1d173}', '\u{1d17a}'),
    ('\u{e0001}', '\u{e0001}'),
    ('\u{e0020}', '\u{e007f}'),
    ('\u{f0000}', '\u{ffffd}'),
    ('\u{100000}', '\u{10fffd}'),
];

fn is_discarded_control(ch: char) -> bool {
    if py_is_space(ch) {
        return false;
    }
    ch.is_control() || FORMAT_RANGES.iter().any(|&(lo, hi)| ch >= lo && ch <= hi)
}

/// Upstream `clean_text`: drop category-`C` characters, then collapse every whitespace run to
/// a single space — except a run that contains a line break and sits between two CJK
/// characters, which collapses to nothing.
fn clean_text(text: &str) -> String {
    let kept: Vec<char> = text
        .chars()
        .filter(|&ch| !is_discarded_control(ch))
        .collect();
    let mut out = String::with_capacity(kept.len());
    let mut index = 0;
    while index < kept.len() {
        let ch = kept[index];
        if !py_is_space(ch) {
            out.push(ch);
            index += 1;
            continue;
        }
        let start = index;
        while index < kept.len() && py_is_space(kept[index]) {
            index += 1;
        }
        let joins_cjk = kept[start..index].iter().copied().any(is_line_break)
            && start > 0
            && is_cjk(kept[start - 1])
            && kept.get(index).copied().is_some_and(is_cjk);
        if !joins_cjk {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

/// Upstream `format_reference_text`: prepend `<|speaker:0|>` unless the transcript already
/// carries a speaker tag.
fn format_reference_text(text: &str) -> String {
    let cleaned = clean_text(text);
    if has_speaker_tag(&cleaned) {
        cleaned
    } else {
        format!("<|speaker:0|>{cleaned}")
    }
}

/// Upstream's `<\|speaker:\d+\|>` probe, without a regex dependency.
fn has_speaker_tag(text: &str) -> bool {
    text.match_indices("<|speaker:").any(|(at, _)| {
        let rest = &text[at + "<|speaker:".len()..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && rest[digits..].starts_with("|>")
    })
}

/// Assemble the packed `[1, 11, L]` prompt: row 0 is `prefix ++ (reference codebook 0 lifted
/// into semantic-id space) ++ suffix`, and rows 1..=10 carry the raw reference codes aligned
/// under that middle span (zero elsewhere).
///
/// Split out of [`Audio8Preview01Engine::build_prompt`] so the packing is testable without a
/// 5.8 MB tokenizer on disk.
fn pack_prompt(prefix: &[i64], suffix: &[i64], reference: &Reference) -> Result<Array3<i64>> {
    let frames = reference.frames();
    if reference.codes.len() != NUM_CODEBOOKS || frames == 0 {
        return Err(Audio8Error::Reference(format!(
            "reference codes must be [{NUM_CODEBOOKS}, T>0], got [{}, {frames}]",
            reference.codes.len()
        )));
    }
    if reference.codes.iter().any(|row| {
        row.len() != frames || row.iter().any(|&c| !(0..CODEBOOK_SIZE as i64).contains(&c))
    }) {
        return Err(Audio8Error::Reference(format!(
            "reference codes must be rectangular with values in 0..{CODEBOOK_SIZE}"
        )));
    }
    let len = prefix.len() + frames + suffix.len();
    if len >= MAX_SEQ_LEN {
        return Err(Audio8Error::Inference(format!(
            "prompt length {len} exceeds max sequence length {MAX_SEQ_LEN} \
             (reference {frames} frames + text)"
        )));
    }
    let mut values = Array3::<i64>::zeros((1, NUM_CODEBOOKS + 1, len));
    for (index, &token) in prefix.iter().enumerate() {
        values[(0, 0, index)] = token;
    }
    for (index, &code) in reference.codes[0].iter().enumerate() {
        values[(0, 0, prefix.len() + index)] = code + SEMANTIC_BEGIN_ID;
    }
    for (index, &token) in suffix.iter().enumerate() {
        values[(0, 0, prefix.len() + frames + index)] = token;
    }
    for (row, codes) in reference.codes.iter().enumerate() {
        for (index, &code) in codes.iter().enumerate() {
            values[(0, row + 1, prefix.len() + index)] = code;
        }
    }
    Ok(values)
}

// ── recurrent state ─────────────────────────────────────────────────────────────

/// The slow graph's whole carried state. The attention cache is a single stacked
/// `[layers, 1, heads, seq, dim]` tensor (not 0.6B's per-layer list), and the Falcon-H1
/// Mamba half adds the convolution window and SSM state, which the graph returns whole
/// rather than as a delta.
struct SlowState {
    keys: ArrayD<f32>,
    values: ArrayD<f32>,
    conv: ArrayD<f32>,
    ssm: ArrayD<f32>,
}

impl SlowState {
    fn new() -> Self {
        let kv = IxDyn(&[NUM_LAYERS, 1, N_LOCAL_HEADS, MAX_SEQ_LEN, HEAD_DIM]);
        Self {
            keys: ArrayD::zeros(kv.clone()),
            values: ArrayD::zeros(kv),
            conv: ArrayD::zeros(IxDyn(&[NUM_LAYERS, 1, CONV_CHANNELS, MAMBA_D_CONV])),
            ssm: ArrayD::zeros(IxDyn(&[
                NUM_LAYERS,
                1,
                MAMBA_N_HEADS,
                MAMBA_D_HEAD,
                MAMBA_D_STATE,
            ])),
        }
    }

    /// Write one column of the attention cache. The graph SQUEEZES the sequence axis out of
    /// its delta (`[24, 1, 2, 64]`), so it is re-inserted before the assignment — upstream
    /// gets that for free from numpy's `cache[:, :, :, position, :] = delta`.
    fn apply_delta(&mut self, delta: ArrayD<f32>, position: usize, values: bool) -> Result<()> {
        const EXPECTED: [usize; 4] = [NUM_LAYERS, 1, N_LOCAL_HEADS, HEAD_DIM];
        if delta.shape() != EXPECTED {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B slow KV delta shape {:?}, expected {EXPECTED:?}",
                delta.shape()
            )));
        }
        if position >= MAX_SEQ_LEN {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B cache position {position} exceeds {MAX_SEQ_LEN}"
            )));
        }
        let target = if values {
            &mut self.values
        } else {
            &mut self.keys
        };
        target
            .slice_mut(ndarray::s![.., .., .., position..position + 1, ..])
            .assign(&delta.insert_axis(Axis(3)));
        Ok(())
    }

    fn replace_mamba(&mut self, conv: ArrayD<f32>, ssm: ArrayD<f32>) -> Result<()> {
        if conv.shape() != self.conv.shape() || ssm.shape() != self.ssm.shape() {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B Mamba state shapes {:?}/{:?}, expected {:?}/{:?}",
                conv.shape(),
                ssm.shape(),
                self.conv.shape(),
                self.ssm.shape()
            )));
        }
        self.conv = conv;
        self.ssm = ssm;
        Ok(())
    }
}

/// The fast graph keeps ONE `[1, heads, codebooks, dim]` cache per layer per side, fed and
/// returned under individually numbered names. It spans a single frame's ten codebook steps,
/// so it is wiped (not grown) per frame.
struct FastState {
    keys: [ArrayD<f32>; NUM_FAST_LAYERS],
    values: [ArrayD<f32>; NUM_FAST_LAYERS],
}

impl FastState {
    fn new() -> Self {
        let empty = || {
            std::array::from_fn(|_| {
                ArrayD::zeros(IxDyn(&[1, N_LOCAL_HEADS, NUM_CODEBOOKS, FAST_HEAD_DIM]))
            })
        };
        Self {
            keys: empty(),
            values: empty(),
        }
    }

    fn reset(&mut self) {
        for buffer in self.keys.iter_mut().chain(self.values.iter_mut()) {
            buffer.fill(0.0);
        }
    }

    fn apply_delta(
        &mut self,
        layer: usize,
        delta: &ArrayD<f32>,
        position: usize,
        values: bool,
    ) -> Result<()> {
        const EXPECTED: [usize; 4] = [1, N_LOCAL_HEADS, 1, FAST_HEAD_DIM];
        if delta.shape() != EXPECTED {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B fast KV delta shape {:?}, expected {EXPECTED:?}",
                delta.shape()
            )));
        }
        if position >= NUM_CODEBOOKS {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B fast position {position} exceeds {NUM_CODEBOOKS}"
            )));
        }
        let side = if values {
            &mut self.values
        } else {
            &mut self.keys
        };
        let target = side.get_mut(layer).ok_or_else(|| {
            Audio8Error::Inference(format!("Audio8 0.1B fast layer {layer} is out of range"))
        })?;
        target
            .slice_mut(ndarray::s![.., .., position..position + 1, ..])
            .assign(delta);
        Ok(())
    }
}

// ── engine ──────────────────────────────────────────────────────────────────────

pub struct Audio8Preview01Engine {
    slow: Session,
    fast: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    reference: Reference,
}

impl Audio8Preview01Engine {
    /// Load from the model cache directory, laid out exactly as
    /// `hf download Audio8/audio8-TTS-0.1B-ONNX-INT8 --local-dir model` leaves it.
    pub fn load(dir: &Path) -> Result<Self> {
        let manifest = RuntimeManifest::load(&dir.join(MANIFEST_FILE))?;
        let threads = intra_op_threads();
        let session = |name: String, tag: &'static str| -> Result<Session> {
            cpu_session_with_intra_threads(
                &dir.join(&name),
                "the Audio8 0.1B INT8 export is CPU-only upstream",
                tag,
                threads,
            )
            .map_err(Audio8Error::Session)
        };
        let slow = session(manifest.slow_graph(), "audio8-0.1b-slow")?;
        let fast = session(manifest.fast_graph(), "audio8-0.1b-fast")?;
        let decoder = session(manifest.codec_graph(), "audio8-0.1b-codec")?;

        let tokenizer_path = dir.join(TOKENIZER_FILE);
        let tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|err| {
            Audio8Error::Tokenizer(format!("load {}: {err}", tokenizer_path.display()))
        })?;

        let reference = Reference {
            text: manifest.reference_text.clone(),
            codes: read_npy_i64_2d(&dir.join(&manifest.reference_codes))?,
        };
        // Validated once here rather than per sentence: the packaged voice never changes, so
        // a bad download should fail the load, not the first synthesis.
        pack_prompt(&[], &[], &reference)?;
        log::debug!(
            "[tts] audio8 0.1B loaded ({} reference frames, {threads} intra-op threads)",
            reference.frames()
        );
        Ok(Self {
            slow,
            fast,
            decoder,
            tokenizer,
            reference,
        })
    }

    /// Non-graph files a complete install must contain, relative to the model cache dir.
    /// Mirrors the download manifest so a partially-fetched cache is reported before ORT
    /// tries to map a missing external-data sidecar.
    pub fn required_files() -> [PathBuf; 3] {
        [
            PathBuf::from(MANIFEST_FILE),
            PathBuf::from(TOKENIZER_FILE),
            PathBuf::from(default_reference_codes()),
        ]
    }

    fn encode(&self, part: &str) -> Result<Vec<i64>> {
        Ok(self
            .tokenizer
            .encode(part, false)
            .map_err(|err| Audio8Error::Tokenizer(format!("encode: {err}")))?
            .get_ids()
            .iter()
            .map(|&id| i64::from(id))
            .collect())
    }

    /// Upstream `PromptBuilder.build`. Each part is encoded SEPARATELY, exactly as upstream
    /// does — a joined string would merge tokens across the part boundaries and shift the
    /// whole prompt.
    fn build_prompt(&self, target_text: &str) -> Result<Array3<i64>> {
        let target = clean_text(target_text);
        if target.is_empty() {
            return Err(Audio8Error::Inference("text must not be empty".into()));
        }
        let prefix_parts = [
            "<|im_start|>system\n".to_string(),
            "convert the provided text to speech reference to the following:\n\nText:\n"
                .to_string(),
            format_reference_text(&self.reference.text),
            "\n\nSpeech:\n".to_string(),
        ];
        let suffix_parts = [
            "<|im_end|>\n".to_string(),
            "<|im_start|>user\n".to_string(),
            target,
            "<|im_end|>\n".to_string(),
            "<|im_start|>assistant\n<|voice|>".to_string(),
        ];
        let mut prefix: Vec<i64> = Vec::new();
        for part in &prefix_parts {
            prefix.extend(self.encode(part)?);
        }
        let mut suffix: Vec<i64> = Vec::new();
        for part in &suffix_parts {
            suffix.extend(self.encode(part)?);
        }
        pack_prompt(&prefix, &suffix, &self.reference)
    }

    /// One slow-AR position. Returns the semantic logit row and the `[1, 1, 512]` hidden
    /// state the fast AR conditions on.
    fn slow_step(
        &mut self,
        column: &Array3<i64>,
        position: usize,
        state: &mut SlowState,
    ) -> Result<(Vec<f64>, Array3<f32>)> {
        let inputs = vec![
            (
                Cow::Borrowed("codes"),
                TensorRef::from_array_view(column.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("codes: {err}")))?,
            ),
            (
                Cow::Borrowed("position"),
                Tensor::from_array(Array1::from_vec(vec![position as i64]))
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("position: {err}")))?,
            ),
            (
                Cow::Borrowed("cache_keys"),
                TensorRef::from_array_view(state.keys.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("cache_keys: {err}")))?,
            ),
            (
                Cow::Borrowed("cache_values"),
                TensorRef::from_array_view(state.values.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("cache_values: {err}")))?,
            ),
            (
                Cow::Borrowed("conv_states"),
                TensorRef::from_array_view(state.conv.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("conv_states: {err}")))?,
            ),
            (
                Cow::Borrowed("ssm_states"),
                TensorRef::from_array_view(state.ssm.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("ssm_states: {err}")))?,
            ),
        ];
        let outputs = self
            .slow
            .run(inputs)
            .map_err(|err| Audio8Error::Inference(format!("Audio8 0.1B slow AR: {err}")))?;

        let logits = extract_last_row_f64(&outputs, "logits")?;
        if logits.len() != SLOW_LOGITS_SIZE {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B slow logits row {}, expected {SLOW_LOGITS_SIZE}",
                logits.len()
            )));
        }
        let hidden = last_hidden(&extract_f32(&outputs, "hidden")?)?;
        let key_delta = extract_f32(&outputs, "key_delta")?;
        let value_delta = extract_f32(&outputs, "value_delta")?;
        let conv = extract_f32(&outputs, "next_conv_states")?;
        let ssm = extract_f32(&outputs, "next_ssm_states")?;
        drop(outputs);

        state.apply_delta(key_delta, position, false)?;
        state.apply_delta(value_delta, position, true)?;
        state.replace_mamba(conv, ssm)?;
        Ok((logits, hidden))
    }

    /// One fast-AR codebook step. `use_slow_hidden` primes the frame from the slow hidden
    /// state at position 0; later positions feed the previous codebook token instead.
    fn fast_step(
        &mut self,
        hidden: &Array3<f32>,
        token_id: i64,
        use_slow_hidden: bool,
        position: usize,
        state: &mut FastState,
    ) -> Result<Vec<f64>> {
        let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![
            (
                Cow::Borrowed("slow_hidden"),
                TensorRef::from_array_view(hidden.view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("slow_hidden: {err}")))?,
            ),
            (
                Cow::Borrowed("token_id"),
                Tensor::from_array(Array2::from_elem((1, 1), token_id))
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("token_id: {err}")))?,
            ),
            (
                Cow::Borrowed("use_slow_hidden"),
                Tensor::from_array(Array1::from_vec(vec![use_slow_hidden]))
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("use_slow_hidden: {err}")))?,
            ),
            (
                Cow::Borrowed("input_pos"),
                Tensor::from_array(Array1::from_vec(vec![position as i64]))
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("input_pos: {err}")))?,
            ),
        ];
        for (layer, (key_name, value_name)) in FAST_KEY_INPUTS
            .iter()
            .zip(FAST_VALUE_INPUTS.iter())
            .enumerate()
        {
            inputs.push((
                Cow::Borrowed(*key_name),
                TensorRef::from_array_view(state.keys[layer].view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("{key_name}: {err}")))?,
            ));
            inputs.push((
                Cow::Borrowed(*value_name),
                TensorRef::from_array_view(state.values[layer].view())
                    .map(SessionInputValue::from)
                    .map_err(|err| Audio8Error::Inference(format!("{value_name}: {err}")))?,
            ));
        }
        let outputs = self
            .fast
            .run(inputs)
            .map_err(|err| Audio8Error::Inference(format!("Audio8 0.1B fast AR: {err}")))?;

        let logits = extract_last_row_f64(&outputs, "logits")?;
        if logits.len() != CODEBOOK_SIZE {
            return Err(Audio8Error::Inference(format!(
                "Audio8 0.1B fast logits row {}, expected {CODEBOOK_SIZE}",
                logits.len()
            )));
        }
        let mut deltas = Vec::with_capacity(2 * NUM_FAST_LAYERS);
        for (key_name, value_name) in FAST_KEY_DELTAS.iter().zip(FAST_VALUE_DELTAS.iter()) {
            deltas.push(extract_f32(&outputs, key_name)?);
            deltas.push(extract_f32(&outputs, value_name)?);
        }
        drop(outputs);
        for (index, delta) in deltas.iter().enumerate() {
            state.apply_delta(index / 2, delta, position, index % 2 == 1)?;
        }
        Ok(logits)
    }

    /// Upstream `_sample_semantic`: draw from the 4096 semantic logits plus the trailing eos,
    /// with a "high temperature" re-draw whenever the normal draw repeats one of the last
    /// [`REPETITION_WINDOW`] semantic ids.
    fn sample_semantic(logits: &[f64], previous: &[i64], rng: &mut SplitMix64Rng) -> i64 {
        let to_id = |index: usize| -> i64 {
            if index < CODEBOOK_SIZE {
                SEMANTIC_BEGIN_ID + index as i64
            } else {
                IM_END_ID
            }
        };
        let normal = to_id(sample_audio8(logits, TEMPERATURE, TOP_P, TOP_K, rng));
        let high = to_id(sample_audio8(logits, 1.0, 0.9, TOP_K, rng));
        if (SEMANTIC_BEGIN_ID..=SEMANTIC_END_ID).contains(&normal) && previous.contains(&normal) {
            high
        } else {
            normal
        }
    }

    /// Generate the `[10]`-per-frame code matrix for one sentence (upstream `iter_codes`).
    fn generate_codes(&mut self, text: &str) -> Result<Vec<[i64; NUM_CODEBOOKS]>> {
        let prompt = self.build_prompt(text)?;
        let prompt_len = prompt.shape()[2];
        let max_new = MAX_NEW_TOKENS.min(MAX_SEQ_LEN - prompt_len);

        // The hybrid export is a ONE-TOKEN graph, prefill included — there is no batched
        // prefill to take here (0.6B feeds the whole prompt in a single Run; this one cannot,
        // which is why its first frame costs one Run per prompt token).
        let mut state = SlowState::new();
        let mut column = Array3::<i64>::zeros((1, NUM_CODEBOOKS + 1, 1));
        let mut logits = Vec::new();
        let mut hidden = Array3::<f32>::zeros((1, 1, HIDDEN_SIZE));
        for position in 0..prompt_len {
            column
                .slice_mut(ndarray::s![.., .., 0])
                .assign(&prompt.slice(ndarray::s![.., .., position]));
            (logits, hidden) = self.slow_step(&column, position, &mut state)?;
        }

        let mut rng = SplitMix64Rng::new(RNG_SEED);
        let mut previous: Vec<i64> = Vec::with_capacity(REPETITION_WINDOW);
        let mut frames: Vec<[i64; NUM_CODEBOOKS]> = Vec::with_capacity(max_new);
        // One fast cache for the whole sentence, wiped per frame — its only required initial
        // state is "all zeros", so re-allocating eight buffers ~21.5x per second of audio
        // would be pure waste.
        let mut fast = FastState::new();

        for step in 0..max_new {
            let semantic = Self::sample_semantic(&logits, &previous, &mut rng);
            if semantic == IM_END_ID {
                break;
            }
            previous.push(semantic);
            if previous.len() > REPETITION_WINDOW {
                previous.remove(0);
            }

            let first_code = semantic - SEMANTIC_BEGIN_ID;
            if !(0..CODEBOOK_SIZE as i64).contains(&first_code) {
                return Err(Audio8Error::Inference(format!(
                    "Audio8 0.1B semantic token {semantic} is outside the codebook range"
                )));
            }
            fast.reset();
            self.fast_step(&hidden, 0, true, 0, &mut fast)?;
            let mut frame = [0i64; NUM_CODEBOOKS];
            frame[0] = first_code;
            let mut token = first_code;
            for position in 1..NUM_CODEBOOKS {
                let fast_logits = self.fast_step(&hidden, token, false, position, &mut fast)?;
                token = sample_audio8(&fast_logits, TEMPERATURE, TOP_P, TOP_K, &mut rng) as i64;
                if let Some(slot) = frame.get_mut(position) {
                    *slot = token;
                }
            }
            frames.push(frame);
            if step + 1 >= max_new {
                break;
            }

            // Next slow column: [semantic; frame] as [1, 11, 1] at the next position.
            column.fill(0);
            column[(0, 0, 0)] = semantic;
            for (row, &code) in frame.iter().enumerate() {
                column[(0, row + 1, 0)] = code;
            }
            (logits, hidden) = self.slow_step(&column, prompt_len + step, &mut state)?;
        }
        if frames.is_empty() {
            return Err(Audio8Error::Inference(
                "Audio8 0.1B produced no codec frames".into(),
            ));
        }
        Ok(frames)
    }

    /// Decode `[10, frames]` codes to 44.1 kHz mono f32 (upstream `decode_codes`).
    fn decode_codes(&mut self, frames: &[[i64; NUM_CODEBOOKS]]) -> Result<Vec<f32>> {
        let mut codes = Array3::<i64>::zeros((1, NUM_CODEBOOKS, frames.len()));
        for (index, frame) in frames.iter().enumerate() {
            for (codebook, &code) in frame.iter().enumerate() {
                codes[(0, codebook, index)] = code;
            }
        }
        // Names captured before `run` mutably borrows the session, and read from the graph
        // rather than hard-coded so a renamed export surfaces as a session error.
        let input_name = self
            .decoder
            .inputs()
            .first()
            .map(|input| input.name().to_string())
            .ok_or_else(|| Audio8Error::Session("codec decoder declares no inputs".into()))?;
        let output_name = self
            .decoder
            .outputs()
            .first()
            .map(|output| output.name().to_string())
            .ok_or_else(|| Audio8Error::Session("codec decoder declares no outputs".into()))?;
        let tensor = Tensor::from_array(codes)
            .map_err(|err| Audio8Error::Inference(format!("codec codes: {err}")))?;
        let outputs = self
            .decoder
            .run(vec![(
                Cow::Owned(input_name),
                SessionInputValue::from(tensor),
            )])
            .map_err(|err| Audio8Error::Inference(format!("codec decoder: {err}")))?;
        let audio = extract_f32(&outputs, &output_name)?;
        Ok(audio
            .as_slice()
            .map_or_else(|| audio.iter().copied().collect(), <[f32]>::to_vec))
    }

    pub fn synthesize(&mut self, text: &str) -> Result<Vec<f32>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let frames = self.generate_codes(text)?;
        self.decode_codes(&frames)
    }
}

/// `hidden[:, -1:, :]` as a contiguous `[1, 1, 512]` — the shape the fast graph declares.
fn last_hidden(hidden: &ArrayD<f32>) -> Result<Array3<f32>> {
    if hidden.shape().last() != Some(&HIDDEN_SIZE) || hidden.len() < HIDDEN_SIZE {
        return Err(Audio8Error::Inference(format!(
            "Audio8 0.1B hidden shape {:?}, expected a trailing {HIDDEN_SIZE}",
            hidden.shape()
        )));
    }
    let flat: Vec<f32> = hidden
        .as_slice()
        .map_or_else(|| hidden.iter().copied().collect(), <[f32]>::to_vec);
    Array3::from_shape_vec(
        (1, 1, HIDDEN_SIZE),
        flat[flat.len() - HIDDEN_SIZE..].to_vec(),
    )
    .map_err(|err| Audio8Error::Inference(format!("hidden reshape: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(frames: usize) -> Reference {
        Reference {
            text: "reference".into(),
            codes: (0..NUM_CODEBOOKS)
                .map(|row| (0..frames).map(|t| ((row * 7 + t) % 4096) as i64).collect())
                .collect(),
        }
    }

    #[test]
    fn state_shapes_match_the_published_graph_contract() {
        // Asserted against upstream tests/test_contract.py, which is the authority here.
        let slow = SlowState::new();
        assert_eq!(slow.keys.shape(), &[24, 1, 2, 2048, 64]);
        assert_eq!(slow.values.shape(), &[24, 1, 2, 2048, 64]);
        assert_eq!(slow.conv.shape(), &[24, 1, 896, 4]);
        assert_eq!(slow.ssm.shape(), &[24, 1, 24, 32, 64]);
        let fast = FastState::new();
        assert_eq!(fast.keys.len(), 4);
        assert_eq!(fast.keys[0].shape(), &[1, 2, 10, 64]);
        assert_eq!(fast.values[3].shape(), &[1, 2, 10, 64]);
    }

    #[test]
    fn slow_delta_is_four_dimensional_and_lands_at_its_position() {
        // The regression this guards: the slow graph SQUEEZES the sequence axis out of its
        // delta, unlike the fast graph. A 5-D expectation silently rejects every step.
        let mut state = SlowState::new();
        let delta = ArrayD::from_elem(IxDyn(&[NUM_LAYERS, 1, N_LOCAL_HEADS, HEAD_DIM]), 2.5f32);
        state
            .apply_delta(delta, 17, false)
            .expect("write key delta");
        assert_eq!(state.keys[[3, 0, 1, 17, 5]], 2.5);
        assert_eq!(state.keys[[3, 0, 1, 16, 5]], 0.0);
        assert_eq!(state.values[[3, 0, 1, 17, 5]], 0.0);

        let wrong = ArrayD::zeros(IxDyn(&[NUM_LAYERS, 1, N_LOCAL_HEADS, 1, HEAD_DIM]));
        assert!(state.apply_delta(wrong, 0, false).is_err());
    }

    #[test]
    fn fast_deltas_are_written_per_layer() {
        let mut state = FastState::new();
        let delta = ArrayD::from_elem(IxDyn(&[1, N_LOCAL_HEADS, 1, FAST_HEAD_DIM]), 1.5f32);
        state.apply_delta(2, &delta, 4, true).expect("write value");
        assert_eq!(state.values[2][[0, 1, 4, 0]], 1.5);
        assert_eq!(state.values[1][[0, 1, 4, 0]], 0.0);
        assert_eq!(state.keys[2][[0, 1, 4, 0]], 0.0);
        state.reset();
        assert_eq!(state.values[2][[0, 1, 4, 0]], 0.0);
        assert!(state.apply_delta(2, &delta, NUM_CODEBOOKS, true).is_err());
    }

    #[test]
    fn prompt_packs_reference_codes_under_their_semantic_row() {
        let reference = reference(3);
        let prompt = pack_prompt(&[10, 11], &[20, 21, 22], &reference).expect("pack");
        assert_eq!(prompt.shape(), &[1, NUM_CODEBOOKS + 1, 8]);
        assert_eq!(prompt[(0, 0, 0)], 10);
        assert_eq!(prompt[(0, 0, 1)], 11);
        // Row 0 across the reference span is codebook 0 lifted into semantic-id space.
        for t in 0..3 {
            assert_eq!(
                prompt[(0, 0, 2 + t)],
                reference.codes[0][t] + SEMANTIC_BEGIN_ID
            );
        }
        assert_eq!(prompt[(0, 0, 5)], 20);
        assert_eq!(prompt[(0, 0, 7)], 22);
        // Rows 1..=10 carry the RAW codes, aligned under the same span and zero elsewhere.
        for (row, codes) in reference.codes.iter().enumerate() {
            for t in 0..3 {
                assert_eq!(prompt[(0, row + 1, 2 + t)], codes[t]);
            }
            assert_eq!(prompt[(0, row + 1, 0)], 0);
            assert_eq!(prompt[(0, row + 1, 5)], 0);
        }
    }

    #[test]
    fn prompt_rejects_a_reference_it_cannot_pack() {
        assert!(pack_prompt(&[1], &[1], &reference(MAX_SEQ_LEN)).is_err());
        let mut ragged = reference(4);
        ragged.codes[3].pop();
        assert!(pack_prompt(&[1], &[1], &ragged).is_err());
        let mut out_of_range = reference(4);
        out_of_range.codes[0][0] = CODEBOOK_SIZE as i64;
        assert!(pack_prompt(&[1], &[1], &out_of_range).is_err());
    }

    #[test]
    fn clean_text_collapses_whitespace_but_rejoins_wrapped_cjk() {
        assert_eq!(clean_text("  hello \t world \n"), "hello world");
        // A line break between two CJK characters is not a word separator.
        assert_eq!(clean_text("元气\n火箭"), "元气火箭");
        // A plain space between them still is — only line breaks are rejoined.
        assert_eq!(clean_text("元气 火箭"), "元气 火箭");
        // …and a break with Latin on either side stays a space.
        assert_eq!(clean_text("hello\nworld"), "hello world");
        // Category-C characters are dropped, not spaced.
        assert_eq!(clean_text("a\u{feff}b\u{200d}c"), "abc");
    }

    #[test]
    fn reference_text_gains_a_speaker_tag_exactly_once() {
        assert_eq!(format_reference_text("hi"), "<|speaker:0|>hi");
        assert_eq!(format_reference_text("<|speaker:3|>hi"), "<|speaker:3|>hi");
        // A near-miss is NOT a tag, so it still gets one.
        assert_eq!(
            format_reference_text("<|speaker:|>hi"),
            "<|speaker:0|><|speaker:|>hi"
        );
    }

    #[test]
    fn semantic_ids_span_exactly_the_codebook_and_exclude_eos() {
        assert_eq!(
            SEMANTIC_BEGIN_ID + CODEBOOK_SIZE as i64 - 1,
            SEMANTIC_END_ID
        );
        assert!(!(SEMANTIC_BEGIN_ID..=SEMANTIC_END_ID).contains(&IM_END_ID));
        assert_eq!(CONV_CHANNELS, 896);
    }

    fn npy_bytes(descr: &str, shape: &str, payload: &[u8]) -> Vec<u8> {
        let header = format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': {shape}, }}");
        let mut out = b"\x93NUMPY\x01\x00".to_vec();
        out.extend((header.len() as u16).to_le_bytes());
        out.extend(header.as_bytes());
        out.extend(payload);
        out
    }

    #[test]
    fn npy_reader_parses_a_c_order_int_matrix_and_refuses_the_rest() {
        let dir = std::env::temp_dir().join(format!("winstt-npy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("codes.npy");

        let payload: Vec<u8> = [1i64, 2, 3, 4, 5, 6]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        std::fs::write(&path, npy_bytes("<i8", "(2, 3)", &payload)).expect("write");
        assert_eq!(
            read_npy_i64_2d(&path).expect("read"),
            vec![vec![1, 2, 3], vec![4, 5, 6]]
        );

        // int32 is widened; Fortran order and other dtypes are refused rather than silently
        // transposed or reinterpreted.
        let narrow: Vec<u8> = [7i32, 8].iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(&path, npy_bytes("<i4", "(1, 2)", &narrow)).expect("write");
        assert_eq!(read_npy_i64_2d(&path).expect("read"), vec![vec![7, 8]]);

        std::fs::write(&path, npy_bytes("<f4", "(1, 2)", &narrow)).expect("write");
        assert!(read_npy_i64_2d(&path).is_err());

        let fortran = String::from_utf8_lossy(&npy_bytes("<i8", "(2, 3)", &payload))
            .replace("False", "True ")
            .into_bytes();
        std::fs::write(&path, fortran).expect("write");
        assert!(read_npy_i64_2d(&path).is_err());

        // A truncated payload must be an error, not a short read.
        std::fs::write(&path, npy_bytes("<i8", "(2, 3)", &payload[..16])).expect("write");
        assert!(read_npy_i64_2d(&path).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_verification_pins_the_published_export() {
        // Audio8's shipped runtime_manifest.json, verbatim.
        let official = r#"{
          "model_id": "Audio8/Audio8-TTS-Preview-0.1B-ONNX-INT8",
          "model_fingerprint": "audio8-tts-preview-0.1b-int8-v1",
          "default_precision": "int8", "available_precisions": ["int8"],
          "default_codec_precision": "fp16", "available_codec_precisions": ["fp16"],
          "codec_models": {"fp16": "codec_decoder_fp16.onnx"},
          "sample_rate": 44100, "codec_frame_size": 2048, "codec_hop_length": 2048,
          "num_codebooks": 10, "codebook_size": 4096,
          "semantic_begin_id": 65537, "semantic_end_id": 69632, "im_end_id": 4096,
          "slow_logits_layout": "relative_semantic_then_eos",
          "max_seq_len": 2048, "num_layers": 24, "n_local_heads": 2, "head_dim": 64,
          "num_fast_layers": 4, "fast_n_local_heads": 2, "fast_head_dim": 64,
          "mamba_chunk_size": 128, "mamba_d_conv": 4, "mamba_d_ssm": 768,
          "mamba_d_state": 64, "mamba_d_head": 32, "mamba_n_heads": 24, "mamba_n_groups": 1,
          "reference_codes": "reference_codes.npy",
          "reference_text": "至今为止，元气火箭总共发行了两张专辑。",
          "slow_decode_model": "slow_ar_int8.onnx", "fast_model": "fast_ar_int8.onnx",
          "slow_decode_models": {"int8": "slow_ar_int8.onnx"},
          "fast_models": {"int8": "fast_ar_int8.onnx"}
        }"#;
        let manifest: RuntimeManifest = serde_json::from_str(official).expect("parse");
        manifest.verify().expect("the shipped manifest must verify");
        assert_eq!(manifest.slow_graph(), "slow_ar_int8.onnx");
        assert_eq!(manifest.fast_graph(), "fast_ar_int8.onnx");
        assert_eq!(manifest.codec_graph(), "codec_decoder_fp16.onnx");
        assert_eq!(manifest.reference_codes, "reference_codes.npy");

        // A moved dimension must fail the LOAD, not corrupt the audio.
        let shifted: RuntimeManifest =
            serde_json::from_str(&official.replace("\"head_dim\": 64", "\"head_dim\": 128"))
                .expect("parse");
        let error = shifted.verify().expect_err("head_dim 128 must be rejected");
        assert!(error.to_string().contains("head_dim"), "{error}");
    }
}
