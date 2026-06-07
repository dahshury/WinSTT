// ═════════════════════════════════════════════════════════════════════════════
// 6. align_words — the full pipeline.  Verbatim port of align_words.
// ═════════════════════════════════════════════════════════════════════════════

use ndarray::{Array2, Array3};

use super::{dtw, median_filter_1d, split_tokens_into_words, WordTsError, TOKENS_PER_SECOND};

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
///
/// [`lookup_alignment_heads`]: super::lookup_alignment_heads
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
    let (words, word_tokens) = split_tokens_into_words(
        args.text_tokens,
        args.decode_one,
        args.eot_id,
        args.language,
    );
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
// 7. CrossAttentions container (filled by the engine's decode loop — Half 1).
// ═════════════════════════════════════════════════════════════════════════════

/// Flat `(num_layers, num_heads, num_tokens, num_frames)` cross-attention store.
/// A dense `Vec<f32>` (not Array4) so the engine's per-step collector
/// (`WhisperEngine::decode_with_cross_attn`) can fill it row-major regardless of the
/// per-step ort `cross_attentions.{i}` `(1, heads, dec_step_len, frames)` shape.
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
