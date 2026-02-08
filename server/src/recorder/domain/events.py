from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RecorderEvent:
    timestamp: float


@dataclass(frozen=True)
class RecordingStarted(RecorderEvent):
    pass


@dataclass(frozen=True)
class RecordingStopped(RecorderEvent):
    pass


@dataclass(frozen=True)
class TranscriptionStarted(RecorderEvent):
    audio: bytes = b""


@dataclass(frozen=True)
class TranscriptionCompleted(RecorderEvent):
    text: str


@dataclass(frozen=True)
class VADStarted(RecorderEvent):
    pass


@dataclass(frozen=True)
class VADStopped(RecorderEvent):
    pass


@dataclass(frozen=True)
class VADDetectStarted(RecorderEvent):
    pass


@dataclass(frozen=True)
class VADDetectStopped(RecorderEvent):
    pass


@dataclass(frozen=True)
class TurnDetectionStarted(RecorderEvent):
    pass


@dataclass(frozen=True)
class TurnDetectionStopped(RecorderEvent):
    pass


@dataclass(frozen=True)
class WakeWordDetected(RecorderEvent):
    word_index: int
    word: str


@dataclass(frozen=True)
class WakeWordTimeout(RecorderEvent):
    pass


@dataclass(frozen=True)
class WakeWordDetectionStarted(RecorderEvent):
    pass


@dataclass(frozen=True)
class WakeWordDetectionEnded(RecorderEvent):
    pass


@dataclass(frozen=True)
class AudioChunkRecorded(RecorderEvent):
    chunk: bytes


@dataclass(frozen=True)
class RealtimeTranscriptionUpdate(RecorderEvent):
    text: str


@dataclass(frozen=True)
class RealtimeTranscriptionStabilized(RecorderEvent):
    text: str
