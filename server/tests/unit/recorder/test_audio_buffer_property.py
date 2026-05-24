"""Property-based tests for :mod:`src.recorder.domain.audio_buffer`."""

from __future__ import annotations

import math
import struct

from hypothesis import given, settings
from hypothesis import strategies as st

from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.domain.audio_buffer import AudioBuffer


def _make_chunk(value: int = 0, size: int = 512) -> bytes:
    return struct.pack(f"<{size}h", *([value] * size))


def _new_buf(
    sample_rate: int = 16000, buffer_size: int = 512, pre_recording_buffer_duration: float = 1.0
) -> AudioBuffer:
    return AudioBuffer(
        sample_rate=SampleRate(sample_rate),
        buffer_size=BufferSize(buffer_size),
        pre_recording_buffer_duration=pre_recording_buffer_duration,
    )


@settings(max_examples=100)
@given(
    st.integers(min_value=1, max_value=200),
    st.integers(min_value=0, max_value=500),
    st.floats(min_value=0.1, max_value=3.0, allow_nan=False, allow_infinity=False),
)
def test_pre_roll_bounded_by_maxlen(num_chunks: int, value_seed: int, duration: float) -> None:
    buf = _new_buf(pre_recording_buffer_duration=duration)
    expected_maxlen = max(1, int((16000 // 512) * duration))
    for i in range(num_chunks):
        buf.add_to_pre_roll(_make_chunk(value=(value_seed + i) % 32000))
    assert buf.pre_roll_count == min(num_chunks, expected_maxlen)


@settings(max_examples=100)
@given(st.integers(min_value=2, max_value=100))
def test_pre_roll_fifo_eviction(num_chunks: int) -> None:
    # Tight maxlen so eviction definitely happens.
    buf = _new_buf(pre_recording_buffer_duration=0.1)  # ~3 frames at 31.25fps
    maxlen = max(1, int((16000 // 512) * 0.1))
    chunks = [_make_chunk(value=i, size=4) for i in range(num_chunks)]
    for c in chunks:
        buf.add_to_pre_roll(c)
    # After overflow, the deque holds the *last* maxlen items in FIFO order.
    buf.start_recording()
    expected_tail = chunks[-maxlen:]
    assert buf.frames == expected_tail


@settings(max_examples=100)
@given(
    st.integers(min_value=1, max_value=300),
    st.floats(min_value=0.01, max_value=5.0, allow_nan=False, allow_infinity=False),
)
def test_get_recent_audio_array_bounded_by_max_frames(num_frames: int, max_seconds: float) -> None:
    buf = _new_buf(pre_recording_buffer_duration=0.0)
    chunk_size = 512
    for i in range(num_frames):
        buf.add_frame(_make_chunk(value=i % 30000, size=chunk_size))
    arr = buf.get_recent_audio_array(max_seconds)
    fps = buf.frames_per_second()
    cap = max(1, int(max_seconds * fps))
    expected_frames = min(num_frames, cap)
    assert len(arr) == expected_frames * chunk_size


@settings(max_examples=100)
@given(st.integers(min_value=1, max_value=50), st.integers(min_value=2, max_value=64))
def test_duration_seconds_matches_byte_math(num_frames: int, samples_per_frame: int) -> None:
    sr = 16000
    buf = _new_buf(sample_rate=sr, pre_recording_buffer_duration=0.0)
    for i in range(num_frames):
        buf.add_frame(_make_chunk(value=i % 30000, size=samples_per_frame))
    total_bytes = num_frames * samples_per_frame * 2  # int16 = 2 bytes/sample
    expected = (total_bytes // 2) / sr
    assert math.isclose(buf.duration_seconds, expected, rel_tol=1e-9, abs_tol=1e-9)


@settings(max_examples=100)
@given(st.integers(min_value=0, max_value=10), st.integers(min_value=0, max_value=200))
def test_slice_out_of_range_returns_empty(num_frames: int, start: int) -> None:
    buf = _new_buf(pre_recording_buffer_duration=0.0)
    for _ in range(num_frames):
        buf.add_frame(_make_chunk(size=4))
    # Slice with start ≥ total or negative start → empty.
    if start >= num_frames:
        arr = buf.get_audio_array_slice(start)
        assert len(arr) == 0
    # Negative start always empty regardless of count.
    arr_neg = buf.get_audio_array_slice(-1)
    assert len(arr_neg) == 0


@settings(max_examples=100)
@given(
    st.integers(min_value=1, max_value=30),
    st.integers(min_value=0, max_value=30),
    st.integers(min_value=0, max_value=30),
)
def test_slice_start_ge_end_returns_empty(total: int, start: int, end_offset: int) -> None:
    buf = _new_buf(pre_recording_buffer_duration=0.0)
    for _ in range(total):
        buf.add_frame(_make_chunk(size=4))
    end = start + end_offset if end_offset > 0 else start  # end <= start
    if 0 <= start < total and start >= end:
        arr = buf.get_audio_array_slice(start, end)
        assert len(arr) == 0
