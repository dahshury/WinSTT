//! Magpie-TTS text frontend — a Rust port of the NeMo 3.0.0 tokenizers the v2607
//! checkpoint was trained with (`AggregatedTTSTokenizer` over 15 sub-tokenizers).
//!
//! Three tokenizer families cover the ten languages WinSTT ships:
//!
//! * **IPA** (`IPATokenizer` + `IpaG2p`) — English, German, Spanish, Brazilian Portuguese and
//!   Hindi. Dictionary G2P with grapheme fallback for out-of-vocabulary words, exactly as
//!   NeMo runs it with `phoneme_probability = 1.0` (the deterministic setting NeMo's own
//!   evaluation datasets use; the training-time 0.8 randomly spells words out instead).
//! * **ByT5 bytes** (`google/byt5-small` via `AutoTokenizer`) — French, Italian, Vietnamese
//!   and Korean: UTF-8 bytes + 3, then the ByT5 `</s>`.
//! * **Arabic characters** (`ArabicCharsTokenizer`, `charset_version: 1`).
//!
//! Mandarin (jieba + pypinyin) and Japanese (OpenJTalk) need native segmenters this crate does
//! not carry, so `zh`/`ja` are not offered.
//!
//! The exact NeMo token tables and per-tokenizer knobs are NOT re-typed here: the export dumps
//! them from the loaded checkpoint into `tokenizer/magpie_tokenizers.json` next to the graphs,
//! together with the pronunciation dictionaries extracted from the `.nemo`. Golden ids from
//! NeMo itself pin this port (`golden_tokens_match_nemo`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// File name of the tokenizer config inside the model's `tokenizer/` directory.
pub const TOKENIZER_CONFIG: &str = "magpie_tokenizers.json";

#[derive(Debug, Deserialize)]
struct TokenizerFile {
    eos_id: i64,
    tokenizers: HashMap<String, TokSpec>,
}

#[derive(Debug, Deserialize)]
struct TokSpec {
    offset: i64,
    kind: String,
    #[serde(default)]
    tokens: Vec<String>,
    #[serde(default)]
    punct_list: Vec<String>,
    #[serde(default)]
    locale: Option<String>,
    #[serde(default)]
    grapheme_case: Option<String>,
    #[serde(default)]
    grapheme_prefix: Option<String>,
    #[serde(default)]
    pad_with_space: bool,
    #[serde(default)]
    dict: Option<String>,
    #[serde(default)]
    heteronyms: Option<String>,
}

/// NeMo tokenizer name for a WinSTT language code (`en`, `en-us`, `pt-br`, `ar-sa`, …).
///
/// `None` for languages the checkpoint has no tokenizer for here (`zh`/`cmn`/`ja` need native
/// segmenters; anything else was never trained).
pub fn tokenizer_for_language(lang: &str) -> Option<&'static str> {
    let lower = lang.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    let primary = parts.next().unwrap_or("");
    let region = parts.next().unwrap_or("");
    Some(match primary {
        "en" => "english_phoneme",
        "de" => "german_phoneme",
        "es" => "spanish_phoneme",
        "pt" => "portuguese_Brazilian_phoneme",
        "hi" => "hindi_phoneme",
        "fr" => "french_chartokenizer",
        "it" => "italian_chartokenizer",
        "vi" => "vietnamese_chartokenizer",
        "ko" => "korean_chartokenizer",
        "ar" => match region {
            "ae" => "arabic_AE_chartokenizer",
            "sa" => "arabic_SA_chartokenizer",
            _ => "arabic_MSA_chartokenizer",
        },
        _ => return None,
    })
}

/// The text frontend: tokenizer config + lazily built IPA tokenizers (the English
/// dictionary alone is ~135k entries, so each is parsed on first use of its language).
pub struct MagpieText {
    dir: PathBuf,
    spec: TokenizerFile,
    ipa: HashMap<String, IpaTokenizer>,
}

impl MagpieText {
    /// `dir` holds `magpie_tokenizers.json` and the dictionaries it names.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join(TOKENIZER_CONFIG);
        let raw =
            std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let spec: TokenizerFile =
            serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            spec,
            ipa: HashMap::new(),
        })
    }

    /// Token ids for one chunk of text, INCLUDING the trailing text EOS (what NeMo's
    /// `chunk_text_for_inference` feeds the encoder).
    pub fn encode(&mut self, text: &str, tokenizer_name: &str) -> Result<Vec<i64>, String> {
        let spec = self
            .spec
            .tokenizers
            .get(tokenizer_name)
            .ok_or_else(|| format!("tokenizer {tokenizer_name} missing from config"))?;
        let offset = spec.offset;
        let mut ids: Vec<i64> = match spec.kind.as_str() {
            "byt5" => byt5_ids(text).into_iter().map(|i| i + offset).collect(),
            "chars" => chars_ids(text, spec),
            "ipa" => {
                if !self.ipa.contains_key(tokenizer_name) {
                    let tok = IpaTokenizer::load(&self.dir, spec)?;
                    self.ipa.insert(tokenizer_name.to_string(), tok);
                }
                self.ipa
                    .get(tokenizer_name)
                    .map(|t| t.encode(text))
                    .unwrap_or_default()
            }
            other => return Err(format!("tokenizer kind {other} is not supported")),
        };
        ids.push(self.spec.eos_id);
        Ok(ids)
    }
}

// ── ByT5 ────────────────────────────────────────────────────────────────────

/// `google/byt5-small` `encode`: every UTF-8 byte + 3 (pad/eos/unk come first), then `</s>` (1).
fn byt5_ids(text: &str) -> Vec<i64> {
    let mut ids: Vec<i64> = text.bytes().map(|b| i64::from(b) + 3).collect();
    ids.push(1);
    ids
}

// ── Arabic characters ───────────────────────────────────────────────────────

/// Python `{token: i for i, token in enumerate(tokens)}` — a later duplicate wins.
fn token_map(tokens: &[String], offset: i64) -> HashMap<&str, i64> {
    let mut map = HashMap::with_capacity(tokens.len());
    for (i, t) in tokens.iter().enumerate() {
        map.insert(t.as_str(), offset + i as i64);
    }
    map
}

/// `ArabicCharsTokenizer.encode`: any-locale preprocessing, keep known characters, collapse
/// spaces, strip trailing spaces, optional space padding.
fn chars_ids(text: &str, spec: &TokSpec) -> Vec<i64> {
    let map = token_map(&spec.tokens, spec.offset);
    let mut cs: Vec<String> = Vec::new();
    for c in any_locale_preprocess(text).chars() {
        let s = c.to_string();
        if c == ' ' {
            if cs.last().is_some_and(|l| l != " ") {
                cs.push(s);
            }
        } else if map.contains_key(s.as_str()) || spec.punct_list.contains(&s) {
            cs.push(s);
        }
    }
    finish(cs, spec.pad_with_space, &map)
}

fn finish(mut symbols: Vec<String>, pad_with_space: bool, map: &HashMap<&str, i64>) -> Vec<i64> {
    while symbols.last().is_some_and(|s| s == " ") {
        symbols.pop();
    }
    if pad_with_space {
        symbols.insert(0, " ".to_string());
        symbols.push(" ".to_string());
    }
    symbols
        .iter()
        .filter_map(|s| map.get(s.as_str()).copied())
        .collect()
}

// ── text preprocessing (nemo tokenizer_utils) ───────────────────────────────

/// `english_text_preprocessing(text, lower=False)`: NFD, drop combining marks, fold the
/// curly quotes to ASCII.
fn english_preprocess(text: &str) -> String {
    text.nfd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| match c {
            '\u{2019}' => '\'',
            '\u{201D}' | '\u{201C}' => '"',
            other => other,
        })
        .collect()
}

/// `any_locale_text_preprocessing`: NFC + right single quote → apostrophe.
fn any_locale_preprocess(text: &str) -> String {
    text.nfc()
        .map(|c| if c == '\u{2019}' { '\'' } else { c })
        .collect()
}

/// `WORD_CHARS_ALL` (Latin incl. Latin-1 accents, Indic blocks, Hangul).
fn is_any_locale_word_char(c: char) -> bool {
    matches!(c,
        'A'..='Z' | 'a'..='z'
        | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{FF}'
        | '\u{900}'..='\u{963}' | '\u{966}'..='\u{97F}'
        | '\u{980}'..='\u{9FF}' | '\u{B80}'..='\u{BFF}' | '\u{C00}'..='\u{C7F}'
        | '\u{C80}'..='\u{CFF}' | '\u{A80}'..='\u{AFF}'
        | '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}')
}

fn is_english_word_char(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// First character test of a dictionary line (`IpaG2p._parse_phoneme_dict`).
fn is_dict_line_start(c: char) -> bool {
    matches!(c,
        'A'..='Z' | 'a'..='z' | '\''
        | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}' | '\u{F8}'..='\u{FF}'
        | '\u{900}'..='\u{963}' | '\u{966}'..='\u{97F}'
        | '\u{980}'..='\u{9FF}' | '\u{B80}'..='\u{BFF}' | '\u{C00}'..='\u{C7F}'
        | '\u{C80}'..='\u{CFF}' | '\u{A80}'..='\u{AFF}'
        | '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}')
}

/// Python `str.isupper()`: at least one cased character and no lowercase one.
fn py_isupper(s: &str) -> bool {
    !s.chars().any(char::is_lowercase) && s.chars().any(char::is_uppercase)
}

/// One `_WORDS_RE_*` match.
#[derive(Debug, PartialEq, Eq)]
enum Piece {
    /// A word or a punctuation/space run — both go through `parse_one_word`.
    Token(String),
    /// `|kept as is|` spans, split on spaces.
    Unchanged(Vec<String>),
}

/// `re.findall` over `W+(?:[W\-']*W+)* | \|[^|]*\| | [^W|]+` for the locale's word class `W`.
fn word_tokenize(text: &str, is_word: fn(char) -> bool, lower: bool) -> Vec<Piece> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < n {
        let c = chars[i];
        if is_word(c) {
            // Greedy: the longest W/-/' run that ends on a word char.
            let mut j = i;
            let mut last_word = i;
            while j < n && (is_word(chars[j]) || chars[j] == '-' || chars[j] == '\'') {
                if is_word(chars[j]) {
                    last_word = j;
                }
                j += 1;
            }
            let word: String = chars[i..=last_word].iter().collect();
            out.push(Piece::Token(if lower { word.to_lowercase() } else { word }));
            i = last_word + 1;
        } else if c == '|' {
            match chars[i + 1..].iter().position(|&x| x == '|') {
                Some(rel) => {
                    let inner: String = chars[i + 1..i + 1 + rel].iter().collect();
                    out.push(Piece::Unchanged(
                        inner.split(' ').map(str::to_string).collect(),
                    ));
                    i += rel + 2;
                }
                // An unpaired `|` matches no alternative; findall steps over it.
                None => i += 1,
            }
        } else {
            let mut j = i;
            while j < n && !is_word(chars[j]) && chars[j] != '|' {
                j += 1;
            }
            out.push(Piece::Token(chars[i..j].iter().collect()));
            i = j;
        }
    }
    out
}

// ── IPA tokenizer (IPATokenizer + IpaG2p) ───────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GraphemeCase {
    Upper,
    Lower,
    Mixed,
}

struct IpaTokenizer {
    english: bool,
    case: GraphemeCase,
    prefix: String,
    /// word -> FIRST pronunciation (NeMo `ignore_ambiguous_words: false` takes `[0]`).
    dict: HashMap<String, Box<str>>,
    heteronyms: HashSet<String>,
    ids: HashMap<String, i64>,
    punct: HashSet<String>,
    pad_with_space: bool,
}

impl IpaTokenizer {
    fn load(dir: &Path, spec: &TokSpec) -> Result<Self, String> {
        let case = match spec.grapheme_case.as_deref().unwrap_or("upper") {
            "lower" => GraphemeCase::Lower,
            "mixed" => GraphemeCase::Mixed,
            _ => GraphemeCase::Upper,
        };
        let dict_name = spec.dict.as_deref().ok_or("ipa tokenizer without dict")?;
        let dict_path = dir.join(dict_name);
        let raw = std::fs::read_to_string(&dict_path)
            .map_err(|e| format!("read {}: {e}", dict_path.display()))?;
        let dict = parse_dict(&raw, case);
        let heteronyms = match spec.heteronyms.as_deref() {
            Some(name) => {
                let p = dir.join(name);
                std::fs::read_to_string(&p)
                    .map_err(|e| format!("read {}: {e}", p.display()))?
                    .lines()
                    .map(|l| apply_case(l.trim_end(), case))
                    .collect()
            }
            None => HashSet::new(),
        };
        let ids = token_map(&spec.tokens, spec.offset)
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        Ok(Self {
            english: spec.locale.as_deref() == Some("en-US"),
            case,
            prefix: spec.grapheme_prefix.clone().unwrap_or_default(),
            dict,
            heteronyms,
            ids,
            punct: spec.punct_list.iter().cloned().collect(),
            pad_with_space: spec.pad_with_space,
        })
    }

    fn encode(&self, text: &str) -> Vec<i64> {
        let pre = if self.english {
            english_preprocess(text)
        } else {
            any_locale_preprocess(text)
        };
        let g2p = self.g2p(&pre);
        // encode_from_g2p: known symbols and punctuation survive, everything else is skipped.
        let symbols: Vec<String> = g2p
            .into_iter()
            .filter(|p| self.ids.contains_key(p) || self.punct.contains(p))
            .collect();
        let map: HashMap<&str, i64> = self.ids.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        finish(symbols, self.pad_with_space, &map)
    }

    fn g2p(&self, text: &str) -> Vec<String> {
        let text: String = text.nfc().collect();
        let pieces = if self.english {
            word_tokenize(&text, is_english_word_char, true)
        } else {
            word_tokenize(&text, is_any_locale_word_char, false)
        };
        let mut prons = Vec::new();
        for piece in pieces {
            match piece {
                Piece::Unchanged(words) => {
                    prons.extend(words.into_iter().map(|w| format!("{}{w}", self.prefix)));
                }
                Piece::Token(word) => {
                    let (mut pron, handled) = self.parse_one_word(&word);
                    if !handled && word.contains('-') {
                        pron.clear();
                        for (k, sub) in word.split('-').enumerate() {
                            if k > 0 {
                                pron.push("-".to_string());
                            }
                            pron.extend(self.parse_one_word(sub).0);
                        }
                    }
                    prons.extend(pron);
                }
            }
        }
        prons
    }

    fn with_prefix(&self, word: &str) -> Vec<String> {
        word.chars()
            .map(|c| format!("{}{c}", self.prefix))
            .collect()
    }

    fn lookup(&self, word: &str) -> Option<Vec<String>> {
        self.dict
            .get(word)
            .map(|p| p.chars().map(|c| c.to_string()).collect())
    }

    fn in_dict(&self, word: &str) -> bool {
        self.dict.contains_key(word)
    }

    /// `IpaG2p.parse_one_word` with `phoneme_probability = 1.0`.
    fn parse_one_word(&self, word: &str) -> (Vec<String>, bool) {
        let word = apply_case(word, self.case);
        // Punctuation / spaces only (no word char or digit): passed through char by char.
        if !word
            .chars()
            .any(|c| is_any_locale_word_char(c) || c.is_numeric())
        {
            return (word.chars().map(|c| c.to_string()).collect(), true);
        }
        if self.heteronyms.contains(&word) {
            return (self.with_prefix(&word), true);
        }
        if self.english {
            let n = word.chars().count();
            let upper = word.to_uppercase();
            let absent = !self.in_dict(&word) && !self.in_dict(&upper);
            // `'s` suffix of an in-dictionary word.
            if n > 2 && (word.ends_with("'s") || word.ends_with("'S")) && absent {
                let base = &word[..word.len() - 2];
                if let Some((found, mut pron)) = self.base_lookup(base) {
                    match found.chars().last() {
                        Some('T' | 't') => pron.push("s".into()),
                        Some('S' | 's') => {
                            pron.push("ɪ".into());
                            pron.push("z".into());
                        }
                        _ => pron.push("z".into()),
                    }
                    return (pron, true);
                }
            }
            // Plain `s` suffix of an in-dictionary word.
            if n > 1 && (word.ends_with('s') || word.ends_with('S')) && absent {
                let base = &word[..word.len() - 1];
                if let Some((found, mut pron)) = self.base_lookup(base) {
                    if matches!(found.chars().last(), Some('T' | 't')) {
                        pron.push("s".into());
                    } else {
                        pron.push("z".into());
                    }
                    return (pron, true);
                }
            }
        }
        if let Some(p) = self.lookup(&word) {
            return (p, true);
        }
        if self.case == GraphemeCase::Mixed {
            let upper = word.to_uppercase();
            if let Some(p) = self.lookup(&upper) {
                return (p, true);
            }
        }
        (self.with_prefix(&word), false)
    }

    fn base_lookup(&self, base: &str) -> Option<(String, Vec<String>)> {
        if let Some(p) = self.lookup(base) {
            return Some((base.to_string(), p));
        }
        let upper = base.to_uppercase();
        self.lookup(&upper).map(|p| (upper, p))
    }
}

fn apply_case(word: &str, case: GraphemeCase) -> String {
    match case {
        GraphemeCase::Upper => word.to_uppercase(),
        GraphemeCase::Lower => word.to_lowercase(),
        GraphemeCase::Mixed => word.to_string(),
    }
}

/// `IpaG2p._parse_phoneme_dict` + `_normalize_dict`: NFC lines, `WORD(2)` variants merged
/// under one key (first pronunciation kept), keys re-cased in file order with a later key
/// overwriting an earlier one that cases to the same string, and — for `mixed` case — an
/// upper-cased alias for every key that is not already upper case.
fn parse_dict(raw: &str, case: GraphemeCase) -> HashMap<String, Box<str>> {
    let mut order: Vec<String> = Vec::new();
    let mut first: HashMap<String, Box<str>> = HashMap::new();
    for line in raw.split_inclusive('\n') {
        let line: String = line.nfc().collect();
        if !line.chars().next().is_some_and(is_dict_line_start) {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(word), Some(_)) = (parts.next(), parts.clone().next()) else {
            continue;
        };
        let word = strip_variant_suffix(word);
        let pron: String = parts.collect::<Vec<_>>().concat();
        if let std::collections::hash_map::Entry::Vacant(slot) = first.entry(word) {
            order.push(slot.key().clone());
            slot.insert(pron.into_boxed_str());
        }
    }
    let mut out: HashMap<String, Box<str>> = HashMap::with_capacity(order.len() * 2);
    for word in order {
        let Some(pron) = first.remove(&word) else {
            continue;
        };
        let cased = apply_case(&word, case);
        if case == GraphemeCase::Mixed && !py_isupper(&cased) {
            out.insert(cased.to_uppercase(), pron.clone());
        }
        out.insert(cased, pron);
    }
    out
}

/// `re.sub(r"\([0-9]+\)", "", word)`.
fn strip_variant_suffix(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let b = word.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'(' {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < b.len() && b[j] == b')' {
                i = j + 1;
                continue;
            }
        }
        // Copy one full UTF-8 char.
        let ch_len = word[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&word[i..i + ch_len]);
        i += ch_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_resolve_to_nemo_tokenizers() {
        assert_eq!(tokenizer_for_language("en-us"), Some("english_phoneme"));
        assert_eq!(tokenizer_for_language("EN_GB"), Some("english_phoneme"));
        assert_eq!(
            tokenizer_for_language("pt-br"),
            Some("portuguese_Brazilian_phoneme")
        );
        assert_eq!(
            tokenizer_for_language("ar"),
            Some("arabic_MSA_chartokenizer")
        );
        assert_eq!(
            tokenizer_for_language("ar-SA"),
            Some("arabic_SA_chartokenizer")
        );
        assert_eq!(tokenizer_for_language("ko"), Some("korean_chartokenizer"));
        assert_eq!(tokenizer_for_language("cmn"), None);
        assert_eq!(tokenizer_for_language("ja"), None);
    }

    #[test]
    fn byt5_is_bytes_plus_three_then_eos() {
        assert_eq!(byt5_ids("aé"), vec![97 + 3, 0xC3 + 3, 0xA9 + 3, 1]);
    }

    #[test]
    fn word_tokenizer_matches_the_nemo_regex() {
        let p = word_tokenize("Don't stop-me, 42 |x y| a|b", is_english_word_char, true);
        assert_eq!(
            p,
            vec![
                Piece::Token("don't".into()),
                Piece::Token(" ".into()),
                Piece::Token("stop-me".into()),
                Piece::Token(", 42 ".into()),
                Piece::Unchanged(vec!["x".into(), "y".into()]),
                Piece::Token(" ".into()),
                Piece::Token("a".into()),
                Piece::Token("b".into()),
            ]
        );
        // A trailing hyphen/apostrophe is not part of the word.
        let p = word_tokenize("rock-' n", is_english_word_char, false);
        assert_eq!(p[0], Piece::Token("rock".into()));
        assert_eq!(p[1], Piece::Token("-' ".into()));
    }

    #[test]
    fn dictionary_keeps_first_variant_and_mixed_case_aliases() {
        let raw = ";;; comment\nREAD  ɹ ˈ i d\nREAD(2)  ɹ ˈ ɛ d\nHaus h a ʊ s\n";
        let upper = parse_dict(raw, GraphemeCase::Upper);
        assert_eq!(upper.get("READ").map(|s| &**s), Some("ɹˈid"));
        assert_eq!(upper.get("HAUS").map(|s| &**s), Some("haʊs"));
        let mixed = parse_dict(raw, GraphemeCase::Mixed);
        assert_eq!(mixed.get("Haus").map(|s| &**s), Some("haʊs"));
        assert_eq!(mixed.get("HAUS").map(|s| &**s), Some("haʊs"));
        assert!(!mixed.contains_key(";;;"));
    }

    #[test]
    fn english_preprocessing_strips_accents_and_folds_quotes() {
        assert_eq!(english_preprocess("café “x” it’s"), "cafe \"x\" it's");
    }
}
