from __future__ import annotations

from typing_extensions import override

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import SpeakerSegment
from src.recorder.domain.ports.diarizer import IDiarizer


class FakeDiarizer(IDiarizer):
    """In-memory diarizer for tests.

    Returns ``segments`` from :meth:`diarize`, or raises ``raises`` when set
    (to exercise the fail-soft path in ``RecorderService._safe_diarize``).
    """

    def __init__(
        self,
        segments: tuple[SpeakerSegment, ...] = (),
        raises: Exception | None = None,
    ) -> None:
        self._segments = segments
        self._raises = raises
        self.diarize_calls = 0
        self.reset_calls = 0
        self.shutdown_calls = 0

    @override
    def diarize(self, audio: AudioArray) -> tuple[SpeakerSegment, ...]:
        self.diarize_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._segments

    @override
    def reset(self) -> None:
        self.reset_calls += 1

    @override
    def shutdown(self) -> None:
        self.shutdown_calls += 1
