// Kokoro v1.0 phoneme → token-id vocab (verbatim from config.json "vocab",
// n_token = 178). Built once into a HashMap<char, i64>. Split out of
// `phonemize.rs` — a static data table paired with its lazily-built lookup map.

use std::collections::HashMap;
use std::sync::OnceLock;

/// The (char, id) pairs from Kokoro v1.0 `config.json` "vocab". Order is
/// irrelevant (lookup is by char); kept grouped as in the source for review.
/// A handful of rare glyphs (the curly quotes at 14/15) can render with the
/// wrong unicode escape; the values below use the canonical code points.
#[rustfmt::skip]
pub(super) const VOCAB_PAIRS: &[(char, i64)] = &[
    // punctuation / structural
    (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6),
    ('\u{2014}', 9),   // — em dash
    ('\u{2026}', 10),  // … ellipsis
    ('"', 11),
    ('(', 12), (')', 13),
    ('\u{201C}', 14),  // " left double quote
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
