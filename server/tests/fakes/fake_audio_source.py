from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioChunk, BufferSize, SampleRate
from src.recorder.domain.ports.audio_source import IAudioSource

_DEFAULT_SAMPLE_RATE = SampleRate(16000)
_DEFAULT_BUFFER_SIZE = BufferSize(512)


class FakeAudioSource(IAudioSource):
    def __init__(
        self,
        chunks: list[AudioChunk] | None = None,
        sample_rate: SampleRate = _DEFAULT_SAMPLE_RATE,
        buffer_size: BufferSize = _DEFAULT_BUFFER_SIZE,
    ) -> None:
        self._chunks: list[AudioChunk] = list(chunks) if chunks else []
        self._index = 0
        self._sample_rate = sample_rate
        self._buffer_size = buffer_size
        self._active = False
        self._setup_called = False

    @override
    def setup(self) -> None:
        self._active = True
        self._setup_called = True

    @override
    def read_chunk(self) -> AudioChunk:
        if self._index < len(self._chunks):
            chunk = self._chunks[self._index]
            self._index += 1
            return chunk
        return b"\x00" * (self._buffer_size * 2)

    @override
    def cleanup(self) -> None:
        self._active = False

    @override
    def is_active(self) -> bool:
        return self._active

    @property
    @override
    def sample_rate(self) -> SampleRate:
        return self._sample_rate

    @property
    @override
    def buffer_size(self) -> BufferSize:
        return self._buffer_size

    def feed(self, chunk: AudioChunk) -> None:
        self._chunks.append(chunk)

    @property
    def setup_called(self) -> bool:
        return self._setup_called
