// Fun-CosyVoice3-0.5B-2512 (FunAudioLLM / Alibaba, Apache-2.0) — zero-shot voice cloning on
// ort 2.0. Faithful port of upstream `cosyvoice/cli/{frontend,model}.py` + `llm/llm.py`
// (`Qwen2LM.inference`) + `flow/flow.py` (`CausalMaskedDiffWithDiT.inference`) +
// `flow/flow_matching.py` (`CausalConditionalCFM`) + `hifigan/generator.py`
// (`CausalHiFTGenerator.inference`), run over the graphs published at
// `Masterx/Fun-CosyVoice3-0.5B-2512-ONNX` (the LLM is the RL-tuned `llm.rl.pt`).
//
// Graph split (all `[batch=1]`):
//   text_embedding_fp16   input_ids[1,S] i64                → inputs_embeds[1,S,896]
//   speech_embedding      input_ids[1,S] i64                → inputs_embeds[1,S,896]
//   llm_<quant>           inputs_embeds + attention_mask + position_ids + 48 past K/V
//                           → logits[1,6761] (LAST position only) + 48 present K/V
//   flow_encoder          token[1,T] i64 + embedding[1,192] → mu[1,80,2T] + spks[1,80]
//   flow_estimator        x,mask,mu,t,spks,cond (batch 2 = CFG) → velocity[2,80,F]
//   hift                  speech_feat[1,80,F] + noise[1,480F,9] → magnitude/phase[1,9,120F+1]
//   campplus              kaldi fbank[1,T,80]               → speaker embedding[1,192]
//   speech_tokenizer_v3   whisper log-mel[1,128,T] + len    → speech tokens[1,T/4]
//
// What runs HERE in Rust rather than in a graph: the three audio front-ends (Whisper
// 128-bin log-mel, Kaldi fbank, Matcha 80-bin log-mel), prompt assembly, Repetition-Aware
// Sampling, the 10-step Euler ODE with classifier-free guidance, the optional speed
// resample of the mel, and the n_fft=16 / hop=4 iSTFT that turns HiFT's magnitude+phase
// into 24 kHz audio (ONNX has no usable inverse STFT).
//
// Cloning: the reference clip is tokenized ONCE (speech tokens + speaker embedding + 24 kHz
// mel) and cached in memory and on disk, so the 0.9 GB speech tokenizer is loaded on demand
// and dropped right after. A transcript is OPTIONAL: with one, the LLM is primed with the
// reference text + its speech tokens (upstream `inference_zero_shot`, best similarity);
// without one it runs upstream's `inference_cross_lingual` path (the voice still comes from
// the flow prompt). A style instruction switches to `inference_instruct2`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ndarray::Array3;
use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor};
use rustfft::FftPlanner;
use rustfft::num_complex::Complex;
use tokenizers::Tokenizer;

use super::provider::{TtsOrtProviderPolicy, build_session, cpu_session_with_intra_threads};
use super::sampling::{SplitMix64Rng, UniformF64, sample_categorical, softmax};
use super::types::TtsDevice;

pub const COSYVOICE3_SAMPLE_RATE: u32 = 24_000;
/// Speech-tokenizer / speaker-encoder input rate.
pub const COSYVOICE3_FRONTEND_RATE: u32 = 16_000;
/// Upstream asserts the reference is at most 30 s (`_extract_speech_token`).
pub const COSYVOICE3_MAX_REF_SECS: u32 = 30;

// --- token ids (CosyVoice3LM: speech_token_size = 6561, llm_decoder = 6561 + 200) ---
const SPEECH_TOKEN_SIZE: usize = 6561;
const SOS_TOKEN: i64 = SPEECH_TOKEN_SIZE as i64; // speech_embedding row for <sos>
const TASK_ID_TOKEN: i64 = SPEECH_TOKEN_SIZE as i64 + 2; // speech_embedding row for <task_id>
/// `<|endofprompt|>` in the CosyVoice3 Qwen tokenizer (upstream asserts its presence).
const END_OF_PROMPT_ID: u32 = 151_646;
/// Upstream's fixed system prefix (example.py + `instruct_list`).
const SYSTEM_PROMPT: &str = "You are a helpful assistant.";
const END_OF_PROMPT: &str = "<|endofprompt|>";

// --- LLM decode budget (Qwen2LM.inference defaults) ---
const MIN_TOKEN_TEXT_RATIO: f64 = 2.0;
const MAX_TOKEN_TEXT_RATIO: f64 = 20.0;
// --- RAS sampling (cosyvoice3.yaml `ras_sampling`) ---
const TOP_P: f64 = 0.8;
const TOP_K: usize = 25;
const RAS_WIN: usize = 10;
const RAS_TAU: f64 = 0.1;
/// FSQ silence/breath tokens: at most MAX_SILENT consecutive ones reach the flow.
const SILENT_TOKENS: [i64; 11] = [1, 2, 28, 29, 55, 248, 494, 2241, 2242, 2322, 2323];
const MAX_SILENT: usize = 5;

// --- flow matching ---
const MEL_BINS: usize = 80;
const TOKEN_MEL_RATIO: usize = 2;
const N_TIMESTEPS: usize = 10;
const CFG_RATE: f32 = 0.7;
const SPK_DIM: usize = 192;

// --- HiFT / iSTFT ---
const HOP_SAMPLES: usize = 480; // 24 kHz samples per mel frame (prod(upsample_rates) * hop)
const ISTFT_N_FFT: usize = 16;
const ISTFT_HOP: usize = 4;
const HARMONICS: usize = 9; // nb_harmonics + 1
const AUDIO_LIMIT: f32 = 0.99;

#[derive(Debug, thiserror::Error)]
pub enum CosyVoice3Error {
    #[error("CosyVoice3 assets missing: {0}")]
    AssetsMissing(String),
    #[error("CosyVoice3 session error: {0}")]
    Session(String),
    #[error("CosyVoice3 tokenizer error: {0}")]
    Tokenizer(String),
    #[error("CosyVoice3 reference error: {0}")]
    Reference(String),
    #[error("CosyVoice3 inference error: {0}")]
    Inference(String),
    #[error("cancelled")]
    Cancelled,
}
pub type CosyVoice3Result<T> = Result<T, CosyVoice3Error>;

fn inf<E: std::fmt::Display>(ctx: &'static str) -> impl FnOnce(E) -> CosyVoice3Error {
    move |e| CosyVoice3Error::Inference(format!("{ctx}: {e}"))
}

/// The per-quant graph filenames (relative to the model dir). Built by
/// `catalog::cosyvoice3_graph_set` so the download manifest and the loader agree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CosyVoice3Files {
    pub llm: &'static str,
    pub estimator: &'static str,
}

/// Bare inline paralinguistic tags (square-bracket syntax) — the event tokens upstream's
/// `CosyVoice3Tokenizer` registers as special tokens and the model card demonstrates.
pub const COSYVOICE3_TAGS: &[&str] = &[
    "breath",
    "quick_breath",
    "laughter",
    "sigh",
    "cough",
    "lipsmack",
    "noise",
];

/// A built-in reference voice shipped in the model repo (`voices/<id>.wav`).
#[derive(Clone, Copy, Debug)]
pub struct BuiltinVoice {
    pub id: &'static str,
    /// Exact transcript of the clip (enables the zero-shot prompt mode).
    pub transcript: &'static str,
}

/// Built-in reference clips: `zh-female` is upstream's `asset/zero_shot_prompt.wav` (Apache-2.0);
/// `en-male` is LibriTTS-R test-clean `8224_274384_000016_000000` (CC BY 4.0, 24 kHz).
pub const COSYVOICE3_BUILTIN_VOICES: &[BuiltinVoice] = &[
    BuiltinVoice {
        id: "zh-female",
        transcript: "希望你以后能够做的比我还好呦。",
    },
    BuiltinVoice {
        id: "en-male",
        transcript: "The marquis of Worcester, a man past eighty-four, was the last in England that submitted to the authority of the parliament.",
    },
];

pub fn builtin_voice(id: &str) -> Option<&'static BuiltinVoice> {
    COSYVOICE3_BUILTIN_VOICES.iter().find(|v| v.id == id)
}

pub fn builtin_voice_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("voices").join(format!("{id}.wav"))
}

// ---------------------------------------------------------------------------------------------
// Voice prompt (cached per reference clip)
// ---------------------------------------------------------------------------------------------

/// Everything the synthesis path needs from a reference clip.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VoicePrompt {
    /// Normalized transcript ("" = none → cross-lingual mode).
    pub transcript: String,
    /// Speech tokens of the clip (25 Hz), already aligned to `feat`.
    pub speech_tokens: Vec<i64>,
    /// 24 kHz Matcha log-mel, row-major `[frames, 80]`, `frames == 2 * speech_tokens.len()`.
    pub feat: Vec<f32>,
    /// CAM++ speaker embedding (192).
    pub embedding: Vec<f32>,
}

impl VoicePrompt {
    pub fn frames(&self) -> usize {
        self.feat.len() / MEL_BINS
    }

    fn validate(&self) -> CosyVoice3Result<()> {
        if self.embedding.len() != SPK_DIM
            || !self.feat.len().is_multiple_of(MEL_BINS)
            || self.frames() != TOKEN_MEL_RATIO * self.speech_tokens.len()
            || self.speech_tokens.is_empty()
        {
            return Err(CosyVoice3Error::Reference(
                "cached voice prompt has inconsistent shapes".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct PromptKey {
    path: PathBuf,
    len: u64,
    modified_ns: u128,
    transcript: String,
}

impl PromptKey {
    fn for_clip(path: &Path, transcript: &str) -> Self {
        let meta = std::fs::metadata(path).ok();
        Self {
            path: path.to_path_buf(),
            len: meta.as_ref().map_or(0, std::fs::Metadata::len),
            modified_ns: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos()),
            transcript: transcript.to_string(),
        }
    }

    fn hash_hex(&self) -> String {
        // FNV-1a over the key fields — stable across runs (std's SipHash is randomly keyed).
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for b in bytes {
                h ^= u64::from(*b);
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        feed(self.path.to_string_lossy().as_bytes());
        feed(&self.len.to_le_bytes());
        feed(&self.modified_ns.to_le_bytes());
        feed(self.transcript.as_bytes());
        format!("{h:016x}")
    }
}

// ---------------------------------------------------------------------------------------------
// Synthesis request
// ---------------------------------------------------------------------------------------------

/// How the LLM is prompted (upstream's three zero-shot entry points).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptMode {
    /// `inference_zero_shot`: reference transcript + reference speech tokens prime the LLM.
    ZeroShot,
    /// `inference_cross_lingual`: no transcript; only the flow sees the reference.
    CrossLingual,
    /// `inference_instruct2`: a style instruction replaces the transcript.
    Instruct,
}

/// Coarse writing-system family, used to spot a reference clip and a target text in
/// different languages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScriptFamily {
    /// Any kana (Japanese; kanji alone reads as Han).
    Kana,
    Hangul,
    /// Han without kana (Chinese).
    Han,
    Cyrillic,
    Latin,
}

fn script_family(text: &str) -> Option<ScriptFamily> {
    let (mut kana, mut hangul, mut han, mut cyrillic, mut latin) =
        (false, false, false, false, false);
    for c in text.chars() {
        let u = u32::from(c);
        kana |= (0x3040..=0x30FF).contains(&u);
        hangul |= (0xAC00..=0xD7AF).contains(&u) || (0x1100..=0x11FF).contains(&u);
        han |= (0x3400..=0x9FFF).contains(&u) || (0xF900..=0xFAFF).contains(&u);
        cyrillic |= (0x0400..=0x04FF).contains(&u);
        latin |= c.is_alphabetic() && u < 0x0250;
    }
    [
        (kana, ScriptFamily::Kana),
        (hangul, ScriptFamily::Hangul),
        (han, ScriptFamily::Han),
        (cyrillic, ScriptFamily::Cyrillic),
        (latin, ScriptFamily::Latin),
    ]
    .into_iter()
    .find_map(|(seen, family)| seen.then_some(family))
}

/// Zero-shot (transcript-conditioned) prompting makes the LLM continue the reference
/// utterance, which carries its accent across languages: the bundled Mandarin clip read
/// German at 25% WER that way (vs 2% for the English clip). When the reference transcript
/// and `text` are in different script families, fall back to upstream's cross-lingual mode
/// (no prompt text / tokens; the flow still clones the timbre).
pub fn prompt_mode(prompt: &VoicePrompt, instruct: Option<&str>, text: &str) -> PromptMode {
    if instruct.is_some_and(|s| !s.trim().is_empty()) {
        return PromptMode::Instruct;
    }
    if prompt.transcript.trim().is_empty() {
        return PromptMode::CrossLingual;
    }
    match (script_family(&prompt.transcript), script_family(text)) {
        (Some(a), Some(b)) if a != b => PromptMode::CrossLingual,
        _ => PromptMode::ZeroShot,
    }
}

/// The two text segments fed to the LLM, as strings: `(prompt_text, tts_text)`.
/// Upstream concatenates them (`text = concat(prompt_text, text)`) and budgets the decode
/// by the token count of `tts_text` alone.
pub fn llm_text_segments(
    mode: PromptMode,
    transcript: &str,
    instruct: Option<&str>,
    text: &str,
) -> (String, String) {
    match mode {
        PromptMode::ZeroShot => (
            format!("{SYSTEM_PROMPT}{END_OF_PROMPT}{}", transcript.trim()),
            text.to_string(),
        ),
        // cross-lingual puts the system prompt INSIDE tts_text (example.py), so it counts
        // towards the min/max length budget exactly as upstream.
        PromptMode::CrossLingual => (
            String::new(),
            format!("{SYSTEM_PROMPT}{END_OF_PROMPT}{text}"),
        ),
        PromptMode::Instruct => {
            let ins = instruct.unwrap_or("").trim();
            let ins = ins.strip_suffix(END_OF_PROMPT).unwrap_or(ins).trim();
            (
                format!("{SYSTEM_PROMPT} {ins}{END_OF_PROMPT}"),
                text.to_string(),
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Text frontend (upstream `text_normalize` minus wetext/ttsfrd)
// ---------------------------------------------------------------------------------------------

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// Light, dependency-free port of upstream's fallback text normalization (the path taken
/// when neither ttsfrd nor wetext is installed). CosyVoice3 reads numbers/symbols itself.
pub fn normalize_text(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    // SSML-like control tokens bypass the frontend upstream.
    if text.contains("<|") && text.contains("|>") {
        return text.to_string();
    }
    let chinese = text.chars().any(is_cjk);
    let mut out: String;
    if chinese {
        let t = text.replace('\n', "");
        let t = replace_blank(&t);
        let t = t.replace('²', "平方").replace('³', "立方");
        // `.` → `。` except inside numbers (upstream runs wetext first, which has already
        // spelled decimals out; we have no TN, so keep `3.5` intact).
        let chars: Vec<char> = t.chars().collect();
        let mut s = String::with_capacity(t.len());
        for (i, &c) in chars.iter().enumerate() {
            let between_digits = i > 0
                && i + 1 < chars.len()
                && chars[i - 1].is_ascii_digit()
                && chars[i + 1].is_ascii_digit();
            if c == '.' && !between_digits {
                s.push('。');
            } else {
                s.push(c);
            }
        }
        let s = s.replace(" - ", "，");
        let s = s
            .replace(['（', '）', '【', '】', '`'], "")
            .replace("——", " ");
        out = s.trim_end_matches(['，', ',', '、']).to_string();
        if out.len() != s.len() {
            out.push('。');
        }
        if !out.ends_with(['。', '？', '！', '；', '：', '、', '.', '?', '!', ';']) {
            out.push('。');
        }
    } else {
        out = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !out.ends_with(['.', '?', '!', ';', ':', '"', '”', '\'', ')']) {
            out.push('.');
        }
    }
    out
}

/// Upstream `replace_blank`: drop a space unless it sits between two non-space ASCII chars.
fn replace_blank(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == ' ' {
            let next = chars.get(i + 1).copied();
            let prev = if i > 0 {
                chars.get(i - 1).copied()
            } else {
                None
            };
            let keep = matches!(next, Some(n) if n.is_ascii() && n != ' ')
                && matches!(prev, Some(p) if p.is_ascii() && p != ' ');
            if keep {
                out.push(c);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// True when the text has nothing speakable (upstream `is_only_punctuation`).
pub fn is_only_punctuation(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_whitespace() || c.is_ascii_punctuation() || (!c.is_alphanumeric()))
}

// ---------------------------------------------------------------------------------------------
// Repetition-Aware Sampling (cosyvoice/utils/common.py `ras_sampling`)
// ---------------------------------------------------------------------------------------------

/// One RAS draw over the LLM's logits row. `ignore_eos` masks ONLY `speech_token_size`
/// (upstream `sampling_ids`), exactly like the reference.
pub fn ras_sample<R: UniformF64>(
    logits: &[f32],
    decoded: &[i64],
    ignore_eos: bool,
    rng: &mut R,
) -> usize {
    let mut scores: Vec<f64> = logits.iter().map(|&v| f64::from(v)).collect();
    if ignore_eos && SPEECH_TOKEN_SIZE < scores.len() {
        scores[SPEECH_TOKEN_SIZE] = f64::NEG_INFINITY;
    }
    let top = nucleus_sample(&scores, TOP_P, TOP_K, rng);
    let window = &decoded[decoded.len().saturating_sub(RAS_WIN)..];
    let rep = window.iter().filter(|&&t| t == top as i64).count();
    if rep as f64 >= RAS_WIN as f64 * RAS_TAU {
        scores[top] = f64::NEG_INFINITY;
        let probs = softmax(&scores);
        return sample_categorical(&probs, rng);
    }
    top
}

fn nucleus_sample<R: UniformF64>(scores: &[f64], top_p: f64, top_k: usize, rng: &mut R) -> usize {
    let probs = softmax(scores);
    let mut order: Vec<usize> = (0..probs.len()).collect();
    // stable descending sort (torch `sort(descending=True, stable=True)`)
    order.sort_by(|&a, &b| {
        probs[b]
            .partial_cmp(&probs[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<(usize, f64)> = Vec::with_capacity(top_k);
    let mut cum = 0.0f64;
    for &i in &order {
        if cum < top_p && kept.len() < top_k {
            cum += probs[i];
            kept.push((i, probs[i]));
        } else {
            break;
        }
    }
    let total: f64 = kept.iter().map(|(_, p)| p).sum();
    if kept.is_empty() || total <= 0.0 {
        return order.first().copied().unwrap_or(0);
    }
    let norm: Vec<f64> = kept.iter().map(|(_, p)| p / total).collect();
    kept[sample_categorical(&norm, rng)].0
}

// ---------------------------------------------------------------------------------------------
// Audio front-ends
// ---------------------------------------------------------------------------------------------

/// `whisper.log_mel_spectrogram(audio, n_mels=128)` for 16 kHz audio. Returns row-major
/// `[128, frames]` with `frames = len / 160`.
pub fn whisper_log_mel_128(audio: &[f32]) -> (Vec<f32>, usize) {
    const N_FFT: usize = 400;
    const HOP: usize = 160;
    const N_MELS: usize = 128;
    let n_freqs = N_FFT / 2 + 1;
    let frames = audio.len() / HOP; // stft(center=True) gives len/HOP + 1, last dropped
    if frames == 0 {
        return (Vec::new(), 0);
    }
    let padded = reflect_pad(audio, N_FFT / 2, N_FFT / 2);
    let window: Vec<f32> = (0..N_FFT)
        .map(|n| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / N_FFT as f32).cos()))
        .collect();
    let fb = crate::winstt::stt::mel::slaney_mel_filterbank(n_freqs, 0.0, 8000.0, N_MELS, 16_000);
    let power = stft_power(&padded, &window, N_FFT, HOP, frames);
    let mut log_spec = vec![0f32; N_MELS * frames];
    let mut max = f32::NEG_INFINITY;
    for t in 0..frames {
        let row = &power[t * n_freqs..(t + 1) * n_freqs];
        for m in 0..N_MELS {
            let mut acc = 0f32;
            for (f, &p) in row.iter().enumerate() {
                acc += p * fb[f * N_MELS + m];
            }
            let v = acc.max(1e-10).log10();
            max = max.max(v);
            log_spec[m * frames + t] = v;
        }
    }
    for v in &mut log_spec {
        *v = (v.max(max - 8.0) + 4.0) / 4.0;
    }
    (log_spec, frames)
}

/// `torchaudio.compliance.kaldi.fbank(num_mel_bins=80, dither=0, sample_frequency=16000)`
/// followed by upstream's per-utterance mean subtraction. Row-major `[frames, 80]`.
pub fn kaldi_fbank_80(audio: &[f32]) -> (Vec<f32>, usize) {
    const WIN: usize = 400;
    const HOP: usize = 160;
    const N_FFT: usize = 512;
    const N_MELS: usize = 80;
    if audio.len() < WIN {
        return (Vec::new(), 0);
    }
    let frames = 1 + (audio.len() - WIN) / HOP;
    // povey window: hann(400, periodic=False) ** 0.85
    let window: Vec<f32> = (0..WIN)
        .map(|n| {
            (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (WIN - 1) as f64).cos())
                .powf(0.85) as f32
        })
        .collect();
    let bins = kaldi_mel_banks(N_MELS, N_FFT, 16_000.0, 20.0, 8_000.0);
    let n_freqs = N_FFT / 2 + 1;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buf = vec![Complex::new(0f32, 0f32); N_FFT];
    let mut raw = vec![0f32; WIN];
    let mut out = vec![0f32; frames * N_MELS];
    for t in 0..frames {
        raw.copy_from_slice(&audio[t * HOP..t * HOP + WIN]);
        let mean = raw.iter().sum::<f32>() / WIN as f32;
        for v in &mut raw {
            *v -= mean;
        }
        for c in buf.iter_mut() {
            *c = Complex::new(0.0, 0.0);
        }
        for i in (0..WIN).rev() {
            let prev = if i == 0 { raw[0] } else { raw[i - 1] };
            buf[i] = Complex::new((raw[i] - 0.97 * prev) * window[i], 0.0);
        }
        fft.process(&mut buf);
        for m in 0..N_MELS {
            let mut acc = 0f32;
            for f in 0..n_freqs {
                let w = bins[m * n_freqs + f];
                if w != 0.0 {
                    acc += buf[f].norm_sqr() * w;
                }
            }
            out[t * N_MELS + m] = acc.max(f32::EPSILON).ln();
        }
    }
    // feat - feat.mean(dim=0)
    for m in 0..N_MELS {
        let mean = (0..frames).map(|t| out[t * N_MELS + m]).sum::<f32>() / frames as f32;
        for t in 0..frames {
            out[t * N_MELS + m] -= mean;
        }
    }
    (out, frames)
}

/// torchaudio `get_mel_banks` (kaldi mel scale, no area normalization), padded with the
/// Nyquist column. Row-major `[n_mels, n_fft/2 + 1]`.
fn kaldi_mel_banks(n_mels: usize, n_fft: usize, sr: f64, low: f64, high: f64) -> Vec<f32> {
    let mel = |f: f64| 1127.0 * (1.0 + f / 700.0).ln();
    let num_fft_bins = n_fft / 2;
    let fft_bin_width = sr / n_fft as f64;
    let mel_low = mel(low);
    let mel_high = mel(high);
    let delta = (mel_high - mel_low) / (n_mels as f64 + 1.0);
    let mut out = vec![0f32; n_mels * (num_fft_bins + 1)];
    for m in 0..n_mels {
        let left = mel_low + m as f64 * delta;
        let center = mel_low + (m as f64 + 1.0) * delta;
        let right = mel_low + (m as f64 + 2.0) * delta;
        for k in 0..num_fft_bins {
            let f = mel(fft_bin_width * k as f64);
            let up = (f - left) / (center - left);
            let down = (right - f) / (right - center);
            out[m * (num_fft_bins + 1) + k] = up.min(down).max(0.0) as f32;
        }
    }
    out
}

/// `matcha.utils.audio.mel_spectrogram` with the cosyvoice3.yaml params (n_fft 1920,
/// hop 480, win 1920, 80 mels, fmin 0, fmax 12 kHz, center=False after a (n_fft-hop)/2
/// reflect pad, magnitude `sqrt(p + 1e-9)`, `ln(clamp(1e-5))`). Row-major `[frames, 80]`.
pub fn matcha_mel_80(audio: &[f32]) -> (Vec<f32>, usize) {
    const N_FFT: usize = 1920;
    const HOP: usize = 480;
    let pad = (N_FFT - HOP) / 2;
    if audio.len() <= pad {
        return (Vec::new(), 0);
    }
    let padded = reflect_pad(audio, pad, pad);
    if padded.len() < N_FFT {
        return (Vec::new(), 0);
    }
    let frames = 1 + (padded.len() - N_FFT) / HOP;
    let window: Vec<f32> = (0..N_FFT)
        .map(|n| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / N_FFT as f32).cos()))
        .collect();
    let n_freqs = N_FFT / 2 + 1;
    let fb =
        crate::winstt::stt::mel::slaney_mel_filterbank(n_freqs, 0.0, 12_000.0, MEL_BINS, 24_000);
    let power = stft_power(&padded, &window, N_FFT, HOP, frames);
    let mut out = vec![0f32; frames * MEL_BINS];
    for t in 0..frames {
        let row = &power[t * n_freqs..(t + 1) * n_freqs];
        for m in 0..MEL_BINS {
            let mut acc = 0f32;
            for (f, &p) in row.iter().enumerate() {
                let w = fb[f * MEL_BINS + m];
                if w != 0.0 {
                    acc += (p + 1e-9).sqrt() * w;
                }
            }
            out[t * MEL_BINS + m] = acc.max(1e-5).ln();
        }
    }
    (out, frames)
}

/// numpy/torch `reflect` padding (edge sample not repeated).
fn reflect_pad(x: &[f32], left: usize, right: usize) -> Vec<f32> {
    let n = x.len();
    let mut out = Vec::with_capacity(n + left + right);
    let reflect = |i: isize| -> f32 {
        if n == 1 {
            return x[0];
        }
        let period = 2 * (n as isize - 1);
        let mut j = i.rem_euclid(period);
        if j >= n as isize {
            j = period - j;
        }
        x[j as usize]
    };
    for i in (1..=left as isize).rev() {
        out.push(reflect(-i));
    }
    out.extend_from_slice(x);
    for i in 0..right as isize {
        out.push(reflect(n as isize + i));
    }
    out
}

/// Power spectrum `|X|^2` of `frames` windowed frames (row-major `[frames, n_fft/2+1]`).
fn stft_power(padded: &[f32], window: &[f32], n_fft: usize, hop: usize, frames: usize) -> Vec<f32> {
    let n_freqs = n_fft / 2 + 1;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let mut buf = vec![Complex::new(0f32, 0f32); n_fft];
    let mut out = vec![0f32; frames * n_freqs];
    for t in 0..frames {
        let start = t * hop;
        for (i, c) in buf.iter_mut().enumerate() {
            let s = padded.get(start + i).copied().unwrap_or(0.0);
            *c = Complex::new(s * window[i], 0.0);
        }
        fft.process(&mut buf);
        for f in 0..n_freqs {
            out[t * n_freqs + f] = buf[f].norm_sqr();
        }
    }
    out
}

/// `torch.istft(n_fft=16, hop=4, win=hann(16), center=True)` of `mag * e^{i*phase}` with
/// upstream's `clip(mag, max=1e2)`. Inputs are row-major `[9, frames]`; returns
/// `hop * (frames - 1)` samples.
pub fn istft(magnitude: &[f32], phase: &[f32], frames: usize) -> Vec<f32> {
    let n_fft = ISTFT_N_FFT;
    let hop = ISTFT_HOP;
    let n_freqs = n_fft / 2 + 1;
    if frames == 0 {
        return Vec::new();
    }
    let window: Vec<f32> = (0..n_fft)
        .map(|n| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / n_fft as f32).cos()))
        .collect();
    let full_len = n_fft + hop * (frames - 1);
    let mut y = vec![0f32; full_len];
    let mut env = vec![0f32; full_len];
    let mut planner = FftPlanner::<f32>::new();
    let ifft = planner.plan_fft_inverse(n_fft);
    let mut buf = vec![Complex::new(0f32, 0f32); n_fft];
    for t in 0..frames {
        for k in 0..n_freqs {
            let m = magnitude[k * frames + t].min(1e2);
            let p = phase[k * frames + t];
            buf[k] = Complex::new(m * p.cos(), m * p.sin());
        }
        // Hermitian completion (irfft ignores the imaginary part of DC / Nyquist).
        buf[0].im = 0.0;
        buf[n_fft / 2].im = 0.0;
        for k in 1..n_fft / 2 {
            buf[n_fft - k] = buf[k].conj();
        }
        ifft.process(&mut buf);
        let start = t * hop;
        for i in 0..n_fft {
            let w = window[i];
            y[start + i] += buf[i].re / n_fft as f32 * w;
            env[start + i] += w * w;
        }
    }
    let pad = n_fft / 2;
    let out_len = hop * (frames - 1);
    (0..out_len)
        .map(|i| {
            let e = env[pad + i];
            if e > 1e-11 { y[pad + i] / e } else { 0.0 }
        })
        .collect()
}

/// `F.interpolate(mel, size=int(T/speed), mode='linear')` (align_corners=False) on a
/// row-major `[80, T]` mel.
pub fn resample_mel(mel: &[f32], frames: usize, speed: f32) -> (Vec<f32>, usize) {
    let out_frames = ((frames as f64) / f64::from(speed)) as usize;
    if out_frames == 0 || frames == 0 {
        return (Vec::new(), 0);
    }
    let scale = frames as f64 / out_frames as f64;
    let mut out = vec![0f32; MEL_BINS * out_frames];
    for j in 0..out_frames {
        let src = ((j as f64 + 0.5) * scale - 0.5).max(0.0);
        let i0 = (src.floor() as usize).min(frames - 1);
        let i1 = (i0 + 1).min(frames - 1);
        let w = (src - i0 as f64) as f32;
        for m in 0..MEL_BINS {
            let a = mel[m * frames + i0];
            let b = mel[m * frames + i1];
            out[m * out_frames + j] = a + (b - a) * w;
        }
    }
    (out, out_frames)
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

struct KvLayout {
    past_names: Vec<String>,
    present_names: Vec<String>,
    heads: usize,
    head_dim: usize,
    dtype_f16: bool,
}

pub struct CosyVoice3Engine {
    dir: PathBuf,
    tokenizer: Tokenizer,
    text_embed: Session,
    speech_embed: Session,
    llm: Session,
    kv: KvLayout,
    flow_encoder: Session,
    estimator: Session,
    estimator_f16: bool,
    hift: Session,
    prompts: HashMap<PromptKey, Arc<VoicePrompt>>,
    rng: SplitMix64Rng,
}

fn intra_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .clamp(1, 8)
}

fn cpu(path: &Path) -> CosyVoice3Result<Session> {
    if !path.is_file() {
        return Err(CosyVoice3Error::AssetsMissing(path.display().to_string()));
    }
    cpu_session_with_intra_threads(
        path,
        "CosyVoice3 LLM/front-end graphs run on CPU (host-side KV cache)",
        "cosyvoice3",
        intra_threads(),
    )
    .map_err(CosyVoice3Error::Session)
}

fn device_session(path: &Path, device: TtsDevice) -> CosyVoice3Result<Session> {
    if !path.is_file() {
        return Err(CosyVoice3Error::AssetsMissing(path.display().to_string()));
    }
    if matches!(device, TtsDevice::Cpu) {
        return cpu(path);
    }
    build_session(
        path,
        device,
        TtsOrtProviderPolicy::FollowDevice,
        "cosyvoice3",
    )
    .map(|(s, providers)| {
        log::info!(
            "[tts] cosyvoice3 {} on {providers:?}",
            path.file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        );
        s
    })
    .map_err(CosyVoice3Error::Session)
}

fn input_is_f16(session: &Session, name: &str) -> bool {
    session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .is_some_and(|i| format!("{:?}", i.dtype()).contains("Float16"))
}

impl CosyVoice3Engine {
    /// Load the synthesis graphs. The two prompt encoders (CAM++ + the 0.9 GB speech
    /// tokenizer) are opened on demand by [`Self::ensure_prompt`].
    pub fn load(dir: &Path, files: &CosyVoice3Files, device: TtsDevice) -> CosyVoice3Result<Self> {
        let tokenizer_path = dir.join("tokenizer.json");
        if !tokenizer_path.is_file() {
            return Err(CosyVoice3Error::AssetsMissing(
                tokenizer_path.display().to_string(),
            ));
        }
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| CosyVoice3Error::Tokenizer(e.to_string()))?;
        let text_embed = cpu(&dir.join("text_embedding_fp16.onnx"))?;
        let speech_embed = cpu(&dir.join("speech_embedding.onnx"))?;
        let llm = cpu(&dir.join(files.llm))?;
        let flow_encoder = cpu(&dir.join("flow_encoder.onnx"))?;
        let estimator = device_session(&dir.join(files.estimator), device)?;
        let hift = device_session(&dir.join("hift.onnx"), device)?;

        let mut past_names = Vec::new();
        for i in llm.inputs() {
            if i.name().starts_with("past_key_values.") {
                past_names.push(i.name().to_string());
            }
        }
        let present_names: Vec<String> = past_names
            .iter()
            .map(|n| n.replacen("past_key_values.", "present.", 1))
            .collect();
        if past_names.is_empty() {
            return Err(CosyVoice3Error::Session(
                "llm graph has no KV inputs".into(),
            ));
        }
        let kv = KvLayout {
            dtype_f16: input_is_f16(&llm, &past_names[0]),
            past_names,
            present_names,
            heads: 2,
            head_dim: 64,
        };
        let estimator_f16 = input_is_f16(&estimator, "x");
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0x5eed, |d| d.as_nanos() as u64);
        Ok(Self {
            dir: dir.to_path_buf(),
            tokenizer,
            text_embed,
            speech_embed,
            llm,
            kv,
            flow_encoder,
            estimator,
            estimator_f16,
            hift,
            prompts: HashMap::new(),
            rng: SplitMix64Rng::new(seed),
        })
    }

    /// Reseed the sampler + noise (tests / reproducible renders).
    pub fn set_seed(&mut self, seed: u64) {
        self.rng = SplitMix64Rng::new(seed);
    }

    // -----------------------------------------------------------------------------------------
    // reference prompt
    // -----------------------------------------------------------------------------------------

    /// Tokenize a reference clip once (memory + disk cache). `decode(rate)` must return the
    /// clip as mono f32 at `rate` (capped at 30 s); it is only called on a cache miss.
    pub fn ensure_prompt(
        &mut self,
        clip_path: &Path,
        transcript: &str,
        decode: impl Fn(u32) -> Result<Vec<f32>, String>,
    ) -> CosyVoice3Result<Arc<VoicePrompt>> {
        let transcript = if transcript.trim().is_empty() {
            String::new()
        } else {
            normalize_text(transcript)
        };
        let key = PromptKey::for_clip(clip_path, &transcript);
        if let Some(p) = self.prompts.get(&key) {
            return Ok(p.clone());
        }
        let disk = self
            .dir
            .join("reference_cache")
            .join(format!("{}.cosyvoice3-ref.json", key.hash_hex()));
        if let Some(p) = std::fs::read_to_string(&disk)
            .ok()
            .and_then(|s| serde_json::from_str::<VoicePrompt>(&s).ok())
            .filter(|p| p.validate().is_ok() && p.transcript == transcript)
        {
            let p = Arc::new(p);
            self.remember(key, p.clone());
            return Ok(p);
        }
        let audio16 = decode(COSYVOICE3_FRONTEND_RATE).map_err(CosyVoice3Error::Reference)?;
        let audio24 = decode(COSYVOICE3_SAMPLE_RATE).map_err(CosyVoice3Error::Reference)?;
        let prompt = self.extract_prompt(&audio16, &audio24, transcript)?;
        if let Some(parent) = disk.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&prompt) {
            let _ = std::fs::write(&disk, json);
        }
        let p = Arc::new(prompt);
        self.remember(key, p.clone());
        Ok(p)
    }

    fn remember(&mut self, key: PromptKey, prompt: Arc<VoicePrompt>) {
        if self.prompts.len() >= 8 {
            self.prompts.clear();
        }
        self.prompts.insert(key, prompt);
    }

    /// upstream `frontend_zero_shot` minus the text: speech tokens, CAM++ embedding and the
    /// 24 kHz mel, trimmed so `feat_frames == 2 * tokens`.
    pub fn extract_prompt(
        &self,
        audio16: &[f32],
        audio24: &[f32],
        transcript: String,
    ) -> CosyVoice3Result<VoicePrompt> {
        if audio16.len() < COSYVOICE3_FRONTEND_RATE as usize / 2 {
            return Err(CosyVoice3Error::Reference(
                "reference clip is too short".into(),
            ));
        }
        // 1. speech tokens
        let (mel, frames) = whisper_log_mel_128(audio16);
        let mut tokenizer = cpu(&self.dir.join("speech_tokenizer_v3.onnx"))?;
        let feats = Tensor::from_array((vec![1i64, 128, frames as i64], mel))
            .map_err(inf("speech tokenizer feats"))?;
        let feats_len = Tensor::from_array((vec![1i64], vec![frames as i32]))
            .map_err(inf("speech tokenizer len"))?;
        let names: Vec<String> = tokenizer
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        if names.len() < 2 {
            return Err(CosyVoice3Error::Session(
                "speech tokenizer: unexpected inputs".into(),
            ));
        }
        let mut tokens: Vec<i64> = {
            let outputs = tokenizer
                .run(ort::inputs! { names[0].as_str() => feats, names[1].as_str() => feats_len })
                .map_err(inf("speech tokenizer run"))?;
            extract_ints(&outputs[0])?
        };
        drop(tokenizer);
        // 2. speaker embedding
        let (fbank, fb_frames) = kaldi_fbank_80(audio16);
        let mut campplus = cpu(&self.dir.join("campplus.onnx"))?;
        let fb = Tensor::from_array((vec![1i64, fb_frames as i64, 80], fbank))
            .map_err(inf("campplus feats"))?;
        let embedding: Vec<f32> = {
            let outputs = campplus
                .run(ort::inputs! { "input" => fb })
                .map_err(inf("campplus run"))?;
            let (_, d) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(inf("campplus output"))?;
            d.to_vec()
        };
        drop(campplus);
        // 3. 24 kHz mel + alignment (cosyvoice2+: force feat == 2 * tokens)
        let (mut feat, feat_frames) = matcha_mel_80(audio24);
        let token_len = (feat_frames / TOKEN_MEL_RATIO).min(tokens.len());
        if token_len == 0 {
            return Err(CosyVoice3Error::Reference(
                "reference produced no speech tokens".into(),
            ));
        }
        tokens.truncate(token_len);
        feat.truncate(TOKEN_MEL_RATIO * token_len * MEL_BINS);
        let prompt = VoicePrompt {
            transcript,
            speech_tokens: tokens,
            feat,
            embedding,
        };
        prompt.validate()?;
        Ok(prompt)
    }

    // -----------------------------------------------------------------------------------------
    // synthesis
    // -----------------------------------------------------------------------------------------

    fn encode_text(&self, text: &str) -> CosyVoice3Result<Vec<i64>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let enc = self
            .tokenizer
            .encode(text, false)
            .map_err(|e| CosyVoice3Error::Tokenizer(e.to_string()))?;
        Ok(enc.get_ids().iter().map(|&i| i64::from(i)).collect())
    }

    fn embed(session: &mut Session, ids: &[i64]) -> CosyVoice3Result<Vec<f32>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let t = Tensor::from_array((vec![1i64, ids.len() as i64], ids.to_vec()))
            .map_err(inf("embed ids"))?;
        let outputs = session
            .run(ort::inputs! { "input_ids" => t })
            .map_err(inf("embed run"))?;
        let (_, d) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(inf("embed output"))?;
        Ok(d.to_vec())
    }

    /// Render one sentence in the prompt's voice. `cancel` is polled every LLM step and
    /// every ODE step.
    pub fn synthesize(
        &mut self,
        text: &str,
        prompt: &VoicePrompt,
        instruct: Option<&str>,
        speed: f32,
        cancel: &dyn Fn() -> bool,
    ) -> CosyVoice3Result<Vec<f32>> {
        let text = normalize_text(text);
        if text.is_empty() || is_only_punctuation(&text) {
            return Ok(Vec::new());
        }
        let tokens = self.generate_tokens(&text, prompt, instruct, cancel)?;
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        let (mel, frames) = self.flow(&tokens, prompt, cancel)?;
        let (mel, frames) = if (speed - 1.0).abs() > 1e-3 {
            resample_mel(&mel, frames, speed)
        } else {
            (mel, frames)
        };
        self.vocode(&mel, frames)
    }

    /// LLM stage: text → speech tokens (upstream `Qwen2LM.inference` + `llm_job`).
    pub fn generate_tokens(
        &mut self,
        text: &str,
        prompt: &VoicePrompt,
        instruct: Option<&str>,
        cancel: &dyn Fn() -> bool,
    ) -> CosyVoice3Result<Vec<i64>> {
        let mode = prompt_mode(prompt, instruct, text);
        let (prompt_text, tts_text) = llm_text_segments(mode, &prompt.transcript, instruct, text);
        let prompt_ids = self.encode_text(&prompt_text)?;
        let text_ids = self.encode_text(&tts_text)?;
        if !prompt_ids.contains(&i64::from(END_OF_PROMPT_ID))
            && !text_ids.contains(&i64::from(END_OF_PROMPT_ID))
        {
            return Err(CosyVoice3Error::Tokenizer("<|endofprompt|> missing".into()));
        }
        let text_len = text_ids.len();
        let mut all_text = prompt_ids;
        all_text.extend_from_slice(&text_ids);
        let llm_prompt_tokens: &[i64] = if mode == PromptMode::ZeroShot {
            &prompt.speech_tokens
        } else {
            &[]
        };
        // lm_input = [sos, text_emb(prompt_text ++ text), task_id, speech_emb(prompt tokens)]
        let text_emb = Self::embed(&mut self.text_embed, &all_text)?;
        let mut speech_ids = vec![SOS_TOKEN, TASK_ID_TOKEN];
        speech_ids.extend_from_slice(llm_prompt_tokens);
        let speech_emb = Self::embed(&mut self.speech_embed, &speech_ids)?;
        let hidden = speech_emb.len() / speech_ids.len();
        let mut lm_input = Vec::with_capacity(speech_emb.len() + text_emb.len());
        lm_input.extend_from_slice(&speech_emb[..hidden]); // sos
        lm_input.extend_from_slice(&text_emb);
        lm_input.extend_from_slice(&speech_emb[hidden..2 * hidden]); // task_id
        lm_input.extend_from_slice(&speech_emb[2 * hidden..]); // prompt speech tokens
        let min_len = (text_len as f64 * MIN_TOKEN_TEXT_RATIO) as usize;
        let max_len = (text_len as f64 * MAX_TOKEN_TEXT_RATIO) as usize;

        let mut past: Vec<DynValue> = Vec::with_capacity(self.kv.past_names.len());
        for _ in 0..self.kv.past_names.len() {
            past.push(self.empty_kv()?);
        }
        let mut seq_len = lm_input.len() / hidden;
        let mut total = 0usize;
        let mut step_input = lm_input;
        let mut decoded: Vec<i64> = Vec::new();
        let mut kept: Vec<i64> = Vec::new();
        let mut silent_run = 0usize;
        for i in 0..max_len {
            if cancel() {
                return Err(CosyVoice3Error::Cancelled);
            }
            let mut inputs: Vec<(String, SessionInputValue<'static>)> =
                Vec::with_capacity(3 + past.len());
            inputs.push((
                "inputs_embeds".into(),
                Tensor::from_array((vec![1i64, seq_len as i64, hidden as i64], step_input))
                    .map_err(inf("llm embeds"))?
                    .into(),
            ));
            inputs.push((
                "attention_mask".into(),
                Tensor::from_array((
                    vec![1i64, (total + seq_len) as i64],
                    vec![1i64; total + seq_len],
                ))
                .map_err(inf("llm mask"))?
                .into(),
            ));
            inputs.push((
                "position_ids".into(),
                Tensor::from_array((
                    vec![1i64, seq_len as i64],
                    (total as i64..(total + seq_len) as i64).collect::<Vec<_>>(),
                ))
                .map_err(inf("llm positions"))?
                .into(),
            ));
            for (name, v) in self.kv.past_names.iter().zip(past.drain(..)) {
                inputs.push((name.clone(), v.into()));
            }
            let mut outputs = self.llm.run(inputs).map_err(inf("llm run"))?;
            let logits: Vec<f32> = {
                let (_, d) = outputs["logits"]
                    .try_extract_tensor::<f32>()
                    .map_err(inf("llm logits"))?;
                d.to_vec()
            };
            for name in &self.kv.present_names {
                past.push(
                    outputs
                        .remove(name.as_str())
                        .ok_or_else(|| CosyVoice3Error::Inference(format!("missing {name}")))?,
                );
            }
            drop(outputs);
            total += seq_len;
            let top = ras_sample(&logits, &decoded, i < min_len, &mut self.rng);
            if top >= SPEECH_TOKEN_SIZE {
                break;
            }
            let top = top as i64;
            decoded.push(top);
            if SILENT_TOKENS.contains(&top) {
                silent_run += 1;
                if silent_run <= MAX_SILENT {
                    kept.push(top);
                }
            } else {
                silent_run = 0;
                kept.push(top);
            }
            step_input = Self::embed(&mut self.speech_embed, &[top])?;
            seq_len = 1;
        }
        Ok(kept)
    }

    fn empty_kv(&self) -> CosyVoice3Result<DynValue> {
        let shape = vec![1i64, self.kv.heads as i64, 0, self.kv.head_dim as i64];
        if self.kv.dtype_f16 {
            Ok(Tensor::from_array((shape, Vec::<half::f16>::new()))
                .map_err(inf("empty kv"))?
                .into_dyn())
        } else {
            Ok(Tensor::from_array((shape, Vec::<f32>::new()))
                .map_err(inf("empty kv"))?
                .into_dyn())
        }
    }

    /// Flow stage: (prompt tokens ++ new tokens) → mel `[80, frames]` for the NEW part.
    pub fn flow(
        &mut self,
        tokens: &[i64],
        prompt: &VoicePrompt,
        cancel: &dyn Fn() -> bool,
    ) -> CosyVoice3Result<(Vec<f32>, usize)> {
        let mut all = prompt.speech_tokens.clone();
        all.extend_from_slice(tokens);
        let (mu, spks) = {
            let tok = Tensor::from_array((vec![1i64, all.len() as i64], all.clone()))
                .map_err(inf("flow tokens"))?;
            let emb = Tensor::from_array((vec![1i64, SPK_DIM as i64], prompt.embedding.clone()))
                .map_err(inf("flow embedding"))?;
            let outputs = self
                .flow_encoder
                .run(ort::inputs! { "token" => tok, "embedding" => emb })
                .map_err(inf("flow encoder run"))?;
            let (_, mu) = outputs["mu"]
                .try_extract_tensor::<f32>()
                .map_err(inf("mu"))?;
            let (_, spks) = outputs["spks"]
                .try_extract_tensor::<f32>()
                .map_err(inf("spks"))?;
            (mu.to_vec(), spks.to_vec())
        };
        let total = all.len() * TOKEN_MEL_RATIO;
        let mel1 = prompt.frames();
        if mu.len() != MEL_BINS * total || mel1 >= total {
            return Err(CosyVoice3Error::Inference(
                "flow encoder shape mismatch".into(),
            ));
        }
        // conds: prompt mel in the first mel1 frames, zeros after; channel-major [80, total]
        let mut cond = vec![0f32; MEL_BINS * total];
        for t in 0..mel1 {
            for m in 0..MEL_BINS {
                cond[m * total + t] = prompt.feat[t * MEL_BINS + m];
            }
        }
        // x0 ~ N(0, 1)
        let mut x: Vec<f32> = (0..MEL_BINS * total).map(|_| self.gaussian()).collect();
        let t_span: Vec<f32> = (0..=N_TIMESTEPS)
            .map(|i| {
                let lin = i as f64 / N_TIMESTEPS as f64;
                (1.0 - (lin * 0.5 * std::f64::consts::PI).cos()) as f32
            })
            .collect();
        let plane = MEL_BINS * total;
        // batch-2 constant inputs: row 0 conditional, row 1 unconditional (zeros)
        let mask = vec![1f32; 2 * total];
        let mut mu_in = vec![0f32; 2 * plane];
        mu_in[..plane].copy_from_slice(&mu);
        let mut spks_in = vec![0f32; 2 * MEL_BINS];
        spks_in[..MEL_BINS].copy_from_slice(&spks);
        let mut cond_in = vec![0f32; 2 * plane];
        cond_in[..plane].copy_from_slice(&cond);
        for step in 1..=N_TIMESTEPS {
            if cancel() {
                return Err(CosyVoice3Error::Cancelled);
            }
            let t = t_span[step - 1];
            let dt = t_span[step] - t;
            let mut x_in = Vec::with_capacity(2 * plane);
            x_in.extend_from_slice(&x);
            x_in.extend_from_slice(&x);
            let v = self.run_estimator(
                x_in,
                mask.clone(),
                mu_in.clone(),
                vec![t, t],
                spks_in.clone(),
                cond_in.clone(),
                total,
            )?;
            for i in 0..plane {
                let d = (1.0 + CFG_RATE) * v[i] - CFG_RATE * v[plane + i];
                x[i] += dt * d;
            }
        }
        // keep the generated part: [80, total] → [80, total - mel1]
        let frames = total - mel1;
        let mut out = vec![0f32; MEL_BINS * frames];
        for m in 0..MEL_BINS {
            out[m * frames..(m + 1) * frames]
                .copy_from_slice(&x[m * total + mel1..(m + 1) * total]);
        }
        Ok((out, frames))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_estimator(
        &mut self,
        x: Vec<f32>,
        mask: Vec<f32>,
        mu: Vec<f32>,
        t: Vec<f32>,
        spks: Vec<f32>,
        cond: Vec<f32>,
        frames: usize,
    ) -> CosyVoice3Result<Vec<f32>> {
        let f = frames as i64;
        let m = MEL_BINS as i64;
        let outputs = if self.estimator_f16 {
            let h = |v: Vec<f32>| v.into_iter().map(half::f16::from_f32).collect::<Vec<_>>();
            self.estimator
                .run(ort::inputs! {
                    "x" => Tensor::from_array((vec![2, m, f], h(x))).map_err(inf("x"))?,
                    "mask" => Tensor::from_array((vec![2, 1, f], h(mask))).map_err(inf("mask"))?,
                    "mu" => Tensor::from_array((vec![2, m, f], h(mu))).map_err(inf("mu"))?,
                    "t" => Tensor::from_array((vec![2], h(t))).map_err(inf("t"))?,
                    "spks" => Tensor::from_array((vec![2, m], h(spks))).map_err(inf("spks"))?,
                    "cond" => Tensor::from_array((vec![2, m, f], h(cond))).map_err(inf("cond"))?,
                })
                .map_err(inf("estimator run"))?
        } else {
            self.estimator
                .run(ort::inputs! {
                    "x" => Tensor::from_array((vec![2, m, f], x)).map_err(inf("x"))?,
                    "mask" => Tensor::from_array((vec![2, 1, f], mask)).map_err(inf("mask"))?,
                    "mu" => Tensor::from_array((vec![2, m, f], mu)).map_err(inf("mu"))?,
                    "t" => Tensor::from_array((vec![2], t)).map_err(inf("t"))?,
                    "spks" => Tensor::from_array((vec![2, m], spks)).map_err(inf("spks"))?,
                    "cond" => Tensor::from_array((vec![2, m, f], cond)).map_err(inf("cond"))?,
                })
                .map_err(inf("estimator run"))?
        };
        if self.estimator_f16 {
            let (_, d) = outputs[0]
                .try_extract_tensor::<half::f16>()
                .map_err(inf("estimator out"))?;
            Ok(d.iter().map(|v| v.to_f32()).collect())
        } else {
            let (_, d) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(inf("estimator out"))?;
            Ok(d.to_vec())
        }
    }

    /// Box-Muller N(0,1) from the engine RNG.
    fn gaussian(&mut self) -> f32 {
        let u1 = self.rng.next_f64().max(1e-12);
        let u2 = self.rng.next_f64();
        ((-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()) as f32
    }

    /// HiFT stage: mel `[80, frames]` → 24 kHz audio.
    pub fn vocode(&mut self, mel: &[f32], frames: usize) -> CosyVoice3Result<Vec<f32>> {
        if frames == 0 {
            return Ok(Vec::new());
        }
        let samples = frames * HOP_SAMPLES;
        let noise: Vec<f32> = (0..samples * HARMONICS)
            .map(|_| self.rng.next_f64() as f32)
            .collect();
        let feat =
            Array3::from_shape_vec((1, MEL_BINS, frames), mel.to_vec()).map_err(inf("hift mel"))?;
        let noise =
            Array3::from_shape_vec((1, samples, HARMONICS), noise).map_err(inf("hift noise"))?;
        let outputs = self
            .hift
            .run(ort::inputs! {
                "speech_feat" => Tensor::from_array(feat).map_err(inf("hift feat tensor"))?,
                "noise" => Tensor::from_array(noise).map_err(inf("hift noise tensor"))?,
            })
            .map_err(inf("hift run"))?;
        let (shape, mag) = outputs["magnitude"]
            .try_extract_tensor::<f32>()
            .map_err(inf("hift magnitude"))?;
        let (_, phase) = outputs["phase"]
            .try_extract_tensor::<f32>()
            .map_err(inf("hift phase"))?;
        let stft_frames = shape[2] as usize;
        let mut audio = istft(mag, phase, stft_frames);
        audio.truncate(samples);
        for s in &mut audio {
            *s = s.clamp(-AUDIO_LIMIT, AUDIO_LIMIT);
        }
        Ok(audio)
    }
}

fn extract_ints(v: &DynValue) -> CosyVoice3Result<Vec<i64>> {
    if let Ok((_, d)) = v.try_extract_tensor::<i64>() {
        return Ok(d.to_vec());
    }
    let (_, d) = v
        .try_extract_tensor::<i32>()
        .map_err(inf("speech tokens"))?;
    Ok(d.iter().map(|&x| i64::from(x)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedRng(Vec<f64>, usize);
    impl UniformF64 for FixedRng {
        fn next_f64(&mut self) -> f64 {
            let v = self.0[self.1 % self.0.len()];
            self.1 += 1;
            v
        }
    }

    #[test]
    fn segments_follow_upstream_entry_points() {
        let (p, t) = llm_text_segments(PromptMode::ZeroShot, " 你好 ", None, "Hi.");
        assert_eq!(p, "You are a helpful assistant.<|endofprompt|>你好");
        assert_eq!(t, "Hi.");
        let (p, t) = llm_text_segments(PromptMode::CrossLingual, "", None, "Hi.");
        assert!(p.is_empty());
        assert_eq!(t, "You are a helpful assistant.<|endofprompt|>Hi.");
        let (p, _) = llm_text_segments(
            PromptMode::Instruct,
            "x",
            Some("Please speak slowly.<|endofprompt|>"),
            "Hi.",
        );
        assert_eq!(
            p,
            "You are a helpful assistant. Please speak slowly.<|endofprompt|>"
        );
    }

    #[test]
    fn mode_selection() {
        let mut p = VoicePrompt {
            transcript: String::new(),
            speech_tokens: vec![1],
            feat: vec![0.0; 160],
            embedding: vec![0.0; 192],
        };
        assert_eq!(prompt_mode(&p, None, "Hi."), PromptMode::CrossLingual);
        p.transcript = "hello".into();
        assert_eq!(prompt_mode(&p, Some("  "), "Hi."), PromptMode::ZeroShot);
        assert_eq!(prompt_mode(&p, Some("happy"), "Hi."), PromptMode::Instruct);
        // Latin reference, Latin target (another language) keeps the transcript.
        assert_eq!(
            prompt_mode(&p, None, "Guten Tag, wie geht's?"),
            PromptMode::ZeroShot
        );
        // Script mismatch drops to cross-lingual, both ways.
        assert_eq!(
            prompt_mode(&p, None, "你好，世界。"),
            PromptMode::CrossLingual
        );
        assert_eq!(
            prompt_mode(&p, None, "Привет, мир."),
            PromptMode::CrossLingual
        );
        p.transcript = "希望你以后能够做的比我还好呦。".into();
        assert_eq!(
            prompt_mode(&p, None, "Hello world."),
            PromptMode::CrossLingual
        );
        assert_eq!(
            prompt_mode(&p, None, "今天天气很好。"),
            PromptMode::ZeroShot
        );
        assert_eq!(
            prompt_mode(&p, None, "今日はいい天気です。"),
            PromptMode::CrossLingual
        );
        assert_eq!(
            prompt_mode(&p, None, "안녕하세요."),
            PromptMode::CrossLingual
        );
        // Digits / punctuation alone say nothing about the language.
        assert_eq!(prompt_mode(&p, None, "123!"), PromptMode::ZeroShot);
        assert!(p.validate().is_ok());
    }

    #[test]
    fn normalization_matches_upstream_fallback() {
        assert_eq!(normalize_text("Hello   world"), "Hello world.");
        assert_eq!(normalize_text("Is it?"), "Is it?");
        assert_eq!(normalize_text("你好 世界."), "你好世界。");
        assert_eq!(normalize_text("价格是3.5元，"), "价格是3.5元。");
        assert_eq!(normalize_text("（测试）【一】"), "测试一。");
        assert!(is_only_punctuation("…!?"));
        assert!(!is_only_punctuation("a."));
    }

    #[test]
    fn ras_resamples_on_repetition() {
        // logits strongly favour token 3; with 3 in the window RAS must pick another id.
        let mut logits = vec![-10.0f32; 6761];
        logits[3] = 10.0;
        logits[4] = 9.0;
        let mut rng = FixedRng(vec![0.0], 0);
        assert_eq!(ras_sample(&logits, &[], false, &mut rng), 3);
        assert_ne!(ras_sample(&logits, &[3], false, &mut rng), 3);
    }

    #[test]
    fn ras_ignore_eos_masks_only_the_eos_row() {
        let mut logits = vec![-10.0f32; 6761];
        logits[SPEECH_TOKEN_SIZE] = 50.0;
        let mut rng = FixedRng(vec![0.0], 0);
        assert_eq!(ras_sample(&logits, &[], false, &mut rng), SPEECH_TOKEN_SIZE);
        assert_ne!(ras_sample(&logits, &[], true, &mut rng), SPEECH_TOKEN_SIZE);
    }

    #[test]
    fn istft_inverts_a_forward_stft() {
        // forward STFT (center=True, reflect) of a sine → iSTFT must reproduce it.
        let n = 4 * 64;
        let x: Vec<f32> = (0..n).map(|i| (i as f32 * 0.3).sin() * 0.5).collect();
        let padded = reflect_pad(&x, 8, 8);
        let frames = 1 + (padded.len() - ISTFT_N_FFT) / ISTFT_HOP;
        let window: Vec<f32> = (0..16)
            .map(|k| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * k as f32 / 16.0).cos()))
            .collect();
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(16);
        let mut mag = vec![0f32; 9 * frames];
        let mut ph = vec![0f32; 9 * frames];
        for t in 0..frames {
            let mut buf: Vec<Complex<f32>> = (0..16)
                .map(|i| Complex::new(padded[t * 4 + i] * window[i], 0.0))
                .collect();
            fft.process(&mut buf);
            for k in 0..9 {
                mag[k * frames + t] = buf[k].norm();
                ph[k * frames + t] = buf[k].arg();
            }
        }
        let y = istft(&mag, &ph, frames);
        assert_eq!(y.len(), n);
        for i in 0..n {
            assert!(
                (y[i] - x[i]).abs() < 1e-4,
                "sample {i}: {} vs {}",
                y[i],
                x[i]
            );
        }
    }

    #[test]
    fn mel_resample_identity_and_length() {
        let mel: Vec<f32> = (0..80 * 10).map(|i| i as f32).collect();
        let (same, f) = resample_mel(&mel, 10, 1.0);
        assert_eq!(f, 10);
        assert_eq!(same, mel);
        let (_, f) = resample_mel(&mel, 10, 2.0);
        assert_eq!(f, 5);
    }

    /// End-to-end render through the shipping graphs. Writes one WAV per sentence plus
    /// `rust_render.json` (text, seconds, RTF) to `WINSTT_COSYVOICE3_OUT` so the WER /
    /// speaker-similarity scorer (`eval_rust.py`, Whisper large-v3-turbo + WavLM-SV) can run
    /// on exactly what Rust produced; the reference prompt lands in `reference_cache/` for
    /// the front-end parity check.
    ///   WINSTT_COSYVOICE3_DIR=<model dir> [WINSTT_COSYVOICE3_QUANT=int8|q4|fp32]
    ///   [WINSTT_COSYVOICE3_DEVICE=cpu|auto] [WINSTT_COSYVOICE3_SENTENCES=<json>]
    ///   [WINSTT_COSYVOICE3_ESTIMATOR=<file>] cargo test cosyvoice3_end_to_end -- --ignored
    #[test]
    #[ignore = "needs the CosyVoice3 model dir in WINSTT_COSYVOICE3_DIR"]
    fn cosyvoice3_end_to_end() {
        let dir = PathBuf::from(
            std::env::var("WINSTT_COSYVOICE3_DIR").expect("set WINSTT_COSYVOICE3_DIR"),
        );
        let quant = std::env::var("WINSTT_COSYVOICE3_QUANT").unwrap_or_else(|_| "int8".into());
        let device = match std::env::var("WINSTT_COSYVOICE3_DEVICE").as_deref() {
            Ok("auto") => TtsDevice::Auto,
            _ => TtsDevice::Cpu,
        };
        let out = std::env::var("WINSTT_COSYVOICE3_OUT")
            .map_or_else(|_| dir.join("rust_out"), PathBuf::from)
            .join(format!("{quant}-{device:?}").to_lowercase());
        std::fs::create_dir_all(&out).expect("out dir");
        let mut files = crate::winstt::tts::catalog::cosyvoice3_graph_set(&quant);
        if let Ok(est) = std::env::var("WINSTT_COSYVOICE3_ESTIMATOR") {
            files.estimator = Box::leak(est.into_boxed_str());
        }
        let t_load = std::time::Instant::now();
        let mut eng = CosyVoice3Engine::load(&dir, &files, device).expect("load");
        eprintln!("load {:.1}s", t_load.elapsed().as_secs_f32());
        eng.set_seed(1234);
        let builtin: &[(&str, &str)] = &[
            (
                "en",
                "The quick brown fox jumps over the lazy dog near the river bank.",
            ),
            (
                "en",
                "Please remember to bring your umbrella, because it might rain this afternoon.",
            ),
            (
                "en",
                "Thank you so much for your help, I really appreciate your kindness.",
            ),
            ("zh", "今天天气很好，我们一起去公园散步吧。"),
            ("zh", "人工智能正在改变我们的工作和生活方式。"),
            ("de", "Der Zug nach Berlin fährt in zehn Minuten ab."),
            ("es", "Muchas gracias por tu ayuda, eres muy amable."),
        ];
        let prompts: Vec<_> = COSYVOICE3_BUILTIN_VOICES
            .iter()
            .map(|voice| {
                let clip = builtin_voice_path(&dir, voice.id);
                let prompt = eng
                    .ensure_prompt(&clip, voice.transcript, |rate| {
                        crate::winstt::managers::transcode::decode_reference_clip(&clip, rate, 30)
                            .map(|c| c.samples)
                    })
                    .expect("prompt");
                (voice.id, prompt)
            })
            .collect();
        // Default: every built-in sentence in every voice. With WINSTT_COSYVOICE3_SENTENCES
        // (a JSON list of {"lang","text"}) the voices alternate instead, for the larger
        // WER set.
        let jobs: Vec<(usize, String, String)> = match std::env::var("WINSTT_COSYVOICE3_SENTENCES")
        {
            Ok(path) => {
                let raw = std::fs::read_to_string(path).expect("sentences file");
                let list: Vec<serde_json::Value> =
                    serde_json::from_str(&raw).expect("sentences json");
                list.iter()
                    .enumerate()
                    .map(|(i, v)| {
                        (
                            i % prompts.len(),
                            v["lang"].as_str().expect("lang").to_owned(),
                            v["text"].as_str().expect("text").to_owned(),
                        )
                    })
                    .collect()
            }
            Err(_) => (0..prompts.len())
                .flat_map(|v| {
                    builtin
                        .iter()
                        .map(move |(l, t)| (v, (*l).to_owned(), (*t).to_owned()))
                })
                .collect(),
        };
        let mut rows = Vec::new();
        let mut total_audio = 0f64;
        let mut total_time = 0f64;
        for (i, (voice_idx, lang, text)) in jobs.iter().enumerate() {
            let (voice_id, prompt) = &prompts[*voice_idx];
            let t0 = std::time::Instant::now();
            // Same stages as `synthesize`, timed separately.
            let norm = normalize_text(text);
            let tokens = eng
                .generate_tokens(&norm, prompt, None, &|| false)
                .expect("llm");
            let t_llm = t0.elapsed().as_secs_f64();
            let (mel, frames) = eng.flow(&tokens, prompt, &|| false).expect("flow");
            let t_flow = t0.elapsed().as_secs_f64() - t_llm;
            let audio = eng.vocode(&mel, frames).expect("vocode");
            let secs = audio.len() as f64 / f64::from(COSYVOICE3_SAMPLE_RATE);
            let elapsed = t0.elapsed().as_secs_f64();
            let t_voc = elapsed - t_llm - t_flow;
            total_audio += secs;
            total_time += elapsed;
            assert!(audio.iter().all(|s| s.is_finite()), "non-finite sample");
            let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len().max(1) as f32).sqrt();
            assert!(
                secs > 0.8 && secs < 25.0,
                "{text}: implausible duration {secs:.2}s"
            );
            assert!(rms > 0.005, "{text}: near-silent output (rms {rms})");
            let name = format!("{voice_id}_{lang}_{i}.wav");
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: COSYVOICE3_SAMPLE_RATE,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut w = hound::WavWriter::create(out.join(&name), spec).expect("wav");
            for s in &audio {
                w.write_sample(*s).expect("write");
            }
            w.finalize().expect("finalize");
            eprintln!(
                "{name}: {secs:.2}s in {elapsed:.2}s (RTF {:.2}; llm {t_llm:.2}s / {} tok, flow {t_flow:.2}s, vocoder {t_voc:.2}s)",
                elapsed / secs,
                tokens.len()
            );
            rows.push(serde_json::json!({
                "file": name, "voice": voice_id, "lang": lang, "text": text,
                "seconds": secs, "elapsed": elapsed, "llm": t_llm, "flow": t_flow,
                "vocoder": t_voc, "tokens": tokens.len(),
            }));
        }
        // speed + instruct + cancellation paths
        let clip = builtin_voice_path(&dir, COSYVOICE3_BUILTIN_VOICES[0].id);
        let prompt = eng
            .ensure_prompt(&clip, COSYVOICE3_BUILTIN_VOICES[0].transcript, |rate| {
                crate::winstt::managers::transcode::decode_reference_clip(&clip, rate, 30)
                    .map(|c| c.samples)
            })
            .expect("prompt");
        let fast = eng
            .synthesize(
                "This sentence is rendered faster.",
                &prompt,
                None,
                1.5,
                &|| false,
            )
            .expect("fast");
        assert!(!fast.is_empty());
        let instructed = eng
            .synthesize(
                "I am so happy to see you again today!",
                &prompt,
                Some("Please speak in a very happy tone."),
                1.0,
                &|| false,
            )
            .expect("instruct");
        assert!(!instructed.is_empty());
        assert!(matches!(
            eng.synthesize("Cancelled before it starts.", &prompt, None, 1.0, &|| true),
            Err(CosyVoice3Error::Cancelled)
        ));
        let rtf = total_time / total_audio;
        eprintln!("overall RTF {rtf:.2} over {total_audio:.1}s of audio");
        std::fs::write(
            out.join("rust_render.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "quant": quant, "device": format!("{device:?}"), "rtf": rtf, "rows": rows,
            }))
            .expect("json"),
        )
        .expect("write json");
    }

    #[test]
    fn frontend_shapes() {
        let audio: Vec<f32> = (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        let (m, frames) = whisper_log_mel_128(&audio);
        assert_eq!(frames, 100);
        assert_eq!(m.len(), 128 * 100);
        let (f, frames) = kaldi_fbank_80(&audio);
        assert_eq!(frames, 98);
        assert_eq!(f.len(), 80 * 98);
        let audio24: Vec<f32> = (0..24_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        let (m, frames) = matcha_mel_80(&audio24);
        assert_eq!(frames, 50);
        assert_eq!(m.len(), 80 * 50);
    }
}
