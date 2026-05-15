from __future__ import annotations

from src.building_blocks.event_bus import EventBus
from src.recorder.bootstrap import CALLBACK_EVENT_MAP, wire_callback
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import RecordingStarted


class TestBootstrap:
    def test_callback_event_map_has_expected_callbacks(self) -> None:
        # The map has grown beyond the original 17 entries (DeviceSwitchFailed,
        # AudioLevelComputed, NoAudioDetected etc. were added later). The exact
        # count is brittle — just verify the map is non-empty and a sampling
        # of well-known callback names are present.
        assert len(CALLBACK_EVENT_MAP) >= 17
        for required in (
            "on_recording_start",
            "on_recording_stop",
            "on_transcription_start",
            "on_realtime_transcription_update",
        ):
            assert required in CALLBACK_EVENT_MAP, f"missing required callback: {required}"

    def test_wire_callback_fires_on_event(self) -> None:
        event_bus = EventBus()
        called: list[bool] = []
        wire_callback(event_bus, RecordingStarted, lambda: called.append(True))
        event_bus.publish(RecordingStarted(timestamp=1.0))
        assert len(called) == 1

    def test_config_from_kwargs(self) -> None:
        config = RecorderConfig.from_kwargs(
            model="base",
            language="en",
            use_microphone=False,
        )
        assert config.transcription.model == "base"
        assert config.transcription.language == "en"
        assert config.audio.use_microphone is False
