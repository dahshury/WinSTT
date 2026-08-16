// Moonshine ASR (Useful Sensors / onnx-community export).
// Reference (decode correctness): onnx-asr fork src/onnx_asr/models/moonshine.py
//   (<onnx-asr>/src/onnx_asr/models/moonshine.py) — the 3-graph structure,
//   greedy KV decode loop, and the SentencePiece byte-fallback `_decode_text`.
//
// Near-clone of `whisper.rs` (same ort **device-resident** IoBinding KV-cache decode, present.* →
// past.* carry) MINUS the mel front-end (Moonshine takes RAW 16 kHz f32 audio) and MINUS Whisper's
// prompt/timestamps/cross-attention. The tokenizer is a DIFFERENT beast (SentencePiece byte-fallback
// BPE, NOT Whisper's GPT-2 byte-BPE).
//
// PERF: like whisper.rs, decode binds the encoder output + carried KV **device-resident** via ort's
// IoBinding — the encoder `last_hidden_state` is bound once (never copied to host) and rebound as
// both decoders' `encoder_hidden_states`, and the `present.*` KV is carried as session-owned device
// `DynValue`s rebound as the next step's `past_key_values.*` (no per-step host round-trip / clone).
// Moonshine is CPU-forced (see `load()`), so today IoBinding simply binds host memory — still a win
// (drops the per-step `.to_vec()` of 12-24 KV tensors + the whole-state `HashMap::clone`) and
// EP-agnostic if the CPU force is ever lifted. Only `input_ids` goes host→device and `logits` comes
// host-side for argmax — exactly as `whisper.rs` / onnx-asr do.
//
// Graph layout (verified against the cached onnx-community/moonshine-tiny-ONNX graphs via
// onnx.load; matches moonshine.py's docstring exactly):
//   * encoder_model.onnx          : input `input_values` (1, n_samples) f32 raw PCM →
//                                   `last_hidden_state` (1, enc_T, 288). NO attention_mask.
//   * decoder_model.onnx          : step 0. inputs `input_ids` + `encoder_hidden_states`;
//                                   outputs `logits` + present.{0..L-1}.{decoder,encoder}.{key,value}.
//   * decoder_with_past_model.onnx: cached steps. inputs `input_ids` (1,1) + ALL
//                                   past_key_values.{0..L-1}.{decoder,encoder}.{key,value};
//                                   outputs `logits` + present.{0..L-1}.decoder.{key,value} ONLY
//                                   (encoder K/V are static — fed straight back from step-0 output).
//
// Newer re-exports (moonshine-tiny-{uk,fr}-ONNX, transformers >= 4.57) ADD `attention_mask`
// (encoder), `encoder_attention_mask`, and a recomputed `encoder_hidden_states` on the past-step
// decoder. We gate every one of those on the graph actually declaring the input (session.inputs()
// name probe) so both layouts load through the same code — exactly like moonshine.py.

use std::collections::HashMap;
use std::path::Path;

use ort::memory::{AllocationDevice, AllocatorType, MemoryInfo, MemoryType};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::{DynValue, Tensor};

use super::{
    Accelerator, EngineConfig, EngineKind, SttError, SttResult, TranscribeOptions, Transcriber,
    Transcription, configure_session, kv_sort_key, num_cpus_best_effort as num_cpus,
    provider_label,
};

/// onnx-asr `_DEFAULT_MAX_LENGTH` — a safety cap on a runaway greedy decode. Moonshine's
/// `max_position_embeddings` is 512; 448 matches Whisper's classic cap and is plenty for
/// short-form ASR.
const MAX_LENGTH: usize = 448;

/// SentencePiece "underscore" — the visible substitute for an ASCII space in a token piece.
const SP_SPACE: char = '\u{2581}';

/// A loaded Moonshine engine (`EngineKind::Moonshine`). Holds the three ORT sessions, the parsed
/// SentencePiece tokenizer, and the per-load capability flags / cached graph layout.
pub struct MoonshineEngine {
    model_name: String,
    encoder: Session,
    decoder: Session,
    decoder_with_past: Session,
    tokenizer: MoonshineTokenizer,
    providers: Vec<String>,
    /// Sorted `past_key_values.*` decoder-with-past input names (canonical layer/sub order).
    past_input_names: Vec<String>,
    /// Sorted `present.*` step-0 decoder output names (24 tensors: decoder + encoder K/V).
    present_output_names: Vec<String>,
    /// Sorted `present.*` past-step decoder output names (12 tensors: decoder K/V only).
    past_present_names: Vec<String>,
    /// Step-0 carry map: `(present output name, index into past_input_names)`, precomputed at load
    /// so the hot loop carries `present.X`→`past_key_values.X` without a per-step name scan.
    present_carry: Vec<(String, usize)>,
    /// Past-step carry map (decoder-K/V present names → past index); the encoder K/V isn't re-emitted
    /// by `decoder_with_past_model`, so only these ~12 entries are overwritten each cached step.
    past_present_carry: Vec<(String, usize)>,
    /// Encoder `attention_mask` input name, if the export declares one (newer re-exports).
    encoder_mask_name: Option<String>,
    /// Step-0 decoder `encoder_attention_mask` input name, if declared.
    decoder_enc_mask_name: Option<String>,
    /// Past-step decoder `encoder_attention_mask` input name, if declared.
    past_enc_mask_name: Option<String>,
    /// Past-step decoder `encoder_hidden_states` input name, if declared (re-exports recompute
    /// cross-attention every step instead of caching it).
    past_enc_hidden_name: Option<String>,
    /// Device the sessions run on, for binding the encoder output + KV-cache device-resident
    /// (mirrors whisper.rs). Always CPU today (Moonshine is CPU-forced); then IoBinding just binds
    /// host memory. EP-agnostic if the CPU force is ever lifted.
    device: AllocationDevice,
    device_id: i32,
    ready: bool,
}

impl MoonshineEngine {
    /// Build the three sessions + tokenizer from a resolved file set.
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let files = &cfg.resolved.files;
        let get = |k: &str| -> SttResult<&Path> {
            files
                .get(k)
                .map(|p| p.as_path())
                .ok_or_else(|| SttError::Resolve(format!("moonshine: missing resolved file '{k}'")))
        };
        let encoder_path = get("encoder")?;
        let decoder_path = get("decoder")?;
        let decoder_with_past_path = get("decoder_with_past")?;
        let tokenizer_path = get("tokenizer")?;
        let tokenizer_config_path = files.get("tokenizer_config").map(|p| p.as_path());

        let tokenizer = MoonshineTokenizer::load(tokenizer_path, tokenizer_config_path)?;

        // PERFORMANCE — Moonshine is CPU-ONLY. Its autoregressive decode carries the KV cache
        // host-side per token, so on DirectML every step round-trips device↔host; for a model
        // this tiny the GPU launch + transfer overhead LOSES to CPU (benchmarked: moonshine-tiny
        // JFK warm 189ms CPU vs 530ms DML — 2.8×). NOTE this is a SPEED choice, not a correctness
        // gate: Moonshine decodes CORRECTLY on DML, just slower, so we force CPU locally here
        // rather than adding it to the engine-kind incompatibility list for graphs that actually
        // crash on DML.
        // is_gpu=false → ORT gets the full CPU intra-op thread pool, not the GPU's single thread.
        let intra = super::pick_intra_op_threads(false, num_cpus());

        let encoder = build_session(encoder_path, intra)?;
        let decoder = build_session(decoder_path, intra)?;
        let decoder_with_past = build_session(decoder_with_past_path, intra)?;

        // Probe optional mask / re-fed encoder inputs (only the uk/fr re-exports declare them).
        let encoder_mask_name = input_named(&encoder, "attention_mask");
        let decoder_enc_mask_name = input_named(&decoder, "encoder_attention_mask");
        let past_enc_mask_name = input_named(&decoder_with_past, "encoder_attention_mask");
        let past_enc_hidden_name = input_named(&decoder_with_past, "encoder_hidden_states");

        // Cache the past-step KV layout (sorted) so we don't re-query the session per step.
        let mut past_input_names: Vec<String> = decoder_with_past
            .inputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("past_key_values."))
            .collect();
        past_input_names.sort_by_key(|n| kv_sort_key(n));

        let mut present_output_names: Vec<String> = decoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("present."))
            .collect();
        present_output_names.sort_by_key(|n| kv_sort_key(n));

        let mut past_present_names: Vec<String> = decoder_with_past
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("present."))
            .collect();
        past_present_names.sort_by_key(|n| kv_sort_key(n));

        // Precompute `present.X` → index-in-`past_input_names` carry maps (once, not per step). A
        // malformed export whose `present.*` has no matching `past_key_values.*` input is rejected
        // at load rather than mid-decode.
        let carry_map = |present: &[String]| -> SttResult<Vec<(String, usize)>> {
            present
                .iter()
                .map(|pn| {
                    let past_name = pn.replacen("present.", "past_key_values.", 1);
                    past_input_names
                        .iter()
                        .position(|n| *n == past_name)
                        .map(|idx| (pn.clone(), idx))
                        .ok_or_else(|| {
                            SttError::Inference(format!("no past input for {past_name}"))
                        })
                })
                .collect()
        };
        let present_carry = carry_map(&present_output_names)?;
        let past_present_carry = carry_map(&past_present_names)?;

        log::debug!(
            "[moonshine] past_kv={} present0={} present_past={} bos={} eos={} \
			 enc_mask={:?} dec_enc_mask={:?} past_enc_mask={:?} past_enc_hidden={:?}",
            past_input_names.len(),
            present_output_names.len(),
            past_present_names.len(),
            tokenizer.bos_id,
            tokenizer.eos_id,
            encoder_mask_name,
            decoder_enc_mask_name,
            past_enc_mask_name,
            past_enc_hidden_name,
        );

        // CPU-forced (see above) → report CPU as the active provider, not the requested device.
        // The IoBinding device MUST track the ACTUAL session allocator, so resolve it from the same
        // CPU-forced provider list the sessions were built with (not `cfg.providers`) — else we'd
        // bind device outputs to a GPU the CPU sessions don't run on. `moonshine_device` is the
        // EP-agnostic map (like `cohere_device`), correct if the CPU force is ever lifted.
        let (device, device_id) = moonshine_device(&[Accelerator::Cpu]);
        let providers = [Accelerator::Cpu].iter().map(provider_label).collect();

        Ok(Self {
            model_name: cfg.model_name.clone(),
            encoder,
            decoder,
            decoder_with_past,
            tokenizer,
            providers,
            past_input_names,
            present_output_names,
            past_present_names,
            present_carry,
            past_present_carry,
            encoder_mask_name,
            decoder_enc_mask_name,
            past_enc_mask_name,
            past_enc_hidden_name,
            device,
            device_id,
            ready: true,
        })
    }

    /// Device `MemoryInfo` for binding the encoder output + KV-cache resident on the session's
    /// device (CPU today; Moonshine is CPU-forced). Cheap to build; one per encode + one per step.
    fn device_mem(&self) -> SttResult<MemoryInfo<'static>> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("device mem info: {e}")))
    }

    /// Run the encoder once over the whole utterance → **device-resident** `last_hidden_state`
    /// (`bind_output_to_device`, never copied to host). Moonshine eats the RAW waveform —
    /// `(1, num_samples)` straight through, no mel, no fixed window. The returned `DynValue` is
    /// rebound as both decoders' `encoder_hidden_states` every step with no host round-trip.
    fn encode(&mut self, audio: &[f32]) -> SttResult<DynValue> {
        let n = audio.len();
        let input = Tensor::from_array(([1usize, n], audio.to_vec().into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("encoder input_values: {e}")))?;
        // Built before the encoder borrow so the mask outlives the binding through `run_binding`.
        let mask = if self.encoder_mask_name.is_some() {
            Some(
                Tensor::from_array(([1usize, n], vec![1i64; n].into_boxed_slice()))
                    .map_err(|e| SttError::Inference(format!("encoder attention_mask: {e}")))?,
            )
        } else {
            None
        };
        let dev_mem = self.device_mem()?;
        let mut binding = self
            .encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("encoder binding: {e}")))?;
        binding
            .bind_input("input_values", &input)
            .map_err(|e| SttError::Inference(format!("bind input_values: {e}")))?;
        if let (Some(mask_name), Some(mask)) = (&self.encoder_mask_name, &mask) {
            binding
                .bind_input(mask_name.as_str(), mask)
                .map_err(|e| SttError::Inference(format!("bind encoder attention_mask: {e}")))?;
        }
        binding
            .bind_output_to_device("last_hidden_state", &dev_mem)
            .map_err(|e| SttError::Inference(format!("bind last_hidden_state: {e}")))?;
        let mut outputs = self
            .encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("encoder run_binding: {e}")))?;
        // DML/CUDA run_binding is async w.r.t. the device stream — block before handing the device
        // value to the decoder (no-op on CPU). Matches whisper.rs.
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("encoder synchronize: {e}")))?;
        outputs
            .remove("last_hidden_state")
            .ok_or_else(|| SttError::Inference("encoder produced no last_hidden_state".into()))
    }

    /// Greedy autoregressive decode for one waveform. Returns the full token sequence
    /// (prompt + generated, INCLUDING the trailing eos). Port of `moonshine.py::_decode_greedy`.
    ///
    /// The KV cache is carried **device-resident** in `past` (parallel to `past_input_names`):
    /// step 0's `decoder_model` seeds all 24 entries (decoder + encoder K/V); each cached step's
    /// `decoder_with_past_model` re-emits only the 12 decoder-self-attn `present.*`, so we overwrite
    /// those indices and KEEP the static encoder K/V. No entry ever round-trips through the host.
    fn decode_greedy(&mut self, encoder_out: &DynValue) -> SttResult<Vec<i64>> {
        let bos = self.tokenizer.bos_id;
        let eos = self.tokenizer.eos_id;
        // Encoder time axis (frames) for the optional all-ones cross-attention mask; read from the
        // device value's shape metadata (no host copy). last_hidden_state is (1, enc_T, 288).
        let enc_frames = encoder_dim1(encoder_out) as usize;

        let dev_mem = self.device_mem()?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("cpu mem info: {e}")))?;

        let mut tokens: Vec<i64> = vec![bos];

        // ── step 0: decoder_model.onnx (no past) seeds the KV cache device-resident ──
        let (mut next, mut past) =
            self.first_decode_step(encoder_out, &tokens, enc_frames, &dev_mem, &cpu_mem)?;
        tokens.push(next);

        while tokens.len() < MAX_LENGTH && next != eos {
            next = self.past_decode_step(
                encoder_out,
                next,
                &mut past,
                enc_frames,
                &dev_mem,
                &cpu_mem,
            )?;
            tokens.push(next);
        }

        Ok(tokens)
    }

    /// Run `decoder_model.onnx` (step 0, no past). Binds the device-resident encoder output +
    /// `logits`→host / all 24 `present.*`→device in a fresh binding, argmaxes the last-position
    /// logits, and returns `(next_token, past)` where `past` is the carried KV as device
    /// `DynValue`s parallel to `past_input_names` (`present.X` → `past_key_values.X` by name).
    fn first_decode_step(
        &mut self,
        encoder_out: &DynValue,
        prompt: &[i64],
        enc_frames: usize,
        dev_mem: &MemoryInfo<'_>,
        cpu_mem: &MemoryInfo<'_>,
    ) -> SttResult<(i64, Vec<Option<DynValue>>)> {
        let input_ids =
            Tensor::from_array(([1usize, prompt.len()], prompt.to_vec().into_boxed_slice()))
                .map_err(|e| SttError::Inference(format!("decoder input_ids: {e}")))?;
        // Held here so it outlives the binding through `run_binding`.
        let enc_mask = self.decoder_enc_mask_name.as_ref().map(|_| {
            Tensor::from_array((
                [1usize, enc_frames],
                vec![1i64; enc_frames].into_boxed_slice(),
            ))
            .map_err(|e| SttError::Inference(format!("decoder enc mask: {e}")))
        });
        let enc_mask = enc_mask.transpose()?;

        let mut binding = self
            .decoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("decoder binding: {e}")))?;
        binding
            .bind_input("input_ids", &input_ids)
            .map_err(|e| SttError::Inference(format!("bind input_ids: {e}")))?;
        binding
            .bind_input("encoder_hidden_states", encoder_out)
            .map_err(|e| SttError::Inference(format!("bind encoder_hidden_states: {e}")))?;
        if let (Some(mask_name), Some(mask)) = (&self.decoder_enc_mask_name, &enc_mask) {
            binding
                .bind_input(mask_name.as_str(), mask)
                .map_err(|e| SttError::Inference(format!("bind decoder enc mask: {e}")))?;
        }
        binding
            .bind_output_to_device("logits", cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
        for pname in &self.present_output_names {
            binding
                .bind_output_to_device(pname.as_str(), dev_mem)
                .map_err(|e| SttError::Inference(format!("bind {pname}: {e}")))?;
        }

        let mut outputs = self
            .decoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("decoder run (step 0): {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("decoder synchronize: {e}")))?;

        let next = argmax_from_outputs(&outputs)?;

        // Carry present.{layer}.{decoder|encoder}.{key|value} → past_key_values.<same suffix> as
        // DEVICE values (session-owned, survive the binding drop → rebind next step). Parallel to
        // `past_input_names`; every entry is populated on step 0. The `present_carry` map is
        // precomputed at load so this borrows nothing off `self` (which `outputs` holds mutably).
        let mut past: Vec<Option<DynValue>> =
            (0..self.past_input_names.len()).map(|_| None).collect();
        for (present_name, idx) in &self.present_carry {
            past[*idx] = Some(outputs.remove(present_name.as_str()).ok_or_else(|| {
                SttError::Inference(format!("decoder produced no {present_name}"))
            })?);
        }
        drop(outputs);
        drop(binding);

        Ok((next, past))
    }

    /// Run `decoder_with_past_model.onnx` for one autoregressive step. Feeds the last token + the
    /// full device-resident KV state; binds `logits`→host / the 12 decoder-self-attn `present.*`
    /// →device, argmaxes, and overwrites ONLY those decoder-K/V entries in `past` (the static
    /// encoder K/V from step 0 is kept — the past-step graph doesn't re-emit it). Returns the next
    /// token; `past` is mutated in place. Nothing round-trips through the host.
    fn past_decode_step(
        &mut self,
        encoder_out: &DynValue,
        next_token: i64,
        past: &mut [Option<DynValue>],
        enc_frames: usize,
        dev_mem: &MemoryInfo<'_>,
        cpu_mem: &MemoryInfo<'_>,
    ) -> SttResult<i64> {
        let input_ids = Tensor::from_array(([1usize, 1usize], vec![next_token].into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("past input_ids: {e}")))?;
        // Held here so it outlives the binding through `run_binding`.
        let enc_mask = self.past_enc_mask_name.as_ref().map(|_| {
            Tensor::from_array((
                [1usize, enc_frames],
                vec![1i64; enc_frames].into_boxed_slice(),
            ))
            .map_err(|e| SttError::Inference(format!("past enc mask: {e}")))
        });
        let enc_mask = enc_mask.transpose()?;

        let mut binding = self
            .decoder_with_past
            .create_binding()
            .map_err(|e| SttError::Inference(format!("decoder_with_past binding: {e}")))?;
        binding
            .bind_input("input_ids", &input_ids)
            .map_err(|e| SttError::Inference(format!("bind past input_ids: {e}")))?;
        // Only fed when the re-export declares them.
        if let (Some(mask_name), Some(mask)) = (&self.past_enc_mask_name, &enc_mask) {
            binding
                .bind_input(mask_name.as_str(), mask)
                .map_err(|e| SttError::Inference(format!("bind past enc mask: {e}")))?;
        }
        if let Some(hidden_name) = &self.past_enc_hidden_name {
            binding
                .bind_input(hidden_name.as_str(), encoder_out)
                .map_err(|e| SttError::Inference(format!("bind past enc_hidden: {e}")))?;
        }
        // past_key_values.* : device value carried from the previous step.
        for (i, name) in self.past_input_names.iter().enumerate() {
            let v = past[i]
                .as_ref()
                .ok_or_else(|| SttError::Inference(format!("missing carried KV {name}")))?;
            binding
                .bind_input(name.as_str(), v)
                .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
        }
        binding
            .bind_output_to_device("logits", cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind past logits: {e}")))?;
        for pname in &self.past_present_names {
            binding
                .bind_output_to_device(pname.as_str(), dev_mem)
                .map_err(|e| SttError::Inference(format!("bind {pname}: {e}")))?;
        }

        let mut outputs = self
            .decoder_with_past
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("decoder_with_past run: {e}")))?;
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("decoder_with_past synchronize: {e}")))?;

        let next = argmax_from_outputs(&outputs)?;

        // Overwrite only the decoder-self-attn present.* the past-step graph re-emits (the static
        // encoder K/V stays as seeded in step 0). Extracted values are session-owned and survive the
        // binding drop. Uses the precomputed `past_present_carry` map (borrows only that field, not
        // all of `self`, which `outputs` holds mutably via `self.decoder_with_past`).
        for (present_name, idx) in &self.past_present_carry {
            past[*idx] = Some(outputs.remove(present_name.as_str()).ok_or_else(|| {
                SttError::Inference(format!("past decoder produced no {present_name}"))
            })?);
        }
        drop(outputs);
        drop(binding);

        Ok(next)
    }
}

impl Transcriber for MoonshineEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::Moonshine
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_ready(&self) -> bool {
        self.ready
    }

    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let encoder_out = self.encode(audio)?;
        let tokens = self.decode_greedy(&encoder_out)?;
        // Strip the leading bos before rendering (moonshine.py: `tokens[0, 1:]`).
        let body: &[i64] = if tokens.first().copied() == Some(self.tokenizer.bos_id) {
            &tokens[1..]
        } else {
            &tokens
        };
        let text = self.tokenizer.decode_text(body);
        Ok(Transcription {
            text,
            segments: None,
            words: None,
        })
    }

    fn shutdown(&mut self) {
        self.ready = false;
    }
}

// ---------------------------------------------------------------------------
// Tokenizer (SentencePiece byte-fallback BPE parsed from tokenizer.json)
// ---------------------------------------------------------------------------

/// Moonshine's SentencePiece byte-fallback tokenizer, parsed straight from `tokenizer.json`
/// (no `tokenizers`/`sentencepiece` dependency — we only need id → text). Port of
/// `moonshine.py::_load_tokenizer` + `_decode_text`.
struct MoonshineTokenizer {
    id_to_token: HashMap<i64, String>,
    special_token_ids: std::collections::HashSet<i64>,
    bos_id: i64,
    eos_id: i64,
}

impl MoonshineTokenizer {
    fn load(tokenizer_path: &Path, tokenizer_config_path: Option<&Path>) -> SttResult<Self> {
        let raw = std::fs::read_to_string(tokenizer_path)
            .map_err(|e| SttError::Tokenizer(format!("read {}: {e}", tokenizer_path.display())))?;
        let tok: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| SttError::Tokenizer(format!("parse tokenizer.json: {e}")))?;

        let mut id_to_token: HashMap<i64, String> = HashMap::new();
        let mut special_token_ids: std::collections::HashSet<i64> =
            std::collections::HashSet::new();
        let mut bos_id: Option<i64> = None;
        let mut eos_id: Option<i64> = None;

        // model.vocab is `{piece: id}` for a BPE model (rust-tokenizers canonical layout).
        if let Some(vocab) = tok.get("model").and_then(|m| m.get("vocab")) {
            if let Some(map) = vocab.as_object() {
                for (piece, idx) in map {
                    if let Some(id) = idx.as_i64() {
                        id_to_token.insert(id, piece.clone());
                    }
                }
            } else if let Some(list) = vocab.as_array() {
                // SentencePiece-unigram fallback: a list of [piece, score] (or bare pieces).
                for (i, entry) in list.iter().enumerate() {
                    let piece = entry
                        .as_array()
                        .and_then(|a| a.first())
                        .and_then(|p| p.as_str())
                        .or_else(|| entry.as_str())
                        .unwrap_or("");
                    id_to_token.insert(i as i64, piece.to_string());
                }
            }
        }

        // added_tokens (specials + the <<ST_*>> timestamp markers) live OUTSIDE model.vocab.
        if let Some(added) = tok.get("added_tokens").and_then(|a| a.as_array()) {
            for entry in added {
                let Some(tid) = entry.get("id").and_then(|x| x.as_i64()) else {
                    continue;
                };
                let content = entry
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let special = entry
                    .get("special")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false);
                if content == "<s>" {
                    bos_id = Some(tid);
                } else if content == "</s>" {
                    eos_id = Some(tid);
                }
                id_to_token.insert(tid, content);
                if special {
                    special_token_ids.insert(tid);
                }
            }
        }

        // tokenizer_config.json's added_tokens_decoder is the same data in a slightly different
        // shape — read as a belt-and-braces fallback (a variant might ship only one file).
        if let Some(cfg_path) = tokenizer_config_path
            && let Ok(cfg_raw) = std::fs::read_to_string(cfg_path)
            && let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&cfg_raw)
            && let Some(atd) = cfg.get("added_tokens_decoder").and_then(|a| a.as_object())
        {
            for (tid_str, entry) in atd {
                let Ok(tid) = tid_str.parse::<i64>() else {
                    continue;
                };
                let content = entry
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let special = entry
                    .get("special")
                    .and_then(|s| s.as_bool())
                    .unwrap_or(false);
                id_to_token.entry(tid).or_insert_with(|| content.clone());
                if special {
                    special_token_ids.insert(tid);
                }
                if content == "<s>" && bos_id.is_none() {
                    bos_id = Some(tid);
                } else if content == "</s>" && eos_id.is_none() {
                    eos_id = Some(tid);
                }
            }
        }

        Ok(Self {
            id_to_token,
            special_token_ids,
            // Canonical Moonshine ids if the JSON didn't name the tokens (<s>=1, </s>=2).
            bos_id: bos_id.unwrap_or(1),
            eos_id: eos_id.unwrap_or(2),
        })
    }

    /// Render decoder token ids → plain text. Mirrors the JSON `decoder` chain shipped in
    /// `tokenizer.json` (Replace ▁→space, ByteFallback, Fuse, Strip ONE leading space), exactly
    /// like `moonshine.py::_decode_text`:
    ///   1. id → piece (skip ids flagged special — bos/eos/<<ST_*>> contribute no characters);
    ///   2. byte-fallback: pieces `<0xNN>` buffer a raw byte, decoded as UTF-8 when the run breaks;
    ///   3. ▁ (U+2581) → ASCII space;
    ///   4. strip the single SentencePiece-prepended leading space.
    fn decode_text(&self, ids: &[i64]) -> String {
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut out = String::new();

        let flush = |byte_buf: &mut Vec<u8>, out: &mut String| {
            if !byte_buf.is_empty() {
                out.push_str(&String::from_utf8_lossy(byte_buf));
                byte_buf.clear();
            }
        };

        for &tid in ids {
            if self.special_token_ids.contains(&tid) {
                flush(&mut byte_buf, &mut out);
                continue;
            }
            let Some(piece) = self.id_to_token.get(&tid) else {
                flush(&mut byte_buf, &mut out);
                continue;
            };
            // Byte-fallback pieces: `<0xNN>` (exactly 6 chars: `<0x` + 2 hex + `>`).
            let bytes = piece.as_bytes();
            if bytes.len() == 6
                && piece.starts_with("<0x")
                && piece.ends_with('>')
                && let Ok(b) = u8::from_str_radix(&piece[3..5], 16)
            {
                byte_buf.push(b);
                continue;
            }
            flush(&mut byte_buf, &mut out);
            out.push_str(piece);
        }
        flush(&mut byte_buf, &mut out);

        let text = out.replace(SP_SPACE, " ");
        text.strip_prefix(' ')
            .map(|s| s.to_string())
            .unwrap_or(text)
    }
}

// ---------------------------------------------------------------------------
// Session construction + ORT helpers (provider/argmax/KV helpers are shared in `super`)
// ---------------------------------------------------------------------------

/// Build one ORT session, CPU-ONLY (see `load()`: the KV decode loses to CPU on DML for this tiny
/// model — the per-step device launch/transfer overhead dominates). Moonshine keeps full
/// optimization (no fp16 EXTENDED downgrade — it isn't in INT8_PREFERRED / DML_INCOMPATIBLE and the
/// default export is fp32).
fn build_session(path: &Path, intra: usize) -> SttResult<Session> {
    let mut builder = configure_session(
        GraphOptimizationLevel::All,
        Some(intra),
        false,
        Some(&[Accelerator::Cpu]),
    )
    .map_err(SttError::SessionCreate)?;
    builder
        .commit_from_file(path)
        .map_err(|e| SttError::SessionCreate(format!("commit {}: {e}", path.display())))
}

/// Return the session input name matching `name` exactly, if the graph declares it.
fn input_named(session: &Session, name: &str) -> Option<String> {
    session
        .inputs()
        .iter()
        .find(|o| o.name() == name)
        .map(|o| o.name().to_string())
}

/// The `AllocationDevice` (+ id) the sessions run on, for IoBinding the encoder output + KV-cache
/// resident on it (like `cohere_device` / whisper's `device_for_providers`). Derived from the FIRST
/// requested accelerator; Moonshine is CPU-forced so this is CPU today, but the map stays EP-agnostic
/// (DirectML/CUDA → that device) if the force is ever lifted. (No WEBGPU arm yet.)
fn moonshine_device(providers: &[Accelerator]) -> (AllocationDevice, i32) {
    match providers.first() {
        Some(Accelerator::DirectMl) => (AllocationDevice::DIRECTML, 0),
        Some(Accelerator::Cuda) => (AllocationDevice::CUDA, 0),
        _ => (AllocationDevice::CPU, 0),
    }
}

/// The encoder time-axis length (dim 1) of the device-resident `last_hidden_state`, read from the
/// value's shape metadata (no host copy). Used to size the optional all-ones cross-attention mask.
fn encoder_dim1(v: &DynValue) -> i64 {
    match v.dtype() {
        ort::value::ValueType::Tensor { shape, .. } => shape.get(1).copied().unwrap_or(0).max(0),
        _ => 0,
    }
}

/// Extract the (host-bound) `logits` from a bound decode step and argmax its last position → next
/// token. Kept host-side transiently (the only value that leaves the device each step, exactly like
/// `whisper.rs`); the KV cache stays device-resident.
fn argmax_from_outputs(outputs: &ort::session::SessionOutputs<'_>) -> SttResult<i64> {
    let v = outputs
        .get("logits")
        .ok_or_else(|| SttError::Inference("decoder produced no logits".into()))?;
    let (shape, data) = v
        .try_extract_tensor::<f32>()
        .map_err(|e| SttError::Inference(format!("logits extract: {e}")))?;
    Ok(argmax_last(data, shape))
}

/// argmax over the LAST decoder position of a `(1, seq, vocab)` logits tensor. Empty → 0.
fn argmax_last(data: &[f32], shape: &[i64]) -> i64 {
    let vocab = shape.last().copied().unwrap_or(0).max(0) as usize;
    if vocab == 0 || data.is_empty() {
        return 0;
    }
    let seq = if shape.len() >= 2 {
        shape[shape.len() - 2].max(1) as usize
    } else {
        1
    };
    let last_off = seq.saturating_sub(1) * vocab;
    let slice = &data[last_off..(last_off + vocab).min(data.len())];
    super::families::argmax_1d(slice).0 as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tk_with(pairs: &[(i64, &str)], specials: &[i64]) -> MoonshineTokenizer {
        let mut id_to_token = HashMap::new();
        for &(id, p) in pairs {
            id_to_token.insert(id, p.to_string());
        }
        MoonshineTokenizer {
            id_to_token,
            special_token_ids: specials.iter().copied().collect(),
            bos_id: 1,
            eos_id: 2,
        }
    }

    #[test]
    fn decode_maps_underscore_to_space_and_strips_leading() {
        // "▁And ▁so" style: leading ▁ becomes a leading space then is stripped.
        let tk = tk_with(
            &[
                (10, "\u{2581}And"),
                (11, "\u{2581}so"),
                (1, "<s>"),
                (2, "</s>"),
            ],
            &[1, 2],
        );
        assert_eq!(tk.decode_text(&[10, 11]), "And so");
        // bos/eos are special → contribute nothing.
        assert_eq!(tk.decode_text(&[1, 10, 11, 2]), "And so");
    }

    #[test]
    fn decode_byte_fallback_assembles_utf8() {
        // '€' = E2 82 AC in UTF-8 → three <0xNN> byte pieces fused.
        let tk = tk_with(
            &[
                (3, "<0xE2>"),
                (4, "<0x82>"),
                (5, "<0xAC>"),
                (10, "\u{2581}x"),
            ],
            &[],
        );
        // "▁x" then the euro bytes → "x€".
        assert_eq!(tk.decode_text(&[10, 3, 4, 5]), "x€");
    }

    #[test]
    fn argmax_last_picks_last_position() {
        // shape (1, 2, 3): two positions; the LAST one's argmax is index 0 here.
        let data = vec![0.1, 0.9, 0.3, /*pos1:*/ 5.0, 1.0, 2.0];
        assert_eq!(argmax_last(&data, &[1, 2, 3]), 0);
        // single position (1,1,3): argmax index 2.
        assert_eq!(argmax_last(&[0.1, 0.2, 0.9], &[1, 1, 3]), 2);
        // empty / zero-vocab → 0.
        assert_eq!(argmax_last(&[], &[1, 0, 0]), 0);
    }

    #[test]
    fn kv_sort_orders_present_and_past() {
        let mut names = [
            "present.10.encoder.value".to_string(),
            "past_key_values.2.decoder.key".to_string(),
            "present.2.decoder.value".to_string(),
            "past_key_values.2.encoder.key".to_string(),
        ];
        names.sort_by_key(|n| kv_sort_key(n));
        assert_eq!(names[0], "past_key_values.2.decoder.key");
        assert_eq!(names[1], "present.2.decoder.value");
        assert_eq!(names[2], "past_key_values.2.encoder.key");
        assert_eq!(names[3], "present.10.encoder.value");
    }
}
