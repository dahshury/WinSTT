// Reference: E:/DL/Projects/onnx-asr/src/onnx_asr/word_timestamps.py
//         (itself a port of openai-whisper/whisper/timing.py, MIT)
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
//   Half 1 (COLLECTION, implemented in `stt::whisper`) — the autoregressive decode
//   loop reads the sorted `cross_attentions.{i}` outputs from the
//   `onnx-community/whisper-*_timestamped` decoder export each step and concatenates
//   them along the decoder-token axis into the [`CrossAttentions`] buffer below.
//   See `WhisperEngine::decode_with_cross_attn`.
//
//   Half 2 (PURE ARITHMETIC, implemented + tested here) — the DTW alignment pipeline:
//   alignment-heads decode (base85+gzip), median filter, softmax/normalize, DTW
//   backtrace, GPT-2 byte-decoder word grouping, and the jump-time word boundaries.
//   This is `word_timestamps.py` verbatim, entirely arithmetic.
//
// ─────────────────────────────────────────────────────────────────────────────
// MODULE LAYOUT (split from a single file; public paths unchanged)
// ─────────────────────────────────────────────────────────────────────────────
//   heads     — alignment-heads decode (base85 + gzip) + lookup/fallback
//   dsp       — pure DSP/grouping primitives (median filter, DTW, word grouping)
//   align     — the `align_words` orchestrator + IO types + CrossAttentions buffer
//   text_map  — the independent LCS text-relabel path (`map_timings_to_text`)
// All public items below are re-exported so `crate::winstt::word_timestamps::X`
// paths stay stable for `stt::whisper` and `managers::word_aligner`.

mod align;
mod dsp;
mod heads;
mod text_map;

pub use align::{align_words, AlignArgs, CrossAttentions, WordTiming};
pub use dsp::{dtw, median_filter_1d, split_tokens_into_words};
pub use heads::{decode_alignment_heads, lookup_alignment_heads};
pub use text_map::{map_timings_to_text, MappedWord};

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
    (
        "small.en",
        "ABzY8>?_)10{>%RpeA61k&I|OI3I$65C{;;pbCHh0B{qLQ;+}v00",
    ),
    ("small", "ABzY8DmU6=0{>%Rpa?J`kvJ6qF(V^F86#Xh7JUGMK}P<N0000"),
    (
        "medium.en",
        "ABzY8usPae0{>%R7<zz_OvQ{)4kMa0BMw6u5rT}kRKX;$NfYBv00*Hl@qhsU00",
    ),
    ("medium", "ABzY8B0Jh+0{>%R7}kK1fFL7w6%<-Pf*t^=N)Qr&0RR9"),
    (
        "large-v1",
        "ABzY8r9j$a0{>%R7#4sLmoOs{s)o3~84-RPdcFk!JR<kSfC2yj",
    ),
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
// 2. Shared error — used by heads-decode, median_filter, and align_words.
// ═════════════════════════════════════════════════════════════════════════════

/// Errors from the word-timestamp pipeline.
#[derive(Debug, thiserror::Error)]
pub enum WordTsError {
    #[error("base85 decode failed: {0}")]
    Base85(String),
    #[error("gzip inflate failed: {0}")]
    Gzip(String),
    #[error(
        "alignment-heads blob reshapes to {got} bools, expected {expected} ({layers}x{heads})"
    )]
    Shape {
        got: usize,
        expected: usize,
        layers: usize,
        heads: usize,
    },
    #[error("median filter width must be odd, got {0}")]
    EvenFilterWidth(usize),
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Tests — the numpy pipeline (no ort). Mandatory base85/gzip round-trip.
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::dsp::reflect_pad;
    use super::heads::blob_for;
    use super::*;
    use ndarray::Array2;

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
        assert!(
            mask.iter().any(|&b| b),
            "tiny must select at least one head"
        );
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
        assert!(matches!(
            median_filter_1d(&[1.0, 2.0, 3.0], 4),
            Err(WordTsError::EvenFilterWidth(4))
        ));
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
        let cost =
            Array2::<f64>::from_shape_vec((2, 3), vec![0.0, 1.0, 5.0, 5.0, 1.0, 0.0]).unwrap();
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
            WordTiming {
                word: "test".into(),
                start: 0.0,
                end: 0.5,
                tokens: vec![],
            },
            WordTiming {
                word: "that".into(),
                start: 0.5,
                end: 1.0,
                tokens: vec![],
            },
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
            WordTiming {
                word: "a".into(),
                start: 0.0,
                end: 0.3,
                tokens: vec![],
            },
            WordTiming {
                word: "b".into(),
                start: 0.3,
                end: 0.6,
                tokens: vec![],
            },
            WordTiming {
                word: "c".into(),
                start: 0.6,
                end: 0.9,
                tokens: vec![],
            },
        ];
        let text = vec![
            "a".to_string(),
            "x".to_string(),
            "y".to_string(),
            "c".to_string(),
        ];
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
