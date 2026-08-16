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

/// Empty step-0 self-KV shape `(1, heads, 0, head_dim)` from the KV decoder's `self_k_0`
/// input metadata (past-len dim 2 is dynamic → 0).
fn self_kv_empty_shape(decoder: &Session) -> Vec<usize> {
    if let Some(inp) = decoder.inputs().iter().find(|i| i.name() == "self_k_0")
        && let Some(shape) = inp.dtype().tensor_shape()
        && shape.len() == 4
    {
        let d = |i: usize, def: usize| {
            shape
                .get(i)
                .copied()
                .filter(|&d| d > 0)
                .map_or(def, |d| d as usize)
        };
        return vec![1, d(1, 8), 0, d(3, 128)];
    }
    vec![1, 8, 0, 128]
}

pub struct CanaryEngine {
    encoder: Session,
    /// Legacy `decoder_mems` decoder — only loaded when the KV artifacts are absent.
    decoder: Option<Session>,
    /// KV fast path (re-exported artifacts; both CPU-pinned): `cross-kv-model.onnx` projects the
    /// encoder output through every decoder layer's cross-attn key/value nets ONCE per utterance,
    /// and `decoder-kv-model.onnx` carries a REAL self-attn K/V cache. Together they remove the
    /// per-token re-projection of cross-KV over the whole encoder sequence (~85% of legacy decode
    /// FLOPs, scaling with clip length: 9.4 ms/tok @5.7s → 40 ms/tok @66s) — the same disease the
    /// cohere hoist fixed. `None` (older cached artifact sets) → legacy `decoder_mems` loop.
    cross_kv: Option<Session>,
    decoder_kv: Option<Session>,
    vocab: Vocab,
    token_to_id: BTreeMap<String, i64>,
    transcribe_input: Vec<i64>,
    eos_token_id: i64,
    max_sequence_length: usize,
    mel_fb: Array2<f32>,
    /// DirectML encoder pad-bucket in FEATURE FRAMES (the cohere lesson, ported): the DML EP
    /// caches its fused graph for exactly ONE input-shape signature per session (first-compiled
    /// wins), and real dictation has a new length every utterance — so an unpadded encoder pays a
    /// re-fuse (~0.7 s class) EVERY decode. Padding the (post-normalization) log-mel to one fixed
    /// T gives the EP a single shape. Unlike cohere, canary's encoder takes a true `length` input
    /// and emits `encoder_mask`, so we feed the TRUE length and afterwards SLICE the encoder
    /// output back to the valid frames — the CPU decoder sees natural length (no per-token
    /// cross-attn cost on pad frames) and transcripts stay exact. `None` off DirectML (no
    /// per-shape re-fuse there — padding would only add compute) or under
    /// `WINSTT_CANARY_NO_ENC_PAD`.
    encoder_pad_bucket: Option<usize>,
    model_name: String,
    providers: Vec<String>,
    /// Device the sessions run on, for binding the carried `decoder_mems` device-resident
    /// (mirrors `whisper::device`). `CPU` when no GPU EP is active; then IoBinding simply binds
    /// host memory (still correct, ~same speed as the old host-clone path).
    device: AllocationDevice,
    device_id: i32,
}

/// Encoder pad-bucket length in feature frames: 28 s (`EngineKind::max_chunk_seconds` for
/// NemoAed — the VAD segmenter caps every chunk there, so every segment the app can produce
/// lands in the one cached encoder shape) at the NeMo 10 ms hop.
const CANARY_ENC_PAD_BUCKET_FRAMES: usize = 28 * 16_000 / 160;

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
    if opts.translate {
        // The target-language slot (position 5) selects what Canary emits. A
        // configured target renders any→any among its languages; absent/blank
        // falls back to English (the legacy translate-to-English behavior).
        let target = opts
            .translate_target_language
            .as_deref()
            .and_then(canary_concrete_language)
            .unwrap_or("en");
        if let Some(&id) = token_to_id.get(&format!("<|{target}|>")) {
            toks[5] = id;
        }
    }
    toks
}

impl CanaryEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<CanaryEngine> {
        // DirectML HYBRID (mirrors CohereEngine): the AED decoder is autoregressive with a GROWING
        // `decoder_mems` KV cache, so every token is a new shape and the DML EP RE-FUSES the decoder
        // graph per step (~tens of ms/token) — that recompile tax dwarfs the GPU's per-token savings,
        // so a short/medium clip is SLOWER on DML than CPU (15 s clip, 180m: 1.6 s DML vs 0.9 s CPU).
        // The heavy, single-shot CONFORMER ENCODER wins on DML (66 s clip: 3.95 s vs 8.05 s). So run
        // the encoder on the GPU EP and the decoder on CPU. The encoder's outputs are already pulled
        // to host (`out_to_f32`/`out_to_i64` below), so the CPU decoder consumes them with no extra
        // copy. `WINSTT_CANARY_DECODER_DML` forces the decoder back onto the GPU (benchmark escape);
        // `WINSTT_CANARY_ENCODER_CPU` pins the encoder to CPU (isolation).
        let cpu_only = [Accelerator::Cpu];
        let dml_primary = cfg.providers.first() == Some(&Accelerator::DirectMl);
        let enc_providers: &[Accelerator] = if std::env::var("WINSTT_CANARY_ENCODER_CPU").is_ok() {
            &cpu_only
        } else {
            &cfg.providers
        };
        let dec_providers: &[Accelerator] =
            if dml_primary && std::env::var("WINSTT_CANARY_DECODER_DML").is_err() {
                &cpu_only
            } else {
                &cfg.providers
            };
        let decoder_on_cpu = dec_providers.first() == Some(&Accelerator::Cpu);
        let encoder = build_session(file(&cfg.resolved, "encoder")?, enc_providers)?;
        // KV fast path when the re-exported artifacts resolved (optional globs). Both CPU: the
        // step decoder's growing self-KV would re-fuse per token on DML, and cross-kv runs once
        // per utterance over a different enc length each time (same re-fusion trap). The heavy
        // conformer encoder stays on the GPU EP above. WINSTT_CANARY_LEGACY_DECODE forces the
        // old decoder_mems loop (benchmark escape). The legacy decoder session is only built when
        // the KV path is absent — loading both would waste ~1.2 GB RAM on the 1B models.
        let (cross_kv, decoder_kv) = match (
            cfg.resolved.files.get("cross_kv"),
            cfg.resolved.files.get("decoder_kv"),
        ) {
            (Some(ck), Some(dk)) if std::env::var("WINSTT_CANARY_LEGACY_DECODE").is_err() => (
                Some(build_session(ck.as_path(), &cpu_only)?),
                Some(build_session(dk.as_path(), &cpu_only)?),
            ),
            _ => (None, None),
        };
        let decoder = if decoder_kv.is_some() {
            None
        } else {
            Some(build_session(
                file(&cfg.resolved, "decoder")?,
                dec_providers,
            )?)
        };
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

        // The decoder's io-binding device follows the DECODER's placement: in the DML hybrid the
        // decoder runs on CPU, so `decoder_mems` + carried outputs are bound to HOST memory.
        let (device, device_id) = if decoder_on_cpu {
            (AllocationDevice::CPU, 0)
        } else {
            canary_device(&cfg.providers)
        };
        // One fixed encoder input shape on DirectML (see the field docs).
        // WINSTT_CANARY_NO_ENC_PAD disables it (diagnostics / A-B benchmarking).
        let encoder_pad_bucket = (enc_providers.first() == Some(&Accelerator::DirectMl)
            && std::env::var("WINSTT_CANARY_NO_ENC_PAD").is_err())
        .then_some(CANARY_ENC_PAD_BUCKET_FRAMES);
        Ok(CanaryEngine {
            encoder,
            decoder,
            cross_kv,
            decoder_kv,
            vocab,
            token_to_id,
            transcribe_input,
            eos_token_id,
            max_sequence_length: 1024,
            mel_fb,
            encoder_pad_bucket,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
            device,
            device_id,
        })
    }

    /// Legacy `decoder_mems` greedy loop (istupakov artifact set): the cache holds hidden states,
    /// so every step re-projects self-KV over the history and cross-KV over the whole encoder
    /// output -- per-token cost grows with clip length. Kept for older cached artifact sets and as
    /// the WINSTT_CANARY_LEGACY_DECODE benchmark escape.
    fn decode_legacy(
        &mut self,
        encoder_embeddings: &ndarray::ArrayD<f32>,
        encoder_mask: &ndarray::ArrayD<i64>,
        prompt: Vec<i64>,
    ) -> SttResult<Vec<i64>> {
        // Greedy AED decode with the NeMo `decoder_mems` cache carried DEVICE-RESIDENT via ort's
        // IoBinding (mirrors whisper.rs's KV-cache loop). The decoder returns `decoder_hidden_states`,
        // which becomes the NEXT step's `decoder_mems` input — bound straight back on the device with
        // NO host clone (the old path `out_to_f32`'d it every step and re-fed the host array). Port of
        // nemo.py `NemoConformerAED._decode`/`_decoding`. input_ids = full prompt while the mems are
        // empty (shape[2]==0, i.e. step 0), then only the last token. EOS breaks BEFORE it's appended.
        // (The prior code re-fed zero mems every step → no context after token 0 → output "And".)
        let mut batch_tokens: Vec<i64> = prompt;
        let prompt_len = batch_tokens.len();
        let decoder = self.decoder.as_mut().ok_or_else(|| {
            SttError::Inference("canary legacy decoder session not loaded".into())
        })?;
        let enc_shape = encoder_embeddings.shape().to_vec();
        let mask_shape = encoder_mask.shape().to_vec();
        // Initial decoder_mems shape (num_layers, 1, 0, hidden) — dms_shape declares mem_len(dim 2)=0.
        let empty_mems_shape = dms_shape(decoder);
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
        let non_logits_outputs: Vec<String> = decoder
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
            let mut binding = decoder
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

            let mut outputs = decoder
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
            // Phrase-loop guard (shared with the other maskless AED decodes): keep one occurrence
            // of a verbatim-repeated cycle and stop — see `phrase_loop_truncation`.
            if let Some(keep) = phrase_loop_truncation(&batch_tokens[prompt_len..]) {
                batch_tokens.truncate(prompt_len + keep);
                break;
            }

            // Carry decoder_hidden_states (device) → next step's decoder_mems input. The extracted
            // value is session-owned and survives the binding drop, so it rebinds next step with no
            // host round-trip. Take it BEFORE dropping `outputs`.
            decoder_mems = Some(outputs.remove("decoder_hidden_states").ok_or_else(|| {
                SttError::Inference("canary produced no decoder_hidden_states".into())
            })?);
            drop(outputs);
            drop(binding);
        }
        Ok(batch_tokens)
    }

    /// KV fast path: run `cross-kv-model.onnx` once (per-layer cross-attn K/V of the encoder
    /// output), then step `decoder-kv-model.onnx` carrying a REAL self-attn K/V cache. Per-token
    /// cost is O(d^2), constant with clip length (the legacy loop is O(enc_len*d^2 + past*d^2)).
    /// All K/V tensors are PER-LAYER inputs/outputs (`self_k_0`, `cross_v_2`, ...): a stacked
    /// (L,...) layout made the graph Gather/slice per layer per token, which ORT materializes as
    /// a ~27 MB copy each step on long clips (measured +7.5 ms/tok @66s). Everything here is CPU
    /// (see `load`); logits are read back for the greedy argmax exactly like the legacy loop.
    fn decode_kv(
        &mut self,
        encoder_embeddings: &ndarray::ArrayD<f32>,
        encoder_mask: &ndarray::ArrayD<i64>,
        prompt: Vec<i64>,
    ) -> SttResult<Vec<i64>> {
        let profile = std::env::var("WINSTT_CANARY_PROFILE").is_ok();
        let t0 = std::time::Instant::now();
        let mut batch_tokens: Vec<i64> = prompt;
        let prompt_len = batch_tokens.len();

        // Cross-KV hoist: once per utterance, pulled to caller-owned host arrays and re-bound as
        // zero-copy TensorRef views every step.
        let enc_shape = encoder_embeddings.shape().to_vec();
        let mask_shape = encoder_mask.shape().to_vec();
        let layers = self.decoder_kv.as_ref().map_or(0, |d| {
            d.inputs()
                .iter()
                .filter(|i| i.name().starts_with("self_k_"))
                .count()
        });
        if layers == 0 {
            return Err(SttError::Inference(
                "canary kv decoder has no self_k_* inputs".into(),
            ));
        }
        let cross_names: Vec<String> = (0..layers)
            .flat_map(|i| [format!("cross_k_{i}"), format!("cross_v_{i}")])
            .collect();
        let cross: Vec<ndarray::ArrayD<f32>> =
            {
                let sess = self
                    .cross_kv
                    .as_mut()
                    .ok_or_else(|| SttError::Inference("canary kv path without cross_kv".into()))?;
                let emb = TensorRef::from_array_view((
                    enc_shape.as_slice(),
                    encoder_embeddings.as_slice().ok_or_else(|| {
                        SttError::Inference("encoder_embeddings not contiguous".into())
                    })?,
                ))
                .map_err(|e| SttError::Inference(format!("canary cross_kv emb view: {e}")))?;
                let out = sess
                    .run(ort::inputs!["encoder_embeddings" => emb])
                    .map_err(|e| SttError::Inference(format!("canary cross_kv run: {e}")))?;
                cross_names
                    .iter()
                    .map(|n| {
                        out_to_f32(out.get(n.as_str()).ok_or_else(|| {
                            SttError::Inference(format!("cross_kv produced no {n}"))
                        })?)
                    })
                    .collect::<SttResult<Vec<_>>>()?
            };
        let t_cross = t0.elapsed();

        // Empty step-0 self-KV (1, H, 0, hd) from the decoder's `self_k_0` input metadata.
        let empty_kv_shape = self_kv_empty_shape(
            self.decoder_kv
                .as_ref()
                .ok_or_else(|| SttError::Inference("canary kv path without decoder_kv".into()))?,
        );
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("canary cpu mem info: {e}")))?;
        let self_names: Vec<String> = (0..layers)
            .flat_map(|i| [format!("self_k_{i}"), format!("self_v_{i}")])
            .collect();
        let out_names: Vec<String> = (0..layers)
            .flat_map(|i| [format!("self_k_out_{i}"), format!("self_v_out_{i}")])
            .collect();

        // Carried per-layer self-KV, aligned with `self_names` / `out_names` order.
        let mut self_kv: Option<Vec<DynValue>> = None;
        let mut step0_ms = 0f64;
        let mut run_ms = 0f64;
        let mut steps = 0usize;
        while batch_tokens.len() < self.max_sequence_length {
            let t_step = std::time::Instant::now();
            // Step 0 (empty cache) feeds the full prompt; cached steps feed only the last token.
            let (input_len, input_ids_data): (usize, Vec<i64>) = if self_kv.is_none() {
                (batch_tokens.len(), batch_tokens.clone())
            } else {
                let last = batch_tokens.last().copied().ok_or_else(|| {
                    SttError::Inference("canary decoder token history is empty".into())
                })?;
                (1, vec![last])
            };
            let input_ids = tensor_i64((1, input_len), input_ids_data)?;
            let enc_mask = TensorRef::from_array_view((
                mask_shape.as_slice(),
                encoder_mask
                    .as_slice()
                    .ok_or_else(|| SttError::Inference("encoder_mask not contiguous".into()))?,
            ))
            .map_err(|e| SttError::Inference(format!("canary enc_mask view: {e}")))?;
            // 0-sized dims need the allocator-backed ctor (same gotcha as the legacy empty mems).
            let empty_kv: Option<Vec<Tensor<f32>>> = if self_kv.is_none() {
                let mut v = Vec::with_capacity(2 * layers);
                for _ in 0..2 * layers {
                    v.push(
                        Tensor::<f32>::new(&Allocator::default(), empty_kv_shape.as_slice())
                            .map_err(|e| {
                                SttError::Inference(format!("canary empty self kv: {e}"))
                            })?,
                    );
                }
                Some(v)
            } else {
                None
            };
            let cross_refs: Vec<TensorRef<'_, f32>> = cross
                .iter()
                .map(|a| {
                    TensorRef::from_array_view((
                        a.shape(),
                        a.as_slice()
                            .ok_or_else(|| SttError::Inference("cross kv not contiguous".into()))?,
                    ))
                    .map_err(|e| SttError::Inference(format!("cross kv view: {e}")))
                })
                .collect::<SttResult<Vec<_>>>()?;

            let decoder = self
                .decoder_kv
                .as_mut()
                .ok_or_else(|| SttError::Inference("canary kv path without decoder_kv".into()))?;
            let mut binding = decoder
                .create_binding()
                .map_err(|e| SttError::Inference(format!("canary kv binding: {e}")))?;
            binding
                .bind_input("input_ids", &input_ids)
                .map_err(|e| SttError::Inference(format!("bind input_ids: {e}")))?;
            binding
                .bind_input("encoder_mask", &enc_mask)
                .map_err(|e| SttError::Inference(format!("bind encoder_mask: {e}")))?;
            for (name, val) in cross_names.iter().zip(&cross_refs) {
                binding
                    .bind_input(name.as_str(), val)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }
            match (&self_kv, &empty_kv) {
                (Some(vals), _) => {
                    for (name, val) in self_names.iter().zip(vals) {
                        binding
                            .bind_input(name.as_str(), val)
                            .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                    }
                }
                (None, Some(vals)) => {
                    for (name, val) in self_names.iter().zip(vals) {
                        binding
                            .bind_input(name.as_str(), val)
                            .map_err(|e| SttError::Inference(format!("bind empty {name}: {e}")))?;
                    }
                }
                (None, None) => {
                    return Err(SttError::Inference(
                        "canary: missing empty self-KV tensors".into(),
                    ));
                }
            }
            binding
                .bind_output_to_device("logits", &cpu_mem)
                .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
            for name in &out_names {
                binding
                    .bind_output_to_device(name.as_str(), &cpu_mem)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
            }

            let t_run = std::time::Instant::now();
            let mut outputs = decoder
                .run_binding(&binding)
                .map_err(|e| SttError::Inference(format!("canary kv run_binding: {e}")))?;
            if steps == 0 {
                step0_ms = t_step.elapsed().as_secs_f64() * 1000.0;
            } else {
                run_ms += t_run.elapsed().as_secs_f64() * 1000.0;
            }
            steps += 1;

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
            // Phrase-loop guard (shared with the other maskless AED decodes): keep one occurrence
            // of a verbatim-repeated cycle and stop — see `phrase_loop_truncation`.
            if let Some(keep) = phrase_loop_truncation(&batch_tokens[prompt_len..]) {
                batch_tokens.truncate(prompt_len + keep);
                break;
            }

            let mut carried = Vec::with_capacity(2 * layers);
            for name in &out_names {
                carried.push(
                    outputs
                        .remove(name.as_str())
                        .ok_or_else(|| SttError::Inference(format!("canary produced no {name}")))?,
                );
            }
            self_kv = Some(carried);
        }
        if profile && steps > 1 {
            eprintln!(
                "[canary-kv] cross_kv={:.1}ms step0={:.1}ms run-only avg={:.2}ms/tok over {} steps, loop total={:.1}ms",
                t_cross.as_secs_f64() * 1000.0,
                step0_ms,
                run_ms / (steps - 1) as f64,
                steps - 1,
                t0.elapsed().as_secs_f64() * 1000.0,
            );
        }
        Ok(batch_tokens)
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
        // WINSTT_CANARY_PROFILE=1 → per-stage timings on stderr (mirrors WINSTT_WHISPER_PROFILE).
        let profile = std::env::var("WINSTT_CANARY_PROFILE").is_ok();
        let t_start = std::time::Instant::now();
        // Encode (audio_signal=(1,feat,T), length=[T]) → (encoder_embeddings, encoder_mask).
        // NeMo 128-mel featurizer (per-feature normalized) — NOT the 80-mel kaldi fbank.
        let fbank = frontend::nemo_features(audio, &self.mel_fb);
        let t_feat = t_start.elapsed();
        let t = fbank.nrows();
        if t == 0 {
            return Ok(Transcription::default());
        }
        let feat_dim = fbank.ncols();
        // DirectML pad-bucket: right-pad the (post-normalization) log-mel with zeros to the ONE
        // fixed T the EP's fused graph is cached for, feeding the TRUE length so the encoder's
        // internal masks exclude the pad. Padding must happen AFTER `nemo_features`' per-feature
        // normalization — silence samples padded before it would skew the utterance statistics
        // and change the valid frames. Clips longer than the bucket run at natural length
        // (re-fuse, same as before the bucket existed).
        let feed_rows = match self.encoder_pad_bucket {
            Some(bucket) if t <= bucket => bucket,
            _ => t,
        };
        let fbank = if feed_rows > t {
            let mut padded = Array2::<f32>::zeros((feed_rows, feat_dim));
            padded.slice_mut(ndarray::s![..t, ..]).assign(&fbank.view());
            padded
        } else {
            fbank
        };
        // `.t()` is an F-order view; force a C-contiguous owned copy before reshaping
        // (into_shape_with_order rejects the transposed layout — was "incompatible memory layout").
        let x = fbank
            .t()
            .as_standard_layout()
            .into_owned()
            .into_shape_with_order((1, feat_dim, feed_rows))
            .map_err(|e| SttError::Inference(format!("canary enc reshape: {e}")))?;
        let x_tensor = Tensor::from_array(x)
            .map_err(|e| SttError::Inference(format!("canary enc tensor: {e}")))?;
        let len_tensor = tensor_i64_1d(vec![t as i64])?;

        let enc_out = self
            .encoder
            .run(ort::inputs![ "audio_signal" => x_tensor, "length" => len_tensor ])
            .map_err(|e| SttError::Inference(format!("canary encoder run: {e}")))?;
        let mut encoder_embeddings = out_to_f32(&enc_out["encoder_embeddings"])?;
        let mut encoder_mask = out_to_i64(&enc_out["encoder_mask"])?;
        drop(enc_out); // release &mut self.encoder (SessionOutputs holds it via Drop) before &self use
        // Slice a padded encoder output back to the VALID frames (mask-counted) so the decoder
        // sees natural length — zero per-token cross-attn cost on pad frames, exact transcripts.
        if feed_rows > t {
            let s_valid = encoder_mask.iter().filter(|&&v| v != 0).count();
            let sliced_emb = {
                let emb3 = encoder_embeddings
                    .view()
                    .into_dimensionality::<ndarray::Ix3>()
                    .map_err(|e| SttError::Inference(format!("canary enc emb dim: {e}")))?;
                (s_valid > 0 && s_valid < emb3.shape()[1]).then(|| {
                    emb3.slice(ndarray::s![.., ..s_valid, ..])
                        .to_owned()
                        .into_dyn()
                })
            };
            if let Some(emb) = sliced_emb {
                encoder_embeddings = emb;
                let sliced_mask = {
                    let mask2 = encoder_mask
                        .view()
                        .into_dimensionality::<ndarray::Ix2>()
                        .map_err(|e| SttError::Inference(format!("canary enc mask dim: {e}")))?;
                    mask2
                        .slice(ndarray::s![.., ..s_valid])
                        .to_owned()
                        .into_dyn()
                };
                encoder_mask = sliced_mask;
            }
        }
        let t_enc = t_start.elapsed();

        let prompt = self.prompt_for(opts);
        let prefix_len = prompt.len();
        let batch_tokens = if self.decoder_kv.is_some() {
            self.decode_kv(&encoder_embeddings, &encoder_mask, prompt)?
        } else {
            self.decode_legacy(&encoder_embeddings, &encoder_mask, prompt)?
        };

        if profile {
            let n_tok = batch_tokens.len() - prefix_len;
            let t_dec = t_start.elapsed() - t_enc;
            eprintln!(
                "[canary-profile] feat={:.1}ms enc={:.1}ms dec={:.1}ms ({} tok, {:.2}ms/tok) total={:.1}ms",
                t_feat.as_secs_f64() * 1000.0,
                (t_enc - t_feat).as_secs_f64() * 1000.0,
                t_dec.as_secs_f64() * 1000.0,
                n_tok,
                if n_tok > 0 {
                    t_dec.as_secs_f64() * 1000.0 / n_tok as f64
                } else {
                    0.0
                },
                t_start.elapsed().as_secs_f64() * 1000.0,
            );
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
