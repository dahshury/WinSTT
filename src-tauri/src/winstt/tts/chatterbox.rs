// Chatterbox (Resemble AI, MIT) voice-cloning TTS on ort 2.0 — ONE engine driving all
// three published exports: `chatterbox-multilingual`, `chatterbox-turbo`, `chatterbox-nano`.
//
// Faithful port of the verbatim onnxruntime pipelines shipped on the HF model cards
// (onnx-community/chatterbox-multilingual-ONNX; ResembleAI/chatterbox-turbo-ONNX;
// owensong/chatterbox-nano-ONNX). FOUR ort sessions:
//   1. speech_encoder      (ref wav 24k mono -> cond_emb, prompt_token, ref_x_vector, prompt_feat)  run ONCE
//   2. embed_tokens        (ids [+position+exaggeration] -> inputs_embeds)                          run EVERY step
//   3. language_model      (T3 backbone, KV-cache AR decode of S3 speech tokens)                    run EVERY step
//   4. conditional_decoder (S3Gen flow vocoder: speech_tokens + speaker cond -> 24k wav)            run ONCE
//
// AR loop: greedy argmax + repetition_penalty=1.2; START=6561 seed, STOP=6562, max 256 tokens,
// plus a degenerate-cycle cut (see `loop_cycle`) because the cap alone truncates mid-phrase.
// KV-cache convention = Optimum `past_key_values.{N}.{key|value}` -> `present.{N}.{key|value}`
// (decoder-only self-attn; present.* always carried forward — same shape pattern as whisper.rs,
// host-copy here for correctness; IoBinding optimization deferred).
//
// EXPORTS DIVERGE, so everything mechanical is INTROSPECTED off the loaded graphs rather than
// hardcoded (the three differ in layer count 30/24/12, KV heads 16/16/12, and — critically —
// KV element type):
//   * `embed_tokens` takes `position_ids`+`exaggeration` on multilingual but ONLY `input_ids`
//     on turbo/nano; `language_model` takes `position_ids` on turbo/nano but not on multilingual.
//     Both are fed from the session's declared input names.
//   * fp16/q4f16 backbones declare **float16** `past_key_values.*` (see the repos'
//     `transformers.js_config.kv_cache_dtype`). Seeding those with f32 empties is exactly the
//     "Unexpected input data type" break the Cohere fp16 decoder hit, so the KV element type is
//     read off the graph and the cache is carried in that dtype.
// The two genuinely editorial differences (language tag, trailing silence tokens) are config.
//
// Zero-shot cloning: a reference WAV (no transcript) -> speech_encoder. A bundled default voice is
// used when none is supplied. EN-first: multilingual prepends the `[en]` language tag (turbo/nano
// are English-only and take raw text); per-language CJK/he frontends are deferred.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use half::f16;
use ndarray::{Array1, Array2, Array3, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::provider::LazyOrtEngine;
use super::splitter::{DEFAULT_MAX_SENTENCE_LEN, split_sentences};

pub const CHATTERBOX_SAMPLE_RATE: u32 = 24_000;
const START_SPEECH_TOKEN: i64 = 6561;
const STOP_SPEECH_TOKEN: i64 = 6562;
/// Trailing-silence codec token appended by the turbo/nano recipes so the vocoder
/// resolves the final phoneme instead of cutting it off (`SILENCE_TOKEN` in both
/// reference scripts).
const SILENCE_SPEECH_TOKEN: i64 = 4299;
const MAX_NEW_TOKENS: usize = 256;
const REPETITION_PENALTY: f32 = 1.2;
const DEFAULT_EXAGGERATION: f32 = 0.5;

/// Longest cycle [`loop_cycle`] will look for, in speech tokens. S3 codec tokens run at
/// 25 Hz (1 token = 40 ms — measured: 255 tokens → 10.32 s), so the runaway that motivates
/// this detector is a repeated *clause* of roughly 25-60 tokens, an order of magnitude
/// longer than the 1-4 frame buzz `orpheus::loop_cycle` looks for. 64 tokens ≈ 2.6 s.
const LOOP_MAX_PERIOD_TOKENS: usize = 64;
/// A cycle must repeat back-to-back at least this many times before it is called a loop.
/// Two byte-identical copies of a ≥16-token span is already something a neural codec never
/// produces from distinct speech — the same 0.64 s of acoustics, frame for frame.
const LOOP_MIN_CYCLES: usize = 2;
/// …and the repeating tail must span at least this many tokens (1.28 s at 25 Hz), so SHORT
/// periods need proportionally MORE copies: 32 of a single token, 16 of a pair, 4 of an
/// 8-token span, 2 of anything ≥ 16. Sustained phonemes and pauses legitimately repeat codec
/// tokens for a few hundred ms; 1.28 s of *exact* repetition is pathological. This is ~2x
/// more conservative than the 0.68 s the shipped Orpheus cut already uses. (The drift budget
/// below lets a *near*-constant run fire a couple of tokens early — the effective floor is
/// ~1.2 s, not exactly 1.28 s; pinned by `loop_cycle_boundary_is_the_min_span`.)
const LOOP_MIN_SPAN_TOKENS: usize = 32;
/// Per-copy drift budget: `period / LOOP_DRIFT_DEN` token positions may differ from the first
/// copy of the cycle. A backbone looping on a *phrase* re-renders it with slightly different
/// prosody, so the copies are near-identical rather than bit-identical; requiring ≥ 87.5%
/// agreement over ≥ 16 tokens still cannot fire on real speech (a 6,561-entry codebook makes
/// even 50% agreement between two distinct spans astronomically unlikely), while periods
/// under 8 tokens fall back to exact equality (`period / 8 == 0`).
const LOOP_DRIFT_DEN: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum ChatterboxError {
    #[error("chatterbox assets missing: {0}")]
    AssetsMissing(String),
    #[error("chatterbox session error: {0}")]
    Session(String),
    #[error("chatterbox tokenizer error: {0}")]
    Tokenizer(String),
    #[error("chatterbox audio error: {0}")]
    Audio(String),
    #[error("chatterbox inference error: {0}")]
    Inference(String),
}
pub type ChatterboxResult<T> = Result<T, ChatterboxError>;

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

/// The four ONNX graph filenames under `onnx/`. Every Chatterbox export picks its own
/// quant suffix PER GRAPH — nano genuinely MIXES them (`conditional_decoder_q4` +
/// `embed_tokens_fp16` + `language_model_q4f16` + `speech_encoder_q4f16`) — so one
/// global suffix cannot address a model. `catalog::chatterbox_graph_set` is the SINGLE
/// place the per-model/per-quant names are decided (shared with the downloader), and
/// production only ever reaches this struct through `ChatterboxLocalEngine::new`.
///
/// Deliberately NO `Default`: a hardcoded fallback set here (it used to name
/// `language_model_q4.onnx`) is a second source of truth that points at a stale or
/// missing file the moment the catalog re-quantizes a rung, and nothing can construct
/// this type without asking the catalog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatterboxGraphs {
    pub speech_encoder: String,
    pub embed_tokens: String,
    pub language_model: String,
    pub conditional_decoder: String,
}

#[derive(Clone, Debug)]
pub struct ChatterboxConfig {
    /// Holds `onnx/<graph>.onnx` (+ `.onnx_data`), `tokenizer.json`, `default_voice.wav`.
    pub cache_dir: PathBuf,
    /// Per-graph quant filenames (see [`ChatterboxGraphs`]).
    pub graphs: ChatterboxGraphs,
    /// Language tag prepended to the prompt as `[<tag>]` — the multilingual export's
    /// EN-first frontend. `None` for the English-only turbo/nano exports, whose
    /// reference scripts tokenize the raw text.
    pub language_tag: Option<String>,
    /// Codec tokens of silence appended after the generated speech tokens. The
    /// turbo/nano recipes append 3; multilingual appends none.
    pub trailing_silence_tokens: usize,
    /// Attenuate reference clips hotter than [`REF_PEAK_GATE`] down to
    /// [`REF_PEAK_TARGET`] before conditioning. See [`attenuate_hot_reference`]
    /// for the measurements. ONLY the multilingual export wants this: turbo
    /// regressed on it (`shells` 0.000 -> 0.214) and nano was unchanged, so both
    /// keep their bit-identical reference path.
    pub attenuate_hot_reference: bool,
}
impl ChatterboxConfig {
    fn onnx(&self, name: &str) -> PathBuf {
        self.cache_dir.join("onnx").join(name)
    }
    pub fn tokenizer_path(&self) -> PathBuf {
        self.cache_dir.join("tokenizer.json")
    }
    pub fn default_voice_path(&self) -> PathBuf {
        self.cache_dir.join("default_voice.wav")
    }
    pub fn assets_present(&self) -> bool {
        self.onnx(&self.graphs.speech_encoder).exists()
            && self.onnx(&self.graphs.embed_tokens).exists()
            && self.onnx(&self.graphs.language_model).exists()
            && self.onnx(&self.graphs.conditional_decoder).exists()
            && self.tokenizer_path().exists()
    }
}

/// KV-cache element type declared by the backbone's `past_key_values.*` inputs.
/// fp32/q4 exports declare f32; the fp16/q4f16 exports declare **float16** (the
/// repos' `transformers.js_config.kv_cache_dtype`). Never assumed — see the module
/// header for why (Cohere's fp16 decoder crashed on exactly this).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KvDtype {
    F32,
    F16,
}

/// One layer's carried K or V, held in the graph's own element type so it can be
/// fed straight back without a lossy round-trip through f32.
enum KvValue {
    F32(ArrayD<f32>),
    F16(ArrayD<f16>),
}

impl KvValue {
    /// A `[1, heads, 0, head_dim]` empty for the AR prefill step.
    fn empty(dtype: KvDtype, heads: usize, head_dim: usize) -> ChatterboxResult<Self> {
        let shape = IxDyn(&[1, heads, 0, head_dim]);
        Ok(match dtype {
            KvDtype::F32 => Self::F32(
                ArrayD::from_shape_vec(shape, Vec::new())
                    .map_err(|e| ChatterboxError::Inference(format!("empty kv: {e}")))?,
            ),
            KvDtype::F16 => Self::F16(
                ArrayD::from_shape_vec(shape, Vec::new())
                    .map_err(|e| ChatterboxError::Inference(format!("empty kv: {e}")))?,
            ),
        })
    }

    /// Take the matching `present.*` output verbatim (no dtype conversion).
    fn from_output(
        outputs: &ort::session::SessionOutputs<'_>,
        name: &str,
        dtype: KvDtype,
    ) -> ChatterboxResult<Self> {
        Ok(match dtype {
            KvDtype::F32 => Self::F32(extract_f32(outputs, name)?),
            KvDtype::F16 => Self::F16(extract_typed::<f16>(outputs, name)?),
        })
    }

    fn into_input(self) -> ChatterboxResult<SessionInputValue<'static>> {
        match self {
            Self::F32(a) => Tensor::from_array(a)
                .map(SessionInputValue::from)
                .map_err(|e| ChatterboxError::Inference(format!("kv tensor: {e}"))),
            Self::F16(a) => Tensor::from_array(a)
                .map(SessionInputValue::from)
                .map_err(|e| ChatterboxError::Inference(format!("kv tensor: {e}"))),
        }
    }
}

/// Everything about the backbone's KV cache that varies per export: names, the
/// `[1, heads, 0, head_dim]` empty shape, and the element type. All introspected.
struct KvSpec {
    past_names: Vec<String>,
    present_names: Vec<String>,
    heads: usize,
    head_dim: usize,
    dtype: KvDtype,
}

struct Loaded {
    speech_encoder: Session,
    embed_tokens: Session,
    language_model: Session,
    conditional_decoder: Session,
    tokenizer: Tokenizer,
    kv: KvSpec,
    /// `embed_tokens` declares `position_ids` (multilingual) or only `input_ids`
    /// (turbo/nano).
    embed_wants_position_ids: bool,
    /// `embed_tokens` declares the `exaggeration` scalar (multilingual only).
    embed_wants_exaggeration: bool,
    /// `language_model` declares `position_ids` (turbo/nano) — multilingual derives
    /// positions inside `embed_tokens` instead.
    lm_wants_position_ids: bool,
    /// Single-slot cache of the reference-voice conditioning (`speech_encoder`
    /// over the whole reference WAV — by far the most expensive fixed cost).
    /// Keyed by (path, mtime) so a multi-sentence read runs the encoder ONCE
    /// and an edited reference clip still re-encodes. Dropped with the session.
    ref_cond: Option<RefCondCacheEntry>,
}

/// Cached `speech_encoder` outputs for one reference clip.
struct RefConditioning {
    cond_emb: ArrayD<f32>,
    prompt_token: ArrayD<i64>,
    ref_x_vector: ArrayD<f32>,
    prompt_feat: ArrayD<f32>,
}

struct RefCondCacheEntry {
    path: PathBuf,
    mtime: Option<std::time::SystemTime>,
    cond: std::sync::Arc<RefConditioning>,
}

pub struct ChatterboxEngine {
    config: ChatterboxConfig,
    inner: LazyOrtEngine<Loaded>,
}

impl ChatterboxEngine {
    pub fn new(config: ChatterboxConfig) -> Self {
        Self {
            config,
            inner: LazyOrtEngine::new(),
        }
    }
    pub fn is_ready(&self) -> bool {
        self.inner.is_ready()
    }

    pub fn warm_up(&self) -> ChatterboxResult<()> {
        self.inner.warm_up(
            || ChatterboxError::Session("lock poisoned".into()),
            || self.load(),
        )
    }

    fn load(&self) -> ChatterboxResult<Loaded> {
        if !self.config.assets_present() {
            return Err(ChatterboxError::AssetsMissing(format!(
                "expected 4 onnx graphs + tokenizer under {}",
                self.config.cache_dir.display()
            )));
        }
        let graphs = &self.config.graphs;
        let speech_encoder = build_session(&self.config.onnx(&graphs.speech_encoder))?;
        let embed_tokens = build_session(&self.config.onnx(&graphs.embed_tokens))?;
        let language_model = build_session(&self.config.onnx(&graphs.language_model))?;
        let conditional_decoder = build_session(&self.config.onnx(&graphs.conditional_decoder))?;
        let tokenizer = Tokenizer::from_file(self.config.tokenizer_path())
            .map_err(|e| ChatterboxError::Tokenizer(e.to_string()))?;
        let kv = introspect_kv(&language_model)?;
        Ok(Loaded {
            embed_wants_position_ids: declares_input(&embed_tokens, "position_ids"),
            embed_wants_exaggeration: declares_input(&embed_tokens, "exaggeration"),
            lm_wants_position_ids: declares_input(&language_model, "position_ids"),
            speech_encoder,
            embed_tokens,
            language_model,
            conditional_decoder,
            tokenizer,
            kv,
            ref_cond: None,
        })
    }

    /// Synthesize `text` (English) in the voice of `ref_wav` (or the bundled default
    /// when None). Returns mono f32 PCM @ 24 kHz.
    ///
    /// `text` is re-split into sentence chunks (see [`synthesis_chunks`]) — a no-op for
    /// the one-sentence-at-a-time path `service.rs` drives, and the guard that keeps a
    /// paragraph handed straight to this method from wedging the backbone.
    pub fn synthesize(
        &self,
        text: &str,
        ref_wav: Option<&Path>,
        exaggeration: f32,
    ) -> ChatterboxResult<Vec<f32>> {
        let chunks = synthesis_chunks(text);
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        // --- reference conditioning (cached per clip; see RefCondCacheEntry) ---
        let ref_path =
            ref_wav.map_or_else(|| self.config.default_voice_path(), |p| p.to_path_buf());
        let exaggeration = if exaggeration.is_finite() {
            exaggeration.clamp(0.0, 1.0)
        } else {
            DEFAULT_EXAGGERATION
        };
        self.inner.with_loaded(
            || ChatterboxError::Session("lock poisoned".into()),
            || ChatterboxError::Session("chatterbox session was not initialized".into()),
            || self.load(),
            |loaded| {
                let mut out: Vec<f32> = Vec::new();
                for chunk in &chunks {
                    let Some((ids, position_ids)) =
                        encode_prompt(loaded, self.config.language_tag.as_deref(), chunk)?
                    else {
                        continue; // chunk tokenized to nothing (punctuation-only)
                    };
                    out.extend(run_pipeline(
                        loaded,
                        &ids,
                        &position_ids,
                        &ref_path,
                        exaggeration,
                        self.config.trailing_silence_tokens,
                        self.config.attenuate_hot_reference,
                    )?);
                }
                Ok(out)
            },
        )
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

/// Split one `synthesize` call into the sentence-sized chunks this backbone can actually
/// finish, using the SAME splitter (and the same 240-char cap) `service.rs` applies before
/// it ever gets here — so the shipping one-sentence-per-call path is bit-identical.
///
/// The engine must not *depend* on that caller: handed `"Hello. The quick brown fox …"` in
/// one call, the T3 backbone reads the first sentence and then runs away — measured 255
/// tokens / 10.2 s of audio that transcribes as just `"Hello."`. Splitting here bounds every
/// backbone run to one sentence, and blank input yields no chunks at all.
fn synthesis_chunks(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let chunks = split_sentences(trimmed, DEFAULT_MAX_SENTENCE_LEN);
    if chunks.is_empty() {
        // `split_sentences` only returns [] for blank input, which is already handled —
        // but never let a non-blank prompt fall through as silence.
        return vec![trimmed.to_string()];
    }
    chunks
}

/// Tokenize one chunk into `(ids, embed position_ids)`. The multilingual export prepends its
/// `[en]` language tag; turbo/nano are English-only and tokenize raw text. `None` when the
/// chunk carries no tokens at all.
fn encode_prompt(
    loaded: &Loaded,
    language_tag: Option<&str>,
    chunk: &str,
) -> ChatterboxResult<Option<(Vec<i64>, Vec<i64>)>> {
    let prompt = match language_tag {
        Some(tag) => format!("[{tag}]{chunk}"),
        None => chunk.to_string(),
    };
    let enc = loaded
        .tokenizer
        .encode(prompt, true)
        .map_err(|e| ChatterboxError::Tokenizer(e.to_string()))?;
    let ids: Vec<i64> = enc.get_ids().iter().map(|&u| u as i64).collect();
    if ids.is_empty() {
        return Ok(None);
    }
    let position_ids: Vec<i64> = ids
        .iter()
        .enumerate()
        .map(|(idx, &id)| {
            if id >= START_SPEECH_TOKEN {
                0
            } else {
                idx as i64 - 1
            }
        })
        .collect();
    Ok(Some((ids, position_ids)))
}

fn build_session(path: &Path) -> ChatterboxResult<Session> {
    super::provider::cpu_session(
        path,
        "Chatterbox DirectML policy is not validated yet",
        "Chatterbox",
    )
    .map_err(ChatterboxError::Session)
}

/// Extract a named float output as an owned f32 array, PROMOTING a float16 export.
/// The q4f16/fp16 graphs emit fp16 activations (logits, `audio_features`, the speaker
/// conditioning), so every host-side computation here works in f32 and re-narrows at
/// the input boundary via [`float_input`]. The KV cache is the one exception — it
/// round-trips in its own dtype through [`extract_typed`], never through this.
fn extract_f32(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ChatterboxResult<ArrayD<f32>> {
    if let Ok((shape, data)) = outputs[name].try_extract_tensor::<f32>() {
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        return ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("shape {name}: {e}")));
    }
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f16>()
        .map_err(|e| ChatterboxError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.iter().map(|v| v.to_f32()).collect())
        .map_err(|e| ChatterboxError::Inference(format!("shape {name}: {e}")))
}

/// Build a float input tensor for `name` from f32 data, narrowing to float16 when the
/// graph declares that input as fp16 (the q4f16/fp16 exports do for `audio_values`,
/// `inputs_embeds`, and the decoder's speaker conditioning).
fn float_input(
    session: &Session,
    name: &str,
    array: ArrayD<f32>,
) -> ChatterboxResult<SessionInputValue<'static>> {
    let wants_f16 = session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_type())
        .is_some_and(|t| matches!(t, ort::value::TensorElementType::Float16));
    if wants_f16 {
        let narrowed = array.mapv(f16::from_f32);
        return Tensor::from_array(narrowed)
            .map(SessionInputValue::from)
            .map_err(|e| ChatterboxError::Inference(format!("{name} fp16 tensor: {e}")));
    }
    Tensor::from_array(array)
        .map(SessionInputValue::from)
        .map_err(|e| ChatterboxError::Inference(format!("{name} tensor: {e}")))
}
fn extract_i64(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ChatterboxResult<ArrayD<i64>> {
    extract_typed::<i64>(outputs, name)
}

/// Extract a named output verbatim in its own element type (no promotion) — used for
/// the KV cache, which must round-trip in the dtype the graph declares.
fn extract_typed<T: ort::value::PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static>(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ChatterboxResult<ArrayD<T>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<T>()
        .map_err(|e| ChatterboxError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| ChatterboxError::Inference(format!("shape {name}: {e}")))
}

/// True when `session` declares an input called `name`. Drives the per-export
/// optional inputs (`position_ids` / `exaggeration`) instead of branching on a
/// model id — the graphs are the source of truth.
fn declares_input(session: &Session, name: &str) -> bool {
    session.inputs().iter().any(|i| i.name() == name)
}

/// Read the backbone's KV-cache contract off the graph: the `past_key_values.*`
/// input names in declaration order, their `present.*` counterparts (same order,
/// so index `i` pairs), the static `[_, heads, _, head_dim]` dims, and the element
/// type. Layer count (30 multilingual / 24 turbo / 12 nano) therefore never appears
/// as a constant.
fn introspect_kv(language_model: &Session) -> ChatterboxResult<KvSpec> {
    let past_names: Vec<String> = language_model
        .inputs()
        .iter()
        .map(|i| i.name().to_string())
        .filter(|n| n.starts_with("past_key_values."))
        .collect();
    let present_names: Vec<String> = language_model
        .outputs()
        .iter()
        .map(|o| o.name().to_string())
        .filter(|n| n.starts_with("present."))
        .collect();
    if past_names.is_empty() || past_names.len() != present_names.len() {
        return Err(ChatterboxError::Session(format!(
            "language_model KV introspection mismatch: {} past vs {} present",
            past_names.len(),
            present_names.len()
        )));
    }
    let node = language_model
        .inputs()
        .iter()
        .find(|i| i.name().starts_with("past_key_values."))
        .ok_or_else(|| ChatterboxError::Session("no past_key_values input".into()))?;
    let ty = node.dtype();
    let shape = ty.tensor_shape();
    // Layout `(batch, heads, seq, head_dim)`; dims 1 and 3 are static in every export.
    let heads = shape
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .ok_or_else(|| ChatterboxError::Session("past_key_values heads dim is dynamic".into()))?
        as usize;
    let head_dim = shape
        .and_then(|s| s.get(3).copied())
        .filter(|&d| d > 0)
        .ok_or_else(|| ChatterboxError::Session("past_key_values head_dim is dynamic".into()))?
        as usize;
    let dtype = match ty.tensor_type() {
        Some(ort::value::TensorElementType::Float16) => KvDtype::F16,
        _ => KvDtype::F32,
    };
    Ok(KvSpec {
        past_names,
        present_names,
        heads,
        head_dim,
        dtype,
    })
}

/// The reference conditioning for `ref_path`, reusing the cached encoder run
/// when the same (path, mtime) was already conditioned this session. A
/// multi-sentence read otherwise re-decoded the WAV and re-ran the (whole-clip)
/// speech encoder for EVERY sentence.
fn ensure_ref_conditioning(
    loaded: &mut Loaded,
    ref_path: &Path,
    attenuate: bool,
) -> ChatterboxResult<std::sync::Arc<RefConditioning>> {
    let mtime = std::fs::metadata(ref_path).and_then(|m| m.modified()).ok();
    if let Some(entry) = &loaded.ref_cond
        && entry.path == ref_path
        && entry.mtime == mtime
    {
        return Ok(entry.cond.clone());
    }

    let audio = load_ref_24k_mono(ref_path, attenuate)?;
    if audio.is_empty() {
        return Err(ChatterboxError::Audio("reference audio is empty".into()));
    }
    let se_out = {
        let av = Array2::from_shape_vec((1, audio.len()), audio)
            .map_err(|e| ChatterboxError::Inference(format!("audio_values: {e}")))?
            .into_dyn();
        let t = float_input(&loaded.speech_encoder, "audio_values", av)?;
        loaded
            .speech_encoder
            .run(vec![(Cow::Borrowed("audio_values"), t)])
            .map_err(|e| ChatterboxError::Inference(format!("speech_encoder: {e}")))?
    };
    let cond = std::sync::Arc::new(RefConditioning {
        cond_emb: extract_f32(&se_out, "audio_features")?, // [1, Lc, H]
        prompt_token: extract_i64(&se_out, "audio_tokens")?, // [1, Lp]
        ref_x_vector: extract_f32(&se_out, "speaker_embeddings")?,
        prompt_feat: extract_f32(&se_out, "speaker_features")?,
    });
    drop(se_out);
    loaded.ref_cond = Some(RefCondCacheEntry {
        path: ref_path.to_path_buf(),
        mtime,
        cond: cond.clone(),
    });
    Ok(cond)
}

fn run_pipeline(
    loaded: &mut Loaded,
    ids: &[i64],
    position_ids: &[i64],
    ref_path: &Path,
    exaggeration: f32,
    trailing_silence: usize,
    attenuate_hot_ref: bool,
) -> ChatterboxResult<Vec<f32>> {
    let s = ids.len();

    // --- speech_encoder conditioning (cached per reference clip) ---
    let cond = ensure_ref_conditioning(loaded, ref_path, attenuate_hot_ref)?;
    let cond_emb = &cond.cond_emb; // [1, Lc, H]
    let prompt_token = &cond.prompt_token; // [1, Lp]

    // --- prefill embed_tokens(full text) ---
    let mut embed_ids: Vec<i64> = ids.to_vec();
    let mut embed_pos: Vec<i64> = position_ids.to_vec();
    let text_embeds = run_embed(loaded, &embed_ids, &embed_pos, exaggeration)?; // [1, S, H]
    let hidden = *text_embeds.shape().last().unwrap_or(&0);
    if hidden == 0 {
        return Err(ChatterboxError::Inference("embed hidden dim 0".into()));
    }

    // inputs_embeds = concat(cond_emb, text_embeds) along axis 1 (batch=1 → flat append).
    let lc = cond_emb.shape().get(1).copied().unwrap_or(0);
    let mut embeds_flat: Vec<f32> = Vec::with_capacity((lc + s) * hidden);
    embeds_flat.extend(cond_emb.iter().copied());
    embeds_flat.extend(text_embeds.iter().copied());
    let mut seq_len = lc + s;
    let mut inputs_embeds: ArrayD<f32> = Array3::from_shape_vec((1, seq_len, hidden), embeds_flat)
        .map_err(|e| ChatterboxError::Inference(format!("concat embeds: {e}")))?
        .into_dyn();

    // --- KV state (empty, in the graph's own dtype) + attention mask ---
    let mut kv: BTreeMap<String, KvValue> = BTreeMap::new();
    for name in &loaded.kv.past_names {
        kv.insert(
            name.clone(),
            KvValue::empty(loaded.kv.dtype, loaded.kv.heads, loaded.kv.head_dim)?,
        );
    }
    let mut attention_mask: Vec<i64> = vec![1; seq_len];
    // Absolute LM positions — only the turbo/nano backbones declare `position_ids`;
    // prefill is `arange(seq_len)` and every decode step is `last + 1`
    // (`position_ids = position_ids[:, -1:] + 1` in both reference scripts).
    let mut lm_positions: Vec<i64> = (0..seq_len as i64).collect();
    let mut generate_tokens: Vec<i64> = vec![START_SPEECH_TOKEN];

    for i in 0..MAX_NEW_TOKENS {
        // language_model(inputs_embeds, attention_mask, [position_ids,] past_key_values.*)
        let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + loaded.kv.past_names.len());
        inputs.push((
            Cow::Borrowed("inputs_embeds"),
            float_input(
                &loaded.language_model,
                "inputs_embeds",
                inputs_embeds.clone(),
            )?,
        ));
        let mask_t = Tensor::from_array(
            Array2::from_shape_vec((1, attention_mask.len()), attention_mask.clone())
                .map_err(|e| ChatterboxError::Inference(format!("mask: {e}")))?,
        )
        .map_err(|e| ChatterboxError::Inference(format!("mask tensor: {e}")))?;
        inputs.push((
            Cow::Borrowed("attention_mask"),
            SessionInputValue::from(mask_t),
        ));
        if loaded.lm_wants_position_ids {
            let pos_t = Tensor::from_array(
                Array2::from_shape_vec((1, lm_positions.len()), lm_positions.clone())
                    .map_err(|e| ChatterboxError::Inference(format!("lm positions: {e}")))?,
            )
            .map_err(|e| ChatterboxError::Inference(format!("lm position tensor: {e}")))?;
            inputs.push((
                Cow::Borrowed("position_ids"),
                SessionInputValue::from(pos_t),
            ));
        }
        for name in &loaded.kv.past_names {
            // MOVE the cached array into the tensor (the slot is refilled from
            // `present.*` right after this run) — cloning here copied the whole
            // KV cache a second time per generated token.
            let arr = kv
                .remove(name)
                .ok_or_else(|| ChatterboxError::Inference(format!("missing kv cache {name}")))?;
            inputs.push((Cow::Owned(name.clone()), arr.into_input()?));
        }
        let outputs = loaded
            .language_model
            .run(inputs)
            .map_err(|e| ChatterboxError::Inference(format!("language_model step {i}: {e}")))?;

        // logits[:, -1, :]
        let logits = extract_f32(&outputs, "logits")?;
        let lshape = logits.shape().to_vec();
        let (seq, vocab) = (lshape[1], lshape[2]);
        let last = (seq - 1) * vocab;
        let logits_slice = logits
            .as_slice()
            .ok_or_else(|| ChatterboxError::Inference("logits tensor is not contiguous".into()))?;
        let mut scores: Vec<f32> = logits_slice[last..last + vocab].to_vec();
        // repetition penalty over the running tokens (per unique id)
        let mut seen = std::collections::HashSet::new();
        for &tok in &generate_tokens {
            if tok >= 0 && (tok as usize) < vocab && seen.insert(tok) {
                let v = scores[tok as usize];
                scores[tok as usize] = if v < 0.0 {
                    v * REPETITION_PENALTY
                } else {
                    v / REPETITION_PENALTY
                };
            }
        }
        let next_token = crate::winstt::stt::families::argmax_1d(&scores).0 as i64;
        generate_tokens.push(next_token);
        if next_token == STOP_SPEECH_TOKEN {
            break;
        }
        // Safety net for the runaway `REPETITION_PENALTY` does not rescue: once the
        // backbone locks onto a repeated clause it never emits STOP, grinds all the way to
        // MAX_NEW_TOKENS and the sentence is then cut off MID-PHRASE (measured: a legal
        // 236-char chunk lost its final 17 words, WER 0.5). Raising the cap only buys more
        // looping — 1024 tokens produced 41 s of audio missing the same words — so cut the
        // cycle back to one copy and stop cleanly here instead. `[1..]` skips the START seed.
        if let Some(cycle) = loop_cycle(&generate_tokens[1..]) {
            log::debug!(
                "chatterbox: cut a {}-token loop at step {i} (dropped {})",
                cycle.period,
                cycle.dropped
            );
            generate_tokens.truncate(generate_tokens.len() - cycle.dropped);
            // Terminate the way STOP would, so the tail trimming below is unchanged.
            generate_tokens.push(STOP_SPEECH_TOKEN);
            break;
        }

        // carry present.* -> past_key_values.* (by index; both lists are in graph order)
        for (pi, pres) in loaded.kv.present_names.iter().enumerate() {
            let arr = KvValue::from_output(&outputs, pres, loaded.kv.dtype)?;
            kv.insert(loaded.kv.past_names[pi].clone(), arr);
        }
        drop(outputs);

        // next decode step: embed the new token at position i+1
        embed_ids = vec![next_token];
        embed_pos = vec![(i + 1) as i64];
        inputs_embeds = run_embed(loaded, &embed_ids, &embed_pos, exaggeration)?; // [1,1,H]
        seq_len += 1;
        attention_mask.push(1);
        lm_positions = vec![lm_positions.last().copied().unwrap_or(0) + 1];
        let _ = seq_len;
    }

    // speech_tokens = prompt_token ++ generate_tokens[1..len-1] [++ silence]
    let gen_mid: Vec<i64> = if generate_tokens.len() > 2 {
        generate_tokens[1..generate_tokens.len() - 1].to_vec()
    } else {
        Vec::new()
    };
    let prompt_vec: Vec<i64> = prompt_token.iter().copied().collect();
    let mut speech_tokens: Vec<i64> =
        Vec::with_capacity(prompt_vec.len() + gen_mid.len() + trailing_silence);
    speech_tokens.extend(prompt_vec);
    speech_tokens.extend(gen_mid);
    // Turbo/Nano pad the token stream with a few silence frames so the distilled
    // one-step decoder resolves the final phoneme instead of clipping it.
    speech_tokens.extend(std::iter::repeat_n(SILENCE_SPEECH_TOKEN, trailing_silence));
    if speech_tokens.is_empty() {
        return Err(ChatterboxError::Inference(
            "no speech tokens generated".into(),
        ));
    }

    // --- conditional_decoder (S3Gen vocoder) ---
    let st = Tensor::from_array(
        Array2::from_shape_vec((1, speech_tokens.len()), speech_tokens)
            .map_err(|e| ChatterboxError::Inference(format!("speech_tokens: {e}")))?,
    )
    .map_err(|e| ChatterboxError::Inference(format!("speech_tokens tensor: {e}")))?;
    // Cloned out of the cached conditioning (tensors consume their input; the
    // cache keeps the originals for the next sentence).
    let spk = float_input(
        &loaded.conditional_decoder,
        "speaker_embeddings",
        cond.ref_x_vector.clone(),
    )?;
    let feat = float_input(
        &loaded.conditional_decoder,
        "speaker_features",
        cond.prompt_feat.clone(),
    )?;
    // Read the fallback output name BEFORE `run`, whose `SessionOutputs` holds the session
    // mutably borrowed for as long as `dec` lives.
    let first_output_name = loaded
        .conditional_decoder
        .outputs()
        .first()
        .map(|o| o.name().to_string());
    let dec = loaded
        .conditional_decoder
        .run(vec![
            (Cow::Borrowed("speech_tokens"), SessionInputValue::from(st)),
            (Cow::Borrowed("speaker_embeddings"), spk),
            (Cow::Borrowed("speaker_features"), feat),
        ])
        .map_err(|e| ChatterboxError::Inference(format!("conditional_decoder: {e}")))?;
    let wav = match extract_f32(&dec, "waveform") {
        Ok(w) => w,
        // Fall back to the first output when the name differs across exports.
        Err(err) => match first_output_name {
            Some(name) => extract_f32(&dec, &name)?,
            None => return Err(err),
        },
    };
    // Peak-normalize if the vocoder output exceeds [-1,1] (Chatterbox can run hot)
    // so playback/WAV write doesn't hard-clip.
    let mut out: Vec<f32> = wav.iter().copied().collect();
    let peak = out.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak > 1.0 {
        let gain = 0.99 / peak;
        for s in &mut out {
            *s *= gain;
        }
    }
    Ok(out)
}

/// A degenerate cycle found at the tail of the generated speech-token stream.
struct LoopCycle {
    /// Cycle length in speech tokens (`1..=LOOP_MAX_PERIOD_TOKENS`).
    period: usize,
    /// Tokens to drop so exactly one copy of the cycle survives.
    dropped: usize,
}

/// Detect a repeating cycle at the tail of `stream`: a period of `1..=`
/// [`LOOP_MAX_PERIOD_TOKENS`] repeated back-to-back at least [`LOOP_MIN_CYCLES`] times AND
/// spanning at least [`LOOP_MIN_SPAN_TOKENS`] tokens, each copy matching the first to within
/// the [`LOOP_DRIFT_DEN`] budget. The SHORTEST qualifying period wins, so a frozen token is
/// reported as period 1 rather than as some multiple of itself.
///
/// Deliberately NOT the `no_repeat_ngram` ban the Whisper decoder uses
/// (`stt/whisper/token_select.rs`), for the same reason `orpheus::loop_cycle` isn't: banning
/// a repeated n-gram is right for *text*, but S3 codec tokens repeat constantly during
/// sustained phonemes and pauses, so a hard ban would distort ordinary speech. This looks
/// only for the pathological case and cuts rather than bans.
///
/// Scaled up from the Orpheus cut, which only ever sees 1-4 frame buzz: the failure here is
/// a repeated *clause*, tens of tokens long. The thresholds are set so the measured
/// non-repetitive control (a 234-char chunk that legitimately generated 240 of 256 tokens)
/// cannot fire — nothing under 1.28 s of near-exact repetition is touched.
fn loop_cycle(stream: &[i64]) -> Option<LoopCycle> {
    for period in 1..=LOOP_MAX_PERIOD_TOKENS {
        let cycles = LOOP_MIN_CYCLES.max(LOOP_MIN_SPAN_TOKENS.div_ceil(period));
        let span = period * cycles;
        if stream.len() < span {
            continue;
        }
        let tail = &stream[stream.len() - span..];
        let first = &tail[..period];
        let budget = period / LOOP_DRIFT_DEN;
        let repeats = tail
            .chunks_exact(period)
            .all(|copy| copy.iter().zip(first).filter(|(a, b)| a != b).count() <= budget);
        if repeats {
            return Some(LoopCycle {
                period,
                dropped: span - period,
            });
        }
    }
    None
}

/// Run `embed_tokens` -> inputs_embeds. `position_ids` and `exaggeration` are supplied
/// only when the loaded graph declares them: the multilingual export takes all three,
/// the turbo/nano exports take `input_ids` alone (they carry positions on the backbone
/// and bake the style in).
fn run_embed(
    loaded: &mut Loaded,
    ids: &[i64],
    pos: &[i64],
    exaggeration: f32,
) -> ChatterboxResult<ArrayD<f32>> {
    let n = ids.len();
    let mut inputs: Vec<NamedInput> = Vec::with_capacity(3);
    let ids_t = Tensor::from_array(
        Array2::from_shape_vec((1, n), ids.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("embed ids: {e}")))?,
    )
    .map_err(|e| ChatterboxError::Inference(format!("embed ids tensor: {e}")))?;
    inputs.push((Cow::Borrowed("input_ids"), SessionInputValue::from(ids_t)));
    if loaded.embed_wants_position_ids {
        let pos_t = Tensor::from_array(
            Array2::from_shape_vec((1, n), pos.to_vec())
                .map_err(|e| ChatterboxError::Inference(format!("embed pos: {e}")))?,
        )
        .map_err(|e| ChatterboxError::Inference(format!("embed pos tensor: {e}")))?;
        inputs.push((
            Cow::Borrowed("position_ids"),
            SessionInputValue::from(pos_t),
        ));
    }
    if loaded.embed_wants_exaggeration {
        inputs.push((
            Cow::Borrowed("exaggeration"),
            float_input(
                &loaded.embed_tokens,
                "exaggeration",
                Array1::from_vec(vec![exaggeration]).into_dyn(),
            )?,
        ));
    }
    let out = loaded
        .embed_tokens
        .run(inputs)
        .map_err(|e| ChatterboxError::Inference(format!("embed_tokens: {e}")))?;
    extract_f32(&out, "inputs_embeds")
}

/// Load a reference clip as mono f32 @ 24 kHz, capped at
/// [`crate::winstt::tts::catalog::MAX_CLONE_REF_SECS`].
///
/// The clip picker normalizes what it stores (`tts_prepare_reference_clip` writes
/// a 24 kHz mono WAV), so the WAV fast path below is the one that runs and its
/// resampling behavior is unchanged. Anything else — an mp3/m4a/flac the user
/// pointed `tts.voice` at directly, or a clip persisted before the picker
/// existed — falls through to the shared symphonia decoder instead of failing at
/// synthesis time. The cap is enforced here too: neither this engine nor Spark
/// bounds the clip, and `speech_encoder` runs over the WHOLE thing.
/// A reference clip louder than this drives the multilingual `speech_encoder` into the
/// failure mode the shipped `default_voice.wav` exhibits (it measures peak 1.0802 — i.e.
/// clipped): the opening words come out mangled, "The quick brown fox jumps over the lazy
/// dog." -> "Rick Brown fox jumps over the lazy dog." on 10 of 10 renders. Rescaling that
/// same clip to peak 0.30 gives 0 of 10 failures.
///
/// The gate is deliberately ATTENUATE-ONLY, and sits between the measured-clean ceiling
/// (peak 0.45) and the measured-failing floor (peak 0.55). Reference clips that already
/// work measure peak 0.28-0.39, so they fall below the gate and pass through BIT-IDENTICAL
/// — the reason a blanket normaliser was previously (correctly) rejected: normalising to
/// 0.95 was a no-op and to 0.50 a coin flip, and neither reached the working band.
const REF_PEAK_GATE: f32 = 0.5;
/// Rescale target for clips above [`REF_PEAK_GATE`] — the best of a measured sweep over
/// peak 0.20/0.25/0.30/0.35/0.40/0.45/0.55.
const REF_PEAK_TARGET: f32 = 0.30;

// Both constants are pinned to the measurements at COMPILE time, so retuning either one
// out of the band the sweep established cannot build: peak 0.45 measured clean (must pass
// the gate untouched), 0.55 measured failing (must be caught), and the target must land
// inside the 0.28-0.39 band occupied by the reference clips that already clone correctly.
const _: () = {
    assert!(REF_PEAK_GATE > 0.45);
    assert!(REF_PEAK_GATE < 0.55);
    assert!(REF_PEAK_TARGET < REF_PEAK_GATE);
    assert!(REF_PEAK_TARGET >= 0.28 && REF_PEAK_TARGET <= 0.39);
};

/// Scale `audio` down to [`REF_PEAK_TARGET`] when it is hotter than [`REF_PEAK_GATE`].
/// Quieter clips are left untouched, so this can only ever reduce level.
fn attenuate_hot_reference(audio: &mut [f32]) {
    let peak = audio.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak > REF_PEAK_GATE {
        let gain = REF_PEAK_TARGET / peak;
        for s in audio.iter_mut() {
            *s *= gain;
        }
    }
}

fn load_ref_24k_mono(path: &Path, attenuate: bool) -> ChatterboxResult<Vec<f32>> {
    let max_samples =
        crate::winstt::tts::catalog::MAX_CLONE_REF_SECS as usize * CHATTERBOX_SAMPLE_RATE as usize;
    let mut audio = match load_wav_24k_mono(path) {
        Ok(audio) => audio,
        Err(wav_err) => crate::winstt::managers::transcode::decode_reference_clip(
            path,
            CHATTERBOX_SAMPLE_RATE,
            crate::winstt::tts::catalog::MAX_CLONE_REF_SECS,
        )
        .map(|clip| clip.samples)
        .map_err(|decode_err| {
            ChatterboxError::Audio(format!("{wav_err} (also failed to decode: {decode_err})"))
        })?,
    };
    audio.truncate(max_samples);
    if attenuate {
        attenuate_hot_reference(&mut audio);
    }
    Ok(audio)
}

/// Load a WAV as mono f32 @ 24 kHz (linear-resampled if needed).
fn load_wav_24k_mono(path: &Path) -> ChatterboxResult<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| ChatterboxError::Audio(format!("open {}: {e}", path.display())))?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|v| v as f32 / max)
                .collect()
        }
    };
    // downmix to mono
    let mono: Vec<f32> = if ch <= 1 {
        raw
    } else {
        raw.chunks(ch)
            .map(|fr| fr.iter().copied().sum::<f32>() / ch as f32)
            .collect()
    };
    if spec.sample_rate == CHATTERBOX_SAMPLE_RATE || mono.is_empty() {
        return Ok(mono);
    }
    // linear resample to 24 kHz
    let ratio = CHATTERBOX_SAMPLE_RATE as f64 / spec.sample_rate as f64;
    let out_len = ((mono.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = mono.get(i0).copied().unwrap_or(0.0);
        let b = mono.get(i0 + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field is spelled out — there is no `Default` to lean on, by design (the old
    /// one hardcoded `language_model_q4.onnx` behind the catalog's back).
    #[test]
    fn config_paths() {
        let c = ChatterboxConfig {
            cache_dir: PathBuf::from("/x/chatterbox"),
            graphs: ChatterboxGraphs {
                speech_encoder: "speech_encoder.onnx".into(),
                embed_tokens: "embed_tokens.onnx".into(),
                language_model: "language_model_q4.onnx".into(),
                conditional_decoder: "conditional_decoder.onnx".into(),
            },
            language_tag: Some("en".to_string()),
            trailing_silence_tokens: 0,
            attenuate_hot_reference: true,
        };
        assert!(
            c.onnx(&c.graphs.speech_encoder)
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with("onnx/speech_encoder.onnx")
        );
        assert!(c.tokenizer_path().ends_with("tokenizer.json"));
        assert!(c.default_voice_path().ends_with("default_voice.wav"));
    }

    /// Nano MIXES precisions across its four graphs — the case a single global quant
    /// suffix cannot express, and the reason the filenames are per-graph.
    #[test]
    fn per_graph_filenames_can_mix_precisions() {
        let g = ChatterboxGraphs {
            speech_encoder: "speech_encoder_q4f16.onnx".into(),
            embed_tokens: "embed_tokens_fp16.onnx".into(),
            language_model: "language_model_q4f16.onnx".into(),
            conditional_decoder: "conditional_decoder_q4.onnx".into(),
        };
        let c = ChatterboxConfig {
            cache_dir: PathBuf::from("/x/nano"),
            graphs: g,
            language_tag: None,
            trailing_silence_tokens: 3,
            attenuate_hot_reference: false,
        };
        let path = |n: &str| c.onnx(n).to_string_lossy().replace('\\', "/");
        assert!(path(&c.graphs.embed_tokens).ends_with("onnx/embed_tokens_fp16.onnx"));
        assert!(path(&c.graphs.conditional_decoder).ends_with("onnx/conditional_decoder_q4.onnx"));
    }

    #[test]
    fn kv_empty_matches_the_declared_dtype() {
        let f32_kv = KvValue::empty(KvDtype::F32, 16, 64).expect("f32 empty");
        let f16_kv = KvValue::empty(KvDtype::F16, 12, 64).expect("f16 empty");
        assert!(matches!(f32_kv, KvValue::F32(ref a) if a.shape() == [1, 16, 0, 64]));
        assert!(matches!(f16_kv, KvValue::F16(ref a) if a.shape() == [1, 12, 0, 64]));
    }

    // ── degenerate-loop cut ──────────────────────────────────────────────────────

    /// A plausible NON-repeating speech-token stream: a stride walk over the 6,561-entry S3
    /// codebook. The stride is coprime with 6561 (= 3^8), so `x[i+p] == x[i]` cannot hold for
    /// any period this detector looks at — the same property real speech has.
    fn speech_stream(len: usize, seed: i64) -> Vec<i64> {
        (0..len as i64)
            .map(|i| (seed + i * 2_654_435_761) % 6561)
            .collect()
    }

    /// Ordinary speech ahead of the tail under test (monotone, so it can never repeat).
    fn lead_in(len: usize) -> Vec<i64> {
        (100..100 + len as i64).collect()
    }

    /// The measured control: a 234-char chunk legitimately generated 240 of 256 tokens with
    /// no repetition. Nothing may fire on it, or the cut would clip real speech.
    #[test]
    fn loop_cycle_ignores_ordinary_speech() {
        assert!(loop_cycle(&speech_stream(240, 5)).is_none());
        assert!(loop_cycle(&[]).is_none());
        assert!(loop_cycle(&lead_in(31)).is_none());
    }

    /// The D1 failure: the backbone locks onto a repeated clause and never emits STOP.
    #[test]
    fn loop_cycle_catches_a_repeated_clause() {
        let clause = speech_stream(40, 7);
        let mut stream = lead_in(24);
        stream.extend(clause.iter().copied());
        stream.extend(clause.iter().copied());
        let cut = loop_cycle(&stream).expect("clause-length cycle detected");
        assert_eq!(cut.period, 40);
        // Exactly one copy of the clause survives.
        assert_eq!(cut.dropped, 40);
    }

    /// The other shape of runaway: a frozen codec token droning to the cap.
    #[test]
    fn loop_cycle_catches_a_frozen_token() {
        let mut stream = lead_in(50);
        stream.extend(std::iter::repeat_n(
            SILENCE_SPEECH_TOKEN,
            LOOP_MIN_SPAN_TOKENS,
        ));
        let cut = loop_cycle(&stream).expect("frozen-token run detected");
        assert_eq!(cut.period, 1);
        assert_eq!(cut.dropped, LOOP_MIN_SPAN_TOKENS - 1);
    }

    /// The gate is ATTENUATE-ONLY: a clip already inside the measured working band
    /// (peak 0.28-0.39) must come through bit-identical, or the reference clips that
    /// already clone correctly would be silently altered.
    #[test]
    fn reference_below_the_gate_is_untouched() {
        for peak in [0.05_f32, 0.28, 0.35, 0.39, REF_PEAK_GATE] {
            let original: Vec<f32> = (0..64)
                .map(|i| peak * ((i % 7) as f32 / 6.0 - 0.5) * 2.0)
                .collect();
            let mut audio = original.clone();
            attenuate_hot_reference(&mut audio);
            assert_eq!(audio, original, "peak {peak} must not be rescaled");
        }
    }

    /// The shipped `default_voice.wav` measures peak 1.0802 — clipped — and that is what
    /// mangles sentence openings on the multilingual export.
    #[test]
    fn reference_above_the_gate_is_scaled_to_target() {
        for peak in [0.55_f32, 1.0, 1.0802, 4.0] {
            let mut audio: Vec<f32> = vec![peak, -peak * 0.5, 0.0, peak * 0.25];
            attenuate_hot_reference(&mut audio);
            let out_peak = audio.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            assert!(
                (out_peak - REF_PEAK_TARGET).abs() < 1e-6,
                "peak {peak} -> {out_peak}, want {REF_PEAK_TARGET}"
            );
            // Shape is preserved — this is a gain change, not a limiter.
            assert!((audio[1] / audio[0] + 0.5).abs() < 1e-6);
            assert!((audio[3] / audio[0] - 0.25).abs() < 1e-6);
        }
    }

    /// Silence must not divide by zero or be amplified.
    #[test]
    fn silent_reference_is_left_alone() {
        let mut audio = vec![0.0_f32; 16];
        attenuate_hot_reference(&mut audio);
        assert!(audio.iter().all(|&s| s == 0.0));
        let mut empty: Vec<f32> = Vec::new();
        attenuate_hot_reference(&mut empty);
        assert!(empty.is_empty());
    }

    /// Boundary: under the span floor nothing fires, at it the cut does.
    #[test]
    fn loop_cycle_boundary_is_the_min_span() {
        let frozen = |n: usize| {
            let mut s = lead_in(50);
            s.extend(std::iter::repeat_n(SILENCE_SPEECH_TOKEN, n));
            s
        };
        // 24 tokens ≈ 0.96 s of frozen codec — a long pause, not yet a loop.
        assert!(loop_cycle(&frozen(24)).is_none());
        assert!(loop_cycle(&frozen(LOOP_MIN_SPAN_TOKENS)).is_some());

        // A phrase-length cycle needs LOOP_MIN_CYCLES copies; ONE pass is just speech.
        let mut once = lead_in(50);
        once.extend(speech_stream(40, 7));
        assert!(loop_cycle(&once).is_none());
    }

    /// A backbone looping on a *phrase* re-renders it with slightly different prosody, so the
    /// copies are near- rather than bit-identical. Within the budget that still counts; past
    /// it the stream is two different spans and must be left alone.
    #[test]
    fn loop_cycle_tolerates_bounded_drift_only() {
        let clause = speech_stream(16, 11);
        let drifted = |changed: usize| {
            let mut s = lead_in(40);
            s.extend(clause.iter().copied());
            let mut copy = clause.clone();
            for (i, slot) in copy.iter_mut().enumerate().take(changed) {
                *slot = 6000 + i as i64;
            }
            s.extend(copy);
            s
        };
        let budget = 16 / LOOP_DRIFT_DEN;
        assert_eq!(budget, 2);
        assert!(
            loop_cycle(&drifted(budget)).is_some(),
            "drift within budget"
        );
        assert!(
            loop_cycle(&drifted(budget + 1)).is_none(),
            "drift past budget must not fire"
        );
    }

    /// The cut terminates at the START of the loop instead of running to the cap and
    /// truncating mid-phrase: one copy of the cycle survives, everything said before it is
    /// kept, and the stream ends exactly as a STOP-terminated one does.
    #[test]
    fn the_cut_keeps_one_copy_and_terminates_like_stop() {
        let clause = speech_stream(40, 7);
        let mut generate_tokens = vec![START_SPEECH_TOKEN];
        generate_tokens.extend(lead_in(24));
        generate_tokens.extend(clause.iter().copied());
        generate_tokens.extend(clause.iter().copied());

        let cycle = loop_cycle(&generate_tokens[1..]).expect("clause loop");
        generate_tokens.truncate(generate_tokens.len() - cycle.dropped);
        generate_tokens.push(STOP_SPEECH_TOKEN);

        assert_eq!(generate_tokens.len(), 1 + 24 + 40 + 1);
        assert_eq!(generate_tokens[0], START_SPEECH_TOKEN);
        assert_eq!(&generate_tokens[25..65], clause.as_slice());
        assert_eq!(generate_tokens.last().copied(), Some(STOP_SPEECH_TOKEN));
        // `run_pipeline`'s tail trimming (`[1..len-1]`) then keeps ALL the real speech.
        let gen_mid = &generate_tokens[1..generate_tokens.len() - 1];
        assert_eq!(gen_mid.len(), 24 + 40);
    }

    // ── multi-sentence robustness (D2) ───────────────────────────────────────────

    /// `"Hello. The quick brown fox…"` in ONE call produced 255 tokens / 10.2 s of audio
    /// that transcribed as just `"Hello."`. The engine now splits it itself instead of
    /// depending on `service.rs` having done so.
    #[test]
    fn multi_sentence_input_is_split_before_the_backbone_sees_it() {
        let chunks = synthesis_chunks("Hello. The quick brown fox jumps over the lazy dog.");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "Hello.");
        assert!(chunks[1].starts_with("The quick brown fox"));
    }

    /// …and the shipping path is untouched: one sentence in, the same one sentence out, so a
    /// `service.rs`-driven read runs exactly the same backbone pass it did before.
    #[test]
    fn single_sentence_chunking_is_a_no_op() {
        let one = "The quick brown fox jumps over the lazy dog.";
        assert_eq!(synthesis_chunks(one), vec![one.to_string()]);
        assert_eq!(
            synthesis_chunks("  a plain phrase  "),
            vec!["a plain phrase"]
        );
        assert!(synthesis_chunks("   \n  ").is_empty());
        assert!(synthesis_chunks("").is_empty());
    }

    /// An unpunctuated wall of text is capped at the same length the caller would cap it at,
    /// so no single backbone run is asked for more than it can finish.
    #[test]
    fn overlong_input_is_capped_at_the_splitter_limit() {
        let long = "word ".repeat(200);
        let chunks = synthesis_chunks(&long);
        assert!(chunks.len() > 1);
        assert!(
            chunks
                .iter()
                .all(|c| c.chars().count() <= DEFAULT_MAX_SENTENCE_LEN)
        );
    }
}
