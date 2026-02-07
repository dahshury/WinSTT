from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult


class FakeVAD(IVoiceActivityDetector):
    def __init__(
        self,
        speech_pattern: list[bool] | None = None,
    ) -> None:
        self._pattern: list[bool] = list(speech_pattern) if speech_pattern else []
        self._index = 0
        self._reset_count = 0

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        if self._index < len(self._pattern):
            is_speech = self._pattern[self._index]
            self._index += 1
        else:
            is_speech = False
        return VADResult(is_speech=is_speech, confidence=1.0 if is_speech else 0.0)

    @override
    def reset(self) -> None:
        self._index = 0
        self._reset_count += 1

    @property
    def reset_count(self) -> int:
        return self._reset_count

    def set_pattern(self, pattern: list[bool]) -> None:
        self._pattern = list(pattern)
        self._index = 0
