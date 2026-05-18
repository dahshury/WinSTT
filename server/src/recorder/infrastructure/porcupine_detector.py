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
        wake_words: list[str],
        sensitivities: list[float] | None = None,
        buffer_size: int = 512,
    ) -> None:
        if pvporcupine is None:
            msg = "pvporcupine is not installed"
            raise RuntimeError(msg)
        if not wake_words:
            msg = "PorcupineDetector requires at least one wake word"
            raise ValueError(msg)
        keywords = [w.strip() for w in wake_words if w.strip()]
        sens = sensitivities or [0.6] * len(keywords)
        # pvporcupine 1.9.x signature — no access_key. The 2.0+ line requires
        # one for every user including free-tier; we stay on 1.9 to keep the
        # 14 built-in keywords usable without a Picovoice signup. Mirrors
        # examples/RealtimeSTT/audio_recorder.py L837-840.
        self._porcupine: Any = pvporcupine.create(
            keywords=keywords,
            sensitivities=sens,
        )
        self._wake_words = keywords
        # Porcupine 1.9 expects exactly `frame_length` samples per process()
        # call (typically 512 @ 16 kHz). Honor the engine's own frame_length
        # over the caller-supplied buffer_size so a misconfigured config
        # doesn't crash struct.unpack with "buffer too small".
        engine_frame_length = getattr(self._porcupine, "frame_length", buffer_size)
        self._buffer_size = engine_frame_length

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
