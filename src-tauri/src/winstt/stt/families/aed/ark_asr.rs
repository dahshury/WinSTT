// ARK-ASR engine (`arkasr`: Whisper-large audio encoder + MLP adapter → Qwen-style causal LM).
//
// Source: Audio8/ark-asr-0.6b-int8-onnx — `infer_ark_audio_onnx.py::ArkAsrOnnxRuntime`,
// `runtime_manifest.json`, and `processing_arkasr.py` (the prompt builder).
//
// SIBLING, NOT A COPY, of `audio8.rs`. Both models are the same upstream `arkasr` architecture and
// share the prompt scaffold + `ark_audio_token_count` verbatim (imported from `audio8`), but the two
// ONNX packagings have nothing else in common:
//
//                     audio8.rs (Audio8-ASR-0.1B)        this file (ARK-ASR)
//   audio            one graph → host LayerNorm/Linear   encoder graph → host reshape-merge →
//                    from a `.npz`                       a SECOND adapter graph
//   embeddings       fp32 `.npy`, host lookup            raw fp32 blob behind `embedding_fp32.onnx`
//   LM               prefill graph + decode graph        ONE graph drives both
//   KV cache axes    `[1, heads, seq, dim]`              `[1, seq, heads, dim]`  ← note the swap
//
// Pipeline:
//   1. 128-mel log-spectrogram. Unlike the 0.1B bundle the encoder's `audios` input is
//      `[1, 128, mel_seq]` with a DYNAMIC length, so we feed only the frames the audio actually
//      occupies (`samples / 160`) instead of padding to the full 30 s / 3000-frame window. That
//      matches the reference (its feature extractor runs with `padding="longest"`) and is
//      strictly less encoder work for short dictation.
//   2. `audio_encoder_whisper_int8.onnx`(audios) → `encoded_audio_features [1, seq, 1280]`.
//   3. Host merge: truncate `seq` to a multiple of `merge_factor` and RESHAPE 4 frames into one
//      `[1, seq/4, 5120]` row (a plain regroup — no pooling, unlike the 0.1B adapter).
//   4. `audio_encoder_adapter_int8.onnx`(merged_audio_features) → `audio_embeddings [1, n, 896]`.
//   5. Prompt (identical scaffold to the 0.1B): `<|user|><|begin_of_audio|>` + N×`<|audio|>` +
//      `<|end_of_audio|>` + "Please transcribe this audio." + `<|assistant|>`, with the audio
//      placeholders overwritten by the adapter output (zero-padded / truncated to N, as upstream's
//      `_inject_audio` does).
//   6. `llm_kv_cpu_fp32_int8.onnx` for BOTH phases: `inputs_embeds [1, L, 896]`,
//      `attention_mask [1, 2048]`, `cache_position [L]`, and all 48 `cache_{key,value}_i`
//      `[1, 2048, 2, 64]` buffers → `logits` + 48 per-position deltas the host writes back.
//
// PERF NOTE: the LM takes the FULL static cache as inputs every step — 24 layers × 2 × 1 MiB ≈
// 50 MiB of tensor copies per generated token (the reference pays the same). That, plus the int8
// QDQ graph, is why this kind is CPU-pinned alongside the other LLM-decoder engines.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use ndarray::{Array1, Array2, Array3, Array4, ArrayD};
use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::{Session, SessionInputValue};
use ort::value::{DynValue, Tensor};

use super::audio8::{ark_audio_token_count, normalize_prediction_text};
use super::*;
use crate::winstt::stt::Accelerator;
use crate::winstt::stt::mel::{HOP_LENGTH, MelExtractor, N_FRAMES};

/// Prompt instruction, verbatim from the reference CLI's conversation template.
const PROMPT_INSTRUCTION: &str = "Please transcribe this audio.";
/// `infer_ark_audio_onnx.py::DEFAULT_ASR_BLOCK_TOKEN_ID_FROM` — every id at or above this is masked
/// out of the transcript. Only a fallback: `runtime_manifest.json` wins when it carries the field.
const DEFAULT_BLOCK_FROM: i64 = 151_670;
/// Whisper's fixed window; the encoder positional table tops out here (`max_source_positions`
/// 1500 = 3000 mel frames), so a decode never sees more than 30 s in one pass.
const MAX_AUDIO_SECONDS: usize = 30;
/// Runaway guard for the GROWING export, which has no cache ceiling of its own. 30 s of speech
/// tops out near 150 tokens even for dense CJK, so this only fires on a degenerate loop that
/// `phrase_loop_truncation` somehow missed.
const GROWING_DECODE_CAP: usize = 320;

// ───────────────────────────────────────────────────────────────────────────
// runtime_manifest.json
// ───────────────────────────────────────────────────────────────────────────

struct RuntimeManifest {
    user_token: String,
    assistant_token: String,
    bos_audio_token: String,
    eos_audio_token: String,
    stop_token_ids: Vec<i64>,
    /// The ONE stop id that must stay UNMASKED — see the block-list note in `load`.
    eos_token_id: i64,
    merge_factor: usize,
    encoder_hidden: usize,
    block_from: i64,
}

impl RuntimeManifest {
    fn load(path: &Path) -> SttResult<RuntimeManifest> {
        let raw = std::fs::read(path)
            .map_err(|e| SttError::Resolve(format!("ark-asr manifest read: {e}")))?;
        let json: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|e| SttError::Resolve(format!("ark-asr manifest parse: {e}")))?;
        let stop_token_ids: Vec<i64> = json["stop_token_ids"]
            .as_array()
            .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
            .filter(|v: &Vec<i64>| !v.is_empty())
            .unwrap_or_else(|| vec![151_645]);
        Ok(RuntimeManifest {
            // The marker STRINGS are fixed by `ArkasrProcessor.__init__`; the manifest only carries
            // their ids, and we re-encode the strings with this repo's own tokenizer anyway. The
            // `<|audio|>` placeholder itself never needs encoding here: the prompt reserves its
            // slots positionally between the prefix and suffix, and every `<…>` added token is
            // masked out of the transcript anyway.
            user_token: "<|user|>".to_string(),
            assistant_token: "<|assistant|>".to_string(),
            bos_audio_token: "<|begin_of_audio|>".to_string(),
            eos_audio_token: "<|end_of_audio|>".to_string(),
            stop_token_ids,
            eos_token_id: json["im_end_token_id"].as_i64().unwrap_or(151_645),
            merge_factor: json["audio_merge_factor"]
                .as_u64()
                .filter(|v| *v > 0)
                .unwrap_or(4) as usize,
            encoder_hidden: json["audio_encoder_hidden_size"]
                .as_u64()
                .filter(|v| *v > 0)
                .unwrap_or(1280) as usize,
            block_from: json["asr_block_token_id_from"]
                .as_i64()
                .unwrap_or(DEFAULT_BLOCK_FROM),
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Static KV cache (seq-major)
// ───────────────────────────────────────────────────────────────────────────

/// Host-side static KV cache in this export's `[1, max_total_len, kv_heads, head_dim]` layout —
/// the SEQUENCE axis is 1 here, not 2 as in `audio8.rs`. Getting that wrong silently scrambles
/// attention instead of erroring, so the axis is asserted against the graph's declared shape at
/// load and the delta writeback slices axis 1.
struct ArkKvCaches {
    buffers: Vec<Array4<f32>>,
    max_total_len: usize,
}

impl ArkKvCaches {
    fn new(layers: usize, max_total_len: usize, kv_heads: usize, head_dim: usize) -> Self {
        Self {
            buffers: (0..2 * layers)
                .map(|_| Array4::<f32>::zeros((1, max_total_len, kv_heads, head_dim)))
                .collect(),
            max_total_len,
        }
    }

    /// Write one `[1, P, kv_heads, head_dim]` delta back at `pos_start..pos_start + P`.
    fn apply_delta(
        &mut self,
        index: usize,
        delta: &ArrayD<f32>,
        pos_start: usize,
    ) -> SttResult<()> {
        let buffer = self
            .buffers
            .get_mut(index)
            .ok_or_else(|| SttError::Inference(format!("ark-asr kv delta {index} out of range")))?;
        let dims = delta.shape();
        let want = buffer.shape().to_vec();
        if dims.len() != 4 || dims[2] != want[2] || dims[3] != want[3] {
            return Err(SttError::Inference(format!(
                "ark-asr unexpected kv delta shape {dims:?} (cache {want:?})"
            )));
        }
        let p = dims[1];
        if pos_start + p > self.max_total_len {
            return Err(SttError::Inference(format!(
                "ark-asr kv delta writes past the cache: {pos_start}+{p} > {}",
                self.max_total_len
            )));
        }
        let delta4 = delta
            .view()
            .into_dimensionality::<ndarray::Ix4>()
            .map_err(|e| SttError::Inference(format!("ark-asr kv delta ix4: {e}")))?;
        buffer
            .slice_mut(ndarray::s![.., pos_start..pos_start + p, .., ..])
            .assign(&delta4);
        Ok(())
    }
}

/// Which KV contract the resolved LM graph implements.
///
/// Both are `arkasr`; they differ only in how the decoder is exported, and the difference is the
/// single biggest performance lever on this family:
///
/// * `Static` — upstream's shape. The whole `[1, max_total_len, kv_heads, head_dim]` buffer is a
///   graph INPUT on every token and the graph returns per-position deltas the host writes back.
///   Attention therefore costs O(max_total_len) per token however short the utterance, and the
///   host moves the entire cache each step (76 MiB/token on the 3B at 1024).
/// * `Growing` — our re-export. `past_key_i`/`past_value_i` in, `present_key_i`/`present_value_i`
///   out, concatenated inside the graph. Attention costs O(actual length), there is no writeback,
///   and the `present_* -> past_*` handoff stays DEVICE-RESIDENT through IoBinding — the same
///   trick `qwen3.rs` uses — so nothing round-trips through the host per token.
///
/// Detected from the graph's own input names, so one engine drives either export with no flag.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ArkCacheKind {
    Static,
    Growing,
}

/// Device the LM session runs on, for binding the growing cache resident on it. CPU when no device
/// GPU EP is active, where IoBinding simply binds host memory (near-free, same result).
fn ark_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Engine
// ───────────────────────────────────────────────────────────────────────────

pub(in crate::winstt::stt::families) struct ArkAsrEngine {
    audio_encoder: Session,
    audio_adapter: Session,
    /// ONE graph serves prefill and decode — both feed the full cache and a `cache_position`.
    lm: Session,
    tokenizer: tokenizers::Tokenizer,
    /// `[vocab, hidden]` token embeddings as f16, read straight out of `embedding_fp32.data`.
    embed: Vec<F16>,
    vocab: usize,
    hidden: usize,
    prompt_prefix: Vec<i64>,
    prompt_suffix: Vec<i64>,
    merge_factor: usize,
    encoder_hidden: usize,
    mel_bins: usize,
    layers: usize,
    kv_heads: usize,
    head_dim: usize,
    /// Static export only: the fixed cache length. `usize::MAX` for the growing export, which has
    /// no ceiling of its own (the 30 s audio cap bounds the sequence instead).
    max_total_len: usize,
    cache_kind: ArkCacheKind,
    device: AllocationDevice,
    device_id: i32,
    stop: Vec<i64>,
    blocked: Vec<i64>,
    block_from: i64,
    enc_input: String,
    enc_output: String,
    adapter_input: String,
    adapter_output: String,
    model_name: String,
    providers: Vec<String>,
}

impl ArkAsrEngine {
    pub(in crate::winstt::stt::families) fn load(cfg: &EngineConfig) -> SttResult<ArkAsrEngine> {
        let audio_encoder = build_session(file(&cfg.resolved, "audio_encoder")?, &cfg.providers)?;
        let audio_adapter = build_session(file(&cfg.resolved, "audio_adapter")?, &cfg.providers)?;
        let lm = build_session(file(&cfg.resolved, "lm")?, &cfg.providers)?;
        let tokenizer = tokenizers::Tokenizer::from_file(file(&cfg.resolved, "tokenizer")?)
            .map_err(|e| SttError::Tokenizer(format!("ark-asr tokenizer: {e}")))?;
        let manifest = RuntimeManifest::load(file(&cfg.resolved, "runtime_manifest")?)?;

        // Which KV contract did we resolve? The graph's own input names decide — `past_key_0` is
        // the growing re-export, `cache_key_0` upstream's static one. No flag, no manifest field.
        let growing_layers = filter_sorted_inputs(&lm, "past_key_").len();
        let static_layers = filter_sorted_inputs(&lm, "cache_key_").len();
        let (cache_kind, layers, kv_heads, head_dim, max_total_len) = if growing_layers > 0 {
            // `past_key_0` is `[1, kv_heads, past_len, head_dim]` with a DYNAMIC seq axis, so only
            // axes 1 and 3 are readable — which is the point: there is no fixed length to read.
            let shape = input_shape_or(&lm, "past_key_0", 0)
                .ok_or_else(|| SttError::Resolve("ark-asr lm has no past_key_0 input".into()))?;
            let [_, kv, _, hd] = shape[..] else {
                return Err(SttError::Resolve(format!(
                    "ark-asr lm: unexpected past_key_0 rank {shape:?}"
                )));
            };
            if kv == 0 || hd == 0 {
                return Err(SttError::Resolve(format!(
                    "ark-asr lm: past_key_0 has a dynamic head axis {shape:?}"
                )));
            }
            (ArkCacheKind::Growing, growing_layers, kv, hd, usize::MAX)
        } else {
            let cache_shape = input_shape_or(&lm, "cache_key_0", 0).ok_or_else(|| {
                SttError::Resolve("ark-asr lm has neither past_key_0 nor cache_key_0".into())
            })?;
            let [_, mt, kv, hd] = cache_shape[..] else {
                return Err(SttError::Resolve(format!(
                    "ark-asr lm: unexpected cache_key_0 rank {cache_shape:?}"
                )));
            };
            if mt == 0 || kv == 0 || hd == 0 {
                return Err(SttError::Resolve(format!(
                    "ark-asr lm: cache_key_0 has a dynamic axis {cache_shape:?}; the static export                      requires all of them fixed"
                )));
            }
            if static_layers == 0 {
                return Err(SttError::Resolve(
                    "ark-asr lm exposes no cache_key_* inputs".into(),
                ));
            }
            (ArkCacheKind::Static, static_layers, kv, hd, mt)
        };
        let hidden = static_input_dim(&lm, "inputs_embeds", 2).ok_or_else(|| {
            SttError::Resolve("ark-asr lm has no static inputs_embeds hidden size".into())
        })?;

        // `embedding_*.onnx` is a single `Gather` over an external-data initializer, so the sidecar
        // blob IS the raw row-major `[vocab, hidden]` table. Reading it directly (and holding it as
        // f16) skips a multi-hundred-MB ORT session plus a graph run per token; the exact-division
        // check in `read_embedding_blob` is what makes that shortcut safe.
        //
        // Bundles ship exactly ONE spelling: upstream's fp32, or our re-export's fp16 (half the
        // download; we downcast to f16 on load either way, so fp16 on disk costs nothing). The
        // resolver marks both optional, so requiring exactly one is enforced HERE.
        let (embed_path, embed_bytes) = match (
            cfg.resolved.files.get("embed_tokens_fp16"),
            cfg.resolved.files.get("embed_tokens"),
        ) {
            (Some(p), _) => (p.as_path(), 2usize),
            (None, Some(p)) => (p.as_path(), 4usize),
            (None, None) => {
                return Err(SttError::Resolve(
                    "ark-asr bundle has neither embedding_fp16.data nor embedding_fp32.data".into(),
                ));
            }
        };
        let (vocab, embed) = read_embedding_blob(embed_path, hidden, embed_bytes)?;

        let encode = |text: &str| -> SttResult<Vec<i64>> {
            Ok(tokenizer
                .encode(text, false)
                .map_err(|e| SttError::Tokenizer(format!("ark-asr prompt encode {text:?}: {e}")))?
                .get_ids()
                .iter()
                .map(|&i| i64::from(i))
                .collect())
        };
        let prompt_prefix = encode(&format!(
            "{}{}",
            manifest.user_token, manifest.bos_audio_token
        ))?;
        let prompt_suffix = encode(&format!(
            "{}{PROMPT_INSTRUCTION}{}",
            manifest.eos_audio_token, manifest.assistant_token
        ))?;

        // Upstream `build_bad_token_ids`: every special / `<…>` added-vocab id is masked out of the
        // transcript, and the ONLY exemption is the tokenizer's eos (`im_end_token_id`).
        //
        // LOAD-BEARING: exempting the OTHER stop ids too looks harmless and is not. This model's
        // raw first-token argmax on a plain utterance is `<|user|>` (151665), which the manifest
        // also lists as a stop id — leave it unmasked and every decode ends on token one with an
        // empty transcript. Masking it is what makes the argmax land on the first real word.
        let stop: Vec<i64> = manifest.stop_token_ids.clone();
        let blocked = build_block_list(
            tokenizer
                .get_added_tokens_decoder()
                .into_iter()
                .map(|(id, token)| (id, token.content)),
            manifest.eos_token_id,
        );

        let enc_input = node_input_names(&audio_encoder)
            .first()
            .cloned()
            .unwrap_or_else(|| "audios".to_string());
        let enc_output = node_output_names(&audio_encoder)
            .first()
            .cloned()
            .unwrap_or_else(|| "encoded_audio_features".to_string());
        let adapter_input = node_input_names(&audio_adapter)
            .first()
            .cloned()
            .unwrap_or_else(|| "merged_audio_features".to_string());
        let adapter_output = node_output_names(&audio_adapter)
            .first()
            .cloned()
            .unwrap_or_else(|| "audio_embeddings".to_string());
        let mel_bins = static_input_dim(&audio_encoder, &enc_input, 1).unwrap_or(128);
        let (device, device_id) = ark_device(&cfg.providers);

        Ok(ArkAsrEngine {
            audio_encoder,
            audio_adapter,
            lm,
            tokenizer,
            embed,
            vocab,
            hidden,
            prompt_prefix,
            prompt_suffix,
            merge_factor: manifest.merge_factor,
            encoder_hidden: manifest.encoder_hidden,
            mel_bins,
            layers,
            kv_heads,
            head_dim,
            max_total_len,
            cache_kind,
            device,
            device_id,
            stop,
            blocked,
            block_from: manifest.block_from,
            enc_input,
            enc_output,
            adapter_input,
            adapter_output,
            model_name: cfg.model_name.clone(),
            providers: providers_to_strings(&cfg.providers),
        })
    }

    /// Encoder → host merge → adapter, returning `[n, hidden]` audio embeddings row-major.
    fn audio_embeddings(&mut self, audio: &[f32]) -> SttResult<(usize, Vec<f32>)> {
        // The encoder length is dynamic, so feed only the frames the audio occupies.
        let frames = (audio.len() / HOP_LENGTH).clamp(1, N_FRAMES);
        let mel = MelExtractor::new(self.mel_bins);
        let (feats, n_mels, n_frames) = mel.extract_frames(audio, frames);
        let mel_tensor = Tensor::from_array(
            Array3::from_shape_vec((1, n_mels, n_frames), feats)
                .map_err(|e| SttError::Inference(format!("ark-asr mel reshape: {e}")))?,
        )
        .map_err(|e| SttError::Inference(format!("ark-asr mel tensor: {e}")))?;

        let encoded = {
            let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![(
                Cow::Owned(self.enc_input.clone()),
                SessionInputValue::from(mel_tensor),
            )];
            let outputs = self
                .audio_encoder
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("ark-asr audio encoder: {e}")))?;
            out_to_f32(outputs.get(self.enc_output.as_str()).ok_or_else(|| {
                SttError::Inference(format!("ark-asr encoder produced no {}", self.enc_output))
            })?)?
        };

        let merged = self.merge_encoder_frames(&encoded)?;
        let rows = merged.shape()[1];
        let merged_tensor = Tensor::from_array(merged)
            .map_err(|e| SttError::Inference(format!("ark-asr merged tensor: {e}")))?;
        let embeds = {
            let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![(
                Cow::Owned(self.adapter_input.clone()),
                SessionInputValue::from(merged_tensor),
            )];
            let outputs = self
                .audio_adapter
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("ark-asr audio adapter: {e}")))?;
            out_to_f32(outputs.get(self.adapter_output.as_str()).ok_or_else(|| {
                SttError::Inference(format!(
                    "ark-asr adapter produced no {}",
                    self.adapter_output
                ))
            })?)?
        };
        let flat = embeds
            .as_slice()
            .ok_or_else(|| SttError::Inference("ark-asr audio embeds not contiguous".into()))?
            .to_vec();
        Ok((rows, flat))
    }

    /// Upstream `_merge_audio_features`: drop the frames past the last whole group and regroup
    /// `merge_factor` encoder frames into one adapter row (`[1, seq/f, hidden*f]`). Short clips are
    /// zero-padded up to one full group so the adapter always sees at least one row.
    fn merge_encoder_frames(&self, encoded: &ArrayD<f32>) -> SttResult<Array3<f32>> {
        let dims = encoded.shape();
        if dims.len() != 3 || dims[2] != self.encoder_hidden {
            return Err(SttError::Inference(format!(
                "ark-asr unexpected encoder output shape {dims:?} (hidden {})",
                self.encoder_hidden
            )));
        }
        let flat = encoded
            .as_slice()
            .ok_or_else(|| SttError::Inference("ark-asr encoder output not contiguous".into()))?;
        let hidden = self.encoder_hidden;
        let factor = self.merge_factor.max(1);
        let seq = dims[1];
        let mut values: Vec<f32>;
        let rows;
        if seq < factor {
            values = vec![0.0; factor * hidden];
            values[..seq * hidden].copy_from_slice(&flat[..seq * hidden]);
            rows = 1;
        } else {
            let kept = (seq / factor) * factor;
            values = flat[..kept * hidden].to_vec();
            rows = kept / factor;
        }
        Array3::from_shape_vec((1, rows, hidden * factor), values)
            .map_err(|e| SttError::Inference(format!("ark-asr merge reshape: {e}")))
    }

    fn embed_row(&self, token: i64) -> SttResult<&[F16]> {
        let index = usize::try_from(token)
            .ok()
            .filter(|i| *i < self.vocab)
            .ok_or_else(|| {
                SttError::Inference(format!("ark-asr token id out of range: {token}"))
            })?;
        Ok(&self.embed[index * self.hidden..(index + 1) * self.hidden])
    }

    /// Prompt ids → `[1, L, hidden]` embeddings with the `<|audio|>` slots overwritten.
    ///
    /// `audio` is `[rows, hidden]`; upstream `_inject_audio` zero-pads when the adapter produced
    /// fewer rows than the prompt reserved and truncates when it produced more, so the prompt's
    /// token count — not the adapter's row count — is authoritative.
    fn prompt_embeddings(
        &self,
        audio: &[f32],
        rows: usize,
        slots: usize,
    ) -> SttResult<(usize, Array3<f32>)> {
        let len = self.prompt_prefix.len() + slots + self.prompt_suffix.len();
        let mut embeds = Vec::with_capacity(len * self.hidden);
        for &id in &self.prompt_prefix {
            embeds.extend(self.embed_row(id)?.iter().map(|h| h.to_f32()));
        }
        let usable = rows.min(slots);
        embeds.extend_from_slice(&audio[..usable * self.hidden]);
        embeds.extend(std::iter::repeat_n(0.0, (slots - usable) * self.hidden));
        for &id in &self.prompt_suffix {
            embeds.extend(self.embed_row(id)?.iter().map(|h| h.to_f32()));
        }
        let arr = Array3::from_shape_vec((1, len, self.hidden), embeds)
            .map_err(|e| SttError::Inference(format!("ark-asr prompt embeds: {e}")))?;
        Ok((len, arr))
    }

    /// One LM call — the same graph serves the prompt prefill (`P` positions at `pos_start`) and a
    /// single decode step (`P == 1`). Returns the final position's logits.
    fn lm_step(
        &mut self,
        embeds: Array3<f32>,
        pos_start: usize,
        caches: &mut ArkKvCaches,
    ) -> SttResult<Vec<f32>> {
        let span = embeds.shape()[1];
        let valid = (pos_start + span).min(self.max_total_len);
        let mut mask = Array2::<i64>::zeros((1, self.max_total_len));
        mask.slice_mut(ndarray::s![.., ..valid]).fill(1);
        let positions: Vec<i64> = (pos_start..pos_start + span).map(|p| p as i64).collect();

        let outputs = {
            let mut inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> =
                Vec::with_capacity(3 + caches.buffers.len());
            inputs.push((
                Cow::Borrowed("inputs_embeds"),
                Tensor::from_array(embeds)
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("ark-asr embeds tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("attention_mask"),
                Tensor::from_array(mask)
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("ark-asr mask tensor: {e}")))?,
            ));
            inputs.push((
                Cow::Borrowed("cache_position"),
                Tensor::from_array(Array1::from_vec(positions))
                    .map(SessionInputValue::from)
                    .map_err(|e| SttError::Inference(format!("ark-asr positions tensor: {e}")))?,
            ));
            for (i, buffer) in caches.buffers.iter().enumerate() {
                let name = if i % 2 == 0 {
                    format!("cache_key_{}", i / 2)
                } else {
                    format!("cache_value_{}", i / 2)
                };
                inputs.push((
                    Cow::Owned(name),
                    Tensor::from_array(buffer.clone())
                        .map(SessionInputValue::from)
                        .map_err(|e| SttError::Inference(format!("ark-asr kv tensor: {e}")))?,
                ));
            }
            self.lm
                .run(inputs)
                .map_err(|e| SttError::Inference(format!("ark-asr lm: {e}")))?
        };

        let logits =
            last_step_row(&out_to_f32(outputs.get("logits").ok_or_else(|| {
                SttError::Inference("ark-asr lm produced no logits".into())
            })?)?)?;
        let mut deltas = Vec::with_capacity(2 * self.layers);
        for layer in 0..self.layers {
            for prefix in ["key_delta", "value_delta"] {
                let name = format!("{prefix}_{layer}");
                let value = outputs
                    .get(name.as_str())
                    .ok_or_else(|| SttError::Inference(format!("ark-asr lm produced no {name}")))?;
                deltas.push(out_to_f32(value)?);
            }
        }
        drop(outputs);
        for (i, delta) in deltas.iter().enumerate() {
            caches.apply_delta(i, delta, pos_start)?;
        }
        Ok(logits)
    }

    /// Device `MemoryInfo` for keeping the growing KV resident on the session's device.
    fn device_mem(&self) -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("ark-asr device mem info: {e}")))
    }

    /// Host `MemoryInfo` so logits come back for argmax.
    fn host_mem() -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("ark-asr cpu mem info: {e}")))
    }

    /// Empty `[1, kv_heads, 0, head_dim]` past tensors — the prefill call's starting cache.
    fn empty_past(&self) -> SttResult<Vec<Tensor<f32>>> {
        (0..2 * self.layers)
            .map(|_| {
                Tensor::from_array(Array4::<f32>::zeros((1, self.kv_heads, 0, self.head_dim)))
                    .map_err(|e| SttError::Inference(format!("ark-asr empty past: {e}")))
            })
            .collect()
    }

    /// One GROWING-cache LM call. `past` is the previous step's `present_*` values, carried as
    /// DEVICE-resident `DynValue`s and rebound here with no host copy — so a decode step moves only
    /// the one token's embedding in and its logits out, instead of the whole cache both ways.
    ///
    /// Returns the last position's logits plus the new `present_*` values for the next step.
    fn lm_step_growing(
        &mut self,
        embeds: Array3<f32>,
        pos_start: usize,
        past: Vec<DynValue>,
    ) -> SttResult<(Vec<f32>, Vec<DynValue>)> {
        let span = embeds.shape()[1];
        let positions: Vec<i64> = (pos_start..pos_start + span).map(|p| p as i64).collect();
        let embeds_t = Tensor::from_array(embeds)
            .map_err(|e| SttError::Inference(format!("ark-asr growing embeds: {e}")))?;
        let pos_t = Tensor::from_array(Array1::from_vec(positions))
            .map_err(|e| SttError::Inference(format!("ark-asr growing positions: {e}")))?;
        let dev = self.device_mem()?;
        let cpu = Self::host_mem()?;

        let mut binding = self
            .lm
            .create_binding()
            .map_err(|e| SttError::Inference(format!("ark-asr binding: {e}")))?;
        binding
            .bind_input("inputs_embeds", &embeds_t)
            .map_err(|e| SttError::Inference(format!("ark-asr bind embeds: {e}")))?;
        binding
            .bind_input("cache_position", &pos_t)
            .map_err(|e| SttError::Inference(format!("ark-asr bind positions: {e}")))?;
        for (i, value) in past.iter().enumerate() {
            let name = if i % 2 == 0 {
                format!("past_key_{}", i / 2)
            } else {
                format!("past_value_{}", i / 2)
            };
            binding
                .bind_input(name.as_str(), value)
                .map_err(|e| SttError::Inference(format!("ark-asr bind {name}: {e}")))?;
        }
        binding
            .bind_output_to_device("logits", &cpu)
            .map_err(|e| SttError::Inference(format!("ark-asr bind logits: {e}")))?;
        for layer in 0..self.layers {
            for tag in ["key", "value"] {
                let name = format!("present_{tag}_{layer}");
                binding
                    .bind_output_to_device(name.as_str(), &dev)
                    .map_err(|e| SttError::Inference(format!("ark-asr bind {name}: {e}")))?;
            }
        }
        let mut outputs = self
            .lm
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("ark-asr growing lm: {e}")))?;
        // CUDA/DML `run_binding` is async w.r.t. the device stream — block before handing the
        // device values to the next step, or we would rebind memory that is still being written.
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("ark-asr growing synchronize: {e}")))?;

        let logits =
            last_step_row(&out_to_f32(outputs.get("logits").ok_or_else(|| {
                SttError::Inference("ark-asr growing lm: no logits".into())
            })?)?)?;
        // Take the present_* out as session-owned device values: they survive the binding drop and
        // rebind next step untouched by the host. Done AFTER the logits read so that borrow ends.
        let mut present = Vec::with_capacity(2 * self.layers);
        for layer in 0..self.layers {
            for tag in ["key", "value"] {
                let name = format!("present_{tag}_{layer}");
                present.push(outputs.remove(name.as_str()).ok_or_else(|| {
                    SttError::Inference(format!("ark-asr growing lm: no {name}"))
                })?);
            }
        }
        Ok((logits, present))
    }

    /// Upstream `AsrLogitsMask`: everything from `block_from` up, plus the special / `<…>` ids.
    fn pick_token(&self, logits: &mut [f32]) -> i64 {
        if self.block_from >= 0 {
            let from = self.block_from as usize;
            if from < logits.len() {
                logits[from..].fill(f32::NEG_INFINITY);
            }
        }
        for &id in &self.blocked {
            if let Ok(index) = usize::try_from(id)
                && index < logits.len()
            {
                logits[index] = f32::NEG_INFINITY;
            }
        }
        argmax_1d(logits).0 as i64
    }

    fn decode_text(&self, ids: &[i64]) -> SttResult<String> {
        let ids32: Vec<u32> = ids.iter().filter_map(|&i| u32::try_from(i).ok()).collect();
        let raw = self
            .tokenizer
            .decode(&ids32, true)
            .map_err(|e| SttError::Tokenizer(format!("ark-asr decode: {e}")))?;
        Ok(normalize_prediction_text(&raw))
    }
}

impl Transcriber for ArkAsrEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::ArkAsr
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
        let audio = &audio[..audio.len().min(MAX_AUDIO_SECONDS * 16_000)];
        let slots = ark_audio_token_count(audio.len(), self.merge_factor);

        let (rows, audio_embeds) = self.audio_embeddings(audio)?;
        let (prompt_len, embeds) = self.prompt_embeddings(&audio_embeds, rows, slots)?;
        if prompt_len >= self.max_total_len {
            return Err(SttError::Inference(format!(
                "ark-asr prompt is {prompt_len} positions, cache holds {} — the caller must \
                 segment to `max_chunk_seconds`",
                self.max_total_len
            )));
        }
        // The static export's ceiling is its cache; the growing one has none of its own, so the
        // 30 s audio cap (and `max_chunk_seconds` above it) is what bounds the transcript.
        let budget = match self.cache_kind {
            ArkCacheKind::Static => self.max_total_len - prompt_len,
            ArkCacheKind::Growing => GROWING_DECODE_CAP,
        };

        // Static: a host-side buffer re-fed whole every step. Growing: device-resident values
        // handed straight from one step's `present_*` to the next step's `past_*`, no host copy.
        let mut caches = ArkKvCaches::new(
            self.layers,
            self.max_total_len.min(1 << 16),
            self.kv_heads,
            self.head_dim,
        );
        let mut carried: Vec<DynValue> = Vec::new();
        let mut logits = match self.cache_kind {
            ArkCacheKind::Static => self.lm_step(embeds, 0, &mut caches)?,
            ArkCacheKind::Growing => {
                let past: Vec<DynValue> =
                    self.empty_past()?.into_iter().map(DynValue::from).collect();
                let (l, present) = self.lm_step_growing(embeds, 0, past)?;
                carried = present;
                l
            }
        };

        let mut generated: Vec<i64> = Vec::new();
        for step in 0..budget {
            let next = self.pick_token(&mut logits);
            if self.stop.contains(&next) {
                break;
            }
            generated.push(next);
            if let Some(keep) = phrase_loop_truncation(&generated) {
                generated.truncate(keep);
                break;
            }
            if step + 1 == budget {
                break;
            }
            let row: Vec<f32> = self.embed_row(next)?.iter().map(|h| h.to_f32()).collect();
            let step_embeds = Array3::from_shape_vec((1, 1, self.hidden), row)
                .map_err(|e| SttError::Inference(format!("ark-asr step embeds: {e}")))?;
            logits = match self.cache_kind {
                ArkCacheKind::Static => {
                    self.lm_step(step_embeds, prompt_len + step, &mut caches)?
                }
                ArkCacheKind::Growing => {
                    let past = std::mem::take(&mut carried);
                    let (l, present) =
                        self.lm_step_growing(step_embeds, prompt_len + step, past)?;
                    carried = present;
                    l
                }
            };
        }

        Ok(Transcription {
            text: self.decode_text(&generated)?,
            ..Default::default()
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Embedding blob
// ───────────────────────────────────────────────────────────────────────────

/// Build the decode block-list: every `<…>` added-vocab id EXCEPT `eos`.
///
/// Upstream `build_bad_token_ids`. Split out as a free function purely so the exemption rule can be
/// regression-tested — see `only_the_eos_escapes_the_block_list`, which pins the bug this replaced.
fn build_block_list(added: impl Iterator<Item = (u32, String)>, eos: i64) -> Vec<i64> {
    let mut blocked: BTreeSet<i64> = added
        .filter(|(_, content)| content.starts_with('<') && content.ends_with('>'))
        .map(|(id, _)| i64::from(id))
        .collect();
    blocked.remove(&eos);
    blocked.into_iter().collect()
}

/// Read `embedding_fp32.data` — the raw row-major fp32 `[vocab, hidden]` external-data blob behind
/// `embedding_fp32.onnx`'s single `Gather` — and hold it as f16 (halves ~588 MB to ~294 MB; the
/// checkpoint is bf16, so f16 storage loses nothing).
///
/// `hidden` comes from the LM graph, and the blob length must divide by `hidden * 4` EXACTLY. That
/// check is what makes reading the sidecar directly safe: any other blob layout (extra tensors,
/// padding, a different dtype) fails to divide and errors instead of yielding shifted rows.
fn read_embedding_blob(
    path: &Path,
    hidden: usize,
    elem_bytes: usize,
) -> SttResult<(usize, Vec<F16>)> {
    let len = std::fs::metadata(path)
        .map_err(|e| SttError::Resolve(format!("ark-asr embedding blob stat: {e}")))?
        .len() as usize;
    let row_bytes = hidden * elem_bytes;
    if hidden == 0 || len == 0 || row_bytes == 0 || !len.is_multiple_of(row_bytes) {
        return Err(SttError::Resolve(format!(
            "ark-asr embedding blob is {len} bytes, not a whole number of {hidden}-wide rows at              {elem_bytes} B/element"
        )));
    }
    let vocab = len / row_bytes;

    let file = std::fs::File::open(path)
        .map_err(|e| SttError::Resolve(format!("ark-asr embedding blob open: {e}")))?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file);
    let mut table = Vec::with_capacity(vocab * hidden);
    // 1 MiB is a multiple of both 2 and 4, so a chunk never splits an element.
    let mut chunk = vec![0u8; 1 << 20];
    let mut remaining = len;
    while remaining > 0 {
        let want = remaining.min(chunk.len());
        reader
            .read_exact(&mut chunk[..want])
            .map_err(|e| SttError::Resolve(format!("ark-asr embedding blob body: {e}")))?;
        if elem_bytes == 2 {
            // Already f16 on disk — reinterpret, no conversion.
            table.extend(
                chunk[..want]
                    .chunks_exact(2)
                    .map(|c| F16::from_le_bytes([c[0], c[1]])),
            );
        } else {
            table.extend(
                chunk[..want]
                    .chunks_exact(4)
                    .map(|c| F16::from_f32(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))),
            );
        }
        remaining -= want;
    }
    Ok((vocab, table))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirror of `ArkAsrEngine::merge_encoder_frames` over plain parameters, so the reshape rule can
    /// be tested without an ORT session (the real method needs a loaded encoder to produce input).
    fn merge_frames_for_test(
        flat: &[f32],
        seq: usize,
        hidden: usize,
        factor: usize,
    ) -> (usize, Vec<f32>) {
        if seq < factor {
            let mut values = vec![0.0; factor * hidden];
            values[..seq * hidden].copy_from_slice(&flat[..seq * hidden]);
            (1, values)
        } else {
            let kept = (seq / factor) * factor;
            (kept / factor, flat[..kept * hidden].to_vec())
        }
    }

    #[test]
    fn merge_regroups_whole_windows_and_drops_the_remainder() {
        // 9 frames of dim 1, factor 4 → 2 rows from frames 0..8; frame 8 is dropped.
        let flat: Vec<f32> = (0..9).map(|v| v as f32).collect();
        let (rows, values) = merge_frames_for_test(&flat, 9, 1, 4);
        assert_eq!(rows, 2);
        assert_eq!(values, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]);
    }

    #[test]
    fn merge_zero_pads_a_clip_shorter_than_one_window() {
        // 2 frames of dim 1, factor 4 → one row, tail zero-filled (never an empty adapter input).
        let (rows, values) = merge_frames_for_test(&[5.0, 6.0], 2, 1, 4);
        assert_eq!(rows, 1);
        assert_eq!(values, vec![5.0, 6.0, 0.0, 0.0]);
    }

    #[test]
    fn kv_cache_writes_delta_on_the_sequence_axis() {
        // `[1, seq, heads, dim]` — the axis order that differs from audio8.rs.
        let mut caches = ArkKvCaches::new(1, 8, 2, 3);
        let delta = ArrayD::from_elem(ndarray::IxDyn(&[1, 1, 2, 3]), 7.0f32);
        caches.apply_delta(0, &delta, 5).unwrap();
        assert_eq!(caches.buffers[0][[0, 5, 0, 0]], 7.0);
        assert_eq!(caches.buffers[0][[0, 4, 0, 0]], 0.0);
        // Past the end is an error, not a silent truncation.
        assert!(caches.apply_delta(0, &delta, 8).is_err());
        // A delta whose head geometry disagrees is rejected (catches an axis-order mix-up).
        let swapped = ArrayD::from_elem(ndarray::IxDyn(&[1, 2, 3, 1]), 1.0f32);
        assert!(caches.apply_delta(0, &swapped, 0).is_err());
    }

    #[test]
    fn prefill_spans_positions_zero_through_prompt_len() {
        // A multi-position delta must land as one contiguous run starting at pos_start.
        let mut caches = ArkKvCaches::new(1, 8, 1, 1);
        let delta = ArrayD::from_elem(ndarray::IxDyn(&[1, 4, 1, 1]), 2.0f32);
        caches.apply_delta(0, &delta, 0).unwrap();
        for pos in 0..4 {
            assert_eq!(caches.buffers[0][[0, pos, 0, 0]], 2.0);
        }
        assert_eq!(caches.buffers[0][[0, 4, 0, 0]], 0.0);
    }

    #[test]
    fn only_the_eos_escapes_the_block_list() {
        // Every `<…>` added token is masked; plain word-pieces are untouched.
        let added = [
            (151_643u32, "<|endoftext|>".to_string()),
            (151_645, "<|im_end|>".to_string()),
            (151_663, "<|audio|>".to_string()),
            (151_665, "<|user|>".to_string()),
            (151_668, "<|assistant|>".to_string()),
            (3_036, "And".to_string()),
        ];
        let blocked = build_block_list(added.into_iter(), 151_645);

        // REGRESSION: `<|user|>` is BOTH an added marker and a manifest stop id, and it is this
        // model's raw first-token argmax on ordinary speech. Exempting it (as an earlier revision
        // did for every stop id) made the decode stop on token one and return "" every time.
        assert!(blocked.contains(&151_665), "<|user|> must stay masked");
        assert!(blocked.contains(&151_643), "pad must stay masked");
        assert!(
            blocked.contains(&151_663),
            "the audio placeholder must stay masked"
        );
        // The eos is the ONLY exemption — masking it would make the decode unstoppable.
        assert!(!blocked.contains(&151_645), "eos must NOT be masked");
        // Real vocabulary is never touched.
        assert!(!blocked.contains(&3_036));
    }

    #[test]
    fn audio_token_count_is_shared_with_the_audio8_engine() {
        // 3 s at 16 kHz → 300 mel frames → 150 → 37 slots (the value the reference reports).
        assert_eq!(ark_audio_token_count(48_000, 4), 37);
        // Never zero, however short the clip.
        assert_eq!(ark_audio_token_count(10, 4), 1);
    }
}
