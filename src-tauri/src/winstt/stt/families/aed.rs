// Attention-encoder-decoder + Granite + streaming-CTC engines:
//   * `CohereEngine` (merged decoder, fp16 KV-cache dtype + logits f32-promote),
//   * `GraniteArEngine` / `GraniteNarEngine` (Granite-Speech AR / NAR),
//   * `CanaryEngine` (NeMo AED with the `decoder_mems` loop),
//   * `ToneEngine` (T-one streaming CTC over raw 8 kHz int32 signal, no mel).
//
// Lifted verbatim out of the old monolithic `families.rs`; depends only on the shared `support`
// layer (incl. the `KvTensor` enum) and the `frontend` featurizers, never on a peer engine.

#![allow(dead_code)] // surface defined ahead of the dispatch call sites / resolver wiring.

use std::collections::BTreeMap;

use ndarray::{Array1, Array2, ArrayD, ArrayView2, Axis};
use ort::session::Session;
use ort::value::{Tensor, TensorRef};

use super::super::{
    ctc_greedy_collapse, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription,
};
use super::frontend;
use super::support::*;

// ───────────────────────────────────────────────────────────────────────────
// 7. Cohere AED  (merged decoder, fp16 KV-cache dtype + logits f32-promote)
// ───────────────────────────────────────────────────────────────────────────
//
// Conformer encoder (time-first mel (1,T,128)) + merged decoder with implicit KV-cache branch (no
// `use_cache_branch` input). Per step feeds input_ids/attention_mask/position_ids/num_logits_to_keep
// /encoder_hidden_states + 32 past_key_values.*; carries present.*→past_key_values.*. SentencePiece
// byte-fallback decode. fp16 fix: seed empty KV with the decoder's declared dtype + promote logits.
//
// The encoder mel preprocessor (`CohereAsrPreprocessorNumpy`, 128-bin time-first) has no ONNX twin.
// We run the same 128-mel NeMo/Cohere frontend in-process so the encoder receives the expected
// time-first features.

pub struct CohereEngine {
    encoder: Session,
    decoder: Session,
    token_to_id: BTreeMap<String, i64>,
    id_to_token: BTreeMap<i64, String>,
    byte_fallback: BTreeMap<i64, u8>,
    past_input_names: Vec<String>,
    present_output_names: Vec<String>,
    num_heads: usize,
    head_dim: usize,
    past_is_fp16: bool,
    eos_token_id: i64,
    max_decode_length: usize,
    mel_fb: Array2<f32>,
    model_name: String,
    providers: Vec<String>,
}

pub(super) const COHERE_LANGUAGES: &[&str] = &[
    "ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];

impl CohereEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<CohereEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;

        let tok_json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(file(&cfg.resolved, "tokenizer")?)
                .map_err(|e| SttError::Tokenizer(format!("read tokenizer.json: {e}")))?,
        )
        .map_err(|e| SttError::Tokenizer(format!("parse tokenizer.json: {e}")))?;

        let mut token_to_id = BTreeMap::new();
        if let Some(vocab) = tok_json
            .get("model")
            .and_then(|m| m.get("vocab"))
            .and_then(|v| v.as_object())
        {
            for (k, v) in vocab {
                if let Some(id) = v.as_i64() {
                    token_to_id.insert(k.clone(), id);
                }
            }
        }
        if token_to_id.is_empty() {
            return Err(SttError::Tokenizer("cohere vocab empty".into()));
        }
        let id_to_token: BTreeMap<i64, String> =
            token_to_id.iter().map(|(t, &i)| (i, t.clone())).collect();

        // tokenizer_config for eos id.
        let eos_token_id = read_special_id(
            file(&cfg.resolved, "tokenizer_config").ok(),
            "eos_token_id",
            &token_to_id,
            "<|endoftext|>",
            3,
        );

        // byte_fallback <0xXX>.
        let mut byte_fallback = BTreeMap::new();
        for b in 0u16..256 {
            let tok = format!("<0x{:02X}>", b);
            if let Some(&id) = token_to_id.get(&tok) {
                byte_fallback.insert(id, b as u8);
            }
        }

        // decoder past/present I/O names + dtype + head dims.
        let past_input_names = filter_sorted_inputs(&decoder, "past_key_values.");
        let present_output_names = filter_sorted_outputs(&decoder, "present.");
        let (num_heads, head_dim, past_is_fp16) = cohere_past_shape(&decoder)?;

        Ok(CohereEngine {
            encoder,
            decoder,
            token_to_id,
            id_to_token,
            byte_fallback,
            past_input_names,
            present_output_names,
            num_heads,
            head_dim,
            past_is_fp16,
            eos_token_id,
            max_decode_length: 1024,
            mel_fb: frontend::build_nemo_mel_filterbank(128),
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn resolve_lang_token(&self, language: Option<&str>) -> String {
        match language {
            Some(l) if COHERE_LANGUAGES.contains(&l.to_lowercase().as_str()) => {
                format!("<|{}|>", l.to_lowercase())
            }
            None => "<|unklang|>".into(),
            Some(_) => "<|en|>".into(),
        }
    }

    fn build_prompt(&self, language: Option<&str>, punctuation: bool) -> SttResult<Vec<i64>> {
        let pnc = if punctuation { "<|pnc|>" } else { "<|nopnc|>" };
        let lang = self.resolve_lang_token(language);
        let toks = [
            "\u{2581}",
            "<|startofcontext|>",
            "<|startoftranscript|>",
            "<|emo:undefined|>",
            lang.as_str(),
            lang.as_str(),
            pnc,
            "<|noitn|>",
            "<|notimestamp|>",
            "<|nodiarize|>",
        ];
        let mut prompt = Vec::with_capacity(toks.len());
        for tok in toks {
            let id = *self
                .token_to_id
                .get(tok)
                .ok_or_else(|| SttError::Tokenizer(format!("cohere missing prompt token {tok}")))?;
            prompt.push(id);
        }
        Ok(prompt)
    }

    /// Encode → owned `(T, 1024)` last_hidden_state (we keep it host-side as f32; the engine is
    /// CPU-forced so device IoBinding is not required for correctness).
    fn encode(&mut self, audio: &[f32]) -> SttResult<Array2<f32>> {
        // Cohere (Conformer AED) uses the SAME 128-mel time-first featurizer as NeMo
        // (Slaney 128-mel, preemphasis 0.97, n_fft=512/win=400/hop=160 Hann, per-feature
        // norm over time) — faithful to onnx-asr's Cohere featurizer. The old 80-mel kaldi
        // The previous 80-mel `compute_fbank` frontend produced wrong numerics and garbled output.
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let t = fbank.nrows();
        let feat_dim = fbank.ncols();
        let x = fbank
            .into_shape_with_order((1, t, feat_dim))
            .map_err(|e| SttError::Inference(format!("cohere enc reshape: {e}")))?;
        let tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("cohere enc tensor: {e}")))?;
        let outputs = self
            .encoder
            .run(ort::inputs![ "input_features" => tensor ])
            .map_err(|e| SttError::Inference(format!("cohere encoder run: {e}")))?;
        let hidden = out_to_f32(&outputs["last_hidden_state"])?;
        let hidden3 = hidden
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("cohere hidden dim: {e}")))?;
        Ok(hidden3.index_axis_move(Axis(0), 0).to_owned())
    }

    /// Build empty KV-cache tensors `(1, num_heads, 0, head_dim)` in the decoder's declared dtype.
    /// The fp16 seed is the §6.5 fix: a float32 empty cache on an fp16 decoder trips ORT's input
    /// type check on the very first step.
    fn empty_state(&self) -> SttResult<BTreeMap<String, KvTensor>> {
        let shape = ndarray::IxDyn(&[1, self.num_heads, 0, self.head_dim]);
        let mut map = BTreeMap::new();
        for name in &self.past_input_names {
            let kv = if self.past_is_fp16 {
                KvTensor::F16(ArrayD::<F16>::from_elem(shape.clone(), F16::from_f32(0.0)))
            } else {
                KvTensor::F32(ArrayD::<f32>::zeros(shape.clone()))
            };
            map.insert(name.clone(), kv);
        }
        Ok(map)
    }

    fn decode_text(&self, tokens: &[i64]) -> String {
        let mut out = String::new();
        let mut byte_buf: Vec<u8> = Vec::new();
        let flush = |buf: &mut Vec<u8>, out: &mut String| {
            if !buf.is_empty() {
                out.push_str(&String::from_utf8_lossy(buf));
                buf.clear();
            }
        };
        for &tid in tokens {
            if let Some(&b) = self.byte_fallback.get(&tid) {
                byte_buf.push(b);
                continue;
            }
            flush(&mut byte_buf, &mut out);
            let Some(token) = self.id_to_token.get(&tid) else {
                continue;
            };
            if is_special_token(token) {
                continue;
            }
            out.push_str(&token.replace('\u{2581}', " "));
        }
        flush(&mut byte_buf, &mut out);
        out.strip_prefix(' ').unwrap_or(&out).to_string()
    }
}

impl Transcriber for CohereEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::CohereAsr
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
        let encoder_hidden = self.encode(audio)?; // (T, 1024), kept host-side
        let enc_t = encoder_hidden.nrows();
        let enc_d = encoder_hidden.ncols();
        // Pre-flatten the encoder hidden state ONCE (row-major → (1, T, D)) so the decode loop can
        // BORROW it each token via TensorRef instead of rebuilding + cloning the full [T,D] array
        // every step (the dominant per-token host cost — the same waste fixed in CanaryEngine).
        let enc_flat: Vec<f32> = encoder_hidden.iter().copied().collect();
        let enc_shape = [1usize, enc_t, enc_d];
        let prompt = self.build_prompt(opts.language.as_deref(), true)?;
        let prompt_len = prompt.len();

        // Greedy autoregressive decode (beam=1, matches Cohere generation_config). The 32 past/present
        // KV tensors are carried HOST-SIDE (dtype-matched f32/f16 per §6.5). This is correct but
        // re-feeds the host arrays each step; device-side IoBinding can replace it after benchmark
        // coverage proves the fast path.
        let mut state = self.empty_state()?;
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.clone();
        let mut attn_len = prompt_len;
        let mut pos_start = 0i64;

        #[expect(
            clippy::explicit_counter_loop,
            reason = "attn_len starts at prompt_len (not 0) and is incremented only after the EOS early-break, so it is the attention length used in tensor shapes, not a plain loop counter"
        )]
        for step in 0..self.max_decode_length {
            let in_len = next_input.len();
            let position_ids: Vec<i64> = if step == 0 {
                (0..in_len as i64).collect()
            } else {
                vec![pos_start]
            };

            // Named inputs with the encoder hidden state BORROWED (zero-copy) via TensorRef instead
            // of rebuilt+cloned per token; the KV stays allocator-backed (it is 0-length on step 0,
            // which TensorRef's raw-data path rejects). The borrowed lifetime means building the vec
            // inline (push_tensor/push_past_kv are 'static-typed).
            let mut inputs: Vec<(
                std::borrow::Cow<'_, str>,
                ort::session::SessionInputValue<'_>,
            )> = Vec::with_capacity(5 + self.past_input_names.len());
            inputs.push((
                std::borrow::Cow::Borrowed("input_ids"),
                ort::session::SessionInputValue::from(tensor_i64((1, in_len), next_input.clone())?),
            ));
            inputs.push((
                std::borrow::Cow::Borrowed("attention_mask"),
                ort::session::SessionInputValue::from(tensor_i64(
                    (1, attn_len),
                    vec![1i64; attn_len],
                )?),
            ));
            inputs.push((
                std::borrow::Cow::Borrowed("position_ids"),
                ort::session::SessionInputValue::from(tensor_i64(
                    (1, position_ids.len()),
                    position_ids,
                )?),
            ));
            inputs.push((
                std::borrow::Cow::Borrowed("num_logits_to_keep"),
                ort::session::SessionInputValue::from(scalar_i64(1)?),
            ));
            let enc_ref = TensorRef::from_array_view((enc_shape.as_slice(), enc_flat.as_slice()))
                .map_err(|e| SttError::Inference(format!("cohere enc view: {e}")))?;
            inputs.push((
                std::borrow::Cow::Borrowed("encoder_hidden_states"),
                ort::session::SessionInputValue::from(enc_ref),
            ));
            for name in &self.past_input_names {
                let kv = state
                    .get(name)
                    .ok_or_else(|| SttError::Inference(format!("missing KV state for {name}")))?;
                let value = match kv {
                    KvTensor::F32(a) => ort::session::SessionInputValue::from(
                        Tensor::from_array(a.clone())
                            .map_err(|e| SttError::Inference(format!("kv f32 {name}: {e}")))?,
                    ),
                    KvTensor::F16(a) => ort::session::SessionInputValue::from(
                        Tensor::from_array(a.clone())
                            .map_err(|e| SttError::Inference(format!("kv f16 {name}: {e}")))?,
                    ),
                };
                inputs.push((std::borrow::Cow::Owned(name.clone()), value));
            }

            let outputs = self
                .decoder
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("cohere decoder run: {e}")))?;

            let logits = out_to_f32(&outputs["logits"])?; // fp16 → f32 promote (§6.5)
            let last = last_step_row(&logits)?;
            let next = argmax_1d(&last).0 as i64;
            if next == self.eos_token_id {
                break;
            }
            generated.push(next);

            state = carry_present(
                &outputs,
                &self.past_input_names,
                &self.present_output_names,
                self.past_is_fp16,
            )?;
            next_input = vec![next];
            attn_len += 1;
            pos_start = (prompt_len + step) as i64;
        }

        let text = self.decode_text(&generated);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Canary AED  (NeMo encoder/decoder with decoder_mems loop)
// ───────────────────────────────────────────────────────────────────────────
//
// Static 10-token control prompt; encoder → (encoder_embeddings, encoder_mask); decoder runs with
// growing `decoder_mems` (full input when mems.shape[2]==0 else last-token-only). Stop on all-EOS
// or max_sequence_length=1024. <|...|> stripped on decode. `<|startofcontext|>` is UNTRAINED → no
// prompt injection (enforced by EngineKind::supports_initial_prompt()==false upstream).

pub(super) struct GraniteArEngine {
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
    pub(super) fn load(cfg: &EngineConfig) -> SttResult<GraniteArEngine> {
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

/// `encode_audio` output: (encoder hidden states, attention mask, audio
/// embeddings, audio frame length).
type GraniteNarEncoded = (ArrayD<f32>, ArrayD<f32>, ndarray::Array3<f32>, usize);

pub(super) struct GraniteNarEngine {
    encoder: Session,
    embed_tokens: Session,
    editor: Session,
    tokenizer: tokenizers::Tokenizer,
    blank_token_id: i64,
    embedding_multiplier: f32,
    model_name: String,
    providers: Vec<String>,
}

impl GraniteNarEngine {
    pub(super) fn load(cfg: &EngineConfig) -> SttResult<GraniteNarEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let embed_tokens = build_session(file(&cfg.resolved, "embed_tokens")?, &cfg.providers)?;
        let editor = build_session(file(&cfg.resolved, "editor")?, &cfg.providers)?;
        let tokenizer = load_granite_tokenizer(file(&cfg.resolved, "tokenizer")?)?;
        let blank_token_id = tokenizer
            .token_to_id("<|end_of_text|>")
            .map(i64::from)
            .unwrap_or(100257);

        Ok(GraniteNarEngine {
            encoder,
            embed_tokens,
            editor,
            tokenizer,
            blank_token_id,
            embedding_multiplier: 12.0,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn encode_audio(&mut self, audio: &[f32]) -> SttResult<GraniteNarEncoded> {
        let features = frontend::granite_nar_features(audio);
        let t = features.nrows();
        if t == 0 {
            return Ok((
                ArrayD::<f32>::zeros(ndarray::IxDyn(&[1, 0, 0])),
                ArrayD::<f32>::zeros(ndarray::IxDyn(&[1, 0])),
                ndarray::Array3::<f32>::zeros((1, 0, 2048)),
                0,
            ));
        }
        let x = features
            .into_shape_with_order((1, t, 160))
            .map_err(|e| SttError::Inference(format!("granite nar feature reshape: {e}")))?;
        let outputs = self
            .encoder
            .run(ort::inputs![
                "input_features" => Tensor::from_array(x)
                    .map_err(|e| SttError::Inference(format!("granite nar feature tensor: {e}")))?,
                "attention_mask" => tensor_i64((1, t), vec![1; t])?
            ])
            .map_err(|e| SttError::Inference(format!("granite nar encoder run: {e}")))?;
        let bpe_logits = out_to_f32(&outputs["bpe_logits_dense"])?;
        let bpe_mask = out_to_mask_f32(&outputs["bpe_mask"])?;
        let mut audio_embeds = out_to_f32(&outputs["audio_embeds"])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar audio embeds dim: {e}")))?;
        if self.embedding_multiplier != 0.0 {
            audio_embeds.mapv_inplace(|v| v / self.embedding_multiplier);
        }
        let audio_lengths = out_to_i64(&outputs["audio_lengths"])?
            .into_dimensionality::<ndarray::Ix1>()
            .map_err(|e| SttError::Inference(format!("granite nar audio lengths dim: {e}")))?;
        let audio_len = audio_lengths
            .get(0)
            .copied()
            .unwrap_or(audio_embeds.shape()[1] as i64)
            .max(0) as usize;
        let audio_len = audio_len.min(audio_embeds.shape()[1]);
        Ok((bpe_logits, bpe_mask, audio_embeds, audio_len))
    }

    fn ctc_draft(&self, logits: &ArrayD<f32>, mask: &ArrayD<f32>) -> SttResult<Vec<i64>> {
        let logits = logits
            .view()
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar bpe logits dim: {e}")))?;
        let mask = mask
            .view()
            .into_dimensionality::<ndarray::Ix2>()
            .map_err(|e| SttError::Inference(format!("granite nar bpe mask dim: {e}")))?;
        let mut ids = Vec::new();
        for t in 0..logits.shape()[1] {
            if mask[[0, t]] <= 0.0 {
                continue;
            }
            let row = logits
                .index_axis(Axis(0), 0)
                .index_axis(Axis(0), t)
                .to_vec();
            ids.push(argmax_1d(&row).0 as i64);
        }
        Ok(ctc_greedy_collapse(&ids, self.blank_token_id))
    }

    fn add_insertion_slots(&self, ids: &[i64]) -> Vec<i64> {
        let out_len = (2 * ids.len() + 1).max(8);
        let mut out = vec![self.blank_token_id; out_len];
        for (i, &id) in ids.iter().enumerate() {
            out[2 * i + 1] = id;
        }
        out
    }

    fn run_editor(
        &mut self,
        slot_ids: &[i64],
        audio_embeds: &ndarray::Array3<f32>,
        audio_len: usize,
    ) -> SttResult<Vec<i64>> {
        let text_embeds = run_embed_tokens(&mut self.embed_tokens, slot_ids, "granite nar")?;
        let hidden = text_embeds.shape()[2];
        let text_len = slot_ids.len();
        let total_len = audio_len + text_len;
        let mut flat = Vec::with_capacity(total_len * hidden);
        for t in 0..audio_len {
            for h in 0..hidden {
                flat.push(audio_embeds[[0, t, h]]);
            }
        }
        for t in 0..text_len {
            for h in 0..hidden {
                flat.push(text_embeds[[0, t, h]]);
            }
        }
        let inputs_embeds = ndarray::Array3::from_shape_vec((1, total_len, hidden), flat)
            .map_err(|e| SttError::Inference(format!("granite nar flat embeds shape: {e}")))?;
        let outputs = self
            .editor
            .run(ort::inputs![
                "inputs_embeds" => Tensor::from_array(inputs_embeds)
                    .map_err(|e| SttError::Inference(format!("granite nar editor embeds tensor: {e}")))?,
                "position_ids" => tensor_i64((1, total_len), (0..total_len as i64).collect())?,
                "attention_mask" => Tensor::from_array(ndarray::Array4::<f32>::zeros((1, 1, total_len, total_len)))
                    .map_err(|e| SttError::Inference(format!("granite nar editor mask tensor: {e}")))?
            ])
            .map_err(|e| SttError::Inference(format!("granite nar editor run: {e}")))?;
        let logits = out_to_f32(&outputs["logits"])?
            .into_dimensionality::<ndarray::Ix3>()
            .map_err(|e| SttError::Inference(format!("granite nar editor logits dim: {e}")))?;
        let mut ids = Vec::with_capacity(text_len);
        for t in audio_len..total_len {
            let row = logits
                .index_axis(Axis(0), 0)
                .index_axis(Axis(0), t)
                .to_vec();
            ids.push(argmax_1d(&row).0 as i64);
        }
        Ok(ctc_greedy_collapse(&ids, self.blank_token_id))
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        granite_decode_tokens(&self.tokenizer, ids)
    }
}

impl Transcriber for GraniteNarEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::GraniteSpeechNar
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
        let (bpe_logits, bpe_mask, audio_embeds, audio_len) = self.encode_audio(audio)?;
        if audio_len == 0 {
            return Ok(Transcription::default());
        }
        let draft = self.ctc_draft(&bpe_logits, &bpe_mask)?;
        let slots = self.add_insertion_slots(&draft);
        let final_ids = self.run_editor(&slots, &audio_embeds, audio_len)?;
        let text = self.decode_text(&final_ids)?;
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

pub struct CanaryEngine {
    encoder: Session,
    decoder: Session,
    vocab: Vocab,
    token_to_id: BTreeMap<String, i64>,
    transcribe_input: Vec<i64>,
    eos_token_id: i64,
    max_sequence_length: usize,
    mel_fb: Array2<f32>,
    model_name: String,
    providers: Vec<String>,
}

fn canary_concrete_language(raw: &str) -> Option<&str> {
    let lang = raw.trim();
    if lang.is_empty() || lang == "auto" {
        None
    } else {
        Some(lang)
    }
}

fn canary_configured_language(opts: &TranscribeOptions) -> Option<&str> {
    opts.language
        .as_deref()
        .and_then(canary_concrete_language)
        .or_else(|| {
            opts.language_candidates
                .iter()
                .map(String::as_str)
                .find_map(canary_concrete_language)
        })
}

pub(super) fn canary_prompt_tokens(
    base: &[i64],
    token_to_id: &BTreeMap<String, i64>,
    opts: &TranscribeOptions,
) -> Vec<i64> {
    let mut toks = base.to_vec();
    if toks.len() < 6 {
        return toks;
    }
    if let Some(lang) = canary_configured_language(opts) {
        if let Some(&id) = token_to_id.get(&format!("<|{lang}|>")) {
            toks[4] = id;
            toks[5] = id;
        }
    }
    if opts.translate {
        if let Some(&id) = token_to_id.get("<|en|>") {
            toks[5] = id;
        }
    }
    toks
}

impl CanaryEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<CanaryEngine> {
        let encoder = build_session(file(&cfg.resolved, "encoder")?, &cfg.providers)?;
        let decoder = build_session(file(&cfg.resolved, "decoder")?, &cfg.providers)?;
        // Canary declares 128-mel `audio_signal`; read it before `encoder` is moved into the struct.
        let mel_fb = frontend::build_nemo_mel_filterbank(feat_dim_of(&encoder, "audio_signal"));
        // Load with `▁→space` (matches `_AsrWithDecoding.__init__`): the prompt's `" "` slot resolves
        // to the `▁`-origin token, and the decode appends already-spaced symbols.
        let vocab = Vocab::load(file(&cfg.resolved, "vocab")?, false, true)?;
        let token_to_id: BTreeMap<String, i64> = vocab
            .id_to_sym
            .iter()
            .map(|(&i, t)| (t.clone(), i))
            .collect();

        let need = |t: &str| -> SttResult<i64> {
            token_to_id
                .get(t)
                .copied()
                .ok_or_else(|| SttError::Tokenizer(format!("canary missing token {t}")))
        };
        let transcribe_input = vec![
            need(" ")?,
            need("<|startofcontext|>")?,
            need("<|startoftranscript|>")?,
            need("<|emo:undefined|>")?,
            need("<|en|>")?,
            need("<|en|>")?,
            need("<|pnc|>")?,
            need("<|noitn|>")?,
            need("<|notimestamp|>")?,
            need("<|nodiarize|>")?,
        ];
        let eos_token_id = need("<|endoftext|>")?;

        Ok(CanaryEngine {
            encoder,
            decoder,
            vocab,
            token_to_id,
            transcribe_input,
            eos_token_id,
            max_sequence_length: 1024,
            mel_fb,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    fn prompt_for(&self, opts: &TranscribeOptions) -> Vec<i64> {
        canary_prompt_tokens(&self.transcribe_input, &self.token_to_id, opts)
    }
}

impl Transcriber for CanaryEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::NemoAed
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
        // Encode (audio_signal=(1,feat,T), length=[T]) → (encoder_embeddings, encoder_mask).
        // NeMo 128-mel featurizer (per-feature normalized) — NOT the 80-mel kaldi fbank.
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let t = fbank.nrows();
        if t == 0 {
            return Ok(Transcription::default());
        }
        let feat_dim = fbank.ncols();
        // `.t()` is an F-order view; force a C-contiguous owned copy before reshaping
        // (into_shape_with_order rejects the transposed layout — was "incompatible memory layout").
        let x = fbank
            .t()
            .as_standard_layout()
            .into_owned()
            .into_shape_with_order((1, feat_dim, t))
            .map_err(|e| SttError::Inference(format!("canary enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("canary enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;

        let enc_out = self
            .encoder
            .run(ort::inputs![ "audio_signal" => x_tensor, "length" => len_tensor ])
            .map_err(|e| SttError::Inference(format!("canary encoder run: {e}")))?;
        let encoder_embeddings = out_to_f32(&enc_out["encoder_embeddings"])?;
        let encoder_mask = out_to_i64(&enc_out["encoder_mask"])?;
        drop(enc_out); // release &mut self.encoder (SessionOutputs holds it via Drop) before &self use

        let prompt = self.prompt_for(opts);
        let prefix_len = prompt.len();
        let mut batch_tokens: Vec<i64> = prompt;

        // Greedy AED decode with the NeMo `decoder_mems` cache. The decoder returns
        // `decoder_hidden_states`, which becomes the NEXT step's `decoder_mems` (port of
        // nemo.py `NemoConformerAED._decode`/`_decoding`). input_ids = full prompt while the mems
        // are empty (shape[2]==0), then only the last token. EOS breaks BEFORE it's appended.
        // (The prior code re-fed zero mems every step → no context after token 0 → output "And".)
        let enc_shape = encoder_embeddings.shape().to_vec();
        let mask_shape = encoder_mask.shape().to_vec();
        // Initial decoder_mems: (num_layers, 1, 0, hidden) — dms_shape declares mem_len(dim 2)=0.
        let mut decoder_mems: ArrayD<f32> =
            ArrayD::<f32>::zeros(ndarray::IxDyn(&dms_shape(&self.decoder)));

        while batch_tokens.len() < self.max_sequence_length {
            let mem_len = decoder_mems.shape().get(2).copied().unwrap_or(0);
            let (input_len, input_ids_data): (usize, Vec<i64>) = if mem_len == 0 {
                (batch_tokens.len(), batch_tokens.clone())
            } else {
                (1, vec![*batch_tokens.last().unwrap()])
            };
            let input_ids = tensor_i64((1, input_len), input_ids_data)?;

            // Zero-copy: BORROW the static encoder outputs + the current mems as TensorRefs rather
            // than re-cloning them onto the host EVERY token. `clone_f32_arrayd`/`Tensor::from_array`
            // were O(tokens) host re-uploads of the UNCHANGING encoder_embeddings/encoder_mask plus
            // the growing decoder_mems — the dominant cost vs the reference's by-reference numpy onnx-asr
            // path (Rust was far slower than the reference's ~1.8s on canary-1b-int8 purely from this).
            // The borrows live only inside `named`, released when `run` consumes it; decoder_mems is
            // then reassigned from next_mems below.
            let enc_emb = TensorRef::from_array_view((
                enc_shape.as_slice(),
                encoder_embeddings.as_slice().ok_or_else(|| {
                    SttError::Inference("encoder_embeddings not contiguous".into())
                })?,
            ))
            .map_err(|e| SttError::Inference(format!("canary enc_emb view: {e}")))?;
            let enc_mask = TensorRef::from_array_view((
                mask_shape.as_slice(),
                encoder_mask
                    .as_slice()
                    .ok_or_else(|| SttError::Inference("encoder_mask not contiguous".into()))?,
            ))
            .map_err(|e| SttError::Inference(format!("canary enc_mask view: {e}")))?;
            // decoder_mems is 0-length on the FIRST step (mem_len dim = 0). TensorRef's raw-data
            // path rejects 0-sized dims (allocator-backed `Tensor::from_array` accepts them — same
            // gotcha as whisper.rs's empty KV); this carry is small vs the encoder outputs borrowed
            // above, so keep it as an allocator-backed clone.
            let mems_tensor = Tensor::from_array(decoder_mems.clone())
                .map_err(|e| SttError::Inference(format!("canary mems: {e}")))?;

            let named: Vec<(
                std::borrow::Cow<'_, str>,
                ort::session::SessionInputValue<'_>,
            )> = vec![
                (
                    std::borrow::Cow::Borrowed("input_ids"),
                    ort::session::SessionInputValue::from(input_ids),
                ),
                (
                    std::borrow::Cow::Borrowed("encoder_embeddings"),
                    ort::session::SessionInputValue::from(enc_emb),
                ),
                (
                    std::borrow::Cow::Borrowed("encoder_mask"),
                    ort::session::SessionInputValue::from(enc_mask),
                ),
                (
                    std::borrow::Cow::Borrowed("decoder_mems"),
                    ort::session::SessionInputValue::from(mems_tensor),
                ),
            ];
            let outputs = self
                .decoder
                .run(named)
                .map_err(|e| SttError::Inference(format!("canary decoder run: {e}")))?;

            let logits = out_to_f32(&outputs["logits"])?;
            let next_mems = out_to_f32(&outputs["decoder_hidden_states"])?;
            drop(outputs);

            let last = last_step_row(&logits)?;
            let (best, _) = argmax_1d(&last);
            let next = best as i64;
            if next == self.eos_token_id {
                break;
            }
            batch_tokens.push(next);
            decoder_mems = next_mems; // carry decoder_hidden_states → decoder_mems
        }

        // Decode: strip <|...|> tokens.
        let out_tokens = &batch_tokens[prefix_len..];
        let mut text = String::new();
        for &tid in out_tokens {
            if let Some(sym) = self.vocab.get(tid) {
                if !sym.starts_with("<|") {
                    text.push_str(sym);
                }
            }
        }
        let text = join_and_normalize(&[text.as_str()], false);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 8b. T-One — streaming CTC (single graph; raw 8 kHz int32 signal, NO mel)
// ───────────────────────────────────────────────────────────────────────────
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
    let views: Vec<ArrayView2<f32>> = all_logprobs.iter().map(|a| a.view()).collect();
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
        let in_names = session_input_names(&session);
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
        let st = self.stream.as_mut().expect("reset above");
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
