"""Audio buffer value object for audio visualization."""

from collections.abc import Iterator
from dataclasses import dataclass

import numpy as np

from src_refactored.domain.common.value_object import ValueObject

from .waveform_data import WaveformData


@dataclass(frozen=True)
class AudioBuffer(ValueObject):
    """Buffer for storing audio data for visualization."""

    # Buffer configuration
    max_size: int
    sample_rate: int
    chunk_size: int

    # Buffer data
    data: list[WaveformData]
    current_size: int = 0

    def __post_init__(self):
        """Validate audio buffer configuration."""
        if self.max_size <= 0:
            msg = "Max size must be positive"
            raise ValueError(msg)

        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)

        if self.chunk_size <= 0:
            msg = "Chunk size must be positive"
            raise ValueError(msg)

        if self.current_size < 0 or self.current_size > len(self.data):
            msg = "Invalid current size"
            raise ValueError(msg)

        if len(self.data) > self.max_size:
            msg = "Data exceeds max size"
            raise ValueError(msg)

        # Validate all waveform data has consistent sample rate
        for waveform in self.data:
            if waveform.sample_rate != self.sample_rate:
                msg = "Inconsistent sample rate in buffer data"
                raise ValueError(msg)

    @classmethod
    def create_empty(cls, max_size: int, sample_rate: int, chunk_size: int,
    ) -> "AudioBuffer":
        """Create an empty audio buffer."""
        return cls(
            max_size=max_size,
            sample_rate=sample_rate,
            chunk_size=chunk_size,
            data=[],
            current_size=0,
        )

    @classmethod
    def create_with_capacity(cls, max_size: int, sample_rate: int, chunk_size: int,
    ) -> "AudioBuffer":
        """Create audio buffer with pre-allocated capacity."""
        # Create silent waveform data for pre-allocation
        import time
        timestamp_ms = time.time() * 1000.0
        silent_data = WaveformData.silence(chunk_size, sample_rate, timestamp_ms)
        data = [silent_data] * max_size

        return cls(
            max_size=max_size,
            sample_rate=sample_rate,
            chunk_size=chunk_size,
            data=data,
            current_size=0,
        )

    def add_waveform(self, waveform: WaveformData,
    ) -> "AudioBuffer":
        """Add new waveform data to the buffer."""
        if waveform.sample_rate != self.sample_rate:
            msg = "Waveform sample rate doesn't match buffer"
            raise ValueError(msg)

        new_data = self.data.copy()

        if len(new_data) >= self.max_size:
            # Remove oldest data (FIFO)
            new_data.pop(0)

        new_data.append(waveform)
        new_size = min(self.current_size + 1, self.max_size)

        return AudioBuffer(
            max_size=self.max_size,
            sample_rate=self.sample_rate,
            chunk_size=self.chunk_size,
            data=new_data,
            current_size=new_size,
        )

    def add_samples(self, samples: np.ndarray) -> "AudioBuffer":
        """Add raw audio samples to the buffer."""
        import time
        timestamp_ms = time.time() * 1000.0
        waveform = WaveformData.from_numpy_array(samples, self.sample_rate, timestamp_ms)
        return self.add_waveform(waveform)

    def get_latest(self, count: int = 1,
    ) -> list[WaveformData]:
        """Get the latest waveform data from the buffer."""
        if count <= 0:
            return []

        actual_count = min(count, len(self.data))
        return self.data[-actual_count:]

    def get_oldest(self, count: int = 1,
    ) -> list[WaveformData]:
        """Get the oldest waveform data from the buffer."""
        if count <= 0:
            return []

        actual_count = min(count, len(self.data))
        return self.data[:actual_count]

    def get_range(self, start_index: int, end_index: int | None = None) -> list[WaveformData]:
        """Get waveform data in a specific range."""
        if end_index is None:
            end_index = len(self.data)

        start_index = max(0, start_index)
        end_index = min(len(self.data), end_index)

        if start_index >= end_index:
            return []

        return self.data[start_index:end_index]

    def get_time_range(self, duration_ms: float,
    ) -> list[WaveformData]:
        """Get waveform data for a specific time duration from the end."""
        if duration_ms <= 0:
            return []

        # Calculate how many chunks we need
        chunk_duration_ms = (self.chunk_size / self.sample_rate) * 1000.0
        chunks_needed = int(np.ceil(duration_ms / chunk_duration_ms))

        return self.get_latest(chunks_needed)

    def concatenate_all(self) -> WaveformData | None:
        """Concatenate all waveform data into a single waveform."""
        if not self.data:
            return None

        if len(self.data) == 1:
            return self.data[0]

        # Concatenate all samples
        all_samples = []
        total_duration = 0.0

        for waveform in self.data:
            all_samples.append(waveform.to_numpy())
            total_duration += waveform.duration

        concatenated_samples = np.concatenate(all_samples)

        import time
        timestamp_ms = time.time() * 1000.0
        return WaveformData.from_numpy_array(concatenated_samples, self.sample_rate, timestamp_ms)

    def concatenate_latest(self, count: int,
    ) -> WaveformData | None:
        """Concatenate the latest waveform data."""
        latest_data = self.get_latest(count)

        if not latest_data:
            return None

        if len(latest_data) == 1:
            return latest_data[0]

        # Concatenate samples
        all_samples = []
        for waveform in latest_data:
            all_samples.append(waveform.to_numpy())

        concatenated_samples = np.concatenate(all_samples)

        return WaveformData.from_numpy_array(concatenated_samples, self.sample_rate)

    def get_average_level(self) -> float:
        """Get average RMS level across all buffer data."""
        if not self.data:
            return 0.0

        total_rms = sum(waveform.rms_level for waveform in self.data)
        return total_rms / len(self.data)

    def get_peak_level(self) -> float:
        """Get peak level across all buffer data."""
        if not self.data:
            return 0.0

        return max(waveform.peak_level for waveform in self.data)

    def get_total_duration(self) -> float:
        """Get total duration of all data in the buffer (seconds)."""
        return sum(waveform.duration for waveform in self.data)

    def get_total_samples(self) -> int:
        """Get total number of samples in the buffer."""
        return sum(len(waveform.samples) for waveform in self.data)

    def is_empty(self) -> bool:
        """Check if buffer is empty."""
        return len(self.data) == 0

    def is_full(self) -> bool:
        """Check if buffer is at maximum capacity."""
        return len(self.data) >= self.max_size

    def get_fill_percentage(self) -> float:
        """Get buffer fill percentage (0.0 to 1.0)."""
        return len(self.data) / self.max_size

    def clear(self) -> "AudioBuffer":
        """Clear all data from the buffer."""
        return AudioBuffer(
            max_size=self.max_size,
            sample_rate=self.sample_rate,
            chunk_size=self.chunk_size,
            data=[],
            current_size=0,
        )

    def resize(self, new_max_size: int,
    ) -> "AudioBuffer":
        """Resize the buffer to a new maximum size."""
        if new_max_size <= 0:
            msg = "New max size must be positive"
            raise ValueError(msg)

        new_data = self.data.copy()

        # Trim data if new size is smaller
        if len(new_data) > new_max_size:
            # Keep the most recent data
            new_data = new_data[-new_max_size:]

        new_current_size = min(self.current_size, new_max_size)

        return AudioBuffer(
            max_size=new_max_size,
            sample_rate=self.sample_rate,
            chunk_size=self.chunk_size,
            data=new_data,
            current_size=new_current_size,
        )

    def filter_by_activity(self, silence_threshold: float = 0.01) -> "AudioBuffer":
        """Filter buffer to only include data with speech activity."""
        active_data = [
            waveform for waveform in self.data
            if not waveform.is_silence(silence_threshold)
        ]

        return AudioBuffer(
            max_size=self.max_size,
            sample_rate=self.sample_rate,
            chunk_size=self.chunk_size,
            data=active_data,
            current_size=len(active_data),
        )

    def get_statistics(self) -> dict:
        """Get buffer statistics."""
        if not self.data:
            return {
                "count": 0,
                "total_duration": 0.0,
                "total_samples": 0,
                "average_rms": 0.0,
                "peak_level": 0.0,
                "fill_percentage": 0.0,
                "is_full": False,
            }

        return {
            "count": len(self.data),
            "total_duration": self.get_total_duration(),
            "total_samples": self.get_total_samples(),
            "average_rms": self.get_average_level(),
            "peak_level": self.get_peak_level(),
            "fill_percentage": self.get_fill_percentage(),
            "is_full": self.is_full(),
        }

    def __iter__(self) -> Iterator[WaveformData]:
        """Iterate over waveform data in the buffer."""
        return iter(self.data)

    def __len__(self) -> int:
        """Get number of waveform data items in the buffer."""
        return len(self.data)

    def __getitem__(self, index: int,
    ) -> WaveformData:
        """Get waveform data at specific index."""
        return self.data[index]