// TtsEngine adapters for the new local ONNX engines (Kitten / Piper / Supertonic),
// mirroring KokoroLocalEngine: wrap the concrete engine, map errors into TtsError,
// and expose the engine's voice catalog. The manager selects one of these by the
// catalog entry's TtsEngineId. Asset download is the manager's responsibility
// (the underlying engine errors `AssetsMissing` until files are on disk).

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use super::chatterbox::{ChatterboxConfig, ChatterboxEngine, CHATTERBOX_SAMPLE_RATE};
use super::kitten::{KittenConfig, KittenDevice, KittenEngine, KITTEN_SAMPLE_RATE};
use super::piper::{PiperConfig, PiperEngine};
use super::supertonic::{SupertonicConfig, SupertonicEngine, SUPERTONIC_SAMPLE_RATE};
use super::{Gender, SentenceAudio, TtsEngine, TtsError, TtsResult, VoiceInfo};

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

/// Supertonic 10 preset voices (English): F1-F5 / M1-M5.
pub const SUPERTONIC_VOICES: &[VoiceInfo] = &[
    VoiceInfo {
        id: "F1",
        label: "Supertonic Female 1",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F2",
        label: "Supertonic Female 2",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F3",
        label: "Supertonic Female 3",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F4",
        label: "Supertonic Female 4",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "F5",
        label: "Supertonic Female 5",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "M1",
        label: "Supertonic Male 1",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M2",
        label: "Supertonic Male 2",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M3",
        label: "Supertonic Male 3",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M4",
        label: "Supertonic Male 4",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "M5",
        label: "Supertonic Male 5",
        language: "en-us",
        gender: Gender::Male,
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
                device: KittenDevice::Cpu,
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
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        let samples = self
            .engine
            .synthesize(text, voice, speed)
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        Ok(SentenceAudio::F32le {
            samples,
            sample_rate: SUPERTONIC_SAMPLE_RATE,
        })
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
    engines: Mutex<HashMap<String, PiperEngine>>,
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
        let mut map = self
            .engines
            .lock()
            .map_err(|_| TtsError::Engine("piper engine map poisoned".into()))?;
        let engine = map.entry(stem.to_string()).or_insert_with(|| {
            PiperEngine::new(PiperConfig {
                cache_dir: self.cache_dir.clone(),
                voice_stem: stem.to_string(),
            })
        });
        f(engine)
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
            .map(|m| m.values().any(|e| e.is_ready()))
            .unwrap_or(false)
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
}
impl ChatterboxLocalEngine {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            engine: ChatterboxEngine::new(ChatterboxConfig {
                cache_dir,
                ..Default::default()
            }),
        }
    }
}
impl TtsEngine for ChatterboxLocalEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
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
        let samples = self
            .engine
            .synthesize(text, ref_path, 0.5)
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
