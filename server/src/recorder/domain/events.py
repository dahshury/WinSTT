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


@dataclass(frozen=True)
class ModelSwapStarted(RecorderEvent):
    """A model-swap (main or realtime) has begun.

    ``kind`` is ``"main"`` or ``"realtime"``. ``name`` is the resolved HF
    model id of the *new* model being loaded. The old model stays active
    and serves transcription requests until the swap completes — so PTT
    presses during a swap still work, just on the previous model.
    """

    kind: str
    name: str


@dataclass(frozen=True)
class ModelSwapCompleted(RecorderEvent):
    """The new model is loaded and is now the active transcriber.

    The old model has been shut down by this point and its ORT sessions
    are released. The next transcription call goes through the new model.
    """

    kind: str
    name: str


@dataclass(frozen=True)
class ModelSwapFailed(RecorderEvent):
    """A model swap aborted — load error, OOM, network failure, or cancel.

    The current transcriber is unchanged (the previous model remains
    active). The frontend should revert its picker to whatever the
    server's current model name is, and surface ``reason`` to the user.
    """

    kind: str
    name: str
    reason: str


@dataclass(frozen=True)
class DeviceSwitchFailed(RecorderEvent):
    """A live input-device switch failed and the audio source fell back.

    ``requested_index`` is the device the user (or settings sync) asked for.
    ``error_message`` is the human-readable reason from PortAudio. When
    ``fallback_index`` is None, the audio source has no working stream and
    subsequent reads return silence; when it is an int, the audio source
    fell back to that device (typically the system default) and audio is
    flowing again — the UI should still revert the user's selection and
    surface the failure.
    """

    requested_index: int
    error_message: str
    fallback_index: int | None
