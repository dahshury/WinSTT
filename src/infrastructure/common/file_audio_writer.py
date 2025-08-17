"""File Audio Writer.

Assembles WAV bytes from PCM frames using the configured audio format.
"""

from __future__ import annotations

import io
import wave
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable


class FileAudioWriter:
    """Assemble WAV data from PCM frames."""

    def assemble_wav(self, sample_width: int, channels: int, rate: int, frames: Iterable[bytes]) -> bytes:
        with io.BytesIO() as wf:
            with wave.open(wf, "wb") as wave_file:
                wave_file.setnchannels(channels)
                wave_file.setsampwidth(sample_width)
                wave_file.setframerate(rate)
                for chunk in frames:
                    wave_file.writeframes(chunk)
            wf.seek(0)
            return wf.read()


