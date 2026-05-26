"""Single-utterance WAV writer used by :class:`RecorderService` when
:class:`src.recorder.domain.config.HistoryConfig.save_wav` is enabled.

Lives in ``application`` (not ``infrastructure``) because the writer has no
external dependency beyond the Python ``wave`` stdlib module — it is policy
about how the recorder serialises its in-memory PCM bytes, not a port-adapter
implementation. Mirrors Handy's ``audio_toolkit::save_wav_file`` (16 kHz mono
16-bit PCM) so the renderer history-view's ``<audio>`` element can play the
files back without provider-specific decoders.
"""

from __future__ import annotations

import logging
import os
import time
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


def make_wav_filename(timestamp: float | None = None) -> str:
    """Match Handy's ``handy-<unix-ts>.wav`` naming convention with our prefix.

    Uses ``time.time()`` when ``timestamp`` is ``None`` so tests can pass a
    fixed value for deterministic file names without monkey-patching the
    clock module.
    """
    ts = int(time.time() if timestamp is None else timestamp)
    return f"winstt-{ts}.wav"


def write_pcm_wav(
    directory: str,
    audio: bytes,
    sample_rate: int = 16000,
    *,
    timestamp: float | None = None,
) -> str:
    """Write 16-bit PCM ``audio`` to ``directory`` and return the absolute path.

    Returns an empty string when ``audio`` is empty (no PCM captured) or when
    ``directory`` is empty/falsy. Both are user-facing scenarios the recorder
    must tolerate without raising:

    * ``directory == ""`` happens when the facade left ``HistoryConfig`` at its
      defaults — saving WAVs is opt-in.
    * ``audio == b""`` happens on a PTT release that captured nothing — VAD
      returns no transcribable bytes and we don't want to litter the
      recordings folder with 44-byte header-only WAVs.

    Errors during write are logged and swallowed (returns ""): a disk-full /
    permission failure must NEVER block the transcription text from reaching
    the user.
    """
    if not directory or not audio:
        return ""
    try:
        Path(directory).mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception("Failed to mkdir recordings dir %s", directory)
        return ""
    filename = make_wav_filename(timestamp)
    full = os.path.join(directory, filename)
    try:
        with wave.open(full, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)  # 16-bit
            wav.setframerate(sample_rate)
            wav.writeframes(audio)
    except (OSError, wave.Error):
        logger.exception("Failed to write WAV %s", full)
        return ""
    return full
