// Transducer (RNNT/TDT) engine for Kaldi/Zipformer, NeMo-RNNT/TDT, and GigaAM-RNNT.
//
// Greedy (beam=1) transducer decode — port of `_AsrWithTransducerDecoding._decoding`. The encoder
// emits `(1, T, D)` (Kaldi) or `(1, D, T)→transpose→(1, T, D)` (NeMo); per-frame we run the
// decoder+joiner, argmax, advance by `step` (TDT duration) or 1.
//
// Compatibility behavior: exact per-export encoder/decoder/joiner input+output names vary
// (NeMo vs icefall vs GigaAM). Resolve them by name with deterministic fallbacks; the control flow
// and tensor shapes are exact.
//
// Lifted verbatim out of the old monolithic `families.rs`; depends only on the shared `support`
// layer and the `frontend` featurizers, never on a peer engine.

#![allow(dead_code)] // surface defined ahead of the dispatch call sites / resolver wiring.

use ndarray::{Array1, Array2, ArrayD, Axis};
use ort::session::Session;
use ort::value::Tensor;

use super::super::{
    EngineConfig, EngineKind, SttError, SttResult, TranscribeOptions, Transcriber, Transcription,
};
use super::frontend;
use super::support::*;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum TransducerKind {
    /// icefall/Kaldi stateless-2-context: decoder cached by `(-1, blank, *ctx)[-2:]`.
    KaldiStateless,
    /// NeMo RNN-T: stateful predictor `(input_states_1, input_states_2)`, RNN-T (step always 1).
    NemoRnnt,
    /// NeMo TDT: like RNN-T but joint emits `[vocab | duration]` → step = argmax(duration head).
    NemoTdt,
    /// GigaAM v3 E2E RNN-T (gigaam.py GigaamV2Rnnt): separate decoder (`x`/`h.1`/`c.1`→`dec`/`h`/`c`)
    /// + joiner (`enc`(1,768,1)/`dec`(1,320,1)→`joint`). LSTM predictor state (h,c) of width 320,
    ///   cached `dec` reused across blank frames (re-run decoder only on a token emission). blank=1024,
    ///   max_tokens_per_step=3 (config.json). 64-mel `gigaam_v3_features` front-end; encoder outputs
    ///   `encoded`(1,768,T')/`encoded_len`.
    GigaamRnnt,
}

/// NeMo RNN-T/TDT predictor LSTM state `(output_states_1, output_states_2)` carried across emitted
/// tokens. Updated only on a non-blank emission (Kaldi-stateless transducers don't use it).
type NemoState = (ArrayD<f32>, ArrayD<f32>);

/// GigaAM RNN-T predictor cache: the LSTM `(h, c)` state (each `(1,1,320)`) PLUS the cached decoder
/// output `dec` `(1,1,320)`. Mirrors onnx-asr's `prev_state[:] = (dec, h, c)` caching: `dec` is reused
/// while frames produce blanks; `(h, c)` advance only when the decoder is re-run after a token.
struct GigaamPredState {
    dec: ArrayD<f32>,
    h: ArrayD<f32>,
    c: ArrayD<f32>,
}

pub struct TransducerEngine {
    encoder: Session,
    decoder: Session,
    joiner: Option<Session>, // None for fused NeMo decoder_joint
    vocab: Vocab,
    kind: EngineKind,
    tkind: TransducerKind,
    vocab_size: usize,
    blank_id: i64,
    max_tokens_per_step: usize,
    context_size: usize,
    mel_fb: Array2<f32>,
    use_kaldi_fbank: bool,
    model_name: String,
    providers: Vec<String>,
}

impl TransducerEngine {
    pub(crate) fn load(cfg: &EngineConfig, tkind: TransducerKind) -> SttResult<TransducerEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder_key = match tkind {
            TransducerKind::KaldiStateless | TransducerKind::GigaamRnnt => "decoder",
            TransducerKind::NemoRnnt | TransducerKind::NemoTdt => "decoder_joint",
        };
        let decoder = build_session(file(&cfg.resolved, decoder_key)?, &cfg.providers)?;
        let joiner = match tkind {
            TransducerKind::KaldiStateless => Some(build_session(
                file(&cfg.resolved, "joiner")?,
                &cfg.providers,
            )?),
            // GigaAM ships its joiner under the `joint` key (gigaam.py `_get_model_files`).
            TransducerKind::GigaamRnnt => Some(build_session(
                file(&cfg.resolved, "joint")?,
                &cfg.providers,
            )?),
            _ => None,
        };
        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let vocab_size = vocab.size;
        let blank_id = vocab.blank_idx;
        let max_tokens_per_step = match tkind {
            TransducerKind::KaldiStateless => 1,
            TransducerKind::NemoRnnt | TransducerKind::NemoTdt => 10,
            // GigaAM v3 config.json max_tokens_per_step = 3.
            TransducerKind::GigaamRnnt => 3,
        };
        // NeMo transducer uses the proven 128-mel Slaney featurizer (read mel count from audio_signal);
        // Vosk/zipformer uses the 80-mel kaldi fbank with the HTK-mel bank (`build_zipformer_mel_
        // filterbank`); GigaAM v3 uses its own embedded 64-mel featurizer. Read before `encoder` is
        // moved into the struct.
        let mel_fb = match tkind {
            TransducerKind::KaldiStateless => frontend::build_zipformer_mel_filterbank(),
            TransducerKind::GigaamRnnt => Array2::<f32>::zeros((0, 0)), // unused (embedded featurizer)
            _ => frontend::build_nemo_mel_filterbank(feat_dim_of(&encoder, "audio_signal")),
        };

        Ok(TransducerEngine {
            encoder,
            decoder,
            joiner,
            vocab,
            kind: cfg.kind,
            tkind,
            vocab_size,
            blank_id,
            max_tokens_per_step,
            context_size: 2,
            mel_fb,
            use_kaldi_fbank: matches!(tkind, TransducerKind::KaldiStateless),
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    /// Run the encoder → `(encoder_out (T, D), T_len)`.
    fn encode(&mut self, audio: &[f32]) -> SttResult<(Array2<f32>, usize)> {
        let fbank = match self.tkind {
            // Vosk/zipformer Kaldi transducer: 80-mel kaldi fbank with the HTK-mel bank.
            TransducerKind::KaldiStateless => frontend::compute_kaldi_fbank(audio, &self.mel_fb),
            TransducerKind::GigaamRnnt => frontend::gigaam_v3_features(audio),
            _ => frontend::nemo_features(audio, &self.mel_fb),
        };
        let t = fbank.nrows();
        if t == 0 {
            return Ok((Array2::zeros((0, 0)), 0));
        }
        let feat_dim = fbank.ncols();

        let (x, x_len_name, x_name, out_name, out_len_name) = match self.tkind {
            TransducerKind::KaldiStateless => {
                // (1, T, 80)
                let x = fbank
                    .into_shape_with_order((1, t, feat_dim))
                    .map_err(|e| SttError::Inference(format!("kaldi enc reshape: {e}")))?;
                (x, "x_lens", "x", "encoder_out", "encoder_out_lens")
            }
            TransducerKind::GigaamRnnt => {
                // (1, 64, T). GigaAM encoder: audio_signal/length → encoded(1,768,T')/encoded_len.
                let tr = fbank.t().as_standard_layout().into_owned();
                let x = tr
                    .into_shape_with_order((1, feat_dim, t))
                    .map_err(|e| SttError::Inference(format!("gigaam enc reshape: {e}")))?;
                (x, "length", "audio_signal", "encoded", "encoded_len")
            }
            TransducerKind::NemoRnnt | TransducerKind::NemoTdt => {
                // (1, feat, T). Force C-contiguous after the transpose (see NemoMel note above).
                let tr = fbank.t().as_standard_layout().into_owned();
                let x = tr
                    .into_shape_with_order((1, feat_dim, t))
                    .map_err(|e| SttError::Inference(format!("nemo enc reshape: {e}")))?;
                (x, "length", "audio_signal", "outputs", "encoded_lengths")
            }
        };

        let x_tensor =
            Tensor::from_array(x).map_err(|e| SttError::Inference(format!("enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;

        let outputs = self
            .encoder
            .run(ort::inputs![ x_name => x_tensor, x_len_name => len_tensor ])
            .map_err(|e| SttError::Inference(format!("encoder run: {e}")))?;

        // encoder_out shape: Kaldi (1, T', D); NeMo (1, D, T') → transpose to (1, T', D).
        let enc = out_to_f32(&outputs[out_name])?;
        let enc3 = enc
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("enc dim: {e}")))?;
        let enc2 = match self.tkind {
            TransducerKind::KaldiStateless => enc3.index_axis_move(Axis(0), 0).to_owned(),
            _ => enc3.index_axis_move(Axis(0), 0).reversed_axes().to_owned(), // (D,T')→(T',D)
        };
        let lens = out_to_i64(&outputs[out_len_name])?;
        let enc_rows = enc2.nrows();
        let t_len = lens
            .iter()
            .next()
            .copied()
            .unwrap_or(enc_rows as i64)
            .max(0) as usize;
        Ok((enc2, t_len.min(enc_rows)))
    }

    /// Run decoder+joiner for ONE encoder frame → `(logits, step, new_state?)`.
    /// `step` is the TDT duration (>0) or -1 for RNN-T/Kaldi (caller advances by 1). `new_state`
    /// is the freshly-advanced NeMo predictor state (None for Kaldi); the caller keeps it only on
    /// a non-blank emission.
    fn decode_frame(
        &mut self,
        prev_tokens: &[i64],
        prev_state: Option<&NemoState>,
        enc_frame: &Array1<f32>,
    ) -> SttResult<(Vec<f32>, i64, Option<NemoState>)> {
        match self.tkind {
            TransducerKind::KaldiStateless => {
                let (v, step) = self.decode_frame_kaldi(prev_tokens, enc_frame)?;
                Ok((v, step, None))
            }
            TransducerKind::NemoRnnt => {
                let owned;
                let st = match prev_state {
                    Some(s) => s,
                    None => {
                        owned = self.create_nemo_state();
                        &owned
                    }
                };
                let (v, ns) = self.decode_frame_nemo(prev_tokens, st, enc_frame)?;
                Ok((v, -1, Some(ns)))
            }
            TransducerKind::NemoTdt => {
                let owned;
                let st = match prev_state {
                    Some(s) => s,
                    None => {
                        owned = self.create_nemo_state();
                        &owned
                    }
                };
                let (v, ns) = self.decode_frame_nemo(prev_tokens, st, enc_frame)?;
                // joint output is [vocab | duration]; split.
                let (vocab_part, dur_part) = v.split_at(self.vocab_size.min(v.len()));
                let step = if dur_part.is_empty() {
                    -1
                } else {
                    argmax_1d(dur_part).0 as i64
                };
                Ok((vocab_part.to_vec(), step, Some(ns)))
            }
            // GigaAM RNN-T decodes via the dedicated `transcribe_gigaam` (decoder-output caching +
            // distinct decoder/joiner I/O); the generic per-frame `decode_frame` is never reached.
            TransducerKind::GigaamRnnt => Err(SttError::Unsupported(
                "gigaam rnnt uses transcribe_gigaam, not the generic decode_frame",
            )),
        }
    }

    fn decode_frame_kaldi(
        &mut self,
        prev_tokens: &[i64],
        enc_frame: &Array1<f32>,
    ) -> SttResult<(Vec<f32>, i64)> {
        // context = (-1, blank, *prev)[-2:]
        let mut ctx_full: Vec<i64> = vec![-1, self.blank_id];
        ctx_full.extend_from_slice(prev_tokens);
        let ctx = &ctx_full[ctx_full.len().saturating_sub(self.context_size)..];
        let ctx2 = Array2::from_shape_vec((1, ctx.len()), ctx.to_vec())
            .map_err(|e| SttError::Inference(format!("kaldi ctx: {e}")))?;
        let y_tensor = Tensor::from_array(ctx2)
            .map_err(|e| SttError::Inference(format!("kaldi y tensor: {e}")))?;

        let dec_out = self
            .decoder
            .run(ort::inputs![ "y" => y_tensor ])
            .map_err(|e| SttError::Inference(format!("kaldi decoder run: {e}")))?;
        let decoder_out = out_to_f32(&dec_out["decoder_out"])?;

        // joiner(encoder_out=(1,D), decoder_out) → logit
        let enc_row = enc_frame
            .view()
            .into_shape_with_order((1, enc_frame.len()))
            .map_err(|e| SttError::Inference(format!("kaldi enc row: {e}")))?
            .to_owned();
        let enc_tensor = Tensor::from_array(enc_row)
            .map_err(|e| SttError::Inference(format!("kaldi enc tensor: {e}")))?;
        let dec_tensor = Tensor::from_array(decoder_out)
            .map_err(|e| SttError::Inference(format!("kaldi dec tensor: {e}")))?;
        let joiner = self
            .joiner
            .as_mut()
            .ok_or(SttError::Unsupported("kaldi transducer missing joiner"))?;
        let joint = joiner
            .run(ort::inputs![ "encoder_out" => enc_tensor, "decoder_out" => dec_tensor ])
            .map_err(|e| SttError::Inference(format!("kaldi joiner run: {e}")))?;
        let logit = out_to_f32(&joint["logit"])?;
        Ok((logit.iter().copied().collect(), -1))
    }

    /// NeMo fused decoder_joint for ONE frame: feeds the stateful predictor states and returns the
    /// joint logits + the NEW `(output_states_1, output_states_2)` (port of nemo.py
    /// `NemoConformerRnnt._decode`). The caller updates the carried state only on a non-blank
    /// emission (see `transcribe`).
    fn decode_frame_nemo(
        &mut self,
        prev_tokens: &[i64],
        prev_state: &NemoState,
        enc_frame: &Array1<f32>,
    ) -> SttResult<(Vec<f32>, NemoState)> {
        let last = prev_tokens.last().copied().unwrap_or(self.blank_id);
        // NeMo decoder_joint declares `targets`/`target_length` as INT32 (ORT rejects int64).
        let targets = tensor_i32((1, 1), vec![last as i32])?;
        let target_length = tensor_i32_1d(vec![1i32])?;
        // encoder_outputs (1, D, 1)
        let d = enc_frame.len();
        let enc3 = enc_frame
            .view()
            .into_shape_with_order((1, d, 1))
            .map_err(|e| SttError::Inference(format!("nemo enc3: {e}")))?
            .to_owned();
        let enc_tensor = Tensor::from_array(enc3)
            .map_err(|e| SttError::Inference(format!("nemo enc tensor: {e}")))?;
        let st1 = Tensor::from_array(prev_state.0.clone())
            .map_err(|e| SttError::Inference(format!("nemo state1: {e}")))?;
        let st2 = Tensor::from_array(prev_state.1.clone())
            .map_err(|e| SttError::Inference(format!("nemo state2: {e}")))?;

        let outputs = self
            .decoder
            .run(ort::inputs![
                "encoder_outputs" => enc_tensor,
                "targets" => targets,
                "target_length" => target_length,
                "input_states_1" => st1,
                "input_states_2" => st2,
            ])
            .map_err(|e| SttError::Inference(format!("nemo decoder_joint run: {e}")))?;
        let joint = out_to_f32(&outputs["outputs"])?;
        let ns1 = out_to_f32(&outputs["output_states_1"])?;
        let ns2 = out_to_f32(&outputs["output_states_2"])?;
        drop(outputs);
        Ok((joint.iter().copied().collect(), (ns1, ns2)))
    }

    /// Zero predictor state `(input_states_1, input_states_2)` (NeMo RNN-T/TDT only).
    fn create_nemo_state(&self) -> NemoState {
        (
            ArrayD::<f32>::zeros(ndarray::IxDyn(&input_state_shape(
                &self.decoder,
                "input_states_1",
            ))),
            ArrayD::<f32>::zeros(ndarray::IxDyn(&input_state_shape(
                &self.decoder,
                "input_states_2",
            ))),
        )
    }

    /// GigaAM RNN-T predictor step: decoder(`x=token`, `h.1`, `c.1`) → `(dec, h, c)`
    /// (gigaam.py `GigaamV2Rnnt._decode`, the `len(prev_state)==2` branch). Re-run only after a token
    /// emission; the result's `dec` is cached and reused across blank frames.
    fn gigaam_decoder_step(
        &mut self,
        token: i64,
        h: &ArrayD<f32>,
        c: &ArrayD<f32>,
    ) -> SttResult<GigaamPredState> {
        // x is (1,1) int64 (decoder declares int64); h.1/c.1 are (1,1,320).
        let x = tensor_i64((1, 1), vec![token])?;
        let h_t = Tensor::from_array(h.clone())
            .map_err(|e| SttError::Inference(format!("gigaam h.1: {e}")))?;
        let c_t = Tensor::from_array(c.clone())
            .map_err(|e| SttError::Inference(format!("gigaam c.1: {e}")))?;
        let out = self
            .decoder
            .run(ort::inputs![ "x" => x, "h.1" => h_t, "c.1" => c_t ])
            .map_err(|e| SttError::Inference(format!("gigaam decoder run: {e}")))?;
        let dec = out_to_f32(&out["dec"])?;
        let nh = out_to_f32(&out["h"])?;
        let nc = out_to_f32(&out["c"])?;
        drop(out);
        Ok(GigaamPredState { dec, h: nh, c: nc })
    }

    /// GigaAM joiner: `joint = joiner(enc=encoder_out[None,:,None] (1,768,1), dec=dec.transpose(0,2,1)
    /// (1,320,1))` → squeeze → (1025,) (gigaam.py `_decode`). `dec` is the cached decoder output
    /// `(1,1,320)`; we transpose it to `(1,320,1)`.
    fn gigaam_joiner_step(
        &mut self,
        enc_frame: &Array1<f32>,
        dec: &ArrayD<f32>,
    ) -> SttResult<Vec<f32>> {
        let d_enc = enc_frame.len();
        // enc: (1, 768, 1)
        let enc3 = enc_frame
            .view()
            .into_shape_with_order((1, d_enc, 1))
            .map_err(|e| SttError::Inference(format!("gigaam joiner enc: {e}")))?
            .to_owned();
        let enc_t = Tensor::from_array(enc3)
            .map_err(|e| SttError::Inference(format!("gigaam joiner enc tensor: {e}")))?;
        // dec is (1,1,320) → transpose(0,2,1) → (1,320,1).
        let dec3 = dec
            .clone()
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("gigaam dec dim: {e}")))?;
        let dec_t_arr = dec3
            .permuted_axes([0, 2, 1])
            .as_standard_layout()
            .into_owned();
        let dec_t = Tensor::from_array(dec_t_arr)
            .map_err(|e| SttError::Inference(format!("gigaam joiner dec tensor: {e}")))?;
        let joint = self
            .joiner
            .as_mut()
            .ok_or(SttError::Unsupported("gigaam transducer missing joiner"))?
            .run(ort::inputs![ "enc" => enc_t, "dec" => dec_t ])
            .map_err(|e| SttError::Inference(format!("gigaam joiner run: {e}")))?;
        // joint is (1,1,1,1025) → flatten to (1025,).
        let j = out_to_f32(&joint["joint"])?;
        Ok(j.iter().copied().collect())
    }

    /// GigaAM v3 E2E RNN-T greedy decode — faithful port of onnx-asr `_AsrWithTransducerDecoding.
    /// _decoding` specialized to `GigaamV2Rnnt._decode`'s decoder-output caching. The LSTM `(h,c)`
    /// state advances only on a token emission; the cached `dec` is reused while frames produce blanks.
    /// `max_tokens_per_step=3` caps emissions per encoder frame; step is always 1 (RNN-T).
    fn transcribe_gigaam(
        &mut self,
        encoder_out: &Array2<f32>,
        t_len: usize,
    ) -> SttResult<Vec<i64>> {
        let pred_hidden = 320usize;
        let zeros_state = || ArrayD::<f32>::zeros(ndarray::IxDyn(&[1, 1, pred_hidden]));

        // `state` mirrors onnx-asr's `prev_state`: after a token emission it holds ONLY (h,c) so the
        // next frame re-runs the decoder; between emissions it holds the cached (dec,h,c).
        // We model both with GigaamPredState + a `dirty` flag (true ⇒ dec must be recomputed).
        let mut h = zeros_state();
        let mut c = zeros_state();
        let mut cached: Option<GigaamPredState> = None; // Some ⇒ dec is fresh for the current context
        let mut tokens: Vec<i64> = Vec::new();

        let mut t = 0usize;
        let mut emitted = 0usize;
        while t < t_len {
            let enc_frame = encoder_out.index_axis(Axis(0), t).to_owned();

            // Ensure we have a fresh decoder output for the current (last-token, h, c) context.
            // Re-run the decoder iff the context changed since the last decoder run (cached == None).
            if cached.is_none() {
                let last = tokens.last().copied().unwrap_or(self.blank_id);
                let st = self.gigaam_decoder_step(last, &h, &c)?;
                cached = Some(st);
            }
            let pred = cached.as_ref().expect("cached set above");
            let logits = self.gigaam_joiner_step(&enc_frame, &pred.dec)?;
            let (best, _) = argmax_1d(&logits);
            let token = best as i64;

            if token != self.blank_id {
                // Emit: advance the LSTM state to the just-computed (h,c) and invalidate the cache so
                // the NEXT frame re-runs the decoder with the new last token (onnx-asr: prev_state=state).
                let pred = cached.take().expect("cached set above");
                h = pred.h;
                c = pred.c;
                tokens.push(token);
                emitted += 1;
                if emitted == self.max_tokens_per_step {
                    t += 1;
                    emitted = 0;
                }
            } else {
                // Blank: keep the cached dec (reused next frame), advance time.
                t += 1;
                emitted = 0;
            }
        }
        Ok(tokens)
    }
}

impl Transcriber for TransducerEngine {
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
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let (encoder_out, t_len) = self.encode(audio)?;
        if t_len == 0 {
            return Ok(Transcription::default());
        }

        // GigaAM RNN-T uses a distinct decoder/joiner archetype + decoder-output caching; decode it
        // with the dedicated faithful port, then share the symbol-join below.
        if self.tkind == TransducerKind::GigaamRnnt {
            let tokens = self.transcribe_gigaam(&encoder_out, t_len)?;
            let syms: Vec<&str> = tokens.iter().filter_map(|&id| self.vocab.get(id)).collect();
            let text = join_and_normalize(&syms, self.vocab.lowercase_decoded);
            return Ok(Transcription {
                text,
                ..Default::default()
            });
        }

        let mut tokens: Vec<i64> = Vec::new();
        let mut t = 0usize;
        let mut emitted = 0usize;
        // NeMo predictor state (None for stateless Kaldi). Updated only on non-blank emission
        // (port of onnx-asr asr.py `_AsrWithTransducerDecoding._decoding`).
        let mut prev_state: Option<NemoState> = match self.tkind {
            TransducerKind::KaldiStateless => None,
            _ => Some(self.create_nemo_state()),
        };
        while t < t_len {
            let frame = encoder_out.index_axis(Axis(0), t).to_owned();
            let (logits, step, new_state) =
                self.decode_frame(&tokens, prev_state.as_ref(), &frame)?;
            let (best, _) = argmax_1d(&logits);
            let token = best as i64;

            if token != self.blank_id {
                tokens.push(token);
                emitted += 1;
                if let Some(ns) = new_state {
                    prev_state = Some(ns); // advance the predictor only when a token is emitted
                }
            }
            if step > 0 {
                t += step as usize;
                emitted = 0;
            } else if token == self.blank_id || emitted == self.max_tokens_per_step {
                t += 1;
                emitted = 0;
            }
        }

        let syms: Vec<&str> = tokens.iter().filter_map(|&id| self.vocab.get(id)).collect();
        let text = join_and_normalize(&syms, self.vocab.lowercase_decoded);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
