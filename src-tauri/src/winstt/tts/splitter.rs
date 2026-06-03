// --- Sentence splitter (verbatim port of tts-reader.ts splitSentences) ------

/// Cap an over-long sentence so one giant clause can't block the whole read.
pub const DEFAULT_MAX_SENTENCE_LEN: usize = 240;

/// Split `text` into sentence-sized chunks for sequential synthesis. Splits
/// after sentence-ending punctuation (`. ! ?`, optionally a closing quote /
/// bracket) and hard-caps over-long sentences at `max_len`. Blank input → `[]`.
/// Verbatim behavioral port of `splitSentences` in tts-reader.ts.
pub fn split_sentences(text: &str, max_len: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let rough = rough_split(trimmed);
    let pieces = if rough.is_empty() {
        vec![trimmed.to_string()]
    } else {
        rough
    };
    let mut out: Vec<String> = Vec::new();
    for piece in pieces {
        let sentence = piece.trim();
        if sentence.is_empty() {
            continue;
        }
        if sentence.chars().count() <= max_len {
            out.push(sentence.to_string());
        } else {
            out.extend(chunk_long_sentence(sentence, max_len));
        }
    }
    out
}

/// Equivalent of the JS regex `/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g`.
fn rough_split(s: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_terminator(c) {
            while i < chars.len() && is_terminator(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            while i < chars.len() && is_closer(chars[i]) {
                current.push(chars[i]);
                i += 1;
            }
            while i < chars.len() && chars[i].is_whitespace() {
                current.push(chars[i]);
                i += 1;
            }
            pieces.push(std::mem::take(&mut current));
        } else {
            current.push(c);
            i += 1;
        }
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

fn is_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?')
}

fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | ')' | ']')
}

/// Break `long` into ≤`max_len` pieces on whitespace boundaries. Verbatim port
/// of `chunkLongSentence`.
fn chunk_long_sentence(long: &str, max_len: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in long.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{current} {word}")
        };
        if candidate.chars().count() <= max_len {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        if word.chars().count() > max_len {
            let wchars: Vec<char> = word.chars().collect();
            let mut i = 0;
            while i < wchars.len() {
                let end = (i + max_len).min(wchars.len());
                out.push(wchars[i..end].iter().collect());
                i = end;
            }
            current.clear();
        } else {
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}
