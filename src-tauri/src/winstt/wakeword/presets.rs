// ═════════════════════════════════════════════════════════════════════════════
// 2. Preset registry — maps WinSTT's historical wake-word NAMES (the values the
//    renderer persists in `general.wakeWord`, default "alexa") to the canonical
//    spoken phrase the KWS engine should listen for.
//
//    WinSTT/Porcupine exposed 14 built-in keywords with no signup; openWakeWord
//    added a few "hey_*" phrases. The renderer's `wakeWordBackendFor` selected
//    Porcupine vs OWW vs composite from the NAME alone. In the unified KWS port
//    there is no backend to select — every preset is just a phrase to tokenize.
//
//    Underscores in OWW-style names ("hey_jarvis") are normalized to spaces so
//    the tokenizer sees the real phrase. The `@transcript` half of a keywords
//    line is the human-readable label echoed back on a hit.
// ═════════════════════════════════════════════════════════════════════════════

use super::config::LegacyPorcupinePaths;

/// One built-in wake-word preset: the persisted NAME and the phrase to spot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WakeWordPreset {
    /// The value stored in `general.wakeWord` (Porcupine/OWW historical name).
    pub name: &'static str,
    /// The natural-language phrase fed to the BPE tokenizer.
    pub phrase: &'static str,
}

/// The 14 Porcupine 1.9.x built-ins plus the openWakeWord "hey_*" extras that
/// WinSTT shipped. Order is irrelevant (looked up by name); the renderer's
/// dropdown drives which one is active. Anything NOT in this table is treated
/// as a free-form custom phrase (see [`resolve_phrase`]).
pub const WAKE_WORD_PRESETS: &[WakeWordPreset] = &[
    // ── Porcupine 1.9.x built-ins (no access key) ──
    WakeWordPreset {
        name: "alexa",
        phrase: "alexa",
    },
    WakeWordPreset {
        name: "americano",
        phrase: "americano",
    },
    WakeWordPreset {
        name: "blueberry",
        phrase: "blueberry",
    },
    WakeWordPreset {
        name: "bumblebee",
        phrase: "bumblebee",
    },
    WakeWordPreset {
        name: "computer",
        phrase: "computer",
    },
    WakeWordPreset {
        name: "grapefruit",
        phrase: "grapefruit",
    },
    WakeWordPreset {
        name: "grasshopper",
        phrase: "grasshopper",
    },
    WakeWordPreset {
        name: "hey google",
        phrase: "hey google",
    },
    WakeWordPreset {
        name: "hey siri",
        phrase: "hey siri",
    },
    WakeWordPreset {
        name: "jarvis",
        phrase: "jarvis",
    },
    WakeWordPreset {
        name: "ok google",
        phrase: "ok google",
    },
    WakeWordPreset {
        name: "pico clock",
        phrase: "pico clock",
    },
    WakeWordPreset {
        name: "picovoice",
        phrase: "picovoice",
    },
    WakeWordPreset {
        name: "porcupine",
        phrase: "porcupine",
    },
    WakeWordPreset {
        name: "terminator",
        phrase: "terminator",
    },
    // ── openWakeWord "hey_*" phrases WinSTT exposed (underscores → spaces) ──
    WakeWordPreset {
        name: "hey_jarvis",
        phrase: "hey jarvis",
    },
    WakeWordPreset {
        name: "hey_mycroft",
        phrase: "hey mycroft",
    },
    WakeWordPreset {
        name: "hey_rhasspy",
        phrase: "hey rhasspy",
    },
];

/// Wake-word runtime chosen for a persisted wake-word value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeWordRuntimeEngine {
    /// Legacy pvporcupine 1.9.5, downloaded at runtime and used for its bundled
    /// built-in `.ppn` phrases only.
    LegacyPorcupine,
    /// sherpa-onnx open-vocabulary KWS, used for custom typed phrases and for
    /// presets that do not have a redistributable Porcupine 1.9.5 model.
    SherpaKws,
}

impl WakeWordRuntimeEngine {
    pub fn id(self) -> &'static str {
        match self {
            WakeWordRuntimeEngine::LegacyPorcupine => "porcupine-legacy",
            WakeWordRuntimeEngine::SherpaKws => "sherpa-kws",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            WakeWordRuntimeEngine::LegacyPorcupine => "Porcupine built-in wake words",
            WakeWordRuntimeEngine::SherpaKws => "sherpa-onnx custom wake words",
        }
    }

    pub fn accuracy_label(self) -> &'static str {
        match self {
            WakeWordRuntimeEngine::LegacyPorcupine => "High accuracy built-in",
            WakeWordRuntimeEngine::SherpaKws => "Lower accuracy custom",
        }
    }

    pub fn download_size_label(self) -> &'static str {
        match self {
            WakeWordRuntimeEngine::LegacyPorcupine => "about 2 MB",
            WakeWordRuntimeEngine::SherpaKws => "about 17 MB",
        }
    }
}

/// Cross-platform built-ins present in pvporcupine 1.9.5 for Windows, macOS
/// x86_64, and Linux x86_64. Linux has a few extra `.ppn` files; keep the shared
/// subset so the UI behaves consistently across desktop targets.
pub const LEGACY_PORCUPINE_KEYWORDS: &[&str] = &[
    "alexa",
    "americano",
    "blueberry",
    "bumblebee",
    "computer",
    "grapefruit",
    "grasshopper",
    "hey google",
    "hey siri",
    "jarvis",
    "ok google",
    "pico clock",
    "picovoice",
    "porcupine",
    "terminator",
];

pub fn wakeword_runtime_engine_for_name(name: &str) -> WakeWordRuntimeEngine {
    if is_legacy_porcupine_keyword(name) && LegacyPorcupinePaths::platform_supported() {
        WakeWordRuntimeEngine::LegacyPorcupine
    } else {
        WakeWordRuntimeEngine::SherpaKws
    }
}

pub fn is_legacy_porcupine_keyword(name: &str) -> bool {
    let normalized = normalize_name(name);
    LEGACY_PORCUPINE_KEYWORDS
        .iter()
        .any(|keyword| normalize_name(keyword) == normalized)
}

/// Resolve a persisted wake-word name into the phrase to spot.
///
/// Lookup is case-insensitive over the preset table; underscores in the INPUT
/// are also normalized so a stale `"hey_google"` resolves the same as
/// `"hey google"`. An unrecognized value is taken as a literal custom phrase
/// (trimmed, lower-cased, underscores→spaces) — open vocabulary means a user
/// can type any trigger and it just works.
pub fn resolve_phrase(name: &str) -> String {
    let normalized = normalize_name(name);
    for preset in WAKE_WORD_PRESETS {
        if normalize_name(preset.name) == normalized {
            return preset.phrase.to_string();
        }
    }
    // Unknown → treat the persisted value itself as the phrase (custom trigger).
    normalized
}

/// Lower-case, trim, and collapse `_`/whitespace runs into single spaces.
pub(super) fn normalize_name(name: &str) -> String {
    let lowered = name.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut last_was_space = false;
    for ch in lowered.chars() {
        if ch == '_' || ch.is_whitespace() {
            if !last_was_space && !out.is_empty() {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    // Drop any trailing space introduced by a terminal separator.
    if out.ends_with(' ') {
        out.pop();
    }
    out
}
