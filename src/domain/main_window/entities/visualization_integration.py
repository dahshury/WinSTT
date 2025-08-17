"""Visualization integration entity.

This module contains the VisualizationIntegration entity that manages
voice visualizer integration and coordination business rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

from src.domain.common.entity import Entity
from src.domain.common.result import Result
from src.domain.main_window.value_objects.opacity_level import OpacityLevel

if TYPE_CHECKING:
    from collections.abc import Sequence

    from src.domain.audio_visualization.value_objects.waveform_data import WaveformData


class VisualizationState(Enum):
    """Visualization state enumeration."""
    INACTIVE = "inactive"
    INITIALIZING = "initializing"
    READY = "ready"
    RECORDING = "recording"
    PROCESSING = "processing"
    ERROR = "error"


class VisualizationMode(Enum):
    """Visualization mode enumeration."""
    WAVEFORM = "waveform"
    SPECTRUM = "spectrum"
    BARS = "bars"
    CIRCLE = "circle"
    MINIMAL = "minimal"


class AnimationStyle(Enum):
    """Animation style enumeration."""
    SMOOTH = "smooth"
    SHARP = "sharp"
    BOUNCE = "bounce"
    FADE = "fade"


@dataclass
class VisualizationSettings:
    """Visualization settings data."""
    mode: VisualizationMode = VisualizationMode.WAVEFORM
    color: tuple[int, int, int] = (189, 46, 45)  # Red color
    line_width: float = 2.5
    opacity: OpacityLevel | None = None
    animation_style: AnimationStyle = AnimationStyle.SMOOTH
    update_interval_ms: int = 50
    buffer_size: int = 1024

    def __post_init__(self) -> None:
        """Initialize default opacity."""
        if self.opacity is None:
            self.opacity = OpacityLevel.from_value(1.0)

    def validate(self) -> Result[None]:
        """Validate settings."""
        if self.line_width <= 0:
            return Result.failure("Line width must be positive")
        if self.update_interval_ms <= 0:
            return Result.failure("Update interval must be positive")
        if self.buffer_size <= 0:
            return Result.failure("Buffer size must be positive")
        if not all(0 <= c <= 255 for c in self.color):
            return Result.failure("Color values must be between 0 and 255")
        return Result.success(None)


# WaveformData is now imported from audio_visualization.value_objects.waveform_data


class VisualizationIntegration(Entity,
    ):
    """Visualization integration entity.
    
    Manages voice visualizer integration and coordination business rules.
    """

    def __init__(
        self,
        integration_id: str,
        settings: VisualizationSettings,
    ):
        super().__init__(integration_id)
        self._settings = settings
        self._state = VisualizationState.INACTIVE
        self._current_data: WaveformData | None = None
        self._data_history: list[WaveformData] = []
        self._is_visible = False
        self._background_opacity = OpacityLevel.from_value(0.0)
        self._max_history_size = 100
        self.validate()

    @classmethod
    def create_default(cls) -> Result[VisualizationIntegration]:
        """Create default visualization integration."""
        try:
            settings = VisualizationSettings()
            validation_result = settings.validate()
            if not validation_result.is_success:
                return Result.failure(f"Invalid settings: {validation_result.error}")

            integration = cls(
                integration_id="main_window_visualization",
                settings=settings,
            )

            return Result.success(integration)
        except Exception as e:
            return Result.failure(f"Failed to create visualization integration: {e!s}")

    def initialize(self) -> Result[None]:
        """Initialize visualization integration."""
        if self._state != VisualizationState.INACTIVE:
            return Result.failure("Visualization is not inactive")

        self._state = VisualizationState.INITIALIZING

        # Validate settings
        validation_result = self._settings.validate()
        if not validation_result.is_success:
            self._state = VisualizationState.ERROR
            return Result.failure(f"Settings validation failed: {validation_result.error}")

        self._state = VisualizationState.READY
        self.mark_as_updated()
        return Result.success(None)

    def start_recording(self) -> Result[None]:
        """Start recording visualization."""
        if self._state not in [VisualizationState.READY, VisualizationState.PROCESSING]:
            return Result.failure(f"Cannot start recording from state: {self._state.value}")

        self._state = VisualizationState.RECORDING
        self._is_visible = True

        # Clear previous data
        self._current_data = None
        self._data_history.clear()

        self.mark_as_updated()
        return Result.success(None)

    def stop_recording(self) -> Result[None]:
        """Stop recording visualization."""
        if self._state != VisualizationState.RECORDING:
            return Result.failure("Visualization is not recording")

        self._state = VisualizationState.PROCESSING
        self._is_visible = False
        self.mark_as_updated()
        return Result.success(None)

    def update_waveform_data(self, data: WaveformData,
    ) -> Result[None]:
        """Update waveform data for visualization."""
        if self._state != VisualizationState.RECORDING:
            return Result.failure("Visualization is not in recording state")

        try:
            # Validate data
            if data.samples is None or len(data.samples) == 0:
                return Result.failure("Waveform data cannot be empty")

            self._current_data = data

            # Add to history
            self._data_history.append(data)

            # Limit history size
            if len(self._data_history) > self._max_history_size:
                self._data_history = self._data_history[-self._max_history_size:]

            self.mark_as_updated()
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to update waveform data: {e!s}")

    def set_visibility(self, visible: bool,
    ) -> Result[None]:
        """Set visualization visibility."""
        if self._state == VisualizationState.ERROR:
            return Result.failure("Cannot change visibility in error state")

        self._is_visible = visible
        self.mark_as_updated()
        return Result.success(None)

    def set_opacity(self, opacity: OpacityLevel,
    ) -> Result[None]:
        """Set visualization opacity."""
        self._background_opacity = opacity
        self.mark_as_updated()
        return Result.success(None)

    def update_settings(self, settings: VisualizationSettings,
    ) -> Result[None]:
        """Update visualization settings."""
        validation_result = settings.validate()
        if not validation_result.is_success:
            return Result.failure(f"Invalid settings: {validation_result.error}")

        self._settings = settings
        self.mark_as_updated()
        return Result.success(None)

    def reset(self) -> Result[None]:
        """Reset visualization to ready state."""
        if self._state == VisualizationState.INACTIVE:
            return Result.failure("Visualization is inactive")

        self._state = VisualizationState.READY
        self._current_data = None
        self._data_history.clear()
        self._is_visible = False
        self.mark_as_updated()
        return Result.success(None)

    def get_display_data(self) -> Sequence[float] | None:
        """Get data for display rendering."""
        if not self._current_data:
            return None

        # Process data based on visualization mode
        if self._settings.mode == VisualizationMode.WAVEFORM:
            return self._process_waveform_data()
        if self._settings.mode == VisualizationMode.SPECTRUM:
            return self._process_spectrum_data()
        if self._settings.mode == VisualizationMode.BARS:
            return self._process_bars_data()
        return self._current_data.samples

    def _process_waveform_data(self) -> Sequence[float]:
        """Process data for waveform display."""
        if not self._current_data:
            return []

        # Downsample if needed for display
        samples = list(self._current_data.samples)
        target_points = 400  # Match widget width

        if len(samples) > target_points:
            # Downsample by taking every nth sample
            step = len(samples) // target_points
            samples = samples[::step][:target_points]

        return samples

    def _process_spectrum_data(self) -> Sequence[float]:
        """Process data for spectrum display."""
        if not self._current_data:
            return []

        # Note: FFT processing would be implemented in infrastructure layer
        # For now, return a simplified visualization based on amplitude levels
        samples = list(self._current_data.samples)
        
        # Create simple frequency-like representation using amplitude windows
        target_points = 200
        window_size = max(1, len(samples) // target_points)
        
        spectrum_data = []
        for i in range(0, len(samples), window_size):
            window = samples[i:i + window_size]
            if window:
                # Use RMS as a simple frequency magnitude approximation
                rms = (sum(s * s for s in window) / len(window)) ** 0.5
                spectrum_data.append(rms)
        
        return spectrum_data[:target_points]

    def _process_bars_data(self) -> Sequence[float]:
        """Process data for bars display."""
        if not self._current_data:
            return []

        # Note: True frequency analysis would be implemented in infrastructure layer
        # For now, create simplified frequency bands using amplitude grouping
        samples = list(self._current_data.samples)
        num_bars = 32
        
        if not samples:
            return [0.0] * num_bars
        
        window_size = max(1, len(samples) // num_bars)
        bars = []
        
        for i in range(num_bars):
            start = i * window_size
            end = min(start + window_size, len(samples))
            
            if start < len(samples):
                window = samples[start:end]
                # Use RMS as bar height
                bar_value = (sum(s * s for s in window) / len(window)) ** 0.5 if window else 0.0
                bars.append(bar_value)
            else:
                bars.append(0.0)
        
        return bars

    # Properties
    @property
    def settings(self) -> VisualizationSettings:
        """Get visualization settings."""
        return self._settings

    @property
    def state(self) -> VisualizationState:
        """Get current state."""
        return self._state

    @property
    def is_visible(self) -> bool:
        """Check if visualization is visible."""
        return self._is_visible

    @property
    def is_recording(self) -> bool:
        """Check if visualization is recording."""
        return self._state == VisualizationState.RECORDING

    @property
    def is_ready(self) -> bool:
        """Check if visualization is ready."""
        return self._state == VisualizationState.READY

    @property
    def current_data(self) -> WaveformData | None:
        """Get current waveform data."""
        return self._current_data

    @property
    def data_history_size(self) -> int:
        """Get size of data history."""
        return len(self._data_history)

    @property
    def background_opacity(self) -> OpacityLevel:
        """Get background opacity."""
        return self._background_opacity

    @property
    def peak_amplitude(self) -> float:
        """Get current peak amplitude."""
        if not self._current_data:
            return 0.0
        return self._current_data.peak_amplitude

    @property
    def rms_amplitude(self) -> float:
        """Get current RMS amplitude."""
        if not self._current_data:
            return 0.0
        return self._current_data.rms_amplitude

    def __invariants__(self) -> None:
        """Validate visualization integration invariants."""
        if not self._settings:
            msg = "Visualization settings are required"
            raise ValueError(msg)
        if not isinstance(self._state, VisualizationState):
            msg = "Invalid visualization state"
            raise ValueError(msg)
        if not isinstance(self._data_history, list):
            msg = "Data history must be a list"
            raise ValueError(msg)
        if self._max_history_size <= 0:
            msg = "Max history size must be positive"
            raise ValueError(msg)