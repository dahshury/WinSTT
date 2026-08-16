// Source: onnx-asr fork src/onnx_asr/models/whisper/_base.py
//   (bytes_to_unicode, _decode_text, _decode_text_preserve_leading_space, the static
//    prompt builders, _is_multilingual, _extract_segments) and WinSTT memory
//   (project_whisper_incomplete_vocab_and_transcription_failed → vocab.get not vocab[id]).
//
// Hand-rolled Whisper BPE / byte tokenizer + special-token table. onnx-asr deliberately
// does NOT use HuggingFace `tokenizers` for Whisper — it parses `vocab.json` +
// `added_tokens.json` with serde and rebuilds the GPT-2 byte_decoder, so we mirror that
// exactly for byte-identical decode (and a smaller dep tree).
//
// Decode is byte-level: each vocab token is a string of "byte-unicode" chars; mapping
// each char back through the inverse GPT-2 byte table yields raw bytes, which are then
// UTF-8 decoded (lossy). Special tokens (`<|...|>`) are skipped during text decode.

use std::collections::HashMap;
use std::path::Path;

use super::{SttError, SttResult};

/// Parsed Whisper vocabulary + special-token ids + the GPT-2 inverse byte map.
///
/// Built from `vocab.json` (+ optional `added_tokens.json`). All decoding goes through
/// `vocab.get(id)` (NOT direct indexing) so an incomplete vocab — e.g. CrisperWhisper
/// ships 46674/51866 ids — degrades to dropped tokens instead of a crash
/// (memory `project_whisper_incomplete_vocab_and_transcription_failed`).
pub struct WhisperTokenizer {
    /// token string → id.
    tokens: HashMap<String, i64>,
    /// id → token string (inverse of `tokens`). Sparse-tolerant via `.get`.
    vocab: HashMap<i64, String>,
    /// GPT-2 "byte-unicode" char → original byte (inverse of `bytes_to_unicode`).
    byte_decoder: HashMap<char, u8>,
    /// original byte → GPT-2 "byte-unicode" char (forward map, for prompt encoding).
    byte_encoder: [char; 256],

    pub bos_token_id: i64,
    pub eos_token_id: i64,
    pub transcribe_token_id: i64,
    pub translate_token_id: i64,
    pub notimestamps_token_id: i64,
    /// `<|nospeech|>` on Whisper exports, or `<|nocaptions|>` on older variants.
    pub nospeech_token_id: Option<i64>,
    /// `<|startofprev|>` — the initial-prompt prefix marker; None on `.en` / very old
    /// exports that drop it (then initial-prompt biasing is silently unavailable).
    pub startofprev_id: Option<i64>,
    /// `<|0.00|>` — the first segment-timestamp token; None when absent.
    pub timestamp_begin_id: Option<i64>,
    /// 0.02 s per timestamp step (Whisper convention).
    pub timestamp_step_s: f32,
    /// True iff the export is multilingual (`<|fr|>` present). `.en` exports are false
    /// and MUST NOT have a language token written into prompt position 1.
    pub is_multilingual: bool,

    /// CrisperWhisper 2.0 verbatim-mode prompt prefix: `[verbatim_1]..[verbatim_5]` ids in
    /// order, emitted BEFORE `<|startoftranscript|>` (the training-time prompt layout is
    /// `{mode_tags} {<htx> hotwords <ehtx>?} <|startoftranscript|>...`). Empty on every
    /// other Whisper export.
    pub crisper_verbatim_prefix: Vec<i64>,
    /// CrisperWhisper 2.0 hotword-block markers `(<htx>, <ehtx>)`; hotword text between
    /// them replaces `<|startofprev|>` biasing on that model.
    pub crisper_hotword_markers: Option<(i64, i64)>,
    /// Every CrisperWhisper 2.0 prompt-control token id ([verbatim_N]/[intended_N] +
    /// <vtx>/<evtx>/<ctx>/<ectx>/<htx>/<ehtx>): skipped during text decode exactly like
    /// the `<|...|>` specials (they are prompt machinery, never transcript text). The
    /// verbatim EVENT tokens ([UM], [laughter], ...) are NOT here — they decode literally.
    crisper_marker_ids: std::collections::HashSet<i64>,
}

/// CrisperWhisper 2.0 prompt-marker token strings (mode tags + block markers).
const CRISPER_MODE_TAGS_VERBATIM: [&str; 5] = [
    "[verbatim_1]",
    "[verbatim_2]",
    "[verbatim_3]",
    "[verbatim_4]",
    "[verbatim_5]",
];
const CRISPER_MODE_TAGS_INTENDED: [&str; 5] = [
    "[intended_1]",
    "[intended_2]",
    "[intended_3]",
    "[intended_4]",
    "[intended_5]",
];
const CRISPER_BLOCK_MARKERS: [&str; 6] = ["<vtx>", "<evtx>", "<ctx>", "<ectx>", "<htx>", "<ehtx>"];

impl WhisperTokenizer {
    /// Load from the resolved file map. `vocab` is required; `added_tokens` is optional
    /// (some exports fold added tokens into `vocab.json`).
    pub fn load(vocab_path: &Path, added_tokens_path: Option<&Path>) -> SttResult<Self> {
        let raw = std::fs::read_to_string(vocab_path)
            .map_err(|e| SttError::Tokenizer(format!("read vocab.json: {e}")))?;
        let mut tokens: HashMap<String, i64> = serde_json::from_str(&raw)
            .map_err(|e| SttError::Tokenizer(format!("parse vocab.json: {e}")))?;
        if let Some(p) = added_tokens_path
            && let Ok(raw_add) = std::fs::read_to_string(p)
            && let Ok(added) = serde_json::from_str::<HashMap<String, i64>>(&raw_add)
        {
            tokens.extend(added);
        }
        Self::from_tokens(tokens)
    }

    /// Build from an in-memory token→id map (test / custom-model entrypoint).
    pub fn from_tokens(tokens: HashMap<String, i64>) -> SttResult<Self> {
        let mut vocab: HashMap<i64, String> = HashMap::with_capacity(tokens.len());
        for (tok, &id) in &tokens {
            vocab.insert(id, tok.clone());
        }
        let need = |name: &str| -> SttResult<i64> {
            tokens
                .get(name)
                .copied()
                .ok_or_else(|| SttError::Tokenizer(format!("missing special token {name}")))
        };
        let bos_token_id = need("<|startoftranscript|>")?;
        let eos_token_id = need("<|endoftext|>")?;
        let transcribe_token_id = need("<|transcribe|>")?;
        // Translate token exists on multilingual exports only; absent on `.en`.
        let translate_token_id = tokens
            .get("<|translate|>")
            .copied()
            .unwrap_or(transcribe_token_id);
        let notimestamps_token_id = need("<|notimestamps|>")?;
        let nospeech_token_id = tokens
            .get("<|nospeech|>")
            .or_else(|| tokens.get("<|nocaptions|>"))
            .copied();
        let timestamp_begin_id = tokens.get("<|0.00|>").copied();
        let is_multilingual = tokens.contains_key("<|fr|>");
        let startofprev_id = tokens.get("<|startofprev|>").copied();
        let (byte_decoder, byte_encoder) = build_byte_maps();

        // CrisperWhisper 2.0 detection: the verbatim prefix is usable only when ALL five
        // tags are present (a partial set would build a prompt the model never saw).
        let crisper_verbatim_prefix: Vec<i64> = {
            let ids: Vec<i64> = CRISPER_MODE_TAGS_VERBATIM
                .iter()
                .filter_map(|t| tokens.get(*t).copied())
                .collect();
            if ids.len() == CRISPER_MODE_TAGS_VERBATIM.len() {
                ids
            } else {
                Vec::new()
            }
        };
        let crisper_hotword_markers = match (tokens.get("<htx>"), tokens.get("<ehtx>")) {
            (Some(&s), Some(&e)) if !crisper_verbatim_prefix.is_empty() => Some((s, e)),
            _ => None,
        };
        let crisper_marker_ids: std::collections::HashSet<i64> = CRISPER_MODE_TAGS_VERBATIM
            .iter()
            .chain(CRISPER_MODE_TAGS_INTENDED.iter())
            .chain(CRISPER_BLOCK_MARKERS.iter())
            .filter_map(|t| tokens.get(*t).copied())
            .collect();

        Ok(Self {
            tokens,
            vocab,
            byte_decoder,
            byte_encoder,
            bos_token_id,
            eos_token_id,
            transcribe_token_id,
            translate_token_id,
            notimestamps_token_id,
            nospeech_token_id,
            startofprev_id,
            timestamp_begin_id,
            timestamp_step_s: 0.02,
            is_multilingual,
            crisper_verbatim_prefix,
            crisper_hotword_markers,
            crisper_marker_ids,
        })
    }

    /// Build the CrisperWhisper 2.0 hotword block `[<htx>, *encoded, <ehtx>]` (the model's
    /// trained vocabulary-biasing channel — used INSTEAD of `<|startofprev|>` there). Empty
    /// when the export has no hotword markers or the text encodes to nothing.
    pub fn crisper_hotword_block(&self, text: &str) -> Vec<i64> {
        let Some((start, end)) = self.crisper_hotword_markers else {
            return Vec::new();
        };
        let encoded = self.encode_prompt(text);
        if encoded.is_empty() {
            return Vec::new();
        }
        let mut block = Vec::with_capacity(encoded.len() + 2);
        block.push(start);
        block.extend(encoded);
        block.push(end);
        block
    }

    /// Encode free-form prompt text into Whisper token ids via a deliberately APPROXIMATE
    /// GPT-2 byte-level BPE: no `merges.txt` is read — instead greedy longest-prefix
    /// matching against the vocab (port of WinSTT `onnx_decoder_patches.encode_whisper_prompt`).
    ///
    /// This is sufficient because the initial prompt is a SOFT attention bias, not a hard
    /// label; common proper nouns / brand names exist as whole-word vocab entries, and any
    /// residual segmentation mismatch is a ~zero quality regression. Whisper prepends one
    /// space so the first piece carries the `Ġ` leading-space marker the BPE was trained on.
    ///
    /// A fully faithful encoder would apply the trained `merges.txt` rank order;
    /// greedy-longest-prefix is the WinSTT-shipped approximation and matches its behavior.
    pub fn encode_prompt(&self, text: &str) -> Vec<i64> {
        if text.trim().is_empty() {
            return Vec::new();
        }
        // Byte-encode " " + text via the GPT-2 byte→unicode forward map.
        let mut rendered = String::new();
        for &b in format!(" {text}").as_bytes() {
            rendered.push(self.byte_encoder[b as usize]);
        }
        let chars: Vec<char> = rendered.chars().collect();
        let n = chars.len();
        let mut out: Vec<i64> = Vec::new();
        let mut i = 0usize;
        while i < n {
            let upper = (i + 32).min(n); // bounded inner loop (pieces are rarely >8)
            let mut matched = false;
            let mut j = upper;
            while j > i {
                let piece: String = chars[i..j].iter().collect();
                if let Some(&tid) = self.tokens.get(&piece) {
                    out.push(tid);
                    i = j;
                    matched = true;
                    break;
                }
                j -= 1;
            }
            if !matched {
                // Single-byte fallback: every byte-unicode codepoint is also a vocab entry
                // in Whisper exports (the 256-byte alphabet). If even that misses, drop it.
                let single = chars[i].to_string();
                if let Some(&tid) = self.tokens.get(&single) {
                    out.push(tid);
                }
                i += 1;
            }
        }
        out
    }

    /// Build the `[<|startofprev|>, *encoded]` prefix for initial-prompt biasing, ready to
    /// prepend to the standard prompt array. Empty when `<|startofprev|>` is absent (`.en`)
    /// or the encoded text is empty (port of `whisper_initial_prompt_tokens`).
    pub fn initial_prompt_prefix(&self, text: &str) -> Vec<i64> {
        let Some(sop) = self.startofprev_id else {
            return Vec::new();
        };
        let encoded = self.encode_prompt(text);
        if encoded.is_empty() {
            return Vec::new();
        }
        let mut prefix = Vec::with_capacity(encoded.len() + 1);
        prefix.push(sop);
        prefix.extend(encoded);
        prefix
    }

    /// Look up `<|{lang}|>` (e.g. `<|en|>`, `<|ru|>`). None on `.en` exports / unknown.
    pub fn language_token(&self, lang: &str) -> Option<i64> {
        self.tokens.get(&format!("<|{lang}|>")).copied()
    }

    /// True if `id` is a special `<|...|>` marker token OR a CrisperWhisper 2.0 prompt
    /// marker (both skipped in text decode).
    pub fn is_special(&self, id: i64) -> bool {
        self.crisper_marker_ids.contains(&id)
            || self.vocab.get(&id).is_some_and(|t| t.starts_with("<|"))
    }

    /// Decode token ids → text, skipping `<|...|>` markers and stripping ONE leading
    /// space. Port of `_base.py::_decode_text`. Uses `vocab.get` (sparse-tolerant).
    pub fn decode_text(&self, ids: &[i64]) -> String {
        let s = self.collect_byte_chars(ids);
        let mut out = self.bytes_from_chars(&s);
        // `.removeprefix(" ")` — strip exactly one leading ASCII space.
        if out.starts_with(' ') {
            out.remove(0);
        }
        out
    }

    /// Decode but PRESERVE the leading space — required for word-boundary splitting in
    /// the word-timestamp aligner (`_decode_text_preserve_leading_space`).
    pub fn decode_text_preserve_leading_space(&self, ids: &[i64]) -> String {
        let s = self.collect_byte_chars(ids);
        self.bytes_from_chars(&s)
    }

    /// Concatenate the byte-unicode strings of every non-special, present token id.
    /// CrisperWhisper 2.0 prompt markers ([verbatim_N], <htx>, ...) are skipped like the
    /// `<|...|>` specials; its verbatim EVENT tokens ([UM], [laughter], ...) pass through
    /// and decode to their literal bracketed text — that IS the verbatim transcript format.
    fn collect_byte_chars(&self, ids: &[i64]) -> String {
        let mut s = String::new();
        for &id in ids {
            if self.crisper_marker_ids.contains(&id) {
                continue;
            }
            if let Some(tok) = self.vocab.get(&id)
                && !tok.starts_with("<|")
            {
                s.push_str(tok);
            }
            // Missing id (incomplete vocab) → silently skipped (no crash).
        }
        s
    }

    /// Map each byte-unicode char back to a raw byte and UTF-8 decode (lossy).
    fn bytes_from_chars(&self, s: &str) -> String {
        let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
        for c in s.chars() {
            if let Some(&b) = self.byte_decoder.get(&c) {
                bytes.push(b);
            }
            // A char not in the byte map is dropped (matches Python KeyError-free path
            // after the vocab.get guard — only valid byte-unicode chars reach here).
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Parse the Whisper timestamp-token stream into `(start_s, end_s, text)` segments.
    /// Port of `_base.py::_extract_segments`. Returns empty when the export has no
    /// timestamp tokens (`timestamp_begin_id` is None) — i.e. `<|notimestamps|>` mode.
    pub fn extract_segments(&self, tokens: &[i64]) -> Vec<(f32, f32, String)> {
        let Some(begin_id) = self.timestamp_begin_id else {
            return Vec::new();
        };
        let step = self.timestamp_step_s;
        let mut segments = Vec::new();
        let mut i = 0usize;
        while i < tokens.len() {
            let tok = tokens[i];
            // CrisperWhisper 2.0 prompt markers sit ABOVE the timestamp range
            // (51880+ > <|0.00|>=50364) — without this guard the mode tags in the
            // prompt would parse as ~30 s phantom timestamps.
            if tok < begin_id || self.crisper_marker_ids.contains(&tok) {
                i += 1;
                continue;
            }
            let start = (tok - begin_id) as f32 * step;
            let mut j = i + 1;
            while j < tokens.len() && tokens[j] < begin_id {
                if tokens[j] == self.eos_token_id {
                    break;
                }
                j += 1;
            }
            if j >= tokens.len() || tokens[j] < begin_id {
                break;
            }
            let end = (tokens[j] - begin_id) as f32 * step;
            let text = self.decode_text(&tokens[i + 1..j]);
            if !text.is_empty() {
                segments.push((start, end, text.trim().to_string()));
            }
            i = j + 1;
        }
        segments
    }

    /// Largest id in the vocab + 1 (used to look up the alignment-heads table by size).
    pub fn vocab_size(&self) -> i64 {
        self.tokens.values().copied().max().map_or(0, |m| m + 1)
    }
}

/// Build BOTH the GPT-2 byte maps from `transformers...gpt2.bytes_to_unicode` (the same
/// function onnx-asr copies in `_base.py`):
///   * `byte_decoder`: byte-unicode char → original byte (for decode).
///   * `byte_encoder`: original byte (0..256) → byte-unicode char (for prompt encode).
fn build_byte_maps() -> (HashMap<char, u8>, [char; 256]) {
    // bs: the bytes that map to themselves (printable ASCII + Latin-1 ranges).
    let mut bs: Vec<u32> = Vec::new();
    bs.extend(b'!' as u32..=b'~' as u32);
    bs.extend(0xA1u32..=0xACu32); // ¡..¬
    bs.extend(0xAEu32..=0xFFu32); // ®..ÿ
    let mut cs: Vec<u32> = bs.clone();
    let mut n = 0u32;
    for b in 0..256u32 {
        if !bs.contains(&b) {
            bs.push(b);
            cs.push(256 + n);
            n += 1;
        }
    }
    let mut byte_decoder = HashMap::with_capacity(256);
    let mut byte_encoder = ['\0'; 256];
    for (byte_val, code) in bs.iter().zip(cs.iter()) {
        if let Some(ch) = char::from_u32(*code) {
            byte_decoder.insert(ch, *byte_val as u8);
            byte_encoder[*byte_val as usize] = ch;
        }
    }
    (byte_decoder, byte_encoder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_vocab() -> HashMap<String, i64> {
        // A minimal Whisper-like special-token table + a couple byte tokens.
        // 'Ġ' (U+0120) is the GPT-2 byte-unicode char for a space (byte 0x20).
        let mut m = HashMap::new();
        m.insert("<|startoftranscript|>".into(), 50258);
        m.insert("<|endoftext|>".into(), 50257);
        m.insert("<|transcribe|>".into(), 50359);
        m.insert("<|translate|>".into(), 50358);
        m.insert("<|notimestamps|>".into(), 50363);
        m.insert("<|nospeech|>".into(), 50362);
        m.insert("<|en|>".into(), 50259);
        m.insert("<|fr|>".into(), 50265);
        m.insert("<|0.00|>".into(), 50364);
        m.insert("<|0.02|>".into(), 50365);
        // "Ġhi" = space + h + i (byte tokens). 'h','i' map to themselves.
        m.insert("Ġhi".into(), 100);
        m.insert("there".into(), 101);
        m
    }

    #[test]
    fn special_tokens_resolved_and_multilingual() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        assert_eq!(tk.bos_token_id, 50258);
        assert_eq!(tk.eos_token_id, 50257);
        assert_eq!(tk.transcribe_token_id, 50359);
        assert_eq!(tk.translate_token_id, 50358);
        assert_eq!(tk.nospeech_token_id, Some(50362));
        assert!(tk.is_multilingual); // <|fr|> present
        assert_eq!(tk.language_token("en"), Some(50259));
        assert_eq!(tk.timestamp_begin_id, Some(50364));
    }

    #[test]
    fn decode_skips_specials_and_strips_leading_space() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        // [sot, en, transcribe, notimestamps, "Ġhi", "there", eot]:
        // specials are dropped → " hi" + "there" = " hithere" → strip leading space.
        let ids = [50258, 50259, 50359, 50363, 100, 101, 50257];
        assert_eq!(tk.decode_text(&ids), "hithere");
    }

    #[test]
    fn decode_strips_exactly_one_leading_space() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        // "Ġhi" alone decodes to " hi" then strips the leading space → "hi".
        assert_eq!(tk.decode_text(&[100]), "hi");
        // Preserve variant keeps it.
        assert_eq!(tk.decode_text_preserve_leading_space(&[100]), " hi");
    }

    #[test]
    fn missing_id_is_skipped_not_panicked() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        // id 99999 absent from vocab → dropped, "there" still decodes.
        assert_eq!(tk.decode_text(&[99999, 101]), "there");
    }

    #[test]
    fn en_only_vocab_not_multilingual() {
        let mut m = tiny_vocab();
        m.remove("<|fr|>");
        let tk = WhisperTokenizer::from_tokens(m).unwrap();
        assert!(!tk.is_multilingual);
        assert_eq!(tk.language_token("fr"), None);
    }

    #[test]
    fn extract_segments_pairs_timestamps() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        // <|0.00|> "Ġhi" <|0.02|> → one segment [0.0, 0.04) "hi".
        let ids = [50364i64, 100, 50365];
        let segs = tk.extract_segments(&ids);
        assert_eq!(segs.len(), 1);
        assert!((segs[0].0 - 0.0).abs() < 1e-6);
        assert!((segs[0].1 - 0.02).abs() < 1e-6);
        assert_eq!(segs[0].2, "hi");
    }

    #[test]
    fn byte_maps_cover_all_256_bytes() {
        let (bd, be) = build_byte_maps();
        // Inverse map reproduces every byte 0..=255.
        let recovered: std::collections::HashSet<u8> = bd.values().copied().collect();
        assert_eq!(recovered.len(), 256);
        // Forward map is a full round-trip: byte → char → byte.
        for b in 0u8..=255 {
            let ch = be[b as usize];
            assert_eq!(bd.get(&ch).copied(), Some(b), "roundtrip byte {b}");
        }
    }

    #[test]
    fn encode_prompt_greedy_matches_whole_words() {
        let mut m = tiny_vocab();
        m.insert("<|startofprev|>".into(), 50361);
        // "Ġthere" whole-word entry so " there" encodes to one token.
        m.insert("Ġthere".into(), 200);
        let tk = WhisperTokenizer::from_tokens(m).unwrap();
        let ids = tk.encode_prompt("there");
        // " there" → "Ġthere" → single token 200.
        assert_eq!(ids, vec![200]);
        // Prefix includes <|startofprev|>.
        let prefix = tk.initial_prompt_prefix("there");
        assert_eq!(prefix, vec![50361, 200]);
    }

    #[test]
    fn initial_prompt_empty_without_startofprev() {
        let tk = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        // tiny_vocab has no <|startofprev|> → no prefix even with text.
        assert!(tk.initial_prompt_prefix("hello").is_empty());
    }

    /// tiny_vocab + the CrisperWhisper 2.0 marker/event token set (real ids).
    fn crisper_vocab() -> HashMap<String, i64> {
        let mut m = tiny_vocab();
        for (i, t) in [
            "[verbatim_1]",
            "[verbatim_2]",
            "[verbatim_3]",
            "[verbatim_4]",
            "[verbatim_5]",
            "[intended_1]",
            "[intended_2]",
            "[intended_3]",
            "[intended_4]",
            "[intended_5]",
        ]
        .iter()
        .enumerate()
        {
            m.insert((*t).into(), 51880 + i as i64);
        }
        m.insert("<vtx>".into(), 51890);
        m.insert("<evtx>".into(), 51891);
        m.insert("<ctx>".into(), 51892);
        m.insert("<ectx>".into(), 51893);
        m.insert("<htx>".into(), 51894);
        m.insert("<ehtx>".into(), 51895);
        m.insert("[UM]".into(), 51865);
        m.insert("[laughter]".into(), 51867);
        m
    }

    #[test]
    fn crisper_markers_detected_and_ordered() {
        let tk = WhisperTokenizer::from_tokens(crisper_vocab()).unwrap();
        assert_eq!(
            tk.crisper_verbatim_prefix,
            vec![51880, 51881, 51882, 51883, 51884]
        );
        assert_eq!(tk.crisper_hotword_markers, Some((51894, 51895)));
        // Plain exports never grow a prefix.
        let plain = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        assert!(plain.crisper_verbatim_prefix.is_empty());
        assert!(plain.crisper_hotword_markers.is_none());
    }

    #[test]
    fn crisper_partial_tag_set_is_not_a_prefix() {
        let mut m = tiny_vocab();
        m.insert("[verbatim_1]".into(), 51880); // 2..5 missing
        let tk = WhisperTokenizer::from_tokens(m).unwrap();
        assert!(tk.crisper_verbatim_prefix.is_empty());
    }

    #[test]
    fn crisper_decode_skips_markers_but_keeps_event_tokens() {
        let tk = WhisperTokenizer::from_tokens(crisper_vocab()).unwrap();
        // [verbatim_1] sot "Ġhi" [UM] [laughter] <htx> eot
        let ids = [51880, 50258, 100, 51865, 51867, 51894, 50257];
        assert_eq!(tk.decode_text(&ids), "hi[UM][laughter]");
        assert!(tk.is_special(51880));
        assert!(tk.is_special(51894));
        assert!(!tk.is_special(51865)); // [UM] is transcript text, not prompt machinery
    }

    #[test]
    fn crisper_hotword_block_wraps_encoded_text() {
        let mut m = crisper_vocab();
        m.insert("Ġthere".into(), 200);
        let tk = WhisperTokenizer::from_tokens(m).unwrap();
        assert_eq!(tk.crisper_hotword_block("there"), vec![51894, 200, 51895]);
        assert!(tk.crisper_hotword_block("").is_empty());
        // Non-crisper exports have no hotword channel.
        let plain = WhisperTokenizer::from_tokens(tiny_vocab()).unwrap();
        assert!(plain.crisper_hotword_block("there").is_empty());
    }
}
