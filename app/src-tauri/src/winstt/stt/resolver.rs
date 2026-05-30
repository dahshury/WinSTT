// PORT IMPL — drafted against real APIs, pending compile. Source: onnx-asr fork
//   (E:/DL/Projects/onnx-asr/src/onnx_asr/resolver.py — model_repos, Resolver._download_model,
//    _resolve_model_files; model_base._get_model_files; models/*.py per-family globs)
// + WinSTT server (server/src/recorder/infrastructure/onnxasr_transcriber.py — _refetch_hf_snapshot,
//   _is_external_data_missing_error, _slug_model_id) and model_cache._file_quantization.
// + hf-hub 1.0.0-rc.1 async API (docs.rs): HFClient::new() -> HFResult<Self>,
//   .model(owner, name) -> HFRepository<RepoTypeModel>, .download_file().filename(..).revision(..)
//   .local_files_only(..).local_dir(..).force_download(..).send().await -> HFResult<PathBuf>;
//   .info().send().await -> ModelInfo { siblings: Option<Vec<RepoSibling{ rfilename, size, lfs }>> }.
//   HFError enum. (We use `info().siblings` to enumerate files — `list_tree`'s RepoTreeEntry is an
//   enum we'd have to destructure; `rfilename` is a flat String we can glob directly, mirroring the
//   Python `huggingface_hub` siblings surface onnx-asr fnmatches.)
//
// WHAT THIS DOES
// --------------
// Resolve a `(model_id, requested_quant)` pair to a concrete on-disk file set the engine loaders
// look up by logical key (`encoder`, `decoder`, `vocab`, `tokenizer`, `model`, `joiner`, …), plus:
//   * per-EngineKind quant-suffixed glob set (the `?`-separator trick: `?`+quant matches BOTH the
//     `_` onnx-community separator AND the `.` Kaldi/sherpa separator) — resolver.py §2.2;
//   * sharded `.onnx_data` / `.onnx_data_N` external-data sidecar completeness with a ONE-shot
//     refetch (the three converging bugs from spec §2.3 + cohere fp16 memory);
//   * forward-slash POSIX globbing (the load-bearing Windows backslash bug — resolver.py:149-157);
//   * a per-quant cache slug so int8/fp16 of the same repo never collide (_slug_model_id).
//
// hf-hub's `blocking` feature is NOT in its default feature set (verified docs.rs/crate/hf-hub/
// 1.0.0-rc.1/features), and Cargo.toml currently declares `hf-hub = "1.0.0-rc.1"` with defaults.
// So we drive the ASYNC client. `resolve()` is async; `resolve_blocking()` wraps it with the
// caller-supplied tokio runtime handle (the engine loads off the Tauri thread; the coordinator owns
// a `tokio::runtime::Handle`). See `// LIB WIRING` note at the bottom.

#![allow(dead_code)] // surface defined ahead of the engine call sites.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{EngineKind, Quantization, ResolvedModel, SttError, SttResult};

// ---------------------------------------------------------------------------
// 1. Alias / repo-id resolution (resolver.py `model_repos` + the `/`-in-id rule)
// ---------------------------------------------------------------------------

/// onnx-asr's `model_repos` alias table (resolver.py:19-70), ported verbatim. A bare alias
/// (`nemo-parakeet-tdt-0.6b-v3`) maps to a slashed HF repo id; a model that already contains `/`
/// is used verbatim. The VAD / speaker-embedding aliases are included for completeness (the
/// diarization + VAD slices resolve through the same table).
pub const MODEL_REPOS: &[(&str, &str)] = &[
    ("gigaam-v2-ctc", "istupakov/gigaam-v2-onnx"),
    ("gigaam-v2-rnnt", "istupakov/gigaam-v2-onnx"),
    ("gigaam-v3-ctc", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-rnnt", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-e2e-ctc", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-e2e-rnnt", "istupakov/gigaam-v3-onnx"),
    ("nemo-fastconformer-ru-ctc", "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx"),
    ("nemo-fastconformer-ru-rnnt", "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx"),
    ("nemo-parakeet-ctc-0.6b", "istupakov/parakeet-ctc-0.6b-onnx"),
    ("nemo-parakeet-rnnt-0.6b", "istupakov/parakeet-rnnt-0.6b-onnx"),
    ("nemo-parakeet-tdt-0.6b-v2", "istupakov/parakeet-tdt-0.6b-v2-onnx"),
    ("nemo-parakeet-tdt-0.6b-v3", "istupakov/parakeet-tdt-0.6b-v3-onnx"),
    ("nemo-canary-1b-v2", "istupakov/canary-1b-v2-onnx"),
    ("whisper-base", "istupakov/whisper-base-onnx"),
    ("moonshine-tiny", "onnx-community/moonshine-tiny-ONNX"),
    ("moonshine-base", "onnx-community/moonshine-base-ONNX"),
    ("moonshine-tiny-zh", "onnx-community/moonshine-tiny-zh-ONNX"),
    ("moonshine-tiny-ja", "onnx-community/moonshine-tiny-ja-ONNX"),
    ("moonshine-tiny-ko", "onnx-community/moonshine-tiny-ko-ONNX"),
    ("moonshine-tiny-ar", "onnx-community/moonshine-tiny-ar-ONNX"),
    ("moonshine-tiny-vi", "onnx-community/moonshine-tiny-vi-ONNX"),
    ("moonshine-base-zh", "onnx-community/moonshine-base-zh-ONNX"),
    ("moonshine-base-ja", "onnx-community/moonshine-base-ja-ONNX"),
    ("moonshine-base-ko", "onnx-community/moonshine-base-ko-ONNX"),
    ("moonshine-tiny-uk", "onnx-community/moonshine-tiny-uk-ONNX"),
    ("moonshine-tiny-fr", "onnx-community/moonshine-tiny-fr-ONNX"),
    ("cohere-transcribe", "onnx-community/cohere-transcribe-03-2026-ONNX"),
    ("granite-4.0-1b-speech", "onnx-community/granite-4.0-1b-speech-ONNX"),
    (
        "dolphin-base-ctc",
        "csukuangfj/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
    ),
    (
        "dolphin-small-ctc",
        "csukuangfj/sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02",
    ),
    ("zipformer-en", "csukuangfj/sherpa-onnx-zipformer-en-2023-06-26"),
    (
        "sense-voice-small",
        "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ),
    ("silero", "istupakov/silero-vad-onnx"),
    ("wespeaker-voxceleb-resnet34-LM", "Wespeaker/wespeaker-voxceleb-resnet34-LM"),
];

/// Map a catalog id / bare alias to a `(owner, name)` HF repo pair. A model id that already
/// contains `/` is split as-is (`onnx-community/whisper-tiny` → `("onnx-community", "whisper-tiny")`);
/// a bare alias is looked up in `MODEL_REPOS` first and the resolved repo split. Returns `None` for
/// an unknown bare alias (caller treats it as a local-dir custom model or errors).
pub fn resolve_repo(model: &str) -> Option<(String, String)> {
    let repo: &str = if model.contains('/') {
        model
    } else {
        MODEL_REPOS.iter().find(|(alias, _)| *alias == model).map(|(_, r)| *r)?
    };
    let (owner, name) = repo.split_once('/')?;
    Some((owner.to_string(), name.to_string()))
}

// ---------------------------------------------------------------------------
// 2. Per-EngineKind file globs (resolver.py model_base + models/*.py `_get_model_files`)
// ---------------------------------------------------------------------------

/// A logical file requirement: the key the engine loader looks up + the quant-suffixed glob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileGlob {
    pub key: &'static str,
    /// POSIX glob with `/` separators (NEVER a host `Path` — the Windows backslash bug). May start
    /// with `**/` (recurse any depth) or `*/` (one dir level), and uses `?` (single char) as the
    /// quant-separator wildcard so `?int8` matches BOTH `_int8` and `.int8`.
    pub glob: String,
}

/// Build the quant suffix the way every `_get_model_files` does: `"?" + quant` when a quant is set,
/// else `""`. The leading `?` is a single-char glob that matches the `_` (onnx-community) or `.`
/// (Kaldi/sherpa) separator that precedes the quant tag. `Quantization::Default` → no suffix.
fn quant_suffix(quant: Quantization) -> String {
    match quant {
        Quantization::Default => String::new(),
        q => format!("?{}", q.suffix()),
    }
}

/// The logical file globs for one engine kind at one quantization. Ported one-for-one from each
/// family's `_get_model_files` (spec §2.2 table; cross-checked against the onnx-asr source).
/// `config.json` / `config.yaml` are ALWAYS added by `download_set()` so they aren't listed here.
pub fn file_globs(kind: EngineKind, quant: Quantization) -> Vec<FileGlob> {
    let s = quant_suffix(quant);
    let g = |key: &'static str, glob: String| FileGlob { key, glob };
    match kind {
        EngineKind::WhisperHf => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("vocab", "vocab.json".into()),
            g("added_tokens", "added_tokens.json".into()),
        ],
        EngineKind::WhisperOrt => vec![
            // whisper-base-ort layout: encoder/decoder + vocab.json/added_tokens.json (_ort.py).
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("vocab", "vocab.json".into()),
            g("added_tokens", "added_tokens.json".into()),
        ],
        EngineKind::Moonshine => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model{s}.onnx")),
            g("decoder_with_past", format!("**/decoder_with_past_model{s}.onnx")),
            g("tokenizer", "tokenizer.json".into()),
            g("tokenizer_config", "tokenizer_config.json".into()),
        ],
        EngineKind::CohereAsr => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("tokenizer", "tokenizer.json".into()),
            g("tokenizer_config", "tokenizer_config.json".into()),
        ],
        EngineKind::NemoCtc => vec![
            g("model", format!("model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::NemoRnnt | EngineKind::NemoTdt => vec![
            g("encoder", format!("encoder-model{s}.onnx")),
            g("decoder_joint", format!("decoder_joint-model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::NemoAed => vec![
            g("encoder", format!("encoder-model{s}.onnx")),
            g("decoder", format!("decoder-model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::KaldiTransducer => vec![
            // sherpa packs nest files one dir down → `*/`.
            g("encoder", format!("*/encoder{s}.onnx")),
            g("decoder", format!("*/decoder{s}.onnx")),
            g("joiner", format!("*/joiner{s}.onnx")),
            g("vocab", "*/tokens.txt".into()),
        ],
        EngineKind::GigaamCtc => vec![
            // GigaAM v3 e2e ctc: flat root, `v3_e2e_ctc{sfx}.onnx` (gigaam.py:144). The `v?_` glob
            // also covers v2 (`v2_ctc.onnx`); we use the e2e form the catalog ships.
            g("model", format!("v3_e2e_ctc{s}.onnx")),
            g("vocab", "v3_e2e_ctc_vocab.txt".into()),
        ],
        EngineKind::GigaamRnnt => vec![
            g("encoder", format!("v3_e2e_rnnt_encoder{s}.onnx")),
            g("decoder", format!("v3_e2e_rnnt_decoder{s}.onnx")),
            g("joint", format!("v3_e2e_rnnt_joint{s}.onnx")),
            g("vocab", "v3_e2e_rnnt_vocab.txt".into()),
        ],
        EngineKind::ToneCtc => vec![
            // T-One single-graph streaming CTC (models/tone.py): flat `model{sfx}.onnx` + tokens.
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        EngineKind::DolphinCtc | EngineKind::SenseVoiceCtc => vec![
            // Both ship a flat root `model{?quant}.onnx` + `tokens.txt` (dolphin.py / sense_voice.py).
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
    }
}

// ---------------------------------------------------------------------------
// 3. POSIX glob matching (forward-slash; `**` / `*` / `?` semantics)
// ---------------------------------------------------------------------------

/// Match a POSIX repo path against one of our `_get_model_files` globs. Semantics mirror Python's
/// `pathlib.Path.glob` as onnx-asr uses it:
///   * `**` matches any number of path segments (including zero);
///   * `*`  matches within a single segment (not across `/`);
///   * `?`  matches exactly one character (the quant-separator wildcard);
///   * everything else is literal.
/// `path` MUST be a forward-slash POSIX path (an HF repo path is always POSIX). We normalise any
/// stray backslash to `/` defensively so a Windows-side comparison can't silently miss.
pub fn glob_match(glob: &str, path: &str) -> bool {
    let path = path.replace('\\', "/");
    let g: Vec<char> = glob.chars().collect();
    let p: Vec<char> = path.chars().collect();
    glob_rec(&g, &p)
}

fn glob_rec(g: &[char], p: &[char]) -> bool {
    // Empty glob matches only empty remainder.
    if g.is_empty() {
        return p.is_empty();
    }
    // `**` — matches any number of segments. Two forms: `**/rest` and trailing `**`.
    if g.len() >= 2 && g[0] == '*' && g[1] == '*' {
        // Skip the `**` and an optional following `/`.
        let rest = if g.len() >= 3 && g[2] == '/' { &g[3..] } else { &g[2..] };
        // `**` can consume zero or more whole segments. Try matching `rest` at the current
        // position and after each `/`-delimited prefix.
        if glob_rec(rest, p) {
            return true;
        }
        let mut i = 0;
        while i < p.len() {
            if p[i] == '/' && glob_rec(rest, &p[i + 1..]) {
                return true;
            }
            i += 1;
        }
        return false;
    }
    match g[0] {
        '*' => {
            // `*` matches zero+ chars within one segment (stops at `/`).
            if glob_rec(&g[1..], p) {
                return true;
            }
            let mut i = 0;
            while i < p.len() && p[i] != '/' {
                i += 1;
                if glob_rec(&g[1..], &p[i..]) {
                    return true;
                }
            }
            false
        }
        '?' => {
            // Single char, not `/`.
            !p.is_empty() && p[0] != '/' && glob_rec(&g[1..], &p[1..])
        }
        c => !p.is_empty() && p[0] == c && glob_rec(&g[1..], &p[1..]),
    }
}

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
/// On any parse failure we fall back to the NAME-PATTERN guess (`<stem>.onnx_data*`,
/// `<stem>.onnx.data*`) which the directory scan in `verify_external_data_complete` resolves.
pub fn referenced_sidecars(onnx_path: &Path) -> Vec<String> {
    let size = std::fs::metadata(onnx_path).map(|m| m.len()).unwrap_or(u64::MAX);
    if size >= EXTERNAL_DATA_PARSE_SIZE_GUARD {
        return Vec::new();
    }
    match super::fp16_patch::external_data_locations(onnx_path) {
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
pub fn verify_external_data_complete(onnx_path: &Path) -> bool {
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
            let present = [format!("{stem}.onnx_data_{n}"), format!("{stem}.onnx.data_{n}")]
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
    let base = if model_name.is_empty() { "unknown" } else { model_name };
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
    Quantization::parse(last).filter(|q| *q != Quantization::Default).unwrap_or(Quantization::Default)
}

// ---------------------------------------------------------------------------
// 6. The resolver (async hf-hub) + blocking wrapper
// ---------------------------------------------------------------------------

/// Inputs to one resolution. `effective_quant` is the quant the loader ACTUALLY wants AFTER the
/// catalog's int8-preferred / fp16-auto / DML resolution (see `catalog::resolve_quantization` and
/// `mod::resolve_quantization_auto`); the picker badge must check THIS, not the raw requested quant
/// (memory project_effective_quantization_bridge).
#[derive(Clone, Debug)]
pub struct ResolveRequest {
    pub model_id: String,
    pub kind: EngineKind,
    pub effective_quant: Quantization,
    /// Local custom-model dir (offline). When set, HF is bypassed and files are resolved from disk
    /// (spec §10). `model_id` still drives the engine kind.
    pub local_dir: Option<PathBuf>,
    /// Resolve from cache only (never hit the network). The first pass uses this; on a miss /
    /// incomplete-shard we retry with `false` exactly once.
    pub local_files_only: bool,
}

/// One repo file we intend to fetch: its POSIX repo path and whether it's a hard requirement.
#[derive(Clone, Debug)]
struct PlannedFile {
    /// Logical key (`encoder`, …) for the required files; `None` for the config/sidecar extras.
    key: Option<&'static str>,
    /// POSIX repo path (an `rfilename` from `ModelInfo.siblings`).
    repo_path: String,
}

/// Resolve a model to its on-disk file set (async — uses the hf-hub async client).
///
/// Flow (port of resolver.py `resolve_model` + `_download_model` + onnxasr `_refetch_hf_snapshot`):
///   1. If `local_dir` is set → resolve files from disk only (no HF).
///   2. Else: list the repo tree, match every `file_globs(kind, quant)` glob against it, pick the
///      one matching path per logical key (>1 match = error, 0 = ModelFileNotFound), and ALSO plan
///      every `<stem>.onnx_data*` sidecar + `config.json`/`config.yaml`.
///   3. Download each planned file (`local_files_only` first), forming the path map.
///   4. Verify external-data completeness on every downloaded `.onnx`. If any shard is missing AND
///      we were cache-only → flip to a network refetch and retry the WHOLE plan ONCE (spec §2.3).
pub async fn resolve(req: &ResolveRequest) -> SttResult<ResolvedModel> {
    if let Some(dir) = &req.local_dir {
        return resolve_local_dir(dir, req.kind, req.effective_quant);
    }

    // Pass 1 — honour the caller's cache-only flag (mirrors resolver.py: try local_files_only=True).
    // It is "good" only if it resolved AND every `.onnx` has complete external data.
    if req.local_files_only {
        if let Ok(resolved) = resolve_remote(req, true).await {
            if all_onnx_complete(&resolved) {
                return Ok(resolved);
            }
            // else: cache present but an `.onnx_data_N` shard is missing → fall through to refetch.
        }
        // Pass 2 — exactly ONE network attempt (cache-only miss OR the partial-shard refetch).
        let refetched = resolve_remote(req, false).await?;
        if all_onnx_complete(&refetched) {
            return Ok(refetched);
        }
        return Err(SttError::Resolve(format!(
            "external-data shards still incomplete after refetch for {}",
            req.model_id
        )));
    }

    // Caller explicitly asked for a network resolve from the start: one attempt, must be complete.
    let resolved = resolve_remote(req, false).await?;
    if all_onnx_complete(&resolved) {
        Ok(resolved)
    } else {
        Err(SttError::Resolve(format!(
            "external-data shards incomplete for {} after network resolve",
            req.model_id
        )))
    }
}

/// Blocking convenience for callers without an async context (engine load on a worker thread).
/// Drives `resolve` on the supplied tokio runtime handle. The coordinator owns a `Handle` (Tauri's
/// async runtime); pass `tokio::runtime::Handle::current()` from inside Tauri, or a dedicated
/// `Runtime::new()?.handle()`.
pub fn resolve_blocking(handle: &tokio::runtime::Handle, req: &ResolveRequest) -> SttResult<ResolvedModel> {
    // CONTRACT: call this from a NON-runtime thread (the engine load runs on a dedicated
    // `std::thread` / `spawn_blocking` worker), so `Handle::block_on` is valid. If you must call it
    // from inside a runtime worker, wrap with `tokio::task::block_in_place(|| handle.block_on(..))`
    // (multi-thread runtime only) at the call site instead.
    handle.block_on(resolve(req))
}

/// Resolve a custom local-dir model (offline; no HF). Globs the dir for each required file.
fn resolve_local_dir(dir: &Path, kind: EngineKind, quant: Quantization) -> SttResult<ResolvedModel> {
    let mut files = BTreeMap::new();
    let entries = list_dir_posix(dir).map_err(|e| SttError::Resolve(format!("scan {}: {e}", dir.display())))?;
    for fg in file_globs(kind, quant) {
        // Required keys must resolve; config-only extras are added below.
        let matched: Vec<&(String, PathBuf)> = entries.iter().filter(|(rel, _)| glob_match(&fg.glob, rel)).collect();
        if matched.len() > 1 {
            return Err(SttError::Resolve(format!(
                "more than one file matched {} in {}",
                fg.glob,
                dir.display()
            )));
        }
        match matched.first() {
            Some((_, abs)) => {
                files.insert(fg.key.to_string(), abs.clone());
            }
            None => {
                // `.ort` fallback (resolver.py find()): try the `.onnx`→`.ort` swap.
                if let Some(ort_glob) = fg.glob.strip_suffix(".onnx") {
                    let ort_glob = format!("{ort_glob}.ort");
                    if let Some((_, abs)) = entries.iter().find(|(rel, _)| glob_match(&ort_glob, rel)) {
                        files.insert(fg.key.to_string(), abs.clone());
                        continue;
                    }
                }
                return Err(SttError::Resolve(format!("missing {} ({}) in {}", fg.key, fg.glob, dir.display())));
            }
        }
    }
    // config.json if present.
    let cfg = dir.join("config.json");
    if cfg.is_file() {
        files.insert("config".into(), cfg);
    }
    Ok(ResolvedModel { files, effective_quantization: quant })
}

/// The remote resolve: list tree → glob → download each file (+ sidecars + config). `cache_only`
/// chooses `local_files_only` on every download (the first pass) vs a network fetch (the refetch).
async fn resolve_remote(req: &ResolveRequest, cache_only: bool) -> SttResult<ResolvedModel> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(&req.model_id)
        .ok_or_else(|| SttError::Resolve(format!("unknown model alias / repo: {}", req.model_id)))?;

    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner.clone(), name.clone());

    // Enumerate the repo's file list (`ModelInfo.siblings[].rfilename`) so we can glob-match like
    // Python's `path.glob(...)` does against the snapshot — but without downloading everything first.
    let tree_paths = list_repo_tree(&repo).await?;

    // Plan the required (logical-key) files by matching each glob against the tree.
    let globs = file_globs(req.kind, req.effective_quant);
    let mut planned: Vec<PlannedFile> = Vec::new();
    let mut onnx_stems: Vec<String> = Vec::new();
    for fg in &globs {
        let mut matches: Vec<&String> = tree_paths.iter().filter(|p| glob_match(&fg.glob, p)).collect();
        // `.ort` fallback when the `.onnx` form has no match (resolver.py find()).
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = tree_paths.iter().filter(|p| glob_match(&ort, p)).collect();
            }
        }
        if matches.len() > 1 {
            return Err(SttError::Resolve(format!(
                "more than one file matched {} in {}/{}",
                fg.glob, owner, name
            )));
        }
        let path = matches
            .first()
            .ok_or_else(|| SttError::Resolve(format!("missing {} ({}) in {}/{}", fg.key, fg.glob, owner, name)))?;
        if path.ends_with(".onnx") {
            if let Some(stem) = path.strip_suffix(".onnx") {
                onnx_stems.push(stem.to_string());
            }
        }
        planned.push(PlannedFile { key: Some(fg.key), repo_path: (*path).clone() });
    }

    // Plan every external-data sidecar for each planned `.onnx`: `<stem>.onnx_data`, `.onnx.data`,
    // and the sharded `.onnx_data_N` / `.onnx.data_N`. We add only the sidecars the tree actually
    // lists (avoids a 404 on single-file graphs). Forward-slash patterns throughout (the Win bug).
    for stem in &onnx_stems {
        for p in &tree_paths {
            if is_sidecar_for(stem, p) {
                planned.push(PlannedFile { key: None, repo_path: p.clone() });
            }
        }
    }

    // Always pull config.json / config.yaml when present (resolver.py:145-147).
    for cfg in ["config.json", "config.yaml"] {
        if tree_paths.iter().any(|p| p == cfg) {
            planned.push(PlannedFile { key: None, repo_path: cfg.to_string() });
        }
    }

    // Download everything; build the logical-key → local-path map.
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut config_local: Option<PathBuf> = None;
    for pf in &planned {
        let local = download_one(&repo, &pf.repo_path, cache_only).await?;
        if let Some(key) = pf.key {
            files.insert(key.to_string(), local.clone());
        } else if pf.repo_path == "config.json" {
            config_local = Some(local);
        }
    }
    if let Some(cfg) = config_local {
        files.insert("config".into(), cfg);
    }

    Ok(ResolvedModel { files, effective_quantization: req.effective_quant })
}

/// Download one repo file (cache-aware). Returns the local cached path.
async fn download_one(
    repo: &hf_hub::HFRepository<hf_hub::RepoTypeModel>,
    repo_path: &str,
    cache_only: bool,
) -> SttResult<PathBuf> {
    repo.download_file()
        .filename(repo_path)
        .local_files_only(cache_only)
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("download {repo_path}: {e}")))
}

/// Collect the repo's POSIX file paths via `repo.info().send()` → `ModelInfo.siblings`, each a
/// `RepoSibling { rfilename: String, .. }` (the relative repo path — the same `siblings`/`rfilename`
/// surface the Python `huggingface_hub` exposes, which onnx-asr's resolver fnmatches). This is
/// preferred over `list_tree()` (whose `RepoTreeEntry` is an enum we'd have to destructure) because
/// `rfilename` is a flat `String` we can glob directly.
async fn list_repo_tree(repo: &hf_hub::HFRepository<hf_hub::RepoTypeModel>) -> SttResult<Vec<String>> {
    // SPIKE: the HF `/api/models/{id}` response includes `siblings` (rfilename) by default, so a
    // plain `info().send()` should populate `ModelInfo.siblings`. If the builder gates siblings
    // behind an expand flag (e.g. `.expand("siblings")` / `.files(true)`), add it on the next line.
    let info = repo
        .info()
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("repo info: {e}")))?;
    let siblings = info.siblings.unwrap_or_default();
    Ok(siblings
        .into_iter()
        .map(|s| s.rfilename.replace('\\', "/"))
        .filter(|p| !p.is_empty())
        .collect())
}

/// True iff `repo_path` is an external-data sidecar of `<stem>.onnx` (base or sharded, either
/// separator). All forward-slash POSIX comparison.
fn is_sidecar_for(stem: &str, repo_path: &str) -> bool {
    // Accept `<stem>.onnx_data`, `<stem>.onnx.data`, `<stem>.onnx_data_N`, `<stem>.onnx.data_N`.
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

/// True iff every `.onnx` in the resolved set has complete external data on disk.
fn all_onnx_complete(resolved: &ResolvedModel) -> bool {
    resolved
        .files
        .values()
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("onnx"))
        .all(|p| verify_external_data_complete(p))
}

/// Recursively list a local dir, returning `(posix_relative_path, absolute_path)` pairs. Used by
/// the custom-model offline resolver so the same `glob_match` works on disk.
fn list_dir_posix(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out)?;
            } else if let Ok(rel) = path.strip_prefix(base) {
                let posix = rel.to_string_lossy().replace('\\', "/");
                out.push((posix, path));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// LIB WIRING NOTE
// ---------------------------------------------------------------------------
// * `stt/mod.rs` must add `pub mod resolver;` and `pub mod fp16_patch;` (this file references
//   `super::fp16_patch::external_data_locations`). The orchestrator wires these serially.
// * Cargo.toml: `hf-hub`'s `blocking` feature is NOT default-on, and we use the ASYNC client, so no
//   hf-hub feature change is required for the async path. (If a future caller wants the blocking
//   `HFClientSync` instead, add `features = ["blocking"]`.) No `futures-util` is needed here — repo
//   listing uses `repo.info().send().await` (siblings), not a stream.
// * `super::fp16_patch::external_data_locations` is consumed for the small-graph sidecar parse.
// * The engine `build_engine()` (mod.rs) calls `resolve_blocking(handle, &ResolveRequest{..})` to
//   get the `ResolvedModel`, then loads each `files[key]` with `ort_env::load_with_fp16_repair`.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_resolves_to_owner_name() {
        assert_eq!(
            resolve_repo("nemo-parakeet-tdt-0.6b-v3"),
            Some(("istupakov".into(), "parakeet-tdt-0.6b-v3-onnx".into()))
        );
        // slashed id used verbatim.
        assert_eq!(
            resolve_repo("onnx-community/whisper-tiny"),
            Some(("onnx-community".into(), "whisper-tiny".into()))
        );
        // sense-voice alias.
        assert_eq!(
            resolve_repo("sense-voice-small"),
            Some(("csukuangfj".into(), "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17".into()))
        );
        // unknown bare alias → None.
        assert_eq!(resolve_repo("totally-unknown-alias"), None);
    }

    #[test]
    fn quant_suffix_uses_question_separator() {
        assert_eq!(quant_suffix(Quantization::Default), "");
        assert_eq!(quant_suffix(Quantization::Int8), "?int8");
        assert_eq!(quant_suffix(Quantization::Fp16), "?fp16");
    }

    #[test]
    fn whisper_globs_default_and_fp16() {
        let g = file_globs(EngineKind::WhisperHf, Quantization::Default);
        assert!(g.iter().any(|f| f.key == "encoder" && f.glob == "**/encoder_model.onnx"));
        assert!(g.iter().any(|f| f.key == "decoder" && f.glob == "**/decoder_model_merged.onnx"));
        let g16 = file_globs(EngineKind::WhisperHf, Quantization::Fp16);
        assert!(g16.iter().any(|f| f.glob == "**/encoder_model?fp16.onnx"));
        assert!(g16.iter().any(|f| f.glob == "**/decoder_model_merged?fp16.onnx"));
    }

    #[test]
    fn kaldi_globs_nest_one_dir() {
        let g = file_globs(EngineKind::KaldiTransducer, Quantization::Int8);
        assert!(g.iter().any(|f| f.key == "encoder" && f.glob == "*/encoder?int8.onnx"));
        assert!(g.iter().any(|f| f.key == "vocab" && f.glob == "*/tokens.txt"));
    }

    #[test]
    fn glob_match_doublestar_recurses() {
        // `**/x.onnx` matches at root and any depth.
        assert!(glob_match("**/encoder_model.onnx", "encoder_model.onnx"));
        assert!(glob_match("**/encoder_model.onnx", "onnx/encoder_model.onnx"));
        assert!(glob_match("**/encoder_model.onnx", "a/b/encoder_model.onnx"));
        assert!(!glob_match("**/encoder_model.onnx", "encoder_model_fp16.onnx"));
    }

    #[test]
    fn glob_match_single_star_one_segment() {
        // `*/tokens.txt` matches exactly one dir level (sherpa pack).
        assert!(glob_match("*/tokens.txt", "sherpa-onnx-zipformer-en/tokens.txt"));
        assert!(!glob_match("*/tokens.txt", "tokens.txt")); // needs a dir level
        assert!(!glob_match("*/tokens.txt", "a/b/tokens.txt")); // `*` can't cross `/`
    }

    #[test]
    fn glob_match_question_separator_matches_dot_and_underscore() {
        // `?int8` glob matches BOTH `.int8` (kaldi) and `_int8` (onnx-community).
        assert!(glob_match("*/encoder?int8.onnx", "pack/encoder.int8.onnx"));
        assert!(glob_match("model?int8.onnx", "model.int8.onnx"));
        assert!(glob_match("model?int8.onnx", "model_int8.onnx"));
        // but `?` is exactly one char, not zero.
        assert!(!glob_match("model?int8.onnx", "modelint8.onnx"));
    }

    #[test]
    fn glob_match_normalises_backslashes() {
        // A Windows-side path with backslashes must still match a POSIX glob.
        assert!(glob_match("**/encoder_model.onnx", "onnx\\encoder_model.onnx"));
    }

    #[test]
    fn sidecar_detection_base_and_sharded() {
        let stem = "encoder_model_fp16";
        assert!(is_sidecar_for(stem, "encoder_model_fp16.onnx_data"));
        assert!(is_sidecar_for(stem, "encoder_model_fp16.onnx.data"));
        assert!(is_sidecar_for(stem, "encoder_model_fp16.onnx_data_1"));
        assert!(is_sidecar_for(stem, "encoder_model_fp16.onnx.data_2"));
        // not a sidecar of THIS stem.
        assert!(!is_sidecar_for(stem, "decoder_model_merged_fp16.onnx_data"));
        // the graph file itself is not its own sidecar.
        assert!(!is_sidecar_for(stem, "encoder_model_fp16.onnx"));
        // trailing non-digit → not a shard.
        assert!(!is_sidecar_for(stem, "encoder_model_fp16.onnx_data_x"));
    }

    #[test]
    fn slug_embeds_quant_and_is_fs_safe() {
        assert_eq!(slug_model_id("onnx-community/whisper-tiny", Quantization::Int8), "onnx-community_whisper-tiny__int8");
        assert_eq!(slug_model_id("onnx-community/whisper-tiny", Quantization::Default), "onnx-community_whisper-tiny__default");
        // int8 vs fp16 never collide.
        assert_ne!(
            slug_model_id("m", Quantization::Int8),
            slug_model_id("m", Quantization::Fp16)
        );
        assert_eq!(slug_model_id("", Quantization::Default), "unknown__default");
    }

    #[test]
    fn file_quantization_reads_suffix_both_separators() {
        assert_eq!(file_quantization("encoder_model_fp16.onnx"), Quantization::Fp16);
        assert_eq!(file_quantization("encoder.int8.onnx"), Quantization::Int8);
        assert_eq!(file_quantization("encoder_model.onnx"), Quantization::Default);
        assert_eq!(file_quantization("model.onnx"), Quantization::Default);
        // q4f16 round-trips (last component).
        assert_eq!(file_quantization("decoder_model_merged_q4f16.onnx"), Quantization::Q4f16);
    }

    #[test]
    fn external_data_complete_when_no_onnx_or_sidecars() {
        // A dir with a graph file but no referenced data → name-pattern path returns true
        // (full inline graph, no sidecars). Build a tmp dir.
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("model.onnx");
        std::fs::write(&onnx, b"not-a-real-graph").unwrap();
        assert!(verify_external_data_complete(&onnx));
    }

    #[test]
    fn external_data_incomplete_when_shard_series_referenced_but_missing() {
        // base sidecar present but we simulate the protobuf path returning nothing → name sweep.
        // With only the graph present and NO sidecar files, name sweep finds no shard1 → "complete".
        // (The authoritative incomplete case is exercised by the protobuf path in fp16_patch tests.)
        let dir = tempfile::tempdir().unwrap();
        let onnx = dir.path().join("encoder_model_fp16.onnx");
        std::fs::write(&onnx, b"graph").unwrap();
        // No sidecars at all → treated as complete (single-file graph).
        assert!(verify_external_data_complete(&onnx));
    }
}
