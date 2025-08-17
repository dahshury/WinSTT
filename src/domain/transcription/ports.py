"""Domain ports and DTOs for transcription engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class TranscriptionOutput:
    """Lightweight DTO returned by the engine (no external deps)."""
    text: str
    segments: list[dict[str, Any]] | None = None


class TranscriptionEnginePort(Protocol):
    """Domain-facing transcription engine port."""

    def transcribe(self, audio_input: Any, return_segments: bool = True) -> TranscriptionOutput: ...


