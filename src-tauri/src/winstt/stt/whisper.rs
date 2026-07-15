// Source (decode correctness): onnx-asr fork src/onnx_asr/models/whisper/_hf.py + _base.py
//   (<onnx-asr>/src/onnx_asr/models/whisper/).
// Source (load fixes): server/src/recorder/infrastructure/onnxasr_transcriber.py
//   (fp16 decoder repair §6.1, ORT_ENABLE_EXTENDED §6.2, .en prompt-slot §6.3, vocab.get §6.4).
// Source (ort API, verified against the installed crate src):
//   ort-2.0.0-rc.12/src/{session/mod.rs,session/input.rs,session/output.rs,
//   value/type.rs,value/impl_tensor/{create.rs,extract.rs,shape.rs}}.
//     * Session::builder() -> SessionBuilder; .with_execution_providers(impl AsRef<[EPDispatch]>)
//       -> .with_optimization_level(GraphOptimizationLevel::{Level2,Level3}) -> .with_intra_threads(usize)
//       -> .commit_from_file(path) -> Session.
//     * Session::run(impl Into<SessionInputs>) -> SessionOutputs; a Vec<(Cow<str>, SessionInputValue)>
//       Into<SessionInputs> (input.rs:62). SessionInputValue: From<Value<T>> and From<ValueRef<T>>.
//     * value::Tensor::from_array((shape, Box<[T]>)) -> Tensor<T>; TensorRef::from_array_view((shape, &[T])).
//     * SessionOutputs::get(name) -> Option<&DynValue>; DynValue::try_extract_tensor::<f32>()
//       -> Result<(&Shape, &[f32])>; Shape derefs to [i64].
//     * Session::{inputs(),outputs()} -> &[Outlet]; Outlet::{name(),dtype()->&ValueType};
//       ValueType::Tensor { ty, shape, dimension_symbols }.
//
// The Whisper / lite-whisper / distil-whisper ONNX engine — the dictation core.
//
// Topology (Optimum split export):
//   * encoder_model{_q}.onnx        : input_features (1, n_mels, T) → last_hidden_state
//   * decoder_model_merged{_q}.onnx : autoregressive decoder with an optional
//     `use_cache_branch` flag + past_key_values.* inputs / present.* outputs, and
//     (for `*_timestamped` exports) cross_attentions.* outputs.
//
// Decode is a greedy KV-cache loop, ONE token per cached step (multi-token-per-call is
// broken on these merged-decoder exports — memory project_onnx_whisper_cache_bug). lite-whisper
// is byte-identical here: same decoder graph, only the encoder is the low-rank/factorized
// variant which loads as-is.
//
// PERF/CORRECTNESS NOTE: decode binds the encoder output + past/present KV **device-resident**
// via ort's IoBinding (session/io_binding.rs), faithful to onnx-asr `_hf.py` `_encode`/`_decode`
// (`bind_ortvalue_input` / `bind_output(..., device)`). The earlier host-copy `Session::run` path
// `.to_vec()`'d the encoder output AND every present.* KV back to host every token and re-fed them
// — on DirectML that host↔device round-trip per layer per step was both catastrophically slow
// (~14s vs 2.5s CPU for whisper-tiny on the JFK clip) AND *corrupted* the cache (DML produced pure
// token garbage). Keeping them on-device fixes both: only `input_ids` (1 token) goes host→device and
// `logits` comes host-side for argmax — exactly as the Python reference does. A fresh binding is
// created per step (mirrors onnx-asr's per-`_decode` `io_binding()`); the device present.* outputs
// are extracted as session-owned `DynValue`s (survive the binding drop) and rebound next step.

mod degenerate;
mod loader;
mod ort_shapes;
mod token_select;

use std::path::Path;
use std::time::Instant;

use ort::memory::{AllocationDevice, Allocator, AllocatorType, MemoryInfo, MemoryType};
use ort::session::{IoBinding, Session};
use ort::value::{DynValue, Tensor};

use degenerate::{
    DML_DEGENERATE_BLOCK_THRESHOLD, DML_PROVIDER_LABEL, mark_directml_degenerate_model,
};
use loader::{build_session, load_decoder_with_fp16_repair};
use ort_shapes::{
    device_for_providers, first_dim, kv_head_dim, read_config_usize, read_whisper_head_dims,
};
use token_select::{
    NO_REPEAT_NGRAM_SIZE, build_suppress_token_mask, fill_no_repeat_ngram_banned,
    select_whisper_token, select_whisper_token_from_allowed,
};

use super::mel::{HOP_LENGTH, MelExtractor, N_FRAMES};
use super::whisper_tokenizer::WhisperTokenizer;
use super::{
    Accelerator, EngineConfig, EngineKind, Segment, SttError, SttResult, TranscribeOptions,
    Transcriber, Transcription, WordResult, kv_sort_key, num_cpus_best_effort as num_cpus,
    provider_label,
};
use crate::winstt::word_timestamps::{self, AlignArgs, CrossAttentions, lookup_alignment_heads};

/// Re-export so `stt::whisper::directml_degenerate_model_blocked` (backend.rs) keeps resolving.
pub(crate) use degenerate::directml_degenerate_model_blocked;

/// Stage-timing diagnostics, printed to stderr when `WINSTT_WHISPER_PROFILE` is set (spike/bench runs
/// only — never in the shipped hot path unless the user opts in). Mirrors `WINSTT_COHERE_PROFILE`.
/// Reports mel+encode ms, decode ms, decoded token count, and per-token decode cost — the numbers that
/// decide whether the encoder-DML/decoder-CPU hybrid is worth it for a given model.
fn profile_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("WINSTT_WHISPER_PROFILE").is_ok())
}

/// Maximum decoder length (Whisper's hard cap). The loop also stops on all-EOS.
const MAX_LENGTH: usize = 448;
const WARMUP_DECODE_STEPS: usize = 8;

/// Dynamic-length encoder buckets (mel frames; 100 frames = 1 s). A dynlen-capable encoder
/// (dynamic `input_features` T — the `posfix` sliced positional embedding) encodes only the
/// smallest bucket that holds the utterance + tail pad instead of always paying the 30 s
/// window (whisper.cpp `audio_ctx` / sherpa-onnx tail-padding; ~3× encoder cut on short
/// dictation, WER-neutral per whisper.cpp #1855 and our fixture sweep). Floor is 1000 (10 s):
/// a 5 s window measurably degenerates (repetition loops — the decoder was trained against a
/// 30 s cross-attention memory and needs slack). Few, coarse buckets on purpose: the DirectML
/// EP re-fuses per input shape and caches ONE compiled shape, so every distinct bucket that
/// appears costs one re-fusion when it displaces another.
const ENC_BUCKETS: &[usize] = &[1000, 2000, 3000];
/// Tail padding (mel frames) appended past the audio before bucket rounding — the "silence"
/// region the decoder emits EOT into (whisper.cpp uses +128 post-conv ≈ 256 mel; sherpa-onnx
/// defaults to a generous 1000). 250 (2.5 s) sits between them and validated clean.
const ENC_TAIL_PAD_FRAMES: usize = 250;

/// Pick the mel-frame count to encode for `n_audio_frames` of real signal: the smallest
/// bucket that fits audio + tail pad, else the full 30 s window.
fn enc_bucket_frames(n_audio_frames: usize) -> usize {
    let want = n_audio_frames.saturating_add(ENC_TAIL_PAD_FRAMES);
    for &b in ENC_BUCKETS {
        if want <= b {
            return b;
        }
    }
    *ENC_BUCKETS.last().unwrap_or(&3000)
}

/// A loaded Whisper-family engine (covers `EngineKind::WhisperHf`). Holds the two ORT
/// sessions, the parsed tokenizer, the mel front-end, and the per-load capability flags.
pub struct WhisperEngine {
    model_name: String,
    encoder: Option<Session>,
    decoder: Option<Session>,
    tokenizer: WhisperTokenizer,
    mel: MelExtractor,
    providers: Vec<String>,
    /// Sorted `past_key_values.*` decoder input names (canonical layer order).
    past_kv_names: Vec<String>,
    /// (num_heads, head_dim) per past-kv name, read from the decoder graph at load.
    kv_dims: Vec<(i64, i64)>,
    has_use_cache_branch: bool,
    has_cross_attention: bool,
    /// Sorted `cross_attentions.*` decoder output names (canonical layer 0..N-1 order),
    /// empty unless this is a `*_timestamped` export. Mirrors `_hf.py`
    /// `_cross_attention_output_names` (sorted by trailing integer layer index).
    cross_attn_names: Vec<String>,
    /// Device the sessions run on, for binding the encoder output + KV-cache device-resident
    /// (mirrors onnx-asr `_hf.py` `get_onnx_device`). `CPU` when no GPU EP is active; then
    /// IoBinding simply binds host memory (still correct, ~same speed as the old host path).
    device: AllocationDevice,
    device_id: i32,
    suppress_token_mask: Vec<bool>,
    /// True when the encoder graph accepts a variable mel-frame count (dim 2 of
    /// `input_features` is symbolic — the dynlen-patched export). Enables the short-window
    /// bucket path in `encode`; the stock static-3000 export always gets the full window.
    enc_dynlen: bool,
    ready: bool,
}

/// Loop-carried state for one `decode_inner` run (mirrors onnx-asr's per-`recognize` state).
/// Built once by `prepare_decode_state` and threaded `&mut` through `decode_step` so the hot
/// loop body allocates nothing across the step boundary. `decode_inner` owns it on the stack.
struct DecodeState {
    /// Full token sequence: prompt + generated (incl. trailing eos). Grown one token per step.
    tokens: Vec<i64>,
    /// Number of decoder-prompt tokens at the head of `tokens` (the generated region starts here).
    prompt_len: usize,
    /// Device `MemoryInfo` for re-binding the `present.*` outputs each step (CPU when no GPU EP).
    dev_mem: MemoryInfo,
    /// Host `MemoryInfo` for the logits (argmax) and, when collecting, the cross-attention.
    cpu_mem: MemoryInfo,
    /// ONE IoBinding reused for every step of this decode (optimum keeps one per session;
    /// the old fresh-binding-per-step pattern re-bound all ~20 inputs + ~17 outputs each token).
    /// Rebinding by name REPLACES the prior entry, so each step rebinds only what changed:
    /// `input_ids`, the flipped `use_cache_branch`, and the carried self-attn KV entries.
    binding: IoBinding,
    /// Pre-created `use_cache_branch=true` flag tensor, bound once at step 1 (the step-0 `false`
    /// tensor is bound in `prepare_decode_state`; the binding keeps bound values alive).
    flag_true: Tensor<bool>,
    /// `present.*` output names, parallel to `past_kv_names` (canonical layer order).
    present_names: Vec<String>,
    /// Carried KV cache as DEVICE-resident OrtValues; `None` = the (0,H,0,D) empty step-0 cache.
    past: Vec<Option<DynValue>>,
    /// Which `past` entries were replaced since their last bind (must be rebound this step).
    /// Encoder (cross-attn) KV settles after step 0 and is never rebound again.
    past_dirty: Vec<bool>,
    /// Reused no-repeat-ngram ban list for the generated region.
    banned_tokens: Vec<i64>,
    /// Whether to collect cross-attention this run (`*_timestamped` export + caller requested).
    want_attn: bool,
    /// Per-layer running cross-attention buffers: each entry is (heads, dec_step_len, frames) FLAT
    /// data, one per decode step. Concatenated along the decoder-token axis at the end.
    per_layer_steps: Vec<Vec<Vec<f32>>>,
    /// Cross-attention head/frame counts, resolved at the FIRST step from the actual output shapes.
    ca_heads: usize,
    ca_frames: usize,
    /// Step-0 peek for the garbage detector: (argmax token, top logit, runner-up logit).
    step0: Option<(i64, f32, f32)>,
}

impl DecodeState {
    /// Stack the collected per-layer per-step attention into one dense
    /// (num_layers, num_heads, num_dec_tokens, num_enc_frames) buffer in CrossAttentions's
    /// canonical layout. The per-step `dec_step_len` segments concatenate along the token axis
    /// in generation order (step 0's prompt rows first, then one row per subsequent step) — the
    /// same order the decoder tokens themselves were produced, so token row i lines up with
    /// `tokens[i]`. Mirrors `np.concatenate(steps, axis=2)` then `np.stack(layers, axis=1)`.
    fn stack_cross_attentions(&self) -> Option<CrossAttentions> {
        if !(self.want_attn
            && self.ca_heads > 0
            && self.ca_frames > 0
            && !self.per_layer_steps[0].is_empty())
        {
            return None;
        }
        let n_layers = self.per_layer_steps.len();
        let (ca_heads, ca_frames) = (self.ca_heads, self.ca_frames);
        // Total decoder tokens = sum of each step's dec_step_len for layer 0.
        let total_tokens: usize = self.per_layer_steps[0]
            .iter()
            .map(|step| step.len() / (ca_heads * ca_frames).max(1))
            .sum();
        let mut ca = CrossAttentions::new(n_layers, ca_heads, total_tokens, ca_frames);
        for (li, steps) in self.per_layer_steps.iter().enumerate() {
            let mut tok_base = 0usize; // running decoder-token offset across steps
            for step in steps {
                // step is (heads, dec_step_len, frames) row-major.
                let step_tokens = step.len() / (ca_heads * ca_frames).max(1);
                for h in 0..ca_heads {
                    for t in 0..step_tokens {
                        for fr in 0..ca_frames {
                            let src = (h * step_tokens + t) * ca_frames + fr;
                            ca.set(li, h, tok_base + t, fr, step[src]);
                        }
                    }
                }
                tok_base += step_tokens;
            }
        }
        Some(ca)
    }
}

impl WhisperEngine {
    /// Build both sessions from a resolved file set. Applies the fp16 decoder repair and
    /// the `ORT_ENABLE_EXTENDED` downgrade when `cfg.whisper_fp16_workaround` is set.
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let files = &cfg.resolved.files;
        let get = |k: &str| -> SttResult<&Path> {
            files
                .get(k)
                .map(|p| p.as_path())
                .ok_or_else(|| SttError::Resolve(format!("whisper: missing resolved file '{k}'")))
        };
        let encoder_path = get("encoder")?;
        let decoder_path = get("decoder")?;
        let vocab_path = get("vocab")?;
        let added_tokens_path = files.get("added_tokens").map(|p| p.as_path());

        let tokenizer = WhisperTokenizer::load(vocab_path, added_tokens_path)?;

        // n_mels resolution order: explicit "num_mel_bins" pseudo-entry → the
        // config.json `num_mel_bins` (the resolver provides a "config" path; else the sibling
        // of vocab.json) → 80 (every export except large-v3 = 128). Getting this wrong silently
        // breaks 128-mel models loaded through the live resolver path (they'd run at 80 mel).
        let n_mels = files
            .get("num_mel_bins")
            .and_then(|p| p.to_str())
            .and_then(|s| s.parse::<usize>().ok())
            .or_else(|| {
                let cfg = files
                    .get("config")
                    .map(|p| p.to_path_buf())
                    .or_else(|| vocab_path.parent().map(|d| d.join("config.json")))?;
                read_config_usize(&cfg, "num_mel_bins")
            })
            .unwrap_or(80);
        let mel = MelExtractor::new(n_mels);

        let is_gpu = cfg
            .providers
            .first()
            .is_some_and(|a| !matches!(a, Accelerator::Cpu));
        let intra = super::pick_intra_op_threads(is_gpu, num_cpus());

        let encoder = build_session(encoder_path, cfg, intra, cfg.whisper_fp16_workaround)?;
        let decoder = load_decoder_with_fp16_repair(decoder_path, cfg, intra)?;

        // Dynamic-length capability probe: a dynlen-patched encoder declares `input_features`
        // dim 2 (mel frames) symbolically; the stock Optimum export pins it at 3000. Opt-out via
        // WINSTT_WHISPER_NO_DYNLEN (mirrors WINSTT_COHERE_NO_ENC_PAD).
        let enc_dynlen = std::env::var("WINSTT_WHISPER_NO_DYNLEN").is_err()
            && encoder
                .inputs()
                .iter()
                .find(|o| o.name() == "input_features")
                .is_some_and(|o| match o.dtype() {
                    ort::value::ValueType::Tensor { shape, .. } => {
                        shape.get(2).copied().unwrap_or(0) <= 0
                    }
                    _ => false,
                });

        // Introspect the decoder graph (inputs()/outputs() return &[Outlet]).
        let mut past_kv_names: Vec<String> = decoder
            .inputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("past_key_values."))
            .collect();
        past_kv_names.sort_by_key(|n| kv_sort_key(n));
        let mut kv_dims: Vec<(i64, i64)> = past_kv_names
            .iter()
            .map(|n| kv_head_dim(&decoder, n))
            .collect();
        // Optimum exports often declare past_key_values dims (num_heads, head_dim) as
        // SYMBOLIC — ort reports those as 0/-1 (unlike onnxruntime-python, which yields the
        // concrete ints). The empty step-0 cache must still be (0, num_heads, 0, head_dim)
        // or the merged decoder's If-node branch shapes mismatch. Fall back to config.json
        // (sibling of vocab.json): decoder_attention_heads + d_model/heads.
        if kv_dims.iter().any(|&(h, d)| h <= 0 || d <= 0)
            && let Some((h, d)) = read_whisper_head_dims(vocab_path)
        {
            for kv in kv_dims.iter_mut() {
                if kv.0 <= 0 {
                    kv.0 = h;
                }
                if kv.1 <= 0 {
                    kv.1 = d;
                }
            }
        }

        let has_use_cache_branch = decoder
            .inputs()
            .iter()
            .any(|o| o.name() == "use_cache_branch");
        // Collect + sort the `cross_attentions.{i}` output names by the trailing integer layer
        // index (canonical layer-0..N-1 order), exactly like `_hf.py::_cross_attention_output_names`.
        let mut cross_attn_names: Vec<String> = decoder
            .outputs()
            .iter()
            .map(|o| o.name().to_string())
            .filter(|n| n.starts_with("cross_attentions."))
            .collect();
        cross_attn_names.sort_by_key(|n| {
            n.trim_start_matches("cross_attentions.")
                .parse::<i64>()
                .unwrap_or(i64::MAX)
        });
        let has_cross_attention = !cross_attn_names.is_empty();

        if std::env::var("WINSTT_STT_DEBUG").is_ok() {
            eprintln!(
                "[whisper] {} past_kv tensors; dims[0]={:?}; use_cache_branch={}; cross_attn={}; multilingual={}",
                past_kv_names.len(),
                kv_dims.first(),
                has_use_cache_branch,
                has_cross_attention,
                tokenizer.is_multilingual
            );
        }

        let providers = cfg.providers.iter().map(provider_label).collect();
        let (device, device_id) = device_for_providers(&cfg.providers);
        let suppress_token_mask = build_suppress_token_mask(tokenizer.vocab_size() as usize);

        Ok(Self {
            model_name: cfg.model_name.clone(),
            encoder: Some(encoder),
            decoder: Some(decoder),
            tokenizer,
            mel,
            providers,
            past_kv_names,
            kv_dims,
            has_use_cache_branch,
            has_cross_attention,
            cross_attn_names,
            device,
            device_id,
            suppress_token_mask,
            enc_dynlen,
            ready: true,
        })
    }

    /// Encode mel features once → **device-resident** `last_hidden_state` (`bind_output_to_device`,
    /// never copied to host). Mirrors onnx-asr `_hf.py::_encode`. The returned `DynValue` is rebound
    /// as the decoder's `encoder_hidden_states` every step with no host round-trip.
    fn encode(&mut self, audio: &[f32]) -> SttResult<DynValue> {
        // Dynlen-capable encoder → smallest bucket that holds the audio + tail pad; stock
        // static export → the classic full 30 s window.
        if self.enc_dynlen {
            let n_audio_frames = audio.len().div_ceil(HOP_LENGTH);
            let bucket = enc_bucket_frames(n_audio_frames);
            let (feats, n_mels, n_frames) = self.mel.extract_frames(audio, bucket);
            match self.encode_frames(feats, n_mels, n_frames) {
                Ok(hidden) => return Ok(hidden),
                // MISDETECTED dynlen: some exports (e.g. onnx-community `*_timestamped`)
                // declare `input_features` dim 2 symbolically while the graph's positional
                // embedding is still the fixed 1500-frame constant — a sub-3000 bucket then
                // fails the pos-emb Add broadcast ("500 by 1500"). The symbolic dim alone is
                // therefore NOT proof of dynlen support; treat the first sub-window failure
                // as the real capability probe: pin the engine to the static full window and
                // re-encode. A full-window (3000-frame) failure is a genuine error either way,
                // so only the shortened path retries.
                Err(e) if n_frames < N_FRAMES => {
                    log::debug!(
                        "[whisper] '{}' rejected the dynamic {n_frames}-frame capability probe; using static 30 s encode ({e})",
                        self.model_name
                    );
                    self.enc_dynlen = false;
                }
                Err(e) => return Err(e),
            }
        }
        let (feats, n_mels, n_frames) = self.mel.extract(audio);
        self.encode_frames(feats, n_mels, n_frames)
    }

    /// One encoder run over already-extracted mel features → device-resident hidden state.
    /// Split out of [`Self::encode`] so the dynlen path can retry with the full static window
    /// when a shortened bucket turns out to be unsupported by the export.
    fn encode_frames(
        &mut self,
        feats: Vec<f32>,
        n_mels: usize,
        n_frames: usize,
    ) -> SttResult<DynValue> {
        // input_features: (1, n_mels, T).
        let input = Tensor::from_array(([1usize, n_mels, n_frames], feats.into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("encoder input tensor: {e}")))?;
        let dev_mem = self.device_mem()?;
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| SttError::Inference("whisper encoder session is shut down".into()))?;
        let mut binding = encoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("encoder binding: {e}")))?;
        binding
            .bind_input("input_features", &input)
            .map_err(|e| SttError::Inference(format!("bind input_features: {e}")))?;
        binding
            .bind_output_to_device("last_hidden_state", &dev_mem)
            .map_err(|e| SttError::Inference(format!("bind last_hidden_state: {e}")))?;
        let mut outputs = encoder
            .run_binding(&binding)
            .map_err(|e| SttError::Inference(format!("encoder run_binding: {e}")))?;
        // DML/CUDA run_binding is async w.r.t. the device stream — block until the encoder output is
        // actually written before we hand the device value to the decoder (else we read stale memory).
        binding
            .synchronize_outputs()
            .map_err(|e| SttError::Inference(format!("encoder synchronize: {e}")))?;
        outputs
            .remove("last_hidden_state")
            .ok_or_else(|| SttError::Inference("encoder produced no last_hidden_state".into()))
    }

    /// Device `MemoryInfo` for binding the encoder output + KV-cache resident on the session's
    /// device (CPU when no GPU EP). Cheap to build; one per encode + one per decode call.
    fn device_mem(&self) -> SttResult<MemoryInfo> {
        MemoryInfo::new(
            self.device,
            self.device_id,
            AllocatorType::Device,
            MemoryType::Default,
        )
        .map_err(|e| SttError::Inference(format!("device mem info: {e}")))
    }

    /// Build the static decoder prompt for one utterance (mirrors `_base.py`).
    ///
    /// Multilingual: `[sot, <lang|eos-sentinel>, transcribe|translate, (notimestamps?)]`.
    /// `.en` exports keep the eos sentinel in position 1 — writing a language token there
    /// corrupts the prompt (memory project_whisper_incomplete_vocab...; §6.3).
    fn build_prompt(&self, opts: &TranscribeOptions) -> Vec<i64> {
        let tk = &self.tokenizer;
        let task = if opts.translate && tk.is_multilingual {
            tk.translate_token_id
        } else {
            tk.transcribe_token_id
        };
        let mut prompt = if opts.return_timestamps {
            vec![tk.bos_token_id, tk.eos_token_id, task]
        } else {
            vec![
                tk.bos_token_id,
                tk.eos_token_id,
                task,
                tk.notimestamps_token_id,
            ]
        };
        if tk.is_multilingual
            && let Some(lang) = opts.language.as_deref().filter(|l| !l.is_empty())
            && let Some(tok) = tk.language_token(lang)
        {
            prompt[1] = tok;
        }
        prompt
    }

    fn candidate_language_tokens(&self, candidates: &[String]) -> Vec<i64> {
        let mut out = Vec::new();
        for candidate in candidates {
            if let Some(token) = self.tokenizer.language_token(candidate)
                && !out.contains(&token)
            {
                out.push(token);
            }
        }
        out
    }

    /// Short 3-token decode from `[sot]`; position-1 argmax = detected language token.
    fn detect_language(&mut self, encoder_out: &DynValue, candidates: &[String]) -> SttResult<i64> {
        let prompt = vec![self.tokenizer.bos_token_id];
        let candidate_tokens = self.candidate_language_tokens(candidates);
        let tokens = if candidate_tokens.is_empty() {
            self.decode_greedy(encoder_out, prompt, 3)?
        } else {
            self.decode_greedy_with_first_step_allowed(encoder_out, prompt, 3, &candidate_tokens)?
        };
        Ok(*tokens.get(1).unwrap_or(&self.tokenizer.eos_token_id))
    }

    /// The greedy autoregressive KV-cache loop. Returns the full token sequence
    /// (prompt + generated incl. trailing eos). Port of `_hf.py::_decoding` / `_decode`.
    fn decode_greedy(
        &mut self,
        encoder_out: &DynValue,
        prompt: Vec<i64>,
        max_length: usize,
    ) -> SttResult<Vec<i64>> {
        let (tokens, _) = self.decode_inner(encoder_out, prompt, max_length, false, None)?;
        Ok(tokens)
    }

    fn decode_greedy_with_first_step_allowed(
        &mut self,
        encoder_out: &DynValue,
        prompt: Vec<i64>,
        max_length: usize,
        first_step_allowed: &[i64],
    ) -> SttResult<Vec<i64>> {
        let (tokens, _) = self.decode_inner(
            encoder_out,
            prompt,
            max_length,
            false,
            Some(first_step_allowed),
        )?;
        Ok(tokens)
    }

    /// Greedy decode that ALSO collects per-step cross-attention from the
    /// `cross_attentions.{i}` decoder outputs (word-timestamp path). Port of
    /// `_hf.py::_decoding_with_cross_attention`. Returns the full token sequence and a
    /// stacked `(num_layers, num_heads, num_decoder_tokens, num_encoder_frames)` tensor.
    ///
    /// Requires `self.has_cross_attention`; callers gate on `supports_word_timestamps()`.
    fn decode_with_cross_attn(
        &mut self,
        encoder_out: &DynValue,
        prompt: Vec<i64>,
        max_length: usize,
    ) -> SttResult<(Vec<i64>, CrossAttentions)> {
        let (tokens, attn) = self.decode_inner(encoder_out, prompt, max_length, true, None)?;
        let attn = attn.ok_or_else(|| {
            SttError::Inference("cross-attention requested but decoder produced none".into())
        })?;
        Ok((tokens, attn))
    }

    /// Shared greedy KV-cache decode body. When `collect_cross_attn` is set the loop reads the
    /// sorted `cross_attentions.{i}` outputs each step and concatenates them along the decoder-
    /// token axis, returning the stacked `(num_layers, num_heads, num_dec_tokens, num_enc_frames)`.
    ///
    /// Orchestrates named helpers: `prepare_decode_state` (one-time KV/memory/cross-attn buffers) →
    /// per-step `decode_step` (the hot loop body: bind, run, sync, select token, carry KV, collect
    /// attn) → `check_degenerate_decode` (always-on garbage guard) → `stack_cross_attentions`.
    fn decode_inner(
        &mut self,
        encoder_out: &DynValue,
        prompt: Vec<i64>,
        max_length: usize,
        collect_cross_attn: bool,
        first_step_allowed: Option<&[i64]>,
    ) -> SttResult<(Vec<i64>, Option<CrossAttentions>)> {
        let eos = self.tokenizer.eos_token_id;
        let mut state = self.prepare_decode_state(encoder_out, prompt, collect_cross_attn)?;
        let total_steps = max_length.saturating_sub(state.tokens.len());

        for step_index in 0..total_steps {
            let next = self.decode_step(&mut state, step_index, first_step_allowed)?;
            state.tokens.push(next);
            if next == eos {
                break;
            }
        }

        self.check_degenerate_decode(&state, max_length)?;
        let attn = state.stack_cross_attentions();
        Ok((state.tokens, attn))
    }

    /// One-time decode setup (mirrors onnx-asr `_create_state` + optimum's one-binding-per-
    /// session): allocate the device/host `MemoryInfo`, derive the `present.*` output names,
    /// create THE IoBinding for this decode and bind everything that never changes across steps —
    /// the encoder output, the step-0 empty KV cache, the step-0 `use_cache_branch=false` flag,
    /// and every output. Returns the loop-carried `DecodeState`; per-step work is only the
    /// handful of rebinds that actually changed (input_ids, flipped flag, replaced self-KV).
    fn prepare_decode_state(
        &self,
        encoder_out: &DynValue,
        prompt: Vec<i64>,
        collect_cross_attn: bool,
    ) -> SttResult<DecodeState> {
        // Device memory for the KV-cache + encoder output (resident); logits/cross-attn come back
        // to host. `device_mem` is CPU when no GPU EP, so this path is correct + ~free on CPU too.
        let dev_mem = self.device_mem()?;
        let cpu_mem = MemoryInfo::new(
            AllocationDevice::CPU,
            0,
            AllocatorType::Device,
            MemoryType::CPUOutput,
        )
        .map_err(|e| SttError::Inference(format!("cpu mem info: {e}")))?;
        // `present.*` output names, parallel to `past_kv_names` (canonical layer order).
        let present_names: Vec<String> = self
            .past_kv_names
            .iter()
            .map(|n| n.replace("past_key_values.", "present."))
            .collect();

        // Carried KV cache as DEVICE-resident OrtValues, parallel to `past_kv_names`. `None` = the
        // (0,H,0,D) empty cache (step 0 / use_cache_branch=False; onnx-asr `_create_state`); from
        // step 1 each entry is a `present.*` device output of the previous step. The cross-attn
        // (encoder) KV is computed once at step 0 and reused, so its `present.*` returns empty on
        // cached steps → we keep the prior value ("keep prev when present is 0-length", `_hf.py`).
        // (`DynValue` isn't `Clone`, so build the all-`None` vec without the `vec![None; n]` repeat.)
        let past: Vec<Option<DynValue>> = (0..self.past_kv_names.len()).map(|_| None).collect();

        let want_attn =
            collect_cross_attn && self.has_cross_attention && !self.cross_attn_names.is_empty();

        // THE binding for this decode. Bind the step-invariants now:
        //   * encoder_hidden_states — device-resident, identical every step;
        //   * the (0,H,0,D) empty past.* tensors — replaced from step 1 by carried device KV
        //     (`bind_input` holds an Arc on the bound value, so the temporaries can drop here);
        //   * use_cache_branch=false — flipped to the pre-created `true` tensor at step 1;
        //   * every output: logits → host, present.* → device, cross_attentions.* → host when
        //     collecting else device (ORT requires all outputs bound when any is).
        let decoder = self
            .decoder
            .as_ref()
            .ok_or_else(|| SttError::Inference("whisper decoder session is shut down".into()))?;
        let mut binding = decoder
            .create_binding()
            .map_err(|e| SttError::Inference(format!("decoder binding: {e}")))?;
        binding
            .bind_input("encoder_hidden_states", encoder_out)
            .map_err(|e| SttError::Inference(format!("bind encoder_hidden_states: {e}")))?;
        for (i, name) in self.past_kv_names.iter().enumerate() {
            let (h, d) = self.kv_dims[i];
            let shape = [0usize, h.max(0) as usize, 0usize, d.max(0) as usize];
            let t = Tensor::<f32>::new(&Allocator::default(), shape)
                .map_err(|e| SttError::Inference(format!("empty past kv: {e}")))?;
            binding
                .bind_input(name.as_str(), &t)
                .map_err(|e| SttError::Inference(format!("bind empty {name}: {e}")))?;
        }
        let flag_false = Tensor::from_array(([1usize], vec![false].into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("use_cache_branch=false: {e}")))?;
        let flag_true = Tensor::from_array(([1usize], vec![true].into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("use_cache_branch=true: {e}")))?;
        if self.has_use_cache_branch {
            binding
                .bind_input("use_cache_branch", &flag_false)
                .map_err(|e| SttError::Inference(format!("bind use_cache_branch: {e}")))?;
        }
        binding
            .bind_output_to_device("logits", &cpu_mem)
            .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
        for pname in &present_names {
            binding
                .bind_output_to_device(pname.as_str(), &dev_mem)
                .map_err(|e| SttError::Inference(format!("bind {pname}: {e}")))?;
        }
        let ca_mem = if want_attn { &cpu_mem } else { &dev_mem };
        for name in &self.cross_attn_names {
            binding
                .bind_output_to_device(name.as_str(), ca_mem)
                .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
        }
        // Per-layer running buffers: each entry is (heads, dec_step_len, enc_frames) FLAT data, one
        // per decode step. Concatenated along the decoder-token (step) axis at the end, exactly like
        // `_hf.py` `np.concatenate(layer_steps, axis=2)` then `np.stack(..., axis=1)`.
        let n_layers = self.cross_attn_names.len();
        let per_layer_steps: Vec<Vec<Vec<f32>>> = vec![Vec::new(); n_layers];

        let prompt_len = prompt.len();
        let past_dirty = vec![false; self.past_kv_names.len()];
        Ok(DecodeState {
            tokens: prompt,
            prompt_len,
            dev_mem,
            cpu_mem,
            binding,
            flag_true,
            present_names,
            past,
            past_dirty,
            banned_tokens: Vec::new(),
            want_attn,
            per_layer_steps,
            // Resolved at the FIRST step from the actual output shapes (steps are uniform per layer).
            ca_heads: 0,
            ca_frames: 0,
            // ALWAYS-ON garbage guard (silent in normal use): a Whisper decode that runs to the
            // token cap WITHOUT an EOS and is dominated by a single repeated token is the "..."-wall
            // garbage we saw when lite-whisper's low-rank encoder corrupts on DirectML after model
            // swaps. We capture the step-0 logit margin (a tiny margin ⇒ the encoder gave the
            // decoder no real signal) and, ONLY when the decode actually degenerates, emit one rich
            // WARN with every metric. Normal decodes EOS early and never reach the detector; the
            // only standing cost is a one-time step-0 peek.
            step0: None, // (argmax token, top logit, runner-up logit)
        })
    }

    /// One greedy KV-cache step (mirrors onnx-asr `_decode` semantics, optimum's binding reuse):
    /// rebind ONLY what changed since the previous step — `input_ids`, the `use_cache_branch`
    /// flip at step 1, and the carried self-KV entries replaced last step — then run, argmax the
    /// last-position logits (with first-step allow-list / no_repeat_ngram), carry `present.*` →
    /// `past.*`, and collect this step's cross-attention. Returns the next token.
    ///
    /// No per-step `synchronize_outputs()`: on DirectML that call is a FULL device-queue drain
    /// (`ExecutionProvider::Sync` → `WaitForOutstandingWork`), while the host `logits` readback
    /// ORT performs during `run_binding` already fence-waits on the producing kernels, and the
    /// device-resident `present.*` → next-step reads are ordered by the command queue itself.
    /// (onnx-asr never syncs; optimum's per-step syncs are CUDA-stream semantics.) Verified on
    /// DML by transcript-identical repeated bench passes; the always-on garbage detector below
    /// self-reports if a platform ever violates this ordering.
    fn decode_step(
        &mut self,
        state: &mut DecodeState,
        step_index: usize,
        first_step_allowed: Option<&[i64]>,
    ) -> SttResult<i64> {
        let eos = self.tokenizer.eos_token_id;
        let use_cache = step_index > 0;

        // input_ids: full prompt on step 0, else only the last token.
        let (id_data, id_len): (Vec<i64>, usize) = if use_cache {
            let last = state.tokens.last().copied().ok_or_else(|| {
                SttError::Inference("whisper decoder token history is empty".into())
            })?;
            (vec![last], 1)
        } else {
            (state.tokens.clone(), state.tokens.len())
        };
        let input_ids = Tensor::from_array(([1usize, id_len], id_data.into_boxed_slice()))
            .map_err(|e| SttError::Inference(format!("decoder input_ids: {e}")))?;
        state
            .binding
            .bind_input("input_ids", &input_ids)
            .map_err(|e| SttError::Inference(format!("bind input_ids: {e}")))?;
        // The merged decoder's bool `use_cache_branch` flips exactly once, at step 1.
        if self.has_use_cache_branch && step_index == 1 {
            state
                .binding
                .bind_input("use_cache_branch", &state.flag_true)
                .map_err(|e| SttError::Inference(format!("bind use_cache_branch: {e}")))?;
        }
        // past_key_values.*: rebind only the entries replaced since their last bind (all 2·L
        // decoder+encoder entries at step 1; just the 2·L_dec self-attn entries afterwards —
        // the cross-attn KV settles at step 0 and its binding stays valid for the whole decode).
        for (i, name) in self.past_kv_names.iter().enumerate() {
            if state.past_dirty[i]
                && let Some(v) = &state.past[i]
            {
                state
                    .binding
                    .bind_input(name.as_str(), v)
                    .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                state.past_dirty[i] = false;
            }
        }
        // OUTPUTS must be re-bound every step: a `bind_output_to_device` binding caches the
        // run's allocated OrtValue, and the next run shape-verifies against it — the growing
        // present.*.decoder (p+1) and the (0,H,1,D)↔(1,H,T,D) encoder sentinel flip both fail
        // that check ("OrtValue shape verification failed"). Re-binding resets the slot to
        // "allocate on device this run" — pure FFI, no tensor copies.
        if step_index > 0 {
            state
                .binding
                .bind_output_to_device("logits", &state.cpu_mem)
                .map_err(|e| SttError::Inference(format!("bind logits: {e}")))?;
            for pname in &state.present_names {
                state
                    .binding
                    .bind_output_to_device(pname.as_str(), &state.dev_mem)
                    .map_err(|e| SttError::Inference(format!("bind {pname}: {e}")))?;
            }
            if !self.cross_attn_names.is_empty() {
                let ca_mem = if state.want_attn {
                    &state.cpu_mem
                } else {
                    &state.dev_mem
                };
                for name in &self.cross_attn_names {
                    state
                        .binding
                        .bind_output_to_device(name.as_str(), ca_mem)
                        .map_err(|e| SttError::Inference(format!("bind {name}: {e}")))?;
                }
            }
        }

        let mut outputs = self
            .decoder
            .as_mut()
            .ok_or_else(|| SttError::Inference("whisper decoder session is shut down".into()))?
            .run_binding(&state.binding)
            .map_err(|e| SttError::Inference(format!("decoder run_binding: {e}")))?;

        // logits: (1, seq, vocab) → argmax of the LAST position (host). Scoped so the borrow of
        // `outputs` ends before the present→past `remove`s take it mutably.
        let mut next: i64 = {
            let logits = outputs
                .get("logits")
                .ok_or_else(|| SttError::Inference("decoder produced no logits".into()))?;
            let (lshape, ldata) = logits
                .try_extract_tensor::<f32>()
                .map_err(|e| SttError::Inference(format!("logits extract: {e}")))?;
            let vocab = *lshape.last().unwrap_or(&0) as usize;
            let seq = if lshape.len() >= 2 {
                lshape[lshape.len() - 2] as usize
            } else {
                1
            };
            if vocab == 0 {
                return Err(SttError::Inference(
                    "decoder logits had 0-width vocab".into(),
                ));
            }
            let last_off = seq.saturating_sub(1) * vocab;
            // Clamp to the actual data length: the slice bounds come from the logits
            // *shape* metadata, so a shape/data-mismatched downloaded ONNX decoder
            // would otherwise panic the decode thread (mirrors moonshine.rs).
            let end = (last_off + vocab).min(ldata.len());
            if end <= last_off {
                return Err(SttError::Inference(
                    "decoder logits buffer shorter than declared shape".into(),
                ));
            }
            let logits = &ldata[last_off..end];
            let selected = if step_index == 0 {
                first_step_allowed
                    .filter(|allowed| !allowed.is_empty())
                    .map_or_else(
                        || {
                            select_whisper_token(
                                logits,
                                &self.suppress_token_mask,
                                self.tokenizer.eos_token_id,
                                self.tokenizer.nospeech_token_id,
                                true,
                                &[],
                            )
                        },
                        |allowed| {
                            select_whisper_token_from_allowed(
                                logits,
                                allowed,
                                self.tokenizer.eos_token_id,
                                self.tokenizer.nospeech_token_id,
                                true,
                            )
                        },
                    )
            } else {
                // no_repeat_ngram over the GENERATED region only (prompt excluded): bans the
                // continuations that would close a verbatim repetition loop, which is what the
                // greedy decoder falls into on lite-whisper's low-rank encoders. No-op on any
                // decode that isn't actually repeating an n-gram, and EOS is never in the set.
                fill_no_repeat_ngram_banned(
                    &state.tokens[state.prompt_len.min(state.tokens.len())..],
                    NO_REPEAT_NGRAM_SIZE,
                    &mut state.banned_tokens,
                );
                select_whisper_token(
                    logits,
                    &self.suppress_token_mask,
                    self.tokenizer.eos_token_id,
                    self.tokenizer.nospeech_token_id,
                    false,
                    &state.banned_tokens,
                )
            };
            if state.step0.is_none() {
                state.step0 = Some((selected.token, selected.top_logit, selected.runner_up_logit));
            }
            selected.token
        };
        // EOS-sticky: once a row hit eos, freeze it.
        if state.tokens.last().is_some_and(|&token| token == eos) {
            next = eos;
        }

        // Collect this step's cross-attention (host) BEFORE the present→past `remove`s.
        // Each `cross_attentions.{i}` output is (batch=1, num_heads, dec_step_len, enc_frames)
        // where dec_step_len == id_len (the number of decoder tokens fed THIS step — the full
        // prompt on step 0, then 1 thereafter). We store the FLAT (heads*dec_step_len*frames)
        // data per layer per step; the dec_step_len axis is what we concat over.
        if state.want_attn {
            for (li, name) in self.cross_attn_names.iter().enumerate() {
                let v = outputs
                    .get(name.as_str())
                    .ok_or_else(|| SttError::Inference(format!("decoder produced no {name}")))?;
                let (shape, data) = v
                    .try_extract_tensor::<f32>()
                    .map_err(|e| SttError::Inference(format!("{name} extract: {e}")))?;
                // shape = [batch, heads, dec_step_len, frames]; batch is always 1.
                let h = shape.get(1).copied().unwrap_or(0).max(0) as usize;
                let f = shape.get(3).copied().unwrap_or(0).max(0) as usize;
                if li == 0 && state.per_layer_steps[0].is_empty() {
                    state.ca_heads = h;
                    state.ca_frames = f;
                }
                state.per_layer_steps[li].push(data.to_vec());
            }
        }

        // Carry present.* → past.* as DEVICE values (keep prev when present is 0-length, i.e.
        // the reused cross-attn/encoder KV). Extracted values are session-owned and survive the
        // step, so they rebind next step with no host round-trip. Mark replaced entries dirty so
        // the next step rebinds exactly those.
        for (i, pname) in state.present_names.iter().enumerate() {
            if let Some(v) = outputs.remove(pname.as_str())
                && first_dim(&v) != 0
            {
                state.past[i] = Some(v);
                state.past_dirty[i] = true;
            }
            // else: present empty → keep the existing past[i] (reused encoder KV, still bound).
        }
        drop(outputs);

        Ok(next)
    }

    /// ── GARBAGE DETECTOR (always on; emits ONLY on a degenerate decode) ──
    /// Fires when the decode ran to the token cap with no EOS AND the generated tokens are ≥50% one
    /// repeated token. That excludes the 2-step language-detect decode (too few tokens) and a
    /// legitimately long transcription (varied tokens → low dominant fraction). The single WARN
    /// carries everything needed to root-cause it in a later session — copy/paste it. Returns
    /// `Err(DegenerateDecode)` (and marks the DirectML strike counter) on a degenerate decode.
    fn check_degenerate_decode(&self, state: &DecodeState, max_length: usize) -> SttResult<()> {
        let eos = self.tokenizer.eos_token_id;
        let generated = &state.tokens[state.prompt_len.min(state.tokens.len())..];
        if state.tokens.last() == Some(&eos) || generated.len() < 32 {
            return Ok(());
        }
        let mut counts: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
        for &t in generated {
            *counts.entry(t).or_default() += 1;
        }
        let (dom_tok, dom_n) = counts
            .iter()
            .max_by_key(|(_, n)| **n)
            .map_or((-1, 0), |(t, n)| (*t, *n));
        let dom_frac = dom_n as f32 / generated.len().max(1) as f32;
        if dom_frac < 0.5 {
            return Ok(());
        }
        let (s0t, s0top, s0run) = state.step0.unwrap_or((-1, f32::NAN, f32::NAN));
        let dom_text = self.tokenizer.decode_text(&[dom_tok]);
        log::warn!(
            "[whisper-garbage] DEGENERATE DECODE; model='{}' ep={:?} thread={:?} | {} generated \
             tokens, {:.0}% are token {} ({:?}), NO EOS (hit {}-token cap) | step0: token={} \
             top_logit={:.2} margin={:.2} (tiny margin => garbage encoder output; large => \
             decoder/KV-cache fault) | LIKELY CAUSE: unreleased/overlapped DirectML ORT \
             session state across model swaps (lite-whisper low-rank encoder is the fragile \
             case). Copy this line for the next debugging session.",
            self.model_name,
            self.providers,
            std::thread::current().id(),
            generated.len(),
            dom_frac * 100.0,
            dom_tok,
            dom_text,
            max_length,
            s0t,
            s0top,
            s0top - s0run,
        );
        let dml_active = self.providers.iter().any(|p| p == DML_PROVIDER_LABEL);
        let mut dml_count = 0usize;
        if dml_active {
            dml_count = mark_directml_degenerate_model(&self.model_name);
            let action = if dml_count >= DML_DEGENERATE_BLOCK_THRESHOLD {
                "CPU fallback will be used on the next reload"
            } else {
                "DirectML will be recycled once on the next reload"
            };
            log::warn!(
                "[whisper-garbage] DirectML degenerate count for model '{}' is {}; {}",
                self.model_name,
                dml_count,
                action
            );
        }
        Err(SttError::DegenerateDecode(format!(
            "[whisper-garbage] model='{}' ep={:?} hit {}-token cap with {:.0}% token {} ({:?}); step0_token={} top_logit={:.2} margin={:.2}{}",
            self.model_name,
            self.providers,
            max_length,
            dom_frac * 100.0,
            dom_tok,
            dom_text,
            s0t,
            s0top,
            s0top - s0run,
            if dml_active && dml_count >= DML_DEGENERATE_BLOCK_THRESHOLD {
                "; repeated DirectML degenerate decode, CPU fallback will be used"
            } else if dml_active {
                "; DirectML session will be recycled once before CPU fallback"
            } else {
                ""
            },
        )))
    }

    /// Run cross-attention DTW on `cross_attentions` to recover per-word start/end seconds.
    /// `full_tokens` is the FULL decoded sequence (prompt + generated incl. trailing eos);
    /// `prompt_length` is the number of decoder-prompt tokens at its head (cross-attention row 0
    /// aligns with `full_tokens[0]`). Mirrors `_base.py::_align_word_timestamps`.
    fn align_word_timestamps(
        &self,
        cross_attentions: &CrossAttentions,
        full_tokens: &[i64],
        prompt_length: usize,
        num_audio_frames: usize,
        language: Option<&str>,
    ) -> Vec<WordResult> {
        // Generated text tokens = everything after the prompt, eos stripped, then ONE eos appended
        // (the aligner needs the trailing-eot anchor to bound the last real word). Mirrors
        // `recognize_batch`: `generated = [t for t in row[prompt_length:] if t != eos] + [eos]`.
        let eos = self.tokenizer.eos_token_id;
        let mut generated: Vec<i64> = full_tokens
            .iter()
            .skip(prompt_length)
            .copied()
            .filter(|&t| t != eos)
            .collect();
        generated.push(eos);

        let num_layers = cross_attentions.num_layers;
        let num_heads = cross_attentions.num_heads;
        let vocab_size = self.tokenizer.vocab_size().max(0) as usize;
        let heads_mask = lookup_alignment_heads(num_layers, num_heads, vocab_size);

        // decode_one MUST preserve the leading space (`Ġ`/" ") so word-boundary splitting works.
        let decode_one =
            |ids: &[i64]| -> String { self.tokenizer.decode_text_preserve_leading_space(ids) };

        let args = AlignArgs {
            text_tokens: &generated,
            decode_one: &decode_one,
            eot_id: eos,
            prompt_length,
            num_audio_frames,
            language,
            medfilt_width: 7,
            qk_scale: 1.0,
        };
        match word_timestamps::align_words(cross_attentions, &heads_mask, args) {
            Ok(timings) => timings
                .into_iter()
                .map(|t| WordResult {
                    text: t.word,
                    start: t.start as f32,
                    end: t.end as f32,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

impl Transcriber for WhisperEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::WhisperHf
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

    fn supports_word_timestamps(&self) -> bool {
        self.has_cross_attention
    }

    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.is_empty() {
            return Ok(Transcription::default());
        }
        let enc_started = Instant::now();
        let encoder_out = self.encode(audio)?;
        let encode_ms = enc_started.elapsed().as_secs_f64() * 1000.0;

        // Resolve the language slot for multilingual + no-language via the 3-token detect.
        let mut prompt = self.build_prompt(opts);
        if self.tokenizer.is_multilingual {
            let no_lang = opts.language.as_deref().is_none_or(|l| l.is_empty());
            if no_lang && prompt.get(1).copied() == Some(self.tokenizer.eos_token_id) {
                let lang_tok = self.detect_language(&encoder_out, &opts.language_candidates)?;
                prompt[1] = lang_tok;
            }
        }

        let want_words = opts.return_word_timestamps && self.has_cross_attention;

        // ── Word-timestamp path: cross-attention DTW (no initial-prompt prefix) ──
        // The aligner needs each cross-attention row to line up 1:1 with a decoder-prompt /
        // generated token, so we DON'T inject the `<|startofprev|>` prefix here (it would shift
        // every row index and the history aligner has no prior-text bias to apply anyway). The
        // `prompt_length` is the plain decoder prompt length; cross-attention row 0 == prompt[0].
        if want_words {
            let prompt_length = prompt.len();
            let (tokens, cross_attn) =
                self.decode_with_cross_attn(&encoder_out, prompt, MAX_LENGTH)?;
            let text = self.tokenizer.decode_text(&tokens);
            let segments = if opts.return_timestamps {
                Some(self.to_segments(&tokens))
            } else {
                None
            };
            // num_audio_frames = num_samples // HOP_LENGTH (pre 2× encoder downsample). The aligner
            // crops to `// 2` internally to match the encoder frame count.
            let num_audio_frames = audio.len() / HOP_LENGTH;
            let language = opts.language.as_deref().filter(|l| !l.is_empty());
            let words = self.align_word_timestamps(
                &cross_attn,
                &tokens,
                prompt_length,
                num_audio_frames,
                language,
            );
            let words = if words.is_empty() { None } else { Some(words) };
            return Ok(Transcription {
                text,
                segments,
                words,
            });
        }

        // ── Standard path: greedy decode (optional initial-prompt biasing) ──
        // Initial-prompt biasing (Whisper-only; `EngineKind::supports_initial_prompt`).
        // Prepend `[<|startofprev|>, *encoded]` BEFORE the standard prompt so the decoder
        // soft-attends to the prior text (custom vocab / continuation). Sanitized upstream
        // (context slice) — raised noise here would poison whisper-tiny (memory
        // project_context_prompt_poisons_whisper). No-op on `.en` / Canary / Cohere.
        //
        // The prefix tokens are NOT special markers, so they must be STRIPPED from the
        // generated sequence before decode or the prompt body bleeds into the transcript
        // (memory-confirmed bug; WinSTT onnx_decoder_patches slices `out[:, prefix_len:]`).
        // max_length is bumped by prefix_len (capped at 448) so the prefix is "free".
        let mut prefix_len = 0usize;
        let mut max_length = MAX_LENGTH;
        if let Some(prompt_text) = opts.initial_prompt_text.as_deref() {
            let prefix = self.tokenizer.initial_prompt_prefix(prompt_text);
            if !prefix.is_empty() {
                prefix_len = prefix.len();
                // Allow the prefix tokens up to the 448 positional cap (we're already at
                // the cap, so the prefix shares the budget — Python: min(448, ml+prefix)).
                max_length = (MAX_LENGTH + prefix_len).min(MAX_LENGTH);
                let mut full = prefix;
                full.extend(prompt);
                prompt = full;
            }
        }

        let prompt_len = prompt.len();
        let dec_started = Instant::now();
        let tokens = self.decode_greedy(&encoder_out, prompt, max_length)?;
        if profile_enabled() {
            let decode_ms = dec_started.elapsed().as_secs_f64() * 1000.0;
            let n_tok = tokens.len().saturating_sub(prompt_len).max(1);
            eprintln!(
                "[whisper-profile] model='{}' ep={:?} | encode {:.1}ms | decode {:.1}ms | {} tok | {:.2} ms/tok",
                self.model_name,
                self.providers,
                encode_ms,
                decode_ms,
                n_tok,
                decode_ms / n_tok as f64,
            );
        }
        // Strip the injected initial-prompt prefix before decode.
        let tokens: &[i64] = if prefix_len > 0 && prefix_len <= tokens.len() {
            &tokens[prefix_len..]
        } else {
            &tokens
        };

        let text = self.tokenizer.decode_text(tokens);
        let segments = if opts.return_timestamps {
            Some(self.to_segments(tokens))
        } else {
            None
        };
        Ok(Transcription {
            text,
            segments,
            words: None,
        })
    }

    fn warmup(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<()> {
        if audio.is_empty() {
            return Ok(());
        }

        let encoder_out = self.encode(audio)?;
        let mut prompt = self.build_prompt(opts);
        if self.tokenizer.is_multilingual {
            let no_lang = opts.language.as_deref().is_none_or(|l| l.is_empty());
            if no_lang && prompt.get(1).copied() == Some(self.tokenizer.eos_token_id) {
                let lang_tok = self.detect_language(&encoder_out, &opts.language_candidates)?;
                prompt[1] = lang_tok;
            }
        }

        let max_length = (prompt.len() + WARMUP_DECODE_STEPS).min(MAX_LENGTH);
        let _ = self.decode_greedy(&encoder_out, prompt, max_length)?;
        Ok(())
    }

    fn shutdown(&mut self) {
        self.ready = false;
        self.decoder.take();
        self.encoder.take();
    }
}

impl WhisperEngine {
    fn to_segments(&self, tokens: &[i64]) -> Vec<Segment> {
        self.tokenizer
            .extract_segments(tokens)
            .into_iter()
            .map(|(start, end, text)| Segment { start, end, text })
            .collect()
    }
}
