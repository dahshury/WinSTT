// Cohere AED (merged decoder, fp16 KV-cache dtype + logits f32-promote).
//
// Conformer encoder (time-first mel (1,T,128)) + merged decoder with implicit KV-cache branch (no
// `use_cache_branch` input). Per step feeds input_ids/attention_mask/position_ids/num_logits_to_keep
// /encoder_hidden_states + 32 past_key_values.*; carries present.*→past_key_values.*. SentencePiece
// byte-fallback decode. fp16 fix: seed empty KV with the decoder's declared dtype + promote logits.
//
// The encoder mel preprocessor (`CohereAsrPreprocessorNumpy`, 128-bin time-first) has no ONNX twin.
// We run the same 128-mel NeMo/Cohere frontend in-process so the encoder receives the expected
// time-first features.

use std::collections::BTreeMap;

use ndarray::{Array2, ArrayD, Axis};
use ort::session::Session;
use ort::value::{Tensor, TensorRef};

use super::*;

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

pub(in crate::winstt::stt::families) const COHERE_LANGUAGES: &[&str] = &[
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
