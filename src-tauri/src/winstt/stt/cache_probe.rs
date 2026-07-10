// Models slice. Reference (authoritative):
//   server/src/recorder/infrastructure/model_state.py (model_state_dict — per-quant cache scan)
//   server/src/recorder/infrastructure/model_cache.py (_file_quantization, snapshot scan)
//   + onnx-asr resolver (which files a (family, quant) needs)
//   + the renderer contract: ModelCacheInfo { state: "cached"|"partial"|"not_cached", … }
//     (entities/model-catalog/model/model-state-store.ts + lib/model-options.ts).
//
// WHAT THIS DOES
// --------------
// The detached model-picker keys every per-quant badge ("✓ Downloaded" / "⏬ 42%" /
// "⬇ Not downloaded") off `cache_by_quantization[quant].state`, and the model's overall badge
// off the EFFECTIVE precision's state (the effective-quant bridge). The original Python server
// computed those states by scanning the HuggingFace cache snapshot directory per (model, quant).
//
// This module ports that scan onto hf-hub's `scan_cache()` (which walks the SAME cache the
// resolver downloads into → badge↔load agreement). For each catalog model we:
//   1. resolve its HF repo id (resolver::resolve_repo),
//   2. find that repo in the cache scan (if absent → every quant is `not_cached`),
//   3. collect the cached file names across all snapshot revisions,
//   4. for each available quantization, glob the engine's REQUIRED graph file(s)
//      (resolver::file_globs for the model's EngineKind) against the cached names and check
//      external-data completeness. All required graphs present + complete → `cached`; some
//      present → `partial`; none → `not_cached`.
//
// model_id → EngineKind mapping lives here (the only place in the models slice that needs it for
// the file-glob set). It mirrors onnx-asr's family→loader dispatch, derived from the catalog
// `family` string plus the handful of id/name patterns that split a catalog family across two
// decode archetypes (e.g. NeMo ctc/rnnt/tdt/aed, GigaAM ctc/rnnt, Kaldi vosk-transducer vs
// zipformer-transducer — both transducer).

use std::collections::{BTreeMap, BTreeSet};

use super::resolver::{self, FileGlob};
use super::{EngineKind, Quantization};

/// The three cache states the renderer's badge formatter understands. We re-derive the strings
/// here (rather than importing the command-layer struct) so this engine-slice module stays free of
/// the `serde`/`specta` command types. The caller maps `(CacheState, bytes)` → `ModelCacheInfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheState {
    Cached,
    Partial,
    NotCached,
}

impl CacheState {
    pub fn as_str(self) -> &'static str {
        match self {
            CacheState::Cached => "cached",
            CacheState::Partial => "partial",
            CacheState::NotCached => "not_cached",
        }
    }
}

/// One model's per-quant on-disk cache snapshot. `quant` keys are the catalog suffix strings
/// (`""` = default export, `"int8"`, `"fp16"`, …) so they line up 1:1 with
/// `available_quantizations` and the renderer's `cache_by_quantization` map.
#[derive(Clone, Debug, Default)]
pub struct ModelQuantCache {
    /// `quant_suffix → (state, downloaded_bytes, total_bytes)`. `total_bytes` is the on-disk byte
    /// sum of the matched graph files (we don't know the remote total without a HEAD, so for a
    /// fully-cached quant downloaded == total; partial uses the same number as a best-effort).
    pub by_quant: BTreeMap<String, (CacheState, u64, u64)>,
}

// ---------------------------------------------------------------------------
// 1. model_id / family → EngineKind (the file-glob selector)
// ---------------------------------------------------------------------------

/// Map a catalog model (`id`, `family`, `onnx_model_name`) to the decode archetype whose
/// `file_globs` define which files a given quant needs. `family` is the catalog slug
/// (`whisper`/`moonshine`/`nemo`/`cohere`/`kaldi`/`gigaam`/`t-one`/`sense_voice`/`dolphin`).
///
/// Faithful to onnx-asr's family dispatch: several catalog families fan out by the model id /
/// onnx name (NeMo: ctc/rnnt/tdt/aed; GigaAM: ctc/rnnt). When a family can't be split by name we
/// pick the archetype that shares the SAME required-file set (the glob set is what matters for the
/// probe — Kaldi vosk and zipformer both resolve as `KaldiTransducer`).
pub fn engine_kind_for(id: &str, family: &str, onnx_name: &str) -> EngineKind {
    let hay = format!("{} {} {}", id, onnx_name, family).to_ascii_lowercase();
    let has = |needle: &str| hay.contains(needle);

    match family {
        "whisper" => EngineKind::WhisperHf,
        "moonshine" => EngineKind::Moonshine,
        "cohere" => EngineKind::CohereAsr,
        "granite" => {
            if has("nar") {
                EngineKind::GraniteSpeechNar
            } else {
                EngineKind::GraniteSpeechAr
            }
        }
        "sense_voice" => EngineKind::SenseVoiceCtc,
        "dolphin" => EngineKind::DolphinCtc,
        "qwen3" => EngineKind::Qwen3Asr,
        "t-one" => EngineKind::ToneCtc,
        "kaldi" if has("streaming") => EngineKind::KaldiTransducerStreaming, // sherpa streaming zipformer2
        "kaldi" => EngineKind::KaldiTransducer, // vosk + zipformer both = transducer file set
        "gigaam" => {
            if has("rnnt") {
                EngineKind::GigaamRnnt
            } else {
                EngineKind::GigaamCtc
            }
        }
        "nemo" => {
            if has("canary") {
                EngineKind::NemoAed
            } else if has("streaming") {
                // sherpa-onnx streaming FastConformer (cache-aware): CTC vs RNN-T transducer.
                if has("ctc") {
                    EngineKind::NemoCtcStreaming
                } else {
                    EngineKind::NemoRnntStreaming
                }
            } else if has("rnnt") {
                EngineKind::NemoRnnt
            } else if has("tdt") {
                EngineKind::NemoTdt
            } else {
                // parakeet-ctc / fastconformer-ctc → CTC.
                EngineKind::NemoCtc
            }
        }
        // Off-catalog / custom → treat as Whisper-HF layout (the permissive default the resolver
        // also assumes for unknown repos).
        _ => EngineKind::WhisperHf,
    }
}

// ---------------------------------------------------------------------------
// 2. Per-quant cache attribution over a set of cached file names
// ---------------------------------------------------------------------------

/// The graph (`.onnx`) globs a quant requires — i.e. `file_globs` minus the always-present
/// vocab/tokenizer/config text files (those are shared across quants, so they don't tell us
/// whether THIS quant's weights are present), AND minus OPTIONAL graphs. An optional graph (e.g.
/// the Cohere `decoder_dyn` CPU-fallback, or the NeMo AED KV fast-path exports) is one the loader
/// runs fine without, so a repo that doesn't ship it for a given precision — the Cohere Arabic
/// export has no `decoder_model_merged_int8_dyn` — must still badge that quant "cached" once its
/// REQUIRED graphs are present. Including the optional here left such a quant stuck at `Partial`
/// forever (the "1% / can't finish" badge). A quant is "cached" iff every REQUIRED `.onnx` graph it
/// needs is present and external-data-complete.
fn required_onnx_globs(model_id: &str, kind: EngineKind, quant: Quantization) -> Vec<FileGlob> {
    resolver::file_globs(model_id, kind, quant)
        .into_iter()
        .filter(|fg| !fg.optional && fg.glob.ends_with(".onnx"))
        .collect()
}

/// Given the set of cached `(posix_name, size_bytes, complete)` triples for one repo, decide the
/// cache state and DOWNLOADED-BYTES for ONE quantization. `complete` is the per-file external-data
/// completeness flag the caller computed.
///
/// The returned byte count sums each present graph AND its external-data sidecars (`.onnx_data*`).
/// The `.onnx` graph is only KB-MB while its weights are GB, so counting graphs alone made a
/// partial (or even fully-cached) download read a nonsense ~1% against the real repo total. (In-flight
/// `.incomplete` STAGING bytes are folded in by the caller, only for a `Partial` result.)
fn quant_state(
    model_id: &str,
    kind: EngineKind,
    quant: Quantization,
    cached: &[(String, u64, bool)],
) -> (CacheState, u64) {
    let globs = required_onnx_globs(model_id, kind, quant);
    if globs.is_empty() {
        // No graph files for this archetype (shouldn't happen) → can't attribute → not cached.
        return (CacheState::NotCached, 0);
    }
    let mut matched_bytes = 0u64;
    let mut present = 0usize;
    let mut all_complete = true;
    for fg in &globs {
        // A glob is satisfied if SOME cached file matches it. Prefer the largest match (the real
        // graph, not a stray `.ort` of zero size).
        let best = cached
            .iter()
            .filter(|(name, _, _)| matches_quant_glob(&fg.glob, name, quant))
            .max_by_key(|(_, size, _)| *size);
        if let Some((name, size, complete)) = best {
            present += 1;
            matched_bytes += *size;
            // Add every external-data sidecar of this graph (`<stem>.onnx_data*` / `.weights`) — the
            // real weight bytes. Without this the "downloaded" figure was just the tiny graph.
            if let Some(stem) = name.strip_suffix(".onnx") {
                for (sname, ssize, _) in cached {
                    if resolver::is_sidecar_for(stem, sname) {
                        matched_bytes += *ssize;
                    }
                }
            }
            if !*complete {
                all_complete = false;
            }
        }
    }
    if present == 0 {
        (CacheState::NotCached, 0)
    } else if present == globs.len() && all_complete {
        (CacheState::Cached, matched_bytes)
    } else {
        (CacheState::Partial, matched_bytes)
    }
}

/// Match a cached repo file name against a required `.onnx` glob FOR A SPECIFIC QUANT, with the
/// extra guard that the matched file's actual quant tag equals the requested one. Without this
/// guard the default (`""`) glob `**/encoder_model.onnx` would never be a problem, but the
/// quant-suffixed forms rely on the `?`-separator glob which already encodes the tag; we add the
/// `file_quantization` cross-check so a partial onnx name collision can't mis-attribute a file to
/// the wrong precision (e.g. `..._fp16.onnx` accidentally counting toward int8).
fn matches_quant_glob(glob: &str, name: &str, quant: Quantization) -> bool {
    if !resolver::glob_match(glob, name) {
        return false;
    }
    // Confirm the file's own quant tag matches what we're attributing it to. The glob already
    // enforces the suffix for non-default quants; for the default export we require NO recognised
    // quant tag on the stem (so a stray `encoder_model_int8.onnx` doesn't satisfy the default
    // `**/encoder_model.onnx` — which it can't anyway, but this makes the intent explicit).
    path_quantization(name) == quant
}

fn path_quantization(name: &str) -> Quantization {
    let posix = name.replace('\\', "/");
    if let Some((first, _)) = posix.split_once('/') {
        return match first {
            "fp32" => Quantization::Default,
            "fp16" => Quantization::Fp16,
            "fp16w" => Quantization::Fp16w,
            "int8" => Quantization::Int8,
            "uint8" => Quantization::Uint8,
            "q4" => Quantization::Q4,
            "q4f16" => Quantization::Q4f16,
            "bnb4" => Quantization::Bnb4,
            _ => {
                let file_name = posix.rsplit('/').next().unwrap_or(&posix);
                resolver::file_quantization(file_name)
            }
        };
    }
    resolver::file_quantization(&posix)
}

// ---------------------------------------------------------------------------
// 3. The probe (hf-hub scan_cache → per-model per-quant states)
// ---------------------------------------------------------------------------

/// One catalog model's identity + its published quant set, as the probe needs it.
#[derive(Clone, Debug)]
pub struct ProbeModel {
    pub id: String,
    pub family: String,
    pub onnx_name: String,
    /// Catalog `available_quantizations` (suffix strings, `""` for default).
    pub quantizations: Vec<String>,
}

/// Probe the HF cache for every model in `models`, returning `model_id → ModelQuantCache`.
///
/// Async because hf-hub's `scan_cache()` is async. The caller (download_manager / runtime command)
/// drives it on the shared runtime. A scan failure (no cache dir yet, IO error) degrades to an EMPTY
/// map → every model reads `not_cached`, which is the honest cold-start answer.
///
/// Sum the repo's in-flight STAGING bytes: every `blobs/<etag>.incomplete` file (a transfer paused
/// or interrupted mid-file — the streamer stages there before renaming into `snapshots/`). These are
/// real downloaded bytes not yet committed to a snapshot file, so a partial quant counts them toward
/// its progress. A missing/unreadable `blobs` dir → 0 (the common no-staging case). Cheap: one
/// `read_dir` + a `stat` per staging file.
fn staging_bytes_in(repo_path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(repo_path.join("blobs")) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("incomplete")
                && let Ok(meta) = entry.metadata()
            {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// EXTERNAL-DATA COMPLETENESS: a graph `.onnx` present but its `.onnx_data*` shard MISSING (e.g. an
/// interrupted multi-GB download) must NOT badge `cached` — otherwise the picker shows green, the
/// user selects the quant, and the LOAD path (`resolver::resolve`) then SILENTLY refetches gigabytes
/// with no feedback ("transcription stuck forever"). So we DO verify completeness here, but cheaply:
/// `verify_external_data_complete` parses ONLY graphs under 64 MB (`EXTERNAL_DATA_PARSE_SIZE_GUARD`)
/// — big inline-weight graphs are instant-skipped, avoiding the documented Python
/// `list_models_onnx_parse_loop_starvation` cost — and we scope the verify to the repos actually
/// being probed (below); most catalog models aren't cached so contribute nothing. The whole probe
/// result is memoized for 2 s by the caller (`cache_snapshot_async`), so a picker open pays it once.
pub async fn probe_cache(models: &[ProbeModel]) -> BTreeMap<String, ModelQuantCache> {
    let mut out: BTreeMap<String, ModelQuantCache> = BTreeMap::new();

    let client = match hf_hub::HFClient::new() {
        Ok(c) => c,
        Err(_) => return out,
    };
    let scan = match client.scan_cache().send().await {
        Ok(s) => s,
        Err(_) => return out,
    };

    // The repos we actually probe (each model × quant → its resolved repo key). ONLY these get the
    // bounded external-data verify; every other cached repo's completeness flag is never read, so we
    // leave it `true` and skip the parse entirely.
    let mut relevant_repos: BTreeSet<String> = BTreeSet::new();
    for m in models {
        for q in &m.quantizations {
            let quant = Quantization::parse(q).unwrap_or(Quantization::Default);
            if let Some((o, n)) = resolver::resolve_repo_for_quant(&m.id, quant) {
                relevant_repos.insert(format!("{o}/{n}").to_ascii_lowercase());
            }
        }
    }

    // Index cached repos by lowercase `owner/name` for a cheap lookup per model, plus each probed
    // repo's in-flight STAGING total (`blobs/<etag>.incomplete` — bytes of a file mid-transfer that
    // isn't a committed snapshot file yet). An interrupted multi-GB download leaves these, and they
    // are real progress, so they count toward the repo's partial quant.
    let mut repo_files: BTreeMap<String, Vec<(String, u64, bool)>> = BTreeMap::new();
    let mut repo_staging: BTreeMap<String, u64> = BTreeMap::new();
    for repo in &scan.repos {
        let repo_key = repo.repo_id.to_ascii_lowercase();
        // Verify external-data completeness only for probed repos (see the doc-comment). Presence
        // alone is NOT enough — a graph whose shard series is incomplete must read `partial`.
        let verify = relevant_repos.contains(&repo_key);
        if verify {
            repo_staging.insert(repo_key.clone(), staging_bytes_in(&repo.repo_path));
        }
        let mut files: Vec<(String, u64, bool)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for rev in &repo.revisions {
            for f in &rev.files {
                let posix = f.file_name.replace('\\', "/");
                if !seen.insert(posix.clone()) {
                    continue;
                }
                // A `.onnx` graph is "complete" iff its referenced external-data sidecars are all on
                // disk; `verify_external_data_complete` self-limits its protobuf parse to <64 MB
                // graphs. Non-`.onnx` files (vocab/tokenizer/config/sidecars) are always `true`.
                let complete = if verify && posix.ends_with(".onnx") {
                    resolver::verify_external_data_complete(&f.file_path)
                } else {
                    true
                };
                files.push((posix, f.size_on_disk, complete));
            }
        }
        repo_files.insert(repo_key, files);
    }

    for m in models {
        let mut mqc = ModelQuantCache::default();
        let kind = engine_kind_for(&m.id, &m.family, &m.onnx_name);

        for q in &m.quantizations {
            let quant = Quantization::parse(q).unwrap_or(Quantization::Default);
            // Resolve the HF repo id PER QUANT: a per-quant override (e.g. the multilingual int8 we
            // host on Masterx) can place one precision in a different repo than the model default.
            // An unknown bare alias has no cache entry → not_cached.
            let repo_key = resolver::resolve_repo_for_quant(&m.id, quant)
                .map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase());
            let cached = repo_key.as_ref().and_then(|k| repo_files.get(k));
            let staging = repo_key
                .as_ref()
                .and_then(|k| repo_staging.get(k))
                .copied()
                .unwrap_or(0);
            let (state, bytes) = match cached {
                Some(files) => quant_state(&m.id, kind, quant, files),
                None => (CacheState::NotCached, 0),
            };
            // Fold the repo's in-flight `.incomplete` staging bytes into a PARTIAL quant's progress
            // (an interrupted multi-GB shard is real downloaded bytes). Only `Partial` — a fully
            // `Cached` quant has no pending transfer, and a `NotCached` quant has nothing started.
            let bytes = if state == CacheState::Partial {
                bytes.saturating_add(staging)
            } else {
                bytes
            };
            mqc.by_quant.insert(q.clone(), (state, bytes, bytes));
        }
        out.insert(m.id.clone(), mqc);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_kind_dispatch_matches_family() {
        assert_eq!(
            engine_kind_for("tiny", "whisper", "onnx-community/whisper-tiny"),
            EngineKind::WhisperHf
        );
        assert_eq!(
            engine_kind_for("moonshine-base", "moonshine", "moonshine-base"),
            EngineKind::Moonshine
        );
        assert_eq!(
            engine_kind_for("cohere-transcribe", "cohere", "cohere-transcribe"),
            EngineKind::CohereAsr
        );
        assert_eq!(
            engine_kind_for(
                "granite-speech-4.1-2b-plus",
                "granite",
                "smcleod/ibm-granite-speech-4.1-2b-plus-onnx"
            ),
            EngineKind::GraniteSpeechAr
        );
        assert_eq!(
            engine_kind_for(
                "granite-speech-4.1-2b-nar",
                "granite",
                "smcleod/ibm-granite-speech-4.1-2b-nar-onnx"
            ),
            EngineKind::GraniteSpeechNar
        );
        assert_eq!(
            engine_kind_for("sense-voice-small", "sense_voice", "x"),
            EngineKind::SenseVoiceCtc
        );
        assert_eq!(
            engine_kind_for("dolphin-base-ctc", "dolphin", "dolphin-base-ctc"),
            EngineKind::DolphinCtc
        );
        assert_eq!(
            engine_kind_for("t-tech/t-one", "t-one", "t-tech/t-one"),
            EngineKind::ToneCtc
        );
        assert_eq!(
            engine_kind_for("zipformer-en", "kaldi", "zipformer-en"),
            EngineKind::KaldiTransducer
        );
        assert_eq!(
            engine_kind_for("alphacep/vosk-model-ru", "kaldi", "x"),
            EngineKind::KaldiTransducer
        );
        assert_eq!(
            engine_kind_for("qwen3-asr-0.6b", "qwen3", "andrewleech/qwen3-asr-0.6b-onnx"),
            EngineKind::Qwen3Asr
        );
    }

    #[test]
    fn nemo_family_fans_out_by_name() {
        assert_eq!(
            engine_kind_for("nemo-parakeet-ctc-0.6b", "nemo", "nemo-parakeet-ctc-0.6b"),
            EngineKind::NemoCtc
        );
        assert_eq!(
            engine_kind_for("nemo-parakeet-rnnt-0.6b", "nemo", "nemo-parakeet-rnnt-0.6b"),
            EngineKind::NemoRnnt
        );
        assert_eq!(
            engine_kind_for(
                "nemo-parakeet-tdt-0.6b-v3",
                "nemo",
                "nemo-parakeet-tdt-0.6b-v3"
            ),
            EngineKind::NemoTdt
        );
        assert_eq!(
            engine_kind_for("nemo-canary-1b-v2", "nemo", "nemo-canary-1b-v2"),
            EngineKind::NemoAed
        );
        assert_eq!(
            engine_kind_for(
                "nemo-canary-1b-flash",
                "nemo",
                "istupakov/canary-1b-flash-onnx"
            ),
            EngineKind::NemoAed
        );
    }

    #[test]
    fn gigaam_family_splits_ctc_rnnt() {
        assert_eq!(
            engine_kind_for("gigaam-v3-e2e-ctc", "gigaam", "gigaam-v3-e2e-ctc"),
            EngineKind::GigaamCtc
        );
        assert_eq!(
            engine_kind_for("gigaam-v3-e2e-rnnt", "gigaam", "gigaam-v3-e2e-rnnt"),
            EngineKind::GigaamRnnt
        );
    }

    #[test]
    fn quant_state_cached_when_all_graphs_present_and_complete() {
        // Whisper default export needs encoder_model.onnx + decoder_model_merged.onnx.
        let files = vec![
            ("onnx/encoder_model.onnx".to_string(), 100, true),
            ("onnx/decoder_model_merged.onnx".to_string(), 200, true),
            ("vocab.json".to_string(), 5, true),
        ];
        let (state, bytes) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Default,
            &files,
        );
        assert_eq!(state, CacheState::Cached);
        assert_eq!(bytes, 300);
    }

    #[test]
    fn quant_state_uses_granite_precision_directory() {
        let files = vec![
            ("int8/encoder.onnx".to_string(), 100, true),
            ("int8/prompt_encode.onnx".to_string(), 200, true),
            ("int8/decode_step.onnx".to_string(), 300, true),
            ("int8/embed_tokens.onnx".to_string(), 400, true),
        ];
        let (state, bytes) = quant_state(
            "granite-speech-4.1-2b-plus",
            EngineKind::GraniteSpeechAr,
            Quantization::Int8,
            &files,
        );
        assert_eq!(state, CacheState::Cached);
        assert_eq!(bytes, 1000);

        let (default_state, _) = quant_state(
            "granite-speech-4.1-2b-plus",
            EngineKind::GraniteSpeechAr,
            Quantization::Default,
            &files,
        );
        assert_eq!(default_state, CacheState::NotCached);
    }

    #[test]
    fn quant_state_partial_when_one_graph_missing() {
        let files = vec![("onnx/encoder_model.onnx".to_string(), 100, true)];
        let (state, _) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Default,
            &files,
        );
        assert_eq!(state, CacheState::Partial);
    }

    #[test]
    fn quant_state_partial_when_external_data_incomplete() {
        let files = vec![
            ("onnx/encoder_model_fp16.onnx".to_string(), 100, false), // shard missing
            ("onnx/decoder_model_merged_fp16.onnx".to_string(), 200, true),
        ];
        let (state, _) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Fp16,
            &files,
        );
        assert_eq!(state, CacheState::Partial);
    }

    #[test]
    fn quant_state_not_cached_when_no_graph() {
        let files = vec![("vocab.json".to_string(), 5, true)];
        let (state, bytes) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Default,
            &files,
        );
        assert_eq!(state, CacheState::NotCached);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn fp16_files_do_not_satisfy_default_quant() {
        // Only fp16 graphs present → the DEFAULT (unsuffixed) quant stays not_cached and vice-versa.
        let files = vec![
            ("onnx/encoder_model_fp16.onnx".to_string(), 100, true),
            ("onnx/decoder_model_merged_fp16.onnx".to_string(), 200, true),
        ];
        let (default_state, _) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Default,
            &files,
        );
        assert_eq!(
            default_state,
            CacheState::NotCached,
            "fp16 files must not satisfy default export"
        );
        let (fp16_state, _) = quant_state(
            "onnx-community/whisper-tiny",
            EngineKind::WhisperHf,
            Quantization::Fp16,
            &files,
        );
        assert_eq!(fp16_state, CacheState::Cached);
    }

    #[test]
    fn cohere_int8_cached_without_optional_dyn_decoder() {
        // REGRESSION: the Cohere Arabic export ships `encoder_model_int8` + `decoder_model_merged_int8`
        // but NO `decoder_model_merged_int8_dyn` (the OPTIONAL CPU-fallback graph). The probe must
        // badge int8 "cached" off the two REQUIRED graphs — including the optional `_dyn` as required
        // left this quant stuck at `Partial` (the "1% / can't finish" badge the user reported).
        let files = vec![
            ("onnx/encoder_model_int8.onnx".to_string(), 1000, true),
            ("onnx/decoder_model_merged_int8.onnx".to_string(), 500, true),
            ("tokenizer.json".to_string(), 10, true),
        ];
        let (state, bytes) = quant_state(
            "cohere-transcribe-arabic",
            EngineKind::CohereAsr,
            Quantization::Int8,
            &files,
        );
        assert_eq!(state, CacheState::Cached);
        assert_eq!(bytes, 1500);
        // The default export (which DOES ship its `_dyn`) still requires only encoder+decoder, and a
        // present `_dyn` neither breaks nor is needed for the cached verdict.
        let files_default = vec![
            ("onnx/encoder_model.onnx".to_string(), 2000, true),
            ("onnx/decoder_model_merged.onnx".to_string(), 800, true),
            ("onnx/decoder_model_merged_dyn.onnx".to_string(), 400, true),
        ];
        let (dstate, _) = quant_state(
            "cohere-transcribe-arabic",
            EngineKind::CohereAsr,
            Quantization::Default,
            &files_default,
        );
        assert_eq!(dstate, CacheState::Cached);
    }

    #[test]
    fn quant_state_downloaded_bytes_include_external_data_sidecars() {
        // REGRESSION (badge read ~1%): the `.onnx` graph is KB-MB, its `.onnx_data*` weights are GB.
        // Downloaded-bytes must sum graph + sidecars, else the picker showed ~1% for a model with
        // gigabytes on disk (multilingual cohere int8). Sharded encoder + single-file decoder here.
        let files = vec![
            ("onnx/encoder_model_int8.onnx".to_string(), 20_000_000, true),
            (
                "onnx/encoder_model_int8.onnx_data".to_string(),
                2_000_000_000,
                true,
            ),
            (
                "onnx/encoder_model_int8.onnx_data_1".to_string(),
                700_000_000,
                true,
            ),
            (
                "onnx/decoder_model_merged_int8.onnx".to_string(),
                120_000,
                true,
            ),
            (
                "onnx/decoder_model_merged_int8.onnx_data".to_string(),
                195_000_000,
                true,
            ),
            ("tokenizer.json".to_string(), 1_800_000, true), // shared metadata — NOT counted
        ];
        let (state, bytes) = quant_state(
            "cohere-transcribe",
            EngineKind::CohereAsr,
            Quantization::Int8,
            &files,
        );
        assert_eq!(state, CacheState::Cached);
        assert_eq!(
            bytes,
            20_000_000 + 2_000_000_000 + 700_000_000 + 120_000 + 195_000_000,
            "downloaded bytes must include every graph's external-data sidecars, not just the graph"
        );
    }

    #[test]
    fn int8_ctc_model_single_graph() {
        // Dolphin/SenseVoice CTC = one `model.onnx` graph. int8 export → model.int8.onnx / model_int8.onnx.
        let files = vec![
            ("model.int8.onnx".to_string(), 999, true),
            ("tokens.txt".to_string(), 3, true),
        ];
        let (state, bytes) = quant_state(
            "dolphin-base-ctc",
            EngineKind::DolphinCtc,
            Quantization::Int8,
            &files,
        );
        assert_eq!(state, CacheState::Cached);
        assert_eq!(bytes, 999);
    }
}
