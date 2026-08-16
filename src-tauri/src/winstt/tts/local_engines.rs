// TtsEngine adapters for the new local ONNX engines (Kitten / Piper / Supertonic),
// mirroring KokoroLocalEngine: wrap the concrete engine, map errors into TtsError,
// and expose the engine's voice catalog. The manager selects one of these by the
// catalog entry's TtsEngineId. Asset download is the manager's responsibility
// (the underlying engine errors `AssetsMissing` until files are on disk).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::audio8::{AUDIO8_SAMPLE_RATE, Audio8Engine};
use super::catalog;
use super::chatterbox::{
    CHATTERBOX_SAMPLE_RATE, ChatterboxConfig, ChatterboxEngine, ChatterboxGraphs,
};
use super::kitten::{KITTEN_SAMPLE_RATE, KittenConfig, KittenEngine};
use super::neutts::{NEUTTS_SAMPLE_RATE, NeuTtsEngine};
use super::omnivoice::{OMNIVOICE_SAMPLE_RATE, OmniVoiceEngine};
use super::orpheus::{ORPHEUS_SAMPLE_RATE, OrpheusEngine};
use super::piper::{PiperConfig, PiperEngine};
use super::qwen3_tts::{QWEN3TTS_SAMPLE_RATE, Qwen3TtsEngine, Qwen3TtsVoiceMode};
use super::spark::{SPARK_SAMPLE_RATE, SparkEngine};
use super::supertonic::{
    SUPERTONIC_DEFAULT_VOICE, SUPERTONIC_SAMPLE_RATE, SUPERTONIC_SPEED_MAX, SUPERTONIC_SPEED_MIN,
    SupertonicConfig, SupertonicEngine,
};
use super::{Gender, SentenceAudio, TtsDevice, TtsEngine, TtsError, TtsResult, VoiceInfo};

// ---------------------------------------------------------------------------
// Per-engine voice catalogs
// ---------------------------------------------------------------------------

/// KittenTTS nano 8 voices (English). Internal ids are the npz keys.
pub const KITTEN_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        id: "expr-voice-2-f",
        label: "Kitten 2 (Female)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "expr-voice-3-f",
        label: "Kitten 3 (Female)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "expr-voice-4-f",
        label: "Kitten 4 (Female)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "expr-voice-5-f",
        label: "Kitten 5 (Female)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "expr-voice-2-m",
        label: "Kitten 2 (Male)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "expr-voice-3-m",
        label: "Kitten 3 (Male)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "expr-voice-4-m",
        label: "Kitten 4 (Male)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "expr-voice-5-m",
        label: "Kitten 5 (Male)",
        language: "en-us",
        gender: Gender::Male,
    },
];

/// Supertonic 3 preset style voices. Speech language is selected separately.
pub const SUPERTONIC_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        id: "M3",
        label: "Robert (M3)",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M1",
        label: "Alex (M1)",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M2",
        label: "James (M2)",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M4",
        label: "Sam (M4)",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M5",
        label: "Daniel (M5)",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "F1",
        label: "Sarah (F1)",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F2",
        label: "Lily (F2)",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F3",
        label: "Jessica (F3)",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F4",
        label: "Olivia (F4)",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F5",
        label: "Emily (F5)",
        language: "en",
        gender: Gender::Female,
    },
];

/// One curated Piper voice in the `rhasspy/piper-voices` repo. Piper is exposed as
/// a SINGLE catalog model ("piper") whose voice list spans many languages; each
/// voice is its own `{stem}.onnx` + `{stem}.onnx.json` fetched ON-DEMAND when the
/// user selects it (see `TtsDownloadManager::ensure_voice`) — so the catalog grows
/// the language coverage without bundling a single byte into the exe.
///
/// `stem` is the Piper voice basename (also the renderer-selected voice id, e.g.
/// `de_DE-thorsten-high`); `subdir` is its HF directory prefix
/// (`<family>/<lang_COUNTRY>/<name>/<quality>`), so the two files live at
/// `<subdir>/<stem>.onnx[.json]`. `language` is mapped to our app lang codes where
/// one of the 9 Kokoro codes fits, else the lowercased `lang-country`. The Piper
/// ENGINE phonemizes via the voice's own `espeak.voice` (read from the `.onnx.json`),
/// so `language` here is display-only and never feeds `espeak_lang_for`.
#[derive(Clone, Copy, Debug)]
pub struct PiperVoiceDef {
    pub stem: &'static str,
    pub subdir: &'static str,
    pub label: &'static str,
    pub language: &'static str,
}

const fn p(
    stem: &'static str,
    subdir: &'static str,
    label: &'static str,
    language: &'static str,
) -> PiperVoiceDef {
    PiperVoiceDef {
        stem,
        subdir,
        label,
        language,
    }
}

/// The default Piper voice (kept working as the original single-voice entry).
pub const PIPER_DEFAULT_VOICE: &str = "en_US-lessac-medium";

/// Curated Piper voices: one good voice per language-country, preferring quality
/// high then medium then low; 48 languages. `en_US-lessac-medium` is first (the
/// default). Generated from `rhasspy/piper-voices`/`voices.json` (MIT). `pt_PT` was
/// dropped because its only voice's HF path carries a non-ASCII char that needs
/// URL-encoding (pt_BR already covers Portuguese).
#[rustfmt::skip]
pub const PIPER_VOICES: &[PiperVoiceDef] = &[
    p("en_US-lessac-medium", "en/en_US/lessac/medium", "English — Lessac (medium)", "en-us"),
    p("ar_JO-kareem-medium", "ar/ar_JO/kareem/medium", "Arabic — Kareem (medium)", "ar-jo"),
    p("bg_BG-dimitar-medium", "bg/bg_BG/dimitar/medium", "Bulgarian — Dimitar (medium)", "bg-bg"),
    p("ca_ES-upc_ona-medium", "ca/ca_ES/upc_ona/medium", "Catalan — Upc Ona (medium)", "ca-es"),
    p("cs_CZ-jirka-medium", "cs/cs_CZ/jirka/medium", "Czech — Jirka (medium)", "cs-cz"),
    p("cy_GB-bu_tts-medium", "cy/cy_GB/bu_tts/medium", "Welsh — Bu Tts (medium)", "cy-gb"),
    p("da_DK-talesyntese-medium", "da/da_DK/talesyntese/medium", "Danish — Talesyntese (medium)", "da-dk"),
    p("de_DE-thorsten-high", "de/de_DE/thorsten/high", "German — Thorsten (high)", "de-de"),
    p("el_GR-rapunzelina-medium", "el/el_GR/rapunzelina/medium", "Greek — Rapunzelina (medium)", "el-gr"),
    p("en_GB-cori-high", "en/en_GB/cori/high", "English — Cori (high)", "en-gb"),
    p("es_AR-daniela-high", "es/es_AR/daniela/high", "Spanish — Daniela (high)", "es"),
    p("es_ES-davefx-medium", "es/es_ES/davefx/medium", "Spanish — Davefx (medium)", "es"),
    p("es_MX-claude-high", "es/es_MX/claude/high", "Spanish — Claude (high)", "es"),
    p("eu_ES-antton-medium", "eu/eu_ES/antton/medium", "Basque — Antton (medium)", "eu-es"),
    p("fa_IR-amir-medium", "fa/fa_IR/amir/medium", "Farsi — Amir (medium)", "fa-ir"),
    p("fi_FI-harri-medium", "fi/fi_FI/harri/medium", "Finnish — Harri (medium)", "fi-fi"),
    p("fr_FR-mls-medium", "fr/fr_FR/mls/medium", "French — Mls (medium)", "fr"),
    p("hi_IN-pratham-medium", "hi/hi_IN/pratham/medium", "Hindi — Pratham (medium)", "hi"),
    p("hu_HU-anna-medium", "hu/hu_HU/anna/medium", "Hungarian — Anna (medium)", "hu-hu"),
    p("id_ID-news_tts-medium", "id/id_ID/news_tts/medium", "Indonesian — News Tts (medium)", "id-id"),
    p("is_IS-bui-medium", "is/is_IS/bui/medium", "Icelandic — Bui (medium)", "is-is"),
    p("it_IT-paola-medium", "it/it_IT/paola/medium", "Italian — Paola (medium)", "it"),
    p("ka_GE-natia-medium", "ka/ka_GE/natia/medium", "Georgian — Natia (medium)", "ka-ge"),
    p("kk_KZ-issai-high", "kk/kk_KZ/issai/high", "Kazakh — Issai (high)", "kk-kz"),
    p("ku_TR-berfin_renas-medium", "ku/ku_TR/berfin_renas/medium", "Kurmanji Kurdish — Berfin Renas (medium)", "ku-tr"),
    p("lb_LU-marylux-medium", "lb/lb_LU/marylux/medium", "Luxembourgish — Marylux (medium)", "lb-lu"),
    p("lv_LV-aivars-medium", "lv/lv_LV/aivars/medium", "Latvian — Aivars (medium)", "lv-lv"),
    p("ml_IN-arjun-medium", "ml/ml_IN/arjun/medium", "Malayalam — Arjun (medium)", "ml-in"),
    p("ne_NP-chitwan-medium", "ne/ne_NP/chitwan/medium", "Nepali — Chitwan (medium)", "ne-np"),
    p("nl_BE-nathalie-medium", "nl/nl_BE/nathalie/medium", "Dutch — Nathalie (medium)", "nl-be"),
    p("nl_NL-alex-medium", "nl/nl_NL/alex/medium", "Dutch — Alex (medium)", "nl-nl"),
    p("no_NO-talesyntese-medium", "no/no_NO/talesyntese/medium", "Norwegian — Talesyntese (medium)", "no-no"),
    p("pl_PL-bass-high", "pl/pl_PL/bass/high", "Polish — Bass (high)", "pl-pl"),
    p("pt_BR-cadu-medium", "pt/pt_BR/cadu/medium", "Portuguese — Cadu (medium)", "pt-br"),
    p("ro_RO-mihai-medium", "ro/ro_RO/mihai/medium", "Romanian — Mihai (medium)", "ro-ro"),
    p("ru_RU-denis-medium", "ru/ru_RU/denis/medium", "Russian — Denis (medium)", "ru-ru"),
    p("sk_SK-lili-medium", "sk/sk_SK/lili/medium", "Slovak — Lili (medium)", "sk-sk"),
    p("sl_SI-artur-medium", "sl/sl_SI/artur/medium", "Slovenian — Artur (medium)", "sl-si"),
    p("sq_AL-edon-medium", "sq/sq_AL/edon/medium", "Albanian — Edon (medium)", "sq-al"),
    p("sr_RS-serbski_institut-medium", "sr/sr_RS/serbski_institut/medium", "Serbian — Serbski Institut (medium)", "sr-rs"),
    p("sv_SE-alma-medium", "sv/sv_SE/alma/medium", "Swedish — Alma (medium)", "sv-se"),
    p("sw_CD-lanfrica-medium", "sw/sw_CD/lanfrica/medium", "Swahili — Lanfrica (medium)", "sw-cd"),
    p("te_IN-maya-medium", "te/te_IN/maya/medium", "Telugu — Maya (medium)", "te-in"),
    p("tr_TR-dfki-medium", "tr/tr_TR/dfki/medium", "Turkish — Dfki (medium)", "tr-tr"),
    p("uk_UA-mykyta-high", "uk/uk_UA/mykyta/high", "Ukrainian — Mykyta (high)", "uk-ua"),
    p("ur_PK-fasih-medium", "ur/ur_PK/fasih/medium", "Urdu — Fasih (medium)", "ur-pk"),
    p("vi_VN-vais1000-medium", "vi/vi_VN/vais1000/medium", "Vietnamese — Vais1000 (medium)", "vi-vn"),
    p("zh_CN-chaowen-medium", "zh/zh_CN/chaowen/medium", "Chinese — Chaowen (medium)", "cmn"),
];

/// Look up a Piper voice definition by its stem (= voice id).
pub fn piper_voice_def(stem: &str) -> Option<&'static PiperVoiceDef> {
    PIPER_VOICES.iter().find(|v| v.stem == stem)
}

/// The Piper voice catalog projected to `VoiceInfo` for the picker. Gender is not
/// reliably published by Piper, so every voice reports `Female` (display-only).
pub fn piper_voice_infos() -> Vec<VoiceInfo> {
    PIPER_VOICES
        .iter()
        .map(|v| VoiceInfo {
            id: v.stem,
            label: v.label,
            language: v.language,
            gender: Gender::Female,
        })
        .collect()
}

/// Chatterbox is cloning-based: a single "default" entry (the bundled default
/// voice). A reference-clip picker can later set the voice to a wav path.
pub const CHATTERBOX_VOICES: &[VoiceInfo] = &[VoiceInfo {
    id: "default",
    label: "Default voice (or clone from a clip)",
    language: "en-us",
    gender: Gender::Female,
}];

// ---------------------------------------------------------------------------
// Chatterbox multilingual language tags
// ---------------------------------------------------------------------------

/// Why a `[xx]` tag may or may not be usable for real text.
///
/// Every variant below has a REAL single-token `[xx]` entry in the shipped
/// `chatterbox-multilingual` `tokenizer.json` — the classification is about what
/// happens to the TEXT after the tag, not about the tag itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChatterboxLangSupport {
    /// The tag is a single token AND the vocab can represent the language's script,
    /// so plain text from the app tokenizes with no `[UNK]`. Safe to advertise.
    Supported,
    /// The tag is a single token, but the script needs a text frontend this app does
    /// not ship. The payload names the missing frontend. MUST NOT be advertised: the
    /// tag alone cannot rescue text the vocab has no symbols for.
    NeedsFrontend(&'static str),
    /// The tag is a single token, but the language is not on the upstream model
    /// card's trained list, so we route it if asked and never advertise it.
    Untrained,
}

/// `chatterbox-multilingual` language tags, VERIFIED against the shipped
/// `tokenizer.json` (2,454 entries) rather than assumed: each `[xx]` below is one
/// token whose id is quoted, and `[zz]`/`[th]`/`[uk]`/`[fa]` (absent) shatter into
/// `[` + letters + `]` instead. The prompt is `[tag]` + text — see
/// `ChatterboxLocalEngine::synthesize_sentence`.
///
/// The four `NeedsFrontend` rows are measured, not guessed. Tokenizing native-script
/// samples through the real vocab gives:
///   * zh — 0 CJK-Han tokens exist at all; every hanzi is `[UNK]`. Upstream converts
///     to Cangjie first, which is what the vocab's 40 `[cj_*]` tokens are for.
///   * ja — kana are present (137 tokens) but kanji are `[UNK]` (same missing Han
///     block), so real Japanese needs a kana/romaji frontend (pykakasi).
///   * ko — 256 conjoining-jamo tokens but only 10 precomposed Hangul syllables, so
///     ordinary Korean is `[UNK]` until it is decomposed to jamo.
///   * he — letters tokenize, but the vocab carries 24 niqqud marks, i.e. the model
///     was trained on DIACRITIZED Hebrew; undiacritized input is ambiguous and
///     upstream runs a dicta diacritizer first.
const CHATTERBOX_LANGUAGES: &[(&str, ChatterboxLangSupport)] = &[
    // ── on the upstream model card's 23-language list ────────────────────────
    ("en", ChatterboxLangSupport::Supported), // 708
    ("ar", ChatterboxLangSupport::Supported), // 721
    ("da", ChatterboxLangSupport::Supported), // 715
    ("de", ChatterboxLangSupport::Supported), // 636
    ("el", ChatterboxLangSupport::Supported), // 711
    ("es", ChatterboxLangSupport::Supported), // 635
    ("fi", ChatterboxLangSupport::Supported), // 2107
    ("fr", ChatterboxLangSupport::Supported), // 634
    (
        "he",
        ChatterboxLangSupport::NeedsFrontend("niqqud diacritization (dicta)"),
    ), // 2110
    ("hi", ChatterboxLangSupport::Supported), // 722
    ("it", ChatterboxLangSupport::Supported), // 637
    (
        "ja",
        ChatterboxLangSupport::NeedsFrontend("kanji→kana (pykakasi)"),
    ), // 723
    (
        "ko",
        ChatterboxLangSupport::NeedsFrontend("Hangul→jamo decomposition"),
    ), // 724
    ("ms", ChatterboxLangSupport::Supported), // 2109
    ("nl", ChatterboxLangSupport::Supported), // 709
    ("no", ChatterboxLangSupport::Supported), // 714
    ("pl", ChatterboxLangSupport::Supported), // 717
    ("pt", ChatterboxLangSupport::Supported), // 710
    ("ru", ChatterboxLangSupport::Supported), // 716
    ("sv", ChatterboxLangSupport::Supported), // 713
    ("sw", ChatterboxLangSupport::Supported), // 730
    ("tr", ChatterboxLangSupport::Supported), // 712
    ("zh", ChatterboxLangSupport::NeedsFrontend("hanzi→Cangjie")), // 725
    // ── tags the vocab carries but the model card does not claim ─────────────
    ("bg", ChatterboxLangSupport::Untrained), // 727
    ("cs", ChatterboxLangSupport::Untrained), // 719
    ("hu", ChatterboxLangSupport::Untrained), // 720
    ("ro", ChatterboxLangSupport::Untrained), // 726
    ("sk", ChatterboxLangSupport::Untrained), // 718
    ("ta", ChatterboxLangSupport::Untrained), // 2108
    ("vi", ChatterboxLangSupport::Untrained), // 732
    ("ea", ChatterboxLangSupport::Untrained), // 729
];

/// Codes this app emits that are not the tag's spelling. `cmn` is espeak's Mandarin
/// (it is what `SUPPORTED_LANGUAGES` uses), `nb`/`nn` are the two written Norwegians
/// the single `[no]` tag covers, and `iw` is the legacy ISO code for Hebrew.
const CHATTERBOX_LANGUAGE_ALIASES: &[(&str, &str)] = &[
    ("cmn", "zh"),
    ("yue", "zh"),
    ("zho", "zh"),
    ("nb", "no"),
    ("nn", "no"),
    ("nob", "no"),
    ("nno", "no"),
    ("iw", "he"),
];

/// EN-first fallback: an empty (warm-up), unrecognised, or region-only language code
/// keeps the behaviour the engine shipped with rather than dropping the tag, because
/// the multilingual export is always tagged.
const CHATTERBOX_DEFAULT_LANGUAGE_TAG: &str = "en";

/// Reduce an app language code to its primary subtag: `en-US` / `en_us` / ` EN ` → `en`.
/// Both separators are in play (`SUPPORTED_LANGUAGES` uses `pt-br`, Piper uses `en_US`).
fn primary_subtag(code: &str) -> String {
    code.trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// The `[tag]` to prefix for `code`, or `None` when the tokenizer has no single-token
/// tag for it. Returns a tag for `zh`/`ja`/`ko`/`he` too: those cannot be ADVERTISED
/// (see [`chatterbox_advertised_languages`]), but if a caller asks for one anyway the
/// correct tag is strictly better conditioning than silently claiming English.
fn chatterbox_language_tag(code: &str) -> Option<&'static str> {
    let key = primary_subtag(code);
    let key = CHATTERBOX_LANGUAGE_ALIASES
        .iter()
        .find(|(from, _)| *from == key)
        .map_or(key.as_str(), |(_, to)| *to);
    CHATTERBOX_LANGUAGES
        .iter()
        .find(|(c, _)| *c == key)
        .map(|(c, _)| *c)
}

/// The languages `chatterbox-multilingual` can HONESTLY be advertised with: an
/// upstream-trained language whose text this app can actually tokenize.
///
/// This is what `catalog.rs`'s `chatterbox-multilingual` row must carry in its
/// `languages:` field. It is 19, not the 23 on the upstream model card, because
/// `zh`/`ja`/`ko`/`he` need script frontends this app does not ship (see
/// [`ChatterboxLangSupport::NeedsFrontend`]) — the tag is real, the text is not
/// representable. Re-check this function before widening that row.
pub fn chatterbox_advertised_languages() -> Vec<&'static str> {
    CHATTERBOX_LANGUAGES
        .iter()
        .filter(|(_, s)| matches!(s, ChatterboxLangSupport::Supported))
        .map(|(c, _)| *c)
        .collect()
}

/// Qwen3-TTS Voice Design has NO preset voices: the voice is described by a
/// natural-language prompt (stored in `tts.voice`). We surface a single "Default"
/// entry as the empty-prompt affordance (empty prompt → model's default voice).
pub const QWEN3TTS_VOICES: &[VoiceInfo] = &[VoiceInfo {
    id: "",
    label: "Default voice (or describe one with a prompt)",
    language: "en",
    gender: Gender::Female,
}];

/// Qwen3-TTS CustomVoice's 9 premium preset timbres. Ids are the `talker_config.spk_id`
/// keys the engine looks up (lowercase); labels and native languages are the model
/// card's own descriptions — Qwen recommends each speaker in its native language.
/// NOTE this checkpoint is preset-timbre + style-instruct, NOT clone-from-a-clip.
pub const QWEN3TTS_CUSTOMVOICE_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        id: "vivian",
        label: "Vivian — bright young female",
        language: "zh",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "serena",
        label: "Serena — warm, gentle young female",
        language: "zh",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "uncle_fu",
        label: "Uncle Fu — seasoned, mellow male",
        language: "zh",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "dylan",
        label: "Dylan — youthful Beijing male",
        language: "zh",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "eric",
        label: "Eric — lively Chengdu male",
        language: "zh",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "ryan",
        label: "Ryan — dynamic male with rhythm",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "aiden",
        label: "Aiden — sunny American male",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "ono_anna",
        label: "Ono Anna — playful Japanese female",
        language: "ja",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sohee",
        label: "Sohee — warm Korean female",
        language: "ko",
        gender: Gender::Female,
    },
];

// ---------------------------------------------------------------------------
// Kitten
// ---------------------------------------------------------------------------

pub struct KittenLocalEngine {
    engine: KittenEngine,
}
impl KittenLocalEngine {
    /// `model_filename` is the per-model graph name on HF (`kitten_tts_nano_v0_1.onnx`
    /// for nano-0.1, `kitten_tts_nano_v0_2.onnx` for nano-0.2) — both share the same
    /// `voices.npz` voice set and input signature, so only the graph file differs.
    pub fn new(cache_dir: PathBuf, model_filename: impl Into<String>) -> Self {
        Self {
            engine: KittenEngine::new(KittenConfig {
                cache_dir,
                model_filename: model_filename.into(),
                device: TtsDevice::Cpu,
                ..Default::default()
            }),
        }
    }
}
impl TtsEngine for KittenLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        let samples = self
            .engine
            .synthesize(text, voice, lang, speed)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: KITTEN_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        KITTEN_VOICES.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.is_ready()
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.engine
            .warm_up()
            .map_err(|e| TtsError::Engine(e.to_string()))
    }
    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Supertonic
// ---------------------------------------------------------------------------

pub struct SupertonicLocalEngine {
    engine: SupertonicEngine,
}
impl SupertonicLocalEngine {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            engine: SupertonicEngine::new(SupertonicConfig { cache_dir }),
        }
    }
}
impl TtsEngine for SupertonicLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        let voice = if voice.is_empty() {
            SUPERTONIC_DEFAULT_VOICE
        } else {
            voice
        };
        let samples = self
            .engine
            .synthesize(text, voice, lang, speed)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: SUPERTONIC_SAMPLE_RATE,
        })
    }
    fn speed_range(&self) -> (f32, f32) {
        (SUPERTONIC_SPEED_MIN, SUPERTONIC_SPEED_MAX)
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        SUPERTONIC_VOICES.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.is_ready()
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.engine
            .warm_up()
            .map_err(|e| TtsError::Engine(e.to_string()))
    }
    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Piper (ONE catalog model spanning many languages; one PiperEngine per voice
// stem, created lazily as the user selects a voice)
// ---------------------------------------------------------------------------

/// Piper as a single multilingual catalog model. Each voice (`tts.voice` = a Piper
/// stem like `de_DE-thorsten-high`) is its own `{stem}.onnx` + `{stem}.onnx.json`
/// living flat under the shared `cache_dir`; a `PiperEngine` is created (and its
/// ORT session loaded) lazily on first use of that voice and cached for reuse.
/// The download manager fetches each voice's two files on-demand (no bundling).
pub struct PiperLocalEngine {
    cache_dir: PathBuf,
    /// stem → loaded `PiperEngine` (lazily inserted on first use of that voice).
    engines: Mutex<HashMap<String, Arc<PiperEngine>>>,
}
impl PiperLocalEngine {
    /// `cache_dir` holds `{stem}.onnx` + `{stem}.onnx.json` for every used voice.
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            engines: Mutex::new(HashMap::new()),
        }
    }

    /// The voice stem to use for a requested `voice` id: the id when it's a known
    /// Piper voice, else the default (so a stale/empty selection still speaks).
    fn resolve_stem(voice: &str) -> String {
        if piper_voice_def(voice).is_some() {
            voice.to_string()
        } else {
            PIPER_DEFAULT_VOICE.to_string()
        }
    }

    /// Run `f` against the (lazily created) `PiperEngine` for `stem`.
    fn with_engine<T>(
        &self,
        stem: &str,
        f: impl FnOnce(&PiperEngine) -> TtsResult<T>,
    ) -> TtsResult<T> {
        let engine = {
            let mut map = self
                .engines
                .lock()
                .map_err(|_| TtsError::Engine("piper engine map poisoned".into()))?;
            map.entry(stem.to_string())
                .or_insert_with(|| {
                    Arc::new(PiperEngine::new(PiperConfig {
                        cache_dir: self.cache_dir.clone(),
                        voice_stem: stem.to_string(),
                    }))
                })
                .clone()
        };
        f(engine.as_ref())
    }
}
impl TtsEngine for PiperLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        // Piper's "voice" selects WHICH `{stem}.onnx` to load; each Piper voice is a
        // separate VITS model file, so a per-call voice picks (and lazily warms) its
        // own `PiperEngine`. The engine phonemizes via the voice's own espeak id.
        let stem = Self::resolve_stem(voice);
        let (samples, sample_rate) = self.with_engine(&stem, |engine| {
            engine
                .synthesize(text, speed)
                .map_err(|e| TtsError::Engine(e.to_string()))
        })?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        piper_voice_infos()
    }
    fn is_ready(&self) -> bool {
        // Ready once ANY voice engine has loaded (warm_up loads the default voice).
        self.engines
            .lock()
            .is_ok_and(|m| m.values().any(|e| e.is_ready()))
    }
    fn warm_up(&self) -> TtsResult<()> {
        // Warm the default voice so the first read has a session ready; other voices
        // warm lazily on first selection.
        self.with_engine(PIPER_DEFAULT_VOICE, |engine| {
            engine
                .warm_up()
                .map_err(|e| TtsError::Engine(e.to_string()))
        })
    }
    fn shutdown(&self) {
        if let Ok(map) = self.engines.lock() {
            for engine in map.values() {
                engine.shutdown();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Chatterbox (voice cloning; autoregressive LLM-codec, 4 sessions)
// ---------------------------------------------------------------------------

pub struct ChatterboxLocalEngine {
    engine: ChatterboxEngine,
    /// Only the multilingual export takes a `[lang]` tag; turbo/nano are English-only
    /// exports whose reference scripts tokenize raw text. Drives the per-call prefix.
    tagged: bool,
}
impl ChatterboxLocalEngine {
    /// One adapter for all three Chatterbox exports. The per-graph quant filenames come
    /// from `catalog::chatterbox_graph_set` — the same function the download manifest
    /// uses, so the fetched files and the opened sessions can never drift. The two
    /// non-introspectable differences are set here:
    ///   * multilingual prefixes the prompt with a `[lang]` tag chosen PER CALL from the
    ///     caller's language (see `synthesize_sentence`); turbo/nano are English-only
    ///     exports whose reference scripts tokenize raw text;
    ///   * turbo/nano append 3 silence codec tokens so their one-step distilled decoder
    ///     resolves the final phoneme instead of clipping it.
    ///
    /// Everything else (layer count, KV heads/dim, KV element type, which optional inputs
    /// each graph takes) is read off the loaded graphs by the engine.
    pub fn new(cache_dir: PathBuf, model_id: &str, quant: &str) -> Self {
        let set = catalog::chatterbox_graph_set(model_id, quant);
        let is_multilingual = model_id == "chatterbox-multilingual";
        Self {
            engine: ChatterboxEngine::new(ChatterboxConfig {
                cache_dir,
                graphs: ChatterboxGraphs {
                    speech_encoder: set.speech_encoder.to_string(),
                    embed_tokens: set.embed_tokens.to_string(),
                    language_model: set.language_model.to_string(),
                    conditional_decoder: set.conditional_decoder.to_string(),
                },
                // Deliberately OFF for every export, multilingual included: the engine's
                // config tag is a per-SESSION constant, but the language is a per-CALL
                // argument, so this adapter owns the prefix (`chatterbox_prompt` below).
                // Leaving it Some(..) here would double-prefix into `[en][fr]…`.
                language_tag: None,
                trailing_silence_tokens: if is_multilingual { 0 } else { 3 },
                // Multilingual ONLY. The bundled `default_voice.wav` is clipped (peak
                // 1.0802) and that is what mangles sentence openings there — measured
                // 0/10 clean renders of the pangram, 10/10 after rescaling to peak 0.30.
                // Turbo REGRESSED under the same gate (`shells` 0.000 -> 0.214) and nano
                // was unchanged, so both keep a bit-identical reference path.
                attenuate_hot_reference: is_multilingual,
            }),
            tagged: is_multilingual,
        }
    }

    /// The prompt handed to the engine: `[tag]text` on the multilingual export, raw
    /// `text` on turbo/nano.
    ///
    /// `text` is trimmed FIRST so the result is byte-identical to what the engine
    /// builds for a config-level tag (it trims before prefixing), and whitespace-only
    /// input is passed through untouched so the engine's empty-input short-circuit
    /// still fires instead of synthesizing a bare `[en]`.
    fn chatterbox_prompt(&self, text: &str, lang: &str) -> String {
        let trimmed = text.trim();
        if !self.tagged || trimmed.is_empty() {
            return text.to_string();
        }
        let tag = chatterbox_language_tag(lang).unwrap_or(CHATTERBOX_DEFAULT_LANGUAGE_TAG);
        format!("[{tag}]{trimmed}")
    }
}
impl TtsEngine for ChatterboxLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        // `voice` is either "default"/"" (bundled default voice) or a path to a
        // reference WAV to clone from (set by a future reference-clip picker).
        let ref_path =
            if !voice.is_empty() && voice != "default" && std::path::Path::new(voice).exists() {
                Some(std::path::Path::new(voice))
            } else {
                None
            };
        let prompt = self.chatterbox_prompt(text, lang);
        let samples = self
            .engine
            .synthesize(&prompt, ref_path, 0.5)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: CHATTERBOX_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        CHATTERBOX_VOICES.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.is_ready()
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.engine
            .warm_up()
            .map_err(|e| TtsError::Engine(e.to_string()))
    }
    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Qwen3-TTS Voice Design (autoregressive LLM-codec; voice via text prompt)
// ---------------------------------------------------------------------------

pub struct Qwen3TtsLocalEngine {
    engine: Qwen3TtsEngine,
    voice_mode: Qwen3TtsVoiceMode,
}
impl Qwen3TtsLocalEngine {
    /// `quant` selects the on-disk weights subdir (`int4`|`fp16`|`fp32`; the
    /// engine maps it to `cpu_int4`|`cpu_fp16`|`cpu_fp32`). Passed through from the
    /// manager's `tts.quantization` (default `int4`). `voice_mode` decides how
    /// `tts.voice` is read: a design prompt (VoiceDesign) or a preset timbre name
    /// (CustomVoice) — see [`Qwen3TtsVoiceMode`].
    pub fn new(cache_dir: PathBuf, quant: String, voice_mode: Qwen3TtsVoiceMode) -> Self {
        Self {
            engine: Qwen3TtsEngine::new(cache_dir, quant, voice_mode),
            voice_mode,
        }
    }
}
impl TtsEngine for Qwen3TtsLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        // Both checkpoints overload `voice`, exactly as Chatterbox overloads it for the
        // ref-clip path: Voice Design reads it as the design PROMPT (natural-language
        // voice description), Custom Voice as one of its 9 preset timbre names. Empty is
        // valid either way — the model falls back to its own default voice.
        let samples = self
            .engine
            .synthesize(text, voice, lang, speed)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: QWEN3TTS_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        match self.voice_mode {
            Qwen3TtsVoiceMode::PresetSpeaker => QWEN3TTS_CUSTOMVOICE_VOICES.to_vec(),
            Qwen3TtsVoiceMode::DesignPrompt => QWEN3TTS_VOICES.to_vec(),
        }
    }
    fn is_ready(&self) -> bool {
        self.engine.is_ready()
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.engine
            .warm_up()
            .map_err(|e| TtsError::Engine(e.to_string()))
    }
    fn shutdown(&self) {
        self.engine.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Orpheus (3B Llama → SNAC codec; 8 preset English voices w/ emotion tags)
// ---------------------------------------------------------------------------

/// The 8 fine-tuned Orpheus voices (canopylabs card). `tara` is the recommended default.
pub const ORPHEUS_VOICE_INFOS: &[VoiceInfo] = &[
    VoiceInfo {
        id: "tara",
        label: "Tara",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "leah",
        label: "Leah",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "jess",
        label: "Jess",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "mia",
        label: "Mia",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "zoe",
        label: "Zoe",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "leo",
        label: "Leo",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "dan",
        label: "Dan",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "zac",
        label: "Zac",
        language: "en",
        gender: Gender::Male,
    },
];

pub struct OrpheusLocalEngine {
    cache_dir: PathBuf,
    engine: Mutex<Option<OrpheusEngine>>,
}
impl OrpheusLocalEngine {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            engine: Mutex::new(None),
        }
    }
    fn ensure_loaded(&self) -> TtsResult<()> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("orpheus lock poisoned".into()))?;
        if guard.is_none() {
            let eng = OrpheusEngine::load(
                &self.cache_dir.join("onnx/model_q4.onnx"),
                &self.cache_dir.join("snac/decoder_model.onnx"),
                &self.cache_dir.join("tokenizer.json"),
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
            *guard = Some(eng);
        }
        Ok(())
    }
}
impl TtsEngine for OrpheusLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        self.ensure_loaded()?;
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("orpheus lock poisoned".into()))?;
        let eng = guard
            .as_mut()
            .ok_or_else(|| TtsError::Engine("orpheus not loaded".into()))?;
        let out = eng
            .synthesize(text, voice, 0.6)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        // A runaway decode still yields audio, but it is salvage, not a normal render — say so
        // rather than handing back ~30 s of degenerate buzz as if the sentence had rendered.
        if !out.stop.is_clean() {
            log::warn!(
                "[tts] orpheus decode did not terminate cleanly (voice={voice}, stop={:?}, \
                 tokens={}, {:.2}s) — audio salvaged from a runaway",
                out.stop,
                out.tokens,
                out.samples.len() as f32 / ORPHEUS_SAMPLE_RATE as f32
            );
        }
        Ok(SentenceAudio::F32le {
            samples: out.samples,
            sample_rate: ORPHEUS_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        ORPHEUS_VOICE_INFOS.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.lock().is_ok_and(|g| g.is_some())
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_loaded()
    }
    fn shutdown(&self) {
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Spark-TTS (Qwen0.5B → BiCodec; voice creation by gender)
// ---------------------------------------------------------------------------

/// Spark voice-creation presets — the timbre is generated; gender steers it.
pub const SPARK_VOICE_INFOS: &[VoiceInfo] = &[
    VoiceInfo {
        id: "female",
        label: "Female",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "male",
        label: "Male",
        language: "en",
        gender: Gender::Male,
    },
];

pub struct SparkLocalEngine {
    cache_dir: PathBuf,
    /// Reference-clip transcript (settings.tts.clone_ref_text) — used when `voice` is a ref path.
    clone_ref_text: String,
    engine: Mutex<Option<SparkEngine>>,
}
impl SparkLocalEngine {
    pub fn new(cache_dir: PathBuf, clone_ref_text: String) -> Self {
        Self {
            cache_dir,
            clone_ref_text,
            engine: Mutex::new(None),
        }
    }
    fn ensure_loaded(&self) -> TtsResult<()> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("spark lock poisoned".into()))?;
        if guard.is_none() {
            let mut eng = SparkEngine::load(
                &self.cache_dir.join("model_q4.onnx"),
                &self.cache_dir.join("bicodec.onnx"),
                &self.cache_dir.join("tokenizer.json"),
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
            // Attach the cloning graphs when present (downloaded by the Spark manifest).
            let w2v = self.cache_dir.join("wav2vec2_model_fp16.onnx");
            if w2v.exists() {
                eng.load_cloning(
                    &w2v,
                    &self.cache_dir.join("mel_spectrogram.onnx"),
                    &self.cache_dir.join("speaker_encoder_tokenizer.onnx"),
                    &self.cache_dir.join("bicodec_encoder_quantizer.onnx"),
                )
                .map_err(|e| TtsError::Engine(e.to_string()))?;
            }
            *guard = Some(eng);
        }
        Ok(())
    }
}
impl TtsEngine for SparkLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        self.ensure_loaded()?;
        // A `voice` that resolves to an existing file is a CLONE reference clip; a preset
        // ("female"/"male"/"") is voice creation.
        let ref_path =
            (!voice.is_empty() && std::path::Path::new(voice).is_file()).then(|| voice.to_string());
        // Capped, not rejected: wav2vec2's attention is quadratic in clip length
        // AND the resulting semantic tokens are prepended to EVERY sentence's
        // prompt, so an uncapped clip taxes the whole read.
        let ref16k = match &ref_path {
            Some(p) => Some(
                crate::winstt::managers::transcode::decode_reference_clip(
                    std::path::Path::new(p),
                    SPARK_SAMPLE_RATE,
                    crate::winstt::tts::catalog::MAX_CLONE_REF_SECS,
                )
                .map(|clip| clip.samples)
                .map_err(TtsError::Engine)?,
            ),
            None => None,
        };
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("spark lock poisoned".into()))?;
        let eng = guard
            .as_mut()
            .ok_or_else(|| TtsError::Engine("spark not loaded".into()))?;
        let samples = match ref16k {
            Some(ref16k) => {
                if !eng.cloning_ready() {
                    return Err(TtsError::Engine(
                        "Spark cloning graphs not downloaded for this model".into(),
                    ));
                }
                eng.synthesize_clone(text, &ref16k, &self.clone_ref_text)
                    .map_err(|e| TtsError::Engine(e.to_string()))?
            }
            None => {
                let gender = if voice.is_empty() { "female" } else { voice };
                eng.synthesize(text, gender)
                    .map_err(|e| TtsError::Engine(e.to_string()))?
            }
        };
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: SPARK_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        SPARK_VOICE_INFOS.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.lock().is_ok_and(|g| g.is_some())
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_loaded()
    }
    fn shutdown(&self) {
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------
// NeuTTS-2e (Qwen3 backbone -> NeuCodec; 4 fixed speakers x 7 emotions)
// ---------------------------------------------------------------------------

/// The 4 x 7 speaker/emotion cross product, flattened to `{speaker}-{emotion}` ids.
///
/// NeuTTS-2e conditions on a FIXED pre-encoded speaker reference and takes the mood as a
/// separate control token, so "voice" in this engine is really a (speaker, emotion) pair.
/// Flattening it here keeps the shared voice dropdown as the only UI: no second selector,
/// no new settings field, and a persisted id round-trips through `neutts::parse_voice`.
/// The catalog's `num_voices` is pinned to this length by a test.
pub const NEUTTS_VOICE_INFOS: &[VoiceInfo] = &[
    VoiceInfo {
        id: "emily-neutral",
        label: "Emily — Neutral",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-angry",
        label: "Emily — Angry",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-disgusted",
        label: "Emily — Disgusted",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-fearful",
        label: "Emily — Fearful",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-happy",
        label: "Emily — Happy",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-sad",
        label: "Emily — Sad",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "emily-surprised",
        label: "Emily — Surprised",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "paul-neutral",
        label: "Paul — Neutral",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-angry",
        label: "Paul — Angry",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-disgusted",
        label: "Paul — Disgusted",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-fearful",
        label: "Paul — Fearful",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-happy",
        label: "Paul — Happy",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-sad",
        label: "Paul — Sad",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "paul-surprised",
        label: "Paul — Surprised",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "sophie-neutral",
        label: "Sophie — Neutral",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-angry",
        label: "Sophie — Angry",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-disgusted",
        label: "Sophie — Disgusted",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-fearful",
        label: "Sophie — Fearful",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-happy",
        label: "Sophie — Happy",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-sad",
        label: "Sophie — Sad",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "sophie-surprised",
        label: "Sophie — Surprised",
        language: "en",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "steven-neutral",
        label: "Steven — Neutral",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-angry",
        label: "Steven — Angry",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-disgusted",
        label: "Steven — Disgusted",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-fearful",
        label: "Steven — Fearful",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-happy",
        label: "Steven — Happy",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-sad",
        label: "Steven — Sad",
        language: "en",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "steven-surprised",
        label: "Steven — Surprised",
        language: "en",
        gender: Gender::Male,
    },
];

/// NeuTTS-2e adapter. Two sessions (backbone + NeuCodec decoder) loaded lazily from the
/// per-model cache dir; `quant` picks the rung via `catalog::neutts_graph_set`, the same
/// mapping the download manifest fetches through.
pub struct NeuTtsLocalEngine {
    cache_dir: PathBuf,
    quant: String,
    engine: Mutex<Option<NeuTtsEngine>>,
}
impl NeuTtsLocalEngine {
    pub fn new(cache_dir: PathBuf, quant: String) -> Self {
        Self {
            cache_dir,
            quant,
            engine: Mutex::new(None),
        }
    }
    fn ensure_loaded(&self) -> TtsResult<()> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("neutts lock poisoned".into()))?;
        if guard.is_none() {
            let set = catalog::neutts_graph_set(&self.quant);
            let eng = NeuTtsEngine::load(
                &self.cache_dir.join(set.backbone),
                &self.cache_dir.join(set.codec),
                &self.cache_dir.join("tokenizer.json"),
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
            *guard = Some(eng);
        }
        Ok(())
    }
}
impl TtsEngine for NeuTtsLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        self.ensure_loaded()?;
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("neutts lock poisoned".into()))?;
        let eng = guard
            .as_mut()
            .ok_or_else(|| TtsError::Engine("neutts not loaded".into()))?;
        // `speed` is ignored: the backbone has no duration control and resampling an AR
        // codec stream would pitch-shift it. English-only, so `lang` is ignored too.
        let samples = eng
            .synthesize(text, voice)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: NEUTTS_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        NEUTTS_VOICE_INFOS.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.lock().is_ok_and(|g| g.is_some())
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_loaded()
    }
    fn shutdown(&self) {
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------
// OmniVoice (Qwen3-0.6B masked-refinement -> Higgs codec; clone from a clip)
// ---------------------------------------------------------------------------

/// OmniVoice has no preset voices — the voice comes from a reference clip. One sentinel
/// entry, exactly like CHATTERBOX_VOICES. Must equal the catalog row's `num_voices`.
pub const OMNIVOICE_VOICES: &[VoiceInfo] = &[VoiceInfo {
    id: "default",
    label: "Default voice (or clone from a clip)",
    language: "en-us",
    gender: Gender::Female,
}];

/// This engine's catalog row id, so the reference trim below can ask
/// [`catalog::reference_clip_cap_secs`] for THIS row's cap instead of the shared
/// default. A typo here would silently fall back to 30 s — six times the measured
/// budget — so `omnivoice_trims_the_reference_at_its_own_row_cap` pins it.
const OMNIVOICE_MODEL_ID: &str = "omnivoice-0.6b";

pub struct OmniVoiceLocalEngine {
    cache_dir: PathBuf,
    /// Reference-clip transcript (settings.tts.clone_ref_text) — used when `voice` is a
    /// reference-clip path. Part of the engine fingerprint, so editing it rebuilds.
    clone_ref_text: String,
    /// Style instruction (settings.tts.voice_instruct) filling the prompt's
    /// `<|instruct_start|>…<|instruct_end|>` span. Blank emits the trained `None`
    /// sentinel. Part of the engine fingerprint, so editing it rebuilds.
    voice_instruct: String,
    engine: Mutex<Option<OmniVoiceEngine>>,
}

impl OmniVoiceLocalEngine {
    pub fn new(cache_dir: PathBuf, clone_ref_text: String, voice_instruct: String) -> Self {
        Self {
            cache_dir,
            clone_ref_text,
            voice_instruct,
            engine: Mutex::new(None),
        }
    }

    /// Loads the step graph + codec decoder ONLY. The three encode-only graphs
    /// (655 MB, `semantic_encoder` alone is 436 MB) are loaded on demand by the
    /// reference path and dropped as soon as the codes exist.
    fn ensure_loaded(&self) -> TtsResult<()> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("omnivoice lock poisoned".into()))?;
        if guard.is_none() {
            let eng = OmniVoiceEngine::load(
                &self.cache_dir.join("omnivoice_step.onnx"),
                &self
                    .cache_dir
                    .join("audio_tokenizer")
                    .join("higgs_decoder.onnx"),
                &self.cache_dir.join("tokenizer.json"),
                &self.cache_dir,
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
            *guard = Some(eng);
        }
        Ok(())
    }
}

impl TtsEngine for OmniVoiceLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        self.ensure_loaded()?;
        // A `voice` that resolves to an existing file is a CLONE reference clip; the
        // "default" sentinel is the no-reference path.
        let ref_path =
            (!voice.is_empty() && std::path::Path::new(voice).is_file()).then(|| voice.to_string());
        // Capped, not rejected. OmniVoice's native rate IS 24 kHz, so unlike Spark there is
        // no resample on this branch at all.
        //
        // The cap is THIS ROW'S (5 s), not the shared 30 s: the masked-refinement step is
        // O(num_step * L^2) with L including the reference frames, so every sentence of the
        // whole read pays for the clip. Clip *preparation* is already row-aware, but a clip
        // prepared while a 30 s-capped model was selected reaches this engine at full
        // length once the user switches, so the trim has to re-assert the row's budget.
        let clip = match &ref_path {
            Some(p) => Some(
                crate::winstt::managers::transcode::decode_reference_clip(
                    std::path::Path::new(p),
                    OMNIVOICE_SAMPLE_RATE,
                    catalog::reference_clip_cap_secs(OMNIVOICE_MODEL_ID),
                )
                .map_err(TtsError::Engine)?,
            ),
            None => None,
        };
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("omnivoice lock poisoned".into()))?;
        let eng = guard
            .as_mut()
            .ok_or_else(|| TtsError::Engine("omnivoice not loaded".into()))?;
        let reference = match (&ref_path, &clip) {
            (Some(path), Some(clip)) => {
                if !eng.cloning_ready() {
                    return Err(TtsError::Engine(
                        "OmniVoice audio-tokenizer graphs not downloaded for this model".into(),
                    ));
                }
                Some(
                    eng.ensure_reference(
                        &clip.samples,
                        std::path::Path::new(path),
                        &self.clone_ref_text,
                    )
                    .map_err(|e| TtsError::Engine(e.to_string()))?,
                )
            }
            _ => None,
        };
        // `speed` is ignored: OmniVoice has no rate knob. (Its `frames` count is close to
        // one, but scaling it also scales L, which the O(num_step * L^2) cost model makes
        // a quality/latency trade rather than a pure speed control — left for a follow-up.)
        // `lang` IS used, unlike the other cloning engines: it fills the <|lang_start|> slot.
        let instruct = {
            let t = self.voice_instruct.trim();
            (!t.is_empty()).then_some(t)
        };
        let samples = eng
            .synthesize(text, lang, reference.as_ref(), instruct)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: OMNIVOICE_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        OMNIVOICE_VOICES.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.lock().is_ok_and(|g| g.is_some())
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_loaded()
    }
    fn shutdown(&self) {
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Audio8 TTS Preview 0.6B (DualAR slow/fast AR -> 44.1 kHz codec; clone from a clip)
// ---------------------------------------------------------------------------

/// Audio8 has no preset voices — the voice comes from a reference clip. One sentinel
/// entry, exactly like OmniVoice. Must equal the catalog row's `num_voices`.
pub const AUDIO8_VOICES: &[VoiceInfo] = &[VoiceInfo {
    id: "default",
    label: "Cloned voice (add a reference clip)",
    language: "en",
    gender: Gender::Female,
}];

/// This engine's catalog row id — the reference trim asks the catalog for THIS row's
/// cap so a future per-row tightening (like OmniVoice's) takes effect here for free.
const AUDIO8_MODEL_ID: &str = "audio8-tts-0.6b";

pub struct Audio8LocalEngine {
    cache_dir: PathBuf,
    /// Reference-clip transcript (settings.tts.clone_ref_text) — the DualAR prompt
    /// interleaves it with the clip's codec codes, so cloning cannot work without it.
    /// Part of the engine fingerprint, so editing it rebuilds.
    clone_ref_text: String,
    engine: Mutex<Option<Audio8Engine>>,
}

impl Audio8LocalEngine {
    pub fn new(cache_dir: PathBuf, clone_ref_text: String) -> Self {
        Self {
            cache_dir,
            clone_ref_text,
            engine: Mutex::new(None),
        }
    }

    /// Loads the slow/fast AR graphs + codec decoder + tokenizer. The 414 MB
    /// registration ENCODER is not touched here — `ensure_reference` loads it on
    /// demand and drops it as soon as the reference codes exist.
    fn ensure_loaded(&self) -> TtsResult<()> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("audio8 lock poisoned".into()))?;
        if guard.is_none() {
            let eng = Audio8Engine::load(
                &self.cache_dir.join("slow_ar_int4.onnx"),
                &self.cache_dir.join("fast_ar_int4.onnx"),
                &self.cache_dir.join("codec_decoder_fp16.onnx"),
                &self.cache_dir.join("tokenizer").join("tokenizer.json"),
                &self.cache_dir,
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
            *guard = Some(eng);
        }
        Ok(())
    }
}

impl TtsEngine for Audio8LocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        _speed: f32,
    ) -> TtsResult<SentenceAudio> {
        self.ensure_loaded()?;
        // A `voice` that resolves to an existing file is the CLONE reference clip.
        // Unlike OmniVoice there is NO unconditioned path: the DualAR prompt REQUIRES
        // reference codes (upstream's PromptBuilder rejects an empty Speech span), so
        // the "default" sentinel without a clip is an instructive error, not silence.
        let ref_path =
            (!voice.is_empty() && std::path::Path::new(voice).is_file()).then(|| voice.to_string());
        let Some(ref_path) = ref_path else {
            return Err(TtsError::Invalid(
                "Audio8 clones from a reference clip — add one (with its transcript) in \
                 the voice settings."
                    .into(),
            ));
        };
        if self.clone_ref_text.trim().is_empty() {
            return Err(TtsError::Invalid(
                "Audio8 needs the reference clip's transcript — fill (or auto-transcribe) \
                 the reference text field."
                    .into(),
            ));
        }
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| TtsError::Engine("audio8 lock poisoned".into()))?;
        let eng = guard
            .as_mut()
            .ok_or_else(|| TtsError::Engine("audio8 not loaded".into()))?;
        // Decoding is DEFERRED into `ensure_reference`, which runs it only when both the
        // in-memory and on-disk caches miss — i.e. once per clip rather than once per
        // sentence. Capped at THIS row's budget (30 s, matching upstream's registration
        // limit); clips are trimmed, not rejected. Decoded at the codec's native 44.1 kHz.
        let clip_path = ref_path.clone();
        let reference = eng
            .ensure_reference(
                std::path::Path::new(&ref_path),
                &self.clone_ref_text,
                || {
                    crate::winstt::managers::transcode::decode_reference_clip(
                        std::path::Path::new(&clip_path),
                        AUDIO8_SAMPLE_RATE,
                        catalog::reference_clip_cap_secs(AUDIO8_MODEL_ID),
                    )
                    .map(|clip| clip.samples)
                },
            )
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        // `speed`/`lang` are ignored: no rate knob, and the prompt carries no language
        // tag — the model follows the text + reference voice.
        let samples = eng
            .synthesize(text, &reference)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: AUDIO8_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        AUDIO8_VOICES.to_vec()
    }
    fn is_ready(&self) -> bool {
        self.engine.lock().is_ok_and(|g| g.is_some())
    }
    fn warm_up(&self) -> TtsResult<()> {
        self.ensure_loaded()
    }
    fn shutdown(&self) {
        if let Ok(mut g) = self.engine.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The 23 languages upstream's model card claims — which is what the
    /// `chatterbox-multilingual` catalog row USED to advertise, before the four with no
    /// usable vocab were dropped. A local copy on purpose: the tests below assert the
    /// engine's classification against this fixed list, and the catalog-side test
    /// (`chatterbox_multilingual_advertises_exactly_what_the_engine_can_speak`) is what
    /// ties the row itself to `chatterbox_advertised_languages`.
    const CATALOG_ADVERTISED: &[&str] = &[
        "en", "ar", "da", "de", "el", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl",
        "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
    ];

    /// The four whose text this app cannot feed correctly — they tokenize to `[UNK]`
    /// (or, for `he`, to undiacritized ambiguity) no matter which tag is prefixed.
    const NEEDS_MISSING_FRONTEND: &[&str] = &["he", "ja", "ko", "zh"];

    #[test]
    fn every_catalog_language_has_a_real_single_token_tag() {
        // The tag side of the contract: all 23 advertised codes DO resolve. The honesty
        // problem is the text frontend, not the tag — asserted separately below.
        for code in CATALOG_ADVERTISED {
            assert_eq!(
                chatterbox_language_tag(code),
                Some(*code),
                "{code} has no tag"
            );
        }
    }

    #[test]
    fn language_tag_rejects_codes_with_no_tag_in_the_vocab() {
        // `[zz]`/`[th]`/`[uk]`/`[fa]` shatter into `[` + letters + `]` in the shipped
        // tokenizer, so routing them would inject junk tokens into the prompt.
        for code in [
            "zz", "xx", "th", "uk", "fa", "ur", "bn", "id", "klingon", "",
        ] {
            assert_eq!(chatterbox_language_tag(code), None, "{code} should not map");
        }
    }

    #[test]
    fn language_tag_normalizes_region_case_and_aliases() {
        // Region subtags and both separators (SUPPORTED_LANGUAGES uses `pt-br`, Piper
        // uses `en_US`), plus surrounding whitespace.
        assert_eq!(chatterbox_language_tag("en-us"), Some("en"));
        assert_eq!(chatterbox_language_tag("en-GB"), Some("en"));
        assert_eq!(chatterbox_language_tag("en_US"), Some("en"));
        assert_eq!(chatterbox_language_tag("  FR  "), Some("fr"));
        assert_eq!(chatterbox_language_tag("pt-br"), Some("pt"));
        // Aliases the app actually emits.
        assert_eq!(chatterbox_language_tag("cmn"), Some("zh"));
        assert_eq!(chatterbox_language_tag("nb"), Some("no"));
        assert_eq!(chatterbox_language_tag("nn"), Some("no"));
        assert_eq!(chatterbox_language_tag("iw"), Some("he"));
        // A region on an alias still resolves.
        assert_eq!(chatterbox_language_tag("cmn-Hans"), Some("zh"));
    }

    #[test]
    fn advertised_languages_drop_the_four_that_need_a_missing_frontend() {
        let advertised = chatterbox_advertised_languages();
        for code in NEEDS_MISSING_FRONTEND {
            assert!(
                !advertised.contains(code),
                "{code} needs a text frontend this app does not ship and must not be advertised"
            );
            // …but it still ROUTES to its own tag if a caller insists, because the
            // correct tag beats silently claiming English.
            assert_eq!(chatterbox_language_tag(code), Some(*code));
        }
        // Exactly the upstream-trained set minus those four.
        assert_eq!(
            advertised,
            vec![
                "en", "ar", "da", "de", "el", "es", "fi", "fr", "hi", "it", "ms", "nl", "no", "pl",
                "pt", "ru", "sv", "sw", "tr"
            ]
        );
        assert_eq!(advertised.len(), CATALOG_ADVERTISED.len() - 4);
        // Never advertise a language upstream does not claim, even where the vocab
        // happens to carry a tag (cs/hu/ro/sk/bg/vi/ta/ea).
        for code in ["cs", "hu", "ro", "sk", "bg", "vi", "ta", "ea"] {
            assert!(
                !advertised.contains(&code),
                "{code} is not upstream-trained"
            );
            assert_eq!(chatterbox_language_tag(code), Some(code));
        }
    }

    #[test]
    fn language_table_has_no_duplicate_or_unreachable_rows() {
        let mut seen = std::collections::HashSet::new();
        for (code, _) in CHATTERBOX_LANGUAGES {
            assert!(seen.insert(*code), "duplicate row for {code}");
            // A row whose code is itself an alias source could never be reached.
            assert!(
                !CHATTERBOX_LANGUAGE_ALIASES.iter().any(|(f, _)| f == code),
                "{code} is shadowed by an alias"
            );
        }
        for (_, to) in CHATTERBOX_LANGUAGE_ALIASES {
            assert!(seen.contains(to), "alias target {to} has no row");
        }
    }

    fn chatterbox_engine(model_id: &str) -> ChatterboxLocalEngine {
        // `new` only resolves filenames + builds a lazy session holder; nothing is read
        // from disk until the first synthesize/warm_up.
        ChatterboxLocalEngine::new(PathBuf::from("/nonexistent-chatterbox"), model_id, "q4")
    }

    #[test]
    fn multilingual_prompt_follows_the_callers_language() {
        let eng = chatterbox_engine("chatterbox-multilingual");
        assert!(eng.tagged);
        assert_eq!(eng.chatterbox_prompt("Bonjour.", "fr"), "[fr]Bonjour.");
        assert_eq!(eng.chatterbox_prompt("Hallo.", "de-DE"), "[de]Hallo.");
        assert_eq!(eng.chatterbox_prompt("Habari.", "sw"), "[sw]Habari.");
        // Region-tagged English still lands on the plain tag.
        assert_eq!(eng.chatterbox_prompt("Hello.", "en-us"), "[en]Hello.");
    }

    #[test]
    fn multilingual_prompt_falls_back_to_english_not_to_a_junk_tag() {
        let eng = chatterbox_engine("chatterbox-multilingual");
        // Empty lang is the warm-up / hotkey path; unknown codes are stale settings.
        assert_eq!(eng.chatterbox_prompt("Hello.", ""), "[en]Hello.");
        assert_eq!(eng.chatterbox_prompt("Hello.", "zz"), "[en]Hello.");
        assert_eq!(eng.chatterbox_prompt("Hello.", "klingon"), "[en]Hello.");
    }

    #[test]
    fn multilingual_prompt_trims_like_the_engine_and_passes_blanks_through() {
        let eng = chatterbox_engine("chatterbox-multilingual");
        // The engine trims BEFORE prefixing when it owns the tag; matching that keeps
        // the prompt byte-identical to the pre-existing single-language behaviour.
        assert_eq!(eng.chatterbox_prompt("  Hello.  ", "en"), "[en]Hello.");
        // Whitespace-only input must NOT become a bare `[en]` — it has to reach the
        // engine still empty so the empty-input short-circuit returns silence.
        assert_eq!(eng.chatterbox_prompt("   ", "en"), "   ");
        assert_eq!(eng.chatterbox_prompt("", "fr"), "");
    }

    #[test]
    fn english_only_exports_are_never_tagged() {
        for model_id in ["chatterbox-turbo", "chatterbox-nano"] {
            let eng = chatterbox_engine(model_id);
            assert!(!eng.tagged, "{model_id} must not be tagged");
            // Even an explicit language is ignored: these exports tokenize raw text.
            assert_eq!(eng.chatterbox_prompt("Hello.", "fr"), "Hello.");
            assert_eq!(eng.chatterbox_prompt("  Hello.  ", "en"), "  Hello.  ");
        }
    }

    /// The engine-side trim has to re-assert THIS row's budget, not the shared default.
    /// Clip preparation is already row-aware, but a clip prepared while a 30 s-capped
    /// model was selected is still on disk after the user switches to OmniVoice, and
    /// would otherwise reach the quadratic step graph six times over budget. A typo in
    /// [`OMNIVOICE_MODEL_ID`] resolves to no row at all and falls back to 30 s silently,
    /// which is exactly the failure this pins.
    #[test]
    fn omnivoice_trims_the_reference_at_its_own_row_cap() {
        assert_eq!(
            catalog::reference_clip_cap_secs(OMNIVOICE_MODEL_ID),
            catalog::OMNIVOICE_MAX_CLONE_REF_SECS,
            "OMNIVOICE_MODEL_ID does not name the catalog row, so the trim fell back \
             to the shared cap"
        );
        assert!(
            catalog::reference_clip_cap_secs(OMNIVOICE_MODEL_ID) < catalog::MAX_CLONE_REF_SECS,
            "the per-row cap must actually be tighter than the shared default"
        );
    }
}
