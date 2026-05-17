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
    active, or has been rebuilt via the swap worker's restore path).
    The frontend uses ``category`` to pick a localised toast variant
    (network icon, OOM advice, etc.) and falls back to ``reason`` as
    the human-readable headline. ``detail`` carries the technical
    string for diagnostic logs / bug reports.

    Defaulted ``category`` / ``detail`` so older callers that emit only
    a flat reason still construct successfully — see
    :func:`src.recorder.domain.swap_errors.classify_swap_error` for the
    canonical mapping.
    """

    kind: str
    name: str
    reason: str
    category: str = "unknown"
    detail: str = ""


@dataclass(frozen=True)
class VADSensitivityAdapted(RecorderEvent):
    """Cross-utterance VAD calibrator settled on a new Silero sensitivity.

    Fires once per recording with a non-empty transcription, after the
    calibrator updates the running ``SileroVAD.sensitivity``. The renderer
    keeps a per-input-device map of the last adapted value so subsequent
    sessions seed adaptation with the right starting point for the device
    in use.
    """

    new_sensitivity: float
    noise_floor_rms: float
    speech_peak_rms: float


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


@dataclass(frozen=True)
class SpeakerSegment:
    """One speaker-attributed time range within an utterance."""

    start: float
    """Segment start in seconds, relative to utterance start."""
    end: float
    """Segment end in seconds, relative to utterance start."""
    speaker: int
    """Stable session-wide speaker id assigned by the online clusterer."""


@dataclass(frozen=True)
class SpeakerSegmentsDetected(RecorderEvent):
    """Diarization completed for the just-transcribed utterance.

    Fires immediately after :class:`TranscriptionCompleted` when
    ``DiarizationConfig.enabled`` is true. ``segments`` may be empty if the
    audio contained no detectable speech (silence, sub-threshold noise) —
    consumers should treat that case as "single unknown speaker" rather than
    an error.
    """

    segments: tuple[SpeakerSegment, ...]


@dataclass(frozen=True)
class DeviceBecameAvailable(RecorderEvent):
    """A previously-absent input device is now openable.

    Fires when the audio source's hotplug-wait state ends — either because
    the server booted with no microphone and the OS later exposed one, or
    because a working device was unplugged mid-run and a replacement has
    been attached. ``device_index`` is the PyAudio input-device index now
    in use. Paired with ``DeviceSwitchFailed``: failure tells the UI to
    revert; this one tells the UI "you can record again".
    """

    device_index: int
