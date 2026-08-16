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
    NeuTts,
    OmniVoice,
    Audio8,
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
            TtsEngineId::NeuTts => "neutts",
            TtsEngineId::OmniVoice => "omnivoice",
            TtsEngineId::Audio8 => "audio8",
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

/// Inline paralinguistic-tag syntax. TWO INCOMPATIBLE SYNTAXES ship in this
/// catalog — `orpheus-3b` emits `<laugh>`, `chatterbox-turbo` emits `[laugh]` —
/// so no call site may hardcode brackets: read the syntax off the row and wrap
/// with [`TagSyntax::wrap`]. A third style is then a one-variant addition.
///
/// Wire form (`snake_case`, via serde + specta): `"none" | "angle" | "square"`.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum TagSyntax {
    /// The model has no inline tag vocabulary; tags would be read aloud literally.
    #[default]
    None,
    /// `<laugh>` — Orpheus.
    Angle,
    /// `[laugh]` — Chatterbox Turbo.
    Square,
}

impl TagSyntax {
    pub fn as_str(self) -> &'static str {
        match self {
            TagSyntax::None => "none",
            TagSyntax::Angle => "angle",
            TagSyntax::Square => "square",
        }
    }

    /// The delimiter pair, or `None` when the model supports no tags.
    pub fn delimiters(self) -> Option<(char, char)> {
        match self {
            TagSyntax::None => None,
            TagSyntax::Angle => Some(('<', '>')),
            TagSyntax::Square => Some(('[', ']')),
        }
    }

    /// Render a BARE tag name (`laugh`) in this model's syntax (`<laugh>`).
    /// Returns the bare name unchanged when the model supports no tags.
    pub fn wrap(self, tag: &str) -> String {
        match self.delimiters() {
            Some((open, close)) => format!("{open}{tag}{close}"),
            None => tag.to_string(),
        }
    }
}

/// Product cap on the voice-design instruct, in characters.
///
/// NOT model-imposed: the talker's `max_position_embeddings` is 32768 and the
/// instruct is merely tokenized and prepended to the prefill, so extra length
/// only costs prefill time (a ~310-char prompt was verified working). The cap
/// exists so the field stays a *voice description* rather than a script, and so
/// the LLM-authoring command has a budget to aim at. Defined ONCE here and
/// carried to the renderer on the catalog row — never re-typed as a literal.
pub const VOICE_DESIGN_PROMPT_MAX_CHARS: u32 = 300;

/// DEFAULT cap on a cloning reference clip, in seconds — what a row gets when its
/// engine's cost grows no worse than linearly in clip length.
///
/// NOT a global ceiling: the effective cap is the row's
/// [`TtsModelEntry::max_ref_clip_secs`], and at least one engine (OmniVoice, see
/// [`OMNIVOICE_MAX_CLONE_REF_SECS`]) needs a much tighter one. Resolve it through
/// [`reference_clip_cap_secs`] rather than reading this constant, or a row with a
/// tighter cap silently gets 30 s.
///
/// No engine in this tree enforces a length: Chatterbox feeds the whole clip to
/// `speech_encoder` and Spark feeds the whole clip to wav2vec2 (whose attention
/// is quadratic in clip length, and whose semantic tokens are then prepended to
/// EVERY sentence's prompt). So the honest statement is "unconstrained in our
/// code", and 30 s is an editorial choice: it is the value already shipping for
/// Spark, it is past the point where more reference audio measurably improves
/// zero-shot timbre, and it keeps the per-sentence prefill bounded.
pub const MAX_CLONE_REF_SECS: u32 = 30;

/// OmniVoice's own, much tighter cap — the one row where the shared 30 s is not a
/// bounded prefill but an unusable engine.
///
/// MEASURED (`examples/omnivoice_step_probe.rs`, i9-12900KF, warm, fp32 CPU EP):
/// the masked-refinement step is O(num_step * L^2) and L INCLUDES the reference
/// frames, so a reference taxes EVERY sentence of the whole read, permanently.
/// Warm RTF is 3.37x with no reference, **6.45x at 3 s**, 13.70x at 10 s and
/// 17.04x at 12.5 s; extrapolating the same fit to the 30 s ceiling gives ~34x,
/// i.e. half a minute of speech per second of audio.
///
/// 5 s interpolates to ~8x — where this row's `speed_score` (0.08) already sits on
/// the shared log-RTF scale, between qwen3-tts-0.6b (6.3x → 0.10) and orpheus-3b
/// (24x → 0.03) — while still giving the clone nearly double the 3 s reference the
/// port was gated on. Clips longer than the cap are TRIMMED, not rejected, so this
/// costs a long upload nothing but the tail.
pub const OMNIVOICE_MAX_CLONE_REF_SECS: u32 = 5;

/// The reference-clip cap for a catalog id, in seconds.
///
/// THE resolver for the cloning flow: clip preparation, the per-engine trim and the
/// UI hint must all measure a clip against the same number, and that number is
/// per row (OmniVoice is 6x tighter than everything else). An id that does not
/// clone — or is not in the catalog at all — falls back to [`MAX_CLONE_REF_SECS`]
/// rather than `0`, because a clip can legitimately be prepared before the cloning
/// model is selected and `0` there would read as "no cap".
pub fn reference_clip_cap_secs(model_id: &str) -> u32 {
    find(model_id)
        .map(|m| m.max_ref_clip_secs)
        .filter(|secs| *secs > 0)
        .unwrap_or(MAX_CLONE_REF_SECS)
}

/// Floor for a usable reference clip, in seconds.
///
/// UNVERIFIED BELOW 6.28 s. The "below ~1 s there is not enough voiced speech to
/// condition on and both engines produce noise" rationale this constant shipped
/// with is an assumption: the shortest clip ever actually measured through either
/// cloning engine in this tree was 6.28 s, so nothing between 1.0 and 6.28 has
/// been heard. Do not move the number blind — measure first. It only REJECTS, so
/// the cost of it being too low is a bad clone, not a crash.
pub const MIN_CLONE_REF_SECS: f64 = 1.0;

/// Reject a reference clip shorter than [`MIN_CLONE_REF_SECS`], with the message the
/// user sees. Both entry points that accept a clip — `tts_transcribe_reference`
/// (auto-transcribe) and `tts_prepare_reference_clip` (store it) — must apply the
/// SAME floor and say the SAME thing, so the check lives here next to the constant
/// rather than being retyped at each call site.
pub fn reject_short_reference(seconds: f64) -> Result<(), String> {
    if seconds < MIN_CLONE_REF_SECS {
        return Err(format!(
            "Reference clip is too short — use at least ~{MIN_CLONE_REF_SECS:.0} second of clear speech."
        ));
    }
    Ok(())
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
    /// The row has NO unconditioned synthesis path: without a reference clip (and,
    /// when [`CloningKind::needs_reference_text`], its transcript) the engine
    /// ERRORS instead of falling back to a bundled voice, so the model is not
    /// usable until the user clones something.
    ///
    /// This cannot be derived from the two fields above. OmniVoice and Audio8 are
    /// IDENTICAL on both (`num_voices: 1`, `ZeroShotAudioText`) — the `1` is a
    /// sentinel row, not a real preset bank — yet OmniVoice's sentinel is a
    /// genuine bundled voice and Audio8's is an instructive error
    /// (`local_engines.rs`, `Audio8LocalEngine::synthesize_sentence`). Deriving
    /// the warning from `num_voices`/`cloning` would therefore fire on rows that
    /// work fine out of the box, so the fact gets its own flag.
    pub requires_reference_clip: bool,
    /// Voice-design capability: the voice is chosen by a natural-language prompt
    /// (stored in `tts.voice`) rather than a preset list. Drives the picker's
    /// VoiceDesign badge + the "Design voice" prompt dialog.
    pub voice_design: bool,
    /// Character budget for the voice-design instruct, `0` when neither
    /// `voice_design` nor `voice_instruct`. Carried per row (rather than read from
    /// the const at the UI) so a future design model with a different budget needs
    /// no renderer change.
    pub voice_design_max_chars: u32,
    /// The model takes a natural-language style instruction *in addition to* its
    /// voice, rather than instead of it — OmniVoice's prompt carries a dedicated
    /// `<|instruct_start|>…<|instruct_end|>` span alongside the cloned speaker.
    ///
    /// Distinct from [`Self::voice_design`], where the prompt IS the voice and is
    /// stored in the overloaded `tts.voice`. A row that clones needs `tts.voice`
    /// for the reference-clip path, so the instruction lives in its own
    /// `tts.voice_instruct` setting and the picker renders the prompt editor as an
    /// EXTRA row beneath the clone control instead of replacing it.
    pub voice_instruct: bool,
    /// Longest reference clip the cloning UI accepts, seconds; `0` when the row
    /// does not clone. Clips longer than this are TRIMMED, not rejected — see
    /// [`MAX_CLONE_REF_SECS`] for why the number is editorial.
    pub max_ref_clip_secs: u32,
    /// Delimiter style for [`Self::tags`]. `TagSyntax::None` iff `tags` is empty.
    pub tag_syntax: TagSyntax,
    /// BARE inline paralinguistic tag names (no delimiters — wrap with
    /// `tag_syntax.wrap()`), empty when the model has no tag vocabulary.
    pub tags: &'static [&'static str],
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
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 82,
        // fp16 graph (163,234,740) + all 54 voice .bin files (54 x 522,240 =
        // 28,200,960) — the full voice set ships in the one model download. Every
        // voice tensor is the same shape (510 style vectors x 256 dims x fp32), so
        // the per-voice size is structural, not incidental. This CORRECTS an
        // over-declared 191,959,988 that counted 28,725,248 of voices, i.e. 524,288 B
        // (one extra voice) too many.
        quants: &[TtsQuant {
            id: "fp16",
            size_bytes: 191_435_700,
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
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
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
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
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
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
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
        // 19, NOT the model card's 23 — `zh`/`ja`/`ko`/`he` are dropped. All 23 have a
        // real single-token `[xx]` tag in the shipped tokenizer, but the tag cannot
        // rescue text the vocab has no symbols for: the vocab carries ZERO CJK-Han
        // tokens (so `zh` and the kanji half of `ja` are `[UNK]`), only 10 precomposed
        // Hangul syllables against 256 conjoining jamo (`ko` needs NFD decomposition),
        // and 24 niqqud marks (`he` was trained diacritized). Each needs a script
        // frontend — Cangjie / pykakasi / jamo / dicta — this app does not ship. Kept in
        // sync with `local_engines::chatterbox_advertised_languages`, which is the
        // source of truth and is asserted against this row in the tests below.
        languages: &[
            "en", "ar", "da", "de", "el", "es", "fi", "fr", "hi", "it", "ms", "nl", "no", "pl",
            "pt", "ru", "sv", "sw", "tr",
        ],
        num_voices: 1, // ships a bundled default voice (default_voice.wav); also clones from a clip
        cloning: CloningKind::ZeroShotAudio,
        // Ships `default_voice.wav`; usable the moment it finishes downloading.
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 500,
        // EXACT manifest sum, 1,555,820,227 — confirmed twice, byte for byte: against the
        // HF blobs API and against a complete on-disk cache of this row. The q4 backbone
        // is 353,849,159 (227,911 graph + 353,621,248 external data) and the three
        // unquantized graphs + tokenizer + default voice are 1,201,971,068.
        //
        // This CORRECTS a hand-rounded 1,650,000,000, over-declared by 94,179,773 B —
        // the reason this row's download bar stalled at 94.3% and never reached 100%.
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 1_555_820_227,
        }],
        quality_score: 0.80,
        speed_score: 0.20,
        description: "Clone a voice from a short clip; best for personalized multilingual speech.",
    },
    // Chatterbox Turbo — ResembleAI's own 350M English export. Same 4-session
    // architecture as the multilingual entry, but roughly a third of the weights and a
    // token→mel decoder distilled to ONE step, so it is the fast lane of the cloning
    // tier. Ships paralinguistic tags ([cough]/[laugh]/[chuckle]) inline in the text.
    // Sizes are the summed HF blob bytes for each per-graph quant set + tokenizer/config
    // + the default voice clip (fetched from the multilingual repo, which is the only
    // Chatterbox export that publishes one). q4f16 is first/default (smallest); q4 is the
    // conservative f32-KV rung. Both work — the engine reads the KV element type off the
    // graph rather than assuming f32 (see chatterbox.rs' header).
    TtsModelEntry {
        id: "chatterbox-turbo",
        engine: TtsEngineId::Chatterbox,
        display_name: "Chatterbox Turbo (voice cloning)",
        maker: "Resemble AI",
        hf_repo: "ResembleAI/chatterbox-turbo-ONNX",
        languages: &["en"],
        num_voices: 1, // bundled default voice; also clones from a clip
        cloning: CloningKind::ZeroShotAudio,
        // Ships `default_voice.wav`; usable the moment it finishes downloading.
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        // Turbo is the ONLY square-bracket row; Orpheus below uses angle
        // brackets for an overlapping tag set. Tag names are the ones the
        // ResembleAI card documents.
        tag_syntax: TagSyntax::Square,
        tags: &["laugh", "cough", "chuckle"],
        sample_rate: 24_000,
        param_count_m: 350,
        quants: &[
            TtsQuant {
                id: "q4f16",
                size_bytes: 566_084_857,
            },
            TtsQuant {
                id: "q4",
                size_bytes: 725_635_615,
            },
        ],
        // speed measured, quality editorial: warm CPU RTF 1.34 (q4) / 1.38 (q4f16) vs 3.00
        // for the multilingual row on the same box and sentence — ~2.2x faster, placed on
        // the same log-RTF scale that puts Kokoro (0.18) at 0.85 and multilingual at 0.20.
        // The two rungs run at the same speed, so q4f16 leads purely on size.
        quality_score: 0.78,
        speed_score: 0.38,
        description: "Fast English voice cloning with inline [laugh]/[cough] tags.",
    },
    // Chatterbox Nano — the 110M end of the family (12-layer backbone, 1-step decoder).
    // ResembleAI publishes the PyTorch weights but no first-party ONNX export yet, so the
    // weights come from the MIT community export (owensong), which ships one MIXED-quant
    // set: q4 decoder + fp16 embeddings + q4f16 backbone/encoder. Its README only claims
    // "development smoke tests" (a single CPU pass, one speaker, one sentence), so this
    // entry is gated on our own forward-pass verification, not the publisher's.
    TtsModelEntry {
        id: "chatterbox-nano",
        engine: TtsEngineId::Chatterbox,
        display_name: "Chatterbox Nano (voice cloning)",
        maker: "Resemble AI",
        hf_repo: "owensong/chatterbox-nano-ONNX",
        languages: &["en"],
        num_voices: 1, // bundled default voice; also clones from a clip
        cloning: CloningKind::ZeroShotAudio,
        // Ships `default_voice.wav`; usable the moment it finishes downloading.
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        // The community export documents no tag vocabulary for nano.
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 110,
        // Single mixed-precision set (the publisher exported no other rung), + tokenizer/
        // config + the default voice clip from the multilingual repo.
        quants: &[TtsQuant {
            id: "q4f16",
            size_bytes: 574_087_767,
        }],
        // Warm CPU RTF 0.97 — the only Chatterbox rung that synthesizes faster than
        // realtime here, ~3.1x the multilingual row. Well short of the card's "3x faster
        // than realtime on 8 cores", which is why the score follows the measurement.
        // Quality is editorial: audible loss vs turbo (110M, one-step decoder), still
        // clean enough to round-trip verbatim through STT.
        quality_score: 0.62,
        speed_score: 0.46,
        description: "Smallest voice-cloning model; fastest of the Chatterbox family.",
    },
    // Qwen3-TTS Voice Design: no preset voices — the voice is described by a
    // natural-language prompt (stored in `tts.voice`). ONNX weights come from the
    // onnx-community repo under `<quant_subdir>/` (cpu_int4|cpu_fp16|cpu_fp32) at
    // repo ROOT; config/tokenizer come from the separate `Qwen/...VoiceDesign`
    // repo (see PORT_SPEC §1). int4 is first/default (smallest, maintained recipe).
    // Sizes = onnx-for-quant + 4,460,682 (config/tokenizer: config 4,421 +
    // generation_config 245 + tokenizer_config 7,344 + vocab 2,776,833 + merges
    // 1,671,839). That second term was 4,458,597 until it was re-read from the blobs
    // API, so all three rungs below were 2,085 B short. Quality stays at the
    // unmeasured 0.5 placeholder; speed is DERIVED, not measured — the 0.6B sibling
    // below benchmarks at warm CPU RTF 6.3 on int4, and this row's talker (the AR loop
    // that dominates that time) is ~2.8x heavier, so it has to score below it.
    TtsModelEntry {
        id: "qwen3-tts-1.7b-voicedesign",
        engine: TtsEngineId::Qwen3Tts,
        display_name: "Qwen3-TTS 1.7B Voice Design",
        maker: "Qwen",
        hf_repo: "onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        languages: &["en", "zh", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"],
        num_voices: 0, // no preset voices; voice via prompt
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: true,
        voice_design_max_chars: VOICE_DESIGN_PROMPT_MAX_CHARS,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 1700,
        quants: &[
            TtsQuant {
                id: "int4",
                size_bytes: 1_741_196_079,
            },
            TtsQuant {
                id: "fp16",
                size_bytes: 4_443_564_168,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 8_419_486_319,
            },
        ],
        quality_score: 0.5,
        speed_score: 0.05,
        description: "Multilingual voice-design TTS; describe the voice with a text prompt.",
    },
    // Qwen3-TTS Custom Voice 0.6B — same export pipeline/graph layout as the 1.7B
    // VoiceDesign row above (quant subdirs at repo ROOT, identical `inference.py`), so
    // `qwen3_tts.rs` drives it with config only. Worth carrying alongside the 1.7B for
    // two reasons: the talker drops 1.7B → 0.6B, and the talker is the autoregressive
    // decode loop that dominates latency, so the hot path gets ~2.8x lighter; and it adds
    // 9 preset timbres, which the VoiceDesign row (`num_voices: 0`) has none of.
    //
    // NAMING TRAP: despite "CustomVoice", this is NOT zero-shot cloning from a clip — the
    // model card describes 9 premium preset timbres plus natural-language STYLE control
    // via `instruct`. Hence `cloning: None` and `voice_design: false`; the instruct text
    // rides along with the selected speaker rather than replacing it.
    //
    // Sizes = the six graphs this engine actually loads (`tok_encoder` is skipped, exactly
    // as for the 1.7B — the ONNX path never runs the audio tokenizer) + manifest.json +
    // 4,461,169 bytes of config/tokenizer from the separate `Qwen/...` repo.
    TtsModelEntry {
        id: "qwen3-tts-0.6b-customvoice",
        engine: TtsEngineId::Qwen3Tts,
        display_name: "Qwen3-TTS 0.6B Custom Voice",
        maker: "Qwen",
        hf_repo: "onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        languages: &["en", "zh", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"],
        num_voices: 9,
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: false,
        // The style `instruct` this row accepts rides ALONGSIDE a preset speaker,
        // so it is not the voice-design field the cap governs.
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 600,
        quants: &[
            TtsQuant {
                id: "int4",
                size_bytes: 1_070_553_338,
            },
            TtsQuant {
                id: "fp16",
                size_bytes: 2_350_468_175,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 4_233_300_466,
            },
        ],
        // Speed measured: warm CPU RTF 6.3 on int4 (the AR talker loop dominates), so it
        // scores near the floor of the same log-RTF scale as the Chatterbox rows — still
        // ahead of the 1.7B above. Quality keeps the sibling's unmeasured 0.5 placeholder.
        quality_score: 0.5,
        speed_score: 0.10,
        description: "Nine preset multilingual timbres with text style control.",
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
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        // ANGLE brackets — the opposite of Chatterbox Turbo above. Orpheus's
        // tags ride through the tokenizer as ordinary text, so the wrong
        // delimiter is spoken aloud rather than rejected.
        tag_syntax: TagSyntax::Angle,
        tags: &["laugh", "sigh", "gasp"],
        sample_rate: 24_000,
        param_count_m: 3_000,
        // q4 llm (2,423,656,878) + snac decoder (52,600,822) + tokenizer (15,722,697).
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 2_491_980_397,
        }],
        // Speed MEASURED with examples/tts_engine_bench (i9-12900KF, warm, CPU, q4 — the only
        // rung) on the shared sentence: warm RTF 24.09 (tara, ~772 tokens → 9.4 s, natural
        // EOS). Duration here is strictly 7 SNAC codes per 85 ms frame, so RTF is nothing but
        // the decode rate — ~3.4 tok/s for a 3B q4 Llama on the ORT CPU EP. It gets WORSE with
        // context, not better, because attention is O(n^2) and the KV cache is re-fed whole
        // every step: the `leah` draw of that measurement ran away to the 2,800-token cap
        // (34.05 s) and cost RTF 43.73. That runaway was the missing repetition penalty
        // (orpheus.rs) and no longer reproduces — `leah` now ends on EOS at 973 tokens — but
        // the anchors above predate the fix, so they are token-rate measurements only.
        //
        // This REPLACES an unmeasured 0.35 — wrong by ~12x, and it left this row reading as
        // FASTER than `neutts-2e` (measured ~3.0 → 0.20) despite a 24x larger backbone. On the
        // log-RTF fit through the measured anchors (kokoro 0.18 → 0.85, chatterbox-nano 0.974
        // → 0.46, chatterbox-turbo 1.34 → 0.38, chatterbox-multilingual 3.00 → 0.20,
        // qwen3-tts-0.6b 6.33 → 0.10) an RTF of 24 extrapolates BELOW zero, so the score is
        // pinned just off the floor: the slowest row in the catalog, under omnivoice's 0.08.
        //
        // QUALITY MEASURED with examples/orpheus_loop_probe (all 8 voices, q4 — the only rung)
        // on "The quick brown fox jumps over the lazy dog, and honestly, it never gets old.",
        // every render transcribed back through Whisper base.en — the same gate `neutts-2e`
        // below passed word-for-word. **Not one of the 8 voices reproduced the sentence.** The
        // trailing clause usually survives ("…lazy dog and honestly, it never gets old") while
        // the opening is replaced by fluent nonsense: tara → "Okay, you player of the lazy
        // dog…", zoe → "Can places with did lacy?". The control rules out the harness —
        // `neutts-2e` int8 renders that exact sentence and round-trips word-for-word.
        //
        // This REPLACES an editorial, never-measured 0.88 that ranked this row 4th in the
        // catalog and ABOVE the `neutts-2e` row (0.80) that is word-perfect on the same input.
        // 0.30 puts it below every measured row including kitten-nano (0.46): those rows are
        // thin or robotic, which is a different thing from wrong. It is not lower because the
        // failure is content fidelity, not audio — the timbre and prosody are convincingly
        // human, which is exactly what makes the substitutions easy to miss.
        //
        // The q4 GRAPH is the suspect, not the sampler. Decoded GREEDY
        // (`ORPHEUS_PROBE_TEMP=0`), tara collapses to 21 tokens — 3 frames, 0.26 s, rms
        // exactly 0.0000 — then EOS, at BOTH repetition penalties. The argmax path of this
        // graph is silence, so the speech-shaped output at temperature 0.6 is coming out of
        // the tail of a miscalibrated distribution rather than off a healthy mode. (That is
        // also what `dan` hit pre-fix: its 0.6 draw happened to follow the argmax path and it
        // rendered the same 21-token silence.) Re-measure if a non-q4 rung is ever published;
        // nothing here separates the export from the quantization, and this row takes the
        // crudest quantization of any model in the catalog on the largest backbone.
        quality_score: 0.30,
        speed_score: 0.03,
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
        // Two preset timbres for creation mode — works without a clip.
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 16_000,
        param_count_m: 500,
        // EXACT manifest sum, 2,003,881,112 — every file confirmed twice (HF blobs API and a
        // complete on-disk cache of this row). Fhrozen LLM q4 819,707,255 + bicodec
        // 385,417,099 + tokenizer 14,129,172 + tokenizer_config 2,577,032, then DgDev91's
        // cloning graphs: wav2vec2 fp16 631,289,801 + encoder-quantizer 122,407,119 +
        // speaker 23,852,747 + mel 4,500,887. This CORRECTS a hand-rounded 2,001,500,000
        // (2,381,112 B short — a guess, not a sum).
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 2_003_881_112,
        }],
        quality_score: 0.68,
        speed_score: 0.5,
        description: "Small bilingual (EN/ZH) TTS: pick a gender or clone a voice from a reference clip.",
    },
    // NeuTTS-2e — Neuphonic's expressive English model: a ~236M-param Qwen3 backbone emitting
    // single-codebook NeuCodec tokens, decoded by the NeuCodec decoder from a SECOND repo
    // (neuphonic/neucodec-onnx-decoder[-int8], Apache-2.0), stitched in the download manifest
    // exactly like Orpheus + SNAC. It occupies the same slot as `orpheus-3b` above — expressive
    // English with mood control — at roughly a quarter of the download and a 24x smaller
    // backbone, and unlike Orpheus the mood is a real conditioning token rather than an inline
    // tag, so `tag_syntax` stays `None`. NOT a cloning model: the four speakers are FIXED
    // pre-encoded references bundled in `neutts.rs`, hence `cloning: None` / `voice_design:
    // false` / `max_ref_clip_secs: 0`.
    //
    // ⚠️ LICENSE — the backbone (and the bundled speaker references, which come from the same
    // release) is under the **NeuTTS Open License v1.0**, NOT Apache-2.0. It permits
    // redistribution, format conversion and desktop-app distribution with attribution
    // preserved, but §5 conditions COMMERCIAL use on the user's Legal Entity staying under
    // $5,000,000 annual revenue; above that threshold a paid license from Neuphonic is
    // required. The manifest therefore also fetches the upstream `LICENSE` next to the
    // weights so every recipient of the Work gets a copy (§4(a)), and the terms are recorded
    // in THIRD_PARTY_NOTICES.md. The NeuCodec decoder is Apache-2.0 and carries no threshold.
    TtsModelEntry {
        id: "neutts-2e",
        engine: TtsEngineId::NeuTts,
        display_name: "NeuTTS 2E",
        maker: "Neuphonic",
        hf_repo: "Danny-Dasilva/neutts-2e-onnx",
        languages: &["en"],
        // 4 speakers x 7 emotions, flattened to `{speaker}-{emotion}` voice ids so the shared
        // voice dropdown renders them with no new UI. Must equal NEUTTS_VOICE_INFOS.len().
        num_voices: 28,
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 236,
        // Exact HF blob bytes. int8 = model_int8.onnx 349,402,919 + tokenizer 24,063,947 +
        // config 1,652 + LICENSE 11,081 + neucodec-onnx-decoder-int8 312,292,102.
        // fp32 = model.onnx 1,390,321,808 + the same 24,076,680 of metadata +
        // neucodec-onnx-decoder 782,565,930.
        quants: &[
            TtsQuant {
                id: "int8",
                size_bytes: 685_771_701,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 2_196_964_418,
            },
        ],
        // Both MEASURED with examples/tts_engine_bench (i9-12900KF, warm, CPU, int8 rung).
        //
        // SPEED — warm RTF 2.96 (paul) / 3.00 (steven) / 3.01 (sophie) / 3.39 (emily) on the
        // same neutral sentence. Emily is the slow one because her bundled reference is the
        // longest (402 codes = 8.0 s vs sophie's 175), and the reference sits in the prompt of
        // EVERY sentence. ~3.0 puts it level with `chatterbox-multilingual` (measured 3.00 →
        // 0.20) on the shared log-RTF scale, so it takes the same score. This USED to read as
        // slower than `orpheus-3b`, which is the row it competes with — but that comparison was
        // against an unmeasured 0.35; Orpheus has since been benchmarked at RTF 24.09 (→ 0.03),
        // so the 24x smaller backbone is now correctly ~8x the faster of the two.
        //
        // QUALITY — all 15 gate renders (4 speakers, 7 emotions, both rungs) transcribed back
        // word-for-word through Whisper base.en with 0 NaN. Held below the Kokoro/Supertonic
        // tier because the backbone is 236M and the sampler is stochastic: upstream documents
        // that occasional bad draws (a slurred word, a trailing artifact) happen at any
        // precision, which the fixed per-prompt seed makes reproducible but not impossible.
        quality_score: 0.80,
        speed_score: 0.20,
        description: "Expressive English speakers with seven selectable emotions each.",
    },
    // OmniVoice — k2-fsa's 646-language NON-AUTOREGRESSIVE masked-refinement TTS. Not an AR
    // decoder: 32 full bidirectional forward passes per sentence, no KV cache, and CFG doubles
    // the batch. The fused step graph comes from the WebGPU-demo export (the only one keeping
    // the 4-D bidirectional mask — verified empirically, see omnivoice.rs); the waveform->codes
    // tokenizer stack that makes runtime cloning possible comes from onnx-community. CPU-pinned.
    //
    // Speed MEASURED with examples/omnivoice_step_probe.rs (i9-12900KF, quiet, warm, fp32):
    // CPU-EP RTF 3.37x with no reference, 6.45x with a 3 s clip, 17.04x with a 12.5 s clip.
    // Cost is O(num_step * L^2) with L INCLUDING the reference frames, so a longer reference
    // taxes every sentence permanently — hence the score sits just under the qwen3-tts-0.6b
    // row (measured 6.3x) on the same log-RTF scale.
    TtsModelEntry {
        id: "omnivoice-0.6b",
        engine: TtsEngineId::OmniVoice,
        display_name: "OmniVoice 0.6B",
        maker: "k2-fsa",
        // Provenance only — this row spans three repos, so omnivoice_manifest() builds every
        // URL explicitly (same pattern as Orpheus/Spark/Qwen3).
        hf_repo: "k2-fsa/OmniVoice",
        languages: &[
            "en-us", "en-gb", "ja", "cmn", "es", "fr", "hi", "it", "pt-br",
        ],
        // No preset bank — the voice comes from a reference clip. One sentinel entry, exactly
        // like Chatterbox. Must equal OMNIVOICE_VOICES.len().
        num_voices: 1,
        cloning: CloningKind::ZeroShotAudioText,
        // The sentinel IS a real bundled voice here — synthesis works unconditioned.
        requires_reference_clip: false,
        // `instruct` is a CLOSED, validated 6-category vocabulary upstream, NOT the free-text
        // prompt VoiceDesignField backs — wiring it there would emit out-of-distribution style
        // tokens with no error. Not exposed in v1.
        voice_design: false,
        voice_design_max_chars: VOICE_DESIGN_PROMPT_MAX_CHARS,
        // OmniVoice's prompt carries a dedicated instruct span ALONGSIDE the cloned
        // speaker, so this is an extra field rather than a replacement for the
        // voice (that is `voice_design`, which this row deliberately leaves false).
        voice_instruct: true,
        // 5 s, not the shared 30 s: this engine's cost is O(num_step * L^2) with the
        // reference INSIDE L, so the clip is charged to every sentence of the read.
        // See [`OMNIVOICE_MAX_CLONE_REF_SECS`] for the measured curve.
        max_ref_clip_secs: OMNIVOICE_MAX_CLONE_REF_SECS,
        // [laughter], [sigh], ... — same bracket syntax as Chatterbox Turbo, different names.
        tag_syntax: TagSyntax::Square,
        tags: crate::winstt::tts::omnivoice::OMNIVOICE_TAGS,
        sample_rate: 24_000,
        // Qwen3-0.6B backbone: 440.4M in the layer matmuls + embeddings + 8.4M audio head.
        param_count_m: 600,
        // Exact HF blob bytes, every one confirmed against the repo tree API and, for the
        // sidecar, against the step proto's own max(external_data.offset + length):
        //   omnivoice_step.onnx           1,468,045  (tritueviet/omnivoice-webgpu-assets)
        //   omnivoice_step.data       2,450,280,448  (same)
        //   tokenizer.json               11,423,986  (k2-fsa/OmniVoice)
        //   audio_tokenizer/acoustic_encoder.onnx    205,546,480  (onnx-community/OmniVoice-Onnx)
        //   audio_tokenizer/semantic_encoder.onnx    436,736,856  (same)
        //   audio_tokenizer/quantizer_encoder.onnx    12,131,293  (same)
        //   audio_tokenizer/higgs_decoder.onnx        86,500,102  (same)
        quants: &[TtsQuant {
            id: "fp32",
            size_bytes: 3_204_087_210,
        }],
        quality_score: 0.92,
        speed_score: 0.08,
        description: "Clone a voice from a short clip in 600+ languages. Slow.",
    },
    // Audio8 TTS Preview 0.6B — DualAR (Fish-Audio-S2-style) zero-shot cloner: 24-layer
    // slow AR (one semantic token per frame) + 4-layer fast AR (10 codec codebooks) +
    // 44.1 kHz neural codec, ported from the official CPU-oriented ONNX runtime
    // (`audio8.rs`). Cloning REQUIRES the reference transcript (the prompt interleaves
    // it with the clip's codec codes), so the row is ZeroShotAudioText and the shared
    // auto-transcribe field lights up. Upstream accepts 0.5-30 s references — the shared
    // 30 s cap and 1 s floor bracket that honestly. Apache-2.0, weights + code.
    TtsModelEntry {
        id: "audio8-tts-0.6b",
        engine: TtsEngineId::Audio8,
        display_name: "Audio8 TTS 0.6B",
        maker: "Audio8",
        hf_repo: "Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4",
        // The 11 languages the Preview card recommends (coverage is intentionally
        // limited in this release, per upstream): Cantonese, Chinese, Dutch, English,
        // French, German, Italian, Japanese, Korean, Polish, Spanish.
        languages: &[
            "en", "cmn", "yue", "nl", "fr", "de", "it", "ja", "ko", "pl", "es",
        ],
        // No preset bank — the voice comes from a reference clip. One sentinel entry,
        // exactly like OmniVoice. Must equal AUDIO8_VOICES.len().
        num_voices: 1,
        cloning: CloningKind::ZeroShotAudioText,
        // The ONLY row that is inert until cloned: the DualAR prompt REQUIRES reference
        // codes (upstream's PromptBuilder rejects an empty Speech span), so the "default"
        // sentinel without a clip is an error, not a bundled voice.
        requires_reference_clip: true,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 44_100,
        param_count_m: 601,
        // Exact HF blob bytes (repo tree API, 2026-08-01): slow_ar_int4.onnx 900,218 +
        // .data 290,267,090 + fast_ar_int4.onnx 156,318 + .data 35,055,104 +
        // codec_decoder_fp16.onnx 594,319 + .data 260,741,440 + registration/
        // codec_encoder_fp16.onnx 940,787 + .data 414,425,088 + tokenizer/tokenizer.json
        // 12,217,872. "int4" is the only precision upstream publishes (weight-only INT4
        // AR + fp16 activations/codec) — there is no int8 export.
        quants: &[TtsQuant {
            id: "int4",
            size_bytes: 1_015_298_236,
        }],
        // quality editorial (44.1 kHz output, strong cloning fidelity for 0.6B; the
        // gate render transcribed back word-for-word through Whisper base.en, 0 NaN).
        //
        // speed MEASURED with examples/tts_engine_bench (i9-12900KF, warm, idle CPU,
        // ort rc.13 / ORT 1.28, weight prepacking DISABLED — the pyke-build MLAS
        // mis-prepacks this export's int4 weights on every runtime tried, see
        // `audio8_int4_session`): RTF 25.0, the orpheus-3b tier (24.1 → 0.03) on the
        // shared log-RTF scale. ORT 1.28's unpacked int4 kernels are ~1.9x faster
        // than 1.24.2's (47.5 → 25.0), so the rc.13 bump still halved this row's cost.
        quality_score: 0.88,
        speed_score: 0.03,
        description: "Clone any voice from a short clip; 11 languages at studio 44.1 kHz. Slow.",
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

/// The four Chatterbox ONNX graph basenames (under `onnx/`) for a catalog id + quant.
///
/// Each Chatterbox export chooses its quant suffix PER GRAPH, so a single global
/// suffix cannot address them: `chatterbox-nano` genuinely MIXES precisions
/// (`conditional_decoder_q4` + `embed_tokens_fp16` + `language_model_q4f16` +
/// `speech_encoder_q4f16`) because that is the only set its publisher exported.
/// Shared by the TTS download manager (file fetch) and `build_local_engine_for`
/// (session load) so the two never drift apart — same contract as
/// [`kitten_model_file`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatterboxGraphSet {
    pub speech_encoder: &'static str,
    pub embed_tokens: &'static str,
    pub language_model: &'static str,
    pub conditional_decoder: &'static str,
}

pub(crate) fn chatterbox_graph_set(model_id: &str, quant: &str) -> ChatterboxGraphSet {
    match model_id {
        // Community export (owensong): ONE mixed-precision set — there is no other
        // ladder rung to pick, so `quant` is ignored.
        "chatterbox-nano" => ChatterboxGraphSet {
            speech_encoder: "speech_encoder_q4f16.onnx",
            embed_tokens: "embed_tokens_fp16.onnx",
            language_model: "language_model_q4f16.onnx",
            conditional_decoder: "conditional_decoder_q4.onnx",
        },
        // ResembleAI's first-party Turbo export publishes a uniform suffix per rung.
        "chatterbox-turbo" => match quant {
            "q4" => ChatterboxGraphSet {
                speech_encoder: "speech_encoder_q4.onnx",
                embed_tokens: "embed_tokens_q4.onnx",
                language_model: "language_model_q4.onnx",
                conditional_decoder: "conditional_decoder_q4.onnx",
            },
            // q4f16 is first/default (smallest); unknown ids fall through to it.
            _ => ChatterboxGraphSet {
                speech_encoder: "speech_encoder_q4f16.onnx",
                embed_tokens: "embed_tokens_q4f16.onnx",
                language_model: "language_model_q4f16.onnx",
                conditional_decoder: "conditional_decoder_q4f16.onnx",
            },
        },
        // chatterbox-multilingual (and any future default): only the backbone is
        // quantized in the onnx-community export; the other three are the base graphs.
        _ => ChatterboxGraphSet {
            speech_encoder: "speech_encoder.onnx",
            embed_tokens: "embed_tokens.onnx",
            language_model: match quant {
                "fp16" => "language_model_fp16.onnx",
                "q4f16" => "language_model_q4f16.onnx",
                "fp32" => "language_model.onnx",
                _ => "language_model_q4.onnx",
            },
            conditional_decoder: "conditional_decoder.onnx",
        },
    }
}

/// The NeuTTS-2e file set for a quant: the backbone graph, the local NeuCodec decoder path,
/// and WHICH decoder repo it comes from.
///
/// The two decoder rungs live in two different repos that BOTH publish their graph as
/// `model.onnx`, so the local name has to disambiguate them — otherwise switching quants
/// would silently reuse the other precision's cached decoder. Shared by the download manifest
/// and `NeuTtsLocalEngine` so the fetched files and the opened sessions cannot drift (same
/// contract as [`chatterbox_graph_set`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NeuTtsGraphSet {
    /// Backbone graph name in `entry.hf_repo`, also its local name.
    pub backbone: &'static str,
    /// Local path of the NeuCodec decoder, relative to the model cache dir.
    pub codec: &'static str,
    /// HF repo publishing that decoder (its file is always `model.onnx`).
    pub codec_repo: &'static str,
}

pub(crate) fn neutts_graph_set(quant: &str) -> NeuTtsGraphSet {
    match quant {
        "fp32" => NeuTtsGraphSet {
            backbone: "model.onnx",
            codec: "neucodec/model.onnx",
            codec_repo: "neuphonic/neucodec-onnx-decoder",
        },
        // int8 is first/default; unknown ids fall through to it. It is the default because it
        // MEASURED faster on BOTH stages, which is not a safe assumption on ORT CPU (dynamic
        // int8 is 4-23x SLOWER than fp16/DML for Cohere ASR in this same tree) — so both were
        // A/B'd on this box at 4 intra-op threads, same prompt, same seed:
        //   backbone  int8  prefill  997 ms, decode 15.1 tok/s   |  fp32 1593 ms, 9.2 tok/s
        //             → int8 is 1.6x faster both at prefill and per token
        //   decoder   int8   313 ms  |  fp32  553 ms  (1.8x faster) on the SAME code sequence,
        //             and numerically near-transparent: SNR 21.9 dB, waveform correlation
        //             0.9968, peak 0.621 vs 0.622, rms 0.0993 vs 0.0997.
        // So int8 wins on size AND speed with no audible cost, and end-to-end warm RTF is
        // 3.39 vs 6.07 (emily) / 2.33 vs 3.63 (sophie). The rungs stay COUPLED (int8 backbone
        // with int8 decoder, fp32 with fp32): the fp32 rung exists for users who want the
        // argmax-identical-to-torch backbone, and pairing it with a lossy decoder would give
        // away the fidelity that is the whole reason to pay 2.2 GB for it.
        _ => NeuTtsGraphSet {
            backbone: "model_int8.onnx",
            codec: "neucodec/model_int8.onnx",
            codec_repo: "neuphonic/neucodec-onnx-decoder-int8",
        },
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

    /// OmniVoice's facets are what light up the EXISTING cloning UI with no frontend or
    /// settings-schema change: the wire string `zero_shot_audio_transcript` is what
    /// `use-tts-model-section.ts` keys `needsRefText` off, and `voice_design: false` keeps
    /// the row out of the free-text VoiceDesignField (its `instruct` is a closed,
    /// validated vocabulary upstream, not a prose prompt).
    #[test]
    fn omnivoice_clones_from_a_clip_and_transcript_without_voice_design() {
        let entry = find("omnivoice-0.6b").expect("omnivoice catalog row");
        assert_eq!(entry.engine, TtsEngineId::OmniVoice);
        assert_eq!(entry.engine.as_str(), "omnivoice");
        assert_eq!(entry.cloning, CloningKind::ZeroShotAudioText);
        assert_eq!(entry.cloning.as_str(), "zero_shot_audio_transcript");
        // NOT voice-design: the prompt does not replace the voice here, the clip does.
        // The model's `<|instruct_start|>` span is a SEPARATE style instruction that
        // rides alongside the cloned speaker, hence `voice_instruct` + a budget.
        assert!(!entry.voice_design);
        assert!(entry.voice_instruct);
        assert_eq!(entry.voice_design_max_chars, VOICE_DESIGN_PROMPT_MAX_CHARS);
        assert_eq!(entry.max_ref_clip_secs, OMNIVOICE_MAX_CLONE_REF_SECS);
        assert_eq!(entry.sample_rate, 24_000);
        // Single rung: the export publishes fp32 only, and the fp16 tokenizer rung is
        // deliberately deferred (the RVQ stage is a Euclidean argmin, so fp16 rounding
        // can flip individual codes).
        assert_eq!(entry.quants.len(), 1);
        assert_eq!(entry.quants[0].id, "fp32");
        // One sentinel entry, not a preset bank — the voice comes from the clip.
        assert_eq!(
            entry.num_voices as usize,
            crate::winstt::tts::local_engines::OMNIVOICE_VOICES.len()
        );
    }

    /// The 13 non-verbal tags come from the engine module rather than being re-typed
    /// here, so the catalog's advertised vocabulary and the tokenizer's isolation regex
    /// cannot drift apart.
    #[test]
    fn omnivoice_tags_are_the_engines_own_list() {
        let entry = find("omnivoice-0.6b").expect("omnivoice catalog row");
        assert_eq!(entry.tag_syntax, TagSyntax::Square);
        assert_eq!(entry.tags, crate::winstt::tts::omnivoice::OMNIVOICE_TAGS);
        assert_eq!(entry.tags.len(), 13);
        assert!(entry.tags.contains(&"laughter"));
        assert!(entry.tags.contains(&"dissatisfaction-hnn"));
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

    /// The refactor to per-graph filenames must leave the shipped multilingual entry's
    /// file set EXACTLY as it was (only the backbone carries a quant suffix there).
    #[test]
    fn multilingual_graph_set_is_unchanged_by_the_per_graph_refactor() {
        let g = chatterbox_graph_set("chatterbox-multilingual", "q4");
        assert_eq!(g.speech_encoder, "speech_encoder.onnx");
        assert_eq!(g.embed_tokens, "embed_tokens.onnx");
        assert_eq!(g.language_model, "language_model_q4.onnx");
        assert_eq!(g.conditional_decoder, "conditional_decoder.onnx");
        // An unknown/empty quant still resolves to the shipped default backbone.
        assert_eq!(
            chatterbox_graph_set("chatterbox-multilingual", "").language_model,
            "language_model_q4.onnx"
        );
    }

    /// Nano's publisher exported ONE mixed-precision set; a single global quant suffix
    /// could not name these four files, which is why the mapping is per graph.
    #[test]
    fn nano_graph_set_mixes_precisions() {
        let g = chatterbox_graph_set("chatterbox-nano", "q4f16");
        assert_eq!(g.speech_encoder, "speech_encoder_q4f16.onnx");
        assert_eq!(g.embed_tokens, "embed_tokens_fp16.onnx");
        assert_eq!(g.language_model, "language_model_q4f16.onnx");
        assert_eq!(g.conditional_decoder, "conditional_decoder_q4.onnx");
        let distinct: std::collections::BTreeSet<&str> = [
            g.speech_encoder,
            g.embed_tokens,
            g.language_model,
            g.conditional_decoder,
        ]
        .iter()
        .map(|f| {
            f.rsplit_once('.')
                .map_or("", |(stem, _)| stem)
                .rsplit_once('_')
                .map_or("", |(_, suffix)| suffix)
        })
        .collect();
        assert!(
            distinct.len() > 1,
            "nano must span more than one precision: {distinct:?}"
        );
    }

    #[test]
    fn turbo_graph_set_follows_the_selected_rung() {
        let f16 = chatterbox_graph_set("chatterbox-turbo", "q4f16");
        assert_eq!(f16.language_model, "language_model_q4f16.onnx");
        assert_eq!(f16.conditional_decoder, "conditional_decoder_q4f16.onnx");
        let q4 = chatterbox_graph_set("chatterbox-turbo", "q4");
        assert_eq!(q4.language_model, "language_model_q4.onnx");
        assert_eq!(q4.speech_encoder, "speech_encoder_q4.onnx");
        // q4f16 is first in the ladder, so it is what an empty selection resolves to.
        assert_eq!(
            find("chatterbox-turbo")
                .expect("turbo entry")
                .default_quant(),
            "q4f16"
        );
    }

    /// Qwen3-TTS-CustomVoice is preset-timbre + style-instruct, NOT clone-from-a-clip —
    /// the name invites exactly that mistake, so the facets are pinned here.
    #[test]
    fn qwen3_custom_voice_is_presets_not_cloning_or_voice_design() {
        let entry = find("qwen3-tts-0.6b-customvoice").expect("custom-voice entry");
        assert_eq!(entry.cloning, CloningKind::None);
        assert!(!entry.voice_design);
        assert_eq!(entry.num_voices, 9);
        // The 1.7B row keeps the opposite facets (design prompt, no preset bank).
        let design = find("qwen3-tts-1.7b-voicedesign").expect("voice-design entry");
        assert!(design.voice_design);
        assert_eq!(design.num_voices, 0);
    }

    /// A cloning row that ships without a clip cap would feed an unbounded clip
    /// to `speech_encoder`/wav2vec2 (neither engine enforces one), so the two
    /// facets are pinned to each other rather than filled in per row by hand.
    #[test]
    fn clone_ref_cap_is_set_exactly_on_cloning_rows() {
        for m in TTS_CATALOG {
            if m.cloning.supports_cloning() {
                assert!(
                    m.max_ref_clip_secs > 0,
                    "{} clones but declares no reference-clip cap",
                    m.id
                );
            } else {
                assert_eq!(
                    m.max_ref_clip_secs, 0,
                    "{} does not clone but declares a clip cap",
                    m.id
                );
            }
        }
    }

    /// The cap is a PER-ROW facet, not one global number: OmniVoice pays for the
    /// reference on every sentence (O(num_step * L^2) with the reference inside L), so
    /// its 5 s is a correctness-of-product decision, not a preference. A call site that
    /// reads [`MAX_CLONE_REF_SECS`] directly instead of the row silently hands it 30 s —
    /// ~34x realtime by the measured fit.
    #[test]
    fn omnivoice_caps_the_reference_far_below_the_shared_default() {
        let omnivoice = find("omnivoice-0.6b").expect("omnivoice row");
        assert_eq!(omnivoice.max_ref_clip_secs, OMNIVOICE_MAX_CLONE_REF_SECS);
        const {
            assert!(
                OMNIVOICE_MAX_CLONE_REF_SECS < MAX_CLONE_REF_SECS,
                "the whole point of the per-row facet is that this row is tighter"
            );
            // The cap must still leave a usable clip: above the 3 s reference the port
            // was gated on (and so, transitively, above the 1 s rejection floor).
            assert!(OMNIVOICE_MAX_CLONE_REF_SECS >= 3);
        }
        assert!(f64::from(OMNIVOICE_MAX_CLONE_REF_SECS) > MIN_CLONE_REF_SECS);
        // Every OTHER cloning row keeps the shared default — this change is scoped to
        // the one engine whose cost curve forced it.
        for m in TTS_CATALOG {
            if m.cloning.supports_cloning() && m.id != "omnivoice-0.6b" {
                assert_eq!(
                    m.max_ref_clip_secs, MAX_CLONE_REF_SECS,
                    "{} must keep the shared reference cap",
                    m.id
                );
            }
        }
    }

    /// One resolver, so clip preparation, the engine-side trim and the UI hint cannot
    /// measure the same clip against three different numbers.
    #[test]
    fn reference_clip_cap_resolves_per_row_with_a_usable_fallback() {
        assert_eq!(
            reference_clip_cap_secs("omnivoice-0.6b"),
            OMNIVOICE_MAX_CLONE_REF_SECS
        );
        assert_eq!(
            reference_clip_cap_secs("chatterbox-multilingual"),
            MAX_CLONE_REF_SECS
        );
        // Rows that do not clone declare `0`, which must NOT read as "no cap": a clip can
        // be prepared before the cloning model is picked.
        assert_eq!(reference_clip_cap_secs("kokoro-82m"), MAX_CLONE_REF_SECS);
        assert_eq!(reference_clip_cap_secs("not-a-model"), MAX_CLONE_REF_SECS);
        assert_eq!(reference_clip_cap_secs(""), MAX_CLONE_REF_SECS);
        // Never zero — a `0` budget would trim every clip to nothing.
        for m in TTS_CATALOG {
            assert!(reference_clip_cap_secs(m.id) > 0, "{} caps at 0", m.id);
        }
    }

    /// The advertised language list is a product claim, and for this row it is NOT the
    /// model card's 23: `zh`/`ja`/`ko`/`he` tokenize to `[UNK]` (or, for `he`, to
    /// undiacritized ambiguity) in the shipped vocab no matter which `[xx]` tag is
    /// prefixed, because the script frontends they need are not in this app. The engine
    /// module owns that classification; this test is the wire that stops the catalog row
    /// from drifting away from it.
    #[test]
    fn chatterbox_multilingual_advertises_exactly_what_the_engine_can_speak() {
        let entry = find("chatterbox-multilingual").expect("multilingual row");
        assert_eq!(
            entry.languages,
            crate::winstt::tts::local_engines::chatterbox_advertised_languages().as_slice(),
        );
        assert_eq!(entry.languages.len(), 19);
        for code in ["zh", "ja", "ko", "he"] {
            assert!(
                !entry.languages.contains(&code),
                "{code} needs a script frontend this app does not ship"
            );
        }
        // The other Chatterbox exports are English-only and must not inherit the list.
        for id in ["chatterbox-turbo", "chatterbox-nano"] {
            assert_eq!(find(id).expect("chatterbox row").languages, &["en"]);
        }
    }

    #[test]
    fn requires_reference_clip_is_set_only_where_the_engine_truly_has_no_voice() {
        // The flag drives a "this model cannot speak yet" warning, so a false
        // positive nags on a model that works out of the box. Two invariants:
        // it implies cloning (a row that cannot clone could never satisfy it,
        // which would strand the user), and today exactly one row carries it.
        for m in TTS_CATALOG {
            assert!(
                !m.requires_reference_clip || m.cloning.supports_cloning(),
                "{} demands a reference clip but cannot clone — unsatisfiable",
                m.id
            );
        }
        let flagged: Vec<&str> = TTS_CATALOG
            .iter()
            .filter(|m| m.requires_reference_clip)
            .map(|m| m.id)
            .collect();
        // Pinned by id, not by count: this must be edited deliberately when an
        // engine's fallback behavior changes, and the diff should say which row.
        assert_eq!(
            flagged,
            vec!["audio8-tts-0.6b"],
            "the set of rows with no unconditioned voice changed"
        );
        // The regression this guards: OmniVoice and Audio8 are indistinguishable
        // on `num_voices` + `cloning`, so any attempt to DERIVE the warning from
        // those two fields would fire on OmniVoice, which ships a real voice.
        let omni = find("omnivoice-0.6b").expect("omnivoice entry");
        let audio8 = find("audio8-tts-0.6b").expect("audio8 entry");
        assert_eq!(omni.num_voices, audio8.num_voices);
        assert_eq!(omni.cloning, audio8.cloning);
        assert!(!omni.requires_reference_clip);
        assert!(audio8.requires_reference_clip);
    }

    #[test]
    fn voice_design_budget_is_set_exactly_on_design_rows() {
        // The budget backs BOTH prompt editors — the design prompt (which IS the
        // voice) and the instruct (which sits alongside it) — so it must be set on
        // exactly the rows carrying one of them, and on no others.
        for m in TTS_CATALOG {
            assert_eq!(
                m.voice_design || m.voice_instruct,
                m.voice_design_max_chars > 0,
                "{} disagrees about its prompt budget",
                m.id
            );
            assert!(
                !(m.voice_design && m.voice_instruct),
                "{} claims both — the prompt either IS the voice or accompanies it",
                m.id
            );
        }
        assert_eq!(
            find("qwen3-tts-1.7b-voicedesign")
                .expect("voice-design entry")
                .voice_design_max_chars,
            VOICE_DESIGN_PROMPT_MAX_CHARS
        );
        assert_eq!(
            find("omnivoice-0.6b")
                .expect("instruct entry")
                .voice_design_max_chars,
            VOICE_DESIGN_PROMPT_MAX_CHARS
        );
    }

    /// The two-syntax trap is the whole reason `tag_syntax` exists: Turbo's
    /// `[laugh]` and Orpheus's `<laugh>` are NOT interchangeable, and the wrong
    /// delimiter is read aloud instead of rejected.
    #[test]
    fn tag_syntax_and_vocabulary_agree_and_the_two_styles_are_pinned() {
        for m in TTS_CATALOG {
            assert_eq!(
                m.tag_syntax == TagSyntax::None,
                m.tags.is_empty(),
                "{} disagrees about inline tags",
                m.id
            );
            for tag in m.tags {
                assert!(
                    !tag.contains(['<', '>', '[', ']']),
                    "{}: tags are stored BARE, the syntax adds delimiters",
                    m.id
                );
            }
        }
        let turbo = find("chatterbox-turbo").expect("turbo entry");
        assert_eq!(turbo.tag_syntax, TagSyntax::Square);
        assert_eq!(turbo.tag_syntax.wrap("laugh"), "[laugh]");
        let orpheus = find("orpheus-3b").expect("orpheus entry");
        assert_eq!(orpheus.tag_syntax, TagSyntax::Angle);
        assert_eq!(orpheus.tag_syntax.wrap("laugh"), "<laugh>");
        assert!(TagSyntax::None.delimiters().is_none());
    }

    /// Both NeuCodec rungs are published as `model.onnx` in their own repo, so the LOCAL
    /// names must differ or a quant swap reuses the wrong precision's cached decoder.
    #[test]
    fn neutts_quants_resolve_to_distinct_files_and_decoder_repos() {
        let int8 = neutts_graph_set("int8");
        let fp32 = neutts_graph_set("fp32");
        assert_ne!(int8.backbone, fp32.backbone);
        assert_ne!(int8.codec, fp32.codec);
        assert_ne!(int8.codec_repo, fp32.codec_repo);
        // int8 leads the ladder, so an empty/unknown selection resolves to it.
        assert_eq!(neutts_graph_set(""), int8);
        assert_eq!(neutts_graph_set("q4"), int8);
        assert_eq!(
            find("neutts-2e").expect("neutts entry").default_quant(),
            "int8"
        );
    }

    /// The picker's voice count is a product claim; it must equal the list the engine
    /// actually exposes (4 speakers x 7 emotions), not a rounded number.
    #[test]
    fn neutts_voice_count_matches_the_exposed_voice_list() {
        let entry = find("neutts-2e").expect("neutts entry");
        assert_eq!(
            entry.num_voices as usize,
            crate::winstt::tts::local_engines::NEUTTS_VOICE_INFOS.len()
        );
        assert_eq!(entry.cloning, CloningKind::None);
        assert!(!entry.voice_design);
        assert_eq!(entry.languages, &["en"]);
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
