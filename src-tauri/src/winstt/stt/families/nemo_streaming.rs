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

type DecoderState = (ArrayD<f32>, ArrayD<f32>);

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
    /// ORT allocation device the sessions run on, for binding the carried encoder cache resident.
    device: AllocationDevice,
    device_id: i32,
    stream: NemoStreamState,
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
    decoder_state: DecoderState,
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
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        let joiner = build_session(file(&cfg.resolved, "joiner")?, &cfg.providers)?;

        let metadata = read_custom_metadata(&encoder)?;
        let feature_dim = feat_dim_of(&encoder, "audio_signal");
        let window_size = streaming::meta_usize(&metadata, "window_size", "NeMo streaming")?;
        let chunk_shift = streaming::meta_usize(&metadata, "chunk_shift", "NeMo streaming")?;
        let vocab_size = streaming::meta_usize(&metadata, "vocab_size", "NeMo streaming")? + 1;
        let blank_id = vocab_size.saturating_sub(1) as i64;
        let normalize_type =
            frontend::NemoNorm::from_metadata(metadata.get("normalize_type").map(String::as_str));

        let cache_last_channel_shape = vec![
            1,
            streaming::meta_usize(&metadata, "cache_last_channel_dim1", "NeMo streaming")?,
            streaming::meta_usize(&metadata, "cache_last_channel_dim2", "NeMo streaming")?,
            streaming::meta_usize(&metadata, "cache_last_channel_dim3", "NeMo streaming")?,
        ];
        let cache_last_time_shape = vec![
            1,
            streaming::meta_usize(&metadata, "cache_last_time_dim1", "NeMo streaming")?,
            streaming::meta_usize(&metadata, "cache_last_time_dim2", "NeMo streaming")?,
            streaming::meta_usize(&metadata, "cache_last_time_dim3", "NeMo streaming")?,
        ];

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
        let (device, device_id) = nemo_stream_device(&cfg.providers);
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
            device,
            device_id,
            stream: NemoStreamState::empty(),
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
            decoder_state: (
                ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_0)),
                ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_1)),
            ),
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
        .map_err(|e| SttError::Inference(format!("nemo stream device mem info: {e}")))
    }

    fn process_available_chunks(&mut self, finalize: bool) -> SttResult<bool> {
        let features = frontend::nemo_features_with_normalization(
            &self.stream.cursor.pcm,
            &self.mel_fb,
            self.normalize_type,
        );
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

    fn run_feature_chunk(&mut self, chunk: &Array2<f32>) -> SttResult<()> {
        if chunk.ncols() != self.feature_dim {
            return Err(SttError::Inference(format!(
                "feature dim mismatch: got {}, expected {}",
                chunk.ncols(),
                self.feature_dim
            )));
        }
        let encoder_out = self.run_encoder(chunk)?;
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
        // Encoder output is [1, D, T]. The decoder loop consumes [T, D].
        Ok(enc3.index_axis_move(Axis(0), 0).reversed_axes().to_owned())
    }

    fn decode_encoder_out(&mut self, encoder_out: &Array2<f32>) -> SttResult<()> {
        let last = self
            .stream
            .cursor
            .tokens
            .last()
            .copied()
            .unwrap_or(self.blank_id);
        let state = self.stream.decoder_state.clone();
        let (mut decoder_out, mut next_state) = self.run_decoder(last, &state)?;
        let mut emitted = false;

        for t in 0..encoder_out.nrows() {
            let enc_frame = encoder_out.index_axis(Axis(0), t).to_owned();
            for _ in 0..MAX_SYMBOLS_PER_FRAME {
                let logits = self.run_joiner(&enc_frame, &decoder_out)?;
                let (best, _) = argmax_1d(&logits);
                let token = best as i64;
                if token == self.blank_id {
                    self.stream.cursor.num_trailing_blanks += 1;
                    break;
                }
                emitted = true;
                self.stream.cursor.tokens.push(token);
                self.stream.cursor.num_trailing_blanks = 0;
                let (new_decoder_out, new_next_state) = self.run_decoder(token, &next_state)?;
                decoder_out = new_decoder_out;
                next_state = new_next_state;
            }
        }

        if emitted {
            self.stream.decoder_state = next_state;
        }
        self.stream.cursor.frame_offset += encoder_out.nrows();
        Ok(())
    }

    fn run_decoder(
        &mut self,
        token: i64,
        state: &DecoderState,
    ) -> SttResult<(ArrayD<f32>, DecoderState)> {
        let targets = tensor_i32((1, 1), vec![token as i32])?;
        let target_length = tensor_i32_1d(vec![1])?;
        let st0 = Tensor::from_array(state.0.clone())
            .map_err(|e| SttError::Inference(format!("decoder state0 tensor: {e}")))?;
        let st1 = Tensor::from_array(state.1.clone())
            .map_err(|e| SttError::Inference(format!("decoder state1 tensor: {e}")))?;

        let target_name = self.decoder_input_names[0].as_str();
        let target_len_name = self.decoder_input_names[1].as_str();
        let state0_name = self.decoder_input_names[2].as_str();
        let state1_name = self.decoder_input_names[3].as_str();
        let outputs = self
            .decoder
            .run(ort::inputs![
                target_name => targets,
                target_len_name => target_length,
                state0_name => st0,
                state1_name => st1,
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream decoder run: {e}")))?;
        let decoder_out = out_to_f32(&outputs[self.decoder_output_names[0].as_str()])?;
        let next0 = out_to_f32(&outputs[self.decoder_output_names[2].as_str()])?;
        let next1 = out_to_f32(&outputs[self.decoder_output_names[3].as_str()])?;
        drop(outputs);
        Ok((decoder_out, (next0, next1)))
    }

    fn run_joiner(
        &mut self,
        enc_frame: &ndarray::Array1<f32>,
        decoder_out: &ArrayD<f32>,
    ) -> SttResult<Vec<f32>> {
        let enc = enc_frame
            .view()
            .into_shape_with_order((1, enc_frame.len(), 1))
            .map_err(|e| SttError::Inference(format!("joiner enc reshape: {e}")))?
            .to_owned();
        let enc_tensor = Tensor::from_array(enc)
            .map_err(|e| SttError::Inference(format!("joiner enc tensor: {e}")))?;
        let dec_tensor = Tensor::from_array(decoder_out.clone())
            .map_err(|e| SttError::Inference(format!("joiner dec tensor: {e}")))?;
        let outputs = self
            .joiner
            .run(ort::inputs![
                "encoder_outputs" => enc_tensor,
                "decoder_outputs" => dec_tensor,
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream joiner run: {e}")))?;
        let logits = out_to_f32(&outputs["outputs"])?;
        Ok(logits.iter().copied().take(self.vocab_size).collect())
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
            decoder_state: (
                ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1])),
                ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1])),
            ),
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
        self.stream_accept(&streaming::final_silence_pad())?;
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
