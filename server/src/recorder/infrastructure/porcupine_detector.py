from __future__ import annotations

import struct
from typing import Any

from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.wake_word import IWakeWordDetector, WakeWordResult

try:
    import pvporcupine
except ImportError:
    pvporcupine = None


class PorcupineDetector(IWakeWordDetector):
    def __init__(
        self,
        *,
        access_key: str,
        wake_words: list[str],
        sensitivities: list[float] | None = None,
        buffer_size: int = 512,
    ) -> None:
        if pvporcupine is None:
            msg = "pvporcupine is not installed"
            raise RuntimeError(msg)
        keywords = [w.strip() for w in wake_words if w.strip()]
        sens = sensitivities or [0.6] * len(keywords)
        self._porcupine: Any = pvporcupine.create(
            access_key=access_key,
            keywords=keywords,
            sensitivities=sens,
        )
        self._wake_words = keywords
        self._buffer_size = buffer_size

    @override
    def detect(self, chunk: AudioChunk) -> WakeWordResult:
        pcm = struct.unpack_from(f"{self._buffer_size}h", chunk)
        index: int = self._porcupine.process(pcm)
        if index >= 0:
            word = self._wake_words[index] if index < len(self._wake_words) else ""
            return WakeWordResult(detected=True, word_index=index, word=word)
        return WakeWordResult(detected=False, word_index=-1, word="")

    @override
    def cleanup(self) -> None:
        if self._porcupine is not None:
            self._porcupine.delete()
