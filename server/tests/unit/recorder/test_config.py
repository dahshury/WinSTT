from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.recorder.domain.config import (
    RecorderConfig,
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
