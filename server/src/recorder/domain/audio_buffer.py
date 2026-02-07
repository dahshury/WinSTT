from __future__ import annotations

import collections

import numpy as np

from src.building_blocks.types import AudioArray, AudioChunk, BufferSize, SampleRate

INT16_MAX_ABS_VALUE = 32768.0


class AudioBuffer:
    def __init__(
        self,
        *,
        sample_rate: SampleRate,
        buffer_size: BufferSize,
        pre_recording_buffer_duration: float,
    ) -> None:
        self._sample_rate = sample_rate
        self._buffer_size = buffer_size
        maxlen = int((sample_rate // buffer_size) * pre_recording_buffer_duration)
        self._pre_roll: collections.deque[AudioChunk] = collections.deque(maxlen=maxlen if maxlen > 0 else 1)
        self._frames: list[AudioChunk] = []
        last_words_maxlen = max(1, int((sample_rate // buffer_size) * 0.3))
        self._last_words: collections.deque[AudioChunk] = collections.deque(maxlen=last_words_maxlen)

    def add_to_pre_roll(self, chunk: AudioChunk) -> None:
        self._pre_roll.append(chunk)

    def start_recording(self) -> None:
        self._frames = list(self._pre_roll)
        self._pre_roll.clear()

    def add_frame(self, chunk: AudioChunk) -> None:
        self._frames.append(chunk)

    def clear(self) -> None:
        self._frames.clear()
        self._pre_roll.clear()

    def get_audio_array(self) -> AudioArray:
        if not self._frames:
            return np.array([], dtype=np.float32)
        raw = b"".join(self._frames)
        audio_int16 = np.frombuffer(raw, dtype=np.int16)
        return (audio_int16.astype(np.float32) / INT16_MAX_ABS_VALUE).astype(np.float32)

    def backdate(self, seconds: float) -> None:
        if seconds <= 0 or not self._frames:
            return
        frames_per_second = self._sample_rate / self._buffer_size
        frames_to_remove = int(seconds * frames_per_second)
        if frames_to_remove >= len(self._frames):
            self._frames.clear()
        else:
            self._frames = self._frames[: len(self._frames) - frames_to_remove]

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    @property
    def pre_roll_count(self) -> int:
        return len(self._pre_roll)

    @property
    def frames(self) -> list[AudioChunk]:
        return self._frames

    @property
    def last_words_buffer(self) -> collections.deque[AudioChunk]:
        return self._last_words

    def add_to_last_words(self, chunk: AudioChunk) -> None:
        self._last_words.append(chunk)

    @property
    def duration_seconds(self) -> float:
        if not self._frames:
            return 0.0
        total_bytes = sum(len(f) for f in self._frames)
        total_samples = total_bytes // 2  # 16-bit = 2 bytes per sample
        return total_samples / self._sample_rate
