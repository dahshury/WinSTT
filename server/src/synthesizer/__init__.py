"""Text-to-Speech subsystem.

Hexagonal port + adapter for streaming TTS synthesis. Mirrors the
``recorder`` package's shape (domain/ports/, infrastructure/, bootstrap)
but lives as a parallel subsystem because TTS (text → audio) is the
inverse of recording (audio → text).

Public surface:
    - ``ISpeechSynthesizer``: domain port
    - ``KokoroSynthesizer``: ONNX-only Kokoro-82M adapter
    - ``SynthesisChunk``: per-chunk DTO emitted by ``synthesize_stream``
    - ``SynthesizerConfig``: Pydantic config
    - ``build_synthesizer``: bootstrap helper
"""

from __future__ import annotations

from src.synthesizer.bootstrap import build_synthesizer
from src.synthesizer.domain.config import SynthesizerConfig
from src.synthesizer.domain.ports.synthesizer import ISpeechSynthesizer, SynthesisChunk

__all__ = [
    "ISpeechSynthesizer",
    "KokoroSynthesizer",
    "SynthesisChunk",
    "SynthesizerConfig",
    "build_synthesizer",
]


def __getattr__(name: str) -> object:
    # Lazy import so test/typecheck environments without kokoro_onnx still
    # parse this package without exploding at import time.
    if name == "KokoroSynthesizer":
        from src.synthesizer.infrastructure.kokoro_synthesizer import KokoroSynthesizer

        return KokoroSynthesizer
    raise AttributeError(name)
