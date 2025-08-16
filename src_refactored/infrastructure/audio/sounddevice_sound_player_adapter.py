"""SoundDevice Sound Player Adapter.

Simple, low-latency playback for short UI sounds using `sounddevice`.
Uses `pydub` to decode common audio formats (e.g., MP3/WAV) and plays
via PortAudio with low-latency defaults.
"""

from __future__ import annotations

import contextlib
import threading
from pathlib import Path

import numpy as np
import sounddevice as sd
from pydub import AudioSegment
from pydub.exceptions import CouldntDecodeError


class SoundDeviceSoundPlayerAdapter:
    """Simple sound player using sounddevice for low-latency playback."""

    def __init__(self) -> None:
        self._data: np.ndarray | None = None
        self._samplerate: int | None = None
        self._loaded_path: str | None = None
        self._lock = threading.Lock()
        self._stream: sd.OutputStream | None = None
        self._stream_rate: int | None = None
        self._stream_channels: int | None = None
        # Callback playback state
        self._cb_buffer: np.ndarray | None = None
        self._cb_position: int = 0
        self.ensure_initialized()

    def ensure_initialized(self) -> None:
        """Apply low-latency settings; idempotent."""
        with contextlib.suppress(Exception):
            sd.default.latency = ("low", "low")
            # Hint a small default blocksize globally to reduce backend buffers
            try:
                sd.default.blocksize = 64
            except Exception:
                pass
            # Prime backend device enumeration once at startup to avoid first-use overhead
            with contextlib.suppress(Exception):
                sd.query_devices(None, "output")

    def _audio_callback(self, outdata, frames, time_info, status):
        """Feed preloaded beep buffer to the active sounddevice stream."""
        del time_info  # unused
        if status:
            # Best-effort: ignore underflows/overflows in short beep context
            pass
        # Fill with silence by default
        outdata.fill(0.0)
        with self._lock:
            buf = self._cb_buffer
            pos = self._cb_position
        if buf is None:
            return
        remaining = buf.shape[0] - pos
        if remaining <= 0:
            return
        n = min(frames, remaining)
        # Ensure channel shape
        if buf.ndim == 1:
            # mono -> expand
            outdata[:n, 0] = buf[pos:pos + n]
        else:
            outdata[:n, : buf.shape[1]] = buf[pos:pos + n]
        with self._lock:
            self._cb_position = pos + n

    def prepare(self) -> None:
        """Pre-create and start a low-latency output stream with a callback."""
        with self._lock:
            rate = self._samplerate
            data = self._data

        if rate is None:
            return

        with contextlib.suppress(Exception):
            if (
                self._stream is None
                or not isinstance(self._stream, sd.OutputStream)
                or self._stream_rate != rate
                or (data is not None and self._stream_channels != (data.shape[1] if data.ndim == 2 else 1))
            ):
                if self._stream is not None:
                    with contextlib.suppress(Exception):
                        self._stream.close()
                self._stream = sd.OutputStream(
                    samplerate=rate,
                    channels=(data.shape[1] if isinstance(data, np.ndarray) and data.ndim == 2 else 1),
                    dtype="float32",
                    blocksize=64,
                    latency="low",
                    callback=self._audio_callback,
                )
                self._stream_rate = rate
                self._stream_channels = (data.shape[1] if isinstance(data, np.ndarray) and data.ndim == 2 else 1)
            if not self._stream.active:
                self._stream.start()

    def load(self, file_path: str | Path) -> bool:
        """Decode audio file to numpy buffer ready for playback.

        Returns True on success, False otherwise.
        """
        p = Path(file_path)
        if not p.exists():
            with self._lock:
                self._data = None
                self._samplerate = None
                self._loaded_path = None
            return False

        # If already loaded, skip re-decode
        if self._loaded_path == str(p):
            return True

        try:
            # Decode using pydub (requires ffmpeg for formats like MP3)
            seg = AudioSegment.from_file(str(p))
        except (CouldntDecodeError, OSError, ValueError):
            with self._lock:
                self._data = None
                self._samplerate = None
                self._loaded_path = None
            return False

        # Convert to float32 numpy array in range [-1.0, 1.0]
        raw = np.array(seg.get_array_of_samples())
        if seg.channels > 1:
            raw = raw.reshape((-1, seg.channels))

        # Convert PCM to float32 in [-1.0, 1.0)
        if seg.sample_width == 1:
            # pydub returns signed int8 array for 8-bit audio (-128..127)
            data = raw.astype(np.float32) / 128.0
        else:
            sample_width_bits = seg.sample_width * 8
            max_int = float(2 ** (sample_width_bits - 1))
            data = raw.astype(np.float32) / max_int

        # Normalize to a high but safe peak (~-0.2 dBFS) for audibility without clipping
        peak = float(np.max(np.abs(data))) if data.size else 0.0
        if peak > 0.0:
            target_peak = 0.98
            gain = min(target_peak / peak, 10.0)  # cap boost to +20 dB (10x)
            if gain != 1.0:
                data = data * gain

        with self._lock:
            self._data = data
            self._samplerate = int(seg.frame_rate)
            self._loaded_path = str(p)
        return True

    def play(self) -> None:
        """Non-blocking playback of the loaded buffer (if any)."""
        with self._lock:
            data = self._data
            rate = self._samplerate
            channels = int(data.shape[1]) if isinstance(data, np.ndarray) and data.ndim == 2 else 1

        if data is None or rate is None:
            return

        with contextlib.suppress(Exception):
            # Ensure stream ready
            self.prepare()
            # Hand buffer to callback for immediate playback
            with self._lock:
                self._cb_buffer = data
                self._cb_position = 0
            # Keep stream open to minimize latency for next play

    def shutdown(self) -> None:
        """Stop playback and release resources if needed."""
        with contextlib.suppress(Exception):
            if self._stream is not None:
                self._stream.abort()
                self._stream.close()
        self._stream = None
        self._stream_rate = None
        self._stream_channels = None


