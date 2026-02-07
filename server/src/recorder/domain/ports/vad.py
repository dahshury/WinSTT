from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from src.building_blocks.types import AudioChunk


@dataclass(frozen=True)
class VADResult:
    is_speech: bool
    confidence: float


class IVoiceActivityDetector(ABC):
    @abstractmethod
    def detect(self, chunk: AudioChunk) -> VADResult: ...

    @abstractmethod
    def reset(self) -> None: ...
