from __future__ import annotations

import struct

import numpy as np

from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.domain.audio_buffer import INT16_MAX_ABS_VALUE, AudioBuffer


def _make_chunk(value: int = 0, size: int = 512) -> bytes:
    return struct.pack(f"<{size}h", *([value] * size))


class TestAudioBuffer:
    def test_pre_roll_maxlen(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=1.0,
        )
        maxlen = int((16000 // 512) * 1.0)
        for i in range(maxlen + 10):
            buf.add_to_pre_roll(_make_chunk(value=i))
        assert buf.pre_roll_count == maxlen

    def test_start_recording_drains_pre_roll(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=1.0,
        )
        buf.add_to_pre_roll(_make_chunk(value=1))
        buf.add_to_pre_roll(_make_chunk(value=2))
        buf.start_recording()
        assert buf.frame_count == 2
        assert buf.pre_roll_count == 0

    def test_add_frame(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        buf.add_frame(_make_chunk())
        assert buf.frame_count == 1

    def test_clear(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=1.0,
        )
        buf.add_to_pre_roll(_make_chunk())
        buf.start_recording()
        buf.add_frame(_make_chunk())
        buf.clear()
        assert buf.frame_count == 0
        assert buf.pre_roll_count == 0

    def test_get_audio_array_empty(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        arr = buf.get_audio_array()
        assert len(arr) == 0
        assert arr.dtype == np.float32

    def test_get_audio_array_converts_int16_to_float32(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        buf.add_frame(_make_chunk(value=16384))
        arr = buf.get_audio_array()
        assert arr.dtype == np.float32
        expected = 16384.0 / INT16_MAX_ABS_VALUE
        np.testing.assert_allclose(arr[0], expected, rtol=1e-5)

    def test_backdate_removes_trailing_frames(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        for _ in range(100):
            buf.add_frame(_make_chunk())
        assert buf.frame_count == 100
        buf.backdate(0.5)  # ~15 frames at 16000/512=31.25 fps
        assert buf.frame_count < 100

    def test_backdate_zero_is_noop(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        buf.add_frame(_make_chunk())
        buf.backdate(0.0)
        assert buf.frame_count == 1

    def test_backdate_clears_all_when_large_value(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        for _ in range(5):
            buf.add_frame(_make_chunk())
        assert buf.frame_count == 5
        buf.backdate(999.0)  # Way more frames than exist
        assert buf.frame_count == 0

    def test_duration_seconds_empty(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        assert buf.duration_seconds == 0.0

    def test_duration_seconds(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        buf.add_frame(_make_chunk(size=512))
        # 512 samples * 2 bytes = 1024 bytes -> 512 samples at 16000 Hz = 0.032s
        assert abs(buf.duration_seconds - 512 / 16000) < 0.001

    def test_frames_property_returns_frames_list(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        c1 = _make_chunk(value=1)
        c2 = _make_chunk(value=2)
        buf.add_frame(c1)
        buf.add_frame(c2)
        assert buf.frames == [c1, c2]

    def test_frames_property_empty(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        assert buf.frames == []

    def test_last_words_buffer_property(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        c = _make_chunk(value=42)
        buf.add_to_last_words(c)
        assert list(buf.last_words_buffer) == [c]

    def test_last_words_buffer_maxlen(self) -> None:
        buf = AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )
        maxlen = max(1, int((16000 // 512) * 0.3))
        for i in range(maxlen + 5):
            buf.add_to_last_words(_make_chunk(value=i))
        assert len(buf.last_words_buffer) == maxlen

    @staticmethod
    def _new_buf() -> AudioBuffer:
        return AudioBuffer(
            sample_rate=SampleRate(16000),
            buffer_size=BufferSize(512),
            pre_recording_buffer_duration=0.0,
        )

    def test_get_recent_audio_array_empty_buffer(self) -> None:
        buf = self._new_buf()
        arr = buf.get_recent_audio_array(1.0)
        assert len(arr) == 0
        assert arr.dtype == np.float32

    def test_get_recent_audio_array_zero_seconds(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk(value=1))
        arr = buf.get_recent_audio_array(0.0)
        assert len(arr) == 0
        assert arr.dtype == np.float32

    def test_get_recent_audio_array_negative_seconds(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk(value=1))
        arr = buf.get_recent_audio_array(-5.0)
        assert len(arr) == 0

    def test_get_recent_audio_array_larger_than_buffer_returns_all(self) -> None:
        buf = self._new_buf()
        for _ in range(3):
            buf.add_frame(_make_chunk(value=7, size=512))
        # 999s window far exceeds the 3 buffered frames -> all frames returned.
        arr = buf.get_recent_audio_array(999.0)
        assert len(arr) == 3 * 512
        np.testing.assert_allclose(arr[0], 7.0 / INT16_MAX_ABS_VALUE, rtol=1e-5)

    def test_get_recent_audio_array_caps_to_recent_window(self) -> None:
        buf = self._new_buf()
        # 31.25 fps; many frames so a tiny window trims to the tail.
        for i in range(200):
            buf.add_frame(_make_chunk(value=i, size=512))
        arr = buf.get_recent_audio_array(0.1)  # max(1, int(0.1*31.25)) = 3 frames
        assert len(arr) == 3 * 512
        # Tail frames are the highest indices (197, 198, 199).
        np.testing.assert_allclose(arr[0], 197.0 / INT16_MAX_ABS_VALUE, rtol=1e-5)

    def test_get_recent_audio_array_exact_boundary(self) -> None:
        buf = self._new_buf()
        fps = buf.frames_per_second()
        # Exactly max_frames frames in the buffer -> not strictly greater, returns all.
        max_frames = max(1, int(1.0 * fps))
        for _ in range(max_frames):
            buf.add_frame(_make_chunk(value=3, size=512))
        arr = buf.get_recent_audio_array(1.0)
        assert len(arr) == max_frames * 512

    def test_get_audio_array_slice_empty_buffer(self) -> None:
        buf = self._new_buf()
        arr = buf.get_audio_array_slice(0)
        assert len(arr) == 0
        assert arr.dtype == np.float32

    def test_get_audio_array_slice_negative_start(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk(value=1))
        arr = buf.get_audio_array_slice(-1)
        assert len(arr) == 0

    def test_get_audio_array_slice_start_beyond_total(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk(value=1))
        arr = buf.get_audio_array_slice(5)
        assert len(arr) == 0

    def test_get_audio_array_slice_start_equals_total(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk(value=1))
        arr = buf.get_audio_array_slice(1)
        assert len(arr) == 0

    def test_get_audio_array_slice_default_end_returns_tail(self) -> None:
        buf = self._new_buf()
        for i in range(4):
            buf.add_frame(_make_chunk(value=i + 1, size=512))
        arr = buf.get_audio_array_slice(2)
        assert len(arr) == 2 * 512
        np.testing.assert_allclose(arr[0], 3.0 / INT16_MAX_ABS_VALUE, rtol=1e-5)

    def test_get_audio_array_slice_explicit_end(self) -> None:
        buf = self._new_buf()
        for i in range(5):
            buf.add_frame(_make_chunk(value=i + 1, size=512))
        arr = buf.get_audio_array_slice(1, 3)
        assert len(arr) == 2 * 512
        np.testing.assert_allclose(arr[0], 2.0 / INT16_MAX_ABS_VALUE, rtol=1e-5)

    def test_get_audio_array_slice_end_clamped_to_total(self) -> None:
        buf = self._new_buf()
        for i in range(3):
            buf.add_frame(_make_chunk(value=i + 1, size=512))
        arr = buf.get_audio_array_slice(0, 999)
        assert len(arr) == 3 * 512

    def test_get_audio_array_slice_start_ge_end_empty(self) -> None:
        buf = self._new_buf()
        for _ in range(5):
            buf.add_frame(_make_chunk(value=1))
        arr = buf.get_audio_array_slice(3, 2)
        assert len(arr) == 0

    def test_get_audio_array_slice_start_equals_end_empty(self) -> None:
        buf = self._new_buf()
        for _ in range(5):
            buf.add_frame(_make_chunk(value=1))
        arr = buf.get_audio_array_slice(2, 2)
        assert len(arr) == 0

    def test_backdate_negative_is_noop(self) -> None:
        buf = self._new_buf()
        buf.add_frame(_make_chunk())
        buf.backdate(-1.0)
        assert buf.frame_count == 1

    def test_backdate_empty_buffer_is_noop(self) -> None:
        buf = self._new_buf()
        buf.backdate(1.0)
        assert buf.frame_count == 0

    def test_backdate_exact_boundary_clears_all(self) -> None:
        buf = self._new_buf()
        fps = buf.frames_per_second()
        n = 10
        for _ in range(n):
            buf.add_frame(_make_chunk())
        # Choose seconds so frames_to_remove == n exactly -> keep == 0 -> [].
        buf.backdate(n / fps)
        assert buf.frame_count == 0

    def test_backdate_partial_keeps_head_frames(self) -> None:
        buf = self._new_buf()
        for i in range(50):
            buf.add_frame(_make_chunk(value=i))
        buf.backdate(0.2)  # ~6 frames at 31.25 fps
        assert 0 < buf.frame_count < 50
