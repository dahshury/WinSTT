from __future__ import annotations

from src.recorder.application.dto import (
    RealtimeUpdateDTO,
    RecordingStatusDTO,
    TranscriptionResultDTO,
)
from src.recorder.domain.state_machine import RecorderState


class TestDTOs:
    def test_transcription_result_dto(self) -> None:
        dto = TranscriptionResultDTO(text="hello", language="en", language_probability=0.99, duration_seconds=1.5)
        assert dto.text == "hello"
        assert dto.language == "en"

    def test_recording_status_dto(self) -> None:
        dto = RecordingStatusDTO(state=RecorderState.RECORDING, is_recording=True, duration_seconds=2.5)
        assert dto.state == RecorderState.RECORDING
        assert dto.is_recording is True

    def test_realtime_update_dto(self) -> None:
        dto = RealtimeUpdateDTO(text="partial text", is_stabilized=False)
        assert dto.text == "partial text"
        assert dto.is_stabilized is False
