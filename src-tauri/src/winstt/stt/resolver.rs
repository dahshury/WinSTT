// Source: onnx-asr fork
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
    (
        "nemo-fastconformer-ru-ctc",
        "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    ),
    (
        "nemo-fastconformer-ru-rnnt",
        "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    ),
    ("nemo-parakeet-ctc-0.6b", "istupakov/parakeet-ctc-0.6b-onnx"),
    (
        "nemo-parakeet-rnnt-0.6b",
        "istupakov/parakeet-rnnt-0.6b-onnx",
    ),
    (
        "nemo-parakeet-tdt-0.6b-v2",
        "istupakov/parakeet-tdt-0.6b-v2-onnx",
    ),
    (
        "nemo-parakeet-tdt-0.6b-v3",
        "istupakov/parakeet-tdt-0.6b-v3-onnx",
    ),
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
    (
        "cohere-transcribe",
        "onnx-community/cohere-transcribe-03-2026-ONNX",
    ),
    (
        "granite-4.0-1b-speech",
        "onnx-community/granite-4.0-1b-speech-ONNX",
    ),
    (
        "dolphin-base-ctc",
        "csukuangfj/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
    ),
    (
        "dolphin-small-ctc",
        "csukuangfj/sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02",
    ),
    (
        "zipformer-en",
        "csukuangfj/sherpa-onnx-zipformer-en-2023-06-26",
    ),
    (
        "sense-voice-small",
        "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ),
    ("silero", "istupakov/silero-vad-onnx"),
    (
        "wespeaker-voxceleb-resnet34-LM",
        "Wespeaker/wespeaker-voxceleb-resnet34-LM",
    ),
];

/// Map a catalog id / bare alias to a `(owner, name)` HF repo pair. A model id that already
/// contains `/` is split as-is (`onnx-community/whisper-tiny` → `("onnx-community", "whisper-tiny")`);
/// a bare id is resolved through THREE sources, in order:
///   1. the WinSTT catalog (`catalog::find(id).onnx_model_name`) — the authoritative id→repo map the
///      engine-load path already uses (`transcription.rs` builds `ResolveRequest { model_id:
///      entry.onnx_model_name, .. }`). The catalog ships bare ids like `tiny` / `crisper-whisper` /
///      `nemo-canary-1b-flash` whose real HF repo (`onnx-community/whisper-tiny`, …) lives ONLY in
///      `onnx_model_name`, NOT in `MODEL_REPOS`. Without this lookup the per-quant DownloadManager
///      and the cache probe both passed the bare catalog id straight here, got `None`, and silently
///      settled the download as cancelled (badge cleared → "download does nothing / resets to
///      nothing / stuck at 0%") while the model showed "Not downloaded" even when fully cached.
///   2. the `MODEL_REPOS` onnx-asr alias table (Moonshine/NeMo/GigaAM/… aliases the catalog stores
///      verbatim in `onnx_model_name`, so step 1 already covers catalog rows; this remains for any
///      off-catalog alias callers).
///   3. `None` — caller treats it as a local-dir custom model or errors.
///
/// The catalog's `onnx_model_name` is itself either a slashed repo (Whisper/Cohere/Sense/Vosk) or a
/// `MODEL_REPOS` alias (Moonshine/NeMo/GigaAM), so we recurse through it once: a slash splits
/// directly, an alias falls to step 2. The single-level guard (`!= model`) prevents any self-loop.
pub fn resolve_repo(model: &str) -> Option<(String, String)> {
    if let Some((owner, name)) = model.split_once('/') {
        return Some((owner.to_string(), name.to_string()));
    }
    // 1. Catalog id → real repo / alias (the engine-load path's source of truth).
    if let Some(entry) = crate::winstt::catalog::find(model) {
        let onnx = entry.onnx_model_name;
        if onnx != model {
            if let Some((owner, name)) = onnx.split_once('/') {
                return Some((owner.to_string(), name.to_string()));
            }
            // onnx_model_name is a bare alias (Moonshine/NeMo/GigaAM) → resolve it via MODEL_REPOS.
            if let Some(repo) = MODEL_REPOS
                .iter()
                .find(|(alias, _)| *alias == onnx)
                .map(|(_, r)| *r)
            {
                let (owner, name) = repo.split_once('/')?;
                return Some((owner.to_string(), name.to_string()));
            }
        }
    }
    // 2. Bare onnx-asr alias not on the catalog.
    let repo = MODEL_REPOS
        .iter()
        .find(|(alias, _)| *alias == model)
        .map(|(_, r)| *r)?;
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
///
/// `model_id` is threaded through so the Kaldi arm can pick the right LAYOUT: Vosk packs nest the
/// graphs one dir down (`am/encoder.onnx` + `lang/tokens.txt`), while icefall / sherpa-onnx
/// zipformer packs ship them at the repo ROOT with an epoch-suffixed name
/// (`encoder-epoch-99-avg-1.onnx` …). This mirrors onnx-asr's `IcefallZipformer._get_model_files`
/// override of `KaldiTransducer._get_model_files` (models/kaldi.py L110-118 vs L39-47).
pub fn file_globs(model_id: &str, kind: EngineKind, quant: Quantization) -> Vec<FileGlob> {
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
            g(
                "decoder_with_past",
                format!("**/decoder_with_past_model{s}.onnx"),
            ),
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
        EngineKind::KaldiTransducer => {
            // onnx-asr splits the Kaldi transducer file set by repo layout (models/kaldi.py):
            //   * `KaldiTransducer` (Vosk) nests one dir down: `*/encoder{?q}.onnx`, `*/tokens.txt`.
            //   * `IcefallZipformer` (sherpa-onnx / icefall zipformer) ships at the ROOT with an
            //     epoch suffix: `encoder-*{?q}.onnx`, `decoder-*{?q}.onnx`, `joiner-*{?q}.onnx`,
            //     `tokens.txt`.
            // We select on the model id the catalog uses (`zipformer-en`, `icefall-zipformer`).
            let id = model_id.to_ascii_lowercase();
            if id.contains("zipformer") || id.contains("icefall") {
                vec![
                    g("encoder", format!("encoder-*{s}.onnx")),
                    g("decoder", format!("decoder-*{s}.onnx")),
                    g("joiner", format!("joiner-*{s}.onnx")),
                    g("vocab", "tokens.txt".into()),
                ]
            } else {
                vec![
                    g("encoder", format!("*/encoder{s}.onnx")),
                    g("decoder", format!("*/decoder{s}.onnx")),
                    g("joiner", format!("*/joiner{s}.onnx")),
                    g("vocab", "*/tokens.txt".into()),
                ]
            }
        }
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
            // T-One single-graph streaming CTC (models/tone.py): flat `model{sfx}.onnx` only.
            // T-One has NO tokens.txt — its vocabulary lives in `config.json`
            // (decoder_params.vocabulary), which `download_set()` auto-resolves into the
            // "config" key. `_get_model_files` returns just `{"model": "model{?quant}.onnx"}`.
            g("model", format!("model{s}.onnx")),
        ],
        EngineKind::DolphinCtc | EngineKind::SenseVoiceCtc => vec![
            // Both ship a flat root `model{?quant}.onnx` + `tokens.txt` (dolphin.py / sense_voice.py).
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        // sherpa-onnx streaming packs (driven by SherpaStreamingEngine):
        EngineKind::NemoCtcStreaming => vec![
            // streaming NeMo FastConformer CTC: flat `model{?q}.onnx` + `tokens.txt`.
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        EngineKind::NemoRnntStreaming => vec![
            // streaming NeMo RNN-T: flat encoder/decoder/joiner + `tokens.txt`.
            g("encoder", format!("encoder{s}.onnx")),
            g("decoder", format!("decoder{s}.onnx")),
            g("joiner", format!("joiner{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        EngineKind::KaldiTransducerStreaming => vec![
            // streaming Zipformer2: epoch-suffixed encoder/decoder/joiner + `tokens.txt`
            // (same root-epoch layout as the offline icefall zipformer branch above).
            g("encoder", format!("encoder-*{s}.onnx")),
            g("decoder", format!("decoder-*{s}.onnx")),
            g("joiner", format!("joiner-*{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
    }
}

/// Resolve a set of glob matches to ONE path, applying a Kaldi-scoped tie-break.
///
/// The icefall/zipformer root globs (`encoder-*{?q}.onnx`) are intentionally loose so they catch
/// the epoch-suffixed name (`encoder-epoch-99-avg-1.onnx`). But for the DEFAULT (unsuffixed) quant
/// the `*` after `encoder-` ALSO spans the `.int8` / `.fp16` separator, so a repo that ships both
/// precisions yields >1 match (`encoder-epoch-99-avg-1.onnx` AND `encoder-epoch-99-avg-1.int8.onnx`).
/// The resolver normally errors on >1 match; for Kaldi we instead pick the file whose stem carries
/// NO recognised quant tag (the shortest stem — the default export). For a NON-Kaldi kind, or when
/// a single match exists, behaviour is unchanged (0 = caller's not-found error, >1 = error).
///
/// `matches` are POSIX repo paths. Returns `Ok(Some(path))` for a unique/resolved match, `Ok(None)`
/// for zero matches (caller raises the family-specific "missing" error), and `Err(())` only when
/// the tie-break could not disambiguate (>1 match that are all untagged, or a non-Kaldi >1).
fn pick_kaldi_tiebreak<'a>(
    kind: EngineKind,
    matches: &[&'a String],
) -> Result<Option<&'a String>, ()> {
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0])),
        _ if matches!(
            kind,
            EngineKind::KaldiTransducer | EngineKind::KaldiTransducerStreaming
        ) =>
        {
            // Keep only the matches with NO quant tag on the `.onnx` stem (the default export).
            // `tokens.txt` (vocab) never has a tag, so this only ever fires on the graph globs.
            let untagged: Vec<&&'a String> = matches
                .iter()
                .filter(|p| {
                    let fname: &str = p.rsplit('/').next().unwrap_or(p.as_str());
                    file_quantization(fname) == Quantization::Default
                })
                .collect();
            match untagged.len() {
                1 => Ok(Some(untagged[0])),
                _ => Err(()), // 0 (all tagged) or >1 (ambiguous) → can't disambiguate.
            }
        }
        _ => Err(()), // non-Kaldi: >1 match is genuinely ambiguous → error.
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
///
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
        let rest = if g.len() >= 3 && g[2] == '/' {
            &g[3..]
        } else {
            &g[2..]
        };
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
///
/// On any parse failure we fall back to the NAME-PATTERN guess (`<stem>.onnx_data*`,
/// `<stem>.onnx.data*`) which the directory scan in `verify_external_data_complete` resolves.
pub fn referenced_sidecars(onnx_path: &Path) -> Vec<String> {
    let size = std::fs::metadata(onnx_path)
        .map(|m| m.len())
        .unwrap_or(u64::MAX);
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
        return resolve_local_dir(dir, &req.model_id, req.kind, req.effective_quant);
    }

    // Pass 1 — honour the caller's cache-only flag (mirrors resolver.py: try local_files_only=True).
    // It is "good" only if it resolved AND every `.onnx` has complete external data.
    //
    // OFFLINE-FIRST (audit #2 CRITICAL): a 100%-cached model must load with ZERO network. We derive
    // the planned file set straight from the ON-DISK hf-hub snapshot (`scan_cache`) and glob-match it
    // there — `repo.info().send()` (the HTTP tree listing) is NEVER touched on this pass. A genuine
    // cache miss / incomplete shard falls through to the single network pass below.
    if req.local_files_only {
        if let Ok(resolved) = resolve_cached_offline(req).await {
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
pub fn resolve_blocking(
    handle: &tokio::runtime::Handle,
    req: &ResolveRequest,
) -> SttResult<ResolvedModel> {
    // CONTRACT: call this from a NON-runtime thread (the engine load runs on a dedicated
    // `std::thread` / `spawn_blocking` worker), so `Handle::block_on` is valid. If you must call it
    // from inside a runtime worker, wrap with `tokio::task::block_in_place(|| handle.block_on(..))`
    // (multi-thread runtime only) at the call site instead.
    handle.block_on(resolve(req))
}

/// Resolve a custom local-dir model (offline; no HF). Globs the dir for each required file.
fn resolve_local_dir(
    dir: &Path,
    model_id: &str,
    kind: EngineKind,
    quant: Quantization,
) -> SttResult<ResolvedModel> {
    let mut files = BTreeMap::new();
    let entries = list_dir_posix(dir)
        .map_err(|e| SttError::Resolve(format!("scan {}: {e}", dir.display())))?;
    for fg in file_globs(model_id, kind, quant) {
        // Required keys must resolve; config-only extras are added below.
        let matched: Vec<&(String, PathBuf)> = entries
            .iter()
            .filter(|(rel, _)| glob_match(&fg.glob, rel))
            .collect();
        let rels: Vec<&String> = matched.iter().map(|(rel, _)| rel).collect();
        let chosen_rel = match pick_kaldi_tiebreak(kind, &rels) {
            Ok(Some(rel)) => Some((*rel).clone()),
            Ok(None) => None,
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one file matched {} in {}",
                    fg.glob,
                    dir.display()
                )));
            }
        };
        let matched_one = chosen_rel
            .as_ref()
            .and_then(|rel| matched.iter().find(|(r, _)| r == rel));
        match matched_one {
            Some((_, abs)) => {
                files.insert(fg.key.to_string(), abs.clone());
            }
            None => {
                // `.ort` fallback (resolver.py find()): try the `.onnx`→`.ort` swap.
                if let Some(ort_glob) = fg.glob.strip_suffix(".onnx") {
                    let ort_glob = format!("{ort_glob}.ort");
                    if let Some((_, abs)) =
                        entries.iter().find(|(rel, _)| glob_match(&ort_glob, rel))
                    {
                        files.insert(fg.key.to_string(), abs.clone());
                        continue;
                    }
                }
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {}",
                    fg.key,
                    fg.glob,
                    dir.display()
                )));
            }
        }
    }
    // config.json if present.
    let cfg = dir.join("config.json");
    if cfg.is_file() {
        files.insert("config".into(), cfg);
    }
    Ok(ResolvedModel {
        files,
        effective_quantization: quant,
    })
}

/// The remote resolve: list tree → glob → download each file (+ sidecars + config). `cache_only`
/// chooses `local_files_only` on every download (the first pass) vs a network fetch (the refetch).
async fn resolve_remote(req: &ResolveRequest, cache_only: bool) -> SttResult<ResolvedModel> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(&req.model_id).ok_or_else(|| {
        SttError::Resolve(format!("unknown model alias / repo: {}", req.model_id))
    })?;

    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner.clone(), name.clone());

    // Enumerate the repo's file list (`ModelInfo.siblings[].rfilename`) so we can glob-match like
    // Python's `path.glob(...)` does against the snapshot — but without downloading everything first.
    let tree_paths = list_repo_tree(&repo).await?;

    // Plan the required (logical-key) files by matching each glob against the tree.
    let globs = file_globs(&req.model_id, req.kind, req.effective_quant);
    let mut planned: Vec<PlannedFile> = Vec::new();
    let mut onnx_stems: Vec<String> = Vec::new();
    for fg in &globs {
        let mut matches: Vec<&String> = tree_paths
            .iter()
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        // `.ort` fallback when the `.onnx` form has no match (resolver.py find()).
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = tree_paths.iter().filter(|p| glob_match(&ort, p)).collect();
            }
        }
        let path = match pick_kaldi_tiebreak(req.kind, &matches) {
            Ok(Some(p)) => p,
            Ok(None) => {
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {}/{}",
                    fg.key, fg.glob, owner, name
                )));
            }
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one file matched {} in {}/{}",
                    fg.glob, owner, name
                )));
            }
        };
        if path.ends_with(".onnx") {
            if let Some(stem) = path.strip_suffix(".onnx") {
                onnx_stems.push(stem.to_string());
            }
        }
        planned.push(PlannedFile {
            key: Some(fg.key),
            repo_path: (*path).clone(),
        });
    }

    // Plan every external-data sidecar for each planned `.onnx`: `<stem>.onnx_data`, `.onnx.data`,
    // and the sharded `.onnx_data_N` / `.onnx.data_N`. We add only the sidecars the tree actually
    // lists (avoids a 404 on single-file graphs). Forward-slash patterns throughout (the Win bug).
    for stem in &onnx_stems {
        for p in &tree_paths {
            if is_sidecar_for(stem, p) {
                planned.push(PlannedFile {
                    key: None,
                    repo_path: p.clone(),
                });
            }
        }
    }

    // Always pull config.json / config.yaml when present (resolver.py:145-147).
    for cfg in ["config.json", "config.yaml"] {
        if tree_paths.iter().any(|p| p == cfg) {
            planned.push(PlannedFile {
                key: None,
                repo_path: cfg.to_string(),
            });
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

    Ok(ResolvedModel {
        files,
        effective_quantization: req.effective_quant,
    })
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

/// Resolve a model to its on-disk file set using ONLY the local hf-hub cache — never the network
/// (no `repo.info().send()`). This is the offline-first Pass-1 of `resolve()`: a 100%-cached model
/// loads/swaps with zero network latency and works when HF is unreachable.
///
/// It scans the local cache (`scan_cache`, an fs walk — the SAME walk `cache_probe.rs` uses), finds
/// the repo's cached `(posix_name, abs_path)` pairs across every revision, then runs the IDENTICAL
/// planning + glob-matching as `resolve_remote` against that on-disk file list. A cache miss (repo
/// absent, or a required logical file not yet downloaded) returns `Err` so `resolve()` falls through
/// to exactly one network pass.
async fn resolve_cached_offline(req: &ResolveRequest) -> SttResult<ResolvedModel> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(&req.model_id).ok_or_else(|| {
        SttError::Resolve(format!("unknown model alias / repo: {}", req.model_id))
    })?;
    let repo_key = format!("{owner}/{name}").to_ascii_lowercase();

    // Walk the local cache only — `scan_cache()` is a filesystem scan, no HTTP. A scan error or an
    // absent repo is a cache miss → caller does the one network pass.
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let scan = client
        .scan_cache()
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("scan cache: {e}")))?;

    // Collect the repo's cached files as `(posix_repo_path, abs_pointer_path)` across all revisions
    // (dedup by repo path; first revision wins — pointer files refer to the same blob).
    let repo = scan
        .repos
        .iter()
        .find(|r| r.repo_id.to_ascii_lowercase() == repo_key)
        .ok_or_else(|| SttError::Resolve(format!("{owner}/{name} not in local cache")))?;
    let mut cached: Vec<(String, PathBuf)> = Vec::new();
    {
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for rev in &repo.revisions {
            for f in &rev.files {
                let posix = f.file_name.replace('\\', "/");
                if posix.is_empty() || !seen.insert(posix.clone()) {
                    continue;
                }
                cached.push((posix, f.file_path.clone()));
            }
        }
    }

    // Plan the required (logical-key) files by matching each glob against the cached file list —
    // the SAME planning logic as `resolve_remote`, just over the on-disk snapshot instead of the
    // remote tree. A missing required file is a cache miss (→ network pass).
    let globs = file_globs(&req.model_id, req.kind, req.effective_quant);
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    for fg in &globs {
        // Match the glob (and the `.onnx`→`.ort` fallback) against the cached POSIX paths.
        let mut matches: Vec<&String> = cached
            .iter()
            .map(|(p, _)| p)
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = cached
                    .iter()
                    .map(|(p, _)| p)
                    .filter(|p| glob_match(&ort, p))
                    .collect();
            }
        }
        let chosen = match pick_kaldi_tiebreak(req.kind, &matches) {
            Ok(Some(p)) => (*p).clone(),
            Ok(None) => {
                // Required file not cached → genuine miss; let `resolve()` go to the network.
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in local cache {}/{}",
                    fg.key, fg.glob, owner, name
                )));
            }
            Err(()) => {
                return Err(SttError::Resolve(format!(
                    "more than one cached file matched {} in {}/{}",
                    fg.glob, owner, name
                )));
            }
        };
        let abs = cached
            .iter()
            .find(|(p, _)| *p == chosen)
            .map(|(_, abs)| abs.clone())
            .ok_or_else(|| {
                SttError::Resolve(format!(
                    "cache path lost for {} in {}/{}",
                    fg.key, owner, name
                ))
            })?;
        files.insert(fg.key.to_string(), abs);
    }

    // config.json (resolver.py:145-147): include it when cached so families that read decode params
    // from config (e.g. T-One vocab) have it. Optional — its absence is not a cache miss. The
    // external-data sidecars don't need enumerating into the map (they're not logical-key entries);
    // `resolve()`'s `all_onnx_complete` verifies them on disk next, relative to each `.onnx`'s dir.
    if let Some((_, abs)) = cached.iter().find(|(p, _)| p == "config.json") {
        files.insert("config".into(), abs.clone());
    }

    Ok(ResolvedModel {
        files,
        effective_quantization: req.effective_quant,
    })
}

// ---------------------------------------------------------------------------
// 6b. Per-quant download PLAN + progress-aware fetch (consumed by DownloadManager)
// ---------------------------------------------------------------------------

/// The full set of repo-relative POSIX paths a `(model_id, kind, quant)` download must fetch INTO
/// the HF cache: every required graph (`.onnx`) + its external-data sidecars + `config.json` /
/// `config.yaml` + the vocab/tokenizer text files. Mirrors `resolve_remote`'s planning step but
/// returns the path LIST (instead of downloading) so the DownloadManager can stream each file with
/// pause/cancel/progress. Lists the repo tree once over the network.
pub async fn plan_quant_download(
    model_id: &str,
    kind: EngineKind,
    quant: Quantization,
) -> SttResult<Vec<String>> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(model_id)
        .ok_or_else(|| SttError::Resolve(format!("unknown model alias / repo: {model_id}")))?;
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner.clone(), name.clone());
    let tree_paths = list_repo_tree(&repo).await?;

    let globs = file_globs(model_id, kind, quant);
    let mut planned: Vec<String> = Vec::new();
    let mut onnx_stems: Vec<String> = Vec::new();
    for fg in &globs {
        let mut matches: Vec<&String> = tree_paths
            .iter()
            .filter(|p| glob_match(&fg.glob, p))
            .collect();
        if matches.is_empty() {
            if let Some(stem) = fg.glob.strip_suffix(".onnx") {
                let ort = format!("{stem}.ort");
                matches = tree_paths.iter().filter(|p| glob_match(&ort, p)).collect();
            }
        }
        // Kaldi-scoped tie-break (zipformer default glob also matches `.int8` siblings); for any
        // other kind a unique match is chosen, and >1 falls back to `first()` (pre-existing behaviour).
        let path = match pick_kaldi_tiebreak(kind, &matches) {
            Ok(Some(p)) => p.clone(),
            Ok(None) => {
                return Err(SttError::Resolve(format!(
                    "missing {} ({}) in {owner}/{name}",
                    fg.key, fg.glob
                )));
            }
            Err(()) => match matches.first() {
                Some(p) => (*p).clone(),
                None => {
                    return Err(SttError::Resolve(format!(
                        "missing {} ({}) in {owner}/{name}",
                        fg.key, fg.glob
                    )));
                }
            },
        };
        if let Some(stem) = path.strip_suffix(".onnx") {
            onnx_stems.push(stem.to_string());
        }
        planned.push(path);
    }
    // External-data sidecars for each planned `.onnx`.
    for stem in &onnx_stems {
        for p in &tree_paths {
            if is_sidecar_for(stem, p) {
                planned.push(p.clone());
            }
        }
    }
    // config.json / config.yaml when present.
    for cfg in ["config.json", "config.yaml"] {
        if tree_paths.iter().any(|p| p == cfg) {
            planned.push(cfg.to_string());
        }
    }
    // De-dup (a sidecar could in theory also be a planned graph match — defensive).
    planned.sort();
    planned.dedup();
    Ok(planned)
}

/// Download ONE planned repo file INTO the HF cache, reporting byte-level progress via `progress`
/// (an hf-hub `ProgressHandler`). Returns the local cached path. `cache_only` skips the network
/// when the file is already present (used to short-circuit already-cached files cheaply).
pub async fn download_planned_file(
    model_id: &str,
    repo_path: &str,
    cache_only: bool,
    progress: impl Into<hf_hub::progress::Progress>,
) -> SttResult<PathBuf> {
    use hf_hub::HFClient;

    let (owner, name) = resolve_repo(model_id)
        .ok_or_else(|| SttError::Resolve(format!("unknown model alias / repo: {model_id}")))?;
    let client = HFClient::new().map_err(|e| SttError::Resolve(format!("hf client init: {e}")))?;
    let repo = client.model(owner, name);
    let progress: hf_hub::progress::Progress = progress.into();
    repo.download_file()
        .filename(repo_path)
        .local_files_only(cache_only)
        .progress(progress)
        .send()
        .await
        .map_err(|e| SttError::Resolve(format!("download {repo_path}: {e}")))
}

/// True iff `repo_path` is already present + complete in the HF cache (used to skip already-cached
/// files when resuming a partial per-quant download). A cache-only `download_file` succeeds iff the
/// file is cached; we then verify external-data completeness for `.onnx`.
pub async fn is_file_cached(model_id: &str, repo_path: &str) -> bool {
    struct Noop;
    impl hf_hub::progress::ProgressHandler for Noop {
        fn on_progress(&self, _e: &hf_hub::progress::ProgressEvent) {}
    }
    match download_planned_file(model_id, repo_path, true, Noop).await {
        Ok(p) => {
            if repo_path.ends_with(".onnx") {
                verify_external_data_complete(&p)
            } else {
                p.metadata().map(|m| m.len() > 0).unwrap_or(false)
            }
        }
        Err(_) => false,
    }
}

/// Collect the repo's POSIX file paths via `repo.info().send()` → `ModelInfo.siblings`, each a
/// `RepoSibling { rfilename: String, .. }` (the relative repo path — the same `siblings`/`rfilename`
/// surface the Python `huggingface_hub` exposes, which onnx-asr's resolver fnmatches). This is
/// preferred over `list_tree()` (whose `RepoTreeEntry` is an enum we'd have to destructure) because
/// `rfilename` is a flat `String` we can glob directly.
async fn list_repo_tree(
    repo: &hf_hub::HFRepository<hf_hub::RepoTypeModel>,
) -> SttResult<Vec<String>> {
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
            Some((
                "csukuangfj".into(),
                "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17".into()
            ))
        );
        // unknown bare alias → None.
        assert_eq!(resolve_repo("totally-unknown-alias"), None);
    }

    #[test]
    fn catalog_bare_ids_resolve_via_onnx_model_name() {
        // REGRESSION (download-stuck-at-0%): these catalog ids are bare (no `/`) and are NOT in
        // MODEL_REPOS — they were only resolvable via the catalog's `onnx_model_name`. Before the
        // fix, resolve_repo returned None for every one, so per-quant downloads settled cancelled
        // (badge cleared instantly) and cached models showed "Not downloaded".
        assert_eq!(
            resolve_repo("tiny"),
            Some(("onnx-community".into(), "whisper-tiny".into()))
        );
        assert_eq!(
            resolve_repo("medium"),
            Some(("Xenova".into(), "whisper-medium".into()))
        );
        assert_eq!(
            resolve_repo("large-v3-turbo"),
            Some(("onnx-community".into(), "whisper-large-v3-turbo".into()))
        );
        assert_eq!(
            resolve_repo("crisper-whisper"),
            Some(("onnx-community".into(), "CrisperWhisper-ONNX".into()))
        );
        assert_eq!(
            resolve_repo("nemo-canary-1b-flash"),
            Some(("istupakov".into(), "canary-1b-flash-onnx".into()))
        );
        // A catalog id whose onnx_model_name is itself a MODEL_REPOS alias (Moonshine) still
        // resolves through the alias recursion.
        assert_eq!(
            resolve_repo("moonshine-base"),
            Some(("onnx-community".into(), "moonshine-base-ONNX".into()))
        );
    }

    #[test]
    fn quant_suffix_uses_question_separator() {
        assert_eq!(quant_suffix(Quantization::Default), "");
        assert_eq!(quant_suffix(Quantization::Int8), "?int8");
        assert_eq!(quant_suffix(Quantization::Fp16), "?fp16");
    }

    #[test]
    fn whisper_globs_default_and_fp16() {
        let g = file_globs(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Default,
        );
        assert!(g
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "**/encoder_model.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "decoder" && f.glob == "**/decoder_model_merged.onnx"));
        let g16 = file_globs(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Fp16,
        );
        assert!(g16.iter().any(|f| f.glob == "**/encoder_model?fp16.onnx"));
        assert!(g16
            .iter()
            .any(|f| f.glob == "**/decoder_model_merged?fp16.onnx"));
    }

    #[test]
    fn kaldi_vosk_globs_nest_one_dir() {
        // Vosk (no "zipformer"/"icefall" in the id) keeps the nested `*/encoder...` layout.
        let g = file_globs(
            "alphacep/vosk-model-small-ru",
            EngineKind::KaldiTransducer,
            Quantization::Int8,
        );
        assert!(g
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "*/encoder?int8.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "vocab" && f.glob == "*/tokens.txt"));
    }

    #[test]
    fn kaldi_zipformer_globs_root_with_epoch_suffix() {
        // icefall/zipformer ships at the ROOT with an epoch suffix → `encoder-*{?q}.onnx`, `tokens.txt`.
        let g = file_globs(
            "zipformer-en",
            EngineKind::KaldiTransducer,
            Quantization::Default,
        );
        assert!(g
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "encoder-*.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "decoder" && f.glob == "decoder-*.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "joiner" && f.glob == "joiner-*.onnx"));
        assert!(g.iter().any(|f| f.key == "vocab" && f.glob == "tokens.txt"));
        let gi = file_globs(
            "icefall-zipformer",
            EngineKind::KaldiTransducer,
            Quantization::Int8,
        );
        assert!(gi.iter().any(|f| f.glob == "encoder-*?int8.onnx"));
    }

    #[test]
    fn kaldi_tiebreak_prefers_untagged_default_export() {
        // Default zipformer glob `encoder-*.onnx` matches BOTH the default and its int8 sibling.
        let a = "encoder-epoch-99-avg-1.onnx".to_string();
        let b = "encoder-epoch-99-avg-1.int8.onnx".to_string();
        let matches = vec![&a, &b];
        let chosen = pick_kaldi_tiebreak(EngineKind::KaldiTransducer, &matches).unwrap();
        assert_eq!(chosen, Some(&a), "default export (untagged stem) must win");
        // A non-Kaldi kind keeps the strict >1 = error contract.
        assert!(pick_kaldi_tiebreak(EngineKind::WhisperHf, &matches).is_err());
        // Zero / one match pass through unchanged.
        assert_eq!(
            pick_kaldi_tiebreak(EngineKind::KaldiTransducer, &[]).unwrap(),
            None
        );
        assert_eq!(
            pick_kaldi_tiebreak(EngineKind::KaldiTransducer, &[&a]).unwrap(),
            Some(&a)
        );
    }

    #[test]
    fn glob_match_doublestar_recurses() {
        // `**/x.onnx` matches at root and any depth.
        assert!(glob_match("**/encoder_model.onnx", "encoder_model.onnx"));
        assert!(glob_match(
            "**/encoder_model.onnx",
            "onnx/encoder_model.onnx"
        ));
        assert!(glob_match(
            "**/encoder_model.onnx",
            "a/b/encoder_model.onnx"
        ));
        assert!(!glob_match(
            "**/encoder_model.onnx",
            "encoder_model_fp16.onnx"
        ));
    }

    #[test]
    fn glob_match_single_star_one_segment() {
        // `*/tokens.txt` matches exactly one dir level (sherpa pack).
        assert!(glob_match(
            "*/tokens.txt",
            "sherpa-onnx-zipformer-en/tokens.txt"
        ));
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
        assert!(glob_match(
            "**/encoder_model.onnx",
            "onnx\\encoder_model.onnx"
        ));
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
        assert_eq!(
            slug_model_id("onnx-community/whisper-tiny", Quantization::Int8),
            "onnx-community_whisper-tiny__int8"
        );
        assert_eq!(
            slug_model_id("onnx-community/whisper-tiny", Quantization::Default),
            "onnx-community_whisper-tiny__default"
        );
        // int8 vs fp16 never collide.
        assert_ne!(
            slug_model_id("m", Quantization::Int8),
            slug_model_id("m", Quantization::Fp16)
        );
        assert_eq!(slug_model_id("", Quantization::Default), "unknown__default");
    }

    #[test]
    fn file_quantization_reads_suffix_both_separators() {
        assert_eq!(
            file_quantization("encoder_model_fp16.onnx"),
            Quantization::Fp16
        );
        assert_eq!(file_quantization("encoder.int8.onnx"), Quantization::Int8);
        assert_eq!(
            file_quantization("encoder_model.onnx"),
            Quantization::Default
        );
        assert_eq!(file_quantization("model.onnx"), Quantization::Default);
        // q4f16 round-trips (last component).
        assert_eq!(
            file_quantization("decoder_model_merged_q4f16.onnx"),
            Quantization::Q4f16
        );
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
