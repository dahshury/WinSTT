from __future__ import annotations

from abc import ABC, abstractmethod

from src.building_blocks.types import AudioArray
from src.recorder.domain.events import SpeakerSegment


class IDiarizer(ABC):
    """Per-utterance speaker diarizer with session-wide identity tracking.

    Calls to :meth:`diarize` share state — a speaker who appears in utterance
    N gets the same id when they reappear in utterance N+M. :meth:`reset`
    clears that state (used when the recorder restarts a session).
    """

    @abstractmethod
    def diarize(self, audio: AudioArray) -> tuple[SpeakerSegment, ...]:
        """Diarize a finalized utterance; return per-speaker time ranges."""

    @abstractmethod
    def reset(self) -> None:
        """Forget all session speakers — next utterance starts fresh ids."""

    @abstractmethod
    def shutdown(self) -> None:
        """Release any held resources (ORT sessions, model files)."""
