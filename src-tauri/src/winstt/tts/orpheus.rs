// Orpheus TTS (canopylabs/orpheus-3b-0.1-ft) — LLM → SNAC neural codec → 24 kHz audio.
//
// Pipeline (verified end-to-end in Python against onnx-community/orpheus-3b-0.1-ft-ONNX +
// onnx-community/snac_24khz-ONNX before this port):
//   prompt   = [128259] ++ tok("{voice}: {text}") ++ [128009, 128260]
//   decode   = merged Llama decoder w/ KV cache (28 layers, 8 KV heads, head_dim 128, NO position_ids);
//              temperature+top-p sampling until 128258 (audio EOS) or 128001
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
const MAX_NEW_TOKENS: usize = 2_800; // ~28 s ceiling (7 codes ≈ 80 ms/frame)

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
        })
    }

    /// Synthesize `text` in `voice` → mono f32 PCM @ 24 kHz. `temperature` <= 0 ⇒ greedy.
    pub fn synthesize(
        &mut self,
        text: &str,
        voice: &str,
        temperature: f32,
    ) -> OrpheusResult<Vec<f32>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
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

        let generated = self.decode(&prompt, temperature)?;
        let codes = parse_codes(&generated);
        if codes.is_empty() {
            return Err(OrpheusError::Inference("no audio codes generated".into()));
        }
        self.snac_decode(&codes)
    }

    /// Autoregressive KV-cache decode → the raw generated token stream (excludes the stop token).
    fn decode(&mut self, prompt: &[i64], temperature: f32) -> OrpheusResult<Vec<i64>> {
        let mut past: Vec<Option<Tensor<f32>>> = (0..self.past_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.to_vec();
        let mut seed = fnv1a_seed(prompt);

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
            let next = sample(last, temperature, 0.9, &mut seed);
            if next == AUDIO_EOS || next == TEXT_EOS {
                break;
            }
            generated.push(next);

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
        Ok(generated)
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

fn sample(logits: &[f32], temperature: f32, top_p: f64, seed: &mut u64) -> i64 {
    if temperature <= 0.0 {
        let mut best = 0usize;
        for (i, &v) in logits.iter().enumerate() {
            if v > logits[best] {
                best = i;
            }
        }
        return best as i64;
    }
    let t = temperature as f64;
    let maxv = logits.iter().cloned().fold(f32::MIN, f32::max) as f64;
    let mut probs: Vec<(usize, f64)> = logits
        .iter()
        .enumerate()
        .map(|(i, &v)| (i, (((v as f64) - maxv) / t).exp()))
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
        let pcm = eng
            .synthesize(
                "Hey there, this is Orpheus running through the native Rust engine.",
                "tara",
                0.6,
            )
            .expect("synthesize");
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
