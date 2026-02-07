from __future__ import annotations

from src.building_blocks.errors import AudioError, DomainError, TranscriptionError


class InvalidStateTransition(DomainError):
    pass


class RecordingError(AudioError):
    pass


class AudioSourceError(AudioError):
    pass


class BufferOverflowError(AudioError):
    pass


class TranscriberNotReady(TranscriptionError):
    pass
