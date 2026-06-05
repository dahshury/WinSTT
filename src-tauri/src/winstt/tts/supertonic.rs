// Supertonic 3 TTS on ort 2.0.0-rc.12.
//
// Upstream assets come from Supertone/supertonic-3:
//   onnx/duration_predictor.onnx
//   onnx/text_encoder.onnx
//   onnx/vector_estimator.onnx
//   onnx/vocoder.onnx
//   onnx/tts.json
//   onnx/unicode_indexer.json
//   voice_styles/{F1..M5}.json
//
// Inference mirrors the official Hugging Face Space:
//   preprocess text -> Unicode indexer ids
//   duration_predictor(text_ids, style_dp, text_mask) -> duration seconds
//   text_encoder(text_ids, style_ttl, text_mask) -> text_emb
//   vector_estimator(noisy_latent, text_emb, style_ttl, text_mask, latent_mask,
//                    total_step, current_step) -> denoised_latent
//   vocoder(latent) -> wav_tts @ 44.1 kHz

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

pub const SUPERTONIC_SAMPLE_RATE: u32 = 44_100;
const BASE_CHUNK_SIZE: usize = 512;
const CHUNK_COMPRESS_FACTOR: usize = 6;
const LATENT_DIM: usize = 24;
const LATENT_SIZE: usize = BASE_CHUNK_SIZE * CHUNK_COMPRESS_FACTOR;
const LATENT_CHANNELS: usize = LATENT_DIM * CHUNK_COMPRESS_FACTOR;
const STYLE_TTL_SEQ: usize = 50;
const STYLE_TTL_DIM: usize = 256;
const STYLE_DP_SEQ: usize = 8;
const STYLE_DP_DIM: usize = 16;
const NUM_INFERENCE_STEPS: usize = 8;
const SPEED_MIN: f32 = 0.8;
const SPEED_MAX: f32 = 1.3;
const SPEED_OFFSET: f32 = 0.05;

pub const SUPERTONIC_DEFAULT_VOICE: &str = "M3";
pub const SUPERTONIC_VOICE_IDS: &[&str] =
    &["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
pub const SUPERTONIC_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("ko", "Korean"),
    ("ja", "Japanese"),
    ("ar", "Arabic"),
    ("bg", "Bulgarian"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("es", "Spanish"),
    ("et", "Estonian"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("id", "Indonesian"),
    ("it", "Italian"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sv", "Swedish"),
    ("tr", "Turkish"),
    ("uk", "Ukrainian"),
    ("vi", "Vietnamese"),
];

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
// Text preprocessing + tokenizer
// ---------------------------------------------------------------------------

fn supported_language(code: &str) -> Option<&'static str> {
    SUPERTONIC_LANGUAGES
        .iter()
        .find(|(lang, _)| *lang == code)
        .map(|(lang, _)| *lang)
}

fn resolve_language(lang: &str) -> &'static str {
    let normalized = lang.trim().to_lowercase().replace('_', "-");
    if let Some(lang) = supported_language(&normalized) {
        return lang;
    }
    let prefix = normalized.split('-').next().unwrap_or_default();
    supported_language(prefix).unwrap_or("en")
}

fn resolve_voice_id(voice: &str) -> &'static str {
    let requested = voice.trim();
    SUPERTONIC_VOICE_IDS
        .iter()
        .copied()
        .find(|id| id.eq_ignore_ascii_case(requested))
        .unwrap_or(SUPERTONIC_DEFAULT_VOICE)
}

fn is_emoji_or_symbol(c: char) -> bool {
    matches!(
        c as u32,
        0x1F600..=0x1F64F
            | 0x1F300..=0x1F5FF
            | 0x1F680..=0x1F6FF
            | 0x2600..=0x26FF
            | 0x2700..=0x27BF
            | 0x1F1E6..=0x1F1FF
    )
}

fn has_terminal_punctuation(s: &str) -> bool {
    s.chars().last().is_some_and(|c| {
        matches!(
            c,
            '.' | '!'
                | '?'
                | ';'
                | ':'
                | ','
                | '\''
                | '"'
                | ')'
                | ']'
                | '}'
                | '\u{2026}'
                | '\u{3002}'
                | '\u{300D}'
                | '\u{300F}'
                | '\u{3011}'
                | '\u{3009}'
                | '\u{300B}'
                | '\u{203A}'
                | '\u{00BB}'
        )
    })
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_spacing(mut s: String) -> String {
    for punct in [".", ",", "!", "?", ";", ":"] {
        let before = format!(" {punct}");
        while s.contains(&before) {
            s = s.replace(&before, punct);
        }
    }
    while s.contains("''") {
        s = s.replace("''", "'");
    }
    while s.contains("\"\"") {
        s = s.replace("\"\"", "\"");
    }
    collapse_spaces(&s)
}

fn preprocess_text(text: &str, lang: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    for c in text.nfkd() {
        if is_emoji_or_symbol(c) {
            continue;
        }
        match c {
            '\u{2013}' | '\u{2014}' | '\u{2011}' => normalized.push('-'),
            '_' | '[' | ']' | '|' | '/' | '#' | '\u{2192}' | '\u{2190}' => normalized.push(' '),
            '\u{201C}' | '\u{201D}' => normalized.push('"'),
            '\u{2018}' | '\u{2019}' | '\u{00B4}' | '`' => normalized.push('\''),
            '@' => normalized.push_str(" at "),
            '\\' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => {}
            other => normalized.push(other),
        }
    }

    let mut s = normalized
        .replace("e.g.,", "for example,")
        .replace("E.g.,", "For example,")
        .replace("i.e.,", "that is,")
        .replace("I.e.,", "That is,");
    s = normalize_spacing(s);
    if s.is_empty() {
        s.push('.');
    } else if !has_terminal_punctuation(&s) {
        s.push('.');
    }

    let lang = resolve_language(lang);
    format!("<{lang}>{s}</{lang}>")
}

fn tokenize_with_indexer(text: &str, indexer: &[i64]) -> Vec<i64> {
    text.chars()
        .map(|c| {
            let code = c as usize;
            let id = indexer.get(code).copied().unwrap_or(-1);
            if id >= 0 {
                id
            } else {
                0
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Deterministic Gaussian noise (xorshift64* + Box-Muller).
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
    /// Directory holding the upstream Supertonic 3 repo layout.
    pub cache_dir: PathBuf,
}

impl SupertonicConfig {
    fn onnx_dir(&self) -> PathBuf {
        self.cache_dir.join("onnx")
    }

    fn graph_path(&self, name: &str) -> PathBuf {
        self.onnx_dir().join(format!("{name}.onnx"))
    }

    fn style_path(&self, voice: &str) -> PathBuf {
        self.cache_dir
            .join("voice_styles")
            .join(format!("{voice}.json"))
    }

    fn unicode_indexer_path(&self) -> PathBuf {
        self.onnx_dir().join("unicode_indexer.json")
    }

    pub fn assets_present(&self) -> bool {
        [
            "duration_predictor",
            "text_encoder",
            "vector_estimator",
            "vocoder",
        ]
        .iter()
        .all(|graph| self.graph_path(graph).exists())
            && self.onnx_dir().join("tts.json").exists()
            && self.unicode_indexer_path().exists()
    }
}

struct Loaded {
    duration_predictor: ort::session::Session,
    text_encoder: ort::session::Session,
    vector_estimator: ort::session::Session,
    vocoder: ort::session::Session,
    dp_outputs: Vec<String>,
    te_outputs: Vec<String>,
    ve_outputs: Vec<String>,
    vocoder_outputs: Vec<String>,
    unicode_indexer: Vec<i64>,
}

struct StyleEmbeddings {
    ttl: Vec<f32>,
    dp: Vec<f32>,
}

#[derive(Deserialize)]
struct StyleFile {
    style_ttl: StyleTensor,
    style_dp: StyleTensor,
}

#[derive(Deserialize)]
struct StyleTensor {
    data: serde_json::Value,
    dims: Vec<usize>,
    #[serde(rename = "type")]
    _dtype: Option<String>,
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
                "expected Supertonic 3 graphs and metadata under {}",
                self.config.cache_dir.display()
            )));
        }

        let duration_predictor = build_session(&self.config.graph_path("duration_predictor"))?;
        let text_encoder = build_session(&self.config.graph_path("text_encoder"))?;
        let vector_estimator = build_session(&self.config.graph_path("vector_estimator"))?;
        let vocoder = build_session(&self.config.graph_path("vocoder"))?;
        let dp_outputs = output_names(&duration_predictor);
        let te_outputs = output_names(&text_encoder);
        let ve_outputs = output_names(&vector_estimator);
        let vocoder_outputs = output_names(&vocoder);
        let unicode_indexer = load_unicode_indexer(&self.config.unicode_indexer_path())?;

        Ok(Loaded {
            duration_predictor,
            text_encoder,
            vector_estimator,
            vocoder,
            dp_outputs,
            te_outputs,
            ve_outputs,
            vocoder_outputs,
            unicode_indexer,
        })
    }

    fn load_style(&self, voice: &str) -> SupertonicResult<StyleEmbeddings> {
        let voice = resolve_voice_id(voice);
        let path = self.config.style_path(voice);
        let bytes = std::fs::read(&path)
            .map_err(|e| SupertonicError::Voice(format!("read {}: {e}", path.display())))?;
        let style_file: StyleFile = serde_json::from_slice(&bytes)
            .map_err(|e| SupertonicError::Voice(format!("parse {}: {e}", path.display())))?;
        let ttl = flatten_style_tensor(
            &style_file.style_ttl,
            &[1, STYLE_TTL_SEQ, STYLE_TTL_DIM],
            "style_ttl",
        )?;
        let dp = flatten_style_tensor(
            &style_file.style_dp,
            &[1, STYLE_DP_SEQ, STYLE_DP_DIM],
            "style_dp",
        )?;
        Ok(StyleEmbeddings { ttl, dp })
    }

    /// Synthesize one sentence into mono f32 PCM at 44.1 kHz.
    pub fn synthesize(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> SupertonicResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
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
        let preprocessed = preprocess_text(trimmed, lang);
        let ids = tokenize_with_indexer(&preprocessed, &loaded.unicode_indexer);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let text_mask = vec![1.0_f32; ids.len()];

        run_pipeline(loaded, &ids, &text_mask, &style, speed)
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

fn flatten_style_tensor(
    tensor: &StyleTensor,
    expected_dims: &[usize],
    field: &str,
) -> SupertonicResult<Vec<f32>> {
    if tensor.dims.as_slice() != expected_dims {
        return Err(SupertonicError::Voice(format!(
            "{field} dims {:?}, expected {:?}",
            tensor.dims, expected_dims
        )));
    }
    let expected_len = expected_dims.iter().product();
    let mut data = Vec::with_capacity(expected_len);
    flatten_json_numbers(&tensor.data, &mut data).map_err(|e| {
        SupertonicError::Voice(format!("{field} contains non-float tensor data: {e}"))
    })?;
    if data.len() != expected_len {
        return Err(SupertonicError::Voice(format!(
            "{field} has {} floats, expected {expected_len}",
            data.len()
        )));
    }
    Ok(data)
}

fn flatten_json_numbers(value: &serde_json::Value, out: &mut Vec<f32>) -> Result<(), String> {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                flatten_json_numbers(value, out)?;
            }
            Ok(())
        }
        serde_json::Value::Number(n) => n
            .as_f64()
            .map(|v| out.push(v as f32))
            .ok_or_else(|| "number is not representable as f64".to_string()),
        other => Err(format!("unexpected JSON value {other}")),
    }
}

fn load_unicode_indexer(path: &Path) -> SupertonicResult<Vec<i64>> {
    let bytes = std::fs::read(path)
        .map_err(|e| SupertonicError::AssetsMissing(format!("read {}: {e}", path.display())))?;
    let indexer: Vec<i64> = serde_json::from_slice(&bytes)
        .map_err(|e| SupertonicError::AssetsMissing(format!("parse {}: {e}", path.display())))?;
    if indexer.len() != 65_536 {
        return Err(SupertonicError::AssetsMissing(format!(
            "{} has {} entries, expected 65536",
            path.display(),
            indexer.len()
        )));
    }
    Ok(indexer)
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

fn output_names(s: &ort::session::Session) -> Vec<String> {
    s.outputs().iter().map(|o| o.name().to_string()).collect()
}

fn out_idx(names: &[String], target: &str, default: usize) -> usize {
    names.iter().position(|n| n == target).unwrap_or(default)
}

fn clamp_supertonic_speed(speed: f32) -> f32 {
    if speed.is_finite() {
        speed.clamp(SPEED_MIN, SPEED_MAX)
    } else {
        1.0
    }
}

fn run_pipeline(
    loaded: &mut Loaded,
    ids: &[i64],
    text_mask: &[f32],
    style: &StyleEmbeddings,
    speed: f32,
) -> SupertonicResult<Vec<f32>> {
    use ort::value::Tensor;

    let text_len = ids.len();

    let duration_sec = {
        let text_ids = Tensor::from_array(([1usize, text_len], ids.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("text_ids(duration): {e}")))?;
        let style_dp = Tensor::from_array((
            [1usize, STYLE_DP_SEQ, STYLE_DP_DIM],
            style.dp.clone().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("style_dp: {e}")))?;
        let text_mask_t = Tensor::from_array((
            [1usize, 1usize, text_len],
            text_mask.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("text_mask(duration): {e}")))?;
        let out = loaded
            .duration_predictor
            .run(ort::inputs! {
                "text_ids" => text_ids,
                "style_dp" => style_dp,
                "text_mask" => text_mask_t,
            })
            .map_err(|e| SupertonicError::Inference(format!("duration_predictor: {e}")))?;
        let idx = out_idx(&loaded.dp_outputs, "duration", 0);
        let (_shape, duration) = out[idx]
            .try_extract_tensor::<f32>()
            .map_err(|e| SupertonicError::Inference(format!("extract duration: {e}")))?;
        let raw = duration.first().copied().unwrap_or(0.0);
        let factor = 1.0 / (clamp_supertonic_speed(speed) + SPEED_OFFSET);
        raw * factor
    };

    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return Err(SupertonicError::Inference(format!(
            "non-positive predicted duration {duration_sec}"
        )));
    }

    let (text_emb_shape, text_emb) = {
        let text_ids = Tensor::from_array(([1usize, text_len], ids.to_vec().into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("text_ids(encoder): {e}")))?;
        let style_ttl = Tensor::from_array((
            [1usize, STYLE_TTL_SEQ, STYLE_TTL_DIM],
            style.ttl.clone().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("style_ttl(encoder): {e}")))?;
        let text_mask_t = Tensor::from_array((
            [1usize, 1usize, text_len],
            text_mask.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("text_mask(encoder): {e}")))?;
        let out = loaded
            .text_encoder
            .run(ort::inputs! {
                "text_ids" => text_ids,
                "style_ttl" => style_ttl,
                "text_mask" => text_mask_t,
            })
            .map_err(|e| SupertonicError::Inference(format!("text_encoder: {e}")))?;
        let idx = out_idx(&loaded.te_outputs, "text_emb", 0);
        let (shape, data) = out[idx]
            .try_extract_tensor::<f32>()
            .map_err(|e| SupertonicError::Inference(format!("extract text_emb: {e}")))?;
        (
            shape.iter().map(|&d| d as usize).collect::<Vec<_>>(),
            data.to_vec(),
        )
    };

    let wav_len = (duration_sec * SUPERTONIC_SAMPLE_RATE as f32).floor() as usize;
    let wav_len = wav_len.max(1);
    let latent_len = ((wav_len + LATENT_SIZE - 1) / LATENT_SIZE).max(1);
    let latent_shape = vec![1usize, LATENT_CHANNELS, latent_len];
    let latent_mask_shape = vec![1usize, 1usize, latent_len];
    let latent_mask = vec![1.0_f32; latent_len];
    let mut g = Gauss::new(
        0x9E37_79B9_7F4A_7C15 ^ (text_len as u64).wrapping_mul(2_654_435_761) ^ (wav_len as u64),
    );
    let mut latent: Vec<f32> = (0..LATENT_CHANNELS * latent_len)
        .map(|_| g.next_normal())
        .collect();

    let denoised_idx = out_idx(&loaded.ve_outputs, "denoised_latent", 0);
    for step in 0..NUM_INFERENCE_STEPS {
        let noisy_latent =
            Tensor::from_array((latent_shape.clone(), latent.clone().into_boxed_slice()))
                .map_err(|e| SupertonicError::Inference(format!("noisy_latent: {e}")))?;
        let text_emb_t =
            Tensor::from_array((text_emb_shape.clone(), text_emb.clone().into_boxed_slice()))
                .map_err(|e| SupertonicError::Inference(format!("text_emb(input): {e}")))?;
        let style_ttl = Tensor::from_array((
            [1usize, STYLE_TTL_SEQ, STYLE_TTL_DIM],
            style.ttl.clone().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("style_ttl(vector): {e}")))?;
        let text_mask_t = Tensor::from_array((
            [1usize, 1usize, text_len],
            text_mask.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("text_mask(vector): {e}")))?;
        let latent_mask_t = Tensor::from_array((
            latent_mask_shape.clone(),
            latent_mask.clone().into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("latent_mask: {e}")))?;
        let total_step = Tensor::from_array((
            [1usize],
            vec![NUM_INFERENCE_STEPS as f32].into_boxed_slice(),
        ))
        .map_err(|e| SupertonicError::Inference(format!("total_step: {e}")))?;
        let current_step = Tensor::from_array(([1usize], vec![step as f32].into_boxed_slice()))
            .map_err(|e| SupertonicError::Inference(format!("current_step: {e}")))?;
        let out = loaded
            .vector_estimator
            .run(ort::inputs! {
                "noisy_latent" => noisy_latent,
                "text_emb" => text_emb_t,
                "style_ttl" => style_ttl,
                "text_mask" => text_mask_t,
                "latent_mask" => latent_mask_t,
                "total_step" => total_step,
                "current_step" => current_step,
            })
            .map_err(|e| {
                SupertonicError::Inference(format!("vector_estimator step {step}: {e}"))
            })?;
        let (_shape, denoised) = out[denoised_idx]
            .try_extract_tensor::<f32>()
            .map_err(|e| SupertonicError::Inference(format!("extract denoised_latent: {e}")))?;
        latent = denoised.to_vec();
    }

    let wav_idx = out_idx(&loaded.vocoder_outputs, "wav_tts", 0);
    let latent_t = Tensor::from_array((latent_shape, latent.into_boxed_slice()))
        .map_err(|e| SupertonicError::Inference(format!("latent(vocoder): {e}")))?;
    let out = loaded
        .vocoder
        .run(ort::inputs! { "latent" => latent_t })
        .map_err(|e| SupertonicError::Inference(format!("vocoder: {e}")))?;
    let (_shape, wav) = out[wav_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| SupertonicError::Inference(format!("extract wav_tts: {e}")))?;
    let trim_len = wav_len.min(wav.len());
    Ok(wav[..trim_len].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ascii_indexer() -> Vec<i64> {
        let mut indexer = vec![-1; 65_536];
        for code in 0..128 {
            indexer[code] = code as i64;
        }
        indexer
    }

    #[test]
    fn resolves_region_language_to_supertonic_code() {
        assert_eq!(resolve_language("en-us"), "en");
        assert_eq!(resolve_language("pt-BR"), "pt");
        assert_eq!(resolve_language("cmn"), "en");
        assert_eq!(resolve_language("ja"), "ja");
    }

    #[test]
    fn preprocesses_text_like_space() {
        let text = preprocess_text("Hi @ Sam -- okay", "en-us");
        assert_eq!(text, "<en>Hi at Sam -- okay.</en>");
    }

    #[test]
    fn tokenizer_uses_unicode_indexer_array() {
        let ids = tokenize_with_indexer("<en>Hi.</en>", &ascii_indexer());
        assert_eq!(
            ids,
            vec![60, 101, 110, 62, 72, 105, 46, 60, 47, 101, 110, 62]
        );
    }

    #[test]
    fn flatten_style_tensor_validates_dims_and_data() {
        let tensor = StyleTensor {
            data: serde_json::json!([[[1.0, 2.0], [3.0, 4.0]]]),
            dims: vec![1, 2, 2],
            _dtype: Some("float32".to_string()),
        };
        let data = flatten_style_tensor(&tensor, &[1, 2, 2], "style").unwrap();
        assert_eq!(data, vec![1.0, 2.0, 3.0, 4.0]);
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
