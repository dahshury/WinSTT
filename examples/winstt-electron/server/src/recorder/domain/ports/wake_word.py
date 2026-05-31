from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from src.building_blocks.types import AudioChunk


@dataclass(frozen=True)
class WakeWordResult:
    detected: bool
    word_index: int
    word: str


class IWakeWordDetector(ABC):
    @abstractmethod
    def detect(self, chunk: AudioChunk) -> WakeWordResult: ...

    @abstractmethod
    def cleanup(self) -> None: ...
