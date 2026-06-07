// Source: E:/DL/Projects/onnx-asr/src/onnx_asr/diarization.py
//         docs/archive/port/05_wakeword_diarization_loopback_wordts.md §B
//
// ═════════════════════════════════════════════════════════════════════════════
// 1. Data types — mirror onnx-asr `DiarSegment` / WinSTT `SpeakerSegment`.
//    Plus the private vector helpers (`l2_normalize`, `dot`) shared by the
//    clustering and the AHC distance matrix.
// ═════════════════════════════════════════════════════════════════════════════

/// One contiguous speaker turn: half-open `[start, end)` seconds + global id.
/// `speaker == -1` means "unassigned" (no segment overlapped a word).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    pub speaker: i64,
}

impl SpeakerSegment {
    pub fn new(start: f64, end: f64, speaker: i64) -> Self {
        SpeakerSegment {
            start,
            end,
            speaker,
        }
    }
}

/// One un-clustered diarizer segment carrying its embedding + activity ratio.
/// Produced by the segmentation+embedding stage, consumed by the clustering.
/// Mirrors the `dict` returned by `Diarizer.diarize_with_embeddings`.
#[derive(Debug, Clone)]
pub struct EmbeddedSegment {
    pub start: f64,
    pub end: f64,
    pub embedding: Vec<f32>,
    /// Mean per-frame speech probability over the segment, in `[0, 1]`.
    pub active_ratio: f32,
}

/// One timed word with start/end seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// One timed word tagged with its dominant speaker id (`-1` if none).
#[derive(Debug, Clone, PartialEq)]
pub struct SpeakerWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub speaker: i64,
}

/// L2-normalize a vector with a `1e-12` floor (matches Python `np.linalg.norm`).
pub(super) fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter().map(|x| x / norm).collect()
}

pub(super) fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}
