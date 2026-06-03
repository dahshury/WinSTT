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

use crate::audio_toolkit::vad::{SileroVad, VoiceActivityDetector, VAD_FRAME_SAMPLES};

use super::{TranscribeOptions, Transcriber};

const SR: usize = 16_000;

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
    if audio.len() <= max_chunk {
        return engine.transcribe(audio, opts).map(|t| t.text);
    }

    // 1. Per-frame speech mask (30 ms / 480-sample Silero frames).
    let mut mask = Vec::with_capacity(audio.len() / VAD_FRAME_SAMPLES + 1);
    let mut i = 0;
    while i + VAD_FRAME_SAMPLES <= audio.len() {
        let speech = vad
            .is_voice(&audio[i..i + VAD_FRAME_SAMPLES])
            .unwrap_or(false);
        mask.push(speech);
        i += VAD_FRAME_SAMPLES;
    }

    // 2. Raw regions → merged chunks (onnx-asr constants @ 16 kHz).
    let pad = SR * 30 / 1000; // 480
    let min_speech = (SR * 250 / 1000).saturating_sub(2 * pad); // 3040
    let min_silence = SR * 100 / 1000 + 2 * pad; // 2560
    let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
    // Cap so a +pad on each side keeps the emitted chunk ≤ max_chunk (under the engine window).
    let merged = merge_segments(
        &raw,
        audio.len(),
        max_chunk.saturating_sub(2 * pad),
        min_speech,
        min_silence,
        pad,
    );

    // The offline segmenter can score an all-silent buffer as zero chunks even though the upstream
    // RMS gate passed — fall back to a single pass so we still produce output.
    if merged.is_empty() {
        return engine.transcribe(audio, opts).map(|t| t.text);
    }

    // 3. Decode each chunk independently; optional Whisper prior-chunk prompt.
    let track_prev = prior_prompt && engine.kind().supports_initial_prompt();
    let mut prev = String::new();
    let mut parts: Vec<String> = Vec::with_capacity(merged.len());
    for (s, e) in merged {
        let mut o = opts.clone();
        if track_prev && !prev.trim().is_empty() {
            o.initial_prompt_text = Some(tail_chars(&prev, 200));
        }
        let txt = engine.transcribe(&audio[s..e], &o)?.text.trim().to_string();
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
    fn tail_chars_is_char_safe() {
        assert_eq!(tail_chars("hello world", 5), "world");
        assert_eq!(tail_chars("hi", 5), "hi");
        assert_eq!(tail_chars("héllo wörld", 5).chars().count(), 5);
    }
}
