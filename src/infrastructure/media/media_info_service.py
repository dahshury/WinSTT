"""Media info service for audio duration and related utilities."""

from __future__ import annotations

from typing import Any

import librosa


class MediaInfoService:
    """Provides media-related queries (duration, channels, etc.)."""

    def get_duration_seconds(self, audio_input: Any, default: float = 30.0) -> float:
        """Compute duration in seconds for supported inputs.

        Args:
            audio_input: file path or other supported type
            default: fallback when duration cannot be determined
        """
        try:
            if isinstance(audio_input, str):
                return float(librosa.get_duration(path=audio_input))
        except Exception:
            pass
        return float(default)


