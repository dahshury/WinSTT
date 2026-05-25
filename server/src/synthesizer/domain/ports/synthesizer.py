from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class SynthesisChunk:
    """One slice of synthesized audio, emitted as the stream proceeds.

    ``audio`` is a 1-D float32 array of PCM samples at ``sample_rate``.
    ``seq`` is monotonic per stream; ``is_final`` flags the last chunk.
    """

    audio: NDArray[np.float32]
    sample_rate: int
    seq: int
    is_final: bool


@dataclass(frozen=True)
class VoiceInfo:
    """One available voice — surfaced to the UI for the voice picker."""

    id: str
    label: str
    language: str
    gender: str


class ISpeechSynthesizer(ABC):
    """Streaming text-to-speech port.

    Implementations split text into sentences internally and yield audio
    per sentence so playback can start before the full passage finishes.
    """

    @abstractmethod
    def synthesize_stream(
        self,
        text: str,
        voice: str,
        lang: str,
        speed: float,
    ) -> AsyncIterator[SynthesisChunk]:
        """Yield audio chunks as synthesis proceeds.

        Implementations are expected to be ``async def`` functions with
        ``yield`` statements (i.e. async generators). The abstract is
        declared without ``async`` so subclasses can return any
        ``AsyncIterator`` shape without mypy complaining about a
        return-type mismatch.

        Cancellation: the consumer can stop iterating; implementations
        must release any in-flight work on next yield boundary.
        """

    @abstractmethod
    def list_voices(self) -> list[VoiceInfo]:
        """Return every voice the loaded model can render."""

    @abstractmethod
    def is_ready(self) -> bool:
        """True once the underlying ONNX session and voicepacks are loaded."""

    @abstractmethod
    def warm_up(self) -> None:
        """Force the engine pack download + ONNX session load now.

        Synchronous and blocking — callers wishing to keep the asyncio
        loop live must run this in an executor. Raises on download / load
        failure so the caller can surface it to the user; succeeds as a
        no-op once already ready (idempotent).
        """

    @abstractmethod
    def shutdown(self) -> None:
        """Release native resources. Idempotent."""
