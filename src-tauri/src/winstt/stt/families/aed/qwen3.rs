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

use ndarray::{Array1, Array3, ArrayD};
use ort::session::Session;
use ort::value::Tensor;

use super::*;

pub(in crate::winstt::stt::families) struct Qwen3AsrEngine {
    encoder: Session,
    decoder_init: Session,
    decoder_step: Session,
    /// Raw fp16 token-embedding table, row-major `[vocab * hidden]`. Kept as f16 (≈311 MB for the
    /// 0.6B 151936×1024 table) and promoted per looked-up row — storing f32 would double the RAM.
    embed: Vec<F16>,
    hidden: usize,
    tokenizer: tokenizers::Tokenizer,
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
}

impl Qwen3AsrEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<Qwen3AsrEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder_init = build_session(file(&cfg.resolved, "decoder_init")?, &cfg.providers)?;
        let decoder_step = build_session(file(&cfg.resolved, "decoder_step")?, &cfg.providers)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("qwen3 tokenizer: {e}")))?;

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

        Ok(Qwen3AsrEngine {
            encoder,
            decoder_init,
            decoder_step,
            embed,
            hidden,
            tokenizer,
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
        })
    }

    fn encode_audio(&mut self, audio: &[f32]) -> SttResult<Array3<f32>> {
        let mel = crate::winstt::stt::mel::MelExtractor::new(128);
        let (feats, n_mels, n_frames) = mel.extract(audio);
        let x = Array3::from_shape_vec((1, n_mels, n_frames), feats)
            .map_err(|e| SttError::Inference(format!("qwen3 mel reshape: {e}")))?;
        let mel_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("qwen3 mel tensor: {e}")))?;
        let inputs: Vec<(
            std::borrow::Cow<'_, str>,
            ort::session::SessionInputValue<'_>,
        )> = vec![(
            std::borrow::Cow::Owned(self.enc_input.clone()),
            ort::session::SessionInputValue::from(mel_tensor),
        )];
        let outputs = self
            .encoder
            .run(inputs)
            .map_err(|e| SttError::Inference(format!("qwen3 encoder run: {e}")))?;
        let audio_features = out_to_f32(&outputs[self.enc_output.as_str()])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("qwen3 audio_features dim: {e}")))?;
        Ok(audio_features)
    }

    fn build_prompt_ids(&self, audio_len: usize) -> SttResult<(Vec<i64>, usize)> {
        let enc = |s: &str| -> SttResult<Vec<i64>> {
            Ok(self
                .tokenizer
                .encode(s, false)
                .map_err(|e| SttError::Tokenizer(format!("qwen3 prompt encode: {e}")))?
                .get_ids()
                .iter()
                .map(|&i| i64::from(i))
                .collect())
        };
        let mut ids = Vec::with_capacity(audio_len + 24);
        ids.push(self.im_start);
        ids.extend(enc("system\n")?);
        ids.push(self.im_end);
        ids.extend(enc("\n")?);
        ids.push(self.im_start);
        ids.extend(enc("user\n")?);
        ids.push(self.audio_start);
        let audio_offset = ids.len();
        ids.extend(std::iter::repeat_n(self.audio_pad, audio_len));
        ids.push(self.audio_end);
        ids.push(self.im_end);
        ids.extend(enc("\n")?);
        ids.push(self.im_start);
        ids.extend(enc("assistant\n")?);
        Ok((ids, audio_offset))
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
        Ok(argmax_1d(&last_step_row(logits)?).0 as i64)
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
        let audio_features = self.encode_audio(audio)?;
        let audio_len = audio_features.shape()[1];
        if audio_len == 0 {
            return Ok(Transcription::default());
        }
        let (prompt_ids, audio_offset) = self.build_prompt_ids(audio_len)?;
        let seq = prompt_ids.len();

        let init_out = self
            .decoder_init
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(
                    Array1::from_vec(prompt_ids)
                        .into_shape_with_order((1, seq))
                        .map_err(|e| SttError::Inference(format!("qwen3 input_ids: {e}")))?)
                    .map_err(|e| SttError::Inference(format!("qwen3 input_ids tensor: {e}")))?,
                "position_ids" => tensor_i64((1, seq), (0..seq as i64).collect())?,
                "audio_features" => Tensor::from_array(audio_features)
                    .map_err(|e| SttError::Inference(format!("qwen3 audio_features tensor: {e}")))?,
                "audio_offset" => tensor_i64_1d(vec![audio_offset as i64])?,
            ])
            .map_err(|e| SttError::Inference(format!("qwen3 decoder_init run: {e}")))?;

        let mut current = Self::argmax_logits(&out_to_f32(&init_out["logits"])?)?;
        let mut past_keys = out_to_f32(&init_out["present_keys"])?;
        let mut past_values = out_to_f32(&init_out["present_values"])?;
        drop(init_out);

        let mut generated = Vec::new();
        for pos in (seq as i64..).take(self.max_decode_length) {
            if self.eos.contains(&current) {
                break;
            }
            generated.push(current);
            let embeds = self.embed_row(current)?;
            let step_out = self
                .decoder_step
                .run(ort::inputs![
                    "input_embeds" => Tensor::from_array(embeds)
                        .map_err(|e| SttError::Inference(format!("qwen3 step embeds: {e}")))?,
                    "position_ids" => tensor_i64((1, 1), vec![pos])?,
                    "past_keys" => Tensor::from_array(past_keys)
                        .map_err(|e| SttError::Inference(format!("qwen3 past_keys: {e}")))?,
                    "past_values" => Tensor::from_array(past_values)
                        .map_err(|e| SttError::Inference(format!("qwen3 past_values: {e}")))?,
                ])
                .map_err(|e| SttError::Inference(format!("qwen3 decoder_step run: {e}")))?;
            current = Self::argmax_logits(&out_to_f32(&step_out["logits"])?)?;
            past_keys = out_to_f32(&step_out["present_keys"])?;
            past_values = out_to_f32(&step_out["present_values"])?;
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
