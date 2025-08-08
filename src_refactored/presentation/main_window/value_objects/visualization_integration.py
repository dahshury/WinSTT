"""Visualization integration value objects for main window presentation layer."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class VisualizationType(Enum):
    """Types of audio visualizations."""
    WAVEFORM = "waveform"
    SPECTRUM = "spectrum"
    LEVEL_METER = "level_meter"
    OSCILLOSCOPE = "oscilloscope"
    SPECTROGRAM = "spectrogram"
    NONE = "none"


class RenderingMode(Enum):
    """Rendering modes for visualizations."""
    REAL_TIME = "real_time"
    BUFFERED = "buffered"
    STATIC = "static"
    INTERACTIVE = "interactive"


class IntegrationStatus(Enum):
    """Status of visualization integration."""
    NOT_INITIALIZED = "not_initialized"
    INITIALIZING = "initializing"
    INITIALIZED = "initialized"
    ACTIVE = "active"
    READY = "ready"
    RENDERING = "rendering"
    PAUSED = "paused"
    ERROR = "error"
    DISABLED = "disabled"


@dataclass(frozen=True)
class VisualizationSettings(ValueObject):
    """Settings for visualization rendering."""
    
    update_rate_hz: int = 60
    buffer_size: int = 1024
    smoothing_factor: float = 0.8
    color_scheme: str = "default"
    show_grid: bool = True
    show_labels: bool = True
    auto_scale: bool = True
    
    def __post_init__(self) -> None:
        """Validate visualization settings."""
        if self.update_rate_hz <= 0:
            msg = "Update rate must be positive"
            raise ValueError(msg)
        
        if self.buffer_size <= 0:
            msg = "Buffer size must be positive"
            raise ValueError(msg)
        
        if not (0.0 <= self.smoothing_factor <= 1.0):
            msg = "Smoothing factor must be between 0.0 and 1.0"
            raise ValueError(msg)
    
    def with_update_rate(self, rate_hz: int) -> VisualizationSettings:
        """Create new settings with different update rate."""
        return VisualizationSettings(
            update_rate_hz=rate_hz,
            buffer_size=self.buffer_size,
            smoothing_factor=self.smoothing_factor,
            color_scheme=self.color_scheme,
            show_grid=self.show_grid,
            show_labels=self.show_labels,
            auto_scale=self.auto_scale,
        )
    
    def with_smoothing(self, factor: float) -> VisualizationSettings:
        """Create new settings with different smoothing factor."""
        return VisualizationSettings(
            update_rate_hz=self.update_rate_hz,
            buffer_size=self.buffer_size,
            smoothing_factor=factor,
            color_scheme=self.color_scheme,
            show_grid=self.show_grid,
            show_labels=self.show_labels,
            auto_scale=self.auto_scale,
        )


@dataclass(frozen=True)
class VisualizationIntegration(ValueObject):
    """Configuration for integrating visualization into the main window."""
    
    visualization_type: VisualizationType
    rendering_mode: RenderingMode
    settings: VisualizationSettings
    container_widget_id: str
    status: IntegrationStatus = IntegrationStatus.NOT_INITIALIZED
    error_message: str | None = None
    custom_properties: dict[str, Any] | None = None
    
    def __post_init__(self) -> None:
        """Validate visualization integration."""
        if not self.container_widget_id:
            msg = "Container widget ID cannot be empty"
            raise ValueError(msg)
        
        if self.status == IntegrationStatus.ERROR and not self.error_message:
            msg = "Error status requires error message"
            raise ValueError(msg)
    
    @classmethod
    def create_waveform(
        cls,
        container_id: str,
        settings: VisualizationSettings | None = None,
    ) -> VisualizationIntegration:
        """Create waveform visualization integration."""
        return cls(
            visualization_type=VisualizationType.WAVEFORM,
            rendering_mode=RenderingMode.REAL_TIME,
            settings=settings or VisualizationSettings(),
            container_widget_id=container_id,
        )
    
    @classmethod
    def create_spectrum(
        cls,
        container_id: str,
        settings: VisualizationSettings | None = None,
    ) -> VisualizationIntegration:
        """Create spectrum visualization integration."""
        return cls(
            visualization_type=VisualizationType.SPECTRUM,
            rendering_mode=RenderingMode.REAL_TIME,
            settings=settings or VisualizationSettings(),
            container_widget_id=container_id,
        )
    
    @classmethod
    def create_disabled(cls, container_id: str) -> VisualizationIntegration:
        """Create disabled visualization integration."""
        return cls(
            visualization_type=VisualizationType.NONE,
            rendering_mode=RenderingMode.STATIC,
            settings=VisualizationSettings(),
            container_widget_id=container_id,
            status=IntegrationStatus.DISABLED,
        )
    
    def with_status(self, status: IntegrationStatus, error_message: str | None = None) -> VisualizationIntegration:
        """Create new integration with different status."""
        return VisualizationIntegration(
            visualization_type=self.visualization_type,
            rendering_mode=self.rendering_mode,
            settings=self.settings,
            container_widget_id=self.container_widget_id,
            status=status,
            error_message=error_message,
            custom_properties=self.custom_properties,
        )
    
    def with_settings(self, settings: VisualizationSettings) -> VisualizationIntegration:
        """Create new integration with different settings."""
        return VisualizationIntegration(
            visualization_type=self.visualization_type,
            rendering_mode=self.rendering_mode,
            settings=settings,
            container_widget_id=self.container_widget_id,
            status=self.status,
            error_message=self.error_message,
            custom_properties=self.custom_properties,
        )
    
    def with_custom_property(self, key: str, value: Any) -> VisualizationIntegration:
        """Create new integration with additional custom property."""
        custom_props = dict(self.custom_properties) if self.custom_properties else {}
        custom_props[key] = value
        
        return VisualizationIntegration(
            visualization_type=self.visualization_type,
            rendering_mode=self.rendering_mode,
            settings=self.settings,
            container_widget_id=self.container_widget_id,
            status=self.status,
            error_message=self.error_message,
            custom_properties=custom_props,
        )
    
    def is_ready(self) -> bool:
        """Check if visualization is ready for rendering."""
        return self.status == IntegrationStatus.READY
    
    def is_rendering(self) -> bool:
        """Check if visualization is currently rendering."""
        return self.status == IntegrationStatus.RENDERING
    
    def is_error(self) -> bool:
        """Check if visualization is in error state."""
        return self.status == IntegrationStatus.ERROR
    
    def is_enabled(self) -> bool:
        """Check if visualization is enabled."""
        return self.status != IntegrationStatus.DISABLED and self.visualization_type != VisualizationType.NONE
    
    def requires_audio_input(self) -> bool:
        """Check if visualization requires audio input."""
        return self.visualization_type in [
            VisualizationType.WAVEFORM,
            VisualizationType.SPECTRUM,
            VisualizationType.LEVEL_METER,
            VisualizationType.OSCILLOSCOPE,
            VisualizationType.SPECTROGRAM,
        ]
    
    def supports_real_time(self) -> bool:
        """Check if visualization supports real-time rendering."""
        return self.rendering_mode in [RenderingMode.REAL_TIME, RenderingMode.INTERACTIVE]
    
    def initialize(self) -> Result[None]:
        """Initialize the visualization integration."""
        
        if self.status == IntegrationStatus.INITIALIZED:
            return Result.success(None)
        
        # Basic initialization logic
        try:
            # Update status to initialized
            object.__setattr__(self, "status", IntegrationStatus.INITIALIZED)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to initialize visualization: {e}")
    
    def start_recording(self) -> Result[None]:
        """Start recording and visualization."""
        
        if self.status != IntegrationStatus.INITIALIZED:
            return Result.failure("Visualization not initialized")
        
        try:
            # Update status to active
            object.__setattr__(self, "status", IntegrationStatus.ACTIVE)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to start recording: {e}")
    
    def stop_recording(self) -> Result[None]:
        """Stop recording and visualization."""
        
        if self.status != IntegrationStatus.ACTIVE:
            return Result.failure("Visualization not active")
        
        try:
            # Update status to initialized
            object.__setattr__(self, "status", IntegrationStatus.INITIALIZED)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to stop recording: {e}")
