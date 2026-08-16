// Shared engine infrastructure used by every non-Whisper STT family sub-engine:
//   * ORT session construction + EP registration,
//   * tensor/ndarray ↔ ort conversion + argmax + named-input / KV push & carry helpers,
//   * `Vocab` loader,
//   * ORT session introspection + path/tokenizer helpers.
//
// Lifted verbatim out of the old monolithic `families.rs`; the engine sub-files
// (`ctc`, `transducer`, `aed`) call these via `use super::support::*`. Most fns are `pub(super)`
// so the leakage stays inside the `families/` module tree (it does not widen the crate API).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ndarray::{ArrayD, ArrayView1, ArrayView2};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use super::super::{
    Accelerator, ResolvedModel, SttError, SttResult, configure_session, num_cpus_best_effort,
    pick_intra_op_threads, provider_label, vocab_is_uppercase,
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
    build_session_with_optimization(path, providers, GraphOptimizationLevel::Level3)
}

pub(super) fn build_session_with_optimization(
    path: &Path,
    providers: &[Accelerator],
    optimization_level: GraphOptimizationLevel,
) -> SttResult<Session> {
    let is_gpu = providers
        .first()
        .is_some_and(|p| !matches!(p, Accelerator::Cpu));
    let threads = pick_intra_op_threads(is_gpu, num_cpus_best_effort());

    // Optimization level `ORT_ENABLE_ALL` (Level3) normally; intra-op threads via
    // `pick_intra_op_threads` (CPU→physical, GPU→2). DirectML session config (L1): ORT's DirectML
    // EP is incompatible with the memory-pattern planner — it allocates/manages its own device
    // memory, so EnableMemPattern must be OFF (the ORT DML docs require DisableMemPattern +
    // ORT_SEQUENTIAL). Parallel execution is already OFF by default (the builder defaults to
    // Sequential), so we only need to disable mem-pattern. It's also the right call for our
    // DYNAMIC-length audio inputs (shapes vary every call → the memory pattern can't be reused and
    // just adds planning overhead). CPU/CUDA keep the default (mem-pattern on) — validated
    // separately. EPs are the FINAL, already-policy-routed list from `EngineConfig.providers`.
    let mut builder = configure_session(optimization_level, Some(threads), is_gpu, Some(providers))
        .map_err(SttError::SessionCreate)?;

    builder
        .commit_from_file(path)
        .map_err(|e| SttError::SessionCreate(format!("commit_from_file {}: {e}", path.display())))
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
#[cfg(test)]
pub(super) fn argmax_last_axis_2d(logits: ArrayView2<'_, f32>) -> Vec<i64> {
    let mut out = Vec::with_capacity(logits.nrows());
    for row in logits.rows() {
        out.push(argmax_row(row));
    }
    out
}

#[inline]
fn argmax_row(row: ArrayView1<'_, f32>) -> i64 {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (j, &v) in row.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = j;
        }
    }
    best as i64
}

/// Append CTC greedy-decoded token IDs directly from `(T, vocab)` logits.
///
/// This is equivalent to `argmax_last_axis_2d` followed by `ctc_greedy_collapse`, while preserving
/// the previous frame across chunk boundaries for streaming models. `valid_frames` masks trailing
/// padded frames the same way as forcing them to blank before collapse.
pub(super) fn append_ctc_greedy_ids_from_logits(
    logits: ArrayView2<'_, f32>,
    blank_id: i64,
    valid_frames: usize,
    prev_token: &mut i64,
    out: &mut Vec<i64>,
) {
    let limit = logits.nrows().min(valid_frames);
    out.reserve(limit);
    for row in logits.rows().into_iter().take(limit) {
        let token = argmax_row(row);
        if token != blank_id && token != *prev_token {
            out.push(token);
        }
        *prev_token = token;
    }
}

/// One-shot CTC greedy decode from logits with an optional valid-frame cap.
pub(super) fn ctc_greedy_ids_from_logits(
    logits: ArrayView2<'_, f32>,
    blank_id: i64,
    valid_frames: usize,
) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut prev_token = -1;
    append_ctc_greedy_ids_from_logits(logits, blank_id, valid_frames, &mut prev_token, &mut ids);
    ids
}

/// argmax over a flat 1-D logit slice (single decode step). Returns (index, value).
///
/// The one scalar linear-max scan for the STT engines — `families` use the `(index, value)` pair
/// directly; `whisper`/`moonshine` wrap it for their last-position / 2-D shapes.
pub(crate) fn argmax_1d(v: &[f32]) -> (usize, f32) {
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

/// argmax over a 1-D ndarray view without materializing the row.
pub(super) fn argmax_view1(v: ArrayView1<'_, f32>) -> (usize, f32) {
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
            if base64_encoded && let Some(decoded) = b64_to_utf8(&sym) {
                sym = decoded;
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
        // `<blk>` (sherpa/GigaAM) or `<blank>` (icefall CTC — e.g. zipformer_p-arabic-v2, where
        // blank is 250 and id 0 is a REAL token, so falling back to 0 would eat that token).
        let blank_idx = id_to_sym
            .iter()
            .find(|(_, s)| matches!(s.as_str(), "<blk>" | "<blank>"))
            .map_or(0, |(id, _)| *id);
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

/// Join vocab IDs into text with the same whitespace/lowercase semantics as `join_and_normalize`,
/// but without first collecting borrowed symbol slices or building the raw concatenated string.
pub(super) fn join_ids_and_normalize(ids: &[i64], vocab: &Vocab) -> String {
    let mut out = String::new();
    let mut prev_space = true;
    for &id in ids {
        if let Some(sym) = vocab.get(id) {
            push_normalized_symbol(&mut out, sym, &mut prev_space);
        }
    }
    let trimmed_len = out.trim_end().len();
    out.truncate(trimmed_len);
    if vocab.lowercase_decoded {
        out.to_lowercase()
    } else {
        out
    }
}

fn push_normalized_symbol(out: &mut String, sym: &str, prev_space: &mut bool) {
    for ch in sym.chars() {
        if ch.is_whitespace() {
            if !*prev_space {
                out.push(' ');
            }
            *prev_space = true;
        } else {
            out.push(ch);
            *prev_space = false;
        }
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

/// Read an input tensor shape, replacing dynamic/unknown dimensions with `dynamic_fallback`.
pub(super) fn input_shape_or(
    session: &Session,
    name: &str,
    dynamic_fallback: usize,
) -> Option<Vec<usize>> {
    session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_shape())
        .map(|shape| {
            shape
                .iter()
                .map(|&d| if d > 0 { d as usize } else { dynamic_fallback })
                .collect()
        })
}

pub(super) fn input_is_i64(session: &Session, name: &str) -> bool {
    session
        .inputs()
        .iter()
        .find(|i| i.name() == name)
        .and_then(|i| i.dtype().tensor_type())
        .is_some_and(|ty| matches!(ty, ort::value::TensorElementType::Int64))
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
        .map_or(128, |d| d as usize)
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
    providers.iter().map(provider_label).collect()
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
        inputs.first().map_or("x", String::as_str)
    };
    let len = if has("x_len") {
        "x_len"
    } else if has("length") {
        "length"
    } else if has("feature_lengths") {
        "feature_lengths"
    } else {
        inputs.get(1).map_or("x_len", String::as_str)
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
    if let Some(path) = cfg_path
        && let Ok(text) = std::fs::read_to_string(path)
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(id) = v.get(key).and_then(|x| x.as_i64())
    {
        return id;
    }
    token_to_id
        .get(fallback_token)
        .copied()
        .unwrap_or(hard_default)
}

pub(super) fn is_special_token(token: &str) -> bool {
    (token.starts_with("<|") && token.ends_with("|>")) || token == "<unk>" || token == "<pad>"
}

/// Strip the Cohere/AED decoder's inline NON-SPEECH EVENT annotations from finished text
/// (`<hesitation>`, `<laugh>`, `<cough>`, …). The model emits these as ordinary sub-word text —
/// NOT as `<|…|>` control tokens — so `is_special_token` never sees them; they must be removed
/// from the decoded string. A `<…>` span is removed only when its interior is a non-speech marker:
/// either `<lowercase_ascii/underscore>` (the event tags, e.g. `<hesitation>`) or a `<|…|>` control
/// token in text form (defensive — usually already token-stripped, but a sub-word-assembled one
/// would slip through). Any other angle-bracket content (`5 < 10 > 3`, `<Foo>`, `<3`) is left
/// untouched. The single space a mid-sentence removal would double up is collapsed, then trimmed.
pub(super) fn strip_inline_event_tags(s: &str) -> String {
    fn strippable(inner: &str) -> bool {
        (inner.starts_with('|') && inner.ends_with('|') && inner.len() >= 2)
            || (!inner.is_empty() && inner.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let after = &rest[lt + 1..];
        if let Some(gt) = after.find('>')
            && strippable(&after[..gt])
        {
            rest = &after[gt + 1..]; // drop the whole `<tag>`
            continue;
        }
        out.push('<');
        rest = after;
    }
    out.push_str(rest);
    // collapse the doubled ASCII space a removed tag leaves ("a  b" -> "a b"); trim.
    let mut collapsed = String::with_capacity(out.len());
    let mut prev_space = false;
    for ch in out.chars() {
        if ch == ' ' {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    collapsed.trim().to_string()
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
            if s == 0 {
                return Err(SttError::Inference("empty logits sequence".into()));
            }
            Ok(l.index_axis(ndarray::Axis(0), 0)
                .index_axis(ndarray::Axis(0), s - 1)
                .to_vec())
        }
        2 => {
            let l = logits
                .view()
                .into_dimensionality::<ndarray::Ix2>()
                .map_err(|e| SttError::Inference(format!("logits ix2: {e}")))?;
            if l.shape()[0] == 0 {
                return Err(SttError::Inference("empty logits batch".into()));
            }
            Ok(l.index_axis(ndarray::Axis(0), 0).to_vec())
        }
        _ => Err(SttError::Inference("unexpected logits rank".into())),
    }
}

/// Argmax over the final decode-step logit row from `(1, S, vocab)` or `(1, vocab)` logits.
pub(super) fn argmax_last_step(logits: &ArrayD<f32>) -> SttResult<(usize, f32)> {
    Ok(argmax_1d(&last_step_row(logits)?))
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
// `Into<SessionInputs>`, so the AED engines build that vector explicitly inline.

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

/// Argmax over an f32 iterator without materializing a slice (streaming joiner/CTC rows).
/// Same first-max-wins semantics as `argmax_1d`; empty input → `(0, NEG_INFINITY)`.
pub(super) fn argmax_iter(values: impl Iterator<Item = f32>) -> (usize, f32) {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, x) in values.enumerate() {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    (best, best_v)
}

/// Longest token cycle the phrase-loop guard scans for. A looped sentence tokenizes to ~10–30
/// SentencePiece pieces; 100 leaves margin for byte-fallback-heavy (non-Latin) text.
const PHRASE_LOOP_MAX_CYCLE: usize = 100;
/// Verbatim occurrences before a multi-token cycle counts as a loop. Genuine dictation almost never
/// repeats the same sentence 3× token-identically (punctuation included); hallucination loops run
/// until the token budget.
const PHRASE_LOOP_MIN_OCCURRENCES: usize = 3;
/// Stricter threshold for 1–2-token cycles, where short verbatim runs ("no, no, no…") are
/// legitimate speech.
const PHRASE_LOOP_MIN_OCCURRENCES_SHORT: usize = 6;

/// Phrase-loop guard for the maskless greedy AED decodes (Cohere/Canary/Granite-AR/Qwen3). These
/// decoders have no encoder attention mask in their ONNX export, so trailing silence — mic tail,
/// the trailing-pad word guard, or the DirectML encoder pad bucket's zeros — can pull the greedy
/// path into re-emitting one sentence verbatim until the token budget ("phrase loop"; the
/// consecutive-identical-token guards never fire because the tokens differ within each cycle).
///
/// Call after every generated token. Returns `Some(keep_len)` when the tail of `generated` is at
/// least `PHRASE_LOOP_MIN_OCCURRENCES` verbatim repeats of one cycle (≥`…_SHORT` for 1–2-token
/// cycles): truncate to `keep_len` — which keeps exactly ONE occurrence (the dominant loop mode
/// re-emits the final GENUINE sentence, so the first occurrence is real speech) — and stop the
/// decode (the model is in a hallucination attractor; continuing only re-loops). `None` on any
/// sequence whose tail is not a verbatim cycle — clean decodes are untouched, matching the
/// reference Cohere implementations' pure-greedy design (no logits penalty).
pub(super) fn phrase_loop_truncation(generated: &[i64]) -> Option<usize> {
    let len = generated.len();
    for cycle_len in 1..=PHRASE_LOOP_MAX_CYCLE.min(len / 2) {
        let min_occ = if cycle_len <= 2 {
            PHRASE_LOOP_MIN_OCCURRENCES_SHORT
        } else {
            PHRASE_LOOP_MIN_OCCURRENCES
        };
        let span = cycle_len * min_occ;
        if span > len {
            continue;
        }
        // The last `span` tokens are `min_occ` copies of the final `cycle_len`-gram exactly when
        // every position in the span matches the token one cycle later.
        if generated[len - span..len - cycle_len]
            .iter()
            .zip(&generated[len - span + cycle_len..])
            .all(|(a, b)| a == b)
        {
            return Some(len - (min_occ - 1) * cycle_len);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use ndarray::array;

    use super::*;

    #[test]
    fn fused_ctc_logits_matches_argmax_collapse_with_valid_frame_mask() {
        let logits = array![
            [0.0, 3.0, 1.0],
            [0.0, 2.0, 1.0],
            [4.0, 1.0, 0.0],
            [0.0, 5.0, 1.0],
            [0.0, 1.0, 6.0],
            [0.0, 7.0, 1.0],
        ];
        let blank = 0;
        let valid_frames = 5;

        let mut ids = argmax_last_axis_2d(logits.view());
        for id in ids.iter_mut().skip(valid_frames) {
            *id = blank;
        }
        let expected = crate::winstt::stt::ctc_greedy_collapse(&ids, blank);
        let actual = ctc_greedy_ids_from_logits(logits.view(), blank, valid_frames);

        assert_eq!(actual, expected);
        assert_eq!(actual, vec![1, 1, 2]);
    }

    #[test]
    fn streaming_ctc_append_preserves_cross_chunk_previous_token() {
        let first = array![[0.0, 3.0, 1.0], [0.0, 2.0, 1.0], [4.0, 1.0, 0.0]];
        let second = array![[0.0, 5.0, 1.0], [0.0, 1.0, 6.0]];

        let mut ids = Vec::new();
        let mut prev = -1;
        append_ctc_greedy_ids_from_logits(first.view(), 0, usize::MAX, &mut prev, &mut ids);
        append_ctc_greedy_ids_from_logits(second.view(), 0, usize::MAX, &mut prev, &mut ids);

        assert_eq!(ids, vec![1, 1, 2]);
    }

    #[test]
    fn phrase_loop_fires_on_third_sentence_repeat_and_keeps_one() {
        // Genuine prefix [1..=4], then a 5-token "sentence" looped verbatim. The guard fires the
        // moment the 3rd occurrence completes and keeps the prefix + ONE occurrence.
        let sentence = [10, 11, 12, 13, 14];
        let mut generated = vec![1, 2, 3, 4];
        for _ in 0..2 {
            generated.extend_from_slice(&sentence);
            assert_eq!(phrase_loop_truncation(&generated), None);
        }
        generated.extend_from_slice(&sentence);
        assert_eq!(phrase_loop_truncation(&generated), Some(4 + sentence.len()));
    }

    #[test]
    fn phrase_loop_fires_at_cycle_boundary_when_checked_every_token() {
        // Per-token checking catches the loop exactly at the boundary — a partial 4th cycle never
        // accumulates because the decode stops on the first Some.
        let mut generated = Vec::new();
        let mut fired_at = None;
        for step in 0..40 {
            generated.push([20, 21, 22][step % 3]);
            if phrase_loop_truncation(&generated).is_some() {
                fired_at = Some(generated.len());
                break;
            }
        }
        assert_eq!(fired_at, Some(9)); // exactly three 3-token cycles
    }

    #[test]
    fn phrase_loop_short_cycles_need_six_occurrences() {
        // "no, no, no" style 1–2-token runs are legitimate speech — 5 identical tokens pass…
        assert_eq!(phrase_loop_truncation(&[7; 5]), None);
        // …the 6th fires and collapses the run to one token.
        assert_eq!(phrase_loop_truncation(&[7; 6]), Some(1));
        // Same for a 2-token cycle: five pairs pass, the sixth fires keeping one pair.
        let pair: Vec<i64> = [8, 9].repeat(5);
        assert_eq!(phrase_loop_truncation(&pair), None);
        assert_eq!(phrase_loop_truncation(&[8, 9].repeat(6)), Some(2));
    }

    #[test]
    fn phrase_loop_is_noop_on_clean_and_near_miss_sequences() {
        assert_eq!(phrase_loop_truncation(&[]), None);
        assert_eq!(phrase_loop_truncation(&[1, 2, 3, 4, 5, 6, 7, 8]), None);
        // Two verbatim occurrences of a multi-token cycle stay untouched (threshold is 3).
        assert_eq!(phrase_loop_truncation(&[5, 6, 7, 5, 6, 7]), None);
        // A one-token mutation inside the would-be third cycle breaks the verbatim match.
        assert_eq!(phrase_loop_truncation(&[5, 6, 7, 5, 6, 7, 5, 99, 7]), None);
    }

    #[test]
    fn join_ids_and_normalize_matches_symbol_join() {
        let mut id_to_sym = BTreeMap::new();
        id_to_sym.insert(1, " HELLO".to_string());
        id_to_sym.insert(2, "  ".to_string());
        id_to_sym.insert(3, "WORLD ".to_string());
        let vocab = Vocab {
            id_to_sym,
            size: 3,
            blank_idx: 0,
            lowercase_decoded: true,
        };
        let ids = [1, 2, 3, 99];
        let syms: Vec<&str> = ids.iter().filter_map(|&id| vocab.get(id)).collect();

        assert_eq!(
            join_ids_and_normalize(&ids, &vocab),
            join_and_normalize(&syms, vocab.lowercase_decoded)
        );
    }
}
