// PORT IMPL — Supertonic TTS (3-graph flow-matching) on ort 2.0.0-rc.12.
//
// Recipe verified verbatim from transformers.js modeling_supertonic.js +
// text-to-audio.js + onnx-community/Supertonic-TTS-ONNX config.json/tokenizer.json
// (see TTS research run, model:supertonic):
//   text --char tokenizer (WordLevel, 81 vocab)--> input_ids + attention_mask
//   text_encoder(input_ids, attention_mask, style[1,101,128]) -> last_hidden_state, durations
//   ds = raw_durations / speed * 44100;  latent_len = ceil(ds / 3072);  channels = 144
//   noisy = randn([1,144,latent_len]);  latent_mask = ones[1,latent_len]
//   for step in 0..5: latent_denoiser(style, noisy, latent_mask, encoder_outputs=last_hidden,
//                       attention_mask, timestep=step, num_inference_steps=5) -> noisy
//   voice_decoder(latents=noisy) -> waveform f32 @ 44100, trim to ceil(ds)
//
// No espeak/phonemizer (char tokenizer). Each .onnx has a sibling .onnx_data
// (external weights) loaded automatically from the same dir.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// config.json constants.
pub const SUPERTONIC_SAMPLE_RATE: u32 = 44_100;
const BASE_CHUNK_SIZE: usize = 512;
const CHUNK_COMPRESS_FACTOR: usize = 6;
const LATENT_DIM: usize = 24;
const STYLE_DIM: usize = 128;
const LATENT_SIZE: usize = BASE_CHUNK_SIZE * CHUNK_COMPRESS_FACTOR; // 3072
const LATENT_CHANNELS: usize = LATENT_DIM * CHUNK_COMPRESS_FACTOR; // 144
const STYLE_SEQ: usize = 101; // voice .bin = 101*128 f32
                              // Flow-matching denoise steps. Supertonic's own guidance: "5 (low) to 12 (high),
                              // default 8 (medium)" — steps have a HUGE impact on intelligibility. At 5 (the
                              // low end) the model slurs/drops words (e.g. "jumps" in the fox pangram); 8 is the
                              // official default and recovers them at a small latency cost (~8/5 the denoiser
                              // runs; still RTF << 1 on CPU).
const NUM_INFERENCE_STEPS: usize = 8;
pub const SUPERTONIC_DEFAULT_VOICE: &str = "M1";
pub const SUPERTONIC_VOICES: &[&str] =
    &["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

#[derive(Debug)]
pub enum SupertonicError {
    AssetsMissing(String),
    Session(String),
    Voice(String),
    Inference(String),
}
impl std::fmt::Display for SupertonicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupertonicError::AssetsMissing(m) => write!(f, "supertonic assets missing: {m}"),
            SupertonicError::Session(m) => write!(f, "supertonic session error: {m}"),
            SupertonicError::Voice(m) => write!(f, "supertonic voice error: {m}"),
            SupertonicError::Inference(m) => write!(f, "supertonic inference error: {m}"),
        }
    }
}
impl std::error::Error for SupertonicError {}
pub type SupertonicResult<T> = Result<T, SupertonicError>;

// ---------------------------------------------------------------------------
// Char tokenizer (WordLevel, 81 vocab). NFKD is skipped (no-op for English /
// already-decomposed input); the normalizer's \s+→space + en/em-dash→'-' +
// drop-out-of-class rules are applied. Out-of-vocab chars are dropped.
// ---------------------------------------------------------------------------

static SUPERTONIC_VOCAB: OnceLock<HashMap<char, i64>> = OnceLock::new();

fn supertonic_vocab() -> &'static HashMap<char, i64> {
    SUPERTONIC_VOCAB.get_or_init(|| {
        let mut m: HashMap<char, i64> = HashMap::new();
        // verbatim from tokenizer.json model.vocab
        let punct: &[(char, i64)] = &[
            (' ', 0),
            ('!', 1),
            ('"', 2),
            ('$', 3),
            ('%', 4),
            ('&', 5),
            ('\'', 6),
            ('(', 7),
            (')', 8),
            ('*', 9),
            ('+', 10),
            (',', 11),
            ('-', 12),
            ('.', 13),
        ];
        for &(c, i) in punct {
            m.insert(c, i);
        }
        for d in 0..10u8 {
            m.insert((b'0' + d) as char, 14 + d as i64); // '0'..'9' → 14..23
        }
        m.insert(':', 24);
        m.insert(';', 25);
        m.insert('?', 26);
        for (k, c) in (b'A'..=b'Z').enumerate() {
            m.insert(c as char, 27 + k as i64); // A..Z → 27..52
        }
        for (k, c) in (b'a'..=b'z').enumerate() {
            m.insert(c as char, 53 + k as i64); // a..z → 53..78
        }
        m.insert('\u{00A3}', 79); // £
        m.insert('\u{0301}', 80); // combining acute (also unk_token)
        m
    })
}

/// Normalize + char-tokenize → (input_ids, attention_mask). attention_mask is all
/// 1s (single sequence, no padding).
fn supertonic_tokenize(text: &str) -> (Vec<i64>, Vec<i64>) {
    let vocab = supertonic_vocab();
    let mut ids: Vec<i64> = Vec::with_capacity(text.len());
    let mut prev_space = false;
    for raw in text.chars() {
        // \s+ → single space
        if raw.is_whitespace() {
            if !prev_space {
                if let Some(&id) = vocab.get(&' ') {
                    ids.push(id);
                }
                prev_space = true;
            }
            continue;
        }
        prev_space = false;
        // en/em dash → '-'
        let c = if raw == '\u{2013}' || raw == '\u{2014}' {
            '-'
        } else {
            raw
        };
        if let Some(&id) = vocab.get(&c) {
            ids.push(id);
        }
        // out-of-class chars are dropped (the normalizer filter)
    }
    // trim a trailing lone space id to mirror typical normalization edges
    let mask = vec![1i64; ids.len()];
    (ids, mask)
}

// ---------------------------------------------------------------------------
// Deterministic Gaussian noise (xorshift64* + Box–Muller). Fixed seed → stable
// flow-matching init (any valid sample works; determinism aids reproducibility).
// ---------------------------------------------------------------------------

struct Gauss {
    state: u64,
    spare: Option<f32>,
}
impl Gauss {
    fn new(seed: u64) -> Self {
        Self {
            state: seed | 1,
            spare: None,
        }
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn next_uniform(&mut self) -> f32 {
        // (0,1)
        let v = (self.next_u64() >> 11) as f32 / (1u64 << 53) as f32;
        if v <= 0.0 {
            f32::MIN_POSITIVE
        } else {
            v
        }
    }
    fn next_normal(&mut self) -> f32 {
        if let Some(s) = self.spare.take() {
            return s;
        }
        let u1 = self.next_uniform();
        let u2 = self.next_uniform();
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = std::f32::consts::TAU * u2;
        self.spare = Some(r * theta.sin());
        r * theta.cos()
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SupertonicConfig {
    /// Directory holding `onnx/{text_encoder,latent_denoiser,voice_decoder}.onnx`
    /// (+ `.onnx_data`) and `voices/{F1..M5}.bin`.
    pub cache_dir: PathBuf,
}
impl SupertonicConfig {
    fn onnx_dir(&self) -> PathBuf {
        self.cache_dir.join("onnx")
    }
    fn graph_path(&self, name: &str) -> PathBuf {
        self.onnx_dir().join(format!("{name}.onnx"))
    }
    fn voice_path(&self, voice: &str) -> PathBuf {
        self.cache_dir.join("voices").join(format!("{voice}.bin"))
    }
    pub fn assets_present(&self) -> bool {
        self.graph_path("text_encoder").exists()
            && self.graph_path("latent_denoiser").exists()
            && self.graph_path("voice_decoder").exists()
    }
}

struct Loaded {
    text_encoder: ort::session::Session,
    latent_denoiser: ort::session::Session,
    voice_decoder: ort::session::Session,
    te_outputs: Vec<String>,
    ld_outputs: Vec<String>,
    vd_outputs: Vec<String>,
}

pub struct SupertonicEngine {
    config: SupertonicConfig,
    inner: Mutex<Option<Loaded>>,
    ready: AtomicBool,
}

impl SupertonicEngine {
    pub fn new(config: SupertonicConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            ready: AtomicBool::new(false),
        }
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// Report each session's input/output node names (debugging the I/O contract).
    pub fn io_report(&self) -> Option<String> {
        let guard = self.inner.lock().ok()?;
        let l = guard.as_ref()?;
        Some(format!(
            "text_encoder  in={:?} out={:?}\nlatent_denoiser in={:?} out={:?}\nvoice_decoder in={:?} out={:?}",
            input_names(&l.text_encoder),
            l.te_outputs,
            input_names(&l.latent_denoiser),
            l.ld_outputs,
            input_names(&l.voice_decoder),
            l.vd_outputs,
        ))
    }

    pub fn warm_up(&self) -> SupertonicResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| SupertonicError::Session("supertonic lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn load(&self) -> SupertonicResult<Loaded> {
        if !self.config.assets_present() {
            return Err(SupertonicError::AssetsMissing(format!(
                "expected graphs under {}",
                self.config.onnx_dir().display()
            )));
        }
        let text_encoder = build_session(&self.config.graph_path("text_encoder"))?;
        let latent_denoiser = build_session(&self.config.graph_path("latent_denoiser"))?;
        let voice_decoder = build_session(&self.config.graph_path("voice_decoder"))?;
        let te_outputs = output_names(&text_encoder);
        let ld_outputs = output_names(&latent_denoiser);
        let vd_outputs = output_names(&voice_decoder);
        Ok(Loaded {
            text_encoder,
            latent_denoiser,
            voice_decoder,
            te_outputs,
            ld_outputs,
            vd_outputs,
        })
    }

    /// Load a voice's 101*128 style embedding from `voices/{voice}.bin`.
    fn load_style(&self, voice: &str) -> SupertonicResult<Vec<f32>> {
        let v = if SUPERTONIC_VOICES.contains(&voice) {
            voice
        } else {
            SUPERTONIC_DEFAULT_VOICE
        };
        let path = self.config.voice_path(v);
        let bytes = std::fs::read(&path)
            .map_err(|e| SupertonicError::Voice(format!("read {}: {e}", path.display())))?;
        let expected = STYLE_SEQ * STYLE_DIM * 4;
        if bytes.len() != expected {
            return Err(SupertonicError::Voice(format!(
                "voice {v} is {} bytes, expected {expected} (101*128 f32)",
                bytes.len()
            )));
        }
        let mut data = Vec::with_capacity(STYLE_SEQ * STYLE_DIM);
        for chunk in bytes.chunks_exact(4) {
            data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Ok(data)
    }

    /// Synthesize ONE sentence → mono f32 PCM @ 44.1 kHz.
    pub fn synthesize(&self, text: &str, voice: &str, speed: f32) -> SupertonicResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let (ids, mask) = supertonic_tokenize(trimmed);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let style = self.load_style(voice)?;

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| SupertonicError::Session("supertonic lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        let loaded = guard.as_mut().expect("just initialized");
        run_pipeline(loaded, &ids, &mask, &style, speed)
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

fn build_session(path: &Path) -> SupertonicResult<ort::session::Session> {
    use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
    let dispatch: Vec<ExecutionProviderDispatch> = vec![CPUExecutionProvider::default().build()];
    let mut builder = ort::session::Session::builder()
        .map_err(|e| SupertonicError::Session(format!("session builder: {e}")))?
        .with_execution_providers(dispatch)
        .map_err(|e| SupertonicError::Session(format!("register EPs: {e}")))?;
    builder
        .commit_from_file(path)
        .map_err(|e| SupertonicError::Session(format!("commit_from_file {}: {e}", path.display())))
}

fn input_names(s: &ort::session::Session) -> Vec<String> {
    s.inputs().iter().map(|o| o.name().to_string()).collect()
}
fn output_names(s: &ort::session::Session) -> Vec<String> {
    s.outputs().iter().map(|o| o.name().to_string()).collect()
}
/// Output index for `target` name, else `default` positional index.
fn out_idx(names: &[String], target: &str, default: usize) -> usize {
    names.iter().position(|n| n == target).unwrap_or(default)
}

fn run_pipeline(
    loaded: &mut Loaded,
    ids: &[i64],
    mask: &[i64],
    style: &[f32],
    speed: f32,
) -> SupertonicResult<Vec<f32>> {
    use ort::value::Tensor;
    let t = ids.len();
    let style_shape = vec![1usize, STYLE_SEQ, STYLE_DIM];

    // ---- 1. text_encoder ----
    let te_out = {
        let input_ids = Tensor::from_array(([1usize, t], ids.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("input_ids: {e}")))?;
        let attn = Tensor::from_array(([1usize, t], mask.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("attention_mask: {e}")))?;
        let style_t = Tensor::from_array((style_shape.clone(), style.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("style: {e}")))?;
        loaded
            .text_encoder
            .run(ort::inputs! {
                "input_ids" => input_ids,
                "attention_mask" => attn,
                "style" => style_t,
            })
            .map_err(|e| SupertonicError::Inference(format!("text_encoder: {e}")))?
    };
    let lh_idx = out_idx(&loaded.te_outputs, "last_hidden_state", 0);
    let dur_idx = out_idx(&loaded.te_outputs, "durations", 1);
    let (lh_shape_ref, lh_data) = te_out[lh_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| SupertonicError::Inference(format!("extract last_hidden_state: {e}")))?;
    let lh_shape: Vec<usize> = lh_shape_ref.iter().map(|&d| d as usize).collect();
    let last_hidden: Vec<f32> = lh_data.to_vec();
    let (_d_shape, d_data) = te_out[dur_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| SupertonicError::Inference(format!("extract durations: {e}")))?;
    let raw_duration = d_data.first().copied().unwrap_or(0.0);
    drop(te_out);

    // ---- 2. latent prep ----
    let speed = if speed > 0.0 { speed } else { 1.0 };
    let ds = (raw_duration / speed) * SUPERTONIC_SAMPLE_RATE as f32; // sample count (float)
    if !ds.is_finite() || ds <= 0.0 {
        return Err(SupertonicError::Inference(format!(
            "non-positive predicted duration {ds} (raw {raw_duration})"
        )));
    }
    let latent_len = (ds / LATENT_SIZE as f32).ceil() as usize;
    let latent_len = latent_len.max(1);
    let n_latents = LATENT_CHANNELS * latent_len;
    // randn([1,144,latent_len]); batch 1 → every time position is valid (no pad mask).
    let mut g = Gauss::new(0x9E3779B97F4A7C15 ^ (t as u64).wrapping_mul(2654435761));
    let mut noisy: Vec<f32> = (0..n_latents).map(|_| g.next_normal()).collect();
    let noisy_shape = vec![1usize, LATENT_CHANNELS, latent_len];
    let latent_mask: Vec<i64> = vec![1i64; latent_len];
    let num_steps_val = vec![NUM_INFERENCE_STEPS as f32];

    // ---- 3. denoise loop ----
    let den_idx = out_idx(&loaded.ld_outputs, "denoised_latents", 0);
    for step in 0..NUM_INFERENCE_STEPS {
        let style_t = Tensor::from_array((style_shape.clone(), style.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("style(step): {e}")))?;
        let noisy_t = Tensor::from_array((noisy_shape.clone(), noisy.clone().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("noisy_latents: {e}")))?;
        let lmask_t =
            Tensor::from_array(([1usize, latent_len], latent_mask.clone().into_boxed_slice()))
                .map_err(|e| SupertonicError::Inference(format!("latent_mask: {e}")))?;
        let enc_t = Tensor::from_array((lh_shape.clone(), last_hidden.clone().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("encoder_outputs: {e}")))?;
        let attn_t = Tensor::from_array(([1usize, t], mask.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("attention_mask(step): {e}")))?;
        let ts_t = Tensor::from_array(([1usize], vec![step as f32].into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("timestep: {e}")))?;
        let nsteps_t = Tensor::from_array(([1usize], num_steps_val.clone().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("num_inference_steps: {e}")))?;
        let out = loaded
            .latent_denoiser
            .run(ort::inputs! {
                "style" => style_t,
                "noisy_latents" => noisy_t,
                "latent_mask" => lmask_t,
                "encoder_outputs" => enc_t,
                "attention_mask" => attn_t,
                "timestep" => ts_t,
                "num_inference_steps" => nsteps_t,
            })
            .map_err(|e| SupertonicError::Inference(format!("latent_denoiser step {step}: {e}")))?;
        let (_s, data) = out[den_idx]
            .try_extract_tensor::<f32>()
            .map_err(|e| SupertonicError::Inference(format!("extract denoised: {e}")))?;
        noisy = data.to_vec();
    }

    // ---- 4. voice_decoder ----
    let wav_idx = out_idx(&loaded.vd_outputs, "waveform", 0);
    let latents_t = Tensor::from_array((noisy_shape.clone(), noisy.into_boxed_slice()))
        .map_err(|e| SupertonicError::Inference(format!("latents: {e}")))?;
    let dec = loaded
        .voice_decoder
        .run(ort::inputs! { "latents" => latents_t })
        .map_err(|e| SupertonicError::Inference(format!("voice_decoder: {e}")))?;
    let (_w_shape, wav) = dec[wav_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| SupertonicError::Inference(format!("extract waveform: {e}")))?;
    let trim_len = (ds.ceil() as usize).min(wav.len());
    Ok(wav[..trim_len].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_matches_tokenizer_json() {
        let v = supertonic_vocab();
        assert_eq!(v.len(), 81);
        assert_eq!(v.get(&' '), Some(&0));
        assert_eq!(v.get(&'!'), Some(&1));
        assert_eq!(v.get(&'.'), Some(&13));
        assert_eq!(v.get(&'0'), Some(&14));
        assert_eq!(v.get(&'9'), Some(&23));
        assert_eq!(v.get(&'A'), Some(&27));
        assert_eq!(v.get(&'Z'), Some(&52));
        assert_eq!(v.get(&'a'), Some(&53));
        assert_eq!(v.get(&'z'), Some(&78));
        assert_eq!(v.get(&'\u{00A3}'), Some(&79));
    }

    #[test]
    fn tokenize_collapses_space_and_drops_unknown() {
        let (ids, mask) = supertonic_tokenize("Hi  there~");
        // '~' is out of class → dropped; double space → single.
        // H(34) i(61) space(0) t(72) h(60) e(57) r(70) e(57)
        assert_eq!(ids, vec![34, 61, 0, 72, 60, 57, 70, 57]);
        assert_eq!(mask.len(), ids.len());
    }

    #[test]
    fn dash_normalized() {
        let (ids, _) = supertonic_tokenize("a\u{2014}b");
        // em dash → '-' (12)
        assert_eq!(ids, vec![53, 12, 54]);
    }

    #[test]
    fn gauss_is_deterministic_and_finite() {
        let mut a = Gauss::new(123);
        let mut b = Gauss::new(123);
        for _ in 0..1000 {
            let x = a.next_normal();
            assert!(x.is_finite());
            assert_eq!(x, b.next_normal());
        }
    }
}
