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
}

impl TtsEngineId {
    pub fn as_str(self) -> &'static str {
        match self {
            TtsEngineId::Kokoro => "kokoro",
            TtsEngineId::Kitten => "kitten",
            TtsEngineId::Piper => "piper",
            TtsEngineId::Supertonic => "supertonic",
            TtsEngineId::Chatterbox => "chatterbox",
        }
    }
}

/// Voice-cloning capability — three-state (a boolean would lose the transcript
/// distinction the UI must surface).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloningKind {
    /// Fixed preset voices only; no runtime cloning.
    None,
    /// Zero-shot from a reference clip alone.
    ZeroShotAudio,
}

impl CloningKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CloningKind::None => "none",
            CloningKind::ZeroShotAudio => "zero_shot_audio",
        }
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
        self.quants.first().map(|q| q.id).unwrap_or("")
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
];

pub fn find(id: &str) -> Option<&'static TtsModelEntry> {
    TTS_CATALOG.iter().find(|m| m.id == id)
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
