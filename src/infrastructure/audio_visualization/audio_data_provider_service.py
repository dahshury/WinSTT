"""Infrastructure Audio Data Provider Service.

Provides waveform data to the domain visualizer by reading from an
infrastructure audio buffer and converting raw samples into the
domain `WaveformData` value object via the domain `AudioDataProviderPort`.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from src.domain.audio_visualization.ports.audio_data_provider_port import (
    AudioDataProviderPort,
)
from src.domain.audio_visualization.value_objects.waveform_data import (
    WaveformData,
)
from src.domain.common.result import Result


class AudioDataProviderService(AudioDataProviderPort):
    """Concrete provider that builds `WaveformData` from an audio buffer."""

    def __init__(
        self,
        buffer_service: Any,
        sample_rate: int,
        frame_window_ms: float = 33.33,
    ) -> None:
        """Initialize the provider.

        Args:
            buffer_service: Infrastructure buffer service exposing `get_buffer_data()` -> np.ndarray
            sample_rate: Audio sample rate in Hz
            frame_window_ms: Logical frame window in milliseconds to extract from the tail of the buffer
        """
        self._buffer_service = buffer_service
        self._sample_rate = max(1, int(sample_rate))
        self._frame_window_ms = max(1.0, float(frame_window_ms))

    def get_next_waveform(self) -> Result[WaveformData]:
        """Get the next available waveform data for visualization."""
        try:
            # Pull current buffer snapshot
            data = self._buffer_service.get_buffer_data() if self._buffer_service else None

            if data is None:
                return Result.failure("Audio buffer is not available")

            if not isinstance(data, np.ndarray):
                return Result.failure("Audio buffer returned unexpected type")

            if data.size == 0:
                # Produce a silent frame to keep visualization responsive
                timestamp_ms = float(time.time() * 1000.0)
                silence = [0.0] * int(self._sample_rate * self._frame_window_ms / 1000.0)
                wf = WaveformData.from_samples_list(silence, self._sample_rate, timestamp_ms)
                return Result.success(wf)

            # Extract the most recent window from the buffer tail
            window_size = int(self._sample_rate * self._frame_window_ms / 1000.0)
            window_size = max(1, window_size)
            tail = data[-window_size:] if data.size >= window_size else data

            # Normalize dtype to float for safe downstream math
            if not np.issubdtype(tail.dtype, np.floating):
                tail = tail.astype(np.float32, copy=False)

            # Clamp extreme values to [-1, 1] to avoid visualization spikes
            tail = np.clip(tail, -1.0, 1.0)

            # Convert to Python list for domain VO creation
            samples = tail.tolist()
            timestamp_ms = float(time.time() * 1000.0)
            waveform = WaveformData.from_samples_list(samples, self._sample_rate, timestamp_ms)
            return Result.success(waveform)

        except Exception as e:
            return Result.failure(f"Failed to produce waveform: {e!s}")


