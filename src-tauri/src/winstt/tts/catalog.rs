// TTS model catalog — the single source of truth for the multi-provider TTS
// picker (analogous to winstt/stt/catalog.rs for STT). Each entry carries the
// editorial + technical facets the universal ModelCard renders: engine, voices,
// cloning support, languages, sample rate, size/quant ladder, and quality/speed
// tiers. A `list_tts_models` command projects these into the camelCase wire DTO.
//
// Recipes + ship/skip rationale live in the deep-research report; the working
// engines are in {kokoro,kitten,piper,supertonic}.rs. Cloning engines
// (OuteTTS-0.6B → Chatterbox) are added in Phase 2.

/// Which in-process engine backs a catalog entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsEngineId {
    Kokoro,
    Kitten,
    Piper,
    Supertonic,
    Chatterbox,
    Qwen3Tts,
    Orpheus,
    Spark,
}

impl TtsEngineId {
    pub fn as_str(self) -> &'static str {
        match self {
            TtsEngineId::Kokoro => "kokoro",
            TtsEngineId::Kitten => "kitten",
            TtsEngineId::Piper => "piper",
            TtsEngineId::Supertonic => "supertonic",
            TtsEngineId::Chatterbox => "chatterbox",
            TtsEngineId::Qwen3Tts => "qwen3tts",
            TtsEngineId::Orpheus => "orpheus",
            TtsEngineId::Spark => "spark",
        }
    }
}

/// Voice-cloning capability — three-state (a boolean would lose the transcript
/// distinction the UI must surface).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloningKind {
    /// Fixed preset voices only; no runtime cloning.
    None,
    /// Zero-shot from a reference clip alone (no transcript needed) — e.g. Chatterbox.
    ZeroShotAudio,
    /// Zero-shot from a reference clip PLUS its transcript — e.g. Spark. The UI must
    /// collect the reference text (auto-transcribed with the selected STT model into an
    /// editable field) alongside the clip.
    ZeroShotAudioText,
}

impl CloningKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CloningKind::None => "none",
            CloningKind::ZeroShotAudio => "zero_shot_audio",
            CloningKind::ZeroShotAudioText => "zero_shot_audio_transcript",
        }
    }

    /// True for any runtime-cloning capability (drives the reference-upload UI).
    pub fn supports_cloning(self) -> bool {
        !matches!(self, CloningKind::None)
    }

    /// True when the clone needs the reference transcript (drives the auto-transcribe field).
    pub fn needs_reference_text(self) -> bool {
        matches!(self, CloningKind::ZeroShotAudioText)
    }
}

/// One downloadable precision/quant of a model's weights (TTS ladders are short:
/// most models ship one or two). `size_bytes` is the on-disk total for ALL files
/// of that quant (single-file engines + voices; multi-graph engines summed).
#[derive(Clone, Copy, Debug)]
pub struct TtsQuant {
    pub id: &'static str,
    pub size_bytes: u64,
}

/// A TTS catalog row.
#[derive(Clone, Copy, Debug)]
pub struct TtsModelEntry {
    /// Stable catalog id (also the renderer's selection value).
    pub id: &'static str,
    pub engine: TtsEngineId,
    pub display_name: &'static str,
    pub maker: &'static str,
    /// Hugging Face repo the model files come from (download source).
    pub hf_repo: &'static str,
    /// Languages the model can speak (engine lang codes / ISO).
    pub languages: &'static [&'static str],
    /// Built-in preset voice count (0 when cloning-only).
    pub num_voices: u32,
    pub cloning: CloningKind,
    /// Voice-design capability: the voice is chosen by a natural-language prompt
    /// (stored in `tts.voice`) rather than a preset list. Drives the picker's
    /// VoiceDesign badge + the "Design voice" prompt dialog.
    pub voice_design: bool,
    pub sample_rate: u32,
    /// Parameter count (millions) — drives the RAM/size fit hint.
    pub param_count_m: u32,
    pub quants: &'static [TtsQuant],
    /// Editorial naturalness tier 0..1 (NOT measured; relative guidance for the card).
    pub quality_score: f32,
    /// Speed tier 0..1 (higher = faster; derived from warm CPU RTF on this box).
    pub speed_score: f32,
    pub description: &'static str,
}

impl TtsModelEntry {
    /// Default/smallest usable quant id (first listed).
    pub fn default_quant(&self) -> &'static str {
        self.quants.first().map_or("", |q| q.id)
    }
    pub fn quant(&self, id: &str) -> Option<&TtsQuant> {
        self.quants.iter().find(|q| q.id == id)
    }
}

// ---------------------------------------------------------------------------
// The catalog. Sizes are exact on-disk bytes (from the HF file trees, see the
// research report and upstream HF file trees). speed_score is a relative card
// hint, not a runtime contract.
// ---------------------------------------------------------------------------

pub const TTS_CATALOG: &[TtsModelEntry] = &[
    TtsModelEntry {
        id: "kokoro-82m",
        engine: TtsEngineId::Kokoro,
        display_name: "Kokoro 82M",
        maker: "hexgrad",
        hf_repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
        languages: &[
            "en-us", "en-gb", "es", "fr", "hi", "it", "pt-br", "ja", "cmn",
        ],
        num_voices: 54,
        cloning: CloningKind::None,
        voice_design: false,
        sample_rate: 24_000,
        param_count_m: 82,
        // fp16 graph (163,234,740) + all 54 voice .bin files (28,725,248) — the full
        // voice set ships in the one model download (HF file sizes, verified).
        quants: &[TtsQuant {
            id: "fp16",
            size_bytes: 191_959_988,
        }],
        quality_score: 0.90,
        speed_score: 0.85,
        description: "Best everyday local voice set; natural read-aloud across many languages.",
    },
    // NOTE: `kitten-nano-0.1` was retired — `kitten-nano-0.2` strictly supersedes
    // it (identical size/voices/params/speed, cleaner sound) so listing both read
    // as a duplicate "Kitten TTS Nano" pair. A persisted 0.1 selection is an
    // unknown id and resolves through the engine's default fallback.
    TtsModelEntry {
        id: "kitten-nano-0.2",
        engine: TtsEngineId::Kitten,
        display_name: "Kitten TTS Nano",
        maker: "KittenML",
        hf_repo: "KittenML/kitten-tts-nano-0.2",
        languages: &["en-us"],
        num_voices: 8,
        cloning: CloningKind::None,
        voice_design: false,
        sample_rate: 24_000,
        param_count_m: 15,
        // graph (23,804,156) + voices.npz (10,294) + config.json (177).
        quants: &[TtsQuant {
            id: "fp32",
            size_bytes: 23_814_627,
        }],
        quality_score: 0.46,
        speed_score: 0.85,
        description: "Smallest English voice model; best when disk space matters most.",
    },
    TtsModelEntry {
        id: "piper",
        engine: TtsEngineId::Piper,
        display_name: "Piper (multilingual)",
        maker: "rhasspy",
        hf_repo: "rhasspy/piper-voices",
        // 46 distinct app lang codes across 48 curated voices (one good voice per
        // language-country). Each voice downloads ON-DEMAND when selected.
        languages: &[
            "en-us", "ar-jo", "bg-bg", "ca-es", "cs-cz", "cy-gb", "da-dk", "de-de", "el-gr",
            "en-gb", "es", "eu-es", "fa-ir", "fi-fi", "fr", "hi", "hu-hu", "id-id", "is-is", "it",
            "ka-ge", "kk-kz", "ku-tr", "lb-lu", "lv-lv", "ml-in", "ne-np", "nl-be", "nl-nl",
            "no-no", "pl-pl", "pt-br", "ro-ro", "ru-ru", "sk-sk", "sl-si", "sq-al", "sr-rs",
            "sv-se", "sw-cd", "te-in", "tr-tr", "uk-ua", "ur-pk", "vi-vn", "cmn",
        ],
        num_voices: 48,
        cloning: CloningKind::None,
        voice_design: false,
        sample_rate: 22_050,
        param_count_m: 20,
        // The "model download" is just the DEFAULT voice (en_US-lessac-medium, ~63 MB);
        // the other 47 voices are fetched per-id on first selection (`ensure_voice`),
        // so nothing is bundled and the picker stays small until a language is picked.
        quants: &[TtsQuant {
            id: "medium",
            size_bytes: 63_206_179,
        }],
        quality_score: 0.62,
        speed_score: 0.98,
        description: "Broad language coverage with fast voices that download only when needed.",
    },
    TtsModelEntry {
        id: "supertonic-3",
        engine: TtsEngineId::Supertonic,
        display_name: "Supertonic 3",
        maker: "Supertone",
        hf_repo: "Supertone/supertonic-3",
        languages: &[
            "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi",
            "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv",
            "tr", "uk", "vi",
        ],
        num_voices: 10,
        cloning: CloningKind::None,
        voice_design: false,
        sample_rate: 44_100,
        param_count_m: 100,
        // 4 ONNX graphs + tts/unicode metadata + 10 voice style JSON files.
        quants: &[TtsQuant {
            id: "fp32",
            size_bytes: 401_276_744,
        }],
        quality_score: 0.86,
        speed_score: 0.88,
        description: "High-sample-rate multilingual voices from Supertone's latest release.",
    },
    TtsModelEntry {
        id: "chatterbox-multilingual",
        engine: TtsEngineId::Chatterbox,
        display_name: "Chatterbox (voice cloning)",
        maker: "Resemble AI",
        hf_repo: "onnx-community/chatterbox-multilingual-ONNX",
        languages: &[
            "en", "ar", "da", "de", "el", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms",
            "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
        ],
        num_voices: 1, // ships a bundled default voice (default_voice.wav); also clones from a clip
        cloning: CloningKind::ZeroShotAudio,
        voice_design: false,
        sample_rate: 24_000,
        param_count_m: 500,
        // q4 backbone (354MB) + embed (68MB) + speech_encoder (591MB) + decoder (534MB) ≈ 1.55 GB.
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 1_650_000_000,
        }],
        quality_score: 0.80,
        speed_score: 0.20,
        description: "Clone a voice from a short clip; best for personalized multilingual speech.",
    },
    // Qwen3-TTS Voice Design: no preset voices — the voice is described by a
    // natural-language prompt (stored in `tts.voice`). ONNX weights come from the
    // onnx-community repo under `<quant_subdir>/` (cpu_int4|cpu_fp16|cpu_fp32) at
    // repo ROOT; config/tokenizer come from the separate `Qwen/...VoiceDesign`
    // repo (see PORT_SPEC §1). int4 is first/default (smallest, maintained recipe).
    // Sizes = onnx-for-quant + 4,458,597 (config/tokenizer). quality/speed left at
    // 0.5 (unknown → hidden bar); autoregressive LLM so genuinely slow.
    TtsModelEntry {
        id: "qwen3-tts-1.7b-voicedesign",
        engine: TtsEngineId::Qwen3Tts,
        display_name: "Qwen3-TTS 1.7B Voice Design",
        maker: "Qwen",
        hf_repo: "onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        languages: &["en", "zh", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"],
        num_voices: 0, // no preset voices; voice via prompt
        cloning: CloningKind::None,
        voice_design: true,
        sample_rate: 24_000,
        param_count_m: 1700,
        quants: &[
            TtsQuant {
                id: "int4",
                size_bytes: 1_741_193_994,
            },
            TtsQuant {
                id: "fp16",
                size_bytes: 4_443_562_083,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 8_419_484_234,
            },
        ],
        quality_score: 0.5,
        speed_score: 0.5,
        description: "Multilingual voice-design TTS; describe the voice with a text prompt.",
    },
    // Orpheus — 3B Llama emitting SNAC codec tokens; 8 fine-tuned English voices with inline
    // emotion tags (<laugh>, <sigh>, …). Weights from onnx-community; the SNAC vocoder is a
    // SECOND repo (onnx-community/snac_24khz-ONNX), stitched in the download manifest. CPU-pinned.
    TtsModelEntry {
        id: "orpheus-3b",
        engine: TtsEngineId::Orpheus,
        display_name: "Orpheus 3B",
        maker: "Canopy Labs",
        hf_repo: "onnx-community/orpheus-3b-0.1-ft-ONNX",
        languages: &["en"],
        num_voices: 8,
        cloning: CloningKind::None,
        voice_design: false,
        sample_rate: 24_000,
        param_count_m: 3_000,
        // q4 llm (2,423,656,878) + snac decoder (52,600,822) + tokenizer (15,722,697).
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 2_491_980_397,
        }],
        quality_score: 0.88,
        speed_score: 0.35,
        description: "Expressive English voices with inline emotion tags (laugh, sigh, gasp).",
    },
    // Spark-TTS — Qwen0.5B + BiCodec. Ships voice CREATION now (gender/pitch/speed presets);
    // zero-shot cloning (reference clip + transcript) is a follow-up needing the BiCodec encoder
    // stack. CPU-pinned; must decode greedy (the global-token preamble derails under sampling).
    TtsModelEntry {
        id: "spark-tts-0.5b",
        engine: TtsEngineId::Spark,
        display_name: "Spark-TTS 0.5B",
        maker: "SparkAudio",
        hf_repo: "Fhrozen/Spark-TTS-0.5B-ONNX",
        languages: &["en", "zh"],
        num_voices: 2, // Female / Male preset (generated timbre) for creation mode
        // Zero-shot cloning needs the reference clip's transcript → the UI collects it (auto-
        // transcribed with the selected STT model). Encoder stack from DgDev91/SparkTTS-ONNX.
        cloning: CloningKind::ZeroShotAudioText,
        voice_design: false,
        sample_rate: 16_000,
        param_count_m: 500,
        // Fhrozen q4 LLM + bicodec + tokenizer (1.22 GB) + DgDev91 cloning graphs (wav2vec2 fp16
        // 631M + encoder 122M + speaker 24M + mel 4.5M ≈ 782M).
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 2_001_500_000,
        }],
        quality_score: 0.68,
        speed_score: 0.5,
        description: "Small bilingual (EN/ZH) TTS: pick a gender or clone a voice from a reference clip.",
    },
];

pub fn find(id: &str) -> Option<&'static TtsModelEntry> {
    TTS_CATALOG.iter().find(|m| m.id == id)
}

/// The Kitten ONNX graph filename for a catalog id. Both nano models ship the same
/// `voices.npz` + `config.json`; only the graph file name differs per version.
/// Shared by the TTS download manager (file fetch) and the read-aloud chunk sink
/// (engine load) so the two never drift apart.
pub(crate) fn kitten_model_file(model_id: &str) -> &'static str {
    match model_id {
        "kitten-nano-0.2" => "kitten_tts_nano_v0_2.onnx",
        // nano-0.1 (and any future default) uses the v0.1 graph.
        _ => "kitten_tts_nano_v0_1.onnx",
    }
}

/// The default catalog selection (Kokoro stays the default engine).
pub const DEFAULT_TTS_MODEL_ID: &str = "kokoro-82m";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = TTS_CATALOG.iter().map(|m| m.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate catalog ids");
    }

    #[test]
    fn every_entry_has_a_short_description() {
        for m in TTS_CATALOG {
            let description = m.description.trim();
            assert!(!description.is_empty(), "{} has no description", m.id);
            assert!(description.len() <= 90, "{} description is too long", m.id);
        }
    }

    #[test]
    fn kitten_nano_is_a_single_entry() {
        // 0.2 superseded 0.1; the catalog must list exactly one Kitten Nano model
        // (the retired 0.1 id is gone) so the picker shows no duplicate row.
        let kitten: Vec<&str> = TTS_CATALOG
            .iter()
            .filter(|m| m.engine == TtsEngineId::Kitten)
            .map(|m| m.id)
            .collect();
        assert_eq!(kitten, vec!["kitten-nano-0.2"]);
        assert!(find("kitten-nano-0.1").is_none());
    }

    #[test]
    fn every_entry_has_a_quant_and_find_works() {
        for m in TTS_CATALOG {
            assert!(!m.quants.is_empty(), "{} has no quant", m.id);
            assert!(!m.default_quant().is_empty());
            assert!(find(m.id).is_some());
        }
        assert!(find(DEFAULT_TTS_MODEL_ID).is_some());
    }
}
