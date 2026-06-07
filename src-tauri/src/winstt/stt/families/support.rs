// Shared engine infrastructure used by every non-Whisper STT family sub-engine:
//   * ORT session construction + EP registration,
//   * tensor/ndarray ↔ ort conversion + argmax + named-input / KV push & carry helpers,
//   * `Vocab` loader,
//   * ORT session introspection + path/tokenizer helpers.
//
// Lifted verbatim out of the old monolithic `families.rs`; the engine sub-files
// (`ctc`, `transducer`, `aed`) call these via `use super::support::*`. Most fns are `pub(super)`
// so the leakage stays inside the `families/` module tree (it does not widen the crate API).

#![allow(dead_code)] // staged: surface defined ahead of call sites / wiring.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ndarray::{ArrayD, ArrayView2};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use super::super::{
    num_cpus_best_effort, pick_intra_op_threads, vocab_is_uppercase, Accelerator, ResolvedModel,
    SttError, SttResult,
};

/// fp16 element type. `ort` depends on `half` and impls `PrimitiveTensorElementType` for
/// `half::f16`; this alias is the single reference point so the (transitive) `half` dep — which
/// must be declared direct in Cargo.toml for this path — is easy to swap if ort re-exports it
/// (e.g. `ort::half::f16`) under a different name in the pinned rc.
pub(super) type F16 = half::f16;

// ───────────────────────────────────────────────────────────────────────────
// 0. Shared ORT session construction
// ───────────────────────────────────────────────────────────────────────────

/// Build an `ort::Session` for one model file, honoring the resolved provider list.
///
/// Mirrors `onnxasr_transcriber.build_session_options` + `device.providers_for_settings`:
///   * optimization level `ORT_ENABLE_ALL` (Level3) normally; the whisper-fp16 EXTENDED downgrade
///     (§6.2) is a Whisper-family concern handled in `whisper_hf.rs`, not here.
///   * intra-op threads via `pick_intra_op_threads` (CPU→min(cpu,8), GPU→2).
///   * EPs registered per `providers` (already DML→CPU-overridden upstream for these families).
pub(super) fn build_session(path: &Path, providers: &[Accelerator]) -> SttResult<Session> {
    let is_gpu = providers
        .first()
        .is_some_and(|p| !matches!(p, Accelerator::Cpu));
    let threads = pick_intra_op_threads(is_gpu, num_cpus_best_effort());

    let mut builder = Session::builder()
        .map_err(|e| SttError::SessionCreate(format!("Session::builder: {e}")))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| SttError::SessionCreate(format!("opt level: {e}")))?
        .with_intra_threads(threads)
        .map_err(|e| SttError::SessionCreate(format!("intra threads: {e}")))?;

    // DirectML session config (L1). ORT's DirectML EP is incompatible with the memory-pattern
    // planner — it allocates/manages its own device memory, so EnableMemPattern must be OFF (the
    // ORT DML docs require DisableMemPattern + ORT_SEQUENTIAL). Parallel execution is already
    // OFF by default (the builder defaults to Sequential), so we only need to disable mem-pattern.
    // It's also the right call for our DYNAMIC-length audio inputs (shapes vary every call → the
    // memory pattern can't be reused and just adds planning overhead). transcribe-rs sets the same
    // for its DML sessions. CPU/CUDA keep the default (mem-pattern on) — validated separately.
    if is_gpu {
        builder = builder
            .with_memory_pattern(false)
            .map_err(|e| SttError::SessionCreate(format!("disable mem pattern (DML): {e}")))?;
    }

    builder = register_providers(builder, providers)?;

    builder
        .commit_from_file(path)
        .map_err(|e| SttError::SessionCreate(format!("commit_from_file {}: {e}", path.display())))
}

/// Register the execution providers onto a `SessionBuilder`. The provider list is the FINAL,
/// already-policy-routed list from `EngineConfig.providers`; CPU is always appended last for
/// per-op fallback by the shared helper (mirrors Python `[<gpu_ep>, CPUExecutionProvider]`).
pub(super) fn register_providers(
    builder: ort::session::builder::SessionBuilder,
    providers: &[Accelerator],
) -> SttResult<ort::session::builder::SessionBuilder> {
    builder
        .with_execution_providers(super::super::execution_providers(providers))
        .map_err(|e| SttError::SessionCreate(format!("register EPs: {e}")))
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Tensor helpers (ndarray ↔ ort::Value)
// ───────────────────────────────────────────────────────────────────────────

/// Extract a session output as an owned f32 `ArrayD`. The output may be f16 on fp16 exports —
/// we promote to f32 here so downstream argmax/logprob math is uniform (Cohere fp16 logits path).
pub(super) fn out_to_f32(out: &ort::value::DynValue) -> SttResult<ArrayD<f32>> {
    // Fast path: already f32.
    if let Ok(view) = out.try_extract_array::<f32>() {
        return Ok(view.to_owned());
    }
    // fp16 export → promote. `half::f16` is re-exported by ort's tensor element types.
    if let Ok(view) = out.try_extract_array::<F16>() {
        return Ok(view.mapv(|v| v.to_f32()));
    }
    Err(SttError::Inference(
        "output tensor is neither f32 nor f16".into(),
    ))
}

/// Extract an output as owned i64 (encoder_out_lens / mask).
pub(super) fn out_to_i64(out: &ort::value::DynValue) -> SttResult<ArrayD<i64>> {
    if let Ok(view) = out.try_extract_array::<i64>() {
        return Ok(view.to_owned());
    }
    if let Ok(view) = out.try_extract_array::<i32>() {
        return Ok(view.mapv(i64::from));
    }
    Err(SttError::Inference(
        "length/mask output is neither i64 nor i32".into(),
    ))
}

pub(super) fn out_to_mask_f32(out: &ort::value::DynValue) -> SttResult<ArrayD<f32>> {
    if let Ok(view) = out.try_extract_array::<bool>() {
        return Ok(view.mapv(|v| if v { 1.0 } else { 0.0 }));
    }
    if let Ok(view) = out.try_extract_array::<i64>() {
        return Ok(view.mapv(|v| v as f32));
    }
    if let Ok(view) = out.try_extract_array::<i32>() {
        return Ok(view.mapv(|v| v as f32));
    }
    out_to_f32(out)
        .map_err(|_| SttError::Inference("mask output is not bool, integer, f32, or f16".into()))
}

/// argmax along the last axis of a 2-D `(T, vocab)` view → `Vec<i64>` of length `T`.
pub(super) fn argmax_last_axis_2d(logits: ArrayView2<f32>) -> Vec<i64> {
    let mut out = Vec::with_capacity(logits.nrows());
    for row in logits.rows() {
        let mut best = 0usize;
        let mut best_v = f32::NEG_INFINITY;
        for (j, &v) in row.iter().enumerate() {
            if v > best_v {
                best_v = v;
                best = j;
            }
        }
        out.push(best as i64);
    }
    out
}

/// argmax over a flat 1-D logit slice (single decode step). Returns (index, value).
pub(super) fn argmax_1d(v: &[f32]) -> (usize, f32) {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &x) in v.iter().enumerate() {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    (best, best_v)
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Vocab loading (tokens.txt / vocab.txt — "<token> <id>" per line)
// ───────────────────────────────────────────────────────────────────────────

/// Load a `tokens.txt` / `vocab.txt` (`<symbol> <id>` per line) into `{id → symbol}`.
///
/// Mirrors `_AsrWithDecoding.__init__`: `▁`→space happens at LOAD here so the decode-join matches
/// onnx-asr. `rsplit(None, 1)` keeps symbols that contain whitespace intact. `base64_encoded` is
/// the SenseVoice-Nano path. Detects the `<blk>`/`<blank>` blank id and ALL-CAPS vocabs.
pub(super) struct Vocab {
    pub(super) id_to_sym: BTreeMap<i64, String>,
    pub(super) size: usize,
    pub(super) blank_idx: i64,
    pub(super) lowercase_decoded: bool,
}

impl Vocab {
    pub(super) fn load(
        path: &Path,
        base64_encoded: bool,
        replace_underscore: bool,
    ) -> SttResult<Vocab> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| SttError::Tokenizer(format!("read {}: {e}", path.display())))?;
        let mut id_to_sym = BTreeMap::new();
        for line in text.lines() {
            let stripped = line.trim_end_matches(['\n', '\r']);
            if stripped.trim().is_empty() {
                continue;
            }
            // rsplit once on the LAST whitespace run → (symbol, id).
            let Some((symbol, id_str)) = stripped.rsplit_once(char::is_whitespace) else {
                continue;
            };
            let Ok(id) = id_str.trim().parse::<i64>() else {
                continue;
            };
            let mut sym = symbol.to_string();
            if base64_encoded {
                if let Some(decoded) = b64_to_utf8(&sym) {
                    sym = decoded;
                }
            }
            if replace_underscore {
                sym = sym.replace('\u{2581}', " ");
            }
            id_to_sym.insert(id, sym);
        }
        if id_to_sym.is_empty() {
            return Err(SttError::Tokenizer(format!(
                "empty vocab {}",
                path.display()
            )));
        }
        let blank_idx = id_to_sym
            .iter()
            .find(|(_, s)| s.as_str() == "<blk>")
            .map(|(id, _)| *id)
            .unwrap_or(0);
        let lowercase_decoded = vocab_is_uppercase(id_to_sym.values().map(String::as_str));
        let size = id_to_sym.len();
        Ok(Vocab {
            id_to_sym,
            size,
            blank_idx,
            lowercase_decoded,
        })
    }

    #[inline]
    pub(super) fn get(&self, id: i64) -> Option<&str> {
        self.id_to_sym.get(&id).map(String::as_str)
    }
}

pub(super) fn b64_to_utf8(s: &str) -> Option<String> {
    // Minimal RFC4648 base64 decode (SenseVoice-Nano vocab; std-free manual decode — the `base85`
    // crate is for the Whisper alignment-heads table, not this).
    const fn val(c: u8) -> i16 {
        match c {
            b'A'..=b'Z' => (c - b'A') as i16,
            b'a'..=b'z' => (c - b'a' + 26) as i16,
            b'0'..=b'9' => (c - b'0' + 52) as i16,
            b'+' => 62,
            b'/' => 63,
            _ => -1,
        }
    }
    let bytes = s.as_bytes();
    let mut buf = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut nbits = 0u32;
    for &c in bytes {
        if c == b'=' {
            break;
        }
        let v = val(c);
        if v < 0 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            buf.push((acc >> nbits) as u8);
        }
    }
    String::from_utf8(buf).ok()
}

/// Join decoded symbols into text using onnx-asr's `DECODE_SPACE_PATTERN` semantics, then
/// lowercase if the vocab is all-caps (zipformer/icefall). The regex `\A\s|\s\B|(\s)\b` collapses
/// internal SentencePiece spacing; we reproduce its observable behavior: trim a leading space,
/// collapse a run of spaces between word-pieces to one, and keep word-boundary spaces.
pub(super) fn join_and_normalize(syms: &[&str], lowercase: bool) -> String {
    let raw: String = syms.concat();
    // Collapse the SentencePiece artifacts the way the Python regex does in the common case:
    //   - leading whitespace removed
    //   - any internal whitespace that is NOT at a word boundary removed
    // The pragmatic, parity-safe reduction: trim, then squeeze multiple spaces to one.
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = true; // strips leading
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    let trimmed = out.trim_end().to_string();
    if lowercase {
        trimmed.to_lowercase()
    } else {
        trimmed
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 10. ORT introspection + small helpers
// ───────────────────────────────────────────────────────────────────────────
//
// ⚠️ API RISK ZONE: the precise shape of `ort` 2.0.0-rc.12's input/output node accessor is the
// least-certain surface (docs.rs returns conflicting struct names). The verified facts from the
// rc.12 source are: `Session::inputs() -> &[Input]` and `outputs() -> &[Output]` (METHODS); each
// node has a public `name: String` and an `input_type`/`output_type: ValueType`; `ValueType` has
// `tensor_shape() -> Option<&Shape>` and `tensor_type() -> Option<TensorElementType>`. All raw
// field access is funneled through the four `node_*` accessors below so a single compile-loop edit
// fixes every call site if the names differ.

/// Read a STATIC dimension at `axis` of the named input, or `None` if dynamic/missing.
/// (tone.py:30-32 reads `shapes["signal"][1]` / `shapes["state"][1]` off the loaded graph.)
pub(super) fn static_input_dim(session: &Session, name: &str, axis: usize) -> Option<usize> {
    session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_shape())
        .and_then(|s| s.get(axis).copied())
        .filter(|&d| d > 0)
        .map(|d| d as usize)
}

/// Input/output node names. Uses the `inputs()`/`outputs()` methods + `.name` field.
pub(super) fn node_input_names(session: &Session) -> Vec<String> {
    session
        .inputs()
        .iter()
        .map(|i| i.name().to_string())
        .collect()
}
pub(super) fn node_output_names(session: &Session) -> Vec<String> {
    session
        .outputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect()
}

/// Declared tensor rank (dimension count) for a named output, if it is a tensor type.
pub(super) fn node_output_rank(session: &Session, name: &str) -> Option<usize> {
    session
        .outputs()
        .iter()
        .find(|o| o.name() == name)
        .and_then(|o| o.dtype().tensor_shape())
        .map(|s| s.len())
}

/// `(num_heads, head_dim, is_fp16)` for the first input whose name starts with `prefix`.
/// Shape layout assumed `(batch, num_heads, seq, head_dim)`; dims 1 and 3 are static.
pub(super) fn node_past_shape(session: &Session, prefix: &str) -> Option<(usize, usize, bool)> {
    let inp = session
        .inputs()
        .iter()
        .find(|i| i.name().starts_with(prefix))?;
    let ty = inp.dtype();
    let shape = ty.tensor_shape();
    let num_heads = shape
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .unwrap_or(8) as usize;
    let head_dim = shape
        .and_then(|s| s.get(3).copied())
        .filter(|&d| d > 0)
        .unwrap_or(128) as usize;
    let is_fp16 = matches!(
        ty.tensor_type(),
        Some(ort::value::TensorElementType::Float16)
    );
    Some((num_heads, head_dim, is_fp16))
}

/// Feature-dim (mel bins) declared by a model input shaped `(batch, FEAT, time)` — e.g.
/// NeMo `audio_signal`. NeMo varies (parakeet-ctc=80, canary=128); read it from the graph so
/// the featurizer builds the matching filterbank. Falls back to 128 when dynamic/unknown.
pub(super) fn feat_dim_of(session: &Session, name: &str) -> usize {
    session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_shape())
        .and_then(|s| s.get(1).copied())
        .filter(|&d| d > 0)
        .map(|d| d as usize)
        .unwrap_or(128)
}

/// Zero-init shape `[dim0, 1, dim2]` for a NeMo RNN-T predictor state input (`input_states_1/2`,
/// declared `(num_layers, batch, hidden)`). Mirrors onnx-asr `_create_state`.
pub(super) fn input_state_shape(session: &Session, name: &str) -> Vec<usize> {
    let dims = session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_shape());
    let d0 = dims
        .and_then(|s| s.first().copied())
        .filter(|&d| d > 0)
        .unwrap_or(1) as usize;
    let d2 = dims
        .and_then(|s| s.get(2).copied())
        .filter(|&d| d > 0)
        .unwrap_or(640) as usize;
    vec![d0, 1, d2]
}

/// `(layers, hidden)` from a named input's declared `(layers, batch, seq, hidden)` shape.
pub(super) fn node_input_outer_inner(session: &Session, name: &str) -> Option<(usize, usize)> {
    let inp = session.inputs().iter().find(|i| i.name() == name)?;
    let shape = inp.dtype().tensor_shape()?;
    let layers = shape.first().copied().filter(|&d| d > 0).unwrap_or(1) as usize;
    let hidden = shape.get(3).copied().filter(|&d| d > 0).unwrap_or(1024) as usize;
    Some((layers, hidden))
}

pub(crate) fn file<'a>(resolved: &'a ResolvedModel, key: &str) -> SttResult<&'a Path> {
    resolved
        .files
        .get(key)
        .map(PathBuf::as_path)
        .ok_or_else(|| SttError::Resolve(format!("resolved model missing file key '{key}'")))
}

pub(super) fn providers_to_strings(providers: &[Accelerator]) -> Vec<String> {
    providers
        .iter()
        .map(|a| {
            match a {
                Accelerator::Cpu => "CPUExecutionProvider",
                Accelerator::Cuda => "CUDAExecutionProvider",
                Accelerator::DirectMl => "DmlExecutionProvider",
                Accelerator::CoreMl => "CoreMLExecutionProvider",
                Accelerator::Rocm => "ROCMExecutionProvider",
                Accelerator::OpenVino => "OpenVINOExecutionProvider",
            }
            .to_string()
        })
        .collect()
}

pub(super) fn session_input_names(session: &Session) -> Vec<String> {
    node_input_names(session)
}

pub(super) fn session_output_names(session: &Session) -> Vec<String> {
    node_output_names(session)
}

/// Read the ONNX model's `custom_metadata_map` as a String→String map.
pub(super) fn read_custom_metadata(session: &Session) -> SttResult<BTreeMap<String, String>> {
    let meta = session
        .metadata()
        .map_err(|e| SttError::SessionCreate(format!("metadata: {e}")))?;
    let mut out = BTreeMap::new();
    if let Ok(entries) = meta.custom_keys() {
        for k in entries {
            // `custom(key) -> Option<String>` in rc.12 (NOT Result).
            if let Some(v) = meta.custom(&k) {
                out.insert(k, v);
            }
        }
    }
    Ok(out)
}

/// Pick the (feat, len) input names. Dolphin: `x`/`x_len`; NeMo: `audio_signal`/`length`;
/// GigaAM: `features`/`feature_lengths`. Falls back to the first two declared inputs.
pub(super) fn pick_feat_len_inputs(inputs: &[String]) -> (String, String) {
    let has = |n: &str| inputs.iter().any(|i| i == n);
    let feat = if has("x") {
        "x"
    } else if has("audio_signal") {
        "audio_signal"
    } else if has("features") {
        "features"
    } else {
        inputs.first().map(String::as_str).unwrap_or("x")
    };
    let len = if has("x_len") {
        "x_len"
    } else if has("length") {
        "length"
    } else if has("feature_lengths") {
        "feature_lengths"
    } else {
        inputs.get(1).map(String::as_str).unwrap_or("x_len")
    };
    (feat.to_string(), len.to_string())
}

/// Pick the 3-D log-prob output (`logprobs`/`log_probs`/`lob_probs`) by name, else by rank.
pub(super) fn pick_logits_output(session: &Session, outputs: &[String]) -> String {
    for cand in ["logprobs", "log_probs", "lob_probs"] {
        if outputs.iter().any(|o| o == cand) {
            return cand.to_string();
        }
    }
    // by rank: first output whose declared tensor shape has length 3.
    for name in outputs {
        if node_output_rank(session, name) == Some(3) {
            return name.clone();
        }
    }
    outputs
        .first()
        .cloned()
        .unwrap_or_else(|| "logprobs".into())
}

pub(super) fn filter_sorted_inputs(session: &Session, prefix: &str) -> Vec<String> {
    let mut v: Vec<String> = node_input_names(session)
        .into_iter()
        .filter(|n| n.starts_with(prefix))
        .collect();
    v.sort();
    v
}

pub(super) fn filter_sorted_outputs(session: &Session, prefix: &str) -> Vec<String> {
    let mut v: Vec<String> = node_output_names(session)
        .into_iter()
        .filter(|n| n.starts_with(prefix))
        .collect();
    v.sort();
    v
}

/// Read the first `past_key_values.*` input's `(num_heads, head_dim, is_fp16)` (§6.5 dtype read).
pub(super) fn cohere_past_shape(session: &Session) -> SttResult<(usize, usize, bool)> {
    node_past_shape(session, "past_key_values.").ok_or_else(|| {
        SttError::SessionCreate("cohere decoder has no past_key_values input".into())
    })
}

pub(super) fn load_granite_tokenizer(path: &Path) -> SttResult<tokenizers::Tokenizer> {
    tokenizers::Tokenizer::from_file(path)
        .map_err(|e| SttError::Tokenizer(format!("load {}: {e}", path.display())))
}

pub(super) fn run_embed_tokens(
    session: &mut Session,
    ids: &[i64],
    label: &str,
) -> SttResult<ndarray::Array3<f32>> {
    let outputs = session
        .run(ort::inputs![
            "input_ids" => tensor_i64((1, ids.len()), ids.to_vec())?
        ])
        .map_err(|e| SttError::Inference(format!("{label} embed_tokens run: {e}")))?;
    out_to_f32(&outputs["inputs_embeds"])?
        .into_dimensionality::<ndarray::Ix3>()
        .map_err(|e| SttError::Inference(format!("{label} inputs_embeds dim: {e}")))
}

pub(super) fn granite_decode_tokens(
    tokenizer: &tokenizers::Tokenizer,
    ids: &[i64],
) -> SttResult<String> {
    let ids: Vec<u32> = ids
        .iter()
        .copied()
        .filter(|&id| id >= 0)
        .map(|id| id as u32)
        .collect();
    tokenizer
        .decode(&ids, true)
        .map(|s| s.trim().to_string())
        .map_err(|e| SttError::Tokenizer(format!("granite decode: {e}")))
}

pub(super) fn causal_attention_mask(n: usize) -> ndarray::Array4<f32> {
    let mut mask = ndarray::Array4::<f32>::zeros((1, 1, n, n));
    for i in 0..n {
        for j in i + 1..n {
            mask[[0, 0, i, j]] = -1.0e4;
        }
    }
    mask
}

pub(super) fn read_special_id(
    cfg_path: Option<&Path>,
    key: &str,
    token_to_id: &BTreeMap<String, i64>,
    fallback_token: &str,
    hard_default: i64,
) -> i64 {
    if let Some(path) = cfg_path {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(id) = v.get(key).and_then(|x| x.as_i64()) {
                    return id;
                }
            }
        }
    }
    token_to_id
        .get(fallback_token)
        .copied()
        .unwrap_or(hard_default)
}

pub(super) fn is_special_token(token: &str) -> bool {
    (token.starts_with("<|") && token.ends_with("|>")) || token == "<unk>" || token == "<pad>"
}

/// Extract the final decode-step logit row from a `(1, S, vocab)` or `(1, vocab)` logits array.
pub(super) fn last_step_row(logits: &ArrayD<f32>) -> SttResult<Vec<f32>> {
    match logits.ndim() {
        3 => {
            let l = logits
                .view()
                .into_dimensionality::<ndarray::Ix3>()
                .map_err(|e| SttError::Inference(format!("logits ix3: {e}")))?;
            let s = l.shape()[1];
            Ok(l.index_axis(ndarray::Axis(0), 0)
                .index_axis(ndarray::Axis(0), s - 1)
                .to_vec())
        }
        2 => {
            let l = logits
                .view()
                .into_dimensionality::<ndarray::Ix2>()
                .map_err(|e| SttError::Inference(format!("logits ix2: {e}")))?;
            Ok(l.index_axis(ndarray::Axis(0), 0).to_vec())
        }
        _ => Err(SttError::Inference("unexpected logits rank".into())),
    }
}

/// Decoder_mems shape `(layers, 1, 0, hidden)` from the decoder input metadata (mem_len starts 0).
pub(super) fn dms_shape(decoder: &Session) -> Vec<usize> {
    if let Some((layers, hidden)) = node_input_outer_inner(decoder, "decoder_mems") {
        return vec![layers, 1, 0, hidden];
    }
    vec![1, 1, 0, 1024]
}

// ── Dynamic named-input vector helpers (for the variadic Cohere KV-cache) ──
//
// `ort::inputs![]` is fixed-arity; the Cohere decoder needs 5 fixed inputs + N past_key_values.*
// (dtype-matched f32/f16). `Session::run` accepts `Vec<(Cow<str>, SessionInputValue)>` via
// `Into<SessionInputs>`, so we build that vector explicitly.

pub(super) type NamedInput = (
    std::borrow::Cow<'static, str>,
    ort::session::SessionInputValue<'static>,
);

/// A KV-cache tensor that is either f32 or f16 (matches the decoder's declared past dtype).
///
/// Defined here in the shared layer (not with the AED engines) because the `push_past_kv` /
/// `carry_present` helpers below operate on it; the `aed` engines re-use it via `super::support`.
pub(super) enum KvTensor {
    F32(ArrayD<f32>),
    F16(ArrayD<F16>),
}

pub(super) fn tensor_i64(shape: (usize, usize), data: Vec<i64>) -> SttResult<Tensor<i64>> {
    let arr = ndarray::Array2::from_shape_vec(shape, data)
        .map_err(|e| SttError::Inference(format!("i64 array: {e}")))?;
    Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i64 tensor: {e}")))
}

/// Scalar i64 (0-D tensor) — e.g. `num_logits_to_keep`.
pub(super) fn scalar_i64(v: i64) -> SttResult<Tensor<i64>> {
    let arr = ndarray::Array0::from_elem((), v);
    Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("scalar i64: {e}")))
}

/// 1-D i64 vector tensor — e.g. lengths `[T]`.
pub(super) fn tensor_i64_1d(data: Vec<i64>) -> SttResult<Tensor<i64>> {
    let arr = ndarray::Array1::from_vec(data);
    Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i64 1d tensor: {e}")))
}

/// 1-D i32 vector tensor — SenseVoice control inputs.
pub(super) fn tensor_i32_1d(data: Vec<i32>) -> SttResult<Tensor<i32>> {
    let arr = ndarray::Array1::from_vec(data);
    Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i32 1d tensor: {e}")))
}

pub(super) fn tensor_i32(shape: (usize, usize), data: Vec<i32>) -> SttResult<Tensor<i32>> {
    let arr = ndarray::Array2::from_shape_vec(shape, data)
        .map_err(|e| SttError::Inference(format!("i32 array: {e}")))?;
    Tensor::from_array(arr).map_err(|e| SttError::Inference(format!("i32 tensor: {e}")))
}

pub(super) fn push_tensor<T>(inputs: &mut Vec<NamedInput>, name: &'static str, tensor: Tensor<T>)
where
    T: ort::value::PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static,
{
    // `SessionInputValue: From<Value<T>>` (Tensor<T> = Value<TensorValueTypeMarker<T>>) → direct.
    inputs.push((
        std::borrow::Cow::Borrowed(name),
        ort::session::SessionInputValue::from(tensor),
    ));
}

/// Push the host past-KV arrays (dtype-matched) as named inputs (§6.5 fp16 carry).
pub(super) fn push_past_kv(
    inputs: &mut Vec<NamedInput>,
    names: &[String],
    state: &BTreeMap<String, KvTensor>,
) -> SttResult<()> {
    for name in names {
        let kv = state
            .get(name)
            .ok_or_else(|| SttError::Inference(format!("missing KV state for {name}")))?;
        let value: ort::session::SessionInputValue<'static> = match kv {
            KvTensor::F32(a) => {
                let t = Tensor::from_array(a.clone())
                    .map_err(|e| SttError::Inference(format!("kv f32 {name}: {e}")))?;
                ort::session::SessionInputValue::from(t)
            }
            KvTensor::F16(a) => {
                let t = Tensor::from_array(a.clone())
                    .map_err(|e| SttError::Inference(format!("kv f16 {name}: {e}")))?;
                ort::session::SessionInputValue::from(t)
            }
        };
        inputs.push((std::borrow::Cow::Owned(name.clone()), value));
    }
    Ok(())
}

/// Carry present.* outputs into the next step's past_key_values.* (dtype-preserving).
pub(super) fn carry_present(
    outputs: &ort::session::SessionOutputs<'_>,
    past_names: &[String],
    present_names: &[String],
    is_fp16: bool,
) -> SttResult<BTreeMap<String, KvTensor>> {
    let mut next = BTreeMap::new();
    for (past, present) in past_names.iter().zip(present_names.iter()) {
        let val = &outputs[present.as_str()];
        let kv = if is_fp16 {
            let arr = val
                .try_extract_array::<F16>()
                .map_err(|e| SttError::Inference(format!("carry present f16 {present}: {e}")))?;
            KvTensor::F16(arr.to_owned())
        } else {
            let arr = val
                .try_extract_array::<f32>()
                .map_err(|e| SttError::Inference(format!("carry present f32 {present}: {e}")))?;
            KvTensor::F32(arr.to_owned())
        };
        next.insert(past.clone(), kv);
    }
    Ok(next)
}
