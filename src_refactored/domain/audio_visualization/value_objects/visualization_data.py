"""Visualization Data Value Objects.

This module provides pure domain visualization data representations
without external library dependencies.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from src_refactored.domain.common.value_object import ValueObject

from .visualization_settings import VisualizationSettings


@dataclass(frozen=True)
class VisualizationData(ValueObject):
    """Pure domain representation of visualization data."""
    
    data_points: Sequence[float]
    width: int
    height: int
    data_type: str  # e.g., "waveform", "spectrum", "level_meter"
    timestamp: datetime
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            tuple(self.data_points),
            self.width,
            self.height,
            self.data_type,
            self.timestamp,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if self.width <= 0:
            msg = "Width must be positive"
            raise ValueError(msg)
        if self.height <= 0:
            msg = "Height must be positive"
            raise ValueError(msg)
        if not self.data_type.strip():
            msg = "Data type cannot be empty"
            raise ValueError(msg)
        if len(self.data_points) == 0:
            msg = "Data points cannot be empty"
            raise ValueError(msg)

    @property
    def point_count(self) -> int:
        """Get number of data points."""
        return len(self.data_points)

    @property
    def min_value(self) -> float:
        """Get minimum data value."""
        return min(self.data_points) if self.data_points else 0.0

    @property
    def max_value(self) -> float:
        """Get maximum data value."""
        return max(self.data_points) if self.data_points else 0.0

    @property
    def range_value(self) -> float:
        """Get data range (max - min)."""
        return self.max_value - self.min_value

    def get_normalized_data(self, target_min: float = 0.0, target_max: float = 1.0) -> Sequence[float]:
        """Get normalized data points to target range."""
        if self.range_value == 0:
            # All values are the same
            mid_value = (target_min + target_max) / 2
            return [mid_value] * len(self.data_points)
        
        scale = (target_max - target_min) / self.range_value
        offset = target_min - self.min_value * scale
        
        return [point * scale + offset for point in self.data_points]

    def resize_to_width(self, new_width: int) -> "VisualizationData":
        """Resize data to new width by resampling."""
        if new_width <= 0:
            msg = "New width must be positive"
            raise ValueError(msg)
        
        if new_width == len(self.data_points):
            return self
        
        if len(self.data_points) == 1:
            # Single point, replicate it
            new_points = [self.data_points[0]] * new_width
        elif new_width < len(self.data_points):
            # Downsample by taking every nth point
            step = len(self.data_points) / new_width
            new_points = [
                self.data_points[int(i * step)] 
                for i in range(new_width)
            ]
        else:
            # Upsample by linear interpolation
            new_points = []
            scale = (len(self.data_points) - 1) / (new_width - 1)
            
            for i in range(new_width):
                if i == new_width - 1:
                    new_points.append(self.data_points[-1])
                else:
                    pos = i * scale
                    left_idx = int(pos)
                    right_idx = min(left_idx + 1, len(self.data_points) - 1)
                    
                    if left_idx == right_idx:
                        new_points.append(self.data_points[left_idx])
                    else:
                        # Linear interpolation
                        frac = pos - left_idx
                        left_val = self.data_points[left_idx]
                        right_val = self.data_points[right_idx]
                        interpolated = left_val + frac * (right_val - left_val)
                        new_points.append(interpolated)
        
        return VisualizationData(
            data_points=new_points,
            width=new_width,
            height=self.height,
            data_type=self.data_type,
            timestamp=self.timestamp,
            metadata=self.metadata,
        )


@dataclass(frozen=True)
class VisualizationFrame(ValueObject):
    """A single frame of visualization data."""
    
    visualization_data: VisualizationData
    settings: VisualizationSettings
    frame_id: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.visualization_data,
            self.settings,
            self.frame_id,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if not self.frame_id.strip():
            msg = "Frame ID cannot be empty"
            raise ValueError(msg)

    def get_age_ms(self, current_time: datetime) -> float:
        """Get frame age in milliseconds."""
        return (current_time - self.visualization_data.timestamp).total_seconds() * 1000.0

    def is_expired(self, current_time: datetime, max_age_ms: float) -> bool:
        """Check if frame is expired."""
        return self.get_age_ms(current_time) > max_age_ms

    @property
    def timestamp(self) -> datetime:
        """Get frame timestamp."""
        return self.visualization_data.timestamp

    @property
    def data_type(self) -> str:
        """Get visualization data type."""
        return self.visualization_data.data_type


@dataclass(frozen=True)
class RenderStatistics(ValueObject):
    """Statistics for visualization rendering."""
    
    frames_rendered: int = 0
    frames_dropped: int = 0
    average_render_time_ms: float = 0.0
    peak_render_time_ms: float = 0.0
    current_fps: float = 0.0
    target_fps: float = 0.0

    def _get_equality_components(self) -> tuple:
        return (
            self.frames_rendered,
            self.frames_dropped,
            self.average_render_time_ms,
            self.peak_render_time_ms,
            self.current_fps,
            self.target_fps,
        )

    def __invariants__(self) -> None:
        if self.frames_rendered < 0:
            msg = "Frames rendered cannot be negative"
            raise ValueError(msg)
        if self.frames_dropped < 0:
            msg = "Frames dropped cannot be negative"
            raise ValueError(msg)
        if self.average_render_time_ms < 0:
            msg = "Average render time cannot be negative"
            raise ValueError(msg)
        if self.peak_render_time_ms < 0:
            msg = "Peak render time cannot be negative"
            raise ValueError(msg)
        if self.current_fps < 0:
            msg = "Current FPS cannot be negative"
            raise ValueError(msg)
        if self.target_fps < 0:
            msg = "Target FPS cannot be negative"
            raise ValueError(msg)

    def get_drop_rate(self) -> float:
        """Get frame drop rate as percentage."""
        total_frames = self.frames_rendered + self.frames_dropped
        if total_frames == 0:
            return 0.0
        return (self.frames_dropped / total_frames) * 100.0

    def get_efficiency(self) -> float:
        """Get rendering efficiency (0.0 to 1.0)."""
        if self.target_fps == 0:
            return 1.0
        return min(1.0, self.current_fps / self.target_fps)

    def add_render_time(self, render_time_ms: float) -> "RenderStatistics":
        """Add a new render time measurement."""
        new_frames_rendered = self.frames_rendered + 1
        
        # Update peak
        new_peak = max(self.peak_render_time_ms, render_time_ms)
        
        # Update average (exponential moving average)
        alpha = 0.1  # Smoothing factor
        if self.average_render_time_ms == 0.0:
            new_average = render_time_ms
        else:
            new_average = (
                alpha * render_time_ms + 
                (1 - alpha) * self.average_render_time_ms
            )
        
        return RenderStatistics(
            frames_rendered=new_frames_rendered,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=new_average,
            peak_render_time_ms=new_peak,
            current_fps=self.current_fps,
            target_fps=self.target_fps,
        )

    def add_dropped_frame(self) -> "RenderStatistics":
        """Record a dropped frame."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered,
            frames_dropped=self.frames_dropped + 1,
            average_render_time_ms=self.average_render_time_ms,
            peak_render_time_ms=self.peak_render_time_ms,
            current_fps=self.current_fps,
            target_fps=self.target_fps,
        )

    def update_fps(self, fps: float) -> "RenderStatistics":
        """Update current FPS measurement."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=self.average_render_time_ms,
            peak_render_time_ms=self.peak_render_time_ms,
            current_fps=max(0.0, fps),
            target_fps=self.target_fps,
        )

    def update_target_fps(self, target_fps: float) -> "RenderStatistics":
        """Update target FPS."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=self.average_render_time_ms,
            peak_render_time_ms=self.peak_render_time_ms,
            current_fps=self.current_fps,
            target_fps=max(0.0, target_fps),
        )

    def add_frame_rendered(self) -> "RenderStatistics":
        """Record a rendered frame."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered + 1,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=self.average_render_time_ms,
            peak_render_time_ms=self.peak_render_time_ms,
            current_fps=self.current_fps,
            target_fps=self.target_fps,
        )

    def update_peak_render_time(self, peak_time_ms: float) -> "RenderStatistics":
        """Update peak render time."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=self.average_render_time_ms,
            peak_render_time_ms=max(self.peak_render_time_ms, peak_time_ms),
            current_fps=self.current_fps,
            target_fps=self.target_fps,
        )

    def update_average_render_time(self, average_time_ms: float) -> "RenderStatistics":
        """Update average render time."""
        return RenderStatistics(
            frames_rendered=self.frames_rendered,
            frames_dropped=self.frames_dropped,
            average_render_time_ms=max(0.0, average_time_ms),
            peak_render_time_ms=self.peak_render_time_ms,
            current_fps=self.current_fps,
            target_fps=self.target_fps,
        )

