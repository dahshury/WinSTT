// ═════════════════════════════════════════════════════════════════════════════
// 3. Median filter — reflect-pad sliding window, odd width. Last-axis only.
//    Verbatim port of median_filter_1d.
// ═════════════════════════════════════════════════════════════════════════════

use ndarray::Array2;

use super::WordTsError;

/// Median filter a 1-D slice along its length with reflect padding. `width` must
/// be odd. Width ≤ 1 (or signal shorter than the half-window) is identity.
pub fn median_filter_1d(x: &[f32], width: usize) -> Result<Vec<f32>, WordTsError> {
    if width <= 1 {
        return Ok(x.to_vec());
    }
    if width.is_multiple_of(2) {
        return Err(WordTsError::EvenFilterWidth(width));
    }
    let pad = width / 2;
    if x.len() <= pad {
        return Ok(x.to_vec());
    }
    let padded = reflect_pad(x, pad);
    let mut out = Vec::with_capacity(x.len());
    for i in 0..x.len() {
        let mut window: Vec<f32> = padded[i..i + width].to_vec();
        window.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        out.push(window[width / 2]);
    }
    Ok(out)
}

/// numpy `mode="reflect"` padding: reflect WITHOUT repeating the edge element.
/// `[a,b,c]` pad 2 → `[c,b,a,b,c,b,a]`.
pub(super) fn reflect_pad(x: &[f32], pad: usize) -> Vec<f32> {
    let n = x.len();
    debug_assert!(n > pad, "reflect pad requires len > pad");
    let mut out = Vec::with_capacity(n + 2 * pad);
    // Leading reflect: indices pad, pad-1, ..., 1.
    for k in (1..=pad).rev() {
        out.push(x[k]);
    }
    out.extend_from_slice(x);
    // Trailing reflect: indices n-2, n-3, ..., n-1-pad.
    for k in 1..=pad {
        out.push(x[n - 1 - k]);
    }
    out
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. DTW — (N+1, M+1) cost lattice, diag/down/right, backtrace.
//    Verbatim port of dtw / openai-whisper dtw_cpu.
// ═════════════════════════════════════════════════════════════════════════════

/// Dynamic-time-warp a `(n_text, n_time)` cost matrix; return monotonic
/// `(text_indices, time_indices)` index pairs from `(0,0)` to `(N-1,M-1)`.
pub fn dtw(cost_input: &Array2<f64>) -> (Vec<i64>, Vec<i64>) {
    let (n_text, n_time) = cost_input.dim();
    if n_text == 0 || n_time == 0 {
        return (Vec::new(), Vec::new());
    }
    // cost[(N+1)x(M+1)] inf, cost[0,0]=0; trace -1.
    let mut cost = Array2::<f64>::from_elem((n_text + 1, n_time + 1), f64::INFINITY);
    let mut trace = Array2::<i8>::from_elem((n_text + 1, n_time + 1), -1);
    cost[[0, 0]] = 0.0;

    for j in 1..=n_time {
        for i in 1..=n_text {
            let c0 = cost[[i - 1, j - 1]]; // diag (match)
            let c1 = cost[[i - 1, j]]; // down (text advances)
            let c2 = cost[[i, j - 1]]; // right (time advances)
            let (c, t) = if c0 < c1 && c0 < c2 {
                (c0, 0i8)
            } else if c1 < c0 && c1 < c2 {
                (c1, 1i8)
            } else {
                (c2, 2i8)
            };
            cost[[i, j]] = cost_input[[i - 1, j - 1]] + c;
            trace[[i, j]] = t;
        }
    }

    // Boundary conventions for the backtrace (match openai-whisper).
    for j in 0..=n_time {
        trace[[0, j]] = 2;
    }
    for i in 0..=n_text {
        trace[[i, 0]] = 1;
    }

    let mut i = n_text;
    let mut j = n_time;
    let mut text_indices: Vec<i64> = Vec::new();
    let mut time_indices: Vec<i64> = Vec::new();
    while i > 0 || j > 0 {
        text_indices.push((i as i64) - 1);
        time_indices.push((j as i64) - 1);
        match trace[[i, j]] {
            0 => {
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            2 => j -= 1,
            _ => break,
        }
    }
    text_indices.reverse();
    time_indices.reverse();
    (text_indices, time_indices)
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Word grouping — GPT-2 byte-decoder boundaries + space/punct merge.
//    Verbatim port of split_tokens_into_words.
// ═════════════════════════════════════════════════════════════════════════════

const REPLACEMENT: char = '\u{FFFD}'; // '�'

/// Languages where spaces are not word delimiters → stop at unicode boundaries.
fn is_cjk_lang(language: Option<&str>) -> bool {
    matches!(language, Some("zh" | "ja" | "th" | "lo" | "my" | "yue"))
}

/// Group token IDs into words using the model's byte-decoder. `decode_one`
/// renders a list of token IDs into (possibly partial / replacement-char) text.
/// Returns `(words, word_token_groups)`.
pub fn split_tokens_into_words<F: Fn(&[i64]) -> String>(
    tokens: &[i64],
    decode_one: &F,
    eot_id: i64,
    language: Option<&str>,
) -> (Vec<String>, Vec<Vec<i64>>) {
    // Stage 1: split on unicode boundaries (handles multi-byte tokens that only
    // render to a valid char once combined).
    let decoded_full = decode_one(tokens);
    let decoded_full_chars: Vec<char> = decoded_full.chars().collect();

    let mut subwords: Vec<String> = Vec::new();
    let mut subword_tokens: Vec<Vec<i64>> = Vec::new();
    let mut current: Vec<i64> = Vec::new();
    let mut offset = 0usize; // in CHARS, mirroring Python str semantics

    for &tok in tokens {
        current.push(tok);
        let decoded = decode_one(&current);
        let decoded_chars: Vec<char> = decoded.chars().collect();
        let repl_pos = decoded_chars.iter().position(|&c| c == REPLACEMENT);

        let accept = match repl_pos {
            None => true,
            Some(idx) => {
                let abs = offset + idx;
                abs < decoded_full_chars.len() && decoded_full_chars[abs] == REPLACEMENT
            }
        };

        if accept {
            offset += decoded_chars.len();
            subwords.push(decoded);
            subword_tokens.push(std::mem::take(&mut current));
        }
    }

    if is_cjk_lang(language) {
        return (subwords, subword_tokens);
    }

    // Stage 2: collapse subwords into space-delimited words.
    let mut words: Vec<String> = Vec::new();
    let mut word_tokens: Vec<Vec<i64>> = Vec::new();
    for (subword, ids) in subwords.into_iter().zip(subword_tokens) {
        let is_special = ids.first().is_some_and(|&t| t >= eot_id);
        let is_space_prefixed = subword.starts_with(' ');
        let is_punct = is_ascii_punct(subword.trim());
        if is_special || is_space_prefixed || is_punct || words.is_empty() {
            words.push(subword);
            word_tokens.push(ids);
        } else if let (Some(last), Some(last_tokens)) = (words.last_mut(), word_tokens.last_mut()) {
            last.push_str(&subword);
            last_tokens.extend(ids);
        }
    }
    (words, word_tokens)
}

/// `s.strip() in string.punctuation` — non-empty and every char ASCII punct.
fn is_ascii_punct(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_punctuation())
}
