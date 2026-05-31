from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.wake_word import IWakeWordDetector, WakeWordResult


class FakeWakeWordDetector(IWakeWordDetector):
    def __init__(
        self,
        detect_at_call: int = -1,
        word: str = "jarvis",
    ) -> None:
        self._detect_at_call = detect_at_call
        self._word = word
        self._call_count = 0
        self._cleanup_called = False

    @override
    def detect(self, chunk: AudioChunk) -> WakeWordResult:
        self._call_count += 1
        if self._detect_at_call >= 0 and self._call_count == self._detect_at_call:
            return WakeWordResult(detected=True, word_index=0, word=self._word)
        return WakeWordResult(detected=False, word_index=-1, word="")

    @override
    def cleanup(self) -> None:
        self._cleanup_called = True

    @property
    def call_count(self) -> int:
        return self._call_count

    @property
    def cleanup_called(self) -> bool:
        return self._cleanup_called
