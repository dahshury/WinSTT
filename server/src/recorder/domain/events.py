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
class NoAudioDetected(RecorderEvent):
    """Emitted when a manual stop (PTT release) finds no transcribable audio."""


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
class AudioLevelComputed(RecorderEvent):
    level: float  # 0.0-1.0 normalized RMS


@dataclass(frozen=True)
class AudioChunkRecorded(RecorderEvent):
    chunk: bytes


@dataclass(frozen=True)
class RealtimeTranscriptionUpdate(RecorderEvent):
    text: str


@dataclass(frozen=True)
class RealtimeTranscriptionStabilized(RecorderEvent):
    text: str


@dataclass(frozen=True)
class DownloadProgress:
    """Rich progress snapshot for model downloads."""

    model: str
    progress: float  # 0.0 - 1.0
    downloaded_bytes: int
    total_bytes: int
    speed_bps: float  # bytes per second
    eta_seconds: float  # estimated seconds remaining (0 when done)


@dataclass(frozen=True)
class ModelDownloadStarted(RecorderEvent):
    model: str


@dataclass(frozen=True)
class ModelDownloadProgress(RecorderEvent):
    model: str
    progress: float
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    eta_seconds: float = 0.0


@dataclass(frozen=True)
class ModelDownloadCompleted(RecorderEvent):
    model: str
