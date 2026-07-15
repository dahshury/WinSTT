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

use ndarray::{Array2, ArrayView2, Axis};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::*;
use crate::winstt::stt::Accelerator;

/// Map the active provider list to the ORT allocation device for carrying the T-One LSTM state
/// device-resident (CPU when no GPU EP; then IoBinding simply binds host memory, still correct).
/// Mirrors whisper's `device_for_providers`.
fn tone_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// 16 kHz → 8 kHz one-shot resample via rubato `Fft` (the same resampler `FrameResampler`
/// uses; the task allows reusing it). onnx-asr resamples with an ONNX polyphase graph, but a quality
/// 2:1 FFT downsample is numerically close enough for CTC phoneme decoding (validated by the spike).
/// Processes in fixed chunks, zero-padding the final partial chunk (matches `FrameResampler::finish`).
fn resample_16k_to_8k(audio: &[f32]) -> Vec<f32> {
    use rubato::{Fft, FixedSync, Resampler as _, audioadapter_buffers::direct::InterleavedSlice};
    const CHUNK_IN: usize = 1024;
    let mut resampler = match Fft::<f32>::new(16_000, 8_000, CHUNK_IN, 1, FixedSync::Input) {
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
        if let Ok(input) = InterleavedSlice::new(buf.as_slice(), 1, CHUNK_IN)
            && let Ok(o) = resampler.process(&input, None)
        {
            out.extend(o.take_data());
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
    /// ORT allocation device the session runs on, for carrying the LSTM state resident.
    device: AllocationDevice,
    device_id: i32,
    /// Live native-streaming session (the realtime worker feeds chunks via `stream_accept`).
    /// `None` outside an active stream; the batch `transcribe` path uses its own local state.
    stream: Option<ToneStreamingState>,
}

/// One T-One streaming session's carried state, lifted out of `transcribe` so the realtime worker
/// can drive chunks incrementally instead of re-decoding the whole window each tick. `state` is the
/// opaque f16 LSTM blob carried across chunks — kept DEVICE-RESIDENT as a session-owned `DynValue`
/// (`None` before the first chunk, when a host f16 zero-tensor seeds it) so the ~220K-element blob
/// no longer round-trips to host every chunk. `chunk_idx` drops the warm-up chunk 0; `pending8`
/// buffers 8 kHz samples not yet forming a full `chunk_size` window (streaming path only).
struct ToneStreamingState {
    state: Option<DynValue>,
    all_logprobs: Vec<Array2<f32>>,
    chunk_idx: usize,
    pending8: Vec<f32>,
}

impl ToneStreamingState {
    fn new() -> Self {
        Self {
            state: None,
            all_logprobs: Vec::new(),
            chunk_idx: 0,
            pending8: Vec::new(),
        }
    }
}

/// Run ONE `chunk_size`-sample (8 kHz) window through the T-One graph, carrying `st.state`
/// DEVICE-RESIDENT via IoBinding: the `state_next` f16 LSTM blob is bound to the device and kept as
/// a session-owned `DynValue` (rebound as the next chunk's `state` input) instead of extracted to a
/// host `Array1<F16>` and re-fed each chunk. Only `signal` (fresh per chunk) goes host→device and
/// `logprobs` comes back host-side for the CTC collapse — same graph, same values. Drops the warm-up
/// chunk 0's logprobs (`chunk_idx`), collects the rest. Shared by the offline `transcribe` driver
/// and the streaming `stream_accept` so both decode identically.
#[expect(
    clippy::too_many_arguments,
    reason = "one-shot IoBinding driver mirrors the T-One graph's input surface"
)]
fn tone_run_chunk(
    session: &mut Session,
    signal_input: &str,
    state_input: &str,
    state_size: usize,
    dev_mem: &MemoryInfo,
    cpu_mem: &MemoryInfo,
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
    // Empty host f16 zero-state for the first chunk; held here so it outlives the binding through
    // `run_binding`. From chunk 2 on, `st.state` holds the carried device value.
    let empty_state = match &st.state {
        Some(_) => None,
        None => Some(
            Tensor::from_array(ndarray::Array2::<F16>::from_elem(
                (1, state_size),
                F16::from_f32(0.0),
            ))
            .map_err(|e| SttError::Inference(format!("t-one state tensor: {e}")))?,
        ),
    };

    let mut binding = session
        .create_binding()
        .map_err(|e| SttError::Inference(format!("t-one binding: {e}")))?;
    binding
        .bind_input(signal_input, &sig_tensor)
        .map_err(|e| SttError::Inference(format!("bind {signal_input}: {e}")))?;
    match (&st.state, &empty_state) {
        (Some(v), _) => binding
            .bind_input(state_input, v)
            .map_err(|e| SttError::Inference(format!("bind {state_input}: {e}")))?,
        (None, Some(t)) => binding
            .bind_input(state_input, t)
            .map_err(|e| SttError::Inference(format!("bind {state_input}: {e}")))?,
        (None, None) => {
            return Err(SttError::Inference(
                "t-one state has neither carried nor empty tensor".into(),
            ));
        }
    }
    // logprobs → host (CTC collapse); state_next → device (carried).
    binding
        .bind_output_to_device("logprobs", cpu_mem)
        .map_err(|e| SttError::Inference(format!("bind logprobs: {e}")))?;
    binding
        .bind_output_to_device("state_next", dev_mem)
        .map_err(|e| SttError::Inference(format!("bind state_next: {e}")))?;

    let mut outputs = session
        .run_binding(&binding)
        .map_err(|e| SttError::Inference(format!("t-one chunk run: {e}")))?;
    // DML/CUDA run_binding is async w.r.t. the device stream — sync before reading host `logprobs`
    // and before carrying the device `state_next`, else we race the still-running kernels.
    binding
        .synchronize_outputs()
        .map_err(|e| SttError::Inference(format!("t-one synchronize: {e}")))?;

    // DROP the first chunk's logprobs (warm-up); collect the rest (tone.py:86 `np.hstack(res[1:])`).
    // Read logprobs (host) BEFORE the state_next `remove` takes `outputs`.
    if st.chunk_idx >= 1 {
        let lp = {
            let v = outputs
                .get("logprobs")
                .ok_or_else(|| SttError::Inference("t-one produced no logprobs".into()))?;
            out_to_f32(v)? // (1, frames, 35)
        };
        let lp3 = lp
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("t-one logprobs dim: {e}")))?;
        st.all_logprobs
            .push(lp3.index_axis_move(Axis(0), 0).to_owned()); // (frames, 35)
    }
    // state_next is f16 (tone.py:70). Carry it → device (session-owned; survives the binding drop).
    st.state = Some(
        outputs
            .remove("state_next")
            .ok_or_else(|| SttError::Inference("t-one produced no state_next".into()))?,
    );
    drop(outputs);
    drop(binding);
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

        let (device, device_id) = tone_device(&cfg.providers);
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
            device,
            device_id,
            stream: None,
        })
    }

    /// Device `MemoryInfo` (state_next) + host `MemoryInfo` (logprobs) for one chunk's IoBinding.
    /// Device is CPU when no GPU EP, so the bind is correct + ~free there too.
    fn chunk_mem(&self) -> SttResult<(MemoryInfo, MemoryInfo)> {
        let dev_mem = MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("t-one device mem info: {e}")))?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("t-one cpu mem info: {e}")))?;
        Ok((dev_mem, cpu_mem))
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
        let (dev_mem, cpu_mem) = self.chunk_mem()?;
        let mut st = ToneStreamingState::new();
        for c in 0..num_chunks {
            let off = c * self.chunk_size;
            tone_run_chunk(
                &mut self.session,
                &self.signal_input,
                &self.state_input,
                self.state_size,
                &dev_mem,
                &cpu_mem,
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
        let (dev_mem, cpu_mem) = self.chunk_mem()?;
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
                &dev_mem,
                &cpu_mem,
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
        let (dev_mem, cpu_mem) = self.chunk_mem()?;
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
                &dev_mem,
                &cpu_mem,
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
        let mut st = ToneStreamingState::new();
        st.pending8 = vec![0.0f32; self.chunk_size];
        self.stream = Some(st);
    }
}
