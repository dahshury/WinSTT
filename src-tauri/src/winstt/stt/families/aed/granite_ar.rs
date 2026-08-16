// Granite-Speech AR engine (autoregressive decode over a spliced text+audio prompt).
//
// Encoder → audio embeds; build a `USER: <|audio|>… \n ASSISTANT:` prompt, splice the audio embeds
// into the `<|audio|>` slots, run `prompt_encode` once, then greedily decode token-by-token with the
// `decode_step` graph carrying past/present KV. `<|startofcontext|>` is UNTRAINED → no prompt
// injection (enforced by EngineKind::supports_initial_prompt()==false upstream).
//
// PERF: the greedy KV-cache loop binds the carried KV **device-resident** via ort's IoBinding
// (mirrors whisper.rs). `prompt_encode` emits the initial `present.*` KV bound to the device; every
// `decode_step` re-binds the prior step's `present.*` device values as `past_key_values.*` and its
// own `present.*`→device, so the growing cache never round-trips through the host — only `logits`
// come back host-side for the argmax. The old path `carry_present`'d all 40+ KV tensors to owned
// host `ndarray`s every token (a full clone per layer per step) and re-fed them; keeping them on the
// device removes that per-step host↔device copy (a small win on CPU, the prerequisite for a GPU-EP
// win). `AllocationDevice` comes from the active provider (`granite_device`); CPU today, so this is
// correct + ~free on CPU too. EXACT tokens/EOS/output preserved: same graphs, same inputs, same
// argmax — only HOW the KV is carried changed (host clone → device-resident bind).

use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::*;
use crate::winstt::stt::Accelerator;

/// `(AllocationDevice, device_id)` for binding the carried KV resident on the session's device.
/// CPU when no GPU EP is active — then IoBinding simply binds host memory (still correct, ~same
/// speed as the old host path). Mirrors whisper's `device_for_providers` / cohere's device map.
/// (WEBGPU_BUFFER intentionally omitted — added later.)
fn granite_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

pub(in crate::winstt::stt::families) struct GraniteArEngine {
    encoder: Session,
    embed_tokens: Session,
    prompt_encode: Session,
    decode_step: Session,
    tokenizer: tokenizers::Tokenizer,
    audio_token_id: i64,
    eos_token_id: i64,
    past_input_names: Vec<String>,
    present_output_names: Vec<String>,
    max_decode_length: usize,
    /// Device the sessions run on, for binding the carried KV device-resident (CPU when no GPU EP).
    device: AllocationDevice,
    device_id: i32,
    model_name: String,
    providers: Vec<String>,
}

impl GraniteArEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<GraniteArEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let embed_tokens = build_session(file(&cfg.resolved, "embed_tokens")?, &cfg.providers)?;
        let prompt_encode = build_session(file(&cfg.resolved, "prompt_encode")?, &cfg.providers)?;
        let decode_step = build_session(file(&cfg.resolved, "decode_step")?, &cfg.providers)?;
        let tokenizer = load_granite_tokenizer(file(&cfg.resolved, "tokenizer")?)?;
        let audio_token_id = tokenizer.token_to_id("<|audio|>").map_or(100352, i64::from);
        let eos_token_id = tokenizer
            .token_to_id("<|end_of_text|>")
            .map_or(100257, i64::from);
        let past_input_names = filter_sorted_inputs(&decode_step, "past_key_values.");
        let present_output_names = filter_sorted_outputs(&decode_step, "present.");
        let (device, device_id) = granite_device(&cfg.providers);

        Ok(GraniteArEngine {
            encoder,
            embed_tokens,
            prompt_encode,
            decode_step,
            tokenizer,
            audio_token_id,
            eos_token_id,
            past_input_names,
            present_output_names,
            max_decode_length: 1024,
            device,
            device_id,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn encode_audio(&mut self, audio: &[f32]) -> SttResult<(ndarray::Array3<f32>, usize)> {
        let features = frontend::granite_ar_features(audio);
        let t = features.nrows();
        if t == 0 {
            return Ok((ndarray::Array3::<f32>::zeros((1, 0, 2048)), 0));
        }
        let x = features
            .into_shape_with_order((1, t, 160))
            .map_err(|e| SttError::Inference(format!("granite ar feature reshape: {e}")))?;
        let outputs = self
            .encoder
            .run(ort::inputs![
                "input_features" => Tensor::from_array(x)
                    .map_err(|e| SttError::Inference(format!("granite ar feature tensor: {e}")))?
            ])
            .map_err(|e| SttError::Inference(format!("granite ar encoder run: {e}")))?;
        let audio_embeds = out_to_f32(&outputs["audio_embeds"])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite ar audio embeds dim: {e}")))?;
        let sizes = out_to_i64(&outputs["audio_embed_sizes"])?
            .into_dimensionality::<ndarray::Ix1>()
            .map_err(|e| SttError::Inference(format!("granite ar audio sizes dim: {e}")))?;
        let audio_len = sizes
            .get(0)
            .copied()
            .unwrap_or(audio_embeds.shape()[1] as i64)
            .max(0) as usize;
        let max_audio_len = audio_embeds.shape()[1];
        Ok((audio_embeds, audio_len.min(max_audio_len)))
    }

    fn build_prompt_ids(&self, audio_len: usize) -> SttResult<Vec<i64>> {
        let prefix = self
            .tokenizer
            .encode("USER: ", false)
            .map_err(|e| SttError::Tokenizer(format!("granite prompt prefix: {e}")))?;
        let suffix = self
            .tokenizer
            .encode("\n ASSISTANT:", false)
            .map_err(|e| SttError::Tokenizer(format!("granite prompt suffix: {e}")))?;
        let mut ids = Vec::with_capacity(prefix.len() + audio_len + suffix.len());
        ids.extend(prefix.get_ids().iter().map(|&i| i as i64));
        ids.extend(std::iter::repeat_n(self.audio_token_id, audio_len));
        ids.extend(suffix.get_ids().iter().map(|&i| i as i64));
        Ok(ids)
    }

    fn splice_audio_embeds(
        &mut self,
        prompt_ids: &[i64],
        audio_embeds: &ndarray::Array3<f32>,
        audio_len: usize,
    ) -> SttResult<ndarray::Array3<f32>> {
        let embed_ids: Vec<i64> = prompt_ids
            .iter()
            .map(|&id| if id == self.audio_token_id { 0 } else { id })
            .collect();
        let text_embeds = run_embed_tokens(&mut self.embed_tokens, &embed_ids, "granite ar")?;
        let hidden = text_embeds.shape()[2];
        let audio_slots = prompt_ids
            .iter()
            .filter(|&&id| id == self.audio_token_id)
            .count();
        if audio_slots != audio_len {
            return Err(SttError::Inference(format!(
                "granite ar prompt has {audio_slots} audio slots but encoder returned {audio_len}"
            )));
        }

        let mut flat = Vec::with_capacity(prompt_ids.len() * hidden);
        let mut audio_idx = 0usize;
        for (pos, &id) in prompt_ids.iter().enumerate() {
            if id == self.audio_token_id {
                for h in 0..hidden {
                    flat.push(audio_embeds[[0, audio_idx, h]]);
                }
                audio_idx += 1;
            } else {
                for h in 0..hidden {
                    flat.push(text_embeds[[0, pos, h]]);
                }
            }
        }

        ndarray::Array3::from_shape_vec((1, prompt_ids.len(), hidden), flat)
            .map_err(|e| SttError::Inference(format!("granite ar splice shape: {e}")))
    }

    /// Device `MemoryInfo` for binding the carried KV resident on the session's device (CPU when no
    /// GPU EP). Cheap to build; one per run_prompt + one per decode step.
    fn device_mem(&self) -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("granite device mem info: {e}")))
    }

    /// Host `MemoryInfo` for the logits (argmax reads them on the CPU).
    fn cpu_mem() -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("granite cpu mem info: {e}")))
    }

    /// Argmax the last-position logits of a bound run (host), preserving the exact fp16→f32 promote
    /// + last-step-row selection of the old `argmax_1d(&last_step_row(&out_to_f32(logits)?))` path.
    fn argmax_bound_logits(outputs: &ort::session::SessionOutputs<'_>) -> SttResult<i64> {
        let logits = outputs
            .get("logits")
            .ok_or_else(|| SttError::Inference("granite decode produced no logits".into()))?;
        let logits = out_to_f32(logits)?;
        Ok(argmax_1d(&last_step_row(&logits)?).0 as i64)
    }

    /// Carry every `present.*` output → the next step's `past_key_values.*` as DEVICE-resident
    /// OrtValues (in canonical `past_input_names` order). Extracted values are session-owned and
    /// survive the binding drop, so they rebind next step with no host round-trip. Every Granite KV
    /// grows each step (a causal-LM cache, not reused cross-attn), so every present is non-empty.
    fn carry_present_device(
        outputs: &mut ort::session::SessionOutputs<'_>,
        present_names: &[String],
    ) -> SttResult<Vec<DynValue>> {
        let mut carried = Vec::with_capacity(present_names.len());
        for pname in present_names {
            let v = outputs.remove(pname.as_str()).ok_or_else(|| {
                SttError::Inference(format!("granite decode produced no {pname}"))
            })?;
            carried.push(v);
        }
        Ok(carried)
    }

    /// Run `prompt_encode` once → (first generated token, initial device-resident KV cache).
    /// The KV `present.*` outputs are bound to the device and carried directly (no host clone).
    fn run_prompt(
        &mut self,
        inputs_embeds: ndarray::Array3<f32>,
    ) -> SttResult<(i64, Vec<DynValue>)> {
        let n = inputs_embeds.shape()[1];
        let embeds = Tensor::from_array(inputs_embeds)
            .map_err(|e| SttError::Inference(format!("granite prompt embeds tensor: {e}")))?;
        let position_ids = tensor_i64((1, n), (0..n as i64).collect())?;
        let attention_mask = Tensor::from_array(causal_attention_mask(n))
            .map_err(|e| SttError::Inference(format!("granite prompt mask tensor: {e}")))?;
        let dev_mem = self.device_mem()?;
        let cpu_mem = Self::cpu_mem()?;

        let mut binding = self
            .prompt_encode
            .create_binding()
            .map_err(|e| SttError::Inference(format!("granite prompt binding: {e}")))?;
        binding
            .bind_input("inputs_embeds", &embeds)
            .map_err(|e| SttError::Inference(format!("bind prompt inputs_embeds: {e}")))?;
        binding
            .bind_input("position_ids", &position_ids)
            .map_err(|e| SttError::Inference(format!("bind prompt position_ids: {e}")))?;
        binding
            .bind_input("attention_mask", &attention_mask)
            .map_err(|e| SttError::Inference(format!("bind prompt attention_mask: {e}")))?;
        binding
            .bind_output_to_device("logits", &cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind prompt logits: {e}")))?;
        for pname in &self.present_output_names {
            binding
                .bind_output_to_device(pname.as_str(), &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind prompt {pname}: {e}")))?;
        }

        let mut outputs = self
            .prompt_encode
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("granite prompt_encode run: {e}")))?;
        // DML/CUDA run_binding is async w.r.t. the device stream: block before reading host logits /
        // carrying the device present.* (no-op on CPU). Matches the implicit per-step sync the old
        // host path got from `.to_owned()` on every output.
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("granite prompt synchronize: {e}")))?;

        let next = Self::argmax_bound_logits(&outputs)?;
        let state = Self::carry_present_device(&mut outputs, &self.present_output_names)?;
        Ok((next, state))
    }

    /// One greedy KV-cache decode step: embed the last token, bind the carried device KV as
    /// `past_key_values.*` + this step's `present.*`→device, run + sync, argmax logits (host), and
    /// carry the new `present.*` device values forward. Returns (next token, next device KV cache).
    fn run_decode_step(
        &mut self,
        token: i64,
        past_len: usize,
        state: &[DynValue],
    ) -> SttResult<(i64, Vec<DynValue>)> {
        let token_embeds = run_embed_tokens(&mut self.embed_tokens, &[token], "granite ar step")?;
        let embeds = Tensor::from_array(token_embeds)
            .map_err(|e| SttError::Inference(format!("granite step embed tensor: {e}")))?;
        let position_ids = tensor_i64((1, 1), vec![past_len as i64])?;
        let attention_mask =
            Tensor::from_array(ndarray::Array4::<f32>::zeros((1, 1, 1, past_len + 1)))
                .map_err(|e| SttError::Inference(format!("granite step mask tensor: {e}")))?;
        let dev_mem = self.device_mem()?;
        let cpu_mem = Self::cpu_mem()?;

        if state.len() != self.past_input_names.len() {
            return Err(SttError::Inference(format!(
                "granite KV state has {} tensors but decoder expects {}",
                state.len(),
                self.past_input_names.len()
            )));
        }

        let mut binding = self
            .decode_step
            .create_binding()
            .map_err(|e| SttError::Inference(format!("granite step binding: {e}")))?;
        binding
            .bind_input("inputs_embeds", &embeds)
            .map_err(|e| SttError::Inference(format!("bind step inputs_embeds: {e}")))?;
        binding
            .bind_input("position_ids", &position_ids)
            .map_err(|e| SttError::Inference(format!("bind step position_ids: {e}")))?;
        binding
            .bind_input("attention_mask", &attention_mask)
            .map_err(|e| SttError::Inference(format!("bind step attention_mask: {e}")))?;
        // past_key_values.* : the prior step's present.* device values, carried resident.
        for (name, value) in self.past_input_names.iter().zip(state.iter()) {
            binding
                .bind_input(name.as_str(), value)
                .map_err(|e| SttError::Inference(format!("bind step {name}: {e}")))?;
        }
        binding
            .bind_output_to_device("logits", &cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind step logits: {e}")))?;
        for pname in &self.present_output_names {
            binding
                .bind_output_to_device(pname.as_str(), &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind step {pname}: {e}")))?;
        }

        let mut outputs = self
            .decode_step
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("granite decode_step run: {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("granite step synchronize: {e}")))?;

        let next = Self::argmax_bound_logits(&outputs)?;
        let next_state = Self::carry_present_device(&mut outputs, &self.present_output_names)?;
        Ok((next, next_state))
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        granite_decode_tokens(&self.tokenizer, ids)
    }
}

impl Transcriber for GraniteArEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::GraniteSpeechAr
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
        let (audio_embeds, audio_len) = self.encode_audio(audio)?;
        if audio_len == 0 {
            return Ok(Transcription::default());
        }
        let prompt_ids = self.build_prompt_ids(audio_len)?;
        let prompt_len = prompt_ids.len();
        let inputs_embeds = self.splice_audio_embeds(&prompt_ids, &audio_embeds, audio_len)?;
        let (mut current, mut state) = self.run_prompt(inputs_embeds)?;
        let mut generated = Vec::new();

        for past_len in (prompt_len..).take(self.max_decode_length) {
            if current == self.eos_token_id {
                break;
            }
            generated.push(current);
            // Phrase-loop guard (shared with the other maskless AED decodes): keep one occurrence
            // of a verbatim-repeated cycle and stop — see `phrase_loop_truncation`.
            if let Some(keep) = phrase_loop_truncation(&generated) {
                generated.truncate(keep);
                break;
            }
            let (next, next_state) = self.run_decode_step(current, past_len, &state)?;
            state = next_state;
            current = next;
        }

        let text = self.decode_text(&generated)?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
