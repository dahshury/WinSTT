"""Composite wake-word detector that requires BOTH Porcupine and openWakeWord
to fire within a short agreement window before declaring a detection.

Used for keywords supported by both engines (currently only "alexa") to cut the
false-positive rate roughly in half — each engine has its own characteristic
false-positives, and demanding cross-engine agreement rejects nearly all of
them while keeping recall high (mis-pronunciations that only one engine misses
still get caught by the other and are simply held until the second engine
confirms within the window).

The pipeline expects an `IWakeWordDetector`, so this class implements the same
port and is otherwise indistinguishable from the single-engine adapters.
"""

from __future__ import annotations

import contextlib
import time

from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.wake_word import IWakeWordDetector, WakeWordResult


class CompositeWakeWordDetector(IWakeWordDetector):
    """Run Porcupine and openWakeWord on every chunk, fire only when both agree.

    Both engines are kept independent — each maintains its own internal state
    and runs detection on every chunk. Agreement is tracked by remembering the
    monotonic-clock time of each engine's last positive fire; a detection is
    declared when the gap between the two most recent fires falls inside
    ``AGREEMENT_WINDOW_SECONDS``. The fire timestamps reset after a successful
    detection so the next session starts clean.
    """

    AGREEMENT_WINDOW_SECONDS = 1.5

    def __init__(
        self,
        *,
        wake_word: str,
        sensitivity: float = 0.6,
        buffer_size: int = 512,
    ) -> None:
        # Late imports keep this module importable in test environments
        # where pvporcupine / openwakeword aren't installed; construction
        # then fails clearly inside the per-engine adapter rather than at
        # module load.
        from src.recorder.infrastructure.oww_detector import OWWDetector
        from src.recorder.infrastructure.porcupine_detector import PorcupineDetector

        self._wake_word = wake_word
        self._porcupine = PorcupineDetector(
            wake_words=[wake_word],
            sensitivities=[sensitivity],
            buffer_size=buffer_size,
        )
        self._oww = OWWDetector(
            model_paths=[wake_word],
            sensitivity=sensitivity,
        )
        self._porcupine_last_fire: float | None = None
        self._oww_last_fire: float | None = None

    @override
    def detect(self, chunk: AudioChunk) -> WakeWordResult:
        now = time.monotonic()
        # Both engines see every chunk so each can independently decide. We
        # don't short-circuit on the first engine firing — the second engine's
        # internal state machine (e.g. openWakeWord's prediction buffer) needs
        # every chunk regardless, or it would lose context on the audio span
        # the trigger word was spoken over.
        if self._porcupine.detect(chunk).detected:
            self._porcupine_last_fire = now
        if self._oww.detect(chunk).detected:
            self._oww_last_fire = now
        if self._both_fired_within_window(now):
            self._porcupine_last_fire = None
            self._oww_last_fire = None
            return WakeWordResult(detected=True, word_index=0, word=self._wake_word)
        return WakeWordResult(detected=False, word_index=-1, word="")

    def _both_fired_within_window(self, now: float) -> bool:
        porc = self._porcupine_last_fire
        oww = self._oww_last_fire
        if porc is None or oww is None:
            return False
        # Both fires must be inside the window relative to "now" — otherwise
        # an old stale fire could pair with a fresh one and create a phantom
        # detection minutes after the user actually said the word.
        if now - porc > self.AGREEMENT_WINDOW_SECONDS:
            return False
        return now - oww <= self.AGREEMENT_WINDOW_SECONDS

    @override
    def cleanup(self) -> None:
        # Best-effort cleanup for each engine — if one fails to release its
        # native resources we still try the other so the recorder can shut
        # down cleanly. Swallowing exceptions matches the rest of the
        # infrastructure layer's cleanup semantics.
        with contextlib.suppress(Exception):
            self._porcupine.cleanup()
        with contextlib.suppress(Exception):
            self._oww.cleanup()
