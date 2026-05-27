from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from src.building_blocks.types import AudioArray


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    language_probability: float
    duration_seconds: float


class ITranscriber(ABC):
    @abstractmethod
    def transcribe(
        self,
        audio: AudioArray,
        language: str = "",
        use_prompt: bool = True,
        custom_words: list[str] | None = None,
        initial_prompt_text: str | None = None,
    ) -> TranscriptionResult: ...

    @abstractmethod
    def is_ready(self) -> bool: ...

    @abstractmethod
    def shutdown(self) -> None: ...
