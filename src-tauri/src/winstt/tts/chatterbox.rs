// PORT IMPL — Chatterbox-multilingual (Resemble AI, MIT) voice-cloning TTS on ort 2.0.
//
// Faithful port of the verbatim onnxruntime pipeline shipped on the HF model card
// (onnx-community/chatterbox-multilingual-ONNX). FOUR ort sessions:
//   1. speech_encoder      (ref wav 24k mono -> cond_emb, prompt_token, ref_x_vector, prompt_feat)  run ONCE
//   2. embed_tokens        (ids+position+exaggeration -> inputs_embeds)                              run EVERY step
//   3. language_model      (T3 Llama backbone, KV-cache AR decode of S3 speech tokens)              run EVERY step
//   4. conditional_decoder (S3Gen flow vocoder: speech_tokens + speaker cond -> 24k wav)            run ONCE
//
// AR loop: greedy argmax + repetition_penalty=1.2; START=6561 seed, STOP=6562, max 256 tokens.
// KV-cache convention = Optimum `past_key_values.{N}.{key|value}` -> `present.{N}.{key|value}`
// (decoder-only self-attn; present.* always carried forward — same shape pattern as whisper.rs,
// host-copy here for correctness; IoBinding optimization deferred). q4 backbone => f32 KV.
//
// Zero-shot cloning: a reference WAV (no transcript) -> speech_encoder. A bundled default voice is
// used when none is supplied. EN-first: the `[en]` language tag is prepended; per-language CJK/he
// frontends are deferred.

#![allow(dead_code)]

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use ndarray::{Array1, Array2, Array3, ArrayD, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

pub const CHATTERBOX_SAMPLE_RATE: u32 = 24_000;
const NUM_LAYERS: usize = 30;
const KV_HEADS: usize = 16;
const HEAD_DIM: usize = 64;
const START_SPEECH_TOKEN: i64 = 6561;
const STOP_SPEECH_TOKEN: i64 = 6562;
const MAX_NEW_TOKENS: usize = 256;
const REPETITION_PENALTY: f32 = 1.2;
const DEFAULT_EXAGGERATION: f32 = 0.5;

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

#[derive(Clone, Debug)]
pub struct ChatterboxConfig {
    /// Holds `onnx/<graph>.onnx` (+ `.onnx_data`), `tokenizer.json`, `default_voice.wav`.
    pub cache_dir: PathBuf,
    /// Backbone quant filename under `onnx/` (q4 = f32 KV, the shippable default).
    pub backbone_filename: String,
}
impl Default for ChatterboxConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::new(),
            backbone_filename: "language_model_q4.onnx".to_string(),
        }
    }
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
        self.onnx("speech_encoder.onnx").exists()
            && self.onnx("embed_tokens.onnx").exists()
            && self.onnx(&self.backbone_filename).exists()
            && self.onnx("conditional_decoder.onnx").exists()
            && self.tokenizer_path().exists()
    }
}

struct Loaded {
    speech_encoder: Session,
    embed_tokens: Session,
    language_model: Session,
    conditional_decoder: Session,
    tokenizer: Tokenizer,
    past_names: Vec<String>,
    present_names: Vec<String>,
}

pub struct ChatterboxEngine {
    config: ChatterboxConfig,
    inner: Mutex<Option<Loaded>>,
    ready: AtomicBool,
}

impl ChatterboxEngine {
    pub fn new(config: ChatterboxConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            ready: AtomicBool::new(false),
        }
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub fn warm_up(&self) -> ChatterboxResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| ChatterboxError::Session("lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn load(&self) -> ChatterboxResult<Loaded> {
        if !self.config.assets_present() {
            return Err(ChatterboxError::AssetsMissing(format!(
                "expected 4 onnx graphs + tokenizer under {}",
                self.config.cache_dir.display()
            )));
        }
        let speech_encoder = build_session(&self.config.onnx("speech_encoder.onnx"))?;
        let embed_tokens = build_session(&self.config.onnx("embed_tokens.onnx"))?;
        let language_model = build_session(&self.config.onnx(&self.config.backbone_filename))?;
        let conditional_decoder = build_session(&self.config.onnx("conditional_decoder.onnx"))?;
        let tokenizer = Tokenizer::from_file(self.config.tokenizer_path())
            .map_err(|e| ChatterboxError::Tokenizer(e.to_string()))?;
        let mut past_names = Vec::with_capacity(NUM_LAYERS * 2);
        let mut present_names = Vec::with_capacity(NUM_LAYERS * 2);
        for l in 0..NUM_LAYERS {
            for kv in ["key", "value"] {
                past_names.push(format!("past_key_values.{l}.{kv}"));
                present_names.push(format!("present.{l}.{kv}"));
            }
        }
        Ok(Loaded {
            speech_encoder,
            embed_tokens,
            language_model,
            conditional_decoder,
            tokenizer,
            past_names,
            present_names,
        })
    }

    /// Synthesize `text` (English) in the voice of `ref_wav` (or the bundled default
    /// when None). Returns mono f32 PCM @ 24 kHz.
    pub fn synthesize(
        &self,
        text: &str,
        ref_wav: Option<&Path>,
        exaggeration: f32,
    ) -> ChatterboxResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| ChatterboxError::Session("lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        let loaded = guard.as_mut().expect("just loaded");

        // --- text -> ids ([en] tag prefix; EN frontend) ---
        let prompt = format!("[en]{trimmed}");
        let enc = loaded
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| ChatterboxError::Tokenizer(e.to_string()))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&u| u as i64).collect();
        let s = ids.len();
        if s == 0 {
            return Ok(Vec::new());
        }
        let position_ids: Vec<i64> = (0..s)
            .map(|idx| {
                if ids[idx] >= START_SPEECH_TOKEN {
                    0
                } else {
                    idx as i64 - 1
                }
            })
            .collect();

        // --- reference audio (24k mono f32) ---
        let ref_path = ref_wav
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| self.config.default_voice_path());
        let audio = load_wav_24k_mono(&ref_path)?;
        if audio.is_empty() {
            return Err(ChatterboxError::Audio("reference audio is empty".into()));
        }

        let exaggeration = if exaggeration.is_finite() {
            exaggeration.clamp(0.0, 1.0)
        } else {
            DEFAULT_EXAGGERATION
        };

        run_pipeline(loaded, &ids, &position_ids, &audio, exaggeration)
    }

    pub fn shutdown(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

fn build_session(path: &Path) -> ChatterboxResult<Session> {
    use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
    let dispatch: Vec<ExecutionProviderDispatch> = vec![CPUExecutionProvider::default().build()];
    let mut builder = Session::builder()
        .map_err(|e| ChatterboxError::Session(format!("builder: {e}")))?
        .with_execution_providers(dispatch)
        .map_err(|e| ChatterboxError::Session(format!("EPs: {e}")))?;
    builder
        .commit_from_file(path)
        .map_err(|e| ChatterboxError::Session(format!("commit {}: {e}", path.display())))
}

fn in_names(s: &Session) -> Vec<String> {
    s.inputs().iter().map(|o| o.name().to_string()).collect()
}
fn out_names(s: &Session) -> Vec<String> {
    s.outputs().iter().map(|o| o.name().to_string()).collect()
}

/// Extract a named f32 output as an owned dynamic array.
fn extract_f32(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ChatterboxResult<ArrayD<f32>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|e| ChatterboxError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| ChatterboxError::Inference(format!("shape {name}: {e}")))
}
fn extract_i64(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ChatterboxResult<ArrayD<i64>> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<i64>()
        .map_err(|e| ChatterboxError::Inference(format!("extract {name}: {e}")))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
        .map_err(|e| ChatterboxError::Inference(format!("shape {name}: {e}")))
}

fn run_pipeline(
    loaded: &mut Loaded,
    ids: &[i64],
    position_ids: &[i64],
    audio: &[f32],
    exaggeration: f32,
) -> ChatterboxResult<Vec<f32>> {
    let s = ids.len();

    // --- speech_encoder (once): reference conditioning ---
    let se_out = {
        let av = Array2::from_shape_vec((1, audio.len()), audio.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("audio_values: {e}")))?;
        let t = Tensor::from_array(av)
            .map_err(|e| ChatterboxError::Inference(format!("audio tensor: {e}")))?;
        loaded
            .speech_encoder
            .run(ort::inputs! { "audio_values" => t })
            .map_err(|e| ChatterboxError::Inference(format!("speech_encoder: {e}")))?
    };
    let cond_emb = extract_f32(&se_out, "audio_features")?; // [1, Lc, H]
    let prompt_token = extract_i64(&se_out, "audio_tokens")?; // [1, Lp]
    let ref_x_vector = extract_f32(&se_out, "speaker_embeddings")?;
    let prompt_feat = extract_f32(&se_out, "speaker_features")?;
    drop(se_out);

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

    // --- KV state (empty) + attention mask ---
    let mut kv: BTreeMap<String, ArrayD<f32>> = BTreeMap::new();
    for name in &loaded.past_names {
        kv.insert(
            name.clone(),
            ArrayD::from_shape_vec(IxDyn(&[1, KV_HEADS, 0, HEAD_DIM]), Vec::new())
                .map_err(|e| ChatterboxError::Inference(format!("empty kv: {e}")))?,
        );
    }
    let mut attention_mask: Vec<i64> = vec![1; seq_len];
    let mut generate_tokens: Vec<i64> = vec![START_SPEECH_TOKEN];

    for i in 0..MAX_NEW_TOKENS {
        // language_model(inputs_embeds, attention_mask, past_key_values.*)
        let mut inputs: Vec<NamedInput> = Vec::with_capacity(2 + loaded.past_names.len());
        let emb_t = Tensor::from_array(inputs_embeds.clone())
            .map_err(|e| ChatterboxError::Inference(format!("inputs_embeds tensor: {e}")))?;
        inputs.push((
            Cow::Borrowed("inputs_embeds"),
            SessionInputValue::from(emb_t),
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
        for name in &loaded.past_names {
            let arr = kv.get(name).expect("kv present");
            let t = Tensor::from_array(arr.clone())
                .map_err(|e| ChatterboxError::Inference(format!("kv {name}: {e}")))?;
            inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(t)));
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
        let mut scores: Vec<f32> = logits.as_slice().expect("contig")[last..last + vocab].to_vec();
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
        let next_token = argmax(&scores) as i64;
        generate_tokens.push(next_token);
        if next_token == STOP_SPEECH_TOKEN {
            break;
        }

        // carry present.* -> past_key_values.* (by name)
        for (pi, pres) in loaded.present_names.iter().enumerate() {
            let arr = extract_f32(&outputs, pres)?;
            kv.insert(loaded.past_names[pi].clone(), arr);
        }
        drop(outputs);

        // next decode step: embed the new token at position i+1
        embed_ids = vec![next_token];
        embed_pos = vec![(i + 1) as i64];
        inputs_embeds = run_embed(loaded, &embed_ids, &embed_pos, exaggeration)?; // [1,1,H]
        seq_len += 1;
        attention_mask.push(1);
        let _ = seq_len;
    }

    // speech_tokens = prompt_token ++ generate_tokens[1..len-1]
    let gen_mid: Vec<i64> = if generate_tokens.len() > 2 {
        generate_tokens[1..generate_tokens.len() - 1].to_vec()
    } else {
        Vec::new()
    };
    let prompt_vec: Vec<i64> = prompt_token.iter().copied().collect();
    let mut speech_tokens: Vec<i64> = Vec::with_capacity(prompt_vec.len() + gen_mid.len());
    speech_tokens.extend(prompt_vec);
    speech_tokens.extend(gen_mid);
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
    let spk = Tensor::from_array(ref_x_vector)
        .map_err(|e| ChatterboxError::Inference(format!("speaker_embeddings: {e}")))?;
    let feat = Tensor::from_array(prompt_feat)
        .map_err(|e| ChatterboxError::Inference(format!("speaker_features: {e}")))?;
    let dec = loaded
        .conditional_decoder
        .run(ort::inputs! {
            "speech_tokens" => st,
            "speaker_embeddings" => spk,
            "speaker_features" => feat,
        })
        .map_err(|e| ChatterboxError::Inference(format!("conditional_decoder: {e}")))?;
    let wav = extract_f32(&dec, "waveform").or_else(|_| {
        // fall back to first output if the name differs
        let (shape, data) = dec[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| ChatterboxError::Inference(format!("extract wav[0]: {e}")))?;
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("wav shape: {e}")))
    })?;
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

/// Run embed_tokens(input_ids, position_ids, exaggeration) -> inputs_embeds.
fn run_embed(
    loaded: &mut Loaded,
    ids: &[i64],
    pos: &[i64],
    exaggeration: f32,
) -> ChatterboxResult<ArrayD<f32>> {
    let n = ids.len();
    let ids_t = Tensor::from_array(
        Array2::from_shape_vec((1, n), ids.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("embed ids: {e}")))?,
    )
    .map_err(|e| ChatterboxError::Inference(format!("embed ids tensor: {e}")))?;
    let pos_t = Tensor::from_array(
        Array2::from_shape_vec((1, n), pos.to_vec())
            .map_err(|e| ChatterboxError::Inference(format!("embed pos: {e}")))?,
    )
    .map_err(|e| ChatterboxError::Inference(format!("embed pos tensor: {e}")))?;
    let exa_t = Tensor::from_array(Array1::from_vec(vec![exaggeration]))
        .map_err(|e| ChatterboxError::Inference(format!("exaggeration tensor: {e}")))?;
    let out = loaded
        .embed_tokens
        .run(ort::inputs! {
            "input_ids" => ids_t,
            "position_ids" => pos_t,
            "exaggeration" => exa_t,
        })
        .map_err(|e| ChatterboxError::Inference(format!("embed_tokens: {e}")))?;
    extract_f32(&out, "inputs_embeds")
}

fn argmax(scores: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in scores.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best
}

/// Load a WAV as mono f32 @ 24 kHz (linear-resampled if needed). Reference clips
/// for cloning are WAV; full symphonia decode + rubato can replace this later.
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

    #[test]
    fn argmax_picks_max() {
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
        assert_eq!(argmax(&[-1.0, -2.0, -0.5]), 2);
    }

    #[test]
    fn config_paths() {
        let c = ChatterboxConfig {
            cache_dir: PathBuf::from("/x/chatterbox"),
            ..Default::default()
        };
        assert!(c
            .onnx("speech_encoder.onnx")
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("onnx/speech_encoder.onnx"));
        assert!(c.tokenizer_path().ends_with("tokenizer.json"));
        assert!(c.default_voice_path().ends_with("default_voice.wav"));
    }

    #[test]
    fn kv_names_are_60() {
        let mut n = 0;
        for _l in 0..NUM_LAYERS {
            for _kv in ["key", "value"] {
                n += 1;
            }
        }
        assert_eq!(n, 60);
    }
}
