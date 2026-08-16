//! Direct ORT implementation for sherpa-format streaming NeMo RNN-T exports.
//!
//! This ports the NeMo split-graph loop used by sherpa-onnx:
//! encoder cache tensors are carried across feature chunks, the predictor state is advanced only
//! after a non-blank token, and the joiner runs once per encoder frame. These sessions use WinSTT's
//! shared `ort` provider routing, so DirectML can be selected on Windows.

use ndarray::{Array2, ArrayD, Axis, IxDyn, s};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::frontend;
use super::streaming::{self, StreamCursor};
use super::support::*;
use crate::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription,
};

const MAX_SYMBOLS_PER_FRAME: usize = 10;

/// Map the active provider list to the ORT allocation device for binding the carried encoder
/// cache device-resident (CPU when no GPU EP; then IoBinding simply binds host memory, still
/// correct + ~same speed). Mirrors whisper's `device_for_providers` / cohere's `cohere_device`.
fn nemo_stream_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// Bind a carried cache input: the device `DynValue` from the previous chunk when present, else the
/// host zero-tensor built for a fresh stream's first chunk. Exactly one of `carried`/`empty` is Some.
fn bind_cache_input<T: ort::value::ValueTypeMarker + ?Sized>(
    binding: &mut ort::session::IoBinding,
    name: &str,
    carried: Option<&DynValue>,
    empty: Option<&ort::value::Value<T>>,
) -> SttResult<()> {
    match (carried, empty) {
        (Some(v), _) => binding.bind_input(name, v),
        (None, Some(t)) => binding.bind_input(name, t),
        (None, None) => {
            return Err(SttError::Inference(format!(
                "nemo stream cache '{name}' has neither carried nor empty tensor"
            )));
        }
    }
    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))
}

/// Carried predictor step, kept as session-owned `DynValue`s (zero host round-trips):
/// `decoder_out` is Pred(all emitted tokens) — the joiner's `decoder_outputs` input, reused
/// across every frame until the next emission — and `post_state` is the LSTM `(h, c)` AFTER
/// consuming the last token, i.e. the input state for the NEXT emission's predictor run.
///
/// Carrying BOTH across chunks (sherpa's 2026 "parakeet unified" decoder semantics) fixes the
/// classic-sherpa bug this engine inherited: saving only the post-token state and re-running
/// `Pred(tokens.last(), post_state)` at every chunk start fed the last token to the LSTM TWICE
/// at each chunk boundary. With the carried pair there is no chunk-start re-run at all — each
/// token is consumed exactly once, and the per-chunk predictor call disappears as a bonus.
struct CarriedPred {
    decoder_out: DynValue,
    post_state: (DynValue, DynValue),
}

pub struct NativeNemoStreamingEngine {
    encoder: Session,
    decoder: Session,
    joiner: Session,
    vocab: Vocab,
    kind: EngineKind,
    model_name: String,
    providers: Vec<String>,
    mel_fb: Array2<f32>,
    feature_dim: usize,
    normalize_type: frontend::NemoNorm,
    window_size: usize,
    chunk_shift: usize,
    vocab_size: usize,
    blank_id: i64,
    cache_last_channel_shape: Vec<usize>,
    cache_last_time_shape: Vec<usize>,
    decoder_state_shape_0: Vec<usize>,
    decoder_state_shape_1: Vec<usize>,
    decoder_input_names: Vec<String>,
    decoder_output_names: Vec<String>,
    /// Language/prompt selector for `EncDecRNNTBPEModelWithPrompt` exports (e.g. multilingual
    /// Nemotron-3.5): the value bound to the encoder's 6th `prompt_index` input. `None` for
    /// non-prompt exports (English Nemotron) whose encoder has only the 5 standard inputs.
    prompt_index: Option<i64>,
    /// `Some` for buffered "parakeet unified" exports (sliding-window offline-style encoder,
    /// no cache tensors — see `UnifiedWindow`); `None` for cache-aware exports.
    unified: Option<UnifiedWindow>,
    /// ORT allocation device the sessions run on, for binding the carried encoder cache resident.
    device: AllocationDevice,
    device_id: i32,
    stream: NemoStreamState,
    /// `WINSTT_NEMO_STREAM_PROFILE=1` → per-stage counters printed on finalize.
    profile: Option<StreamProfile>,
}

/// Per-stream accumulated stage timings (profiling only; reset with the stream).
#[derive(Default)]
struct StreamProfile {
    feat_ms: f64,
    encoder_ms: f64,
    encoder_runs: usize,
    decoder_ms: f64,
    decoder_runs: usize,
    joiner_ms: f64,
    joiner_runs: usize,
}

/// Per-stream carried state. The three encoder cache tensors are carried DEVICE-RESIDENT across
/// feature chunks: `None` on a fresh stream (the empty zero-cache is built host-side for the first
/// chunk only), then each chunk's `*_next` encoder outputs are kept as session-owned device
/// `DynValue`s and rebound as the next chunk's inputs — no per-chunk host round-trip. The RNN-T
/// predictor state stays host-side (`decoder_state`): it is carried per-TOKEN inside a chunk (not
/// per-chunk) and only conditionally on emission, so the device-resident payoff is marginal and the
/// host path keeps the token loop's exact semantics.
struct NemoStreamState {
    cursor: StreamCursor,
    cache_last_channel: Option<DynValue>,
    cache_last_time: Option<DynValue>,
    cache_last_channel_len: Option<DynValue>,
    /// Carried predictor output + post-token LSTM state (see `CarriedPred`). `None` on a fresh
    /// stream — primed with `Pred(blank, zeros)` when the first chunk decodes.
    pred: Option<CarriedPred>,
}

/// Pull `(decoder_out, post_state)` out of a predictor run's outputs as session-owned
/// `DynValue`s (output order: `[decoder_out, decoder_length, state0, state1]`).
fn take_pred_outputs(
    mut outputs: ort::session::SessionOutputs<'_>,
    names: &[String],
) -> SttResult<CarriedPred> {
    let mut take = |name: &str| {
        outputs
            .remove(name)
            .ok_or_else(|| SttError::Inference(format!("nemo stream decoder produced no {name}")))
    };
    let decoder_out = take(names[0].as_str())?;
    let s0 = take(names[2].as_str())?;
    let s1 = take(names[3].as_str())?;
    Ok(CarriedPred {
        decoder_out,
        post_state: (s0, s1),
    })
}

/// Buffered-streaming ("parakeet unified") window constants, from the encoder metadata of a
/// `streaming_model_type: nemo_parakeet_unified_streaming` export. These exports have NO cache
/// tensors — the encoder is a plain offline-style graph (`audio_signal`+`length` → `outputs`)
/// that sherpa's 2026 unified decoder drives with a SLIDING WINDOW: per step it rebuilds
/// `left+chunk+right` feature frames (zero-padding missing left at stream start / right at the
/// tail), per-feature-normalizes THE WINDOW, runs the full encoder, then decodes only the CENTER
/// `chunk_encoder_frames` (starting at `left_encoder_frames`) and advances by
/// `chunk_feature_frames`. The fixed window shape also means the DML EP fuses the encoder ONCE.
#[derive(Clone, Copy)]
struct UnifiedWindow {
    left_feat: usize,
    chunk_feat: usize,
    right_feat: usize,
    left_enc: usize,
    chunk_enc: usize,
}

/// True for a `<...>`-framed special/language token (`<en-US>`, `<unk>`, `<blk>`, …) that the
/// prompt-conditioned multilingual decoder can emit but that must NEVER reach the transcript. A
/// whole-symbol frame — real BPE subwords never start with `<` AND end with `>`.
fn is_framed_special_token(sym: &str) -> bool {
    sym.len() >= 2 && sym.starts_with('<') && sym.ends_with('>')
}

/// Resolve the encoder `prompt_index` for a prompt-based multilingual streaming model
/// (`EncDecRNNTBPEModelWithPrompt`). Looks `language` up in the `prompt_dictionary` metadata
/// (exact, case-insensitive, then the base language before a `-`, e.g. `en` from `en-US`); returns
/// `auto_prompt_id` (whole-utterance auto-detect) when the language is `None`/blank/unknown.
fn resolve_prompt_index(
    metadata: &std::collections::BTreeMap<String, String>,
    language: Option<&str>,
) -> i64 {
    let auto = metadata
        .get("auto_prompt_id")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let Some(lang) = language.map(str::trim).filter(|s| !s.is_empty()) else {
        return auto;
    };
    let Some(dict) = metadata
        .get("prompt_dictionary")
        .and_then(|s| serde_json::from_str::<std::collections::BTreeMap<String, i64>>(s).ok())
    else {
        return auto;
    };
    let want = lang.to_ascii_lowercase();
    let base = want.split('-').next().unwrap_or(&want);
    dict.iter()
        .find(|(k, _)| k.to_ascii_lowercase() == want)
        .or_else(|| {
            dict.iter().find(|(k, _)| {
                let kl = k.to_ascii_lowercase();
                kl == base || kl.split('-').next() == Some(base)
            })
        })
        .map_or(auto, |(_, &v)| v)
}

impl NativeNemoStreamingEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        // HYBRID device split for QUANTIZED exports on DirectML (measured, nemotron-3.5 1120ms
        // int8, 66 s clip): the int8 ENCODER is faster on DML than CPU (~117 vs ~186 ms/chunk —
        // one fixed-shape run, fuses once), but the per-token decoder/joiner runs collapse on DML
        // (dec ~8-16 ms/run vs 0.6 ms on CPU; join ~2-3 ms vs 0.4 ms) because the QDQ nodes demote
        // per-op and every tiny run pays kernel-launch overhead. So: encoder → GPU EP, decoder +
        // joiner → CPU. Float exports keep the full provider list everywhere (fp32 dec/join on DML
        // ≈ CPU, no QDQ demotion). Escapes: `WINSTT_NEMO_STREAM_DECODER_DML` forces dec/join back
        // onto the GPU EP; `WINSTT_NEMO_STREAM_ENCODER_CPU` pins the encoder to CPU (isolation).
        let cpu_only = [Accelerator::Cpu];
        let dml_primary = cfg.providers.first() == Some(&Accelerator::DirectMl);
        let quantized = matches!(
            cfg.resolved.effective_quantization,
            crate::winstt::stt::Quantization::Int8
                | crate::winstt::stt::Quantization::Q4
                | crate::winstt::stt::Quantization::Q4f16
                | crate::winstt::stt::Quantization::Bnb4
                | crate::winstt::stt::Quantization::Uint8
        );
        let enc_providers: &[Accelerator] =
            if std::env::var("WINSTT_NEMO_STREAM_ENCODER_CPU").is_ok() {
                &cpu_only
            } else {
                &cfg.providers
            };
        let decjoin_providers: &[Accelerator] =
            if dml_primary && quantized && std::env::var("WINSTT_NEMO_STREAM_DECODER_DML").is_err()
            {
                &cpu_only
            } else {
                &cfg.providers
            };
        let encoder = build_session(file(&cfg.resolved, "encoder")?, enc_providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, decjoin_providers)?;
        let joiner = build_session(file(&cfg.resolved, "joiner")?, decjoin_providers)?;

        let metadata = read_custom_metadata(&encoder)?;
        let feature_dim = feat_dim_of(&encoder, "audio_signal");
        let vocab_size = streaming::meta_usize(&metadata, "vocab_size", "NeMo streaming")? + 1;
        let blank_id = vocab_size.saturating_sub(1) as i64;
        let normalize_type =
            frontend::NemoNorm::from_metadata(metadata.get("normalize_type").map(String::as_str));

        // Two sherpa streaming export flavors share this engine:
        //   * cache-aware (Nemotron/FastConformer): `window_size`/`chunk_shift` + 3 carried
        //     cache tensors;
        //   * buffered "parakeet unified" (`streaming_model_type: nemo_parakeet_unified_streaming`):
        //     a plain offline-style encoder driven by a sliding left+chunk+right window with
        //     center-slice decoding — NO cache tensors (see `UnifiedWindow`).
        let is_unified = metadata
            .get("streaming_model_type")
            .is_some_and(|s| s == "nemo_parakeet_unified_streaming")
            || metadata.get("buffered_streaming").is_some_and(|s| s == "1");
        let (window_size, chunk_shift, cache_last_channel_shape, cache_last_time_shape, unified) =
            if is_unified {
                let u = UnifiedWindow {
                    left_feat: streaming::meta_usize(
                        &metadata,
                        "left_feature_frames",
                        "NeMo unified streaming",
                    )?,
                    chunk_feat: streaming::meta_usize(
                        &metadata,
                        "chunk_feature_frames",
                        "NeMo unified streaming",
                    )?,
                    right_feat: streaming::meta_usize(
                        &metadata,
                        "right_feature_frames",
                        "NeMo unified streaming",
                    )?,
                    left_enc: streaming::meta_usize(
                        &metadata,
                        "left_encoder_frames",
                        "NeMo unified streaming",
                    )?,
                    chunk_enc: streaming::meta_usize(
                        &metadata,
                        "chunk_encoder_frames",
                        "NeMo unified streaming",
                    )?,
                };
                let window = u.left_feat + u.chunk_feat + u.right_feat;
                (window, u.chunk_feat, Vec::new(), Vec::new(), Some(u))
            } else {
                (
                    streaming::meta_usize(&metadata, "window_size", "NeMo streaming")?,
                    streaming::meta_usize(&metadata, "chunk_shift", "NeMo streaming")?,
                    vec![
                        1,
                        streaming::meta_usize(
                            &metadata,
                            "cache_last_channel_dim1",
                            "NeMo streaming",
                        )?,
                        streaming::meta_usize(
                            &metadata,
                            "cache_last_channel_dim2",
                            "NeMo streaming",
                        )?,
                        streaming::meta_usize(
                            &metadata,
                            "cache_last_channel_dim3",
                            "NeMo streaming",
                        )?,
                    ],
                    vec![
                        1,
                        streaming::meta_usize(&metadata, "cache_last_time_dim1", "NeMo streaming")?,
                        streaming::meta_usize(&metadata, "cache_last_time_dim2", "NeMo streaming")?,
                        streaming::meta_usize(&metadata, "cache_last_time_dim3", "NeMo streaming")?,
                    ],
                    None,
                )
            };

        let decoder_input_names = node_input_names(&decoder);
        let decoder_output_names = node_output_names(&decoder);
        if decoder_input_names.len() < 4 || decoder_output_names.len() < 4 {
            return Err(SttError::SessionCreate(
                "NeMo streaming decoder must expose 4 inputs and 4 outputs".into(),
            ));
        }

        let pred_layers = metadata
            .get("pred_rnn_layers")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or_else(|| input_state_shape(&decoder, &decoder_input_names[2])[0]);
        let pred_hidden = metadata
            .get("pred_hidden")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or_else(|| input_state_shape(&decoder, &decoder_input_names[2])[2]);
        let decoder_state_shape_0 = vec![pred_layers, 1, pred_hidden];
        let decoder_state_shape_1 = vec![pred_layers, 1, pred_hidden];

        // Multilingual prompt models (`EncDecRNNTBPEModelWithPrompt`, e.g. Nemotron-3.5) expose a 6th
        // encoder input `prompt_index` selecting the language/prompt. Resolve it from the requested
        // language via the model's `prompt_dictionary` (falling back to `auto_prompt_id` = whole-
        // utterance auto-detect) when the input is present; plain exports (English Nemotron) omit the
        // input, so we leave it `None` and bind nothing.
        let prompt_index = node_input_names(&encoder)
            .iter()
            .any(|n| n == "prompt_index")
            .then(|| resolve_prompt_index(&metadata, cfg.language.as_deref()));

        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let mel_fb = frontend::build_nemo_mel_filterbank(feature_dim);
        // The carried encoder-cache binding follows the ENCODER session's placement (the decoder/
        // joiner may be CPU-split above, but the cache tensors only flow encoder→encoder).
        let (device, device_id) = nemo_stream_device(enc_providers);
        let mut engine = Self {
            encoder,
            decoder,
            joiner,
            vocab,
            kind: cfg.kind,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            mel_fb,
            feature_dim,
            normalize_type,
            window_size,
            chunk_shift,
            vocab_size,
            blank_id,
            cache_last_channel_shape,
            cache_last_time_shape,
            decoder_state_shape_0,
            decoder_state_shape_1,
            decoder_input_names,
            decoder_output_names,
            prompt_index,
            unified,
            device,
            device_id,
            stream: NemoStreamState::empty(),
            profile: std::env::var("WINSTT_NEMO_STREAM_PROFILE")
                .is_ok()
                .then(StreamProfile::default),
        };
        engine.stream = engine.fresh_stream_state();
        Ok(engine)
    }

    pub fn supports(cfg: &EngineConfig) -> bool {
        cfg.kind == EngineKind::NemoRnntStreaming
            && cfg.resolved.files.contains_key("encoder")
            && cfg.resolved.files.contains_key("decoder")
            && cfg.resolved.files.contains_key("joiner")
            && cfg.resolved.files.contains_key("vocab")
    }

    fn fresh_stream_state(&self) -> NemoStreamState {
        NemoStreamState {
            cursor: StreamCursor::new(),
            // Device-resident encoder cache starts empty; the first chunk binds host zero-tensors.
            cache_last_channel: None,
            cache_last_time: None,
            cache_last_channel_len: None,
            pred: None,
        }
    }

    /// Device `MemoryInfo` for binding the carried encoder cache resident (CPU when no GPU EP).
    fn device_mem(&self) -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("nemo stream device mem info: {e}")))
    }

    fn process_available_chunks(&mut self, finalize: bool) -> SttResult<bool> {
        if self.unified.is_some() {
            return self.process_available_chunks_unified(finalize);
        }
        let t_feat = std::time::Instant::now();
        let features = frontend::nemo_features_with_normalization(
            &self.stream.cursor.pcm,
            &self.mel_fb,
            self.normalize_type,
        );
        if let Some(p) = self.profile.as_mut() {
            p.feat_ms += t_feat.elapsed().as_secs_f64() * 1000.0;
        }
        let mut processed_any = false;
        loop {
            // Readiness follows the official streaming RNN-T rule:
            // num_processed_frames + ChunkSize() < NumFramesReady() (`<=` on finalize).
            let rel_start = self.stream.cursor.rel_start();
            if !streaming::chunk_ready(rel_start, self.window_size, features.nrows(), finalize) {
                break;
            }
            let chunk = features
                .slice(s![rel_start..rel_start + self.window_size, ..])
                .to_owned();
            self.run_feature_chunk(&chunk)?;
            self.stream.cursor.next_chunk_frame += self.chunk_shift;
            processed_any = true;
        }
        if processed_any {
            self.stream.cursor.trim_pcm(frontend::NEMO_HOP);
        }
        Ok(processed_any)
    }

    /// Buffered "parakeet unified" chunk loop (port of sherpa's 2026 unified streaming decoder):
    /// per step, rebuild the `left+chunk+right` feature window around the chunk start (zero-pad
    /// the missing left at stream start; the finalize silence pad supplies the right tail),
    /// per-feature-normalize THE WINDOW (matching sherpa: normalization runs over the copied,
    /// padded window — the cache-aware whole-buffer normalization would drift as the ring trims),
    /// run the offline-style encoder, decode only the CENTER encoder frames, advance by
    /// `chunk_feature_frames`.
    fn process_available_chunks_unified(&mut self, finalize: bool) -> SttResult<bool> {
        let Some(u) = self.unified else {
            return Ok(false);
        };
        let t_feat = std::time::Instant::now();
        // Raw (unnormalized) log-mel over the buffered PCM; the window normalizes itself below.
        let features = frontend::nemo_features_with_normalization(
            &self.stream.cursor.pcm,
            &self.mel_fb,
            frontend::NemoNorm::None,
        );
        if let Some(p) = self.profile.as_mut() {
            p.feat_ms += t_feat.elapsed().as_secs_f64() * 1000.0;
        }
        let window_rows = u.left_feat + u.chunk_feat + u.right_feat;
        let mut processed_any = false;
        loop {
            // Ready when the chunk AND its right context are available past the chunk start
            // (the left context is history — re-read from the ring, zero-padded at stream start).
            let rel_start = self.stream.cursor.rel_start();
            if !streaming::chunk_ready(
                rel_start,
                u.chunk_feat + u.right_feat,
                features.nrows(),
                finalize,
            ) {
                break;
            }
            // Assemble the window: rows [rel_start - left_feat, rel_start + chunk + right) of the
            // available features, zero-padding rows that fall before the buffer (stream start) or
            // past its end (the finalize tail).
            let mut window = Array2::<f32>::zeros((window_rows, self.feature_dim));
            for (w_row, abs) in (0..window_rows)
                .map(|i| (i, rel_start as isize - u.left_feat as isize + i as isize))
            {
                if abs >= 0 && (abs as usize) < features.nrows() {
                    window.row_mut(w_row).assign(&features.row(abs as usize));
                }
            }
            // Per-feature (per mel bin) normalization over the window, matching the offline
            // normalizer's unbiased-variance form.
            if self.normalize_type == frontend::NemoNorm::PerFeature {
                for m in 0..self.feature_dim {
                    let col = window.column(m);
                    let n = col.len() as f32;
                    let mean = col.sum() / n;
                    let var = col.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>()
                        / (n - 1.0).max(1.0);
                    let std = var.sqrt() + 1e-5;
                    window.column_mut(m).mapv_inplace(|v| (v - mean) / std);
                }
            }
            let t_enc = std::time::Instant::now();
            let center = self.run_encoder_unified(&window, &u)?;
            if let Some(p) = self.profile.as_mut() {
                p.encoder_ms += t_enc.elapsed().as_secs_f64() * 1000.0;
                p.encoder_runs += 1;
            }
            if center.nrows() > 0 {
                self.decode_encoder_out(&center)?;
            }
            self.stream.cursor.next_chunk_frame += u.chunk_feat;
            processed_any = true;
        }
        if processed_any {
            self.stream
                .cursor
                .trim_pcm_keeping(frontend::NEMO_HOP, u.left_feat);
        }
        Ok(processed_any)
    }

    /// One unified window through the plain offline-style encoder → the CENTER encoder frames
    /// `[left_enc, left_enc + chunk_enc)` as `(T_center, D)` rows (clamped by `encoded_lengths`).
    fn run_encoder_unified(
        &mut self,
        window: &Array2<f32>,
        u: &UnifiedWindow,
    ) -> SttResult<Array2<f32>> {
        let t = window.nrows();
        let tr = window.t().as_standard_layout().into_owned();
        let x = tr
            .into_shape_with_order((1, self.feature_dim, t))
            .map_err(|e| SttError::Inference(format!("nemo unified enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("nemo unified enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;
        let outputs = self
            .encoder
            .run(ort::inputs![ "audio_signal" => x_tensor, "length" => len_tensor ])
            .map_err(|e| SttError::Inference(format!("nemo unified encoder run: {e}")))?;
        let enc = out_to_f32(&outputs["outputs"])?;
        let enc_len = out_to_i64(&outputs["encoded_lengths"])?
            .iter()
            .next()
            .copied()
            .unwrap_or(0)
            .max(0) as usize;
        drop(outputs);
        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("nemo unified enc dim: {e}")))?;
        // (1, D, T_enc) → (T_enc, D) rows, then slice the decoded CENTER.
        let full = enc3
            .index_axis_move(Axis(0), 0)
            .reversed_axes()
            .as_standard_layout()
            .into_owned();
        let t_total = full.nrows().min(enc_len);
        let start = u.left_enc.min(t_total);
        let end = (u.left_enc + u.chunk_enc).min(t_total);
        Ok(full.slice(s![start..end, ..]).to_owned())
    }

    fn run_feature_chunk(&mut self, chunk: &Array2<f32>) -> SttResult<()> {
        if chunk.ncols() != self.feature_dim {
            return Err(SttError::Inference(format!(
                "feature dim mismatch: got {}, expected {}",
                chunk.ncols(),
                self.feature_dim
            )));
        }
        let t_enc = std::time::Instant::now();
        let encoder_out = self.run_encoder(chunk)?;
        if let Some(p) = self.profile.as_mut() {
            p.encoder_ms += t_enc.elapsed().as_secs_f64() * 1000.0;
            p.encoder_runs += 1;
        }
        self.decode_encoder_out(&encoder_out)
    }

    /// Run one feature chunk through the streaming encoder, carrying the three cache tensors
    /// DEVICE-RESIDENT via IoBinding: the `*_next` cache outputs are bound to the device and kept as
    /// session-owned `DynValue`s (rebound as the next chunk's `cache_*` inputs) instead of copied to
    /// host and re-fed every chunk. Only `audio_signal`/`length` (fresh per chunk) go host→device and
    /// the `outputs` tensor comes back host-side for the CPU decoder loop — same graph, same values.
    fn run_encoder(&mut self, chunk: &Array2<f32>) -> SttResult<Array2<f32>> {
        let t = chunk.nrows();
        let tr = chunk.t().as_standard_layout().into_owned();
        let x = tr
            .into_shape_with_order((1, self.feature_dim, t))
            .map_err(|e| SttError::Inference(format!("nemo stream enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("nemo stream enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;

        let dev_mem = self.device_mem()?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("nemo stream cpu mem info: {e}")))?;

        // Empty host zero-caches for a fresh stream (first chunk); held here so they outlive the
        // binding through `run_binding`. From chunk 2 on, `state.cache_*` holds the device values.
        let empty_channel = match &self.stream.cache_last_channel {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.cache_last_channel_shape)))
                    .map_err(|e| SttError::Inference(format!("cache_last_channel tensor: {e}")))?,
            ),
        };
        let empty_time = match &self.stream.cache_last_time {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.cache_last_time_shape)))
                    .map_err(|e| SttError::Inference(format!("cache_last_time tensor: {e}")))?,
            ),
        };
        let empty_len = match &self.stream.cache_last_channel_len {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<i64>::zeros(IxDyn(&[1])))
                    .map_err(|e| SttError::Inference(format!("cache len tensor: {e}")))?,
            ),
        };

        // Prompt/language selector for multilingual exports — held here so it outlives `run_binding`.
        let prompt_tensor = match self.prompt_index {
            Some(id) => Some(tensor_i64_1d(vec![id])?),
            None => None,
        };

        let mut binding = self
            .encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("nemo stream enc binding: {e}")))?;
        binding
            .bind_input("audio_signal", &x_tensor)
            .map_err(|e| SttError::Inference(format!("bind audio_signal: {e}")))?;
        binding
            .bind_input("length", &len_tensor)
            .map_err(|e| SttError::Inference(format!("bind length: {e}")))?;
        if let Some(prompt) = &prompt_tensor {
            binding
                .bind_input("prompt_index", prompt)
                .map_err(|e| SttError::Inference(format!("bind prompt_index: {e}")))?;
        }
        bind_cache_input(
            &mut binding,
            "cache_last_channel",
            self.stream.cache_last_channel.as_ref(),
            empty_channel.as_ref(),
        )?;
        bind_cache_input(
            &mut binding,
            "cache_last_time",
            self.stream.cache_last_time.as_ref(),
            empty_time.as_ref(),
        )?;
        bind_cache_input(
            &mut binding,
            "cache_last_channel_len",
            self.stream.cache_last_channel_len.as_ref(),
            empty_len.as_ref(),
        )?;
        // outputs → host (CPU decoder loop consumes it); the three `*_next` caches → device (carried).
        binding
            .bind_output_to_device("outputs", &cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind outputs: {e}")))?;
        for name in [
            "cache_last_channel_next",
            "cache_last_time_next",
            "cache_last_channel_next_len",
        ] {
            binding
                .bind_output_to_device(name, &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
        }

        let mut outputs = self
            .encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("nemo stream encoder run: {e}")))?;
        // DML/CUDA run_binding is async w.r.t. the device stream — sync before reading host `outputs`
        // and before carrying the device `*_next` caches, else we race the still-running kernels.
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("nemo stream enc synchronize: {e}")))?;

        // Encoder output → host (scoped so the borrow ends before the cache `remove`s take `outputs`).
        let enc = {
            let v = outputs.get("outputs").ok_or_else(|| {
                SttError::Inference("nemo stream encoder produced no outputs".into())
            })?;
            out_to_f32(v)?
        };
        // Carry the three `*_next` caches → device (session-owned; survive the binding drop).
        self.stream.cache_last_channel = outputs.remove("cache_last_channel_next");
        self.stream.cache_last_time = outputs.remove("cache_last_time_next");
        self.stream.cache_last_channel_len = outputs.remove("cache_last_channel_next_len");
        if self.stream.cache_last_channel.is_none()
            || self.stream.cache_last_time.is_none()
            || self.stream.cache_last_channel_len.is_none()
        {
            return Err(SttError::Inference(
                "nemo stream encoder produced no cache_*_next outputs".into(),
            ));
        }
        drop(outputs);
        drop(binding);

        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("nemo stream enc dim: {e}")))?;
        // Encoder output is [1, D, T]. The decoder loop consumes [T, D] — force row-major so each
        // frame row borrows as a contiguous zero-copy joiner input (`reversed_axes` only swaps
        // strides; a plain `to_owned` would keep the F-order and force a second copy later).
        Ok(enc3
            .index_axis_move(Axis(0), 0)
            .reversed_axes()
            .as_standard_layout()
            .into_owned())
    }

    fn decode_encoder_out(&mut self, encoder_out: &Array2<f32>) -> SttResult<()> {
        // Ensure contiguous rows so each frame borrows as a zero-copy joiner input below.
        let enc = encoder_out.as_standard_layout();
        // Take (or prime) the carried predictor step. Priming happens ONCE per stream — Pred(last
        // token, zeros); a truly fresh stream primes with blank. Each emitted token advances it,
        // so tokens are consumed by the LSTM exactly once (see `CarriedPred`).
        let mut pred = match self.stream.pred.take() {
            Some(p) => p,
            None => {
                let last = self
                    .stream
                    .cursor
                    .tokens
                    .last()
                    .copied()
                    .unwrap_or(self.blank_id);
                self.prime_pred(last)?
            }
        };

        for t in 0..enc.nrows() {
            let row = enc.row(t);
            let enc_frame = row.as_slice().ok_or_else(|| {
                SttError::Inference("nemo stream encoder row not contiguous".into())
            })?;
            for _ in 0..MAX_SYMBOLS_PER_FRAME {
                let logits = self.run_joiner(enc_frame, &pred.decoder_out)?;
                let (best, _) = argmax_1d(&logits);
                let token = best as i64;
                if token == self.blank_id {
                    self.stream.cursor.num_trailing_blanks += 1;
                    break;
                }
                self.stream.cursor.tokens.push(token);
                self.stream.cursor.num_trailing_blanks = 0;
                pred = self.step_pred(token, &pred)?;
            }
        }

        self.stream.pred = Some(pred);
        self.stream.cursor.frame_offset += enc.nrows();
        Ok(())
    }

    /// Predictor run priming a fresh stream: `Pred(token, zero LSTM state)`.
    fn prime_pred(&mut self, token: i64) -> SttResult<CarriedPred> {
        let t_run = std::time::Instant::now();
        let targets = tensor_i32((1, 1), vec![token as i32])?;
        let target_length = tensor_i32_1d(vec![1])?;
        let st0 = Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_0)))
            .map_err(|e| SttError::Inference(format!("decoder state0 tensor: {e}")))?;
        let st1 = Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_1)))
            .map_err(|e| SttError::Inference(format!("decoder state1 tensor: {e}")))?;
        let outputs = self
            .decoder
            .run(ort::inputs![
                self.decoder_input_names[0].as_str() => targets,
                self.decoder_input_names[1].as_str() => target_length,
                self.decoder_input_names[2].as_str() => st0,
                self.decoder_input_names[3].as_str() => st1,
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream decoder run: {e}")))?;
        let pred = take_pred_outputs(outputs, &self.decoder_output_names)?;
        if let Some(p) = self.profile.as_mut() {
            p.decoder_ms += t_run.elapsed().as_secs_f64() * 1000.0;
            p.decoder_runs += 1;
        }
        Ok(pred)
    }

    /// Predictor run advancing the carried step after an emission: `Pred(token, post_state)`.
    /// The carried states pass as zero-copy views — no host extraction, no re-upload.
    fn step_pred(&mut self, token: i64, prev: &CarriedPred) -> SttResult<CarriedPred> {
        let t_run = std::time::Instant::now();
        let targets = tensor_i32((1, 1), vec![token as i32])?;
        let target_length = tensor_i32_1d(vec![1])?;
        let outputs = self
            .decoder
            .run(ort::inputs![
                self.decoder_input_names[0].as_str() => targets,
                self.decoder_input_names[1].as_str() => target_length,
                self.decoder_input_names[2].as_str() => prev.post_state.0.view(),
                self.decoder_input_names[3].as_str() => prev.post_state.1.view(),
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream decoder run: {e}")))?;
        let pred = take_pred_outputs(outputs, &self.decoder_output_names)?;
        if let Some(p) = self.profile.as_mut() {
            p.decoder_ms += t_run.elapsed().as_secs_f64() * 1000.0;
            p.decoder_runs += 1;
        }
        Ok(pred)
    }

    /// Joiner over ONE encoder frame (borrowed zero-copy as `(1, D, 1)`) and the carried
    /// `decoder_out` (borrowed as a view — reused across frames, never cloned).
    fn run_joiner(&mut self, enc_frame: &[f32], decoder_out: &DynValue) -> SttResult<Vec<f32>> {
        let t_run = std::time::Instant::now();
        let enc_shape = [1usize, enc_frame.len(), 1usize];
        let enc_ref = ort::value::TensorRef::from_array_view((enc_shape.as_slice(), enc_frame))
            .map_err(|e| SttError::Inference(format!("joiner enc view: {e}")))?;
        let outputs = self
            .joiner
            .run(ort::inputs![
                "encoder_outputs" => enc_ref,
                "decoder_outputs" => decoder_out.view(),
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream joiner run: {e}")))?;
        let logits = out_to_f32(&outputs["outputs"])?;
        let out = logits.iter().copied().take(self.vocab_size).collect();
        if let Some(p) = self.profile.as_mut() {
            p.joiner_ms += t_run.elapsed().as_secs_f64() * 1000.0;
            p.joiner_runs += 1;
        }
        Ok(out)
    }

    fn current_text(&self) -> String {
        let blank_id = self.blank_id;
        self.stream.cursor.decode_text(&self.vocab, |id, sym| {
            // Drop the blank AND any `<...>`-framed special/language token — the prompt-conditioned
            // multilingual decoder (Nemotron-3.5) emits language tags like `<en-US>` / `<unk>` that
            // must never reach the transcript.
            id != blank_id && !is_framed_special_token(sym)
        })
    }
}

impl NemoStreamState {
    fn empty() -> Self {
        Self {
            cursor: StreamCursor::new(),
            cache_last_channel: None,
            cache_last_time: None,
            cache_last_channel_len: None,
            pred: None,
        }
    }
}

impl Transcriber for NativeNemoStreamingEngine {
    fn kind(&self) -> EngineKind {
        self.kind
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_ready(&self) -> bool {
        true
    }

    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        self.stream_reset();
        self.stream_accept(audio)?;
        self.stream_accept(&vec![0.0; streaming::FINAL_SILENCE_PAD_SAMPLES])?;
        let text = self.stream_finalize()?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }

    fn supports_native_streaming(&self) -> bool {
        true
    }

    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if !pcm.is_empty() {
            self.stream.cursor.pcm.extend_from_slice(pcm);
            self.process_available_chunks(false)?;
        }
        Ok(NativeStreamUpdate::interim(self.current_text()))
    }

    fn stream_finalize(&mut self) -> SttResult<String> {
        streaming::append_final_silence_pad(&mut self.stream.cursor.pcm);
        self.process_available_chunks(true)?;
        if let Some(p) = self.profile.as_ref() {
            eprintln!(
                "[nemo-stream-profile] feat={:.1}ms enc={:.1}ms/{} runs ({:.1}ms/run) dec={:.1}ms/{} runs ({:.2}ms/run) join={:.1}ms/{} runs ({:.2}ms/run)",
                p.feat_ms,
                p.encoder_ms,
                p.encoder_runs,
                p.encoder_ms / p.encoder_runs.max(1) as f64,
                p.decoder_ms,
                p.decoder_runs,
                p.decoder_ms / p.decoder_runs.max(1) as f64,
                p.joiner_ms,
                p.joiner_runs,
                p.joiner_ms / p.joiner_runs.max(1) as f64,
            );
        }
        Ok(self.current_text())
    }

    fn stream_reset(&mut self) {
        self.stream = self.fresh_stream_state();
        if let Some(p) = self.profile.as_mut() {
            *p = StreamProfile::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::NativeNemoStreamingEngine;
    use super::streaming::meta_usize;
    use crate::winstt::stt::{EngineConfig, EngineKind, Quantization, ResolvedModel};

    #[test]
    fn supports_only_split_nemo_streaming_bundles() {
        let cfg = EngineConfig {
            model_name: "streaming-nemotron-en-80ms-int8".into(),
            family: "nemo".into(),
            kind: EngineKind::NemoRnntStreaming,
            resolved: ResolvedModel {
                files: [
                    ("encoder".into(), "encoder.onnx".into()),
                    ("decoder".into(), "decoder.onnx".into()),
                    ("joiner".into(), "joiner.onnx".into()),
                    ("vocab".into(), "tokens.txt".into()),
                ]
                .into_iter()
                .collect(),
                effective_quantization: Quantization::Int8,
            },
            providers: vec![crate::winstt::stt::Accelerator::DirectMl],
            whisper_fp16_workaround: false,
            language: None,
        };
        assert!(NativeNemoStreamingEngine::supports(&cfg));
    }

    #[test]
    fn metadata_parser_reports_missing_keys() {
        let meta = BTreeMap::new();
        assert!(meta_usize(&meta, "window_size", "NeMo streaming").is_err());
    }

    #[test]
    fn framed_special_tokens_are_stripped() {
        // Language tags + specials the multilingual decoder emits (must be dropped).
        for t in [
            "<en-US>", "<ja-JP>", "<ar-AR>", "<unk>", "<blk>", "<s>", "<>",
        ] {
            assert!(super::is_framed_special_token(t), "{t} should be framed");
        }
        // Real content subwords (must be kept).
        for t in ["Real", "Madrid", " team", ".", "<", ">", "a<b", "3<5"] {
            assert!(!super::is_framed_special_token(t), "{t} must be kept");
        }
    }

    #[test]
    fn prompt_index_resolves_language_via_dictionary() {
        let mut meta = BTreeMap::new();
        meta.insert("auto_prompt_id".to_string(), "101".to_string());
        meta.insert(
            "prompt_dictionary".to_string(),
            r#"{"en": 0, "en-US": 0, "ar": 7, "ja-JP": 10, "auto": 101}"#.to_string(),
        );
        // None / blank -> auto-detect.
        assert_eq!(super::resolve_prompt_index(&meta, None), 101);
        assert_eq!(super::resolve_prompt_index(&meta, Some("  ")), 101);
        // Exact + case-insensitive.
        assert_eq!(super::resolve_prompt_index(&meta, Some("ar")), 7);
        assert_eq!(super::resolve_prompt_index(&meta, Some("EN")), 0);
        // Base-language fallback ("ja" matches "ja-JP").
        assert_eq!(super::resolve_prompt_index(&meta, Some("ja")), 10);
        // Unknown language -> auto.
        assert_eq!(super::resolve_prompt_index(&meta, Some("zz")), 101);
        // Missing dictionary -> auto.
        let mut bare = BTreeMap::new();
        bare.insert("auto_prompt_id".to_string(), "42".to_string());
        assert_eq!(super::resolve_prompt_index(&bare, Some("ar")), 42);
    }
}
