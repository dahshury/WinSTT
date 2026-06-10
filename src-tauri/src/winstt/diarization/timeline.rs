// Source: server/src/recorder/domain/speaker_timeline.py (Listen mode)
//         <onnx-asr>/src/onnx_asr/diarization.py
//
// ═════════════════════════════════════════════════════════════════════════════
// 5. SpeakerTimeline — session-global absolute-time speaker spans.
//    Port of server/src/recorder/domain/speaker_timeline.py (Listen mode).
// 6. assign_speakers_to_words — overlap-weighted majority vote.
//    Verbatim port of diarization.py:661-708.
// ═════════════════════════════════════════════════════════════════════════════

use super::types::{SpeakerSegment, SpeakerWord, TimedWord};

/// Default retention window (seconds) before old spans are pruned.
pub const DEFAULT_TIMELINE_RETENTION_S: f64 = 600.0;

/// Absolute-time speaker timeline built from rolling diarization windows.
/// `merge` shifts window-relative segments by the window's absolute start.
#[derive(Debug, Clone)]
pub struct SpeakerTimeline {
    segments: Vec<SpeakerSegment>,
    retain_seconds: f64,
}

impl Default for SpeakerTimeline {
    fn default() -> Self {
        SpeakerTimeline {
            segments: Vec::new(),
            retain_seconds: DEFAULT_TIMELINE_RETENTION_S,
        }
    }
}

impl SpeakerTimeline {
    pub fn new(retain_seconds: f64) -> Self {
        SpeakerTimeline {
            segments: Vec::new(),
            retain_seconds,
        }
    }

    /// Merge a window's diarization output into the absolute timeline.
    /// `window_segments` are window-relative (`start`/`end` in `[0, window_len]`);
    /// `window_start_s` is the window's absolute start time. Adjacent same-speaker
    /// spans separated by `< 0.05s` are coalesced; old spans pruned.
    pub fn merge(&mut self, window_segments: &[SpeakerSegment], window_start_s: f64) {
        for seg in window_segments {
            let abs = SpeakerSegment::new(
                seg.start + window_start_s,
                seg.end + window_start_s,
                seg.speaker,
            );
            // Coalesce with the last span if same speaker and (near-)contiguous.
            if let Some(last) = self.segments.last_mut() {
                if last.speaker == abs.speaker && abs.start - last.end < 0.05 {
                    last.end = last.end.max(abs.end);
                    continue;
                }
            }
            self.segments.push(abs);
        }
        self.prune();
    }

    fn prune(&mut self) {
        if self.segments.is_empty() {
            return;
        }
        let latest = self.segments.iter().map(|s| s.end).fold(0.0f64, f64::max);
        let cutoff = latest - self.retain_seconds;
        self.segments.retain(|s| s.end >= cutoff);
    }

    /// The speaker with the most active time inside `[start, end)`, or `None`.
    pub fn dominant_speaker(&self, start: f64, end: f64) -> Option<i64> {
        let mut best_spk: Option<i64> = None;
        let mut best_overlap = 0.0f64;
        // Accumulate overlap per speaker.
        let mut acc: Vec<(i64, f64)> = Vec::new();
        for seg in &self.segments {
            let overlap = (end.min(seg.end) - start.max(seg.start)).max(0.0);
            if overlap <= 0.0 {
                continue;
            }
            if let Some(entry) = acc.iter_mut().find(|(spk, _)| *spk == seg.speaker) {
                entry.1 += overlap;
            } else {
                acc.push((seg.speaker, overlap));
            }
        }
        for (spk, overlap) in acc {
            if overlap > best_overlap {
                best_overlap = overlap;
                best_spk = Some(spk);
            }
        }
        best_spk
    }

    /// All segments overlapping `[start, end)`, time-ordered, clipped to range.
    pub fn segments_in_range(&self, start: f64, end: f64) -> Vec<SpeakerSegment> {
        let mut out: Vec<SpeakerSegment> = self
            .segments
            .iter()
            .filter_map(|s| {
                let lo = s.start.max(start);
                let hi = s.end.min(end);
                if hi > lo {
                    Some(SpeakerSegment::new(lo, hi, s.speaker))
                } else {
                    None
                }
            })
            .collect();
        out.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    /// The most recent `duration_s` of timeline, rebased so its start is `0.0`.
    pub fn recent_segments(&self, duration_s: f64) -> Vec<SpeakerSegment> {
        if self.segments.is_empty() {
            return Vec::new();
        }
        let latest = self.segments.iter().map(|s| s.end).fold(0.0f64, f64::max);
        let lo = latest - duration_s;
        self.segments
            .iter()
            .filter(|s| s.end > lo)
            .map(|s| SpeakerSegment::new((s.start.max(lo)) - lo, s.end - lo, s.speaker))
            .collect()
    }

    pub fn reset(&mut self) {
        self.segments.clear();
    }

    pub fn segments(&self) -> &[SpeakerSegment] {
        &self.segments
    }
}

/// Default smoothing window (seconds) for per-word speaker assignment.
pub const DEFAULT_SMOOTHING_WINDOW_S: f64 = 1.5;

/// Tag each word with the dominant speaker via overlap-weighted majority vote
/// inside `[word_mid - w/2, word_mid + w/2]` (`w = smoothing_window_s`).
/// `smoothing_window_s == 0` falls back to plain per-word overlap. Empty
/// `segments` → all `-1`.
pub fn assign_speakers_to_words(
    words: &[TimedWord],
    segments: &[SpeakerSegment],
    smoothing_window_s: f64,
) -> Vec<SpeakerWord> {
    if segments.is_empty() {
        return words
            .iter()
            .map(|w| SpeakerWord {
                text: w.text.clone(),
                start: w.start,
                end: w.end,
                speaker: -1,
            })
            .collect();
    }

    let half_window = smoothing_window_s.max(0.0) / 2.0;
    let mut out = Vec::with_capacity(words.len());

    for w in words {
        let midpoint = 0.5 * (w.start + w.end);
        let (lo, hi) = if half_window > 0.0 {
            (midpoint - half_window, midpoint + half_window)
        } else {
            (w.start, w.end)
        };

        // Sum overlap per speaker.
        let mut scores: Vec<(i64, f64)> = Vec::new();
        for seg in segments {
            let overlap = (hi.min(seg.end) - lo.max(seg.start)).max(0.0);
            if overlap > 0.0 {
                if let Some(entry) = scores.iter_mut().find(|(spk, _)| *spk == seg.speaker) {
                    entry.1 += overlap;
                } else {
                    scores.push((seg.speaker, overlap));
                }
            }
        }

        let best_spk = if !scores.is_empty() {
            scores
                .iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(spk, _)| *spk)
                .unwrap_or(-1)
        } else {
            // Nothing overlaps the window — nearest segment edge.
            segments
                .iter()
                .min_by(|a, b| {
                    let da = (midpoint - a.start).abs().min((midpoint - a.end).abs());
                    let db = (midpoint - b.start).abs().min((midpoint - b.end).abs());
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|s| s.speaker)
                .unwrap_or(-1)
        };

        out.push(SpeakerWord {
            text: w.text.clone(),
            start: w.start,
            end: w.end,
            speaker: best_spk,
        });
    }
    out
}

/// Merge adjacent same-speaker segments split by `< merge_gap_s` into time-ordered
/// spans. Mirrors `Diarizer._build_output` / `SessionDiarizer.diarize` tail merge.
pub fn merge_adjacent_segments(
    mut triples: Vec<SpeakerSegment>,
    merge_gap_s: f64,
) -> Vec<SpeakerSegment> {
    triples.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut merged: Vec<SpeakerSegment> = Vec::new();
    for seg in triples {
        if let Some(last) = merged.last_mut() {
            if last.speaker == seg.speaker && seg.start - last.end < merge_gap_s {
                last.end = last.end.max(seg.end);
                continue;
            }
        }
        merged.push(seg);
    }
    merged
}
