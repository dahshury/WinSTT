"""Wrapper-level tests for
:mod:`src.recorder.infrastructure.composite_wake_word`.

The composite requires Porcupine AND openWakeWord to fire within the
``AGREEMENT_WINDOW_SECONDS`` window before declaring a detection. We stub
both inner detectors (the constructor late-imports them) and the
monotonic clock so the window-handling logic is deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.wake_word import IWakeWordDetector, WakeWordResult


@dataclass
class _ScriptedWakeWord(IWakeWordDetector):
    """Wake-word detector that fires on a pre-scripted boolean schedule."""

    schedule: list[bool] = field(default_factory=list)
    detect_calls: int = 0
    cleanup_calls: int = 0
    cleanup_raises: BaseException | None = None

    @override
    def detect(self, chunk: AudioChunk) -> WakeWordResult:
        idx = self.detect_calls
        self.detect_calls += 1
        fired = idx < len(self.schedule) and self.schedule[idx]
        if fired:
            return WakeWordResult(detected=True, word_index=0, word="alexa")
        return WakeWordResult(detected=False, word_index=-1, word="")

    @override
    def cleanup(self) -> None:
        self.cleanup_calls += 1
        if self.cleanup_raises is not None:
            raise self.cleanup_raises


def _install_scripted_detectors(
    monkeypatch: pytest.MonkeyPatch,
    *,
    porc_schedule: list[bool],
    oww_schedule: list[bool],
) -> tuple[_ScriptedWakeWord, _ScriptedWakeWord]:
    """Replace PorcupineDetector / OWWDetector inside the composite module.

    The composite does *late* imports inside ``__init__``
    (``from src.recorder.infrastructure.oww_detector import OWWDetector``),
    so we patch the attributes on the source modules — they're resolved
    fresh on every instance construction.
    """
    porc_stub = _ScriptedWakeWord(schedule=porc_schedule)
    oww_stub = _ScriptedWakeWord(schedule=oww_schedule)

    def porc_factory(**_kw: object) -> _ScriptedWakeWord:
        return porc_stub

    def oww_factory(**_kw: object) -> _ScriptedWakeWord:
        return oww_stub

    # Build the modules with the stub classes — late imports inside the
    # composite read attributes off these modules, so swapping ``PorcupineDetector``
    # / ``OWWDetector`` is enough.
    monkeypatch.setattr(
        "src.recorder.infrastructure.porcupine_detector.PorcupineDetector",
        porc_factory,
    )
    monkeypatch.setattr(
        "src.recorder.infrastructure.oww_detector.OWWDetector",
        oww_factory,
    )
    return porc_stub, oww_stub


# ── Agreement window: BOTH must fire within window ───────────────────


def test_no_fires_no_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[False], oww_schedule=[False])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    result = composite.detect(b"\x00\x00" * 256)
    assert result.detected is False
    assert result.word == ""


def test_porcupine_only_fires_no_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[True], oww_schedule=[False])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    result = composite.detect(b"\x00\x00" * 256)
    assert result.detected is False


def test_oww_only_fires_no_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[False], oww_schedule=[True])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    result = composite.detect(b"\x00\x00" * 256)
    assert result.detected is False


def test_both_fire_same_tick_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[True], oww_schedule=[True])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    result = composite.detect(b"\x00\x00" * 256)
    assert result.detected is True
    assert result.word == "alexa"
    assert result.word_index == 0


def test_both_fire_inside_window_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sequential fires within the agreement window must trigger detection
    on the second engine's fire tick."""
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    # Porcupine fires on tick 0; OWW fires on tick 1. Both inside the window.
    _install_scripted_detectors(monkeypatch, porc_schedule=[True, False], oww_schedule=[False, True])

    times = iter([100.0, 100.5])

    def fake_mono() -> float:
        return next(times)

    monkeypatch.setattr("src.recorder.infrastructure.composite_wake_word.time.monotonic", fake_mono)

    composite = CompositeWakeWordDetector(wake_word="alexa")
    r1 = composite.detect(b"\x00\x00" * 256)
    r2 = composite.detect(b"\x00\x00" * 256)
    assert r1.detected is False  # only porcupine fired
    assert r2.detected is True
    assert r2.word == "alexa"


def test_fires_outside_window_no_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the gap between fires exceeds the agreement window, NO detection.

    This is the phantom-detection guard — an old porcupine fire from
    minutes ago must not pair with a fresh oww fire.
    """
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[True, False], oww_schedule=[False, True])

    # AGREEMENT_WINDOW_SECONDS is 1.5; we put the fires 5 s apart.
    times = iter([100.0, 105.0])

    def fake_mono() -> float:
        return next(times)

    monkeypatch.setattr("src.recorder.infrastructure.composite_wake_word.time.monotonic", fake_mono)

    composite = CompositeWakeWordDetector(wake_word="alexa")
    composite.detect(b"\x00\x00" * 256)
    r2 = composite.detect(b"\x00\x00" * 256)
    assert r2.detected is False


def test_detection_resets_fire_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """After a successful detection both timestamps reset to ``None`` so
    the next session needs both engines to re-fire."""
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[True], oww_schedule=[True])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    composite.detect(b"\x00\x00" * 256)
    # Internal state was reset.
    assert composite._porcupine_last_fire is None
    assert composite._oww_last_fire is None


def test_cleanup_calls_both_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    porc, oww = _install_scripted_detectors(monkeypatch, porc_schedule=[], oww_schedule=[])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    composite.cleanup()
    assert porc.cleanup_calls == 1
    assert oww.cleanup_calls == 1


def test_cleanup_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling cleanup() more than once must not raise."""
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    porc, oww = _install_scripted_detectors(monkeypatch, porc_schedule=[], oww_schedule=[])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    composite.cleanup()
    composite.cleanup()
    composite.cleanup()
    assert porc.cleanup_calls == 3
    assert oww.cleanup_calls == 3


def test_cleanup_swallows_inner_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """If one engine's cleanup raises, the composite still cleans the
    other and does NOT propagate."""
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    porc, oww = _install_scripted_detectors(monkeypatch, porc_schedule=[], oww_schedule=[])
    porc.cleanup_raises = RuntimeError("porcupine native crash")
    composite = CompositeWakeWordDetector(wake_word="alexa")
    composite.cleanup()  # must not raise
    assert porc.cleanup_calls == 1
    # Even though porcupine raised, oww still got its cleanup.
    assert oww.cleanup_calls == 1


def test_implements_iwake_word_detector_port(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.recorder.infrastructure.composite_wake_word import (
        CompositeWakeWordDetector,
    )

    _install_scripted_detectors(monkeypatch, porc_schedule=[], oww_schedule=[])
    composite = CompositeWakeWordDetector(wake_word="alexa")
    assert isinstance(composite, IWakeWordDetector)
