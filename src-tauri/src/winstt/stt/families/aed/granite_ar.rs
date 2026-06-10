// Granite-Speech AR engine (autoregressive decode over a spliced text+audio prompt).
//
// Encoder → audio embeds; build a `USER: <|audio|>… \n ASSISTANT:` prompt, splice the audio embeds
// into the `<|audio|>` slots, run `prompt_encode` once, then greedily decode token-by-token with the
// `decode_step` graph carrying past/present KV. `<|startofcontext|>` is UNTRAINED → no prompt
// injection (enforced by EngineKind::supports_initial_prompt()==false upstream).

use std::collections::BTreeMap;

use ort::session::Session;
use ort::value::Tensor;

use super::*;

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
    past_is_fp16: bool,
    max_decode_length: usize,
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
        let audio_token_id = tokenizer
            .token_to_id("<|audio|>")
            .map(i64::from)
            .unwrap_or(100352);
        let eos_token_id = tokenizer
            .token_to_id("<|end_of_text|>")
            .map(i64::from)
            .unwrap_or(100257);
        let past_input_names = filter_sorted_inputs(&decode_step, "past_key_values.");
        let present_output_names = filter_sorted_outputs(&decode_step, "present.");
        let (_, _, past_is_fp16) =
            node_past_shape(&decode_step, "past_key_values.").unwrap_or((4, 128, false));

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
            past_is_fp16,
            max_decode_length: 1024,
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

    fn run_prompt(
        &mut self,
        inputs_embeds: ndarray::Array3<f32>,
    ) -> SttResult<(i64, BTreeMap<String, KvTensor>)> {
        let n = inputs_embeds.shape()[1];
        let outputs = self
            .prompt_encode
            .run(ort::inputs![
                "inputs_embeds" => Tensor::from_array(inputs_embeds)
                    .map_err(|e| SttError::Inference(format!("granite prompt embeds tensor: {e}")))?,
                "position_ids" => tensor_i64((1, n), (0..n as i64).collect())?,
                "attention_mask" => Tensor::from_array(causal_attention_mask(n))
                    .map_err(|e| SttError::Inference(format!("granite prompt mask tensor: {e}")))?
            ])
            .map_err(|e| SttError::Inference(format!("granite prompt_encode run: {e}")))?;
        let logits = out_to_f32(&outputs["logits"])?;
        let next = argmax_1d(&last_step_row(&logits)?).0 as i64;
        let state = carry_present(
            &outputs,
            &self.past_input_names,
            &self.present_output_names,
            self.past_is_fp16,
        )?;
        Ok((next, state))
    }

    fn run_decode_step(
        &mut self,
        token: i64,
        past_len: usize,
        state: &BTreeMap<String, KvTensor>,
    ) -> SttResult<(i64, BTreeMap<String, KvTensor>)> {
        let token_embeds = run_embed_tokens(&mut self.embed_tokens, &[token], "granite ar step")?;
        let mut inputs: Vec<(
            std::borrow::Cow<'_, str>,
            ort::session::SessionInputValue<'_>,
        )> = Vec::with_capacity(3 + self.past_input_names.len());
        inputs.push((
            std::borrow::Cow::Borrowed("inputs_embeds"),
            ort::session::SessionInputValue::from(
                Tensor::from_array(token_embeds)
                    .map_err(|e| SttError::Inference(format!("granite step embed tensor: {e}")))?,
            ),
        ));
        inputs.push((
            std::borrow::Cow::Borrowed("position_ids"),
            ort::session::SessionInputValue::from(tensor_i64((1, 1), vec![past_len as i64])?),
        ));
        inputs.push((
            std::borrow::Cow::Borrowed("attention_mask"),
            ort::session::SessionInputValue::from(
                Tensor::from_array(ndarray::Array4::<f32>::zeros((1, 1, 1, past_len + 1)))
                    .map_err(|e| SttError::Inference(format!("granite step mask tensor: {e}")))?,
            ),
        ));
        for name in &self.past_input_names {
            let kv = state.get(name).ok_or_else(|| {
                SttError::Inference(format!("missing Granite KV state for {name}"))
            })?;
            let value = match kv {
                KvTensor::F32(a) => ort::session::SessionInputValue::from(
                    Tensor::from_array(a.clone())
                        .map_err(|e| SttError::Inference(format!("granite kv f32 {name}: {e}")))?,
                ),
                KvTensor::F16(a) => ort::session::SessionInputValue::from(
                    Tensor::from_array(a.clone())
                        .map_err(|e| SttError::Inference(format!("granite kv f16 {name}: {e}")))?,
                ),
            };
            inputs.push((std::borrow::Cow::Owned(name.clone()), value));
        }

        let outputs = self
            .decode_step
            .run(inputs)
            .map_err(|e| SttError::Inference(format!("granite decode_step run: {e}")))?;
        let logits = out_to_f32(&outputs["logits"])?;
        let next = argmax_1d(&last_step_row(&logits)?).0 as i64;
        let next_state = carry_present(
            &outputs,
            &self.past_input_names,
            &self.present_output_names,
            self.past_is_fp16,
        )?;
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
