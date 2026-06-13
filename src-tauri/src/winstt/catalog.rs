// Source: WinSTT server/src/recorder/domain/catalog.json
//   + server/src/recorder/domain/model_registry.py (ModelCatalog, _GPU_COMPATIBLE_QUANTIZATIONS,
//     _DML_INCOMPATIBLE_FAMILIES, gpu_filter_quantizations)
//   + server/src/recorder/bootstrap.py (_resolve_quantization, _FP16_AUTO_PARAM_THRESHOLD,
//     _INT8_PREFERRED_FAMILIES, _override_dml_to_cpu_for_incompatible_family)
//   + server/src/stt_server/control_handler.py (_effective_quant_for — the picker badge bridge)
//
// This module is DETERMINISTIC DATA + pure resolution logic. It is the Rust port of WinSTT's
// STT model catalog and the per-family precision/EP policy that the picker badge and the ort
// loader must AGREE on. There is no ML here — only a const table and string-state arithmetic —
// so it is written as REAL code with `#[cfg(test)]` unit tests (per slice rules).
//
// INVARIANTS (carried verbatim from WinSTT memory + server source):
//   * `DML_INCOMPATIBLE_FAMILIES` MUST EQUAL `INT8_PREFERRED_FAMILIES`
//     (memory: project_onnx_asr_single_source_of_truth — "invariant == _INT8_PREFERRED_FAMILIES").
//     Both = {NeMo, Cohere, GigaAM, Kaldi, TOne, SenseVoice, Dolphin}.
//   * fp16-auto only fires on CUDA for models with >= 500M params that publish fp16.
//   * On non-CUDA (CPU / DirectML / ROCm / CoreML), int8-preferred families auto-resolve to int8.
//   * On CUDA, sub-fp16 quants (int8/q4/q4f16/bnb4/uint8) are filtered out — they fall back to
//     fp32 compute via QDQ scatter-gather AND per-channel int8 hallucinates (onnxruntime#25489).
//   * Silero VAD is CPU-only (handled in the VAD slice, NOT here — noted for cross-reference).
//   * Canary/Cohere `<|startofcontext|>` prompt slot is UNTRAINED — no initial-prompt bias for
//     them (handled in the engine slice, NOT here — noted for cross-reference).
//
// The const `STT_CATALOG` below has exactly 71 entries (whisper 15, moonshine 10, granite 2,
// nemo 34, kaldi 4, gigaam 2, cohere 1, sense_voice 1, t-one 1, dolphin 1). Every entry is
// preview-capable in WinSTT today; native streaming and final-reuse policy are derived from
// `EngineKind`, not this legacy field.
//
// This module is split into two siblings behind a stable re-export surface:
//   * `data`   — the `ModelEntry` row shape + the verbatim 71-row `STT_CATALOG` const.
//   * `policy` — `Family`/`Accelerator` + the deterministic precision/EP resolution policy.
// Every previously public path (`crate::winstt::catalog::X`) is preserved via the globs below.

mod data;
mod policy;

pub use data::*;
pub use policy::*;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn catalog_total_count_is_71() {
        assert_eq!(
            STT_CATALOG.len(),
            71,
            "catalog.json ships exactly 71 STT models"
        );
    }

    #[test]
    fn per_family_counts_match_catalog_json() {
        let count = |f: Family| STT_CATALOG.iter().filter(|m| m.family == f).count();
        assert_eq!(count(Family::Whisper), 15, "whisper count");
        assert_eq!(count(Family::Moonshine), 10, "moonshine count");
        assert_eq!(count(Family::Nemo), 34, "nemo count");
        assert_eq!(count(Family::Kaldi), 4, "kaldi count");
        assert_eq!(count(Family::GigaAm), 2, "gigaam count");
        assert_eq!(count(Family::Cohere), 1, "cohere count");
        assert_eq!(count(Family::Granite), 2, "granite count");
        assert_eq!(count(Family::SenseVoice), 1, "sense_voice count");
        assert_eq!(count(Family::TOne), 1, "t-one count");
        assert_eq!(count(Family::Dolphin), 1, "dolphin count");
        assert_eq!(
            count(Family::Custom),
            0,
            "custom never appears in the shipped catalog"
        );
        // The nine family counts must sum to the catalog total.
        let summed = 15 + 10 + 34 + 4 + 2 + 1 + 2 + 1 + 1 + 1;
        assert_eq!(summed, STT_CATALOG.len());
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = BTreeSet::new();
        for m in STT_CATALOG {
            assert!(seen.insert(m.id), "duplicate catalog id: {}", m.id);
        }
    }

    #[test]
    fn streaming_latency_rows_remain_distinct() {
        for (alias, canonical) in [
            ("streaming-nemo-ctc-en", "streaming-nemo-ctc-en"),
            ("streaming-nemo-ctc-en-480ms", "streaming-nemo-ctc-en-480ms"),
            (
                "streaming-nemo-ctc-en-80ms-int8",
                "streaming-nemo-ctc-en-80ms-int8",
            ),
            (
                "streaming-nemo-ctc-en-480ms-int8",
                "streaming-nemo-ctc-en-480ms-int8",
            ),
            ("streaming-nemo-rnnt-en", "streaming-nemo-rnnt-en"),
            ("streaming-nemo-rnnt-en-80ms", "streaming-nemo-rnnt-en-80ms"),
            (
                "streaming-nemo-rnnt-en-80ms-int8",
                "streaming-nemo-rnnt-en-80ms-int8",
            ),
            (
                "streaming-nemo-rnnt-en-480ms-int8",
                "streaming-nemo-rnnt-en-480ms-int8",
            ),
            (
                "streaming-parakeet-unified-en-240ms",
                "streaming-parakeet-unified-en-240ms",
            ),
            (
                "streaming-parakeet-unified-en-560ms",
                "streaming-parakeet-unified-en-560ms",
            ),
            (
                "streaming-parakeet-unified-en-240ms-int8",
                "streaming-parakeet-unified-en-240ms-int8",
            ),
            (
                "streaming-parakeet-unified-en-560ms-int8",
                "streaming-parakeet-unified-en-560ms-int8",
            ),
            (
                "streaming-nemotron-en-80ms",
                "streaming-nemotron-en-80ms-int8",
            ),
            (
                "streaming-nemotron-en-160ms",
                "streaming-nemotron-en-160ms-int8",
            ),
            (
                "streaming-nemotron-en-560ms",
                "streaming-nemotron-en-560ms-int8",
            ),
            (
                "streaming-nemotron-en-1120ms",
                "streaming-nemotron-en-1120ms-int8",
            ),
            (
                "streaming-nemotron-en-80ms-int8",
                "streaming-nemotron-en-80ms-int8",
            ),
            (
                "streaming-nemotron-en-160ms-int8",
                "streaming-nemotron-en-160ms-int8",
            ),
            (
                "streaming-nemotron-en-560ms-int8",
                "streaming-nemotron-en-560ms-int8",
            ),
        ] {
            assert_eq!(canonical_model_id(alias), canonical);
            assert_eq!(find(alias).unwrap().id, canonical);
            assert_eq!(find(canonical).unwrap().id, canonical);
        }
    }

    #[test]
    fn display_name_for_id_strips_language_and_streaming_latency() {
        assert_eq!(
            display_name_for_id("streaming-nemo-rnnt-en-80ms-int8"),
            "Streaming NeMo FastConformer RNN-T"
        );
        assert_eq!(
            display_name_for_id("streaming-nemotron-en-1120ms"),
            "Streaming Nemotron"
        );
        assert_eq!(display_name_for_id("tiny.en"), "Whisper Tiny");
    }

    #[test]
    fn every_model_has_a_repo_and_at_least_one_quant() {
        for m in STT_CATALOG {
            assert!(
                !m.onnx_model_name.is_empty(),
                "{} missing onnx_model_name",
                m.id
            );
            let quants = quantizations_for_id(m.id);
            assert!(
                !quants.is_empty(),
                "{} must publish at least one quant",
                m.id
            );
        }
    }

    #[test]
    fn all_shipped_models_are_preview_capable() {
        // WinSTT ships every catalog row with supports_realtime=true as the legacy
        // preview-capable flag. Native streaming is a separate EngineKind capability.
        for m in STT_CATALOG {
            assert!(
                m.supports_realtime,
                "{} unexpectedly not preview-capable",
                m.id
            );
        }
    }

    /// THE LOAD-BEARING INVARIANT: DML_INCOMPATIBLE_FAMILIES == INT8_PREFERRED_FAMILIES.
    /// Memory project_onnx_asr_single_source_of_truth: "invariant == _INT8_PREFERRED_FAMILIES".
    #[test]
    fn dml_incompatible_equals_int8_preferred() {
        let expected = dml_incompatible_int8_preferred_families();
        // Both predicates are backed by the SAME method, so for every family the two flags
        // must agree, and the agreeing set must equal the canonical 7-family set.
        let mut dml = BTreeSet::new();
        let mut int8 = BTreeSet::new();
        for f in [
            Family::Whisper,
            Family::Moonshine,
            Family::Cohere,
            Family::Granite,
            Family::Nemo,
            Family::SenseVoice,
            Family::GigaAm,
            Family::Kaldi,
            Family::TOne,
            Family::Dolphin,
            Family::Custom,
        ] {
            assert_eq!(
                f.is_dml_incompatible(),
                f.prefers_int8_off_cuda(),
                "family {:?}: DML-incompat and int8-preferred must be identical",
                f
            );
            if f.is_dml_incompatible() {
                dml.insert(f);
            }
            if f.prefers_int8_off_cuda() {
                int8.insert(f);
            }
        }
        assert_eq!(
            dml, int8,
            "the two family lists must be byte-identical sets"
        );
        assert_eq!(
            dml, expected,
            "the set must equal the canonical 7-family list"
        );
        assert_eq!(
            dml.len(),
            7,
            "exactly 7 families are DML-incompatible / int8-preferred"
        );
        // Whisper / Moonshine / Custom must NOT be in the set.
        assert!(!dml.contains(&Family::Whisper));
        assert!(!dml.contains(&Family::Moonshine));
        assert!(!dml.contains(&Family::Granite));
        assert!(!dml.contains(&Family::Custom));
    }

    #[test]
    fn family_str_roundtrips() {
        for f in [
            Family::Whisper,
            Family::Moonshine,
            Family::Cohere,
            Family::Granite,
            Family::Nemo,
            Family::SenseVoice,
            Family::GigaAm,
            Family::Kaldi,
            Family::TOne,
            Family::Dolphin,
            Family::Custom,
        ] {
            assert_eq!(Family::from_str(f.as_str()), f, "roundtrip {:?}", f);
        }
        // Unknown slug falls into the permissive Custom bucket.
        assert_eq!(Family::from_str("totally-unknown"), Family::Custom);
        // Exact slug spellings (the wire format) — guard against typos.
        assert_eq!(Family::SenseVoice.as_str(), "sense_voice");
        assert_eq!(Family::TOne.as_str(), "t-one");
        assert_eq!(Family::GigaAm.as_str(), "gigaam");
    }

    #[test]
    fn dolphin_quants_are_int8_only() {
        // catalog.json ships Dolphin with available_quantizations == ["int8"] (default-export
        // int8 DML segfaults; int8 is the only viable build).
        assert_eq!(quantizations_for_id("dolphin-base-ctc"), &["int8"]);
    }

    // ── _resolve_quantization branch coverage ────────────────────────────────────────────

    #[test]
    fn auto_on_cuda_picks_float16_tiers_for_large_models_that_publish_them() {
        // large-v3-turbo: 795M, publishes fp16 -> fp16 on CUDA.
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            Some("fp16")
        );
        // tiny: 37M, publishes fp16 but is BELOW the 500M floor -> fp32 (None).
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
        // large-v3: 1.55B but publishes ONLY "" (no fp16) -> fp32 (None) even though huge.
        let lv3 = find("large-v3").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                lv3.param_count,
                Some(lv3.available_quantizations),
                lv3.family
            ),
            None
        );
        // Granite publishes fp16w rather than fp16, so CUDA auto should still avoid the 15GB fp32
        // tier and choose the float16-weights export.
        let granite = find("granite-speech-4.1-2b").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                granite.param_count,
                Some(granite.available_quantizations),
                granite.family
            ),
            Some("fp16w")
        );
    }

    #[test]
    fn auto_off_cuda_picks_int8_for_int8_preferred_families() {
        // Cohere on DirectML -> int8 (int8-preferred family, publishes "" + fp16 + q4 + q4f16...
        // NOTE: cohere does NOT publish int8 in the catalog, so it must FALL THROUGH to fp32).
        let cohere = find("cohere-transcribe").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                cohere.param_count,
                Some(cohere.available_quantizations),
                cohere.family
            ),
            None,
            "cohere doesn't publish int8 -> auto must not invent it"
        );
        // NeMo Canary 1B v2 on DirectML -> ACCURACY-FIRST: None (the natural fp32 export). int8 IS
        // published but is NOT auto-selected — the user picks it in the picker for speed/size.
        let canary = find("nemo-canary-1b-v2").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                canary.param_count,
                Some(canary.available_quantizations),
                canary.family
            ),
            None
        );
        // Same on plain CPU.
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                canary.param_count,
                Some(canary.available_quantizations),
                canary.family
            ),
            None
        );
        // GigaAM CTC on CPU -> fp32 (None), accuracy-first.
        let giga = find("gigaam-v3-e2e-ctc").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                giga.param_count,
                Some(giga.available_quantizations),
                giga.family
            ),
            None
        );
    }

    #[test]
    fn auto_off_cuda_does_not_int8_whisper_or_moonshine() {
        // Whisper small.en on CPU -> fp32 (not an int8-preferred family).
        let small_en = find("small.en").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                small_en.param_count,
                Some(small_en.available_quantizations),
                small_en.family
            ),
            None
        );
        // Moonshine on DirectML -> fp32 even though it publishes int8 (not int8-preferred family).
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            None
        );
    }

    #[test]
    fn concrete_quant_not_published_falls_back_to_fp32() {
        // Whisper tiny does not publish int8 -> requesting int8 yields fp32 (None), never a
        // ModelFileNotFoundError cascade.
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cpu,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
    }

    #[test]
    fn concrete_sub_fp16_on_cuda_falls_back_to_fp32() {
        // Moonshine publishes int8, but on CUDA sub-fp16 is filtered -> fp32.
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cuda,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            None
        );
        // q4 on CUDA for whisper -> fp32.
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "q4",
                Accelerator::Cuda,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
    }

    #[test]
    fn concrete_quant_passes_through_off_cuda_and_for_fp16_on_cuda() {
        // int8 on CPU for a model that publishes it -> int8 (pass-through).
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cpu,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            Some("int8")
        );
        // fp16 on CUDA -> fp16 (in GPU_COMPATIBLE set; hits the decoder repair path).
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            resolve_quantization(
                "fp16",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            Some("fp16")
        );
    }

    #[test]
    fn effective_quantization_collapses_none_to_empty_string() {
        let tiny = find("tiny").unwrap();
        assert_eq!(
            effective_quantization(
                "auto",
                Accelerator::Cpu,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            ""
        );
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            effective_quantization(
                "auto",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            "fp16"
        );
    }

    #[test]
    fn off_catalog_repo_is_permissive_about_quants() {
        // available=None (off-catalog HF repo) -> any concrete quant passes (the historical
        // assume-it-exists behaviour), and auto on CUDA still respects the param + fp16 gates.
        assert_eq!(
            resolve_quantization("int8", Accelerator::Cpu, 100, None, Family::Custom),
            Some("int8")
        );
        // auto + huge + non-int8-family + off-catalog on CUDA: publishes("fp16") is true when
        // available is None, so fp16 fires.
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                600_000_000,
                None,
                Family::Whisper
            ),
            Some("fp16")
        );
    }

    // ── picker quant filtering ───────────────────────────────────────────────────────────

    #[test]
    fn picker_filters_sub_fp16_only_on_cuda() {
        let moon = find("moonshine-base").unwrap(); // ["","fp16","q4","bnb4","int8","uint8","q4f16"]
                                                    // CUDA: only "" and fp16 survive (order preserved).
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::Cuda),
            vec!["", "fp16"]
        );
        // DirectML: full list kept (model routes to CPU EP, all quants valid).
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::DirectMl),
            vec!["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"]
        );
        // CPU: full list kept.
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::Cpu),
            vec!["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"]
        );
    }

    // ── DML force-CPU decision ───────────────────────────────────────────────────────────

    #[test]
    fn force_cpu_only_for_incompatible_families_on_non_cuda_gpu() {
        // NeMo on DirectML -> force CPU.
        assert!(must_force_cpu(Family::Nemo, Accelerator::DirectMl));
        // NeMo on CUDA -> NOT forced (CUDA is fine).
        assert!(!must_force_cpu(Family::Nemo, Accelerator::Cuda));
        // NeMo on CPU -> already CPU, no override.
        assert!(!must_force_cpu(Family::Nemo, Accelerator::Cpu));
        // Whisper on DirectML -> keeps its GPU EP.
        assert!(!must_force_cpu(Family::Whisper, Accelerator::DirectMl));
        // Moonshine on DirectML -> keeps GPU EP.
        assert!(!must_force_cpu(Family::Moonshine, Accelerator::DirectMl));
        // Dolphin on ROCm -> force CPU.
        assert!(must_force_cpu(Family::Dolphin, Accelerator::Rocm));
        // SenseVoice on CoreML -> force CPU.
        assert!(must_force_cpu(Family::SenseVoice, Accelerator::CoreMl));
    }

    #[test]
    fn initial_prompt_bias_only_for_whisper() {
        assert!(Family::Whisper.supports_initial_prompt_bias());
        // Canary (Nemo) + Cohere context slot is untrained -> no prompt bias.
        assert!(!Family::Nemo.supports_initial_prompt_bias());
        assert!(!Family::Cohere.supports_initial_prompt_bias());
        // Moonshine has no prompt slot.
        assert!(!Family::Moonshine.supports_initial_prompt_bias());
    }
}
