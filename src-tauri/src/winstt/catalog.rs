// Source: WinSTT server/src/recorder/domain/catalog.json
//   + server/src/recorder/domain/model_registry.py (ModelCatalog, _GPU_COMPATIBLE_QUANTIZATIONS,
//     _DML_INCOMPATIBLE_FAMILIES, gpu_filter_quantizations)
//   + server/src/recorder/bootstrap.py (_INT8_PREFERRED_FAMILIES — the family classification)
//
// This module is data + the per-family DML/int8 classification and CUDA quant-filter that the
// picker relies on. There is no ML here — only a const table and string-state arithmetic. The
// requested->effective precision resolution the load path AND picker badge use lives in
// `stt::quant_resolve` (the RAM/VRAM fit-aware resolver); the older family-based accuracy-first
// port that once lived here diverged and was removed.
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
// The const `STT_CATALOG` below has exactly 67 entries (whisper 15, moonshine 10, granite 2,
// nemo 27, kaldi 4, gigaam 2, cohere 2, sense_voice 1, t-one 1, dolphin 1, qwen3 2). Every entry is
// preview-capable in WinSTT today; native streaming and final-reuse policy are derived from
// `EngineKind`, not this legacy field.
//
// This module is split into two siblings behind a stable re-export surface:
//   * `data`   — the `ModelEntry` row shape + the verbatim 75-row `STT_CATALOG` const.
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
    fn catalog_total_count_is_69() {
        assert_eq!(
            STT_CATALOG.len(),
            69,
            "catalog.json ships exactly 69 STT models"
        );
    }

    #[test]
    fn per_family_counts_match_catalog_json() {
        let count = |f: Family| STT_CATALOG.iter().filter(|m| m.family == f).count();
        assert_eq!(count(Family::Whisper), 15, "whisper count");
        assert_eq!(count(Family::Moonshine), 10, "moonshine count");
        assert_eq!(count(Family::Nemo), 29, "nemo count");
        assert_eq!(count(Family::Kaldi), 4, "kaldi count");
        assert_eq!(count(Family::GigaAm), 2, "gigaam count");
        assert_eq!(count(Family::Cohere), 2, "cohere count");
        assert_eq!(count(Family::Granite), 2, "granite count");
        assert_eq!(count(Family::SenseVoice), 1, "sense_voice count");
        assert_eq!(count(Family::TOne), 1, "t-one count");
        assert_eq!(count(Family::Dolphin), 1, "dolphin count");
        assert_eq!(count(Family::Qwen3), 2, "qwen3 count");
        assert_eq!(
            count(Family::Custom),
            0,
            "custom never appears in the shipped catalog"
        );
        // The family counts must sum to the catalog total.
        let summed = 15 + 10 + 29 + 4 + 2 + 2 + 2 + 1 + 1 + 1 + 2;
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
                "streaming-nemotron-3.5-multi-1120ms-int8",
                "streaming-nemotron-3.5-multi-1120ms-int8",
            ),
            // The 320/560 ms multilingual rows are SHIPPED latency variants, not deprecated —
            // they must resolve to themselves (never aliased to the 1120 ms bundle).
            (
                "streaming-nemotron-3.5-multi-320ms-int8",
                "streaming-nemotron-3.5-multi-320ms-int8",
            ),
            (
                "streaming-nemotron-3.5-multi-560ms-int8",
                "streaming-nemotron-3.5-multi-560ms-int8",
            ),
        ] {
            assert_eq!(canonical_model_id(alias), canonical);
            assert_eq!(find(alias).unwrap().id, canonical);
            assert_eq!(find(canonical).unwrap().id, canonical);
        }
    }

    #[test]
    fn deleted_english_nemotron_ids_migrate_to_multilingual() {
        for old in [
            "streaming-nemotron-en-80ms",
            "streaming-nemotron-en-1120ms",
            "streaming-nemotron-en-1120ms-int8",
        ] {
            assert_eq!(
                canonical_model_id(old),
                "streaming-nemotron-3.5-multi-1120ms-int8"
            );
            // A persisted old selection resolves to the live replacement row.
            assert_eq!(
                find(old).unwrap().id,
                "streaming-nemotron-3.5-multi-1120ms-int8"
            );
        }
    }

    #[test]
    fn display_name_for_id_strips_language_and_streaming_latency() {
        assert_eq!(
            display_name_for_id("streaming-nemo-rnnt-en-80ms-int8"),
            "Streaming NeMo FastConformer RNN-T"
        );
        assert_eq!(
            display_name_for_id("streaming-nemotron-3.5-multi-1120ms-int8"),
            "Streaming Nemotron 3.5"
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
    /// `is_dml_incompatible` is a thin alias over `is_dml_incompatible_and_int8_preferred`, so this
    /// pins the canonical set the live load path (`stt::quant_resolve`) keys its int8 preference off.
    #[test]
    fn dml_incompatible_family_set_is_canonical() {
        let expected: BTreeSet<Family> = [
            Family::Nemo,
            Family::Cohere,
            Family::GigaAm,
            Family::Kaldi,
            Family::TOne,
            Family::SenseVoice,
            Family::Dolphin,
        ]
        .into_iter()
        .collect();
        let mut dml = BTreeSet::new();
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
            Family::Qwen3,
            Family::Custom,
        ] {
            if f.is_dml_incompatible() {
                dml.insert(f);
            }
        }
        assert_eq!(
            dml, expected,
            "the set must equal the canonical 7-family list"
        );
        assert_eq!(
            dml.len(),
            7,
            "exactly 7 families are DML-incompatible / int8-preferred"
        );
        // Whisper / Moonshine / Granite / Custom must NOT be in the set.
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
            Family::Qwen3,
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
