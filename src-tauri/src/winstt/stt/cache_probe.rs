// PORT IMPL — models slice. Source (authoritative):
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

#![allow(dead_code)] // probe surface is consumed by runtime.rs + download_manager.rs as they wire in.

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
        "sense_voice" => EngineKind::SenseVoiceCtc,
        "dolphin" => EngineKind::DolphinCtc,
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
/// whether THIS quant's weights are present). A quant is "cached" iff every `.onnx` graph it needs
/// is present and external-data-complete.
fn required_onnx_globs(model_id: &str, kind: EngineKind, quant: Quantization) -> Vec<FileGlob> {
    resolver::file_globs(model_id, kind, quant)
        .into_iter()
        .filter(|fg| fg.glob.ends_with(".onnx"))
        .collect()
}

/// Given the set of cached `(posix_name, size_bytes, complete)` triples for one repo, decide the
/// cache state for ONE quantization. `complete` is the per-file external-data completeness flag the
/// caller computed from the on-disk snapshot.
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
        if let Some((_, size, complete)) = best {
            present += 1;
            matched_bytes += *size;
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
    let file_name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    resolver::file_quantization(file_name) == quant
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
/// PICKER-OPEN HOT PATH (audit #7): this is the list path (`list_models_with_state`). It does NOT
/// run `verify_external_data_complete` — that stat/parses every cached `.onnx` (the Rust analogue of
/// the documented Python `list_models_onnx_parse_loop_starvation` bug). Every `.onnx` present on
/// disk is treated as complete here; the LOAD path (`resolver::resolve` → `all_onnx_complete`) does
/// the authoritative per-shard verify lazily, only for the one quant actually being loaded.
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

    // Index cached repos by lowercase `owner/name` for a cheap lookup per model.
    let mut repo_files: BTreeMap<String, Vec<(String, u64, bool)>> = BTreeMap::new();
    for repo in &scan.repos {
        // Collect every file across all cached revisions of this repo. The completeness flag is set
        // to `true` for every present file: the picker-open list path deliberately skips the
        // per-`.onnx` external-data verify (see the doc-comment above). Presence is enough to badge
        // the quant `cached`; the load path catches a truly-partial shard set and refetches.
        let mut files: Vec<(String, u64, bool)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for rev in &repo.revisions {
            for f in &rev.files {
                let posix = f.file_name.replace('\\', "/");
                if !seen.insert(posix.clone()) {
                    continue;
                }
                files.push((posix, f.size_on_disk, true));
            }
        }
        repo_files.insert(repo.repo_id.to_ascii_lowercase(), files);
    }

    for m in models {
        let mut mqc = ModelQuantCache::default();
        // Resolve the model's HF repo id; an unknown bare alias has no cache entry → all not_cached.
        let repo_key =
            resolver::resolve_repo(&m.id).map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase());
        let cached = repo_key.as_ref().and_then(|k| repo_files.get(k));
        let kind = engine_kind_for(&m.id, &m.family, &m.onnx_name);

        for q in &m.quantizations {
            let quant = Quantization::parse(q).unwrap_or(Quantization::Default);
            let (state, bytes) = match cached {
                Some(files) => quant_state(&m.id, kind, quant, files),
                None => (CacheState::NotCached, 0),
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
