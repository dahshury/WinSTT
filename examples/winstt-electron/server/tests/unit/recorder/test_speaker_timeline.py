"""Tests for :mod:`src.recorder.domain.speaker_timeline`.

Pure domain logic — no threads, no I/O. The continuous diarization worker
feeds window-relative segments; the timeline must shift them to absolute
session time, resolve a query range by majority overlap (the same vote
utterr's splitter uses), clip range queries, prune unbounded growth, and
reset cleanly.
"""

from __future__ import annotations

from src.recorder.domain.events import SpeakerSegment
from src.recorder.domain.speaker_timeline import SpeakerTimeline


def _seg(start: float, end: float, speaker: int) -> SpeakerSegment:
    return SpeakerSegment(start=start, end=end, speaker=speaker)


class TestSpeakerTimeline:
    def test_merge_shifts_window_relative_to_absolute(self) -> None:
        tl = SpeakerTimeline()
        # A window starting at t=10s yields a 0.0-1.0 window-relative span.
        tl.merge((_seg(0.0, 1.0, 2),), window_start_seconds=10.0)
        assert tl.dominant_speaker(10.0, 11.0) == 2
        assert tl.dominant_speaker(0.0, 1.0) is None  # nothing at the origin

    def test_merge_empty_is_noop(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((), window_start_seconds=5.0)
        assert tl.dominant_speaker(0.0, 100.0) is None

    def test_merge_skips_non_positive_spans(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.5, 0.5, 1), _seg(0.8, 0.4, 1)), window_start_seconds=0.0)
        assert tl.dominant_speaker(0.0, 1.0) is None

    def test_dominant_speaker_is_majority_overlap(self) -> None:
        tl = SpeakerTimeline()
        # Speaker 0 covers [0,3), speaker 1 covers [3,4): query [0,4) → 0 wins.
        tl.merge((_seg(0.0, 3.0, 0), _seg(3.0, 4.0, 1)), window_start_seconds=0.0)
        assert tl.dominant_speaker(0.0, 4.0) == 0
        # Narrow the query to where speaker 1 dominates.
        assert tl.dominant_speaker(3.0, 4.0) == 1

    def test_dominant_speaker_none_when_no_overlap(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=0.0)
        assert tl.dominant_speaker(50.0, 60.0) is None

    def test_dominant_speaker_empty_range(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=0.0)
        assert tl.dominant_speaker(2.0, 2.0) is None
        assert tl.dominant_speaker(3.0, 2.0) is None

    def test_segments_in_range_clipped_and_sorted(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 5.0, 1),), window_start_seconds=0.0)
        tl.merge((_seg(0.0, 2.0, 0),), window_start_seconds=1.0)  # → abs 1..3 spk0
        hits = tl.segments_in_range(2.0, 4.0)
        assert [(round(h.start, 3), round(h.end, 3), h.speaker) for h in hits] == [
            (2.0, 3.0, 0),
            (2.0, 4.0, 1),
        ]

    def test_segments_in_range_empty(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=0.0)
        assert tl.segments_in_range(10.0, 20.0) == []
        assert tl.segments_in_range(5.0, 5.0) == []

    def test_prunes_old_spans_to_bound_memory(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=0.0)
        # Jump far ahead — the old span is now >600s behind the newest end.
        tl.merge((_seg(0.0, 1.0, 1),), window_start_seconds=5000.0)
        assert tl.dominant_speaker(0.0, 1.0) is None  # pruned
        assert tl.dominant_speaker(5000.0, 5001.0) == 1

    def test_recent_segments_rebased_to_line_start(self) -> None:
        tl = SpeakerTimeline()
        # Timeline: spk0 over abs [0,5), spk1 over abs [5,10). latest_end=10.
        tl.merge((_seg(0.0, 5.0, 0), _seg(5.0, 10.0, 1)), window_start_seconds=0.0)
        # A 4s committed line = the last 4s → abs [6,10). spk0 (ends at 5) is
        # entirely before the window → dropped; spk1 fills it, re-based [0,4).
        segs = tl.recent_segments(4.0)
        assert [(round(s.start, 3), round(s.end, 3), s.speaker) for s in segs] == [(0.0, 4.0, 1)]

    def test_recent_segments_spans_two_speakers(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 5.0, 0), _seg(5.0, 10.0, 1)), window_start_seconds=0.0)
        # Last 8s → abs [2,10): spk0 [2,5)→rel[0,3), spk1 [5,10)→rel[3,8).
        segs = tl.recent_segments(8.0)
        assert [(round(s.start, 3), round(s.end, 3), s.speaker) for s in segs] == [
            (0.0, 3.0, 0),
            (3.0, 8.0, 1),
        ]

    def test_recent_segments_single_speaker_window(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 5.0, 2),), window_start_seconds=0.0)  # latest_end=5
        segs = tl.recent_segments(3.0)  # last 3s → abs [2,5) → rel [0,3)
        assert len(segs) == 1
        assert (round(segs[0].start, 3), round(segs[0].end, 3), segs[0].speaker) == (0.0, 3.0, 2)

    def test_recent_segments_non_positive_duration(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=0.0)
        assert tl.recent_segments(0.0) == ()
        assert tl.recent_segments(-1.0) == ()

    def test_recent_segments_empty_timeline(self) -> None:
        assert SpeakerTimeline().recent_segments(5.0) == ()

    def test_reset_clears_everything(self) -> None:
        tl = SpeakerTimeline()
        tl.merge((_seg(0.0, 1.0, 0),), window_start_seconds=10.0)
        tl.reset()
        assert tl.dominant_speaker(10.0, 11.0) is None
        assert tl.segments_in_range(0.0, 100.0) == []
