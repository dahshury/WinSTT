// The static STT catalog: the `ModelEntry` row shape + the verbatim 70-row `STT_CATALOG`
// const ported from `catalog.json`. Pure data, no policy. The precision/EP resolution policy
// that consumes these rows lives in the sibling `policy` module.

use super::policy::Family;

/// One catalog row. The Rust analogue of WinSTT's `ModelInfo` (the slice subset the engine +
/// picker policy actually need; editorial fields like `wer`/`rtfx`/`size_bytes_by_quantization`
/// live in the picker payload and are intentionally NOT modeled here to keep this table a
/// load-bearing engine table rather than a UI mirror).
#[derive(Debug, Clone, Copy)]
pub struct ModelEntry {
    /// Stable catalog id (e.g. `"tiny"`, `"nemo-canary-1b-v2"`, `"alphacep/vosk-model-ru"`).
    pub id: &'static str,
    /// Human-facing label.
    pub display_name: &'static str,
    pub family: Family,
    /// HuggingFace repo id OR a bare onnx-asr alias (Moonshine/NeMo/GigaAM/etc. use aliases;
    /// Whisper/Cohere/SenseVoice/Kaldi-Vosk use slashed HF repos). The onnx-asr resolver is the
    /// single source of truth for which files this maps to.
    pub onnx_model_name: &'static str,
    /// ONNX quantization suffixes the upstream repo actually ships. The empty string `""` is the
    /// default (un-suffixed fp32) export. Order is preserved from `catalog.json`.
    pub available_quantizations: &'static [&'static str],
    /// Approximate parameter count. Drives the fp16-auto threshold (>= 500M) and the
    /// hardware-fitness estimate. `0` means "unknown" (custom models).
    pub param_count: u64,
    /// `true` for every shipped catalog entry today (kept per-row so it can diverge later).
    pub supports_realtime: bool,
}

/// The full STT catalog: 75 shipped models. Verbatim from `catalog.json` (id / display_name /
/// family / onnx_model_name / available_quantizations / param_count / supports_realtime).
///
/// Counts (asserted in tests): whisper 16, moonshine 10, nemo 29, kaldi 5, gigaam 2,
/// cohere 2, granite 2, sense_voice 1, t-one 1, dolphin 1, qwen3 2, vibevoice 1, audio8 3.
pub const STT_CATALOG: &[ModelEntry] = &[
    // ── Whisper family (15) ──────────────────────────────────────────────────────────────
    ModelEntry {
        id: "tiny",
        display_name: "Whisper Tiny",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-tiny",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 37_760_640,
        supports_realtime: true,
    },
    ModelEntry {
        id: "base",
        display_name: "Whisper Base",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-base",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 72_593_920,
        supports_realtime: true,
    },
    ModelEntry {
        id: "small",
        display_name: "Whisper Small",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-small",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 241_734_912,
        supports_realtime: true,
    },
    ModelEntry {
        id: "medium",
        display_name: "Whisper Medium",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-medium",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 769_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "large-v3",
        display_name: "Whisper Large v3",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-large-v3",
        available_quantizations: &[""],
        param_count: 1_550_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "large-v3-turbo",
        display_name: "Whisper Large v3 Turbo",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-large-v3-turbo",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 795_766_657,
        supports_realtime: true,
    },
    ModelEntry {
        id: "tiny.en",
        display_name: "Whisper Tiny (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-tiny.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 37_760_256,
        supports_realtime: true,
    },
    ModelEntry {
        id: "base.en",
        display_name: "Whisper Base (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-base.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 74_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "small.en",
        display_name: "Whisper Small (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-small.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 244_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "medium.en",
        display_name: "Whisper Medium (EN)",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-medium.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 769_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "breeze-asr-25",
        display_name: "Breeze ASR 25",
        family: Family::Whisper,
        onnx_model_name: "xeonchen/Breeze-ASR-25-ONNX",
        available_quantizations: &[""],
        param_count: 1_545_107_214,
        supports_realtime: true,
    },
    ModelEntry {
        id: "crisper-whisper",
        display_name: "CrisperWhisper 2.0",
        family: Family::Whisper,
        // nyralabs/CrisperWhisper2.0_large converted to ONNX (Masterx re-export, Nyra
        // non-commercial research license carried in-repo). Replaces the v1
        // onnx-community/CrisperWhisper-ONNX export (truncated vocab, en+de only).
        onnx_model_name: "Masterx/CrisperWhisper2.0-large-ONNX",
        available_quantizations: &["", "fp16", "q4"],
        param_count: 1_543_344_640,
        supports_realtime: true,
    },
    ModelEntry {
        id: "crisper-whisper-turbo",
        display_name: "CrisperWhisper 2.0 Turbo",
        family: Family::Whisper,
        // nyralabs/CrisperWhisper2.0_turbo (large-v3-turbo family: 128 mel, 4 decoder
        // layers) converted to ONNX — same Masterx re-export + Nyra license as the large.
        onnx_model_name: "Masterx/CrisperWhisper2.0-turbo-ONNX",
        available_quantizations: &["", "fp16", "q4"],
        param_count: 808_917_760,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo",
        display_name: "Lite-Whisper Large v3 Turbo",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 534_359_083,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo-acc",
        display_name: "Lite-Whisper Large v3 Turbo (Accurate)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 581_299_243,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo-fast",
        display_name: "Lite-Whisper Large v3 Turbo (Fast)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-fast-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 473_840_689,
        supports_realtime: true,
    },
    // ── Moonshine family (10) ────────────────────────────────────────────────────────────
    ModelEntry {
        id: "moonshine-tiny",
        display_name: "Moonshine Tiny",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base",
        display_name: "Moonshine Base",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-ko",
        display_name: "Moonshine Tiny (KO)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-ko",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-ar",
        display_name: "Moonshine Tiny (AR)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-ar",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-vi",
        display_name: "Moonshine Tiny (VI)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-vi",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-zh",
        display_name: "Moonshine Base (ZH)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-zh",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-ja",
        display_name: "Moonshine Base (JA)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-ja",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-ko",
        display_name: "Moonshine Base (KO)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-ko",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-uk",
        display_name: "Moonshine Tiny (UK)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-uk",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_600_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-fr",
        display_name: "Moonshine Tiny (FR)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-fr",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_600_000,
        supports_realtime: true,
    },
    // ── Cohere family (2) ────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "cohere-transcribe",
        display_name: "Cohere Transcribe",
        family: Family::Cohere,
        // Masterx hosts the DirectML-safe re-export of the onnx-community weights: the stock decoders
        // fuse attention into `MultiHeadAttention` (cross-attn form CRASHES the DML kernel) +
        // `GroupQueryAttention` (DML silently drops its attention_bias input → garbled decode), gated
        // by two `If` nodes (a CPU-only op → per-token GPU↔CPU sync). The Masterx decoders are the
        // SAME weights with the attention decomposed to plain ops and the `If`s flattened (branchless
        // cross-KV recompute, same layout as the Arabic export): CPU bit-parity, and
        // `cohere_export_dml_safe` restores the DirectML EP (66 s clip: 14 s DML vs 21-29 s CPU).
        // Encoders + all weight sidecars are byte-identical to onnx-community's.
        onnx_model_name: "Masterx/cohere-transcribe-03-2026-ONNX",
        available_quantizations: &["", "fp16", "int8", "q4", "q4f16"],
        param_count: 2_000_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "cohere-transcribe-arabic",
        display_name: "Cohere Transcribe Arabic",
        family: Family::Cohere,
        // Same CohereAsr architecture as cohere-transcribe (48-layer Conformer encoder + 8-layer
        // merged-KV decoder), Arabic + English specialised weights. ONNX export in the onnx-community
        // merged layout; runs through the existing CohereEngine unchanged.
        onnx_model_name: "Masterx/cohere-transcribe-arabic-07-2026-ONNX",
        // fp32 (best accuracy) + fp16 (fp32-parity transcripts, ~3.5× faster wall than fp32 on
        // DirectML — encoder halves; ~4.6 GB vs 8.3 GB; added 2026-07-11) + int8 (8-bit, ~2.1 GB).
        // q4 is DROPPED for this checkpoint: its export is actually LARGER than int8 (2.22 GB vs
        // 2.14 GB, the Conformer encoder barely shrinks under 4-bit) AND less accurate, so int8
        // strictly dominates it — there is no configuration where q4 wins. (The multilingual
        // `cohere-transcribe` KEEPS q4: there its export IS ~1 GB smaller than int8, a real tradeoff.)
        // q4f16 is omitted (MatMulNBits dequant overhead loses on DML; CPU up-casts fp16-compute).
        // Auto stays accuracy-first fp32; fp16 auto-promotes on CUDA only (policy.rs) — the picker
        // exposes it everywhere. The 7.6 GB fp32 encoder needed HF `lfs-enable-largefiles` (>5 GB).
        available_quantizations: &["", "fp16", "int8"],
        param_count: 2_000_000_000,
        supports_realtime: true,
    },
    // ── Granite family (2) ───────────────────────────────────────────────────────────────
    ModelEntry {
        id: "granite-speech-4.1-2b-plus",
        display_name: "Granite Speech 4.1 2B Plus",
        family: Family::Granite,
        onnx_model_name: "smcleod/ibm-granite-speech-4.1-2b-plus-onnx",
        available_quantizations: &["", "int8", "fp16w"],
        param_count: 2_000_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "granite-speech-4.1-2b-nar",
        display_name: "Granite Speech 4.1 2B NAR",
        family: Family::Granite,
        onnx_model_name: "smcleod/ibm-granite-speech-4.1-2b-nar-onnx",
        available_quantizations: &["", "int8", "fp16w"],
        param_count: 2_000_000_000,
        supports_realtime: true,
    },
    // ── Qwen3-ASR family (2) ─────────────────────────────────────────────────────────────
    // Qwen3 LLM decoder + Whisper-style audio encoder. The fp default export is 4–10 GB, so only
    // the int4 weight-quantized variant (`*.int4.onnx` + `decoder_weights.int4.data`) is shipped.
    ModelEntry {
        id: "qwen3-asr-0.6b",
        display_name: "Qwen3-ASR 0.6B",
        family: Family::Qwen3,
        onnx_model_name: "andrewleech/qwen3-asr-0.6b-onnx",
        available_quantizations: &["int4"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "qwen3-asr-1.7b",
        display_name: "Qwen3-ASR 1.7B",
        family: Family::Qwen3,
        onnx_model_name: "andrewleech/qwen3-asr-1.7b-onnx",
        available_quantizations: &["int4"],
        param_count: 1_700_000_000,
        supports_realtime: true,
    },
    // ── VibeVoice family (1) ─────────────────────────────────────────────────────────────
    // Microsoft VibeVoice-ASR-BitNet: dual ConvNeXt tokenizer (raw 24 kHz) + QAT-ternary
    // Qwen2.5-1.5B decoder. The int4 tier stores the deployed ternary weights EXACTLY
    // (surgical MatMulNBits: q = w/s + 8 ∈ {7,8,9}, validated token-EXACT vs the transformers
    // reference), so it is the native/default precision; fp16 is the same weights unpacked
    // (also token-EXACT), fp32 the parity-reference tier. NO int8 tier: dynamic-activation int8
    // measurably degraded transcripts while being LARGER than the exact int4 — shipping it
    // would only bait the auto-quant picker into a strictly-worse choice.
    ModelEntry {
        id: "vibevoice-asr-bitnet",
        display_name: "VibeVoice-ASR BitNet",
        family: Family::VibeVoice,
        onnx_model_name: "Masterx/vibevoice-asr-bitnet-onnx",
        available_quantizations: &["", "fp16", "int4"],
        param_count: 2_300_000_000,
        supports_realtime: true,
    },
    // ── Audio8 family (1) ────────────────────────────────────────────────────────────────
    // Audio8-ASR-0.1B (`arkasr`): Qwen3-ASR audio tower + MLP adapter over a 0.1 B 8-layer
    // Qwen-style decoder — 0.32 B end-to-end, one of the smallest usable LLM-era ASR models.
    // The bundle quantizes the tower and the LM independently: `""` is the all-fp32 tier, `int8`
    // pairs the int8 tower with the int8 LM, and `int4` keeps that same int8 tower (the bundle
    // ships no int4 tower) with the int4 LM. LICENSE: CC-BY-NC-4.0 — non-commercial only, same
    // posture as the Cohere ASR rows (see THIRD_PARTY_NOTICES.md).
    ModelEntry {
        id: "audio8-asr-0.1b",
        display_name: "Audio8-ASR 0.1B",
        family: Family::Audio8,
        onnx_model_name: "Audio8/Audio8-ASR-0.1B-onnx-runtime",
        available_quantizations: &["", "int8", "int4"],
        param_count: 323_990_528,
        supports_realtime: true,
    },
    // ARK-ASR 0.6B — the same `arkasr` architecture scaled up (Whisper-large encoder + 0.6 B Qwen
    // decoder, ~1.3 B end-to-end) and the same maker, but a DIFFERENT ONNX packaging, so it runs on
    // `EngineKind::ArkAsr` rather than `Audio8Asr` (the id, not the family, selects the engine —
    // see `cache_probe::engine_kind_for`). Apache-2.0, unlike the NC 0.1 B. The published export
    // ships exactly one precision: int8 graphs with an fp32 embedding blob.
    ModelEntry {
        id: "ark-asr-0.6b",
        display_name: "ARK-ASR 0.6B",
        family: Family::Audio8,
        onnx_model_name: "Audio8/ark-asr-0.6b-int8-onnx",
        available_quantizations: &["int8"],
        param_count: 1_299_510_340,
        supports_realtime: true,
    },
    // ARK-ASR 3B — the same `arkasr` architecture again (Whisper-large encoder + 3 B Qwen decoder,
    // ~4.06 B end-to-end) and the same `EngineKind::ArkAsr` graph contract. Upstream publishes
    // safetensors only, so this row points at OUR int8 ONNX export; it was produced to be a
    // byte-compatible clone of the 0.6 B layout, which is why it needs no engine change. Its
    // static cache is 1024 positions (not the 0.6 B's 2048) — 36 layers make a longer cache
    // expensive to re-feed per token. Apache-2.0, inherited from the source checkpoint.
    ModelEntry {
        id: "ark-asr-3b",
        display_name: "ARK-ASR 3B",
        family: Family::Audio8,
        onnx_model_name: "Masterx/ark-asr-3b-onnx",
        // TWO tiers, and int4 is NOT the fast one: measured on CPU, int4 (MatMulNBits, dequantized
        // on the fly) runs ~50% SLOWER than int8 (MatMulInteger GEMM) at this size — the opposite
        // of the 0.1B, where int4 wins. So int8 is the speed tier and int4 is purely the
        // small-disk tier (2.95 GB vs 4.40 GB).
        available_quantizations: &["int8", "int4"],
        param_count: 4_063_494_332,
        supports_realtime: true,
    },
    // ── SenseVoice family (1) ────────────────────────────────────────────────────────────
    ModelEntry {
        id: "sense-voice-small",
        display_name: "SenseVoice Small",
        family: Family::SenseVoice,
        onnx_model_name: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        available_quantizations: &["", "int8"],
        param_count: 234_000_000,
        supports_realtime: true,
    },
    // ── NeMo family + native streaming rows ───────────────────────────────────────────────
    ModelEntry {
        id: "nemo-parakeet-ctc-0.6b",
        display_name: "NeMo Parakeet CTC 0.6B",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-ctc-0.6b",
        // NO fp16: the v1-era export converts (CPU-correct) but produces garbage on the DML EP
        // at fp16 (the lite-whisper disease); fp16-on-CPU is pointless. tdt-v3 carries fp16.
        available_quantizations: &["", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-parakeet-rnnt-0.6b",
        display_name: "NeMo Parakeet RNNT 0.6B",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-rnnt-0.6b",
        // NO fp16: the v1-era export converts (CPU-correct) but produces garbage on the DML EP
        // at fp16 (the lite-whisper disease); fp16-on-CPU is pointless. tdt-v3 carries fp16.
        available_quantizations: &["", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-parakeet-tdt-0.6b-v3",
        display_name: "NeMo Parakeet TDT 0.6B v3",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-tdt-0.6b-v3",
        // fp16 = Masterx/parakeet-tdt-0.6b-v3-fp16-onnx (QUANT_REPO_OVERRIDES). Measured
        // 2026-07-11: 231 ms vs fp32 459 ms on DirectML (66 s clip), transcripts byte-identical.
        available_quantizations: &["", "fp16", "int8"],
        param_count: 626_983_558,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-1b-v2",
        display_name: "NeMo Canary 1B v2",
        family: Family::Nemo,
        // DirectML-safe re-export (encoder via `dynamo=False`); see nemo-canary-180m-flash.
        // fp16 = fp16 ENCODER only (same repo); the CPU-pinned KV decoders stay fp32 (globs).
        onnx_model_name: "Masterx/canary-1b-v2-onnx",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 978_000_000,
        supports_realtime: true,
    },
    // ── Native streaming (sherpa-format exports on WinSTT ORT; cache-aware chunked). The id contains
    //    "streaming" so `engine_kind_for` routes to the *Streaming EngineKind. ──
    ModelEntry {
        id: "streaming-zipformer-en",
        display_name: "Streaming Zipformer (English)",
        family: Family::Kaldi,
        onnx_model_name: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        available_quantizations: &["", "int8"],
        param_count: 66_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en",
        display_name: "Streaming NeMo FastConformer CTC 80ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en",
        display_name: "Streaming NeMo FastConformer RNN-T 480ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en-480ms",
        display_name: "Streaming NeMo FastConformer CTC 480ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-480ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en-1040ms",
        display_name: "Streaming NeMo FastConformer CTC 1040ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-1040ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en-80ms-int8",
        display_name: "Streaming NeMo FastConformer CTC (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en-480ms-int8",
        display_name: "Streaming NeMo FastConformer CTC 480ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-480ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en-1040ms-int8",
        display_name: "Streaming NeMo FastConformer CTC 1040ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-1040ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en-80ms",
        display_name: "Streaming NeMo FastConformer RNN-T 80ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en-1040ms",
        display_name: "Streaming NeMo FastConformer RNN-T 1040ms (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-1040ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en-80ms-int8",
        display_name: "Streaming NeMo FastConformer RNN-T (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en-480ms-int8",
        display_name: "Streaming NeMo FastConformer RNN-T 480ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en-1040ms-int8",
        display_name: "Streaming NeMo FastConformer RNN-T 1040ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-1040ms-int8",
        available_quantizations: &["int8"],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-240ms",
        display_name: "Streaming Parakeet Unified 240ms (English)",
        family: Family::Nemo,
        // fp16 = Masterx conversion of this repo's graphs (QUANT_REPO_OVERRIDES) — the sherpa
        // maintainer publishes fp32 and int8 as separate repos, no fp16. Same NemoRnntStreaming
        // engine + all-DML float policy as nemotron (whose fp16 measured 2.14× fp32 on DirectML).
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-streaming-240ms",
        available_quantizations: &["", "fp16"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-560ms",
        display_name: "Streaming Parakeet Unified 560ms (English)",
        family: Family::Nemo,
        // fp16 via QUANT_REPO_OVERRIDES (see the 240ms row).
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-streaming-560ms",
        available_quantizations: &["", "fp16"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-1120ms",
        display_name: "Streaming Parakeet Unified 1120ms (English)",
        family: Family::Nemo,
        // fp16 via QUANT_REPO_OVERRIDES (see the 240ms row).
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-streaming-1120ms",
        available_quantizations: &["", "fp16"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-240ms-int8",
        display_name: "Streaming Parakeet Unified (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-240ms",
        available_quantizations: &["int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-560ms-int8",
        display_name: "Streaming Parakeet Unified 560ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms",
        available_quantizations: &["int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-parakeet-unified-en-1120ms-int8",
        display_name: "Streaming Parakeet Unified 1120ms INT8 (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-1120ms",
        available_quantizations: &["int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        // Nemotron-3.5: multilingual (100+ langs) cache-aware streaming RNN-T. SUPERSEDES the
        // English-only Nemotron (2026-04-25). Same sherpa encoder/decoder/joiner layout, plus a 6th
        // `prompt_index` encoder input for language selection (bound by the NemoRnntStreaming engine
        // to the metadata `auto_prompt_id` = auto-detect, or a user-picked language via the realtime
        // language picker + the encoder's `prompt_dictionary`). The sherpa maintainer publishes this
        // model int8-only (no fp32 export); 1120 ms matches the English Nemotron's canonical latency.
        id: "streaming-nemotron-3.5-multi-1120ms-int8",
        display_name: "Streaming Nemotron 3.5 1120ms (Multilingual)",
        family: Family::Nemo,
        // Masterx repo ships fp32 (encoder.onnx + encoder.data), fp16, and int8, self-exported
        // from nvidia/nemotron-3.5-asr-streaming-0.6b via sherpa-onnx's export_onnx.py (the
        // upstream csukuangfj2 package is int8-only). fp32 is the higher-accuracy default; fp16
        // measured 2026-07-11 at 2.14× fp32 on DirectML (66 s clip 1.90 s vs 4.07 s, encoder
        // 22 vs 51 ms/chunk) with an IDENTICAL transcript, at half the download.
        onnx_model_name: "Masterx/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-1120ms-2026-06-11",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        // Lower-latency siblings of the 1120 ms Nemotron above, same nvidia checkpoint re-exported
        // at att_context_size [56, 3] (320 ms) / [56, 6] (560 ms) via sherpa-onnx's export_onnx.py.
        // The three latencies collapse into one realtime card whose LatencyShelf lets the user pick
        // 320/560/1120 ms; each ships fp32 (encoder.onnx + encoder.data), fp16, and int8.
        id: "streaming-nemotron-3.5-multi-320ms-int8",
        display_name: "Streaming Nemotron 3.5 320ms (Multilingual)",
        family: Family::Nemo,
        onnx_model_name: "Masterx/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-2026-06-11",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemotron-3.5-multi-560ms-int8",
        display_name: "Streaming Nemotron 3.5 560ms (Multilingual)",
        family: Family::Nemo,
        onnx_model_name: "Masterx/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-2026-06-11",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-180m-flash",
        display_name: "NeMo Canary 180M Flash",
        family: Family::Nemo,
        // Masterx hosts a DirectML-safe re-export: istupakov's encoder is a torch-DYNAMO export that
        // traps the DML EP (dynamic shapes crash the Reshape/attention kernels; static shapes fail
        // `InferAndVerifyOutputSizes` — unfixed upstream #26826/#26944). The Masterx encoder is the
        // SAME weights re-exported via `torch.onnx.export(dynamo=False)` (parakeet's DML-safe idiom;
        // CPU-parity ~4e-6); the decoder is byte-for-byte istupakov's. Runs on DML ~2× faster than CPU.
        // fp16 = fp16 ENCODER only (same repo); the CPU-pinned KV decoders stay fp32 (globs).
        onnx_model_name: "Masterx/canary-180m-flash-onnx",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 194_168_492,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-1b-flash",
        display_name: "NeMo Canary 1B Flash",
        family: Family::Nemo,
        // DirectML-safe re-export (encoder via `dynamo=False`); see nemo-canary-180m-flash.
        // fp16 = fp16 ENCODER only (same repo); the CPU-pinned KV decoders stay fp32 (globs).
        onnx_model_name: "Masterx/canary-1b-flash-onnx",
        available_quantizations: &["", "fp16", "int8"],
        param_count: 883_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-fastconformer-ru-ctc",
        display_name: "NeMo FastConformer RU CTC",
        family: Family::Nemo,
        onnx_model_name: "nemo-fastconformer-ru-ctc",
        available_quantizations: &["", "int8"],
        param_count: 109_270_705,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-fastconformer-ru-rnnt",
        display_name: "NeMo FastConformer RU RNNT",
        family: Family::Nemo,
        onnx_model_name: "nemo-fastconformer-ru-rnnt",
        available_quantizations: &["", "int8"],
        param_count: 114_078_382,
        supports_realtime: true,
    },
    // ── GigaAM family (2) ────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "gigaam-v3-e2e-ctc",
        display_name: "GigaAM v3 E2E CTC",
        family: Family::GigaAm,
        onnx_model_name: "gigaam-v3-e2e-ctc",
        available_quantizations: &["", "int8"],
        param_count: 243_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "gigaam-v3-e2e-rnnt",
        display_name: "GigaAM v3 E2E RNNT",
        family: Family::GigaAm,
        onnx_model_name: "gigaam-v3-e2e-rnnt",
        available_quantizations: &["", "int8"],
        param_count: 243_000_000,
        supports_realtime: true,
    },
    // ── Kaldi family (4 offline) — Vosk + Zipformer ──────────────────────────────────────
    // NOTE: Kaldi/Vosk uses the `.` quant separator (`encoder.int8.onnx`) vs onnx-community's
    // `_` separator — handled in the model-cache / file-resolution slice, NOT here.
    ModelEntry {
        id: "alphacep/vosk-model-ru",
        display_name: "Vosk Russian",
        family: Family::Kaldi,
        onnx_model_name: "alphacep/vosk-model-ru",
        available_quantizations: &["", "int8"],
        param_count: 65_016_922,
        supports_realtime: true,
    },
    ModelEntry {
        id: "alphacep/vosk-model-small-ru",
        display_name: "Vosk Russian (Small)",
        family: Family::Kaldi,
        onnx_model_name: "alphacep/vosk-model-small-ru",
        available_quantizations: &["", "int8"],
        param_count: 22_986_644,
        supports_realtime: true,
    },
    ModelEntry {
        id: "zipformer-en",
        display_name: "Zipformer English",
        family: Family::Kaldi,
        onnx_model_name: "zipformer-en",
        available_quantizations: &["", "int8"],
        param_count: 70_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "zipformer-ar-ctc",
        display_name: "Zipformer Arabic Phonemes",
        family: Family::Kaldi,
        // icefall zipformer CTC single-graph export (NOT the transducer layout): the id's "ctc"
        // routes `engine_kind_for` to `KaldiCtc`. GATED repo (free-non-commercial license) —
        // downloads need an HF token (`HF_TOKEN` env or `$HF_HOME/token`, picked up by hf-hub).
        // Emits Quranic-Arabic PHONEME units (tajweed grading), not orthographic text.
        onnx_model_name: "Muno459/zipformer_p-arabic-v2",
        available_quantizations: &["", "int8"],
        param_count: 65_700_000,
        supports_realtime: true,
    },
    // ── T-One family (1) ─────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "t-tech/t-one",
        display_name: "T-One",
        family: Family::TOne,
        onnx_model_name: "t-tech/t-one",
        available_quantizations: &[""],
        param_count: 71_697_827,
        supports_realtime: true,
    },
    // ── Dolphin family (1) ───────────────────────────────────────────────────────────────
    ModelEntry {
        id: "dolphin-base-ctc",
        display_name: "Dolphin Base CTC",
        family: Family::Dolphin,
        onnx_model_name: "dolphin-base-ctc",
        // int8-only: Dolphin's default-export int8 graph is the only viable build (the fp32
        // default-export int8 DML segfaults — memory project_onnx_asr_single_source_of_truth).
        available_quantizations: &["int8"],
        param_count: 140_000_000,
        supports_realtime: true,
    },
];
