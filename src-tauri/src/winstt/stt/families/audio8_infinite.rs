// Audio8-ASR-Infinite: native streaming zh/en ASR (Voxtral-Realtime causal audio tower + Qwen2.5-3B
// decoder with delay modulation + semantic end-of-turn heads), driven from our own ONNX export
// (`Masterx/Audio8-ASR-Infinite-ONNX`, tools/onnx/audio8_infinite_*.py).
//
// Source: Edge0/Audio8-ASR-Infinite @ 7476824 — `streaming_inference.py::simulated_streaming_greedy_
//   decode` + `simulated_streaming_audio.py` (the window definition) and the vLLM plugin's rolling
//   scheduler (`audio8_rolling_scheduler.py`: 30 s context, 38-token trim, 16-token stable prefix).
//
// CLOCK. One text token per `P = 320 * frame_len` samples (80 ms at the shipped frame_len 4). The
//   stream is `left_pad*P` zeros + audio (+ `(delay+1+10)*P` zeros on finalize). Window 0 covers
//   `[0, prefill*P + 40)` and consumes the whole prompt `[BOS, LANG, PAD*(prefill-2)]`
//   (`prefill = left_pad + delay + 1`); window k >= 1 covers `[(prefill+k-1)P - 840, (prefill+k)P
//   + 40)` and consumes ONE token: the previous greedy output. Every window is self-contained raw
//   PCM (the graph computes its own log-mel + causal conv), so the PCM ring only keeps the 52.5 ms
//   look-back of the next window.
//
// STATE (constant memory for unbounded sessions):
//   * encoder ring: per layer `[heads, 749, head_dim]` K/V (sliding window 750 = 749 past + self),
//     keys stored ALREADY ROTATED with host f64 angles (reduced mod 2pi) — so absolute positions grow
//     forever without precision loss and slots never need re-rotation; `attn_bias` masks stale /
//     empty / out-of-window slots.
//   * decoder: per layer `[kv_heads, 375, head_dim]`; when the next step would overflow 375
//     positions, 38 entries after the 16-token stable prefix are dropped and the surviving suffix
//     keys re-rotated by -38 positions (exactly the vLLM/MLX rolling policy).
//   * text: emitted visible token BYTES are appended through an incremental UTF-8 decoder.
//
// TURN DETECTION. The decoder also returns the semantic-VAD logits (4 horizons x 8 classes; class 0
//   = "no speech within the horizon"). P(class 0 @ 2.0 s) is the end-of-turn probability the
//   reference realtime client thresholds; a rising edge over `EOT_ON` with new text since the last
//   turn surfaces as `NativeStreamUpdate::is_final` (segment commit in listen mode).

use std::borrow::Cow;
use std::collections::VecDeque;
use std::path::Path;

use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, TensorRef};

use super::super::{
    EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription,
};
use super::support::{F16, build_session, file, node_past_shape, providers_to_strings};

/// Additive mask value. Finite so a fully-masked padding row stays NaN-free.
const NEG: f32 = -1e9;
/// Most windows batched into one encoder call (file mode / catch-up). `T = 24 * frame_len` frames
/// stays far below the 749-slot ring, which the bias construction relies on.
const MAX_ENC_BATCH: usize = 24;
/// End-of-turn hysteresis on P(no speech within 2 s).
const EOT_ON: f32 = 0.5;
const EOT_OFF: f32 = 0.35;
/// Qwen2 ids at/above this are special/added tokens (`<|endoftext|>` = 151643 and up).
const FIRST_SPECIAL_ID: i64 = 151_643;

fn err(msg: impl Into<String>) -> SttError {
    SttError::Inference(format!("audio8-infinite: {}", msg.into()))
}
fn rerr(msg: impl Into<String>) -> SttError {
    SttError::Resolve(format!("audio8-infinite: {}", msg.into()))
}

// ───────────────────────────────────────────────────────────────────────────
// runtime.json
// ───────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct Runtime {
    look_back: usize,
    look_ahead: usize,
    right_pad_text_tokens: usize,
    frame_len: usize,
    left_pad_tokens: usize,
    delay_tokens: usize,
    ada_index: usize,
    ada_combos: usize,
    enc_layers: usize,
    enc_heads: usize,
    enc_head_dim: usize,
    enc_window: usize,
    enc_theta: f64,
    dec_layers: usize,
    dec_kv_heads: usize,
    dec_head_dim: usize,
    hidden: usize,
    dec_theta: f64,
    vocab: usize,
    roll_context: usize,
    roll_trim: usize,
    roll_stable: usize,
    bos: i64,
    eos: i64,
    stream_pad: i64,
    lang_zh: i64,
    lang_en: i64,
    eot_horizon_index: usize,
    vad_heads: usize,
    vad_classes: usize,
}

impl Runtime {
    fn parse(json: &serde_json::Value) -> SttResult<Runtime> {
        let u = |v: &serde_json::Value, what: &str| -> SttResult<usize> {
            v.as_u64()
                .map(|x| x as usize)
                .ok_or_else(|| rerr(format!("runtime.json: missing/invalid {what}")))
        };
        let f = |v: &serde_json::Value, what: &str| -> SttResult<f64> {
            v.as_f64()
                .ok_or_else(|| rerr(format!("runtime.json: missing/invalid {what}")))
        };
        let i = |v: &serde_json::Value, what: &str| -> SttResult<i64> {
            v.as_i64()
                .ok_or_else(|| rerr(format!("runtime.json: missing/invalid {what}")))
        };
        if json["format"].as_str() != Some("winstt-audio8-infinite-v1") {
            return Err(rerr(format!(
                "runtime.json: unsupported format {:?}",
                json["format"]
            )));
        }
        let frame_len = u(&json["default_frame_len"], "default_frame_len")?;
        let delay_ms = u(&json["default_delay_ms"], "default_delay_ms")?;
        let combos = json["ada_scale"]["combos"]
            .as_array()
            .ok_or_else(|| rerr("runtime.json: ada_scale.combos"))?;
        let (ada_index, delay_tokens) = combos
            .iter()
            .enumerate()
            .find_map(|(idx, c)| {
                (c["frame_len"].as_u64() == Some(frame_len as u64)
                    && c["delay_ms"].as_u64() == Some(delay_ms as u64))
                .then(|| c["delay_tokens"].as_u64().map(|d| (idx, d as usize)))
                .flatten()
            })
            .ok_or_else(|| {
                rerr(format!(
                    "runtime.json: no ada combo for frame_len {frame_len} / {delay_ms} ms"
                ))
            })?;
        let left_pad_tokens = u(
            &json["left_pad_tokens_by_frame_len"][frame_len.to_string()],
            "left_pad_tokens_by_frame_len",
        )?;
        let enc = &json["encoder"];
        let dec = &json["decoder"];
        let roll = &json["rolling"];
        let tok = &json["tokens"];
        let vad = &json["semantic_vad"];
        let horizons: Vec<f64> = vad["horizons_seconds"]
            .as_array()
            .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
            .unwrap_or_default();
        let want = vad["default_eot_horizon_seconds"].as_f64().unwrap_or(2.0);
        let eot_horizon_index = horizons
            .iter()
            .position(|h| (h - want).abs() < 1e-6)
            .unwrap_or(horizons.len().saturating_sub(1).min(2));
        let rt = Runtime {
            look_back: u(&json["look_back_samples"], "look_back_samples")?,
            look_ahead: u(&json["look_ahead_samples"], "look_ahead_samples")?,
            right_pad_text_tokens: u(&json["right_pad_text_tokens"], "right_pad_text_tokens")?,
            frame_len,
            left_pad_tokens,
            delay_tokens,
            ada_index,
            ada_combos: combos.len(),
            enc_layers: u(&enc["layers"], "encoder.layers")?,
            enc_heads: u(&enc["heads"], "encoder.heads")?,
            enc_head_dim: u(&enc["head_dim"], "encoder.head_dim")?,
            enc_window: u(&enc["sliding_window"], "encoder.sliding_window")?,
            enc_theta: f(&enc["rope_theta"], "encoder.rope_theta")?,
            dec_layers: u(&dec["layers"], "decoder.layers")?,
            dec_kv_heads: u(&dec["kv_heads"], "decoder.kv_heads")?,
            dec_head_dim: u(&dec["head_dim"], "decoder.head_dim")?,
            hidden: u(&dec["hidden"], "decoder.hidden")?,
            dec_theta: f(&dec["rope_theta"], "decoder.rope_theta")?,
            vocab: u(&dec["vocab"], "decoder.vocab")?,
            roll_context: u(&roll["context_tokens"], "rolling.context_tokens")?,
            roll_trim: u(&roll["trim_tokens"], "rolling.trim_tokens")?,
            roll_stable: u(
                &roll["stable_prefix_tokens"],
                "rolling.stable_prefix_tokens",
            )?,
            bos: i(&tok["bos"], "tokens.bos")?,
            eos: i(&tok["eos"], "tokens.eos")?,
            stream_pad: i(&tok["streaming_pad"], "tokens.streaming_pad")?,
            lang_zh: i(&tok["language_zh"], "tokens.language_zh")?,
            lang_en: i(&tok["language_en"], "tokens.language_en")?,
            eot_horizon_index,
            vad_heads: horizons.len().max(1),
            vad_classes: u(&vad["num_classes"], "semantic_vad.num_classes")?,
        };
        let prefill = rt.prefill();
        if rt.roll_stable + rt.roll_trim >= rt.roll_context
            || prefill > rt.roll_context
            || rt.roll_stable < 2
            || rt.enc_window < 2
            || rt.frame_len == 0
        {
            return Err(rerr("runtime.json: inconsistent streaming geometry"));
        }
        Ok(rt)
    }

    /// Samples per text token.
    fn period(&self) -> usize {
        320 * self.frame_len
    }
    fn prefill(&self) -> usize {
        self.left_pad_tokens + self.delay_tokens + 1
    }
    fn enc_capacity(&self) -> usize {
        self.enc_window - 1
    }
    fn right_pad_samples(&self) -> usize {
        (self.delay_tokens + 1 + self.right_pad_text_tokens) * self.period()
    }
    /// `[start, end)` of window `k` in stream coordinates (left pad included).
    fn window(&self, k: usize) -> (usize, usize) {
        let p = self.period();
        if k == 0 {
            (0, self.prefill() * p + self.look_ahead)
        } else {
            (
                (self.prefill() + k - 1) * p - self.look_back,
                (self.prefill() + k) * p + self.look_ahead,
            )
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Host math
// ───────────────────────────────────────────────────────────────────────────

fn inv_freq(head_dim: usize, theta: f64) -> Vec<f64> {
    (0..head_dim / 2)
        .map(|i| 1.0 / theta.powf((2 * i) as f64 / head_dim as f64))
        .collect()
}

/// `[n, head_dim]` cos/sin for positions `pos0..pos0+n` (rotate_half layout), f64 angles reduced
/// modulo 2pi before the f32 cast.
fn rope_tables(inv: &[f64], pos0: i64, n: usize) -> (Vec<f32>, Vec<f32>) {
    let half = inv.len();
    let d = 2 * half;
    let mut cos = vec![0f32; n * d];
    let mut sin = vec![0f32; n * d];
    for t in 0..n {
        let pos = (pos0 + t as i64) as f64;
        for (i, f) in inv.iter().enumerate() {
            let a = (pos * f).rem_euclid(std::f64::consts::TAU);
            let (s, c) = a.sin_cos();
            cos[t * d + i] = c as f32;
            cos[t * d + half + i] = c as f32;
            sin[t * d + i] = s as f32;
            sin[t * d + half + i] = s as f32;
        }
    }
    (cos, sin)
}

/// Encoder additive mask `[t, cap + t]`: query frame `pos0 + q` sees ring slot `s` iff it holds a
/// frame inside the sliding window, and new frame `j` iff `j <= q` (and inside the window).
fn encoder_bias(slot_pos: &[i64], pos0: i64, t: usize, window: usize) -> Vec<f32> {
    let cap = slot_pos.len();
    let w = window as i64;
    let mut bias = vec![NEG; t * (cap + t)];
    for q in 0..t {
        let qp = pos0 + q as i64;
        let row = &mut bias[q * (cap + t)..(q + 1) * (cap + t)];
        for (s, &p) in slot_pos.iter().enumerate() {
            if p >= 0 && p > qp - w && p < qp {
                row[s] = 0.0;
            }
        }
        for j in 0..=q {
            if (q - j) < window {
                row[cap + j] = 0.0;
            }
        }
    }
    bias
}

/// Decoder additive mask `[n, cap + n]`: the first `len` cache slots plus causal new tokens.
fn decoder_bias(len: usize, cap: usize, n: usize) -> Vec<f32> {
    let mut bias = vec![NEG; n * (cap + n)];
    for q in 0..n {
        let row = &mut bias[q * (cap + n)..(q + 1) * (cap + n)];
        row[..len].fill(0.0);
        row[cap..=cap + q].fill(0.0);
    }
    bias
}

fn bf16_to_f32(bits: u16) -> f32 {
    f32::from_bits(u32::from(bits) << 16)
}

/// GPT-2 byte-level alphabet: token-string char -> raw byte (`bytes_to_unicode` inverted).
fn byte_decoder() -> std::collections::HashMap<char, u8> {
    let mut bs: Vec<u32> = (u32::from(b'!')..=u32::from(b'~'))
        .chain(0xA1..=0xAC)
        .chain(0xAE..=0xFF)
        .collect();
    let mut cs = bs.clone();
    let mut n = 0;
    for b in 0..256u32 {
        if !bs.contains(&b) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    bs.into_iter()
        .zip(cs)
        .filter_map(|(b, c)| char::from_u32(c).map(|ch| (ch, b as u8)))
        .collect()
}

/// Incremental UTF-8 assembly of byte-level BPE pieces (a CJK char often spans two tokens).
#[derive(Default)]
struct TextAssembler {
    text: String,
    pending: Vec<u8>,
}

impl TextAssembler {
    fn push(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    self.text.push_str(s);
                    self.pending.clear();
                    return;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // SAFETY-free: the prefix was just validated.
                    if let Ok(s) = std::str::from_utf8(&self.pending[..valid]) {
                        self.text.push_str(s);
                    }
                    match e.error_len() {
                        // Incomplete trailing sequence: wait for the next token's bytes.
                        None => {
                            self.pending.drain(..valid);
                            return;
                        }
                        Some(bad) => {
                            self.text.push(char::REPLACEMENT_CHARACTER);
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// KV buffers (f32 or f16, matching the graph's declared cache dtype)
// ───────────────────────────────────────────────────────────────────────────

enum KvBuf {
    F32(Vec<f32>),
    F16(Vec<F16>),
}

impl KvBuf {
    fn zeros(len: usize, f16: bool) -> KvBuf {
        if f16 {
            KvBuf::F16(vec![F16::ZERO; len])
        } else {
            KvBuf::F32(vec![0.0; len])
        }
    }

    fn input(&self, shape: &[usize]) -> SttResult<SessionInputValue<'_>> {
        Ok(match self {
            KvBuf::F32(v) => TensorRef::from_array_view((shape.to_vec(), v.as_slice()))
                .map_err(|e| err(format!("kv view: {e}")))?
                .into(),
            KvBuf::F16(v) => TensorRef::from_array_view((shape.to_vec(), v.as_slice()))
                .map_err(|e| err(format!("kv view: {e}")))?
                .into(),
        })
    }

    /// Copy row `src_row` of an output `[1, heads, rows, dim]` into slot `dst_slot` of this
    /// `[heads, cap, dim]` buffer.
    fn write_row(
        &mut self,
        out: &DynValue,
        g: KvGeom,
        rows: usize,
        src_row: usize,
        dst_slot: usize,
    ) -> SttResult<()> {
        match self {
            KvBuf::F32(dst) => {
                let (_, src) = out
                    .try_extract_tensor::<f32>()
                    .map_err(|e| err(format!("kv output f32: {e}")))?;
                copy_rows(src, dst, g, rows, src_row, dst_slot)
            }
            KvBuf::F16(dst) => {
                let (_, src) = out
                    .try_extract_tensor::<F16>()
                    .map_err(|e| err(format!("kv output f16: {e}")))?;
                copy_rows(src, dst, g, rows, src_row, dst_slot)
            }
        }
    }
}

/// Layout of one per-layer cache buffer: `[heads, cap, dim]`.
#[derive(Clone, Copy, Debug)]
struct KvGeom {
    heads: usize,
    cap: usize,
    dim: usize,
}

/// A rolling trim: of `len` live rows, keep the `stable` prefix and drop the next `trim` rows.
#[derive(Clone, Copy, Debug)]
struct TrimSpan {
    len: usize,
    stable: usize,
    trim: usize,
}

fn copy_rows<T: Copy>(
    src: &[T],
    dst: &mut [T],
    g: KvGeom,
    rows: usize,
    src_row: usize,
    dst_slot: usize,
) -> SttResult<()> {
    let KvGeom { heads, cap, dim } = g;
    if src.len() != heads * rows * dim || dst.len() != heads * cap * dim {
        return Err(err(format!(
            "kv shape mismatch (src {} vs {heads}x{rows}x{dim}, dst {} vs {heads}x{cap}x{dim})",
            src.len(),
            dst.len()
        )));
    }
    for h in 0..heads {
        let s = (h * rows + src_row) * dim;
        let d = (h * cap + dst_slot) * dim;
        dst[d..d + dim].copy_from_slice(&src[s..s + dim]);
    }
    Ok(())
}

/// Drop `span.trim` rows after the `span.stable` prefix of a buffer holding `span.len` rows,
/// shifting the suffix down; keys are re-rotated by `-trim` positions (`rot` = (cos, sin) rows).
fn trim_rows(buf: &mut KvBuf, g: KvGeom, span: TrimSpan, rot: Option<(&[f32], &[f32])>) {
    fn go<T: Copy>(
        v: &mut [T],
        g: KvGeom,
        span: TrimSpan,
        rot: Option<(&[f32], &[f32])>,
        to: impl Fn(T) -> f32,
        from: impl Fn(f32) -> T,
    ) {
        let KvGeom { heads, cap, dim } = g;
        let TrimSpan { len, stable, trim } = span;
        let half = dim / 2;
        let mut tmp = vec![0f32; dim];
        for h in 0..heads {
            let base = h * cap * dim;
            for r in stable + trim..len {
                let s = base + r * dim;
                let d = base + (r - trim) * dim;
                match rot {
                    Some((c, sn)) => {
                        for i in 0..dim {
                            tmp[i] = to(v[s + i]);
                        }
                        for i in 0..dim {
                            let rh = if i < half {
                                -tmp[i + half]
                            } else {
                                tmp[i - half]
                            };
                            v[d + i] = from(tmp[i] * c[i] + rh * sn[i]);
                        }
                    }
                    None => v.copy_within(s..s + dim, d),
                }
            }
        }
    }
    match buf {
        KvBuf::F32(v) => go(v, g, span, rot, |x| x, |x| x),
        KvBuf::F16(v) => go(v, g, span, rot, F16::to_f32, F16::from_f32),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Stream state
// ───────────────────────────────────────────────────────────────────────────

struct StreamState {
    /// Source PCM (no left pad) starting at source index `pcm_base`.
    pcm: Vec<f32>,
    pcm_base: usize,
    received: usize,
    finalized: bool,
    next_window: usize,
    enc_k: Vec<KvBuf>,
    enc_v: Vec<KvBuf>,
    /// Absolute encoder frame held by each ring slot (-1 = empty).
    enc_pos: Vec<i64>,
    enc_frames: i64,
    dec_k: Vec<KvBuf>,
    dec_v: Vec<KvBuf>,
    dec_len: usize,
    /// Audio embeddings computed ahead of the decoder (file mode / catch-up batches).
    pending: VecDeque<Vec<f32>>,
    last_token: i64,
    language_token: i64,
    text: TextAssembler,
    steps: usize,
    trims: usize,
    eot_prob: f32,
    eot_latched: bool,
    text_len_at_turn: usize,
}

// ───────────────────────────────────────────────────────────────────────────
// Engine
// ───────────────────────────────────────────────────────────────────────────

pub(super) struct Audio8InfiniteEngine {
    encoder: Session,
    decoder: Session,
    rt: Runtime,
    /// `[vocab, hidden]` little-endian bf16 bytes (exact checkpoint values), kept raw so loading is
    /// one read instead of a 311 M-element conversion pass.
    embed: Vec<u8>,
    /// `[dec_layers, hidden]` (1 + AdaRMSNorm(t_cond)) for the session's delay/frame_len.
    ada: Vec<f32>,
    enc_f16: bool,
    dec_f16: bool,
    enc_inv: Vec<f64>,
    dec_inv: Vec<f64>,
    /// Byte-level BPE bytes for every regular (non-special) token id.
    token_bytes: Vec<Vec<u8>>,
    default_language: Option<String>,
    st: StreamState,
    model_name: String,
    providers: Vec<String>,
}

impl Audio8InfiniteEngine {
    pub(super) fn supports(cfg: &EngineConfig) -> bool {
        cfg.kind == EngineKind::Audio8Infinite
            && [
                "encoder",
                "decoder",
                "runtime",
                "embed_tokens",
                "ada_scale",
                "tokenizer",
            ]
            .iter()
            .all(|k| cfg.resolved.files.contains_key(*k))
    }

    pub(super) fn load(cfg: &EngineConfig) -> SttResult<Audio8InfiniteEngine> {
        let rt_json: serde_json::Value = serde_json::from_slice(
            &std::fs::read(file(&cfg.resolved, "runtime")?)
                .map_err(|e| rerr(format!("runtime.json read: {e}")))?,
        )
        .map_err(|e| rerr(format!("runtime.json parse: {e}")))?;
        let rt = Runtime::parse(&rt_json)?;
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        let (eh, ed, enc_f16) = node_past_shape(&encoder, "past_key_")
            .ok_or_else(|| rerr("encoder graph has no past_key_* inputs"))?;
        let (dh, dd, dec_f16) = node_past_shape(&decoder, "past_key_")
            .ok_or_else(|| rerr("decoder graph has no past_key_* inputs"))?;
        if (eh, ed) != (rt.enc_heads, rt.enc_head_dim)
            || (dh, dd) != (rt.dec_kv_heads, rt.dec_head_dim)
        {
            return Err(rerr(format!(
                "graph KV geometry ({eh}x{ed}, {dh}x{dd}) disagrees with runtime.json"
            )));
        }
        let embed = read_exact_file(
            file(&cfg.resolved, "embed_tokens")?,
            rt.vocab * rt.hidden * 2,
            "embed_tokens",
        )?;
        let ada = read_ada(file(&cfg.resolved, "ada_scale")?, &rt)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("audio8-infinite tokenizer: {e}")))?;
        let decoder_map = byte_decoder();
        let regular = (FIRST_SPECIAL_ID as usize).min(rt.vocab);
        let token_bytes = (0..regular)
            .map(|id| {
                tokenizer
                    .id_to_token(id as u32)
                    .map(|s| {
                        s.chars()
                            .filter_map(|c| decoder_map.get(&c).copied())
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect();
        let st = fresh_state(&rt, enc_f16, dec_f16, rt.lang_en);
        Ok(Audio8InfiniteEngine {
            enc_inv: inv_freq(rt.enc_head_dim, rt.enc_theta),
            dec_inv: inv_freq(rt.dec_head_dim, rt.dec_theta),
            encoder,
            decoder,
            embed,
            ada,
            enc_f16,
            dec_f16,
            token_bytes,
            default_language: cfg.language.clone(),
            st,
            rt,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn language_token(&self, language: Option<&str>) -> i64 {
        let lang = language
            .filter(|l| !l.trim().is_empty())
            .or(self.default_language.as_deref())
            .unwrap_or("en")
            .to_ascii_lowercase();
        if lang.starts_with("zh")
            || lang.starts_with("cmn")
            || lang.starts_with("yue")
            || lang == "chinese"
        {
            self.rt.lang_zh
        } else {
            self.rt.lang_en
        }
    }

    fn reset_with(&mut self, language_token: i64) {
        self.st = fresh_state(&self.rt, self.enc_f16, self.dec_f16, language_token);
    }

    /// Stream samples currently available (left pad + received audio + right pad once finalized).
    fn available(&self) -> usize {
        let p = self.rt.period();
        self.rt.left_pad_tokens * p
            + self.st.received
            + if self.st.finalized {
                self.rt.right_pad_samples()
            } else {
                0
            }
    }

    fn window_samples(&self, k: usize) -> Vec<f32> {
        let (a, b) = self.rt.window(k);
        let left = self.rt.left_pad_tokens * self.rt.period();
        let mut out = vec![0f32; b - a];
        for (i, slot) in out.iter_mut().enumerate() {
            let s = a + i;
            if s < left {
                continue;
            }
            let src = s - left;
            if src >= self.st.pcm_base && src < self.st.received {
                *slot = self.st.pcm[src - self.st.pcm_base];
            }
        }
        out
    }

    /// Run every ready window through encoder + decoder.
    fn process(&mut self) -> SttResult<()> {
        loop {
            let avail = self.available();
            let k0 = self.st.next_window;
            if self.rt.window(k0).1 > avail {
                break;
            }
            let mut ks = vec![k0];
            if k0 > 0 {
                while ks.len() < MAX_ENC_BATCH && self.rt.window(k0 + ks.len()).1 <= avail {
                    ks.push(k0 + ks.len());
                }
            }
            let tokens_per_window = if k0 == 0 { self.rt.prefill() } else { 1 };
            let windows: Vec<Vec<f32>> = ks.iter().map(|&k| self.window_samples(k)).collect();
            let embeds = self.encode(&windows, tokens_per_window)?;
            self.st.next_window = k0 + ks.len();
            self.drop_consumed_pcm();
            if k0 == 0 {
                let mut prompt = vec![self.rt.bos, self.st.language_token];
                prompt.resize(self.rt.prefill(), self.rt.stream_pad);
                let mut x = Vec::with_capacity(prompt.len() * self.rt.hidden);
                for (row, &id) in prompt.iter().enumerate() {
                    self.push_embed(
                        &mut x,
                        id,
                        &embeds[row * self.rt.hidden..(row + 1) * self.rt.hidden],
                    )?;
                }
                self.decode_step(&x, prompt.len())?;
            } else {
                for row in embeds.chunks_exact(self.rt.hidden) {
                    self.st.pending.push_back(row.to_vec());
                }
                while let Some(audio) = self.st.pending.pop_front() {
                    let mut x = Vec::with_capacity(self.rt.hidden);
                    self.push_embed(&mut x, self.st.last_token, &audio)?;
                    self.decode_step(&x, 1)?;
                }
            }
        }
        Ok(())
    }

    fn drop_consumed_pcm(&mut self) {
        let left = self.rt.left_pad_tokens * self.rt.period();
        let next_start = self.rt.window(self.st.next_window).0;
        let keep_from = next_start.saturating_sub(left).min(self.st.received);
        // Compact lazily (once the consumed prefix is at least half the buffer) so a whole-file
        // `transcribe` stays O(n) instead of shifting the remaining clip after every batch.
        let drop = keep_from
            .saturating_sub(self.st.pcm_base)
            .min(self.st.pcm.len());
        if drop > 0 && drop * 2 >= self.st.pcm.len() {
            self.st.pcm.drain(..drop);
            self.st.pcm_base += drop;
        }
    }

    fn push_embed(&self, x: &mut Vec<f32>, id: i64, audio: &[f32]) -> SttResult<()> {
        let id = usize::try_from(id)
            .ok()
            .filter(|&i| i < self.rt.vocab)
            .ok_or_else(|| err(format!("token id {id} outside the embedding table")))?;
        let row = &self.embed[id * self.rt.hidden * 2..(id + 1) * self.rt.hidden * 2];
        x.extend(
            row.chunks_exact(2)
                .zip(audio)
                .map(|(b, &a)| bf16_to_f32(u16::from_le_bytes([b[0], b[1]])) + a),
        );
        Ok(())
    }

    /// Encode `windows` (equal-length raw PCM) -> `[tokens, hidden]` audio embeddings.
    fn encode(&mut self, windows: &[Vec<f32>], tokens_per_window: usize) -> SttResult<Vec<f32>> {
        let rt = &self.rt;
        let b = windows.len();
        let s = windows[0].len();
        let t = b * tokens_per_window * rt.frame_len;
        let cap = rt.enc_capacity();
        let pos0 = self.st.enc_frames;
        let (cos, sin) = rope_tables(&self.enc_inv, pos0, t);
        let bias = encoder_bias(&self.st.enc_pos, pos0, t, rt.enc_window);
        let audio: Vec<f32> = windows.iter().flat_map(|w| w.iter().copied()).collect();
        let frame_len = [rt.frame_len as i64];
        let kv_shape = [1, rt.enc_heads, cap, rt.enc_head_dim];
        let d = rt.enc_head_dim;
        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(5 + 2 * rt.enc_layers);
            fn view<'v>(shape: &[usize], data: &'v [f32]) -> SttResult<SessionInputValue<'v>> {
                Ok(TensorRef::from_array_view((shape.to_vec(), data))
                    .map_err(|e| err(format!("encoder input: {e}")))?
                    .into())
            }
            inputs.push(("audio".into(), view(&[b, s], &audio)?));
            inputs.push((
                "frame_len".into(),
                TensorRef::from_array_view(([1usize], frame_len.as_slice()))
                    .map_err(|e| err(format!("frame_len: {e}")))?
                    .into(),
            ));
            inputs.push(("cos".into(), view(&[t, d], &cos)?));
            inputs.push(("sin".into(), view(&[t, d], &sin)?));
            inputs.push(("attn_bias".into(), view(&[t, cap + t], &bias)?));
            for i in 0..rt.enc_layers {
                inputs.push((
                    format!("past_key_{i}").into(),
                    self.st.enc_k[i].input(&kv_shape)?,
                ));
                inputs.push((
                    format!("past_value_{i}").into(),
                    self.st.enc_v[i].input(&kv_shape)?,
                ));
            }
            self.encoder
                .run(inputs)
                .map_err(|e| err(format!("encoder run: {e}")))?
        };
        let (_, emb) = outputs["audio_embeds"]
            .try_extract_tensor::<f32>()
            .map_err(|e| err(format!("audio_embeds: {e}")))?;
        let want = b * tokens_per_window * rt.hidden;
        if emb.len() != want {
            return Err(err(format!(
                "audio_embeds has {} values, want {want}",
                emb.len()
            )));
        }
        let emb = emb.to_vec();
        // Only the newest `cap` frames can matter to future queries.
        let g = KvGeom {
            heads: rt.enc_heads,
            cap,
            dim: d,
        };
        for row in t.saturating_sub(cap)..t {
            let pos = pos0 + row as i64;
            let slot = pos.rem_euclid(cap as i64) as usize;
            for i in 0..rt.enc_layers {
                self.st.enc_k[i].write_row(
                    &outputs[format!("key_{i}").as_str()],
                    g,
                    t,
                    row,
                    slot,
                )?;
                self.st.enc_v[i].write_row(
                    &outputs[format!("value_{i}").as_str()],
                    g,
                    t,
                    row,
                    slot,
                )?;
            }
            self.st.enc_pos[slot] = pos;
        }
        self.st.enc_frames += t as i64;
        Ok(emb)
    }

    fn maybe_trim(&mut self, incoming: usize) {
        let rt = &self.rt;
        while self.st.dec_len + incoming > rt.roll_context {
            let (c, s) = rope_tables(&self.dec_inv, -(rt.roll_trim as i64), 1);
            let g = KvGeom {
                heads: rt.dec_kv_heads,
                cap: rt.roll_context,
                dim: rt.dec_head_dim,
            };
            let span = TrimSpan {
                len: self.st.dec_len,
                stable: rt.roll_stable,
                trim: rt.roll_trim,
            };
            for i in 0..rt.dec_layers {
                trim_rows(&mut self.st.dec_k[i], g, span, Some((&c, &s)));
                trim_rows(&mut self.st.dec_v[i], g, span, None);
            }
            self.st.dec_len -= rt.roll_trim;
            self.st.trims += 1;
        }
    }

    /// One decoder call over `n` input embeddings `x` (`[n, hidden]`); emits one greedy token.
    fn decode_step(&mut self, x: &[f32], n: usize) -> SttResult<()> {
        self.maybe_trim(n);
        let rt = &self.rt;
        let cap = rt.roll_context;
        let len = self.st.dec_len;
        let d = rt.dec_head_dim;
        let (cos, sin) = rope_tables(&self.dec_inv, len as i64, n);
        let bias = decoder_bias(len, cap, n);
        let kv_shape = [1, rt.dec_kv_heads, cap, d];
        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(5 + 2 * rt.dec_layers);
            fn view<'v>(shape: &[usize], data: &'v [f32]) -> SttResult<SessionInputValue<'v>> {
                Ok(TensorRef::from_array_view((shape.to_vec(), data))
                    .map_err(|e| err(format!("decoder input: {e}")))?
                    .into())
            }
            inputs.push(("inputs_embeds".into(), view(&[1, n, rt.hidden], x)?));
            inputs.push((
                "ada_scale".into(),
                view(&[rt.dec_layers, rt.hidden], &self.ada)?,
            ));
            inputs.push(("cos".into(), view(&[n, d], &cos)?));
            inputs.push(("sin".into(), view(&[n, d], &sin)?));
            inputs.push(("attn_bias".into(), view(&[n, cap + n], &bias)?));
            for i in 0..rt.dec_layers {
                inputs.push((
                    format!("past_key_{i}").into(),
                    self.st.dec_k[i].input(&kv_shape)?,
                ));
                inputs.push((
                    format!("past_value_{i}").into(),
                    self.st.dec_v[i].input(&kv_shape)?,
                ));
            }
            self.decoder
                .run(inputs)
                .map_err(|e| err(format!("decoder run: {e}")))?
        };
        let g = KvGeom {
            heads: rt.dec_kv_heads,
            cap,
            dim: d,
        };
        for row in 0..n {
            for i in 0..rt.dec_layers {
                let (k, v) = (format!("key_{i}"), format!("value_{i}"));
                self.st.dec_k[i].write_row(&outputs[k.as_str()], g, n, row, len + row)?;
                self.st.dec_v[i].write_row(&outputs[v.as_str()], g, n, row, len + row)?;
            }
        }
        self.st.dec_len += n;
        let (_, logits) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(|e| err(format!("logits: {e}")))?;
        let eos = usize::try_from(rt.eos).unwrap_or(usize::MAX);
        let mut best = (0usize, f32::NEG_INFINITY);
        for (i, &v) in logits.iter().enumerate() {
            if i != eos && v > best.1 {
                best = (i, v);
            }
        }
        let token = best.0 as i64;
        if let Ok((_, vad)) = outputs["vad_logits"].try_extract_tensor::<f32>() {
            let c = rt.vad_classes;
            let h = rt.eot_horizon_index;
            if vad.len() >= (h + 1) * c {
                let row = &vad[h * c..(h + 1) * c];
                let m = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let z: f32 = row.iter().map(|v| (v - m).exp()).sum();
                self.st.eot_prob = (row[0] - m).exp() / z;
            }
        }
        drop(outputs);
        self.st.last_token = token;
        self.st.steps += 1;
        if token < FIRST_SPECIAL_ID
            && let Some(bytes) = self.token_bytes.get(token as usize)
        {
            let bytes = bytes.clone();
            self.st.text.push(&bytes);
        }
        Ok(())
    }

    fn current_text(&self) -> String {
        self.st.text.text.trim().to_string()
    }

    /// Rising-edge end-of-turn with new text since the previous turn.
    fn take_turn_end(&mut self) -> bool {
        let p = self.st.eot_prob;
        if self.st.eot_latched {
            if p < EOT_OFF {
                self.st.eot_latched = false;
            }
            return false;
        }
        let len = self.st.text.text.trim_end().len();
        if p >= EOT_ON && len > self.st.text_len_at_turn {
            self.st.eot_latched = true;
            self.st.text_len_at_turn = len;
            return true;
        }
        false
    }

    fn finish(&mut self) -> SttResult<String> {
        if !self.st.finalized {
            self.st.finalized = true;
            self.process()?;
        }
        Ok(self.current_text())
    }
}

fn fresh_state(rt: &Runtime, enc_f16: bool, dec_f16: bool, language_token: i64) -> StreamState {
    let ecap = rt.enc_capacity();
    let elen = rt.enc_heads * ecap * rt.enc_head_dim;
    let dlen = rt.dec_kv_heads * rt.roll_context * rt.dec_head_dim;
    StreamState {
        pcm: Vec::new(),
        pcm_base: 0,
        received: 0,
        finalized: false,
        next_window: 0,
        enc_k: (0..rt.enc_layers)
            .map(|_| KvBuf::zeros(elen, enc_f16))
            .collect(),
        enc_v: (0..rt.enc_layers)
            .map(|_| KvBuf::zeros(elen, enc_f16))
            .collect(),
        enc_pos: vec![-1; ecap],
        enc_frames: 0,
        dec_k: (0..rt.dec_layers)
            .map(|_| KvBuf::zeros(dlen, dec_f16))
            .collect(),
        dec_v: (0..rt.dec_layers)
            .map(|_| KvBuf::zeros(dlen, dec_f16))
            .collect(),
        dec_len: 0,
        pending: VecDeque::new(),
        last_token: rt.stream_pad,
        language_token,
        text: TextAssembler::default(),
        steps: 0,
        trims: 0,
        eot_prob: 0.0,
        eot_latched: false,
        text_len_at_turn: 0,
    }
}

fn read_exact_file(path: &Path, bytes: usize, what: &str) -> SttResult<Vec<u8>> {
    let data = std::fs::read(path).map_err(|e| rerr(format!("{what} read: {e}")))?;
    if data.len() != bytes {
        return Err(rerr(format!(
            "{what}: {} bytes, expected {bytes}",
            data.len()
        )));
    }
    Ok(data)
}

fn read_ada(path: &Path, rt: &Runtime) -> SttResult<Vec<f32>> {
    let per = rt.dec_layers * rt.hidden;
    let bytes = std::fs::read(path).map_err(|e| rerr(format!("ada_scale read: {e}")))?;
    if bytes.len() != rt.ada_combos * per * 4 {
        return Err(rerr(format!(
            "ada_scale: {} bytes, expected {}",
            bytes.len(),
            rt.ada_combos * per * 4
        )));
    }
    Ok(bytes[rt.ada_index * per * 4..(rt.ada_index + 1) * per * 4]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

impl Transcriber for Audio8InfiniteEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Audio8Infinite
    }
    fn model_name(&self) -> &str {
        &self.model_name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    /// Offline decode IS the streaming decode (same windows, same rolling cache): the whole clip
    /// is fed at once, so the encoder batches up to `MAX_ENC_BATCH` windows per call.
    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        let lang = self.language_token(opts.language.as_deref());
        self.reset_with(lang);
        self.st.pcm.extend_from_slice(audio);
        self.st.received = audio.len();
        self.process()?;
        let text = self.finish()?;
        let lang = self.language_token(None);
        self.reset_with(lang);
        Ok(Transcription {
            text,
            segments: None,
            words: None,
        })
    }

    fn supports_native_streaming(&self) -> bool {
        true
    }

    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if self.st.finalized {
            return Err(err(
                "stream_accept after stream_finalize without stream_reset",
            ));
        }
        self.st.pcm.extend_from_slice(pcm);
        self.st.received += pcm.len();
        self.process()?;
        let is_final = self.take_turn_end();
        Ok(NativeStreamUpdate {
            text: self.current_text(),
            is_final,
        })
    }

    fn stream_finalize(&mut self) -> SttResult<String> {
        self.finish()
    }

    fn stream_reset(&mut self) {
        let lang = self.language_token(None);
        self.reset_with(lang);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> Runtime {
        let json = serde_json::json!({
            "format": "winstt-audio8-infinite-v1",
            "look_back_samples": 840, "look_ahead_samples": 40, "right_pad_text_tokens": 10,
            "left_pad_tokens_by_frame_len": {"4": 18, "6": 12, "8": 9},
            "default_frame_len": 4, "default_delay_ms": 480,
            "encoder": {"layers": 32, "heads": 32, "head_dim": 64, "hidden": 1280, "sliding_window": 750, "rope_theta": 1e6},
            "decoder": {"layers": 36, "heads": 16, "kv_heads": 2, "head_dim": 128, "hidden": 2048, "rope_theta": 1e6, "vocab": 151936},
            "rolling": {"context_tokens": 375, "trim_tokens": 38, "stable_prefix_tokens": 16},
            "tokens": {"bos": 151644, "eos": 151645, "pad": 151643, "streaming_pad": 151665,
                       "streaming_word": 151666, "language_zh": 151667, "language_en": 151668},
            "semantic_vad": {"horizons_seconds": [0.5, 1.0, 2.0, 3.0], "num_classes": 8, "default_eot_horizon_seconds": 2.0},
            "ada_scale": {"combos": [
                {"frame_len": 4, "delay_ms": 240, "delay_tokens": 3},
                {"frame_len": 4, "delay_ms": 480, "delay_tokens": 6}]}
        });
        Runtime::parse(&json).expect("runtime parses")
    }

    #[test]
    fn runtime_resolves_the_480ms_gear4_operating_point() {
        let rt = runtime();
        assert_eq!((rt.frame_len, rt.delay_tokens, rt.ada_index), (4, 6, 1));
        assert_eq!(rt.prefill(), 25);
        assert_eq!(rt.period(), 1280);
        assert_eq!(rt.enc_capacity(), 749);
        assert_eq!(rt.eot_horizon_index, 2);
        assert_eq!(rt.right_pad_samples(), 17 * 1280);
    }

    #[test]
    fn windows_follow_the_reference_definition() {
        let rt = runtime();
        // window 0 = the whole prompt clock + 2.5 ms look-ahead
        assert_eq!(rt.window(0), (0, 25 * 1280 + 40));
        // window k>=1: 52.5 ms look-back, one 80 ms token, 2.5 ms look-ahead
        assert_eq!(rt.window(1), (25 * 1280 - 840, 26 * 1280 + 40));
        assert_eq!(rt.window(7).1 - rt.window(7).0, 840 + 1280 + 40);
    }

    #[test]
    fn rope_tables_reduce_large_positions_exactly() {
        let inv = inv_freq(64, 1e6);
        let (c, s) = rope_tables(&inv, 0, 1);
        assert!(c[..64].iter().all(|&v| v == 1.0) && s.iter().all(|&v| v == 0.0));
        // rotate_half layout: both halves carry the same angle
        let (c, s) = rope_tables(&inv, 123_456_789, 1);
        assert_eq!(c[0], c[32]);
        assert_eq!(s[5], s[37]);
        let a = (123_456_789f64 * inv[0]).rem_euclid(std::f64::consts::TAU);
        assert!((f64::from(c[0]) - a.cos()).abs() < 1e-6);
    }

    #[test]
    fn encoder_bias_masks_empty_stale_and_out_of_window_slots() {
        // capacity 3 (window 4); ring holds frames 7, 8, 9 (slot order arbitrary)
        let slots = [8, 9, 7];
        let b = encoder_bias(&slots, 10, 2, 4);
        let row0 = &b[..5];
        let row1 = &b[5..];
        // frame 10 sees 7,8,9 + itself; not frame 11
        assert_eq!(row0, &[0.0, 0.0, 0.0, 0.0, NEG]);
        // frame 11 sees 8,9 (7 is out of its 4-frame window) + 10 + itself
        assert_eq!(row1, &[0.0, 0.0, NEG, 0.0, 0.0]);
        // empty slots are masked
        let b = encoder_bias(&[-1, -1, -1], 0, 1, 4);
        assert_eq!(b, vec![NEG, NEG, NEG, 0.0]);
    }

    #[test]
    fn decoder_bias_is_prefix_plus_causal() {
        let b = decoder_bias(2, 4, 2);
        assert_eq!(&b[..6], &[0.0, 0.0, NEG, NEG, 0.0, NEG]);
        assert_eq!(&b[6..], &[0.0, 0.0, NEG, NEG, 0.0, 0.0]);
    }

    #[test]
    fn trim_rerotation_matches_rope_relativity() {
        // A key rotated at position p, then re-based by -r, equals the key rotated at p - r.
        let dim = 8;
        let inv = inv_freq(dim, 1e6);
        let raw: Vec<f32> = (0..dim).map(|i| (i as f32 * 0.37).sin()).collect();
        let rotate = |pos: i64| -> Vec<f32> {
            let (c, s) = rope_tables(&inv, pos, 1);
            (0..dim)
                .map(|i| {
                    let rh = if i < dim / 2 {
                        -raw[i + dim / 2]
                    } else {
                        raw[i - dim / 2]
                    };
                    raw[i] * c[i] + rh * s[i]
                })
                .collect()
        };
        // heads=1, cap=6, len=6, stable=1, trim=2: rows 3..6 move to 1..4
        let mut buf = KvBuf::F32((0..6).flat_map(|p| rotate(p as i64)).collect());
        let (c, s) = rope_tables(&inv, -2, 1);
        let g = KvGeom {
            heads: 1,
            cap: 6,
            dim,
        };
        let span = TrimSpan {
            len: 6,
            stable: 1,
            trim: 2,
        };
        trim_rows(&mut buf, g, span, Some((&c, &s)));
        let KvBuf::F32(v) = buf else { unreachable!() };
        for (row, pos) in [(0usize, 0i64), (1, 1), (2, 2), (3, 3)] {
            let want = rotate(pos);
            for i in 0..dim {
                assert!((v[row * dim + i] - want[i]).abs() < 1e-5, "row {row}");
            }
        }
    }

    #[test]
    fn byte_level_text_assembles_split_utf8() {
        let map = byte_decoder();
        assert_eq!(map.len(), 256);
        assert_eq!(map[&'Ġ'], b' ');
        let mut t = TextAssembler::default();
        let zh = "中".as_bytes(); // 3 bytes, split across two "tokens"
        t.push(&zh[..2]);
        assert_eq!(t.text, "");
        t.push(&zh[2..]);
        t.push(b" ok");
        assert_eq!(t.text, "中 ok");
        t.push(&[0xFF, b'a']);
        assert_eq!(t.text, "中 ok\u{FFFD}a");
    }
}
