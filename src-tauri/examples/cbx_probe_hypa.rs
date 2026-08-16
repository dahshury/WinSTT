// HYPOTHESIS A probe — "our decode loop is wrong (greedy argmax / no CFG / MAX_NEW_TOKENS=256)".
//
// Independent of `cbx_probe_repro.rs` and `cbx_probe_charz.rs` (owned by other workstreams).
// Same four-session mechanism as `chatterbox.rs`, but the AR decode loop is parameterised so the
// SHIPPING recipe and the UPSTREAM PyTorch recipe can be A/B'd against each other on identical
// weights, identical reference conditioning and identical text.
//
// Upstream references implemented here:
//   * onnx-community/chatterbox-multilingual-ONNX README `run_inference()` — greedy argmax,
//     RepetitionPenaltyLogitsProcessor(1.2), max_new_tokens=256, NO CFG. (== what we ship.)
//   * ResembleAI/chatterbox `tts.py` / `models/t3/t3.py` — temperature=0.8, cfg_weight=0.5,
//     min_p=0.05, top_p=1.0, repetition_penalty=1.2, max_new_tokens=1000, and a batch-of-2
//     classifier-free-guidance branch whose TEXT embeddings are zeroed (`text_emb[1].zero_()`),
//     combined as `logits = cond + cfg * (cond - uncond)`.
//
//   cargo run --release --example cbx_probe_hypa -- gen <model_id> <quant> <out_dir> <reps>
//   cargo run --release --example cbx_probe_hypa -- asr <dir> [whisper_snapshot_dir]
//
// Decode knobs (env, so one binary covers every arm):
//   CBX_ARM     label baked into the wav filename (default derived from the knobs)
//   CBX_CFG     classifier-free-guidance weight; 0 = off (default 0)
//   CBX_UNCOND  uncond branch: `text` = zero text rows only (upstream), `all` = also zero the
//               <EXAGGERATION> row, `full` = zero every embed_tokens row (default `text`)
//   CBX_TEMP    sampling temperature; 0 = greedy argmax (default 0)
//   CBX_MINP    min-p (default 0)   CBX_TOPP  top-p (default 1)
//   CBX_REPPEN  repetition penalty (default 1.2)
//   CBX_MAXNEW  max new tokens (default 256)
//   CBX_SEED    RNG seed base; the per-rep seed is SEED + rep (default 0)
//   CBX_ONLY    comma-separated sentence keys   CBX_TEXT  custom text, keyed `custom`

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use half::f16;
use ndarray::{Array1, Array2, ArrayD, IxDyn};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use winstt_app_lib::winstt::stt::Accelerator;
use winstt_app_lib::winstt::stt::{
    EngineConfig, EngineKind, Quantization, ResolvedModel, TranscribeOptions, Transcriber,
    WhisperEngine,
};

const SR: u32 = 24_000;
const START_SPEECH_TOKEN: i64 = 6561;
const STOP_SPEECH_TOKEN: i64 = 6562;
const SILENCE_SPEECH_TOKEN: i64 = 4299;
/// S3 speech codec frame rate — one generated token is 1/25 s of audio.
const CODEC_HZ: f32 = 25.0;

const SENTENCES: &[(&str, &str)] = &[
    ("fox", "The quick brown fox jumps over the lazy dog."),
    ("hi", "Hello."),
    ("open", "Please open the settings window."),
    ("count", "One two three four five six seven eight nine ten."),
    (
        "weather",
        "The weather today is sunny with a chance of rain later this evening.",
    ),
    (
        "notes",
        "I will send you the meeting notes tomorrow morning before nine.",
    ),
    (
        "shells",
        "She sells seashells by the seashore and the shells she sells are surely seashells.",
    ),
    (
        "long",
        "Artificial intelligence has changed the way we work, the way we communicate, and the way we understand the world around us.",
    ),
];

fn sentences() -> Vec<(String, String)> {
    if let Ok(custom) = std::env::var("CBX_TEXT")
        && !custom.trim().is_empty()
    {
        return vec![("custom".to_string(), custom)];
    }
    match std::env::var("CBX_ONLY") {
        Ok(only) if !only.trim().is_empty() => SENTENCES
            .iter()
            .filter(|(k, _)| only.split(',').any(|o| o.trim() == *k))
            .map(|(k, t)| ((*k).to_string(), (*t).to_string()))
            .collect(),
        _ => SENTENCES
            .iter()
            .map(|(k, t)| ((*k).to_string(), (*t).to_string()))
            .collect(),
    }
}

fn env_f32(key: &str, default: f32) -> f32 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}
fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Decode-loop configuration — the whole point of this probe.
struct Decode {
    cfg: f32,
    uncond: String,
    temp: f32,
    min_p: f32,
    top_p: f32,
    rep_pen: f32,
    max_new: usize,
    seed: u64,
    arm: String,
}

impl Decode {
    fn from_env() -> Self {
        let cfg = env_f32("CBX_CFG", 0.0);
        let temp = env_f32("CBX_TEMP", 0.0);
        let min_p = env_f32("CBX_MINP", 0.0);
        let top_p = env_f32("CBX_TOPP", 1.0);
        let rep_pen = env_f32("CBX_REPPEN", 1.2);
        let max_new = env_usize("CBX_MAXNEW", 256);
        let uncond = std::env::var("CBX_UNCOND").unwrap_or_else(|_| "text".to_string());
        let seed = env_usize("CBX_SEED", 0) as u64;
        let arm = std::env::var("CBX_ARM").unwrap_or_else(|_| {
            format!("cfg{cfg}-t{temp}-mp{min_p}-tp{top_p}-rp{rep_pen}-mx{max_new}")
                .replace('.', "p")
        });
        Self {
            cfg,
            uncond,
            temp,
            min_p,
            top_p,
            rep_pen,
            max_new,
            seed,
            arm,
        }
    }
    fn batch(&self) -> usize {
        if self.cfg > 0.0 { 2 } else { 1 }
    }
    fn stochastic(&self) -> bool {
        self.temp > 0.0
    }
}

/// Small seeded PCG32 — the crate has no `rand` dependency and every sampling arm must be
/// reproducible from its seed.
struct Pcg32 {
    state: u64,
    inc: u64,
}
impl Pcg32 {
    fn new(seed: u64) -> Self {
        let mut r = Self {
            state: 0,
            inc: (seed << 1) | 1,
        };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }
    fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }
}

/// Upstream's post-CFG pipeline: repetition penalty -> temperature -> min-p -> top-p ->
/// softmax + multinomial. `temp == 0` short-circuits to argmax (the shipped/ONNX-README path).
/// Returns `(token, top1_margin)`.
fn choose(scores: &mut [f32], d: &Decode, rng: &mut Pcg32) -> (i64, f32) {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    let mut second_v = f32::NEG_INFINITY;
    for (idx, &x) in scores.iter().enumerate() {
        if x > best_v {
            second_v = best_v;
            best_v = x;
            best = idx;
        } else if x > second_v {
            second_v = x;
        }
    }
    let margin = best_v - second_v;
    if !d.stochastic() {
        return (best as i64, margin);
    }
    for s in scores.iter_mut() {
        *s /= d.temp;
    }
    let max = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut probs: Vec<f32> = scores.iter().map(|&x| (x - max).exp()).collect();
    let sum: f32 = probs.iter().sum();
    for p in &mut probs {
        *p /= sum;
    }
    if d.min_p > 0.0 {
        let pmax = probs.iter().copied().fold(0.0f32, f32::max);
        let thresh = d.min_p * pmax;
        for p in &mut probs {
            if *p < thresh {
                *p = 0.0;
            }
        }
    }
    if d.top_p < 1.0 {
        let mut order: Vec<usize> = (0..probs.len()).collect();
        order.sort_unstable_by(|&a, &b| probs[b].total_cmp(&probs[a]));
        let mut cum = 0.0f32;
        let mut cut = order.len();
        for (rank, &idx) in order.iter().enumerate() {
            cum += probs[idx];
            if cum >= d.top_p {
                cut = rank + 1;
                break;
            }
        }
        for &idx in order.iter().skip(cut) {
            probs[idx] = 0.0;
        }
    }
    let total: f32 = probs.iter().sum();
    if total <= 0.0 {
        return (best as i64, margin);
    }
    let target = rng.next_f32() * total;
    let mut acc = 0.0f32;
    for (idx, &p) in probs.iter().enumerate() {
        acc += p;
        if acc >= target {
            return (idx as i64, margin);
        }
    }
    (best as i64, margin)
}

fn model_dir(model_id: &str) -> PathBuf {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("WINSTT_TTS_CACHE") {
        roots.push(PathBuf::from(v));
    }
    roots.push(PathBuf::from("E:/DL/Projects/WinSTT/.tts-cache"));
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("winstt").join("tts"));
    }
    for r in &roots {
        let d = r.join(model_id);
        if d.join("tokenizer.json").exists() {
            return d;
        }
    }
    panic!("no cache root holds {model_id} (tried {roots:?})");
}

fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec).expect("create wav");
    for &s in samples {
        w.write_sample((s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            .expect("write");
    }
    w.finalize().expect("finalize");
}

fn stats(samples: &[f32]) -> (f32, f32) {
    let mut peak = 0.0f32;
    let mut sumsq = 0.0f64;
    for &s in samples {
        if s.is_nan() {
            continue;
        }
        peak = peak.max(s.abs());
        sumsq += f64::from(s) * f64::from(s);
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sumsq / samples.len() as f64).sqrt() as f32
    };
    (peak, rms)
}

/// RMS over the first `ms` milliseconds — the onset-energy number the repro report used to
/// separate multilingual (starts mid-phoneme) from turbo/nano (80-110 ms of leading silence).
fn head_rms(samples: &[f32], ms: usize) -> f32 {
    let n = (SR as usize * ms / 1000).min(samples.len());
    stats(&samples[..n]).1
}

fn fnv_i64(v: &[i64]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in v {
        for b in x.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
    }
    h
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum KvDtype {
    F32,
    F16,
}

enum KvValue {
    F32(ArrayD<f32>),
    F16(ArrayD<f16>),
}
impl KvValue {
    fn empty(dtype: KvDtype, batch: usize, heads: usize, head_dim: usize) -> Self {
        let shape = IxDyn(&[batch, heads, 0, head_dim]);
        match dtype {
            KvDtype::F32 => Self::F32(ArrayD::from_shape_vec(shape, Vec::new()).unwrap()),
            KvDtype::F16 => Self::F16(ArrayD::from_shape_vec(shape, Vec::new()).unwrap()),
        }
    }
    fn from_output(outputs: &ort::session::SessionOutputs<'_>, name: &str, dtype: KvDtype) -> Self {
        match dtype {
            KvDtype::F32 => Self::F32(extract_typed::<f32>(outputs, name)),
            KvDtype::F16 => Self::F16(extract_typed::<f16>(outputs, name)),
        }
    }
    fn into_input(self) -> SessionInputValue<'static> {
        match self {
            Self::F32(a) => SessionInputValue::from(Tensor::from_array(a).unwrap()),
            Self::F16(a) => SessionInputValue::from(Tensor::from_array(a).unwrap()),
        }
    }
}

fn build_session(path: &Path) -> Session {
    Session::builder()
        .expect("builder")
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .expect("opt")
        .commit_from_file(path)
        .unwrap_or_else(|e| panic!("commit {}: {e}", path.display()))
}

fn extract_f32(outputs: &ort::session::SessionOutputs<'_>, name: &str) -> ArrayD<f32> {
    if let Ok((shape, data)) = outputs[name].try_extract_tensor::<f32>() {
        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        return ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec()).expect("shape");
    }
    let (shape, data) = outputs[name]
        .try_extract_tensor::<f16>()
        .unwrap_or_else(|e| panic!("extract {name}: {e}"));
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.iter().map(|v| v.to_f32()).collect()).expect("shape")
}

fn extract_typed<T: ort::value::PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static>(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> ArrayD<T> {
    let (shape, data) = outputs[name]
        .try_extract_tensor::<T>()
        .unwrap_or_else(|e| panic!("extract {name}: {e}"));
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ArrayD::from_shape_vec(IxDyn(&dims), data.to_vec()).expect("shape")
}

fn float_input(session: &Session, name: &str, array: ArrayD<f32>) -> SessionInputValue<'static> {
    let wants_f16 = session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_type())
        .is_some_and(|t| matches!(t, ort::value::TensorElementType::Float16));
    if wants_f16 {
        return SessionInputValue::from(Tensor::from_array(array.mapv(f16::from_f32)).unwrap());
    }
    SessionInputValue::from(Tensor::from_array(array).unwrap())
}

fn declares_input(session: &Session, name: &str) -> bool {
    session.inputs().iter().any(|i| i.name() == name)
}

struct KvSpec {
    past_names: Vec<String>,
    present_names: Vec<String>,
    heads: usize,
    head_dim: usize,
    dtype: KvDtype,
}

fn introspect_kv(lm: &Session) -> KvSpec {
    let past_names: Vec<String> = lm
        .inputs()
        .iter()
        .map(|i| i.name().to_string())
        .filter(|n| n.starts_with("past_key_values."))
        .collect();
    let present_names: Vec<String> = lm
        .outputs()
        .iter()
        .map(|o| o.name().to_string())
        .filter(|n| n.starts_with("present."))
        .collect();
    let node = lm
        .inputs()
        .iter()
        .find(|i| i.name().starts_with("past_key_values."))
        .expect("kv input");
    let ty = node.dtype();
    let shape = ty.tensor_shape();
    let heads = shape.and_then(|s| s.get(1).copied()).unwrap_or(0) as usize;
    let head_dim = shape.and_then(|s| s.get(3).copied()).unwrap_or(0) as usize;
    let dtype = match ty.tensor_type() {
        Some(ort::value::TensorElementType::Float16) => KvDtype::F16,
        _ => KvDtype::F32,
    };
    KvSpec {
        past_names,
        present_names,
        heads,
        head_dim,
        dtype,
    }
}

fn load_wav_24k_mono(path: &Path) -> Vec<f32> {
    let (mono, sr) = read_wav(path);
    if sr == SR || mono.is_empty() {
        return mono;
    }
    let ratio = f64::from(SR) / f64::from(sr);
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
    out
}

fn run_embed(
    embed: &mut Session,
    ids: &[i64],
    pos: &[i64],
    exaggeration: f32,
    wants_pos: bool,
    wants_exag: bool,
) -> ArrayD<f32> {
    let n = ids.len();
    let mut inputs: Vec<(Cow<'static, str>, SessionInputValue<'static>)> = Vec::with_capacity(3);
    inputs.push((
        Cow::Borrowed("input_ids"),
        SessionInputValue::from(
            Tensor::from_array(Array2::from_shape_vec((1, n), ids.to_vec()).unwrap()).unwrap(),
        ),
    ));
    if wants_pos {
        inputs.push((
            Cow::Borrowed("position_ids"),
            SessionInputValue::from(
                Tensor::from_array(Array2::from_shape_vec((1, n), pos.to_vec()).unwrap()).unwrap(),
            ),
        ));
    }
    if wants_exag {
        inputs.push((
            Cow::Borrowed("exaggeration"),
            float_input(
                embed,
                "exaggeration",
                Array1::from_vec(vec![exaggeration]).into_dyn(),
            ),
        ));
    }
    let out = embed.run(inputs).expect("embed_tokens");
    extract_f32(&out, "inputs_embeds")
}

fn graphs_for(model_id: &str, quant: &str) -> [String; 4] {
    match model_id {
        "chatterbox-nano" => [
            "speech_encoder_q4f16.onnx".into(),
            "embed_tokens_fp16.onnx".into(),
            "language_model_q4f16.onnx".into(),
            "conditional_decoder_q4.onnx".into(),
        ],
        "chatterbox-turbo" => {
            let s = if quant == "q4f16" { "q4f16" } else { "q4" };
            [
                format!("speech_encoder_{s}.onnx"),
                format!("embed_tokens_{s}.onnx"),
                format!("language_model_{s}.onnx"),
                format!("conditional_decoder_{s}.onnx"),
            ]
        }
        _ => {
            let lm = if quant.is_empty() || quant == "fp32" {
                "language_model.onnx".to_string()
            } else {
                format!("language_model_{quant}.onnx")
            };
            [
                "speech_encoder.onnx".into(),
                "embed_tokens.onnx".into(),
                lm,
                "conditional_decoder.onnx".into(),
            ]
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run_gen(model_id: &str, quant: &str, out_dir: &Path, reps: usize) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let d = Decode::from_env();
    let dir = model_dir(model_id);
    let g = graphs_for(model_id, quant);
    println!(
        "ARM arm={} cfg={} uncond={} temp={} min_p={} top_p={} rep_pen={} max_new={} seed={} batch={} model={model_id} quant={quant}",
        d.arm,
        d.cfg,
        d.uncond,
        d.temp,
        d.min_p,
        d.top_p,
        d.rep_pen,
        d.max_new,
        d.seed,
        d.batch()
    );
    let mut speech_encoder = build_session(&dir.join("onnx").join(&g[0]));
    let mut embed_tokens = build_session(&dir.join("onnx").join(&g[1]));
    let mut language_model = build_session(&dir.join("onnx").join(&g[2]));
    let mut conditional_decoder = build_session(&dir.join("onnx").join(&g[3]));
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).expect("tokenizer");
    let kv = introspect_kv(&language_model);
    let embed_wants_pos = declares_input(&embed_tokens, "position_ids");
    let embed_wants_exag = declares_input(&embed_tokens, "exaggeration");
    let lm_wants_pos = declares_input(&language_model, "position_ids");

    let is_multi = model_id == "chatterbox-multilingual";
    let language_tag: Option<String> = if is_multi {
        Some(std::env::var("CBX_LANG").unwrap_or_else(|_| "en".into()))
    } else {
        None
    };
    let trailing_silence = usize::from(!is_multi) * 3;

    // CBX_REF swaps in a candidate reference clip without touching the app cache, so the
    // reference-clip matrix (the measured ~93% of chatterbox damage) can be swept in one run.
    let ref_path =
        std::env::var("CBX_REF").map_or_else(|_| dir.join("default_voice.wav"), PathBuf::from);
    let mut audio = load_wav_24k_mono(&ref_path);
    let cap = 30 * SR as usize;
    audio.truncate(cap);
    let (cond_emb, prompt_token, ref_x_vector, prompt_feat) = {
        let av = Array2::from_shape_vec((1, audio.len()), audio)
            .unwrap()
            .into_dyn();
        let t = float_input(&speech_encoder, "audio_values", av);
        let se = speech_encoder
            .run(vec![(Cow::Borrowed("audio_values"), t)])
            .expect("speech_encoder");
        (
            extract_f32(&se, "audio_features"),
            extract_typed::<i64>(&se, "audio_tokens"),
            extract_f32(&se, "speaker_embeddings"),
            extract_f32(&se, "speaker_features"),
        )
    };
    let lc = cond_emb.shape().get(1).copied().unwrap_or(0);
    let lp = prompt_token.len();

    let tag = model_id.replace("chatterbox-", "cb");
    let batch = d.batch();
    let mut refs: Vec<String> = Vec::new();
    for (key, text) in sentences() {
        refs.push(format!("{key}\t{text}"));
        for rep in 0..reps {
            let prompt = match &language_tag {
                Some(t) => format!("[{t}]{text}"),
                None => text.clone(),
            };
            let enc = tokenizer.encode(prompt.clone(), true).expect("encode");
            let ids: Vec<i64> = enc.get_ids().iter().map(|&u| i64::from(u)).collect();
            let s = ids.len();
            let position_ids: Vec<i64> = (0..s)
                .map(|idx| {
                    if ids[idx] >= START_SPEECH_TOKEN {
                        0
                    } else {
                        idx as i64 - 1
                    }
                })
                .collect();

            let mut rng = Pcg32::new(d.seed + rep as u64);
            let t0 = Instant::now();
            let text_embeds = run_embed(
                &mut embed_tokens,
                &ids,
                &position_ids,
                0.5,
                embed_wants_pos,
                embed_wants_exag,
            );
            let hidden = *text_embeds.shape().last().unwrap_or(&0);

            // Row 0 = conditional: cond_emb ++ text_embeds.
            // Row 1 (CFG only) = unconditional: cond_emb ++ text_embeds with the TEXT rows
            // zeroed (upstream `text_emb[1].zero_()`); the <START_SPEECH> rows stay intact
            // because upstream never zeroes speech_emb.
            let cond_flat: Vec<f32> = cond_emb.iter().copied().collect();
            let text_flat: Vec<f32> = text_embeds.iter().copied().collect();
            let seq_len = lc + s;
            let mut embeds_flat: Vec<f32> = Vec::with_capacity(batch * seq_len * hidden);
            embeds_flat.extend(cond_flat.iter().copied());
            embeds_flat.extend(text_flat.iter().copied());
            if batch == 2 {
                let mut masked = text_flat.clone();
                for (k, &id) in ids.iter().enumerate() {
                    let zero = match d.uncond.as_str() {
                        "full" => true,
                        "all" => id < START_SPEECH_TOKEN,
                        // `text`: leave index 0 (<EXAGGERATION>) alone — upstream carries the
                        // emotion-advisor embedding inside cond, which CFG never zeroes.
                        _ => id < START_SPEECH_TOKEN && k > 0,
                    };
                    if zero {
                        for x in &mut masked[k * hidden..(k + 1) * hidden] {
                            *x = 0.0;
                        }
                    }
                }
                embeds_flat.extend(cond_flat.iter().copied());
                embeds_flat.extend(masked);
            }
            let mut inputs_embeds: ArrayD<f32> =
                ArrayD::from_shape_vec(IxDyn(&[batch, seq_len, hidden]), embeds_flat)
                    .expect("concat");

            let mut kvmap: BTreeMap<String, KvValue> = BTreeMap::new();
            for name in &kv.past_names {
                kvmap.insert(
                    name.clone(),
                    KvValue::empty(kv.dtype, batch, kv.heads, kv.head_dim),
                );
            }
            let mut lm_positions: Vec<i64> = (0..seq_len as i64).collect();
            let mut generate_tokens: Vec<i64> = vec![START_SPEECH_TOKEN];
            let mut top_margins: Vec<f32> = Vec::new();
            let mut hit_cap = true;
            let mut stop_step: i64 = -1;

            for i in 0..d.max_new {
                // attention covers the prefill plus one slot per token accepted so far.
                let mask_len = seq_len + i;
                let mut inputs: Vec<(Cow<'static, str>, SessionInputValue<'static>)> =
                    Vec::with_capacity(3 + kv.past_names.len());
                inputs.push((
                    Cow::Borrowed("inputs_embeds"),
                    float_input(&language_model, "inputs_embeds", inputs_embeds.clone()),
                ));
                inputs.push((
                    Cow::Borrowed("attention_mask"),
                    SessionInputValue::from(
                        Tensor::from_array(
                            Array2::from_shape_vec((batch, mask_len), vec![1i64; batch * mask_len])
                                .unwrap(),
                        )
                        .unwrap(),
                    ),
                ));
                if lm_wants_pos {
                    let n = lm_positions.len();
                    let mut tiled: Vec<i64> = Vec::with_capacity(batch * n);
                    for _ in 0..batch {
                        tiled.extend(lm_positions.iter().copied());
                    }
                    inputs.push((
                        Cow::Borrowed("position_ids"),
                        SessionInputValue::from(
                            Tensor::from_array(Array2::from_shape_vec((batch, n), tiled).unwrap())
                                .unwrap(),
                        ),
                    ));
                }
                for name in &kv.past_names {
                    let arr = kvmap.remove(name).expect("kv");
                    inputs.push((Cow::Owned(name.clone()), arr.into_input()));
                }
                let outputs = language_model.run(inputs).expect("lm step");
                let logits = extract_f32(&outputs, "logits");
                let lshape = logits.shape().to_vec();
                let (seq, vocab) = (lshape[1], lshape[2]);
                let slice = logits.as_slice().expect("contig");
                let base = (seq - 1) * vocab;
                let mut scores: Vec<f32> = slice[base..base + vocab].to_vec();
                if batch == 2 {
                    let ub = seq * vocab + (seq - 1) * vocab;
                    for (k, sc) in scores.iter_mut().enumerate() {
                        let uncond = slice[ub + k];
                        *sc = *sc + d.cfg * (*sc - uncond);
                    }
                }
                let mut seen = std::collections::HashSet::new();
                for &tok in &generate_tokens {
                    if tok >= 0 && (tok as usize) < vocab && seen.insert(tok) {
                        let v = scores[tok as usize];
                        scores[tok as usize] = if v < 0.0 {
                            v * d.rep_pen
                        } else {
                            v / d.rep_pen
                        };
                    }
                }
                let (next_token, margin) = choose(&mut scores, &d, &mut rng);
                top_margins.push(margin);
                generate_tokens.push(next_token);
                if next_token == STOP_SPEECH_TOKEN {
                    hit_cap = false;
                    stop_step = i as i64;
                    break;
                }
                for (pi, pres) in kv.present_names.iter().enumerate() {
                    let arr = KvValue::from_output(&outputs, pres, kv.dtype);
                    kvmap.insert(kv.past_names[pi].clone(), arr);
                }
                drop(outputs);
                let step_embed = run_embed(
                    &mut embed_tokens,
                    &[next_token],
                    &[(i + 1) as i64],
                    0.5,
                    embed_wants_pos,
                    embed_wants_exag,
                );
                // Both CFG rows are fed the SAME sampled token (upstream expands next_token
                // across the batch), so tile the single-row embedding.
                let step_flat: Vec<f32> = step_embed.iter().copied().collect();
                let mut tiled: Vec<f32> = Vec::with_capacity(batch * hidden);
                for _ in 0..batch {
                    tiled.extend(step_flat.iter().copied());
                }
                inputs_embeds =
                    ArrayD::from_shape_vec(IxDyn(&[batch, 1, hidden]), tiled).expect("step embeds");
                lm_positions = vec![lm_positions.last().copied().unwrap_or(0) + 1];
            }
            let ar_ms = t0.elapsed().as_millis();

            let gen_mid: Vec<i64> = if generate_tokens.len() > 2 {
                generate_tokens[1..generate_tokens.len() - 1].to_vec()
            } else {
                Vec::new()
            };
            let prompt_vec: Vec<i64> = prompt_token.iter().copied().collect();
            let mut speech_tokens: Vec<i64> =
                Vec::with_capacity(prompt_vec.len() + gen_mid.len() + trailing_silence);
            speech_tokens.extend(prompt_vec);
            speech_tokens.extend(gen_mid.clone());
            speech_tokens.extend(std::iter::repeat_n(SILENCE_SPEECH_TOKEN, trailing_silence));
            let n_speech = speech_tokens.len();

            let st = Tensor::from_array(
                Array2::from_shape_vec((1, speech_tokens.len()), speech_tokens).unwrap(),
            )
            .unwrap();
            let spk = float_input(
                &conditional_decoder,
                "speaker_embeddings",
                ref_x_vector.clone(),
            );
            let feat = float_input(
                &conditional_decoder,
                "speaker_features",
                prompt_feat.clone(),
            );
            let first_output_name = conditional_decoder
                .outputs()
                .first()
                .map(|o| o.name().to_string());
            let dec = conditional_decoder
                .run(vec![
                    (Cow::Borrowed("speech_tokens"), SessionInputValue::from(st)),
                    (Cow::Borrowed("speaker_embeddings"), spk),
                    (Cow::Borrowed("speaker_features"), feat),
                ])
                .expect("conditional_decoder");
            let wav = if dec.contains_key("waveform") {
                extract_f32(&dec, "waveform")
            } else {
                extract_f32(&dec, &first_output_name.clone().unwrap())
            };
            let mut out: Vec<f32> = wav.iter().copied().collect();
            let peak0 = out.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
            if peak0 > 1.0 {
                let gain = 0.99 / peak0;
                for s in &mut out {
                    *s *= gain;
                }
            }
            let file = out_dir.join(format!("{tag}-{}__{key}__r{rep}.wav", d.arm));
            write_wav(&file, &out, SR);
            let (peak, rms) = stats(&out);
            let mean_margin = top_margins.iter().sum::<f32>() / top_margins.len().max(1) as f32;
            println!(
                "GEN arm={} model={model_id} quant={quant} sent={key} rep={rep} gen_tokens={} hit_cap={hit_cap} stop_step={stop_step} n_speech={n_speech} prompt_tok={lp} samples={} dur_s={:.3} gen_secs={:.3} head50_rms={:.4} peak={peak:.3} rms={rms:.4} ar_ms={ar_ms} margin={mean_margin:.3} tokhash={:016x} file={}",
                d.arm,
                gen_mid.len(),
                out.len(),
                out.len() as f32 / SR as f32,
                gen_mid.len() as f32 / CODEC_HZ,
                head_rms(&out, 50),
                fnv_i64(&gen_mid),
                file.display()
            );
        }
    }
    std::fs::write(out_dir.join("refs.tsv"), refs.join("\n")).expect("write refs");
}

fn resample_to_16k(audio: &[f32], from: u32) -> Vec<f32> {
    if from == 16_000 {
        return audio.to_vec();
    }
    use rubato::{Fft, FixedSync, Resampler as _, audioadapter_buffers::direct::InterleavedSlice};
    const CHUNK_IN: usize = 1200;
    let Ok(mut r) = Fft::<f32>::new(from as usize, 16_000, CHUNK_IN, 1, FixedSync::Input) else {
        let ratio = 16_000.0 / f64::from(from);
        let n = ((audio.len() as f64) * ratio).round() as usize;
        return (0..n)
            .map(|i| {
                let src = (i as f64 / ratio) as usize;
                audio.get(src).copied().unwrap_or(0.0)
            })
            .collect();
    };
    let mut out: Vec<f32> = Vec::with_capacity(audio.len() * 2 / 3 + CHUNK_IN);
    let mut idx = 0usize;
    let padded_len = audio.len() + CHUNK_IN;
    while idx < padded_len {
        let end = (idx + CHUNK_IN).min(padded_len);
        let mut buf: Vec<f32> = (idx..end)
            .map(|i| audio.get(i).copied().unwrap_or(0.0))
            .collect();
        buf.resize(CHUNK_IN, 0.0);
        if let Ok(input) = InterleavedSlice::new(buf.as_slice(), 1, CHUNK_IN)
            && let Ok(o) = r.process(&input, None)
        {
            out.extend(o.take_data());
        }
        idx = end;
    }
    out
}

fn read_wav(path: &Path) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .filter_map(Result::ok)
                .map(|v| v as f32 / max)
                .collect()
        }
    };
    let mono: Vec<f32> = if ch <= 1 {
        raw
    } else {
        raw.chunks(ch)
            .map(|fr| fr.iter().copied().sum::<f32>() / ch as f32)
            .collect()
    };
    (mono, spec.sample_rate)
}

fn norm_words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn wer(reference: &[String], hyp: &[String]) -> (usize, usize, usize, usize) {
    let (n, m) = (reference.len(), hyp.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate().take(n + 1) {
        row[0] = i;
    }
    #[allow(clippy::needless_range_loop)]
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(reference[i - 1] != hyp[j - 1]);
            d[i][j] = (d[i - 1][j - 1] + cost)
                .min(d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1);
        }
    }
    let (mut i, mut j) = (n, m);
    let (mut sub, mut del, mut ins) = (0usize, 0usize, 0usize);
    while i > 0 || j > 0 {
        if i > 0 && j > 0 {
            let cost = usize::from(reference[i - 1] != hyp[j - 1]);
            if d[i][j] == d[i - 1][j - 1] + cost {
                if cost == 1 {
                    sub += 1;
                }
                i -= 1;
                j -= 1;
                continue;
            }
        }
        if i > 0 && d[i][j] == d[i - 1][j] + 1 {
            del += 1;
            i -= 1;
            continue;
        }
        ins += 1;
        j -= 1;
    }
    (sub, del, ins, n)
}

fn default_snap(repo: &str) -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let snaps = PathBuf::from(home)
        .join(".cache/huggingface/hub")
        .join(format!("models--onnx-community--{repo}"))
        .join("snapshots");
    std::fs::read_dir(&snaps)
        .ok()
        .and_then(|e| e.flatten().map(|e| e.path()).find(|p| p.is_dir()))
        .map_or_else(
            || snaps.to_string_lossy().into_owned(),
            |p| p.to_string_lossy().into_owned(),
        )
}

fn run_asr(dir: &Path, snap: &str) {
    eprintln!("ASR snapshot: {snap}");
    // Reference texts written by `gen` (covers CBX_TEXT), falling back to the built-in corpus.
    let mut refs: BTreeMap<String, String> = SENTENCES
        .iter()
        .map(|(k, t)| ((*k).to_string(), (*t).to_string()))
        .collect();
    if let Ok(body) = std::fs::read_to_string(dir.join("refs.tsv")) {
        for line in body.lines() {
            if let Some((k, t)) = line.split_once('\t') {
                refs.insert(k.to_string(), t.to_string());
            }
        }
    }
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    files.insert(
        "encoder".into(),
        PathBuf::from(format!("{snap}/onnx/encoder_model.onnx")),
    );
    files.insert(
        "decoder".into(),
        PathBuf::from(format!("{snap}/onnx/decoder_model_merged.onnx")),
    );
    files.insert("vocab".into(), PathBuf::from(format!("{snap}/vocab.json")));
    let added = PathBuf::from(format!("{snap}/added_tokens.json"));
    if added.exists() {
        files.insert("added_tokens".into(), added);
    }
    files.insert(
        "config".into(),
        PathBuf::from(format!("{snap}/config.json")),
    );
    let cfg = EngineConfig {
        model_name: snap.to_string(),
        family: "whisper".into(),
        kind: EngineKind::WhisperHf,
        resolved: ResolvedModel {
            files,
            effective_quantization: Quantization::Default,
        },
        providers: vec![Accelerator::Cpu],
        whisper_fp16_workaround: false,
        language: None,
    };
    let mut engine = WhisperEngine::load(&cfg).expect("whisper load");
    let opts = TranscribeOptions {
        language: Some("en".to_string()),
        ..Default::default()
    };
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("read out dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    paths.sort();
    for p in paths {
        let (audio, sr) = read_wav(&p);
        let mut a = resample_to_16k(&audio, sr);
        let peak = a.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        if peak > 0.0 {
            let g = 0.95 / peak;
            for x in &mut a {
                *x *= g;
            }
        }
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let key = name.split("__").nth(1).unwrap_or("").to_string();
        let empty = String::new();
        let reference = refs.get(&key).unwrap_or(&empty);
        match engine.transcribe(&a, &opts) {
            Ok(out) => {
                let hyp = out.text.trim().to_string();
                let (sub, del, ins, rn) = wer(&norm_words(reference), &norm_words(&hyp));
                let rate = (sub + del + ins) as f32 / rn.max(1) as f32;
                println!(
                    "ASR file={name} dur_s={:.3} wer={rate:.3} S={sub} D={del} I={ins} N={rn} hyp={hyp:?}",
                    audio.len() as f32 / sr as f32,
                );
            }
            Err(e) => println!("ASR file={name} FAILED: {e}"),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map_or("gen", String::as_str);
    match mode {
        "gen" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "chatterbox-multilingual".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "q4".into());
            let out_dir = PathBuf::from(args.get(4).cloned().unwrap_or_else(|| "cbx_hypa".into()));
            let reps: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);
            run_gen(&model_id, &quant, &out_dir, reps);
        }
        "asr" => {
            let dir = PathBuf::from(args.get(2).cloned().unwrap_or_else(|| "cbx_hypa".into()));
            let snap = args
                .get(3)
                .cloned()
                .unwrap_or_else(|| default_snap("whisper-small.en"));
            run_asr(&dir, &snap);
        }
        other => {
            eprintln!("unknown mode '{other}' (gen | asr)");
            std::process::exit(2);
        }
    }
}
