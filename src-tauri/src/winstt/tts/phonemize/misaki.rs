// eSpeak-ng IPA → misaki spelling (American English).
//
// Source: sahilmahendrakar/paradee `web/misaki.js` (Apache-2.0), itself an adaptation of misaki's
// own eSpeak fallback table (`misaki/espeak.py`, `EspeakFallback`, American English) to eSpeak
// output that carries NO tie marks between a diphthong's halves — which is exactly what our
// `espeak_TextToPhonemes` path emits once `clean_espeak_ipa` drops the `_` separators.
//
// WHY: Kokoro v1.0 and everything distilled from it (Paradee) were trained on misaki phonemes. The
// two G2Ps spell the same sounds differently — eSpeak writes `aɪ`/`oʊ`/`eɪ` where misaki writes
// the single-symbol `I`/`O`/`A`, keeps `ː` length marks misaki never emits, writes the flap as `ɾ`
// (misaki `T`) and so on. Kokoro-82M is robust enough to read eSpeak spelling; Paradee is not
// (the upstream author measured ~31% Whisper WER on raw eSpeak vs ~2% after this conversion).

use super::{PhonemizeResult, Phonemizer};

/// The ordered eSpeak → misaki substring rewrites (misaki.js `E2M`). ORDER IS LOAD-BEARING: the
/// two-symbol diphthongs must be collapsed before their halves are rewritten (`eɪ` before `e`,
/// `ʲo` before `ʲ`), exactly as the JS applies them one after another.
const E2M: &[(&str, &str)] = &[
    ("\u{0294}\u{02CC}n\u{0329}", "\u{0294}n"), // ʔˌn̩ → ʔn
    ("\u{0294}n\u{0329}", "\u{0294}n"),         // ʔn̩ → ʔn
    ("a\u{026A}", "I"),                         // aɪ
    ("a\u{028A}", "W"),                         // aʊ
    ("d\u{0292}", "\u{02A4}"),                  // dʒ → ʤ
    ("e\u{026A}", "A"),                         // eɪ
    ("e", "A"),
    ("t\u{0283}", "\u{02A7}"),         // tʃ → ʧ
    ("\u{0254}\u{026A}", "Y"),         // ɔɪ
    ("\u{02B2}o", "jo"),               // ʲo
    ("\u{02B2}\u{0259}", "j\u{0259}"), // ʲə
    ("\u{02B2}", ""),                  // ʲ
    ("\u{025A}", "\u{0259}\u{0279}"),  // ɚ → əɹ
    ("r", "\u{0279}"),                 // r → ɹ
    ("x", "k"),
    ("\u{00E7}", "k"), // ç → k
    ("\u{026C}", "l"), // ɬ → l
    ("\u{0303}", ""),  // combining tilde (nasalisation)
];

/// Combining vertical line below — eSpeak's syllabic mark (`n̩`, `l̩`).
const SYLLABIC: char = '\u{0329}';
/// misaki's reduced-vowel superscript (`ᵊ`).
const SCHWA_SUPER: char = '\u{1D4A}';

/// The JS `[\s;:,.!?—…"“”()]` class — what may follow a word-final symbol.
fn is_word_end(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            ';' | ':'
                | ','
                | '.'
                | '!'
                | '?'
                | '\u{2014}'
                | '\u{2026}'
                | '"'
                | '\u{201C}'
                | '\u{201D}'
                | '('
                | ')'
        )
}

/// Convert eSpeak-ng IPA (as produced by our phonemizer, American English) to misaki's spelling.
/// A faithful port of misaki.js `toMisaki`; every step is a whole-string pass in the JS order.
pub fn espeak_to_misaki(espeak: &str) -> String {
    let mut ps = espeak.to_string();
    for (from, to) in E2M {
        if ps.contains(from) {
            ps = ps.replace(from, to);
        }
    }

    // `(\S)̩` → `ᵊ$1`, then drop any syllabic mark left (one after whitespace / at the start).
    let chars: Vec<char> = ps.chars().collect();
    let mut out = String::with_capacity(ps.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == SYLLABIC {
            i += 1;
            continue;
        }
        if !c.is_whitespace() && chars.get(i + 1) == Some(&SYLLABIC) {
            out.push(SCHWA_SUPER);
            out.push(c);
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }

    // misaki writes a word-final syllabic l as `ᵊl` (naval → nˈAvᵊl); key on word-final `əl`.
    // Then `ɐ` → `ə` EXCEPT word-finally, where misaki's lexicon keeps `ɐ` for the article "a".
    let chars: Vec<char> = out.chars().collect();
    let mut ps = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\u{0259}' && next == Some('l') && chars.get(i + 2).is_none_or(|&n| is_word_end(n))
        {
            ps.push(SCHWA_SUPER);
            ps.push('l');
            i += 2;
            continue;
        }
        if c == '\u{0250}' && next.is_some_and(|n| !is_word_end(n)) {
            ps.push('\u{0259}');
        } else {
            ps.push(c);
        }
        i += 1;
    }

    // Diphthong / length clean-up, in the JS order. `ɜːɹ` must go before the bare `ɜː`.
    let ps = ps
        .replace("o\u{028A}", "O") // oʊ
        .replace("\u{025C}\u{02D0}\u{0279}", "\u{025C}\u{0279}") // ɜːɹ → ɜɹ
        .replace("\u{025C}\u{02D0}", "\u{025C}\u{0279}") // ɜː → ɜɹ
        .replace("\u{026A}\u{0259}", "i\u{0259}") // ɪə → iə
        .replace('\u{02D0}', "") // ː
        .replace('o', "\u{0254}") // a remaining bare o → ɔ
        .replace('\u{027E}', "T") // ɾ (flap) → T
        .replace('\u{0294}', "t"); // ʔ → t
    ps
}

/// A [`Phonemizer`] that respells another backend's eSpeak output to misaki for the listed lang
/// codes (and passes every other language through untouched). The table is AMERICAN English —
/// misaki's British fallback is a different table — so callers scope it to `en-us`.
pub struct MisakiPhonemizer {
    inner: Box<dyn Phonemizer>,
    langs: &'static [&'static str],
}

impl MisakiPhonemizer {
    pub fn new(inner: Box<dyn Phonemizer>, langs: &'static [&'static str]) -> Self {
        Self { inner, langs }
    }
}

impl Phonemizer for MisakiPhonemizer {
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String> {
        let phonemes = self.inner.phonemize(text, lang)?;
        Ok(if self.langs.contains(&lang) {
            espeak_to_misaki(&phonemes)
        } else {
            phonemes
        })
    }

    fn is_available(&self) -> bool {
        self.inner.is_available()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echoes its input, standing in for eSpeak.
    struct Echo;
    impl Phonemizer for Echo {
        fn phonemize(&self, text: &str, _lang: &str) -> PhonemizeResult<String> {
            Ok(text.to_string())
        }
        fn is_available(&self) -> bool {
            true
        }
    }

    #[test]
    fn wrapper_only_respells_its_languages() {
        let p = MisakiPhonemizer::new(Box::new(Echo), &["en-us"]);
        assert_eq!(p.phonemize("hˈoʊm", "en-us").unwrap(), "hˈOm");
        assert_eq!(p.phonemize("hˈəʊm", "en-gb").unwrap(), "hˈəʊm");
        assert!(p.is_available());
    }

    #[test]
    fn collapses_diphthongs_to_single_symbols() {
        // "I like Kokoro" — aɪ → I, oʊ → O, eɪ → A, aʊ → W, ɔɪ → Y.
        assert_eq!(espeak_to_misaki("ˈaɪ lˈaɪk"), "ˈI lˈIk");
        assert_eq!(espeak_to_misaki("hˈoʊm"), "hˈOm");
        assert_eq!(espeak_to_misaki("dˈeɪ"), "dˈA");
        assert_eq!(espeak_to_misaki("nˈaʊ"), "nˈW");
        assert_eq!(espeak_to_misaki("bˈɔɪ"), "bˈY");
        // A bare `e` (eSpeak's unreduced "e" in e.g. "café") also becomes A.
        assert_eq!(espeak_to_misaki("kæfˈe"), "kæfˈA");
    }

    #[test]
    fn affricates_and_rhotics() {
        assert_eq!(espeak_to_misaki("dʒˈʌdʒ"), "ʤˈʌʤ");
        assert_eq!(espeak_to_misaki("tʃˈɜːtʃ"), "ʧˈɜɹʧ");
        // ɚ → əɹ; a stray trilled r → ɹ.
        assert_eq!(espeak_to_misaki("wˈɔːtɚ"), "wˈɔtəɹ");
        assert_eq!(espeak_to_misaki("rˈʌn"), "ɹˈʌn");
        // ɜːɹ collapses to ɜɹ (not ɜɹɹ).
        assert_eq!(espeak_to_misaki("bˈɜːɹd"), "bˈɜɹd");
    }

    #[test]
    fn length_marks_are_dropped_and_bare_o_becomes_open() {
        assert_eq!(espeak_to_misaki("sˈiː"), "sˈi");
        assert_eq!(espeak_to_misaki("ɡˈɑːɹdən"), "ɡˈɑɹdən");
        // `o` left after oʊ → O becomes ɔ (eSpeak's `oːɹ` in "four").
        assert_eq!(espeak_to_misaki("fˈoːɹ"), "fˈɔɹ");
        assert_eq!(espeak_to_misaki("nˈɪəɹ"), "nˈiəɹ");
    }

    #[test]
    fn flaps_and_glottal_stops() {
        // "better" — the flap is misaki's T; "button" — ʔn̩ → ʔn → tn.
        assert_eq!(espeak_to_misaki("bˈɛɾɚ"), "bˈɛTəɹ");
        assert_eq!(espeak_to_misaki("bˈʌʔn̩"), "bˈʌtn");
        assert_eq!(espeak_to_misaki("bˈʌʔˌn̩"), "bˈʌtn");
    }

    #[test]
    fn syllabic_consonants_take_a_superscript_schwa() {
        // l̩ → ᵊl (the mark moves IN FRONT of its consonant).
        assert_eq!(espeak_to_misaki("bˈɑːtl̩"), "bˈɑtᵊl");
        // A dangling mark after a space is simply dropped.
        assert_eq!(espeak_to_misaki("a \u{0329}b"), "a b");
    }

    #[test]
    fn word_final_schwa_l_becomes_superscript() {
        assert_eq!(espeak_to_misaki("nˈeɪvəl"), "nˈAvᵊl");
        assert_eq!(espeak_to_misaki("nˈeɪvəl ʃˈɪp"), "nˈAvᵊl ʃˈɪp");
        assert_eq!(espeak_to_misaki("nˈeɪvəl,"), "nˈAvᵊl,");
        // Not word-final → untouched.
        assert_eq!(espeak_to_misaki("ɪlˈɛktɹɪkəli"), "ɪlˈɛktɹɪkəli");
    }

    #[test]
    fn near_open_central_vowel_keeps_only_the_article() {
        // Word-final ɐ (the article "a") survives; inside a word it is ə.
        assert_eq!(espeak_to_misaki("ɐ kˈæt"), "ɐ kˈæt");
        assert_eq!(espeak_to_misaki("ɐbˈaʊt"), "əbˈWt");
        assert_eq!(espeak_to_misaki("sˈoʊfɐ"), "sˈOfɐ");
    }

    #[test]
    fn palatalisation_velars_and_nasalisation() {
        assert_eq!(espeak_to_misaki("mʲo"), "mjɔ");
        assert_eq!(espeak_to_misaki("mʲə"), "mjə");
        assert_eq!(espeak_to_misaki("mʲa"), "ma");
        assert_eq!(espeak_to_misaki("lˈɔx"), "lˈɔk");
        assert_eq!(espeak_to_misaki("ɪç"), "ɪk");
        assert_eq!(espeak_to_misaki("ɬ"), "l");
        assert_eq!(espeak_to_misaki("ɑ̃"), "ɑ");
    }

    #[test]
    fn output_stays_inside_the_kokoro_vocab() {
        // Every symbol misaki introduces must be a Kokoro/Paradee token, or the conversion would
        // silently DROP phonemes at tokenisation.
        let vocab = super::super::vocab();
        let converted = espeak_to_misaki(
            "ðə kwˈɪk bɹˈaʊn fˈɑːks dʒˈʌmpt ˌoʊvɚ ðə lˈeɪzi dˈɔɡ ænd bˈɑːtl̩ bˈʌʔn̩ bˈɛɾɚ bˈɔɪ",
        );
        for c in converted.chars() {
            assert!(
                vocab.contains_key(&c),
                "{c:?} (U+{:04X}) not in vocab",
                c as u32
            );
        }
    }

    #[test]
    fn empty_and_plain_ascii_pass_through() {
        assert_eq!(espeak_to_misaki(""), "");
        assert_eq!(espeak_to_misaki("mˈæn"), "mˈæn");
    }
}
