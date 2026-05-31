from __future__ import annotations

from dataclasses import dataclass

from src.recorder.domain.state_machine import RecorderState


@dataclass(frozen=True)
class TranscriptionResultDTO:
    text: str
    language: str
    language_probability: float
    duration_seconds: float


@dataclass(frozen=True)
class RecordingStatusDTO:
    state: RecorderState
    is_recording: bool
    duration_seconds: float


@dataclass(frozen=True)
class RealtimeUpdateDTO:
    text: str
    is_stabilized: bool
