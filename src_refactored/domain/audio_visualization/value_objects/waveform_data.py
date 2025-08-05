"""Waveform data value object for audio visualization."""

from dataclasses import dataclass

import numpy as np

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class WaveformData(ValueObject):
    """Represents audio waveform data for visualization."""

    samples: tuple[float, ...]  # Audio samples as immutable tuple
    sample_rate: int
    duration_ms: float
    rms_level: float
    peak_level: float
    timestamp_ms: float

    def __post_init__(self):
        """Validate waveform data."""
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)

        if self.duration_ms < 0:
            msg = "Duration cannot be negative"
            raise ValueError(msg)

        if not (0.0 <= self.rms_level <= 1.0):
            msg = "RMS level must be between 0.0 and 1.0"
            raise ValueError(msg)

        if not (0.0 <= self.peak_level <= 1.0):
            msg = "Peak level must be between 0.0 and 1.0"
            raise ValueError(msg)

        if self.rms_level > self.peak_level:
            msg = "RMS level cannot exceed peak level"
            raise ValueError(msg)

        if len(self.samples) == 0:
            msg = "Samples cannot be empty"
            raise ValueError(msg,
    )

    @classmethod
    def from_numpy_array(cls, data: np.ndarray, sample_rate: int,
                        timestamp_ms: float,
    ) -> "WaveformData":
        """Create waveform data from numpy array."""
        if len(data) == 0:
            msg = "Data array cannot be empty"
            raise ValueError(msg)

        # Calculate metrics
        rms_level = float(np.sqrt(np.mean(np.square(data))))
        peak_level = float(np.max(np.abs(data)))
        duration_ms = (len(data) / sample_rate,
    ) * 1000

        # Ensure levels are within valid range
        rms_level = min(rms_level, 1.0)
        peak_level = min(peak_level, 1.0)

        return cls(
            samples=tuple(float(sample) for sample in data),
            sample_rate=sample_rate,
            duration_ms=duration_ms,
            rms_level=rms_level,
            peak_level=peak_level,
            timestamp_ms=timestamp_ms,
        )

    @classmethod
    def silence(cls, duration_ms: float, sample_rate: int,
               timestamp_ms: float,
    ) -> "WaveformData":
        """Create silent waveform data."""
        num_samples = int((duration_ms / 1000) * sample_rate)
        samples = tuple(0.0 for _ in range(max(1, num_samples)))

        return cls(
            samples=samples,
            sample_rate=sample_rate,
            duration_ms=duration_ms,
            rms_level=0.0,
            peak_level=0.0,
            timestamp_ms=timestamp_ms,
        )

    def to_numpy_array(self) -> np.ndarray:
        """Convert to numpy array."""
        return np.array(self.samples, dtype=np.float32)

    def get_sample_count(self) -> int:
        """Get the number of samples."""
        return len(self.samples)

    def get_time_axis(self) -> np.ndarray:
        """Get time axis for plotting."""
        return np.linspace(0, self.duration_ms, len(self.samples))

    def downsample(self, factor: int,
    ) -> "WaveformData":
        """Downsample the waveform data by the given factor."""
        if factor <= 1:
            return self

        downsampled_samples = self.samples[::factor]
        new_sample_rate = self.sample_rate // factor
        new_duration = (len(downsampled_samples) / new_sample_rate) * 1000

        # Recalculate metrics for downsampled data
        data_array = np.array(downsampled_samples)
        new_rms = float(np.sqrt(np.mean(np.square(data_array)))) if len(data_array) > 0 else 0.0
        new_peak = float(np.max(np.abs(data_array))) if len(data_array) > 0 else 0.0

        return WaveformData(
            samples=downsampled_samples,
            sample_rate=new_sample_rate,
            duration_ms=new_duration,
            rms_level=min(new_rms, 1.0)
            peak_level=min(new_peak, 1.0)
            timestamp_ms=self.timestamp_ms,
        )

    def normalize(self, target_peak: float = 0.7) -> "WaveformData":
        """Normalize waveform to target peak level."""
        if self.peak_level == 0.0:
            return self

        scale_factor = target_peak / self.peak_level
        normalized_samples = tuple(sample * scale_factor for sample in self.samples,
    )

        return WaveformData(
            samples=normalized_samples,
            sample_rate=self.sample_rate,
            duration_ms=self.duration_ms,
            rms_level=min(self.rms_level * scale_factor, 1.0)
            peak_level=min(self.peak_level * scale_factor, 1.0)
            timestamp_ms=self.timestamp_ms,
        )

    def apply_window(self, window_type: str = "hann") -> "WaveformData":
        """Apply a window function to the waveform."""
        data_array = np.array(self.samples)

        if window_type == "hann":
            window = np.hanning(len(data_array))
        elif window_type == "hamming":
            window = np.hamming(len(data_array))
        elif window_type == "blackman":
            window = np.blackman(len(data_array))
        else:
            # No windowing
            window = np.ones(len(data_array))

        windowed_data = data_array * window
        windowed_samples = tuple(float(sample) for sample in windowed_data)

        # Recalculate metrics
        new_rms = float(np.sqrt(np.mean(np.square(windowed_data))))
        new_peak = float(np.max(np.abs(windowed_data)),
    )

        return WaveformData(
            samples=windowed_samples,
            sample_rate=self.sample_rate,
            duration_ms=self.duration_ms,
            rms_level=min(new_rms, 1.0)
            peak_level=min(new_peak, 1.0)
            timestamp_ms=self.timestamp_ms,
        )

    def is_silence(self, threshold: float = 0.01,
    ) -> bool:
        """Check if the waveform represents silence."""
        return self.rms_level < threshold

    def has_speech_activity(self, threshold: float = 0.02) -> bool:
        """Check if the waveform contains speech activity."""
        return self.rms_level >= threshold

    def get_energy_level(self) -> float:
        """Get normalized energy level (0.0 to 1.0)."""
        return self.rms_level

    def get_dynamic_range(self) -> float:
        """Get dynamic range (peak - RMS,
    )."""
        return self.peak_level - self.rms_level