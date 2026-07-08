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

use ndarray::Array2;
use ort::memory::{AllocationDevice, Allocator, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor, ValueType};

use super::*;
use crate::winstt::stt::Accelerator;

/// Seq (dim 2) length of a KV-cache tensor value's runtime shape, read from metadata (no host copy).
/// Cohere KV is declared `(batch, num_heads, seq, head_dim)`; a 0-length `present.*` means the graph's
/// reused (cross-attn) branch echoed nothing, so the prior device-resident value is kept.
fn kv_seq_len(v: &DynValue) -> i64 {
    match v.dtype() {
        ValueType::Tensor { shape, .. } => shape.get(2).copied().unwrap_or(0),
        _ => 0,
    }
}

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
    // Device-resident KV-cache binding (mirrors WhisperEngine): the EP's allocation device (CPU
    // when the model runs on the CPU EP — cohere is CPU-pinned today — but DIRECTML/CUDA/WEBGPU_BUFFER
    // when a GPU EP is active). The decode loop binds `present.*` outputs here so the KV never
    // round-trips through the host between steps. On CPU this is correct and ~free.
    device: AllocationDevice,
    device_id: i32,
}

/// EP allocation device for the KV-cache IoBinding (parallels `whisper::ort_shapes::device_for_providers`).
/// Fused-attention exports (onnx-community) stay CPU-pinned (their `MultiHeadAttention` crashes on
/// DirectML), but decomposed exports (Masterx) are restored to DirectML by `resolve_catalog`, so this
/// resolves to `DIRECTML` for those and the decode loop's KV cache is device-resident on the GPU with
/// no further change. CUDA / WebGPU map the same way.
fn cohere_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

pub(in crate::winstt::stt::families) const COHERE_LANGUAGES: &[&str] = &[
    "ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];

/// Max candidate languages to score in the auto-detect pass. A specialised bilingual checkpoint
/// (arabic: en+ar) needs detection because its `<|unklang|>` target is biased; the fully-multilingual
/// checkpoint's unklang target is unbiased, so above this many candidates we skip detection and let
/// `<|unklang|>`/`<|unklang|>` do it in one pass (avoids N decode probes for the 14-language model).
const MAX_DETECT_LANGS: usize = 6;

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
        let (device, device_id) = cohere_device(&cfg.providers);

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
            device,
            device_id,
        })
    }

    /// EP `MemoryInfo` for KV-cache-resident outputs (CPU when no GPU EP → the current cohere path).
    fn device_mem(&self) -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("cohere device mem info: {e}")))
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

    /// Build the prompt token ids with explicit `source_lang` / `target_lang` slots. Transcription
    /// is `source == target`; a detection probe uses `source = <|unklang|>` with a concrete target.
    fn build_prompt_tokens(
        &self,
        source: &str,
        target: &str,
        punctuation: bool,
    ) -> SttResult<Vec<i64>> {
        let pnc = if punctuation { "<|pnc|>" } else { "<|nopnc|>" };
        let toks = [
            "\u{2581}",
            "<|startofcontext|>",
            "<|startoftranscript|>",
            "<|emo:undefined|>",
            source,
            target,
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

    fn build_prompt(&self, language: Option<&str>, punctuation: bool) -> SttResult<Vec<i64>> {
        let lang = self.resolve_lang_token(language);
        self.build_prompt_tokens(&lang, &lang, punctuation)
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

    /// Greedy autoregressive decode (beam=1, matches Cohere generation_config) with a DEVICE-RESIDENT
    /// KV cache via IoBinding (mirrors WhisperEngine): each step binds the carried `present.*` device
    /// values back as `past_key_values.*` and binds the new `present.*` straight to the device, so the
    /// 32 KV tensors never round-trip through the host between tokens. Returns the generated token ids
    /// and the mean per-token log-prob of the greedy path (the logits head is already `log_softmax`, so
    /// this is a language-detection confidence signal). `past[i] == None` is the (1,H,0,D) empty cache
    /// on step 0.
    fn decode(
        &mut self,
        encoder_out: &DynValue,
        cpu_mem: &MemoryInfo,
        dev_mem: &MemoryInfo,
        prompt: Vec<i64>,
        max_tokens: usize,
    ) -> SttResult<(Vec<i64>, f32)> {
        let prompt_len = prompt.len();
        let present_names = self.present_output_names.clone();
        let mut past: Vec<Option<DynValue>> =
            (0..self.past_input_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt;
        let mut logprob_sum = 0.0f32;
        let mut logprob_n = 0usize;

        for step in 0..max_tokens {
            let in_len = next_input.len();
            // Mask covers the prompt plus every token generated so far; from
            // step 1 on the single new token sits at position attn_len - 1.
            let attn_len = prompt_len + step;
            let position_ids: Vec<i64> = if step == 0 {
                (0..in_len as i64).collect()
            } else {
                vec![(attn_len - 1) as i64]
            };
            // Host per-step scalars/masks (tiny): full prompt on step 0, then the single new token.
            let input_ids = tensor_i64((1, in_len), next_input.clone())?;
            let attention_mask = tensor_i64((1, attn_len), vec![1i64; attn_len])?;
            let position = tensor_i64((1, position_ids.len()), position_ids)?;
            let num_logits_to_keep = scalar_i64(1)?;

            // Empty (1,H,0,D) host tensors for every `None` past entry (step 0), dtype-matched to the
            // decoder's declared KV type (§6.5). Held in these Vecs so they outlive `run_binding`.
            let empty_shape = [1usize, self.num_heads, 0usize, self.head_dim];
            let mut empties_f32: Vec<Tensor<f32>> = Vec::new();
            let mut empties_f16: Vec<Tensor<F16>> = Vec::new();
            for p in &past {
                if p.is_none() {
                    if self.past_is_fp16 {
                        empties_f16.push(
                            Tensor::<F16>::new(&Allocator::default(), empty_shape)
                                .map_err(|e| SttError::Inference(format!("empty kv f16: {e}")))?,
                        );
                    } else {
                        empties_f32.push(
                            Tensor::<f32>::new(&Allocator::default(), empty_shape)
                                .map_err(|e| SttError::Inference(format!("empty kv f32: {e}")))?,
                        );
                    }
                }
            }

            let mut binding = self
                .decoder
                .create_binding()
                .map_err(|e| SttError::Inference(format!("cohere decoder binding: {e}")))?;
            binding
                .bind_input("input_ids", &input_ids)
                .map_err(|e| SttError::Inference(format!("bind input_ids: {e}")))?;
            binding
                .bind_input("attention_mask", &attention_mask)
                .map_err(|e| SttError::Inference(format!("bind attention_mask: {e}")))?;
            binding
                .bind_input("position_ids", &position)
                .map_err(|e| SttError::Inference(format!("bind position_ids: {e}")))?;
            binding
                .bind_input("num_logits_to_keep", &num_logits_to_keep)
                .map_err(|e| SttError::Inference(format!("bind num_logits_to_keep: {e}")))?;
            binding
                .bind_input("encoder_hidden_states", encoder_out)
                .map_err(|e| SttError::Inference(format!("bind encoder_hidden_states: {e}")))?;
            let mut f32_iter = empties_f32.iter();
            let mut f16_iter = empties_f16.iter();
            for (i, name) in self.past_input_names.iter().enumerate() {
                match &past[i] {
                    Some(v) => binding
                        .bind_input(name.as_str(), v)
                        .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?,
                    None => {
                        if self.past_is_fp16 {
                            let empty = f16_iter.next().ok_or_else(|| {
                                SttError::Inference("missing empty f16 KV tensor".into())
                            })?;
                            binding.bind_input(name.as_str(), empty).map_err(|e| {
                                SttError::Inference(format!("bind empty {name}: {e}"))
                            })?;
                        } else {
                            let empty = f32_iter.next().ok_or_else(|| {
                                SttError::Inference("missing empty f32 KV tensor".into())
                            })?;
                            binding.bind_input(name.as_str(), empty).map_err(|e| {
                                SttError::Inference(format!("bind empty {name}: {e}"))
                            })?;
                        }
                    }
                }
            }
            // logits → host (argmax); present.* → device (carried resident to the next step).
            binding
                .bind_output_to_device("logits", cpu_mem)
                .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
            for pname in &present_names {
                binding
                    .bind_output_to_device(pname.as_str(), dev_mem)
                    .map_err(|e| SttError::Inference(format!("bind {pname}: {e}")))?;
            }

            let mut outputs = self
                .decoder
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("cohere decoder run_binding: {e}")))?;
            // GPU EPs run_binding async w.r.t. the device stream; sync before the host logits read and
            // before carrying the device `present.*` (harmless no-op on CPU). Mirrors WhisperEngine.
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("cohere decoder sync: {e}")))?;

            let (next, logprob) = {
                let logits = outputs.get("logits").ok_or_else(|| {
                    SttError::Inference("cohere decoder produced no logits".into())
                })?;
                let arr = out_to_f32(logits)?; // fp16 → f32 promote (§6.5)
                let last = last_step_row(&arr)?;
                let (idx, lp) = argmax_1d(&last); // lp is already a log-prob (log_softmax head)
                (idx as i64, lp)
            };
            logprob_sum += logprob;
            logprob_n += 1;
            if next == self.eos_token_id {
                break;
            }
            generated.push(next);

            // Carry present.* → past.* as DEVICE values (session-owned, survive the binding drop →
            // rebind next step with no host copy). Keep the prior value when a `present.*` is 0-length
            // (the reused cross-attn branch), so the resident encoder KV is never clobbered.
            for (i, pname) in present_names.iter().enumerate() {
                if let Some(v) = outputs.remove(pname.as_str())
                    && kv_seq_len(&v) != 0
                {
                    past[i] = Some(v);
                }
            }

            next_input = vec![next];
        }

        let mean_logprob = if logprob_n > 0 {
            logprob_sum / logprob_n as f32
        } else {
            f32::NEG_INFINITY
        };
        Ok((generated, mean_logprob))
    }

    /// Auto-detect the spoken language among `candidates` (ISO codes). `<|unklang|>` in the SOURCE
    /// slot detects the spoken language correctly, but the concrete TARGET language that actually
    /// matches the speech yields the most confident (highest mean log-prob) short decode — so we
    /// score each candidate over a short prefix and pick the best. Returns the winning code, or None
    /// if nothing scored (caller falls back to `<|unklang|>`/`<|unklang|>`).
    fn detect_language(
        &mut self,
        encoder_out: &DynValue,
        cpu_mem: &MemoryInfo,
        dev_mem: &MemoryInfo,
        candidates: &[String],
    ) -> SttResult<Option<String>> {
        const DETECT_TOKENS: usize = 24;
        let mut best: Option<(String, f32)> = None;
        for cand in candidates {
            let target = format!("<|{cand}|>");
            let prompt = self.build_prompt_tokens("<|unklang|>", &target, true)?;
            let (_, score) = self.decode(encoder_out, cpu_mem, dev_mem, prompt, DETECT_TOKENS)?;
            if best.as_ref().is_none_or(|(_, b)| score > *b) {
                best = Some((cand.clone(), score));
            }
        }
        Ok(best.map(|(lang, _)| lang))
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

        // ── Encoder → DEVICE-resident hidden state (bound once, reused every decode step) ──
        // Cohere (Conformer AED) uses the SAME 128-mel time-first NeMo featurizer (Slaney 128-mel,
        // preemphasis 0.97, n_fft=512/win=400/hop=160 Hann, per-feature norm). We bind `input_features`
        // (host) and pull `last_hidden_state` to the EP device, so the decoder cross-attends to a
        // resident tensor instead of re-uploading the host array every token.
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let t = fbank.nrows();
        let feat_dim = fbank.ncols();
        let x = fbank
            .into_shape_with_order((1, t, feat_dim))
            .map_err(|e| SttError::Inference(format!("cohere enc reshape: {e}")))?;
        let input_features = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("cohere enc tensor: {e}")))?;

        let dev_mem = self.device_mem()?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("cohere cpu mem info: {e}")))?;

        let encoder_out: DynValue = {
            let mut binding = self
                .encoder
                .create_binding()
                .map_err(|e| SttError::Inference(format!("cohere encoder binding: {e}")))?;
            binding
                .bind_input("input_features", &input_features)
                .map_err(|e| SttError::Inference(format!("bind input_features: {e}")))?;
            binding
                .bind_output_to_device("last_hidden_state", &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind last_hidden_state: {e}")))?;
            let mut out = self
                .encoder
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("cohere encoder run_binding: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("cohere encoder sync: {e}")))?;
            out.remove("last_hidden_state").ok_or_else(|| {
                SttError::Inference("cohere encoder produced no last_hidden_state".into())
            })?
        };

        // Resolve the transcription language. Explicit choice → source == target == choice. Auto-detect
        // → <|unklang|> in the TARGET slot biases the OUTPUT to the model's home language (Arabic on the
        // arabic checkpoint), so a real auto-detect first SCORES the candidate languages by decode
        // log-prob (§detect_language) and transcribes source == target == the detected one. With no
        // usable candidate set we keep <|unklang|>/<|unklang|> — correct on the fully-multilingual
        // checkpoint, whose unklang target is not biased.
        let language: Option<String> = match opts.language.as_deref() {
            Some(l) => Some(l.to_string()),
            None => {
                let cands: Vec<String> = opts
                    .language_candidates
                    .iter()
                    .map(|s| s.to_lowercase())
                    .filter(|s| self.token_to_id.contains_key(&format!("<|{s}|>")))
                    .collect();
                if (2..=MAX_DETECT_LANGS).contains(&cands.len()) {
                    self.detect_language(&encoder_out, &cpu_mem, &dev_mem, &cands)?
                } else {
                    None
                }
            }
        };

        let prompt = self.build_prompt(language.as_deref(), true)?;
        let (generated, _) = self.decode(
            &encoder_out,
            &cpu_mem,
            &dev_mem,
            prompt,
            self.max_decode_length,
        )?;
        let text = self.decode_text(&generated);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
