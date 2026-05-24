from __future__ import annotations

import queue
from typing import Any

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
from typing_extensions import override

from src.building_blocks.types import AudioChunk, BufferSize, SampleRate
from src.recorder.domain.ports.audio_source import IAudioSource

_DEFAULT_SAMPLE_RATE = SampleRate(16000)
_DEFAULT_BUFFER_SIZE = BufferSize(512)


class FileAudioSource(IAudioSource):
    def __init__(
        self,
        *,
        sample_rate: SampleRate = _DEFAULT_SAMPLE_RATE,
        buffer_size: BufferSize = _DEFAULT_BUFFER_SIZE,
    ) -> None:
        self._sample_rate = sample_rate
        self._buffer_size = buffer_size
        self._queue: queue.Queue[AudioChunk] = queue.Queue()
        self._buffer = bytearray()
        self._active = False

    @override
    def setup(self) -> None:
        self._active = True

    @override
    def read_chunk(self) -> AudioChunk:
        try:
            return self._queue.get(timeout=0.01)
        except queue.Empty:
            return b"\x00" * (self._buffer_size * 2)

    @override
    def cleanup(self) -> None:
        self._active = False

    @override
    def is_active(self) -> bool:
        return self._active

    @property
    @override
    def is_capturing(self) -> bool:
        # File-backed sources have no hardware capture state. They're either
        # set up (drained when fed) or torn down. Reporting True here matches
        # historical behaviour — pause()/resume() are no-ops below.
        return self._active

    @override
    def pause(self) -> None:
        # No hardware to pause; loopback feeders push frames into the queue
        # regardless of this flag.
        return

    @override
    def resume(self) -> None:
        # Mirror of pause() — no-op for file-backed sources.
        return

    @override
    def switch_device(self, device_index: int | None) -> None:
        # File-backed sources have no concept of an OS audio device — the
        # external feed is the only input.  No-op so live device-switch
        # control messages are a quiet pass-through in loopback / external-audio
        # mode.
        del device_index

    @property
    @override
    def sample_rate(self) -> SampleRate:
        return self._sample_rate

    @property
    @override
    def buffer_size(self) -> BufferSize:
        return self._buffer_size

    def feed(self, chunk: bytes | NDArray[Any], original_sample_rate: int = 16000) -> None:
        if isinstance(chunk, np.ndarray):
            arr: NDArray[Any] = chunk
            if arr.ndim == 2:
                arr = np.mean(arr, axis=1)
            if original_sample_rate != self._sample_rate:
                # Polyphase (not FFT `resample`): the FFT path assumes a
                # periodic signal and rings at the edges of every fed
                # chunk. resample_poly applies a windowed-sinc anti-alias
                # FIR with no periodicity assumption. Mirrors
                # pyaudio_source._resample.
                arr = resample_poly(arr.astype(np.float64), self._sample_rate, original_sample_rate)
            raw_bytes: bytes = arr.astype(np.int16).tobytes()
        else:
            raw_bytes = chunk

        self._buffer += raw_bytes
        buf_size = 2 * self._buffer_size
        while len(self._buffer) >= buf_size:
            to_process = bytes(self._buffer[:buf_size])
            self._buffer = self._buffer[buf_size:]
            self._queue.put(to_process)
