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
use std::time::Instant;

use crate::audio_toolkit::vad::{SileroVad, VAD_FRAME_SAMPLES, VoiceActivityDetector};

use super::{TranscribeOptions, Transcriber, WordResult};

const SR: usize = 16_000;
const MAX_RETAINED_SILENCE: usize = SR * 200 / 1000;
const MIN_DECODE_CHUNK: usize = SR * 750 / 1000;
pub const VAD_COMPACT_MIN_S: f32 = 5.0;

/// Audio overlap given to each cap-forced (continuous-speech) hard split so the decoder re-hears the
/// words straddling the cut on BOTH sides; `merge_word_overlap` then strips the duplicate. 0.5 s is
/// long enough to cover a word or two at normal speech rate without materially inflating decode cost.
const HARD_SPLIT_OVERLAP: usize = SR / 2;
/// Window before a cap-forced cut position searched for the quietest 30 ms frame to split on, so the
/// seam lands in a natural pause instead of mid-word. ~2 s — long enough to contain a between-word
/// gap in fast continuous speech without letting the seam drift far from the cap.
const HARD_SPLIT_SEARCH_BACK: usize = SR * 2;

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

        if let Some(last) = out.last_mut()
            && e.saturating_sub(last.0) <= max_chunk
        {
            last.1 = e;
            i += 1;
            continue;
        }

        if let Some(&(_, next_e)) = chunks.get(i + 1)
            && next_e.saturating_sub(s) <= max_chunk
        {
            out.push((s, next_e));
            i += 2;
            continue;
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

/// Map a capture-layer per-480-sample-frame speech mask onto the frame grid `find_segments` walks.
///
/// The capture mask (`CapturedAudio`, built in the audio pipeline) uses the SAME 480-sample frame
/// as [`speech_mask`], so it aligns 1:1 with the full-frame grid this module scans. It may be a few
/// frames SHORT — a trailing partial capture frame (< 480 samples) produces no mask bit — so any
/// full frame past the mask's end inherits the LAST known mask value (`false` if the mask is empty).
/// Frames beyond the mask on the audio side are otherwise indistinguishable from held speech/silence,
/// and inheriting the tail value keeps a word that runs into the final partial frame from being cut.
fn capture_mask_frames(audio_len: usize, capture_mask: &[bool]) -> Vec<bool> {
    let frames = audio_len / VAD_FRAME_SAMPLES;
    let last = capture_mask.last().copied().unwrap_or(false);
    (0..frames)
        .map(|fi| capture_mask.get(fi).copied().unwrap_or(last))
        .collect()
}

/// Per-frame speech mask for `audio`: use the supplied capture mask (skipping the Silero sweep
/// entirely) when present, else run Silero. Both produce a `bool` per full 480-sample frame, so the
/// downstream [`find_segments`] / [`compact_silences`] machinery is identical either way.
fn frame_mask(audio: &[f32], capture_mask: Option<&[bool]>, vad: &mut SileroVad) -> Vec<bool> {
    match capture_mask {
        Some(m) => capture_mask_frames(audio.len(), m),
        None => speech_mask(vad, audio),
    }
}

/// Remove long non-speech gaps before transcription, using a supplied capture mask when available.
///
/// When `capture_mask` is `Some`, the capture layer's per-frame speech mask drives compaction and
/// the Silero sweep is SKIPPED (`vad` is then unused). When `None`, this falls back to Silero — so
/// `compact_for_transcription` (below) is a thin wrapper. Keeps up to 200 ms of natural silence
/// around speech runs. Used by the single-pass path for short mic clips too (every mic clip carrying
/// a mask is compacted before decode), and by cloud STT before upload.
pub fn compact_for_transcription_with_mask<'a>(
    audio: &'a [f32],
    capture_mask: Option<&[bool]>,
    vad: &mut SileroVad,
) -> Cow<'a, [f32]> {
    let mask = frame_mask(audio, capture_mask, vad);
    let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
    compact_silences_for_segments(audio, &raw)
}

/// Remove long non-speech gaps before transcription (Silero-driven).
///
/// This keeps up to 200 ms of natural silence around speech runs. Local final
/// decode uses the same primitive before chunking; cloud STT uses it before
/// upload so pause-heavy recordings send less audio and ask the provider to
/// process less duration. Thin wrapper over [`compact_for_transcription_with_mask`] with no capture
/// mask (kept so existing call sites compile while the integration agent threads the mask through).
pub fn compact_for_transcription<'a>(audio: &'a [f32], vad: &mut SileroVad) -> Cow<'a, [f32]> {
    compact_for_transcription_with_mask(audio, None, vad)
}

/// Mask-only silence compaction — no Silero VAD needed (the capture mask fully determines the frame
/// grid). Used by the single-pass mic path and cloud upload, where a capture mask is always present,
/// so a short mic clip's (now ungated) captured silence is cut without paying a Silero session build.
/// Keeps up to 200 ms of natural silence around speech runs, identical to the Silero-driven path.
pub fn compact_for_transcription_mask<'a>(
    audio: &'a [f32],
    capture_mask: &[bool],
) -> Cow<'a, [f32]> {
    let mask = capture_mask_frames(audio.len(), capture_mask);
    let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
    compact_silences_for_segments(audio, &raw)
}

/// DC-immune RMS energy of one frame: subtract the frame mean (kills any constant offset a
/// resampler / codec can leave) before squaring, so a quiet-but-DC-biased frame still reads as low
/// energy. Empty → 0.
fn frame_rms_dc_immune(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let n = frame.len() as f32;
    let mean = frame.iter().sum::<f32>() / n;
    let ss: f32 = frame
        .iter()
        .map(|&x| {
            let d = x - mean;
            d * d
        })
        .sum();
    (ss / n).sqrt()
}

/// START sample of the minimum-DC-immune-RMS `frame`-aligned window within `[lo, hi)`. Used to move a
/// cap-forced cut off a word onto the quietest nearby frame. Frames are stepped from `lo`; if no full
/// frame fits (`hi - lo < frame`), returns `lo`. On an energy tie the EARLIEST frame wins (keeps the
/// left chunk shorter, never over cap).
fn best_split_point(audio: &[f32], lo: usize, hi: usize, frame: usize) -> usize {
    let hi = hi.min(audio.len());
    let mut best = lo;
    let mut best_energy = f32::INFINITY;
    let mut s = lo;
    while s + frame <= hi {
        let energy = frame_rms_dc_immune(&audio[s..s + frame]);
        if energy < best_energy {
            best_energy = energy;
            best = s;
        }
        s += frame;
    }
    best
}

/// Post-pass over merged chunk boundaries that refines each cap-FORCED split and gives it an audio
/// overlap. A forced split is detected purely by geometry: only a hard split leaves neighbors that
/// OVERLAP (`next.start < cur.end`); a real silence boundary always leaves a gap. For each such pair
/// the shared boundary is moved to the quietest 30 ms frame in the ~`search_back` before the cut,
/// the left chunk is extended `overlap` past it, and the right chunk starts AT it — so the seam is
/// re-heard on both sides (deduped later) with no audio lost. Both refined chunks stay ≤ `max_chunk`
/// by construction (search upper bound is clamped to keep the left ≤ cap; the right can only shrink).
///
/// Returns `(refined_chunks, hard_before)` where `hard_before[i]` marks that the join ENTERING chunk
/// `i` is a hard split (its text join must dedupe) rather than a silence boundary (plain space join).
fn refine_hard_splits(
    mut chunks: Vec<(usize, usize)>,
    audio: &[f32],
    max_chunk: usize,
    overlap: usize,
    search_back: usize,
) -> (Vec<(usize, usize)>, Vec<bool>) {
    let n = chunks.len();
    let mut hard_before = vec![false; n];
    for i in 0..n.saturating_sub(1) {
        let (ls, le) = chunks[i];
        let (_rs, re) = chunks[i + 1];
        // Silence boundary (gap) → leave the plain join untouched.
        if chunks[i + 1].0 >= le {
            continue;
        }
        // Keep `b + overlap` within the cap: cap the search at `ls + max_chunk - overlap` (upper) and
        // no earlier than `re - max_chunk` (lower) so the right chunk, which starts at `b`, also stays
        // ≤ cap even when `b` moves before the original overlap region.
        let hi = le
            .min(ls + max_chunk.saturating_sub(overlap))
            .min(audio.len());
        let lo = le
            .saturating_sub(search_back)
            .max(re.saturating_sub(max_chunk))
            .min(hi);
        let b = if hi > lo {
            best_split_point(audio, lo, hi, VAD_FRAME_SAMPLES)
        } else {
            lo
        };
        let new_le = (b + overlap).min(ls + max_chunk).min(audio.len());
        // Guarantee a non-empty, ordered left chunk even in degenerate tiny-region cases.
        chunks[i].1 = new_le.max(ls + 1).min(re);
        chunks[i + 1].0 = b.min(re.saturating_sub(1)).max(ls);
        hard_before[i + 1] = true;
    }
    (chunks, hard_before)
}

/// ASCII-punctuation-and-case-insensitive comparison key for one word (drops leading/trailing ASCII
/// punctuation, lowercases). `"World,"` and `"world"` compare equal; interior punctuation is kept.
fn word_key(w: &str) -> String {
    w.trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase()
}

/// Merge two decoded texts from an OVERLAPPING hard-split pair by dropping the duplicated words.
///
/// Finds the LONGEST word-level overlap where a suffix of `left` equals a prefix of `right` under
/// [`word_key`] (case/punctuation-insensitive), emits `left`'s rendering of the shared words, and
/// drops that many words from the front of `right`. No overlap → a plain space join (also the safe
/// result when a chunk decoded empty and the pair is no longer truly adjacent). Full containment (all
/// of `right` is a suffix of `left`) collapses to just `left`. Either side empty → the other side.
fn merge_word_overlap(left: &str, right: &str) -> String {
    let lw: Vec<&str> = left.split_whitespace().collect();
    let rw: Vec<&str> = right.split_whitespace().collect();
    if lw.is_empty() {
        return right.trim().to_string();
    }
    if rw.is_empty() {
        return left.trim().to_string();
    }

    let lk: Vec<String> = lw.iter().map(|w| word_key(w)).collect();
    let rk: Vec<String> = rw.iter().map(|w| word_key(w)).collect();

    let max_k = lw.len().min(rw.len());
    let mut overlap = 0usize;
    for k in (1..=max_k).rev() {
        // Compare the last `k` keys of left against the first `k` keys of right, skipping any that
        // key to empty (pure-punctuation tokens) so they can't spuriously match.
        if lk[lw.len() - k..]
            .iter()
            .zip(&rk[..k])
            .all(|(a, b)| a == b && !a.is_empty())
        {
            overlap = k;
            break;
        }
    }

    let mut out: Vec<&str> = lw;
    out.extend_from_slice(&rw[overlap..]);
    out.join(" ")
}

/// Last `n` chars of `s` (char-safe), for the optional Whisper prior-chunk continuation prompt.
fn tail_chars(s: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }

    let mut seen = 0usize;
    for (idx, _) in s.char_indices().rev() {
        seen += 1;
        if seen == n {
            return s[idx..].to_string();
        }
    }
    s.to_string()
}

/// Decode an arbitrarily long recording by VAD-segmenting it into ≤ `max_chunk_s` chunks and
/// decoding each independently through `engine`, then joining. Thin wrapper over
/// [`vad_segment_decode_with_mask`] with no capture mask (kept so existing call sites compile while
/// the integration agent threads the capture mask through).
pub fn vad_segment_decode(
    engine: &mut dyn Transcriber,
    audio: &[f32],
    max_chunk_s: f32,
    prior_prompt: bool,
    vad: &mut SileroVad,
    opts: &TranscribeOptions,
    request_id: &str,
) -> super::SttResult<String> {
    vad_segment_decode_with_mask(
        engine,
        audio,
        None,
        max_chunk_s,
        prior_prompt,
        vad,
        opts,
        request_id,
    )
}

/// Decode an arbitrarily long recording by VAD-segmenting it into ≤ `max_chunk_s` chunks and
/// decoding each independently through `engine`, then joining. For audio already short enough
/// (`<= max_chunk_s`), this is a single `engine.transcribe` — i.e. ZERO behavior change for normal
/// PTT dictation; it only engages on long recordings.
///
/// `capture_mask`, when `Some`, is the capture layer's per-480-sample-frame speech mask; it drives
/// the FIRST silence-compaction sweep instead of a Silero pass (identical framing, mapped 1:1). The
/// second sweep, on the already-compacted audio, is always Silero (the capture mask doesn't align to
/// compacted samples).
///
/// A continuous-speech region longer than the cap is hard-split on the quietest nearby frame (not
/// mid-word) with a small audio overlap; the two chunks' texts are then merged by dropping the
/// duplicated words at the seam (`merge_word_overlap`). Silence-boundary joins keep the plain space
/// join.
///
/// `prior_prompt` (Whisper-only — gated on `supports_initial_prompt`) seeds each chunk after the
/// first with the tail of the previous chunk's text via the `<|startofprev|>` slot for continuity.
/// Pass `false` to decode every chunk independently (whisperX/onnx-asr default; preserves the
/// user's configured initial-prompt and avoids prior-text hallucination on near-silent chunks).
#[expect(
    clippy::too_many_arguments,
    reason = "one-shot long-form decode entry; the capture mask is an added parameter alongside the \
              existing engine/audio/cap/prompt/vad/opts/request-id set, all load-bearing"
)]
pub fn vad_segment_decode_with_mask(
    engine: &mut dyn Transcriber,
    audio: &[f32],
    capture_mask: Option<&[bool]>,
    max_chunk_s: f32,
    prior_prompt: bool,
    vad: &mut SileroVad,
    opts: &TranscribeOptions,
    request_id: &str,
) -> super::SttResult<String> {
    let max_chunk = (max_chunk_s * SR as f32) as usize;

    // 1. Per-frame speech mask (30 ms / 480-sample frames). The capture mask, when supplied, skips
    // this Silero sweep. Per-chunk tracing goes to `log::debug!` (`[vad-segment] …`).
    log::debug!(
        "[stt][{request_id}][vad-segment] speech_mask_start audio_ms={} max_chunk_ms={} capture_mask={}",
        audio.len() * 1000 / SR,
        max_chunk * 1000 / SR,
        capture_mask.is_some()
    );
    let mask_started = Instant::now();
    let mask = frame_mask(audio, capture_mask, vad);
    log::debug!(
        "[stt][{request_id}][vad-segment] speech_mask_complete duration_ms={} frames={}",
        mask_started.elapsed().as_millis(),
        mask.len()
    );
    let raw_original = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());

    // The offline segmenter can score an all-silent buffer as zero chunks even though the upstream
    // RMS gate passed — fall back to a single pass so we still produce output.
    if raw_original.is_empty() {
        log::debug!(
            "[stt][{request_id}][vad-segment] no_speech_segments_single_pass_start audio_ms={}",
            audio.len() * 1000 / SR
        );
        let started = Instant::now();
        let result = engine.transcribe(audio, opts).map(|t| t.text);
        if let Ok(text) = &result {
            log::debug!(
                "[stt][{request_id}][vad-segment] no_speech_segments_single_pass_complete duration_ms={} output_chars={}",
                started.elapsed().as_millis(),
                text.chars().count()
            );
        }
        return result;
    }

    let compacted = compact_silences(audio, &raw_original, MAX_RETAINED_SILENCE);
    log::debug!(
        "[stt][{request_id}][vad-segment] compacted audio_ms={} compacted_audio_ms={} raw_segments={} max_silence_ms=200",
        audio.len() * 1000 / SR,
        compacted.len() * 1000 / SR,
        raw_original.len()
    );
    if compacted.len() <= max_chunk {
        log::debug!(
            "[stt][{request_id}][vad-segment] compacted_single_pass_start audio_ms={}",
            compacted.len() * 1000 / SR
        );
        let started = Instant::now();
        let result = engine.transcribe(&compacted, opts).map(|t| t.text);
        if let Ok(text) = &result {
            log::debug!(
                "[stt][{request_id}][vad-segment] compacted_single_pass_complete duration_ms={} output_chars={}",
                started.elapsed().as_millis(),
                text.chars().count()
            );
        }
        return result;
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
    log::debug!(
        "[stt][{request_id}][vad-segment] compacted_speech_mask_start compacted_audio_ms={}",
        compacted.len() * 1000 / SR
    );
    let compacted_mask_started = Instant::now();
    let compacted_mask = speech_mask(vad, &compacted);
    log::debug!(
        "[stt][{request_id}][vad-segment] compacted_speech_mask_complete duration_ms={} frames={}",
        compacted_mask_started.elapsed().as_millis(),
        compacted_mask.len()
    );
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
    // Refine each cap-forced split onto the quietest nearby frame and give it an audio overlap; the
    // returned `hard_before` flags which joins must dedupe (vs silence joins that stay plain).
    let (merged, hard_before) = refine_hard_splits(
        merged,
        &compacted,
        max_chunk,
        HARD_SPLIT_OVERLAP,
        HARD_SPLIT_SEARCH_BACK,
    );
    let hard_splits = hard_before.iter().filter(|h| **h).count();
    log::debug!(
        "[stt][{request_id}][vad-segment] chunks_prepared raw={} merged={} coalesced={} hard_splits={}",
        raw.len(),
        merged_len,
        merged.len(),
        hard_splits
    );

    if merged.is_empty() {
        log::debug!(
            "[stt][{request_id}][vad-segment] empty_chunks_single_pass_start compacted_audio_ms={}",
            compacted.len() * 1000 / SR
        );
        let started = Instant::now();
        let result = engine.transcribe(&compacted, opts).map(|t| t.text);
        if let Ok(text) = &result {
            log::debug!(
                "[stt][{request_id}][vad-segment] empty_chunks_single_pass_complete duration_ms={} output_chars={}",
                started.elapsed().as_millis(),
                text.chars().count()
            );
        }
        return result;
    }

    // 3. Decode each chunk independently; optional Whisper prior-chunk prompt.
    let track_prev = prior_prompt && engine.kind().supports_initial_prompt();
    let mut prev = String::new();
    // Assembled output. Hard-split (overlapping) joins dedupe the seam words; silence joins keep the
    // plain space join. Built incrementally so an empty middle chunk can't desync the join flags.
    let mut acc = String::new();
    let mut emitted = false;
    let total_chunks = merged.len();
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
        log::debug!(
            "[stt][{request_id}][vad-segment] chunk_start index={} total={} start_ms={} end_ms={} duration_ms={}",
            idx + 1,
            total_chunks,
            s * 1000 / SR,
            e * 1000 / SR,
            (e - s) * 1000 / SR
        );
        let mut o = opts.clone();
        if track_prev && !prev.trim().is_empty() {
            o.initial_prompt_text = Some(tail_chars(&prev, 200));
        }
        let chunk_started = Instant::now();
        let txt = engine
            .transcribe(&compacted[s..e], &o)
            .map_err(|err| {
                log::warn!(
                    "[stt][{request_id}][vad-segment] chunk_failed index={} start_ms={} end_ms={} error={err}",
                    idx + 1,
                    s * 1000 / SR,
                    e * 1000 / SR
                );
                err
            })?
            .text
            .trim()
            .to_string();
        log::debug!(
            "[stt][{request_id}][vad-segment] chunk_complete index={} total={} elapsed_ms={} text_chars={}",
            idx + 1,
            total_chunks,
            chunk_started.elapsed().as_millis(),
            txt.chars().count()
        );
        log::debug!("[vad-segment] chunk {} text_len={}", idx + 1, txt.len());
        if !txt.is_empty() {
            if track_prev {
                prev = txt.clone();
            }
            if !emitted {
                acc = txt;
                emitted = true;
            } else if hard_before.get(idx).copied().unwrap_or(false) {
                // Overlapping hard-split seam: drop the words re-heard on both sides.
                acc = merge_word_overlap(&acc, &txt);
            } else {
                acc.push(' ');
                acc.push_str(&txt);
            }
        }
    }
    Ok(acc)
}

/// Per-word timings for an arbitrarily long recording, in the ORIGINAL audio timeline.
///
/// The history karaoke highlight plays back the saved WAV, so the returned start/end seconds must
/// index that exact waveform. Whisper truncates every decode to a 30 s mel window (`mel.rs`
/// `audio.len().min(N_SAMPLES)`), so aligning a >30 s clip in one shot leaves every word past 30 s
/// with NO timing and the highlight stalls on the last word it timed. This reuses the same
/// Silero-VAD chunker as [`vad_segment_decode`] — cut on silence into `<= max_chunk_s` chunks — but
/// decodes each chunk WITH word timestamps and offsets the per-word times by the chunk's start, so
/// the union of chunks spans the whole recording.
///
/// Unlike the decode path it deliberately does NOT compact silences: compaction removes samples and
/// would warp the timeline the WAV is played on, so the highlight would drift. Gaps therefore count
/// toward the chunk cap here — a chunk is still `<= max_chunk_s`, which is all Whisper's window
/// needs.
///
/// Short clips (`<= max_chunk_s`) take a single `engine.transcribe` — byte-identical to the old
/// one-shot aligner path, so the common short history clip is completely unchanged.
pub fn vad_segment_align_words(
    engine: &mut dyn Transcriber,
    audio: &[f32],
    max_chunk_s: f32,
    vad: &mut SileroVad,
    opts: &TranscribeOptions,
) -> super::SttResult<Vec<WordResult>> {
    let max_chunk = (max_chunk_s * SR as f32) as usize;
    // Short enough for one Whisper window → single pass (unchanged aligner behavior).
    if audio.len() <= max_chunk {
        return Ok(engine.transcribe(audio, opts)?.words.unwrap_or_default());
    }

    // Chunk plan on the ORIGINAL timeline (no compaction → the emitted times stay in WAV time).
    let mask = speech_mask(vad, audio);
    let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
    if raw.is_empty() {
        // Offline segmenter found no speech though the clip is long — decode once so we still
        // return the first-window words rather than nothing.
        return Ok(engine.transcribe(audio, opts)?.words.unwrap_or_default());
    }

    let pad = SR * 30 / 1000; // 480
    let min_speech = (SR * 250 / 1000).saturating_sub(2 * pad); // 3040
    // PACK-TO-CAP (same rationale as `vad_segment_decode`): merge across every thinking-pause and
    // let ONLY the max-chunk cap force a split, so each chunk hands the aligner long coherent
    // context on a real region boundary.
    let min_silence = max_chunk;
    let merged = merge_segments(
        &raw,
        audio.len(),
        max_chunk.saturating_sub(2 * pad),
        min_speech,
        min_silence,
        pad,
    );
    let merged = coalesce_short_chunks(merged, max_chunk, MIN_DECODE_CHUNK);
    if merged.is_empty() {
        return Ok(engine.transcribe(audio, opts)?.words.unwrap_or_default());
    }

    // Decode each chunk with word timestamps; shift each chunk's words into the original timeline
    // by the chunk's start offset. Concatenation is naturally ordered (chunk starts ascend); the
    // downstream `map_timings_to_text` monotonic clamp absorbs any small overlap from short-chunk
    // expansion.
    let mut out: Vec<WordResult> = Vec::new();
    for (s, e) in merged {
        let (s, e) = if e.saturating_sub(s) < MIN_DECODE_CHUNK {
            expand_short_chunk(s, e, audio.len(), MIN_DECODE_CHUNK)
        } else {
            (s, e)
        };
        let offset = s as f32 / SR as f32;
        let words = engine
            .transcribe(&audio[s..e], opts)?
            .words
            .unwrap_or_default();
        out.extend(words.into_iter().map(|mut w| {
            w.start += offset;
            w.end += offset;
            w
        }));
    }
    Ok(out)
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
        assert_eq!(tail_chars("hello world", 0), "");
        assert_eq!(tail_chars("hello world", 5), "world");
        assert_eq!(tail_chars("hi", 5), "hi");
        assert_eq!(tail_chars("héllo wörld", 5).chars().count(), 5);
    }

    // ---- capture-mask mapping ----
    #[test]
    fn capture_mask_maps_one_to_one_to_frame_grid() {
        // A hand mask with exactly `audio_len / frame` entries maps back to itself → the capture
        // path feeds `find_segments` the identical mask a Silero sweep would.
        let audio_len = 10 * VAD_FRAME_SAMPLES;
        let mask = vec![
            false, true, true, false, false, true, true, true, false, true,
        ];
        assert_eq!(capture_mask_frames(audio_len, &mask), mask);
    }

    #[test]
    fn capture_mask_inherits_last_value_for_missing_tail_frames() {
        // Audio has 6 full frames but the capture mask is 2 frames short (a trailing partial
        // capture frame produced no bit) → the missing tail frames inherit the last value.
        let audio_len = 6 * VAD_FRAME_SAMPLES;
        assert_eq!(
            capture_mask_frames(audio_len, &[false, true, true, true]),
            vec![false, true, true, true, true, true]
        );
        // Empty mask → all frames default to `false`.
        assert_eq!(capture_mask_frames(audio_len, &[]), vec![false; 6]);
    }

    #[test]
    fn capture_mask_compaction_matches_mask_compaction() {
        // Both the mask path (find_segments on a hand mask standing in for a Silero sweep) and the
        // capture path (map the same mask, then find_segments) must produce identical compacted
        // audio for the same synthetic waveform.
        let audio: Vec<f32> = (0..40 * VAD_FRAME_SAMPLES)
            .map(|n| (n % 7) as f32)
            .collect();
        let mut mask = vec![false; 40];
        mask[2..6].fill(true);
        mask[30..34].fill(true);

        let via_mask = {
            let raw = find_segments(&mask, VAD_FRAME_SAMPLES, audio.len());
            compact_silences_for_segments(&audio, &raw).into_owned()
        };
        let via_capture = {
            let frames = capture_mask_frames(audio.len(), &mask);
            let raw = find_segments(&frames, VAD_FRAME_SAMPLES, audio.len());
            compact_silences_for_segments(&audio, &raw).into_owned()
        };
        assert_eq!(via_mask, via_capture);
        assert!(
            via_capture.len() < audio.len(),
            "the long silence gap must compact"
        );
    }

    #[test]
    fn compact_for_transcription_mask_matches_the_vad_variant_with_a_mask() {
        // The no-VAD mask-only entry point must produce the same compaction as the with-mask path
        // (which ignores the VAD when a mask is present) for the same waveform + mask.
        let audio: Vec<f32> = (0..40 * VAD_FRAME_SAMPLES)
            .map(|n| (n % 5) as f32)
            .collect();
        let mut mask = vec![false; 40];
        mask[3..7].fill(true);
        mask[30..35].fill(true);
        let mask_only = compact_for_transcription_mask(&audio, &mask).into_owned();
        // Equivalent to the manual mask path (no Silero involved).
        let frames = capture_mask_frames(audio.len(), &mask);
        let raw = find_segments(&frames, VAD_FRAME_SAMPLES, audio.len());
        let expected = compact_silences_for_segments(&audio, &raw).into_owned();
        assert_eq!(mask_only, expected);
        assert!(
            mask_only.len() < audio.len(),
            "the silence gap must compact"
        );
    }

    // ---- boundary refinement ----
    #[test]
    fn frame_rms_ignores_dc_offset() {
        // Pure DC → ~0 after mean subtraction; an oscillating frame with the same offset is clearly
        // non-zero. Empty → 0.
        let dc = vec![0.5f32; VAD_FRAME_SAMPLES];
        assert!(frame_rms_dc_immune(&dc) < 1e-6);
        let osc: Vec<f32> = (0..VAD_FRAME_SAMPLES)
            .map(|n| 0.5 + if n % 2 == 0 { 0.1 } else { -0.1 })
            .collect();
        assert!(frame_rms_dc_immune(&osc) > frame_rms_dc_immune(&dc));
        assert_eq!(frame_rms_dc_immune(&[]), 0.0);
    }

    #[test]
    fn best_split_point_picks_low_energy_frame() {
        // Loud oscillating audio (constant frames would read as 0 energy under DC removal) with one
        // silent frame at index 6 → chosen as the split.
        let mut audio: Vec<f32> = (0..10 * VAD_FRAME_SAMPLES)
            .map(|n| if n % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let quiet = 6 * VAD_FRAME_SAMPLES;
        for s in &mut audio[quiet..quiet + VAD_FRAME_SAMPLES] {
            *s = 0.0;
        }
        assert_eq!(
            best_split_point(&audio, 0, audio.len(), VAD_FRAME_SAMPLES),
            quiet
        );
        // Window excluding the quiet frame → earliest in-window frame wins the loud tie.
        assert_eq!(best_split_point(&audio, 0, quiet, VAD_FRAME_SAMPLES), 0);
        // No full frame fits → returns lo.
        assert_eq!(best_split_point(&audio, 100, 200, VAD_FRAME_SAMPLES), 100);
    }

    #[test]
    fn refine_hard_splits_moves_seam_to_quiet_frame_with_overlap() {
        let max_chunk = 30 * VAD_FRAME_SAMPLES;
        let overlap = 2 * VAD_FRAME_SAMPLES;
        let search_back = 8 * VAD_FRAME_SAMPLES;
        let mut audio: Vec<f32> = (0..40 * VAD_FRAME_SAMPLES)
            .map(|n| if n % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let quiet = 16 * VAD_FRAME_SAMPLES;
        for s in &mut audio[quiet..quiet + VAD_FRAME_SAMPLES] {
            *s = 0.0;
        }
        // Two OVERLAPPING chunks (a cap-forced split): left [0, 20F], right [19F, 39F].
        let le = 20 * VAD_FRAME_SAMPLES;
        let rs = 19 * VAD_FRAME_SAMPLES;
        let re = 39 * VAD_FRAME_SAMPLES;
        let (out, hard) = refine_hard_splits(
            vec![(0, le), (rs, re)],
            &audio,
            max_chunk,
            overlap,
            search_back,
        );

        assert_eq!(
            hard,
            vec![false, true],
            "join entering chunk 1 is a hard split"
        );
        assert_eq!(
            out[1].0, quiet,
            "right chunk starts at the quiet split frame"
        );
        assert_eq!(
            out[0].1,
            quiet + overlap,
            "left chunk overlaps past the split"
        );
        assert!(out[0].1 - out[0].0 <= max_chunk, "left within cap");
        assert!(out[1].1 - out[1].0 <= max_chunk, "right within cap");
        assert!(out[0].1 > out[1].0, "seam is re-heard on both sides");
    }

    #[test]
    fn refine_hard_splits_leaves_silence_joins_plain() {
        // Neighbors with a gap (silence boundary) → untouched, no hard-split flag.
        let audio = vec![0.0f32; 40 * VAD_FRAME_SAMPLES];
        let chunks = vec![(0usize, 5_000usize), (12_000, 18_000)];
        let (out, hard) = refine_hard_splits(
            chunks.clone(),
            &audio,
            20 * VAD_FRAME_SAMPLES,
            VAD_FRAME_SAMPLES / 2,
            VAD_FRAME_SAMPLES * 2,
        );
        assert_eq!(out, chunks);
        assert_eq!(hard, vec![false, false]);
    }

    // ---- word-overlap dedupe ----
    #[test]
    fn merge_word_overlap_drops_duplicated_seam() {
        assert_eq!(
            merge_word_overlap(
                "the quick brown fox jumps",
                "brown fox jumps over the lazy dog"
            ),
            "the quick brown fox jumps over the lazy dog"
        );
    }

    #[test]
    fn merge_word_overlap_case_and_punctuation_insensitive() {
        // Seam differs only in case/punctuation; the LEFT rendering is emitted.
        assert_eq!(
            merge_word_overlap("we go to the Store,", "store the shelves"),
            "we go to the Store, the shelves"
        );
    }

    #[test]
    fn merge_word_overlap_full_containment_and_no_overlap() {
        // Right fully contained in left's suffix → collapses to left.
        assert_eq!(
            merge_word_overlap("alpha beta gamma", "beta gamma"),
            "alpha beta gamma"
        );
        // No overlap → plain space join.
        assert_eq!(
            merge_word_overlap("alpha beta", "gamma delta"),
            "alpha beta gamma delta"
        );
        // Empty sides → the other side.
        assert_eq!(merge_word_overlap("", "gamma"), "gamma");
        assert_eq!(merge_word_overlap("alpha", ""), "alpha");
    }
}
