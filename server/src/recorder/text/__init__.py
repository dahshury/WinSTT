"""Pure-Python text utilities consumed by the application layer.

This package holds deterministic, side-effect-free transformations applied
to transcription output. It deliberately has no infrastructure dependencies
so the application layer can import it safely (mirroring the hexagonal
rulebook's "domain → ports → application" import direction).
"""

from __future__ import annotations

from src.recorder.text.dictionary import apply_custom_words
from src.recorder.text.filler_filter import filter_transcription_output

__all__ = ["apply_custom_words", "filter_transcription_output"]
