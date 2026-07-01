// ═════════════════════════════════════════════════════════════════════════════
// 3. Keyword-content builder.
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

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use sentencepiece_rs::SentencePieceProcessor;

use super::config::KwsModelPaths;

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
pub(super) fn fmt_f32(value: f32) -> String {
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
pub(super) fn char_tokenize_phrase(phrase: &str) -> String {
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
