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

    @abstractmethod
    def switch_device(self, device_index: int | None) -> None: ...

    @abstractmethod
    def pause(self) -> None:
        """Stop actively capturing from the hardware (OS mic indicator turns off).

        Idempotent — calling pause() on an already-paused source is a no-op.
        ``read_chunk()`` must still be safe to call on a paused source; it
        should return silence so the reader thread doesn't crash.
        """

    @abstractmethod
    def resume(self) -> None:
        """Restart hardware capture after a prior pause(). Idempotent."""

    @property
    @abstractmethod
    def is_capturing(self) -> bool:
        """True when the hardware is actively capturing (not paused).

        Distinct from ``is_active()`` (whether the source was set up at all)
        — a source can be active but paused.
        """

    @property
    @abstractmethod
    def sample_rate(self) -> SampleRate: ...

    @property
    @abstractmethod
    def buffer_size(self) -> BufferSize: ...
