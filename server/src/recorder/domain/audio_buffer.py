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
            return np.array([], dtype=np.float32)
        frames_per_second = self._sample_rate / self._buffer_size
        max_frames = max(1, int(max_seconds * frames_per_second))
        recent_frames = self._frames[-max_frames:] if len(self._frames) > max_frames else self._frames
        raw = b"".join(recent_frames)
        audio_int16 = np.frombuffer(raw, dtype=np.int16)
        return (audio_int16.astype(np.float32) / INT16_MAX_ABS_VALUE).astype(np.float32)

    def get_audio_array_slice(self, start_frame: int, end_frame: int | None = None) -> AudioArray:
        """Return audio between two frame indices as a float32 array.

        Used by the realtime worker's stable-text accumulator: the worker
        keeps a watermark of frames already committed to the stable text
        and only transcribes audio past that watermark. ``frames`` is a
        plain list so a torn read is at worst a stale length — never a
        crash.
        """
        frames = self._frames
        total = len(frames)
        if start_frame >= total or start_frame < 0:
            return np.array([], dtype=np.float32)
        end = total if end_frame is None else min(end_frame, total)
        if start_frame >= end:
            return np.array([], dtype=np.float32)
        raw = b"".join(frames[start_frame:end])
        audio_int16 = np.frombuffer(raw, dtype=np.int16)
        return (audio_int16.astype(np.float32) / INT16_MAX_ABS_VALUE).astype(np.float32)

    def frames_per_second(self) -> float:
        return self._sample_rate / self._buffer_size

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
