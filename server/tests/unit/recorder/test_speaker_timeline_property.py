"""Property-based tests for :mod:`src.recorder.domain.speaker_timeline`."""

from __future__ import annotations

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from src.recorder.domain.events import SpeakerSegment
from src.recorder.domain.speaker_timeline import SpeakerTimeline


def _seg(start: float, end: float, speaker: int) -> SpeakerSegment:
    return SpeakerSegment(start=start, end=end, speaker=speaker)


# Bounded floats: deterministic durations, no NaN/inf, kept inside ±10000s so
# the rolling-prune cutoff math doesn't overflow.
_TIME = st.floats(min_value=0.0, max_value=1000.0, allow_nan=False, allow_infinity=False)
_DURATION = st.floats(min_value=0.001, max_value=100.0, allow_nan=False, allow_infinity=False)
_SPEAKER = st.integers(min_value=0, max_value=5)


def _segment_strategy() -> st.SearchStrategy[SpeakerSegment]:
    return st.builds(
        lambda start, dur, spk: _seg(start, start + dur, spk),
        _TIME,
        _DURATION,
        _SPEAKER,
    )


# Bounded so latest_end - oldest_end stays inside the 600s retain window:
# avoids prune-truncating the oracle's view of inputs.
_BOUNDED_TIME = st.floats(min_value=0.0, max_value=300.0, allow_nan=False, allow_infinity=False)
_BOUNDED_DURATION = st.floats(min_value=0.001, max_value=50.0, allow_nan=False, allow_infinity=False)


def _bounded_segment_strategy() -> st.SearchStrategy[SpeakerSegment]:
    return st.builds(
        lambda start, dur, spk: _seg(start, start + dur, spk),
        _BOUNDED_TIME,
        _BOUNDED_DURATION,
        _SPEAKER,
    )


@settings(max_examples=200)
@given(st.lists(_bounded_segment_strategy(), min_size=1, max_size=20), _BOUNDED_TIME, _BOUNDED_TIME)
def test_dominant_speaker_matches_brute_force_oracle(
    segments: list[SpeakerSegment], a: float, b: float
) -> None:
    start, end = sorted((a, b))
    assume(end > start)
    tl = SpeakerTimeline()
    tl.merge(tuple(segments), window_start_seconds=0.0)

    # Brute-force oracle: compute per-speaker overlap directly.
    totals: dict[int, float] = {}
    for s in segments:
        lo = max(start, s.start)
        hi = min(end, s.end)
        if hi > lo:
            totals[s.speaker] = totals.get(s.speaker, 0.0) + (hi - lo)

    got = tl.dominant_speaker(start, end)
    if not totals:
        assert got is None
    else:
        expected_max = max(totals.values())
        # Any speaker tied for the max is an acceptable answer (Python's
        # max() picks the first such key, but ties are real and we don't
        # want to over-constrain the oracle on tie-break order).
        assert got is not None
        assert totals[got] == expected_max


@settings(max_examples=200)
@given(st.lists(_segment_strategy(), min_size=1, max_size=15), _DURATION)
def test_recent_segments_within_duration(segments: list[SpeakerSegment], duration: float) -> None:
    tl = SpeakerTimeline()
    tl.merge(tuple(segments), window_start_seconds=0.0)
    out = tl.recent_segments(duration)
    for s in out:
        assert 0.0 <= s.start < s.end
        assert s.end <= duration + 1e-9


@settings(max_examples=200)
@given(_DURATION)
def test_recent_segments_empty_timeline(duration: float) -> None:
    assert SpeakerTimeline().recent_segments(duration) == ()


@settings(max_examples=200)
@given(st.lists(_segment_strategy(), max_size=15))
def test_non_positive_duration_returns_empty(segments: list[SpeakerSegment]) -> None:
    tl = SpeakerTimeline()
    tl.merge(tuple(segments), window_start_seconds=0.0)
    assert tl.recent_segments(0.0) == ()
    assert tl.recent_segments(-1.5) == ()


@settings(max_examples=200)
@given(
    st.lists(_bounded_segment_strategy(), min_size=1, max_size=10),
    st.floats(min_value=0.0, max_value=200.0, allow_nan=False, allow_infinity=False),
)
def test_window_shift_preserves_relative_ordering(
    segments: list[SpeakerSegment], window_start: float
) -> None:
    tl = SpeakerTimeline()
    tl.merge(tuple(segments), window_start_seconds=window_start)
    # Apply the prune semantics to the oracle too: if any single merged
    # segment's end is more than 600s past another's, the earlier one is
    # dropped. Inputs are bounded so this corresponds to the same cutoff
    # the implementation computes.
    shifted = [(window_start + s.start, window_start + s.end, s.speaker) for s in segments if s.end > s.start]
    if not shifted:
        assert tl.segments_in_range(0.0, 1e9) == []
        return
    latest_end = max(end for _start, end, _spk in shifted)
    cutoff = latest_end - 600.0
    expected = sorted((st_, en, sp) for st_, en, sp in shifted if en >= cutoff)
    hits = tl.segments_in_range(0.0, 1e9)
    out_sorted = sorted((s.start, s.end, s.speaker) for s in hits)
    assert out_sorted == expected


@settings(max_examples=100)
@given(
    st.lists(_segment_strategy(), min_size=1, max_size=10),
    st.floats(min_value=700.0, max_value=2000.0, allow_nan=False, allow_infinity=False),
)
def test_pruning_keeps_segments_with_end_ge_cutoff(
    early_segments: list[SpeakerSegment], far_future_start: float
) -> None:
    tl = SpeakerTimeline()
    tl.merge(tuple(early_segments), window_start_seconds=0.0)
    # Now merge a segment so far ahead that everything earlier than cutoff is pruned.
    tl.merge((_seg(0.0, 1.0, 99),), window_start_seconds=far_future_start)
    remaining = tl.segments_in_range(0.0, far_future_start + 1.0)
    cutoff = (far_future_start + 1.0) - 600.0
    for s in remaining:
        assert s.end >= cutoff
