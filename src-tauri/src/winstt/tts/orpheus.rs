// Orpheus TTS (canopylabs/orpheus-3b-0.1-ft) — LLM → SNAC neural codec → 24 kHz audio.
//
// Pipeline (verified end-to-end in Python against onnx-community/orpheus-3b-0.1-ft-ONNX +
// onnx-community/snac_24khz-ONNX before this port):
//   prompt   = [128259] ++ tok("{voice}: {text}") ++ [128009, 128260]
//   decode   = merged Llama decoder w/ KV cache (28 layers, 8 KV heads, head_dim 128, NO position_ids);
//              repetition penalty + temperature+top-p sampling until 128258 (audio EOS) or 128001
//   parse    = crop after last 128257, drop 128258, trim to *7, subtract 128266
//   codec    = redistribute 7 codes/frame → SNAC's 3 hierarchical layers; SNAC decode → waveform
//
// CPU-pinned like the other LLM-class engines (the 3B decoder's attention is a DirectML-crash risk;
// mirrors qwen3_tts / cohere). SNAC is tiny and also runs CPU.

use std::borrow::Cow;
use std::path::Path;

use ndarray::{Array2, Array4, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

pub const ORPHEUS_SAMPLE_RATE: u32 = 24_000;

// Canonical Orpheus control tokens (canopylabs/orpheus-3b-0.1-ft).
const SOH: i64 = 128_259; // start of human turn
const EOT: i64 = 128_009; // end of text
const EOH: i64 = 128_260; // end of human turn
const AUDIO_START: i64 = 128_257; // start-of-audio marker (parse anchor)
const AUDIO_EOS: i64 = 128_258; // audio end / pad (dropped)
const TEXT_EOS: i64 = 128_001; // llama eos
const CODE_OFFSET: i64 = 128_266; // audio-token id → codec code
const SNAC_CODEBOOK: i64 = 4_096; // per-codebook stride in the redistribution
/// Hard decode ceiling. SNAC emits 2,043 samples per 7-code frame, so at 24 kHz one frame is
/// 85.1 ms and 2,800 tokens = 400 frames = **34.05 s** — not the ~28 s an earlier comment here
/// claimed. Reaching it is always a failure: the longest single sentence the app feeds this
/// engine renders in well under 15 s.
const MAX_NEW_TOKENS: usize = 2_800;
/// Samples SNAC's decoder emits per 7-code frame (measured; the transposed-conv stack lands
/// just shy of the nominal 2,048). Nothing at runtime needs it — it exists so the ceiling
/// claimed above is an assertion rather than a comment that can rot again.
#[cfg(test)]
const SAMPLES_PER_FRAME: usize = 2_043;
const FRAME_CODES: usize = 7;
const TOP_P: f64 = 0.9;
/// Upstream (canopyai/Orpheus-TTS) states flatly: "`repetition_penalty>=1.1` is required for
/// stable generations." Without it this decoder falls into degenerate frame loops that never
/// emit AUDIO_EOS and run to [`MAX_NEW_TOKENS`] — reproducible per (text, voice) because the
/// sampler is seeded from the prompt. Applied HF-style over the tokens generated so far.
const REPETITION_PENALTY: f64 = 1.1;
/// Degenerate-loop detector: a cycle of up to this many SNAC frames…
const LOOP_MAX_PERIOD_FRAMES: usize = 4;
/// …repeated back-to-back this many times with byte-identical codes. 8 cycles of the shortest
/// period is 0.68 s of *exactly* repeating codec frames, which a neural codec never produces
/// from real speech — not even from silence, which still carries dither.
const LOOP_CYCLES: usize = 8;

/// The eight fine-tuned Orpheus voices (canopylabs card). `tara` is the default/best.
pub const ORPHEUS_VOICES: &[&str] = &["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"];

#[derive(Debug)]
pub enum OrpheusError {
    Session(String),
    Tokenizer(String),
    Inference(String),
}

impl std::fmt::Display for OrpheusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrpheusError::Session(m) => write!(f, "orpheus session: {m}"),
            OrpheusError::Tokenizer(m) => write!(f, "orpheus tokenizer: {m}"),
            OrpheusError::Inference(m) => write!(f, "orpheus inference: {m}"),
        }
    }
}
pub type OrpheusResult<T> = Result<T, OrpheusError>;

/// Why the autoregressive loop stopped. Anything other than [`OrpheusStop::Eos`] means the
/// render is degraded and the caller must not present it as a normal result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrpheusStop {
    /// AUDIO_EOS / TEXT_EOS — the model finished the utterance on its own.
    Eos,
    /// A byte-identical frame cycle was detected and cut back to a single copy. `frames` is
    /// the period in SNAC frames, `dropped` the number of tokens discarded.
    LoopCut { frames: usize, dropped: usize },
    /// Ran to [`MAX_NEW_TOKENS`] with no EOS and no detectable cycle. The tail is unreliable.
    Cap,
}

impl OrpheusStop {
    /// True when the utterance completed normally.
    pub fn is_clean(self) -> bool {
        matches!(self, OrpheusStop::Eos)
    }
}

/// A completed synthesis plus the decode telemetry needed to tell a good render from a runaway.
pub struct OrpheusSynthesis {
    /// Mono f32 PCM @ [`ORPHEUS_SAMPLE_RATE`].
    pub samples: Vec<f32>,
    /// Why decoding stopped.
    pub stop: OrpheusStop,
    /// Tokens kept after any loop cut (i.e. what SNAC actually decoded).
    pub tokens: usize,
}

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

pub struct OrpheusEngine {
    llm: Session,
    snac: Session,
    tokenizer: Tokenizer,
    past_names: Vec<String>,    // sorted `past_key_values.*`
    present_names: Vec<String>, // sorted `present.*` (index-aligned with past)
    kv_heads: usize,
    head_dim: usize,
    has_position_ids: bool,
    repetition_penalty: f64,
}

impl OrpheusEngine {
    pub fn load(llm_path: &Path, snac_path: &Path, tokenizer_path: &Path) -> OrpheusResult<Self> {
        let llm = cpu_session(llm_path, "Orpheus")?;
        let snac = cpu_session(snac_path, "Orpheus SNAC")?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            OrpheusError::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;

        let past_names = sorted_io(&llm, IoKind::Input, "past_key_values.");
        let present_names = sorted_io(&llm, IoKind::Output, "present.");
        if past_names.len() != present_names.len() || past_names.is_empty() {
            return Err(OrpheusError::Session(format!(
                "orpheus KV mismatch: {} past vs {} present",
                past_names.len(),
                present_names.len()
            )));
        }
        let (kv_heads, head_dim) = kv_shape(&llm, &past_names[0])?;
        let has_position_ids = llm.inputs().iter().any(|i| i.name() == "position_ids");

        Ok(Self {
            llm,
            snac,
            tokenizer,
            past_names,
            present_names,
            kv_heads,
            head_dim,
            has_position_ids,
            repetition_penalty: REPETITION_PENALTY,
        })
    }

    /// Override the decode repetition penalty. Exists so `examples/orpheus_loop_probe.rs` can
    /// measure the penalty-off arm that motivated [`REPETITION_PENALTY`]; production never
    /// calls it, and `1.0` (off) is exactly the configuration upstream warns against.
    pub fn set_repetition_penalty(&mut self, penalty: f64) {
        self.repetition_penalty = penalty;
    }

    /// Synthesize `text` in `voice` → mono f32 PCM @ 24 kHz. `temperature` <= 0 ⇒ greedy.
    ///
    /// Do NOT decode this model greedily: on the shipped q4 graph the argmax path is 3 frames
    /// of digital silence followed by EOS, for every voice and either repetition penalty
    /// (measured, `examples/orpheus_loop_probe.rs` with `ORPHEUS_PROBE_TEMP=0`). The greedy
    /// branch is kept because it is the honest reading of `temperature <= 0`, not because it
    /// is usable here; production passes 0.6.
    ///
    /// The returned [`OrpheusSynthesis::stop`] tells the caller whether the decode terminated
    /// normally; a non-[`OrpheusStop::Eos`] stop means the audio is salvaged from a runaway and
    /// should be reported rather than played back as if nothing happened.
    pub fn synthesize(
        &mut self,
        text: &str,
        voice: &str,
        temperature: f32,
    ) -> OrpheusResult<OrpheusSynthesis> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(OrpheusSynthesis {
                samples: Vec::new(),
                stop: OrpheusStop::Eos,
                tokens: 0,
            });
        }
        let voice = if ORPHEUS_VOICES.contains(&voice) {
            voice
        } else {
            "tara"
        };

        let enc = self
            .tokenizer
            .encode(format!("{voice}: {text}"), false)
            .map_err(|e| OrpheusError::Tokenizer(format!("encode: {e}")))?;
        let mut prompt: Vec<i64> = Vec::with_capacity(enc.get_ids().len() + 3);
        prompt.push(SOH);
        prompt.extend(enc.get_ids().iter().map(|&id| id as i64));
        prompt.push(EOT);
        prompt.push(EOH);

        let (generated, stop) = self.decode(&prompt, temperature)?;
        let codes = parse_codes(&generated);
        if codes.is_empty() {
            return Err(OrpheusError::Inference("no audio codes generated".into()));
        }
        let samples = self.snac_decode(&codes)?;
        Ok(OrpheusSynthesis {
            samples,
            stop,
            tokens: codes.len(),
        })
    }

    /// Autoregressive KV-cache decode → the raw generated token stream (excludes the stop token)
    /// and the reason the loop ended.
    fn decode(
        &mut self,
        prompt: &[i64],
        temperature: f32,
    ) -> OrpheusResult<(Vec<i64>, OrpheusStop)> {
        let mut past: Vec<Option<Tensor<f32>>> = (0..self.past_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.to_vec();
        let mut seed = fnv1a_seed(prompt);
        let mut stop = OrpheusStop::Cap;

        for step in 0..MAX_NEW_TOKENS {
            let in_len = next_input.len();
            let attn_len = prompt.len() + step;
            let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + self.past_names.len());
            inputs.push((
                Cow::Borrowed("input_ids"),
                tensor_i64((1, in_len), next_input.clone())?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                tensor_i64((1, attn_len), vec![1i64; attn_len])?,
            ));
            if self.has_position_ids {
                let pos: Vec<i64> = if step == 0 {
                    (0..in_len as i64).collect()
                } else {
                    vec![(attn_len - 1) as i64]
                };
                inputs.push((
                    Cow::Borrowed("position_ids"),
                    tensor_i64((1, pos.len()), pos)?,
                ));
            }
            for (i, name) in self.past_names.iter().enumerate() {
                // take ownership — past[i] is overwritten with `present` after the run.
                let t = match past[i].take() {
                    Some(v) => v,
                    None => empty_kv(self.kv_heads, self.head_dim)?,
                };
                inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
            }

            let outputs = self
                .llm
                .run(inputs)
                .map_err(|e| OrpheusError::Inference(format!("llm run: {e}")))?;

            let logits = out_f32_named(&outputs, "logits")?; // [1, T, V]
            let vocab = *logits.shape().last().unwrap();
            let last = &logits.as_slice().unwrap()[(logits.len() - vocab)..];
            // Penalize before sampling, mirroring HF's RepetitionPenaltyLogitsProcessor. Only
            // `generated` is fed in, not the prompt: the prompt is text tokens, which live in a
            // disjoint id band from the audio codes this loop can draw, so penalizing them
            // (as vLLM does) is a measured no-op here.
            let mut row: Vec<f64> = last.iter().map(|&v| f64::from(v)).collect();
            super::sampling::apply_repetition_penalty(
                &mut row,
                &generated,
                self.repetition_penalty,
            );
            let next = sample(&row, temperature, TOP_P, &mut seed);
            if next == AUDIO_EOS || next == TEXT_EOS {
                stop = OrpheusStop::Eos;
                break;
            }
            generated.push(next);

            // Safety net for draws the penalty does not rescue: cut a byte-identical frame
            // cycle back to one copy instead of grinding out ~30 s of buzz to the cap.
            if let Some(cycle) = loop_cycle(&generated) {
                let dropped = cycle.dropped;
                generated.truncate(generated.len() - dropped);
                stop = OrpheusStop::LoopCut {
                    frames: cycle.period_frames,
                    dropped,
                };
                break;
            }

            for (i, pname) in self.present_names.iter().enumerate() {
                let (shape, data) = outputs[pname.as_str()]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| OrpheusError::Inference(format!("extract {pname}: {e}")))?;
                past[i] = Some(
                    Tensor::from_array((shape.to_vec(), data.to_vec()))
                        .map_err(|e| OrpheusError::Inference(format!("kv tensor: {e}")))?,
                );
            }
            next_input = vec![next];
        }
        Ok((generated, stop))
    }

    /// SNAC decode: redistribute 7-code frames → 3 hierarchical layers → waveform.
    fn snac_decode(&mut self, codes: &[i64]) -> OrpheusResult<Vec<f32>> {
        let frames = codes.len() / 7;
        let (mut l1, mut l2, mut l3) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..frames {
            let f = &codes[7 * i..7 * i + 7];
            l1.push(f[0]);
            l2.push(f[1] - SNAC_CODEBOOK);
            l3.push(f[2] - 2 * SNAC_CODEBOOK);
            l3.push(f[3] - 3 * SNAC_CODEBOOK);
            l2.push(f[4] - 4 * SNAC_CODEBOOK);
            l3.push(f[5] - 5 * SNAC_CODEBOOK);
            l3.push(f[6] - 6 * SNAC_CODEBOOK);
        }
        let outputs = self
            .snac
            .run(ort::inputs! {
                "audio_codes.0" => tensor_val_i64((1, l1.len()), l1)?,
                "audio_codes.1" => tensor_val_i64((1, l2.len()), l2)?,
                "audio_codes.2" => tensor_val_i64((1, l3.len()), l3)?,
            })
            .map_err(|e| OrpheusError::Inference(format!("snac run: {e}")))?;
        let audio = out_f32_named(&outputs, "audio_values")?; // [1,1,L]
        Ok(audio.iter().copied().collect())
    }
}

fn empty_kv(heads: usize, head_dim: usize) -> OrpheusResult<Tensor<f32>> {
    let arr = Array4::<f32>::from_shape_vec((1, heads, 0, head_dim), Vec::new())
        .map_err(|e| OrpheusError::Inference(format!("empty kv arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| OrpheusError::Inference(format!("empty kv tensor: {e}")))
}

/// A degenerate cycle found at the tail of the generated stream.
pub struct LoopCycle {
    /// Cycle length in SNAC frames (1..=[`LOOP_MAX_PERIOD_FRAMES`]).
    pub period_frames: usize,
    /// Tokens to drop so exactly one copy of the cycle survives.
    pub dropped: usize,
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

/// Parse the generated stream into the flat SNAC code list.
fn parse_codes(generated: &[i64]) -> Vec<i64> {
    let start = generated.iter().rposition(|&t| t == AUDIO_START);
    let slice = match start {
        Some(idx) => &generated[idx + 1..],
        None => generated,
    };
    let mut codes: Vec<i64> = slice.iter().copied().filter(|&t| t != AUDIO_EOS).collect();
    let keep = (codes.len() / 7) * 7;
    codes.truncate(keep);
    for c in &mut codes {
        *c -= CODE_OFFSET;
    }
    codes
}

// ── ORT helpers (mirror qwen3_tts / chatterbox idioms) ─────────────────────────────

fn cpu_session(path: &Path, engine: &str) -> OrpheusResult<Session> {
    super::provider::cpu_session(path, "Orpheus is a CPU-pinned LLM-class engine", engine)
        .map_err(OrpheusError::Session)
}

fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> OrpheusResult<SessionInputValue<'static>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| OrpheusError::Inference(format!("i64 arr: {e}")))?;
    let t =
        Tensor::from_array(arr).map_err(|e| OrpheusError::Inference(format!("i64 tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

fn tensor_val_i64(shape: (usize, usize), data: Vec<i64>) -> OrpheusResult<Tensor<i64>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| OrpheusError::Inference(format!("i64 arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| OrpheusError::Inference(format!("i64 tensor: {e}")))
}

fn out_f32_named(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> OrpheusResult<ArrayD<f32>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| OrpheusError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| OrpheusError::Inference(format!("shape {name}: {e}")))
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
    names.sort();
    names
}

fn kv_shape(sess: &Session, name: &str) -> OrpheusResult<(usize, usize)> {
    let inp = sess
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .ok_or_else(|| OrpheusError::Session(format!("missing kv input {name}")))?;
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
    Ok((heads, hd))
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

fn next_rand(seed: &mut u64) -> f64 {
    let mut x = *seed;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *seed = x;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// temperature → top-p → categorical draw over an f64 logit row.
///
/// Takes f64 so [`super::sampling::apply_repetition_penalty`] — the shared HF-formula helper,
/// already used by the Qwen3-TTS talker — composes directly onto the row. Kept local rather
/// than delegating to `sampling::sample` for the same reason `neutts.rs` does: Orpheus draws
/// over a ~156k-wide vocabulary and has no top-k stage, so the extra full-row sort that helper
/// performs is pure cost here.
fn sample(logits: &[f64], temperature: f32, top_p: f64, seed: &mut u64) -> i64 {
    if temperature <= 0.0 {
        let mut best = 0usize;
        for (i, &v) in logits.iter().enumerate() {
            if v > logits[best] {
                best = i;
            }
        }
        return best as i64;
    }
    let t = f64::from(temperature);
    let maxv = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut probs: Vec<(usize, f64)> = logits
        .iter()
        .enumerate()
        .map(|(i, &v)| (i, ((v - maxv) / t).exp()))
        .collect();
    let sum: f64 = probs.iter().map(|(_, p)| p).sum();
    for p in &mut probs {
        p.1 /= sum;
    }
    probs.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
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
            return *idx as i64;
        }
    }
    probs[0].0 as i64
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
    fn cap_is_34_seconds_not_28() {
        // The constant's original comment claimed a "~28 s ceiling". SNAC emits
        // SAMPLES_PER_FRAME per 7-code frame, so the real ceiling is 34.05 s.
        let frames = MAX_NEW_TOKENS / FRAME_CODES;
        let secs = (frames * SAMPLES_PER_FRAME) as f32 / ORPHEUS_SAMPLE_RATE as f32;
        assert_eq!(frames, 400);
        assert!((secs - 34.05).abs() < 0.01, "cap is {secs:.2}s");
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
        let kept = stream.len() - cut.dropped;
        assert_eq!(kept, 3 * FRAME_CODES);
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
    }

    #[test]
    fn loop_cycle_needs_a_full_span() {
        assert!(loop_cycle(&[]).is_none());
        assert!(loop_cycle(&frame(1)).is_none());
    }

    #[test]
    fn repetition_penalty_pushes_repeated_codes_down() {
        // The decode path's exact composition: penalize, then sample greedily. A code already
        // generated must lose to an equally-scored fresh one.
        let mut row = vec![0.0_f64; 16];
        row[3] = 5.0;
        row[4] = 4.9;
        assert_eq!(sample(&row, 0.0, TOP_P, &mut 1), 3);
        super::super::sampling::apply_repetition_penalty(&mut row, &[3], REPETITION_PENALTY);
        assert_eq!(
            sample(&row, 0.0, TOP_P, &mut 1),
            4,
            "penalty did not demote the repeated code"
        );
    }

    #[test]
    fn stop_reasons_report_cleanliness() {
        assert!(OrpheusStop::Eos.is_clean());
        assert!(!OrpheusStop::Cap.is_clean());
        assert!(
            !OrpheusStop::LoopCut {
                frames: 1,
                dropped: 49
            }
            .is_clean()
        );
    }
}

#[cfg(test)]
mod smoke {
    use super::*;
    use std::path::PathBuf;

    // Loads the locally-validated ONNX and synthesizes through the real engine → writes a wav.
    #[test]
    #[ignore]
    fn orpheus_synthesizes_audio() {
        let base = PathBuf::from(r"E:\DL\Projects\tts-port");
        let mut eng = OrpheusEngine::load(
            &base.join("orpheus/onnx/model_q4.onnx"),
            &base.join("snac/onnx/decoder_model.onnx"),
            &base.join("orpheus/tokenizer.json"),
        )
        .expect("load");
        let out = eng
            .synthesize(
                "Hey there, this is Orpheus running through the native Rust engine.",
                "tara",
                0.6,
            )
            .expect("synthesize");
        assert!(out.stop.is_clean(), "decode ran away: {:?}", out.stop);
        let pcm = out.samples;
        let secs = pcm.len() as f32 / ORPHEUS_SAMPLE_RATE as f32;
        let rms = (pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
        println!(
            "ORPHEUS_RUST samples={} dur={:.2}s rms={:.4}",
            pcm.len(),
            secs,
            rms
        );
        write_wav(&base.join("orpheus_rust.wav"), &pcm, ORPHEUS_SAMPLE_RATE);
        assert!(pcm.len() > ORPHEUS_SAMPLE_RATE as usize / 2, "too short");
        assert!(rms > 0.005, "silent");
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
