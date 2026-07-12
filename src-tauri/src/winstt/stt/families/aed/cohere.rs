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
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
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

/// Stage-timing diagnostics, printed to stderr when `WINSTT_COHERE_PROFILE` is set (spike harness /
/// bench runs only — never in the shipped hot path unless the user opts in).
fn profile_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("WINSTT_COHERE_PROFILE").is_ok())
}

pub struct CohereEngine {
    encoder: Session,
    decoder: Session,
    token_to_id: BTreeMap<String, i64>,
    id_to_token: BTreeMap<i64, String>,
    byte_fallback: BTreeMap<i64, u8>,
    past_input_names: Vec<String>,
    present_output_names: Vec<String>,
    /// Hoisted-cross-KV layout (optimized exports): the ENCODER graph computes the 16 cross-attention
    /// K/V tensors once per utterance and exposes them as extra `cross_attn.{i}.encoder.{key,value}`
    /// outputs; the DECODER consumes them as same-named inputs instead of recomputing them from
    /// `encoder_hidden_states` on EVERY token (which cost ~100x the decoder's own per-token compute).
    /// Both lists are empty on legacy exports — every related step is a no-op there.
    encoder_cross_outputs: Vec<String>,
    decoder_cross_inputs: Vec<String>,
    /// STATIC-KV layout (`winstt_static_kv` decoder metadata): the self-attn KV cache is a fixed
    /// `Some(max)`-length buffer updated in-graph by a masked write, and the causal/padding mask is
    /// a host-fed `attn_bias` input — every per-step shape is CONSTANT, so the DirectML EP compiles
    /// its fused graph once instead of re-fusing per token (~34 ms/token measured). `None` = legacy
    /// growing-KV layout.
    static_kv_max: Option<usize>,
    /// `Some(bucket_samples)` when the ENCODER runs on DirectML AND the STATIC decoder is active
    /// (`static_kv_max.is_some()` — the fully-optimized, DML-safe export pair): input audio is
    /// zero-padded up to this fixed length so every utterance shares ONE encoder input shape. A
    /// legacy / dynamic-only decoder that still resolves (the resolver's `decoder` glob accepts any
    /// merged decoder and `decoder_dyn` is optional) runs the encoder at its natural length — the pad
    /// is only known-benign for the shipped static exports (transcripts verified unchanged there), so
    /// it is not force-fed to an export whose provenance we cannot vouch for. The DML EP caches the
    /// fused graph for exactly one shape signature per session (first-compiled wins — measured:
    /// alternating two lengths keeps only the FIRST warm at ~0.1s; the other re-fuses EVERY run at
    /// ~0.7s). Real dictation has a new length every utterance, so without padding every decode pays
    /// the ~0.7s re-fuse tax. Mirrors the official transformers long-form path (chunks padded to a
    /// common length) — our export has no attention mask, but trailing digital silence is benign
    /// (verified: transcripts unchanged with 22s of zero-pad). Bonus: a fixed S_enc also pins the
    /// Arabic decoder's dynamic cross-input shapes, so its DML graph fuses once too. `None` on
    /// CPU/CUDA (no per-shape re-fuse there — padding would only add compute).
    encoder_pad_bucket: Option<usize>,
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
/// Follows the DECODER session's placement: on the DirectML HYBRID (hoisted exports) the decoder runs
/// on the CPU EP, so `load` overrides this to CPU and the encoder outputs (incl. hoisted cross-KV) are
/// bound to HOST memory once per utterance. CUDA keeps the decoder on-device (no per-shape recompile),
/// so KV stays device-resident there.
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

/// Fixed KV-buffer length of `winstt_static_kv` exports (matches the tool's `STATIC_MAX_KV` and the
/// model's `max_position_embeddings`; also the engine's `max_decode_length`).
const STATIC_MAX_KV: usize = 1024;

/// Encoder pad-bucket length in samples (see `encoder_pad_bucket`). 28 s matches Cohere's own
/// `EngineKind::max_chunk_seconds()` VAD-segment cap (the backend routes with the per-family cap),
/// so EVERY segment the app can produce lands in the one cached encoder shape. Cost of the pad
/// itself is small and flat — warm encoder ≈ 0.18 s at 28 s vs
/// ≈ 0.09 s at 6 s natural (memory-bound conformer) — versus the ~0.7 s per-utterance re-fuse it
/// removes. Audio longer than the bucket runs at natural length (re-fuse, same as before).
const ENC_PAD_BUCKET_SAMPLES: usize = 28 * 16_000;

/// Whether the DirectML encoder pad-bucket applies (see `encoder_pad_bucket`). Gated on THREE facts:
/// the encoder session is on DirectML (only there does the per-shape re-fuse tax exist), the STATIC
/// decoder is the one loaded (`static_decoder` — the pad is only proven benign for the shipped static
/// export pair; a legacy/dynamic decoder that still resolves runs at natural length), and the
/// `WINSTT_COHERE_NO_ENC_PAD` escape hatch is unset. Pure so the gate is unit-testable without a session.
fn encoder_pad_bucket(enc_on_dml: bool, static_decoder: bool, no_pad_env: bool) -> Option<usize> {
    (enc_on_dml && static_decoder && !no_pad_env).then_some(ENC_PAD_BUCKET_SAMPLES)
}

impl CohereEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<CohereEngine> {
        // HYBRID device policy on DirectML (measured, 66 s clip, fp32, RTX 3080 Ti):
        //   * encoder: DML 1.38 s vs CPU 6.05 s → 4.4× faster on DML (one big static-shape run);
        //   * decoder: DML ~34 ms/token FIXED vs CPU 12.6 ms/token → ~3× faster on CPU. The DML cost
        //     is per-run graph RE-COMPILATION: every autoregressive step changes the input shapes
        //     (mask/past lengths grow), and the DML EP re-fuses its DML_GRAPH per shape signature —
        //     independent of S and of weight size (fp16 34 ms ≈ fp32 37 ms; tiny 3 s clip identical).
        // So on DirectML the DECODER runs on the CPU EP (encoder outputs are then bound to HOST
        // memory — see `cohere_device`). CUDA keeps both sessions on GPU (no per-shape recompile).
        // Diagnostics: WINSTT_COHERE_ENCODER_CPU pins the encoder to CPU;
        // WINSTT_COHERE_DECODER_DML forces the decoder back onto DirectML (benchmark escape hatch).
        let cpu_only = [Accelerator::Cpu];
        let enc_providers: &[Accelerator] = if std::env::var("WINSTT_COHERE_ENCODER_CPU").is_ok() {
            &cpu_only
        } else {
            &cfg.providers
        };
        // Layout markers (byte-scanned from the decoder proto BEFORE session build):
        //   * `winstt_static_kv`  — fixed-shape decode: every step reuses one compiled DML graph, so
        //     the decoder goes back ON DirectML (fastest placement).
        //   * `winstt_hoisted_cross_kv` only — per-step shapes still grow → DML re-fuses per token
        //     (~34 ms fixed), so the decoder runs on the CPU EP (12.6 ms/token) = hybrid.
        //   * neither (legacy) — the decoder recomputes cross-KV per token; on CPU that costs
        //     ~200 ms/token, far worse than DML's recompile tax → keep the full provider list.
        let decoder_path = file(&cfg.resolved, "decoder")?;
        let mut static_export =
            crate::winstt::stt::onnx_graph_contains_op(decoder_path, "winstt_static_kv");
        let hoisted_export = static_export
            || crate::winstt::stt::onnx_graph_contains_op(decoder_path, "winstt_hoisted_cross_kv");
        let dml_primary = cfg.providers.first() == Some(&Accelerator::DirectMl);
        let dec_providers: &[Accelerator] = if std::env::var("WINSTT_COHERE_DECODER_DML").is_ok() {
            &cfg.providers
        } else if (dml_primary && hoisted_export && !static_export)
            || std::env::var("WINSTT_COHERE_DECODER_CPU").is_ok()
        {
            &cpu_only
        } else {
            &cfg.providers
        };
        let decoder_on_cpu = dec_providers.first() == Some(&Accelerator::Cpu);
        // On the CPU EP, the growing-self dynamic decoder (`decoder_dyn`) is ~3× faster than the
        // DML-static graph (which attends over the full fixed KV buffer every token) — pick it when
        // the decoder is CPU-bound and the export ships one. On DML the static graph wins big.
        let decoder_path = match cfg.resolved.files.get("decoder_dyn") {
            Some(dyn_path) if decoder_on_cpu => {
                static_export = false;
                dyn_path.as_path()
            }
            _ => decoder_path,
        };
        let encoder = build_session(file(&cfg.resolved, "encoder")?, enc_providers)?;
        let decoder = build_session(decoder_path, dec_providers)?;
        // One fixed encoder input shape on DirectML, but ONLY under the static decoder — a legacy /
        // dynamic-only decoder that still resolves runs the encoder at natural length (see
        // `encoder_pad_bucket` field docs). `static_export` here already reflects the dyn-decoder
        // override above (reset to false when `decoder_dyn` was picked for the CPU EP).
        // WINSTT_COHERE_NO_ENC_PAD disables it (diagnostics / A-B benchmarking).
        let encoder_pad_bucket = encoder_pad_bucket(
            enc_providers.first() == Some(&Accelerator::DirectMl),
            static_export,
            std::env::var("WINSTT_COHERE_NO_ENC_PAD").is_ok(),
        );

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
        // Optimized-export passthrough: any tensor the encoder OUTPUTS and the decoder takes as an
        // INPUT (by identical name) is computed once per utterance and reused every decode step. That
        // is the hoisted cross-KV (`cross_attn.*`) plus, for cross-bucket exports, the padded
        // cross-attention mask (`cross_bias`). A mismatched pair (decoder wants a passthrough the
        // encoder doesn't produce) would decode against garbage — fail loudly at load instead.
        let enc_out_names = filter_sorted_outputs(&encoder, "");
        let decoder_cross_inputs: Vec<String> = filter_sorted_inputs(&decoder, "")
            .into_iter()
            .filter(|n| n.starts_with("cross_attn.") || n == "cross_bias")
            .collect();
        for name in &decoder_cross_inputs {
            if !enc_out_names.contains(name) {
                return Err(SttError::SessionCreate(format!(
                    "cohere decoder expects passthrough input '{name}' but the encoder graph does not output it (mismatched export pair)"
                )));
            }
        }
        let encoder_cross_outputs = decoder_cross_inputs.clone();
        let (num_heads, head_dim, past_is_fp16) = cohere_past_shape(&decoder)?;
        // The KV-cache / encoder-output binding device follows the DECODER's placement: in the
        // DirectML hybrid the decoder runs on CPU, so the encoder's outputs (incl. hoisted cross-KV)
        // are bound to HOST memory — ORT copies them off-device once per utterance.
        let (device, device_id) = if decoder_on_cpu {
            (AllocationDevice::CPU, 0)
        } else {
            cohere_device(&cfg.providers)
        };

        Ok(CohereEngine {
            encoder,
            decoder,
            token_to_id,
            id_to_token,
            byte_fallback,
            past_input_names,
            present_output_names,
            encoder_cross_outputs,
            decoder_cross_inputs,
            static_kv_max: static_export.then_some(STATIC_MAX_KV),
            encoder_pad_bucket,
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
        // Remove the model's inline non-speech event tags (`<hesitation>`, …) — emitted as ordinary
        // text, so not caught by the per-token `is_special_token` skip above. Also trims.
        strip_inline_event_tags(&out)
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
        cross_kv: &BTreeMap<String, DynValue>,
        cpu_mem: &MemoryInfo,
        dev_mem: &MemoryInfo,
        prompt: Vec<i64>,
        max_tokens: usize,
    ) -> SttResult<(Vec<i64>, f32)> {
        let prompt_len = prompt.len();
        let present_names = self.present_output_names.clone();
        let cross_names = self.decoder_cross_inputs.clone();
        // present.N... → past index by NAME: the hoisted layout has 16 present outputs against 32
        // declared past inputs (the encoder entries stay declared for keep-alive sums), so the old
        // positional zip would misalign. Name mapping is exact for every layout.
        let past_index: BTreeMap<String, usize> = self
            .past_input_names
            .iter()
            .enumerate()
            .map(|(i, n)| (n.clone(), i))
            .collect();
        let mut past: Vec<Option<DynValue>> =
            (0..self.past_input_names.len()).map(|_| None).collect();
        let mut generated: Vec<i64> = Vec::new();
        let mut next_input: Vec<i64> = prompt.clone();
        let mut logprob_sum = 0.0f32;
        let mut logprob_n = 0usize;
        let decode_start = std::time::Instant::now();
        let mut step0_ms = 0f64;
        let mut steps_run = 0usize;

        // Static-KV graphs pin sequence_length = 1 (the fixed shape the DirectML EP fused at build),
        // so the PROMPT is fed one token per step — causally identical, since each token sees its
        // predecessors through the KV buffer. Sampling starts once the last prompt token is in.
        let token_wise = self.static_kv_max.is_some();
        let enc_dummy = Tensor::<f32>::from_array(ndarray::Array3::<f32>::zeros((
            1,
            1,
            self.num_heads * self.head_dim,
        )))
        .map_err(|e| SttError::Inference(format!("enc dummy: {e}")))?;
        let max_steps = if token_wise {
            (prompt_len - 1) + max_tokens
        } else {
            max_tokens
        };

        #[allow(clippy::needless_range_loop)] // `step` is a position index, not just a prompt index
        for step in 0..max_steps {
            let step_start = std::time::Instant::now();
            if token_wise {
                next_input = vec![if step < prompt_len {
                    prompt[step]
                } else {
                    *generated.last().unwrap_or(&self.eos_token_id)
                }];
            }
            let in_len = next_input.len();
            // Mask covers the prompt plus every token generated so far; from
            // step 1 on the single new token sits at position attn_len - 1.
            let attn_len = if token_wise {
                step + 1
            } else {
                prompt_len + step
            };
            // Static-KV exports have a hard buffer capacity — stop before overflowing it.
            if self.static_kv_max.is_some_and(|max| attn_len > max) {
                break;
            }
            // Whether this step's logits are a real sample (always, except prompt-priming steps).
            let sample = !token_wise || step + 1 >= prompt_len;
            let position_ids: Vec<i64> = if token_wise {
                vec![step as i64]
            } else if step == 0 {
                (0..in_len as i64).collect()
            } else {
                vec![(attn_len - 1) as i64]
            };
            // Host per-step scalars/masks (tiny): full prompt on step 0, then the single new token.
            // Static-KV: `attention_mask` is DEAD in the graph (replaced by `attn_bias`) but stays
            // declared — bind it at a CONSTANT (1, max) size, or its growing length alone would
            // change the input-shape signature and defeat the fixed-shape decode.
            let input_ids = tensor_i64((1, in_len), next_input.clone())?;
            let mask_len = self.static_kv_max.unwrap_or(attn_len);
            let attention_mask = tensor_i64((1, mask_len), vec![1i64; mask_len])?;
            let position = tensor_i64((1, position_ids.len()), position_ids)?;
            let num_logits_to_keep = scalar_i64(1)?;

            // Static-KV per-step masks (host, ~KBs): L = rows already written. The graph writes the
            // current `in_len` rows at [L, L+in_len) (`kv_write_mat` one-hot scatter + `kv_keep_mask`
            // zeroing those slots) and attends over the FULL max-length buffer with an additive
            // `attn_bias` that -infs every slot beyond row i's causal horizon. All shapes constant
            // across steps → one DML graph compile for the whole decode.
            let mut static_masks_f32: Vec<Tensor<f32>> = Vec::new();
            let mut static_masks_f16: Vec<Tensor<F16>> = Vec::new();
            if let Some(max) = self.static_kv_max {
                let l = attn_len - in_len;
                let neg = if self.past_is_fp16 {
                    -65504.0f32
                } else {
                    -3.402_823_5e38f32
                };
                let mut keep = vec![1.0f32; max];
                keep[l..attn_len].fill(0.0);
                let mut w = vec![0.0f32; max * in_len];
                for i in 0..in_len {
                    w[(l + i) * in_len + i] = 1.0;
                }
                let mut bias = vec![neg; in_len * max];
                for i in 0..in_len {
                    bias[i * max..i * max + l + i + 1].fill(0.0);
                }
                type MaskPart = (Vec<f32>, (usize, usize, usize, usize));
                let parts: [MaskPart; 3] = [
                    (keep, (1, 1, max, 1)),
                    (w, (1, 1, max, in_len)),
                    (bias, (1, 1, in_len, max)),
                ];
                for (data, dims) in parts {
                    if self.past_is_fp16 {
                        let arr = ndarray::Array4::<F16>::from_shape_vec(
                            dims,
                            data.into_iter().map(F16::from_f32).collect(),
                        )
                        .map_err(|e| SttError::Inference(format!("static mask f16: {e}")))?;
                        static_masks_f16.push(
                            Tensor::<F16>::from_array(arr)
                                .map_err(|e| SttError::Inference(format!("static mask: {e}")))?,
                        );
                    } else {
                        let arr = ndarray::Array4::<f32>::from_shape_vec(dims, data)
                            .map_err(|e| SttError::Inference(format!("static mask f32: {e}")))?;
                        static_masks_f32.push(
                            Tensor::<f32>::from_array(arr)
                                .map_err(|e| SttError::Inference(format!("static mask: {e}")))?,
                        );
                    }
                }
            }

            // Host tensors for every `None` past entry (step 0), dtype-matched to the decoder's
            // declared KV type (§6.5): EMPTY (1,H,0,D) for the legacy growing layout and the unused
            // `.encoder.` slots; ZEROED (1,H,MAX,D) for static-KV `.decoder.` slots (the masked
            // write reads the whole buffer — unwritten rows must be finite zeros so the -inf bias
            // rows softmax to exactly 0). Held in these Vecs so they outlive `run_binding`.
            let mut empties_f32: Vec<Tensor<f32>> = Vec::new();
            let mut empties_f16: Vec<Tensor<F16>> = Vec::new();
            for (i, p) in past.iter().enumerate() {
                if p.is_none() {
                    let seq = match self.static_kv_max {
                        Some(max) if self.past_input_names[i].contains(".decoder.") => max,
                        _ => 0,
                    };
                    let dims = (1usize, self.num_heads, seq, self.head_dim);
                    if self.past_is_fp16 {
                        let arr = ndarray::Array4::<F16>::from_elem(dims, F16::from_f32(0.0));
                        empties_f16.push(
                            Tensor::<F16>::from_array(arr)
                                .map_err(|e| SttError::Inference(format!("zero kv f16: {e}")))?,
                        );
                    } else {
                        let arr = ndarray::Array4::<f32>::zeros(dims);
                        empties_f32.push(
                            Tensor::<f32>::from_array(arr)
                                .map_err(|e| SttError::Inference(format!("zero kv f32: {e}")))?,
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
            // Static-KV graphs pin the (dead) `encoder_hidden_states` input to (1,1,H) — bind a
            // constant dummy; the real encoder output reaches the decoder via the cross-KV inputs.
            if self.static_kv_max.is_some() {
                binding
                    .bind_input("encoder_hidden_states", &enc_dummy)
                    .map_err(|e| SttError::Inference(format!("bind encoder_hidden_states: {e}")))?;
            } else {
                binding
                    .bind_input("encoder_hidden_states", encoder_out)
                    .map_err(|e| SttError::Inference(format!("bind encoder_hidden_states: {e}")))?;
            }
            // Static-KV layout: the three per-step mask inputs (order matches `parts` above).
            if self.static_kv_max.is_some() {
                for (j, name) in ["kv_keep_mask", "kv_write_mat", "attn_bias"]
                    .iter()
                    .enumerate()
                {
                    if self.past_is_fp16 {
                        binding
                            .bind_input(*name, &static_masks_f16[j])
                            .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                    } else {
                        binding
                            .bind_input(*name, &static_masks_f32[j])
                            .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                    }
                }
            }
            // Hoisted layout: the once-per-utterance cross-KV (device-resident encoder outputs).
            for name in &cross_names {
                let v = cross_kv.get(name).ok_or_else(|| {
                    SttError::Inference(format!("missing hoisted cross-KV value for {name}"))
                })?;
                binding
                    .bind_input(name.as_str(), v)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }
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

            let sampled: Option<(i64, f32)> = if sample {
                let logits = outputs.get("logits").ok_or_else(|| {
                    SttError::Inference("cohere decoder produced no logits".into())
                })?;
                let arr = out_to_f32(logits)?; // fp16 → f32 promote (§6.5)
                let last = last_step_row(&arr)?;
                let (idx, lp) = argmax_1d(&last); // lp is already a log-prob (log_softmax head)
                Some((idx as i64, lp))
            } else {
                None // prompt-priming step (token-wise) — logits are not a prediction target
            };
            steps_run += 1;
            if step == 0 {
                step0_ms = step_start.elapsed().as_secs_f64() * 1e3;
            }

            // Carry present.* → past.* as DEVICE values (session-owned, survive the binding drop →
            // rebind next step with no host copy). Matched by NAME (present sets can be a subset of
            // the declared past inputs — hoisted layout). Keep the prior value when a `present.*` is
            // 0-length (legacy reused cross-attn branch), so the resident encoder KV is never clobbered.
            for pname in present_names.iter() {
                if let Some(v) = outputs.remove(pname.as_str())
                    && kv_seq_len(&v) != 0
                    && let Some(&i) =
                        past_index.get(pname.replacen("present.", "past_key_values.", 1).as_str())
                {
                    past[i] = Some(v);
                }
            }

            if let Some((next, logprob)) = sampled {
                logprob_sum += logprob;
                logprob_n += 1;
                if next == self.eos_token_id {
                    break;
                }
                generated.push(next);
                if !token_wise {
                    next_input = vec![next];
                }
            }
        }

        let mean_logprob = if logprob_n > 0 {
            logprob_sum / logprob_n as f32
        } else {
            f32::NEG_INFINITY
        };
        if profile_enabled() && steps_run > 0 {
            let total_ms = decode_start.elapsed().as_secs_f64() * 1e3;
            let rest = (steps_run - 1).max(1) as f64;
            eprintln!(
                "[cohere-profile] decode: {steps_run} steps in {total_ms:.0}ms  (step0 {step0_ms:.1}ms, avg-rest {:.1}ms/tok)",
                (total_ms - step0_ms) / rest
            );
        }
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
        cross_kv: &BTreeMap<String, DynValue>,
        cpu_mem: &MemoryInfo,
        dev_mem: &MemoryInfo,
        candidates: &[String],
    ) -> SttResult<Option<String>> {
        const DETECT_TOKENS: usize = 24;
        let mut best: Option<(String, f32)> = None;
        for cand in candidates {
            let target = format!("<|{cand}|>");
            let prompt = self.build_prompt_tokens("<|unklang|>", &target, true)?;
            let (_, score) = self.decode(
                encoder_out,
                cross_kv,
                cpu_mem,
                dev_mem,
                prompt,
                DETECT_TOKENS,
            )?;
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
        let mel_start = std::time::Instant::now();
        // DirectML: zero-pad up to the fixed bucket so the encoder always runs its one cached
        // fused-graph shape (see `encoder_pad_bucket`). Longer audio keeps its natural length.
        let audio: std::borrow::Cow<'_, [f32]> = match self.encoder_pad_bucket {
            Some(bucket) if audio.len() < bucket => {
                let mut padded = Vec::with_capacity(bucket);
                padded.extend_from_slice(audio);
                padded.resize(bucket, 0.0);
                std::borrow::Cow::Owned(padded)
            }
            _ => std::borrow::Cow::Borrowed(audio),
        };
        let audio = audio.as_ref();
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let mel_ms = mel_start.elapsed().as_secs_f64() * 1e3;
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

        let enc_start = std::time::Instant::now();
        let (encoder_out, cross_kv): (DynValue, BTreeMap<String, DynValue>) = {
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
            // Hoisted layout: the encoder also emits the 16 cross-attention K/V tensors — bound to
            // the EP device once and reused (read-only) by every decode step of this utterance.
            for name in &self.encoder_cross_outputs {
                binding
                    .bind_output_to_device(name.as_str(), &dev_mem)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }
            let mut out = self
                .encoder
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("cohere encoder run_binding: {e}")))?;
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("cohere encoder sync: {e}")))?;
            let hidden = out.remove("last_hidden_state").ok_or_else(|| {
                SttError::Inference("cohere encoder produced no last_hidden_state".into())
            })?;
            let mut cross = BTreeMap::new();
            for name in &self.encoder_cross_outputs {
                let v = out.remove(name.as_str()).ok_or_else(|| {
                    SttError::Inference(format!("cohere encoder produced no {name}"))
                })?;
                cross.insert(name.clone(), v);
            }
            (hidden, cross)
        };
        if profile_enabled() {
            eprintln!(
                "[cohere-profile] mel {mel_ms:.0}ms ({t} frames) · encoder {:.0}ms (cross-kv outputs: {})",
                enc_start.elapsed().as_secs_f64() * 1e3,
                cross_kv.len()
            );
        }

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
                    self.detect_language(&encoder_out, &cross_kv, &cpu_mem, &dev_mem, &cands)?
                } else {
                    None
                }
            }
        };

        let prompt = self.build_prompt(language.as_deref(), true)?;
        let (generated, _) = self.decode(
            &encoder_out,
            &cross_kv,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_bucket_requires_dml_static_and_no_escape_hatch() {
        // Canonical shipped case: encoder on DirectML, static decoder loaded, escape hatch unset.
        assert_eq!(
            encoder_pad_bucket(true, true, false),
            Some(ENC_PAD_BUCKET_SAMPLES)
        );
    }

    #[test]
    fn pad_bucket_off_for_legacy_or_dynamic_decoder() {
        // A legacy / dynamic-only decoder still resolves (optional `decoder_dyn`, permissive `decoder`
        // glob) — even with the encoder on DirectML the pad is withheld: only the static export pair
        // is a verified-benign target for trailing zero-pad.
        assert_eq!(encoder_pad_bucket(true, false, false), None);
    }

    #[test]
    fn pad_bucket_off_when_encoder_not_on_dml() {
        // CPU / CUDA encoders have no per-shape re-fuse tax, so padding would only add compute.
        assert_eq!(encoder_pad_bucket(false, true, false), None);
    }

    #[test]
    fn pad_bucket_escape_hatch_disables_it() {
        // WINSTT_COHERE_NO_ENC_PAD forces natural length even on the static DirectML path.
        assert_eq!(encoder_pad_bucket(true, true, true), None);
    }

    #[test]
    fn cohere_device_follows_primary_provider() {
        assert_eq!(
            cohere_device(&[Accelerator::Cuda]),
            (AllocationDevice::CUDA, 0)
        );
        assert_eq!(
            cohere_device(&[Accelerator::DirectMl]),
            (AllocationDevice::DIRECTML, 0)
        );
        assert_eq!(
            cohere_device(&[Accelerator::Cpu]),
            (AllocationDevice::CPU, 0)
        );
        // No providers → CPU (the safe default for the KV-cache binding device).
        assert_eq!(cohere_device(&[]), (AllocationDevice::CPU, 0));
    }
}
