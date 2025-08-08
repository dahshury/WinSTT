"""Visualization settings value object for audio visualization."""

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class VisualizationType(Enum):
    """Types of audio visualization."""
    WAVEFORM = "waveform"
    SPECTRUM = "spectrum"
    SPECTROGRAM = "spectrogram"
    LEVEL_METER = "level_meter"
    OSCILLOSCOPE = "oscilloscope"


class ColorScheme(Enum):
    """Color schemes for visualization."""
    BLUE = "blue"
    GREEN = "green"
    RED = "red"
    PURPLE = "purple"
    ORANGE = "orange"
    GRADIENT = "gradient"
    MONOCHROME = "monochrome"


class ScalingMode(Enum):
    """Scaling modes for visualization."""
    LINEAR = "linear"
    LOGARITHMIC = "logarithmic"
    AUTO = "auto"
    FIXED = "fixed"


class WindowFunction(Enum):
    """Window functions for signal processing."""
    NONE = "none"
    HANN = "hann"
    HAMMING = "hamming"
    BLACKMAN = "blackman"
    KAISER = "kaiser"


@dataclass(frozen=True)
class VisualizationSettings(ValueObject):
    """Settings for audio visualization display."""

    # Visualization type and appearance
    visualization_type: VisualizationType
    color_scheme: ColorScheme
    scaling_mode: ScalingMode

    # Display dimensions
    width: int
    height: int

    # Audio processing settings
    sample_rate: int
    buffer_size: int
    chunk_size: int

    # Visualization parameters
    update_rate_hz: float = 60.0
    smoothing_factor: float = 0.8
    sensitivity: float = 1.0

    # Waveform-specific settings
    line_width: float = 2.0
    show_grid: bool = False
    show_zero_line: bool = True

    # Spectrum-specific settings
    fft_size: int = 1024
    window_function: WindowFunction = WindowFunction.HANN
    frequency_range: tuple[float, float] = (20.0, 8000.0)

    # Level meter settings
    peak_hold_time_ms: float = 1000.0
    decay_rate: float = 0.95

    # Normalization settings
    auto_normalize: bool = True
    normalization_target: float = 0.7
    silence_threshold: float = 0.01

    def __post_init__(self) -> None:
        """Validate visualization settings."""
        if self.width <= 0 or self.height <= 0:
            msg = "Width and height must be positive"
            raise ValueError(msg)

        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)

        if self.buffer_size <= 0 or self.chunk_size <= 0:
            msg = "Buffer size and chunk size must be positive"
            raise ValueError(msg)

        if not (1.0 <= self.update_rate_hz <= 120.0):
            msg = "Update rate must be between 1 and 120 Hz"
            raise ValueError(msg)

        if not (0.0 <= self.smoothing_factor <= 1.0):
            msg = "Smoothing factor must be between 0.0 and 1.0"
            raise ValueError(msg)

        if not (0.1 <= self.sensitivity <= 10.0):
            msg = "Sensitivity must be between 0.1 and 10.0"
            raise ValueError(msg)

        if self.line_width <= 0:
            msg = "Line width must be positive"
            raise ValueError(msg)

        if self.fft_size <= 0 or (self.fft_size & (self.fft_size - 1)) != 0:
            msg = "FFT size must be a positive power of 2"
            raise ValueError(msg,
    )

        freq_min, freq_max = self.frequency_range
        if freq_min >= freq_max or freq_min < 0:
            msg = "Invalid frequency range"
            raise ValueError(msg)

        if self.peak_hold_time_ms < 0:
            msg = "Peak hold time cannot be negative"
            raise ValueError(msg)

        if not (0.0 <= self.decay_rate <= 1.0):
            msg = "Decay rate must be between 0.0 and 1.0"
            raise ValueError(msg)

        if not (0.1 <= self.normalization_target <= 1.0):
            msg = "Normalization target must be between 0.1 and 1.0"
            raise ValueError(msg)

        if not (0.0 <= self.silence_threshold <= 0.1):
            msg = "Silence threshold must be between 0.0 and 0.1"
            raise ValueError(msg,
    )

    @classmethod
    def default_waveform(cls, width: int = 800, height: int = 200,
    ) -> "VisualizationSettings":
        """Create default waveform visualization settings."""
        return cls(
            visualization_type=VisualizationType.WAVEFORM,
            color_scheme=ColorScheme.BLUE,
            scaling_mode=ScalingMode.AUTO,
            width=width,
            height=height,
            sample_rate=16000,
            buffer_size=100,
            chunk_size=1024,
            line_width=2.0,
            show_zero_line=True,
        )

    @classmethod
    def default_spectrum(cls, width: int = 800, height: int = 300,
    ) -> "VisualizationSettings":
        """Create default spectrum visualization settings."""
        return cls(
            visualization_type=VisualizationType.SPECTRUM,
            color_scheme=ColorScheme.GRADIENT,
            scaling_mode=ScalingMode.LOGARITHMIC,
            width=width,
            height=height,
            sample_rate=16000,
            buffer_size=50,
            chunk_size=1024,
            fft_size=1024,
            window_function=WindowFunction.HANN,
            frequency_range=(20.0, 8000.0),
        )

    @classmethod
    def default_level_meter(cls, width: int = 100, height: int = 300,
    ) -> "VisualizationSettings":
        """Create default level meter visualization settings."""
        return cls(
            visualization_type=VisualizationType.LEVEL_METER,
            color_scheme=ColorScheme.GREEN,
            scaling_mode=ScalingMode.LINEAR,
            width=width,
            height=height,
            sample_rate=16000,
            buffer_size=10,
            chunk_size=512,
            peak_hold_time_ms=1000.0,
            decay_rate=0.95,
        )

    @classmethod
    def speech_optimized(cls, width: int = 800, height: int = 150,
    ) -> "VisualizationSettings":
        """Create speech-optimized visualization settings."""
        return cls(
            visualization_type=VisualizationType.WAVEFORM,
            color_scheme=ColorScheme.BLUE,
            scaling_mode=ScalingMode.AUTO,
            width=width,
            height=height,
            sample_rate=16000,
            buffer_size=100,
            chunk_size=1024,
            update_rate_hz=30.0,
            smoothing_factor=0.6,
            sensitivity=2.5,
            line_width=1.5,
            auto_normalize=True,
            normalization_target=0.5,
            silence_threshold=0.02,
        )

    def with_dimensions(self, width: int, height: int,
    ) -> "VisualizationSettings":
        """Create new settings with different dimensions."""
        return VisualizationSettings(
            visualization_type=self.visualization_type,
            color_scheme=self.color_scheme,
            scaling_mode=self.scaling_mode,
            width=width,
            height=height,
            sample_rate=self.sample_rate,
            buffer_size=self.buffer_size,
            chunk_size=self.chunk_size,
            update_rate_hz=self.update_rate_hz,
            smoothing_factor=self.smoothing_factor,
            sensitivity=self.sensitivity,
            line_width=self.line_width,
            show_grid=self.show_grid,
            show_zero_line=self.show_zero_line,
            fft_size=self.fft_size,
            window_function=self.window_function,
            frequency_range=self.frequency_range,
            peak_hold_time_ms=self.peak_hold_time_ms,
            decay_rate=self.decay_rate,
            auto_normalize=self.auto_normalize,
            normalization_target=self.normalization_target,
            silence_threshold=self.silence_threshold,
        )

    def with_sensitivity(self, sensitivity: float,
    ) -> "VisualizationSettings":
        """Create new settings with different sensitivity."""
        return VisualizationSettings(
            visualization_type=self.visualization_type,
            color_scheme=self.color_scheme,
            scaling_mode=self.scaling_mode,
            width=self.width,
            height=self.height,
            sample_rate=self.sample_rate,
            buffer_size=self.buffer_size,
            chunk_size=self.chunk_size,
            update_rate_hz=self.update_rate_hz,
            smoothing_factor=self.smoothing_factor,
            sensitivity=sensitivity,
            line_width=self.line_width,
            show_grid=self.show_grid,
            show_zero_line=self.show_zero_line,
            fft_size=self.fft_size,
            window_function=self.window_function,
            frequency_range=self.frequency_range,
            peak_hold_time_ms=self.peak_hold_time_ms,
            decay_rate=self.decay_rate,
            auto_normalize=self.auto_normalize,
            normalization_target=self.normalization_target,
            silence_threshold=self.silence_threshold,
        )

    def get_update_interval_ms(self) -> float:
        """Get update interval in milliseconds."""
        return 1000.0 / self.update_rate_hz

    def get_buffer_duration_ms(self) -> float:
        """Get buffer duration in milliseconds."""
        samples_per_buffer = self.buffer_size * self.chunk_size
        return (samples_per_buffer / self.sample_rate) * 1000.0

    def get_frequency_bins(self) -> int:
        """Get number of frequency bins for spectrum analysis."""
        return self.fft_size // 2 + 1

    def is_real_time(self) -> bool:
        """Check if settings are suitable for real-time visualization."""
        return self.update_rate_hz >= 15.0 and self.buffer_size <= 200

    def requires_fft(self) -> bool:
        """Check if visualization type requires FFT processing."""
        return self.visualization_type in [
            VisualizationType.SPECTRUM,
            VisualizationType.SPECTROGRAM,
        ]