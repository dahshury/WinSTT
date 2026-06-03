use super::types::{Gender, VoiceInfo};

// ===========================================================================
// REAL, DETERMINISTIC DATA + LOGIC (compilable + unit-tested)
// ===========================================================================

/// The 54-voice Kokoro v1.0 catalog across 9 languages. Verbatim port of
/// `server/src/synthesizer/infrastructure/voice_catalog.py` — the `id` and
/// `language` strings are EXACTLY what the Kokoro engine accepts.
pub const KOKORO_VOICE_CATALOG: &[VoiceInfo] = &[
    // American English — Female (11)
    VoiceInfo {
        id: "af_heart",
        label: "Heart (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_alloy",
        label: "Alloy (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_aoede",
        label: "Aoede (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_bella",
        label: "Bella (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_jessica",
        label: "Jessica (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_kore",
        label: "Kore (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_nicole",
        label: "Nicole (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_nova",
        label: "Nova (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_river",
        label: "River (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_sarah",
        label: "Sarah (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "af_sky",
        label: "Sky (US)",
        language: "en-us",
        gender: Gender::Female,
    },
    // American English — Male (9)
    VoiceInfo {
        id: "am_adam",
        label: "Adam (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_echo",
        label: "Echo (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_eric",
        label: "Eric (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_fenrir",
        label: "Fenrir (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_liam",
        label: "Liam (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_michael",
        label: "Michael (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_onyx",
        label: "Onyx (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_puck",
        label: "Puck (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "am_santa",
        label: "Santa (US)",
        language: "en-us",
        gender: Gender::Male,
    },
    // British English — Female (4)
    VoiceInfo {
        id: "bf_alice",
        label: "Alice (UK)",
        language: "en-gb",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "bf_emma",
        label: "Emma (UK)",
        language: "en-gb",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "bf_isabella",
        label: "Isabella (UK)",
        language: "en-gb",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "bf_lily",
        label: "Lily (UK)",
        language: "en-gb",
        gender: Gender::Female,
    },
    // British English — Male (4)
    VoiceInfo {
        id: "bm_daniel",
        label: "Daniel (UK)",
        language: "en-gb",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "bm_fable",
        label: "Fable (UK)",
        language: "en-gb",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "bm_george",
        label: "George (UK)",
        language: "en-gb",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "bm_lewis",
        label: "Lewis (UK)",
        language: "en-gb",
        gender: Gender::Male,
    },
    // Japanese (5)
    VoiceInfo {
        id: "jf_alpha",
        label: "Alpha (JP)",
        language: "ja",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "jf_gongitsune",
        label: "Gongitsune (JP)",
        language: "ja",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "jf_nezumi",
        label: "Nezumi (JP)",
        language: "ja",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "jf_tebukuro",
        label: "Tebukuro (JP)",
        language: "ja",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "jm_kumo",
        label: "Kumo (JP)",
        language: "ja",
        gender: Gender::Male,
    },
    // Mandarin Chinese (8)
    VoiceInfo {
        id: "zf_xiaobei",
        label: "Xiaobei (ZH)",
        language: "cmn",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "zf_xiaoni",
        label: "Xiaoni (ZH)",
        language: "cmn",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "zf_xiaoxiao",
        label: "Xiaoxiao (ZH)",
        language: "cmn",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "zf_xiaoyi",
        label: "Xiaoyi (ZH)",
        language: "cmn",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "zm_yunjian",
        label: "Yunjian (ZH)",
        language: "cmn",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "zm_yunxi",
        label: "Yunxi (ZH)",
        language: "cmn",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "zm_yunxia",
        label: "Yunxia (ZH)",
        language: "cmn",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "zm_yunyang",
        label: "Yunyang (ZH)",
        language: "cmn",
        gender: Gender::Male,
    },
    // Spanish (3)
    VoiceInfo {
        id: "ef_dora",
        label: "Dora (ES)",
        language: "es",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "em_alex",
        label: "Alex (ES)",
        language: "es",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "em_santa",
        label: "Santa (ES)",
        language: "es",
        gender: Gender::Male,
    },
    // French (1)
    VoiceInfo {
        id: "ff_siwis",
        label: "Siwis (FR)",
        language: "fr",
        gender: Gender::Female,
    },
    // Hindi (4)
    VoiceInfo {
        id: "hf_alpha",
        label: "Alpha (HI)",
        language: "hi",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "hf_beta",
        label: "Beta (HI)",
        language: "hi",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "hm_omega",
        label: "Omega (HI)",
        language: "hi",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "hm_psi",
        label: "Psi (HI)",
        language: "hi",
        gender: Gender::Male,
    },
    // Italian (2)
    VoiceInfo {
        id: "if_sara",
        label: "Sara (IT)",
        language: "it",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "im_nicola",
        label: "Nicola (IT)",
        language: "it",
        gender: Gender::Male,
    },
    // Brazilian Portuguese (3)
    VoiceInfo {
        id: "pf_dora",
        label: "Dora (BR)",
        language: "pt-br",
        gender: Gender::Female,
    },
    VoiceInfo {
        id: "pm_alex",
        label: "Alex (BR)",
        language: "pt-br",
        gender: Gender::Male,
    },
    VoiceInfo {
        id: "pm_santa",
        label: "Santa (BR)",
        language: "pt-br",
        gender: Gender::Male,
    },
];

/// The 9 languages surfaced to the renderer language picker.
pub const SUPPORTED_LANGUAGES: &[(&str, &str)] = &[
    ("en-us", "English (US)"),
    ("en-gb", "English (UK)"),
    ("ja", "Japanese"),
    ("cmn", "Mandarin"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("it", "Italian"),
    ("pt-br", "Portuguese (BR)"),
];

/// Look up a voice by id (renderer-selected voice validation).
pub fn voice_by_id(id: &str) -> Option<&'static VoiceInfo> {
    KOKORO_VOICE_CATALOG.iter().find(|v| v.id == id)
}

/// Voices belonging to a language code (UI grouping).
pub fn voices_for_language(lang: &str) -> Vec<&'static VoiceInfo> {
    KOKORO_VOICE_CATALOG
        .iter()
        .filter(|v| v.language == lang)
        .collect()
}
