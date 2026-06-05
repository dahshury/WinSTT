// Source: docs.rs/sherpa-onnx/1.13.2 (KeywordSpotter / KeywordSpotterConfig /
//         OnlineModelConfig / OnlineTransducerModelConfig / OnlineStream / KeywordResult),
//         verified 2026-05-31 via docs.rs source (src/kws.rs, src/online_asr.rs).
// WinSTT reference (behavior parity target):
//   server/src/recorder/infrastructure/porcupine_detector.py
//   server/src/recorder/infrastructure/oww_detector.py
//   server/src/recorder/infrastructure/composite_wake_word.py
//   server/src/recorder/bootstrap.py (WAKE_WORD_BACKENDS registry, L938-945)
//   frontend/src/shared/config/settings-schema.ts (general.wakeWord/wakeWordSensitivity/wakeWordTimeout)
//   docs/archive/port/05_wakeword_diarization_loopback_wordts.md (§A)
//
// ─────────────────────────────────────────────────────────────────────────────
// REAL sherpa-onnx 1.13.2 KWS API (the ONLY thing that changed vs the sherpa-rs draft):
//   pub struct KeywordSpotterConfig {
//       pub feat_config: sys::FeatureConfig,           // { sample_rate: i32, feature_dim: i32 }
//       pub model_config: OnlineModelConfig,           // transducer { encoder/decoder/joiner: Option<String> }, tokens, provider…
//       pub max_active_paths: i32,                     // default 4
//       pub num_trailing_blanks: i32,                  // default 1
//       pub keywords_score: f32,                       // default 1.0 (== Porcupine :boost)
//       pub keywords_threshold: f32,                   // default 0.25 (GLOBAL #threshold floor)
//       pub keywords_file: Option<String>,             // path to keywords.txt
//       pub keywords_buf: Option<String>,              // OR inline keywords content (we use this)
//   }
//   impl Default for KeywordSpotterConfig { /* sr=16000, dim=80, paths=4, blanks=1, score=1.0, thr=0.25 */ }
//   KeywordSpotter::create(&KeywordSpotterConfig) -> Option<Self>          (Send + Sync + Drop)
//   KeywordSpotter::create_stream(&self) -> OnlineStream                   (uses config keywords)
//   KeywordSpotter::create_stream_with_keywords(&self, &str) -> OnlineStream (inline keyword content)
//   KeywordSpotter::is_ready(&self, &OnlineStream) -> bool
//   KeywordSpotter::decode(&self, &OnlineStream)
//   KeywordSpotter::get_result(&self, &OnlineStream) -> Option<KeywordResult>
//   KeywordSpotter::reset(&self, &OnlineStream)
//   OnlineStream::accept_waveform(&self, sample_rate: i32, samples: &[f32])
//   OnlineStream::input_finished(&self)
//   pub struct KeywordResult { keyword: String, tokens: String, tokens_arr: Vec<String>,
//                              timestamps: Vec<f32>, start_time: f32, json: String }
//
// Canonical streaming loop (from the crate's module example):
//   stream.accept_waveform(sr, samples);
//   while kws.is_ready(&stream) { kws.decode(&stream); }
//   if let Some(r) = kws.get_result(&stream) { /* r.keyword non-empty == HIT */ }
//   kws.reset(&stream);   // re-arm after a hit
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN NOTE — why sherpa-onnx KWS replaces Porcupine + openWakeWord
// ─────────────────────────────────────────────────────────────────────────────
// WinSTT's Python server had THREE wake-word backends behind `IWakeWordDetector`:
//   • PorcupineDetector  (pvporcupine 1.9.x — 14 built-in keywords, no access key)
//   • OWWDetector        (openWakeWord ONNX — alexa/hey_jarvis/hey_mycroft/…)
//   • CompositeWakeWord  (BOTH must fire within 1.5 s — only "alexa" supported by both)
// The Rust port (locked decision: "wake word = sherpa-onnx KWS") collapses all
// three to ONE open-vocabulary zipformer-transducer keyword spotter. Benefits:
//   1. Open vocabulary — ANY phrase ("computer", "hey winstt", "take a note")
//      becomes a wake word by tokenizing it into the keywords content.
//   2. One ONNX runtime (sherpa-onnx) for KWS + diarization — no Picovoice native
//      blob, no OWW's pinned-onnxruntime resolver patch.
//   3. Offline, no access key, vendor-agnostic (matches the torch-free posture).
// The trade-off (a global threshold, see UX CAVEAT below) is handled by emitting
// a PER-KEYWORD `#threshold` suffix in the generated keywords content.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMPILE NOTE — no `#[cfg(feature = "sherpa")]` gate any more.
// The draft gated the live detector behind a `sherpa` cargo feature; Cargo.toml
// declares `sherpa-onnx = "1.13.2"` UNCONDITIONALLY (no such feature, and we may
// not edit Cargo.toml), so the detector compiles unconditionally. The deterministic
// helpers (presets / keyword-file builder / sensitivity mapping) never touched the
// FFI and keep their own unit tests.

use std::collections::HashSet;
use std::ffi::CString;
use std::fs;
use std::os::raw::{c_char, c_float, c_int, c_short, c_void};
use std::path::{Path, PathBuf};

use libloading::Library;
use sentencepiece_rs::SentencePieceProcessor;
use sherpa_onnx::{
    KeywordSpotter, KeywordSpotterConfig, OnlineModelConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Public result type — mirrors WinSTT's `WakeWordResult` frozen dataclass.
//    (domain/ports/wake_word.py: { detected: bool, word_index: int, word: str })
// ═════════════════════════════════════════════════════════════════════════════

/// Outcome of feeding one audio chunk to the keyword spotter.
///
/// `word_index` indexes into the keyword list that was compiled into the
/// active keywords content (stable order = order of [`WakeWordConfig::keywords`]).
/// `-1` means "detected, but the spotter returned a phrase we did not register"
/// (should not happen with a generated file, but kept honest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeWordResult {
    pub detected: bool,
    pub word_index: i32,
    pub word: String,
}

impl WakeWordResult {
    pub fn none() -> Self {
        WakeWordResult {
            detected: false,
            word_index: -1,
            word: String::new(),
        }
    }

    pub fn hit(word_index: i32, word: impl Into<String>) -> Self {
        WakeWordResult {
            detected: true,
            word_index,
            word: word.into(),
        }
    }
}

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
fn normalize_name(name: &str) -> String {
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

// ═════════════════════════════════════════════════════════════════════════════
// 3. Keyword-content builder — DETERMINISTIC, fully unit-tested.
//
//    sherpa-onnx KWS reads keywords (file OR inline buffer) where each line is the
//    BPE-TOKENIZED phrase, optionally followed by per-keyword tuning and a `@label`:
//
//        ▁HE Y ▁S I RI :2.0 #0.35 @hey siri
//        └─ tokens ──┘ └boost┘└thresh┘ └─ label ─┘
//
//    The token half is produced by the same SentencePiece BPE model used by
//    `sherpa-onnx-cli text2token` (`bpe.model` + `tokens.txt`). The builder below
//    stays deterministic and testable by accepting already-tokenized
//    `KeywordSpec` rows; the runtime manager gets those rows from
//    `tokenize_phrase_for_kws_model`, which prefers the bundled `bpe.model` and
//    falls back to token-vocabulary matching if the model is unavailable.
// ═════════════════════════════════════════════════════════════════════════════

/// One fully-resolved keyword line to emit into the keywords content.
#[derive(Debug, Clone, PartialEq)]
pub struct KeywordSpec {
    /// Space-separated BPE tokens, e.g. `"▁HE Y ▁S I RI"` (from text2token).
    pub tokens: String,
    /// Label echoed on a hit (the `@…` half). sherpa parses keyword lines by
    /// whitespace, so this value must not contain spaces.
    pub label: String,
    /// Optional per-keyword boost (`keywords_score` override, `:value`).
    pub boost: Option<f32>,
    /// Optional per-keyword detection threshold (`#value`); see UX CAVEAT.
    pub threshold: Option<f32>,
}

impl KeywordSpec {
    /// Render this spec to a single keywords line (no trailing newline).
    ///
    /// Ordering matches sherpa-onnx's parser expectation:
    ///   `<tokens> [:<boost>] [#<threshold>] @<label>`
    /// Floats are formatted compactly (no trailing zeros beyond what's needed)
    /// so the content is diff-stable and human-auditable.
    pub fn to_line(&self) -> String {
        let mut line = self.tokens.trim().to_string();
        if let Some(boost) = self.boost {
            line.push_str(&format!(" :{}", fmt_f32(boost)));
        }
        if let Some(threshold) = self.threshold {
            line.push_str(&format!(" #{}", fmt_f32(threshold)));
        }
        line.push_str(" @");
        line.push_str(self.label.trim());
        line
    }
}

/// Format an f32 without a fixed precision: integers stay integral ("2"),
/// fractions keep up to 3 dp with trailing zeros stripped ("0.35", "0.5").
fn fmt_f32(value: f32) -> String {
    if value.fract() == 0.0 {
        return format!("{}", value as i64);
    }
    let mut s = format!("{value:.3}");
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

/// Assemble a complete keywords body from already-tokenized specs.
///
/// Returns the joined lines with a trailing newline (sherpa-onnx tolerates
/// either, but a terminal newline avoids a "last keyword dropped on some
/// readers" class of bug). Empty input yields an empty string. The result is
/// usable as either a `keywords.txt` file body OR the inline `keywords_buf`.
pub fn build_keywords_file(specs: &[KeywordSpec]) -> String {
    if specs.is_empty() {
        return String::new();
    }
    let mut body = String::new();
    for spec in specs {
        body.push_str(&spec.to_line());
        body.push('\n');
    }
    body
}

/// Convert a UI sensitivity (0.0 = strict … 1.0 = permissive — WinSTT's
/// `general.wakeWordSensitivity`, default 0.6) into a sherpa `#threshold`.
///
/// ⚠️ DIRECTION FLIP. In WinSTT/Porcupine HIGHER sensitivity = MORE permissive
/// (fires more easily). In sherpa-onnx KWS a HIGHER `keywords_threshold`/`#t`
/// means a STRICTER match (the decoded token score must clear it). So we INVERT:
///
/// ```text
/// threshold = THRESHOLD_MAX - sensitivity * (THRESHOLD_MAX - THRESHOLD_MIN)
/// ```
///
/// With the defaults below, sensitivity 0.6 → threshold ≈ 0.22, i.e. close to
/// sherpa's documented default of 0.25 — preserving WinSTT's out-of-box feel.
/// sensitivity 1.0 → 0.10 (loosest), sensitivity 0.0 → 0.40 (strict).
pub const THRESHOLD_MIN: f32 = 0.10;
pub const THRESHOLD_MAX: f32 = 0.40;

pub fn sensitivity_to_threshold(sensitivity: f32) -> f32 {
    let s = sensitivity.clamp(0.0, 1.0);
    let raw = THRESHOLD_MAX - s * (THRESHOLD_MAX - THRESHOLD_MIN);
    // Round to 2 dp so the emitted #threshold is tidy & diff-stable.
    (raw * 100.0).round() / 100.0
}

// ═════════════════════════════════════════════════════════════════════════════
// 3b. Phrase → keyword-token tokenization (the missing bridge before the engine).
//
//    sherpa-onnx KWS does NOT tokenize keyword text itself: `EncodeKeywords`
//    (sherpa-onnx/csrc/utils.cc) feeds each `keywords.txt`/`keywords_buf` line
//    STRAIGHT into the symbol table — every whitespace-separated piece must
//    already be a token present in the model's `tokens.txt`, or the WHOLE line is
//    rejected as OOV (`has_oov` → `EncodeBase` returns false → `KeywordSpotter`
//    drops that keyword). The BPE `text2token` step (`sherpa-onnx-cli text2token`)
//    runs SentencePiece over `bpe.model`; the app mirrors that in-process with
//    `sentencepiece-rs`, then keeps two fallbacks:
//
//    1. A VERIFIED static map of the canonical preset phrases → their gigaspeech
//       BPE token strings. This keeps built-ins stable and avoids loading
//       SentencePiece in unit tests.
//    2. A token-vocabulary fallback for anything else if `bpe.model` is missing:
//       greedily split each upper-case word into valid `tokens.txt` pieces, then
//       fall back to character pieces only when no longer BPE piece matches. The
//       line stays OOV-safe, but exact SentencePiece tokenization remains the
//       preferred runtime path.
//
//    Both produce the exact `<space-separated tokens>` half of a keyword line; the
//    `#threshold`/`@label` suffixes are added by [`build_keyword_content`].
// ═════════════════════════════════════════════════════════════════════════════

/// Word-start marker used by sentencepiece BPE vocabularies (U+2581).
const BPE_WORD_PREFIX: char = '▁';

/// Verified gigaspeech-BPE tokenizations for the canonical preset phrases.
///
/// Keyed by the resolved phrase (lower-case, the output of [`resolve_phrase`]).
/// Values are the space-separated `tokens.txt` symbols. The three multi-word
/// entries (`hey siri`, `hey google`, `ok google`) match the upstream
/// `text2token` examples verbatim; the single-word entries follow the same
/// `▁<WORD-START> …` sentencepiece convention. Anything not here falls through to
/// [`char_tokenize_phrase`], so a missing/incorrect entry only costs decode steps,
/// never correctness.
const PRESET_BPE_TOKENS: &[(&str, &str)] = &[
    // Generated from the bundle's `bpe.model` with SentencePiece. Keep labels
    // keyed by resolved phrase (not persisted preset name).
    ("alexa", "▁A LE X A"),
    ("americano", "▁AMERICA N O"),
    ("blueberry", "▁B LU E BER RY"),
    ("bumblebee", "▁BU M B LE B E E"),
    ("computer", "▁COMP U TER"),
    ("grapefruit", "▁GRA PE F RU IT"),
    ("grasshopper", "▁GRA S S HO P PER"),
    ("hey siri", "▁HE Y ▁S I RI"),
    ("hey google", "▁HE Y ▁GO O G LE"),
    ("ok google", "▁O K ▁GO O G LE"),
    ("jarvis", "▁JA R VI S"),
    ("picovoice", "▁PI CO VO IC E"),
    ("porcupine", "▁P OR C U P IN E"),
    ("terminator", "▁ TER M IN AT OR"),
    ("hey jarvis", "▁HE Y ▁JA R VI S"),
    ("hey mycroft", "▁HE Y ▁MY C RO F T"),
    ("hey rhasspy", "▁HE Y ▁ R HA S S P Y"),
];

/// Tokenize a resolved phrase into the space-separated token half of a keyword
/// line. Prefers the verified BPE map, falls back to the always-valid char split.
///
/// Returns an empty string only for an empty/blank phrase (the caller skips it).
pub fn tokenize_phrase(phrase: &str) -> String {
    let normalized = phrase.trim().to_lowercase();
    if normalized.is_empty() {
        return String::new();
    }
    if let Some(tokens) = preset_bpe_tokens(&normalized) {
        return tokens.to_string();
    }
    char_tokenize_phrase(&normalized)
}

pub fn load_token_vocabulary(tokens_path: &Path) -> Result<HashSet<String>, String> {
    let raw = fs::read_to_string(tokens_path)
        .map_err(|err| format!("read KWS tokens file {}: {err}", tokens_path.display()))?;
    let mut vocab = HashSet::new();
    for line in raw.lines() {
        let Some(token) = line.split_whitespace().next() else {
            continue;
        };
        if !token.is_empty() {
            vocab.insert(token.to_string());
        }
    }
    if vocab.is_empty() {
        return Err(format!(
            "KWS tokens file {} did not contain any symbols",
            tokens_path.display()
        ));
    }
    Ok(vocab)
}

pub fn tokenize_phrase_for_kws_model(
    phrase: &str,
    model: &KwsModelPaths,
) -> Result<String, String> {
    let bpe_path = model.bpe_model();
    if bpe_path.exists() {
        if let Ok(tokens) = tokenize_phrase_with_sentencepiece(phrase, &bpe_path) {
            return Ok(tokens);
        }
    }
    let vocab = load_token_vocabulary(&model.tokens)?;
    Ok(tokenize_phrase_with_vocabulary(phrase, &vocab))
}

pub fn tokenize_phrase_with_sentencepiece(phrase: &str, bpe_path: &Path) -> Result<String, String> {
    let normalized = phrase.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(String::new());
    }
    let processor = SentencePieceProcessor::open(bpe_path)
        .map_err(|err| format!("load KWS SentencePiece model {}: {err}", bpe_path.display()))?;
    let pieces = processor
        .encode(&normalized.to_uppercase())
        .map_err(|err| format!("tokenize KWS phrase '{normalized}': {err}"))?;
    Ok(pieces.join(" "))
}

pub fn tokenize_phrase_with_vocabulary(phrase: &str, vocab: &HashSet<String>) -> String {
    let normalized = phrase.trim().to_lowercase();
    if normalized.is_empty() {
        return String::new();
    }
    if let Some(tokens) = preset_bpe_tokens(&normalized) {
        return tokens.to_string();
    }
    if vocab.is_empty() {
        return tokenize_phrase(&normalized);
    }

    let mut pieces = Vec::new();
    for word in normalized.split_whitespace() {
        let encoded_word = format!("{BPE_WORD_PREFIX}{}", word.to_uppercase());
        let mut remaining = encoded_word.as_str();
        while !remaining.is_empty() {
            if let Some(piece) = longest_vocab_prefix(remaining, vocab) {
                pieces.push(piece.to_string());
                remaining = &remaining[piece.len()..];
                continue;
            }

            let mut chars = remaining.chars();
            let Some(first) = chars.next() else {
                break;
            };
            pieces.push(first.to_string());
            remaining = chars.as_str();
        }
    }
    pieces.join(" ")
}

fn preset_bpe_tokens(phrase: &str) -> Option<&'static str> {
    PRESET_BPE_TOKENS
        .iter()
        .find_map(|(name, tokens)| (*name == phrase).then_some(*tokens))
}

fn longest_vocab_prefix<'a>(text: &'a str, vocab: &HashSet<String>) -> Option<&'a str> {
    let mut best = None;
    for (idx, _) in text.char_indices().skip(1) {
        let candidate = &text[..idx];
        if vocab.contains(candidate) {
            best = Some(candidate);
        }
    }
    if vocab.contains(text) {
        best = Some(text);
    }
    best
}

/// Character-level fallback tokenizer (always in-vocab → never OOV-rejected).
///
/// Each whitespace-delimited word becomes `▁<C0> <C1> <C2> …` with the first
/// character carrying the sentencepiece word-start marker. Letters are upper-cased
/// because these English BPE vocabularies are upper-case (the upstream examples use
/// `▁HE Y …`, never lower-case). Non-letters (digits, apostrophes) are passed
/// through unchanged — single code points that the symbol table still contains.
fn char_tokenize_phrase(phrase: &str) -> String {
    let mut pieces: Vec<String> = Vec::new();
    for word in phrase.split_whitespace() {
        let mut first = true;
        for ch in word.chars() {
            let up = ch.to_uppercase().collect::<String>();
            if first {
                pieces.push(format!("{BPE_WORD_PREFIX}{up}"));
                first = false;
            } else {
                pieces.push(up);
            }
        }
    }
    pieces.join(" ")
}

/// Build the full keyword content (the body for `keywords_buf` / `keywords.txt`)
/// for ONE active wake word from its resolved phrase + UI sensitivity.
///
/// Produces a single line: `<tokens> #<threshold> @<label>` followed by a newline.
/// The `#threshold` is the direction-flipped [`sensitivity_to_threshold`]; the
/// `@label` echoes the human-readable phrase back on a hit (so the detector can map
/// `KeywordResult::keyword` → keyword index). Returns an empty string when the
/// phrase tokenizes to nothing (blank input), which the manager treats as "no
/// active keyword" (detector not built).
pub fn build_keyword_content(phrase: &str, sensitivity: f32) -> String {
    let tokens = tokenize_phrase(phrase);
    build_keyword_content_from_tokens(phrase, sensitivity, tokens)
}

pub fn build_keyword_content_with_vocabulary(
    phrase: &str,
    sensitivity: f32,
    vocab: &HashSet<String>,
) -> String {
    let tokens = tokenize_phrase_with_vocabulary(phrase, vocab);
    build_keyword_content_from_tokens(phrase, sensitivity, tokens)
}

fn build_keyword_content_from_tokens(phrase: &str, sensitivity: f32, tokens: String) -> String {
    if tokens.is_empty() {
        return String::new();
    }
    let label = keyword_label(phrase);
    let spec = KeywordSpec {
        tokens,
        label,
        boost: None,
        threshold: Some(sensitivity_to_threshold(sensitivity)),
    };
    build_keywords_file(std::slice::from_ref(&spec))
}

/// Label used after `@` in sherpa keyword content. It must be a single
/// whitespace-free token; map it back to the display phrase after detection.
pub fn keyword_label(phrase: &str) -> String {
    phrase
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Configuration — the inputs the manager needs to stand up a KeywordSpotter.
// ═════════════════════════════════════════════════════════════════════════════

/// Inference provider for the KWS session.
///
/// INVARIANT: the KWS session is tiny and runs continuously, so keep it on CPU
/// regardless of the STT accelerator. This also avoids sherpa-onnx's DirectML
/// provider probe during startup, which logs a misleading "DirectML is for
/// Windows only" fallback from the native library on some Windows builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WakeWordProvider {
    #[default]
    Cpu,
    DirectMl,
}

impl WakeWordProvider {
    pub fn from_stt_accelerator(_accel: crate::winstt::stt::Accelerator) -> Self {
        WakeWordProvider::Cpu
    }

    /// String passed into sherpa's `OnlineModelConfig::provider`.
    pub fn as_sherpa_str(self) -> &'static str {
        match self {
            WakeWordProvider::Cpu => "cpu",
            WakeWordProvider::DirectMl => "directml",
        }
    }
}

/// Paths to the four files of a sherpa-onnx KWS zipformer model bundle.
/// (encoder/decoder/joiner ONNX + tokens.txt). Downloaded once from the
/// `kws-models` GitHub release — e.g. `sherpa-onnx-kws-zipformer-gigaspeech-3.3M`
/// (English) or `…-zh-en-3M-2025-12-20` (bilingual). `bpe.model` lives alongside
/// these files and is used at runtime for exact keyword tokenization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KwsModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

/// The gigaspeech English KWS bundle (the default wake-word model). Files match
/// the upstream `kws-models` release layout
/// (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`):
/// `encoder/decoder/joiner-epoch-12-avg-2-chunk-16-left-64.onnx` + `tokens.txt`.
pub const KWS_BUNDLE_DIRNAME: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
pub const KWS_ENCODER_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_DECODER_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_JOINER_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_ENCODER_INT8_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_DECODER_INT8_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_JOINER_INT8_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_TOKENS_FILE: &str = "tokens.txt";
pub const KWS_BPE_FILE: &str = "bpe.model";

impl KwsModelPaths {
    /// Resolve the four bundle files under `bundle_dir` (the directory the model
    /// archive was extracted into). Pure path joining — does NOT check existence
    /// (use [`KwsModelPaths::all_present`] for that).
    pub fn from_bundle_dir(bundle_dir: &Path) -> Self {
        KwsModelPaths {
            encoder: bundle_dir.join(KWS_ENCODER_FILE),
            decoder: bundle_dir.join(KWS_DECODER_FILE),
            joiner: bundle_dir.join(KWS_JOINER_FILE),
            tokens: bundle_dir.join(KWS_TOKENS_FILE),
        }
    }

    /// Resolve the quantized int8 model files in the same upstream bundle.
    /// The token vocabulary is shared with the fp32 files.
    pub fn from_bundle_dir_int8(bundle_dir: &Path) -> Self {
        KwsModelPaths {
            encoder: bundle_dir.join(KWS_ENCODER_INT8_FILE),
            decoder: bundle_dir.join(KWS_DECODER_INT8_FILE),
            joiner: bundle_dir.join(KWS_JOINER_INT8_FILE),
            tokens: bundle_dir.join(KWS_TOKENS_FILE),
        }
    }

    /// True only when all four required files exist on disk (a complete bundle).
    /// The detector cannot stand up against a partial download, so the manager
    /// gates `WakeWordDetector::new` on this.
    pub fn all_present(&self) -> bool {
        self.encoder.exists()
            && self.decoder.exists()
            && self.joiner.exists()
            && self.tokens.exists()
    }

    pub fn bpe_model(&self) -> PathBuf {
        self.tokens
            .parent()
            .map(|dir| dir.join(KWS_BPE_FILE))
            .unwrap_or_else(|| PathBuf::from(KWS_BPE_FILE))
    }
}

/// Extracted pvporcupine 1.9.5 wheel layout under the app data wakeword dir.
/// The detector loads the native library dynamically so the main binary does not
/// link against or bundle Porcupine by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyPorcupinePaths {
    pub root: PathBuf,
}

impl LegacyPorcupinePaths {
    pub const DIRNAME: &'static str = "pvporcupine-1.9.5";

    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn library(&self) -> PathBuf {
        self.package_root().join(Self::library_relative_path())
    }

    pub fn model(&self) -> PathBuf {
        self.package_root()
            .join("lib")
            .join("common")
            .join("porcupine_params.pv")
    }

    pub fn keyword(&self, keyword: &str) -> PathBuf {
        self.package_root()
            .join("resources")
            .join("keyword_files")
            .join(Self::keyword_platform_dir())
            .join(format!(
                "{}_{}.ppn",
                normalize_name(keyword),
                Self::keyword_platform_suffix()
            ))
    }

    pub fn all_present_for_keyword(&self, keyword: &str) -> bool {
        self.library().exists() && self.model().exists() && self.keyword(keyword).exists()
    }

    pub fn platform_supported() -> bool {
        Self::library_relative_path_opt().is_some()
    }

    fn package_root(&self) -> PathBuf {
        self.root.join("pvporcupine")
    }

    fn library_relative_path() -> PathBuf {
        Self::library_relative_path_opt().unwrap_or_else(|| PathBuf::from("__unsupported__"))
    }

    fn library_relative_path_opt() -> Option<PathBuf> {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/windows/amd64/libpv_porcupine.dll"));
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/linux/x86_64/libpv_porcupine.so"));
        }
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/mac/x86_64/libpv_porcupine.dylib"));
        }
        #[allow(unreachable_code)]
        None
    }

    fn keyword_platform_dir() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            return "windows";
        }
        #[cfg(target_os = "linux")]
        {
            return "linux";
        }
        #[cfg(target_os = "macos")]
        {
            return "mac";
        }
        #[allow(unreachable_code)]
        "unsupported"
    }

    fn keyword_platform_suffix() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            return "windows";
        }
        #[cfg(target_os = "linux")]
        {
            return "linux";
        }
        #[cfg(target_os = "macos")]
        {
            return "mac";
        }
        #[allow(unreachable_code)]
        "unsupported"
    }
}

/// Everything needed to build/refresh a live keyword spotter.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeWordConfig {
    pub model: KwsModelPaths,
    /// Path to the generated `keywords.txt`, if the keywords are written to disk.
    /// `None` ⇒ pass the keyword content inline via `keywords_content`
    /// (`keywords_buf` — no temp file). The manager picks one; both are honored.
    pub keywords_file: Option<PathBuf>,
    /// Inline keywords content (the body produced by [`build_keywords_file`]).
    /// Used as sherpa's `keywords_buf` when present; lets the detector stand up
    /// without writing a temp file. Required if `keywords_file` is `None`.
    pub keywords_content: Option<String>,
    /// Ordered active keyword phrases (label half). Index == `word_index`.
    pub keywords: Vec<String>,
    pub provider: WakeWordProvider,
    /// 0..1 UI sensitivity, mapped to the per-keyword `#threshold`.
    pub sensitivity: f32,
    /// Seconds the wake gate stays armed after a hit (`general.wakeWordTimeout`,
    /// default 5). Enforced by the recorder state machine, NOT this module — we
    /// carry it for the manager to read.
    pub timeout_seconds: f32,
    pub num_threads: Option<i32>,
    /// Global sherpa `keywords_score`. `None` keeps the WinSTT default.
    pub keywords_score: Option<f32>,
}

impl WakeWordConfig {
    /// The global `keywords_threshold` for `KeywordSpotterConfig`. We push the REAL
    /// per-keyword thresholds into the keywords content (`#t` suffix), and keep the
    /// config global at the LOOSEST end so a per-keyword `#t` can only TIGHTEN,
    /// never loosen below it. (sherpa applies the per-keyword `#t` on top of the
    /// global; a global stricter than a `#t` would mask it.)
    pub fn global_threshold(&self) -> f32 {
        THRESHOLD_MIN
    }

    /// Default boost (`keywords_score`). sherpa default is 1.0; we lift it to 3.0
    /// to match Porcupine's out-of-box recall for 3+ token phrases. Short triggers
    /// (≤2 syllables) get a recall spike when boosted — see the SHORT-TRIGGER note
    /// in 05_*.md (mitigated per-keyword via `:boost`/`#threshold` suffixes).
    pub fn default_boost(&self) -> f32 {
        self.keywords_score.unwrap_or(3.0)
    }

    /// Resolve the keyword content the detector should hand to sherpa, preferring
    /// the on-disk file when present (sherpa reads it itself), else the inline buf.
    /// Returns `None` when neither is set (the detector then has zero keywords —
    /// a programming error the manager guards against, but we don't panic).
    fn keywords_inline(&self) -> Option<&str> {
        self.keywords_content.as_deref()
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. The detector — real sherpa-onnx 1.13.2 wiring (compiles unconditionally).
//
//    Mirrors `IWakeWordDetector`: `detect(chunk) -> WakeWordResult` + cleanup.
//    sherpa-onnx 1.13.2's KWS is a streaming OnlineStream model: build one
//    `KeywordSpotter` from the zipformer transducer + tokens, open ONE persistent
//    `OnlineStream` (loaded with the active keywords), then for each chunk
//    `accept_waveform` → drain `is_ready`/`decode` → poll `get_result`. A
//    non-empty `KeywordResult::keyword` is a HIT; we `reset` the stream to re-arm.
//    The matched LABEL string (the `@…` half) maps back to the keyword index via
//    the config's ordered `keywords` vector.
// ═════════════════════════════════════════════════════════════════════════════

pub struct WakeWordDetector {
    spotter: KeywordSpotter,
    stream: OnlineStream,
    keywords: Vec<String>,
    /// KWS models are trained at 16 kHz mono; the manager resamples upstream.
    sample_rate: i32,
}

// Compatibility behavior: sherpa-onnx `KeywordSpotter` and `OnlineStream` both
// implement `Send + Sync` (verified in the crate's trait list, docs.rs 1.13.2),
// so `WakeWordDetector` is auto `Send + Sync`. Do not add a manual `unsafe impl`;
// it would conflict with the auto impl. The detector can live behind the
// manager's mutex and be fed from the audio-consumer thread.

impl WakeWordDetector {
    /// Build a live spotter + armed stream from a [`WakeWordConfig`].
    ///
    /// The keyword content comes from `config.keywords_content` (inline
    /// `create_stream_with_keywords`) when present — no temp file needed; the
    /// spotter's own `keywords_file`/`keywords_buf` provide the fallback set so
    /// `create()` always has at least the configured keywords.
    pub fn new(config: &WakeWordConfig) -> anyhow::Result<Self> {
        let transducer = OnlineTransducerModelConfig {
            encoder: Some(path_string(&config.model.encoder)?),
            decoder: Some(path_string(&config.model.decoder)?),
            joiner: Some(path_string(&config.model.joiner)?),
        };

        let model_config = OnlineModelConfig {
            transducer,
            tokens: Some(path_string(&config.model.tokens)?),
            num_threads: config.num_threads.unwrap_or(1).max(1),
            provider: Some(config.provider.as_sherpa_str().to_string()),
            debug: false,
            ..OnlineModelConfig::default()
        };

        // Start from the crate's Default (sr=16000, dim=80, paths=4, blanks=1) so
        // we only override what we mean to. `keywords_buf` carries the inline
        // content; `keywords_file` carries the on-disk path if the manager wrote one.
        let spotter_config = KeywordSpotterConfig {
            model_config,
            // Per-keyword `#threshold` in the content TIGHTENS this global floor.
            keywords_threshold: config.global_threshold(),
            keywords_score: config.default_boost(),
            keywords_file: config.keywords_file.as_deref().map(path_string_lossy),
            keywords_buf: config.keywords_inline().map(str::to_string),
            ..KeywordSpotterConfig::default()
        };

        let spotter = KeywordSpotter::create(&spotter_config)
            .ok_or_else(|| anyhow::anyhow!("failed to create sherpa-onnx KeywordSpotter"))?;

        // Open the persistent stream. Prefer the inline keyword content (lets the
        // active phrase set be swapped per-detector without rebuilding the spotter);
        // fall back to the config-baked keywords otherwise.
        let stream = match config.keywords_inline() {
            Some(content) if !content.trim().is_empty() => {
                spotter.create_stream_with_keywords(content)
            }
            _ => spotter.create_stream(),
        };

        Ok(WakeWordDetector {
            spotter,
            stream,
            keywords: config.keywords.clone(),
            sample_rate: 16_000,
        })
    }

    /// Feed one 16 kHz mono f32 chunk; report any detection.
    ///
    /// Streaming contract (real sherpa-onnx 1.13.2): push the chunk, drain the
    /// ready/decode loop, then poll the result. A non-empty `keyword` is a HIT;
    /// we immediately `reset` the stream so the next phrase starts clean (sherpa's
    /// KWS does NOT auto-reset — without this the spotter keeps re-reporting the
    /// same terminal state). On a match the engine returns the LABEL (the `@…`
    /// half of the keyword line); we resolve its index in the active list
    /// (`-1` if somehow unknown).
    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        if chunk.is_empty() {
            return WakeWordResult::none();
        }

        // 1. Feed audio. accept_waveform takes (sample_rate: i32, samples: &[f32]).
        self.stream.accept_waveform(self.sample_rate, chunk);

        // 2. Drain the decode loop for everything the new audio made ready.
        while self.spotter.is_ready(&self.stream) {
            self.spotter.decode(&self.stream);
        }

        // 3. Poll for a keyword. get_result returns None until a phrase fires.
        match self.spotter.get_result(&self.stream) {
            Some(result) if !result.keyword.trim().is_empty() => {
                let label = result.keyword;
                let idx = self.index_of(&label);
                let word = self.display_word_for_label(&label, idx);
                // Re-arm: clear the terminal state so we don't double-fire.
                self.spotter.reset(&self.stream);
                WakeWordResult::hit(idx, word)
            }
            _ => WakeWordResult::none(),
        }
    }

    /// Map a detected label back to its position in the active keyword list.
    fn index_of(&self, label: &str) -> i32 {
        let needle = normalize_keyword_label(label);
        self.keywords
            .iter()
            .position(|k| normalize_keyword_label(k) == needle)
            .map(|p| p as i32)
            .unwrap_or(-1)
    }

    fn display_word_for_label(&self, label: &str, index: i32) -> String {
        if index >= 0 {
            if let Some(keyword) = self.keywords.get(index as usize) {
                return keyword.clone();
            }
        }
        label.trim().replace('_', " ")
    }

    /// Number of active keywords this detector is armed for.
    pub fn keyword_count(&self) -> usize {
        self.keywords.len()
    }

    /// Reset the streaming state (drop any partial decode). Fail-soft.
    pub fn reset(&mut self) {
        self.spotter.reset(&self.stream);
    }

    /// No-op today (sherpa owns the session); kept for `IWakeWordDetector` parity.
    pub fn cleanup(&mut self) {}
}

type PvPorcupineInit = unsafe extern "C" fn(
    *const c_char,
    c_int,
    *const *const c_char,
    *const c_float,
    *mut *mut c_void,
) -> c_int;
type PvPorcupineDelete = unsafe extern "C" fn(*mut c_void);
type PvPorcupineProcess = unsafe extern "C" fn(*mut c_void, *const c_short, *mut c_int) -> c_int;
type PvPorcupineFrameLength = unsafe extern "C" fn() -> c_int;
type PvSampleRate = unsafe extern "C" fn() -> c_int;

/// Runtime-loaded pvporcupine 1.9.5 detector for bundled built-in `.ppn`
/// phrases. The wheel is downloaded/extracted on demand by the manager; this
/// wrapper only validates the files and calls the C API.
pub struct LegacyPorcupineDetector {
    _library: Library,
    handle: *mut c_void,
    delete: PvPorcupineDelete,
    process: PvPorcupineProcess,
    frame_length: usize,
    sample_rate: i32,
    keyword: String,
    pending: Vec<i16>,
}

// The native handle is only touched while the manager holds its detector mutex.
unsafe impl Send for LegacyPorcupineDetector {}

impl LegacyPorcupineDetector {
    pub fn new(
        paths: &LegacyPorcupinePaths,
        keyword: &str,
        sensitivity: f32,
    ) -> anyhow::Result<Self> {
        if !paths.all_present_for_keyword(keyword) {
            anyhow::bail!(
                "legacy Porcupine files for '{}' are incomplete under {}",
                keyword,
                paths.root.display()
            );
        }

        let model = cstring_path(&paths.model())?;
        let keyword_path = cstring_path(&paths.keyword(keyword))?;
        let keyword_paths = [keyword_path.as_ptr()];
        let sensitivities = [sensitivity.clamp(0.0, 1.0) as c_float];

        let library = unsafe { Library::new(paths.library())? };
        let init: PvPorcupineInit = unsafe { *library.get(b"pv_porcupine_init\0")? };
        let delete: PvPorcupineDelete = unsafe { *library.get(b"pv_porcupine_delete\0")? };
        let process: PvPorcupineProcess = unsafe { *library.get(b"pv_porcupine_process\0")? };
        let frame_length_fn: PvPorcupineFrameLength =
            unsafe { *library.get(b"pv_porcupine_frame_length\0")? };
        let sample_rate_fn: PvSampleRate = unsafe { *library.get(b"pv_sample_rate\0")? };

        let mut handle: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            init(
                model.as_ptr(),
                1,
                keyword_paths.as_ptr(),
                sensitivities.as_ptr(),
                &mut handle,
            )
        };
        if status != 0 || handle.is_null() {
            anyhow::bail!("pv_porcupine_init failed with status {status}");
        }

        let frame_length = unsafe { frame_length_fn() };
        let sample_rate = unsafe { sample_rate_fn() };
        if frame_length <= 0 {
            unsafe { delete(handle) };
            anyhow::bail!("pv_porcupine_frame_length returned {frame_length}");
        }
        if sample_rate != 16_000 {
            unsafe { delete(handle) };
            anyhow::bail!("pv_sample_rate returned {sample_rate}; expected 16000");
        }

        Ok(Self {
            _library: library,
            handle,
            delete,
            process,
            frame_length: frame_length as usize,
            sample_rate,
            keyword: normalize_name(keyword),
            pending: Vec::with_capacity(frame_length as usize * 2),
        })
    }

    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        if chunk.is_empty() {
            return WakeWordResult::none();
        }

        self.pending.extend(chunk.iter().map(|sample| {
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * i16::MAX as f32) as i16
        }));

        let mut consumed = 0usize;
        while self.pending.len().saturating_sub(consumed) >= self.frame_length {
            let frame = &self.pending[consumed..consumed + self.frame_length];
            let mut result = -1;
            let status = unsafe { (self.process)(self.handle, frame.as_ptr(), &mut result) };
            consumed += self.frame_length;
            if status != 0 {
                log::warn!("pv_porcupine_process failed with status {status}");
                break;
            }
            if result >= 0 {
                self.pending.drain(..consumed);
                return WakeWordResult::hit(result, self.keyword.clone());
            }
        }

        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        WakeWordResult::none()
    }

    pub fn reset(&mut self) {
        self.pending.clear();
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }
}

impl Drop for LegacyPorcupineDetector {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { (self.delete)(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

fn cstring_path(path: &Path) -> anyhow::Result<CString> {
    if !path.exists() {
        anyhow::bail!("Porcupine path does not exist: {}", path.display());
    }
    let s = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Porcupine path is not valid UTF-8: {}", path.display()))?;
    CString::new(s).map_err(|err| anyhow::anyhow!("Porcupine path contains NUL byte: {err}"))
}

fn normalize_keyword_label(label: &str) -> String {
    label.trim().to_lowercase().replace('_', " ")
}

/// Validate a model path exists and render it as a UTF-8 string for the FFI
/// config. sherpa's C config takes `const char*`; a non-UTF-8 Windows path
/// would silently truncate, so we reject it loudly here.
fn path_string(path: &Path) -> anyhow::Result<String> {
    if !path.exists() {
        anyhow::bail!("KWS model file does not exist: {}", path.display());
    }
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("KWS model path is not valid UTF-8: {}", path.display()))
}

/// Lossy path → String for the OPTIONAL keywords-file path (existence already
/// implied by the manager; we don't hard-fail keyword-file rendering the way we
/// do for required model files).
fn path_string_lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Tests — only the DETERMINISTIC, pure-logic surface (no ML, no FFI).
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── preset resolution ──────────────────────────────────────────────────

    #[test]
    fn resolve_known_preset_returns_phrase() {
        assert_eq!(resolve_phrase("alexa"), "alexa");
        assert_eq!(resolve_phrase("jarvis"), "jarvis");
        assert_eq!(resolve_phrase("hey google"), "hey google");
    }

    #[test]
    fn resolve_is_case_insensitive() {
        assert_eq!(resolve_phrase("ALEXA"), "alexa");
        assert_eq!(resolve_phrase("Computer"), "computer");
    }

    #[test]
    fn resolve_normalizes_oww_underscore_names() {
        // The OWW-style persisted name "hey_jarvis" must spot "hey jarvis".
        assert_eq!(resolve_phrase("hey_jarvis"), "hey jarvis");
        // A stale underscore variant of a space-named preset resolves the same.
        assert_eq!(resolve_phrase("hey_google"), "hey google");
    }

    #[test]
    fn resolve_unknown_is_taken_as_custom_phrase() {
        assert_eq!(resolve_phrase("hey winstt"), "hey winstt");
        assert_eq!(resolve_phrase("  Take_A_Note  "), "take a note");
    }

    #[test]
    fn default_wake_word_alexa_is_present() {
        // settings-schema.ts defaults general.wakeWord to "alexa".
        assert!(WAKE_WORD_PRESETS.iter().any(|p| p.name == "alexa"));
    }

    // ── name normalization ─────────────────────────────────────────────────

    #[test]
    fn legacy_porcupine_keywords_are_known_builtins() {
        assert!(is_legacy_porcupine_keyword("alexa"));
        assert!(is_legacy_porcupine_keyword("hey_google"));
        assert!(is_legacy_porcupine_keyword("pico clock"));
        assert!(!is_legacy_porcupine_keyword("hey winstt"));
    }

    #[test]
    fn runtime_engine_routes_custom_phrases_to_sherpa() {
        assert_eq!(
            wakeword_runtime_engine_for_name("hey winstt"),
            WakeWordRuntimeEngine::SherpaKws
        );
    }

    #[cfg(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64")
    ))]
    #[test]
    fn runtime_engine_routes_supported_builtins_to_legacy_porcupine() {
        assert_eq!(
            wakeword_runtime_engine_for_name("computer"),
            WakeWordRuntimeEngine::LegacyPorcupine
        );
    }

    #[test]
    fn normalize_collapses_separators() {
        assert_eq!(normalize_name("hey__jarvis"), "hey jarvis");
        assert_eq!(normalize_name("ok   google"), "ok google");
        assert_eq!(normalize_name("_alexa_"), "alexa");
    }

    // ── f32 formatting ─────────────────────────────────────────────────────

    #[test]
    fn fmt_f32_keeps_integers_integral() {
        assert_eq!(fmt_f32(2.0), "2");
        assert_eq!(fmt_f32(3.0), "3");
    }

    #[test]
    fn fmt_f32_strips_trailing_zeros() {
        assert_eq!(fmt_f32(0.5), "0.5");
        assert_eq!(fmt_f32(0.35), "0.35");
        assert_eq!(fmt_f32(0.250), "0.25");
    }

    // ── sensitivity → threshold (the direction-flip invariant) ─────────────

    #[test]
    fn sensitivity_inverts_to_threshold() {
        // Higher UI sensitivity → looser (lower) sherpa threshold.
        let strict = sensitivity_to_threshold(0.0);
        let mid = sensitivity_to_threshold(0.6);
        let loose = sensitivity_to_threshold(1.0);
        assert!(strict > mid, "0.0 sensitivity must be the strictest");
        assert!(mid > loose, "1.0 sensitivity must be the loosest");
    }

    #[test]
    fn sensitivity_endpoints_hit_bounds() {
        assert_eq!(sensitivity_to_threshold(0.0), THRESHOLD_MAX);
        assert_eq!(sensitivity_to_threshold(1.0), THRESHOLD_MIN);
    }

    #[test]
    fn sensitivity_default_matches_sherpa_feel() {
        // WinSTT default 0.6 should land near sherpa's documented 0.25 default.
        let t = sensitivity_to_threshold(0.6);
        assert!((t - 0.22).abs() < 0.01, "got {t}, expected ~0.22");
    }

    #[test]
    fn sensitivity_clamps_out_of_range() {
        assert_eq!(sensitivity_to_threshold(-5.0), THRESHOLD_MAX);
        assert_eq!(sensitivity_to_threshold(99.0), THRESHOLD_MIN);
    }

    // ── keyword-content builder (the load-bearing per-keyword UX path) ─────

    #[test]
    fn to_line_tokens_only() {
        let spec = KeywordSpec {
            tokens: "▁HE Y ▁S I RI".to_string(),
            label: "hey siri".to_string(),
            boost: None,
            threshold: None,
        };
        assert_eq!(spec.to_line(), "▁HE Y ▁S I RI @hey siri");
    }

    #[test]
    fn to_line_with_boost_and_threshold_order() {
        // Order MUST be: tokens :boost #threshold @label
        let spec = KeywordSpec {
            tokens: "▁A L E X A".to_string(),
            label: "alexa".to_string(),
            boost: Some(2.0),
            threshold: Some(0.35),
        };
        assert_eq!(spec.to_line(), "▁A L E X A :2 #0.35 @alexa");
    }

    #[test]
    fn to_line_trims_token_and_label_whitespace() {
        let spec = KeywordSpec {
            tokens: "  ▁C O M P U T E R  ".to_string(),
            label: "  computer  ".to_string(),
            boost: None,
            threshold: Some(0.2),
        };
        assert_eq!(spec.to_line(), "▁C O M P U T E R #0.2 @computer");
    }

    #[test]
    fn build_keywords_file_joins_with_newlines_and_trailing_nl() {
        let specs = vec![
            KeywordSpec {
                tokens: "▁A L E X A".to_string(),
                label: "alexa".to_string(),
                boost: None,
                threshold: Some(sensitivity_to_threshold(0.6)),
            },
            KeywordSpec {
                tokens: "▁J AR VI S".to_string(),
                label: "jarvis".to_string(),
                boost: None,
                threshold: Some(sensitivity_to_threshold(0.6)),
            },
        ];
        let body = build_keywords_file(&specs);
        assert_eq!(body, "▁A L E X A #0.22 @alexa\n▁J AR VI S #0.22 @jarvis\n");
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn build_keywords_file_empty_is_empty() {
        assert_eq!(build_keywords_file(&[]), "");
    }

    // ── phrase tokenization (the bridge before the engine) ─────────────────

    #[test]
    fn tokenize_known_preset_uses_verified_bpe() {
        // Generated from the bundle's bpe.model with SentencePiece.
        assert_eq!(tokenize_phrase("alexa"), "▁A LE X A");
        assert_eq!(tokenize_phrase("computer"), "▁COMP U TER");
        assert_eq!(tokenize_phrase("hey siri"), "▁HE Y ▁S I RI");
        assert_eq!(tokenize_phrase("HEY SIRI"), "▁HE Y ▁S I RI");
        assert_eq!(tokenize_phrase("ok google"), "▁O K ▁GO O G LE");
    }

    #[test]
    fn tokenize_unknown_phrase_falls_back_to_chars() {
        assert_eq!(tokenize_phrase("hey winstt"), "▁H E Y ▁W I N S T T");
        assert_eq!(tokenize_phrase("custom"), "▁C U S T O M");
    }

    #[test]
    fn tokenize_with_vocabulary_prefers_model_native_pieces() {
        let vocab = HashSet::from([
            "▁N".to_string(),
            "OV".to_string(),
            "A".to_string(),
            "▁W".to_string(),
            "IN".to_string(),
            "S".to_string(),
            "T".to_string(),
        ]);
        assert_eq!(tokenize_phrase_with_vocabulary("nova", &vocab), "▁N OV A");
        assert_eq!(
            tokenize_phrase_with_vocabulary("winstt", &vocab),
            "▁W IN S T T"
        );
    }

    #[test]
    fn char_tokenize_marks_each_word_start() {
        // Each word gets its own ▁ word-start marker.
        assert_eq!(char_tokenize_phrase("hey winstt"), "▁H E Y ▁W I N S T T");
    }

    #[test]
    fn tokenize_blank_phrase_is_empty() {
        assert_eq!(tokenize_phrase("   "), "");
        assert_eq!(tokenize_phrase(""), "");
    }

    #[test]
    fn build_keyword_content_emits_tokens_threshold_label() {
        // alexa @0.6 sensitivity → #0.22, exact BPE-tokenized, labelled.
        let body = build_keyword_content("alexa", 0.6);
        assert_eq!(body, "▁A LE X A #0.22 @alexa\n");
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn build_keyword_content_blank_is_empty() {
        assert_eq!(build_keyword_content("", 0.6), "");
    }

    #[test]
    fn build_keyword_content_preset_uses_bpe_tokens() {
        let body = build_keyword_content("hey siri", 0.6);
        assert_eq!(body, "▁HE Y ▁S I RI #0.22 @hey_siri\n");
    }

    #[test]
    fn keyword_label_is_single_sherpa_token() {
        assert_eq!(keyword_label("hey google"), "hey_google");
        assert_eq!(keyword_label("  HEY   WinSTT  "), "hey_winstt");
    }

    #[test]
    fn build_keyword_content_with_vocabulary_uses_runtime_tokens() {
        let vocab = HashSet::from([
            "▁A".to_string(),
            "LE".to_string(),
            "X".to_string(),
            "A".to_string(),
        ]);
        let body = build_keyword_content_with_vocabulary("alexa", 0.6, &vocab);
        assert_eq!(body, "▁A LE X A #0.22 @alexa\n");
    }

    // ── KWS bundle path resolution ─────────────────────────────────────────

    #[test]
    fn kws_paths_from_bundle_dir_joins_known_files() {
        let dir = Path::new("/tmp/kws");
        let paths = KwsModelPaths::from_bundle_dir(dir);
        assert_eq!(paths.encoder, dir.join(KWS_ENCODER_FILE));
        assert_eq!(paths.tokens, dir.join(KWS_TOKENS_FILE));
    }

    #[test]
    fn kws_int8_paths_from_bundle_dir_joins_quantized_files() {
        let dir = Path::new("/tmp/kws");
        let paths = KwsModelPaths::from_bundle_dir_int8(dir);
        assert_eq!(paths.encoder, dir.join(KWS_ENCODER_INT8_FILE));
        assert_eq!(paths.decoder, dir.join(KWS_DECODER_INT8_FILE));
        assert_eq!(paths.joiner, dir.join(KWS_JOINER_INT8_FILE));
        assert_eq!(paths.tokens, dir.join(KWS_TOKENS_FILE));
    }

    #[test]
    fn kws_paths_all_present_false_when_missing() {
        let paths = KwsModelPaths::from_bundle_dir(Path::new("/definitely/not/here"));
        assert!(!paths.all_present());
    }

    // ── result helpers ─────────────────────────────────────────────────────

    #[test]
    fn wake_result_none_is_not_detected() {
        let r = WakeWordResult::none();
        assert!(!r.detected);
        assert_eq!(r.word_index, -1);
    }

    #[test]
    fn wake_result_hit_carries_index_and_word() {
        let r = WakeWordResult::hit(2, "computer");
        assert!(r.detected);
        assert_eq!(r.word_index, 2);
        assert_eq!(r.word, "computer");
    }

    // ── provider mapping ───────────────────────────────────────────────────

    #[test]
    fn provider_maps_to_sherpa_strings() {
        assert_eq!(WakeWordProvider::Cpu.as_sherpa_str(), "cpu");
        assert_eq!(WakeWordProvider::DirectMl.as_sherpa_str(), "directml");
        assert_eq!(WakeWordProvider::default(), WakeWordProvider::Cpu);
    }

    #[test]
    fn wakeword_provider_stays_cpu_for_all_stt_accelerators() {
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::DirectMl),
            WakeWordProvider::Cpu
        );
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::Cpu),
            WakeWordProvider::Cpu
        );
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::Cuda),
            WakeWordProvider::Cpu
        );
    }

    // ── config thresholds ──────────────────────────────────────────────────

    fn sample_config() -> WakeWordConfig {
        WakeWordConfig {
            model: KwsModelPaths {
                encoder: PathBuf::from("e.onnx"),
                decoder: PathBuf::from("d.onnx"),
                joiner: PathBuf::from("j.onnx"),
                tokens: PathBuf::from("tokens.txt"),
            },
            keywords_file: None,
            keywords_content: Some("▁A L E X A #0.22 @alexa\n".to_string()),
            keywords: vec!["alexa".to_string()],
            provider: WakeWordProvider::Cpu,
            sensitivity: 0.6,
            timeout_seconds: 5.0,
            num_threads: None,
            keywords_score: None,
        }
    }

    #[test]
    fn config_global_threshold_is_the_loosest_floor() {
        let cfg = sample_config();
        // The global must equal the loosest per-keyword threshold so a content
        // `#t` can only tighten, never be masked.
        assert_eq!(cfg.global_threshold(), THRESHOLD_MIN);
        assert!(cfg.global_threshold() <= sensitivity_to_threshold(1.0) + f32::EPSILON);
    }

    #[test]
    fn config_default_boost_matches_porcupine_feel() {
        let cfg = sample_config();
        assert_eq!(cfg.default_boost(), 3.0);
    }

    #[test]
    fn config_keywords_inline_prefers_content() {
        let cfg = sample_config();
        assert_eq!(cfg.keywords_inline(), Some("▁A L E X A #0.22 @alexa\n"));
        let empty = WakeWordConfig {
            keywords_content: None,
            ..sample_config()
        };
        assert_eq!(empty.keywords_inline(), None);
    }

    // ── path helpers (no model files required) ─────────────────────────────

    #[test]
    fn path_string_lossy_round_trips_ascii() {
        assert_eq!(path_string_lossy(Path::new("keywords.txt")), "keywords.txt");
    }

    #[test]
    fn path_string_rejects_missing_required_file() {
        // A required model file that does not exist must hard-fail (loud), so the
        // detector never stands up against a half-downloaded bundle.
        let err = path_string(Path::new("definitely-not-a-real-kws-file.onnx"));
        assert!(err.is_err());
    }
}
