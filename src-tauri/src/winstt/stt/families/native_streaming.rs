//! Native ORT streaming engines for sherpa-format CTC and Zipformer exports.
//!
//! These replace the old external streaming STT runtime path. The models still use
//! the same published ONNX graph layouts, but session creation and provider routing now go through
//! WinSTT's shared `ort` stack.

use std::borrow::Cow;
use std::collections::BTreeMap;

use ndarray::{s, Array2, ArrayD, Axis, IxDyn};
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;

use super::frontend;
use super::streaming::{self, StreamCursor};
use super::support::*;
use crate::winstt::stt::{
    EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription,
};

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
    stream: NemoCtcStreamState,
}

struct NemoCtcStreamState {
    cursor: StreamCursor,
    cache_last_channel: ArrayD<f32>,
    cache_last_time: ArrayD<f32>,
    cache_last_channel_len: ArrayD<i64>,
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
            cache_last_channel: ArrayD::<f32>::zeros(IxDyn(&self.cache_last_channel_shape)),
            cache_last_time: ArrayD::<f32>::zeros(IxDyn(&self.cache_last_time_shape)),
            cache_last_channel_len: ArrayD::<i64>::zeros(IxDyn(&[1])),
        }
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
        let cache_last_channel = Tensor::from_array(self.stream.cache_last_channel.clone())
            .map_err(|e| SttError::Inference(format!("ctc cache_last_channel tensor: {e}")))?;
        let cache_last_time = Tensor::from_array(self.stream.cache_last_time.clone())
            .map_err(|e| SttError::Inference(format!("ctc cache_last_time tensor: {e}")))?;
        let cache_last_channel_len = Tensor::from_array(self.stream.cache_last_channel_len.clone())
            .map_err(|e| SttError::Inference(format!("ctc cache len tensor: {e}")))?;

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
        let input2 = self
            .input_names
            .get(2)
            .cloned()
            .unwrap_or_else(|| "cache_last_channel".into());
        let input3 = self
            .input_names
            .get(3)
            .cloned()
            .unwrap_or_else(|| "cache_last_time".into());
        let input4 = self
            .input_names
            .get(4)
            .cloned()
            .unwrap_or_else(|| "cache_last_channel_len".into());
        let outputs = self
            .session
            .run(ort::inputs![
                input0.as_str() => x_tensor,
                input1.as_str() => len_tensor,
                input2.as_str() => cache_last_channel,
                input3.as_str() => cache_last_time,
                input4.as_str() => cache_last_channel_len,
            ])
            .map_err(|e| SttError::Inference(format!("nemo CTC stream run: {e}")))?;

        let logits = out_to_f32(&outputs[self.logits_output.as_str()])?;
        if let Some(name) = self.output_names.get(2) {
            self.stream.cache_last_channel = out_to_f32(&outputs[name.as_str()])?;
        }
        if let Some(name) = self.output_names.get(3) {
            self.stream.cache_last_time = out_to_f32(&outputs[name.as_str()])?;
        }
        if let Some(name) = self.output_names.get(4) {
            self.stream.cache_last_channel_len = out_to_i64(&outputs[name.as_str()])?;
        }
        drop(outputs);

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
            let row_buf = row.to_vec();
            let (best, _) = argmax_1d(&row_buf);
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
            cache_last_channel: ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1, 1])),
            cache_last_time: ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1, 1])),
            cache_last_channel_len: ArrayD::<i64>::zeros(IxDyn(&[1])),
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
    vocab_size: usize,
    stream: ZipformerStreamState,
}

struct ZipformerStreamState {
    cursor: StreamCursor,
    f32_states: BTreeMap<String, ArrayD<f32>>,
    i64_states: BTreeMap<String, ArrayD<i64>>,
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

        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let unk_id = vocab
            .id_to_sym
            .iter()
            .find(|(_, s)| s.as_str() == "<unk>")
            .map(|(id, _)| *id);
        let mut engine = Self {
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
            vocab_size,
            stream: ZipformerStreamState::empty(),
        };
        engine.stream = engine.fresh_stream_state()?;
        Ok(engine)
    }

    pub fn supports(cfg: &EngineConfig) -> bool {
        cfg.kind == EngineKind::KaldiTransducerStreaming
            && cfg.resolved.files.contains_key("encoder")
            && cfg.resolved.files.contains_key("decoder")
            && cfg.resolved.files.contains_key("joiner")
            && cfg.resolved.files.contains_key("vocab")
    }

    fn fresh_stream_state(&self) -> SttResult<ZipformerStreamState> {
        let mut f32_states = BTreeMap::new();
        let mut i64_states = BTreeMap::new();
        for name in &self.state_input_names {
            let shape = input_shape_or(&self.encoder, name, 1)
                .ok_or_else(|| SttError::SessionCreate(format!("missing state input {name}")))?;
            if input_is_i64(&self.encoder, name) || name == "processed_lens" {
                i64_states.insert(name.clone(), ArrayD::<i64>::zeros(IxDyn(&shape)));
            } else {
                f32_states.insert(name.clone(), ArrayD::<f32>::zeros(IxDyn(&shape)));
            }
        }
        Ok(ZipformerStreamState {
            cursor: StreamCursor::new(),
            f32_states,
            i64_states,
        })
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

    fn run_encoder(&mut self, chunk: &Array2<f32>) -> SttResult<Array2<f32>> {
        let x_tensor = Tensor::from_array(
            chunk
                .clone()
                .into_shape_with_order((1, chunk.nrows(), chunk.ncols()))
                .map_err(|e| SttError::Inference(format!("zipformer x reshape: {e}")))?,
        )
        .map_err(|e| SttError::Inference(format!("zipformer x tensor: {e}")))?;

        let mut inputs: Vec<NamedInput> = Vec::with_capacity(1 + self.state_input_names.len());
        inputs.push((
            Cow::Owned(
                self.encoder_input_names
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "x".into()),
            ),
            SessionInputValue::from(x_tensor),
        ));
        for name in &self.state_input_names {
            if let Some(arr) = self.stream.i64_states.get(name) {
                let tensor = Tensor::from_array(arr.clone())
                    .map_err(|e| SttError::Inference(format!("zipformer state {name}: {e}")))?;
                inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(tensor)));
            } else {
                let arr = self.stream.f32_states.get(name).ok_or_else(|| {
                    SttError::Inference(format!("missing zipformer state input {name}"))
                })?;
                let tensor = Tensor::from_array(arr.clone())
                    .map_err(|e| SttError::Inference(format!("zipformer state {name}: {e}")))?;
                inputs.push((Cow::Owned(name.clone()), SessionInputValue::from(tensor)));
            }
        }

        let outputs = self
            .encoder
            .run(inputs)
            .map_err(|e| SttError::Inference(format!("zipformer encoder run: {e}")))?;
        for (input_name, output_name) in self.state_input_names.iter().zip(&self.state_output_names)
        {
            if self.stream.i64_states.contains_key(input_name) {
                self.stream.i64_states.insert(
                    input_name.clone(),
                    out_to_i64(&outputs[output_name.as_str()])?,
                );
            } else {
                self.stream.f32_states.insert(
                    input_name.clone(),
                    out_to_f32(&outputs[output_name.as_str()])?,
                );
            }
        }

        let enc_name = self
            .encoder_output_names
            .first()
            .map_or("encoder_out", String::as_str);
        let enc = out_to_f32(&outputs[enc_name])?;
        drop(outputs);
        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("zipformer encoder_out dim: {e}")))?;
        Ok(enc3.index_axis_move(Axis(0), 0).to_owned())
    }

    fn decode_encoder_out(&mut self, encoder_out: &Array2<f32>) -> SttResult<()> {
        let mut decoder_out = self.run_decoder()?;
        for t in 0..encoder_out.nrows() {
            let enc_frame = encoder_out.index_axis(Axis(0), t).to_owned();
            let logits = self.run_joiner(&enc_frame, &decoder_out)?;
            let take = if self.vocab_size > 0 {
                self.vocab_size.min(logits.len())
            } else {
                logits.len()
            };
            let (best, _) = argmax_1d(&logits[..take]);
            let token = best as i64;
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

    fn run_joiner(
        &mut self,
        enc_frame: &ndarray::Array1<f32>,
        decoder_out: &ArrayD<f32>,
    ) -> SttResult<Vec<f32>> {
        let enc = enc_frame
            .view()
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
        Ok(logit.iter().copied().collect())
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
            f32_states: BTreeMap::new(),
            i64_states: BTreeMap::new(),
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
        if let Ok(state) = self.fresh_stream_state() {
            self.stream = state;
        }
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
