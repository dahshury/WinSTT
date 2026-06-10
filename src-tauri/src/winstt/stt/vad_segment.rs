//! Unlimited-length FINAL transcription via Silero-VAD segmentation.
//!
//! WHY: several engines have a hard per-decode window — Whisper truncates to a fixed 30 s mel
//! window (`mel.rs` `audio.len().min(N_SAMPLES)`), and the AED decoders (Canary/Cohere) cap at
//! ~1024 tokens. Feeding a >30 s recording to those in one shot silently drops everything past the
//! cap. The fix (WhisperX `merge_chunks` / onnx-asr `_merge_segments`): cut the recording into
//! speech chunks on SILENCE boundaries (never through a word), each ≤ a max duration that stays
//! under the engine's window, decode each chunk INDEPENDENTLY through the same offline engine, and
//! join the texts. This makes EVERY family unlimited-length with no per-engine change.
//!
//! This is the FINAL-decode path only; the live-preview path (realtime worker) is unchanged.
//!
//! Algorithm ported from `examples/streaming-refs/onnx-asr/src/onnx_asr/vad.py:55-82`
//! (`_merge_segments`) — chosen over whisperX's pandas-based variant for its hard max-cap guarantee
//! and lack of heavy deps. Raw speech regions come from our existing Silero VAD (a binary
//! speech/noise mask at the shared `VAD_SPEECH_THRESHOLD`); `merge_segments` then merges regions
//! separated by sub-`min_silence` gaps up to the `max_chunk` cap and cuts in the silence otherwise.

use std::borrow::Cow;

use crate::audio_toolkit::vad::{SileroVad, VoiceActivityDetector, VAD_FRAME_SAMPLES};

use super::{TranscribeOptions, Transcriber};

const SR: usize = 16_000;
const MAX_RETAINED_SILENCE: usize = SR * 200 / 1000;
const MIN_DECODE_CHUNK: usize = SR * 750 / 1000;
pub const VAD_COMPACT_MIN_S: f32 = 5.0;

fn speech_mask(vad: &mut SileroVad, audio: &[f32]) -> Vec<bool> {
    vad.reset();
    let mut mask = Vec::with_capacity(audio.len() / VAD_FRAME_SAMPLES + 1);
    let mut i = 0;
    while i + VAD_FRAME_SAMPLES <= audio.len() {
        let speech = vad
            .is_voice(&audio[i..i + VAD_FRAME_SAMPLES])
            .unwrap_or(false);
        mask.push(speech);
        i += VAD_FRAME_SAMPLES;
    }
    mask
}

/// Build raw speech segments `(start_sample, end_sample)` from a per-frame speech mask.
/// Each `true` run becomes one segment; a trailing open run closes at `total_len`.
fn find_segments(mask: &[bool], frame: usize, total_len: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (fi, &sp) in mask.iter().enumerate() {
        if sp {
            if start.is_none() {
                start = Some(fi);
            }
        } else if let Some(s) = start.take() {
            out.push((s * frame, (fi * frame).min(total_len)));
        }
    }
    if let Some(s) = start {
        out.push((s * frame, total_len));
    }
    out
}

/// Merge raw speech segments into decode chunks. Port of onnx-asr `_merge_segments`
/// (vad.py:55-82): absorb the next region when the silence gap is `< min_silence` AND the running
/// chunk stays `< max_chunk`; otherwise emit the running chunk (if longer than `min_speech`) padded
/// by `pad` each side, and — only for a single continuous-speech region longer than `max_chunk` —
/// hard-split it every `max_chunk` samples. All positions in samples @ 16 kHz.
fn merge_segments(
    segs: &[(usize, usize)],
    total_len: usize,
    max_chunk: usize,
    min_speech: usize,
    min_silence: usize,
    pad: usize,
) -> Vec<(usize, usize)> {
    let total = total_len as i64;
    let max_chunk = max_chunk as i64;
    let min_speech = min_speech as i64;
    let min_silence = min_silence as i64;
    let pad = pad as i64;
    // Sentinels mirror Python's `chain(segments, ((len,len),(INF,INF)))`: the (total,total) sentinel
    // flushes the last real chunk, the INF sentinel drains it.
    const INF: i64 = i64::MAX / 4;
    let mut chain: Vec<(i64, i64)> = segs.iter().map(|&(s, e)| (s as i64, e as i64)).collect();
    chain.push((total, total));
    chain.push((INF, INF));

    let mut out = Vec::new();
    // Python starts cur at (-INF,-INF); -INF/4 keeps the first real region in the `else` branch.
    let mut cur_start: i64 = -INF;
    let mut cur_end: i64 = -INF;
    for (mut start, end) in chain {
        if start - cur_end < min_silence && end - cur_start < max_chunk {
            cur_end = end;
        } else {
            if cur_end - cur_start > min_speech {
                let s = (cur_start - pad).max(0);
                let e = (cur_end + pad).min(total);
                if s < e {
                    out.push((s as usize, e as usize));
                }
            }
            while end - start > max_chunk {
                let s = (start - pad).max(0);
                let e = (start + max_chunk + pad).min(total);
                if s < e {
                    out.push((s as usize, e as usize));
                }
                start += max_chunk;
            }
            cur_start = start;
            cur_end = end;
        }
    }
    out
}

fn coalesce_short_chunks(
    chunks: Vec<(usize, usize)>,
    max_chunk: usize,
    min_decode_chunk: usize,
) -> Vec<(usize, usize)> {
    if chunks.len() <= 1 {
        return chunks;
    }

    let mut out: Vec<(usize, usize)> = Vec::with_capacity(chunks.len());
    let mut i = 0usize;
    while i < chunks.len() {
        let (s, e) = chunks[i];
        if e.saturating_sub(s) >= min_decode_chunk {
            out.push((s, e));
            i += 1;
            continue;
        }

        if let Some(last) = out.last_mut() {
            if e.saturating_sub(last.0) <= max_chunk {
                last.1 = e;
                i += 1;
                continue;
            }
        }

        if let Some(&(_, next_e)) = chunks.get(i + 1) {
            if next_e.saturating_sub(s) <= max_chunk {
                out.push((s, next_e));
                i += 2;
                continue;
            }
        }

        out.push((s, e));
        i += 1;
    }
    out
}

fn expand_short_chunk(
    start: usize,
    end: usize,
    total_len: usize,
    min_decode_chunk: usize,
) -> (usize, usize) {
    if end.saturating_sub(start) >= min_decode_chunk || total_len <= end.saturating_sub(start) {
        return (start, end);
    }

    let target = min_decode_chunk.min(total_len);
    let center = start + (end.saturating_sub(start) / 2);
    let mut s = center.saturating_sub(target / 2);
    let mut e = (s + target).min(total_len);
    s = e.saturating_sub(target);

    if s > start {
        s = start;
        e = (s + target).min(total_len);
    }
    if e < end {
        e = end;
        s = e.saturating_sub(target);
    }
    (s, e)
}

fn compact_silences(audio: &[f32], segs: &[(usize, usize)], max_silence: usize) -> Vec<f32> {
    if segs.is_empty() {
        return audio.to_vec();
    }

    let mut out = Vec::with_capacity(
        audio.len().min(
            segs.iter()
                .map(|(s, e)| e.saturating_sub(*s))
                .sum::<usize>()
                + (segs.len() + 1) * max_silence,
        ),
    );

    let (first_start, first_end) = segs[0];
    let leading = first_start.min(max_silence);
    out.extend_from_slice(&audio[first_start - leading..first_end]);
    let mut prev_end = first_end;

    for &(start, end) in segs.iter().skip(1) {
        if start <= prev_end {
            if end > prev_end {
                out.extend_from_slice(&audio[prev_end..end]);
                prev_end = end;
            }
            continue;
        }

        let gap = start - prev_end;
        if gap <= max_silence {
            out.extend_from_slice(&audio[prev_end..end]);
        } else {
            let after_prev = max_silence / 2;
            let before_next = max_silence - after_prev;
            out.extend_from_slice(&audio[prev_end..prev_end + after_prev]);
            out.extend_from_slice(&audio[start - before_next..end]);
        }
        prev_end = end;
    }

    let trailing_end = (prev_end + max_silence).min(audio.len());
    if trailing_end > prev_end {
        out.extend_from_slice(&audio[prev_end..trailing_end]);
    }

    out
}

fn compact_silences_for_segments<'a>(audio: &'a [f32], segs: &[(usize, usize)]) -> Cow<'a, [f32]> {
    if segs.is_empty() {
        return Cow::Borrowed(audio);
    }
    let compacted = compact_silences(audio, segs, MAX_RETAINED_SILENCE);
    if compacted.len() < audio.len() {
        Cow::Owned(compacted)
    } else {
        Cow::Borrowed(audio)
    }
}

/// Remove long non-speech gaps before transcription.
///
/// This keeps up to 200 ms of natural silence around speech runs. Local final
/// decode uses the same primitive before chunking; cloud STT uses it before
/// upload so pause-heavy recordings send less audio and ask the provider to
/// process less duration.
pub fn compact_for_transcription<'a>(audio: &'a [f32], vad: &mut SileroVad) -> Cow<'a, [f32]> {
    let mask = speech_mask(vad, audio);
    let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
    compact_silences_for_segments(audio, &raw)
}

/// Last `n` chars of `s` (char-safe), for the optional Whisper prior-chunk continuation prompt.
fn tail_chars(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        chars[chars.len() - n..].iter().collect()
    }
}

/// Decode an arbitrarily long recording by VAD-segmenting it into ≤ `max_chunk_s` chunks and
/// decoding each independently through `engine`, then joining. For audio already short enough
/// (`<= max_chunk_s`), this is a single `engine.transcribe` — i.e. ZERO behavior change for normal
/// PTT dictation; it only engages on long recordings.
///
/// `prior_prompt` (Whisper-only — gated on `supports_initial_prompt`) seeds each chunk after the
/// first with the tail of the previous chunk's text via the `<|startofprev|>` slot for continuity.
/// Pass `false` to decode every chunk independently (whisperX/onnx-asr default; preserves the
/// user's configured initial-prompt and avoids prior-text hallucination on near-silent chunks).
pub fn vad_segment_decode(
    engine: &mut dyn Transcriber,
    audio: &[f32],
    max_chunk_s: f32,
    prior_prompt: bool,
    vad: &mut SileroVad,
    opts: &TranscribeOptions,
) -> super::SttResult<String> {
    let max_chunk = (max_chunk_s * SR as f32) as usize;

    // 1. Per-frame speech mask (30 ms / 480-sample Silero frames). Per-chunk
    // tracing goes to `log::debug!` (`[vad-segment] …`) — gate it via the log level.
    let mask = speech_mask(vad, audio);
    let raw_original = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());

    // The offline segmenter can score an all-silent buffer as zero chunks even though the upstream
    // RMS gate passed — fall back to a single pass so we still produce output.
    if raw_original.is_empty() {
        return engine.transcribe(audio, opts).map(|t| t.text);
    }

    let compacted = compact_silences(audio, &raw_original, MAX_RETAINED_SILENCE);
    log::debug!(
        "[vad-segment] compacted {:.2}s -> {:.2}s (max_silence=200ms)",
        audio.len() as f32 / SR as f32,
        compacted.len() as f32 / SR as f32
    );
    if compacted.len() <= max_chunk {
        return engine.transcribe(&compacted, opts).map(|t| t.text);
    }

    // 2. Raw regions → merged chunks (onnx-asr constants @ 16 kHz).
    let pad = SR * 30 / 1000; // 480
    let min_speech = (SR * 250 / 1000).saturating_sub(2 * pad); // 3040
                                                                // PACK-TO-CAP: onnx-asr's 100 ms min_silence splits on every thinking-pause, and since
                                                                // `compact_silences` already caps every retained gap at 200 ms, ~every pause in spontaneous
                                                                // dictation exceeds it → dozens of 1–2 s chunks. Short chunks are exactly where Whisper (and
                                                                // the fragile lite-whisper low-rank encoder especially) hallucinate "..." walls and repeat
                                                                // text. whisperX instead packs speech into fixed near-window chunks; we do the same by merging
                                                                // across any pause and letting ONLY the max-chunk cap force a split (on a real region boundary).
                                                                // This hands the decoder long, coherent context — the configuration that transcribes cleanly.
    let min_silence = max_chunk;
    let compacted_mask = speech_mask(vad, &compacted);
    let raw = find_segments(&compacted_mask, VAD_FRAME_SAMPLES, compacted.len());
    // Cap so a +pad on each side keeps the emitted chunk ≤ max_chunk (under the engine window).
    let merged = merge_segments(
        &raw,
        compacted.len(),
        max_chunk.saturating_sub(2 * pad),
        min_speech,
        min_silence,
        pad,
    );
    let merged_len = merged.len();
    let merged = coalesce_short_chunks(merged, max_chunk, MIN_DECODE_CHUNK);
    log::debug!(
        "[vad-segment] raw={} merged={} coalesced={}",
        raw.len(),
        merged_len,
        merged.len()
    );

    if merged.is_empty() {
        return engine.transcribe(&compacted, opts).map(|t| t.text);
    }

    // 3. Decode each chunk independently; optional Whisper prior-chunk prompt.
    let track_prev = prior_prompt && engine.kind().supports_initial_prompt();
    let mut prev = String::new();
    let mut parts: Vec<String> = Vec::with_capacity(merged.len());
    for (idx, (s, e)) in merged.into_iter().enumerate() {
        let (s, e) = if e.saturating_sub(s) < MIN_DECODE_CHUNK {
            let expanded = expand_short_chunk(s, e, compacted.len(), MIN_DECODE_CHUNK);
            log::debug!(
                "[vad-segment] chunk {} expanded: {:.2}s..{:.2}s -> {:.2}s..{:.2}s",
                idx + 1,
                s as f32 / SR as f32,
                e as f32 / SR as f32,
                expanded.0 as f32 / SR as f32,
                expanded.1 as f32 / SR as f32
            );
            expanded
        } else {
            (s, e)
        };
        log::debug!(
            "[vad-segment] chunk {}: {:.2}s..{:.2}s ({:.2}s)",
            idx + 1,
            s as f32 / SR as f32,
            e as f32 / SR as f32,
            (e - s) as f32 / SR as f32
        );
        let mut o = opts.clone();
        if track_prev && !prev.trim().is_empty() {
            o.initial_prompt_text = Some(tail_chars(&prev, 200));
        }
        let txt = engine
            .transcribe(&compacted[s..e], &o)
            .map_err(|err| {
                log::warn!(
                    "[vad-segment] chunk {} failed at {:.2}s..{:.2}s: {err}",
                    idx + 1,
                    s as f32 / SR as f32,
                    e as f32 / SR as f32
                );
                err
            })?
            .text
            .trim()
            .to_string();
        log::debug!("[vad-segment] chunk {} text_len={}", idx + 1, txt.len());
        if !txt.is_empty() {
            if track_prev {
                prev = txt.clone();
            }
            parts.push(txt);
        }
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_segments_runs() {
        // frame=10; mask: speech 1-3, silence, speech 5-6, trailing-open 8..
        let mask = [
            false, true, true, true, false, true, true, false, true, true,
        ];
        let segs = find_segments(&mask, 10, 100);
        assert_eq!(segs, vec![(10, 40), (50, 70), (80, 100)]);
    }

    #[test]
    fn find_segments_all_silence() {
        assert_eq!(find_segments(&[false, false, false], 10, 30), Vec::new());
    }

    #[test]
    fn merge_absorbs_small_gap_and_cuts_big() {
        // Two regions 100ms apart (gap < min_silence=2560) → merged into one chunk.
        let segs = [(0usize, 5000usize), (6000, 11000)];
        let merged = merge_segments(&segs, 11000, 16_000 * 28, 3040, 2560, 480);
        assert_eq!(merged.len(), 1);
        let (s, e) = merged[0];
        assert!(s == 0 && e == 11000, "got ({s},{e})");
    }

    #[test]
    fn merge_splits_on_real_silence() {
        // Two regions separated by a 1 s silence (> min_silence) → two chunks.
        let segs = [(0usize, 8000usize), (24000, 32000)];
        let merged = merge_segments(&segs, 32000, 16_000 * 28, 3040, 2560, 480);
        assert_eq!(merged.len(), 2);
        assert!(merged[0].1 <= 24000 && merged[1].0 >= 8000);
    }

    #[test]
    fn merge_drops_tiny_blip() {
        // A 100 ms blip (< min_speech=3040) followed by long silence → dropped.
        let segs = [(0usize, 1600usize)];
        let merged = merge_segments(&segs, 200_000, 16_000 * 28, 3040, 2560, 480);
        assert!(merged.is_empty());
    }

    #[test]
    fn merge_packs_to_cap_when_min_silence_is_the_cap() {
        // PACK-TO-CAP (the runtime default `min_silence = max_chunk`): regions separated by
        // ordinary thinking-pauses are absorbed into one near-cap chunk instead of splitting on
        // every pause — the fix for lite-whisper hallucinating on dozens of tiny fragments.
        let cap = 16_000 * 28;
        let segs = [
            (0usize, 4000usize),
            (8000, 12000), // ~250 ms gaps — would split under the old 160 ms min_silence
            (16000, 20000),
            (24000, 28000),
        ];
        let merged = merge_segments(&segs, 28000, cap, 3040, cap, 480);
        assert_eq!(
            merged.len(),
            1,
            "all sub-cap speech should pack into one chunk"
        );
        assert!(merged[0].1 - merged[0].0 <= cap + 2 * 480);
    }

    #[test]
    fn merge_hard_splits_continuous_speech_over_cap() {
        // One 60 s continuous-speech region, cap 28 s → forced sub-splits, none exceeding the cap.
        let cap = 16_000 * 28;
        let segs = [(0usize, 16_000 * 60)];
        let merged = merge_segments(&segs, 16_000 * 60, cap, 3040, 2560, 480);
        assert!(merged.len() >= 2);
        for (s, e) in &merged {
            assert!(e - s <= cap + 2 * 480, "chunk {}..{} exceeds cap", s, e);
        }
    }

    #[test]
    fn coalesce_merges_short_chunk_into_previous() {
        let chunks = vec![(0usize, 10_000usize), (11_000, 12_000), (20_000, 30_000)];
        let merged = coalesce_short_chunks(chunks, 60_000, 4_000);
        assert_eq!(merged, vec![(0, 12_000), (20_000, 30_000)]);
    }

    #[test]
    fn coalesce_merges_leading_short_chunk_into_next() {
        let chunks = vec![(1_000usize, 2_000usize), (5_000, 15_000)];
        let merged = coalesce_short_chunks(chunks, 60_000, 4_000);
        assert_eq!(merged, vec![(1_000, 15_000)]);
    }

    #[test]
    fn expand_short_chunk_adds_context_without_losing_original_span() {
        let (s, e) = expand_short_chunk(10_000, 11_000, 40_000, 8_000);
        assert!(s <= 10_000);
        assert!(e >= 11_000);
        assert_eq!(e - s, 8_000);
    }

    #[test]
    fn compact_silences_caps_long_gap_and_keeps_context() {
        let audio: Vec<f32> = (0..1000).map(|n| n as f32).collect();
        let compacted = compact_silences(&audio, &[(100, 200), (800, 900)], 100);

        assert_eq!(compacted.len(), 500);
        assert_eq!(&compacted[0..100], &audio[0..100]);
        assert_eq!(&compacted[100..200], &audio[100..200]);
        assert_eq!(&compacted[200..250], &audio[200..250]);
        assert_eq!(&compacted[250..300], &audio[750..800]);
        assert_eq!(&compacted[300..400], &audio[800..900]);
        assert_eq!(&compacted[400..500], &audio[900..1000]);
    }

    #[test]
    fn compact_silences_keeps_short_gap_intact() {
        let audio: Vec<f32> = (0..500).map(|n| n as f32).collect();
        let compacted = compact_silences(&audio, &[(100, 200), (250, 300)], 100);

        assert_eq!(compacted, audio[0..400].to_vec());
    }

    #[test]
    fn transcription_compaction_borrows_when_no_speech_segments_are_found() {
        let audio: Vec<f32> = (0..500).map(|n| n as f32).collect();
        let compacted = compact_silences_for_segments(&audio, &[]);

        assert!(matches!(compacted, Cow::Borrowed(_)));
        assert_eq!(compacted.as_ref(), audio.as_slice());
    }

    #[test]
    fn transcription_compaction_removes_long_silence_between_segments() {
        let audio: Vec<f32> = (0..32_000).map(|n| n as f32).collect();
        let compacted = compact_silences_for_segments(&audio, &[(1_600, 3_200), (24_000, 25_600)]);

        assert!(matches!(compacted, Cow::Owned(_)));
        assert!(compacted.len() < audio.len());
    }

    #[test]
    fn tail_chars_is_char_safe() {
        assert_eq!(tail_chars("hello world", 5), "world");
        assert_eq!(tail_chars("hi", 5), "hi");
        assert_eq!(tail_chars("héllo wörld", 5).chars().count(), 5);
    }
}
