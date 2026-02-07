from __future__ import annotations

import logging
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
from typing_extensions import override

from src.building_blocks.types import AudioChunk, BufferSize, SampleRate
from src.recorder.domain.ports.audio_source import IAudioSource

logger = logging.getLogger(__name__)

try:
    import pyaudio
except ImportError:
    pyaudio = None

_DEFAULT_SAMPLE_RATE = SampleRate(16000)
_DEFAULT_BUFFER_SIZE = BufferSize(512)


class PyAudioSource(IAudioSource):
    def __init__(
        self,
        *,
        input_device_index: int | None = None,
        target_sample_rate: SampleRate = _DEFAULT_SAMPLE_RATE,
        buffer_size: BufferSize = _DEFAULT_BUFFER_SIZE,
    ) -> None:
        self._input_device_index = input_device_index
        self._target_sample_rate = target_sample_rate
        self._buffer_size = buffer_size
        self._audio_interface: Any = None
        self._stream: Any = None
        self._device_sample_rate: int | None = None
        self._active = False

    @override
    def setup(self) -> None:
        if pyaudio is None:
            msg = "PyAudio is not installed"
            raise RuntimeError(msg)
        self._audio_interface = pyaudio.PyAudio()
        pa: Any = self._audio_interface

        if self._input_device_index is None:
            info: Any = pa.get_default_input_device_info()
            self._input_device_index = int(info["index"])

        self._device_sample_rate = self._get_best_sample_rate(self._input_device_index)

        self._stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=self._device_sample_rate,
            input=True,
            frames_per_buffer=self._buffer_size,
            input_device_index=self._input_device_index,
        )
        self._active = True

    @override
    def read_chunk(self) -> AudioChunk:
        if self._stream is None:
            return b"\x00" * (self._buffer_size * 2)
        raw: bytes = self._stream.read(self._buffer_size, exception_on_overflow=False)
        if self._device_sample_rate and self._device_sample_rate != self._target_sample_rate:
            raw = self._resample(raw, self._device_sample_rate, self._target_sample_rate)
        return raw

    @override
    def cleanup(self) -> None:
        if self._stream is not None:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        if self._audio_interface is not None:
            self._audio_interface.terminate()
            self._audio_interface = None
        self._active = False

    @override
    def is_active(self) -> bool:
        return self._active

    @property
    @override
    def sample_rate(self) -> SampleRate:
        return self._target_sample_rate

    @property
    @override
    def buffer_size(self) -> BufferSize:
        return self._buffer_size

    def _get_best_sample_rate(self, device_index: int) -> int:
        standard_rates = [8000, 16000, 22050, 44100, 48000]
        if self._target_sample_rate in standard_rates:
            try:
                pa: Any = self._audio_interface
                info: Any = pa.get_device_info_by_index(device_index)
                max_channels: Any = info.get("maxInputChannels", 1)
                if pa.is_format_supported(
                    self._target_sample_rate,
                    input_device=device_index,
                    input_channels=max_channels,
                    input_format=pyaudio.paInt16,
                ):
                    return self._target_sample_rate
            except Exception:
                pass
        return 44100

    @staticmethod
    def _resample(raw: bytes, from_rate: int, to_rate: int) -> bytes:
        pcm = np.frombuffer(raw, dtype=np.int16)
        resampled: NDArray[np.float64] = resample_poly(pcm.astype(np.float64), to_rate, from_rate)
        return bytes(resampled.astype(np.int16).tobytes())
