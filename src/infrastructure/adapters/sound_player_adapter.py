"""Sound Player Adapter.

Hexagonal adapter used by the presentation/application layers to play short UI
sounds. Primary implementation uses python-rtmixer; platform fallbacks are
only used if rtmixer is unavailable.
"""

from __future__ import annotations

import wave
from contextlib import suppress
from pathlib import Path

import numpy as np


class SoundPlayerAdapter:
    """Facade to play a sound file path using rtmixer (preferred)."""

    def __init__(self) -> None:
        # No heavy initialization; rtmixer is created per play to avoid device locks
        pass

    def _read_wav_float32(self, file_path: Path) -> tuple[np.ndarray, int, int]:
        """Read a WAV file into float32 numpy array shaped (frames, channels).

        Returns: (audio, samplerate, channels)
        """
        with wave.open(str(file_path), "rb") as wf:
            channels = wf.getnchannels()
            samplerate = wf.getframerate()
            frames = wf.getnframes()
            raw = wf.readframes(frames)
        # Convert bytes to int16 then to float32 in [-1, 1]
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        data = data.reshape(-1, channels) if channels > 1 else data.reshape(-1, 1)
        return data, samplerate, channels

    def play_sound(self, file_path: str) -> bool:
        path_obj = Path(file_path)
        suffix = path_obj.suffix.lower()

        # rtmixer primary path (WAV)
        if suffix == ".wav" and path_obj.exists():
            with suppress(Exception):
                import rtmixer  # lazy import

                data, samplerate, channels = self._read_wav_float32(path_obj)

                # Some rtmixer versions expose play(); others use play_buffer()
                with rtmixer.Mixer(samplerate=samplerate, channels=channels) as mixer:
                    play_fn = getattr(mixer, "play", None) or getattr(mixer, "play_buffer", None)
                    if play_fn:
                        play_fn(data)
                        wait_fn = getattr(mixer, "wait", None)
                        if callable(wait_fn):
                            wait_fn()
                        return True

        # Windows WAV fallback (non-blocking)
        if suffix == ".wav" and path_obj.exists():
            with suppress(Exception):
                import winsound

                winsound.PlaySound(str(path_obj), winsound.SND_FILENAME | winsound.SND_ASYNC)
                return True

        return False


