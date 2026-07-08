// Spark-TTS (SparkAudio/Spark-TTS-0.5B) — Qwen0.5B → BiCodec → 16 kHz audio.
//
// Voice-creation (controllable) path, verified end-to-end in Python against
// Fhrozen/Spark-TTS-0.5B-ONNX before this port:
//   prompt = <|task_controllable_tts|><|start_content|>{text}<|end_content|>
//            <|start_style_label|><|gender_G|><|pitch_label_P|><|speed_label_S|><|end_style_label|>
//   decode = merged Qwen decoder w/ KV cache (24 layers, 2 KV heads, head_dim 64, HAS position_ids).
//            GREEDY — the model's `<|start_global_token|> … <|end_global_token|> <|start_semantic_token|>`
//            preamble is high-confidence under argmax but derails under sampling (validated).
//   collect  = <|bicodec_global_N|> (first 32 → speaker) + <|bicodec_semantic_N|> (content), by token id.
//   codec    = BiCodec(semantic[1,T], global[1,1,32]) → waveform @ 16 kHz.
//
// CPU-pinned like the other LLM-class engines.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use ndarray::{Array2, Array3, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

pub const SPARK_SAMPLE_RATE: u32 = 16_000;
const GLOBAL_TOKENS: usize = 32; // BiCodec speaker code count (fixed)
const MAX_NEW_TOKENS: usize = 3_000;

/// Voice-creation "voices" = gender presets (Spark has no fixed voices; the timbre is generated).
pub const SPARK_VOICES: &[&str] = &["female", "male"];

#[derive(Debug)]
pub enum SparkError {
    Session(String),
    Tokenizer(String),
    Inference(String),
}

impl std::fmt::Display for SparkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SparkError::Session(m) => write!(f, "spark session: {m}"),
            SparkError::Tokenizer(m) => write!(f, "spark tokenizer: {m}"),
            SparkError::Inference(m) => write!(f, "spark inference: {m}"),
        }
    }
}
pub type SparkResult<T> = Result<T, SparkError>;

type NamedInput = (Cow<'static, str>, SessionInputValue<'static>);

/// Zero-shot cloning graphs (DgDev91/SparkTTS-ONNX). Absent for creation-only installs.
struct CloneGraphs {
    wav2vec2: Session, // input_values[1,S] -> hidden_state_0..24 [1,T,1024]
    mel: Session,      // raw_waveform_with_channel[1,1,S] -> mel_spectrogram[1,128,T]
    speaker: Session,  // mel_spectrogram[1,T,128] -> global_tokens[1,1,32]
    encoder: Session,  // features[1,T,1024] -> semantic_tokens
}

pub struct SparkEngine {
    llm: Session,
    bicodec: Session,
    tokenizer: Tokenizer,
    past_names: Vec<String>,
    present_names: Vec<String>,
    kv_heads: usize,
    head_dim: usize,
    semantic_id_to_code: HashMap<i64, i64>,
    global_id_to_code: HashMap<i64, i64>,
    eos_id: i64,
    clone: Option<CloneGraphs>,
}

impl SparkEngine {
    pub fn load(llm_path: &Path, bicodec_path: &Path, tokenizer_path: &Path) -> SparkResult<Self> {
        let llm = cpu_session(llm_path, "Spark-TTS")?;
        let bicodec = cpu_session(bicodec_path, "Spark-TTS BiCodec")?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| {
            SparkError::Tokenizer(format!("load {}: {e}", tokenizer_path.display()))
        })?;

        let past_names = sorted_io(&llm, IoKind::Input, "past_key_values.");
        let present_names = sorted_io(&llm, IoKind::Output, "present.");
        if past_names.len() != present_names.len() || past_names.is_empty() {
            return Err(SparkError::Session(format!(
                "spark KV mismatch: {} past vs {} present",
                past_names.len(),
                present_names.len()
            )));
        }
        let (kv_heads, head_dim) = kv_shape(&llm, &past_names[0])?;

        // token id → codec code for the two bicodec streams.
        let mut semantic_id_to_code = HashMap::new();
        let mut global_id_to_code = HashMap::new();
        for (tok, id) in tokenizer.get_vocab(true) {
            if let Some(n) = tok.strip_prefix("<|bicodec_semantic_").and_then(strip_num) {
                semantic_id_to_code.insert(id as i64, n);
            } else if let Some(n) = tok.strip_prefix("<|bicodec_global_").and_then(strip_num) {
                global_id_to_code.insert(id as i64, n);
            }
        }
        if semantic_id_to_code.is_empty() || global_id_to_code.is_empty() {
            return Err(SparkError::Tokenizer(
                "bicodec tokens missing from vocab".into(),
            ));
        }
        let eos_id = tokenizer
            .token_to_id("<|im_end|>")
            .or_else(|| tokenizer.token_to_id("<|endoftext|>"))
            .map(|id| id as i64)
            .ok_or_else(|| SparkError::Tokenizer("no eos token".into()))?;

        Ok(Self {
            llm,
            bicodec,
            tokenizer,
            past_names,
            present_names,
            kv_heads,
            head_dim,
            semantic_id_to_code,
            global_id_to_code,
            eos_id,
            clone: None,
        })
    }

    /// Attach the zero-shot cloning graphs (from the DgDev91 stack) so `synthesize_clone` works.
    /// No-op-safe: creation still works without them.
    pub fn load_cloning(
        &mut self,
        wav2vec2_path: &Path,
        mel_path: &Path,
        speaker_path: &Path,
        encoder_path: &Path,
    ) -> SparkResult<()> {
        self.clone = Some(CloneGraphs {
            wav2vec2: cpu_session(wav2vec2_path, "Spark-TTS wav2vec2")?,
            mel: cpu_session(mel_path, "Spark-TTS mel")?,
            speaker: cpu_session(speaker_path, "Spark-TTS speaker")?,
            encoder: cpu_session(encoder_path, "Spark-TTS encoder")?,
        });
        Ok(())
    }

    pub fn cloning_ready(&self) -> bool {
        self.clone.is_some()
    }

    /// Zero-shot clone: reproduce the `ref16k` speaker (with its transcript `ref_text`) saying
    /// `text`. `ref16k` is mono f32 @ 16 kHz. Returns 16 kHz PCM.
    pub fn synthesize_clone(
        &mut self,
        text: &str,
        ref16k: &[f32],
        ref_text: &str,
    ) -> SparkResult<Vec<f32>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        if self.clone.is_none() {
            return Err(SparkError::Inference("cloning graphs not loaded".into()));
        }
        let (global, semantic) = self.encode_reference(ref16k)?;
        let global_str: String = global
            .iter()
            .map(|&n| format!("<|bicodec_global_{n}|>"))
            .collect();
        let semantic_str: String = semantic
            .iter()
            .map(|&n| format!("<|bicodec_semantic_{n}|>"))
            .collect();
        let prompt_str = format!(
            "<|task_tts|><|start_content|>{ref_text} {text}<|end_content|>\
             <|start_global_token|>{global_str}<|end_global_token|>\
             <|start_semantic_token|>{semantic_str}"
        );
        let enc = self
            .tokenizer
            .encode(prompt_str, false)
            .map_err(|e| SparkError::Tokenizer(format!("encode: {e}")))?;
        let prompt: Vec<i64> = enc.get_ids().iter().map(|&id| id as i64).collect();

        // Generation appends TARGET semantic tokens after the ref prefix; global comes from the ref.
        let (target_semantic, _) = self.decode(&prompt)?;
        if target_semantic.is_empty() {
            return Err(SparkError::Inference(
                "clone produced no target semantic".into(),
            ));
        }
        let mut g = global;
        g.truncate(GLOBAL_TOKENS);
        self.bicodec_decode(&target_semantic, &g)
    }

    /// Reference audio (16 kHz) → (global speaker tokens [32], semantic content tokens).
    fn encode_reference(&mut self, ref16k: &[f32]) -> SparkResult<(Vec<i64>, Vec<i64>)> {
        let n = ref16k.len();
        // --- semantic: wav2vec2 mean(hs 11,14,16) → bicodec encoder-quantizer ---
        let mean = ref16k.iter().sum::<f32>() / n.max(1) as f32;
        let var = ref16k.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / n.max(1) as f32;
        let denom = (var + 1e-7).sqrt();
        let norm: Vec<f32> = ref16k.iter().map(|x| (x - mean) / denom).collect();
        let clone = self.clone.as_mut().unwrap();
        let hs = clone
            .wav2vec2
            .run(ort::inputs! { "input_values" => tensor_val_f32((1, n), norm)? })
            .map_err(|e| SparkError::Inference(format!("wav2vec2 run: {e}")))?;
        let feat = {
            let a = out_f32_named(&hs, "hidden_state_11")?;
            let b = out_f32_named(&hs, "hidden_state_14")?;
            let c = out_f32_named(&hs, "hidden_state_16")?;
            let mut m = a;
            for (dst, (x, y)) in m.iter_mut().zip(b.iter().zip(c.iter())) {
                *dst = (*dst + *x + *y) / 3.0;
            }
            m // [1, T, 1024]
        };
        let feat_shape: Vec<i64> = feat.shape().iter().map(|&d| d as i64).collect();
        let feat_data: Vec<f32> = feat.as_slice().unwrap().to_vec();
        let feat_t = Tensor::from_array((feat_shape, feat_data))
            .map_err(|e| SparkError::Inference(format!("feat tensor: {e}")))?;
        let sem_out = clone
            .encoder
            .run(ort::inputs! { "features" => feat_t })
            .map_err(|e| SparkError::Inference(format!("encoder run: {e}")))?;
        let semantic: Vec<i64> = extract_i64_flat(&sem_out, "semantic_tokens")?;

        // --- global: mel → transpose → speaker encoder ---
        let mel_out = clone
            .mel
            .run(ort::inputs! { "raw_waveform_with_channel" => tensor_val_f32_3d((1, 1, n), ref16k.to_vec())? })
            .map_err(|e| SparkError::Inference(format!("mel run: {e}")))?;
        let mel = out_f32_named(&mel_out, "mel_spectrogram")?; // [1,128,T]
        let (bins, frames) = (mel.shape()[1], mel.shape()[2]);
        let mel_slice = mel.as_slice().unwrap();
        // transpose [1,128,T] -> [1,T,128]
        let mut mel_t = vec![0f32; bins * frames];
        for bch in 0..bins {
            for fr in 0..frames {
                mel_t[fr * bins + bch] = mel_slice[bch * frames + fr];
            }
        }
        let mel_t_tensor = Tensor::from_array((vec![1i64, frames as i64, bins as i64], mel_t))
            .map_err(|e| SparkError::Inference(format!("mel_t tensor: {e}")))?;
        let glob_out = clone
            .speaker
            .run(ort::inputs! { "mel_spectrogram" => mel_t_tensor })
            .map_err(|e| SparkError::Inference(format!("speaker run: {e}")))?;
        let global: Vec<i64> = extract_i64_flat(&glob_out, "global_tokens")?;
        Ok((global, semantic))
    }

    /// Synthesize `text` with a generated voice of the given `gender` ("female"/"male") → 16 kHz PCM.
    pub fn synthesize(&mut self, text: &str, gender: &str) -> SparkResult<Vec<f32>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let gender_id = if gender.eq_ignore_ascii_case("male") {
            1
        } else {
            0
        };
        let prompt_str = format!(
            "<|task_controllable_tts|><|start_content|>{text}<|end_content|>\
             <|start_style_label|><|gender_{gender_id}|><|pitch_label_2|><|speed_label_2|><|end_style_label|>"
        );
        let enc = self
            .tokenizer
            .encode(prompt_str, false)
            .map_err(|e| SparkError::Tokenizer(format!("encode: {e}")))?;
        let prompt: Vec<i64> = enc.get_ids().iter().map(|&id| id as i64).collect();

        let (semantic, mut global) = self.decode(&prompt)?;
        if semantic.is_empty() || global.len() < GLOBAL_TOKENS {
            return Err(SparkError::Inference(format!(
                "incomplete codes: semantic={} global={}",
                semantic.len(),
                global.len()
            )));
        }
        global.truncate(GLOBAL_TOKENS);
        self.bicodec_decode(&semantic, &global)
    }

    /// Greedy KV-cache decode → (semantic codes, global codes).
    fn decode(&mut self, prompt: &[i64]) -> SparkResult<(Vec<i64>, Vec<i64>)> {
        let mut past: Vec<Option<Tensor<f32>>> = (0..self.past_names.len()).map(|_| None).collect();
        let mut next_input: Vec<i64> = prompt.to_vec();
        let mut semantic: Vec<i64> = Vec::new();
        let mut global: Vec<i64> = Vec::new();

        for step in 0..MAX_NEW_TOKENS {
            let in_len = next_input.len();
            let attn_len = prompt.len() + step;
            let pos: Vec<i64> = if step == 0 {
                (0..in_len as i64).collect()
            } else {
                vec![(attn_len - 1) as i64]
            };
            let mut inputs: Vec<NamedInput> = Vec::with_capacity(3 + self.past_names.len());
            inputs.push((
                Cow::Borrowed("input_ids"),
                tensor_i64((1, in_len), next_input.clone())?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                tensor_i64((1, attn_len), vec![1i64; attn_len])?,
            ));
            inputs.push((
                Cow::Borrowed("position_ids"),
                tensor_i64((1, pos.len()), pos)?,
            ));
            for (i, name) in self.past_names.iter().enumerate() {
                let t = match past[i].take() {
                    Some(v) => v,
                    None => empty_kv(self.kv_heads, self.head_dim)?,
                };
                inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
            }

            let outputs = self
                .llm
                .run(inputs)
                .map_err(|e| SparkError::Inference(format!("llm run: {e}")))?;

            let logits = out_f32_named(&outputs, "logits")?;
            let vocab = *logits.shape().last().unwrap();
            let last = &logits.as_slice().unwrap()[(logits.len() - vocab)..];
            let mut best = 0usize;
            for (i, &v) in last.iter().enumerate() {
                if v > last[best] {
                    best = i;
                }
            }
            let next = best as i64;
            if next == self.eos_id {
                break;
            }
            if let Some(&c) = self.semantic_id_to_code.get(&next) {
                semantic.push(c);
            } else if let Some(&c) = self.global_id_to_code.get(&next) {
                global.push(c);
            }

            for (i, pname) in self.present_names.iter().enumerate() {
                let (shape, data) = outputs[pname.as_str()]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| SparkError::Inference(format!("extract {pname}: {e}")))?;
                past[i] = Some(
                    Tensor::from_array((shape.to_vec(), data.to_vec()))
                        .map_err(|e| SparkError::Inference(format!("kv tensor: {e}")))?,
                );
            }
            next_input = vec![next];
        }
        Ok((semantic, global))
    }

    fn bicodec_decode(&mut self, semantic: &[i64], global: &[i64]) -> SparkResult<Vec<f32>> {
        let sem = Array2::from_shape_vec((1, semantic.len()), semantic.to_vec())
            .map_err(|e| SparkError::Inference(format!("sem arr: {e}")))?;
        let glob = Array3::from_shape_vec((1, 1, global.len()), global.to_vec())
            .map_err(|e| SparkError::Inference(format!("glob arr: {e}")))?;
        let outputs = self
            .bicodec
            .run(ort::inputs! {
                "semantic_tokens" => Tensor::from_array(sem).map_err(|e| SparkError::Inference(format!("sem tensor: {e}")))?,
                "global_tokens"   => Tensor::from_array(glob).map_err(|e| SparkError::Inference(format!("glob tensor: {e}")))?,
            })
            .map_err(|e| SparkError::Inference(format!("bicodec run: {e}")))?;
        let audio = out_f32_named(&outputs, "audio")?; // [1,1,L]
        Ok(audio.iter().copied().collect())
    }
}

fn empty_kv(heads: usize, head_dim: usize) -> SparkResult<Tensor<f32>> {
    let arr = ndarray::Array4::<f32>::from_shape_vec((1, heads, 0, head_dim), Vec::new())
        .map_err(|e| SparkError::Inference(format!("empty kv arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| SparkError::Inference(format!("empty kv tensor: {e}")))
}

fn strip_num(rest: &str) -> Option<i64> {
    rest.strip_suffix("|>").and_then(|n| n.parse::<i64>().ok())
}

// ── ORT helpers ────────────────────────────────────────────────────────────────────

fn cpu_session(path: &Path, engine: &str) -> SparkResult<Session> {
    super::provider::cpu_session(path, "Spark-TTS is a CPU-pinned LLM-class engine", engine)
        .map_err(SparkError::Session)
}

fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> SparkResult<SessionInputValue<'static>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| SparkError::Inference(format!("i64 arr: {e}")))?;
    let t =
        Tensor::from_array(arr).map_err(|e| SparkError::Inference(format!("i64 tensor: {e}")))?;
    Ok(SessionInputValue::from(t))
}

fn out_f32_named(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> SparkResult<ArrayD<f32>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| SparkError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| SparkError::Inference(format!("shape {name}: {e}")))
}

/// f32 tensor `[d0, d1]` (owned) — for wav2vec2 `input_values`.
fn tensor_val_f32(shape: (usize, usize), data: Vec<f32>) -> SparkResult<Tensor<f32>> {
    let arr = Array2::from_shape_vec(shape, data)
        .map_err(|e| SparkError::Inference(format!("f32 arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| SparkError::Inference(format!("f32 tensor: {e}")))
}

/// f32 tensor `[d0, d1, d2]` (owned) — for the mel graph's `raw_waveform_with_channel`.
fn tensor_val_f32_3d(shape: (usize, usize, usize), data: Vec<f32>) -> SparkResult<Tensor<f32>> {
    let arr = Array3::from_shape_vec(shape, data)
        .map_err(|e| SparkError::Inference(format!("f32 3d arr: {e}")))?;
    Tensor::from_array(arr).map_err(|e| SparkError::Inference(format!("f32 3d tensor: {e}")))
}

/// Extract a named integer output as a flat `Vec<i64>` (handles i64 or i32 element types).
fn extract_i64_flat(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> SparkResult<Vec<i64>> {
    if let Ok((_, d)) = outputs[name].try_extract_tensor::<i64>() {
        return Ok(d.to_vec());
    }
    let (_, d) = outputs[name]
        .try_extract_tensor::<i32>()
        .map_err(|e| SparkError::Inference(format!("extract {name} (i32): {e}")))?;
    Ok(d.iter().map(|&x| x as i64).collect())
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

fn kv_shape(sess: &Session, name: &str) -> SparkResult<(usize, usize)> {
    let inp = sess
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .ok_or_else(|| SparkError::Session(format!("missing kv input {name}")))?;
    let shape = inp.dtype().tensor_shape();
    let heads = shape
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .unwrap_or(2) as usize;
    let hd = shape
        .and_then(|s| s.get(3).copied())
        .filter(|&d| d > 0)
        .unwrap_or(64) as usize;
    Ok((heads, hd))
}

#[cfg(test)]
mod smoke {
    use super::*;
    use std::path::PathBuf;

    #[test]
    #[ignore]
    fn spark_synthesizes_audio() {
        let base = PathBuf::from(r"E:\DL\Projects\tts-port");
        let mut eng = SparkEngine::load(
            &base.join("spark/LLM/onnx/model_q4.onnx"),
            &base.join("spark/bicodec.onnx"),
            &base.join("spark/LLM/tokenizer.json"),
        )
        .expect("load");
        let pcm = eng
            .synthesize(
                "Hello! This is Spark running through the native Rust engine.",
                "female",
            )
            .expect("synthesize");
        let secs = pcm.len() as f32 / SPARK_SAMPLE_RATE as f32;
        let rms = (pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
        println!(
            "SPARK_RUST samples={} dur={:.2}s rms={:.4}",
            pcm.len(),
            secs,
            rms
        );
        write_wav(&base.join("spark_rust.wav"), &pcm, SPARK_SAMPLE_RATE);
        assert!(pcm.len() > SPARK_SAMPLE_RATE as usize / 2, "too short");
        assert!(rms > 0.005, "silent");
    }

    #[test]
    #[ignore]
    fn spark_clone_synthesizes_audio() {
        let base = PathBuf::from(r"E:\DL\Projects\tts-port");
        let mut eng = SparkEngine::load(
            &base.join("spark/LLM/onnx/model_q4.onnx"),
            &base.join("spark/bicodec.onnx"),
            &base.join("spark/LLM/tokenizer.json"),
        )
        .expect("load");
        eng.load_cloning(
            &base.join("spark_clone/wav2vec2_model_fp16.onnx"),
            &base.join("spark_clone/mel_spectrogram.onnx"),
            &base.join("spark_clone/speaker_encoder_tokenizer.onnx"),
            &base.join("spark_clone/bicodec_encoder_quantizer.onnx"),
        )
        .expect("load_cloning");
        let bytes = std::fs::read(base.join("ref_en.f32")).expect("ref f32");
        let ref16k: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let ref_text = std::fs::read_to_string(base.join("ref_text.txt")).expect("ref text");
        let pcm = eng
            .synthesize_clone(
                "This voice was cloned from a reference clip.",
                &ref16k,
                ref_text.trim(),
            )
            .expect("synthesize_clone");
        let secs = pcm.len() as f32 / SPARK_SAMPLE_RATE as f32;
        let rms = (pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32).sqrt();
        println!(
            "SPARK_CLONE samples={} dur={:.2}s rms={:.4}",
            pcm.len(),
            secs,
            rms
        );
        write_wav(&base.join("spark_clone_rust.wav"), &pcm, SPARK_SAMPLE_RATE);
        assert!(pcm.len() > SPARK_SAMPLE_RATE as usize / 4, "too short");
        assert!(rms > 0.003, "silent");
    }

    fn write_wav(path: &std::path::Path, pcm: &[f32], sr: u32) {
        let mut b = Vec::new();
        let n = pcm.len() as u32;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + n * 2).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * 2).to_le_bytes());
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
