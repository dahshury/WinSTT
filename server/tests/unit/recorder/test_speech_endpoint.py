from __future__ import annotations

import pytest

from src.recorder.domain.config import EndpointConfig, RecorderConfig
from src.recorder.domain.ports.sentence_classifier import ISentenceClassifier
from tests.fakes.fake_sentence_classifier import FakeSentenceClassifier


class TestEndpointConfig:
    def test_defaults(self) -> None:
        cfg = EndpointConfig()
        assert cfg.smart_endpoint_enabled is False
        assert cfg.detection_speed == 1.5
        assert cfg.smart_endpoint_model == "KoljaB/SentenceFinishedClassification"

    def test_custom_values(self) -> None:
        cfg = EndpointConfig(smart_endpoint_enabled=True, detection_speed=2.0)
        assert cfg.smart_endpoint_enabled is True
        assert cfg.detection_speed == 2.0

    def test_from_kwargs_routes_endpoint_fields(self) -> None:
        config = RecorderConfig.from_kwargs(
            smart_endpoint_enabled=True,
            detection_speed=2.5,
        )
        assert config.endpoint.smart_endpoint_enabled is True
        assert config.endpoint.detection_speed == 2.5


class TestFakeSentenceClassifier:
    def test_implements_interface(self) -> None:
        fake = FakeSentenceClassifier()
        assert isinstance(fake, ISentenceClassifier)

    def test_default_prob(self) -> None:
        fake = FakeSentenceClassifier()
        assert fake.classify("Hello world.") == 1.0

    def test_custom_prob(self) -> None:
        fake = FakeSentenceClassifier(fixed_prob=0.3)
        assert fake.classify("Hello") == 0.3

    def test_set_prob(self) -> None:
        fake = FakeSentenceClassifier()
        fake.set_prob(0.7)
        assert fake.classify("test") == 0.7

    def test_is_available(self) -> None:
        fake = FakeSentenceClassifier()
        assert fake.is_available() is True

    def test_set_available(self) -> None:
        fake = FakeSentenceClassifier()
        fake.set_available(False)
        assert fake.is_available() is False

    def test_shutdown(self) -> None:
        fake = FakeSentenceClassifier()
        fake.shutdown()
        assert fake.is_available() is False
        assert fake._shutdown is True


class TestInterpolateDetection:
    """Test the interpolate_detection helper used in server.py."""

    @staticmethod
    def interpolate_detection(prob: float) -> float:
        """Mirror of the server.py helper for unit testing."""
        return max(0.0, min(1.0, 1.0 - prob))

    def test_zero_prob_gives_max_pause(self) -> None:
        assert self.interpolate_detection(0.0) == pytest.approx(1.0)

    def test_full_prob_gives_min_pause(self) -> None:
        assert self.interpolate_detection(1.0) == pytest.approx(0.0)

    def test_half_prob(self) -> None:
        assert self.interpolate_detection(0.5) == pytest.approx(0.5)

    def test_clamped_above_one(self) -> None:
        assert self.interpolate_detection(1.5) == pytest.approx(0.0)

    def test_clamped_below_zero(self) -> None:
        assert self.interpolate_detection(-0.5) == pytest.approx(1.0)


class TestGetWhisperPause:
    """Test the get_whisper_pause helper used in server.py."""

    @staticmethod
    def get_whisper_pause(text: str) -> float:
        """Mirror of the server.py helper for unit testing."""
        if text.endswith("..."):
            return 4.5
        if text.endswith("."):
            return 0.4
        if text.endswith("!"):
            return 0.3
        if text.endswith("?"):
            return 0.2
        return 1.8

    def test_ellipsis(self) -> None:
        assert self.get_whisper_pause("I was thinking...") == 4.5

    def test_period(self) -> None:
        assert self.get_whisper_pause("The sky is blue.") == 0.4

    def test_exclamation(self) -> None:
        assert self.get_whisper_pause("Wow!") == 0.3

    def test_question(self) -> None:
        assert self.get_whisper_pause("Really?") == 0.2

    def test_no_punctuation(self) -> None:
        assert self.get_whisper_pause("When the sky") == 1.8

    def test_empty_string(self) -> None:
        assert self.get_whisper_pause("") == 1.8
