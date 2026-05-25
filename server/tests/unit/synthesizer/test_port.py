"""Tests for the ``ISpeechSynthesizer`` port — DTO shapes + ABC contract."""

from __future__ import annotations

from collections.abc import AsyncIterator

import numpy as np
import pytest

from src.synthesizer.domain.ports.synthesizer import (
    ISpeechSynthesizer,
    SynthesisChunk,
    VoiceInfo,
)


def test_synthesis_chunk_is_frozen() -> None:
    chunk = SynthesisChunk(
        audio=np.zeros(48, dtype=np.float32),
        sample_rate=24000,
        seq=0,
        is_final=False,
    )
    with pytest.raises(Exception):  # noqa: B017 - dataclass FrozenInstanceError differs by version
        chunk.seq = 5  # type: ignore[misc]


def test_synthesis_chunk_fields() -> None:
    audio = np.array([0.1, -0.2, 0.3], dtype=np.float32)
    chunk = SynthesisChunk(audio=audio, sample_rate=24000, seq=2, is_final=True)
    assert chunk.sample_rate == 24000
    assert chunk.seq == 2
    assert chunk.is_final is True
    assert chunk.audio.dtype == np.float32


def test_voice_info_is_frozen() -> None:
    voice = VoiceInfo(id="af_heart", label="Heart (US)", language="en-us", gender="female")
    with pytest.raises(Exception):  # noqa: B017
        voice.label = "Different"  # type: ignore[misc]


def test_cannot_instantiate_port() -> None:
    """``ISpeechSynthesizer`` is an abstract base — must subclass to use."""
    with pytest.raises(TypeError):
        ISpeechSynthesizer()  # type: ignore[abstract]


def test_minimal_concrete_implementation_satisfies_protocol() -> None:
    """Any class implementing the four abstract methods is a valid synthesizer."""

    class _FakeSynth(ISpeechSynthesizer):
        def __init__(self) -> None:
            self._ready = True
            self._shutdown_calls = 0
            self._warm_up_calls = 0

        def synthesize_stream(
            self,
            text: str,
            voice: str,
            lang: str,
            speed: float,
        ) -> AsyncIterator[SynthesisChunk]:
            async def _gen() -> AsyncIterator[SynthesisChunk]:
                yield SynthesisChunk(
                    audio=np.zeros(24, dtype=np.float32),
                    sample_rate=24000,
                    seq=0,
                    is_final=True,
                )

            return _gen()

        def list_voices(self) -> list[VoiceInfo]:
            return []

        def is_ready(self) -> bool:
            return self._ready

        def warm_up(self) -> None:
            self._warm_up_calls += 1

        def shutdown(self) -> None:
            self._shutdown_calls += 1

    synth = _FakeSynth()
    assert synth.is_ready() is True
    assert synth.list_voices() == []
    synth.warm_up()
    assert synth._warm_up_calls == 1
    synth.shutdown()
    assert synth._shutdown_calls == 1
