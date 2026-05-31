// PORT IMPL — drafted against real APIs, pending compile.
// Source: thewh1teagle/kokoro-onnx (src/kokoro_onnx/{tokenizer.py,config.json}),
//   server/src/synthesizer/infrastructure/kokoro_synthesizer.py, espeak-ng CLI (`espeak-ng -q --ipa`).
//
// Grapheme→phoneme (G2P) for Kokoro. The whole Kokoro ecosystem trains on espeak-ng/Misaki IPA
// phonemes, so we reproduce that pipeline:
//   text  --espeak-ng--> IPA phoneme string  --filter to VOCAB--> token ids (Vec<i64>)
//
// Two phonemizer backends behind one `Phonemizer` trait so the GPL question (PORT/06_tts.md §1) is
// a runtime/feature decision, NOT baked into call sites:
//   * `EspeakCliPhonemizer` — shells out to the system `espeak-ng` binary. Process separation =
//     "mere aggregation" under the GPL (FSF guidance), so this keeps the main binary non-GPL.
//     This is the DEFAULT (no static link, no cargo-linked espeak-ng symbols).
//   * `NullPhonemizer` — deterministic ASCII-letter passthrough used in tests + as a last-resort
//     fallback when espeak-ng is absent (degraded pronunciation, but never panics).
//
// The token-id mapping (`VOCAB`) is the verbatim Kokoro v1.0 `config.json` "vocab" table
// (n_token = 178). Phonemes not in the vocab are dropped (matches the Python
// `"".join(filter(lambda p: p in self.vocab, phonemes))`).

#![allow(dead_code)]

use std::collections::HashMap;
use std::process::Command;
use std::sync::OnceLock;

/// Kokoro v1.0 max phoneme sequence length (the voice-pack first axis size).
/// Token sequences longer than this overflow the style-vector index → reject.
pub const MAX_PHONEME_LENGTH: usize = 510;

/// Errors from the G2P stage.
#[derive(Debug)]
pub enum PhonemizeError {
    /// The `espeak-ng` binary is not on PATH / failed to spawn.
    EspeakUnavailable(String),
    /// `espeak-ng` ran but exited non-zero / produced no usable output.
    EspeakFailed(String),
    /// Phoneme sequence exceeds `MAX_PHONEME_LENGTH` after vocab filtering.
    TooLong(usize),
}

impl std::fmt::Display for PhonemizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PhonemizeError::EspeakUnavailable(m) => write!(f, "espeak-ng unavailable: {m}"),
            PhonemizeError::EspeakFailed(m) => write!(f, "espeak-ng failed: {m}"),
            PhonemizeError::TooLong(n) => {
                write!(f, "phoneme sequence too long ({n} > {MAX_PHONEME_LENGTH})")
            }
        }
    }
}

impl std::error::Error for PhonemizeError {}

pub type PhonemizeResult<T> = Result<T, PhonemizeError>;

/// G2P backend. `phonemize` returns the raw IPA phoneme string for `text` in
/// language `lang` (a Kokoro lang code like `en-us`); `tokenize` maps that to
/// Kokoro vocab token ids (vocab-filtered, padding NOT yet applied).
pub trait Phonemizer: Send + Sync {
    /// Produce the IPA phoneme string for `text`. `lang` is a Kokoro lang code
    /// (`en-us`, `cmn`, `pt-br`, …) — implementations map it to the backend's
    /// own language identifier (`espeak_lang_for`).
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String>;

    /// True when this backend is actually usable (e.g. espeak-ng found on PATH).
    fn is_available(&self) -> bool;

    /// Map IPA phonemes → Kokoro vocab token ids. Default impl is shared across
    /// backends: filter to the vocab, look each up, drop unknowns. Mirrors the
    /// Python `tokenize()` (`[i for i in map(vocab.get, phonemes) if i is not None]`).
    fn tokenize(&self, phonemes: &str) -> PhonemizeResult<Vec<i64>> {
        let vocab = vocab();
        let ids: Vec<i64> = phonemes.chars().filter_map(|c| vocab.get(&c).copied()).collect();
        if ids.len() > MAX_PHONEME_LENGTH {
            return Err(PhonemizeError::TooLong(ids.len()));
        }
        Ok(ids)
    }

    /// Convenience: `phonemize` then `tokenize` in one call.
    fn text_to_tokens(&self, text: &str, lang: &str) -> PhonemizeResult<Vec<i64>> {
        let phonemes = self.phonemize(text, lang)?;
        self.tokenize(&phonemes)
    }
}

// ---------------------------------------------------------------------------
// espeak-ng CLI backend (process-separated → GPL "mere aggregation")
// ---------------------------------------------------------------------------

/// Shells out to the system `espeak-ng` binary. Process isolation keeps the
/// GPL-v3 espeak-ng out of the main binary's link graph (PORT/06_tts.md §1
/// escape hatch — separate process = mere aggregation).
///
/// Invocation: `espeak-ng -q --ipa=3 -v <lang> -- <text>`
///   `-q`        quiet (don't speak; we only want phonemes)
///   `--ipa=3`   emit IPA, tie-bars stripped, one token per phoneme cluster
///   `-v <lang>` voice/language (mapped from the Kokoro lang code)
///   `--`        end of options so leading-dash text isn't parsed as a flag
///
/// We strip espeak's stress/markup that isn't in Kokoro's vocab during the
/// shared `tokenize` filter, so no post-processing beyond whitespace-collapse
/// is needed here.
pub struct EspeakCliPhonemizer {
    /// Resolved binary name/path (`espeak-ng` by default; overridable for tests
    /// / portable installs that ship their own copy).
    binary: String,
}

impl Default for EspeakCliPhonemizer {
    fn default() -> Self {
        Self { binary: espeak_binary() }
    }
}

impl EspeakCliPhonemizer {
    pub fn new(binary: impl Into<String>) -> Self {
        Self { binary: binary.into() }
    }
}

impl Phonemizer for EspeakCliPhonemizer {
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        let espeak_lang = espeak_lang_for(lang);
        let output = Command::new(&self.binary)
            .arg("-q")
            .arg("--ipa=3")
            .arg("-v")
            .arg(espeak_lang)
            .arg("--")
            .arg(trimmed)
            .output()
            .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PhonemizeError::EspeakFailed(format!(
                "exit {:?}: {}",
                output.status.code(),
                stderr.trim()
            )));
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        Ok(clean_espeak_ipa(&raw))
    }

    fn is_available(&self) -> bool {
        // A cheap version probe; `espeak-ng --version` exits 0 when present.
        Command::new(&self.binary)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Collapse espeak `--ipa=3` output (one phoneme per line/space, with `_`
/// word separators and newlines) into the contiguous IPA string Kokoro's
/// tokenizer filters. We keep spaces (Kokoro vocab maps `' '` → 16) but drop
/// espeak's `_` cluster separators and CR/LF.
pub fn clean_espeak_ipa(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        let c = match ch {
            // espeak inserts `_` between phonemes in --ipa=3; not a Kokoro token.
            '_' => continue,
            '\r' | '\n' | '\t' => ' ',
            other => other,
        };
        if c == ' ' {
            // collapse runs of whitespace to a single space
            if prev_space {
                continue;
            }
            prev_space = true;
        } else {
            prev_space = false;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// Resolve the espeak-ng binary name. Windows installs expose `espeak-ng.exe`;
/// the env override lets portable installs ship their own and CI point at a
/// fixture. Returns the bare name (resolved against PATH) by default.
fn espeak_binary() -> String {
    if let Ok(p) = std::env::var("WINSTT_ESPEAK_NG") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    // `espeak-ng` resolves `espeak-ng.exe` on Windows via std's PATHEXT handling.
    "espeak-ng".to_string()
}

/// Map a Kokoro lang code to an espeak-ng `-v` voice id. Kokoro's lang codes are
/// mostly espeak-compatible already; the two that differ are `cmn` (espeak uses
/// `cmn` for Mandarin too, kept) and `pt-br` (espeak `pt-br`). Unknown codes
/// fall back to `en-us`.
pub fn espeak_lang_for(lang: &str) -> &'static str {
    match lang {
        "en-us" => "en-us",
        "en-gb" => "en-gb",
        "ja" => "ja",
        "cmn" => "cmn",
        "es" => "es",
        "fr" => "fr-fr",
        "hi" => "hi",
        "it" => "it",
        "pt-br" => "pt-br",
        _ => "en-us",
    }
}

// ---------------------------------------------------------------------------
// Null backend (deterministic, no native dep) — test + degraded fallback
// ---------------------------------------------------------------------------

/// A phonemizer that does NO real G2P — it passes through characters that are
/// already in Kokoro's vocab (mostly ASCII letters + punctuation). Pronunciation
/// is poor (it spells out letters), but it is deterministic, has zero native
/// deps, and lets the streaming pipeline run end-to-end in tests / when
/// espeak-ng is missing. The host warns the user when this path is taken.
pub struct NullPhonemizer;

impl Phonemizer for NullPhonemizer {
    fn phonemize(&self, text: &str, _lang: &str) -> PhonemizeResult<String> {
        // Lowercase so the ASCII letters land on the lowercase vocab ids.
        Ok(text.trim().to_lowercase())
    }

    fn is_available(&self) -> bool {
        true
    }
}

/// Pick the best available phonemizer: espeak-ng if present, else the null
/// fallback. The host calls this once at engine warm-up and keeps the choice.
pub fn default_phonemizer() -> Box<dyn Phonemizer> {
    let espeak = EspeakCliPhonemizer::default();
    if espeak.is_available() {
        Box::new(espeak)
    } else {
        Box::new(NullPhonemizer)
    }
}

// ---------------------------------------------------------------------------
// Kokoro v1.0 phoneme → token-id vocab (verbatim from config.json "vocab",
// n_token = 178). Built once into a HashMap<char, i64>.
// ---------------------------------------------------------------------------

/// The (char, id) pairs from Kokoro v1.0 `config.json` "vocab". Order is
/// irrelevant (lookup is by char); kept grouped as in the source for review.
/// SPIKE: a handful of rare glyphs in the JSON came through as the wrong
/// unicode escape in some renderings (the curly quotes at 14/15). The values
/// below use the canonical code points; verify against the shipped
/// config.json bytes during the compile loop (`// SPIKE:` markers inline).
#[rustfmt::skip]
const VOCAB_PAIRS: &[(char, i64)] = &[
    // punctuation / structural
    (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6),
    ('\u{2014}', 9),   // — em dash
    ('\u{2026}', 10),  // … ellipsis
    ('"', 11),
    ('(', 12), (')', 13),
    ('\u{201C}', 14),  // " left double quote  // SPIKE: confirm 14/15 ordering vs config.json
    ('\u{201D}', 15),  // " right double quote
    (' ', 16),
    ('\u{0303}', 17),  // ◌̃ combining tilde (nasalization)
    ('\u{02A3}', 18),  // ʣ
    ('\u{02A5}', 19),  // ʥ
    ('\u{02A6}', 20),  // ʦ
    ('\u{02A8}', 21),  // ʨ
    ('\u{1D5D}', 22),  // ᵝ
    ('\u{AB67}', 23),  // ꭧ
    // capital-letter pseudo-phonemes used by Misaki/espeak diphthong notation
    ('A', 24), ('I', 25), ('O', 31), ('Q', 33), ('S', 35), ('T', 36),
    ('W', 39), ('Y', 41),
    ('\u{1D4A}', 42),  // ᵊ
    // lowercase latin
    ('a', 43), ('b', 44), ('c', 45), ('d', 46), ('e', 47), ('f', 48),
    ('h', 50), ('i', 51), ('j', 52), ('k', 53), ('l', 54), ('m', 55),
    ('n', 56), ('o', 57), ('p', 58), ('q', 59), ('r', 60), ('s', 61),
    ('t', 62), ('u', 63), ('v', 64), ('w', 65), ('x', 66), ('y', 67),
    ('z', 68),
    // IPA letters
    ('\u{0251}', 69),  // ɑ
    ('\u{0250}', 70),  // ɐ
    ('\u{0252}', 71),  // ɒ
    ('\u{00E6}', 72),  // æ
    ('\u{03B2}', 75),  // β
    ('\u{0254}', 76),  // ɔ
    ('\u{0255}', 77),  // ɕ
    ('\u{00E7}', 78),  // ç
    ('\u{0256}', 80),  // ɖ
    ('\u{00F0}', 81),  // ð
    ('\u{02A4}', 82),  // ʤ
    ('\u{0259}', 83),  // ə
    ('\u{025A}', 85),  // ɚ
    ('\u{025B}', 86),  // ɛ
    ('\u{025C}', 87),  // ɜ
    ('\u{025F}', 90),  // ɟ
    ('\u{0261}', 92),  // ɡ (script g — NOT ascii 'g')
    ('\u{0265}', 99),  // ɥ
    ('\u{0268}', 101), // ɨ
    ('\u{026A}', 102), // ɪ
    ('\u{029D}', 103), // ʝ
    ('\u{026F}', 110), // ɯ
    ('\u{0270}', 111), // ɰ
    ('\u{014B}', 112), // ŋ
    ('\u{0273}', 113), // ɳ
    ('\u{0272}', 114), // ɲ
    ('\u{0274}', 115), // ɴ
    ('\u{00F8}', 116), // ø
    ('\u{0278}', 118), // ɸ
    ('\u{03B8}', 119), // θ
    ('\u{0153}', 120), // œ
    ('\u{0279}', 123), // ɹ
    ('\u{027E}', 125), // ɾ
    ('\u{027B}', 126), // ɻ
    ('\u{0281}', 128), // ʁ
    ('\u{027D}', 129), // ɽ
    ('\u{0282}', 130), // ʂ
    ('\u{0283}', 131), // ʃ
    ('\u{0288}', 132), // ʈ
    ('\u{02A7}', 133), // ʧ
    ('\u{028A}', 135), // ʊ
    ('\u{028B}', 136), // ʋ
    ('\u{028C}', 138), // ʌ
    ('\u{0263}', 139), // ɣ
    ('\u{0264}', 140), // ɤ
    ('\u{03C7}', 142), // χ
    ('\u{028E}', 143), // ʎ
    ('\u{0292}', 147), // ʒ
    ('\u{0294}', 148), // ʔ
    // suprasegmentals / prosody
    ('\u{02C8}', 156), // ˈ primary stress
    ('\u{02CC}', 157), // ˌ secondary stress
    ('\u{02D0}', 158), // ː length mark
    ('\u{02B0}', 162), // ʰ aspiration
    ('\u{02B2}', 164), // ʲ palatalization
    ('\u{2193}', 169), // ↓
    ('\u{2192}', 171), // →
    ('\u{2197}', 172), // ↗
    ('\u{2198}', 173), // ↘
    ('\u{1D7B}', 177), // ᵻ
];

static VOCAB: OnceLock<HashMap<char, i64>> = OnceLock::new();

/// The Kokoro v1.0 phoneme→id vocab as a lazily-built map.
pub fn vocab() -> &'static HashMap<char, i64> {
    VOCAB.get_or_init(|| VOCAB_PAIRS.iter().copied().collect())
}

// ===========================================================================
// Tests (pure logic — no espeak-ng / network required)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_has_178_entries() {
        // n_token = 178 in config.json; our table is the populated subset
        // (the id space is sparse — gaps like 7,8,26..30 are unassigned).
        assert_eq!(vocab().len(), VOCAB_PAIRS.len());
        // every populated id is unique
        let mut ids: Vec<i64> = VOCAB_PAIRS.iter().map(|(_, i)| *i).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate vocab ids");
    }

    #[test]
    fn vocab_core_mappings_match_config_json() {
        let v = vocab();
        assert_eq!(v.get(&'.'), Some(&4));
        assert_eq!(v.get(&' '), Some(&16));
        assert_eq!(v.get(&'a'), Some(&43));
        // script-g ɡ (U+0261), NOT ascii 'g' — ascii 'g' is intentionally absent.
        assert_eq!(v.get(&'\u{0261}'), Some(&92));
        assert!(v.get(&'g').is_none(), "ascii g must not be in the kokoro vocab");
        assert_eq!(v.get(&'\u{02C8}'), Some(&156)); // primary stress
    }

    #[test]
    fn null_phonemizer_tokenizes_ascii_via_vocab() {
        let p = NullPhonemizer;
        // "hi" → 'h'(50) 'i'(51)
        let toks = p.text_to_tokens("Hi", "en-us").unwrap();
        assert_eq!(toks, vec![50, 51]);
    }

    #[test]
    fn tokenize_drops_unknown_chars() {
        let p = NullPhonemizer;
        // 'g'(absent) and '5'(absent) dropped; 'a'(43) kept.
        let toks = p.tokenize("ga5").unwrap();
        assert_eq!(toks, vec![43]);
    }

    #[test]
    fn tokenize_rejects_overlong() {
        let p = NullPhonemizer;
        let long: String = std::iter::repeat('a').take(MAX_PHONEME_LENGTH + 1).collect();
        assert!(matches!(p.tokenize(&long), Err(PhonemizeError::TooLong(_))));
    }

    #[test]
    fn clean_espeak_ipa_collapses_separators_and_whitespace() {
        // espeak --ipa=3 style: phonemes joined by '_' with newlines between words.
        let raw = "h_\u{0259}_l_o\u{028A}\n_w_\u{025C}_l_d\r\n";
        let cleaned = clean_espeak_ipa(raw);
        assert!(!cleaned.contains('_'));
        assert!(!cleaned.contains('\n'));
        assert!(!cleaned.contains('\r'));
        // single internal space preserved, edges trimmed
        assert_eq!(cleaned, "h\u{0259}lo\u{028A} w\u{025C}ld");
    }

    #[test]
    fn espeak_lang_mapping_known_and_fallback() {
        assert_eq!(espeak_lang_for("en-us"), "en-us");
        assert_eq!(espeak_lang_for("fr"), "fr-fr");
        assert_eq!(espeak_lang_for("pt-br"), "pt-br");
        assert_eq!(espeak_lang_for("zzz"), "en-us"); // unknown → default
    }

    #[test]
    fn null_phonemizer_is_always_available() {
        assert!(NullPhonemizer.is_available());
    }
}
