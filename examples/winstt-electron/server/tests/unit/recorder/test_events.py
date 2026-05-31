from __future__ import annotations

from src.recorder.domain.events import (
    AudioChunkRecorded,
    RealtimeTranscriptionStabilized,
    RealtimeTranscriptionUpdate,
    RecorderEvent,
    RecordingStarted,
    RecordingStopped,
    TranscriptionCompleted,
    TranscriptionStarted,
    TurnDetectionStarted,
    TurnDetectionStopped,
    VADDetectStarted,
    VADDetectStopped,
    VADStarted,
    VADStopped,
    WakeWordDetected,
    WakeWordDetectionEnded,
    WakeWordDetectionStarted,
    WakeWordTimeout,
)


class TestEvents:
    def test_all_inherit_from_recorder_event(self) -> None:
        event_classes = [
            RecordingStarted,
            RecordingStopped,
            TranscriptionStarted,
            TranscriptionCompleted,
            VADStarted,
            VADStopped,
            VADDetectStarted,
            VADDetectStopped,
            TurnDetectionStarted,
            TurnDetectionStopped,
            WakeWordDetected,
            WakeWordTimeout,
            WakeWordDetectionStarted,
            WakeWordDetectionEnded,
            AudioChunkRecorded,
            RealtimeTranscriptionUpdate,
            RealtimeTranscriptionStabilized,
        ]
        for cls in event_classes:
            assert issubclass(cls, RecorderEvent)

    def test_frozen(self) -> None:
        event = RecordingStarted(timestamp=1.0)
        try:
            event.timestamp = 2.0  # type: ignore[misc]
            raise AssertionError("Should have raised")
        except AttributeError:
            pass

    def test_transcription_completed_has_text(self) -> None:
        event = TranscriptionCompleted(timestamp=1.0, text="hello")
        assert event.text == "hello"

    def test_wake_word_detected_fields(self) -> None:
        event = WakeWordDetected(timestamp=1.0, word_index=0, word="jarvis")
        assert event.word_index == 0
        assert event.word == "jarvis"

    def test_transcription_started_audio_default(self) -> None:
        event = TranscriptionStarted(timestamp=1.0)
        assert event.audio == b""

    def test_transcription_started_audio_with_data(self) -> None:
        event = TranscriptionStarted(timestamp=1.0, audio=b"\x00\x01\x02\x03")
        assert event.audio == b"\x00\x01\x02\x03"

    def test_audio_chunk_recorded(self) -> None:
        event = AudioChunkRecorded(timestamp=1.0, chunk=b"\x00\x01")
        assert event.chunk == b"\x00\x01"
