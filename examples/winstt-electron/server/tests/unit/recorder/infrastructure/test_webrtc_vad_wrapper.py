"""Wrapper-level tests for :mod:`src.recorder.infrastructure.webrtc_vad`.

The ``webrtcvad`` library is mocked — we're testing the adapter's contract
enforcement (port shape, frame-splitting math, confidence formula, reset
semantics), not the underlying VAD's signal processing.
"""

from __future__ import annotations

from collections.abc import Callable
from unittest.mock import MagicMock

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from src.recorder.domain.ports.vad import IVoiceActivityDetector


def _install_fake_webrtcvad(
    monkeypatch: pytest.MonkeyPatch,
    *,
    is_speech_returns: bool = False,
    is_speech_factory: Callable[[bytes, int], bool] | None = None,
) -> MagicMock:
    """Replace the ``webrtcvad.Vad`` constructor inside the adapter module.

    ``is_speech_factory`` may be a callable ``(frame, sr) -> bool``; if
    given, it overrides the static ``is_speech_returns`` flag and is used
    to drive per-frame behaviour deterministically.
    """
    import src.recorder.infrastructure.webrtc_vad as mod

    fake_vad = MagicMock()
    fake_vad.set_mode = MagicMock()
    if is_speech_factory is not None:
        fake_vad.is_speech = MagicMock(side_effect=is_speech_factory)
    else:
        fake_vad.is_speech = MagicMock(return_value=is_speech_returns)

    fake_module = MagicMock()
    fake_module.Vad = MagicMock(return_value=fake_vad)
    monkeypatch.setattr(mod, "webrtcvad", fake_module)
    return fake_vad


def test_implements_ivoiceactivitydetector_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch)
    assert isinstance(WebRTCVAD(), IVoiceActivityDetector)


def test_raises_when_webrtcvad_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing webrtcvad → clear RuntimeError, not a downstream AttributeError."""
    import src.recorder.infrastructure.webrtc_vad as mod
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    monkeypatch.setattr(mod, "webrtcvad", None)
    with pytest.raises(RuntimeError, match="webrtcvad is not installed"):
        WebRTCVAD()


def test_constructor_forwards_sensitivity_to_set_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    fake = _install_fake_webrtcvad(monkeypatch)
    WebRTCVAD(sensitivity=2)
    fake.set_mode.assert_called_once_with(2)


@settings(max_examples=50, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(sensitivity=st.integers(min_value=0, max_value=3))
def test_constructor_accepts_all_documented_sensitivities(
    sensitivity: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Property: sensitivities 0-3 (webrtcvad's documented range) construct.

    The mock is set up once and reused — sensitivity flows through to a
    fresh ``set_mode`` call per construction without external state.
    """
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch)
    WebRTCVAD(sensitivity=sensitivity)


def test_detect_no_frames_returns_false_with_zero_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A chunk too small for even one 10ms frame must NOT crash — the
    adapter divides by ``max(num_frames, 1)`` to guard against zero."""
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch, is_speech_returns=False)
    vad = WebRTCVAD()
    # 10ms @ 16kHz = 160 samples = 320 bytes. Anything under triggers the guard.
    result = vad.detect(b"\x00" * 10)
    assert result.is_speech is False
    assert result.confidence == 0.0


def test_detect_all_speech_frames_returns_speech_with_full_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch, is_speech_returns=True)
    vad = WebRTCVAD()
    # 3 full frames at 16kHz: 3 * 160 samples * 2 bytes = 960 bytes.
    result = vad.detect(b"\x01\x02" * 480)
    assert result.is_speech is True
    assert result.confidence == 1.0


def test_detect_no_speech_frames_returns_zero_confidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch, is_speech_returns=False)
    vad = WebRTCVAD()
    result = vad.detect(b"\x01\x02" * 480)
    assert result.is_speech is False
    assert result.confidence == 0.0


def test_detect_confidence_is_speech_frames_over_total(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mixed result: 1 of 4 frames is speech → confidence 0.25, is_speech True."""
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    schedule = iter([True, False, False, False])

    def is_speech_side_effect(_frame: bytes, _sr: int) -> bool:
        return next(schedule)

    _install_fake_webrtcvad(monkeypatch, is_speech_factory=is_speech_side_effect)
    vad = WebRTCVAD()
    # 4 frames @ 16kHz = 4 * 160 * 2 = 1280 bytes.
    result = vad.detect(b"\x00\x00" * 640)
    assert result.is_speech is True
    assert result.confidence == pytest.approx(0.25)


def test_reset_clears_is_active_state(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch, is_speech_returns=True)
    vad = WebRTCVAD()
    vad.detect(b"\x00\x00" * 480)  # sets _is_active=True
    assert vad._is_active is True
    vad.reset()
    assert vad._is_active is False


def test_reset_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """reset() must be safely callable multiple times without raising."""
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    _install_fake_webrtcvad(monkeypatch)
    vad = WebRTCVAD()
    vad.reset()
    vad.reset()
    vad.reset()


def test_detect_works_after_failed_detect(monkeypatch: pytest.MonkeyPatch) -> None:
    """State after a transient error: a follow-up detect() must still succeed.

    We trigger a failure on the first is_speech() call, then succeed on the next.
    The adapter doesn't wrap the call in a try/except — but the property
    asserted here is that *no half-broken state* persists in the wrapper:
    the fake_vad mock continues to expose ``is_speech``, and re-invoking
    detect() with sufficient bytes works against the freshly-rewound
    side_effect iterator.
    """
    from src.recorder.infrastructure.webrtc_vad import WebRTCVAD

    call_count = {"n": 0}

    def is_speech_side_effect(_frame: bytes, _sr: int) -> bool:
        call_count["n"] += 1
        if call_count["n"] == 1:
            msg = "transient backend failure"
            raise RuntimeError(msg)
        return False

    _install_fake_webrtcvad(monkeypatch, is_speech_factory=is_speech_side_effect)
    vad = WebRTCVAD()

    # First call raises — exception propagates (adapter doesn't catch),
    # but the adapter's own state remains intact for the next attempt.
    with pytest.raises(RuntimeError):
        vad.detect(b"\x00\x00" * 480)

    # Second call: should succeed (returns is_speech=False for both frames).
    result = vad.detect(b"\x00\x00" * 480)
    assert result.is_speech is False
