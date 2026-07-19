// Cascade diarization engine — Rust port of the diarization playground's
// `examples/diarization-playground/js/engines/cascade.js`, specialized to the
// WhoSpeaksLive clustering backend (the configuration that cleared every autotest
// gate on the reference material: 2 speakers, consistency ≈ 0.90, boundary F1 ≈ 0.55).
//
// Pipeline per hop (SPEC §3–§5, §8 of the playground):
//   1. pyannote segmentation-3.0 (powerset) on the raw 4 s window → 7-class logits;
//   2. powerset softmax decode → per-local-speaker continuous score + per-frame conf;
//   3. two-threshold hysteresis (onset 0.5 / offset 0.35) → local turns;
//   4. per local turn ≥ 0.5 s: overlap-aware soft-masked fbank span → per-utterance
//      CMN → WeSpeaker ResNet34 embedding → L2 norm → turn-chain EMA;
//   5. SpeakerMemoryLive.assign_turn → global speaker id; merged timeline with
//      pyannote-style min_duration_off bridging.
//
// Sessions are pinned to CPU: both models are small (~6 MB seg + ~26 MB embedding),
// well under realtime on CPU, and the DirectML matrix has burned every non-validated
// model family before (memory: project_stt_per_engine_dml_matrix) — the diarizer must
// never destabilize the STT engine sharing the GPU.

use ndarray::Array3;
use ort::session::Session;
use ort::value::Tensor;

use super::fbank::{self, Fbank, apply_cmn};
use super::memory::{SpeakerMemoryConfig, SpeakerMemoryLive, cosine_sim, l2_normalize_in_place};

const SR: usize = 16_000;

// pyannote seg-3.0 constants (SPEC §3.1–§3.3).
const SEG_CLASSES: usize = 7;
const FRAME_STEP_SEC: f64 = 270.0 / 16_000.0; // 0.016875
/// Powerset table: class → 3-bit local-speaker membership.
const POWERSET: [[f32; 3]; SEG_CLASSES] = [
    [0.0, 0.0, 0.0], // {}
    [1.0, 0.0, 0.0], // {0}
    [0.0, 1.0, 0.0], // {1}
    [0.0, 0.0, 1.0], // {2}
    [1.0, 1.0, 0.0], // {0,1}
    [1.0, 0.0, 1.0], // {0,2}
    [0.0, 1.0, 1.0], // {1,2}
];
const NUM_LOCAL: usize = 3;

// Playground defaults (cascade.js paramsSchema) — EXCEPT the hop: the playground
// ships 0.75 s, but label latency is bounded below by the hop (a turn becomes
// visible only when a window covering enough of the new voice completes), so we
// spend CPU headroom on more windows. 0.5 s halves the latency tail at ~2× compute
// (measured release RTF ≈ 0.3); 0.25 s was tried and ran RTF 0.55–0.77 under
// load — too close to falling behind the live stream on a busy machine.
const WINDOW_SEC: f64 = 4.0;
const HOP_SEC: f64 = 0.5;
const ONSET: f32 = 0.5;
const OFFSET: f32 = 0.35;
const MIN_TURN_SEC: f64 = 0.5;
const MIN_GAP_OFF: f64 = 0.75;
const POOL_GAMMA: f32 = 3.0;
const POOL_BETA: f32 = 10.0;
const TURN_EMA_ALPHA: f32 = 0.5;
/// Minimum cosine similarity for a local slot's turn-chain EMA to continue.
/// pyannote's per-window local slot ORDER is not identity-stable: after a speaker
/// turn, the same slot can carry the OTHER voice in the next window, and blindly
/// EMA-ing across that smears two speakers into one embedding (mis-clustering
/// both). CMN'd WeSpeaker same-speaker sims run ≳0.5, cross-speaker ≲0.3, so 0.35
/// keeps genuine chains and severs cross-speaker slot handoffs.
const CHAIN_MIN_SIM: f32 = 0.35;
/// Max silence between a local slot's consecutive turn-unions for its chain EMA to
/// continue. A CONSTANT — the playground derived this as `2×hop`, but at fast hops
/// that shrank to 0.5 s, severing chains at every breath pause; the resulting
/// unsmoothed embeddings spawned a phantom third profile on the 2-speaker E2E clip.
/// 1.5 s = the original 2×0.75 s tolerance the accuracy gates were validated at.
const CHAIN_MAX_GAP_SEC: f64 = 1.5;

// Timeline coalescing (cascade.js drain contract).
const COALESCE_GAP: f64 = 0.05;
const DROP_SLIVER: f64 = 0.15;

/// Ring keeps the largest window + margin (cascade.js `_maxRingSec`).
const MAX_RING_SEC: f64 = 8.0;
/// Timeline entries older than this (behind the session end) are pruned; caption
/// spans only ever query the recent past.
const TIMELINE_KEEP_SEC: f64 = 300.0;

/// One merged, labeled span of the session timeline.
#[derive(Clone, Debug)]
pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    /// Global speaker id (0-based, stable) or -1 for unknown activity.
    pub speaker: i32,
}

// ---------------------------------------------------------------------------
// Audio ring — packed rolling buffer anchored to the session clock.
// ---------------------------------------------------------------------------

/// Rolling 16 kHz buffer whose sample index maps exactly to session time
/// (`ring_start_sec + i/SR`). Gaps vs the expected continuation are zero-filled
/// so dropped audio reads as silence instead of shifting later samples in time.
struct AudioRing {
    ring: Vec<f32>,
    ring_start_sec: f64,
    session_end: f64,
    anchored: bool,
}

impl AudioRing {
    fn new() -> Self {
        Self {
            ring: Vec::new(),
            ring_start_sec: 0.0,
            session_end: 0.0,
            anchored: false,
        }
    }

    fn clear(&mut self) {
        self.ring.clear();
        self.ring_start_sec = 0.0;
        self.session_end = 0.0;
        self.anchored = false;
    }

    /// Ingest a chunk covering `[abs_time_sec, abs_time_sec + len/SR)`. Returns the
    /// anchor time when this chunk was the first of the session.
    fn accept(&mut self, chunk: &[f32], abs_time_sec: f64) -> Option<f64> {
        if chunk.is_empty() {
            return None;
        }
        let end_sec = abs_time_sec + chunk.len() as f64 / SR as f64;
        if end_sec > self.session_end {
            self.session_end = end_sec;
        }
        if !self.anchored {
            self.ring.extend_from_slice(chunk);
            self.ring_start_sec = abs_time_sec;
            self.anchored = true;
            return Some(abs_time_sec);
        }
        let expected_start = self.ring_start_sec + self.ring.len() as f64 / SR as f64;
        let gap_sec = abs_time_sec - expected_start;
        if gap_sec > 0.5 / SR as f64 {
            let gap_samples = (gap_sec * SR as f64).round() as usize;
            self.ring.resize(self.ring.len() + gap_samples, 0.0);
        }
        self.ring.extend_from_slice(chunk);
        None
    }

    /// Drop audio older than `keep_from_sec` (never mid-sample, never everything).
    fn trim(&mut self, keep_from_sec: f64) {
        let drop_sec = keep_from_sec - self.ring_start_sec;
        if drop_sec <= 0.0 {
            return;
        }
        let drop_samples = (drop_sec * SR as f64).floor() as usize;
        if drop_samples == 0 || drop_samples >= self.ring.len() {
            return;
        }
        self.ring.drain(..drop_samples);
        self.ring_start_sec += drop_samples as f64 / SR as f64;
    }

    /// Extract `[start_sec, start_sec + win_sec)` as samples, zero-padded where the
    /// ring has no data.
    fn slice_window(&self, start_sec: f64, win_sec: f64) -> Vec<f32> {
        let win_samples = (win_sec * SR as f64).round() as usize;
        let start_in_ring = ((start_sec - self.ring_start_sec) * SR as f64).round() as i64;
        let mut out = vec![0.0f32; win_samples];
        for (i, o) in out.iter_mut().enumerate() {
            let idx = start_in_ring + i as i64;
            if idx >= 0 && (idx as usize) < self.ring.len() {
                *o = self.ring[idx as usize];
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Merged timeline with same-speaker gap bridging.
// ---------------------------------------------------------------------------

/// Port of cascade.js `_addToTimeline`: identified speakers bridge gaps up to
/// `MIN_GAP_OFF` (pyannote Binarize min_duration_off semantics) unless a DIFFERENT
/// identified speaker occupies the gap; unknown (-1) activity only micro-coalesces.
#[derive(Default)]
struct Timeline {
    segments: Vec<SpeakerSegment>,
}

impl Timeline {
    fn add(&mut self, start: f64, end: f64, speaker: i32) {
        if end - start <= 0.0 {
            return;
        }
        let bridge = if speaker >= 0 {
            MIN_GAP_OFF
        } else {
            COALESCE_GAP
        };
        let mut target: Option<usize> = None;
        // Scan at most the 16 most recent entries (cascade.js's bounded lookback).
        for i in (0..self.segments.len()).rev().take(16) {
            let seg = &self.segments[i];
            if seg.start > start + 1e-9 {
                continue; // later out-of-order entry; keep scanning
            }
            if seg.speaker == speaker && start - seg.end <= bridge {
                target = Some(i);
                break;
            }
            if speaker >= 0
                && seg.speaker >= 0
                && seg.speaker != speaker
                && seg.end > start - bridge
            {
                break; // a real turn change blocks bridging
            }
            if seg.end <= start - bridge {
                break; // beyond bridging reach
            }
        }
        if let Some(i) = target {
            let seg = &mut self.segments[i];
            if start < seg.end && end <= seg.end {
                return; // fully covered already
            }
            seg.end = seg.end.max(end);
            return;
        }
        self.segments.push(SpeakerSegment {
            start,
            end,
            speaker,
        });
    }

    fn prune_before(&mut self, cutoff: f64) {
        if cutoff > 0.0 {
            self.segments.retain(|s| s.end >= cutoff);
        }
    }

    fn snapshot(&self) -> Vec<SpeakerSegment> {
        self.segments
            .iter()
            .filter(|s| s.end - s.start >= DROP_SLIVER)
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

struct ChainState {
    emb: Vec<f32>,
    last_end: f64,
}

struct LocalTurnInfo {
    start_sec: f64,
    dur: f64,
}

pub struct CascadeDiarizer {
    seg_session: Session,
    emb_session: Session,
    seg_input: String,
    seg_output: String,
    emb_input: String,
    emb_output: String,
    fbank: Fbank,
    memory: SpeakerMemoryLive,

    ring: AudioRing,
    next_window_start: f64,

    /// Turn-chain EMA state per local slot.
    chain: [Option<ChainState>; NUM_LOCAL],

    timeline: Timeline,
    windows_processed: u64,
}

impl CascadeDiarizer {
    /// Build both ONNX sessions (CPU) from local model paths and warm them.
    pub fn new(seg_model: &std::path::Path, emb_model: &std::path::Path) -> Result<Self, String> {
        use crate::winstt::stt::{Accelerator, configure_session};
        use ort::session::builder::GraphOptimizationLevel;

        let build = |path: &std::path::Path, label: &str| -> Result<Session, String> {
            configure_session(
                GraphOptimizationLevel::Level3,
                Some(2),
                false,
                Some(&[Accelerator::Cpu]),
            )?
            .commit_from_file(path)
            .map_err(|e| format!("diarize {label} session ({}): {e}", path.display()))
        };
        let seg_session = build(seg_model, "segmentation")?;
        let emb_session = build(emb_model, "embedding")?;

        let first_name = |names: Vec<String>, what: &str| -> Result<String, String> {
            names
                .into_iter()
                .next()
                .ok_or_else(|| format!("diarize: {what} has no IO nodes"))
        };
        let seg_input = first_name(
            seg_session
                .inputs()
                .iter()
                .map(|i| i.name().to_string())
                .collect(),
            "segmentation input",
        )?;
        let seg_output = first_name(
            seg_session
                .outputs()
                .iter()
                .map(|o| o.name().to_string())
                .collect(),
            "segmentation output",
        )?;
        let emb_input = first_name(
            emb_session
                .inputs()
                .iter()
                .map(|i| i.name().to_string())
                .collect(),
            "embedding input",
        )?;
        let emb_output = first_name(
            emb_session
                .outputs()
                .iter()
                .map(|o| o.name().to_string())
                .collect(),
            "embedding output",
        )?;

        let mut engine = Self {
            seg_session,
            emb_session,
            seg_input,
            seg_output,
            emb_input,
            emb_output,
            fbank: Fbank::new(),
            memory: SpeakerMemoryLive::new(SpeakerMemoryConfig::default()),
            ring: AudioRing::new(),
            next_window_start: 0.0,
            chain: [None, None, None],
            timeline: Timeline::default(),
            windows_processed: 0,
        };
        engine.warm()?;
        Ok(engine)
    }

    /// One warm inference through each session so the first live window doesn't
    /// pay graph-initialization latency on the audio path.
    fn warm(&mut self) -> Result<(), String> {
        let zeros = vec![0.0f32; (WINDOW_SEC * SR as f64) as usize];
        self.run_segmentation(&zeros)?;
        let frames = 50usize;
        let feats = vec![0.0f32; frames * fbank::FEAT_DIM];
        self.run_embedding(&feats, frames)?;
        Ok(())
    }

    /// Reset all per-session state (a new Listen session starts at t=0).
    pub fn reset(&mut self) {
        self.ring.clear();
        self.next_window_start = 0.0;
        self.chain = [None, None, None];
        self.timeline.segments.clear();
        self.windows_processed = 0;
        self.memory.reset();
    }

    pub fn speaker_count(&self) -> usize {
        self.memory.speaker_count()
    }

    pub fn windows_processed(&self) -> u64 {
        self.windows_processed
    }

    /// Ingest one 16 kHz mono chunk covering `[abs_time_sec, abs_time_sec + len/SR)`.
    pub fn accept_audio(&mut self, chunk: &[f32], abs_time_sec: f64) {
        if let Some(anchor) = self.ring.accept(chunk, abs_time_sec) {
            self.next_window_start = anchor;
        }
        let keep_from = self
            .next_window_start
            .min(self.ring.session_end - MAX_RING_SEC);
        self.ring.trim(keep_from);
    }

    /// Process every window fully covered by received audio. Returns how many ran.
    pub fn process_ready_windows(&mut self) -> Result<usize, String> {
        let mut processed = 0usize;
        while self.ring.anchored && self.next_window_start + WINDOW_SEC <= self.ring.session_end {
            let start = self.next_window_start;
            self.process_window(start)?;
            self.next_window_start += HOP_SEC;
            let keep_from = self
                .next_window_start
                .min(self.ring.session_end - MAX_RING_SEC);
            self.ring.trim(keep_from);
            processed += 1;
        }
        if processed > 0 {
            self.timeline
                .prune_before(self.ring.session_end - TIMELINE_KEEP_SEC);
        }
        Ok(processed)
    }

    /// Snapshot of the merged timeline (segments clearing the sliver floor).
    pub fn timeline_snapshot(&self) -> Vec<SpeakerSegment> {
        self.timeline.snapshot()
    }

    fn run_segmentation(&mut self, pcm: &[f32]) -> Result<(Vec<f32>, usize), String> {
        let arr = Array3::from_shape_vec((1, 1, pcm.len()), pcm.to_vec())
            .map_err(|e| format!("seg input shape: {e}"))?;
        let tensor = Tensor::from_array(arr).map_err(|e| format!("seg tensor: {e}"))?;
        let input_name = self.seg_input.clone();
        let outputs = self
            .seg_session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(|e| format!("seg run: {e}"))?;
        let out = outputs[self.seg_output.as_str()]
            .try_extract_array::<f32>()
            .map_err(|e| format!("seg output extract: {e}"))?;
        let shape = out.shape();
        if shape.len() != 3 || shape[2] != SEG_CLASSES {
            return Err(format!("seg output shape unexpected: {shape:?}"));
        }
        let num_frames = shape[1];
        let logits: Vec<f32> = out.iter().copied().collect();
        Ok((logits, num_frames))
    }

    fn run_embedding(&mut self, feats: &[f32], frames: usize) -> Result<Vec<f32>, String> {
        let arr = Array3::from_shape_vec((1, frames, fbank::FEAT_DIM), feats.to_vec())
            .map_err(|e| format!("emb input shape: {e}"))?;
        let tensor = Tensor::from_array(arr).map_err(|e| format!("emb tensor: {e}"))?;
        let input_name = self.emb_input.clone();
        let outputs = self
            .emb_session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(|e| format!("emb run: {e}"))?;
        let out = outputs[self.emb_output.as_str()]
            .try_extract_array::<f32>()
            .map_err(|e| format!("emb output extract: {e}"))?;
        Ok(out.iter().copied().collect())
    }

    fn process_window(&mut self, window_start: f64) -> Result<(), String> {
        let pcm = self.ring.slice_window(window_start, WINDOW_SEC);

        // 1) Segmentation → powerset decode.
        let (logits, num_frames) = self.run_segmentation(&pcm)?;
        let (p_score, conf) = decode_powerset(&logits, num_frames);

        // 2) Hysteresis → local turns.
        let mut turns: Vec<(usize, usize, usize)> = Vec::new(); // (local, startF, endF)
        for s in 0..NUM_LOCAL {
            for (start_f, end_f) in hysteresis(&p_score, num_frames, s) {
                turns.push((s, start_f, end_f));
            }
        }

        // 3) Window fbank + overlap-aware weights on the fbank grid.
        let win_fbank = self.fbank.compute(&pcm);
        let nfb_frames = Fbank::num_frames(pcm.len());
        let weights = overlap_weights(&p_score, num_frames, nfb_frames);

        // 4) Pool + embed one turn-union per local speaker.
        let mut embeddings: [Option<Vec<f32>>; NUM_LOCAL] = [None, None, None];
        let mut infos: [Option<LocalTurnInfo>; NUM_LOCAL] = [None, None, None];
        for s in 0..NUM_LOCAL {
            let s_turns: Vec<&(usize, usize, usize)> = turns
                .iter()
                .filter(|(local, start_f, end_f)| {
                    *local == s && (end_f - start_f) as f64 * FRAME_STEP_SEC >= MIN_TURN_SEC
                })
                .collect();
            if s_turns.is_empty() {
                continue;
            }
            let start_f = s_turns.iter().map(|t| t.1).min().unwrap_or(0);
            let end_f = s_turns.iter().map(|t| t.2).max().unwrap_or(0);
            let start_sec = window_start + start_f as f64 * FRAME_STEP_SEC;
            let end_sec = window_start + end_f as f64 * FRAME_STEP_SEC;
            let dur: f64 = s_turns
                .iter()
                .map(|t| (t.2 - t.1) as f64 * FRAME_STEP_SEC)
                .sum();

            let Some((seq, t_frames)) = pool_fbank(
                &win_fbank,
                nfb_frames,
                &weights,
                s,
                start_sec - window_start,
                end_sec - window_start,
            ) else {
                continue;
            };
            let mut emb = self.run_embedding(&seq, t_frames)?;
            l2_normalize_in_place(&mut emb);
            let emb = self.chain_aggregate(s, emb, start_sec, end_sec);
            embeddings[s] = Some(emb);
            infos[s] = Some(LocalTurnInfo { start_sec, dur });
        }

        // 5) Assign turns in start-time order (WhoSpeaksLive sees turns as they occurred).
        let mut order: Vec<usize> = (0..NUM_LOCAL)
            .filter(|&s| embeddings[s].is_some() && infos[s].is_some())
            .collect();
        order.sort_by(|&a, &b| {
            let sa = infos[a].as_ref().map_or(0.0, |i| i.start_sec);
            let sb = infos[b].as_ref().map_or(0.0, |i| i.start_sec);
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut local_to_global: [i32; NUM_LOCAL] = [-1; NUM_LOCAL];
        for &s in &order {
            let (Some(emb), Some(info)) = (&embeddings[s], &infos[s]) else {
                continue;
            };
            local_to_global[s] = self.memory.assign_turn(emb, info.dur as f32);
        }

        // 6) Emit segments into the merged timeline in chronological order so the
        //    bridging scan behaves like the JS timeline. Sub-min turns surface as -1
        //    activity; embeddable turns carry their global id.
        let _ = conf; // confidence is tracked by the playground HUD only.
        let mut emitted: Vec<(f64, f64, i32)> = turns
            .iter()
            .map(|&(s, start_f, end_f)| {
                let start_sec = window_start + start_f as f64 * FRAME_STEP_SEC;
                let end_sec = window_start + end_f as f64 * FRAME_STEP_SEC;
                let speaker = if end_sec - start_sec >= MIN_TURN_SEC {
                    local_to_global[s]
                } else {
                    -1
                };
                (start_sec, end_sec, speaker)
            })
            .collect();
        emitted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (start, end, speaker) in emitted {
            self.timeline.add(start, end, speaker);
        }

        self.windows_processed += 1;
        Ok(())
    }

    /// Turn-level EMA aggregation across consecutive windows for a local slot.
    fn chain_aggregate(
        &mut self,
        local: usize,
        emb: Vec<f32>,
        start_sec: f64,
        end_sec: f64,
    ) -> Vec<f32> {
        let continues = self.chain[local].as_ref().is_some_and(|prev| {
            start_sec - prev.last_end <= CHAIN_MAX_GAP_SEC + 1e-6
                && cosine_sim(&prev.emb, &emb) >= CHAIN_MIN_SIM
        });
        if continues {
            let prev = self.chain[local].as_ref().expect("chain checked above");
            let a = TURN_EMA_ALPHA;
            let mut agg: Vec<f32> = prev
                .emb
                .iter()
                .zip(emb.iter())
                .map(|(p, e)| (1.0 - a) * p + a * e)
                .collect();
            l2_normalize_in_place(&mut agg);
            self.chain[local] = Some(ChainState {
                emb: agg.clone(),
                last_end: end_sec,
            });
            agg
        } else {
            self.chain[local] = Some(ChainState {
                emb: emb.clone(),
                last_end: end_sec,
            });
            emb
        }
    }
}

/// Majority speaker (by labeled overlap duration) over `[start, end]` of a timeline
/// snapshot. Unknown (-1) spans never vote. Returns `None` when nothing labeled
/// overlaps the span.
pub fn dominant_speaker(segments: &[SpeakerSegment], start: f64, end: f64) -> Option<i32> {
    let votes = speaker_votes(segments, start, end);
    votes
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(speaker, _)| speaker)
}

/// When `[start, end]` contains a speaker TURN — at least two distinct labeled
/// speakers each overlapping the span by ≥ `min_each_sec` — returns the boundary
/// time: the earliest in-span start of a qualifying segment belonging to a
/// DIFFERENT speaker than the span's first qualifying voice. The listen consumer
/// splits the caption at this time (commit the prefix under the first speaker,
/// keep the suffix live), so rows separate per speaker (WhoSpeaksLive-style)
/// instead of mixing two voices into one majority-labeled block. `None` while the
/// span is single-voiced.
pub fn span_turn_boundary(
    segments: &[SpeakerSegment],
    start: f64,
    end: f64,
    min_each_sec: f64,
) -> Option<f64> {
    let votes = speaker_votes(segments, start, end);
    let qualified: std::collections::BTreeSet<i32> = votes
        .iter()
        .filter(|&(_, &sec)| sec >= min_each_sec)
        .map(|(&speaker, _)| speaker)
        .collect();
    if qualified.len() < 2 {
        return None;
    }
    // Earliest in-span start per qualifying speaker.
    let mut earliest: std::collections::BTreeMap<i32, f64> = Default::default();
    for seg in segments {
        if !qualified.contains(&seg.speaker) {
            continue;
        }
        let ov = seg.end.min(end) - seg.start.max(start);
        if ov <= 0.0 {
            continue;
        }
        let in_span_start = seg.start.max(start);
        earliest
            .entry(seg.speaker)
            .and_modify(|t| *t = t.min(in_span_start))
            .or_insert(in_span_start);
    }
    let (&first_speaker, _) = earliest
        .iter()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    earliest
        .iter()
        .filter(|&(&speaker, _)| speaker != first_speaker)
        .map(|(_, &t)| t)
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

/// Labeled overlap seconds per speaker over `[start, end]` (unknown never votes).
fn speaker_votes(
    segments: &[SpeakerSegment],
    start: f64,
    end: f64,
) -> std::collections::BTreeMap<i32, f64> {
    let mut votes: std::collections::BTreeMap<i32, f64> = std::collections::BTreeMap::new();
    for seg in segments {
        if seg.speaker < 0 {
            continue;
        }
        let ov = seg.end.min(end) - seg.start.max(start);
        if ov > 0.0 {
            *votes.entry(seg.speaker).or_insert(0.0) += ov;
        }
    }
    votes
}

/// Powerset decode (SPEC §3.4): per frame softmax over the 7 classes → continuous
/// per-local-speaker score (sum of probs over classes containing s) + per-frame
/// confidence (max prob). Returns `(p_score: frames*3, conf: frames)`.
fn decode_powerset(logits: &[f32], num_frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut p_score = vec![0.0f32; num_frames * NUM_LOCAL];
    let mut conf = vec![0.0f32; num_frames];
    let mut probs = [0.0f64; SEG_CLASSES];
    for f in 0..num_frames {
        let base = f * SEG_CLASSES;
        let mut mx = f32::NEG_INFINITY;
        for c in 0..SEG_CLASSES {
            mx = mx.max(logits[base + c]);
        }
        let mut sum = 0.0f64;
        for (c, p) in probs.iter_mut().enumerate() {
            let e = f64::from(logits[base + c] - mx).exp();
            *p = e;
            sum += e;
        }
        let inv = if sum > 0.0 { 1.0 / sum } else { 0.0 };
        let mut best = 0.0f64;
        for p in probs.iter_mut() {
            *p *= inv;
            best = best.max(*p);
        }
        conf[f] = best as f32;
        for s in 0..NUM_LOCAL {
            let mut ps = 0.0f64;
            for (c, p) in probs.iter().enumerate() {
                if POWERSET[c][s] > 0.0 {
                    ps += *p;
                }
            }
            p_score[f * NUM_LOCAL + s] = ps as f32;
        }
    }
    (p_score, conf)
}

/// Two-threshold hysteresis on the continuous per-speaker score (SPEC §3.5).
/// Returns `[(start_frame, end_frame)]`, end exclusive.
fn hysteresis(p_score: &[f32], num_frames: usize, s: usize) -> Vec<(usize, usize)> {
    let mut intervals = Vec::new();
    let mut on = false;
    let mut start = 0usize;
    for f in 0..num_frames {
        let v = p_score[f * NUM_LOCAL + s];
        if !on {
            if v >= ONSET {
                on = true;
                start = f;
            }
        } else if v < OFFSET {
            on = false;
            intervals.push((start, f));
        }
    }
    if on {
        intervals.push((start, num_frames));
    }
    intervals
}

/// Overlap-aware weights (SPEC §4.1–4.2): softmax(beta·seg) across speakers ×
/// pow(seg,gamma)·pow(probs,gamma), floored, min-max normalized per speaker, then
/// nearest-neighbor resampled from the seg grid to the fbank grid.
fn overlap_weights(p_score: &[f32], seg_frames: usize, nfb_frames: usize) -> Vec<f32> {
    let mut seg_w = vec![0.0f32; seg_frames * NUM_LOCAL];
    let mut sm = [0.0f64; NUM_LOCAL];
    for f in 0..seg_frames {
        let base = f * NUM_LOCAL;
        let mut mx = f32::NEG_INFINITY;
        for s in 0..NUM_LOCAL {
            mx = mx.max(POOL_BETA * p_score[base + s]);
        }
        let mut sum = 0.0f64;
        for (s, slot) in sm.iter_mut().enumerate() {
            let e = f64::from(POOL_BETA * p_score[base + s] - mx).exp();
            *slot = e;
            sum += e;
        }
        let inv = if sum > 0.0 { 1.0 / sum } else { 0.0 };
        for s in 0..NUM_LOCAL {
            let seg = p_score[base + s];
            let prob = (sm[s] * inv) as f32;
            let w = (seg.powf(POOL_GAMMA) * prob.powf(POOL_GAMMA)).max(1e-8);
            seg_w[base + s] = w;
        }
    }
    // Per-speaker min-max normalize across frames.
    for s in 0..NUM_LOCAL {
        let mut mn = f32::INFINITY;
        let mut mx = f32::NEG_INFINITY;
        for f in 0..seg_frames {
            let w = seg_w[f * NUM_LOCAL + s];
            mn = mn.min(w);
            mx = mx.max(w);
        }
        let range = mx - mn;
        for f in 0..seg_frames {
            let idx = f * NUM_LOCAL + s;
            seg_w[idx] = if range > 1e-12 {
                (seg_w[idx] - mn) / range
            } else {
                1e-8
            };
        }
    }
    // Resample to the fbank grid (nearest).
    let mut fb_w = vec![0.0f32; nfb_frames * NUM_LOCAL];
    for f in 0..nfb_frames {
        let sf = if seg_frames > 1 && nfb_frames > 1 {
            (((f as f64 / (nfb_frames - 1) as f64) * (seg_frames - 1) as f64).round() as usize)
                .min(seg_frames - 1)
        } else {
            0
        };
        for s in 0..NUM_LOCAL {
            fb_w[f * NUM_LOCAL + s] = seg_w[sf * NUM_LOCAL + s];
        }
    }
    fb_w
}

/// Overlap-aware soft-masked fbank span for local speaker `s` over
/// `[start_rel, end_rel]` seconds (window-relative), CMN'd. Port of cascade.js
/// `_poolFbank`: low-weight frames are interpolated toward the weighted pooled
/// mean, preserving temporal structure while suppressing overlapped speech.
fn pool_fbank(
    win_fbank: &[f32],
    nfb_frames: usize,
    weights: &[f32],
    s: usize,
    start_rel: f64,
    end_rel: f64,
) -> Option<(Vec<f32>, usize)> {
    const FB_HOP: f64 = fbank::FRAME_SHIFT as f64 / SR as f64; // 0.01
    let feat_dim = fbank::FEAT_DIM;
    if nfb_frames == 0 {
        return None;
    }
    let mut f0 = ((start_rel / FB_HOP).floor() as i64).max(0) as usize;
    let mut f1 = ((end_rel / FB_HOP).ceil() as usize).min(nfb_frames);
    if f1 <= f0 {
        f0 = f0.min(nfb_frames - 1);
        f1 = (f0 + 1).min(nfb_frames);
    }
    if f1 <= f0 {
        return None;
    }

    // Weighted temporal mean over the span.
    let mut pooled = vec![0.0f32; feat_dim];
    let mut w_sum = 0.0f32;
    for f in f0..f1 {
        let w = weights[f * NUM_LOCAL + s];
        if w <= 0.0 {
            continue;
        }
        let base = f * feat_dim;
        for (d, p) in pooled.iter_mut().enumerate() {
            *p += w * win_fbank[base + d];
        }
        w_sum += w;
    }
    if w_sum <= 1e-9 {
        return None;
    }
    for p in pooled.iter_mut() {
        *p /= w_sum;
    }

    // Soft-masked frame sequence: interpolate each frame toward the pooled mean by
    // its (1-weight) share, then per-utterance CMN (WeSpeaker requires global-mean).
    let t = f1 - f0;
    let mut seq = vec![0.0f32; t * feat_dim];
    for i in 0..t {
        let f = f0 + i;
        let a = weights[f * NUM_LOCAL + s].clamp(0.0, 1.0);
        let src = f * feat_dim;
        let dst = i * feat_dim;
        for d in 0..feat_dim {
            seq[dst + d] = a * win_fbank[src + d] + (1.0 - a) * pooled[d];
        }
    }
    apply_cmn(&mut seq, t);
    Some((seq, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powerset_decode_sums_speaker_probabilities() {
        // One frame with all mass on class 4 ({0,1}): both locals 0 and 1 score ~1.
        let mut logits = vec![-20.0f32; SEG_CLASSES];
        logits[4] = 20.0;
        let (p_score, conf) = decode_powerset(&logits, 1);
        assert!(p_score[0] > 0.99); // local 0
        assert!(p_score[1] > 0.99); // local 1
        assert!(p_score[2] < 0.01); // local 2
        assert!(conf[0] > 0.99);
    }

    #[test]
    fn hysteresis_uses_two_thresholds() {
        // Rise above onset, dip between offset and onset (stays ON), fall below offset.
        let track = [0.1f32, 0.6, 0.45, 0.6, 0.2, 0.1];
        let mut p_score = vec![0.0f32; track.len() * NUM_LOCAL];
        for (f, &v) in track.iter().enumerate() {
            p_score[f * NUM_LOCAL] = v;
        }
        let iv = hysteresis(&p_score, track.len(), 0);
        assert_eq!(iv, vec![(1, 4)]);
        // Other locals stay silent.
        assert!(hysteresis(&p_score, track.len(), 1).is_empty());
    }

    #[test]
    fn overlap_weights_suppress_contested_frames() {
        // Frame 0: speaker 0 alone (1.0 vs 0.0) → high weight for 0.
        // Frame 1: both speakers at 0.5 (contested) → suppressed weight for 0.
        let p_score = vec![
            1.0f32, 0.0, 0.0, // frame 0
            0.5, 0.5, 0.0, // frame 1
        ];
        let w = overlap_weights(&p_score, 2, 2);
        assert!(
            w[0] > w[NUM_LOCAL],
            "solo frame must outweigh contested frame"
        );
    }

    #[test]
    fn timeline_bridges_same_speaker_gaps_only() {
        let mut t = Timeline::default();
        t.add(0.0, 1.0, 0);
        t.add(1.4, 2.0, 0); // gap 0.4 < MIN_GAP_OFF → bridged
        assert_eq!(t.segments.len(), 1);
        assert!((t.segments[0].end - 2.0).abs() < 1e-9);

        t.add(2.2, 3.0, 1); // different speaker → new segment
        assert_eq!(t.segments.len(), 2);
        // Speaker 0 after speaker 1's turn: 1's segment occupies the gap → no bridge.
        t.add(3.1, 4.0, 0);
        assert_eq!(t.segments.len(), 3);
    }

    #[test]
    fn timeline_snapshot_drops_slivers() {
        let mut t = Timeline::default();
        t.add(0.0, 0.1, 0); // below DROP_SLIVER
        t.add(1.0, 2.0, 1);
        let snap = t.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].speaker, 1);
    }

    #[test]
    fn ring_zero_fills_gaps_and_keeps_clock() {
        let mut r = AudioRing::new();
        assert_eq!(r.accept(&[1.0; 1600], 0.0), Some(0.0)); // 0.0..0.1
        assert_eq!(r.accept(&[1.0; 1600], 0.2), None); // gap 0.1..0.2 zero-filled
        assert!((r.session_end - 0.3).abs() < 1e-9);
        assert_eq!(r.ring.len(), 4800);
        assert!(r.ring[1600..3200].iter().all(|&v| v == 0.0));
        assert!(r.ring[3200..].iter().all(|&v| v == 1.0));
        // Window slicing maps time exactly (zero-pad outside data).
        let w = r.slice_window(0.05, 0.1);
        assert_eq!(w.len(), 1600);
        assert!(w[..800].iter().all(|&v| v == 1.0));
        assert!(w[800..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn turn_boundary_requires_two_meaningful_speakers() {
        let segs = vec![
            SpeakerSegment {
                start: 0.0,
                end: 3.0,
                speaker: 0,
            },
            SpeakerSegment {
                start: 3.0,
                end: 3.3,
                speaker: 1,
            },
        ];
        // Speaker 1 only has 0.3s in-span — below the 0.8s floor → no break yet.
        assert_eq!(span_turn_boundary(&segs, 0.0, 3.3, 0.8), None);
        // Extend speaker 1 past the floor → boundary at the second voice's start.
        let segs2 = vec![
            SpeakerSegment {
                start: 0.0,
                end: 3.0,
                speaker: 0,
            },
            SpeakerSegment {
                start: 3.0,
                end: 4.2,
                speaker: 1,
            },
        ];
        assert_eq!(span_turn_boundary(&segs2, 0.0, 4.2, 0.8), Some(3.0));
        // Same speaker throughout → never a break.
        assert_eq!(span_turn_boundary(&segs2, 0.0, 2.9, 0.8), None);
        // Unknown activity never counts as a second speaker.
        let segs3 = vec![
            SpeakerSegment {
                start: 0.0,
                end: 3.0,
                speaker: 0,
            },
            SpeakerSegment {
                start: 3.0,
                end: 5.0,
                speaker: -1,
            },
        ];
        assert_eq!(span_turn_boundary(&segs3, 0.0, 5.0, 0.8), None);
        // A span starting mid-way through speaker 0's turn clamps the boundary
        // to the second voice's in-span start, not its absolute segment start.
        let segs4 = vec![
            SpeakerSegment {
                start: 0.0,
                end: 6.0,
                speaker: 0,
            },
            SpeakerSegment {
                start: 6.0,
                end: 8.0,
                speaker: 1,
            },
        ];
        assert_eq!(span_turn_boundary(&segs4, 4.0, 8.0, 0.8), Some(6.0));
    }

    #[test]
    fn dominant_speaker_votes_by_labeled_overlap() {
        let segs = vec![
            SpeakerSegment {
                start: 0.0,
                end: 2.0,
                speaker: 0,
            },
            SpeakerSegment {
                start: 2.0,
                end: 2.5,
                speaker: 1,
            },
            SpeakerSegment {
                start: 2.5,
                end: 3.0,
                speaker: -1,
            },
        ];
        assert_eq!(dominant_speaker(&segs, 0.0, 3.0), Some(0));
        assert_eq!(dominant_speaker(&segs, 1.9, 2.6), Some(1));
        assert_eq!(dominant_speaker(&segs, 2.5, 3.0), None); // only unknown overlaps
        assert_eq!(dominant_speaker(&segs, 5.0, 6.0), None);
    }
}
