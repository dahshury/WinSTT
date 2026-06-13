// Reference: <onnx-asr>/src/onnx_asr/diarization.py
//         server/src/recorder/application/diarization_stream.py + domain/speaker_timeline.py
//         WeSpeaker ResNet34 embedding model on WinSTT's shared `ort` runtime.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PORT (not "use sherpa-onnx OfflineSpeakerDiarization directly")
// ─────────────────────────────────────────────────────────────────────────────
// sherpa-onnx ships an OFFLINE AHC diarizer: given a whole clip + a speaker count
// it complete-linkage-clusters segments. That has NO session-stable IDs — re-run
// it on the next utterance and "speaker 0" may be a different person. WinSTT's
// Listen mode + per-utterance diarization need IDs that PERSIST across calls
// (project_listen_diarization_architecture). So we REUSE the heavy ML from
// WeSpeaker embeddings plus the pyannote segmentation session) and PORT — to
// pure Rust arithmetic — the session-stable
// clustering, the activity-interval hysteresis, the SpeakerTimeline, and the
// word→speaker assignment. None of those touch torch/onnx; they are deterministic
// and fully unit-tested here.
//
// ENGINE NOTE: embedding is direct ORT (`OrtEmbedder`); sherpa-onnx remains for
// wakeword only. The deterministic arithmetic (clustering / timeline /
// word-assignment / AHC) never touches model runtime state and runs its own tests.
// The SEGMENTATION session (pyannote-3.0 powerset) stays behind the `Segmenter`
// trait until the exact output shape is wired.
//
// MODULE LAYOUT (split out of the original single-file module; behaviour-identical):
//   types     — shared data types (SpeakerSegment/EmbeddedSegment/TimedWord/
//               SpeakerWord) + the private l2_normalize/dot helpers.
//   clustering — OnlineSpeakerClustering incremental session-stable state machine.
//   ahc       — offline complete-linkage AHC + active_intervals hysteresis.
//   timeline  — SpeakerTimeline + word→speaker assignment helpers.
//   pipeline  — Diarizer/SessionDiarizer orchestration + ORT WeSpeaker embedder.

mod ahc;
mod clustering;
mod pipeline;
mod timeline;
mod types;

pub use ahc::*;
pub use clustering::*;
pub use pipeline::*;
pub use timeline::*;
pub use types::*;

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
