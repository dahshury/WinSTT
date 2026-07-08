// Canary AED (NeMo encoder/decoder with the `decoder_mems` loop).
//
// Static 10-token control prompt; encoder → (encoder_embeddings, encoder_mask); decoder runs with
// growing `decoder_mems` (full input when mems.shape[2]==0 else last-token-only). Stop on all-EOS
// or max_sequence_length=1024. <|...|> stripped on decode. `<|startofcontext|>` is UNTRAINED → no
// prompt injection (enforced by EngineKind::supports_initial_prompt()==false upstream).

use std::collections::BTreeMap;

use ndarray::Array2;
use ort::memory::{AllocationDevice, Allocator, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::value::{DynValue, Tensor, TensorRef};

use super::*;
use crate::winstt::stt::Accelerator;

/// The `AllocationDevice` (+ id) the sessions run on, for binding the carried `decoder_mems`
/// resident on it (mirrors `whisper::device_for_providers` / onnx-asr `get_onnx_device`). Derived
/// from the FIRST requested accelerator: DirectML/CUDA → that device; everything else (incl.
/// Rocm/CoreML/OpenVINO, which route to a CPU fallback) → CPU, where IoBinding just binds host
/// memory (still correct, ~same speed as the old host-clone path).
fn canary_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        _ => (AllocationDevice::CPU, 0),
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
    /// Device the sessions run on, for binding the carried `decoder_mems` device-resident
    /// (mirrors `whisper::device`). `CPU` when no GPU EP is active; then IoBinding simply binds
    /// host memory (still correct, ~same speed as the old host-clone path).
    device: AllocationDevice,
    device_id: i32,
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

pub(in crate::winstt::stt::families) fn canary_prompt_tokens(
    base: &[i64],
    token_to_id: &BTreeMap<String, i64>,
    opts: &TranscribeOptions,
) -> Vec<i64> {
    let mut toks = base.to_vec();
    if toks.len() < 6 {
        return toks;
    }
    if let Some(lang) = canary_configured_language(opts)
        && let Some(&id) = token_to_id.get(&format!("<|{lang}|>"))
    {
        toks[4] = id;
        toks[5] = id;
    }
    if opts.translate
        && let Some(&id) = token_to_id.get("<|en|>")
    {
        toks[5] = id;
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

        let (device, device_id) = canary_device(&cfg.providers);
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
            device,
            device_id,
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

        // Greedy AED decode with the NeMo `decoder_mems` cache carried DEVICE-RESIDENT via ort's
        // IoBinding (mirrors whisper.rs's KV-cache loop). The decoder returns `decoder_hidden_states`,
        // which becomes the NEXT step's `decoder_mems` input — bound straight back on the device with
        // NO host clone (the old path `out_to_f32`'d it every step and re-fed the host array). Port of
        // nemo.py `NemoConformerAED._decode`/`_decoding`. input_ids = full prompt while the mems are
        // empty (shape[2]==0, i.e. step 0), then only the last token. EOS breaks BEFORE it's appended.
        // (The prior code re-fed zero mems every step → no context after token 0 → output "And".)
        let enc_shape = encoder_embeddings.shape().to_vec();
        let mask_shape = encoder_mask.shape().to_vec();
        // Initial decoder_mems shape (num_layers, 1, 0, hidden) — dms_shape declares mem_len(dim 2)=0.
        let empty_mems_shape = dms_shape(&self.decoder);
        // Device `MemoryInfo` for the resident carried mems; logits come back to host for argmax.
        // Both are CPU when no GPU EP, so this path is correct + ~free on CPU too.
        let dev_mem = MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("canary device mem info: {e}")))?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("canary cpu mem info: {e}")))?;
        // Every graph output must be bound. `logits` → host (argmax); the rest (incl.
        // `decoder_hidden_states`, which we carry) → device. Names introspected once (no per-step alloc).
        let non_logits_outputs: Vec<String> = self
            .decoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n != "logits")
            .collect();

        // Carried mems as a DEVICE-resident value; `None` = the (layers,1,0,hidden) empty step-0 mems.
        let mut decoder_mems: Option<DynValue> = None;

        while batch_tokens.len() < self.max_sequence_length {
            // Step 0 (empty mems) feeds the full prompt; cached steps feed only the last token.
            let (input_len, input_ids_data): (usize, Vec<i64>) = if decoder_mems.is_none() {
                (batch_tokens.len(), batch_tokens.clone())
            } else {
                let last = batch_tokens.last().copied().ok_or_else(|| {
                    SttError::Inference("canary decoder token history is empty".into())
                })?;
                (1, vec![last])
            };
            let input_ids = tensor_i64((1, input_len), input_ids_data)?;

            // Zero-copy: BORROW the static encoder outputs as TensorRefs rather than re-cloning them
            // onto the host EVERY token (they are UNCHANGING across the decode). The borrows live only
            // inside `binding` / `run_binding`, released when the binding is dropped below.
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
            // Step-0 empty mems: (layers,1,0,hidden). `Tensor::from_array`'s raw-data path rejects
            // 0-sized dims, so use the allocator-backed ctor (same gotcha as whisper.rs's empty KV).
            // Held here so it outlives the binding through `run_binding`.
            let empty_mems = if decoder_mems.is_none() {
                Some(
                    Tensor::<f32>::new(&Allocator::default(), empty_mems_shape.as_slice())
                        .map_err(|e| SttError::Inference(format!("canary empty mems: {e}")))?,
                )
            } else {
                None
            };

            // Fresh binding per step (mirrors whisper.rs / onnx-asr's per-`_decode` `io_binding()`):
            // bind the changing input_ids + the borrowed encoder outputs + the device-resident (or
            // empty step-0) mems; bind logits to host and every other output (incl.
            // decoder_hidden_states) to the device so the mems never round-trip through the CPU.
            let mut binding = self
                .decoder
                .create_binding()
                .map_err(|e| SttError::Inference(format!("canary decoder binding: {e}")))?;
            binding
                .bind_input("input_ids", &input_ids)
                .map_err(|e| SttError::Inference(format!("bind input_ids: {e}")))?;
            binding
                .bind_input("encoder_embeddings", &enc_emb)
                .map_err(|e| SttError::Inference(format!("bind encoder_embeddings: {e}")))?;
            binding
                .bind_input("encoder_mask", &enc_mask)
                .map_err(|e| SttError::Inference(format!("bind encoder_mask: {e}")))?;
            match (&decoder_mems, &empty_mems) {
                (Some(v), _) => binding
                    .bind_input("decoder_mems", v)
                    .map_err(|e| SttError::Inference(format!("bind decoder_mems: {e}")))?,
                (None, Some(t)) => binding
                    .bind_input("decoder_mems", t)
                    .map_err(|e| SttError::Inference(format!("bind empty decoder_mems: {e}")))?,
                (None, None) => {
                    return Err(SttError::Inference(
                        "canary: missing empty decoder_mems tensor".into(),
                    ));
                }
            }
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
            for name in &non_logits_outputs {
                binding
                    .bind_output_to_device(name.as_str(), &dev_mem)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }

            let mut outputs = self
                .decoder
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("canary decoder run_binding: {e}")))?;
            // DML/CUDA run_binding is async w.r.t. the device stream. Block until logits are written
            // (host read below) and the carried decoder_hidden_states is complete on-device before we
            // rebind it next step (else host read + device carry race the still-running kernels). No-op
            // on CPU; matches onnx-asr's implicit per-step sync (`.numpy()` on logits).
            binding
                .synchronize_outputs()
                .map_err(|e| SttError::Inference(format!("canary synchronize: {e}")))?;

            // logits → host argmax. Scoped so the borrow of `outputs` ends before the `remove` below.
            let next: i64 = {
                let logits = out_to_f32(
                    outputs
                        .get("logits")
                        .ok_or_else(|| SttError::Inference("canary produced no logits".into()))?,
                )?;
                let last = last_step_row(&logits)?;
                argmax_1d(&last).0 as i64
            };
            if next == self.eos_token_id {
                break;
            }
            batch_tokens.push(next);

            // Carry decoder_hidden_states (device) → next step's decoder_mems input. The extracted
            // value is session-owned and survives the binding drop, so it rebinds next step with no
            // host round-trip. Take it BEFORE dropping `outputs`.
            decoder_mems = Some(outputs.remove("decoder_hidden_states").ok_or_else(|| {
                SttError::Inference("canary produced no decoder_hidden_states".into())
            })?);
            drop(outputs);
            drop(binding);
        }

        // Decode: strip <|...|> tokens.
        let out_tokens = &batch_tokens[prefix_len..];
        let mut text = String::new();
        for &tid in out_tokens {
            if let Some(sym) = self.vocab.get(tid)
                && !sym.starts_with("<|")
            {
                text.push_str(sym);
            }
        }
        let text = join_and_normalize(&[text.as_str()], false);
        Ok(Transcription {
            text,
            ..Default::default()
        })
    }
}
