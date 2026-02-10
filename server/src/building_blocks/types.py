from __future__ import annotations

from collections.abc import Callable
from typing import NewType

import numpy as np
from numpy.typing import NDArray

AudioChunk = bytes
AudioArray = NDArray[np.float32]
SampleRate = NewType("SampleRate", int)
BufferSize = NewType("BufferSize", int)

# ---------------------------------------------------------------------------
# Callback type aliases
# ---------------------------------------------------------------------------
SimpleCallback = Callable[[], None]
"""Callback for state-change notifications (no arguments)."""

TextCallback = Callable[[str], None]
"""Callback that receives a transcription text string."""

ChunkCallback = Callable[[bytes], None]
"""Callback that receives raw audio chunk data."""

LevelCallback = Callable[[float], None]
"""Callback that receives a normalized audio level (0.0-1.0)."""

CallbackMap = dict[str, SimpleCallback | TextCallback | ChunkCallback | LevelCallback | None]
"""Map of callback names to their handler functions (or ``None`` for unset)."""

__all__ = [
    "AudioArray",
    "AudioChunk",
    "BufferSize",
    "CallbackMap",
    "ChunkCallback",
    "LevelCallback",
    "SampleRate",
    "SimpleCallback",
    "TextCallback",
]
