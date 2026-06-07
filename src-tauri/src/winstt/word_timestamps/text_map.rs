// ═════════════════════════════════════════════════════════════════════════════
// 8. map_timings_to_text — relabel aligner words onto OUR transcript via a
//    SequenceMatcher-style diff. Port of map_timings_to_text (history path).
// ═════════════════════════════════════════════════════════════════════════════

use super::WordTiming;

/// One word of the target text carrying a (possibly distributed) time.
#[derive(Debug, Clone, PartialEq)]
pub struct MappedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// Normalize a word for diff matching (lower-case, keep only alphanumerics).
fn norm_word(w: &str) -> String {
    w.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
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
            .map(|w| MappedWord {
                text: w.clone(),
                start: 0.0,
                end: 0.0,
            })
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
                    let src = if k < len {
                        a0 + k
                    } else {
                        a1.saturating_sub(1)
                    };
                    let t = &timed[src.min(timed.len() - 1)];
                    let start = t.start.max(last_end);
                    let end = t.end.max(start);
                    last_end = end;
                    out.push(MappedWord {
                        text: text_words[b0 + k].clone(),
                        start,
                        end,
                    });
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
                    out.push(MappedWord {
                        text: text_words[idx].clone(),
                        start,
                        end,
                    });
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
enum Opcode {
    Equal {
        a0: usize,
        a1: usize,
        b0: usize,
        b1: usize,
    },
    Replace {
        a0: usize,
        a1: usize,
        b0: usize,
        b1: usize,
    },
    Insert {
        a0: usize,
        a1: usize,
        b0: usize,
        b1: usize,
    },
    Delete {
        a0: usize,
        a1: usize,
        b0: usize,
        b1: usize,
    },
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
        ops.push(Opcode::Equal {
            a0: ai,
            a1: ea,
            b0: bi,
            b1: eb,
        });
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
