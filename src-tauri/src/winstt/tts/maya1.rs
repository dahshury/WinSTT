// Maya1 (maya-research/maya1, Apache-2.0) — 3B Llama decoder → SNAC 24 kHz codec → audio.
//
// The voice is not a preset: it is a natural-language DESCRIPTION ("Female, 30s, British
// accent, warm timbre, calm pacing") carried in the prompt, and the text may carry inline
// emotion tags (`<laugh>`, `<sigh>`, `<whisper>` …) that the tokenizer maps to single
// special tokens. Pipeline (mirrors the model card's reference `generate` path, verified
// end-to-end in Python against our own export `Masterx/maya1-ONNX` before this port):
//
//   prompt   = [BOS, SOH, BOS] ++ tok('<description="{desc}"> {text}') ++ [EOT, EOH, SOA, SOS]
//              (the reference builds this as a STRING and calls `tokenizer(prompt)`, whose
//              template prepends a second BOS — reproduced verbatim, it is what the model saw)
//   decode   = merged Llama decoder w/ KV cache (28 layers, 8 KV heads, head_dim 128; the
//              onnxruntime-genai graph derives positions from `attention_mask`, so NO
//              position_ids). The logit row is restricted to the SNAC band + audio EOS (the
//              upstream vLLM script's `OnlyAudioAfterSOS` processor), EOS is suppressed for the
//              first 28 tokens (`min_new_tokens`), then repetition penalty 1.1 → temperature
//              0.4 → top-p 0.9, until audio EOS (128258).
//   codec    = 7 codes/frame → SNAC's 3 hierarchical layers ((id - 128266) mod 4096), SNAC
//              decode, then drop the first 2048 samples (the decoder's warm-up, per the card).
//
// Device: CPU. A DirectML rung (onnxruntime-genai `-e dml` int4/fp16 build, its
// GroupQueryAttention driven in shared-buffer mode through IoBinding) was exported, wired and
// dropped: on an RTX 3080 Ti it decoded at 0.3-2.4 tok/s with the GPU ~3 % busy — slower than
// the CPU EP (~10 tok/s, RTF ~9 on an i9-12900KF). SNAC is tiny: CPU as well.

use std::borrow::Cow;
use std::path::Path;

use half::f16;
use ndarray::{Array2, Array4};
use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor, TensorElementType};
use tokenizers::Tokenizer;

pub const MAYA1_SAMPLE_RATE: u32 = 24_000;

// Control tokens (maya-research/maya1 card + `vllm_streaming_inference.py`).
const BOS: i64 = 128_000; // <|begin_of_text|>
const SOH: i64 = 128_259; // start of human turn
const EOT: i64 = 128_009; // end of text (<|eot_id|>)
const EOH: i64 = 128_260; // end of human turn
const SOA: i64 = 128_261; // start of AI turn
const SOS: i64 = 128_257; // start of speech (the codes follow it)
const AUDIO_EOS: i64 = 128_258; // end of speech — the only stop token
const CODE_OFFSET: i64 = 128_266; // first SNAC code id
const SNAC_CODEBOOK: i64 = 4_096; // codes per SNAC slot
const FRAME_CODES: usize = 7;
/// Number of SNAC code ids (7 slots x 4096) — the band the sampler is restricted to.
const SNAC_BAND: usize = FRAME_CODES * SNAC_CODEBOOK as usize;
/// Hard decode ceiling. 2,800 tokens = 400 SNAC frames = 34 s at 24 kHz; the model was
/// fine-tuned on 1-14 s clips and the app feeds it one sentence at a time, so reaching it is
/// always a failure.
const MAX_NEW_TOKENS: usize = 2_800;
/// Per-sentence budget = base + per-character allowance, capped at [`MAX_NEW_TOKENS`]. The
/// gate renders spend 3.2-4.8 tokens per character of text (217-392 tokens for 55-86 chars),
/// so 7/char is ~1.5-2x the slowest measured pacing, and the 210-token base (30 frames,
/// 2.5 s) covers short lines and inline tags like `<laugh>`. Running into it catches the two
/// sampled failure modes of this model, both seen in the 4-bit gate renders: a runaway with no
/// EOS (robot description), and READING THE DESCRIPTION ALOUD before the text (~800+ tokens
/// for a 70-char line). Both are re-rolled ([`RUNAWAY_RETRIES`]) instead of played.
const BUDGET_BASE_TOKENS: usize = 210;
const BUDGET_TOKENS_PER_CHAR: usize = 7;
/// A render that ends without EOS (budget hit or frame loop) is retried this many extra times
/// with a re-salted seed: both failure modes are sampling events, and the same sentence
/// re-seeded ends cleanly.
const RUNAWAY_RETRIES: u64 = 1;
/// `min_new_tokens=28` in the reference: EOS is masked until 4 SNAC frames exist.
const MIN_NEW_TOKENS: usize = 28;
/// The card trims the first 2048 decoded samples (SNAC warm-up) before writing the wav.
const WARMUP_SAMPLES: usize = 2_048;
/// Reference sampling settings (card + vLLM script): temperature 0.4, top-p 0.9,
/// repetition penalty 1.1 ("prevent loops").
pub const MAYA1_TEMPERATURE: f32 = 0.4;
const TOP_P: f64 = 0.9;
const REPETITION_PENALTY: f64 = 1.1;
/// Degenerate-loop detector: a cycle of up to this many SNAC frames…
const LOOP_MAX_PERIOD_FRAMES: usize = 4;
/// …repeated back-to-back this many times with byte-identical codes. 8 cycles of the shortest
/// period is 0.68 s of *exactly* repeating codec frames, which a neural codec never produces
/// from real speech — not even from silence, which still carries dither.
const LOOP_CYCLES: usize = 8;

/// The description used when the user has not written one (an empty `tts.voice`). Phrased in
/// the card's own "realistic" template (`prompt.txt`: age / accent / pitch / timbre / pacing /
/// emotion + intensity), which is the shape the model was fine-tuned on.
pub const MAYA1_DEFAULT_DESCRIPTION: &str = "Realistic female voice in the 30s age with an american accent. Normal pitch, warm timbre, conversational pacing, neutral tone at medium intensity.";

#[derive(Debug)]
pub enum Maya1Error {
    Session(String),
    Tokenizer(String),
    Inference(String),
}

impl std::fmt::Display for Maya1Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Maya1Error::Session(m) => write!(f, "maya1 session: {m}"),
            Maya1Error::Tokenizer(m) => write!(f, "maya1 tokenizer: {m}"),
            Maya1Error::Inference(m) => write!(f, "maya1 inference: {m}"),
        }
    }
}
pub type Maya1Result<T> = Result<T, Maya1Error>;

/// Why the autoregressive loop stopped. Anything other than [`Maya1Stop::Eos`] means the
/// render is degraded and the caller must not present it as a normal result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Maya1Stop {
    /// Audio EOS — the model finished the utterance on its own.
    Eos,
    /// A byte-identical frame cycle was detected and cut back to a single copy. `frames` is
    /// the period in SNAC frames, `dropped` the number of tokens discarded.
    LoopCut { frames: usize, dropped: usize },
    /// Ran out of its token budget ([`token_budget`]) with no EOS and no detectable cycle.
    /// The tail is unreliable.
    Cap,
}

impl Maya1Stop {
    /// True when the utterance completed normally.
    pub fn is_clean(self) -> bool {
        matches!(self, Maya1Stop::Eos)
    }
}

/// A completed synthesis plus the decode telemetry needed to tell a good render from a runaway.
pub struct Maya1Synthesis {
    /// Mono f32 PCM @ [`MAYA1_SAMPLE_RATE`].
    pub samples: Vec<f32>,
    /// Why decoding stopped.
    pub stop: Maya1Stop,
    /// SNAC codes decoded (a multiple of 7).
    pub tokens: usize,
}

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

pub struct Maya1Engine {
    llm: Session,
    snac: Session,
    tokenizer: Tokenizer,
    past_names: Vec<String>,    // sorted `past_key_values.*`
    present_names: Vec<String>, // sorted `present.*` (index-aligned with past)
    kv_heads: usize,
    head_dim: usize,
    /// The KV cache dtype — f32 for the shipped CPU graphs; f16 graphs load too.
    kv_f16: bool,
    has_position_ids: bool,
}

impl Maya1Engine {
    pub fn load(llm_path: &Path, snac_path: &Path, tokenizer_path: &Path) -> Maya1Result<Self> {
        let llm = cpu_session(llm_path, "Maya1")?;
        let snac = cpu_session(snac_path, "Maya1 SNAC")?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            Maya1Error::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;

        let past_names = sorted_io(&llm, IoKind::Input, "past_key_values.");
        let present_names = sorted_io(&llm, IoKind::Output, "present.");
        if past_names.len() != present_names.len() || past_names.is_empty() {
            return Err(Maya1Error::Session(format!(
                "maya1 KV mismatch: {} past vs {} present",
                past_names.len(),
                present_names.len()
            )));
        }
        let (kv_heads, head_dim, kv_f16) = kv_shape(&llm, &past_names[0])?;
        let has_position_ids = llm.inputs().iter().any(|i| i.name() == "position_ids");

        Ok(Self {
            llm,
            snac,
            tokenizer,
            past_names,
            present_names,
            kv_heads,
            head_dim,
            kv_f16,
            has_position_ids,
        })
    }

    /// The exact prompt ids the reference feeds the model for `description` + `text`.
    pub fn prompt_ids(&self, description: &str, text: &str) -> Maya1Result<Vec<i64>> {
        let enc = self
            .tokenizer
            .encode(prompt_text(description, text), false)
            .map_err(|e| Maya1Error::Tokenizer(format!("encode: {e}")))?;
        let mut prompt: Vec<i64> = Vec::with_capacity(enc.get_ids().len() + 7);
        prompt.extend([BOS, SOH, BOS]);
        prompt.extend(enc.get_ids().iter().map(|&id| i64::from(id)));
        prompt.extend([EOT, EOH, SOA, SOS]);
        Ok(prompt)
    }

    /// Synthesize `text` in the voice `description` → mono f32 PCM @ 24 kHz. An empty
    /// description falls back to [`MAYA1_DEFAULT_DESCRIPTION`]. `temperature` <= 0 ⇒ greedy.
    ///
    /// The returned [`Maya1Synthesis::stop`] tells the caller whether the decode terminated
    /// normally; a non-[`Maya1Stop::Eos`] stop means the audio is salvaged from a runaway and
    /// should be reported rather than played back as if nothing happened.
    pub fn synthesize(
        &mut self,
        text: &str,
        description: &str,
        temperature: f32,
    ) -> Maya1Result<Maya1Synthesis> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Maya1Synthesis {
                samples: Vec::new(),
                stop: Maya1Stop::Eos,
                tokens: 0,
            });
        }
        let prompt = self.prompt_ids(description, text)?;
        let budget = token_budget(text);
        let mut attempt = 0;
        let (generated, stop) = loop {
            let seed = attempt_seed(&prompt, attempt);
            let out = self.decode(&prompt, temperature, budget, seed)?;
            // Greedy decoding is deterministic, so a re-seed would only repeat the runaway.
            if out.1.is_clean() || attempt == RUNAWAY_RETRIES || temperature <= 0.0 {
                break out;
            }
            log::warn!(
                "[tts] maya1 decode ended without EOS (stop={:?}, {} tokens); retrying re-seeded",
                out.1,
                out.0.len()
            );
            attempt += 1;
        };
        let keep = (generated.len() / FRAME_CODES) * FRAME_CODES;
        if keep == 0 {
            return Err(Maya1Error::Inference("no audio codes generated".into()));
        }
        let mut samples = self.snac_decode(&generated[..keep])?;
        if samples.len() > WARMUP_SAMPLES {
            samples.drain(..WARMUP_SAMPLES);
        }
        Ok(Maya1Synthesis {
            samples,
            stop,
            tokens: keep,
        })
    }

    /// Autoregressive KV-cache decode → the generated SNAC code ids (excludes the stop token)
    /// and the reason the loop ended.
    /// At most `budget` tokens are generated ([`token_budget`]).
    fn decode(
        &mut self,
        prompt: &[i64],
        temperature: f32,
        budget: usize,
        mut seed: u64,
    ) -> Maya1Result<(Vec<i64>, Maya1Stop)> {
        let mut past: Vec<Option<DynValue>> = (0..self.past_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.to_vec();
        let mut stop = Maya1Stop::Cap;
        let mut row: Vec<f64> = Vec::with_capacity(SNAC_BAND + 1);

        for step in 0..budget {
            let in_len = next_input.len();
            let attn_len = prompt.len() + step;
            let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + self.past_names.len());
            inputs.push((
                Cow::Borrowed("input_ids"),
                tensor_i64((1, in_len), std::mem::take(&mut next_input))?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                tensor_i64((1, attn_len), vec![1i64; attn_len])?,
            ));
            if self.has_position_ids {
                let pos: Vec<i64> = ((attn_len - in_len) as i64..attn_len as i64).collect();
                inputs.push((
                    Cow::Borrowed("position_ids"),
                    tensor_i64((1, pos.len()), pos)?,
                ));
            }
            for (i, name) in self.past_names.iter().enumerate() {
                // take ownership — past[i] is overwritten with `present` after the run.
                let v = match past[i].take() {
                    Some(v) => SessionInputValue::Owned(v),
                    None => empty_kv(self.kv_heads, self.head_dim, self.kv_f16)?,
                };
                inputs.push((Cow::Owned(name.clone()), v));
            }

            let mut outputs = self
                .llm
                .run(inputs)
                .map_err(|e| Maya1Error::Inference(format!("llm run: {e}")))?;

            band_logits(&outputs["logits"], &mut row)?;
            let next = match accept_next(&mut row, &mut generated, temperature, &mut seed) {
                Ok(next) => next,
                Err(done) => {
                    stop = done;
                    break;
                }
            };

            // Carry present.* → past.* by moving the session-owned values (no host copy of the
            // ever-growing cache, which at ~1k tokens is >200 MB per step).
            for (i, pname) in self.present_names.iter().enumerate() {
                past[i] = Some(
                    outputs
                        .remove(pname.as_str())
                        .ok_or_else(|| Maya1Error::Inference(format!("missing output {pname}")))?,
                );
            }
            next_input = vec![next];
        }
        Ok((generated, stop))
    }

    /// SNAC decode: redistribute 7-code frames → 3 hierarchical layers → waveform.
    fn snac_decode(&mut self, codes: &[i64]) -> Maya1Result<Vec<f32>> {
        let [l1, l2, l3] = unpack_frames(codes);
        let outputs = self
            .snac
            .run(ort::inputs! {
                "audio_codes.0" => tensor_val_i64((1, l1.len()), l1)?,
                "audio_codes.1" => tensor_val_i64((1, l2.len()), l2)?,
                "audio_codes.2" => tensor_val_i64((1, l3.len()), l3)?,
            })
            .map_err(|e| Maya1Error::Inference(format!("snac run: {e}")))?;
        let (_, audio) = outputs["audio_values"]
            .try_extract_tensor::<f32>()
            .map_err(|e| Maya1Error::Inference(format!("extract audio_values: {e}")))?;
        Ok(audio.to_vec())
    }
}

/// The text half of the prompt: the description rides in an XML-style attribute, so a `"`
/// inside it would close the attribute early — it is swapped for `'`. Whitespace (including
/// newlines from the multi-line editor) is collapsed. Empty → [`MAYA1_DEFAULT_DESCRIPTION`].
fn prompt_text(description: &str, text: &str) -> String {
    let desc = description
        .replace('"', "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let desc = if desc.is_empty() {
        MAYA1_DEFAULT_DESCRIPTION.to_string()
    } else {
        desc
    };
    format!("<description=\"{desc}\"> {text}")
}

/// Split a flat 7-codes-per-frame stream into SNAC's three layers (1 / 2 / 4 codes per frame).
/// Codes are reduced mod 4096 like the reference, so a code drawn in a neighbouring slot's
/// band still indexes the right codebook instead of going out of range.
fn unpack_frames(codes: &[i64]) -> [Vec<i64>; 3] {
    let frames = codes.len() / FRAME_CODES;
    let (mut l1, mut l2, mut l3) = (
        Vec::with_capacity(frames),
        Vec::with_capacity(2 * frames),
        Vec::with_capacity(4 * frames),
    );
    let code = |t: i64| (t - CODE_OFFSET).rem_euclid(SNAC_CODEBOOK);
    for f in codes.as_chunks::<FRAME_CODES>().0 {
        l1.push(code(f[0]));
        l2.push(code(f[1]));
        l3.push(code(f[2]));
        l3.push(code(f[3]));
        l2.push(code(f[4]));
        l3.push(code(f[5]));
        l3.push(code(f[6]));
    }
    [l1, l2, l3]
}

/// Copy the LAST position's logits for the allowed vocabulary — the SNAC band
/// (`CODE_OFFSET..CODE_OFFSET+SNAC_BAND`) followed by audio EOS — into `row` as f64. Everything
/// else is masked by construction (the reference's `OnlyAudioAfterSOS`), and drawing over 28k
/// ids instead of the full 157k vocabulary is also ~5x less sampling work.
fn band_logits(value: &DynValue, row: &mut Vec<f64>) -> Maya1Result<()> {
    row.clear();
    let start = CODE_OFFSET as usize;
    let eos = AUDIO_EOS as usize;
    if let Ok((shape, data)) = value.try_extract_tensor::<f32>() {
        let vocab = *shape.last().unwrap_or(&0) as usize;
        let last = last_row(data, vocab)?;
        row.extend(last[start..start + SNAC_BAND].iter().map(|&v| f64::from(v)));
        row.push(f64::from(last[eos]));
    } else {
        let (shape, data) = value
            .try_extract_tensor::<f16>()
            .map_err(|e| Maya1Error::Inference(format!("extract logits: {e}")))?;
        let vocab = *shape.last().unwrap_or(&0) as usize;
        let last = last_row(data, vocab)?;
        row.extend(
            last[start..start + SNAC_BAND]
                .iter()
                .map(|v| f64::from(v.to_f32())),
        );
        row.push(f64::from(last[eos].to_f32()));
    }
    Ok(())
}

fn last_row<T>(data: &[T], vocab: usize) -> Maya1Result<&[T]> {
    if vocab <= CODE_OFFSET as usize + SNAC_BAND || data.len() < vocab {
        return Err(Maya1Error::Inference(format!(
            "logits vocab {vocab} does not cover the SNAC band"
        )));
    }
    Ok(&data[data.len() - vocab..])
}

/// Index of `id` inside the band row built by [`band_logits`].
fn band_index(id: i64) -> Option<usize> {
    if id == AUDIO_EOS {
        return Some(SNAC_BAND);
    }
    let rel = id - CODE_OFFSET;
    (0..SNAC_BAND as i64).contains(&rel).then_some(rel as usize)
}

/// Inverse of [`band_index`].
fn band_token(idx: usize) -> i64 {
    if idx == SNAC_BAND {
        AUDIO_EOS
    } else {
        CODE_OFFSET + idx as i64
    }
}

/// Draw the next token from the band row and append it, or say why decoding is over:
/// audio EOS, or a byte-identical frame cycle (cut back to one copy — the safety net for draws
/// the repetition penalty does not rescue, instead of grinding out ~30 s of buzz to the cap).
fn accept_next(
    row: &mut [f64],
    generated: &mut Vec<i64>,
    temperature: f32,
    seed: &mut u64,
) -> Result<i64, Maya1Stop> {
    let next = pick_next(row, generated, temperature, seed);
    if next == AUDIO_EOS {
        return Err(Maya1Stop::Eos);
    }
    generated.push(next);
    if let Some(cycle) = loop_cycle(generated) {
        generated.truncate(generated.len() - cycle.dropped);
        return Err(Maya1Stop::LoopCut {
            frames: cycle.period_frames,
            dropped: cycle.dropped,
        });
    }
    Ok(next)
}

/// HF-order logits processing over the band row, then the draw: `min_new_tokens` (EOS
/// masked) → repetition penalty over the generated codes → temperature → top-p.
fn pick_next(row: &mut [f64], generated: &[i64], temperature: f32, seed: &mut u64) -> i64 {
    if generated.len() < MIN_NEW_TOKENS {
        row[SNAC_BAND] = f64::NEG_INFINITY;
    }
    let band_ids: Vec<i64> = generated
        .iter()
        .filter_map(|&t| band_index(t).map(|i| i as i64))
        .collect();
    super::sampling::apply_repetition_penalty(row, &band_ids, REPETITION_PENALTY);
    band_token(sample(row, temperature, TOP_P, seed))
}

fn empty_kv(
    heads: usize,
    head_dim: usize,
    f16_kv: bool,
) -> Maya1Result<SessionInputValue<'static>> {
    let shape = (1, heads, 0, head_dim);
    let err = |e: &dyn std::fmt::Display| Maya1Error::Inference(format!("empty kv: {e}"));
    if f16_kv {
        let arr = Array4::<f16>::from_shape_vec(shape, Vec::new()).map_err(|e| err(&e))?;
        Ok(SessionInputValue::from(
            Tensor::from_array(arr).map_err(|e| err(&e))?,
        ))
    } else {
        let arr = Array4::<f32>::from_shape_vec(shape, Vec::new()).map_err(|e| err(&e))?;
        Ok(SessionInputValue::from(
            Tensor::from_array(arr).map_err(|e| err(&e))?,
        ))
    }
}

/// A degenerate cycle found at the tail of the generated stream.
struct LoopCycle {
    /// Cycle length in SNAC frames (1..=[`LOOP_MAX_PERIOD_FRAMES`]).
    period_frames: usize,
    /// Tokens to drop so exactly one copy of the cycle survives.
    dropped: usize,
}

/// Detect a byte-identical frame cycle at the tail of `stream`: a period of 1..=
/// [`LOOP_MAX_PERIOD_FRAMES`] frames repeated [`LOOP_CYCLES`] times back-to-back.
///
/// Deliberately NOT the `no_repeat_ngram` ban the Whisper decoder uses
/// (`stt/whisper/token_select.rs`). Banning a repeated n-gram outright is right for *text*,
/// where a repeated trigram is nearly always a loop; SNAC codes repeat constantly during
/// sustained phonemes and silence, so a hard ban would distort ordinary speech. This only
/// looks for the pathological case — many exact cycles in a row — and cuts rather than bans.
fn loop_cycle(stream: &[i64]) -> Option<LoopCycle> {
    for period_frames in 1..=LOOP_MAX_PERIOD_FRAMES {
        let period = period_frames * FRAME_CODES;
        let span = period * LOOP_CYCLES;
        if stream.len() < span {
            continue;
        }
        let tail = &stream[stream.len() - span..];
        if tail.chunks_exact(period).all(|c| c == &tail[..period]) {
            return Some(LoopCycle {
                period_frames,
                dropped: span - period,
            });
        }
    }
    None
}

// ── ORT helpers (mirror qwen3_tts / chatterbox idioms) ─────────────────────────────

fn cpu_session(path: &Path, engine: &str) -> Maya1Result<Session> {
    super::provider::cpu_session(path, "Maya1 is a CPU-pinned LLM-class engine", engine)
        .map_err(Maya1Error::Session)
}

fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> Maya1Result<SessionInputValue<'static>> {
    Ok(SessionInputValue::from(tensor_val_i64(shape, data)?))
}

fn tensor_val_i64(shape: (usize, usize), data: Vec<i64>) -> Maya1Result<Tensor<i64>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| Maya1Error::Inference(format!("i64 arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| Maya1Error::Inference(format!("i64 tensor: {e}")))
}

enum IoKind {
    Input,
    Output,
}

fn sorted_io(sess: &Session, kind: IoKind, prefix: &str) -> Vec<String> {
    let mut names: Vec<String> = match kind {
        IoKind::Input => sess.inputs().iter().map(|i| i.name().to_string()).collect(),
        IoKind::Output => sess
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .collect(),
    };
    names.retain(|n| n.starts_with(prefix));
    // Numeric layer order (`past_key_values.10.*` after `.9.*`); past/present stay
    // index-aligned either way, but numeric order keeps logs readable.
    names.sort_by_key(|n| {
        let mut parts = n.split('.');
        let layer = parts
            .nth(1)
            .and_then(|p| p.parse::<usize>().ok())
            .unwrap_or(0);
        (layer, n.clone())
    });
    names
}

/// `(kv_heads, head_dim, is_f16)` of a `past_key_values.*` input.
fn kv_shape(sess: &Session, name: &str) -> Maya1Result<(usize, usize, bool)> {
    let inp = sess
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .ok_or_else(|| Maya1Error::Session(format!("missing kv input {name}")))?;
    let shape = inp.dtype().tensor_shape();
    // shape (batch, kv_heads, seq, head_dim); dims 1 and 3 are static.
    let heads = shape
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .unwrap_or(8) as usize;
    let hd = shape
        .and_then(|s| s.get(3).copied())
        .filter(|&d| d > 0)
        .unwrap_or(128) as usize;
    let is_f16 = inp.dtype().tensor_type() == Some(TensorElementType::Float16);
    Ok((heads, hd, is_f16))
}

// ── sampling (self-contained: temperature + top-p + xorshift rng) ──────────────────

fn fnv1a_seed(prompt: &[i64]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &t in prompt {
        h ^= t as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h | 1
}

/// The sampler seed for one attempt: attempt 0 is the plain prompt hash (deterministic per
/// sentence + description), each retry salts it with a golden-ratio step. Never zero, which
/// would freeze the xorshift generator.
fn attempt_seed(prompt: &[i64], attempt: u64) -> u64 {
    (fnv1a_seed(prompt) ^ attempt.wrapping_mul(0x9e37_79b9_7f4a_7c15)) | 1
}

/// Token budget for one sentence ([`BUDGET_BASE_TOKENS`] + [`BUDGET_TOKENS_PER_CHAR`] per
/// character, capped at [`MAX_NEW_TOKENS`]).
fn token_budget(text: &str) -> usize {
    (BUDGET_BASE_TOKENS + text.chars().count() * BUDGET_TOKENS_PER_CHAR).min(MAX_NEW_TOKENS)
}

fn next_rand(seed: &mut u64) -> f64 {
    let mut x = *seed;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *seed = x;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// temperature → top-p → categorical draw over an f64 logit row; returns the row INDEX.
///
/// Takes f64 so [`super::sampling::apply_repetition_penalty`] — the shared HF-formula helper,
/// already used by the Qwen3-TTS talker — composes directly onto the row. Kept local rather
/// than delegating to `sampling::sample` for the same reason `neutts.rs` does: there is no
/// top-k stage, so the extra full-row sort that helper performs is pure cost here.
fn sample(logits: &[f64], temperature: f32, top_p: f64, seed: &mut u64) -> usize {
    if temperature <= 0.0 {
        let mut best = 0usize;
        for (i, &v) in logits.iter().enumerate() {
            if v > logits[best] {
                best = i;
            }
        }
        return best;
    }
    let t = f64::from(temperature);
    let maxv = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut probs: Vec<(usize, f64)> = logits
        .iter()
        .enumerate()
        .map(|(i, &v)| (i, ((v - maxv) / t).exp()))
        .filter(|(_, p)| *p > 0.0)
        .collect();
    let sum: f64 = probs.iter().map(|(_, p)| p).sum();
    for p in &mut probs {
        p.1 /= sum;
    }
    probs.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
    // nucleus: keep the smallest prefix whose mass >= top_p
    let mut cum = 0.0;
    let mut cut = probs.len();
    for (i, (_, p)) in probs.iter().enumerate() {
        cum += p;
        if cum >= top_p {
            cut = i + 1;
            break;
        }
    }
    probs.truncate(cut.max(1));
    let renorm: f64 = probs.iter().map(|(_, p)| p).sum();
    let r = next_rand(seed) * renorm;
    let mut acc = 0.0;
    for (idx, p) in &probs {
        acc += p;
        if r <= acc {
            return *idx;
        }
    }
    probs[0].0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One frame of plausible codes, offset into the audio-token band.
    fn frame(n: i64) -> Vec<i64> {
        (0..FRAME_CODES as i64)
            .map(|i| CODE_OFFSET + i * SNAC_CODEBOOK + n)
            .collect()
    }

    #[test]
    fn snac_band_matches_the_card() {
        // SNAC_MIN_ID 128266 / SNAC_MAX_ID 156937 in the reference.
        assert_eq!(CODE_OFFSET + SNAC_BAND as i64 - 1, 156_937);
        assert_eq!(band_index(CODE_OFFSET), Some(0));
        assert_eq!(band_index(156_937), Some(SNAC_BAND - 1));
        assert_eq!(band_index(AUDIO_EOS), Some(SNAC_BAND));
        assert_eq!(band_index(156_938), None);
        assert_eq!(band_index(SOS), None);
        for idx in [0, 17, SNAC_BAND - 1, SNAC_BAND] {
            assert_eq!(band_index(band_token(idx)), Some(idx));
        }
    }

    #[test]
    fn prompt_text_wraps_the_description_like_the_reference() {
        assert_eq!(
            prompt_text("Male, 40s, warm", "Hello <laugh> there"),
            "<description=\"Male, 40s, warm\"> Hello <laugh> there"
        );
        // A quote would close the attribute early; newlines from the editor collapse.
        assert_eq!(
            prompt_text("A \"booming\"\n  voice", "Hi"),
            "<description=\"A 'booming' voice\"> Hi"
        );
        assert_eq!(
            prompt_text("   ", "Hi"),
            format!("<description=\"{MAYA1_DEFAULT_DESCRIPTION}\"> Hi")
        );
    }

    #[test]
    fn unpack_matches_the_reference_layout() {
        // Slot order: L1 ← 0; L2 ← 1, 4; L3 ← 2, 3, 5, 6 — each reduced mod 4096.
        let f: Vec<i64> = (0..7)
            .map(|i| CODE_OFFSET + i * SNAC_CODEBOOK + 10 + i)
            .collect();
        let [l1, l2, l3] = unpack_frames(&f);
        assert_eq!(l1, vec![10]);
        assert_eq!(l2, vec![11, 14]);
        assert_eq!(l3, vec![12, 13, 15, 16]);
        // A code drawn in the wrong slot's band still lands inside the codebook.
        let mut g = f;
        g[0] = CODE_OFFSET + 3 * SNAC_CODEBOOK + 5;
        assert_eq!(unpack_frames(&g)[0], vec![5]);
    }

    #[test]
    fn eos_is_masked_until_min_new_tokens() {
        let mut row = vec![0.0_f64; SNAC_BAND + 1];
        row[SNAC_BAND] = 100.0; // EOS overwhelmingly likely…
        let early: Vec<i64> = frame(1);
        assert_ne!(pick_next(&mut row.clone(), &early, 0.0, &mut 1), AUDIO_EOS);
        let enough: Vec<i64> = (0..4).flat_map(frame).collect();
        assert_eq!(enough.len(), MIN_NEW_TOKENS);
        assert_eq!(pick_next(&mut row, &enough, 0.0, &mut 1), AUDIO_EOS);
    }

    #[test]
    fn repetition_penalty_pushes_repeated_codes_down() {
        let mut row = vec![0.0_f64; SNAC_BAND + 1];
        row[3] = 5.0;
        row[4] = 4.9;
        let fresh: Vec<i64> = (0..4).flat_map(|n| frame(100 + n)).collect();
        assert_eq!(
            pick_next(&mut row.clone(), &fresh, 0.0, &mut 1),
            CODE_OFFSET + 3
        );
        let mut seen = fresh;
        seen.push(CODE_OFFSET + 3);
        assert_eq!(
            pick_next(&mut row, &seen, 0.0, &mut 1),
            CODE_OFFSET + 4,
            "penalty did not demote the repeated code"
        );
    }

    #[test]
    fn loop_cycle_catches_a_repeating_single_frame() {
        let mut stream: Vec<i64> = frame(1).into_iter().chain(frame(2)).collect();
        for _ in 0..LOOP_CYCLES {
            stream.extend(frame(9));
        }
        let cut = loop_cycle(&stream).expect("single-frame cycle detected");
        assert_eq!(cut.period_frames, 1);
        // Everything but ONE copy of the cycle is dropped.
        assert_eq!(cut.dropped, (LOOP_CYCLES - 1) * FRAME_CODES);
        assert_eq!(stream.len() - cut.dropped, 3 * FRAME_CODES);
    }

    #[test]
    fn loop_cycle_catches_a_multi_frame_cycle() {
        let cycle: Vec<i64> = frame(4).into_iter().chain(frame(5)).collect();
        let mut stream = frame(1);
        for _ in 0..LOOP_CYCLES {
            stream.extend(cycle.iter().copied());
        }
        let cut = loop_cycle(&stream).expect("two-frame cycle detected");
        assert_eq!(cut.period_frames, 2);
        assert_eq!(cut.dropped, (LOOP_CYCLES - 1) * 2 * FRAME_CODES);
    }

    #[test]
    fn loop_cycle_ignores_ordinary_speech() {
        // Varying frames, and a short repeat well under LOOP_CYCLES, must NOT fire — sustained
        // phonemes legitimately repeat codes and cutting them would clip real speech.
        let mut stream = Vec::new();
        for n in 0..80 {
            stream.extend(frame(n % 13));
        }
        assert!(loop_cycle(&stream).is_none());

        let mut brief = frame(1);
        for _ in 0..(LOOP_CYCLES - 1) {
            brief.extend(frame(7));
        }
        assert!(loop_cycle(&brief).is_none(), "cut fired below LOOP_CYCLES");
        assert!(loop_cycle(&[]).is_none());
    }

    #[test]
    fn stop_reasons_report_cleanliness() {
        assert!(Maya1Stop::Eos.is_clean());
        assert!(!Maya1Stop::Cap.is_clean());
        assert!(
            !Maya1Stop::LoopCut {
                frames: 1,
                dropped: 49
            }
            .is_clean()
        );
    }

    #[test]
    fn token_budget_scales_with_text_and_is_capped() {
        // The gate's longest clean render (392 tokens, 75 chars) sits far inside its budget.
        let gate = "Speech recognition turns your voice into text while you keep your hands free.";
        assert!(token_budget(gate) > 392 * 3 / 2);
        // …while the description-read-aloud failure (819 tokens for a 70-char line) is not.
        assert!(token_budget(&"x".repeat(70)) < 819);
        assert_eq!(token_budget(""), BUDGET_BASE_TOKENS);
        assert_eq!(token_budget(&"a".repeat(10_000)), MAX_NEW_TOKENS);
    }

    #[test]
    fn retry_seeds_differ_and_are_never_zero() {
        let prompt = [BOS, SOH, BOS, 42, EOT, EOH, SOA, SOS];
        assert_eq!(attempt_seed(&prompt, 0), fnv1a_seed(&prompt));
        assert_ne!(attempt_seed(&prompt, 0), attempt_seed(&prompt, 1));
        assert_ne!(attempt_seed(&prompt, 1) & 1, 0);
    }
}

#[cfg(test)]
mod smoke {
    use super::*;
    use std::path::PathBuf;

    /// Root of a downloaded `Masterx/maya1-ONNX` snapshot plus the SNAC decoder, laid out like
    /// the app's cache dir (`onnx/`, `snac/decoder_model.onnx`, `tokenizer.json`). Override
    /// with `MAYA1_DIR` (required).
    fn base() -> PathBuf {
        std::env::var_os("MAYA1_DIR")
            .map(PathBuf::from)
            .expect("set MAYA1_DIR to a Masterx/maya1-ONNX snapshot laid out like the app cache")
    }

    // Loads the published ONNX and synthesizes through the real engine → writes wavs that the
    // export's WER harness transcribes (`MAYA1_GRAPH` picks the rung, default `model_q8`).
    #[test]
    #[ignore]
    fn maya1_synthesizes_audio() {
        let base = base();
        let graph = std::env::var("MAYA1_GRAPH").unwrap_or_else(|_| "model_q8".into());
        let mut eng = Maya1Engine::load(
            &base.join(format!("onnx/{graph}.onnx")),
            &base.join("snac/decoder_model.onnx"),
            &base.join("tokenizer.json"),
        )
        .expect("load");
        println!("MAYA1_RUST graph={graph}");
        let lines: Vec<(String, String)> = std::fs::read_to_string(base.join("rust_cases.tsv"))
            .map_or_else(
                |_| {
                    vec![(
                        String::new(),
                        "Hey there, this is Maya running through the native Rust engine.".into(),
                    )]
                },
                |s| {
                    s.lines()
                        .filter_map(|l| l.split_once('\t'))
                        .map(|(d, t)| (d.to_string(), t.to_string()))
                        .collect()
                },
            );
        let out_dir = base.join(format!("rust_out_{graph}_cpu"));
        std::fs::create_dir_all(&out_dir).unwrap();
        let (mut audio_secs, mut wall_secs) = (0.0f64, 0.0f64);
        for (i, (desc, text)) in lines.iter().enumerate() {
            let t0 = std::time::Instant::now();
            let out = eng
                .synthesize(text, desc, MAYA1_TEMPERATURE)
                .expect("synthesize");
            let wall = t0.elapsed().as_secs_f64();
            let pcm = out.samples;
            let secs = pcm.len() as f64 / f64::from(MAYA1_SAMPLE_RATE);
            let rms = (pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
            println!(
                "MAYA1_RUST case={i} stop={:?} tokens={} dur={secs:.2}s wall={wall:.2}s rtf={:.2} rms={rms:.4}",
                out.stop,
                out.tokens,
                wall / secs.max(1e-6)
            );
            audio_secs += secs;
            wall_secs += wall;
            write_wav(
                &out_dir.join(format!("{i:02}.wav")),
                &pcm,
                MAYA1_SAMPLE_RATE,
            );
            assert!(out.stop.is_clean(), "decode ran away: {:?}", out.stop);
            assert!(pcm.len() > MAYA1_SAMPLE_RATE as usize / 2, "too short");
            assert!(rms > 0.005, "silent");
        }
        println!(
            "MAYA1_RUST total audio={audio_secs:.1}s wall={wall_secs:.1}s rtf={:.2}",
            wall_secs / audio_secs.max(1e-6)
        );
    }

    fn write_wav(path: &std::path::Path, pcm: &[f32], sr: u32) {
        let mut b = Vec::new();
        let n = pcm.len() as u32;
        let byte_rate = sr * 2;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + n * 2).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(n * 2).to_le_bytes());
        for &s in pcm {
            b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }
}
