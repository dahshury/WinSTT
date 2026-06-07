// Greedy next-token selection over decoder logits: the no-speech / first-step EOS guard, the
// suppress-token mask, the allowed-token-restricted variant, and the softmax + argmax primitives.
// Self-free (everything is passed in); split out of `whisper.rs` so the engine core stays cohesive.

pub(super) const WHISPER_NO_SPEECH_THRESHOLD: f32 = 0.2;
pub(super) const WHISPER_SUPPRESS_TOKENS: &[usize] = &[
    1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359,
    503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246, 3253, 3268,
    3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331,
    12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520,
    26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470, 36865, 42863, 47425, 49870, 50254,
    50258, 50360, 50361, 50362,
];

/// Default `no_repeat_ngram` order for the greedy decode. A token is banned at the next step when
/// it would recreate an `n`-gram already produced earlier in THIS decode. 3 is the value the
/// Whisper ecosystem uses to break greedy repetition loops: it never fires on text that doesn't
/// actually repeat a trigram (so clean transcriptions are untouched) but it deterministically
/// derails the verbatim phrase loops and runaway single-token runs ("...") that lite-whisper's
/// low-rank/factorized encoders fall into — the failure the full-rank Whisper / Canary encoders
/// don't exhibit. EOS is never in the ban set (it only appears once, at the terminating step).
pub(super) const NO_REPEAT_NGRAM_SIZE: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SelectedToken {
    pub(super) token: i64,
    pub(super) top_logit: f32,
    pub(super) runner_up_logit: f32,
}

/// HuggingFace-style `no_repeat_ngram` ban set. `generated` is the decode region AFTER the static
/// prompt (the prompt is special markers that never recur in text, so excluding it avoids any
/// special-token interaction). Returns every token that, appended next, would make the trailing
/// `ngram_size`-gram equal to one produced earlier — i.e. the continuations that would close a
/// repetition loop. Empty until `generated` holds at least one full prior n-gram.
pub(super) fn no_repeat_ngram_banned(generated: &[i64], ngram_size: usize) -> Vec<i64> {
    if ngram_size == 0 || generated.len() + 1 < ngram_size {
        return Vec::new();
    }
    let prefix_len = ngram_size - 1;
    let suffix = &generated[generated.len() - prefix_len..];
    let mut banned: Vec<i64> = Vec::new();
    // Every complete n-gram window whose leading `prefix_len` tokens match the current suffix has a
    // last token that would recreate that n-gram if emitted next → ban it. The "three identical in a
    // row" case (window == suffix+repeat) is covered too: it bans the repeated token, capping runs.
    for window in generated.windows(ngram_size) {
        if &window[..prefix_len] == suffix {
            let tok = window[prefix_len];
            if !banned.contains(&tok) {
                banned.push(tok);
            }
        }
    }
    banned
}

pub(super) fn build_suppress_token_mask(vocab_size: usize) -> Vec<bool> {
    let mut mask = vec![false; vocab_size];
    for &token in WHISPER_SUPPRESS_TOKENS {
        if let Some(slot) = mask.get_mut(token) {
            *slot = true;
        }
    }
    mask
}

pub(super) fn select_whisper_token(
    logits: &[f32],
    suppress_token_mask: &[bool],
    eos_token_id: i64,
    nospeech_token_id: Option<i64>,
    is_first_step: bool,
    banned_tokens: &[i64],
) -> SelectedToken {
    if is_first_step
        && nospeech_token_id
            .and_then(|token| softmax_probability(logits, token as usize))
            .is_some_and(|p| p > WHISPER_NO_SPEECH_THRESHOLD)
    {
        let eos = eos_token_id.max(0) as usize;
        return SelectedToken {
            token: eos_token_id,
            top_logit: logits.get(eos).copied().unwrap_or(f32::NAN),
            runner_up_logit: f32::NEG_INFINITY,
        };
    }

    let eos = eos_token_id.max(0) as usize;
    let mut best: Option<(usize, f32)> = None;
    let mut runner_up = f32::NEG_INFINITY;
    for (idx, &value) in logits.iter().enumerate() {
        let suppressed = suppress_token_mask.get(idx).copied().unwrap_or(false);
        let banned = banned_tokens.contains(&(idx as i64));
        if suppressed || banned || (is_first_step && idx == eos) {
            continue;
        }

        match best {
            Some((_, best_value)) if value > best_value => {
                runner_up = runner_up.max(best_value);
                best = Some((idx, value));
            }
            Some(_) => {
                runner_up = runner_up.max(value);
            }
            None => best = Some((idx, value)),
        }
    }

    if let Some((token, top_logit)) = best {
        SelectedToken {
            token: token as i64,
            top_logit,
            runner_up_logit: runner_up,
        }
    } else {
        let token = argmax(logits);
        SelectedToken {
            token: token as i64,
            top_logit: logits.get(token).copied().unwrap_or(f32::NAN),
            runner_up_logit: f32::NEG_INFINITY,
        }
    }
}

pub(super) fn select_whisper_token_from_allowed(
    logits: &[f32],
    allowed_tokens: &[i64],
    eos_token_id: i64,
    nospeech_token_id: Option<i64>,
    is_first_step: bool,
) -> SelectedToken {
    if is_first_step
        && nospeech_token_id
            .and_then(|token| softmax_probability(logits, token as usize))
            .is_some_and(|p| p > WHISPER_NO_SPEECH_THRESHOLD)
    {
        let eos = eos_token_id.max(0) as usize;
        return SelectedToken {
            token: eos_token_id,
            top_logit: logits.get(eos).copied().unwrap_or(f32::NAN),
            runner_up_logit: f32::NEG_INFINITY,
        };
    }

    let eos = eos_token_id.max(0) as usize;
    let mut best: Option<(usize, f32)> = None;
    let mut runner_up = f32::NEG_INFINITY;
    for &token in allowed_tokens {
        if token < 0 {
            continue;
        }
        let idx = token as usize;
        if is_first_step && idx == eos {
            continue;
        }
        let Some(&value) = logits.get(idx) else {
            continue;
        };
        match best {
            Some((_, best_value)) if value > best_value => {
                runner_up = runner_up.max(best_value);
                best = Some((idx, value));
            }
            Some(_) => {
                runner_up = runner_up.max(value);
            }
            None => best = Some((idx, value)),
        }
    }

    if let Some((token, top_logit)) = best {
        SelectedToken {
            token: token as i64,
            top_logit,
            runner_up_logit: runner_up,
        }
    } else {
        select_whisper_token(logits, &[], eos_token_id, nospeech_token_id, is_first_step, &[])
    }
}

pub(super) fn softmax_probability(logits: &[f32], token_id: usize) -> Option<f32> {
    let target = *logits.get(token_id)?;
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if !max.is_finite() {
        return None;
    }
    let denom: f32 = logits.iter().map(|v| (*v - max).exp()).sum();
    if denom <= 0.0 || !denom.is_finite() {
        return None;
    }
    Some((target - max).exp() / denom)
}

/// argmax over an f32 slice (greedy next-token). Empty → 0.
pub(super) fn argmax(xs: &[f32]) -> usize {
    let mut best = 0usize;
    let mut best_v = f32::NEG_INFINITY;
    for (i, &v) in xs.iter().enumerate() {
        if v > best_v {
            best_v = v;
            best = i;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argmax_picks_largest() {
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
        assert_eq!(argmax(&[-5.0, -1.0, -9.0]), 1);
        assert_eq!(argmax(&[]), 0);
    }

    #[test]
    fn token_selector_forces_eos_when_no_speech_probability_is_high() {
        let mut logits = vec![0.0; 8];
        logits[4] = 10.0;

        let selected = select_whisper_token(&logits, &[], 2, Some(4), true, &[]);

        assert_eq!(selected.token, 2);
    }

    #[test]
    fn token_selector_suppresses_non_speech_and_first_step_eos() {
        let mut logits = vec![0.0; 8];
        logits[1] = 12.0;
        logits[2] = 11.0;
        logits[5] = 1.0;
        let mut suppress = vec![false; 8];
        suppress[1] = true;

        let selected = select_whisper_token(&logits, &suppress, 2, None, true, &[]);

        assert_eq!(selected.token, 5);
    }

    #[test]
    fn token_selector_allows_eos_after_first_step() {
        let mut logits = vec![0.0; 8];
        logits[2] = 11.0;
        logits[5] = 1.0;

        let selected = select_whisper_token(&logits, &[], 2, None, false, &[]);

        assert_eq!(selected.token, 2);
    }

    #[test]
    fn token_selector_skips_banned_tokens_and_picks_runner_up() {
        let mut logits = vec![0.0; 8];
        logits[6] = 20.0; // would-be argmax, but banned (closes a repetition loop)
        logits[3] = 9.0; // runner-up that should win once 6 is banned
        logits[1] = 4.0;

        let selected = select_whisper_token(&logits, &[], 2, None, false, &[6]);

        assert_eq!(selected.token, 3);
    }

    #[test]
    fn no_repeat_ngram_bans_loop_continuation() {
        // "A B C D A B C" — suffix "B C" already continued with "D"; banning D breaks the loop.
        let generated = [10, 11, 12, 13, 10, 11, 12];
        assert_eq!(no_repeat_ngram_banned(&generated, 3), vec![13]);
    }

    #[test]
    fn no_repeat_ngram_caps_single_token_runs() {
        // Three identical tokens → a 4th would recreate the trigram, so it is banned (kills "..." walls).
        let generated = [7, 7, 7];
        assert_eq!(no_repeat_ngram_banned(&generated, 3), vec![7]);
        // Two in a row is fine — natural repetition is left alone.
        assert!(no_repeat_ngram_banned(&[7, 7], 3).is_empty());
    }

    #[test]
    fn no_repeat_ngram_is_noop_without_a_repeat() {
        // A non-repeating sequence bans nothing — clean transcriptions are untouched.
        let generated = [1, 2, 3, 4, 5, 6];
        assert!(no_repeat_ngram_banned(&generated, 3).is_empty());
        // Too short to hold a full prior n-gram.
        assert!(no_repeat_ngram_banned(&[1, 2], 3).is_empty());
        assert!(no_repeat_ngram_banned(&[], 3).is_empty());
    }

    #[test]
    fn allowed_token_selector_chooses_best_allowed_token() {
        let mut logits = vec![0.0; 8];
        logits[1] = 20.0;
        logits[3] = 4.0;
        logits[6] = 9.0;

        let selected = select_whisper_token_from_allowed(&logits, &[3, 6], 2, None, true);

        assert_eq!(selected.token, 6);
    }

    #[test]
    fn allowed_token_selector_keeps_no_speech_first_step_guard() {
        let mut logits = vec![0.0; 8];
        logits[4] = 10.0;
        logits[6] = 9.0;

        let selected = select_whisper_token_from_allowed(&logits, &[6], 2, Some(4), true);

        assert_eq!(selected.token, 2);
    }
}
