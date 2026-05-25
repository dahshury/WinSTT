"""Wrapper-level tests for :mod:`src.recorder.infrastructure.composite_vad`.

The CompositeVAD adapter is pure-logic glue over two ``IVoiceActivityDetector``
ports. No ML library is involved at runtime — we feed it two stub VADs and
verify the AND-with-short-circuit truth table, the confidence collapse rule
(``min(webrtc, silero)`` when webrtc accepts; webrtc's confidence alone when
it rejects), and that ``reset()`` propagates to both inner detectors.
"""

from __future__ import annotations

from dataclasses import dataclass

from hypothesis import given, settings
from hypothesis import strategies as st
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult
from src.recorder.infrastructure.composite_vad import CompositeVAD


@dataclass
class _StubVAD(IVoiceActivityDetector):
    """Stub VAD that returns a pre-set ``VADResult`` and counts calls."""

    is_speech: bool = False
    confidence: float = 0.0
    detect_calls: int = 0
    reset_calls: int = 0

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        self.detect_calls += 1
        return VADResult(is_speech=self.is_speech, confidence=self.confidence)

    @override
    def reset(self) -> None:
        self.reset_calls += 1


def _make_composite(
    *,
    webrtc_speech: bool,
    webrtc_conf: float,
    silero_speech: bool,
    silero_conf: float,
) -> tuple[CompositeVAD, _StubVAD, _StubVAD]:
    webrtc = _StubVAD(is_speech=webrtc_speech, confidence=webrtc_conf)
    silero = _StubVAD(is_speech=silero_speech, confidence=silero_conf)
    return CompositeVAD(webrtc=webrtc, silero=silero), webrtc, silero


# ── Truth table — composite uses AND with webrtc short-circuit ──────────


@settings(max_examples=200)
@given(
    webrtc_speech=st.booleans(),
    silero_speech=st.booleans(),
    webrtc_conf=st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
    silero_conf=st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
)
def test_composite_is_speech_iff_both_inner_vads_agree(
    webrtc_speech: bool,
    silero_speech: bool,
    webrtc_conf: float,
    silero_conf: float,
) -> None:
    composite, _w, _s = _make_composite(
        webrtc_speech=webrtc_speech,
        webrtc_conf=webrtc_conf,
        silero_speech=silero_speech,
        silero_conf=silero_conf,
    )
    result = composite.detect(b"\x00\x00" * 256)
    assert result.is_speech is (webrtc_speech and silero_speech)


def test_webrtc_negative_short_circuits_silero() -> None:
    """When webrtc returns is_speech=False the silero VAD must NOT be called.

    This is an intentional cost optimization (Silero is the heavy inference
    path). The composite returns webrtc's confidence verbatim in that case.
    """
    composite, webrtc, silero = _make_composite(
        webrtc_speech=False,
        webrtc_conf=0.42,
        silero_speech=True,
        silero_conf=0.99,
    )
    result = composite.detect(b"\x00\x00" * 256)
    assert result.is_speech is False
    assert result.confidence == 0.42
    assert webrtc.detect_calls == 1
    assert silero.detect_calls == 0  # short-circuited


def test_both_positive_returns_min_confidence() -> None:
    composite, _w, _s = _make_composite(
        webrtc_speech=True,
        webrtc_conf=0.7,
        silero_speech=True,
        silero_conf=0.3,
    )
    result = composite.detect(b"\x00\x00" * 256)
    assert result.is_speech is True
    assert result.confidence == 0.3  # min(0.7, 0.3)


def test_webrtc_positive_silero_negative_returns_false_with_min_conf() -> None:
    composite, _w, _s = _make_composite(
        webrtc_speech=True,
        webrtc_conf=0.9,
        silero_speech=False,
        silero_conf=0.05,
    )
    result = composite.detect(b"\x00\x00" * 256)
    assert result.is_speech is False
    assert result.confidence == 0.05


def test_reset_propagates_to_both_inner_vads() -> None:
    composite, webrtc, silero = _make_composite(
        webrtc_speech=False,
        webrtc_conf=0.0,
        silero_speech=False,
        silero_conf=0.0,
    )
    composite.reset()
    assert webrtc.reset_calls == 1
    assert silero.reset_calls == 1
    # Second reset is idempotent (just counts up).
    composite.reset()
    assert webrtc.reset_calls == 2
    assert silero.reset_calls == 2


def test_detect_deterministic_for_identical_inner_state() -> None:
    """Two calls with the same stubs must yield identical results."""
    composite, _w, _s = _make_composite(
        webrtc_speech=True,
        webrtc_conf=0.6,
        silero_speech=True,
        silero_conf=0.4,
    )
    r1 = composite.detect(b"\x00\x00" * 256)
    r2 = composite.detect(b"\x00\x00" * 256)
    assert r1 == r2


def test_implements_ivoiceactivitydetector_port() -> None:
    composite, _w, _s = _make_composite(webrtc_speech=False, webrtc_conf=0.0, silero_speech=False, silero_conf=0.0)
    assert isinstance(composite, IVoiceActivityDetector)
