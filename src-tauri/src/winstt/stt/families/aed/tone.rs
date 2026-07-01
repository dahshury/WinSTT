// T-One — streaming CTC (single graph; raw 8 kHz int32 signal, NO mel).
//
// Port of onnx-asr `models/tone.py` (TOneCtc) + the `_AsrWithCtcDecoding` collapse, with the
// `identity` preprocessor (`preprocessors/preprocessor.py::IdentityPreprocessor` — a no-op): the
// `recognize()` pipeline resamples 16 kHz → 8 kHz (the model's `_get_sample_rate() == 8_000`),
// then feeds the RAW 8 kHz float waveform straight into `_encode` (no fbank/mel).
//
// `_encode` (tone.py:73-86) is CHUNKED streaming CTC:
//   * pad `(chunk_size, chunk_size + (-len) % chunk_size)`  — one leading chunk + round up trailing;
//   * per 2400-sample chunk: `signal = (x[..., None] * (2**15 - 1)).astype(int32)`  shape (1,2400,1)
//     + a carried `state` (f16, zeros at start), run → (`logprobs` f32, `state_next` f16);
//   * `np.hstack(res[1:])`  — DROP the first chunk's logprobs (warm-up frame);
//   * argmax over the (T', 35) logprobs → CTC greedy collapse (blank = `pad_token_id` = 34) →
//     map ids via `config.json::decoder_params.vocabulary` (34 tokens, id 33 == literal " ").
// Vocabulary tokens carry their own spaces (the " " token is the word separator); there is NO
// SentencePiece `▁` and NO lowercasing (Cyrillic) — so we concatenate the symbols verbatim.

use std::collections::BTreeMap;

use ndarray::{Array1, Array2, ArrayView2, Axis};
use ort::session::Session;
use ort::value::Tensor;

use super::*;

/// 16 kHz → 8 kHz one-shot resample via rubato `FftFixedIn` (the same resampler `FrameResampler`
/// uses; the task allows reusing it). onnx-asr resamples with an ONNX polyphase graph, but a quality
/// 2:1 FFT downsample is numerically close enough for CTC phoneme decoding (validated by the spike).
/// Processes in fixed chunks, zero-padding the final partial chunk (matches `FrameResampler::finish`).
fn resample_16k_to_8k(audio: &[f32]) -> Vec<f32> {
    use rubato::{FftFixedIn, Resampler as _};
    const CHUNK_IN: usize = 1024;
    let mut resampler = match FftFixedIn::<f32>::new(16_000, 8_000, CHUNK_IN, 1, 1) {
        Ok(r) => r,
        // If the resampler can't be built, fall back to naive 2:1 decimation (still 8 kHz).
        Err(_) => return audio.iter().step_by(2).copied().collect(),
    };
    let mut out: Vec<f32> = Vec::with_capacity(audio.len() / 2 + CHUNK_IN);
    let mut idx = 0usize;
    while idx < audio.len() {
        let end = (idx + CHUNK_IN).min(audio.len());
        let mut buf: Vec<f32> = audio[idx..end].to_vec();
        if buf.len() < CHUNK_IN {
            buf.resize(CHUNK_IN, 0.0);
        }
        if let Ok(o) = resampler.process(&[&buf[..]], None) {
            out.extend_from_slice(&o[0]);
        }
        idx = end;
    }
    out
}

/// T-One streaming-CTC engine. Single ONNX graph: per-chunk `(signal int32, state f16)` →
/// `(logprobs f32, state_next f16)`. Vocab + blank come from `config.json` (no tokens.txt).
pub struct ToneEngine {
    session: Session,
    /// id → symbol (from `config.json::decoder_params.vocabulary`; id 34 = blank has no symbol).
    vocab: BTreeMap<i64, String>,
    blank_idx: i64,
    /// `signal` input frame length (2400 samples @ 8 kHz = 300 ms) — `shapes["signal"][1]`.
    chunk_size: usize,
    /// `state` input width (219729) — `shapes["state"][1]`.
    state_size: usize,
    signal_input: String,
    state_input: String,
    model_name: String,
    providers: Vec<String>,
    /// Live native-streaming session (the realtime worker feeds chunks via `stream_accept`).
    /// `None` outside an active stream; the batch `transcribe` path uses its own local state.
    stream: Option<ToneStreamingState>,
}

/// One T-One streaming session's carried state, lifted out of `transcribe` so the realtime worker
/// can drive chunks incrementally instead of re-decoding the whole window each tick. `state` is the
/// opaque f16 LSTM blob carried across chunks; `chunk_idx` drops the warm-up chunk 0; `pending8`
/// buffers 8 kHz samples not yet forming a full `chunk_size` window (streaming path only).
struct ToneStreamingState {
    state: Array1<F16>,
    all_logprobs: Vec<Array2<f32>>,
    chunk_idx: usize,
    pending8: Vec<f32>,
}

impl ToneStreamingState {
    fn new(state_size: usize) -> Self {
        Self {
            state: Array1::from_elem(state_size, F16::from_f32(0.0)),
            all_logprobs: Vec::new(),
            chunk_idx: 0,
            pending8: Vec::new(),
        }
    }
}

/// Run ONE `chunk_size`-sample (8 kHz) window through the T-One graph, carrying `st.state`. Drops
/// the warm-up chunk 0's logprobs (`chunk_idx`), collects the rest. Shared by the offline
/// `transcribe` driver and the streaming `stream_accept` so both decode identically.
fn tone_run_chunk(
    session: &mut Session,
    signal_input: &str,
    state_input: &str,
    state_size: usize,
    st: &mut ToneStreamingState,
    chunk8: &[f32],
) -> SttResult<()> {
    // signal = (clamp(x) * 32767).astype(int32), shape (1, len, 1) (tone.py:67; sherpa clamps).
    let sig: Vec<i32> = chunk8
        .iter()
        .map(|&x| (x.clamp(-1.0, 1.0) * 32767.0) as i32)
        .collect();
    let sig_arr = ndarray::Array3::from_shape_vec((1, chunk8.len(), 1), sig)
        .map_err(|e| SttError::Inference(format!("t-one signal reshape: {e}")))?;
    let sig_tensor = Tensor::from_array(sig_arr)
        .map_err(|e| SttError::Inference(format!("t-one signal tensor: {e}")))?;
    let state_arr = st
        .state
        .clone()
        .into_shape_with_order((1, state_size))
        .map_err(|e| SttError::Inference(format!("t-one state reshape: {e}")))?;
    let state_tensor = Tensor::from_array(state_arr)
        .map_err(|e| SttError::Inference(format!("t-one state tensor: {e}")))?;
    let outputs = session
        .run(ort::inputs![
            signal_input => sig_tensor,
            state_input => state_tensor,
        ])
        .map_err(|e| SttError::Inference(format!("t-one chunk run: {e}")))?;
    // state_next is f16 (tone.py:70). Carry it.
    let next_state = outputs["state_next"]
        .try_extract_array::<F16>()
        .map_err(|e| SttError::Inference(format!("t-one state_next extract: {e}")))?;
    st.state = next_state
        .to_owned()
        .into_shape_with_order(state_size)
        .map_err(|e| SttError::Inference(format!("t-one state_next reshape: {e}")))?;
    // DROP the first chunk's logprobs (warm-up); collect the rest (tone.py:86 `np.hstack(res[1:])`).
    if st.chunk_idx >= 1 {
        let lp = out_to_f32(&outputs["logprobs"])?; // (1, frames, 35)
        let lp3 = lp
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("t-one logprobs dim: {e}")))?;
        st.all_logprobs
            .push(lp3.index_axis_move(Axis(0), 0).to_owned()); // (frames, 35)
    }
    st.chunk_idx += 1;
    Ok(())
}

/// Collapse the collected logprobs into text: concat along time → argmax → CTC greedy collapse →
/// id→symbol map (the " " token is the separator; verbatim, no `▁`, no lowercasing).
fn tone_snapshot_text(
    vocab: &BTreeMap<i64, String>,
    blank_idx: i64,
    all_logprobs: &[Array2<f32>],
) -> SttResult<String> {
    if all_logprobs.is_empty() {
        return Ok(String::new());
    }
    let views: Vec<ArrayView2<'_, f32>> = all_logprobs.iter().map(|a| a.view()).collect();
    let enc = ndarray::concatenate(Axis(0), &views)
        .map_err(|e| SttError::Inference(format!("t-one concat logprobs: {e}")))?;
    let ids = argmax_last_axis_2d(enc.view());
    let collapsed = ctc_greedy_collapse(&ids, blank_idx);
    let mut text = String::new();
    for &id in &collapsed {
        if let Some(sym) = vocab.get(&id) {
            text.push_str(sym);
        }
    }
    Ok(text.trim().to_string())
}

impl ToneEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<ToneEngine> {
        let model_path = file(&cfg.resolved, "model")?;
        let config_path = file(&cfg.resolved, "config")?;
        let session = build_session(model_path, &cfg.providers)?;

        // Read chunk_size / state_size from the graph (tone.py:30-32: shapes["signal"][1] /
        // shapes["state"][1]). Default to the published constants if a dim is dynamic.
        let chunk_size = static_input_dim(&session, "signal", 1).unwrap_or(2400);
        let state_size = static_input_dim(&session, "state", 1).unwrap_or(219_729);

        // Resolve the actual input names (graph declares them `signal` / `state`, but read them
        // so a re-export with different names still wires up).
        let in_names = node_input_names(&session);
        let signal_input = in_names
            .iter()
            .find(|n| n.eq_ignore_ascii_case("signal"))
            .cloned()
            .unwrap_or_else(|| in_names.first().cloned().unwrap_or_else(|| "signal".into()));
        let state_input = in_names
            .iter()
            .find(|n| n.eq_ignore_ascii_case("state"))
            .cloned()
            .unwrap_or_else(|| in_names.get(1).cloned().unwrap_or_else(|| "state".into()));

        // Vocab from config.json (decoder_params.vocabulary) + blank = pad_token_id (tone.py:34-36).
        let cfg_text = std::fs::read_to_string(config_path)
            .map_err(|e| SttError::Tokenizer(format!("read {}: {e}", config_path.display())))?;
        let json: serde_json::Value = serde_json::from_str(&cfg_text)
            .map_err(|e| SttError::Tokenizer(format!("parse t-one config.json: {e}")))?;
        let vocab_arr = json
            .get("decoder_params")
            .and_then(|d| d.get("vocabulary"))
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                SttError::Tokenizer("t-one config.json missing decoder_params.vocabulary".into())
            })?;
        let mut vocab = BTreeMap::new();
        for (i, tok) in vocab_arr.iter().enumerate() {
            if let Some(s) = tok.as_str() {
                vocab.insert(i as i64, s.to_string());
            }
        }
        if vocab.is_empty() {
            return Err(SttError::Tokenizer("t-one vocabulary is empty".into()));
        }
        let blank_idx = json
            .get("pad_token_id")
            .and_then(serde_json::Value::as_i64)
            // Default to len(vocab) — TOneCtc uses `_blank_idx = pad_token_id`, which equals the
            // vocab length (the CTC blank lives just past the real symbols).
            .unwrap_or(vocab.len() as i64);

        Ok(ToneEngine {
            session,
            vocab,
            blank_idx,
            chunk_size,
            state_size,
            signal_input,
            state_input,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            stream: None,
        })
    }
}

impl Transcriber for ToneEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::ToneCtc
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

        // 1. Resample 16 kHz → 8 kHz (the model's native rate; `_get_sample_rate() == 8000`).
        let wav8 = resample_16k_to_8k(audio);
        if wav8.is_empty() {
            return Ok(Transcription::default());
        }

        // 2. Pad: leading `chunk_size` + trailing `chunk_size + (-len) % chunk_size` (tone.py:76-78).
        let n = wav8.len();
        let trailing =
            self.chunk_size + ((self.chunk_size - (n % self.chunk_size)) % self.chunk_size);
        let total = n + self.chunk_size + trailing;
        let mut padded = vec![0.0f32; total];
        padded[self.chunk_size..self.chunk_size + n].copy_from_slice(&wav8);
        let num_chunks = total / self.chunk_size;

        // 3. Per-chunk streaming CTC over a fresh local state (SHARED chunk-run with stream_accept,
        //    so offline and live decode identically). Drop-chunk-0 + state carry live in the helper.
        let mut st = ToneStreamingState::new(self.state_size);
        for c in 0..num_chunks {
            let off = c * self.chunk_size;
            tone_run_chunk(
                &mut self.session,
                &self.signal_input,
                &self.state_input,
                self.state_size,
                &mut st,
                &padded[off..off + self.chunk_size],
            )?;
        }

        // 4-5. Concat logprobs → argmax → CTC collapse → id→symbol map.
        let text = tone_snapshot_text(&self.vocab, self.blank_idx, &st.all_logprobs)?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }

    fn supports_native_streaming(&self) -> bool {
        true
    }

    /// Feed a fresh 16 kHz PCM tail into the live T-One stream and return the text so far. Resamples
    /// to 8 kHz, buffers, runs every full `chunk_size` window carrying state, and snapshots. The
    /// per-tick resample is per-call (slight boundary artifacts vs the single offline resample — the
    /// reference carries the same f16-state drift, so text parity holds; see the T-one spec).
    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if self.stream.is_none() {
            self.stream_reset();
        }
        let w8 = resample_16k_to_8k(pcm);
        let chunk_size = self.chunk_size;
        let state_size = self.state_size;
        let Some(st) = self.stream.as_mut() else {
            return Err(SttError::Inference(
                "T-One stream state was not initialized".into(),
            ));
        };
        st.pending8.extend_from_slice(&w8);
        while st.pending8.len() >= chunk_size {
            let chunk: Vec<f32> = st.pending8.drain(..chunk_size).collect();
            tone_run_chunk(
                &mut self.session,
                &self.signal_input,
                &self.state_input,
                state_size,
                st,
                &chunk,
            )?;
        }
        Ok(NativeStreamUpdate::interim(tone_snapshot_text(
            &self.vocab,
            self.blank_idx,
            &st.all_logprobs,
        )?))
    }

    /// Flush the streaming tail: fill the partial pending window + one trailing drain chunk (mirrors
    /// the offline trailing pad), process them, and return the final text.
    fn stream_finalize(&mut self) -> SttResult<String> {
        let chunk_size = self.chunk_size;
        let state_size = self.state_size;
        let st = match self.stream.as_mut() {
            Some(s) => s,
            None => return Ok(String::new()),
        };
        let rem = st.pending8.len() % chunk_size;
        if rem != 0 {
            let fill = chunk_size - rem;
            st.pending8.resize(st.pending8.len() + fill, 0.0);
        }
        st.pending8.resize(st.pending8.len() + chunk_size, 0.0); // trailing drain chunk
        while st.pending8.len() >= chunk_size {
            let chunk: Vec<f32> = st.pending8.drain(..chunk_size).collect();
            tone_run_chunk(
                &mut self.session,
                &self.signal_input,
                &self.state_input,
                state_size,
                st,
                &chunk,
            )?;
        }
        tone_snapshot_text(&self.vocab, self.blank_idx, &st.all_logprobs)
    }

    /// Start a fresh streaming session: zero state, seed the leading warm-up chunk (one `chunk_size`
    /// of zeros) so the first REAL chunk is `chunk_idx >= 1` and kept (mirrors the offline leading
    /// pad). Called by the realtime worker on the recording rising edge.
    fn stream_reset(&mut self) {
        let mut st = ToneStreamingState::new(self.state_size);
        st.pending8 = vec![0.0f32; self.chunk_size];
        self.stream = Some(st);
    }
}
