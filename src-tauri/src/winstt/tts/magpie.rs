//! NVIDIA Magpie-TTS Multilingual 357M (v2607) on ONNX Runtime.
//!
//! Export: `Masterx/magpie-tts-multilingual-357m-ONNX` (NVIDIA Open Model License; the
//! manifest fetches `LICENSE` + `NOTICE` next to the weights). Four graphs, CFG baked into a
//! batch of two (`[conditional, unconditional]`):
//!
//! * `text_encoder`  — text ids → per-decoder-layer cross-attention K/V for both CFG rows
//!   (the unconditional row is NeMo's zeroed dummy encoder output).
//! * `decoder_step`  — the 12-layer causal decoder with an external self-attention KV cache,
//!   the attention prior folded into layers 2..10, and the layer 4/5/8/9 cross-attention of
//!   the last position (the aligner NeMo steers the prior with). Returns the last position's
//!   `final_proj` logits and hidden state.
//! * `local_step`    — one step of the 2-layer local transformer that samples the 16 codes
//!   (8 codebooks x frame stacking 2) of a decoder step, one codebook at a time.
//! * `codec_decoder` — NanoCodec 22 kHz, `codes[1, 8, T]` → waveform.
//!
//! The decoder/local-transformer input embeddings come from `audio_embeddings.bin`
//! (16 x 2024 x 768 f32) and the five baked speakers from `speaker_context.bin`
//! (5 x 217 x 768 f32), gathered here so the 99 MB table is stored once.
//!
//! The decode loop is a 1:1 port of NeMo 3.0.0 `MagpieTTSModel.generate_speech` for a single
//! chunk with the checkpoint's `inference_parameters` (temperature 0.6, top-k 80, CFG 2.5,
//! prior epsilon 0.1, lookahead 6, `argmax_or_multinomial_any` EOS, 500 frames max), run with
//! NeMo's KV-cache decoder semantics (`decoder.reset_cache(use_cache=True)`).

mod text;

use std::path::Path;

use ndarray::Array3;
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::sampling::{SplitMix64Rng, sample};

use text::MagpieText;
pub use text::tokenizer_for_language;

pub const MAGPIE_SAMPLE_RATE: u32 = 22_050;

/// Built-in speakers in `speaker_context.bin` order: `(voice id, label, female?)`.
pub const MAGPIE_SPEAKERS: &[(&str, &str, bool)] = &[
    ("aria", "Aria", true),
    ("jason", "Jason", false),
    ("john", "John", false),
    ("leo", "Leo", false),
    ("sofia", "Sofia", true),
];
pub const MAGPIE_DEFAULT_VOICE: &str = "sofia";

/// Languages with a native tokenizer here, `(code, label)` for the voice picker.
pub const MAGPIE_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("de", "German"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("it", "Italian"),
    ("pt-br", "Portuguese (BR)"),
    ("hi", "Hindi"),
    ("ar", "Arabic"),
    ("ko", "Korean"),
    ("vi", "Vietnamese"),
];

const D: usize = 768;
const NCB: usize = 8;
const FS: usize = 2;
const NTOK: usize = 2024;
const CODEBOOK: usize = 2016;
const AUDIO_BOS: i64 = 2016;
const AUDIO_EOS: i64 = 2017;
const N_CTX: usize = 217;
const MAX_STEPS: usize = 250;
const TEMPERATURE: f64 = 0.6;
const TOP_K: usize = 80;
const CFG_SCALE: f32 = 2.5;
const PRIOR_EPS: f32 = 0.1;
const LOOKAHEAD: usize = 6;
const MIN_FRAMES: usize = 4;
/// NeMo starts the aligner at text position 1 (`ChunkState.last_attended_timesteps`).
const INITIAL_ATTENDED: usize = 1;
/// Phrases longer than this are split at commas / word boundaries before synthesis — the
/// 500-frame (~23 s) decoder budget otherwise truncates them (NeMo-Speech.cpp uses the
/// same 35-word phrase cap).
const MAX_WORDS_PER_PHRASE: usize = 35;
/// Intra-op cap for the local-transformer session (`None` = ORT default pool).
const LOCAL_STEP_THREADS: Option<usize> = Some(4);

#[derive(Debug, thiserror::Error)]
pub enum MagpieError {
    #[error("magpie assets missing: {0}")]
    Assets(String),
    #[error("magpie session error: {0}")]
    Session(String),
    #[error("magpie inference error: {0}")]
    Inference(String),
}

pub type MagpieResult<T> = Result<T, MagpieError>;

fn inf<E: std::fmt::Display>(ctx: &'static str) -> impl FnOnce(E) -> MagpieError {
    move |e| MagpieError::Inference(format!("{ctx}: {e}"))
}

/// The graph file names for a quant rung (shared with the download manifest).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MagpieGraphSet {
    pub text_encoder: &'static str,
    pub decoder_step: &'static str,
    pub local_step: &'static str,
}

pub const MAGPIE_CODEC: &str = "codec_decoder.onnx";
pub const MAGPIE_SHARED_FILES: &[&str] = &[
    MAGPIE_CODEC,
    "audio_embeddings.bin",
    "speaker_context.bin",
    "tokenizer/magpie_tokenizers.json",
    "tokenizer/en_ipa_cmudict-0.7b_nv23.01.txt",
    "tokenizer/en_heteronyms-052722.txt",
    "tokenizer/es_ES_nv230301.dict",
    "tokenizer/de_nv230119.dict",
    "tokenizer/de_nv230119.heteronym",
    "tokenizer/pt_br_prondict-v1.0.dict",
    "tokenizer/hi_phoneme_merged_phoneme_dict.dict",
    "LICENSE",
    "NOTICE",
];

pub fn magpie_graph_set(quant: &str) -> MagpieGraphSet {
    match quant {
        "fp32" => MagpieGraphSet {
            text_encoder: "text_encoder.onnx",
            decoder_step: "decoder_step.onnx",
            local_step: "local_step.onnx",
        },
        _ => MagpieGraphSet {
            text_encoder: "text_encoder_int8.onnx",
            decoder_step: "decoder_step_int8.onnx",
            local_step: "local_step_int8.onnx",
        },
    }
}

/// Voice id → speaker index (unknown ids fall back to the default voice).
pub fn speaker_index(voice: &str) -> usize {
    let v = voice.trim().to_ascii_lowercase();
    MAGPIE_SPEAKERS
        .iter()
        .position(|(id, _, _)| *id == v)
        .or_else(|| {
            MAGPIE_SPEAKERS
                .iter()
                .position(|(id, _, _)| *id == MAGPIE_DEFAULT_VOICE)
        })
        .unwrap_or(0)
}

pub struct MagpieEngine {
    text_encoder: Session,
    decoder: Session,
    local: Session,
    codec: Session,
    /// (16, 2024, 768) codebook embeddings, flat.
    audio_emb: Vec<f32>,
    /// (5, 217, 768) baked speaker contexts, flat.
    speaker_ctx: Vec<f32>,
    text: MagpieText,
    dec_layers: usize,
    dec_heads: usize,
    dec_head_dim: usize,
    lt_layers: usize,
    lt_heads: usize,
    lt_head_dim: usize,
    uncond: Option<std::sync::Arc<UncondPrefill>>,
}

impl MagpieEngine {
    pub fn load(dir: &Path, quant: &str) -> MagpieResult<Self> {
        let set = magpie_graph_set(quant);
        let need = |name: &str| -> MagpieResult<std::path::PathBuf> {
            let p = dir.join(name);
            if p.is_file() {
                Ok(p)
            } else {
                Err(MagpieError::Assets(p.display().to_string()))
            }
        };
        // All four sessions run back to back, so idle pools must not busy-spin against the active
        // one (3x slower end to end when they do). The local transformer runs 16 single-row steps
        // per frame pair, a stack of tiny GEMMs, so it may also take a narrower pool.
        let session = |name: &str, threads: Option<usize>| -> MagpieResult<Session> {
            super::provider::cpu_session_without_spinning(
                &need(name)?,
                "Magpie's step graphs are validated on CPU only",
                "magpie",
                threads,
            )
            .map_err(MagpieError::Session)
        };
        let text_encoder = session(set.text_encoder, None)?;
        let decoder = session(set.decoder_step, None)?;
        let local = session(set.local_step, LOCAL_STEP_THREADS)?;
        let codec = session(MAGPIE_CODEC, None)?;
        let audio_emb = read_f32(&need("audio_embeddings.bin")?, FS * NCB * NTOK * D)?;
        let speaker_ctx = read_f32(
            &need("speaker_context.bin")?,
            MAGPIE_SPEAKERS.len() * N_CTX * D,
        )?;
        let text = MagpieText::load(&dir.join("tokenizer")).map_err(MagpieError::Assets)?;
        let (dec_layers, dec_heads, dec_head_dim) = kv_dims(&decoder)?;
        let (lt_layers, lt_heads, lt_head_dim) = kv_dims(&local)?;
        Ok(Self {
            text_encoder,
            decoder,
            local,
            codec,
            audio_emb,
            speaker_ctx,
            text,
            dec_layers,
            dec_heads,
            dec_head_dim,
            lt_layers,
            lt_heads,
            lt_head_dim,
            uncond: None,
        })
    }

    /// Render `text` in `lang` with the built-in `voice`. Long sentences are split into
    /// phrases (see [`MAX_WORDS_PER_PHRASE`]) whose audio is concatenated.
    pub fn synthesize(&mut self, text: &str, voice: &str, lang: &str) -> MagpieResult<Vec<f32>> {
        let tokenizer = tokenizer_for_language(lang).unwrap_or_else(|| {
            log::warn!("[tts] magpie has no tokenizer for {lang:?}; using English");
            "english_phoneme"
        });
        let speaker = speaker_index(voice);
        let mut audio = Vec::new();
        for phrase in split_long_phrase(text, MAX_WORDS_PER_PHRASE) {
            let ids = self
                .text
                .encode(&phrase, tokenizer)
                .map_err(MagpieError::Inference)?;
            // Only the text EOS left → nothing speakable.
            if ids.len() <= 1 {
                continue;
            }
            let codes = self.generate_codes(&ids, speaker, Some(seed_for(&ids, speaker)))?;
            audio.extend(self.decode_audio(&codes)?);
        }
        Ok(audio)
    }

    /// Token ids for `text` (incl. the text EOS) — exposed for the golden tokenizer test.
    pub fn encode_text(&mut self, text: &str, tokenizer: &str) -> MagpieResult<Vec<i64>> {
        self.text
            .encode(text, tokenizer)
            .map_err(MagpieError::Inference)
    }

    fn frame_embedding(&self, frame: &[[i64; FS]; NCB]) -> Vec<f32> {
        let mut acc = vec![0f32; D];
        for (c, row) in frame.iter().enumerate() {
            for (i, &tok) in row.iter().enumerate() {
                let tok = tok.clamp(0, NTOK as i64 - 1) as usize;
                let base = ((c + i * NCB) * NTOK + tok) * D;
                for (a, e) in acc.iter_mut().zip(&self.audio_emb[base..base + D]) {
                    *a += *e;
                }
            }
        }
        let scale = 1.0 / (NCB * FS) as f32;
        acc.iter_mut().for_each(|a| *a *= scale);
        acc
    }

    fn embedding_row(&self, flat_cb: usize, tok: i64) -> &[f32] {
        let tok = tok.clamp(0, NTOK as i64 - 1) as usize;
        let base = (flat_cb * NTOK + tok) * D;
        &self.audio_emb[base..base + D]
    }

    /// `text` ids `(1, Tt)` → per-layer cross-attention K/V `(L, 2, Tt, xd)` for [cond, uncond].
    fn encode_cross(&mut self, text: Tensor<i64>) -> MagpieResult<(DynValue, DynValue)> {
        let mut enc = self
            .text_encoder
            .run(ort::inputs! { "text" => text })
            .map_err(inf("text_encoder run"))?;
        let k = enc
            .remove("cross_k")
            .ok_or_else(|| inf("cross_k")("missing"))?;
        let v = enc
            .remove("cross_v")
            .ok_or_else(|| inf("cross_v")("missing"))?;
        Ok((k, v))
    }

    /// Prefill rows `[context ; BOS frame]`: the baked speaker context for the conditional
    /// row, zeros for the unconditional one (NeMo `prepare_dummy_cond_for_cfg`).
    fn prefill_rows(&self, speaker: Option<usize>) -> Vec<f32> {
        let mut x = vec![0f32; (N_CTX + 1) * D];
        if let Some(s) = speaker {
            x[..N_CTX * D].copy_from_slice(&self.speaker_ctx[s * N_CTX * D..(s + 1) * N_CTX * D]);
        }
        x[N_CTX * D..].copy_from_slice(&self.frame_embedding(&[[AUDIO_BOS; FS]; NCB]));
        x
    }

    /// One `decoder_step` run over `batch` rows.
    #[allow(clippy::too_many_arguments)]
    fn decode(
        &mut self,
        x: DynValue,
        past_k: DynValue,
        past_v: DynValue,
        cross_k: &DynValue,
        cross_v: &DynValue,
        cond_mask: &DynValue,
        prior: Vec<f32>,
        batch: usize,
    ) -> MagpieResult<DecodeOut> {
        let tt = prior.len() / batch;
        let prior = Tensor::from_array(([batch, tt], prior)).map_err(inf("prior"))?;
        let mut out = self
            .decoder
            .run(ort::inputs! {
                "x" => x,
                "past_k" => past_k,
                "past_v" => past_v,
                "cross_k" => cross_k,
                "cross_v" => cross_v,
                "cond_mask" => cond_mask,
                "prior" => prior,
            })
            .map_err(inf("decoder run"))?;
        let logits = extract(&out, "logits")?;
        let dec_out = extract(&out, "dec_out")?;
        let align = extract(&out, "align")?;
        let k = out.remove("new_k").ok_or_else(|| inf("new_k")("missing"))?;
        let v = out.remove("new_v").ok_or_else(|| inf("new_v")("missing"))?;
        Ok(DecodeOut {
            logits,
            dec_out,
            align,
            k,
            v,
        })
    }

    /// The unconditional CFG row's step-0 decoder state. Its inputs never change — zero
    /// context + the BOS frame, attending only the (zeroed) first encoder position, no
    /// prior — so it is identical for every text and speaker: computed once per engine,
    /// halving the per-phrase prefill (the largest single cost after the codec).
    fn uncond_prefill(&mut self) -> MagpieResult<std::sync::Arc<UncondPrefill>> {
        if let Some(u) = &self.uncond {
            return Ok(u.clone());
        }
        let text = Tensor::from_array(([1usize, 1], vec![0i64])).map_err(inf("text tensor"))?;
        let (ck, cv) = self.encode_cross(text)?;
        let (ck_all, cv_all) = (tensor_vec(&ck)?, tensor_vec(&cv)?);
        let xd = ck_all.len() / (self.dec_layers * 2);
        let uncond_row = |v: &[f32]| -> Vec<f32> {
            v.chunks(xd).skip(1).step_by(2).flatten().copied().collect()
        };
        let ck = Tensor::from_array(([self.dec_layers, 1, 1, xd], uncond_row(&ck_all)))
            .map_err(inf("uncond cross_k"))?
            .into_dyn();
        let cv = Tensor::from_array(([self.dec_layers, 1, 1, xd], uncond_row(&cv_all)))
            .map_err(inf("uncond cross_v"))?
            .into_dyn();
        let mask = Tensor::from_array(([1usize, 1], vec![1f32]))
            .map_err(inf("mask tensor"))?
            .into_dyn();
        let x = Tensor::from_array(([1usize, N_CTX + 1, D], self.prefill_rows(None)))
            .map_err(inf("x"))?
            .into_dyn();
        let out = self.decode(
            x,
            empty_kv(self.dec_layers, 1, self.dec_heads, self.dec_head_dim)?,
            empty_kv(self.dec_layers, 1, self.dec_heads, self.dec_head_dim)?,
            &ck,
            &cv,
            &mask,
            vec![1f32],
            1,
        )?;
        let u = std::sync::Arc::new(UncondPrefill {
            k: tensor_vec(&out.k)?,
            v: tensor_vec(&out.v)?,
            logits: out.logits,
            dec_out: out.dec_out,
        });
        self.uncond = Some(u.clone());
        Ok(u)
    }

    /// The NeMo decode loop. `seed: None` → greedy local transformer (temperature 0), the
    /// mode the parity test compares against NeMo token by token.
    pub fn generate_codes(
        &mut self,
        ids: &[i64],
        speaker: usize,
        seed: Option<u64>,
    ) -> MagpieResult<Vec<[i64; NCB]>> {
        let tt = ids.len();
        let text = Tensor::from_array(([1usize, tt], ids.to_vec())).map_err(inf("text tensor"))?;
        let (cross_k, cross_v) = self.encode_cross(text)?;

        let mut mask = vec![0f32; 2 * tt];
        mask[..tt].iter_mut().for_each(|m| *m = 1.0);
        mask[tt] = 1.0;
        let cond_mask = Tensor::from_array(([2usize, tt], mask))
            .map_err(inf("mask tensor"))?
            .into_dyn();

        // Prefill the conditional row only ([speaker context ; BOS frame] against the text);
        // the unconditional row's step-0 state is text- and speaker-independent and cached.
        let uncond = self.uncond_prefill()?;
        let (ck_all, cv_all) = (tensor_vec(&cross_k)?, tensor_vec(&cross_v)?);
        let xd = ck_all.len() / (self.dec_layers * 2 * tt);
        let ck = Tensor::from_array((
            [self.dec_layers, 1, tt, xd],
            cond_row(&ck_all, self.dec_layers),
        ))
        .map_err(inf("cond cross_k"))?
        .into_dyn();
        let cv = Tensor::from_array((
            [self.dec_layers, 1, tt, xd],
            cond_row(&cv_all, self.dec_layers),
        ))
        .map_err(inf("cond cross_v"))?
        .into_dyn();
        let cond_mask1 = Tensor::from_array(([1usize, tt], vec![1f32; tt]))
            .map_err(inf("mask tensor"))?
            .into_dyn();
        let pre = self.decode(
            Tensor::from_array(([1usize, N_CTX + 1, D], self.prefill_rows(Some(speaker))))
                .map_err(inf("x"))?
                .into_dyn(),
            empty_kv(self.dec_layers, 1, self.dec_heads, self.dec_head_dim)?,
            empty_kv(self.dec_layers, 1, self.dec_heads, self.dec_head_dim)?,
            &ck,
            &cv,
            &cond_mask1,
            vec![1f32; tt],
            1,
        )?;
        let kv_shape = [
            self.dec_layers,
            2,
            self.dec_heads,
            N_CTX + 1,
            self.dec_head_dim,
        ];
        let cat = |c: &[f32], u: &[f32]| -> Vec<f32> {
            let per = c.len() / self.dec_layers;
            let mut out = Vec::with_capacity(2 * c.len());
            for l in 0..self.dec_layers {
                out.extend_from_slice(&c[l * per..(l + 1) * per]);
                out.extend_from_slice(&u[l * per..(l + 1) * per]);
            }
            out
        };
        let mut past_k: DynValue =
            Tensor::from_array((kv_shape, cat(&tensor_vec(&pre.k)?, &uncond.k)))
                .map_err(inf("kv"))?
                .into_dyn();
        let mut past_v: DynValue =
            Tensor::from_array((kv_shape, cat(&tensor_vec(&pre.v)?, &uncond.v)))
                .map_err(inf("kv"))?
                .into_dyn();
        let mut logits = [pre.logits, uncond.logits.clone()].concat();
        let mut dec_out = [pre.dec_out, uncond.dec_out.clone()].concat();
        let mut align = pre.align;

        let mut x: Vec<f32> = Vec::new();
        let mut prior = vec![1f32; 2 * tt];
        let mut last_attended = INITIAL_ATTENDED;
        let mut counter: Vec<u32> = vec![0; tt];
        let mut rng = seed.map(SplitMix64Rng::new);
        let mut frames: Vec<[[i64; FS]; NCB]> = Vec::new();
        let mut end_len: Option<usize> = None;

        for step in 0..MAX_STEPS {
            if step > 0 {
                let out = self.decode(
                    Tensor::from_array(([2usize, 1, D], std::mem::take(&mut x)))
                        .map_err(inf("x"))?
                        .into_dyn(),
                    past_k,
                    past_v,
                    &cross_k,
                    &cross_v,
                    &cond_mask,
                    prior.clone(),
                    2,
                )?;
                logits = out.logits; // (2, 16*2024)
                dec_out = out.dec_out; // (2, 768)
                align = out.align; // (2, Tt) — only the conditional row is read
                past_k = out.k;
                past_v = out.v;
            }

            // ── aligner + next attention prior (conditional row only) ──
            let mut from = last_attended;
            if counter.get(from).copied().unwrap_or(0) >= 8 {
                from += 1; // attention sink — move on
            }
            let window_end = (from + LOOKAHEAD).min(tt.saturating_sub(3));
            let attended = if from >= window_end {
                tt - 1
            } else {
                let w = &align[from..window_end];
                from + argmax_f32(w)
            };
            counter[attended] += 1;
            last_attended = attended;
            prior.iter_mut().for_each(|p| *p = 1.0);
            if tt > 5 {
                prior[..tt].iter_mut().for_each(|p| *p = PRIOR_EPS);
                prior[attended.saturating_sub(1).max(1)] = 1.0;
                prior[attended] = 1.0;
                for k in 1..=LOOKAHEAD {
                    prior[(attended + k).min(tt - 1)] = 1.0;
                }
            }
            for (t, &n) in counter.iter().enumerate() {
                if n >= 10 {
                    prior[..=t].iter_mut().for_each(|p| *p = PRIOR_EPS);
                }
            }
            let forbid_eos = step * FS < MIN_FRAMES;

            // ── argmax codes of the CFG-mixed decoder logits (EOS detection only) ──
            let width = NCB * FS * NTOK;
            let mut argmax_frame = [[0i64; FS]; NCB];
            for i in 0..FS {
                for (c, row) in argmax_frame.iter_mut().enumerate() {
                    let si = (c + NCB * i) * NTOK;
                    let mixed: Vec<f32> = (0..NTOK)
                        .map(|t| cfg_mix(logits[si + t], logits[width + si + t]))
                        .collect();
                    row[i] = masked_argmax(&mixed, forbid_eos) as i64;
                }
            }

            // ── local transformer: 16 codes, AR over the flat codebook index ──
            let mut lk: DynValue = empty_kv(self.lt_layers, 2, self.lt_heads, self.lt_head_dim)?;
            let mut lv: DynValue = empty_kv(self.lt_layers, 2, self.lt_heads, self.lt_head_dim)?;
            let mut lt_in: Vec<f32> = std::mem::take(&mut dec_out);
            let mut toks = [0i64; NCB * FS];
            for (cb, tok_slot) in toks.iter_mut().enumerate() {
                let x_in = Tensor::from_array(([2usize, D], lt_in)).map_err(inf("lt x"))?;
                let cb_t = Tensor::from_array((Vec::<usize>::new(), vec![cb as i64]))
                    .map_err(inf("cb"))?;
                let mut lo = self
                    .local
                    .run(ort::inputs! { "x_in" => x_in, "cb" => cb_t, "past_k" => lk, "past_v" => lv })
                    .map_err(inf("local run"))?;
                let lg = extract(&lo, "logits")?; // (2, 2024)
                lk = lo
                    .remove("new_k")
                    .ok_or_else(|| inf("lt new_k")("missing"))?;
                lv = lo
                    .remove("new_v")
                    .ok_or_else(|| inf("lt new_v")("missing"))?;
                drop(lo);
                let mut mixed: Vec<f64> = (0..NTOK)
                    .map(|t| f64::from(cfg_mix(lg[t], lg[NTOK + t])))
                    .collect();
                forbid(&mut mixed, forbid_eos);
                let tok = match rng.as_mut() {
                    Some(r) => sample(&mixed, true, TOP_K, 1.0, TEMPERATURE, r),
                    None => argmax_f64(&mixed),
                } as i64;
                *tok_slot = tok;
                let e = self.embedding_row(cb, tok);
                let mut next = Vec::with_capacity(2 * D);
                next.extend_from_slice(e);
                next.extend_from_slice(e);
                lt_in = next;
            }
            let mut frame = [[0i64; FS]; NCB];
            for (k, &tok) in toks.iter().enumerate() {
                frame[k % NCB][k / NCB] = tok;
            }

            // ── EOS: first stacked frame with an EOS in any codebook, sampled or argmax ──
            let eos_at =
                |f: &[[i64; FS]; NCB]| (0..FS).find(|&i| f.iter().any(|row| row[i] == AUDIO_EOS));
            let idx = match (eos_at(&frame), eos_at(&argmax_frame)) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            frames.push(frame);
            if let Some(i) = idx {
                end_len = Some(step * FS + i);
                break;
            }
            let emb = self.frame_embedding(&frame);
            x = Vec::with_capacity(2 * D);
            x.extend_from_slice(&emb);
            x.extend_from_slice(&emb);
        }

        let total = frames.len() * FS;
        let n = end_len.unwrap_or(total).min(total);
        let mut codes = Vec::with_capacity(n);
        for t in 0..n {
            let f = &frames[t / FS];
            let mut col = [0i64; NCB];
            for (c, slot) in col.iter_mut().enumerate() {
                *slot = f[c][t % FS];
            }
            codes.push(col);
        }
        Ok(codes)
    }

    pub fn decode_audio(&mut self, codes: &[[i64; NCB]]) -> MagpieResult<Vec<f32>> {
        if codes.is_empty() {
            return Ok(Vec::new());
        }
        let t = codes.len();
        let mut data = vec![0i64; NCB * t];
        for (ti, col) in codes.iter().enumerate() {
            for (c, &v) in col.iter().enumerate() {
                // Special tokens never reach the codec (EOS frames are trimmed); clamp as a guard.
                data[c * t + ti] = v.clamp(0, CODEBOOK as i64 - 1);
            }
        }
        let arr = Array3::from_shape_vec((1, NCB, t), data).map_err(inf("codes arr"))?;
        let tensor = Tensor::from_array(arr).map_err(inf("codes tensor"))?;
        let out = self
            .codec
            .run(ort::inputs! { "codes" => tensor })
            .map_err(inf("codec run"))?;
        let audio = extract(&out, "audio")?;
        Ok(audio)
    }
}

fn cfg_mix(cond: f32, uncond: f32) -> f32 {
    CFG_SCALE * cond + (1.0 - CFG_SCALE) * uncond
}

/// `clear_forbidden_logits`: every special token except AUDIO_EOS (and EOS too while
/// `forbid_eos`).
fn forbid(logits: &mut [f64], forbid_eos: bool) {
    for (t, l) in logits.iter_mut().enumerate().skip(CODEBOOK) {
        if t as i64 != AUDIO_EOS || forbid_eos {
            *l = f64::NEG_INFINITY;
        }
    }
}

fn masked_argmax(logits: &[f32], forbid_eos: bool) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (t, &v) in logits.iter().enumerate() {
        let allowed = t < CODEBOOK || (t as i64 == AUDIO_EOS && !forbid_eos);
        if allowed && v > best_v {
            best_v = v;
            best = t;
        }
    }
    best
}

fn argmax_f32(v: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &x) in v.iter().enumerate() {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    best
}

fn argmax_f64(v: &[f64]) -> usize {
    let mut best = 0usize;
    let mut best_v = f64::NEG_INFINITY;
    for (i, &x) in v.iter().enumerate() {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    best
}

fn extract(out: &ort::session::SessionOutputs<'_>, name: &str) -> MagpieResult<Vec<f32>> {
    let (_, data) = out[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| MagpieError::Inference(format!("extract {name}: {e}")))?;
    Ok(data.to_vec())
}

/// One `decoder_step` result: `(B, 16*2024)` logits, `(B, 768)` hidden state, `(B, Tt)`
/// alignment, and the grown self-attention KV cache.
struct DecodeOut {
    logits: Vec<f32>,
    dec_out: Vec<f32>,
    align: Vec<f32>,
    k: DynValue,
    v: DynValue,
}

/// See [`MagpieEngine::uncond_prefill`]. `k`/`v` are `(L, 1, H, 218, d)` flat.
struct UncondPrefill {
    k: Vec<f32>,
    v: Vec<f32>,
    logits: Vec<f32>,
    dec_out: Vec<f32>,
}

fn tensor_vec(v: &DynValue) -> MagpieResult<Vec<f32>> {
    let (_, data) = v
        .try_extract_tensor::<f32>()
        .map_err(|e| MagpieError::Inference(format!("extract tensor: {e}")))?;
    Ok(data.to_vec())
}

/// Row 0 (conditional) of a `(L, 2, ...)` tensor → `(L, 1, ...)`.
fn cond_row(v: &[f32], layers: usize) -> Vec<f32> {
    let per = v.len() / layers;
    v.chunks(per)
        .flat_map(|layer| &layer[..per / 2])
        .copied()
        .collect()
}

fn empty_kv(layers: usize, batch: usize, heads: usize, head_dim: usize) -> MagpieResult<DynValue> {
    let t = Tensor::from_array(([layers, batch, heads, 0, head_dim], Vec::<f32>::new()))
        .map_err(inf("empty kv"))?;
    Ok(t.into_dyn())
}

/// `(layers, heads, head_dim)` from the `past_k` input shape `(L, B, H, T, d)`.
fn kv_dims(sess: &Session) -> MagpieResult<(usize, usize, usize)> {
    let input = sess
        .inputs()
        .iter()
        .find(|i| i.name() == "past_k")
        .ok_or_else(|| MagpieError::Session("graph has no past_k input".into()))?;
    let shape = input
        .dtype()
        .tensor_shape()
        .ok_or_else(|| MagpieError::Session("past_k is not a tensor".into()))?;
    let dims: Vec<i64> = shape.iter().copied().collect();
    match dims.as_slice() {
        [l, _, h, _, d] if *l > 0 && *h > 0 && *d > 0 => {
            Ok((*l as usize, *h as usize, *d as usize))
        }
        other => Err(MagpieError::Session(format!(
            "unexpected past_k shape {other:?}"
        ))),
    }
}

fn read_f32(path: &Path, expected: usize) -> MagpieResult<Vec<f32>> {
    let bytes =
        std::fs::read(path).map_err(|e| MagpieError::Assets(format!("{}: {e}", path.display())))?;
    if bytes.len() != expected * 4 {
        return Err(MagpieError::Assets(format!(
            "{}: {} bytes, expected {}",
            path.display(),
            bytes.len(),
            expected * 4
        )));
    }
    Ok(bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect())
}

/// Deterministic per-(text, speaker) seed so a sentence renders identically every time.
fn seed_for(ids: &[i64], speaker: usize) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &v in ids.iter().chain(std::iter::once(&(speaker as i64))) {
        for b in v.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    h
}

/// Split an over-long sentence at commas, then at word boundaries, into phrases of at most
/// `max_words` whitespace-separated words (NeMo-Speech.cpp `split_long_sentence_by_commas`).
fn split_long_phrase(text: &str, max_words: usize) -> Vec<String> {
    let words = |s: &str| s.split_whitespace().count();
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if words(text) <= max_words {
        return vec![text.to_string()];
    }
    let by_words = |s: &str| -> Vec<String> {
        let ws: Vec<&str> = s.split_whitespace().collect();
        ws.chunks(max_words).map(|c| c.join(" ")).collect()
    };
    let mut phrases: Vec<String> = Vec::new();
    let mut cur = String::new();
    for clause in text.split_inclusive(',') {
        let clause = clause.trim();
        if clause.is_empty() {
            continue;
        }
        for piece in if words(clause) > max_words {
            by_words(clause)
        } else {
            vec![clause.to_string()]
        } {
            if cur.is_empty() {
                cur = piece;
            } else if words(&cur) + words(&piece) <= max_words {
                cur.push(' ');
                cur.push_str(&piece);
            } else {
                phrases.push(std::mem::take(&mut cur));
                cur = piece;
            }
        }
    }
    if !cur.is_empty() {
        phrases.push(cur);
    }
    phrases
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voices_map_to_speaker_rows() {
        assert_eq!(speaker_index("aria"), 0);
        assert_eq!(speaker_index("Leo"), 3);
        assert_eq!(speaker_index("sofia"), 4);
        assert_eq!(speaker_index("nobody"), 4, "unknown → default voice");
    }

    #[test]
    fn forbidden_tokens_keep_only_codes_and_eos() {
        let mut l = vec![0.0f64; NTOK];
        forbid(&mut l, false);
        assert!(l[..CODEBOOK].iter().all(|v| *v == 0.0));
        assert_eq!(l[AUDIO_EOS as usize], 0.0);
        assert!(l[AUDIO_BOS as usize].is_infinite());
        forbid(&mut l, true);
        assert!(l[AUDIO_EOS as usize].is_infinite());
        let mut f = vec![0.0f32; NTOK];
        f[AUDIO_EOS as usize] = 5.0;
        f[AUDIO_BOS as usize] = 9.0;
        assert_eq!(masked_argmax(&f, false), AUDIO_EOS as usize);
        assert_eq!(masked_argmax(&f, true), 0);
    }

    #[test]
    fn long_sentences_split_into_bounded_phrases() {
        let long = (0..80)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let p = split_long_phrase(&long, 35);
        assert_eq!(p.len(), 3);
        assert!(p.iter().all(|s| s.split_whitespace().count() <= 35));
        assert_eq!(split_long_phrase("Short one.", 35), vec!["Short one."]);
        assert!(split_long_phrase("   ", 35).is_empty());
    }

    #[test]
    fn graph_sets_resolve_by_quant() {
        assert_eq!(magpie_graph_set("fp32").decoder_step, "decoder_step.onnx");
        assert_eq!(
            magpie_graph_set("int8").decoder_step,
            "decoder_step_int8.onnx"
        );
        assert_eq!(magpie_graph_set(""), magpie_graph_set("int8"));
    }

    fn env_path(var: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var(var).unwrap_or_else(|_| panic!("set {var}")))
    }

    /// PARITY: the Rust tokenizer port against ids NeMo produced for the same strings
    /// (`golden_tokens.json`, written by the export scripts, not committed):
    ///   WINSTT_MAGPIE_DIR=<model dir> WINSTT_MAGPIE_GOLDEN=<golden_tokens.json>
    ///   cargo test magpie_tokenizer_matches_nemo -- --ignored
    #[test]
    #[ignore = "requires WINSTT_MAGPIE_DIR + WINSTT_MAGPIE_GOLDEN"]
    fn magpie_tokenizer_matches_nemo() {
        let dir = env_path("WINSTT_MAGPIE_DIR");
        let golden: serde_json::Value = serde_json::from_slice(
            &std::fs::read(env_path("WINSTT_MAGPIE_GOLDEN")).expect("read golden"),
        )
        .expect("parse golden");
        let mut text = MagpieText::load(&dir.join("tokenizer")).expect("load tokenizer");
        let cases = golden["cases"].as_array().expect("cases");
        let mut bad = Vec::new();
        for case in cases {
            let tok = case["tokenizer"].as_str().expect("tokenizer");
            let s = case["text"].as_str().expect("text");
            let want: Vec<i64> = case["ids"]
                .as_array()
                .expect("ids")
                .iter()
                .map(|v| v.as_i64().expect("id"))
                .collect();
            let got = text.encode(s, tok).expect("encode");
            if got != want {
                bad.push(format!("[{tok}] {s:?}\n  want {want:?}\n  got  {got:?}"));
            }
        }
        println!(
            "magpie tokenizer: {}/{} cases match",
            cases.len() - bad.len(),
            cases.len()
        );
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    /// END TO END: synthesize every sentence of `WINSTT_MAGPIE_SENTENCES` (a JSON list of
    /// `{key, lang, text}`) into `WINSTT_MAGPIE_WAVS/<key>.wav` for the external WER check,
    /// and dump greedy codes (`<key>.codes.json`) for the token-parity check against NeMo.
    ///   WINSTT_MAGPIE_QUANT=fp32|int8 (default int8)
    ///   cargo test magpie_real_weights_synthesis -- --ignored --nocapture
    #[test]
    #[ignore = "requires WINSTT_MAGPIE_DIR + WINSTT_MAGPIE_SENTENCES + WINSTT_MAGPIE_WAVS"]
    fn magpie_real_weights_synthesis() {
        let dir = env_path("WINSTT_MAGPIE_DIR");
        let quant = std::env::var("WINSTT_MAGPIE_QUANT").unwrap_or_else(|_| "int8".into());
        let out = env_path("WINSTT_MAGPIE_WAVS");
        std::fs::create_dir_all(&out).expect("wav dir");
        let list: serde_json::Value = serde_json::from_slice(
            &std::fs::read(env_path("WINSTT_MAGPIE_SENTENCES")).expect("read sentences"),
        )
        .expect("parse sentences");
        let mut eng = MagpieEngine::load(&dir, &quant).expect("load engine");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: MAGPIE_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let (mut audio_s, mut wall_s) = (0f64, 0f64);
        for item in list.as_array().expect("list") {
            let key = item["key"].as_str().expect("key");
            let lang = item["lang"].as_str().expect("lang");
            let text = item["text"].as_str().expect("text");
            let voice = item["voice"].as_str().unwrap_or(MAGPIE_DEFAULT_VOICE);
            let t0 = std::time::Instant::now();
            let pcm = eng.synthesize(text, voice, lang).expect("synthesize");
            let dt = t0.elapsed().as_secs_f64();
            let secs = pcm.len() as f64 / f64::from(MAGPIE_SAMPLE_RATE);
            assert!(secs > 0.3, "{key}: only {secs:.2}s of audio");
            assert!(pcm.iter().all(|s| s.is_finite()), "{key}: non-finite audio");
            audio_s += secs;
            wall_s += dt;
            println!("{key}: {secs:.2}s audio in {dt:.2}s (RTF {:.2})", dt / secs);
            let mut w =
                hound::WavWriter::create(out.join(format!("{key}.wav")), spec).expect("wav");
            pcm.iter().for_each(|s| w.write_sample(*s).expect("sample"));
            w.finalize().expect("finalize");

            if item["greedy"].as_bool().unwrap_or(false) {
                let tok = tokenizer_for_language(lang).expect("tokenizer");
                let ids = eng.encode_text(text, tok).expect("encode");
                let codes = eng
                    .generate_codes(&ids, speaker_index(voice), None)
                    .expect("greedy codes");
                let json = serde_json::to_vec(&codes).expect("codes json");
                std::fs::write(out.join(format!("{key}.codes.json")), json).expect("codes");
            }
        }
        println!(
            "magpie {quant}: total RTF {:.3}",
            wall_s / audio_s.max(1e-9)
        );
    }
}
