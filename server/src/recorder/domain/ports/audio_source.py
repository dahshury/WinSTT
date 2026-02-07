from __future__ import annotations

from abc import ABC, abstractmethod

from src.building_blocks.types import AudioChunk, BufferSize, SampleRate


class IAudioSource(ABC):
    @abstractmethod
    def setup(self) -> None: ...

    @abstractmethod
    def read_chunk(self) -> AudioChunk: ...

    @abstractmethod
    def cleanup(self) -> None: ...

    @abstractmethod
    def is_active(self) -> bool: ...

    @property
    @abstractmethod
    def sample_rate(self) -> SampleRate: ...

    @property
    @abstractmethod
    def buffer_size(self) -> BufferSize: ...
