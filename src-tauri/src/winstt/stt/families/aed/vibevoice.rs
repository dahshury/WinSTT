// VibeVoice-ASR (BitNet) engine — dual ConvNeXt audio tokenizer + Qwen2.5-1.5B decoder.
//
// Pipeline (Masterx/vibevoice-asr-bitnet-onnx export, mirrors the qwen3-asr graph layout):
//   1. One-shot 16 kHz → 24 kHz resample (rubato `Fft`, same as tone.rs's 16→8 path — the model
//      consumes RAW 24 kHz waveform; no mel/fbank frontend exists for this family).
//   2. `audio_encoder.onnx`: waveform `[1, T]` → audio embeds `[1, N, 1536]` (acoustic + semantic
//      ConvNeXt tokenizers + projector, 3200× downsample → 7.5 Hz frames, deterministic latents).
//   3. Build the VibeASR chat prompt with `N` `<|speech_pad|>` placeholders (prompt_builder.h
//      parity — the "text" format of the 1.5B checkpoint, NO generation prompt; the model emits
//      the `<|im_start|>assistant\n` turn itself):
//        <|im_start|>system\n{SYS}<|im_end|>\n
//        <|im_start|>user\n<|speech_start|>{pad×N}<|speech_end|>\n{suffix}<|im_end|>\n
//      `suffix` carries the audio duration and, when `initial_prompt_text` is set, the
//      "with extra info: {context}" hotword clause (this family's native vocab-bias channel).
//   4. `decoder_init.onnx`(input_ids, position_ids, audio_features, audio_offset) → last-step
//      logits + stacked KV `[layers, 1, kv_heads, seq, head_dim]`. The init graph owns the
//      embedding table and splices the audio embeds in at `audio_offset` (ScatterND).
//   5. Greedy `decoder_step.onnx`(input_embeds, position_ids, past_keys, past_values) loop;
//      `input_embeds` looked up host-side from the raw fp16 `embed_tokens.bin` table.
//
// The decoder weights are the DEPLOYED BitNet ternary values (per-tensor absmean ternarization
// applied at export, matching VibeASR.cpp's convert_lm_to_gguf.py) — q4 blockwise storage of
// ternary weights is exact, so every quant tier decodes the same model the GGUF runtime ships.
//
// KV carried device-resident via IoBinding exactly like qwen3.rs (CPU today: family is
// CPU-pinned on non-CUDA GPUs by EngineKind policy — growing per-step shapes would re-fuse the
// DML graph per token, and the BitNet checkpoint is an edge-CPU model by design).

use ndarray::{Array1, Array2, Array3, ArrayD};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor};

use super::*;
use crate::winstt::stt::Accelerator;

/// System prompt of every VibeVoice-ASR checkpoint (prompt_builder.h `SYSTEM_PROMPT`, byte-exact —
/// the "JSON" wording is part of the trained prompt even for the text-format 1.5B checkpoint).
const SYSTEM_PROMPT: &str =
    "You are a helpful assistant that transcribes audio input into text output in JSON format.";

/// Model sample rate (Hz). The tokenizers downsample 3200× → 7.5 Hz frame rate.
const MODEL_SAMPLE_RATE: usize = 24_000;

/// Engine input sample rate (Hz) — the app-wide capture/VAD rate.
const INPUT_SAMPLE_RATE: usize = 16_000;

/// `AllocationDevice` (+ id) the sessions run on (mirrors `qwen3_device`). CPU today by EngineKind
/// policy; CUDA keeps everything device-resident.
fn vibevoice_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// One-shot 16 kHz → 24 kHz resample via rubato `Fft` (mirrors tone.rs's 16→8 helper; the same
/// resampler `FrameResampler` uses). Chunked `FixedSync::Input` processing with a final
/// zero-padded flush chunk to drain the FFT overlap tail, trimmed to the exact 3:2 output length.
fn resample_16k_to_24k(audio: &[f32]) -> Vec<f32> {
    use rubato::{Fft, FixedSync, Resampler as _, audioadapter_buffers::direct::InterleavedSlice};
    const CHUNK_IN: usize = 1024;
    let mut resampler = match Fft::<f32>::new(
        INPUT_SAMPLE_RATE,
        MODEL_SAMPLE_RATE,
        CHUNK_IN,
        1,
        FixedSync::Input,
    ) {
        Ok(r) => r,
        // If the resampler can't be built, fall back to naive 2× repeat-thin (still 24 kHz-ish);
        // structurally unreachable for these fixed rates.
        Err(_) => {
            return audio.iter().flat_map(|&s| [s, s, s]).step_by(2).collect();
        }
    };
    let expected = audio.len() * MODEL_SAMPLE_RATE / INPUT_SAMPLE_RATE;
    let mut out: Vec<f32> = Vec::with_capacity(expected + CHUNK_IN * 2);
    let mut idx = 0usize;
    // One extra zero chunk past the input end flushes the resampler's overlap tail.
    while idx < audio.len() + CHUNK_IN {
        let end = (idx + CHUNK_IN).min(audio.len());
        let mut buf: Vec<f32> = if idx < audio.len() {
            audio[idx..end].to_vec()
        } else {
            Vec::new()
        };
        if buf.len() < CHUNK_IN {
            buf.resize(CHUNK_IN, 0.0);
        }
        if let Ok(input) = InterleavedSlice::new(buf.as_slice(), 1, CHUNK_IN)
            && let Ok(o) = resampler.process(&input, None)
        {
            out.extend(o.take_data());
        }
        idx += CHUNK_IN;
    }
    out.truncate(expected);
    out
}

struct VibeVoicePromptScaffold {
    system: Vec<i64>,
    newline: Vec<i64>,
    user: Vec<i64>,
}

impl VibeVoicePromptScaffold {
    fn from_tokenizer(tokenizer: &tokenizers::Tokenizer) -> SttResult<Self> {
        fn enc(tokenizer: &tokenizers::Tokenizer, text: &str) -> SttResult<Vec<i64>> {
            Ok(tokenizer
                .encode(text, false)
                .map_err(|e| SttError::Tokenizer(format!("vibevoice prompt encode {text:?}: {e}")))?
                .get_ids()
                .iter()
                .map(|&i| i64::from(i))
                .collect())
        }
        Ok(Self {
            system: enc(tokenizer, &format!("system\n{SYSTEM_PROMPT}"))?,
            newline: enc(tokenizer, "\n")?,
            user: enc(tokenizer, "user\n")?,
        })
    }
}

pub(in crate::winstt::stt::families) struct VibeVoiceEngine {
    audio_encoder: Session,
    decoder_init: Session,
    decoder_step: Session,
    /// Raw fp16 token-embedding table, row-major `[vocab * hidden]` (≈467 MB for the 151936×1536
    /// Qwen2.5-1.5B table). Kept f16, promoted per looked-up row (mirrors qwen3.rs).
    embed: Vec<F16>,
    hidden: usize,
    tokenizer: tokenizers::Tokenizer,
    scaffold: VibeVoicePromptScaffold,
    im_start: i64,
    im_end: i64,
    speech_start: i64,
    speech_end: i64,
    speech_pad: i64,
    eos: Vec<i64>,
    max_decode_length: usize,
    model_name: String,
    providers: Vec<String>,
    device: AllocationDevice,
    device_id: i32,
}

impl VibeVoiceEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<VibeVoiceEngine> {
        let audio_encoder = build_session(file(&cfg.resolved, "audio_encoder")?, &cfg.providers)?;
        let decoder_init = build_session(file(&cfg.resolved, "decoder_init")?, &cfg.providers)?;
        let decoder_step = build_session(file(&cfg.resolved, "decoder_step")?, &cfg.providers)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("vibevoice tokenizer: {e}")))?;
        let scaffold = VibeVoicePromptScaffold::from_tokenizer(&tokenizer)?;

        let cfg_json: serde_json::Value = {
            let path = file(&cfg.resolved, "config")?;
            let raw = std::fs::read(path)
                .map_err(|e| SttError::Resolve(format!("vibevoice config read: {e}")))?;
            serde_json::from_slice(&raw)
                .map_err(|e| SttError::Resolve(format!("vibevoice config parse: {e}")))?
        };
        let hidden = cfg_json["text_config"]["hidden_size"]
            .as_u64()
            .unwrap_or(1536) as usize;

        // Canonical Qwen2.5 + VibeVoice special-token layout (prompt_builder.h): the ids are
        // stable across every checkpoint of the family; the tokenizer lookup is a fallback for
        // hypothetical re-exports with remapped specials.
        let tok = |name: &str, default: i64| -> i64 {
            tokenizer.token_to_id(name).map_or(default, i64::from)
        };
        let im_start = tok("<|im_start|>", 151_644);
        let im_end = tok("<|im_end|>", 151_645);
        let speech_start = tok("<|object_ref_start|>", 151_646);
        let speech_end = tok("<|object_ref_end|>", 151_647);
        let speech_pad = tok("<|box_start|>", 151_648);
        let eos = vec![151_643, im_end];

        let embed = {
            let path = file(&cfg.resolved, "embed_tokens")?;
            let raw = std::fs::read(path)
                .map_err(|e| SttError::Resolve(format!("vibevoice embed_tokens read: {e}")))?;
            let mut v = Vec::with_capacity(raw.len() / 2);
            for c in raw.chunks_exact(2) {
                v.push(F16::from_le_bytes([c[0], c[1]]));
            }
            v
        };

        let (device, device_id) = vibevoice_device(&cfg.providers);

        Ok(VibeVoiceEngine {
            audio_encoder,
            decoder_init,
            decoder_step,
            embed,
            hidden,
            tokenizer,
            scaffold,
            im_start,
            im_end,
            speech_start,
            speech_end,
            speech_pad,
            eos,
            max_decode_length: 440,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            device,
            device_id,
        })
    }

    fn device_mem(&self) -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("vibevoice device mem info: {e}")))
    }

    fn host_mem() -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("vibevoice cpu mem info: {e}")))
    }

    /// Waveform (24 kHz) → **device-resident** audio embeds; `n_frames` read from the output's
    /// runtime shape (dim 1) — the number of `<|speech_pad|>` placeholders the prompt needs.
    fn encode_audio(&mut self, audio_24k: &[f32]) -> SttResult<(DynValue, usize)> {
        let x = Array2::from_shape_vec((1, audio_24k.len()), audio_24k.to_vec())
            .map_err(|e| SttError::Inference(format!("vibevoice wave reshape: {e}")))?;
        let wave = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("vibevoice wave tensor: {e}")))?;
        let dev_mem = self.device_mem()?;
        let mut binding = self
            .audio_encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("vibevoice encoder binding: {e}")))?;
        binding
            .bind_input("input_values", &wave)
            .map_err(|e| SttError::Inference(format!("vibevoice bind input_values: {e}")))?;
        binding
            .bind_output_to_device("audio_features", &dev_mem)
            .map_err(|e| SttError::Inference(format!("vibevoice bind audio_features: {e}")))?;
        let mut outputs = self
            .audio_encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("vibevoice encoder run_binding: {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("vibevoice encoder synchronize: {e}")))?;
        let audio_features = outputs.remove("audio_features").ok_or_else(|| {
            SttError::Inference("vibevoice encoder produced no audio_features".into())
        })?;
        let n_frames = match audio_features.dtype() {
            ort::value::ValueType::Tensor { shape, .. } => {
                shape.get(1).copied().unwrap_or(0).max(0) as usize
            }
            _ => 0,
        };
        Ok((audio_features, n_frames))
    }

    /// User-turn suffix after the speech block (prompt_builder.h "text" format, byte-exact
    /// including the `%.2f` duration and the two-newline context variant).
    fn user_suffix(duration_sec: f32, context: Option<&str>) -> String {
        match context {
            Some(ctx) if !ctx.is_empty() => format!(
                "\nThis is a {duration_sec:.2} seconds audio, with extra info: {ctx}\n\nPlease transcribe it."
            ),
            _ => format!("\nThis is a {duration_sec:.2} seconds audio, please transcribe it."),
        }
    }

    fn build_prompt_ids(
        &self,
        n_frames: usize,
        duration_sec: f32,
        context: Option<&str>,
    ) -> SttResult<(Vec<i64>, usize)> {
        let suffix = self
            .tokenizer
            .encode(Self::user_suffix(duration_sec, context), false)
            .map_err(|e| SttError::Tokenizer(format!("vibevoice suffix encode: {e}")))?
            .get_ids()
            .iter()
            .map(|&i| i64::from(i))
            .collect::<Vec<i64>>();
        Ok(vibevoice_prompt_ids(
            &self.scaffold,
            &suffix,
            self.im_start,
            self.im_end,
            self.speech_start,
            self.speech_pad,
            self.speech_end,
            n_frames,
        ))
    }

    fn embed_row(&self, token: i64) -> SttResult<Array3<f32>> {
        let base = (token.max(0) as usize) * self.hidden;
        let slice = self.embed.get(base..base + self.hidden).ok_or_else(|| {
            SttError::Inference(format!("vibevoice embed row out of range: {token}"))
        })?;
        let row: Vec<f32> = slice.iter().map(|h| h.to_f32()).collect();
        Array3::from_shape_vec((1, 1, self.hidden), row)
            .map_err(|e| SttError::Inference(format!("vibevoice embed reshape: {e}")))
    }

    fn argmax_logits(logits: &ArrayD<f32>) -> SttResult<i64> {
        Ok(argmax_last_step(logits)?.0 as i64)
    }

    /// Decode generated ids to text. The model emits its own `<|im_start|>assistant\n` turn
    /// opener (no generation prompt in the trained template); specials are skipped by the
    /// tokenizer and the literal `assistant\n` opener is stripped here.
    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        let ids32: Vec<u32> = ids.iter().filter_map(|&i| u32::try_from(i).ok()).collect();
        let raw = self
            .tokenizer
            .decode(&ids32, true)
            .map_err(|e| SttError::Tokenizer(format!("vibevoice decode: {e}")))?;
        let stripped = raw
            .strip_prefix("assistant\n")
            .or_else(|| raw.strip_prefix("assistant"))
            .unwrap_or(&raw);
        Ok(stripped.trim().to_string())
    }
}

impl Transcriber for VibeVoiceEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::VibeVoiceAsr
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

    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let audio_24k = resample_16k_to_24k(audio);
        let duration_sec = audio_24k.len() as f32 / MODEL_SAMPLE_RATE as f32;
        let (audio_features, n_frames) = self.encode_audio(&audio_24k)?;
        if n_frames == 0 {
            return Ok(Transcription::default());
        }
        let (prompt_ids, audio_offset) =
            self.build_prompt_ids(n_frames, duration_sec, opts.initial_prompt_text.as_deref())?;
        let seq = prompt_ids.len();

        let dev_mem = self.device_mem()?;
        let cpu_mem = Self::host_mem()?;

        // ── decoder_init: embed prompt ids, splice audio embeds at `audio_offset`, logits + KV ──
        let input_ids = Tensor::from_array(
            Array1::from_vec(prompt_ids)
                .into_shape_with_order((1, seq))
                .map_err(|e| SttError::Inference(format!("vibevoice input_ids: {e}")))?,
        )
        .map_err(|e| SttError::Inference(format!("vibevoice input_ids tensor: {e}")))?;
        let position_ids = tensor_i64((1, seq), (0..seq as i64).collect())?;
        let audio_offset_t = tensor_i64_1d(vec![audio_offset as i64])?;

        let mut current;
        let mut past_keys: DynValue;
        let mut past_values: DynValue;
        {
            let mut binding = self
                .decoder_init
                .create_binding()
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_init binding: {e}")))?;
            binding
                .bind_input("input_ids", &input_ids)
                .map_err(|e| SttError::Inference(format!("vibevoice bind input_ids: {e}")))?;
            binding
                .bind_input("position_ids", &position_ids)
                .map_err(|e| SttError::Inference(format!("vibevoice bind position_ids: {e}")))?;
            binding
                .bind_input("audio_features", &audio_features)
                .map_err(|e| SttError::Inference(format!("vibevoice bind audio_features: {e}")))?;
            binding
                .bind_input("audio_offset", &audio_offset_t)
                .map_err(|e| SttError::Inference(format!("vibevoice bind audio_offset: {e}")))?;
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind init logits: {e}")))?;
            binding
                .bind_output_to_device("present_keys", &dev_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind init keys: {e}")))?;
            binding
                .bind_output_to_device("present_values", &dev_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind init values: {e}")))?;
            let mut init_out = self
                .decoder_init
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_init run: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_init sync: {e}")))?;
            current =
                Self::argmax_logits(&out_to_f32(init_out.get("logits").ok_or_else(|| {
                    SttError::Inference("vibevoice decoder_init no logits".into())
                })?)?)?;
            past_keys = init_out
                .remove("present_keys")
                .ok_or_else(|| SttError::Inference("vibevoice init no present_keys".into()))?;
            past_values = init_out
                .remove("present_values")
                .ok_or_else(|| SttError::Inference("vibevoice init no present_values".into()))?;
        }

        // ── Greedy step loop (KV device-resident; per-token embeds from the fp16 host table) ──
        let mut generated = Vec::new();
        for pos in (seq as i64..).take(self.max_decode_length) {
            if self.eos.contains(&current) {
                break;
            }
            generated.push(current);
            if let Some(keep) = phrase_loop_truncation(&generated) {
                generated.truncate(keep);
                break;
            }
            let embeds = Tensor::from_array(self.embed_row(current)?)
                .map_err(|e| SttError::Inference(format!("vibevoice step embeds: {e}")))?;
            let pos_ids = tensor_i64((1, 1), vec![pos])?;

            let mut binding = self
                .decoder_step
                .create_binding()
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_step binding: {e}")))?;
            binding
                .bind_input("input_embeds", &embeds)
                .map_err(|e| SttError::Inference(format!("vibevoice bind input_embeds: {e}")))?;
            binding.bind_input("position_ids", &pos_ids).map_err(|e| {
                SttError::Inference(format!("vibevoice bind step position_ids: {e}"))
            })?;
            binding
                .bind_input("past_keys", &past_keys)
                .map_err(|e| SttError::Inference(format!("vibevoice bind past_keys: {e}")))?;
            binding
                .bind_input("past_values", &past_values)
                .map_err(|e| SttError::Inference(format!("vibevoice bind past_values: {e}")))?;
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind step logits: {e}")))?;
            binding
                .bind_output_to_device("present_keys", &dev_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind step keys: {e}")))?;
            binding
                .bind_output_to_device("present_values", &dev_mem)
                .map_err(|e| SttError::Inference(format!("vibevoice bind step values: {e}")))?;
            let mut step_out = self
                .decoder_step
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_step run: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("vibevoice decoder_step sync: {e}")))?;
            current =
                Self::argmax_logits(&out_to_f32(step_out.get("logits").ok_or_else(|| {
                    SttError::Inference("vibevoice decoder_step no logits".into())
                })?)?)?;
            past_keys = step_out
                .remove("present_keys")
                .ok_or_else(|| SttError::Inference("vibevoice step no present_keys".into()))?;
            past_values = step_out
                .remove("present_values")
                .ok_or_else(|| SttError::Inference("vibevoice step no present_values".into()))?;
        }

        let text = self.decode_text(&generated)?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

/// Pure prompt assembly (prompt_builder.h parity), unit-testable without a tokenizer/session.
/// Returns `(ids, audio_offset)` where `audio_offset` indexes the first `<|speech_pad|>`.
#[allow(clippy::too_many_arguments)] // mirrors qwen3_prompt_ids; a params struct would only obscure the template
fn vibevoice_prompt_ids(
    scaffold: &VibeVoicePromptScaffold,
    user_suffix: &[i64],
    im_start: i64,
    im_end: i64,
    speech_start: i64,
    speech_pad: i64,
    speech_end: i64,
    n_frames: usize,
) -> (Vec<i64>, usize) {
    let scaffold_len = scaffold.system.len()
        + scaffold.newline.len() * 2
        + scaffold.user.len()
        + user_suffix.len();
    let mut ids = Vec::with_capacity(n_frames + scaffold_len + 6);
    ids.push(im_start);
    ids.extend_from_slice(&scaffold.system);
    ids.push(im_end);
    ids.extend_from_slice(&scaffold.newline);
    ids.push(im_start);
    ids.extend_from_slice(&scaffold.user);
    ids.push(speech_start);
    let audio_offset = ids.len();
    ids.extend(std::iter::repeat_n(speech_pad, n_frames));
    ids.push(speech_end);
    ids.extend_from_slice(user_suffix);
    ids.push(im_end);
    ids.extend_from_slice(&scaffold.newline);
    (ids, audio_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vibevoice_prompt_ids_match_prompt_builder_layout() {
        let scaffold = VibeVoicePromptScaffold {
            system: vec![9125, 198, 500],
            newline: vec![198],
            user: vec![882, 198],
        };
        let suffix = vec![700, 701];
        let (ids, audio_offset) = vibevoice_prompt_ids(
            &scaffold, &suffix, 151_644, 151_645, 151_646, 151_648, 151_647, 3,
        );

        // im_start + system(3) + im_end + \n + im_start + user(2) + speech_start = 10
        assert_eq!(audio_offset, 10);
        assert_eq!(
            ids,
            vec![
                151_644, 9125, 198, 500, 151_645, 198, 151_644, 882, 198, 151_646, 151_648,
                151_648, 151_648, 151_647, 700, 701, 151_645, 198,
            ]
        );
    }

    #[test]
    fn user_suffix_formats_match_prompt_builder() {
        assert_eq!(
            VibeVoiceEngine::user_suffix(3.5, None),
            "\nThis is a 3.50 seconds audio, please transcribe it."
        );
        assert_eq!(
            VibeVoiceEngine::user_suffix(12.345, Some("WinSTT, Dahshury")),
            "\nThis is a 12.35 seconds audio, with extra info: WinSTT, Dahshury\n\nPlease transcribe it."
        );
    }

    #[test]
    fn resample_16k_to_24k_length_and_tone() {
        // 1 s of a 440 Hz tone at 16 kHz → 24 000 samples out, tone preserved (spot-check RMS).
        let wave: Vec<f32> = (0..16_000)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect();
        let out = resample_16k_to_24k(&wave);
        assert_eq!(out.len(), 24_000);
        let rms = (out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32).sqrt();
        assert!((rms - 0.707).abs() < 0.05, "rms {rms} not sine-like");
    }
}
