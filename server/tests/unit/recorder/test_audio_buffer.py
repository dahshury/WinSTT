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
