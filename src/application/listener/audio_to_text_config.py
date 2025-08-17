from __future__ import annotations

from dataclasses import dataclass


@dataclass
class AudioToTextConfig:
    rec_key: str = "Ctrl+Alt+A"
    channels: int = 1
    rate: int = 16000
    start_sound_file: str | None = "@resources/splash.wav"
    minimum_duration_seconds: float = 0.5


