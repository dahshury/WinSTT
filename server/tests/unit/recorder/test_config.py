from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.recorder.domain.config import (
    AudioConfig,
    DiarizationConfig,
    EndpointConfig,
    RealtimeConfig,
    RecorderConfig,
    TranscriptionConfig,
    UIConfig,
    VADConfig,
    WakeWordConfig,
)


class TestRecorderConfig:
    def test_defaults(self) -> None:
        config = RecorderConfig()
        assert config.audio.sample_rate == 16000
        assert config.audio.buffer_size == 512
        assert config.vad.silero_sensitivity == 0.4
        assert config.transcription.model == "tiny"
        assert config.wake_word.wakeword_backend == ""

    def test_silero_sensitivity_validation(self) -> None:
        with pytest.raises(ValidationError):
            VADConfig(silero_sensitivity=1.5)

    def test_webrtc_sensitivity_validation(self) -> None:
        with pytest.raises(ValidationError):
            VADConfig(webrtc_sensitivity=5)

    def test_wake_words_sensitivity_validation(self) -> None:
        with pytest.raises(ValidationError):
            WakeWordConfig(wake_words_sensitivity=-0.1)

    @pytest.mark.parametrize(
        "raw",
        ["none", "NONE", "  none  ", "default", "", None],
    )
    def test_wakeword_backend_off_sentinels_normalise_to_empty(self, raw: object) -> None:
        # The CLI defaults --wakeword_backend to the literal "none"; bool("none")
        # is True, which would wrongly arm wake-word mode in the pipeline for
        # every PTT/toggle/listen session. All off-sentinels must collapse to "".
        cfg = WakeWordConfig(wakeword_backend=raw)  # type: ignore[arg-type]
        assert cfg.wakeword_backend == ""
        assert bool(cfg.wakeword_backend) is False

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("pvporcupine", "pvporcupine"),
            ("openwakeword", "openwakeword"),
            ("composite", "composite"),
            ("  composite  ", "composite"),
        ],
    )
    def test_wakeword_backend_real_values_pass_through(self, raw: str, expected: str) -> None:
        # Real backend names survive normalisation (trimmed but not lowered —
        # the facade matches against the registry's exact keys).
        assert WakeWordConfig(wakeword_backend=raw).wakeword_backend == expected

    def test_from_kwargs(self) -> None:
        config = RecorderConfig.from_kwargs(
            model="base",
            language="en",
            silero_sensitivity=0.7,
            sample_rate=44100,
            wake_words="hey jarvis",
        )
        assert config.transcription.model == "base"
        assert config.transcription.language == "en"
        assert config.vad.silero_sensitivity == 0.7
        assert config.audio.sample_rate == 44100
        assert config.wake_word.wake_words == "hey jarvis"

    def test_from_kwargs_unknown_keys_ignored(self) -> None:
        config = RecorderConfig.from_kwargs(unknown_key="value")
        assert config.audio.sample_rate == 16000  # still defaults

    def test_from_kwargs_routes_every_subconfig(self) -> None:
        config = RecorderConfig.from_kwargs(
            buffer_size=256,
            post_speech_silence_duration=1.25,
            beam_size=7,
            beam_size_realtime=4,
            wake_word_timeout=9.0,
            debug_mode=True,
            detection_speed=2.0,
        )
        assert config.audio.buffer_size == 256
        assert config.vad.post_speech_silence_duration == 1.25
        assert config.transcription.beam_size == 7
        assert config.realtime.beam_size_realtime == 4
        assert config.wake_word.wake_word_timeout == 9.0
        assert config.ui.debug_mode is True
        assert config.endpoint.detection_speed == 2.0

    def test_subconfigs_order_matches_config_fields(self) -> None:
        assert (
            AudioConfig,
            VADConfig,
            TranscriptionConfig,
            RealtimeConfig,
            WakeWordConfig,
            UIConfig,
            EndpointConfig,
            DiarizationConfig,
        ) == RecorderConfig._SUBCONFIGS


class TestRouteKwargsHelpers:
    def test_field_owner_index_maps_first_owner(self) -> None:
        subconfigs = RecorderConfig._SUBCONFIGS
        owner = RecorderConfig._field_owner_index(subconfigs)
        assert owner["buffer_size"] == 0  # AudioConfig
        assert owner["post_speech_silence_duration"] == 1  # VADConfig
        assert owner["detection_speed"] == 6  # EndpointConfig
        assert "unknown_key" not in owner

    def test_field_owner_index_precedence_on_shared_name(self) -> None:
        class First(VADConfig):
            shared: int = 1

        class Second(VADConfig):
            shared: int = 2

        owner = RecorderConfig._field_owner_index((First, Second))
        assert owner["shared"] == 0  # earlier sub-config wins

    def test_empty_buckets_are_independent(self) -> None:
        buckets = RecorderConfig._empty_buckets(3)
        assert buckets == [{}, {}, {}]
        buckets[0]["a"] = 1
        assert buckets[1] == {}

    def test_route_kwargs_drops_unknown_and_buckets_known(self) -> None:
        subconfigs = RecorderConfig._SUBCONFIGS
        buckets = RecorderConfig._route_kwargs(
            {"buffer_size": 256, "beam_size": 7, "nope": 1},
            subconfigs,
        )
        assert buckets[0] == {"buffer_size": 256}
        assert buckets[2] == {"beam_size": 7}
        assert buckets[1] == {}
