"""Composition root for the TTS subsystem.

Build a :class:`KokoroSynthesizer` from a :class:`SynthesizerConfig`.
Keeps the WS layer (``stt_server``) free of direct infrastructure imports.
"""

from __future__ import annotations

from collections.abc import Callable

from src.synthesizer.domain.config import SynthesizerConfig
from src.synthesizer.domain.ports.synthesizer import ISpeechSynthesizer

# Callback signature for download progress events. ``progress`` is 0..1,
# ``downloaded`` and ``total`` are bytes. Matches the shape of the STT
# DownloadCallbacks closure produced by ``recorder.bootstrap``.
ProgressFn = Callable[[float, int, int], None]
CancelFn = Callable[[], bool]
StatusFn = Callable[[str], None]


def build_synthesizer(
    config: SynthesizerConfig,
    *,
    on_progress: ProgressFn | None = None,
    should_cancel: CancelFn | None = None,
    on_status: StatusFn | None = None,
) -> ISpeechSynthesizer:
    """Construct the configured TTS adapter.

    Only Kokoro is wired today; this hook exists so adding a second engine
    later is a single-file change.
    """
    from src.synthesizer.infrastructure.kokoro_synthesizer import KokoroSynthesizer

    synthesizer = KokoroSynthesizer(config)
    if on_progress is not None or should_cancel is not None or on_status is not None:
        synthesizer.attach_download_callbacks(on_progress, should_cancel, on_status)
    return synthesizer
