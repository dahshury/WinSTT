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
    Maya1,
    NeuTts,
    OmniVoice,
    Audio8,
    Paradee,
    Magpie,
    CosyVoice3,
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
            TtsEngineId::Maya1 => "maya1",
            TtsEngineId::NeuTts => "neutts",
            TtsEngineId::OmniVoice => "omnivoice",
            TtsEngineId::Audio8 => "audio8",
            TtsEngineId::Paradee => "paradee",
            TtsEngineId::Magpie => "magpie",
            TtsEngineId::CosyVoice3 => "cosyvoice3",
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
    /// Zero-shot from a reference clip PLUS its transcript — e.g. OmniVoice or
    /// Qwen3-TTS Base. The UI must collect the reference text (auto-transcribed with the
    /// selected STT model into an editable field) alongside the clip.
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
/// catalog — `maya1-3b` emits `<laugh>`, `chatterbox-turbo` emits `[laugh]` —
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
    /// `<laugh>` — Maya1.
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
/// `speech_encoder`, whose output conditions every sentence. So the honest
/// statement is "unconstrained in our code", and 30 s is an editorial choice: it
/// is past the point where more reference audio measurably improves zero-shot
/// timbre, and it keeps the per-sentence prefill bounded.
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
/// the shared log-RTF scale, between qwen3-tts-0.6b (6.3x → 0.10) and maya1-3b
/// (8.5x → 0.06) — while still giving the clone nearly double the 3 s reference the
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
    // Paradee: Kokoro's af_heart distilled into 8M params by its own author-published ONNX
    // (not republished). The smallest + fastest row in the catalog; English, one voice.
    TtsModelEntry {
        id: "paradee-8m",
        engine: TtsEngineId::Paradee,
        display_name: "Paradee 8M",
        maker: "Sahil Mahendrakar",
        hf_repo: "sahilmahendrakar/Paradee-8M-v1.0",
        languages: &["en-us"],
        num_voices: 1,
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 8,
        // onnx/paradee_int8.onnx only — the vocab is Kokoro's (compiled in), and the fp32
        // graph (36,986,117) "sounds the same" per its author, so it is not offered.
        quants: &[TtsQuant {
            id: "int8",
            size_bytes: 9_037_971,
        }],
        quality_score: 0.80,
        speed_score: 0.95,
        description: "Tiny, near-instant American English voice (Kokoro's Heart, distilled).",
    },
    // KittenML 0.8 — three sizes of ONE engine (same graph signature, same 8 voice ids,
    // each repo with its own voices.npz). Replaces the retired nano 0.1/0.2; a persisted
    // old id is migrated to `kitten-nano-0.8` by the settings store.
    TtsModelEntry {
        id: "kitten-nano-0.8",
        engine: TtsEngineId::Kitten,
        display_name: "Kitten TTS Nano",
        maker: "KittenML",
        // The fp32 (default) rung's repo; the int8 rung is a SEPARATE repo — the download
        // manager resolves both through `kitten_files`.
        hf_repo: "KittenML/kitten-tts-nano-0.8-fp32",
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
        // graph + voices.npz (3,278,902) + config.json (688), per rung:
        // int8 graph 24,369,971 (dynamic int8), fp32 graph 56,767,095.
        //
        // fp32 is the default: same WER as int8 (1.2%) but 2.5-4.5x FASTER on CPU — the int8
        // export is dynamic quantization (MatMulInteger/ConvInteger + DynamicQuantizeLinear),
        // which is slow on x86. Measured on 20 sentences, i9-12900KF, onnxruntime 1.24:
        // RTF 0.49 (fp32) vs 2.24 (int8) at default threads, 0.64 vs 1.62 at 4 threads. The
        // engine is CPU-only, and DirectML cannot run the int8 graph anyway (ConvTranspose
        // fails). int8 stays as the smaller download.
        quants: &[
            TtsQuant {
                id: "fp32",
                size_bytes: 60_046_685,
            },
            TtsQuant {
                id: "int8",
                size_bytes: 27_649_561,
            },
        ],
        quality_score: 0.55,
        speed_score: 0.8,
        description: "Small English voice set with 8 voices; quick on any CPU.",
    },
    TtsModelEntry {
        id: "kitten-micro-0.8",
        engine: TtsEngineId::Kitten,
        display_name: "Kitten TTS Micro",
        maker: "KittenML",
        hf_repo: "KittenML/kitten-tts-micro-0.8",
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
        param_count_m: 40,
        // graph 41,384,970 (dynamic int8) + voices.npz 3,278,902 + config.json 473.
        quants: &[TtsQuant {
            id: "int8",
            size_bytes: 44_664_345,
        }],
        quality_score: 0.62,
        speed_score: 0.59,
        description: "Mid-size Kitten: clearer English than Nano with the same 8 voices.",
    },
    TtsModelEntry {
        id: "kitten-mini-0.8",
        engine: TtsEngineId::Kitten,
        display_name: "Kitten TTS Mini",
        maker: "KittenML",
        hf_repo: "KittenML/kitten-tts-mini-0.8",
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
        param_count_m: 80,
        // graph 78,268,016 (dynamic int8) + voices.npz 3,278,902 + config.json 470.
        quants: &[TtsQuant {
            id: "int8",
            size_bytes: 81_547_388,
        }],
        quality_score: 0.68,
        speed_score: 0.45,
        description: "Largest Kitten: the most natural of its 8 English voices.",
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
    // Chatterbox Multilingual V3 (`t3_mtl23ls_v3`) — Resemble's third multilingual T3 on the
    // unchanged V2 architecture, tokenizer vocab and S3Gen decoder. Our own export
    // (Masterx/chatterbox-multilingual-v3-ONNX) of the same four-graph layout and IO contract
    // as the onnx-community V2 export it replaces, so the engine path is unchanged. The
    // repo's `tokenizer.json` carries V3's `NFKD` normalizer (V3 trains on full-case NFKD
    // text; the V2 export's tokenizer fed un-normalized text).
    TtsModelEntry {
        id: "chatterbox-multilingual-v3",
        engine: TtsEngineId::Chatterbox,
        display_name: "Chatterbox Multilingual V3 (voice cloning)",
        maker: "Resemble AI",
        hf_repo: "Masterx/chatterbox-multilingual-v3-ONNX",
        // 20, NOT the model card's 23 — `zh`/`ja`/`he` are dropped. All 23 have a real
        // single-token `[xx]` tag in the shipped tokenizer, but the tag cannot rescue
        // text the vocab has no symbols for: the vocab carries ZERO CJK-Han tokens, so
        // `zh` (upstream converts to Cangjie first) and the kanji half of `ja` are
        // `[UNK]`. Hebrew tokenizes, but undiacritized input (what V3's upstream frontend
        // feeds) came out unintelligible in our measurement (84% CER). `ko` IS spoken:
        // the tokenizer's NFKD normalizer decomposes Hangul syllables into the
        // conjoining jamo the vocab carries. Kept in sync with
        // `local_engines::chatterbox_advertised_languages`, which is the source of truth
        // and is asserted against this row in the tests below.
        languages: &[
            "en", "ar", "da", "de", "el", "es", "fi", "fr", "hi", "it", "ko", "ms", "nl", "no",
            "pl", "pt", "ru", "sv", "sw", "tr",
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
        // EXACT manifest sum (the HF blob bytes of every file `chatterbox_manifest` fetches
        // for the rung; `tts_download_manager`'s size audit pins it): the backbone rung + the
        // three unquantized graphs + tokenizer + default voice.
        quants: &[TtsQuant {
            id: "q4",
            size_bytes: 1_556_285_252,
        }],
        // Same architecture and graph set as the V2 export it replaces (measured warm CPU
        // RTF 3.00 there), so the speed score carries over.
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
        // Turbo is the ONLY square-bracket row; Maya1 below uses angle
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
    // Chatterbox Nano — the 110M end of the family (12-layer GPT-2 backbone, 1-step
    // decoder). ResembleAI publishes the PyTorch weights (`ResembleAI/chatterbox-nano`) but
    // no ONNX, so this is our own export (Masterx/chatterbox-nano-ONNX) in the exact graph
    // layout and IO contract of ResembleAI's official chatterbox-turbo-ONNX: nano shares
    // Turbo's architecture, tokenizer and distilled S3Gen decoder (the repo carries Turbo's
    // official decoder graphs unchanged). Same per-rung suffix scheme as Turbo, except both
    // rungs share the q4 speech encoder and embeddings (fp32 activations in the DSP front end).
    TtsModelEntry {
        id: "chatterbox-nano-v1",
        engine: TtsEngineId::Chatterbox,
        display_name: "Chatterbox Nano (voice cloning)",
        maker: "Resemble AI",
        hf_repo: "Masterx/chatterbox-nano-ONNX",
        languages: &["en"],
        num_voices: 1, // bundled default voice; also clones from a clip
        cloning: CloningKind::ZeroShotAudio,
        // Ships `default_voice.wav`; usable the moment it finishes downloading.
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        // ResembleAI's nano card documents the same native paralinguistic tags as Turbo
        // (one shared tokenizer: `[laugh]`, `[chuckle]`, `[cough]` are single added tokens).
        tag_syntax: TagSyntax::Square,
        tags: &["laugh", "cough", "chuckle"],
        sample_rate: 24_000,
        param_count_m: 110,
        // Exact manifest sums per rung (graphs + tokenizer/configs + default voice); the
        // download manager's size audit pins them. q4f16 is first/default (smallest).
        quants: &[
            TtsQuant {
                id: "q4f16",
                size_bytes: 394_571_922,
            },
            TtsQuant {
                id: "q4",
                size_bytes: 496_225_072,
            },
        ],
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
    // Qwen3-TTS Base 0.6B / 1.7B — the zero-shot CLONING checkpoints of the same family
    // (same graph layout and `inference.py`, driven by `qwen3_tts.rs` in its
    // `CloneReference` mode). The voice comes from a reference clip: its `speaker_encoder`
    // x-vector always conditions the talker, and when the transcript is known the clip's
    // codec codes + transcript are prefilled too (upstream ICL mode) — hence
    // `ZeroShotAudioText`. With no clip the checkpoint speaks its own unconditioned voice,
    // so the clip is not required.
    //
    // Sizes = all EIGHT graphs (the six the talker loop loads + `tok_encoder` and
    // `speaker_encoder`, which the reference path opens on demand) + manifest.json +
    // 4,460,755 bytes of config/tokenizer from the separate `Qwen/...-Base` repo.
    //
    // Measured (int4, `examples/qwen3_tts_clone_check`, 10 English sentences, 8-10 s
    // clips): WER 2.5% (faster-whisper base.en; the residue is "7:15"/"4" digit
    // normalization) and ECAPA cosine 0.55-0.67 to the reference vs -0.07 between the two
    // reference speakers, for both checkpoints. Speed scores are NOT re-derived: the CPU
    // runs shared the box with other builds (warm RTF 32-46, best sentence 5.5 on 0.6B),
    // so the 0.6B row keeps the CustomVoice 0.6B score (same talker, RTF 6.3) and the
    // 1.7B row sits one notch lower.
    TtsModelEntry {
        id: "qwen3-tts-0.6b-base",
        engine: TtsEngineId::Qwen3Tts,
        display_name: "Qwen3-TTS 0.6B Base",
        maker: "Qwen",
        hf_repo: "onnx-community/Qwen3-TTS-12Hz-0.6B-Base",
        languages: &["en", "zh", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"],
        num_voices: 1, // the "default" sentinel; the voice comes from a reference clip
        cloning: CloningKind::ZeroShotAudioText,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 600,
        quants: &[
            TtsQuant {
                id: "int4",
                size_bytes: 1_332_211_875,
            },
            TtsQuant {
                id: "fp16",
                size_bytes: 2_612_126_718,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 4_494_959_009,
            },
        ],
        quality_score: 0.6,
        speed_score: 0.10,
        description: "Clone any voice from a short clip; multilingual, CPU.",
    },
    TtsModelEntry {
        id: "qwen3-tts-1.7b-base",
        engine: TtsEngineId::Qwen3Tts,
        display_name: "Qwen3-TTS 1.7B Base",
        maker: "Qwen",
        hf_repo: "onnx-community/Qwen3-TTS-12Hz-1.7B-Base",
        languages: &["en", "zh", "de", "it", "pt", "es", "ja", "ko", "fr", "ru"],
        num_voices: 1,
        cloning: CloningKind::ZeroShotAudioText,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 24_000,
        param_count_m: 1700,
        quants: &[
            TtsQuant {
                id: "int4",
                size_bytes: 2_015_442_117,
            },
            TtsQuant {
                id: "fp16",
                size_bytes: 4_717_810_206,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 8_693_732_357,
            },
        ],
        quality_score: 0.65,
        speed_score: 0.05,
        description: "Higher-fidelity Qwen3 voice cloning from a short clip; slower.",
    },
    // Maya1 — Maya Research's 3B Llama emitting SNAC codec tokens. There are NO preset speakers: the voice is a natural-language
    // DESCRIPTION, so this is a voice-design row (`tts.voice` holds the description, empty =
    // the engine's default), plus 17 inline emotion tags that the tokenizer maps to single
    // special tokens. Our own export (Masterx/maya1-ONNX, onnxruntime-genai graph, same I/O as
    // the transformers.js decoders); the SNAC vocoder is a SECOND repo
    // (onnx-community/snac_24khz-ONNX — Maya1 uses the same hubertsiuzdak/snac_24khz codec),
    // stitched in the download manifest. Both rungs are CPU graphs (CPU-pinned): the DirectML
    // build (`q4f16`) was exported and dropped — 0.3-2.4 tok/s on an RTX 3080 Ti, slower than CPU.
    //
    // The 4-bit CPU rung is k-quant with the sensitive weights kept wider (int8 `lm_head` +
    // llama.cpp's "mixed" layers, fp16 embedding). Plain RTN int4 (every MatMul + the embedding
    // at 4 bits) kept logits cos ≈ 0.998 yet broke the prompt contract: it READ THE DESCRIPTION
    // ALOUD before the text (WER 2.1 on the gate sentence vs 0.0 for q8).
    TtsModelEntry {
        id: "maya1-3b",
        engine: TtsEngineId::Maya1,
        display_name: "Maya1 3B",
        maker: "Maya Research",
        hf_repo: "Masterx/maya1-ONNX",
        languages: &["en"],
        num_voices: 0, // no preset voices; voice via description
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: true,
        voice_design_max_chars: VOICE_DESIGN_PROMPT_MAX_CHARS,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        // ANGLE brackets — the opposite of Chatterbox Turbo above. Each tag is a single
        // added special token in Maya1's tokenizer (`emotions.txt`), so the wrong delimiter is
        // tokenized as ordinary text and spoken aloud rather than rejected.
        tag_syntax: TagSyntax::Angle,
        tags: &[
            "laugh",
            "laugh_harder",
            "sigh",
            "chuckle",
            "gasp",
            "angry",
            "excited",
            "whisper",
            "cry",
            "scream",
            "sing",
            "snort",
            "exhale",
            "gulp",
            "giggle",
            "sarcastic",
            "curious",
        ],
        sample_rate: 24_000,
        param_count_m: 3_300,
        quants: &[
            TtsQuant {
                id: "q8",
                size_bytes: 4_924_372_175,
            },
            TtsQuant {
                id: "q4",
                size_bytes: 3_766_250_609,
            },
        ],
        // QUALITY MEASURED through the Rust engine (`maya1_synthesizes_audio`, 10 description ×
        // sentence gate cases, faster-whisper base.en): q4 WER 0.039 — 8 of 10 word-perfect, the
        // misses are single-word slips ("clock-breaker"); q8 WER 0.000 (10/10 word-perfect).
        // Before the token budget + re-seed (`maya1.rs`) one q4 case read its description aloud
        // (WER 2.6). Below the word-perfect neutts-2e (0.80) for the q4 slips and the stochastic
        // sampler; above every robotic row for the expressive, described voices and emotion tags.
        //
        // SPEED MEASURED with the same test (i9-12900KF CPU EP, q4, debug test binary, other
        // jobs on the machine): q4 steady RTF 8.2-9.1 per sentence (~10 tok/s; real time needs
        // 86), q8 RTF 10.0-11.2 → 0.06 on the shared log-RTF scale. No usable GPU path (above).
        quality_score: 0.78,
        speed_score: 0.06,
        description: "Describe any English voice in words; inline emotion tags (laugh, sigh, whisper…).",
    },
    // NeuTTS-2e — Neuphonic's expressive English model: a ~236M-param Qwen3 backbone emitting
    // single-codebook NeuCodec tokens, decoded by the NeuCodec decoder from a SECOND repo
    // (neuphonic/neucodec-onnx-decoder[-int8], Apache-2.0), stitched in the download manifest
    // exactly like Maya1 + SNAC. It occupies the same slot as `maya1-3b` above — expressive
    // English with mood control — at a fraction of the download and a ~14x smaller
    // backbone, and unlike Maya1 the mood is a real conditioning token rather than an inline
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
        // 0.20) on the shared log-RTF scale, so it takes the same score — far ahead of
        // `maya1-3b`, the row it competes with (RTF 8.5 → 0.06).
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
    // Magpie-TTS Multilingual 357M (v2607) — NVIDIA's encoder-decoder codec LM: a causal text
    // encoder, a 12-layer decoder steered by an attention prior + CFG, a 2-layer local
    // transformer sampling 8 codebooks x frame-stacking 2 per step, and the NanoCodec 22 kHz
    // decoder. Our own export (Masterx/magpie-tts-multilingual-357m-ONNX); the text frontend
    // is a native port of the NeMo tokenizers (`magpie/text.rs`), which covers 10 of the
    // checkpoint's 12 languages — Mandarin and Japanese need jieba/OpenJTalk segmenters.
    // NOT a cloning model: upstream removed zero-shot cloning; the five speakers are baked
    // context embeddings shipped as `speaker_context.bin`.
    //
    // LICENSE — NVIDIA Open Model License: redistribution and commercial use are allowed if
    // every copy carries the Agreement and a NOTICE reading "Licensed by NVIDIA Corporation
    // under the NVIDIA Open Model License"; the manifest fetches both next to the weights.
    TtsModelEntry {
        id: "magpie-tts-multilingual-357m",
        engine: TtsEngineId::Magpie,
        display_name: "Magpie TTS Multilingual",
        maker: "NVIDIA",
        hf_repo: "Masterx/magpie-tts-multilingual-357m-ONNX",
        languages: &["en", "de", "es", "fr", "it", "pt", "hi", "ar", "ko", "vi"],
        // Aria, Jason, John, Leo, Sofia. Must equal MAGPIE_VOICES.len().
        num_voices: 5,
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 22_050,
        param_count_m: 357,
        // Exact HF blob bytes; see the BLOB_BYTES audit in tts_download_manager.rs.
        quants: &[
            TtsQuant {
                id: "int8",
                size_bytes: 875_467_750,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 1_302_898_993,
            },
        ],
        // Whisper-small WER 0-7% across the ten languages (Hindi 22%, mostly ASR spelling).
        // CPU RTF ~6x at best on a 24-thread box (the fp32 NanoCodec decoder alone is ~2x;
        // 11-19x under load), so it sits beside qwen3-tts-0.6b on the shared log-RTF scale.
        quality_score: 0.80,
        speed_score: 0.08,
        description: "Five NVIDIA voices speaking ten languages, from English to Hindi and Arabic.",
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
        // URL explicitly (same pattern as Maya1/Qwen3).
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
    // Audio8 TTS Preview 0.1B — a compact Falcon-H1 (attention + Mamba) slow AR feeding
    // the same 4-layer fast AR and 44.1 kHz codec family as 0.6B, from Audio8's OFFICIAL
    // INT8 ONNX release. Unlike the 0.6B row this repo SHIPS its reference voice
    // (reference_codes.npy + the manifest transcript), so the DualAR prompt is conditioned
    // out of the box and Read Aloud works the moment the download lands.
    TtsModelEntry {
        id: "audio8-tts-0.1b",
        engine: TtsEngineId::Audio8,
        display_name: "Audio8 TTS 0.1B",
        maker: "Audio8",
        hf_repo: "Edge0/audio8-TTS-0.1B-ONNX-INT8",
        // The same 11 languages the 0.6B Preview card recommends.
        languages: &[
            "en", "cmn", "yue", "nl", "fr", "de", "it", "ja", "ko", "pl", "es",
        ],
        // The single packaged reference voice. Must equal AUDIO8_01_VOICES.len().
        num_voices: 1,
        // The checkpoint IS a zero-shot cloner, but registering a new voice needs the
        // +414 MB codec ENCODER this row does not download — so no cloning is offered and
        // the bundled voice is always present.
        cloning: CloningKind::None,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: 0,
        voice_instruct: false,
        max_ref_clip_secs: 0,
        tag_syntax: TagSyntax::None,
        tags: &[],
        sample_rate: 44_100,
        // ~100M in the AR stack per the model card, plus the shared 44.1 kHz codec.
        param_count_m: 100,
        // Exact HF blob bytes (repo tree API, 2026-08-30) of AUDIO8_01_FILES:
        // runtime_manifest.json 1,424 + slow_ar_int8.onnx 4,820,700 + .data 133,471,232 +
        // fast_ar_int8.onnx 511,306 + .data 36,718,592 + codec_decoder_fp16.onnx 594,319 +
        // .data 260,741,440 + tokenizer/tokenizer.json 5,852,397 + reference_codes.npy
        // 8,928. "int8" is the only precision upstream publishes.
        quants: &[TtsQuant {
            id: "int8",
            size_bytes: 442_720_338,
        }],
        quality_score: 0.80,
        // speed MEASURED with examples/tts_engine_bench (i9-12900KF, warm, 8 intra-op
        // threads): RTF 7.6 (cold 9.3) rendering 3.20 s of audio in 24.4 s. That lands
        // between qwen3-tts-0.6b (6.3x -> 0.10) and omnivoice (~8x -> 0.08) on the shared
        // log-RTF scale. The cost is structural: upstream's hybrid export is a one-token
        // graph INCLUDING prefill, so every sentence pays one Run per prompt token — and
        // the packaged reference alone is 110 of them — before the first frame appears.
        speed_score: 0.09,
        description: "Tiny multilingual 44.1 kHz speech model; works immediately with its built-in voice.",
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
        hf_repo: "Edge0/Audio8-TTS-Preview-0.6B-ONNX-INT4",
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
        // `audio8_int4_session`): RTF 25.0, pinned at the 0.03 floor of the
        // shared log-RTF scale. ORT 1.28's unpacked int4 kernels are ~1.9x faster
        // than 1.24.2's (47.5 → 25.0), so the rc.13 bump still halved this row's cost.
        quality_score: 0.88,
        speed_score: 0.03,
        description: "Clone any voice from a short clip; 11 languages at studio 44.1 kHz. Slow.",
    },
    // Fun-CosyVoice3 0.5B (2512, RL-tuned LLM) — FunAudioLLM/Alibaba, Apache-2.0. Qwen2.5-0.5B
    // speech-token LM -> 10-step DiT flow matching (CFG) -> causal HiFT vocoder, ported in
    // `cosyvoice3.rs`. Zero-shot cloning from a clip; the transcript is OPTIONAL (without it
    // the engine runs upstream's cross-lingual mode), and a free-text style instruction rides
    // alongside the cloned voice (upstream `inference_instruct2`). LLM/embeddings/flow
    // encoder/HiFT come from our export repo; CAM++, the speech tokenizer and the DiT
    // estimator are upstream's own ONNX (see the download manifest).
    TtsModelEntry {
        id: "cosyvoice3-0.5b",
        engine: TtsEngineId::CosyVoice3,
        display_name: "Fun-CosyVoice3 0.5B",
        maker: "FunAudioLLM",
        hf_repo: "Masterx/Fun-CosyVoice3-0.5B-2512-ONNX",
        // The nine languages the model card lists (dialects are reached via instruct).
        languages: &["cmn", "en", "ja", "ko", "de", "es", "fr", "it", "ru"],
        // Two bundled reference voices. Must equal COSYVOICE3_VOICES.len().
        num_voices: 2,
        cloning: CloningKind::ZeroShotAudioText,
        requires_reference_clip: false,
        voice_design: false,
        voice_design_max_chars: VOICE_DESIGN_PROMPT_MAX_CHARS,
        voice_instruct: true,
        // Upstream asserts the speech-tokenizer input is <= 30 s.
        max_ref_clip_secs: MAX_CLONE_REF_SECS,
        tag_syntax: TagSyntax::Square,
        tags: crate::winstt::tts::cosyvoice3::COSYVOICE3_TAGS,
        sample_rate: 24_000,
        // Synthesis path: LLM 364M + text/speech embeddings 142M + DiT 332M + HiFT 21M +
        // flow encoder 1M (the prompt-only speech tokenizer and CAM++ are not counted).
        param_count_m: 860,
        // Each rung = the shared graphs (2,719,705,479 B: our tokenizer/embeddings/flow
        // encoder/HiFT/voices + upstream CAM++/speech tokenizer/DiT) + that LLM and its
        // `.data` sidecar.
        quants: &[
            TtsQuant {
                id: "int8",
                size_bytes: 3_087_006_947,
            },
            TtsQuant {
                id: "q4",
                size_bytes: 2_948_447_124,
            },
            TtsQuant {
                id: "fp32",
                size_bytes: 4_176_516_266,
            },
        ],
        quality_score: 0.93,
        speed_score: 0.10,
        description: "Natural zero-shot voice cloning in 9 languages, with style instructions.",
    },
];

pub fn find(id: &str) -> Option<&'static TtsModelEntry> {
    TTS_CATALOG.iter().find(|m| m.id == id)
}

/// Where a Kitten catalog row's files come from (per quant) and where its graph lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KittenFiles {
    /// HF repo for this rung — KittenML publishes nano's int8 and fp32 as SEPARATE repos.
    /// `voices.npz` + `config.json` come from the same repo as the graph.
    pub repo: &'static str,
    /// Graph filename inside the repo.
    pub remote_graph: &'static str,
    /// Graph filename in the model's cache dir. Quant-suffixed where two rungs share one
    /// cache dir (nano's repos use the same graph name), so a rung switch never loads —
    /// or counts as cached — the other rung's graph.
    pub local_graph: &'static str,
}

/// The Kitten files for a catalog id + quant. Shared by the TTS download manager (file
/// fetch) and `build_local_engine_for` (engine load) so the two never drift apart. An
/// unknown id or quant resolves to nano's default fp32 rung.
pub(crate) fn kitten_files(model_id: &str, quant: &str) -> KittenFiles {
    match (model_id, quant) {
        ("kitten-micro-0.8", _) => KittenFiles {
            repo: "KittenML/kitten-tts-micro-0.8",
            remote_graph: "kitten_tts_micro_v0_8.onnx",
            local_graph: "kitten_tts_micro_v0_8.onnx",
        },
        ("kitten-mini-0.8", _) => KittenFiles {
            repo: "KittenML/kitten-tts-mini-0.8",
            remote_graph: "kitten_tts_mini_v0_8.onnx",
            local_graph: "kitten_tts_mini_v0_8.onnx",
        },
        (_, "int8") => KittenFiles {
            repo: "KittenML/kitten-tts-nano-0.8-int8",
            remote_graph: "kitten_tts_nano_v0_8.onnx",
            local_graph: "kitten_tts_nano_v0_8_int8.onnx",
        },
        _ => KittenFiles {
            repo: "KittenML/kitten-tts-nano-0.8-fp32",
            remote_graph: "kitten_tts_nano_v0_8.onnx",
            local_graph: "kitten_tts_nano_v0_8_fp32.onnx",
        },
    }
}

/// What happens to a persisted `tts.voice` when its catalog row is retired.
pub enum RetiredVoice {
    /// Same voice ids on the replacement: a voice it knows carries over, anything
    /// else becomes `default`.
    KeepKnown {
        known: fn(&str) -> bool,
        default: &'static str,
    },
    /// The retired row's preset ids (or an empty voice) become `"default"`; anything
    /// else is a reference-clip path and is KEPT, as is `cloneRefText`, so a
    /// cloned-voice setup keeps cloning on the new engine.
    ResetPresets(&'static [&'static str]),
    /// Every stored voice is replaced: the old ids mean nothing to the new engine.
    Replace(&'static str),
}

/// A REMOVED local TTS catalog row and the row a persisted selection of it moves to.
pub struct RetiredTtsModel {
    pub retired: &'static str,
    pub replacement: &'static str,
    /// The replacement's quant; `""` = its row default. Never carried over: the
    /// retired row's quant ids need not be on the replacement's ladder, and the
    /// replacement's default is the rung it recommends.
    pub quant: &'static str,
    pub voice: RetiredVoice,
}

fn is_kitten_voice(voice: &str) -> bool {
    super::local_engines::KITTEN_VOICES
        .iter()
        .any(|k| k.id == voice)
}

/// Retired TTS catalog rows — the settings store rewrites a persisted selection
/// through this table at load (`settings_store::migrate_retired_tts_models`).
pub const RETIRED_TTS_MODELS: &[RetiredTtsModel] = &[
    // Kitten nano 0.1/0.2 → nano 0.8: same engine, same 8 `expr-voice-*` ids.
    RetiredTtsModel {
        retired: "kitten-nano-0.1",
        replacement: "kitten-nano-0.8",
        quant: "",
        voice: RetiredVoice::KeepKnown {
            known: is_kitten_voice,
            default: super::kitten::KITTEN_DEFAULT_VOICE,
        },
    },
    RetiredTtsModel {
        retired: "kitten-nano-0.2",
        replacement: "kitten-nano-0.8",
        quant: "",
        voice: RetiredVoice::KeepKnown {
            known: is_kitten_voice,
            default: super::kitten::KITTEN_DEFAULT_VOICE,
        },
    },
    // Spark-TTS 0.5B → Qwen3-TTS 0.6B Base, which clones from the same (clip,
    // transcript) pair Spark used.
    RetiredTtsModel {
        retired: "spark-tts-0.5b",
        replacement: "qwen3-tts-0.6b-base",
        quant: "int4",
        voice: RetiredVoice::ResetPresets(&["female", "male", "default"]),
    },
    // Chatterbox Multilingual V2 → V3 and the owensong nano build → the Masterx nano
    // export: same engine and voice contract (`"default"` or a reference-clip path),
    // so every stored voice is kept.
    RetiredTtsModel {
        retired: "chatterbox-multilingual",
        replacement: "chatterbox-multilingual-v3",
        quant: "q4",
        voice: RetiredVoice::ResetPresets(&[]),
    },
    RetiredTtsModel {
        retired: "chatterbox-nano",
        replacement: "chatterbox-nano-v1",
        quant: "",
        voice: RetiredVoice::ResetPresets(&[]),
    },
    // Orpheus 3B → Maya1 3B: same Llama-3B → SNAC architecture and the same angle-bracket
    // emotion tags, but Maya1 voices are DESCRIBED rather than picked, so the Orpheus
    // preset name (`tara`, `leo`, …) would be read as a one-word description; it becomes
    // Maya1's default (empty = its default description).
    RetiredTtsModel {
        retired: "orpheus-3b",
        replacement: "maya1-3b",
        quant: "",
        voice: RetiredVoice::Replace(""),
    },
];

/// The four Chatterbox ONNX graph basenames (under `onnx/`) for a catalog id + quant.
///
/// Each Chatterbox export chooses its quant suffix PER GRAPH, so a single global
/// suffix cannot address them: `chatterbox-nano-v1` MIXES precisions within a rung
/// (both rungs share the q4 speech encoder + embeddings, only the backbone and decoder
/// follow the rung), and the multilingual export quantizes only its backbone.
/// Shared by the TTS download manager (file fetch) and `build_local_engine_for`
/// (session load) so the two never drift apart — same contract as
/// [`kitten_files`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChatterboxGraphSet {
    pub speech_encoder: &'static str,
    pub embed_tokens: &'static str,
    pub language_model: &'static str,
    pub conditional_decoder: &'static str,
}

pub(crate) fn chatterbox_graph_set(model_id: &str, quant: &str) -> ChatterboxGraphSet {
    match model_id {
        // Our export (Masterx/chatterbox-nano-ONNX): the backbone and the (Turbo-official)
        // decoder follow the rung; the speech encoder and embeddings are the q4 graphs on
        // both rungs, which keeps the encoder's STFT/mel front end in fp32.
        "chatterbox-nano-v1" => match quant {
            "q4" => ChatterboxGraphSet {
                speech_encoder: "speech_encoder_q4.onnx",
                embed_tokens: "embed_tokens_q4.onnx",
                language_model: "language_model_q4.onnx",
                conditional_decoder: "conditional_decoder_q4.onnx",
            },
            // q4f16 is first/default (smallest); unknown ids fall through to it.
            _ => ChatterboxGraphSet {
                speech_encoder: "speech_encoder_q4.onnx",
                embed_tokens: "embed_tokens_q4.onnx",
                language_model: "language_model_q4f16.onnx",
                conditional_decoder: "conditional_decoder_q4f16.onnx",
            },
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
        // chatterbox-multilingual-v3 (and any future default): only the backbone is
        // quantized (the V2 onnx-community layout); the other three are the base graphs.
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

/// Files of the CosyVoice3 row every quant shares, fetched from OUR export repo
/// (`Masterx/Fun-CosyVoice3-0.5B-2512-ONNX`): tokenizer, the two embedding tables, the
/// flow encoder, the HiFT vocoder and the bundled reference voices.
pub(crate) const COSYVOICE3_EXPORT_FILES: &[&str] = &[
    "tokenizer.json",
    "text_embedding_fp16.onnx",
    "speech_embedding.onnx",
    "flow_encoder.onnx",
    "hift.onnx",
    "voices/zh-female.wav",
    "voices/en-male.wav",
];

/// Graphs upstream `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` already ships as usable ONNX —
/// fetched from there (not republished): CAM++ speaker encoder, the S3 speech tokenizer
/// and the DiT flow estimator.
pub(crate) const COSYVOICE3_UPSTREAM_REPO: &str = "FunAudioLLM/Fun-CosyVoice3-0.5B-2512";
pub(crate) const COSYVOICE3_UPSTREAM_FILES: &[&str] = &[
    "campplus.onnx",
    "speech_tokenizer_v3.onnx",
    "flow.decoder.estimator.fp32.onnx",
];

/// The quant-dependent CosyVoice3 files (the LLM graph + its external-data sidecar). Shared
/// by the download manifest and `CosyVoice3LocalEngine` so they cannot drift (same contract
/// as [`chatterbox_graph_set`]). Unknown ids fall through to the default int8 rung.
pub(crate) fn cosyvoice3_graph_set(quant: &str) -> crate::winstt::tts::cosyvoice3::CosyVoice3Files {
    let llm = match quant {
        "fp32" => "llm.onnx",
        "q4" => "llm_q4.onnx",
        _ => "llm_int8.onnx",
    };
    crate::winstt::tts::cosyvoice3::CosyVoice3Files {
        llm,
        estimator: "flow.decoder.estimator.fp32.onnx",
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

/// The Maya1 decoder graph (basename under `onnx/`, no extension) for a quant rung, plus every
/// external-data shard it references. Shared by the TTS download manager (file fetch) and
/// `Maya1LocalEngine` (session load) so the two never drift apart — same contract as
/// [`chatterbox_graph_set`]. Unknown ids fall through to the default `q8` rung.
pub(crate) fn maya1_graph(quant: &str) -> &'static str {
    match quant {
        "q4" => "model_q4",
        _ => "model_q8",
    }
}

/// Repo-relative files of one Maya1 rung (graph + external-data shards), see [`maya1_graph`].
pub(crate) fn maya1_graph_files(quant: &str) -> &'static [&'static str] {
    match maya1_graph(quant) {
        "model_q4" => &[
            "onnx/model_q4.onnx",
            "onnx/model_q4.onnx_data",
            "onnx/model_q4.onnx_data_1",
        ],
        _ => &[
            "onnx/model_q8.onnx",
            "onnx/model_q8.onnx_data",
            "onnx/model_q8.onnx_data_1",
            "onnx/model_q8.onnx_data_2",
        ],
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
    fn kitten_is_the_0_8_family_only() {
        let kitten: Vec<&str> = TTS_CATALOG
            .iter()
            .filter(|m| m.engine == TtsEngineId::Kitten)
            .map(|m| m.id)
            .collect();
        assert_eq!(
            kitten,
            vec!["kitten-nano-0.8", "kitten-micro-0.8", "kitten-mini-0.8"]
        );
        // Bigger model ⇒ more parameters and a bigger smallest download, never fewer.
        // (Nano's DEFAULT fp32 rung outweighs micro's int8-only graph, so compare the
        // smallest rung of each.)
        let sizes: Vec<(u32, u64)> = kitten
            .iter()
            .map(|id| {
                let m = find(id).unwrap();
                let smallest = m.quants.iter().map(|q| q.size_bytes).min().unwrap();
                (m.param_count_m, smallest)
            })
            .collect();
        assert!(sizes.windows(2).all(|w| w[0].0 < w[1].0 && w[0].1 < w[1].1));
        // Nano defaults to its fp32 rung (faster on CPU than the dynamic-int8 one).
        assert_eq!(find("kitten-nano-0.8").unwrap().default_quant(), "fp32");
    }

    #[test]
    fn retired_tts_rows_point_at_live_rows() {
        for r in RETIRED_TTS_MODELS {
            let (old, new) = (r.retired, r.replacement);
            assert!(find(old).is_none(), "{old} is retired but still listed");
            assert!(
                RETIRED_TTS_MODELS.iter().all(|o| o.retired != new),
                "{old} → {new}: the replacement is itself retired"
            );
            let row = find(new).unwrap_or_else(|| panic!("{old} → {new}: no such row"));
            assert!(
                r.quant.is_empty() || row.quant(r.quant).is_some(),
                "{new} lacks {}",
                r.quant
            );
            if let RetiredVoice::KeepKnown { known, default } = r.voice {
                assert!(
                    known(default),
                    "{old}: default voice {default} is not known"
                );
            }
        }
        assert_eq!(
            find("kitten-nano-0.8").map(|r| r.engine),
            Some(TtsEngineId::Kitten)
        );
    }

    #[test]
    fn kitten_files_resolve_per_rung() {
        let int8 = kitten_files("kitten-nano-0.8", "int8");
        let fp32 = kitten_files("kitten-nano-0.8", "fp32");
        assert_eq!(int8.repo, "KittenML/kitten-tts-nano-0.8-int8");
        assert_eq!(fp32.repo, "KittenML/kitten-tts-nano-0.8-fp32");
        // Same remote name, distinct local names: the two rungs share one cache dir.
        assert_eq!(int8.remote_graph, fp32.remote_graph);
        assert_ne!(int8.local_graph, fp32.local_graph);
        // Empty/unknown quant → the default fp32 rung.
        assert_eq!(kitten_files("kitten-nano-0.8", ""), fp32);
        assert_eq!(
            kitten_files("kitten-mini-0.8", "int8").repo,
            find("kitten-mini-0.8").unwrap().hf_repo
        );
        assert_eq!(
            kitten_files("kitten-micro-0.8", "").repo,
            find("kitten-micro-0.8").unwrap().hf_repo
        );
        assert_eq!(fp32.repo, find("kitten-nano-0.8").unwrap().hf_repo);
    }

    #[test]
    fn paradee_is_a_tiny_single_voice_english_row() {
        let m = find("paradee-8m").expect("paradee row");
        assert_eq!(m.engine.as_str(), "paradee");
        assert_eq!(m.languages, &["en-us"]);
        assert_eq!(
            m.num_voices as usize,
            crate::winstt::tts::local_engines::PARADEE_VOICES.len()
        );
        assert_eq!(
            m.sample_rate,
            crate::winstt::tts::paradee::PARADEE_SAMPLE_RATE
        );
        // The smallest download in the catalog.
        let bytes = |m: &TtsModelEntry| m.quant(m.default_quant()).unwrap().size_bytes;
        assert!(
            TTS_CATALOG
                .iter()
                .all(|o| o.id == m.id || bytes(o) > bytes(m))
        );
    }

    /// The V3 export keeps the V2 onnx-community file layout: only the backbone carries
    /// a quant suffix.
    #[test]
    fn multilingual_v3_graph_set_quantizes_only_the_backbone() {
        let g = chatterbox_graph_set("chatterbox-multilingual-v3", "q4");
        assert_eq!(g.speech_encoder, "speech_encoder.onnx");
        assert_eq!(g.embed_tokens, "embed_tokens.onnx");
        assert_eq!(g.language_model, "language_model_q4.onnx");
        assert_eq!(g.conditional_decoder, "conditional_decoder.onnx");
        // An unknown/empty quant still resolves to the shipped default backbone.
        assert_eq!(
            chatterbox_graph_set("chatterbox-multilingual-v3", "").language_model,
            "language_model_q4.onnx"
        );
    }

    /// Nano's rungs mix precisions (shared q4 encoder/embeddings, per-rung backbone and
    /// decoder); a single global quant suffix could not name these four files.
    #[test]
    fn nano_graph_set_mixes_precisions() {
        let g = chatterbox_graph_set("chatterbox-nano-v1", "q4f16");
        assert_eq!(g.speech_encoder, "speech_encoder_q4.onnx");
        assert_eq!(g.embed_tokens, "embed_tokens_q4.onnx");
        assert_eq!(g.language_model, "language_model_q4f16.onnx");
        assert_eq!(g.conditional_decoder, "conditional_decoder_q4f16.onnx");
        let q4 = chatterbox_graph_set("chatterbox-nano-v1", "q4");
        assert_eq!(q4.language_model, "language_model_q4.onnx");
        assert_eq!(q4.conditional_decoder, "conditional_decoder_q4.onnx");
        assert_eq!(q4.speech_encoder, g.speech_encoder);
        assert_eq!(
            find("chatterbox-nano-v1")
                .expect("nano entry")
                .default_quant(),
            "q4f16"
        );
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

    /// The two Base checkpoints are the family's cloning rows: clip + optional transcript
    /// (ICL when present), one "default" sentinel voice, and a real unconditioned voice
    /// so no clip is demanded. Spark-TTS — the row they replace — must stay gone.
    #[test]
    fn qwen3_base_rows_clone_from_a_clip_and_transcript() {
        for (id, params) in [("qwen3-tts-0.6b-base", 600), ("qwen3-tts-1.7b-base", 1700)] {
            let entry = find(id).unwrap_or_else(|| panic!("{id} catalog row"));
            assert_eq!(entry.engine, TtsEngineId::Qwen3Tts);
            assert_eq!(entry.cloning, CloningKind::ZeroShotAudioText);
            assert!(!entry.requires_reference_clip);
            assert!(!entry.voice_design);
            assert!(!entry.voice_instruct);
            assert_eq!(entry.param_count_m, params);
            assert_eq!(entry.sample_rate, 24_000);
            assert_eq!(entry.default_quant(), "int4");
            assert_eq!(
                entry.quants.iter().map(|q| q.id).collect::<Vec<_>>(),
                ["int4", "fp16", "fp32"]
            );
            assert_eq!(
                entry.num_voices as usize,
                crate::winstt::tts::local_engines::QWEN3TTS_BASE_VOICES.len()
            );
            assert!(entry.hf_repo.starts_with("onnx-community/Qwen3-TTS-12Hz-"));
            assert!(entry.hf_repo.ends_with("-Base"));
        }
        assert!(find("spark-tts-0.5b").is_none());
        assert!(TTS_CATALOG.iter().all(|m| m.engine.as_str() != "spark"));
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
            reference_clip_cap_secs("chatterbox-multilingual-v3"),
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
    /// model card's 23: `zh`/`ja` tokenize to `[UNK]` in the shipped vocab no matter which
    /// `[xx]` tag is prefixed, because the Cangjie / kanji→kana frontends they need are not
    /// in this app; `he` tokenizes but is unintelligible without a diacritizer. The engine
    /// module owns that classification; this test is the wire that stops the catalog row
    /// from drifting away from it.
    #[test]
    fn chatterbox_multilingual_advertises_exactly_what_the_engine_can_speak() {
        let entry = find("chatterbox-multilingual-v3").expect("multilingual row");
        assert_eq!(
            entry.languages,
            crate::winstt::tts::local_engines::chatterbox_advertised_languages().as_slice(),
        );
        assert_eq!(entry.languages.len(), 20);
        for code in ["zh", "ja", "he"] {
            assert!(
                !entry.languages.contains(&code),
                "{code} needs a text frontend this app does not ship"
            );
        }
        // The other Chatterbox exports are English-only and must not inherit the list.
        for id in ["chatterbox-turbo", "chatterbox-nano-v1"] {
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
    fn audio8_preview_01_ships_its_voice_and_points_at_the_official_repo() {
        let entry = find("audio8-tts-0.1b").expect("Audio8 0.1B catalog row");
        assert_eq!(entry.engine, TtsEngineId::Audio8);
        assert_eq!(
            entry.num_voices as usize,
            crate::winstt::tts::local_engines::AUDIO8_01_VOICES.len()
        );
        // The packaged reference voice is what makes this row usable with no clip; the
        // 0.6B row next to it is the one that needs one.
        assert_eq!(entry.cloning, CloningKind::None);
        assert!(!entry.requires_reference_clip);
        assert_eq!(entry.default_quant(), "int8");
        // Audio8's OFFICIAL INT8 export, which superseded WinSTT's community conversion.
        assert_eq!(entry.hf_repo, "Edge0/audio8-TTS-0.1B-ONNX-INT8");
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
    /// `[laugh]` and Maya1's `<laugh>` are NOT interchangeable, and the wrong
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
        let maya1 = find("maya1-3b").expect("maya1 entry");
        assert_eq!(maya1.tag_syntax, TagSyntax::Angle);
        assert_eq!(maya1.tag_syntax.wrap("laugh"), "<laugh>");
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

    /// Every Maya1 rung resolves to a distinct graph, and the download list carries exactly
    /// that graph plus its external data — the engine loads `onnx/{graph}.onnx`.
    #[test]
    fn maya1_rungs_resolve_to_their_own_graph_files() {
        let maya1 = find("maya1-3b").expect("maya1 entry");
        assert!(maya1.voice_design && maya1.num_voices == 0);
        let mut graphs: Vec<&str> = maya1.quants.iter().map(|q| maya1_graph(q.id)).collect();
        graphs.dedup();
        assert_eq!(graphs.len(), maya1.quants.len(), "two rungs share a graph");
        for q in maya1.quants {
            let g = maya1_graph(q.id);
            let files = maya1_graph_files(q.id);
            assert_eq!(files[0], format!("onnx/{g}.onnx"));
            assert!(
                files[1..]
                    .iter()
                    .all(|f| f.starts_with(&format!("onnx/{g}.onnx_data")))
            );
        }
        assert_eq!(maya1_graph("bogus"), maya1_graph(maya1.default_quant()));
    }
}
