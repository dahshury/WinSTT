// Source: E:/DL/Projects/onnx-asr/src/onnx_asr/diarization.py
//         docs/port/05_wakeword_diarization_loopback_wordts.md §B
//         server/src/recorder/application/diarization_stream.py + domain/speaker_timeline.py
//         sherpa-onnx 1.13.2 SpeakerEmbeddingExtractor (verified docs.rs 2026-05):
//           SpeakerEmbeddingExtractorConfig { model: Option<String>, num_threads: i32,
//                                             debug: bool, provider: Option<String> }
//           SpeakerEmbeddingExtractor::create(&cfg) -> Option<Self>
//           .create_stream() -> Option<OnlineStream> ; .compute(&stream) -> Option<Vec<f32>>
//           .dim() -> i32 ; .is_ready(&stream) -> bool
//           OnlineStream::accept_waveform(sample_rate: i32, &[f32]) ; .input_finished()
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PORT (not "use sherpa-onnx OfflineSpeakerDiarization directly")
// ─────────────────────────────────────────────────────────────────────────────
// sherpa-onnx ships an OFFLINE AHC diarizer: given a whole clip + a speaker count
// it complete-linkage-clusters segments. That has NO session-stable IDs — re-run
// it on the next utterance and "speaker 0" may be a different person. WinSTT's
// Listen mode + per-utterance diarization need IDs that PERSIST across calls
// (project_listen_diarization_architecture). So we REUSE the heavy ML from
// sherpa-onnx (the wespeaker ResNet34 SpeakerEmbeddingExtractor + the pyannote
// segmentation session) and PORT — to pure Rust arithmetic — the session-stable
// clustering, the activity-interval hysteresis, the SpeakerTimeline, and the
// word→speaker assignment. None of those touch torch/onnx; they are deterministic
// and fully unit-tested here.
//
// COMPILE NOTE: sherpa-onnx is declared UNCONDITIONALLY in Cargo.toml (no `sherpa`
// cargo feature; we may not edit Cargo.toml), so `SherpaEmbedder` compiles
// unconditionally — same convention as the updated wakeword.rs. The deterministic
// arithmetic (clustering / timeline / word-assignment / AHC) never touches the
// FFI and runs its own tests. The SEGMENTATION session (pyannote-3.0 powerset)
// is left behind the `Segmenter` trait and marked `// SPIKE:` where its exact
// sherpa-onnx output shape must be confirmed in the compile loop.

#![allow(dead_code)] // DRAFT: surface defined ahead of all call sites / the manager.

// ═════════════════════════════════════════════════════════════════════════════
// 1. Data types — mirror onnx-asr `DiarSegment` / WinSTT `SpeakerSegment`.
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

// ═════════════════════════════════════════════════════════════════════════════
// 2. OnlineSpeakerClustering — PURE ARITHMETIC port of diart's clustering.
//    State persists across `assign` calls → session-stable global speaker IDs.
//    Verbatim port of diarization.py:40-198.
// ═════════════════════════════════════════════════════════════════════════════

/// Default constants (DiarizationConfig / onnx-asr defaults).
pub const DEFAULT_DELTA_NEW: f32 = 0.5;
pub const DEFAULT_RHO_UPDATE: f32 = 0.3;
pub const DEFAULT_EMA_ALPHA: f32 = 0.5;
/// WinSTT `DiarizationConfig.max_speakers = 8`; onnx-asr default is 20.
pub const DEFAULT_MAX_SPEAKERS: usize = 8;

/// Incremental cosine-distance speaker clustering with persistent centroids.
///
/// Each [`assign`](OnlineSpeakerClustering::assign) takes a batch of new speaker
/// embeddings and matches them against the running set of global centroids:
/// 1. cosine distance to every ACTIVE centroid;
/// 2. if the closest is within `delta_new` → reuse that id (and EMA-update the
///    centroid iff `active_ratio >= rho_update`);
/// 3. else if a slot is free → mint a new centroid;
/// 4. else → forced reuse of the closest (label aliasing — accepted cap).
#[derive(Debug, Clone)]
pub struct OnlineSpeakerClustering {
    delta_new: f32,
    rho_update: f32,
    max_speakers: usize,
    ema_alpha: f32,
    /// `(max_speakers, dim)` lazily allocated on first `assign`.
    centers: Option<Vec<Vec<f32>>>,
    active: Vec<bool>,
}

impl Default for OnlineSpeakerClustering {
    fn default() -> Self {
        Self::new(
            DEFAULT_DELTA_NEW,
            DEFAULT_RHO_UPDATE,
            DEFAULT_MAX_SPEAKERS,
            DEFAULT_EMA_ALPHA,
        )
    }
}

impl OnlineSpeakerClustering {
    pub fn new(delta_new: f32, rho_update: f32, max_speakers: usize, ema_alpha: f32) -> Self {
        OnlineSpeakerClustering {
            delta_new,
            rho_update,
            max_speakers: max_speakers.max(1),
            ema_alpha,
            centers: None,
            active: Vec::new(),
        }
    }

    /// Distinct global speaker IDs created so far this session.
    pub fn num_known_speakers(&self) -> usize {
        self.active.iter().filter(|&&a| a).count()
    }

    /// Centroid slots remaining before hitting `max_speakers`.
    pub fn num_free_slots(&self) -> usize {
        self.max_speakers - self.num_known_speakers()
    }

    /// Drop all centroids — next `assign` starts a fresh session.
    pub fn reset(&mut self) {
        self.centers = None;
        self.active.clear();
    }

    fn ensure_centers(&mut self, embedding_dim: usize) {
        if self.centers.is_none() {
            self.centers = Some(vec![vec![0.0f32; embedding_dim]; self.max_speakers]);
            self.active = vec![false; self.max_speakers];
        }
    }

    /// Place `embedding` into the first free slot, returning its global id.
    /// Caller guarantees a free slot exists.
    fn add_centroid(&mut self, embedding: &[f32]) -> i64 {
        let centers = self.centers.as_mut().expect("centers allocated");
        for (i, active) in self.active.iter_mut().enumerate() {
            if !*active {
                centers[i].clear();
                centers[i].extend_from_slice(embedding);
                *active = true;
                return i as i64;
            }
        }
        // Unreachable when callers respect `num_free_slots`; degrade to slot 0.
        0
    }

    fn update_centroid(&mut self, centroid_id: usize, embedding: &[f32]) {
        let alpha = self.ema_alpha;
        let centers = self.centers.as_mut().expect("centers allocated");
        let c = &mut centers[centroid_id];
        for (slot, &e) in c.iter_mut().zip(embedding.iter()) {
            *slot = alpha * e + (1.0 - alpha) * *slot;
        }
    }

    /// Match new embeddings to global speaker IDs; return per-input IDs.
    ///
    /// `embeddings`: `n` rows of `dim` floats. `active_ratios`: optional `n`-long
    /// speech-fraction per row (default all 1.0). Returns `n` int64 speaker IDs,
    /// stable across calls.
    pub fn assign(&mut self, embeddings: &[Vec<f32>], active_ratios: Option<&[f32]>) -> Vec<i64> {
        let n = embeddings.len();
        if n == 0 {
            return Vec::new();
        }
        let dim = embeddings[0].len();
        if let Some(r) = active_ratios {
            debug_assert_eq!(r.len(), n, "active_ratios length must match embeddings");
        }
        self.ensure_centers(dim);

        let mut labels = vec![0i64; n];
        for (i, emb) in embeddings.iter().enumerate() {
            let ratio = active_ratios.map_or(1.0f32, |r| r[i]);

            if self.num_known_speakers() == 0 {
                labels[i] = if self.num_free_slots() > 0 {
                    self.add_centroid(emb)
                } else {
                    0
                };
                continue;
            }

            // Cosine distance against ACTIVE centroids only.
            let emb_n = l2_normalize(emb);
            let mut closest_global: i64 = -1;
            let mut closest_dist = f32::INFINITY;
            {
                let centers = self.centers.as_ref().expect("centers allocated");
                for (j, &active) in self.active.iter().enumerate() {
                    if !active {
                        continue;
                    }
                    let ctr_n = l2_normalize(&centers[j]);
                    let cos = dot(&ctr_n, &emb_n);
                    let dist = 1.0 - cos;
                    if dist < closest_dist {
                        closest_dist = dist;
                        closest_global = j as i64;
                    }
                }
            }

            if closest_dist <= self.delta_new {
                labels[i] = closest_global;
                if ratio >= self.rho_update {
                    self.update_centroid(closest_global as usize, emb);
                }
            } else if self.num_free_slots() > 0 {
                labels[i] = self.add_centroid(emb);
            } else {
                // No room → forced reuse of closest (label aliasing, accepted).
                labels[i] = closest_global;
            }
        }
        labels
    }
}

/// L2-normalize a vector with a `1e-12` floor (matches Python `np.linalg.norm`).
fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter().map(|x| x / norm).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Offline AHC complete-linkage (the NON-session path). Pure arithmetic.
//    Verbatim port of diarization.py:201-251.
// ═════════════════════════════════════════════════════════════════════════════

/// Pairwise cosine distance after L2 norm; flat row-major `(n, n)` matrix.
pub fn cosine_distance_matrix(embeddings: &[Vec<f32>]) -> Vec<Vec<f32>> {
    let units: Vec<Vec<f32>> = embeddings.iter().map(|e| l2_normalize(e)).collect();
    let n = units.len();
    let mut out = vec![vec![0.0f32; n]; n];
    for i in 0..n {
        for j in 0..n {
            let cos = dot(&units[i], &units[j]);
            out[i][j] = (1.0 - cos).clamp(0.0, 2.0);
        }
    }
    out
}

/// Complete-linkage AHC. Either a fixed `num_clusters` or stop when the next
/// merge would exceed `threshold`. Returns a label per input (0-based, compact).
pub fn ahc_complete_linkage(
    distances: &[Vec<f32>],
    num_clusters: Option<usize>,
    threshold: f32,
) -> Vec<i64> {
    let n = distances.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }

    // members[keep] = list of original indices in that cluster.
    let mut members: Vec<Option<Vec<usize>>> = (0..n).map(|i| Some(vec![i])).collect();
    let mut dm: Vec<Vec<f32>> = distances.to_vec();
    for (i, row) in dm.iter_mut().enumerate() {
        row[i] = f32::INFINITY;
    }

    let mut live = n;
    while live > 1 {
        // argmin over the whole matrix.
        let mut best = f32::INFINITY;
        let (mut bi, mut bj) = (0usize, 0usize);
        for i in 0..n {
            if members[i].is_none() {
                continue;
            }
            for j in 0..n {
                if members[j].is_none() || i == j {
                    continue;
                }
                if dm[i][j] < best {
                    best = dm[i][j];
                    bi = i;
                    bj = j;
                }
            }
        }
        if bi == bj {
            break;
        }
        if num_clusters.is_none() && best > threshold {
            break;
        }
        if let Some(k) = num_clusters {
            if live <= k {
                break;
            }
        }

        let (keep, drop) = if bi < bj { (bi, bj) } else { (bj, bi) };
        let drop_members = members[drop].take().expect("drop cluster live");
        members[keep]
            .as_mut()
            .expect("keep cluster live")
            .extend(drop_members);

        // Complete linkage: new distance = max(keep, drop) per column.
        #[expect(
            clippy::needless_range_loop,
            reason = "indexes multiple rows of dm (keep/drop/c) by c"
        )]
        for c in 0..n {
            let merged = dm[keep][c].max(dm[drop][c]);
            dm[keep][c] = merged;
            dm[c][keep] = merged;
        }
        dm[keep][keep] = f32::INFINITY;
        #[expect(
            clippy::needless_range_loop,
            reason = "indexes multiple rows of dm (drop/c) by c"
        )]
        for c in 0..n {
            dm[drop][c] = f32::INFINITY;
            dm[c][drop] = f32::INFINITY;
        }
        live -= 1;
    }

    // Relabel surviving clusters by ascending keep-index → compact 0-based ids.
    let mut labels = vec![0i64; n];
    let mut survivors: Vec<(usize, &Vec<usize>)> = members
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.as_ref().map(|v| (i, v)))
        .collect();
    survivors.sort_by_key(|(i, _)| *i);
    for (new_id, (_, idxs)) in survivors.into_iter().enumerate() {
        for &idx in idxs {
            labels[idx] = new_id as i64;
        }
    }
    labels
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Activity-interval hysteresis — PURE state machine.
//    Verbatim port of diarization.py:254-294.
// ═════════════════════════════════════════════════════════════════════════════

/// Hysteresis thresholding on a 1-D probability track. Returns half-open
/// `[start_frame, end_frame)` intervals: enter active at `p >= onset`, leave at
/// `p < offset`; merge gaps `< merge_frames`; drop runs `< min_frames`.
pub fn active_intervals(
    probs_one_speaker: &[f32],
    onset: f32,
    offset: f32,
    min_frames: usize,
    merge_frames: usize,
) -> Vec<(usize, usize)> {
    let mut intervals: Vec<(usize, usize)> = Vec::new();
    let n = probs_one_speaker.len();
    let mut state = false;
    let mut start = 0usize;
    for (i, &p) in probs_one_speaker.iter().enumerate() {
        if !state && p >= onset {
            state = true;
            start = i;
        } else if state && p < offset {
            state = false;
            intervals.push((start, i));
        }
    }
    if state {
        intervals.push((start, n));
    }
    if intervals.is_empty() {
        return Vec::new();
    }

    // Merge intervals separated by gaps shorter than `merge_frames`.
    let mut merged: Vec<(usize, usize)> = vec![intervals[0]];
    for &(s, e) in &intervals[1..] {
        let (ps, pe) = *merged.last().expect("non-empty");
        if s - pe < merge_frames {
            *merged.last_mut().expect("non-empty") = (ps, e);
        } else {
            merged.push((s, e));
        }
    }

    // Drop intervals shorter than `min_frames`.
    merged
        .into_iter()
        .filter(|&(s, e)| e - s >= min_frames)
        .collect()
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. SpeakerTimeline — session-global absolute-time speaker spans.
//    Port of server/src/recorder/domain/speaker_timeline.py (Listen mode).
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// 6. assign_speakers_to_words — overlap-weighted majority vote.
//    Verbatim port of diarization.py:661-708.
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// 7. Diarizer config + the segmentation/embedding ORCHESTRATION (FFI).
//    Embedding is real sherpa-onnx wiring; segmentation output shape is `// SPIKE:`.
// ═════════════════════════════════════════════════════════════════════════════

/// Hysteresis + duration thresholds for the segmentation→interval stage.
/// Mirrors `Diarizer.__init__` defaults.
#[derive(Debug, Clone, Copy)]
pub struct DiarizerConfig {
    pub onset: f32,
    pub offset: f32,
    pub min_segment_duration: f64,
    pub merge_gap_duration: f64,
    pub min_embedding_duration: f64,
}

impl Default for DiarizerConfig {
    fn default() -> Self {
        DiarizerConfig {
            onset: 0.5,
            offset: 0.35,
            min_segment_duration: 0.5,
            merge_gap_duration: 0.3,
            min_embedding_duration: 0.5,
        }
    }
}

pub const DIARIZER_SAMPLE_RATE: u32 = 16_000;

/// Per-frame, per-local-speaker probabilities from the segmentation model.
/// Row-major `num_frames × num_local_speakers`, plus the frame step in samples.
pub struct SegmentationOutput {
    /// `probs[frame][local_speaker]`.
    pub probs: Vec<Vec<f32>>,
    pub num_local_speakers: usize,
    /// Audio samples advanced per frame (`frame_to_sec = frame_step / 16000`).
    pub frame_step: usize,
}

/// The segmentation model (pyannote-segmentation-3.0 powerset). The concrete
/// session is FFI; this trait isolates it so the interval→embed→cluster pipeline
/// is testable with a fake.
pub trait Segmenter: Send {
    /// Run segmentation on a 16 kHz mono waveform → per-frame powerset probs.
    fn speaker_probs(&mut self, waveform: &[f32], sample_rate: u32) -> Option<SegmentationOutput>;
}

/// Speaker-embedding extractor (wespeaker ResNet34 → 256-d). FFI behind a trait
/// so clustering is testable; the real impl is `SherpaEmbedder` below.
pub trait Embedder: Send {
    /// Compute one embedding for a 16 kHz mono crop. `None` on failure.
    fn embed(&mut self, crop: &[f32], sample_rate: u32) -> Option<Vec<f32>>;
}

/// Stateless single-utterance diarizer: segmentation → activity intervals →
/// per-interval embeddings. Clustering is applied by the caller
/// (`SessionDiarizer` for session-stable IDs; AHC for the offline path).
pub struct Diarizer<S: Segmenter, E: Embedder> {
    seg: S,
    emb: E,
    cfg: DiarizerConfig,
}

impl<S: Segmenter, E: Embedder> Diarizer<S, E> {
    pub fn new(seg: S, emb: E, cfg: DiarizerConfig) -> Self {
        Diarizer { seg, emb, cfg }
    }

    /// Segmentation → activity intervals → embeddings, WITHOUT clustering.
    /// Mirrors `Diarizer.diarize_with_embeddings`.
    pub fn diarize_with_embeddings(
        &mut self,
        waveform: &[f32],
        sample_rate: u32,
    ) -> Vec<EmbeddedSegment> {
        if sample_rate != DIARIZER_SAMPLE_RATE || waveform.is_empty() {
            return Vec::new();
        }
        let seg = match self.seg.speaker_probs(waveform, sample_rate) {
            Some(s) if !s.probs.is_empty() => s,
            _ => return Vec::new(),
        };

        let frame_step = seg.frame_step.max(1);
        let frame_to_sec = frame_step as f64 / DIARIZER_SAMPLE_RATE as f64;
        let min_frames = (self.cfg.min_segment_duration / frame_to_sec).max(1.0) as usize;
        let merge_frames = (self.cfg.merge_gap_duration / frame_to_sec).max(1.0) as usize;
        let min_emb_frames = (self.cfg.min_embedding_duration / frame_to_sec).max(1.0) as usize;

        // (local_id, start_f, end_f) candidate intervals long enough to embed.
        let mut segments: Vec<(usize, usize, usize)> = Vec::new();
        for local_id in 0..seg.num_local_speakers {
            // Column-extract the local speaker's probability track.
            let track: Vec<f32> = seg.probs.iter().map(|row| row[local_id]).collect();
            for (s, e) in active_intervals(
                &track,
                self.cfg.onset,
                self.cfg.offset,
                min_frames,
                merge_frames,
            ) {
                if e - s >= min_emb_frames {
                    segments.push((local_id, s, e));
                }
            }
        }
        if segments.is_empty() {
            return Vec::new();
        }

        let mut out = Vec::with_capacity(segments.len());
        for (local, s, e) in segments {
            let start_s = (s * frame_step).min(waveform.len());
            let end_s = (e * frame_step).min(waveform.len());
            if end_s <= start_s {
                continue;
            }
            let crop = &waveform[start_s..end_s];
            let embedding = match self.emb.embed(crop, DIARIZER_SAMPLE_RATE) {
                Some(v) => v,
                None => continue,
            };
            // Mean per-frame probability over the interval = active_ratio.
            let span = (e - s).max(1) as f32;
            let active_ratio = seg.probs[s..e].iter().map(|row| row[local]).sum::<f32>() / span;
            out.push(EmbeddedSegment {
                start: s as f64 * frame_to_sec,
                end: e as f64 * frame_to_sec,
                embedding,
                active_ratio,
            });
        }
        out
    }

    /// Offline diarization with cosine AHC (NO session-stable IDs).
    /// Mirrors `Diarizer.diarize`.
    pub fn diarize(
        &mut self,
        waveform: &[f32],
        sample_rate: u32,
        num_speakers: Option<usize>,
        threshold: f32,
    ) -> Vec<SpeakerSegment> {
        let embedded = self.diarize_with_embeddings(waveform, sample_rate);
        if embedded.is_empty() {
            return Vec::new();
        }
        let embeddings: Vec<Vec<f32>> = embedded.iter().map(|s| s.embedding.clone()).collect();
        let distances = cosine_distance_matrix(&embeddings);
        let labels = ahc_complete_linkage(&distances, num_speakers, threshold);
        let triples: Vec<SpeakerSegment> = embedded
            .iter()
            .enumerate()
            .map(|(i, s)| SpeakerSegment::new(s.start, s.end, labels[i]))
            .collect();
        merge_adjacent_segments(triples, 0.05)
    }
}

/// Per-utterance diarizer with SESSION-stable identity. Wraps a [`Diarizer`] and
/// a persistent [`OnlineSpeakerClustering`]. Mirrors `SessionDiarizer`.
pub struct SessionDiarizer<S: Segmenter, E: Embedder> {
    diarizer: Diarizer<S, E>,
    clustering: OnlineSpeakerClustering,
}

impl<S: Segmenter, E: Embedder> SessionDiarizer<S, E> {
    pub fn new(diarizer: Diarizer<S, E>, clustering: OnlineSpeakerClustering) -> Self {
        SessionDiarizer {
            diarizer,
            clustering,
        }
    }

    pub fn reset(&mut self) {
        self.clustering.reset();
    }

    pub fn num_known_speakers(&self) -> usize {
        self.clustering.num_known_speakers()
    }

    /// Diarize one utterance; speaker IDs persist across calls.
    pub fn diarize(&mut self, waveform: &[f32], sample_rate: u32) -> Vec<SpeakerSegment> {
        let local = self.diarizer.diarize_with_embeddings(waveform, sample_rate);
        if local.is_empty() {
            return Vec::new();
        }
        let embeddings: Vec<Vec<f32>> = local.iter().map(|s| s.embedding.clone()).collect();
        let ratios: Vec<f32> = local.iter().map(|s| s.active_ratio).collect();
        let global_ids = self.clustering.assign(&embeddings, Some(&ratios));
        let triples: Vec<SpeakerSegment> = local
            .iter()
            .enumerate()
            .map(|(i, s)| SpeakerSegment::new(s.start, s.end, global_ids[i]))
            .collect();
        merge_adjacent_segments(triples, 0.05)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Real sherpa-onnx embedder (FFI). Gated behind `feature = "sherpa"`.
// ═════════════════════════════════════════════════════════════════════════════

/// Config for the wespeaker speaker-embedding session.
#[derive(Debug, Clone)]
pub struct EmbedderConfig {
    /// Path to the wespeaker ResNet34 ONNX (e.g. wespeaker-voxceleb-resnet34-LM).
    pub model: std::path::PathBuf,
    pub num_threads: i32,
    /// `"cpu"` / `"directml"`. Embedding is small; CPU is the safe default.
    pub provider: String,
    pub debug: bool,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        EmbedderConfig {
            model: std::path::PathBuf::new(),
            num_threads: 1,
            provider: "cpu".to_string(),
            debug: false,
        }
    }
}

/// Real wespeaker speaker-embedding extractor on sherpa-onnx 1.13.2.
///
/// COMPILE NOTE: like `wakeword.rs`, sherpa-onnx is declared UNCONDITIONALLY in
/// Cargo.toml (no `sherpa` cargo feature, and we may not edit Cargo.toml), so the
/// FFI compiles unconditionally. The pure clustering/timeline logic above never
/// touches the FFI and keeps its own tests.
pub struct SherpaEmbedder {
    extractor: sherpa_onnx::SpeakerEmbeddingExtractor,
}

impl SherpaEmbedder {
    pub fn new(cfg: &EmbedderConfig) -> anyhow::Result<Self> {
        let model = cfg
            .model
            .to_str()
            .ok_or_else(|| {
                anyhow::anyhow!("embedding model path not UTF-8: {}", cfg.model.display())
            })?
            .to_string();
        let sherpa_cfg = sherpa_onnx::SpeakerEmbeddingExtractorConfig {
            model: Some(model),
            num_threads: cfg.num_threads.max(1),
            debug: cfg.debug,
            provider: Some(cfg.provider.clone()),
        };
        let extractor = sherpa_onnx::SpeakerEmbeddingExtractor::create(&sherpa_cfg)
            .ok_or_else(|| anyhow::anyhow!("failed to create sherpa SpeakerEmbeddingExtractor"))?;
        Ok(SherpaEmbedder { extractor })
    }

    pub fn dim(&self) -> i32 {
        self.extractor.dim()
    }
}

impl Embedder for SherpaEmbedder {
    fn embed(&mut self, crop: &[f32], sample_rate: u32) -> Option<Vec<f32>> {
        // sherpa flow: create_stream → accept_waveform → input_finished → compute.
        let stream = self.extractor.create_stream()?;
        stream.accept_waveform(sample_rate as i32, crop);
        stream.input_finished();
        if !self.extractor.is_ready(&stream) {
            // Fail-soft: too-short crop → no embedding (mirrors _safe_diarize).
            return None;
        }
        self.extractor.compute(&stream)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Tests — the PURE arithmetic surface (no ML / no FFI).
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn emb(v: &[f32]) -> Vec<f32> {
        v.to_vec()
    }

    // ── OnlineSpeakerClustering: session stability ──────────────────────────

    #[test]
    fn assign_reuses_same_id_for_identical_embedding() {
        let mut c = OnlineSpeakerClustering::default();
        let a = emb(&[1.0, 0.0, 0.0]);
        let id1 = c.assign(std::slice::from_ref(&a), None)[0];
        // Re-feed the SAME embedding across a later call → same id (session stable).
        let id2 = c.assign(std::slice::from_ref(&a), None)[0];
        assert_eq!(id1, id2);
        assert_eq!(c.num_known_speakers(), 1);
    }

    #[test]
    fn assign_near_duplicate_reuses_far_mints_new() {
        let mut c = OnlineSpeakerClustering::new(0.5, 0.3, 8, 0.5);
        let a = emb(&[1.0, 0.0]);
        let near = emb(&[0.99, 0.01]); // cos≈1 → dist≈0 < delta_new
        let far = emb(&[0.0, 1.0]); // orthogonal → dist=1 > delta_new
        let id_a = c.assign(&[a], None)[0];
        let id_near = c.assign(&[near], None)[0];
        let id_far = c.assign(&[far], None)[0];
        assert_eq!(id_a, id_near, "near duplicate reuses centroid");
        assert_ne!(id_a, id_far, "far embedding mints a new id");
        assert_eq!(c.num_known_speakers(), 2);
    }

    #[test]
    fn assign_forces_reuse_when_max_speakers_reached() {
        let mut c = OnlineSpeakerClustering::new(0.5, 0.3, 1, 0.5);
        let a = emb(&[1.0, 0.0]);
        let far = emb(&[0.0, 1.0]);
        let id_a = c.assign(&[a], None)[0];
        // max_speakers=1 → far cannot mint; forced reuse of the only centroid.
        let id_far = c.assign(&[far], None)[0];
        assert_eq!(id_a, id_far);
        assert_eq!(c.num_known_speakers(), 1);
    }

    #[test]
    fn low_ratio_assigns_but_does_not_move_centroid() {
        let mut c = OnlineSpeakerClustering::new(0.5, 0.3, 8, 0.5);
        let a = emb(&[1.0, 0.0]);
        c.assign(std::slice::from_ref(&a), Some(&[1.0]));
        let centroid_before = c.centers.as_ref().unwrap()[0].clone();
        // A drifting embedding within delta_new but below rho_update → no update.
        let drift = emb(&[0.9, 0.1]);
        c.assign(&[drift], Some(&[0.1])); // ratio 0.1 < rho_update 0.3
        let centroid_after = c.centers.as_ref().unwrap()[0].clone();
        assert_eq!(
            centroid_before, centroid_after,
            "low ratio must not move centroid"
        );
    }

    #[test]
    fn high_ratio_moves_centroid() {
        let mut c = OnlineSpeakerClustering::new(0.5, 0.3, 8, 0.5);
        c.assign(&[emb(&[1.0, 0.0])], Some(&[1.0]));
        let before = c.centers.as_ref().unwrap()[0].clone();
        c.assign(&[emb(&[0.8, 0.2])], Some(&[1.0])); // ratio 1.0 >= rho_update
        let after = c.centers.as_ref().unwrap()[0].clone();
        assert_ne!(before, after, "high ratio EMA-updates the centroid");
    }

    #[test]
    fn assign_empty_returns_empty() {
        let mut c = OnlineSpeakerClustering::default();
        assert!(c.assign(&[], None).is_empty());
    }

    // ── active_intervals hysteresis ─────────────────────────────────────────

    #[test]
    fn active_intervals_basic_hysteresis() {
        // p crosses onset at idx 2, drops below offset at idx 6.
        let probs = [0.0, 0.1, 0.6, 0.7, 0.5, 0.4, 0.1, 0.0];
        // onset 0.5, offset 0.35 → active [2,6). min_frames 1, merge 1.
        let iv = active_intervals(&probs, 0.5, 0.35, 1, 1);
        assert_eq!(iv, vec![(2, 6)]);
    }

    #[test]
    fn active_intervals_open_run_to_end() {
        let probs = [0.0, 0.6, 0.6, 0.6];
        let iv = active_intervals(&probs, 0.5, 0.35, 1, 1);
        assert_eq!(iv, vec![(1, 4)]);
    }

    #[test]
    fn active_intervals_drops_short_runs() {
        // A single-frame run (len 1) dropped when min_frames=2.
        let probs = [0.0, 0.6, 0.0, 0.0];
        let iv = active_intervals(&probs, 0.5, 0.35, 2, 1);
        assert!(iv.is_empty());
    }

    #[test]
    fn active_intervals_merges_short_gaps() {
        // Two runs [1,2) and [3,4) with a 1-frame gap merge at merge_frames=2.
        let probs = [0.0, 0.6, 0.0, 0.6, 0.0];
        let iv = active_intervals(&probs, 0.5, 0.35, 1, 2);
        assert_eq!(iv, vec![(1, 4)]);
    }

    // ── AHC complete linkage ────────────────────────────────────────────────

    #[test]
    fn ahc_single_point() {
        let d = cosine_distance_matrix(&[emb(&[1.0, 0.0])]);
        assert_eq!(ahc_complete_linkage(&d, None, 0.7), vec![0]);
    }

    #[test]
    fn ahc_two_tight_one_far() {
        // Two near-identical vectors + one orthogonal → [0,0,1].
        let pts = vec![emb(&[1.0, 0.0]), emb(&[0.99, 0.01]), emb(&[0.0, 1.0])];
        let d = cosine_distance_matrix(&pts);
        let labels = ahc_complete_linkage(&d, None, 0.5);
        assert_eq!(labels[0], labels[1], "tight pair shares a cluster");
        assert_ne!(labels[0], labels[2], "far point is its own cluster");
    }

    #[test]
    fn ahc_fixed_num_clusters_overrides_threshold() {
        // Three distinct points, force exactly 2 clusters regardless of threshold.
        let pts = vec![emb(&[1.0, 0.0]), emb(&[0.0, 1.0]), emb(&[0.9, 0.1])];
        let d = cosine_distance_matrix(&pts);
        let labels = ahc_complete_linkage(&d, Some(2), 0.0);
        let distinct: std::collections::BTreeSet<i64> = labels.iter().copied().collect();
        assert_eq!(distinct.len(), 2);
    }

    // ── SpeakerTimeline ─────────────────────────────────────────────────────

    #[test]
    fn timeline_shifts_window_relative_to_absolute() {
        let mut tl = SpeakerTimeline::default();
        // A window starting at absolute 10s with a relative [0,1] speaker-0 span.
        tl.merge(&[SpeakerSegment::new(0.0, 1.0, 0)], 10.0);
        let segs = tl.segments();
        assert_eq!(segs.len(), 1);
        assert!((segs[0].start - 10.0).abs() < 1e-9);
        assert!((segs[0].end - 11.0).abs() < 1e-9);
    }

    #[test]
    fn timeline_dominant_speaker_picks_max_overlap() {
        let mut tl = SpeakerTimeline::default();
        tl.merge(
            &[
                SpeakerSegment::new(0.0, 1.0, 0),
                SpeakerSegment::new(1.0, 5.0, 1),
            ],
            0.0,
        );
        // [0.5, 4.0): speaker 0 contributes 0.5s, speaker 1 contributes 3.0s.
        assert_eq!(tl.dominant_speaker(0.5, 4.0), Some(1));
    }

    #[test]
    fn timeline_prunes_old_spans() {
        let mut tl = SpeakerTimeline::new(600.0);
        tl.merge(&[SpeakerSegment::new(0.0, 1.0, 0)], 0.0);
        // A span far in the future pushes the cutoff past the old span.
        tl.merge(&[SpeakerSegment::new(0.0, 1.0, 1)], 1000.0);
        // Old [0,1] span is > 600s before latest (1001) → pruned.
        assert!(tl.segments().iter().all(|s| s.end >= 1001.0 - 600.0));
    }

    #[test]
    fn timeline_recent_segments_rebased_to_zero() {
        let mut tl = SpeakerTimeline::default();
        tl.merge(&[SpeakerSegment::new(0.0, 2.0, 0)], 100.0); // abs [100,102]
        let recent = tl.recent_segments(5.0);
        assert_eq!(recent.len(), 1);
        // latest=102, lo=97; span rebased so end = 102-97 = 5.
        assert!((recent[0].end - 5.0).abs() < 1e-9);
    }

    // ── assign_speakers_to_words ────────────────────────────────────────────

    #[test]
    fn words_get_speaker_of_containing_segment() {
        let words = vec![TimedWord {
            text: "hi".into(),
            start: 1.2,
            end: 1.4,
        }];
        let segs = vec![SpeakerSegment::new(1.0, 2.0, 1)];
        // No smoothing → plain overlap; midpoint 1.3 inside speaker 1.
        let out = assign_speakers_to_words(&words, &segs, 0.0);
        assert_eq!(out[0].speaker, 1);
    }

    #[test]
    fn smoothing_resolves_boundary_straddle_by_total_overlap() {
        // Word centered on a boundary; smoothing window leans toward the speaker
        // with more total overlap.
        let words = vec![TimedWord {
            text: "x".into(),
            start: 1.9,
            end: 2.1,
        }];
        let segs = vec![
            SpeakerSegment::new(0.0, 2.0, 0),
            SpeakerSegment::new(2.0, 10.0, 1), // far more coverage in window
        ];
        let out = assign_speakers_to_words(&words, &segs, 1.5);
        assert_eq!(out[0].speaker, 1);
    }

    #[test]
    fn empty_segments_yield_minus_one() {
        let words = vec![TimedWord {
            text: "a".into(),
            start: 0.0,
            end: 0.1,
        }];
        let out = assign_speakers_to_words(&words, &[], 1.5);
        assert_eq!(out[0].speaker, -1);
    }

    #[test]
    fn word_outside_all_segments_falls_back_to_nearest_edge() {
        let words = vec![TimedWord {
            text: "a".into(),
            start: 50.0,
            end: 50.1,
        }];
        let segs = vec![SpeakerSegment::new(0.0, 1.0, 7)];
        // No overlap anywhere → nearest segment edge wins (speaker 7).
        let out = assign_speakers_to_words(&words, &segs, 0.0);
        assert_eq!(out[0].speaker, 7);
    }

    // ── Diarizer / SessionDiarizer with FAKE seg + emb (no ML) ──────────────

    struct FakeSegmenter;
    impl Segmenter for FakeSegmenter {
        fn speaker_probs(&mut self, _waveform: &[f32], _sr: u32) -> Option<SegmentationOutput> {
            // 10 frames, 2 local speakers; speaker 0 active frames 0..5,
            // speaker 1 active frames 5..10. frame_step 1600 → 0.1s/frame.
            let mut probs = vec![vec![0.0f32; 2]; 10];
            for frame in probs.iter_mut().take(5) {
                frame[0] = 0.9;
            }
            for frame in probs.iter_mut().take(10).skip(5) {
                frame[1] = 0.9;
            }
            Some(SegmentationOutput {
                probs,
                num_local_speakers: 2,
                frame_step: 1600,
            })
        }
    }

    /// Embedder that returns a fixed vector per local-speaker region (orthogonal),
    /// so two regions cluster into two stable global ids.
    struct FakeEmbedder;
    impl Embedder for FakeEmbedder {
        fn embed(&mut self, crop: &[f32], _sr: u32) -> Option<Vec<f32>> {
            // Discriminate by the crop's first sample sign (test fixture marks it).
            if !crop.is_empty() && crop[0] > 0.0 {
                Some(vec![1.0, 0.0])
            } else {
                Some(vec![0.0, 1.0])
            }
        }
    }

    #[test]
    fn session_diarizer_produces_stable_ids_across_calls() {
        // Build a waveform: frames 0..5 region marked +1.0, 5..10 marked -1.0.
        let mut wav = vec![0.0f32; 10 * 1600];
        for sample in wav.iter_mut().take(5 * 1600) {
            *sample = 1.0;
        }
        for sample in wav.iter_mut().take(10 * 1600).skip(5 * 1600) {
            *sample = -1.0;
        }
        let diar = Diarizer::new(FakeSegmenter, FakeEmbedder, DiarizerConfig::default());
        let mut session = SessionDiarizer::new(diar, OnlineSpeakerClustering::default());
        let first = session.diarize(&wav, 16_000);
        assert_eq!(first.len(), 2, "two speakers segmented");
        assert_eq!(session.num_known_speakers(), 2);
        // Second call on the same audio reuses the same global ids.
        let second = session.diarize(&wav, 16_000);
        assert_eq!(session.num_known_speakers(), 2, "no new speakers minted");
        let ids_first: std::collections::BTreeSet<i64> = first.iter().map(|s| s.speaker).collect();
        let ids_second: std::collections::BTreeSet<i64> =
            second.iter().map(|s| s.speaker).collect();
        assert_eq!(ids_first, ids_second);
    }

    #[test]
    fn offline_diarize_two_speakers() {
        let mut wav = vec![0.0f32; 10 * 1600];
        for sample in wav.iter_mut().take(5 * 1600) {
            *sample = 1.0;
        }
        for sample in wav.iter_mut().take(10 * 1600).skip(5 * 1600) {
            *sample = -1.0;
        }
        let mut diar = Diarizer::new(FakeSegmenter, FakeEmbedder, DiarizerConfig::default());
        let out = diar.diarize(&wav, 16_000, None, 0.7);
        let distinct: std::collections::BTreeSet<i64> = out.iter().map(|s| s.speaker).collect();
        assert_eq!(distinct.len(), 2);
    }

    #[test]
    fn merge_adjacent_coalesces_same_speaker() {
        let segs = vec![
            SpeakerSegment::new(0.0, 1.0, 0),
            SpeakerSegment::new(1.02, 2.0, 0), // 0.02s gap < 0.05 → merge
            SpeakerSegment::new(2.0, 3.0, 1),
        ];
        let merged = merge_adjacent_segments(segs, 0.05);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0], SpeakerSegment::new(0.0, 2.0, 0));
    }
}
