"""Tests for ``SynthesizerConfig`` — domain config validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.synthesizer.domain.config import SynthesizerConfig


def test_default_config_is_disabled() -> None:
    config = SynthesizerConfig()
    assert config.enabled is False
    assert config.voice == "af_heart"
    assert config.lang == "en-us"
    assert config.speed == 1.0
    assert config.device == "auto"
    assert config.model_filename == "kokoro-v1.0.fp16.onnx"
    assert config.voices_filename == "voices-v1.0.bin"


def test_speed_lower_bound() -> None:
    with pytest.raises(ValidationError):
        SynthesizerConfig(speed=0.4)


def test_speed_upper_bound() -> None:
    with pytest.raises(ValidationError):
        SynthesizerConfig(speed=2.1)


def test_speed_within_range() -> None:
    config = SynthesizerConfig(speed=1.5)
    assert config.speed == 1.5


def test_mutable() -> None:
    """Config is intentionally mutable so the server can hot-swap settings."""
    config = SynthesizerConfig()
    config.voice = "am_michael"
    assert config.voice == "am_michael"


def test_cache_dir_optional() -> None:
    config = SynthesizerConfig(cache_dir="/tmp/kokoro")
    assert config.cache_dir == "/tmp/kokoro"

    config2 = SynthesizerConfig()
    assert config2.cache_dir is None
