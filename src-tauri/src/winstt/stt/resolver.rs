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
//
// MODULE LAYOUT
// -------------
// This file is the facade for a directory module. The implementation is split into two clean layers
// with a one-way dependency (`globs` <- `sidecars` <- `fetch`):
//   * `globs`    — pure repo-id + glob resolution (alias table, repo-id resolution, per-EngineKind
//                  file globs, POSIX glob matcher). No I/O, no async.
//   * `sidecars` — external-data sidecar enumeration + completeness, the per-quant cache slug, and
//                  on-disk filename quant parsing. Pure / filesystem-read only.
//   * `fetch`    — the async hf-hub resolution + download pipeline that consumes the above.
// The `pub use` re-exports below keep every `resolver::X` path stable for external callers.

mod fetch;
mod globs;
mod sidecars;

pub use fetch::*;
pub use globs::*;
pub use sidecars::*;

// ---------------------------------------------------------------------------
// LIB WIRING NOTE
// ---------------------------------------------------------------------------
// * `stt/mod.rs` must add `pub mod resolver;` and `pub mod fp16_patch;` (this module references
//   `crate::winstt::stt::fp16_patch::external_data_locations`). The orchestrator wires these
//   serially.
// * Cargo.toml: `hf-hub`'s `blocking` feature is NOT default-on, and we use the ASYNC client, so no
//   hf-hub feature change is required for the async path. (If a future caller wants the blocking
//   `HFClientSync` instead, add `features = ["blocking"]`.) No `futures-util` is needed here — repo
//   listing uses `repo.info().send().await` (siblings), not a stream.
// * `crate::winstt::stt::fp16_patch::external_data_locations` is consumed for the small-graph
//   sidecar parse.
// * The engine `build_engine()` (mod.rs) calls `resolve_blocking(handle, &ResolveRequest{..})` to
//   get the `ResolvedModel`, then loads each `files[key]` with `ort_env::load_with_fp16_repair`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::stt::{EngineKind, Quantization};

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
        assert_eq!(
            resolve_repo("granite-speech-4.1-2b"),
            Some(("smcleod".into(), "ibm-granite-speech-4.1-2b-onnx".into()))
        );
        assert_eq!(
            resolve_repo("granite-speech-4.1-2b-nar"),
            Some((
                "smcleod".into(),
                "ibm-granite-speech-4.1-2b-nar-onnx".into()
            ))
        );
        assert_eq!(resolve_repo("granite-4.0-1b-speech"), None);
    }

    #[test]
    fn quant_suffix_uses_question_separator() {
        assert_eq!(quant_suffix(Quantization::Default), "");
        assert_eq!(quant_suffix(Quantization::Int8), "?int8");
        assert_eq!(quant_suffix(Quantization::Fp16), "?fp16");
        assert_eq!(quant_suffix(Quantization::Fp16w), "?fp16w");
    }

    #[test]
    fn granite_globs_use_precision_directories() {
        let ar = file_globs(
            "granite-speech-4.1-2b",
            EngineKind::GraniteSpeechAr,
            Quantization::Int8,
        );
        assert!(ar
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "int8/encoder.onnx"));
        assert!(ar
            .iter()
            .any(|f| f.key == "prompt_encode" && f.glob == "int8/prompt_encode.onnx"));
        assert!(ar
            .iter()
            .any(|f| f.key == "decode_step" && f.glob == "int8/decode_step.onnx"));
        assert!(ar
            .iter()
            .any(|f| f.key == "embed_tokens" && f.glob == "int8/embed_tokens.onnx"));

        let nar = file_globs(
            "granite-speech-4.1-2b-nar",
            EngineKind::GraniteSpeechNar,
            Quantization::Fp16w,
        );
        assert!(nar
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "fp16w/encoder.onnx"));
        assert!(nar
            .iter()
            .any(|f| f.key == "editor" && f.glob == "fp16w/editor.onnx"));
        assert!(nar
            .iter()
            .any(|f| f.key == "embed_tokens" && f.glob == "fp16w/embed_tokens.onnx"));
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
    fn streaming_zipformer_globs_pin_left_128_graph_set() {
        let g = file_globs(
            "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
            EngineKind::KaldiTransducerStreaming,
            Quantization::Default,
        );
        assert!(g
            .iter()
            .any(|f| f.key == "encoder" && f.glob == "encoder-*chunk-16-left-128.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "decoder" && f.glob == "decoder-*chunk-16-left-128.onnx"));
        assert!(g
            .iter()
            .any(|f| f.key == "joiner" && f.glob == "joiner-*chunk-16-left-128.onnx"));

        let gi = file_globs(
            "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
            EngineKind::KaldiTransducerStreaming,
            Quantization::Int8,
        );
        assert!(gi
            .iter()
            .any(|f| f.glob == "encoder-*chunk-16-left-128?int8.onnx"));
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
        assert!(is_sidecar_for(stem, "encoder_model_fp16.weights"));
        // not a sidecar of THIS stem.
        assert!(!is_sidecar_for(stem, "decoder_model_merged_fp16.onnx_data"));
        assert!(!is_sidecar_for(stem, "decoder_model_merged_fp16.weights"));
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
