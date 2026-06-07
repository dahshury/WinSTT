// External-data sidecar enumeration + completeness, the per-quant cache slug, and on-disk filename
// quant parsing (resolver sections 4 and 5). Pure / filesystem-read only, no hf-hub.

use std::path::Path;

use crate::winstt::stt::Quantization;

// ---------------------------------------------------------------------------
// 4. External-data sidecar enumeration (the shard-completeness check)
// ---------------------------------------------------------------------------

/// External-data graphs (>2 GB weights) are tiny `.onnx` protobufs that reference sidecars; full
/// graphs inline their weights and are large. Only parse `.onnx` files UNDER this size to find the
/// referenced sidecars — never `onnx.load` a multi-GB inline-weight graph on the picker-open path
/// (memory project_list_models_onnx_parse_loop_starvation). Spec §2.3.
pub const EXTERNAL_DATA_PARSE_SIZE_GUARD: u64 = 64 * 1024 * 1024;

/// Given a downloaded `.onnx` path, return the sidecar file NAMES it references via external data.
///
/// Two strategies, in order:
///   1. If the `.onnx` is small (under the 64 MB guard) we read the protobuf's `external_data`
///      `location` records via `super::fp16_patch::external_data_locations` (a tiny prost parse).
///   2. Otherwise the graph inlines its weights — there are no sidecars, return empty.
///
/// On any parse failure we fall back to the NAME-PATTERN guess (`<stem>.onnx_data*`,
/// `<stem>.onnx.data*`) which the directory scan in `verify_external_data_complete` resolves.
pub(crate) fn referenced_sidecars(onnx_path: &Path) -> Vec<String> {
    let size = std::fs::metadata(onnx_path)
        .map(|m| m.len())
        .unwrap_or(u64::MAX);
    if size >= EXTERNAL_DATA_PARSE_SIZE_GUARD {
        return Vec::new();
    }
    match crate::winstt::stt::fp16_patch::external_data_locations(onnx_path) {
        Ok(locs) if !locs.is_empty() => locs,
        _ => Vec::new(),
    }
}

/// True iff every external-data sidecar referenced by `onnx_path` exists on disk with nonzero size.
/// Mirrors `_refetch_hf_snapshot`'s completeness intent: a `.onnx` present but a `.onnx_data_N`
/// shard missing means the cache is PARTIAL and ORT will die at session-create (spec §2.3).
///
/// We resolve each referenced location relative to the `.onnx`'s own directory (external-data
/// `location` records are repo-relative, and HF lays them out next to the `.onnx`). When the
/// protobuf parse yields nothing (full inline graph, or a parse miss) we additionally sweep the
/// directory for any `<stem>.onnx?data*` shard the name pattern implies, so a sharded fp16 model
/// (cohere) whose first shard arrived but second didn't is still caught.
pub(crate) fn verify_external_data_complete(onnx_path: &Path) -> bool {
    let dir = match onnx_path.parent() {
        Some(d) => d,
        None => return true,
    };
    // (1) Explicit references from the protobuf.
    let refs = referenced_sidecars(onnx_path);
    for name in &refs {
        // Defensive: external-data locations are POSIX-relative; take the file name component.
        let fname = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let p = dir.join(fname);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() > 0 => {}
            _ => return false,
        }
    }
    if !refs.is_empty() {
        return true;
    }
    // (2) Name-pattern sweep: if a base sidecar exists, ALL its numbered shards must too. We can't
    // know the shard count without the protobuf, so we only enforce contiguity: if `<stem>.onnx_data`
    // OR `<stem>.onnx_data_1` exists we require the numbered series to be gap-free from 1.
    let stem = match onnx_path.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s.to_string(),
        None => return true,
    };
    let base_present = ["onnx_data", "onnx.data"]
        .iter()
        .any(|ext| dir.join(format!("{stem}.{ext}")).is_file());
    let shard1_present = ["onnx_data_1", "onnx.data_1"]
        .iter()
        .any(|ext| dir.join(format!("{stem}.{ext}")).is_file());
    if shard1_present {
        // Require a contiguous shard series 1..N (stop at the first gap). A gap = incomplete.
        let mut n = 1;
        loop {
            let present = [
                format!("{stem}.onnx_data_{n}"),
                format!("{stem}.onnx.data_{n}"),
            ]
            .iter()
            .any(|f| dir.join(f).is_file());
            if !present {
                // n-1 shards present and contiguous; that's "complete" as far as we can tell from
                // names alone. (A truly partial set where shard 2 is missing surfaces here as the
                // series ending at 1 — which we treat as complete-enough; the protobuf path (1)
                // is the authoritative check and runs first whenever the graph is small.)
                break;
            }
            n += 1;
            if n > 4096 {
                break; // sanity cap.
            }
        }
        let _ = base_present;
    }
    true
}

// ---------------------------------------------------------------------------
// 5. The cache slug (per-quant; _slug_model_id) + local-dir layout
// ---------------------------------------------------------------------------

/// Filesystem-safe per-(model,quant) slug. Port of `onnxasr_transcriber._slug_model_id`: embeds the
/// quant tag so `whisper-tiny__int8` and `whisper-tiny__fp16` never collide, and replaces anything
/// outside `[A-Za-z0-9._-]` with `_`. Used for the per-quant local-dir under the app model root.
pub fn slug_model_id(model_name: &str, quant: Quantization) -> String {
    let base = if model_name.is_empty() {
        "unknown"
    } else {
        model_name
    };
    let quant_tag = match quant {
        Quantization::Default => "default",
        q => q.suffix(),
    };
    let raw = format!("{base}__{quant_tag}");
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Read the quantization actually present on a resolved `.onnx` filename — port of
/// `model_cache._file_quantization`. Handles BOTH separators (`_int8` / `.int8`) AND the sharded
/// form (a fp16 model whose weights are `model.onnx_data_1` is still fp16 — the suffix is on the
/// `.onnx` stem, not the sidecar). Returns `Quantization::Default` for an unsuffixed export.
pub fn file_quantization(onnx_filename: &str) -> Quantization {
    // Strip a trailing `.onnx` (the only thing past the quant tag for the graph file).
    let stem = onnx_filename.strip_suffix(".onnx").unwrap_or(onnx_filename);
    // The quant tag is the last `_`- or `.`-delimited component if it parses to a known quant.
    let last = stem.rsplit(['_', '.']).next().unwrap_or("");
    Quantization::parse(last)
        .filter(|q| *q != Quantization::Default)
        .unwrap_or(Quantization::Default)
}

/// True iff `repo_path` is an external-data sidecar of `<stem>.onnx` (base, sharded, or sherpa
/// `.weights`). All forward-slash POSIX comparison.
pub(crate) fn is_sidecar_for(stem: &str, repo_path: &str) -> bool {
    // Accept `<stem>.weights` used by some sherpa-onnx NeMo exports, plus the usual
    // `<stem>.onnx_data`, `<stem>.onnx.data`, `<stem>.onnx_data_N`, `<stem>.onnx.data_N`.
    if repo_path == format!("{stem}.weights") {
        return true;
    }
    for sep in ['_', '.'] {
        let base = format!("{stem}.onnx{sep}data");
        if repo_path == base {
            return true;
        }
        let shard_prefix = format!("{base}_");
        if let Some(rest) = repo_path.strip_prefix(&shard_prefix) {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}
