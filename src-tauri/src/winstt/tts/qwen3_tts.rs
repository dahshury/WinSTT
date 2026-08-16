// Qwen3-TTS-12Hz (Qwen) — text + voice steering → 24 kHz speech, on ort 2.0. Faithful
// port of the exported-ONNX path in the reference `inference.py` (`generate` L263-358 +
// `_ar_loop_cached` L407-447 + `decode_chunked` L197-211). See PORT_SPEC.md §5-§7 for
// the verified algorithm.
//
// Drives BOTH published checkpoints — they ship the same graph layout and a byte-identical
// `inference.py`, and differ only in scale and in how the voice is steered:
//   1.7B VoiceDesign  H=2048, no preset bank  → `voice` is a natural-language instruct.
//   0.6B CustomVoice  H=1024, 9 preset timbres → `voice` names one (see Qwen3TtsVoiceMode).
// Every dim below is therefore read from `config.json`/the graphs, never hardcoded; the
// shapes quoted are the 1.7B's.
//
// SIX ort sessions (manifest `sub_models`), all CPU (int4 talker uses MatMulNBits, a
// standard-ORT contrib op; DirectML is not validated for this pipeline yet — CPU-only
// for v1, cited in `build_session`):
//   text_embed      text_ids[B,T] i64            → [B,T,H]                         run per embed
//   codec_embed     codec_ids[B,T] i64           → [B,T,H]                         run per embed
//   talker_cache    inputs_embeds + position_ids + attention_mask + 56 past K/V
//                     → logits[B,cur,3072], hidden[B,cur,H], 56 present            run per AR step (prefill + decode)
//   code_predictor  talker_hidden[B,H] + codec_ids[B,16] → group_logits[B,15,≥2048]   run 15×/frame
//   residual_embed  codec_ids[B,16] i64          → step_embed[B,H]                 run per frame
//   tok_decoder     audio_codes[B,25,16] i64     → waveform[B,1,L] f32             run per 25-frame chunk
//
// Modeled on chatterbox.rs (CPU ONNX AR-LLM voice engine): `LazyOrtEngine` lazy load,
// interior Mutex, per-file `build_session` → `provider::cpu_session`, host-side KV via
// plain `session.run` + `Tensor::from_array`/`try_extract_tensor`. KV is threaded host-side
// (present → past each step, chatterbox style) because the int4 talker is CPU-pinned.
//
// v1 scope (BUILD_PLAN.md §"Backend engine"): language Auto / nothink (the `lang` arg is
// ignored — noted at the call site), `speed` ignored (natural rate). An empty `voice` is a
// VALID default voice (skips the instruct prefix / the speaker row), never an error.
// The base clone-from-a-clip path (`tok_encoder` + ref audio) is NOT ported — no shipped
// entry uses it, which is why the download manifest skips that graph.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ndarray::{Array2, Array3, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::provider::LazyOrtEngine;
use super::sampling;

pub const QWEN3TTS_SAMPLE_RATE: u32 = 24_000;

// Architecture constants fixed by the exported graphs (inference.py L47-49). Everything
// else (token ids, dims) is read from config.json with these as the fallback (PORT_SPEC §3).
// SR == QWEN3TTS_SAMPLE_RATE (24 kHz); output is 24 kHz mono f32.
const DEC_FRAMES: usize = 25; // tok_decoder is exported at a fixed 25-frame length.
const N_GROUPS: usize = 16; // codec codebooks per frame.
const MAX_NEW_TOKENS: usize = 2048; // inference.py `generate` default.

// Production sampling defaults (inference.py `generate` signature L265-267). Greedy is
// used implicitly when `do_sample` is false; we default to sampling for natural voices.
const DO_SAMPLE: bool = true;
const TOP_K: usize = 50;
const TOP_P: f64 = 1.0;
const TEMPERATURE: f64 = 0.9;
const REPETITION_PENALTY: f64 = 1.05;
// Sub-codebook (code_predictor) sampling — same values in the reference signature.
const SUB_DO_SAMPLE: bool = true;
const SUB_TOP_K: usize = 50;
const SUB_TOP_P: f64 = 1.0;
const SUB_TEMPERATURE: f64 = 0.9;

// Fallback token ids / dims from PORT_SPEC §3 (used only if config.json is missing a field).
const FB_HIDDEN: usize = 2048;
const FB_KV_HEADS: usize = 8;
const FB_HEAD_DIM: usize = 128;
const FB_VOCAB: usize = 3072;
/// Residual codebook size — `code_predictor_config.vocab_size`. See `ModelConfig::residual_vocab`.
const FB_RESIDUAL_VOCAB: usize = 2048;
const FB_TTS_BOS: i64 = 151_672;
const FB_TTS_EOS: i64 = 151_673;
const FB_TTS_PAD: i64 = 151_671;
const FB_CODEC_EOS: i64 = 2150;
const FB_CODEC_PAD: i64 = 2148;
const FB_CODEC_BOS: i64 = 2149;
const FB_CODEC_NOTHINK: i64 = 2155;
const FB_CODEC_THINK_BOS: i64 = 2156;
const FB_CODEC_THINK_EOS: i64 = 2157;

#[derive(Debug, thiserror::Error)]
pub enum Qwen3TtsError {
    #[error("qwen3-tts assets missing: {0}")]
    AssetsMissing(String),
    #[error("qwen3-tts session error: {0}")]
    Session(String),
    #[error("qwen3-tts config error: {0}")]
    Config(String),
    #[error("qwen3-tts tokenizer error: {0}")]
    Tokenizer(String),
    #[error("qwen3-tts inference error: {0}")]
    Inference(String),
}
pub type Qwen3TtsResult<T> = Result<T, Qwen3TtsError>;

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

/// How the engine interprets the `voice` string it is handed.
///
/// The two published checkpoints steer the voice through DIFFERENT mechanisms even
/// though they share one export pipeline and one `inference.py`:
///   * VoiceDesign has no preset bank — `voice` is a natural-language instruct prompt
///     that is embedded and prepended to the talker prefill.
///   * CustomVoice has 9 preset timbres — `voice` names one, which resolves through
///     `config.talker_config.spk_id` to a codec token embedded INTO the prefill.
///     (Despite the name, CustomVoice is not clone-from-a-clip; there is no reference
///     audio anywhere in this path.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Qwen3TtsVoiceMode {
    DesignPrompt,
    PresetSpeaker,
}

/// Token ids + dims resolved from `config.json` (falling back to PORT_SPEC §3).
#[derive(Clone, Debug)]
struct ModelConfig {
    hidden: usize,
    kv_heads: usize,
    head_dim: usize,
    vocab: usize,
    /// `talker_config.code_predictor_config.vocab_size` — the RESIDUAL codebook size (2048),
    /// which is NOT the talker vocab (3072). The talker's extra 1024 ids are control tokens
    /// only the first codebook may emit (codec_bos 2149, codec_eos 2150, think 2154-2157).
    ///
    /// `code_predictor` nevertheless emits `group_logits` padded to the FULL 3072 width, so the
    /// valid range has to come from config rather than the tensor: sampling a residual code out
    /// of the padded tail yields an id ≥ 2048, which the next call's `GatherBlockQuantized`
    /// codebook lookup rejects outright ("indices element out of data bounds").
    residual_vocab: usize,
    tts_bos: i64,
    tts_eos: i64,
    tts_pad: i64,
    codec_eos: i64,
    codec_pad: i64,
    codec_bos: i64,
    codec_nothink: i64,
    codec_think_bos: i64,
    codec_think_eos: i64,
    /// `talker_config.spk_id`: preset-timbre name (lowercase) → codec token id. Empty
    /// on VoiceDesign checkpoints, 9 entries on CustomVoice (inference.py L~325).
    spk_id: std::collections::HashMap<String, i64>,
    // NOTE: im_start/im_end/endoftext ids are intentionally NOT stored — the chat
    // template is built from the literal `<|im_start|>`/`<|im_end|>` strings and the
    // tokenizer maps them to their ids (PORT_SPEC §5).
}

impl ModelConfig {
    /// Read `config.json` (repo B layout: token ids top-level, dims under `talker_config`).
    /// Missing fields fall back to the PORT_SPEC §3 constants so future checkpoints keep
    /// working. (inference.py `generate` L283-292 reads the same fields.)
    fn load(dir: &Path) -> Qwen3TtsResult<Self> {
        let path = dir.join("config.json");
        let json: serde_json::Value = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s)
                .map_err(|e| Qwen3TtsError::Config(format!("parse config.json: {e}")))?,
            // A missing config is tolerated — the fallback constants are the verified
            // VoiceDesign values (PORT_SPEC §3).
            Err(_) => serde_json::Value::Null,
        };
        let top = |k: &str, fb: i64| -> i64 { json.get(k).and_then(|v| v.as_i64()).unwrap_or(fb) };
        let tc = json.get("talker_config");
        let tci = |k: &str, fb: i64| -> i64 {
            tc.and_then(|c| c.get(k))
                .and_then(|v| v.as_i64())
                .unwrap_or(fb)
        };
        let tcu = |k: &str, fb: usize| -> usize {
            tc.and_then(|c| c.get(k))
                .and_then(|v| v.as_u64())
                .map_or(fb, |v| v as usize)
        };
        Ok(Self {
            hidden: tcu("hidden_size", FB_HIDDEN),
            kv_heads: tcu("num_key_value_heads", FB_KV_HEADS),
            head_dim: tcu("head_dim", FB_HEAD_DIM),
            vocab: tcu("vocab_size", FB_VOCAB),
            // A ZERO here is treated as absent, not honoured: `residual_vocab` is the
            // upper bound of the sub-codebook sampler's range, so 0 would hand the
            // sampler an empty row. Keeping it >= 1 makes "valid range is non-empty" an
            // invariant of the struct rather than a check every call site must repeat.
            residual_vocab: tc
                .and_then(|c| c.get("code_predictor_config"))
                .and_then(|c| c.get("vocab_size"))
                .and_then(serde_json::Value::as_u64)
                .filter(|&v| v > 0)
                .map_or(FB_RESIDUAL_VOCAB, |v| v as usize),
            tts_bos: top("tts_bos_token_id", FB_TTS_BOS),
            tts_eos: top("tts_eos_token_id", FB_TTS_EOS),
            tts_pad: top("tts_pad_token_id", FB_TTS_PAD),
            codec_eos: tci("codec_eos_token_id", FB_CODEC_EOS),
            codec_pad: tci("codec_pad_id", FB_CODEC_PAD),
            codec_bos: tci("codec_bos_id", FB_CODEC_BOS),
            codec_nothink: tci("codec_nothink_id", FB_CODEC_NOTHINK),
            codec_think_bos: tci("codec_think_bos_id", FB_CODEC_THINK_BOS),
            codec_think_eos: tci("codec_think_eos_id", FB_CODEC_THINK_EOS),
            spk_id: tc
                .and_then(|c| c.get("spk_id"))
                .and_then(|v| v.as_object())
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| v.as_i64().map(|id| (k.to_ascii_lowercase(), id)))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// Loaded ONNX sessions + tokenizer + resolved config + introspected KV names.
struct Loaded {
    text_embed: Session,
    codec_embed: Session,
    talker_cache: Session,
    code_predictor: Session,
    residual_embed: Session,
    tok_decoder: Session,
    tokenizer: Tokenizer,
    cfg: ModelConfig,
    /// talker_cache past-K/V input names = inputs after index 3 (PORT_SPEC §2).
    past_names: Vec<String>,
    /// talker_cache present-K/V output names = outputs after index 2 (PORT_SPEC §2).
    present_names: Vec<String>,
}

pub struct Qwen3TtsEngine {
    /// Root dir holding the 6 ONNX + manifest.json under `<quant_subdir>/`, plus
    /// config.json / vocab.json / merges.txt / tokenizer_config.json at the root.
    cache_dir: PathBuf,
    /// Quant selector ∈ {"int4","fp16","fp32"} → subdir `cpu_int4|cpu_fp16|cpu_fp32`.
    quant: String,
    /// How to read the `voice` argument (see [`Qwen3TtsVoiceMode`]).
    voice_mode: Qwen3TtsVoiceMode,
    inner: LazyOrtEngine<Loaded>,
}

impl Qwen3TtsEngine {
    pub fn new(cache_dir: PathBuf, quant: String, voice_mode: Qwen3TtsVoiceMode) -> Self {
        Self {
            cache_dir,
            quant,
            voice_mode,
            inner: LazyOrtEngine::new(),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.is_ready()
    }

    pub fn warm_up(&self) -> Qwen3TtsResult<()> {
        self.inner.warm_up(
            || Qwen3TtsError::Session("lock poisoned".into()),
            || self.load(),
        )
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }

    /// Map the quant id to the on-disk weights subdir (BUILD_PLAN §"HF sources").
    fn quant_subdir(&self) -> &'static str {
        match self.quant.as_str() {
            "fp16" => "cpu_fp16",
            "fp32" => "cpu_fp32",
            // int4 is the shippable default; unknown ids fall through to it.
            _ => "cpu_int4",
        }
    }

    fn weights_dir(&self) -> PathBuf {
        self.cache_dir.join(self.quant_subdir())
    }

    /// Resolve `<weights_dir>/<manifest.sub_models[name].filename>`; falls back to
    /// `<name>.onnx` if the manifest is missing/incomplete (the reference filenames
    /// are all `<name>.onnx`).
    fn session_path(&self, manifest: &serde_json::Value, name: &str) -> PathBuf {
        let file = manifest
            .get("sub_models")
            .and_then(|m| m.get(name))
            .and_then(|s| s.get("filename"))
            .and_then(|f| f.as_str())
            .map_or_else(|| format!("{name}.onnx"), |s| s.to_string());
        self.weights_dir().join(file)
    }

    fn load(&self) -> Qwen3TtsResult<Loaded> {
        let wdir = self.weights_dir();
        let manifest_path = wdir.join("manifest.json");
        let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Null);

        let names = [
            "text_embed",
            "codec_embed",
            "talker_cache",
            "code_predictor",
            "residual_embed",
            "tok_decoder",
        ];
        for name in names {
            let p = self.session_path(&manifest, name);
            if !p.exists() {
                return Err(Qwen3TtsError::AssetsMissing(format!(
                    "missing {} under {}",
                    p.display(),
                    wdir.display()
                )));
            }
        }

        let text_embed = build_session(&self.session_path(&manifest, "text_embed"))?;
        let codec_embed = build_session(&self.session_path(&manifest, "codec_embed"))?;
        let talker_cache = build_session(&self.session_path(&manifest, "talker_cache"))?;
        let code_predictor = build_session(&self.session_path(&manifest, "code_predictor"))?;
        let residual_embed = build_session(&self.session_path(&manifest, "residual_embed"))?;
        let tok_decoder = build_session(&self.session_path(&manifest, "tok_decoder"))?;

        let cfg = ModelConfig::load(&self.cache_dir)?;
        let tokenizer = load_or_build_tokenizer(&self.cache_dir)?;

        // Introspect talker_cache past/present KV names by INDEX (PORT_SPEC §2):
        //   past inputs   = get_inputs()[3:]   (after inputs_embeds/position_ids/attention_mask)
        //   present outs  = get_outputs()[2:]  (after logits/hidden)
        // Ordered layer0_k, layer0_v, …; do NOT hardcode.
        let past_names: Vec<String> = talker_cache
            .inputs()
            .iter()
            .skip(3)
            .map(|i| i.name().to_string())
            .collect();
        let present_names: Vec<String> = talker_cache
            .outputs()
            .iter()
            .skip(2)
            .map(|o| o.name().to_string())
            .collect();
        if past_names.is_empty() || past_names.len() != present_names.len() {
            return Err(Qwen3TtsError::Session(format!(
                "talker_cache KV introspection mismatch: {} past vs {} present",
                past_names.len(),
                present_names.len()
            )));
        }

        Ok(Loaded {
            text_embed,
            codec_embed,
            talker_cache,
            code_predictor,
            residual_embed,
            tok_decoder,
            tokenizer,
            cfg,
            past_names,
            present_names,
        })
    }

    /// Synthesize `text` in the requested voice. `voice` is either the VoiceDesign
    /// instruct prompt or a CustomVoice preset-timbre name, per the engine's
    /// [`Qwen3TtsVoiceMode`]. Empty ⇒ the checkpoint's own default voice, never an
    /// error. Returns mono f32 PCM @ 24 kHz.
    ///
    /// `lang` and `speed` are accepted for the `TtsEngine` contract but ignored in v1
    /// (language Auto / nothink; natural rate) — see the module header + BUILD_PLAN §.
    pub fn synthesize(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> Qwen3TtsResult<Vec<f32>> {
        let _ = (lang, speed); // v1: language Auto/nothink; speed ignored (natural rate).
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let voice = voice.trim();
        // Per-call rng seed derived from the request so a given (text, voice) pair is
        // reproducible within a run but different requests get different voices. Greedy
        // (parity) ignores the rng entirely.
        let seed = fnv1a_seed(trimmed) ^ fnv1a_seed(voice);
        let mode = self.voice_mode;
        self.inner.with_loaded(
            || Qwen3TtsError::Session("lock poisoned".into()),
            || Qwen3TtsError::Session("qwen3-tts session was not initialized".into()),
            || self.load(),
            |loaded| {
                let (instruct, speaker) = match mode {
                    Qwen3TtsVoiceMode::DesignPrompt => (voice, ""),
                    Qwen3TtsVoiceMode::PresetSpeaker => ("", voice),
                };
                generate(loaded, trimmed, instruct, speaker, seed)
            },
        )
    }
}

fn build_session(path: &Path) -> Qwen3TtsResult<Session> {
    // CPU-only for v1: the int4 talker relies on MatMulNBits and DirectML has not been
    // validated for this multi-graph pipeline (mirrors the chatterbox CPU-pin rationale).
    super::provider::cpu_session(
        path,
        "Qwen3-TTS DirectML policy is not validated yet",
        "Qwen3-TTS",
    )
    .map_err(Qwen3TtsError::Session)
}

/// FNV-1a 64-bit hash of a string → a stable per-call rng seed.
fn fnv1a_seed(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

// ── ONNX extraction helpers (chatterbox.rs style) ───────────────────────────────

/// Extract session output #`idx` as an owned dynamic f32 array.
fn out_f32(outputs: &ort::session::SessionOutputs<'_>, idx: usize) -> Qwen3TtsResult<ArrayD<f32>> {
    let (shape, data) = outputs[idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| Qwen3TtsError::Inference(format!("extract out[{idx}]: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| Qwen3TtsError::Inference(format!("shape out[{idx}]: {e}")))
}

/// Extract a named f32 output as an owned dynamic array.
fn out_f32_named(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Qwen3TtsResult<ArrayD<f32>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| Qwen3TtsError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| Qwen3TtsError::Inference(format!("shape {name}: {e}")))
}

// ── embed sub-models ────────────────────────────────────────────────────────────

/// text_embed(text_ids[1,T]) → [1,T,H]  (inference.py `embed_text` L135-136).
fn embed_text(sess: &mut Session, ids: &[i64]) -> Qwen3TtsResult<ArrayD<f32>> {
    let n = ids.len();
    let t = Tensor::from_array(
        Array2::from_shape_vec((1, n), ids.to_vec())
            .map_err(|e| Qwen3TtsError::Inference(format!("text_ids arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("text_ids tensor: {e}")))?;
    let out = sess
        .run(ort::inputs! { "text_ids" => t })
        .map_err(|e| Qwen3TtsError::Inference(format!("text_embed: {e}")))?;
    out_f32(&out, 0)
}

/// codec_embed(codec_ids[1,T]) → [1,T,H]  (inference.py `embed_codec` L138-139).
fn embed_codec(sess: &mut Session, ids: &[i64]) -> Qwen3TtsResult<ArrayD<f32>> {
    let n = ids.len();
    let t = Tensor::from_array(
        Array2::from_shape_vec((1, n), ids.to_vec())
            .map_err(|e| Qwen3TtsError::Inference(format!("codec_ids arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("codec_ids tensor: {e}")))?;
    let out = sess
        .run(ort::inputs! { "codec_ids" => t })
        .map_err(|e| Qwen3TtsError::Inference(format!("codec_embed: {e}")))?;
    out_f32(&out, 0)
}

/// residual_embed(codec_ids[1,16]) → step_embed[1,H]  (inference.py `step_embed` L166-167).
fn residual_step_embed(sess: &mut Session, codes16: &[i64; N_GROUPS]) -> Qwen3TtsResult<Vec<f32>> {
    let t = Tensor::from_array(
        Array2::from_shape_vec((1, N_GROUPS), codes16.to_vec())
            .map_err(|e| Qwen3TtsError::Inference(format!("residual codec arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("residual codec tensor: {e}")))?;
    let out = sess
        .run(ort::inputs! { "codec_ids" => t })
        .map_err(|e| Qwen3TtsError::Inference(format!("residual_embed: {e}")))?;
    let arr = out_f32(&out, 0)?; // [1,H]
    Ok(arr.iter().copied().collect())
}

/// code_predictor(talker_hidden[1,H], codec_ids[1,16]) → group_logits[1,15,V]
/// (inference.py `predict_residual` L161-164). Returns the flat [15*V] row.
fn code_predictor_logits(
    sess: &mut Session,
    hidden: &[f32],
    codes16: &[i64; N_GROUPS],
) -> Qwen3TtsResult<ArrayD<f32>> {
    let th = Tensor::from_array(
        Array2::from_shape_vec((1, hidden.len()), hidden.to_vec())
            .map_err(|e| Qwen3TtsError::Inference(format!("talker_hidden arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("talker_hidden tensor: {e}")))?;
    let ct = Tensor::from_array(
        Array2::from_shape_vec((1, N_GROUPS), codes16.to_vec())
            .map_err(|e| Qwen3TtsError::Inference(format!("cp codec arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("cp codec tensor: {e}")))?;
    let out = sess
        .run(ort::inputs! { "talker_hidden" => th, "codec_ids" => ct })
        .map_err(|e| Qwen3TtsError::Inference(format!("code_predictor: {e}")))?;
    out_f32(&out, 0)
}

// ── prefill assembly (PORT_SPEC §5 / inference.py generate L263-358) ─────────────

/// Resolve a CustomVoice preset-timbre name to its codec token id via
/// `talker_config.spk_id` (case-insensitive, as the reference lowercases before the
/// lookup). `None` for an empty name, a VoiceDesign checkpoint (empty map), or an
/// unrecognised name — all of which mean "use the checkpoint's default timbre" rather
/// than failing the read, so a persisted selection from another model still speaks.
fn speaker_token(cfg: &ModelConfig, speaker: &str) -> Option<i64> {
    if speaker.is_empty() || cfg.spk_id.is_empty() {
        return None;
    }
    cfg.spk_id.get(&speaker.to_ascii_lowercase()).copied()
}

/// Slice `[1, T, H]` embeds along the T axis into `[start, end)`, appending flat.
/// (batch is always 1 → contiguous rows.)
fn append_rows(dst: &mut Vec<f32>, embeds: &ArrayD<f32>, start: usize, end: usize, hidden: usize) {
    let flat = embeds.as_slice().expect("embeds contiguous");
    dst.extend_from_slice(&flat[start * hidden..end * hidden]);
}

/// Build the talker prefill embed `[1, L, H]` (flat) and the trailing pad-embed `[H]`
/// added to every generated step. Empty `instruct` ⇒ no instruct prefix (default voice)
/// — PORT_SPEC §5 "Empty-instruct handling". Empty/unknown `speaker` ⇒ no speaker row
/// (the checkpoint's default timbre); an unknown name is NOT an error, so a stale
/// persisted selection still speaks.
fn build_prefill(
    loaded: &mut Loaded,
    text: &str,
    instruct: &str,
    speaker: &str,
) -> Qwen3TtsResult<(Vec<f32>, usize, Vec<f32>)> {
    let cfg = &loaded.cfg;
    let h = cfg.hidden;

    // 0) assistant template → ids (inference.py L295-298). Encode WITH special tokens so
    //    <|im_start|>/<|im_end|> map to their ids.
    let assistant = format!("<|im_start|>assistant\n{text}<|im_end|>\n<|im_start|>assistant\n");
    let enc = loaded
        .tokenizer
        .encode(assistant, true)
        .map_err(|e| Qwen3TtsError::Tokenizer(e.to_string()))?;
    let input_id: Vec<i64> = enc.get_ids().iter().map(|&u| u as i64).collect();
    if input_id.len() < 9 {
        return Err(Qwen3TtsError::Inference(
            "text tokenized too short for the assistant template".into(),
        ));
    }

    // 1) special text embeds tts_bos/eos/pad (inference.py L301-302). spec = [1,3,H].
    let spec = embed_text(
        &mut loaded.text_embed,
        &[cfg.tts_bos, cfg.tts_eos, cfg.tts_pad],
    )?;
    let spec_flat = spec.as_slice().expect("spec contiguous");
    let bos_e = &spec_flat[0..h]; // [H]
    let eos_e = &spec_flat[h..2 * h]; // [H]
    let pad_e = &spec_flat[2 * h..3 * h]; // [H]

    // 2/3) language Auto → nothink codec prefill (P=3) (inference.py L305-315).
    let codec_prefill = [cfg.codec_nothink, cfg.codec_think_bos, cfg.codec_think_eos];
    let codec0 = embed_codec(&mut loaded.codec_embed, &codec_prefill)?; // [1,3,H]
    let codec1 = embed_codec(&mut loaded.codec_embed, &[cfg.codec_pad, cfg.codec_bos])?; // [1,2,H]
    // 4) CustomVoice preset timbre: the speaker's codec token embeds to ONE row spliced
    //    BETWEEN codec0 and codec1 (inference.py L322-330). VoiceDesign has an empty
    //    `spk_id` map, so this is skipped and codec_input stays [1,5,H].
    let speaker_row: Option<ArrayD<f32>> = match speaker_token(cfg, speaker) {
        Some(id) => Some(embed_codec(&mut loaded.codec_embed, &[id])?), // [1,1,H]
        None => None,
    };
    let codec_len = 3 + usize::from(speaker_row.is_some()) + 2;
    let mut codec_input: Vec<f32> = Vec::with_capacity(codec_len * h);
    append_rows(&mut codec_input, &codec0, 0, 3, h);
    if let Some(row) = &speaker_row {
        append_rows(&mut codec_input, row, 0, 1, h);
    }
    append_rows(&mut codec_input, &codec1, 0, 2, h);

    // 5) instruct prefix embeds (only when non-empty) (inference.py L332-336). Both
    //    checkpoints accept an instruct; VoiceDesign uses it to DESIGN the timbre,
    //    CustomVoice to style an already-chosen preset.
    let prefix: Option<Vec<f32>> = if instruct.is_empty() {
        None
    } else {
        let instruct_text = format!("<|im_start|>user\n{instruct}<|im_end|>\n");
        let ienc = loaded
            .tokenizer
            .encode(instruct_text, true)
            .map_err(|e| Qwen3TtsError::Tokenizer(e.to_string()))?;
        let iids: Vec<i64> = ienc.get_ids().iter().map(|&u| u as i64).collect();
        let iemb = embed_text(&mut loaded.text_embed, &iids)?; // [1,Lp,H]
        Some(iemb.iter().copied().collect())
    };

    // 6) role = embed_text(input_id[:, :3]) → [1,3,H] (inference.py L339).
    let role = embed_text(&mut loaded.text_embed, &input_id[..3])?;

    // 7) pad_block = concat([repeat(pad_e, codec_len-2), bos_e]) → [1,codec_len-1,H]
    //    (inference.py L340-341). codec_len-2 = 3 pad rows + 1 bos row = 4 rows.
    let pad_reps = codec_len - 2;

    // 8) talker_in = concat([role, pad_block + codec_input[:, :-1]]) (inference.py L342).
    //    pad_block has (pad_reps + 1) = codec_len-1 rows; codec_input[:, :-1] has
    //    codec_len-1 rows → elementwise sum.
    let mut talker: Vec<f32> = Vec::new();
    // role rows (3)
    append_rows(&mut talker, &role, 0, 3, h);
    // pad_block[r] + codec_input[r] for r in 0..codec_len-1
    for r in 0..(codec_len - 1) {
        // pad_block row r: first `pad_reps` rows are pad_e, the last is bos_e.
        let pb: &[f32] = if r < pad_reps { pad_e } else { bos_e };
        let ci = &codec_input[r * h..(r + 1) * h];
        talker.extend(pb.iter().zip(ci).map(|(a, b)| a + b));
    }

    // 9) body_ids = input_id[:, 3:-5]; text_body = embed_text(body_ids) → [1,Ltext,H];
    //    block1 = concat([text_body, eos_e]) + embed_codec([[codec_pad]*(Ltext+1)])
    //    (inference.py L344-348).
    let body_ids = &input_id[3..input_id.len() - 5];
    let ltext = body_ids.len();
    let text_body = embed_text(&mut loaded.text_embed, body_ids)?; // [1,Ltext,H]
    let codec_pad_row = vec![cfg.codec_pad; ltext + 1];
    let block1_codec = embed_codec(&mut loaded.codec_embed, &codec_pad_row)?; // [1,Ltext+1,H]
    let bc_flat = block1_codec.as_slice().expect("block1_codec contiguous");
    let tb_flat = text_body.as_slice().expect("text_body contiguous");
    // block1 rows 0..Ltext = text_body + codec; row Ltext = eos_e + codec.
    for r in 0..(ltext + 1) {
        let text_row: &[f32] = if r < ltext {
            &tb_flat[r * h..(r + 1) * h]
        } else {
            eos_e
        };
        let codec_row = &bc_flat[r * h..(r + 1) * h];
        talker.extend(text_row.iter().zip(codec_row).map(|(a, b)| a + b));
    }

    // 10) block2 = pad_e + embed_codec([[codec_bos]]) → [1,1,H] (inference.py L349).
    let block2_codec = embed_codec(&mut loaded.codec_embed, &[cfg.codec_bos])?; // [1,1,H]
    let b2_flat = block2_codec.as_slice().expect("block2 contiguous");
    talker.extend(pad_e.iter().zip(&b2_flat[..h]).map(|(a, b)| a + b));

    // 12) if prefix: talker_in = concat(prefix + [talker_in]) (inference.py L351-352).
    let full = if let Some(pre) = prefix {
        let mut out = Vec::with_capacity(pre.len() + talker.len());
        out.extend_from_slice(&pre);
        out.extend_from_slice(&talker);
        out
    } else {
        talker
    };

    // 13) trailing = pad_e (added to every generated step's embed) (inference.py L354).
    let trailing = pad_e.to_vec();

    let seq = full.len() / h;
    Ok((full, seq, trailing))
}

// ── cached AR loop (PORT_SPEC §6 / inference.py _ar_loop_cached L407-447) ─────────

/// Run the talker prefill + KV-cache decode + code_predictor inner loop, returning the
/// generated codes `[T, 16]` (flattened row-major). Host-side KV threading (present →
/// past each step, chatterbox style; plain `session.run`).
fn generate(
    loaded: &mut Loaded,
    text: &str,
    instruct: &str,
    speaker: &str,
    seed: u64,
) -> Qwen3TtsResult<Vec<f32>> {
    let cfg = loaded.cfg.clone();
    let h = cfg.hidden;
    let vocab = cfg.vocab;

    let (prefill_flat, t0, trailing) = build_prefill(loaded, text, instruct, speaker)?;

    // suppress = [vocab-1024, vocab) except codec_eos (inference.py L413, PORT_SPEC §3).
    let suppress_lo = vocab.saturating_sub(1024);
    let codec_eos = cfg.codec_eos;

    // Empty KV: 56 tensors of shape [1, kv_heads, 0, head_dim] (inference.py L414).
    let mut kv: BTreeMap<String, ArrayD<f32>> = BTreeMap::new();
    for name in &loaded.past_names {
        kv.insert(
            name.clone(),
            ArrayD::from_shape_vec(IxDyn(&[1, cfg.kv_heads, 0, cfg.head_dim]), Vec::new())
                .map_err(|e| Qwen3TtsError::Inference(format!("empty kv: {e}")))?,
        );
    }

    // Prefill: inputs_embeds[1,T0,H], position_ids[3,1,T0]=broadcast(arange(T0)),
    // attention_mask[1,T0]=ones (inference.py L416-417).
    let mut inputs_embeds: ArrayD<f32> = Array3::from_shape_vec((1, t0, h), prefill_flat)
        .map_err(|e| Qwen3TtsError::Inference(format!("prefill embeds: {e}")))?
        .into_dyn();
    let mut pos: Vec<i64> = (0..t0 as i64).collect();
    let mut total = t0;

    let mut rng = sampling::SplitMix64Rng::new(seed);
    let mut all_codes: Vec<[i64; N_GROUPS]> = Vec::new();
    let mut prev_first: Vec<i64> = Vec::new();

    // Run the initial prefill step, then loop decoding one frame per step.
    let (mut logits, mut hidden, mut present) =
        run_talker_cache(loaded, &inputs_embeds, &pos, total, &mut kv)?;
    thread_present_into_past(loaded, &mut kv, present.take());

    // `total` is the running sequence length (starts at t0, not 0) — it feeds the
    // KV-cache position id each step, so it is not a plain 0-based loop counter.
    #[allow(clippy::explicit_counter_loop)]
    for _step in 0..MAX_NEW_TOKENS {
        // first = logits[0,-1] (f64); suppress; repetition penalty (inference.py L421-423).
        let mut first = last_step_logits_f64(&logits, vocab)?;
        // suppress = [vocab-1024, vocab) except codec_eos → -inf on the first codebook.
        for (offset, v) in first[suppress_lo..].iter_mut().enumerate() {
            let id = (suppress_lo + offset) as i64;
            if id != codec_eos {
                *v = f64::NEG_INFINITY;
            }
        }
        sampling::apply_repetition_penalty(&mut first, &prev_first, REPETITION_PENALTY);
        let code0 = sampling::sample(&first, DO_SAMPLE, TOP_K, TOP_P, TEMPERATURE, &mut rng) as i64;
        if code0 == codec_eos {
            break;
        }
        prev_first.push(code0);

        // th = hidden[0,-1] (inference.py L428).
        let th = last_step_hidden(&hidden, h)?;

        // 16-group teacher-forced code_predictor inner loop (inference.py L429-434).
        let mut codes16 = [0i64; N_GROUPS];
        codes16[0] = code0;
        for j in 1..N_GROUPS {
            let gl = code_predictor_logits(&mut loaded.code_predictor, &th, &codes16)?; // [1,15,G]
            // gl[0, j-1] — the (j-1)-th group row, sliced at the tensor stride but truncated to
            // the residual codebook size so no out-of-range code is sampled (see below).
            let row = code_predictor_row_f64(&gl, j - 1, cfg.residual_vocab)?;
            codes16[j] = sampling::sample(
                &row,
                SUB_DO_SAMPLE,
                SUB_TOP_K,
                SUB_TOP_P,
                SUB_TEMPERATURE,
                &mut rng,
            ) as i64;
        }
        all_codes.push(codes16);

        // nxt = residual_embed(codes16) + trailing → [1,1,H] (inference.py L436).
        let step_embed = residual_step_embed(&mut loaded.residual_embed, &codes16)?;
        let nxt: Vec<f32> = step_embed
            .iter()
            .zip(&trailing)
            .map(|(a, b)| a + b)
            .collect();
        inputs_embeds = Array3::from_shape_vec((1, 1, h), nxt)
            .map_err(|e| Qwen3TtsError::Inference(format!("nxt embed: {e}")))?
            .into_dyn();

        // pos = [total]; mask = ones(total+1) (inference.py L437-439).
        pos = vec![total as i64];

        let (l, hd, pr) = run_talker_cache(loaded, &inputs_embeds, &pos, total + 1, &mut kv)?;
        logits = l;
        hidden = hd;
        present = pr;
        thread_present_into_past(loaded, &mut kv, present.take());
        total += 1;
    }

    // Decode codes [T,16] → 24 kHz f32 (PORT_SPEC §7).
    decode_chunked(loaded, &all_codes)
}

/// Wraps the per-step present outputs so the caller can move them into the KV map.
struct Present(Vec<(String, ArrayD<f32>)>);
impl Present {
    fn take(&mut self) -> Vec<(String, ArrayD<f32>)> {
        std::mem::take(&mut self.0)
    }
}

/// Run one talker_cache step (prefill or decode). `attn_len` = current total sequence
/// length covered by the attention mask (T0 on prefill, total+1 on decode). Consumes
/// the KV arrays from `kv` (moved into tensors) and returns (logits, hidden, present).
fn run_talker_cache(
    loaded: &mut Loaded,
    inputs_embeds: &ArrayD<f32>,
    pos: &[i64],
    attn_len: usize,
    kv: &mut BTreeMap<String, ArrayD<f32>>,
) -> Qwen3TtsResult<(ArrayD<f32>, ArrayD<f32>, Present)> {
    let cur = pos.len();
    let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + loaded.past_names.len());

    let emb_t = Tensor::from_array(inputs_embeds.clone())
        .map_err(|e| Qwen3TtsError::Inference(format!("inputs_embeds tensor: {e}")))?;
    inputs.push((
        Cow::Borrowed("inputs_embeds"),
        SessionInputValue::from(emb_t),
    ));

    // position_ids[3,1,cur] = broadcast(pos) — 3 identical rows (MROPE reduces to arange
    // for the unpadded single sequence) (inference.py L416/L437).
    let mut pos3: Vec<i64> = Vec::with_capacity(3 * cur);
    for _ in 0..3 {
        pos3.extend_from_slice(pos);
    }
    let pos_t = Tensor::from_array(
        Array3::from_shape_vec((3, 1, cur), pos3)
            .map_err(|e| Qwen3TtsError::Inference(format!("position_ids arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("position_ids tensor: {e}")))?;
    inputs.push((
        Cow::Borrowed("position_ids"),
        SessionInputValue::from(pos_t),
    ));

    let mask_t = Tensor::from_array(
        Array2::from_shape_vec((1, attn_len), vec![1i64; attn_len])
            .map_err(|e| Qwen3TtsError::Inference(format!("mask arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("mask tensor: {e}")))?;
    inputs.push((
        Cow::Borrowed("attention_mask"),
        SessionInputValue::from(mask_t),
    ));

    // Move each cached past K/V into its tensor (refilled from present right after).
    for name in &loaded.past_names {
        let arr = kv
            .remove(name)
            .ok_or_else(|| Qwen3TtsError::Inference(format!("missing kv {name}")))?;
        let t = Tensor::from_array(arr)
            .map_err(|e| Qwen3TtsError::Inference(format!("kv {name}: {e}")))?;
        inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
    }

    let outputs = loaded
        .talker_cache
        .run(inputs)
        .map_err(|e| Qwen3TtsError::Inference(format!("talker_cache run: {e}")))?;

    // out[0]=logits, out[1]=hidden, out[2:]=present (PORT_SPEC §2).
    let logits = out_f32(&outputs, 0)?;
    let hidden = out_f32(&outputs, 1)?;
    let mut present: Vec<(String, ArrayD<f32>)> = Vec::with_capacity(loaded.present_names.len());
    for pname in &loaded.present_names {
        present.push((pname.clone(), out_f32_named(&outputs, pname)?));
    }
    Ok((logits, hidden, Present(present)))
}

/// Carry `present.*` → `past.*` by ORDER (present[i] fills past_names[i]); the
/// introspected name lists are index-aligned (layer0_k, layer0_v, …).
fn thread_present_into_past(
    loaded: &Loaded,
    kv: &mut BTreeMap<String, ArrayD<f32>>,
    present: Vec<(String, ArrayD<f32>)>,
) {
    for (i, (_pname, arr)) in present.into_iter().enumerate() {
        kv.insert(loaded.past_names[i].clone(), arr);
    }
}

/// logits[0, -1] as an f64 row of length `vocab`. logits is [1, cur, V].
fn last_step_logits_f64(logits: &ArrayD<f32>, vocab: usize) -> Qwen3TtsResult<Vec<f64>> {
    let flat = logits
        .as_slice()
        .ok_or_else(|| Qwen3TtsError::Inference("logits not contiguous".into()))?;
    let shape = logits.shape();
    let cur = *shape.get(1).unwrap_or(&0);
    if cur == 0 || flat.len() < cur * vocab {
        return Err(Qwen3TtsError::Inference("logits shape unexpected".into()));
    }
    let start = (cur - 1) * vocab;
    Ok(flat[start..start + vocab]
        .iter()
        .map(|&x| x as f64)
        .collect())
}

/// hidden[0, -1] as an f32 row of length H. hidden is [1, cur, H].
fn last_step_hidden(hidden: &ArrayD<f32>, h: usize) -> Qwen3TtsResult<Vec<f32>> {
    let flat = hidden
        .as_slice()
        .ok_or_else(|| Qwen3TtsError::Inference("hidden not contiguous".into()))?;
    let shape = hidden.shape();
    let cur = *shape.get(1).unwrap_or(&0);
    if cur == 0 || flat.len() < cur * h {
        return Err(Qwen3TtsError::Inference("hidden shape unexpected".into()));
    }
    let start = (cur - 1) * h;
    Ok(flat[start..start + h].to_vec())
}

/// group_logits[0, row] as an f64 vec, truncated to the residual codebook size.
///
/// TWO different widths are in play and conflating them is a live bug:
///   * the tensor's last dim is the STRIDE (3072 — the export pads every group row out to the
///     talker vocab), so the row must be sliced at that stride or every row after the first is
///     read from a misaligned offset and decodes garbage;
///   * only the first `residual_vocab` (2048) entries are REAL codes. The remaining 1024 are
///     padding standing where the talker's control tokens live, and only the first codebook may
///     emit those. Sampling the padded tail returns an id ≥ 2048, which the next
///     `code_predictor` call rejects outright — "indices element out of data bounds, idx=3051
///     must be within the inclusive range [-2048,2047]" from its GatherBlockQuantized codebook
///     lookup — so the row is truncated to the valid range before it reaches the sampler.
fn code_predictor_row_f64(
    gl: &ArrayD<f32>,
    row: usize,
    residual_vocab: usize,
) -> Qwen3TtsResult<Vec<f64>> {
    let stride = *gl
        .shape()
        .last()
        .ok_or_else(|| Qwen3TtsError::Inference("group_logits has no shape".into()))?;
    let flat = gl
        .as_slice()
        .ok_or_else(|| Qwen3TtsError::Inference("group_logits not contiguous".into()))?;
    let start = row * stride;
    if stride == 0 || flat.len() < start + stride {
        return Err(Qwen3TtsError::Inference(
            "group_logits shape unexpected".into(),
        ));
    }
    // A checkpoint whose export is already tight (stride == residual_vocab) is handled by the
    // min: never read past the row. A ZERO `residual_vocab` (a config declaring
    // `code_predictor_config.vocab_size: 0`) would otherwise yield an EMPTY row and hand the
    // sampler nothing to choose from — `ModelConfig::load` already rejects it, and this
    // second guard keeps the function total for any other caller.
    let vocab = if residual_vocab == 0 {
        FB_RESIDUAL_VOCAB
    } else {
        residual_vocab
    };
    let width = vocab.min(stride);
    Ok(flat[start..start + width]
        .iter()
        .map(|&x| x as f64)
        .collect())
}

// ── codec decode (PORT_SPEC §7 / inference.py decode_chunked L197-211) ───────────

/// tok_decoder(audio_codes[1,25,16]) → waveform[1,1,L] (inference.py `decode` L194-195).
fn decode_frames(loaded: &mut Loaded, chunk: &[[i64; N_GROUPS]]) -> Qwen3TtsResult<Vec<f32>> {
    debug_assert_eq!(chunk.len(), DEC_FRAMES);
    let mut flat: Vec<i64> = Vec::with_capacity(DEC_FRAMES * N_GROUPS);
    for row in chunk {
        flat.extend_from_slice(row);
    }
    let t = Tensor::from_array(
        ArrayD::from_shape_vec(IxDyn(&[1, DEC_FRAMES, N_GROUPS]), flat)
            .map_err(|e| Qwen3TtsError::Inference(format!("audio_codes arr: {e}")))?,
    )
    .map_err(|e| Qwen3TtsError::Inference(format!("audio_codes tensor: {e}")))?;
    let out = loaded
        .tok_decoder
        .run(ort::inputs! { "audio_codes" => t })
        .map_err(|e| Qwen3TtsError::Inference(format!("tok_decoder: {e}")))?;
    let wav = out_f32(&out, 0)?; // [1,1,L]
    Ok(wav.iter().copied().collect())
}

/// Decode arbitrary-length codes through the fixed-25-frame decoder by tiling each
/// 25-frame chunk; the tail chunk is padded by repetition (`idx = arange(25) % len`)
/// then trimmed to `round(L * (F - s) / 25)` samples (inference.py L197-211).
fn decode_chunked(loaded: &mut Loaded, codes: &[[i64; N_GROUPS]]) -> Qwen3TtsResult<Vec<f32>> {
    let f = codes.len();
    if f == 0 {
        // Immediate EOS / no frames — silent output (the manager tolerates empties).
        return Ok(Vec::new());
    }
    let mut out: Vec<f32> = Vec::new();
    let mut s = 0usize;
    while s < f {
        let end = (s + DEC_FRAMES).min(f);
        let len = end - s;
        if len < DEC_FRAMES {
            // Pad the tail by repetition: chunk[idx] where idx = arange(25) % len.
            let mut chunk = [[0i64; N_GROUPS]; DEC_FRAMES];
            for (i, slot) in chunk.iter_mut().enumerate() {
                *slot = codes[s + (i % len)];
            }
            let wav = decode_frames(loaded, &chunk)?;
            // keep = round(L * (F - s) / 25).
            let keep =
                ((wav.len() as f64) * ((f - s) as f64) / (DEC_FRAMES as f64)).round() as usize;
            let keep = keep.min(wav.len());
            out.extend_from_slice(&wav[..keep]);
            break;
        }
        let mut chunk = [[0i64; N_GROUPS]; DEC_FRAMES];
        chunk.copy_from_slice(&codes[s..end]);
        let wav = decode_frames(loaded, &chunk)?;
        out.extend_from_slice(&wav);
        s += DEC_FRAMES;
    }
    Ok(out)
}

// ── tokenizer (build from vocab.json + merges.txt; PORT_SPEC §4) ─────────────────

/// Load `<dir>/tokenizer.json` if present; otherwise build the Qwen2 byte-level BPE
/// tokenizer from `vocab.json` + `merges.txt` + `tokenizer_config.json`, `.save()` it
/// next to the model, and reload it (matches qwen3.rs / chatterbox.rs, which
/// `Tokenizer::from_file`). Chat templating is manual string concat (PORT_SPEC §5).
fn load_or_build_tokenizer(dir: &Path) -> Qwen3TtsResult<Tokenizer> {
    let tok_json = dir.join("tokenizer.json");
    if tok_json.exists() {
        return Tokenizer::from_file(&tok_json)
            .map_err(|e| Qwen3TtsError::Tokenizer(format!("load tokenizer.json: {e}")));
    }
    let built = build_qwen2_tokenizer(dir)?;
    // Persist so subsequent loads take the fast from_file path.
    let _ = built.save(&tok_json, true);
    // Reload via from_file to exactly match the persisted form (as the spec directs).
    if tok_json.exists() {
        Tokenizer::from_file(&tok_json)
            .map_err(|e| Qwen3TtsError::Tokenizer(format!("reload tokenizer.json: {e}")))
    } else {
        Ok(built)
    }
}

/// Build the Qwen2 byte-level BPE tokenizer from vocab.json + merges.txt with a
/// ByteLevel pre-tokenizer + decoder, matching the verified golden tokenizer.json
/// structure (NFC normalizer; Split(Qwen2 regex, Isolated) then ByteLevel(no prefix,
/// no regex) pre-tokenizer; ByteLevel post-processor + decoder). Special tokens come
/// from tokenizer_config.json `added_tokens_decoder`, added in ascending-id order so
/// the crate assigns the exact ids (151643 = <|endoftext|> … up).
fn build_qwen2_tokenizer(dir: &Path) -> Qwen3TtsResult<Tokenizer> {
    // ByteLevel is a single struct re-exported under pre_tokenizers / processors /
    // decoders; used for all three stages (pre-tokenizer, post-processor, decoder).
    use tokenizers::models::bpe::BPE;
    use tokenizers::normalizers::unicode::NFC;
    use tokenizers::pre_tokenizers::byte_level::ByteLevel;
    use tokenizers::pre_tokenizers::sequence::Sequence as PreSequence;
    use tokenizers::pre_tokenizers::split::{Split, SplitPattern};
    use tokenizers::{AddedToken, NormalizerWrapper, PreTokenizerWrapper, SplitDelimiterBehavior};

    let vocab = dir.join("vocab.json");
    let merges = dir.join("merges.txt");
    if !vocab.exists() || !merges.exists() {
        return Err(Qwen3TtsError::AssetsMissing(format!(
            "tokenizer needs vocab.json + merges.txt under {}",
            dir.display()
        )));
    }

    // BPE core: no unk, no continuing-subword/end-of-word affixes (Qwen2 defaults;
    // matches golden model config). `from_file` reads vocab.json + merges.txt (skips
    // only `#version` lines — Qwen merges have none).
    let bpe = BPE::from_file(
        vocab
            .to_str()
            .ok_or_else(|| Qwen3TtsError::Tokenizer("vocab.json path is not valid UTF-8".into()))?,
        merges
            .to_str()
            .ok_or_else(|| Qwen3TtsError::Tokenizer("merges.txt path is not valid UTF-8".into()))?,
    )
    .continuing_subword_prefix(String::new())
    .end_of_word_suffix(String::new())
    .build()
    .map_err(|e| Qwen3TtsError::Tokenizer(format!("build BPE: {e}")))?;

    let mut tokenizer = Tokenizer::new(bpe);

    // Normalizer: NFC (golden `normalizer.type == "NFC"`).
    tokenizer.with_normalizer(Some(NormalizerWrapper::from(NFC)));

    // Pre-tokenizer: Sequence[ Split(Qwen2 GPT2-style regex, Isolated), ByteLevel(no
    // prefix, use_regex=false) ] — exactly the golden pre_tokenizer.
    // Regex verbatim from golden_tokenizer.json (onig-compatible; the `onig` feature is on).
    let qwen2_regex = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+";
    let split = Split::new(
        SplitPattern::Regex(qwen2_regex.to_string()),
        SplitDelimiterBehavior::Isolated,
        false,
    )
    .map_err(|e| Qwen3TtsError::Tokenizer(format!("split pretok: {e}")))?;
    // ByteLevel pre-tokenizer with add_prefix_space=false, trim_offsets=true, use_regex=false.
    let bl_pre = ByteLevel::new(false, true, false);
    let pre_seq = PreSequence::new(vec![
        PreTokenizerWrapper::from(split),
        PreTokenizerWrapper::from(bl_pre),
    ]);
    tokenizer.with_pre_tokenizer(Some(PreTokenizerWrapper::from(pre_seq)));

    // Post-processor + decoder: ByteLevel (golden defaults). Same struct as the
    // pre-tokenizer ByteLevel; `Into<PostProcessorWrapper>`/`Into<DecoderWrapper>` cover both.
    tokenizer.with_post_processor(Some(ByteLevel::new(true, false, true)));
    tokenizer.with_decoder(Some(ByteLevel::new(true, true, true)));

    // Special tokens from tokenizer_config.json `added_tokens_decoder`, in ascending id
    // order so add_special_tokens assigns exactly 151643.. (vocab is 0..151642 contiguous).
    let specials = read_added_special_tokens(dir);
    if !specials.is_empty() {
        let added: Vec<AddedToken> = specials
            .iter()
            .map(|(content, opts)| {
                AddedToken::from(content.clone(), true)
                    .normalized(opts.normalized)
                    .single_word(opts.single_word)
                    .lstrip(opts.lstrip)
                    .rstrip(opts.rstrip)
            })
            .collect();
        tokenizer.add_special_tokens(&added);
    } else {
        // Minimal fallback: the three ids the chat template relies on.
        tokenizer.add_special_tokens(&[
            AddedToken::from("<|endoftext|>", true),
            AddedToken::from("<|im_start|>", true),
            AddedToken::from("<|im_end|>", true),
        ]);
    }

    Ok(tokenizer)
}

/// Per-token flags mirrored from `added_tokens_decoder` entries.
struct AddedTokenOpts {
    normalized: bool,
    single_word: bool,
    lstrip: bool,
    rstrip: bool,
}

/// Read `tokenizer_config.json` `added_tokens_decoder` → (content, opts) sorted by id
/// ascending. Empty if the file is missing/unparseable.
fn read_added_special_tokens(dir: &Path) -> Vec<(String, AddedTokenOpts)> {
    let path = dir.join("tokenizer_config.json");
    let Ok(s) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&s) else {
        return Vec::new();
    };
    let Some(map) = json.get("added_tokens_decoder").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut entries: Vec<(i64, String, AddedTokenOpts)> = Vec::with_capacity(map.len());
    for (id_str, spec) in map {
        let Ok(id) = id_str.parse::<i64>() else {
            continue;
        };
        let Some(content) = spec.get("content").and_then(|c| c.as_str()) else {
            continue;
        };
        let flag = |k: &str, d: bool| spec.get(k).and_then(|v| v.as_bool()).unwrap_or(d);
        entries.push((
            id,
            content.to_string(),
            AddedTokenOpts {
                normalized: flag("normalized", false),
                single_word: flag("single_word", false),
                lstrip: flag("lstrip", false),
                rstrip: flag("rstrip", false),
            },
        ));
    }
    entries.sort_by_key(|(id, _, _)| *id);
    entries.into_iter().map(|(_, c, o)| (c, o)).collect()
}

#[cfg(test)]
mod tests {
    use super::super::local_engines::QWEN3TTS_CUSTOMVOICE_VOICES;
    use super::*;

    #[test]
    fn quant_maps_to_subdir() {
        // The subdir depends only on the quant; the voice mode is irrelevant here.
        let mode = Qwen3TtsVoiceMode::DesignPrompt;
        let e = Qwen3TtsEngine::new(PathBuf::from("/x"), "int4".into(), mode);
        assert_eq!(e.quant_subdir(), "cpu_int4");
        let e = Qwen3TtsEngine::new(PathBuf::from("/x"), "fp16".into(), mode);
        assert_eq!(e.quant_subdir(), "cpu_fp16");
        let e = Qwen3TtsEngine::new(PathBuf::from("/x"), "fp32".into(), mode);
        assert_eq!(e.quant_subdir(), "cpu_fp32");
        // Unknown quant falls through to the int4 default.
        let e = Qwen3TtsEngine::new(PathBuf::from("/x"), "weird".into(), mode);
        assert_eq!(e.quant_subdir(), "cpu_int4");
    }

    #[test]
    fn sample_rate_constant_matches() {
        assert_eq!(QWEN3TTS_SAMPLE_RATE, 24_000);
    }

    #[test]
    fn config_fallback_when_missing() {
        // A dir with no config.json yields the PORT_SPEC §3 fallback constants.
        let cfg = ModelConfig::load(Path::new("/nonexistent-qwen3tts")).unwrap();
        assert_eq!(cfg.hidden, FB_HIDDEN);
        assert_eq!(cfg.kv_heads, FB_KV_HEADS);
        assert_eq!(cfg.head_dim, FB_HEAD_DIM);
        assert_eq!(cfg.vocab, FB_VOCAB);
        assert_eq!(cfg.codec_eos, FB_CODEC_EOS);
        assert_eq!(cfg.tts_pad, FB_TTS_PAD);
        assert_eq!(cfg.codec_bos, FB_CODEC_BOS);
        // No `code_predictor_config` at all ⇒ the residual codebook size falls back
        // to 2048 (D4: the value the sub-codebook sampler is clamped to).
        assert_eq!(cfg.residual_vocab, FB_RESIDUAL_VOCAB);
    }

    // ── D4: code_predictor row extraction ────────────────────────────────────
    //
    // The shipped `qwen3-tts-1.7b-voicedesign` row could never produce audio because
    // this row slice used the TALKER vocab stride (3072) as the row width instead of
    // reading the stride off the tensor and clamping the RANGE to the residual
    // codebook size (2048). Two independent widths; conflating them fails on frame 1.

    /// `group_logits[1, 15, w]` where element `[0, r, c] = r * 100_000 + c`, so a row
    /// read from the wrong offset is immediately visible in the values (and every
    /// value is exactly representable in f32 — max 14*100_000+3071 = 1,403,071 < 2^24).
    fn synthetic_group_logits(w: usize) -> ArrayD<f32> {
        let rows = N_GROUPS - 1; // code_predictor emits 15 group rows per frame
        let mut flat = Vec::with_capacity(rows * w);
        for r in 0..rows {
            for c in 0..w {
                flat.push((r * 100_000 + c) as f32);
            }
        }
        ArrayD::from_shape_vec(IxDyn(&[1, rows, w]), flat).expect("synthetic group_logits")
    }

    #[test]
    fn code_predictor_row_reads_every_row_at_the_tensor_stride() {
        // Tight export: stride == residual codebook size. Every one of the 15 rows must
        // come back whole and start at `r * 2048`.
        let gl = synthetic_group_logits(FB_RESIDUAL_VOCAB);
        for r in 0..(N_GROUPS - 1) {
            let row = code_predictor_row_f64(&gl, r, FB_RESIDUAL_VOCAB).expect("row");
            assert_eq!(row.len(), FB_RESIDUAL_VOCAB, "row {r} width");
            assert_eq!(row[0], (r * 100_000) as f64, "row {r} first");
            assert_eq!(
                row[FB_RESIDUAL_VOCAB - 1],
                (r * 100_000 + FB_RESIDUAL_VOCAB - 1) as f64,
                "row {r} last"
            );
        }
    }

    #[test]
    fn code_predictor_row_is_offset_by_stride_not_by_vocab() {
        // THE REGRESSION. Real export: stride 3072 (padded to the talker vocab), valid
        // range 2048. Row r must start at r*3072 — the pre-fix code started it at
        // r*2048, so every row after the first was read from a misaligned offset.
        let gl = synthetic_group_logits(FB_VOCAB);
        for r in 0..(N_GROUPS - 1) {
            let row = code_predictor_row_f64(&gl, r, FB_RESIDUAL_VOCAB).expect("row");
            // Truncated to the residual codebook: the 1024 padded entries are dropped.
            assert_eq!(row.len(), FB_RESIDUAL_VOCAB, "row {r} width");
            assert_eq!(row[0], (r * 100_000) as f64, "row {r} misaligned");
            assert_eq!(row[7], (r * 100_000 + 7) as f64, "row {r} misaligned");
        }
        // Explicitly: slicing at the WRONG width would have produced these values.
        let wrong_start_row_3 = (3 * FB_RESIDUAL_VOCAB) as f64; // flat index, i.e. 6144
        let row3 = code_predictor_row_f64(&gl, 3, FB_RESIDUAL_VOCAB).expect("row 3");
        assert_ne!(row3[0], wrong_start_row_3);
        assert_eq!(row3[0], 300_000.0);
    }

    #[test]
    fn code_predictor_row_cannot_emit_an_out_of_range_code() {
        // Put the LARGEST logits in the padded tail (>= 2048) — exactly the shape that
        // made the next code_predictor call fail with "indices element out of data
        // bounds, idx=3051 must be within the inclusive range [-2048,2047]".
        let rows = N_GROUPS - 1;
        let mut flat = vec![0.0f32; rows * FB_VOCAB];
        for r in 0..rows {
            for c in FB_RESIDUAL_VOCAB..FB_VOCAB {
                flat[r * FB_VOCAB + c] = 1.0e9;
            }
            flat[r * FB_VOCAB + 3051 - r] = 2.0e9; // the reported offender, per row
        }
        let gl = ArrayD::from_shape_vec(IxDyn(&[1, rows, FB_VOCAB]), flat).expect("gl");

        for r in 0..rows {
            let row = code_predictor_row_f64(&gl, r, FB_RESIDUAL_VOCAB).expect("row");
            assert_eq!(row.len(), FB_RESIDUAL_VOCAB);
            // Greedy AND stochastic draws must both stay inside the codebook.
            let mut rng = sampling::SplitMix64Rng::new(0xC0FF_EE00);
            assert!(sampling::sample(&row, false, SUB_TOP_K, SUB_TOP_P, 0.0, &mut rng) < 2048);
            for seed in 0..64u64 {
                let mut rng = sampling::SplitMix64Rng::new(seed);
                let id = sampling::sample(
                    &row,
                    SUB_DO_SAMPLE,
                    SUB_TOP_K,
                    SUB_TOP_P,
                    SUB_TEMPERATURE,
                    &mut rng,
                );
                assert!(
                    id < 2048,
                    "row {r} seed {seed} sampled out-of-range id {id}"
                );
            }
        }
    }

    #[test]
    fn code_predictor_row_never_returns_an_empty_row() {
        // `residual_vocab == 0` (a config declaring `vocab_size: 0`) must NOT hand the
        // sampler an empty slice — it degrades to the 2048 fallback, clamped to stride.
        let gl = synthetic_group_logits(FB_VOCAB);
        let row = code_predictor_row_f64(&gl, 4, 0).expect("row");
        assert_eq!(row.len(), FB_RESIDUAL_VOCAB);
        assert_eq!(row[0], 400_000.0);

        // A checkpoint whose stride is TIGHTER than the configured range is clamped the
        // other way: never read past the row.
        let tight = synthetic_group_logits(FB_RESIDUAL_VOCAB);
        let row = code_predictor_row_f64(&tight, 4, FB_VOCAB).expect("row");
        assert_eq!(row.len(), FB_RESIDUAL_VOCAB);
        assert_eq!(row[0], 400_000.0);
    }

    #[test]
    fn code_predictor_row_rejects_an_out_of_bounds_row_index() {
        let gl = synthetic_group_logits(FB_RESIDUAL_VOCAB);
        assert!(code_predictor_row_f64(&gl, N_GROUPS - 1, FB_RESIDUAL_VOCAB).is_err());
        // A degenerate zero-width tensor is an error, not a panic.
        let empty = ArrayD::from_shape_vec(IxDyn(&[1, 15, 0]), Vec::<f32>::new()).expect("empty");
        assert!(code_predictor_row_f64(&empty, 0, FB_RESIDUAL_VOCAB).is_err());
    }

    /// Write a `config.json` holding `talker_config` into a fresh temp dir.
    fn config_dir_with(talker: serde_json::Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::json!({ "talker_config": talker }).to_string(),
        )
        .expect("write config.json");
        dir
    }

    #[test]
    fn residual_vocab_comes_from_config_and_guards_zero() {
        // Present and sane → honoured verbatim (a future checkpoint may resize it).
        let dir = config_dir_with(serde_json::json!({
            "code_predictor_config": { "vocab_size": 1024 }
        }));
        assert_eq!(ModelConfig::load(dir.path()).unwrap().residual_vocab, 1024);

        // `code_predictor_config` present but with no `vocab_size` → 2048 fallback.
        let dir = config_dir_with(serde_json::json!({ "code_predictor_config": {} }));
        assert_eq!(
            ModelConfig::load(dir.path()).unwrap().residual_vocab,
            FB_RESIDUAL_VOCAB
        );

        // ZERO is nonsense — treated as absent so the sampler range is never empty.
        let dir = config_dir_with(serde_json::json!({
            "code_predictor_config": { "vocab_size": 0 }
        }));
        assert_eq!(
            ModelConfig::load(dir.path()).unwrap().residual_vocab,
            FB_RESIDUAL_VOCAB
        );
    }

    // ── D4: preset-speaker resolution ────────────────────────────────────────

    #[test]
    fn speaker_token_resolves_all_nine_customvoice_presets() {
        // The ids are the CustomVoice voice list the picker ships; a rename on either
        // side (voice list ↔ `talker_config.spk_id` lookup) breaks this test.
        let spk: serde_json::Map<String, serde_json::Value> = QWEN3TTS_CUSTOMVOICE_VOICES
            .iter()
            .enumerate()
            .map(|(i, v)| (v.id.to_string(), serde_json::json!(3000 + i as i64)))
            .collect();
        assert_eq!(spk.len(), 9, "CustomVoice ships 9 preset timbres");
        let dir = config_dir_with(serde_json::json!({ "spk_id": spk }));
        let cfg = ModelConfig::load(dir.path()).unwrap();

        for (i, v) in QWEN3TTS_CUSTOMVOICE_VOICES.iter().enumerate() {
            assert_eq!(
                speaker_token(&cfg, v.id),
                Some(3000 + i as i64),
                "preset {} did not resolve",
                v.id
            );
            // The reference lowercases before the lookup, so a persisted
            // differently-cased selection must still resolve.
            assert_eq!(
                speaker_token(&cfg, &v.id.to_ascii_uppercase()),
                Some(3000 + i as i64),
                "preset {} is case-sensitive",
                v.id
            );
        }

        // Unknown / empty ⇒ the checkpoint's own default timbre, never an error.
        assert_eq!(speaker_token(&cfg, "nobody"), None);
        assert_eq!(speaker_token(&cfg, "VIVIAN "), None); // not trimmed: exact key match
        assert_eq!(speaker_token(&cfg, ""), None);
    }

    #[test]
    fn speaker_token_is_none_on_a_voicedesign_checkpoint() {
        // VoiceDesign publishes no `spk_id` map — a stale CustomVoice selection carried
        // over by settings must fall back to the default voice rather than fail the read.
        let cfg = ModelConfig::load(Path::new("/nonexistent-qwen3tts")).unwrap();
        assert!(cfg.spk_id.is_empty());
        for v in QWEN3TTS_CUSTOMVOICE_VOICES {
            assert_eq!(speaker_token(&cfg, v.id), None);
        }
    }

    /// PARITY: build the tokenizer from the reference fixtures (env-pointed, not
    /// committed) and assert the golden encodings. Gated `#[ignore]` — run with
    /// `WINSTT_QWEN3TTS_FIXTURES` set to the ref folder:
    ///   cargo test qwen3tts_tokenizer_parity -- --ignored
    #[test]
    #[ignore = "requires WINSTT_QWEN3TTS_FIXTURES pointing at the ref fixtures"]
    fn qwen3tts_tokenizer_parity() {
        let root = std::env::var("WINSTT_QWEN3TTS_FIXTURES")
            .expect("set WINSTT_QWEN3TTS_FIXTURES to the ref folder");
        let root = PathBuf::from(root);

        // The fixtures use `qwen_` prefixes; stage them under a temp dir with the names
        // build_qwen2_tokenizer expects (vocab.json/merges.txt/tokenizer_config.json).
        let staging = std::env::temp_dir().join("winstt_qwen3tts_tok_parity");
        let _ = std::fs::create_dir_all(&staging);
        for (src, dst) in [
            ("qwen_vocab.json", "vocab.json"),
            ("qwen_merges.txt", "merges.txt"),
            ("qwen_tokenizer_config.json", "tokenizer_config.json"),
        ] {
            std::fs::copy(root.join(src), staging.join(dst))
                .unwrap_or_else(|e| panic!("copy {src}: {e}"));
        }
        // Ensure we build (not load a stale tokenizer.json).
        let _ = std::fs::remove_file(staging.join("tokenizer.json"));

        let tok = build_qwen2_tokenizer(&staging).expect("build tokenizer");

        let assistant = "<|im_start|>assistant\nHello there.<|im_end|>\n<|im_start|>assistant\n";
        let enc = tok.encode(assistant, true).expect("encode assistant");
        let ids: Vec<i64> = enc.get_ids().iter().map(|&u| u as i64).collect();
        assert_eq!(
            ids,
            vec![
                151644, 77091, 198, 9707, 1052, 13, 151645, 198, 151644, 77091, 198
            ],
            "assistant_hello golden mismatch"
        );

        let instruct = "<|im_start|>user\nA calm, low female voice.<|im_end|>\n";
        let enc2 = tok.encode(instruct, true).expect("encode instruct");
        let ids2: Vec<i64> = enc2.get_ids().iter().map(|&u| u as i64).collect();
        assert_eq!(
            ids2,
            vec![
                151644, 872, 198, 32, 19300, 11, 3347, 8778, 7743, 13, 151645, 198
            ],
            "instruct_calm golden mismatch"
        );
    }
}
