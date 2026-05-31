"""Single-utterance WAV writer used by :class:`RecorderService` when
:class:`src.recorder.domain.config.HistoryConfig.save_wav` is enabled.

Lives in ``application`` (not ``infrastructure``) because the writer has no
external dependency beyond the Python ``wave`` stdlib module — it is policy
about how the recorder serialises its in-memory PCM bytes, not a port-adapter
implementation. Writes 16 kHz mono 16-bit PCM so the renderer history-view's
``<audio>`` element can play the files back without provider-specific decoders.
"""

from __future__ import annotations

import logging
import os
import time
import wave
from pathlib import Path

logger = logging.getLogger(__name__)


def make_wav_filename(timestamp: float | None = None) -> str:
    """Build a ``winstt-<unix-ts>.wav`` filename for a recording.

    Uses ``time.time()`` when ``timestamp`` is ``None`` so tests can pass a
    fixed value for deterministic file names without monkey-patching the
    clock module.
    """
    ts = int(time.time() if timestamp is None else timestamp)
    return f"winstt-{ts}.wav"


def _ensure_recordings_dir(directory: str) -> bool:
    """Create ``directory`` (parents included). Return ``False`` on failure.

    Extracted so :func:`write_pcm_wav` keeps a single decision point: a
    disk-full / permission failure here is logged and swallowed exactly as
    before — the caller turns ``False`` into the empty-string return.
    """
    try:
        Path(directory).mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception("Failed to mkdir recordings dir %s", directory)
        return False
    return True


def _write_frames(full: str, audio: bytes, sample_rate: int) -> str:
    """Serialise ``audio`` as 16 kHz-style mono 16-bit PCM to ``full``.

    Returns ``full`` on success and ``""`` on any write error, which is logged
    and swallowed — a disk-full / permission failure must NEVER block the
    transcription text from reaching the user.
    """
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
    if any([not directory, not audio]):
        return ""
    if not _ensure_recordings_dir(directory):
        return ""
    filename = make_wav_filename(timestamp)
    full = os.path.join(directory, filename)
    return _write_frames(full, audio, sample_rate)
