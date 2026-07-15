// Qwen3-ASR engine (Qwen3 LLM decoder + Whisper-style audio encoder, autoregressive decode).
//
// Pipeline (andrewleech/qwen3-asr-*-onnx export):
//   1. 128-mel log-spectrogram (Whisper feature extractor, fixed 30 s / 3000-frame window).
//   2. `encoder.onnx`: mel `[1, 128, T]` → audio embeds `[1, audio_len, 1024]`.
//   3. Build the official chat prompt token ids with `audio_len` `<|audio_pad|>` placeholders:
//        <|im_start|>system\n<|im_end|>\n
//        <|im_start|>user\n<|audio_start|>{pad×audio_len}<|audio_end|><|im_end|>\n
//        <|im_start|>assistant\n
//      `audio_offset` = index of the first `<|audio_pad|>`.
//   4. `decoder_init.onnx`(input_ids, position_ids, audio_features, audio_offset) → logits + KV.
//      The init graph owns the embedding table and splices the audio embeds in at `audio_offset`.
//   5. Greedy `decoder_step.onnx`(input_embeds, position_ids, past_keys, past_values) → logits + KV.
//      `input_embeds` is looked up per-token from the raw fp16 `embed_tokens.bin` table.
//
// KV cache is two STACKED f32 tensors `[layers, batch, kv_heads, seq, head_dim]` (not per-layer
// named like Granite/Whisper). Conservatively CPU-pinned on non-CUDA GPUs (EngineKind policy).
//
// PERF/CORRECTNESS NOTE: decode carries the audio embeds + the two stacked KV tensors
// (`present_keys`/`present_values`) **device-resident** via ort's IoBinding, mirroring whisper.rs /
// cohere.rs. The prior host path `out_to_f32`'d the encoder output AND both KV tensors back to the
// host every step and re-fed them (`Tensor::from_array`) — a full host↔device round-trip of the KV
// cache per token. Keeping them on-device binds them once and rebinds the previous step's
// `present_*` device outputs directly as the next step's `past_*` inputs (no host clone). Only the
// per-token `input_embeds` (host lookup from `embed_tokens.bin`) goes host→device and `logits` comes
// host-side for argmax. A fresh binding is created per step (mirrors the per-`run` semantics); the
// device `present_*` outputs are extracted as session-owned `DynValue`s (survive the binding drop)
// and rebound next step. EP-agnostic: `qwen3_device()` maps the active provider to the allocation
// device (CPU today → IoBinding just binds host memory, same result, near-free).

use ndarray::{Array1, Array3, ArrayD};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::*;
use crate::winstt::stt::Accelerator;

/// The `AllocationDevice` (+ id) the sessions run on, for binding the audio embeds + KV-cache
/// resident on it (mirrors whisper's `device_for_providers` / cohere's `cohere_device`). Derived
/// from the FIRST requested accelerator; everything that isn't a device GPU EP → CPU, where
/// IoBinding simply binds host memory. Qwen3 is CPU-pinned on non-CUDA GPUs by EngineKind policy, so
/// in practice this is CPU or CUDA today.
fn qwen3_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

struct Qwen3PromptScaffold {
    system: Vec<i64>,
    newline: Vec<i64>,
    user: Vec<i64>,
    assistant: Vec<i64>,
}

impl Qwen3PromptScaffold {
    fn from_tokenizer(tokenizer: &tokenizers::Tokenizer) -> SttResult<Self> {
        fn encode_static(tokenizer: &tokenizers::Tokenizer, text: &str) -> SttResult<Vec<i64>> {
            Ok(tokenizer
                .encode(text, false)
                .map_err(|e| SttError::Tokenizer(format!("qwen3 prompt encode {text:?}: {e}")))?
                .get_ids()
                .iter()
                .map(|&i| i64::from(i))
                .collect())
        }

        Ok(Self {
            system: encode_static(tokenizer, "system\n")?,
            newline: encode_static(tokenizer, "\n")?,
            user: encode_static(tokenizer, "user\n")?,
            assistant: encode_static(tokenizer, "assistant\n")?,
        })
    }
}

pub(in crate::winstt::stt::families) struct Qwen3AsrEngine {
    encoder: Session,
    decoder_init: Session,
    decoder_step: Session,
    /// Raw fp16 token-embedding table, row-major `[vocab * hidden]`. Kept as f16 (≈311 MB for the
    /// 0.6B 151936×1024 table) and promoted per looked-up row — storing f32 would double the RAM.
    embed: Vec<F16>,
    hidden: usize,
    tokenizer: tokenizers::Tokenizer,
    prompt_scaffold: Qwen3PromptScaffold,
    enc_input: String,
    enc_output: String,
    im_start: i64,
    im_end: i64,
    audio_start: i64,
    audio_pad: i64,
    audio_end: i64,
    /// `<asr_text>` (151704): the model emits a `language <Lang><asr_text>` preamble (auto language
    /// detection) before the transcription, so the real text is everything AFTER this token.
    asr_text: i64,
    eos: Vec<i64>,
    max_decode_length: usize,
    model_name: String,
    providers: Vec<String>,
    /// Device the sessions run on, for binding the audio embeds + KV-cache device-resident
    /// (`CPU` when no device GPU EP is active; then IoBinding just binds host memory).
    device: AllocationDevice,
    device_id: i32,
}

impl Qwen3AsrEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<Qwen3AsrEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder_init = build_session(file(&cfg.resolved, "decoder_init")?, &cfg.providers)?;
        let decoder_step = build_session(file(&cfg.resolved, "decoder_step")?, &cfg.providers)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("qwen3 tokenizer: {e}")))?;
        let prompt_scaffold = Qwen3PromptScaffold::from_tokenizer(&tokenizer)?;

        // config.json carries decoder.hidden_size + the special-token ids. The resolver always
        // adds it under the "config" key.
        let cfg_json: serde_json::Value = {
            let path = file(&cfg.resolved, "config")?;
            let raw = std::fs::read(path)
                .map_err(|e| SttError::Resolve(format!("qwen3 config read: {e}")))?;
            serde_json::from_slice(&raw)
                .map_err(|e| SttError::Resolve(format!("qwen3 config parse: {e}")))?
        };
        let dec = &cfg_json["decoder"];
        let hidden = dec["hidden_size"].as_u64().unwrap_or(1024) as usize;
        let sp = &cfg_json["special_tokens"];
        let tok = |key: &str, name: &str, default: i64| -> i64 {
            sp[key]
                .as_i64()
                .or_else(|| tokenizer.token_to_id(name).map(i64::from))
                .unwrap_or(default)
        };
        let im_start = tok("im_start_token_id", "<|im_start|>", 151644);
        let im_end = tok("im_end_token_id", "<|im_end|>", 151645);
        let audio_start = tok("audio_start_token_id", "<|audio_start|>", 151669);
        let audio_pad = tok("audio_pad_token_id", "<|audio_pad|>", 151676);
        let audio_end = tok("audio_end_token_id", "<|audio_end|>", 151670);
        let asr_text = tok("asr_text_token_id", "<asr_text>", 151704);
        let eos: Vec<i64> = sp["eos_token_ids"]
            .as_array()
            .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
            .filter(|v: &Vec<i64>| !v.is_empty())
            .unwrap_or_else(|| vec![151643, im_end]);

        // Raw fp16 embedding table.
        let embed = {
            let path = file(&cfg.resolved, "embed_tokens")?;
            let raw = std::fs::read(path)
                .map_err(|e| SttError::Resolve(format!("qwen3 embed_tokens read: {e}")))?;
            let mut v = Vec::with_capacity(raw.len() / 2);
            for c in raw.chunks_exact(2) {
                v.push(F16::from_le_bytes([c[0], c[1]]));
            }
            v
        };

        let enc_input = encoder
            .inputs()
            .first()
            .map_or_else(|| "input_features".to_string(), |i| i.name().to_string());
        let enc_output = encoder
            .outputs()
            .first()
            .map_or_else(|| "audio_features".to_string(), |o| o.name().to_string());

        let (device, device_id) = qwen3_device(&cfg.providers);

        Ok(Qwen3AsrEngine {
            encoder,
            decoder_init,
            decoder_step,
            embed,
            hidden,
            tokenizer,
            prompt_scaffold,
            enc_input,
            enc_output,
            im_start,
            im_end,
            audio_start,
            audio_pad,
            audio_end,
            asr_text,
            eos,
            max_decode_length: 440,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            device,
            device_id,
        })
    }

    /// Device `MemoryInfo` for binding the audio embeds + KV-cache resident on the session's device
    /// (CPU when no device GPU EP). Cheap to build; one per encode + one per decode step.
    fn device_mem(&self) -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("qwen3 device mem info: {e}")))
    }

    /// Host `MemoryInfo` for binding the logits back to the CPU for argmax.
    fn host_mem() -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("qwen3 cpu mem info: {e}")))
    }

    /// Encode mel features once → **device-resident** audio embeds (`bind_output_to_device`, never
    /// copied to host). Mirrors whisper's `encode`. The returned `DynValue` is rebound as
    /// `decoder_init`'s `audio_features` input with no host round-trip. `audio_len` is read from the
    /// output's runtime shape (dim 1) — the number of `<|audio_pad|>` placeholders the prompt needs.
    fn encode_audio(&mut self, audio: &[f32]) -> SttResult<(DynValue, usize)> {
        let mel = crate::winstt::stt::mel::MelExtractor::new(128);
        let (feats, n_mels, n_frames) = mel.extract(audio);
        let x = Array3::from_shape_vec((1, n_mels, n_frames), feats)
            .map_err(|e| SttError::Inference(format!("qwen3 mel reshape: {e}")))?;
        let mel_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("qwen3 mel tensor: {e}")))?;
        let dev_mem = self.device_mem()?;
        let mut binding = self
            .encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("qwen3 encoder binding: {e}")))?;
        binding
            .bind_input(self.enc_input.as_str(), &mel_tensor)
            .map_err(|e| SttError::Inference(format!("qwen3 bind {}: {e}", self.enc_input)))?;
        binding
            .bind_output_to_device(self.enc_output.as_str(), &dev_mem)
            .map_err(|e| SttError::Inference(format!("qwen3 bind {}: {e}", self.enc_output)))?;
        let mut outputs = self
            .encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("qwen3 encoder run_binding: {e}")))?;
        // DML/CUDA run_binding is async w.r.t. the device stream — block until the encoder output is
        // written before handing the device value to the decoder (else we read stale memory).
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("qwen3 encoder synchronize: {e}")))?;
        let audio_features = outputs.remove(self.enc_output.as_str()).ok_or_else(|| {
            SttError::Inference("qwen3 encoder produced no audio_features".into())
        })?;
        let audio_len = match audio_features.dtype() {
            ort::value::ValueType::Tensor { shape, .. } => {
                shape.get(1).copied().unwrap_or(0).max(0) as usize
            }
            _ => 0,
        };
        Ok((audio_features, audio_len))
    }

    fn build_prompt_ids(&self, audio_len: usize) -> (Vec<i64>, usize) {
        qwen3_prompt_ids(
            &self.prompt_scaffold,
            self.im_start,
            self.im_end,
            self.audio_start,
            self.audio_pad,
            self.audio_end,
            audio_len,
        )
    }

    fn embed_row(&self, token: i64) -> SttResult<Array3<f32>> {
        let base = (token.max(0) as usize) * self.hidden;
        let slice = self
            .embed
            .get(base..base + self.hidden)
            .ok_or_else(|| SttError::Inference(format!("qwen3 embed row out of range: {token}")))?;
        let row: Vec<f32> = slice.iter().map(|h| h.to_f32()).collect();
        Array3::from_shape_vec((1, 1, self.hidden), row)
            .map_err(|e| SttError::Inference(format!("qwen3 embed reshape: {e}")))
    }

    fn argmax_logits(logits: &ArrayD<f32>) -> SttResult<i64> {
        Ok(argmax_last_step(logits)?.0 as i64)
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        let ids32: Vec<u32> = ids.iter().filter_map(|&i| u32::try_from(i).ok()).collect();
        self.tokenizer
            .decode(&ids32, true)
            .map_err(|e| SttError::Tokenizer(format!("qwen3 decode: {e}")))
    }
}

impl Transcriber for Qwen3AsrEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Qwen3Asr
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
        let (audio_features, audio_len) = self.encode_audio(audio)?;
        if audio_len == 0 {
            return Ok(Transcription::default());
        }
        let (prompt_ids, audio_offset) = self.build_prompt_ids(audio_len);
        let seq = prompt_ids.len();

        let dev_mem = self.device_mem()?;
        let cpu_mem = Self::host_mem()?;

        // ── decoder_init: splice audio embeds at `audio_offset`, produce logits + initial KV ──
        // Bind the device-resident audio embeds (no host copy) and pull `present_keys`/`present_values`
        // out as device `DynValue`s to carry into the step loop; logits come back host-side for argmax.
        let input_ids = Tensor::from_array(
            Array1::from_vec(prompt_ids)
                .into_shape_with_order((1, seq))
                .map_err(|e| SttError::Inference(format!("qwen3 input_ids: {e}")))?,
        )
        .map_err(|e| SttError::Inference(format!("qwen3 input_ids tensor: {e}")))?;
        let position_ids = tensor_i64((1, seq), (0..seq as i64).collect())?;
        let audio_offset_t = tensor_i64_1d(vec![audio_offset as i64])?;

        let mut current;
        let mut past_keys: DynValue;
        let mut past_values: DynValue;
        {
            let mut binding = self
                .decoder_init
                .create_binding()
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_init binding: {e}")))?;
            binding
                .bind_input("input_ids", &input_ids)
                .map_err(|e| SttError::Inference(format!("qwen3 bind input_ids: {e}")))?;
            binding
                .bind_input("position_ids", &position_ids)
                .map_err(|e| SttError::Inference(format!("qwen3 bind position_ids: {e}")))?;
            binding
                .bind_input("audio_features", &audio_features)
                .map_err(|e| SttError::Inference(format!("qwen3 bind audio_features: {e}")))?;
            binding
                .bind_input("audio_offset", &audio_offset_t)
                .map_err(|e| SttError::Inference(format!("qwen3 bind audio_offset: {e}")))?;
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind init logits: {e}")))?;
            binding
                .bind_output_to_device("present_keys", &dev_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind init present_keys: {e}")))?;
            binding
                .bind_output_to_device("present_values", &dev_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind init present_values: {e}")))?;
            let mut init_out = self
                .decoder_init
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_init run: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_init synchronize: {e}")))?;
            current =
                Self::argmax_logits(&out_to_f32(init_out.get("logits").ok_or_else(|| {
                    SttError::Inference("qwen3 decoder_init no logits".into())
                })?)?)?;
            past_keys = init_out
                .remove("present_keys")
                .ok_or_else(|| SttError::Inference("qwen3 decoder_init no present_keys".into()))?;
            past_values = init_out.remove("present_values").ok_or_else(|| {
                SttError::Inference("qwen3 decoder_init no present_values".into())
            })?;
        }

        // ── Greedy step loop: `input_embeds` looked up host-side per token; KV carried device-resident.
        // Each step rebinds the previous step's `present_*` device outputs as `past_*` inputs (no host
        // clone), extracts the new `present_*` device values, and argmaxes host-side logits.
        let mut generated = Vec::new();
        for pos in (seq as i64..).take(self.max_decode_length) {
            if self.eos.contains(&current) {
                break;
            }
            generated.push(current);
            let embeds = Tensor::from_array(self.embed_row(current)?)
                .map_err(|e| SttError::Inference(format!("qwen3 step embeds: {e}")))?;
            let pos_ids = tensor_i64((1, 1), vec![pos])?;

            let mut binding = self
                .decoder_step
                .create_binding()
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_step binding: {e}")))?;
            binding
                .bind_input("input_embeds", &embeds)
                .map_err(|e| SttError::Inference(format!("qwen3 bind input_embeds: {e}")))?;
            binding
                .bind_input("position_ids", &pos_ids)
                .map_err(|e| SttError::Inference(format!("qwen3 bind step position_ids: {e}")))?;
            binding
                .bind_input("past_keys", &past_keys)
                .map_err(|e| SttError::Inference(format!("qwen3 bind past_keys: {e}")))?;
            binding
                .bind_input("past_values", &past_values)
                .map_err(|e| SttError::Inference(format!("qwen3 bind past_values: {e}")))?;
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind step logits: {e}")))?;
            binding
                .bind_output_to_device("present_keys", &dev_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind step present_keys: {e}")))?;
            binding
                .bind_output_to_device("present_values", &dev_mem)
                .map_err(|e| SttError::Inference(format!("qwen3 bind step present_values: {e}")))?;
            let mut step_out = self
                .decoder_step
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_step run: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_step synchronize: {e}")))?;
            current =
                Self::argmax_logits(&out_to_f32(step_out.get("logits").ok_or_else(|| {
                    SttError::Inference("qwen3 decoder_step no logits".into())
                })?)?)?;
            // Carry present_* → past_* as DEVICE values: session-owned, survive the binding drop, so
            // they rebind next step with no host round-trip. Assign only AFTER the logits read so the
            // borrow of `step_out` from `.get("logits")` has ended.
            past_keys = step_out
                .remove("present_keys")
                .ok_or_else(|| SttError::Inference("qwen3 decoder_step no present_keys".into()))?;
            past_values = step_out.remove("present_values").ok_or_else(|| {
                SttError::Inference("qwen3 decoder_step no present_values".into())
            })?;
        }

        // Drop the `language <Lang><asr_text>` auto-detect preamble: keep only tokens after the
        // `<asr_text>` marker. Fall back to the full sequence if the marker never appeared.
        let start = generated
            .iter()
            .position(|&t| t == self.asr_text)
            .map_or(0, |i| i + 1);
        let text = self.decode_text(&generated[start..])?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

fn qwen3_prompt_ids(
    scaffold: &Qwen3PromptScaffold,
    im_start: i64,
    im_end: i64,
    audio_start: i64,
    audio_pad: i64,
    audio_end: i64,
    audio_len: usize,
) -> (Vec<i64>, usize) {
    let scaffold_len = scaffold.system.len()
        + scaffold.newline.len() * 2
        + scaffold.user.len()
        + scaffold.assistant.len();
    let mut ids = Vec::with_capacity(audio_len + scaffold_len + 7);
    ids.push(im_start);
    ids.extend_from_slice(&scaffold.system);
    ids.push(im_end);
    ids.extend_from_slice(&scaffold.newline);
    ids.push(im_start);
    ids.extend_from_slice(&scaffold.user);
    ids.push(audio_start);
    let audio_offset = ids.len();
    ids.extend(std::iter::repeat_n(audio_pad, audio_len));
    ids.push(audio_end);
    ids.push(im_end);
    ids.extend_from_slice(&scaffold.newline);
    ids.push(im_start);
    ids.extend_from_slice(&scaffold.assistant);
    (ids, audio_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwen3_prompt_ids_match_reference_scaffold() {
        let scaffold = Qwen3PromptScaffold {
            system: vec![9125, 198],
            newline: vec![198],
            user: vec![882, 198],
            assistant: vec![77091, 198],
        };
        let (ids, audio_offset) =
            qwen3_prompt_ids(&scaffold, 151644, 151645, 151669, 151676, 151670, 2);

        assert_eq!(audio_offset, 9);
        assert_eq!(
            ids,
            vec![
                151644, 9125, 198, 151645, 198, 151644, 882, 198, 151669, 151676, 151676, 151670,
                151645, 198, 151644, 77091, 198,
            ]
        );
    }
}
