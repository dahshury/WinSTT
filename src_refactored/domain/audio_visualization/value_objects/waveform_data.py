"""Waveform data value object for audio visualization."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt

from src_refactored.domain.audio.value_objects.audio_samples import (
    AudioDataType,
    AudioSampleData,
)
from src_refactored.domain.audio.value_objects.sample_rate import SampleRate
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
            raise ValueError(msg)

    @classmethod
    def from_audio_sample_data(
        cls, audio_data: AudioSampleData, timestamp_ms: float,
    ) -> "WaveformData":
        """Create waveform data from AudioSampleData."""
        samples = tuple(audio_data.samples)
        duration_ms = audio_data.calculated_duration.total_seconds() * 1000
        
        # Calculate RMS and peak
        rms_level = audio_data.get_rms()
        peak_level = audio_data.get_peak()
        
        # Ensure levels are within valid range
        rms_level = min(rms_level, 1.0)
        peak_level = min(peak_level, 1.0)

        return cls(
            samples=samples,
            sample_rate=audio_data.sample_rate.value,
            duration_ms=duration_ms,
            rms_level=rms_level,
            peak_level=peak_level,
            timestamp_ms=timestamp_ms,
        )

    @classmethod
    def from_samples_list(
        cls, samples: Sequence[float], sample_rate: int, timestamp_ms: float,
    ) -> "WaveformData":
        """Create waveform data from a list of samples."""
        if len(samples) == 0:
            msg = "Samples cannot be empty"
            raise ValueError(msg)

        # Calculate metrics using pure math
        samples_tuple = tuple(samples)
        duration_ms = (len(samples_tuple) / sample_rate) * 1000

        # Calculate RMS
        sum_squares = sum(sample * sample for sample in samples_tuple)
        mean_square = sum_squares / len(samples_tuple)
        rms_level = sqrt(mean_square)

        # Calculate peak
        peak_level = max(abs(sample) for sample in samples_tuple)

        # Ensure levels are within valid range
        rms_level = min(rms_level, 1.0)
        peak_level = min(peak_level, 1.0)

        return cls(
            samples=samples_tuple,
            sample_rate=sample_rate,
            duration_ms=duration_ms,
            rms_level=rms_level,
            peak_level=peak_level,
            timestamp_ms=timestamp_ms,
        )

    @classmethod
    def silence(cls, duration_ms: float, sample_rate: int, timestamp_ms: float) -> "WaveformData":
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

    def to_audio_sample_data(self) -> AudioSampleData:
        """Convert to domain AudioSampleData."""
        # Using naive datetime for domain layer (timezone handling in infrastructure)
        timestamp = datetime.fromtimestamp(self.timestamp_ms / 1000.0)
        duration = timedelta(milliseconds=self.duration_ms)
        
        return AudioSampleData(
            samples=self.samples,
            sample_rate=SampleRate(self.sample_rate),
            channels=1,  # Waveform data is typically mono for visualization
            data_type=AudioDataType.FLOAT32,
            timestamp=timestamp,
            duration=duration,
        )

    def get_sample_count(self) -> int:
        """Get the number of samples."""
        return len(self.samples)

    def downsample(self, factor: int) -> "WaveformData":
        """Downsample the waveform data by the given factor."""
        if factor <= 1:
            return self

        downsampled_samples = self.samples[::factor]
        new_sample_rate = self.sample_rate // factor
        new_duration = (len(downsampled_samples) / new_sample_rate) * 1000

        # Recalculate metrics for downsampled data using pure math
        if downsampled_samples:
            sum_squares = sum(sample * sample for sample in downsampled_samples)
            new_rms = sqrt(sum_squares / len(downsampled_samples))
            new_peak = max(abs(sample) for sample in downsampled_samples)
        else:
            new_rms = 0.0
            new_peak = 0.0

        return WaveformData(
            samples=downsampled_samples,
            sample_rate=new_sample_rate,
            duration_ms=new_duration,
            rms_level=min(new_rms, 1.0),
            peak_level=min(new_peak, 1.0),
            timestamp_ms=self.timestamp_ms,
        )

    def normalize(self, target_peak: float = 0.7) -> "WaveformData":
        """Normalize waveform to target peak level."""
        if self.peak_level == 0.0:
            return self

        scale_factor = target_peak / self.peak_level
        normalized_samples = tuple(sample * scale_factor for sample in self.samples)

        return WaveformData(
            samples=normalized_samples,
            sample_rate=self.sample_rate,
            duration_ms=self.duration_ms,
            rms_level=min(self.rms_level * scale_factor, 1.0),
            peak_level=min(self.peak_level * scale_factor, 1.0),
            timestamp_ms=self.timestamp_ms,
        )

    def apply_simple_window(self, window_type: str = "hann") -> "WaveformData":
        """Apply a simplified window function to the waveform."""
        n = len(self.samples)
        
        if window_type == "hann":
            # Simplified Hann window calculation
            window = tuple(0.5 * (1 - cos(2 * 3.14159 * i / (n - 1))) for i in range(n))
        elif window_type == "hamming":
            # Simplified Hamming window calculation  
            window = tuple(0.54 - 0.46 * cos(2 * 3.14159 * i / (n - 1)) for i in range(n))
        else:
            # No windowing
            window = tuple(1.0 for _ in range(n))

        windowed_samples = tuple(sample * window[i] for i, sample in enumerate(self.samples))

        # Recalculate metrics using pure math
        if windowed_samples:
            sum_squares = sum(sample * sample for sample in windowed_samples)
            new_rms = sqrt(sum_squares / len(windowed_samples))
            new_peak = max(abs(sample) for sample in windowed_samples)
        else:
            new_rms = 0.0
            new_peak = 0.0

        return WaveformData(
            samples=windowed_samples,
            sample_rate=self.sample_rate,
            duration_ms=self.duration_ms,
            rms_level=min(new_rms, 1.0),
            peak_level=min(new_peak, 1.0),
            timestamp_ms=self.timestamp_ms,
        )

    def is_silence(self, threshold: float = 0.01) -> bool:
        """Check if the waveform represents silence."""
        return self.rms_level < threshold

    def has_speech_activity(self, threshold: float = 0.02) -> bool:
        """Check if the waveform contains speech activity."""
        return self.rms_level >= threshold

    def get_energy_level(self) -> float:
        """Get normalized energy level (0.0 to 1.0)."""
        return self.rms_level

    def get_dynamic_range(self) -> float:
        """Get dynamic range (peak - RMS)."""
        return self.peak_level - self.rms_level
    
    @property
    def peak_amplitude(self) -> float:
        """Alias for peak_level to maintain compatibility."""
        return self.peak_level
    
    @property
    def rms_amplitude(self) -> float:
        """Alias for rms_level to maintain compatibility."""
        return self.rms_level

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.samples,
            self.sample_rate,
            self.duration_ms,
            self.rms_level,
            self.peak_level,
            self.timestamp_ms,
        )


def cos(x: float) -> float:
    """Simple cosine approximation for windowing functions."""
    pi = 3.14159
    two_pi = 2 * pi
    
    # Taylor series approximation for cosine (good enough for windowing)
    x = x % two_pi  # Normalize to 0-2π
    if x > pi:
        x = two_pi - x
        sign = -1
    else:
        sign = 1
    
    # Taylor series: cos(x) ≈ 1 - x²/2! + x⁴/4! - x⁶/6!
    x2 = x * x
    result = 1.0 - x2/2.0 + x2*x2/24.0 - x2*x2*x2/720.0
    return sign * result