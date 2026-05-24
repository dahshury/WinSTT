"""Property-based tests for pure functions in :mod:`src.stt_server.text_processing`."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from src.stt_server.text_processing import (
    get_whisper_pause,
    interpolate_detection,
    preprocess_text,
)


@settings(max_examples=300)
@given(st.floats(allow_nan=False, allow_infinity=False))
def test_interpolate_detection_clamped_to_unit_interval(prob: float) -> None:
    result = interpolate_detection(prob)
    assert 0.0 <= result <= 1.0


@settings(max_examples=300)
@given(
    st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
    st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
)
def test_interpolate_detection_monotonically_decreasing(a: float, b: float) -> None:
    lo, hi = sorted((a, b))
    # Higher prob ⇒ shorter (smaller) pause: interpolate is non-increasing.
    assert interpolate_detection(lo) >= interpolate_detection(hi)


@settings(max_examples=300)
@given(st.text(min_size=0, max_size=200))
def test_preprocess_text_is_idempotent(text: str) -> None:
    once = preprocess_text(text)
    twice = preprocess_text(once)
    assert once == twice


@settings(max_examples=300)
@given(st.text(min_size=0, max_size=200))
def test_get_whisper_pause_deterministic_and_positive(text: str) -> None:
    a = get_whisper_pause(text)
    b = get_whisper_pause(text)
    assert a == b
    assert a > 0.0
    # The function chooses among a small known set; check membership.
    assert a in {4.5, 0.4, 0.3, 0.2, 1.8}


@settings(max_examples=300)
@given(st.text(min_size=0, max_size=200))
def test_preprocess_text_capitalises_first_char_when_non_empty(text: str) -> None:
    result = preprocess_text(text)
    if result:
        # First char must equal its own uppercase form.
        assert result[0] == result[0].upper()
