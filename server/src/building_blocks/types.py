from __future__ import annotations

from collections.abc import Callable
from typing import NewType

import numpy as np
from numpy.typing import NDArray

AudioChunk = bytes
AudioArray = NDArray[np.float32]
SampleRate = NewType("SampleRate", int)
BufferSize = NewType("BufferSize", int)

SimpleCallback = Callable[[], None]
"""Callback for state-change notifications (no arguments)."""

TextCallback = Callable[[str], None]
"""Callback that receives a transcription text string."""

ChunkCallback = Callable[[bytes], None]
"""Callback that receives raw audio chunk data."""

LevelCallback = Callable[[float], None]
"""Callback that receives a normalized audio level (0.0-1.0)."""

DeviceSwitchFailedCallback = Callable[[int, str, int | None], None]
"""Callback for input-device switch failures: (requested, error, fallback)."""

DeviceBecameAvailableCallback = Callable[[int], None]
"""Callback fired when a previously-absent input device is now openable.

Used by the hotplug-aware audio source: the recorder can boot without a
microphone, sit in a waiting state, and surface this hook to the renderer
when the OS later exposes a default input device so the UI can reflect
"recording is now possible".
"""

ModelSwapCallback = Callable[[str, str], None]
"""Callback for model-swap lifecycle: (kind, name). Used for started + completed."""

ModelSwapFailedCallback = Callable[[str, str, str], None]
"""Callback for model-swap failures: (kind, name, reason)."""

DiarizationToggleCallback = Callable[[bool], None]
"""Callback for diarization-toggle started/completed: (enabled,).

Cannot reuse ``ModelSwapCallback`` because the diarization toggle carries
a single boolean (the target on/off state), not the (kind, name) pair
that drives the per-slot model swap. The renderer's lifecycle store
(``diarization-toggle-store``) keys off the boolean directly.
"""

DiarizationToggleFailedCallback = Callable[[bool, str, str, str], None]
"""Callback for diarization-toggle failures: (enabled, reason, category, detail).

Mirrors the shape of :data:`ModelSwapFailedCallback` plus the ``enabled``
target so the renderer can revert its toggle to the right state. The
``category`` vocabulary is shared with
:class:`src.recorder.domain.swap_errors.SwapErrorCategory` so the frontend
can reuse its toast-variant lookup.
"""

VADSensitivityAdaptedCallback = Callable[[float, float, float], None]
"""Callback for adaptive Silero updates: (new_sensitivity, noise_floor_rms, peak_rms)."""

CallbackMap = dict[
    str,
    SimpleCallback
    | TextCallback
    | ChunkCallback
    | LevelCallback
    | DeviceSwitchFailedCallback
    | DeviceBecameAvailableCallback
    | ModelSwapCallback
    | ModelSwapFailedCallback
    | DiarizationToggleCallback
    | DiarizationToggleFailedCallback
    | VADSensitivityAdaptedCallback
    | None,
]
"""Map of callback names to their handler functions (or ``None`` for unset)."""

__all__ = [
    "AudioArray",
    "AudioChunk",
    "BufferSize",
    "CallbackMap",
    "ChunkCallback",
    "DeviceBecameAvailableCallback",
    "DeviceSwitchFailedCallback",
    "DiarizationToggleCallback",
    "DiarizationToggleFailedCallback",
    "LevelCallback",
    "ModelSwapCallback",
    "ModelSwapFailedCallback",
    "SampleRate",
    "SimpleCallback",
    "TextCallback",
    "VADSensitivityAdaptedCallback",
]
