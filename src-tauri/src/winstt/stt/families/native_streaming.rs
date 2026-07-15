//! Native ORT streaming engines for sherpa-format CTC and Zipformer exports.
//!
//! These replace the old external streaming STT runtime path. The models still use
//! the same published ONNX graph layouts, but session creation and provider routing now go through
//! WinSTT's shared `ort` stack.

use std::collections::BTreeMap;

use ndarray::{Array2, ArrayD, Axis, IxDyn, s};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::{IoBinding, Session};
use ort::value::{DynValue, Tensor, Value, ValueTypeMarker};

use super::frontend;
use super::streaming::{self, StreamCursor};
use super::support::*;
use crate::winstt::stt::{
    Accelerator, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription,
};

/// Map the active provider list to the ORT allocation device for binding carried streaming state
/// device-resident (CPU when no GPU EP; then IoBinding simply binds host memory, still correct).
/// Mirrors whisper's `device_for_providers` / cohere's `cohere_device`.
fn native_stream_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// Bind a carried state input: the device `DynValue` from the previous chunk when present, else the
/// host zero-tensor built for a fresh stream's first chunk. Exactly one of `carried`/`empty` is Some.
fn bind_state_input<T: ValueTypeMarker + ?Sized>(
    binding: &mut IoBinding,
    name: &str,
    carried: Option<&DynValue>,
    empty: Option<&Value<T>>,
) -> SttResult<()> {
    match (carried, empty) {
        (Some(v), _) => binding.bind_input(name, v),
        (None, Some(t)) => binding.bind_input(name, t),
        (None, None) => {
            return Err(SttError::Inference(format!(
                "native stream state '{name}' has neither carried nor empty tensor"
            )));
        }
    }
    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))
}

/// Host `MemoryInfo` for outputs that must come back to the CPU decode loop (logits).
fn cpu_output_mem() -> SttResult<MemoryInfo> {
    MemoryInfo::new(
        AllocationDevice::CPU,
        0,
        AllocatorType::Device,
        MemoryType::CPUOutput,
    )
    .map_err(|e| SttError::Inference(format!("native stream cpu mem info: {e}")))
}

pub struct NativeNemoCtcStreamingEngine {
    session: Session,
    vocab: Vocab,
    model_name: String,
    providers: Vec<String>,
    mel_fb: Array2<f32>,
    feature_dim: usize,
    window_size: usize,
    chunk_shift: usize,
    blank_id: i64,
    input_names: Vec<String>,
    output_names: Vec<String>,
    logits_output: String,
    cache_last_channel_shape: Vec<usize>,
    cache_last_time_shape: Vec<usize>,
    /// ORT allocation device the session runs on, for binding the carried cache resident.
    device: AllocationDevice,
    device_id: i32,
    stream: NemoCtcStreamState,
}

/// Per-stream carried state. The three encoder cache tensors are carried DEVICE-RESIDENT across
/// feature chunks: `None` on a fresh stream (the empty zero-cache is built host-side for the first
/// chunk only), then each chunk's `*_next` outputs are kept as session-owned device `DynValue`s and
/// rebound as the next chunk's `cache_*` inputs — no per-chunk host round-trip.
struct NemoCtcStreamState {
    cursor: StreamCursor,
    cache_last_channel: Option<DynValue>,
    cache_last_time: Option<DynValue>,
    cache_last_channel_len: Option<DynValue>,
}

impl NativeNemoCtcStreamingEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let session = build_session(file(&cfg.resolved, "model")?, &cfg.providers)?;
        let metadata = read_custom_metadata(&session)?;
        let feature_dim = feat_dim_of(&session, "audio_signal").clamp(1, 128);
        let window_size = streaming::meta_usize(&metadata, "window_size", "streaming")?;
        let chunk_shift = streaming::meta_usize(&metadata, "chunk_shift", "streaming")?;
        let vocab_size =
            streaming::meta_usize(&metadata, "vocab_size", "streaming").unwrap_or(0) + 1;
        let blank_id = vocab_size.saturating_sub(1) as i64;
        let cache_last_channel_shape = vec![
            1,
            streaming::meta_usize(&metadata, "cache_last_channel_dim1", "streaming")?,
            streaming::meta_usize(&metadata, "cache_last_channel_dim2", "streaming")?,
            streaming::meta_usize(&metadata, "cache_last_channel_dim3", "streaming")?,
        ];
        let cache_last_time_shape = vec![
            1,
            streaming::meta_usize(&metadata, "cache_last_time_dim1", "streaming")?,
            streaming::meta_usize(&metadata, "cache_last_time_dim2", "streaming")?,
            streaming::meta_usize(&metadata, "cache_last_time_dim3", "streaming")?,
        ];

        let input_names = node_input_names(&session);
        let output_names = node_output_names(&session);
        let logits_output = output_names
            .iter()
            .find(|n| {
                let l = n.to_lowercase();
                l.contains("logit") || l.contains("logprob") || l.contains("log_prob")
            })
            .cloned()
            .unwrap_or_else(|| {
                output_names
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "logits".into())
            });

        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let (device, device_id) = native_stream_device(&cfg.providers);
        let mut engine = Self {
            session,
            vocab,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            mel_fb: frontend::build_nemo_mel_filterbank(feature_dim),
            feature_dim,
            window_size,
            chunk_shift,
            blank_id,
            input_names,
            output_names,
            logits_output,
            cache_last_channel_shape,
            cache_last_time_shape,
            device,
            device_id,
            stream: NemoCtcStreamState::empty(),
        };
        engine.stream = engine.fresh_stream_state();
        Ok(engine)
    }

    pub fn supports(cfg: &EngineConfig) -> bool {
        cfg.kind == EngineKind::NemoCtcStreaming
            && cfg.resolved.files.contains_key("model")
            && cfg.resolved.files.contains_key("vocab")
    }

    fn fresh_stream_state(&self) -> NemoCtcStreamState {
        NemoCtcStreamState {
            cursor: StreamCursor::new(),
            // Device-resident encoder cache starts empty; the first chunk binds host zero-tensors.
            cache_last_channel: None,
            cache_last_time: None,
            cache_last_channel_len: None,
        }
    }

    /// Device `MemoryInfo` for binding the carried encoder cache resident (CPU when no GPU EP).
    fn device_mem(&self) -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("native stream device mem info: {e}")))
    }

    fn process_available_chunks(&mut self, finalize: bool) -> SttResult<bool> {
        let features = frontend::nemo_features_with_normalization(
            &self.stream.cursor.pcm,
            &self.mel_fb,
            frontend::NemoNorm::None,
        );
        let mut processed_any = false;
        loop {
            let rel_start = self.stream.cursor.rel_start();
            if !streaming::chunk_ready(rel_start, self.window_size, features.nrows(), finalize) {
                break;
            }
            let chunk = features
                .slice(s![rel_start..rel_start + self.window_size, ..])
                .to_owned();
            let logits = self.run_chunk(&chunk)?;
            self.decode_ctc_logits(&logits);
            self.stream.cursor.next_chunk_frame += self.chunk_shift;
            processed_any = true;
        }
        if processed_any {
            self.stream.cursor.trim_pcm(frontend::NEMO_HOP);
        }
        Ok(processed_any)
    }

    /// Run one feature chunk through the streaming CTC graph, carrying the three encoder cache
    /// tensors DEVICE-RESIDENT via IoBinding: the `*_next` cache outputs (graph output slots 2/3/4,
    /// when present) are bound to the device and kept as session-owned `DynValue`s, rebound as the
    /// next chunk's `cache_*` inputs, instead of copied to host and re-fed each chunk. `logits`
    /// comes back host-side for the CTC decode. Every graph output is bound (ORT's `RunWithBinding`
    /// contract): logits + caches as above, any other declared outputs to the device to satisfy it.
    fn run_chunk(&mut self, chunk: &Array2<f32>) -> SttResult<Array2<f32>> {
        if chunk.ncols() != self.feature_dim {
            return Err(SttError::Inference(format!(
                "nemo CTC stream feature dim mismatch: got {}, expected {}",
                chunk.ncols(),
                self.feature_dim
            )));
        }

        let tr = chunk.t().as_standard_layout().into_owned();
        let x = tr
            .into_shape_with_order((1, self.feature_dim, chunk.nrows()))
            .map_err(|e| SttError::Inference(format!("nemo CTC stream reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("nemo CTC stream tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![chunk.nrows() as i64])?;

        let input0 = self
            .input_names
            .first()
            .cloned()
            .unwrap_or_else(|| "audio_signal".into());
        let input1 = self
            .input_names
            .get(1)
            .cloned()
            .unwrap_or_else(|| "length".into());
        // Cache input names (slots 2/3/4) — present only on streaming exports; a plain single-graph
        // CTC export has just [audio_signal, length] and carries no cache (same as before).
        let cache_in_names: [Option<String>; 3] = [
            self.input_names.get(2).cloned(),
            self.input_names.get(3).cloned(),
            self.input_names.get(4).cloned(),
        ];
        let cache_out_names: [Option<String>; 3] = [
            self.output_names.get(2).cloned(),
            self.output_names.get(3).cloned(),
            self.output_names.get(4).cloned(),
        ];

        // Empty host zero-caches for a fresh stream's first chunk; held here so they outlive the
        // binding through `run_binding`. From chunk 2 on, `state.cache_*` holds the device values.
        let empty_channel = match &self.stream.cache_last_channel {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.cache_last_channel_shape)))
                    .map_err(|e| {
                        SttError::Inference(format!("ctc cache_last_channel tensor: {e}"))
                    })?,
            ),
        };
        let empty_time = match &self.stream.cache_last_time {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&self.cache_last_time_shape)))
                    .map_err(|e| SttError::Inference(format!("ctc cache_last_time tensor: {e}")))?,
            ),
        };
        let empty_len = match &self.stream.cache_last_channel_len {
            Some(_) => None,
            None => Some(
                Tensor::from_array(ArrayD::<i64>::zeros(IxDyn(&[1])))
                    .map_err(|e| SttError::Inference(format!("ctc cache len tensor: {e}")))?,
            ),
        };

        let dev_mem = self.device_mem()?;
        let cpu_mem = cpu_output_mem()?;

        let mut binding = self
            .session
            .create_binding()
            .map_err(|e| SttError::Inference(format!("nemo CTC stream binding: {e}")))?;
        binding
            .bind_input(input0.as_str(), &x_tensor)
            .map_err(|e| SttError::Inference(format!("bind {input0}: {e}")))?;
        binding
            .bind_input(input1.as_str(), &len_tensor)
            .map_err(|e| SttError::Inference(format!("bind {input1}: {e}")))?;
        if let Some(name) = &cache_in_names[0] {
            bind_state_input(
                &mut binding,
                name,
                self.stream.cache_last_channel.as_ref(),
                empty_channel.as_ref(),
            )?;
        }
        if let Some(name) = &cache_in_names[1] {
            bind_state_input(
                &mut binding,
                name,
                self.stream.cache_last_time.as_ref(),
                empty_time.as_ref(),
            )?;
        }
        if let Some(name) = &cache_in_names[2] {
            bind_state_input(
                &mut binding,
                name,
                self.stream.cache_last_channel_len.as_ref(),
                empty_len.as_ref(),
            )?;
        }

        // Bind EVERY declared output: logits → host; cache-next (slots 2/3/4) → device; anything
        // else the graph declares → device (computed either way, satisfies the all-bound contract).
        for name in &self.output_names {
            if name == &self.logits_output {
                binding
                    .bind_output_to_device(name.as_str(), &cpu_mem)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            } else {
                binding
                    .bind_output_to_device(name.as_str(), &dev_mem)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }
        }

        let mut outputs = self
            .session
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("nemo CTC stream run: {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("nemo CTC stream synchronize: {e}")))?;

        // logits → host (scoped so the borrow ends before the cache `remove`s take `outputs`).
        let logits = {
            let v = outputs
                .get(self.logits_output.as_str())
                .ok_or_else(|| SttError::Inference("nemo CTC stream produced no logits".into()))?;
            out_to_f32(v)?
        };
        // Carry the `*_next` caches → device (session-owned; survive the binding drop). Only for the
        // slots the graph actually declares — a plain CTC export carries nothing (unchanged).
        if let Some(name) = &cache_out_names[0] {
            self.stream.cache_last_channel = outputs.remove(name.as_str());
        }
        if let Some(name) = &cache_out_names[1] {
            self.stream.cache_last_time = outputs.remove(name.as_str());
        }
        if let Some(name) = &cache_out_names[2] {
            self.stream.cache_last_channel_len = outputs.remove(name.as_str());
        }
        drop(outputs);
        drop(binding);

        let rank = logits.ndim();
        match rank {
            3 => {
                let l = logits
                    .into_dimensionality::<ndarray::Ix3>()
                    .map_err(|e| SttError::Inference(format!("nemo CTC logits dim: {e}")))?;
                let b0 = l.index_axis_move(Axis(0), 0);
                if b0.ncols() == self.vocab.size + 1 || b0.ncols() >= b0.nrows() {
                    Ok(b0.to_owned())
                } else {
                    Ok(b0.reversed_axes().to_owned())
                }
            }
            2 => logits
                .into_dimensionality::<ndarray::Ix2>()
                .map_err(|e| SttError::Inference(format!("nemo CTC logits ix2: {e}"))),
            _ => Err(SttError::Inference(format!(
                "nemo CTC logits rank {rank} unsupported"
            ))),
        }
    }

    fn decode_ctc_logits(&mut self, logits: &Array2<f32>) {
        let mut prev_id = if self.stream.cursor.tokens.is_empty() {
            -1
        } else if self.stream.cursor.num_trailing_blanks > 0 {
            self.blank_id
        } else {
            *self.stream.cursor.tokens.last().unwrap_or(&self.blank_id)
        };

        for row in logits.rows() {
            let (best, _) = argmax_iter(row.iter().copied());
            let y = best as i64;
            if y == self.blank_id {
                self.stream.cursor.num_trailing_blanks += 1;
            } else {
                self.stream.cursor.num_trailing_blanks = 0;
            }
            if y != self.blank_id && y != prev_id {
                self.stream.cursor.tokens.push(y);
            }
            prev_id = y;
        }
        self.stream.cursor.frame_offset += logits.nrows();
    }

    fn current_text(&self) -> String {
        self.stream
            .cursor
            .decode_text(&self.vocab, |_id, sym| !is_special_token(sym))
    }
}

impl NemoCtcStreamState {
    fn empty() -> Self {
        Self {
            cursor: StreamCursor::new(),
            cache_last_channel: None,
            cache_last_time: None,
            cache_last_channel_len: None,
        }
    }
}

impl Transcriber for NativeNemoCtcStreamingEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::NemoCtcStreaming
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
        self.stream
            .cursor
            .pcm
            .extend_from_slice(&streaming::final_silence_pad());
        self.process_available_chunks(true)?;
        Ok(self.current_text())
    }

    fn stream_reset(&mut self) {
        self.stream = self.fresh_stream_state();
    }
}

pub struct NativeZipformerStreamingEngine {
    encoder: Session,
    decoder: Session,
    joiner: Session,
    vocab: Vocab,
    model_name: String,
    providers: Vec<String>,
    mel_fb: Array2<f32>,
    chunk_size: usize,
    chunk_shift: usize,
    context_size: usize,
    blank_id: i64,
    unk_id: Option<i64>,
    encoder_input_names: Vec<String>,
    encoder_output_names: Vec<String>,
    state_input_names: Vec<String>,
    state_output_names: Vec<String>,
    /// Per-state initial (empty) shapes + i64-ness, resolved once at load so a fresh stream's first
    /// chunk can build the host zero-tensors that seed the device-resident carry.
    state_shapes: BTreeMap<String, Vec<usize>>,
    state_is_i64: BTreeMap<String, bool>,
    /// ORT allocation device the encoder runs on, for binding the carried state resident.
    device: AllocationDevice,
    device_id: i32,
    vocab_size: usize,
    stream: ZipformerStreamState,
}

/// Per-stream carried state. The variadic encoder state tensors are carried DEVICE-RESIDENT across
/// feature chunks: `states` is empty on a fresh stream (first chunk binds host zero-tensors from
/// `state_shapes`), then each chunk's encoder state outputs are kept as session-owned device
/// `DynValue`s (keyed by the matching state INPUT name) and rebound next chunk — no host round-trip.
struct ZipformerStreamState {
    cursor: StreamCursor,
    states: BTreeMap<String, DynValue>,
}

impl NativeZipformerStreamingEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        let joiner = build_session(file(&cfg.resolved, "joiner")?, &cfg.providers)?;

        let encoder_meta = read_custom_metadata(&encoder)?;
        let decoder_meta = read_custom_metadata(&decoder)?;
        let chunk_size = streaming::meta_usize(&encoder_meta, "T", "streaming")?;
        let chunk_shift = streaming::meta_usize(&encoder_meta, "decode_chunk_len", "streaming")?;
        let context_size = decoder_meta
            .get("context_size")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(2);
        let vocab_size = decoder_meta
            .get("vocab_size")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);

        let encoder_input_names = node_input_names(&encoder);
        let encoder_output_names = node_output_names(&encoder);
        let state_input_names = encoder_input_names
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>();
        let state_output_names = encoder_output_names
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>();
        if state_input_names.len() != state_output_names.len() {
            return Err(SttError::SessionCreate(format!(
                "zipformer streaming state input/output mismatch: {} inputs, {} outputs",
                state_input_names.len(),
                state_output_names.len()
            )));
        }

        // Resolve each state input's initial (empty) shape + dtype ONCE at load, so a fresh stream's
        // first chunk can seed host zero-tensors before the device-resident carry takes over.
        let mut state_shapes: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut state_is_i64: BTreeMap<String, bool> = BTreeMap::new();
        for name in &state_input_names {
            let shape = input_shape_or(&encoder, name, 1)
                .ok_or_else(|| SttError::SessionCreate(format!("missing state input {name}")))?;
            let is_i64 = input_is_i64(&encoder, name) || name == "processed_lens";
            state_shapes.insert(name.clone(), shape);
            state_is_i64.insert(name.clone(), is_i64);
        }

        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let unk_id = vocab
            .id_to_sym
            .iter()
            .find(|(_, s)| s.as_str() == "<unk>")
            .map(|(id, _)| *id);
        let (device, device_id) = native_stream_device(&cfg.providers);
        let engine = Self {
            encoder,
            decoder,
            joiner,
            vocab,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            mel_fb: frontend::build_zipformer_mel_filterbank(),
            chunk_size,
            chunk_shift,
            context_size,
            blank_id: 0,
            unk_id,
            encoder_input_names,
            encoder_output_names,
            state_input_names,
            state_output_names,
            state_shapes,
            state_is_i64,
            device,
            device_id,
            vocab_size,
            stream: ZipformerStreamState::empty(),
        };
        Ok(engine)
    }

    pub fn supports(cfg: &EngineConfig) -> bool {
        cfg.kind == EngineKind::KaldiTransducerStreaming
            && cfg.resolved.files.contains_key("encoder")
            && cfg.resolved.files.contains_key("decoder")
            && cfg.resolved.files.contains_key("joiner")
            && cfg.resolved.files.contains_key("vocab")
    }

    /// A fresh stream carries no device state yet — the first chunk seeds host zero-tensors from
    /// `state_shapes`/`state_is_i64`, and from chunk 2 on the device outputs are carried.
    fn fresh_stream_state(&self) -> ZipformerStreamState {
        ZipformerStreamState::empty()
    }

    /// Device `MemoryInfo` for binding the carried encoder state resident (CPU when no GPU EP).
    fn device_mem(&self) -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("zipformer device mem info: {e}")))
    }

    fn process_available_chunks(&mut self, finalize: bool) -> SttResult<bool> {
        let features = frontend::compute_kaldi_fbank(&self.stream.cursor.pcm, &self.mel_fb);
        let mut processed_any = false;
        loop {
            let rel_start = self.stream.cursor.rel_start();
            if !streaming::chunk_ready(rel_start, self.chunk_size, features.nrows(), finalize) {
                break;
            }
            let chunk = features
                .slice(s![rel_start..rel_start + self.chunk_size, ..])
                .to_owned();
            let encoder_out = self.run_encoder(&chunk)?;
            self.decode_encoder_out(&encoder_out)?;
            self.stream.cursor.next_chunk_frame += self.chunk_shift;
            processed_any = true;
        }
        if processed_any {
            self.stream.cursor.trim_pcm(frontend::KALDI_HOP);
        }
        Ok(processed_any)
    }

    /// Run one feature chunk through the streaming encoder, carrying the variadic encoder state
    /// tensors DEVICE-RESIDENT via IoBinding: each state output is bound to the device and kept as a
    /// session-owned `DynValue` (keyed by its matching state INPUT name), rebound as the next chunk's
    /// state input, instead of copied to host and re-fed each chunk. `x` goes host→device and
    /// `encoder_out` comes back host-side for the CPU joiner loop — same graph, same values.
    fn run_encoder(&mut self, chunk: &Array2<f32>) -> SttResult<Array2<f32>> {
        let x_tensor = Tensor::from_array(
            chunk
                .clone()
                .into_shape_with_order((1, chunk.nrows(), chunk.ncols()))
                .map_err(|e| SttError::Inference(format!("zipformer x reshape: {e}")))?,
        )
        .map_err(|e| SttError::Inference(format!("zipformer x tensor: {e}")))?;
        let x_name = self
            .encoder_input_names
            .first()
            .cloned()
            .unwrap_or_else(|| "x".into());

        // Empty host zero-tensors for a fresh stream's first chunk (dtype-matched per state); held
        // here so they outlive the binding through `run_binding`. From chunk 2 on `state.states`
        // holds the device values. Parallel `Vec`s indexed alongside `state_input_names`.
        let mut empty_f32: Vec<Option<Tensor<f32>>> =
            Vec::with_capacity(self.state_input_names.len());
        let mut empty_i64: Vec<Option<Tensor<i64>>> =
            Vec::with_capacity(self.state_input_names.len());
        for name in &self.state_input_names {
            if self.stream.states.contains_key(name) {
                empty_f32.push(None);
                empty_i64.push(None);
                continue;
            }
            let shape = self
                .state_shapes
                .get(name)
                .cloned()
                .unwrap_or_else(|| vec![1]);
            if *self.state_is_i64.get(name).unwrap_or(&false) {
                empty_f32.push(None);
                empty_i64.push(Some(
                    Tensor::from_array(ArrayD::<i64>::zeros(IxDyn(&shape)))
                        .map_err(|e| SttError::Inference(format!("zipformer state {name}: {e}")))?,
                ));
            } else {
                empty_i64.push(None);
                empty_f32.push(Some(
                    Tensor::from_array(ArrayD::<f32>::zeros(IxDyn(&shape)))
                        .map_err(|e| SttError::Inference(format!("zipformer state {name}: {e}")))?,
                ));
            }
        }

        let dev_mem = self.device_mem()?;
        let cpu_mem = cpu_output_mem()?;

        let mut binding = self
            .encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("zipformer encoder binding: {e}")))?;
        binding
            .bind_input(x_name.as_str(), &x_tensor)
            .map_err(|e| SttError::Inference(format!("bind {x_name}: {e}")))?;
        for (i, name) in self.state_input_names.iter().enumerate() {
            match self.stream.states.get(name) {
                Some(v) => binding
                    .bind_input(name.as_str(), v)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?,
                None => {
                    if let Some(t) = &empty_f32[i] {
                        binding
                            .bind_input(name.as_str(), t)
                            .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                    } else if let Some(t) = &empty_i64[i] {
                        binding
                            .bind_input(name.as_str(), t)
                            .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                    } else {
                        return Err(SttError::Inference(format!(
                            "missing zipformer state input {name}"
                        )));
                    }
                }
            }
        }
        // Bind EVERY declared output: encoder_out (slot 0) → host; state outputs → device (carried).
        let enc_name = self
            .encoder_output_names
            .first()
            .cloned()
            .unwrap_or_else(|| "encoder_out".into());
        binding
            .bind_output_to_device(enc_name.as_str(), &cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind {enc_name}: {e}")))?;
        for name in &self.state_output_names {
            binding
                .bind_output_to_device(name.as_str(), &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
        }

        let mut outputs = self
            .encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("zipformer encoder run: {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("zipformer encoder synchronize: {e}")))?;

        // encoder_out → host (scoped so the borrow ends before the state `remove`s take `outputs`).
        let enc = {
            let v = outputs
                .get(enc_name.as_str())
                .ok_or_else(|| SttError::Inference("zipformer produced no encoder_out".into()))?;
            out_to_f32(v)?
        };
        // Carry each state output → device, keyed by the matching state INPUT name (session-owned;
        // survives the binding drop → rebound next chunk).
        for (input_name, output_name) in self.state_input_names.iter().zip(&self.state_output_names)
        {
            let v = outputs.remove(output_name.as_str()).ok_or_else(|| {
                SttError::Inference(format!("zipformer produced no state output {output_name}"))
            })?;
            self.stream.states.insert(input_name.clone(), v);
        }
        drop(outputs);
        drop(binding);

        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("zipformer encoder_out dim: {e}")))?;
        Ok(enc3.index_axis_move(Axis(0), 0).to_owned())
    }

    fn decode_encoder_out(&mut self, encoder_out: &Array2<f32>) -> SttResult<()> {
        let mut decoder_out = self.run_decoder()?;
        for t in 0..encoder_out.nrows() {
            let enc_frame = encoder_out.index_axis(Axis(0), t);
            let token = self.run_joiner_token(enc_frame, &decoder_out)?;
            if token != self.blank_id && Some(token) != self.unk_id {
                self.stream.cursor.tokens.push(token);
                self.stream.cursor.num_trailing_blanks = 0;
                decoder_out = self.run_decoder()?;
            } else {
                self.stream.cursor.num_trailing_blanks += 1;
            }
        }
        self.stream.cursor.frame_offset += encoder_out.nrows();
        Ok(())
    }

    fn run_decoder(&mut self) -> SttResult<ArrayD<f32>> {
        let mut ctx_full = vec![-1, self.blank_id];
        ctx_full.extend_from_slice(&self.stream.cursor.tokens);
        let ctx = &ctx_full[ctx_full.len().saturating_sub(self.context_size)..];
        let y_tensor = tensor_i64((1, ctx.len()), ctx.to_vec())?;
        let outputs = self
            .decoder
            .run(ort::inputs!["y" => y_tensor])
            .map_err(|e| SttError::Inference(format!("zipformer decoder run: {e}")))?;
        out_to_f32(&outputs["decoder_out"])
    }

    fn run_joiner_token(
        &mut self,
        enc_frame: ndarray::ArrayView1<'_, f32>,
        decoder_out: &ArrayD<f32>,
    ) -> SttResult<i64> {
        let enc = enc_frame
            .into_shape_with_order((1, enc_frame.len()))
            .map_err(|e| SttError::Inference(format!("zipformer joiner enc reshape: {e}")))?
            .to_owned();
        let enc_tensor = Tensor::from_array(enc)
            .map_err(|e| SttError::Inference(format!("zipformer joiner enc tensor: {e}")))?;
        let dec_tensor = Tensor::from_array(decoder_out.clone())
            .map_err(|e| SttError::Inference(format!("zipformer joiner dec tensor: {e}")))?;
        let outputs = self
            .joiner
            .run(ort::inputs![
                "encoder_out" => enc_tensor,
                "decoder_out" => dec_tensor,
            ])
            .map_err(|e| SttError::Inference(format!("zipformer joiner run: {e}")))?;
        let logit = out_to_f32(&outputs["logit"])?;
        let take = if self.vocab_size > 0 {
            self.vocab_size.min(logit.len())
        } else {
            logit.len()
        };
        let (best, _) = argmax_iter(logit.iter().take(take).copied());
        Ok(best as i64)
    }

    fn current_text(&self) -> String {
        self.stream
            .cursor
            .decode_text(&self.vocab, |_id, sym| !is_special_token(sym))
    }
}

impl ZipformerStreamState {
    fn empty() -> Self {
        Self {
            cursor: StreamCursor::new(),
            states: BTreeMap::new(),
        }
    }
}

impl Transcriber for NativeZipformerStreamingEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::KaldiTransducerStreaming
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
        self.stream
            .cursor
            .pcm
            .extend_from_slice(&streaming::final_silence_pad());
        self.process_available_chunks(true)?;
        Ok(self.current_text())
    }

    fn stream_reset(&mut self) {
        self.stream = self.fresh_stream_state();
    }
}

#[cfg(test)]
mod tests {
    use super::{NativeNemoCtcStreamingEngine, NativeZipformerStreamingEngine};
    use crate::winstt::stt::{Accelerator, EngineConfig, EngineKind, Quantization, ResolvedModel};

    fn make_cfg(kind: EngineKind, keys: &[&str]) -> EngineConfig {
        EngineConfig {
            model_name: "streaming-test".into(),
            family: "test".into(),
            kind,
            resolved: ResolvedModel {
                files: keys
                    .iter()
                    .map(|k| {
                        (
                            (*k).to_string(),
                            std::path::PathBuf::from(format!("{k}.onnx")),
                        )
                    })
                    .collect(),
                effective_quantization: Quantization::Default,
            },
            providers: vec![Accelerator::Cpu],
            whisper_fp16_workaround: false,
            language: None,
        }
    }

    #[test]
    fn ctc_supports_single_graph_bundle() {
        let cfg = make_cfg(EngineKind::NemoCtcStreaming, &["model", "vocab"]);
        assert!(NativeNemoCtcStreamingEngine::supports(&cfg));
        let missing = make_cfg(EngineKind::NemoCtcStreaming, &["model"]);
        assert!(!NativeNemoCtcStreamingEngine::supports(&missing));
    }

    #[test]
    fn zipformer_supports_split_bundle() {
        let cfg = make_cfg(
            EngineKind::KaldiTransducerStreaming,
            &["encoder", "decoder", "joiner", "vocab"],
        );
        assert!(NativeZipformerStreamingEngine::supports(&cfg));
        let wrong_kind = make_cfg(
            EngineKind::KaldiTransducer,
            &["encoder", "decoder", "joiner", "vocab"],
        );
        assert!(!NativeZipformerStreamingEngine::supports(&wrong_kind));
    }
}
