// THROWAWAY REPRO HARNESS for the `chatterbox-multilingual` audio-degradation report.
// Does NOT touch the shipping engine — it either drives the shipping adapter
// (`synth` mode) or re-implements the pipeline over raw ort sessions so the AR decode
// can be instrumented (`probe` mode), and transcribes the resulting WAVs with the
// repo's own Whisper engine (`asr` mode).
//
//   cargo run --release --example cbx_probe_repro -- synth <model_id> <quant> <out_dir> <reps>
//   cargo run --release --example cbx_probe_repro -- probe <model_id> <quant> <out_dir> <reps>
//   cargo run --release --example cbx_probe_repro -- asr   <dir> [whisper_snapshot_dir]
//
// Cache root comes from WINSTT_TTS_CACHE (same as tts_engine_bench).

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use half::f16;
use ndarray::{Array1, Array2, Array3, ArrayD, IxDyn};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use winstt_app_lib::winstt::stt::Accelerator;
use winstt_app_lib::winstt::stt::{
    EngineConfig, EngineKind, Quantization, ResolvedModel, TranscribeOptions, Transcriber,
    WhisperEngine,
};
use winstt_app_lib::winstt::tts::local_engines::ChatterboxLocalEngine;
use winstt_app_lib::winstt::tts::{SentenceAudio, TtsEngine};

const SR: u32 = 24_000;
const START_SPEECH_TOKEN: i64 = 6561;
const STOP_SPEECH_TOKEN: i64 = 6562;
const SILENCE_SPEECH_TOKEN: i64 = 4299;
const MAX_NEW_TOKENS: usize = 256;
const REPETITION_PENALTY: f32 = 1.2;

/// (key, text) — short / medium / long, plus the exact reported failure sentence.
const SENTENCES: &[(&str, &str)] = &[
    ("fox", "The quick brown fox jumps over the lazy dog."),
    ("hello", "Hello there."),
    ("count", "One two three four five six seven eight nine ten."),
    (
        "weather",
        "The weather today is sunny with a chance of rain later this evening.",
    ),
    (
        "long",
        "Artificial intelligence has changed the way we work, the way we communicate, and the way we understand the world around us.",
    ),
];

fn sentences() -> Vec<(String, String)> {
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

fn cache_root() -> PathBuf {
    std::env::var("WINSTT_TTS_CACHE").map_or_else(|_| PathBuf::from("../.tts-cache"), PathBuf::from)
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
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .expect("write");
    }
    w.finalize().expect("finalize");
}

fn stats(samples: &[f32]) -> (f32, f32, usize) {
    let mut peak = 0.0f32;
    let mut sumsq = 0.0f64;
    let mut nan = 0usize;
    for &s in samples {
        if s.is_nan() {
            nan += 1;
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
    (peak, rms, nan)
}

// ---------------------------------------------------------------------------
// synth mode — the SHIPPING adapter
// ---------------------------------------------------------------------------

fn run_synth(model_id: &str, quant: &str, out_dir: &Path, reps: usize) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let engine = ChatterboxLocalEngine::new(cache_root().join(model_id), model_id, quant);
    let tag = model_id.replace("chatterbox-", "cb");
    for (key, text) in sentences() {
        for rep in 0..reps {
            let t = Instant::now();
            match engine.synthesize_sentence(&text, "default", "en", 1.0) {
                Ok(SentenceAudio::F32le {
                    samples,
                    sample_rate,
                }) => {
                    let (peak, rms, nan) = stats(&samples);
                    let out = out_dir.join(format!("synth__{tag}__{key}__r{rep}.wav"));
                    write_wav(&out, &samples, sample_rate);
                    println!(
                        "SYNTH model={model_id} quant={quant} sent={key} rep={rep} samples={} dur_s={:.3} sr={sample_rate} peak={peak:.3} rms={rms:.4} nan={nan} ms={} file={}",
                        samples.len(),
                        samples.len() as f32 / sample_rate as f32,
                        t.elapsed().as_millis(),
                        out.display()
                    );
                }
                Ok(SentenceAudio::Mp3 { .. }) => panic!("unexpected mp3"),
                Err(e) => {
                    println!("SYNTH model={model_id} sent={key} rep={rep} FAILED: {e}");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// probe mode — raw sessions, instrumented AR loop (copied out of chatterbox.rs)
// ---------------------------------------------------------------------------

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
    fn empty(dtype: KvDtype, heads: usize, head_dim: usize) -> Self {
        let shape = IxDyn(&[1, heads, 0, head_dim]);
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
    let mut reader = hound::WavReader::open(path).expect("open ref wav");
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
    if spec.sample_rate == SR || mono.is_empty() {
        return mono;
    }
    let ratio = f64::from(SR) / f64::from(spec.sample_rate);
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
    // [speech_encoder, embed_tokens, language_model, conditional_decoder]
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
        // multilingual: only the backbone is quantized
        _ => [
            "speech_encoder.onnx".into(),
            "embed_tokens.onnx".into(),
            format!("language_model_{quant}.onnx"),
            "conditional_decoder.onnx".into(),
        ],
    }
}

#[allow(clippy::too_many_lines, unused_assignments)]
fn run_probe(model_id: &str, quant: &str, out_dir: &Path, reps: usize) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let dir = cache_root().join(model_id);
    let g = graphs_for(model_id, quant);
    println!("PROBE_GRAPHS model={model_id} quant={quant} {g:?}");
    let mut speech_encoder = build_session(&dir.join("onnx").join(&g[0]));
    let mut embed_tokens = build_session(&dir.join("onnx").join(&g[1]));
    let mut language_model = build_session(&dir.join("onnx").join(&g[2]));
    let mut conditional_decoder = build_session(&dir.join("onnx").join(&g[3]));
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).expect("tokenizer");
    let kv = introspect_kv(&language_model);
    let embed_wants_pos = declares_input(&embed_tokens, "position_ids");
    let embed_wants_exag = declares_input(&embed_tokens, "exaggeration");
    let lm_wants_pos = declares_input(&language_model, "position_ids");
    println!(
        "PROBE_SPEC model={model_id} layers={} heads={} head_dim={} kv_dtype={} embed_pos={embed_wants_pos} embed_exag={embed_wants_exag} lm_pos={lm_wants_pos} vocab_size={}",
        kv.past_names.len() / 2,
        kv.heads,
        kv.head_dim,
        if kv.dtype == KvDtype::F16 {
            "f16"
        } else {
            "f32"
        },
        tokenizer.get_vocab_size(true),
    );

    let is_multi = model_id == "chatterbox-multilingual";
    let language_tag = if is_multi { Some("en") } else { None };
    let trailing_silence = usize::from(!is_multi) * 3;

    // reference conditioning, ONCE
    let ref_path = dir.join("default_voice.wav");
    let mut audio = load_wav_24k_mono(&ref_path);
    let cap = 30 * SR as usize;
    if audio.len() > cap {
        audio.truncate(cap);
    }
    println!(
        "PROBE_REF model={model_id} ref_samples={} ref_dur_s={:.3}",
        audio.len(),
        audio.len() as f32 / SR as f32
    );
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
    println!(
        "PROBE_COND model={model_id} cond_emb_shape={:?} Lc={lc} prompt_token_len={lp} x_vector={:?} prompt_feat={:?}",
        cond_emb.shape(),
        ref_x_vector.shape(),
        prompt_feat.shape()
    );

    for (key, text) in sentences() {
        for rep in 0..reps {
            let prompt = match language_tag {
                Some(tag) => format!("[{tag}]{text}"),
                None => text.clone(),
            };
            let enc = tokenizer.encode(prompt.clone(), true).expect("encode");
            let ids: Vec<i64> = enc.get_ids().iter().map(|&u| i64::from(u)).collect();
            let s = ids.len();
            let toks: Vec<String> = enc.get_tokens().to_vec();
            if rep == 0 {
                println!(
                    "PROBE_TOK model={model_id} sent={key} prompt={prompt:?} n_ids={s} ids={ids:?}\n           pieces={toks:?}"
                );
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
            let mut embeds_flat: Vec<f32> = Vec::with_capacity((lc + s) * hidden);
            embeds_flat.extend(cond_emb.iter().copied());
            embeds_flat.extend(text_embeds.iter().copied());
            let mut seq_len = lc + s;
            let mut inputs_embeds: ArrayD<f32> =
                Array3::from_shape_vec((1, seq_len, hidden), embeds_flat)
                    .expect("concat")
                    .into_dyn();

            let mut kvmap: BTreeMap<String, KvValue> = BTreeMap::new();
            for name in &kv.past_names {
                kvmap.insert(
                    name.clone(),
                    KvValue::empty(kv.dtype, kv.heads, kv.head_dim),
                );
            }
            let mut attention_mask: Vec<i64> = vec![1; seq_len];
            let mut lm_positions: Vec<i64> = (0..seq_len as i64).collect();
            let mut generate_tokens: Vec<i64> = vec![START_SPEECH_TOKEN];
            // Diagnostics: top-1 margin and the STOP token's rank at each step.
            let mut top_margins: Vec<f32> = Vec::new();
            let mut stop_ranks: Vec<usize> = Vec::new();
            let mut hit_cap = true;
            let mut stop_step = usize::MAX;

            for i in 0..MAX_NEW_TOKENS {
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
                            Array2::from_shape_vec(
                                (1, attention_mask.len()),
                                attention_mask.clone(),
                            )
                            .unwrap(),
                        )
                        .unwrap(),
                    ),
                ));
                if lm_wants_pos {
                    inputs.push((
                        Cow::Borrowed("position_ids"),
                        SessionInputValue::from(
                            Tensor::from_array(
                                Array2::from_shape_vec(
                                    (1, lm_positions.len()),
                                    lm_positions.clone(),
                                )
                                .unwrap(),
                            )
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
                let last = (seq - 1) * vocab;
                let logits_slice = logits.as_slice().expect("contig");
                let mut scores: Vec<f32> = logits_slice[last..last + vocab].to_vec();
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
                // argmax + runner-up + stop rank
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
                top_margins.push(best_v - second_v);
                let stop_score = scores
                    .get(STOP_SPEECH_TOKEN as usize)
                    .copied()
                    .unwrap_or(f32::NEG_INFINITY);
                stop_ranks.push(scores.iter().filter(|&&x| x > stop_score).count());
                let next_token = best as i64;
                generate_tokens.push(next_token);
                if next_token == STOP_SPEECH_TOKEN {
                    hit_cap = false;
                    stop_step = i;
                    break;
                }
                for (pi, pres) in kv.present_names.iter().enumerate() {
                    let arr = KvValue::from_output(&outputs, pres, kv.dtype);
                    kvmap.insert(kv.past_names[pi].clone(), arr);
                }
                drop(outputs);
                inputs_embeds = run_embed(
                    &mut embed_tokens,
                    &[next_token],
                    &[(i + 1) as i64],
                    0.5,
                    embed_wants_pos,
                    embed_wants_exag,
                );
                seq_len += 1;
                attention_mask.push(1);
                lm_positions = vec![lm_positions.last().copied().unwrap_or(0) + 1];
            }
            let ar_ms = t0.elapsed().as_millis();

            let gen_mid: Vec<i64> = if generate_tokens.len() > 2 {
                generate_tokens[1..generate_tokens.len() - 1].to_vec()
            } else {
                Vec::new()
            };
            let uniq: std::collections::HashSet<i64> = gen_mid.iter().copied().collect();
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
            let tag = model_id.replace("chatterbox-", "cb");
            let file = out_dir.join(format!("probe__{tag}__{key}__r{rep}.wav"));
            write_wav(&file, &out, SR);
            let (peak, rms, nan) = stats(&out);
            let mean_margin = top_margins.iter().sum::<f32>() / top_margins.len().max(1) as f32;
            let head: Vec<i64> = gen_mid.iter().take(24).copied().collect();
            let tail: Vec<i64> = gen_mid.iter().rev().take(8).rev().copied().collect();
            println!(
                "PROBE model={model_id} quant={quant} sent={key} rep={rep} n_text_ids={s} gen_tokens={} hit_cap={hit_cap} stop_step={} uniq_gen={} n_speech_tokens={n_speech} prompt_tok={lp} samples={} dur_s={:.3} samples_per_tok={:.1} peak={peak:.3} rms={rms:.4} nan={nan} ar_ms={ar_ms} mean_top1_margin={mean_margin:.3} stop_rank_min={} file={}",
                gen_mid.len(),
                if stop_step == usize::MAX {
                    -1i64
                } else {
                    stop_step as i64
                },
                uniq.len(),
                out.len(),
                out.len() as f32 / SR as f32,
                out.len() as f32 / n_speech.max(1) as f32,
                stop_ranks.iter().min().copied().unwrap_or(usize::MAX),
                file.display()
            );
            println!("PROBE_TOKENS sent={key} rep={rep} head={head:?} tail={tail:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// asr mode — transcribe every WAV in a directory with the repo Whisper engine
// ---------------------------------------------------------------------------

fn resample_to_16k(audio: &[f32], from: u32) -> Vec<f32> {
    if from == 16_000 {
        return audio.to_vec();
    }
    use rubato::{Fft, FixedSync, Resampler as _, audioadapter_buffers::direct::InterleavedSlice};
    const CHUNK_IN: usize = 1200;
    let Ok(mut r) = Fft::<f32>::new(from as usize, 16_000, CHUNK_IN, 1, FixedSync::Input) else {
        // naive fallback
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
    // flush tail with a chunk of silence so the last samples come out
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
    files.insert("num_mel_bins".into(), PathBuf::from("80"));
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
        match engine.transcribe(&a, &opts) {
            Ok(out) => println!(
                "ASR file={} src_dur_s={:.3} -> {:?}",
                p.file_name().unwrap_or_default().to_string_lossy(),
                audio.len() as f32 / sr as f32,
                out.text.trim()
            ),
            Err(e) => println!(
                "ASR file={} FAILED: {e}",
                p.file_name().unwrap_or_default().to_string_lossy()
            ),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map_or("synth", String::as_str);
    match mode {
        "synth" | "probe" => {
            let model_id = args
                .get(2)
                .cloned()
                .unwrap_or_else(|| "chatterbox-multilingual".into());
            let quant = args.get(3).cloned().unwrap_or_else(|| "q4".into());
            let out_dir = PathBuf::from(args.get(4).cloned().unwrap_or_else(|| "cbx_out".into()));
            let reps: usize = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1);
            if mode == "synth" {
                run_synth(&model_id, &quant, &out_dir, reps);
            } else {
                run_probe(&model_id, &quant, &out_dir, reps);
            }
        }
        "asr" => {
            let dir = PathBuf::from(args.get(2).cloned().unwrap_or_else(|| "cbx_out".into()));
            let snap = args
                .get(3)
                .cloned()
                .unwrap_or_else(|| default_snap("whisper-small.en"));
            run_asr(&dir, &snap);
        }
        other => {
            eprintln!("unknown mode '{other}' (synth | probe | asr)");
            std::process::exit(2);
        }
    }
}
