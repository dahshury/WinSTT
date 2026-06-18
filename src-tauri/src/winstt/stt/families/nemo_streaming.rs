//! Direct ORT implementation for sherpa-format streaming NeMo RNN-T exports.
//!
//! This ports the NeMo split-graph loop used by sherpa-onnx:
//! encoder cache tensors are carried across feature chunks, the predictor state is advanced only
//! after a non-blank token, and the joiner runs once per encoder frame. These sessions use WinSTT's
//! shared `ort` provider routing, so DirectML can be selected on Windows.

use ndarray::{s, Array2, ArrayD, Axis, IxDyn};
use ort::session::Session;
use ort::value::Tensor;

use super::frontend;
use super::support::*;
use crate::winstt::stt::{
    EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription,
};

const SAMPLE_RATE: usize = 16_000;
const FINAL_SILENCE_PAD_MS: usize = 2_000;
const STREAM_FEATURE_PRE_CONTEXT_FRAMES: usize = 3;
const MAX_SYMBOLS_PER_FRAME: usize = 10;

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
    normalize_type: String,
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
    stream: NemoStreamState,
}

struct NemoStreamState {
    pcm: Vec<f32>,
    base_frame: usize,
    next_chunk_frame: usize,
    cache_last_channel: ArrayD<f32>,
    cache_last_time: ArrayD<f32>,
    cache_last_channel_len: ArrayD<i64>,
    decoder_state: DecoderState,
    tokens: Vec<i64>,
    frame_offset: usize,
    num_trailing_blanks: usize,
}

impl NativeNemoStreamingEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        let joiner = build_session(file(&cfg.resolved, "joiner")?, &cfg.providers)?;

        let metadata = read_custom_metadata(&encoder)?;
        let feature_dim = feat_dim_of(&encoder, "audio_signal");
        let window_size = meta_usize(&metadata, "window_size")?;
        let chunk_shift = meta_usize(&metadata, "chunk_shift")?;
        let vocab_size = meta_usize(&metadata, "vocab_size")? + 1;
        let blank_id = vocab_size.saturating_sub(1) as i64;
        let normalize_type = metadata
            .get("normalize_type")
            .map_or("", |s| if s == "NA" { "" } else { s.as_str() })
            .to_string();

        let cache_last_channel_shape = vec![
            1,
            meta_usize(&metadata, "cache_last_channel_dim1")?,
            meta_usize(&metadata, "cache_last_channel_dim2")?,
            meta_usize(&metadata, "cache_last_channel_dim3")?,
        ];
        let cache_last_time_shape = vec![
            1,
            meta_usize(&metadata, "cache_last_time_dim1")?,
            meta_usize(&metadata, "cache_last_time_dim2")?,
            meta_usize(&metadata, "cache_last_time_dim3")?,
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

        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let mel_fb = frontend::build_nemo_mel_filterbank(feature_dim);
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
            pcm: Vec::new(),
            base_frame: 0,
            next_chunk_frame: 0,
            cache_last_channel: ArrayD::<f32>::zeros(IxDyn(&self.cache_last_channel_shape)),
            cache_last_time: ArrayD::<f32>::zeros(IxDyn(&self.cache_last_time_shape)),
            cache_last_channel_len: ArrayD::<i64>::zeros(IxDyn(&[1])),
            decoder_state: (
                ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_0)),
                ArrayD::<f32>::zeros(IxDyn(&self.decoder_state_shape_1)),
            ),
            tokens: Vec::new(),
            frame_offset: 0,
            num_trailing_blanks: 0,
        }
    }

    fn process_available_chunks(&mut self, finalize: bool) -> SttResult<bool> {
        let features = frontend::nemo_features_with_normalization(
            &self.stream.pcm,
            &self.mel_fb,
            &self.normalize_type,
        );
        let mut processed_any = false;
        loop {
            let rel_start = self
                .stream
                .next_chunk_frame
                .saturating_sub(self.stream.base_frame);
            let required_frames = rel_start + self.window_size;
            let ready = if finalize {
                required_frames <= features.nrows()
            } else {
                // Matches the official streaming RNN-T readiness rule:
                // num_processed_frames + ChunkSize() < NumFramesReady().
                required_frames < features.nrows()
            };
            if !ready {
                break;
            }
            let chunk = features
                .slice(s![rel_start..rel_start + self.window_size, ..])
                .to_owned();
            self.run_feature_chunk(&chunk)?;
            self.stream.next_chunk_frame += self.chunk_shift;
            processed_any = true;
        }
        if processed_any {
            self.trim_stream_pcm();
        }
        Ok(processed_any)
    }

    fn trim_stream_pcm(&mut self) {
        let keep_from_frame = self
            .stream
            .next_chunk_frame
            .saturating_sub(STREAM_FEATURE_PRE_CONTEXT_FRAMES);
        if keep_from_frame <= self.stream.base_frame {
            return;
        }
        let drop_frames = keep_from_frame - self.stream.base_frame;
        let drop_samples = (drop_frames * frontend::NEMO_HOP).min(self.stream.pcm.len());
        if drop_samples == 0 {
            return;
        }
        self.stream.pcm.drain(..drop_samples);
        self.stream.base_frame += drop_samples / frontend::NEMO_HOP;
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

    fn run_encoder(&mut self, chunk: &Array2<f32>) -> SttResult<Array2<f32>> {
        let t = chunk.nrows();
        let tr = chunk.t().as_standard_layout().into_owned();
        let x = tr
            .into_shape_with_order((1, self.feature_dim, t))
            .map_err(|e| SttError::Inference(format!("nemo stream enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("nemo stream enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;
        let cache_last_channel = Tensor::from_array(self.stream.cache_last_channel.clone())
            .map_err(|e| SttError::Inference(format!("cache_last_channel tensor: {e}")))?;
        let cache_last_time = Tensor::from_array(self.stream.cache_last_time.clone())
            .map_err(|e| SttError::Inference(format!("cache_last_time tensor: {e}")))?;
        let cache_last_channel_len = Tensor::from_array(self.stream.cache_last_channel_len.clone())
            .map_err(|e| SttError::Inference(format!("cache len tensor: {e}")))?;

        let outputs = self
            .encoder
            .run(ort::inputs![
                "audio_signal" => x_tensor,
                "length" => len_tensor,
                "cache_last_channel" => cache_last_channel,
                "cache_last_time" => cache_last_time,
                "cache_last_channel_len" => cache_last_channel_len,
            ])
            .map_err(|e| SttError::Inference(format!("nemo stream encoder run: {e}")))?;

        let enc = out_to_f32(&outputs["outputs"])?;
        self.stream.cache_last_channel = out_to_f32(&outputs["cache_last_channel_next"])?;
        self.stream.cache_last_time = out_to_f32(&outputs["cache_last_time_next"])?;
        self.stream.cache_last_channel_len = out_to_i64(&outputs["cache_last_channel_next_len"])?;
        drop(outputs);

        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("nemo stream enc dim: {e}")))?;
        // Encoder output is [1, D, T]. The decoder loop consumes [T, D].
        Ok(enc3.index_axis_move(Axis(0), 0).reversed_axes().to_owned())
    }

    fn decode_encoder_out(&mut self, encoder_out: &Array2<f32>) -> SttResult<()> {
        let last = self.stream.tokens.last().copied().unwrap_or(self.blank_id);
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
                    self.stream.num_trailing_blanks += 1;
                    break;
                }
                emitted = true;
                self.stream.tokens.push(token);
                self.stream.num_trailing_blanks = 0;
                let (new_decoder_out, new_next_state) = self.run_decoder(token, &next_state)?;
                decoder_out = new_decoder_out;
                next_state = new_next_state;
            }
        }

        if emitted {
            self.stream.decoder_state = next_state;
        }
        self.stream.frame_offset += encoder_out.nrows();
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
        let syms: Vec<&str> = self
            .stream
            .tokens
            .iter()
            .filter_map(|&id| {
                if id == self.blank_id {
                    None
                } else {
                    self.vocab.get(id)
                }
            })
            .collect();
        join_and_normalize(&syms, self.vocab.lowercase_decoded)
    }
}

impl NemoStreamState {
    fn empty() -> Self {
        Self {
            pcm: Vec::new(),
            base_frame: 0,
            next_chunk_frame: 0,
            cache_last_channel: ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1, 1])),
            cache_last_time: ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1, 1])),
            cache_last_channel_len: ArrayD::<i64>::zeros(IxDyn(&[1])),
            decoder_state: (
                ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1])),
                ArrayD::<f32>::zeros(IxDyn(&[1, 1, 1])),
            ),
            tokens: Vec::new(),
            frame_offset: 0,
            num_trailing_blanks: 0,
        }
    }
}

fn meta_usize(meta: &std::collections::BTreeMap<String, String>, key: &str) -> SttResult<usize> {
    meta.get(key)
        .ok_or_else(|| SttError::SessionCreate(format!("missing NeMo streaming metadata {key}")))?
        .parse::<usize>()
        .map_err(|e| SttError::SessionCreate(format!("parse metadata {key}: {e}")))
}

fn final_silence_pad() -> Vec<f32> {
    vec![0.0; SAMPLE_RATE * FINAL_SILENCE_PAD_MS / 1000]
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
        self.stream_accept(&final_silence_pad())?;
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
            self.stream.pcm.extend_from_slice(pcm);
            self.process_available_chunks(false)?;
        }
        Ok(NativeStreamUpdate::interim(self.current_text()))
    }

    fn stream_finalize(&mut self) -> SttResult<String> {
        self.stream.pcm.extend_from_slice(&final_silence_pad());
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

    use super::{meta_usize, NativeNemoStreamingEngine};
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
        };
        assert!(NativeNemoStreamingEngine::supports(&cfg));
    }

    #[test]
    fn metadata_parser_reports_missing_keys() {
        let meta = BTreeMap::new();
        assert!(meta_usize(&meta, "window_size").is_err());
    }
}
