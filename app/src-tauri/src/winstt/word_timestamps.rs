// PORT IMPL — drafted against real APIs, pending compile.
// Source: E:/DL/Projects/onnx-asr/src/onnx_asr/word_timestamps.py
//         (itself a port of openai-whisper/whisper/timing.py, MIT)
//         app/PORT/05_wakeword_diarization_loopback_wordts.md §D
//         memory: project_word_highlight_playback
// External crates (declared in Cargo.toml, verified docs.rs 2026-05):
//   ndarray 0.17.2  — Array2/Array3/ArrayView for the alignment matrix math
//   base85  2.0.0   — RFC1924 == Python base64.b85decode alphabet
//                     base85::decode(instr: &str) -> Result<Vec<u8>>
//   flate2  1.0     — gzip inflate of the alignment-heads blobs (GzDecoder)
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE
// ─────────────────────────────────────────────────────────────────────────────
// Per-word timestamps via Whisper cross-attention DTW (torch-free). Two halves:
//
//   Half 1 (HEAVY, `// SPIKE:`) — collect per-step cross-attention from the
//   `onnx-community/whisper-*_timestamped` decoder export via ort IoBinding while
//   the autoregressive loop runs. The exact ORT output names/shapes for
//   `cross_attentions.*` and the IoBinding device-buffer copy-out can only be
//   confirmed against a live session, so the COLLECTION is left a trait + stub.
//
//   Half 2 (PURE NUMPY → Rust, implemented + tested) — the DTW alignment pipeline:
//   alignment-heads decode (base85+gzip), median filter, softmax/normalize, DTW
//   backtrace, GPT-2 byte-decoder word grouping, and the jump-time word boundaries.
//   This is `word_timestamps.py` verbatim, entirely arithmetic.

#![allow(dead_code)] // DRAFT: surface defined ahead of the WordAligner call sites.

use ndarray::{Array2, Array3};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Constants — copied VERBATIM from word_timestamps.py / openai-whisper.
// ═════════════════════════════════════════════════════════════════════════════

/// Whisper audio frontend: 50 audio frames per second post-encoder downsample.
pub const TOKENS_PER_SECOND: f64 = 50.0;

/// Alignment-heads tables copied VERBATIM from openai-whisper. Each entry is a
/// base85-encoded gzip of a flat bool array over `(num_decoder_layers,
/// num_decoder_attention_heads)`. The heads marked `True` correlate most strongly
/// with word-level alignment. DO NOT regenerate — these are load-bearing magic
/// constants; a wrong base85 variant silently yields garbage timings.
pub const ALIGNMENT_HEADS: &[(&str, &str)] = &[
    ("tiny.en", "ABzY8J1N>@0{>%R00Bk>$p{7v037`oCl~+#00"),
    ("tiny", "ABzY8bu8Lr0{>%RKn9Fp%m@SkK7Kt=7ytkO"),
    ("base.en", "ABzY8;40c<0{>%RzzG;p*o+Vo09|#PsxSZm00"),
    ("base", "ABzY8KQ!870{>%RzyTQH3`Q^yNP!>##QT-<FaQ7m"),
    ("small.en", "ABzY8>?_)10{>%RpeA61k&I|OI3I$65C{;;pbCHh0B{qLQ;+}v00"),
    ("small", "ABzY8DmU6=0{>%Rpa?J`kvJ6qF(V^F86#Xh7JUGMK}P<N0000"),
    (
        "medium.en",
        "ABzY8usPae0{>%R7<zz_OvQ{)4kMa0BMw6u5rT}kRKX;$NfYBv00*Hl@qhsU00",
    ),
    ("medium", "ABzY8B0Jh+0{>%R7}kK1fFL7w6%<-Pf*t^=N)Qr&0RR9"),
    ("large-v1", "ABzY8r9j$a0{>%R7#4sLmoOs{s)o3~84-RPdcFk!JR<kSfC2yj"),
    (
        "large-v2",
        "ABzY8zd+h!0{>%R7=D0pU<_bnWW*tkYAhobTNnu$jnkEkXqp)j;w1Tzk)UH3X%SZd&fFZ2fC2yj",
    ),
    (
        "large-v3",
        "ABzY8gWO1E0{>%R7(9S+Kn!D~%ngiGaR?*L!iJG9p-nab0JQ=-{D1-g00",
    ),
    ("large-v3-turbo", "ABzY8j^C+e0{>%RARaKHP%t(lGR*)0g!tONPyhe`"),
    ("turbo", "ABzY8j^C+e0{>%RARaKHP%t(lGR*)0g!tONPyhe`"),
];

/// `(num_decoder_layers, num_decoder_attention_heads)` → model size key.
pub const MODEL_SIZE_BY_DIMS: &[((usize, usize), &str)] = &[
    ((4, 6), "tiny"),
    ((6, 8), "base"),
    ((12, 12), "small"),
    ((24, 16), "medium"),
    ((32, 20), "large-v3"),
    ((4, 20), "large-v3-turbo"),
];

/// Vocab size of the English-only Whisper variants (`*.en`).
pub const EN_VOCAB_SIZE: usize = 51_864;

// ═════════════════════════════════════════════════════════════════════════════
// 2. Alignment-heads decode — base85 (RFC1924 == Python b85decode) + gzip.
// ═════════════════════════════════════════════════════════════════════════════

/// Errors from the word-timestamp pipeline.
#[derive(Debug, thiserror::Error)]
pub enum WordTsError {
    #[error("base85 decode failed: {0}")]
    Base85(String),
    #[error("gzip inflate failed: {0}")]
    Gzip(String),
    #[error("alignment-heads blob reshapes to {got} bools, expected {expected} ({layers}x{heads})")]
    Shape {
        got: usize,
        expected: usize,
        layers: usize,
        heads: usize,
    },
    #[error("median filter width must be odd, got {0}")]
    EvenFilterWidth(usize),
}

/// Decode a base85-gzipped flat bool array into a `(num_layers, num_heads)` mask.
/// Mirrors `decode_alignment_heads` / `Whisper.set_alignment_heads`.
///
/// The blob is ASCII (RFC1924 base85), then gzip; the inflated bytes are a flat
/// bool array (1 byte per bool, NumPy `dtype=bool`) reshaped row-major.
pub fn decode_alignment_heads(
    dump: &str,
    num_layers: usize,
    num_heads: usize,
) -> Result<Array2<bool>, WordTsError> {
    let compressed = base85::decode(dump).map_err(|e| WordTsError::Base85(format!("{e:?}")))?;
    let raw = gzip_inflate(&compressed).map_err(|e| WordTsError::Gzip(e.to_string()))?;
    let expected = num_layers * num_heads;
    if raw.len() != expected {
        return Err(WordTsError::Shape {
            got: raw.len(),
            expected,
            layers: num_layers,
            heads: num_heads,
        });
    }
    // NumPy bool: any nonzero byte is True.
    let flags: Vec<bool> = raw.iter().map(|&b| b != 0).collect();
    Array2::from_shape_vec((num_layers, num_heads), flags)
        .map_err(|_| WordTsError::Shape { got: raw.len(), expected, layers: num_layers, heads: num_heads })
}

/// gzip-inflate a buffer (flate2 GzDecoder). Separated so tests can hit it.
fn gzip_inflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut decoder = GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

/// Pick an alignment-heads mask by Whisper model size. Falls back to "all heads
/// in the upper half of layers" when dims don't match a known model. Mirrors
/// `lookup_alignment_heads`. `.en` is chosen when `vocab_size == 51864` and a
/// `<size>.en` entry exists.
pub fn lookup_alignment_heads(
    num_layers: usize,
    num_heads: usize,
    vocab_size: usize,
) -> Array2<bool> {
    if let Some(size) = MODEL_SIZE_BY_DIMS
        .iter()
        .find(|((l, h), _)| *l == num_layers && *h == num_heads)
        .map(|(_, s)| *s)
    {
        let english_only = vocab_size == EN_VOCAB_SIZE;
        let en_key = format!("{size}.en");
        if english_only && blob_for(&en_key).is_some() {
            return decode_or_fallback(&en_key, num_layers, num_heads);
        }
        return decode_or_fallback(size, num_layers, num_heads);
    }
    fallback_mask(num_layers, num_heads)
}

fn decode_or_fallback(key: &str, num_layers: usize, num_heads: usize) -> Array2<bool> {
    match blob_for(key) {
        Some(blob) => decode_alignment_heads(blob, num_layers, num_heads)
            .unwrap_or_else(|_| fallback_mask(num_layers, num_heads)),
        None => fallback_mask(num_layers, num_heads),
    }
}

fn blob_for(key: &str) -> Option<&'static str> {
    ALIGNMENT_HEADS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// Default mask: every head in the upper half of layers (Whisper's default when
/// no override was set). `mask[num_layers/2 ..] = true`.
fn fallback_mask(num_layers: usize, num_heads: usize) -> Array2<bool> {
    let mut mask = Array2::from_elem((num_layers, num_heads), false);
    for l in (num_layers / 2)..num_layers {
        for h in 0..num_heads {
            mask[[l, h]] = true;
        }
    }
    mask
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Median filter — reflect-pad sliding window, odd width. Last-axis only.
//    Verbatim port of median_filter_1d.
// ═════════════════════════════════════════════════════════════════════════════

/// Median filter a 1-D slice along its length with reflect padding. `width` must
/// be odd. Width ≤ 1 (or signal shorter than the half-window) is identity.
pub fn median_filter_1d(x: &[f32], width: usize) -> Result<Vec<f32>, WordTsError> {
    if width <= 1 {
        return Ok(x.to_vec());
    }
    if width % 2 == 0 {
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
fn reflect_pad(x: &[f32], pad: usize) -> Vec<f32> {
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
    for (subword, ids) in subwords.into_iter().zip(subword_tokens.into_iter()) {
        let is_special = ids.first().map(|&t| t >= eot_id).unwrap_or(false);
        let is_space_prefixed = subword.starts_with(' ');
        let is_punct = is_ascii_punct(subword.trim());
        if is_special || is_space_prefixed || is_punct || words.is_empty() {
            words.push(subword);
            word_tokens.push(ids);
        } else {
            let last = words.last_mut().expect("non-empty");
            last.push_str(&subword);
            word_tokens.last_mut().expect("non-empty").extend(ids);
        }
    }
    (words, word_tokens)
}

/// `s.strip() in string.punctuation` — non-empty and every char ASCII punct.
fn is_ascii_punct(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_punctuation())
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. align_words — the full pipeline.  Verbatim port of align_words.
// ═════════════════════════════════════════════════════════════════════════════

/// Per-word alignment result: rendered text + start/end seconds + token IDs.
#[derive(Debug, Clone, PartialEq)]
pub struct WordTiming {
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub tokens: Vec<i64>,
}

/// Inputs to [`align_words`] beyond the cross-attention tensor.
pub struct AlignArgs<'a, F: Fn(&[i64]) -> String> {
    /// Generated text token IDs (excluding the prompt prefix, INCLUDING trailing EOT).
    pub text_tokens: &'a [i64],
    pub decode_one: &'a F,
    pub eot_id: i64,
    /// Number of prompt tokens at the decoder input start (e.g.
    /// `[SOT, lang, transcribe, notimestamps]` → 4).
    pub prompt_length: usize,
    /// `num_samples // HOP_LENGTH` (before the encoder's 2× downsample).
    pub num_audio_frames: usize,
    pub language: Option<&'a str>,
    pub medfilt_width: usize,
    pub qk_scale: f32,
}

/// Run the full word-alignment pipeline on collected cross-attentions.
///
/// `cross_attentions` shape: `(num_layers, num_heads, num_decoder_tokens,
/// num_encoder_frames)` — element `[l,h,i,j]` is layer `l`, head `h`'s attention
/// from decoder token `i` to encoder frame `j`. `alignment_heads` is the
/// `(num_layers, num_heads)` bool mask from [`lookup_alignment_heads`].
pub fn align_words<F: Fn(&[i64]) -> String>(
    cross_attentions: &CrossAttentions,
    alignment_heads: &Array2<bool>,
    args: AlignArgs<'_, F>,
) -> Result<Vec<WordTiming>, WordTsError> {
    if args.text_tokens.is_empty() {
        return Ok(Vec::new());
    }

    // Select heads → (num_selected_heads, num_tokens, num_frames).
    let (n_layers, n_heads) = alignment_heads.dim();
    let mut selected: Vec<(usize, usize)> = Vec::new();
    for l in 0..n_layers {
        for h in 0..n_heads {
            if alignment_heads[[l, h]] {
                selected.push((l, h));
            }
        }
    }
    if selected.is_empty() {
        return Ok(Vec::new());
    }

    let n_tokens = cross_attentions.num_tokens;
    let full_frames = cross_attentions.num_frames;
    // Crop to half the audio frame count (encoder downsamples by 2).
    let n_frames = (args.num_audio_frames / 2).min(full_frames);
    if n_tokens == 0 || n_frames == 0 {
        return Ok(Vec::new());
    }

    // weights[head, token, frame] for the selected heads, cropped in frames.
    let mut weights = Array3::<f32>::zeros((selected.len(), n_tokens, n_frames));
    for (out_h, &(l, h)) in selected.iter().enumerate() {
        for t in 0..n_tokens {
            for f in 0..n_frames {
                weights[[out_h, t, f]] = cross_attentions.get(l, h, t, f) * args.qk_scale;
            }
        }
    }

    let (h_n, t_n, f_n) = weights.dim();

    // Softmax across the time (frame) axis (subtract max for stability), per
    // (head, token). Explicit indexing avoids nested-iterator API ambiguity.
    for hh in 0..h_n {
        for tt in 0..t_n {
            let mut max = f32::NEG_INFINITY;
            for ff in 0..f_n {
                max = max.max(weights[[hh, tt, ff]]);
            }
            let mut sum = 0.0f32;
            for ff in 0..f_n {
                let e = (weights[[hh, tt, ff]] - max).exp();
                weights[[hh, tt, ff]] = e;
                sum += e;
            }
            let denom = sum.max(1e-12);
            for ff in 0..f_n {
                weights[[hh, tt, ff]] /= denom;
            }
        }
    }

    // Normalize across the token axis: (w - mean) / max(std, 1e-9), per (head, frame).
    for hh in 0..h_n {
        for ff in 0..f_n {
            let mut mean = 0.0f32;
            for tt in 0..t_n {
                mean += weights[[hh, tt, ff]];
            }
            mean /= t_n.max(1) as f32;
            let mut var = 0.0f32;
            for tt in 0..t_n {
                let d = weights[[hh, tt, ff]] - mean;
                var += d * d;
            }
            // numpy std = population std (ddof=0).
            let std = (var / t_n.max(1) as f32).sqrt().max(1e-9);
            for tt in 0..t_n {
                weights[[hh, tt, ff]] = (weights[[hh, tt, ff]] - mean) / std;
            }
        }
    }

    // Median filter along the time axis (per head, per token row).
    for hh in 0..h_n {
        for tt in 0..t_n {
            let row: Vec<f32> = (0..f_n).map(|ff| weights[[hh, tt, ff]]).collect();
            let filtered = median_filter_1d(&row, args.medfilt_width)?;
            for (ff, v) in filtered.into_iter().enumerate() {
                weights[[hh, tt, ff]] = v;
            }
        }
    }

    // Mean across heads → 2-D (num_tokens, num_frames).
    let mut matrix = Array2::<f32>::zeros((t_n, f_n));
    for tt in 0..t_n {
        for ff in 0..f_n {
            let mut acc = 0.0f32;
            for hh in 0..h_n {
                acc += weights[[hh, tt, ff]];
            }
            matrix[[tt, ff]] = acc / h_n.max(1) as f32;
        }
    }

    // Strip rows before `prompt_length - 1` and the trailing EOT row.
    let anchor = args.prompt_length.saturating_sub(1);
    let upper = (args.prompt_length + args.text_tokens.len()).saturating_sub(1);
    if anchor >= upper || anchor >= t_n {
        return Ok(Vec::new());
    }
    let upper = upper.min(t_n);
    let sliced_rows = upper - anchor;

    // Negate for DTW (we want the MAX-attention path = MIN cost).
    let mut cost = Array2::<f64>::zeros((sliced_rows, f_n));
    for r in 0..sliced_rows {
        for ff in 0..f_n {
            cost[[r, ff]] = -(matrix[[anchor + r, ff]] as f64);
        }
    }

    let (text_indices, time_indices) = dtw(&cost);
    if text_indices.is_empty() {
        return Ok(Vec::new());
    }

    // Group tokens into words.
    let (words, word_tokens) =
        split_tokens_into_words(args.text_tokens, args.decode_one, args.eot_id, args.language);
    if word_tokens.len() <= 1 {
        return Ok(Vec::new());
    }

    // word_boundaries[k] = cumulative token count up to start of word k (excl last).
    let mut word_boundaries: Vec<usize> = Vec::with_capacity(word_tokens.len());
    word_boundaries.push(0);
    let mut acc = 0usize;
    for wt in &word_tokens[..word_tokens.len() - 1] {
        acc += wt.len();
        word_boundaries.push(acc);
    }

    // jumps = positions where the text index transitions (diff != 0), with a
    // leading `1` (np.pad(diff, (1,0), constant_values=1)).
    let mut jump_times_s: Vec<f64> = Vec::new();
    for (k, &ti) in text_indices.iter().enumerate() {
        let is_jump = if k == 0 {
            true
        } else {
            text_indices[k] != text_indices[k - 1]
        };
        let _ = ti;
        if is_jump {
            jump_times_s.push(time_indices[k] as f64 / TOKENS_PER_SECOND);
        }
    }

    // Defensive: jump_times must cover all word boundaries.
    let last_boundary = *word_boundaries.last().expect("non-empty");
    if jump_times_s.len() <= last_boundary {
        return Ok(Vec::new());
    }

    // start_times = jump[boundaries[:-1]], end_times = jump[boundaries[1:]].
    let real_word_count = word_boundaries.len() - 1;
    let mut timings: Vec<WordTiming> = Vec::new();
    for k in 0..real_word_count {
        let start = jump_times_s[word_boundaries[k]];
        let end = jump_times_s[word_boundaries[k + 1]];
        let ids = &word_tokens[k];
        // Skip the trailing EOT word.
        if ids.first().map(|&t| t == args.eot_id).unwrap_or(false) {
            continue;
        }
        timings.push(WordTiming {
            word: words[k].clone(),
            start,
            end,
            tokens: ids.clone(),
        });
    }
    Ok(timings)
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. CrossAttentions container + collection trait (Half 1, `// SPIKE:`).
// ═════════════════════════════════════════════════════════════════════════════

/// Flat `(num_layers, num_heads, num_tokens, num_frames)` cross-attention store.
/// A dense `Vec<f32>` (not Array4) so the SPIKE'd collector can fill it from
/// whatever shape the ort `cross_attentions.*` outputs land in.
pub struct CrossAttentions {
    pub data: Vec<f32>,
    pub num_layers: usize,
    pub num_heads: usize,
    pub num_tokens: usize,
    pub num_frames: usize,
}

impl CrossAttentions {
    pub fn new(num_layers: usize, num_heads: usize, num_tokens: usize, num_frames: usize) -> Self {
        CrossAttentions {
            data: vec![0.0; num_layers * num_heads * num_tokens * num_frames],
            num_layers,
            num_heads,
            num_tokens,
            num_frames,
        }
    }

    #[inline]
    fn index(&self, l: usize, h: usize, t: usize, f: usize) -> usize {
        ((l * self.num_heads + h) * self.num_tokens + t) * self.num_frames + f
    }

    #[inline]
    pub fn get(&self, l: usize, h: usize, t: usize, f: usize) -> f32 {
        self.data[self.index(l, h, t, f)]
    }

    #[inline]
    pub fn set(&mut self, l: usize, h: usize, t: usize, f: usize, v: f32) {
        let i = self.index(l, h, t, f);
        self.data[i] = v;
    }
}

/// The autoregressive decode + cross-attention collection result.
pub struct TimestampedDecodeOutput {
    /// Generated tokens incl trailing EOT.
    pub text_tokens: Vec<i64>,
    pub cross_attentions: CrossAttentions,
    /// `num_samples // HOP_LENGTH` (pre 2× downsample).
    pub num_audio_frames: usize,
    /// Prompt prefix length (e.g. `[SOT, lang, transcribe, notimestamps]` → 4).
    pub prompt_length: usize,
}

/// Drives the `*_timestamped` Whisper decoder via ort IoBinding, capturing each
/// step's `cross_attentions.*` outputs. The IoBinding device-buffer copy-out,
/// KV-cache management, and the exact ORT output names are the `// SPIKE:` part —
/// confirmed against a live `onnx-community/whisper-*_timestamped` session in the
/// compile loop. The arithmetic consumer ([`align_words`]) is independent of it.
pub trait TimestampedDecoder {
    /// Run the decode loop on a precomputed mel, returning tokens + attentions.
    fn decode_with_cross_attn(&mut self) -> Result<TimestampedDecodeOutput, WordTsError>;
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. map_timings_to_text — relabel aligner words onto OUR transcript via a
//    SequenceMatcher-style diff. Port of map_timings_to_text (history path).
// ═════════════════════════════════════════════════════════════════════════════

/// One word of the target text carrying a (possibly distributed) time.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// Normalize a word for diff matching (lower-case, keep only alphanumerics).
fn norm_word(w: &str) -> String {
    w.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// Transfer the aligner's TIMED words onto the target `text` words via a
/// longest-common-subsequence diff: `equal` runs copy the time 1:1, `replace`/
/// `insert`/`delete` runs distribute the spanned time evenly, with a monotonic
/// clamp so start/end never go backwards. Mirrors `map_timings_to_text`.
pub fn map_timings_to_text(timed: &[WordTiming], text_words: &[String]) -> Vec<MappedWord> {
    if text_words.is_empty() {
        return Vec::new();
    }
    if timed.is_empty() {
        // No timing → zero-duration words at t=0 (monotonic, honest).
        return text_words
            .iter()
            .map(|w| MappedWord { text: w.clone(), start: 0.0, end: 0.0 })
            .collect();
    }

    let a: Vec<String> = timed.iter().map(|t| norm_word(&t.word)).collect();
    let b: Vec<String> = text_words.iter().map(|w| norm_word(w)).collect();
    let opcodes = diff_opcodes(&a, &b);

    let mut out: Vec<MappedWord> = Vec::with_capacity(text_words.len());
    let mut last_end = timed.first().map(|t| t.start).unwrap_or(0.0);

    for op in opcodes {
        match op {
            Opcode::Equal { a0, a1, b0, b1 } => {
                // 1:1 transfer along the diagonal of the equal run.
                let len = (a1 - a0).min(b1 - b0);
                for k in 0..(b1 - b0) {
                    let src = if k < len { a0 + k } else { a1.saturating_sub(1) };
                    let t = &timed[src.min(timed.len() - 1)];
                    let start = t.start.max(last_end);
                    let end = t.end.max(start);
                    last_end = end;
                    out.push(MappedWord { text: text_words[b0 + k].clone(), start, end });
                }
            }
            Opcode::Replace { a0, a1, b0, b1 }
            | Opcode::Insert { a0, a1, b0, b1 }
            | Opcode::Delete { a0, a1, b0, b1 } => {
                // Distribute the spanned source time evenly across the b-run.
                let span_start = timed
                    .get(a0.min(timed.len().saturating_sub(1)))
                    .map(|t| t.start)
                    .unwrap_or(last_end)
                    .max(last_end);
                let span_end = if a1 > a0 {
                    timed[(a1 - 1).min(timed.len() - 1)].end
                } else {
                    span_start
                }
                .max(span_start);
                let count = (b1 - b0).max(1) as f64;
                let step = (span_end - span_start) / count;
                for (k, idx) in (b0..b1).enumerate() {
                    let start = (span_start + step * k as f64).max(last_end);
                    let end = (span_start + step * (k as f64 + 1.0)).max(start);
                    last_end = end;
                    out.push(MappedWord { text: text_words[idx].clone(), start, end });
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
enum Opcode {
    Equal { a0: usize, a1: usize, b0: usize, b1: usize },
    Replace { a0: usize, a1: usize, b0: usize, b1: usize },
    Insert { a0: usize, a1: usize, b0: usize, b1: usize },
    Delete { a0: usize, a1: usize, b0: usize, b1: usize },
}

/// LCS-based opcode diff over two token lists (difflib.SequenceMatcher style:
/// alternating equal / non-equal runs covering both sequences end to end).
fn diff_opcodes(a: &[String], b: &[String]) -> Vec<Opcode> {
    let n = a.len();
    let m = b.len();
    // LCS DP table.
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    // Walk the table to recover matched index pairs.
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            matches.push((i, j));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }

    // Build alternating opcodes from the match anchors.
    let mut ops: Vec<Opcode> = Vec::new();
    let (mut ai, mut bi) = (0usize, 0usize);
    let mut iter = matches.into_iter().peekable();
    while iter.peek().is_some() {
        // Coalesce a contiguous run of matches into one Equal opcode.
        let (ma, mb) = *iter.peek().expect("peeked");
        if ma > ai || mb > bi {
            push_nonequal(&mut ops, ai, ma, bi, mb);
            ai = ma;
            bi = mb;
        }
        let (mut ea, mut eb) = (ai, bi);
        while let Some(&(ca, cb)) = iter.peek() {
            if ca == ea && cb == eb {
                ea += 1;
                eb += 1;
                iter.next();
            } else {
                break;
            }
        }
        ops.push(Opcode::Equal { a0: ai, a1: ea, b0: bi, b1: eb });
        ai = ea;
        bi = eb;
    }
    if ai < n || bi < m {
        push_nonequal(&mut ops, ai, n, bi, m);
    }
    ops
}

fn push_nonequal(ops: &mut Vec<Opcode>, a0: usize, a1: usize, b0: usize, b1: usize) {
    if a0 == a1 && b0 == b1 {
        return;
    }
    let op = if a0 < a1 && b0 < b1 {
        Opcode::Replace { a0, a1, b0, b1 }
    } else if b0 < b1 {
        Opcode::Insert { a0, a1, b0, b1 }
    } else {
        Opcode::Delete { a0, a1, b0, b1 }
    };
    ops.push(op);
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Tests — the numpy pipeline (no ort). Mandatory base85/gzip round-trip.
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── alignment heads decode (the load-bearing magic constants) ───────────

    /// Known (layers, heads) for every alignment-heads key (Whisper architecture).
    fn dims_for_key(key: &str) -> (usize, usize) {
        match key.trim_end_matches(".en") {
            "tiny" => (4, 6),
            "base" => (6, 8),
            "small" => (12, 12),
            "medium" => (24, 16),
            "large-v1" | "large-v2" | "large-v3" => (32, 20),
            "large-v3-turbo" | "turbo" => (4, 20),
            other => panic!("unknown alignment-heads key {other}"),
        }
    }

    #[test]
    fn every_alignment_blob_decodes_to_correct_shape() {
        // Each blob must base85-decode + gzip-inflate to EXACTLY (layers, heads)
        // bools. A wrong base85 variant or bad gzip would mismatch the shape.
        for (key, blob) in ALIGNMENT_HEADS {
            let (layers, heads) = dims_for_key(key);
            let mask = decode_alignment_heads(blob, layers, heads)
                .unwrap_or_else(|e| panic!("decode {key} failed: {e}"));
            assert_eq!(mask.dim(), (layers, heads), "{key} wrong shape");
            assert!(mask.iter().any(|&b| b), "{key} selects at least one head");
        }
    }

    #[test]
    fn tiny_alignment_heads_has_true_positions() {
        // tiny = (4 layers, 6 heads). Decodes cleanly and has at least one head set.
        let mask = decode_alignment_heads(blob_for("tiny").unwrap(), 4, 6).unwrap();
        assert_eq!(mask.dim(), (4, 6));
        assert!(mask.iter().any(|&b| b), "tiny must select at least one head");
    }

    #[test]
    fn lookup_picks_en_for_en_vocab() {
        // tiny dims (4,6) with the English vocab size → the tiny.en table.
        let en = lookup_alignment_heads(4, 6, EN_VOCAB_SIZE);
        let expected = decode_alignment_heads(blob_for("tiny.en").unwrap(), 4, 6).unwrap();
        assert_eq!(en, expected);
        // Multilingual vocab → the plain tiny table (different from tiny.en).
        let multi = lookup_alignment_heads(4, 6, 51_865);
        let plain = decode_alignment_heads(blob_for("tiny").unwrap(), 4, 6).unwrap();
        assert_eq!(multi, plain);
    }

    #[test]
    fn lookup_unknown_dims_fall_back_to_upper_half() {
        // Unknown (3,4) → upper-half-of-layers mask: rows 1,2 true; row 0 false.
        let mask = lookup_alignment_heads(3, 4, 51_865);
        for h in 0..4 {
            assert!(!mask[[0, h]], "row 0 must be false");
            assert!(mask[[1, h]] && mask[[2, h]], "upper half true");
        }
    }

    // ── median filter ───────────────────────────────────────────────────────

    #[test]
    fn median_width_one_is_identity() {
        let x = [3.0f32, 1.0, 2.0];
        assert_eq!(median_filter_1d(&x, 1).unwrap(), x.to_vec());
    }

    #[test]
    fn median_even_width_errors() {
        assert!(matches!(median_filter_1d(&[1.0, 2.0, 3.0], 4), Err(WordTsError::EvenFilterWidth(4))));
    }

    #[test]
    fn median_width_three_reflect() {
        // [1,5,1,5,1] reflect-pad 1 → [5,1,5,1,5,1,5]; windows median:
        //   (5,1,5)->5  wait: window0 = padded[0..3] = [5,1,5] median 5
        // Recompute per-index against numpy reflect semantics:
        //   padded = [5,1,5,1,5,1,5]
        //   i0 [5,1,5]->5 ; i1 [1,5,1]->1 ; i2 [5,1,5]->5 ; i3 [1,5,1]->1 ; i4 [5,1,5]->5
        let x = [1.0f32, 5.0, 1.0, 5.0, 1.0];
        let out = median_filter_1d(&x, 3).unwrap();
        assert_eq!(out, vec![5.0, 1.0, 5.0, 1.0, 5.0]);
    }

    #[test]
    fn reflect_pad_no_edge_repeat() {
        // numpy reflect: [a,b,c] pad 2 → [c,b,a,b,c,b,a].
        let out = reflect_pad(&[1.0, 2.0, 3.0], 2);
        assert_eq!(out, vec![3.0, 2.0, 1.0, 2.0, 3.0, 2.0, 1.0]);
    }

    // ── DTW ─────────────────────────────────────────────────────────────────

    #[test]
    fn dtw_clean_diagonal() {
        // A diagonal-favoring cost (0 on diagonal, high off) → the diagonal path.
        let mut cost = Array2::<f64>::from_elem((3, 3), 10.0);
        for d in 0..3 {
            cost[[d, d]] = 0.0;
        }
        let (ti, tj) = dtw(&cost);
        assert_eq!(ti, vec![0, 1, 2]);
        assert_eq!(tj, vec![0, 1, 2]);
    }

    #[test]
    fn dtw_monotonic_path() {
        // Any cost matrix → indices are non-decreasing and end at (N-1, M-1).
        let cost = Array2::<f64>::from_shape_vec(
            (2, 3),
            vec![0.0, 1.0, 5.0, 5.0, 1.0, 0.0],
        )
        .unwrap();
        let (ti, tj) = dtw(&cost);
        assert_eq!(*ti.last().unwrap(), 1);
        assert_eq!(*tj.last().unwrap(), 2);
        for w in ti.windows(2) {
            assert!(w[1] >= w[0]);
        }
        for w in tj.windows(2) {
            assert!(w[1] >= w[0]);
        }
    }

    // ── word splitting ──────────────────────────────────────────────────────

    /// A trivial byte-decoder for tests: maps a known id table to text fragments.
    fn fake_decode(ids: &[i64]) -> String {
        // 1=" Hello", 2=" world", 3=",", 100=EOT(renders empty), default=""
        let mut s = String::new();
        for &id in ids {
            match id {
                1 => s.push_str(" Hello"),
                2 => s.push_str(" world"),
                3 => s.push(','),
                4 => s.push_str("ish"), // a continuation subword (no space)
                100 => {}
                _ => {}
            }
        }
        s
    }

    #[test]
    fn split_groups_space_prefixed_words() {
        let f = fake_decode;
        let (words, toks) = split_tokens_into_words(&[1, 2], &f, 100, None);
        assert_eq!(words, vec![" Hello".to_string(), " world".to_string()]);
        assert_eq!(toks, vec![vec![1], vec![2]]);
    }

    #[test]
    fn split_merges_continuation_subword() {
        // " Hello" + "ish" (no space prefix, not punct) → one word " Helloish".
        let f = fake_decode;
        let (words, _toks) = split_tokens_into_words(&[1, 4], &f, 100, None);
        assert_eq!(words, vec![" Helloish".to_string()]);
    }

    #[test]
    fn split_punctuation_is_its_own_word() {
        let f = fake_decode;
        let (words, _toks) = split_tokens_into_words(&[1, 3], &f, 100, None);
        assert_eq!(words, vec![" Hello".to_string(), ",".to_string()]);
    }

    #[test]
    fn split_cjk_keeps_unicode_boundaries() {
        // For a CJK language we stop at subword boundaries (no space merge).
        let decode = |ids: &[i64]| -> String {
            ids.iter()
                .map(|&id| match id {
                    10 => '你',
                    11 => '好',
                    _ => ' ',
                })
                .collect()
        };
        let (words, _toks) = split_tokens_into_words(&[10, 11], &decode, 100, Some("zh"));
        assert_eq!(words, vec!["你".to_string(), "好".to_string()]);
    }

    // ── align_words end-to-end on a synthetic monotonic alignment ───────────

    #[test]
    fn align_words_monotonic_on_synthetic_matrix() {
        // 2 layers, 1 head, all heads selected via a custom mask.
        let mut mask = Array2::from_elem((2, 1), false);
        mask[[1, 0]] = true; // upper-half head
        // text tokens: [1(" Hello"), 2(" world"), 100(EOT)]; prompt_length 1.
        let text = [1i64, 2, 100];
        // Decoder rows = prompt + text = 1 + 3 = 4 tokens; 8 encoder frames.
        let n_tokens = 4;
        let n_frames = 8;
        let mut ca = CrossAttentions::new(2, 1, n_tokens, n_frames);
        // Put a strong diagonal-ish attention: token i attends frame ~2*i.
        for t in 0..n_tokens {
            let f = (t * 2).min(n_frames - 1);
            ca.set(1, 0, t, f, 5.0);
        }
        let args = AlignArgs {
            text_tokens: &text,
            decode_one: &fake_decode,
            eot_id: 100,
            prompt_length: 1,
            num_audio_frames: n_frames * 2, // //2 inside → n_frames
            language: None,
            medfilt_width: 1,
            qk_scale: 1.0,
        };
        let timings = align_words(&ca, &mask, args).unwrap();
        // Two real words; monotonic non-decreasing start/end; EOT excluded.
        assert!(timings.iter().all(|w| w.tokens.first() != Some(&100)));
        for w in timings.windows(2) {
            assert!(w[1].start >= w[0].start, "starts non-decreasing");
        }
    }

    #[test]
    fn align_words_empty_text_is_empty() {
        let mask = Array2::from_elem((2, 1), true);
        let ca = CrossAttentions::new(2, 1, 2, 4);
        let args = AlignArgs {
            text_tokens: &[],
            decode_one: &fake_decode,
            eot_id: 100,
            prompt_length: 1,
            num_audio_frames: 8,
            language: None,
            medfilt_width: 1,
            qk_scale: 1.0,
        };
        assert!(align_words(&ca, &mask, args).unwrap().is_empty());
    }

    // ── map_timings_to_text ─────────────────────────────────────────────────

    #[test]
    fn map_timings_transfers_equal_words() {
        let timed = vec![
            WordTiming { word: "test".into(), start: 0.0, end: 0.5, tokens: vec![] },
            WordTiming { word: "that".into(), start: 0.5, end: 1.0, tokens: vec![] },
        ];
        // "test that" → "test this": "test" equal (keeps 0.0-0.5), "that"→"this".
        let text = vec!["test".to_string(), "this".to_string()];
        let mapped = map_timings_to_text(&timed, &text);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].text, "test");
        assert!((mapped[0].start - 0.0).abs() < 1e-9);
        assert!((mapped[0].end - 0.5).abs() < 1e-9);
        // "this" carries the replaced "that" timing window (0.5-1.0).
        assert_eq!(mapped[1].text, "this");
        assert!(mapped[1].start >= mapped[0].end - 1e-9, "monotonic");
        assert!(mapped[1].end >= mapped[1].start);
    }

    #[test]
    fn map_timings_is_monotonic() {
        let timed = vec![
            WordTiming { word: "a".into(), start: 0.0, end: 0.3, tokens: vec![] },
            WordTiming { word: "b".into(), start: 0.3, end: 0.6, tokens: vec![] },
            WordTiming { word: "c".into(), start: 0.6, end: 0.9, tokens: vec![] },
        ];
        let text = vec!["a".to_string(), "x".to_string(), "y".to_string(), "c".to_string()];
        let mapped = map_timings_to_text(&timed, &text);
        assert_eq!(mapped.len(), 4);
        let mut prev = -1.0;
        for m in &mapped {
            assert!(m.start >= prev - 1e-9, "starts monotonic");
            assert!(m.end >= m.start - 1e-9);
            prev = m.start;
        }
    }

    #[test]
    fn map_timings_empty_timed_zeroes() {
        let text = vec!["a".to_string(), "b".to_string()];
        let mapped = map_timings_to_text(&[], &text);
        assert_eq!(mapped.len(), 2);
        assert!(mapped.iter().all(|m| m.start == 0.0 && m.end == 0.0));
    }

    // ── CrossAttentions indexing ────────────────────────────────────────────

    #[test]
    fn cross_attentions_roundtrip_index() {
        let mut ca = CrossAttentions::new(2, 3, 4, 5);
        ca.set(1, 2, 3, 4, 7.5);
        assert_eq!(ca.get(1, 2, 3, 4), 7.5);
        assert_eq!(ca.get(0, 0, 0, 0), 0.0);
    }
}
