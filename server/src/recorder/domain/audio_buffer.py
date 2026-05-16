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

    @staticmethod
    def _empty_array() -> AudioArray:
        return np.array([], dtype=np.float32)

    @staticmethod
    def _frames_to_float32(frames: list[AudioChunk]) -> AudioArray:
        raw = b"".join(frames)
        audio_int16 = np.frombuffer(raw, dtype=np.int16)
        return (audio_int16.astype(np.float32) / INT16_MAX_ABS_VALUE).astype(np.float32)

    def get_audio_array(self) -> AudioArray:
        if not self._frames:
            return self._empty_array()
        return self._frames_to_float32(self._frames)

    def get_recent_audio_array(self, max_seconds: float) -> AudioArray:
        """Return the most recent ``max_seconds`` of audio as a float32 array.

        Used by the realtime worker so the transcriber sees a bounded
        sliding window. Without this cap, faster_whisper's
        BatchedInferencePipeline splits audio at 30s VAD chunk boundaries
        — the first chunk's transcribed text becomes identical on every
        call, which inflates similarity past 0.99 and trips the
        noise-repetition recorder stop in stt_server/text_processing.py.
        """
        if not self._frames or max_seconds <= 0:
            return self._empty_array()
        max_frames = max(1, int(max_seconds * self.frames_per_second()))
        return self._frames_to_float32(self._tail_frames(max_frames))

    def _tail_frames(self, max_frames: int) -> list[AudioChunk]:
        """Last ``max_frames`` frames, or all of them when fewer exist."""
        if len(self._frames) > max_frames:
            return self._frames[-max_frames:]
        return self._frames

    def get_audio_array_slice(self, start_frame: int, end_frame: int | None = None) -> AudioArray:
        """Return audio between two frame indices as a float32 array.

        Used by the realtime worker's stable-text accumulator: the worker
        keeps a watermark of frames already committed to the stable text
        and only transcribes audio past that watermark. ``frames`` is a
        plain list so a torn read is at worst a stale length — never a
        crash.
        """
        frames = self._frames
        bounds = self._resolve_slice_bounds(len(frames), start_frame, end_frame)
        if bounds is None:
            return self._empty_array()
        start, end = bounds
        return self._frames_to_float32(frames[start:end])

    @staticmethod
    def _clamp_end(total: int, end_frame: int | None) -> int:
        if end_frame is None:
            return total
        return min(end_frame, total)

    @classmethod
    def _resolve_slice_bounds(cls, total: int, start_frame: int, end_frame: int | None) -> tuple[int, int] | None:
        start_in_range = 0 <= start_frame < total
        if not start_in_range:
            return None
        end = cls._clamp_end(total, end_frame)
        if start_frame >= end:
            return None
        return start_frame, end

    def frames_per_second(self) -> float:
        return self._sample_rate / self._buffer_size

    def _is_noop_backdate(self, seconds: float) -> bool:
        return seconds <= 0 or not self._frames

    def backdate(self, seconds: float) -> None:
        if self._is_noop_backdate(seconds):
            return
        frames_to_remove = int(seconds * self.frames_per_second())
        keep = len(self._frames) - frames_to_remove
        self._frames = self._frames[:keep] if keep > 0 else []

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
