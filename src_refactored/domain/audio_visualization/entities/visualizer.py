"""Visualizer entity for audio visualization.

This domain entity manages the visualization workflow without knowing
about implementation details like numpy arrays.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from src_refactored.domain.audio_visualization.ports.audio_data_provider_port import (
    AudioDataProviderPort,
)
from src_refactored.domain.audio_visualization.ports.visualization_renderer_port import (
    VisualizationRendererPort,
)
from src_refactored.domain.audio_visualization.value_objects import (
    AudioBuffer,
    VisualizationSettings,
    WaveformData,
)
from src_refactored.domain.audio_visualization.value_objects.visualization_data import (
    RenderStatistics,
    VisualizationFrame,
)
from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.ports.concurrency_management_port import ConcurrencyManagementPort
from src_refactored.domain.common.ports.time_management_port import TimeManagementPort


class VisualizerStatus(Enum):
    """Visualizer status."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"


class RenderMode(Enum):
    """Rendering modes for visualization."""
    REAL_TIME = "real_time"
    BUFFERED = "buffered"
    STATIC = "static"


# VisualizationFrame and RenderStatistics are now imported from visualization_data module


@dataclass
class Visualizer(Entity):
    """Entity for rendering audio visualizations."""

    # Required fields (no defaults) must come first
    settings: VisualizationSettings
    concurrency_port: ConcurrencyManagementPort
    time_port: TimeManagementPort
    renderer_port: VisualizationRendererPort
    data_provider_port: AudioDataProviderPort | None = None

    # Optional fields (with defaults) come after
    render_mode: RenderMode = RenderMode.REAL_TIME

    # State
    status: VisualizerStatus = VisualizerStatus.STOPPED
    current_frame: VisualizationFrame | None = None

    # Rendering state
    frame_buffer: list[VisualizationFrame] = field(default_factory=list)
    max_frame_buffer_size: int = 10

    # Statistics
    statistics: RenderStatistics = field(default_factory=RenderStatistics)
    last_render_time: datetime | None = None

    # Callbacks
    frame_callback: Callable[[VisualizationFrame], None] | None = None
    error_callback: Callable[[Exception], None] | None = None
    status_callback: Callable[[VisualizerStatus], None] | None = None

    # Internal concurrency identifiers (managed by port)
    _thread_context_id: str | None = field(default=None, init=False)
    _stop_event_id: str | None = field(default=None, init=False)
    _pause_event_id: str | None = field(default=None, init=False)
    _lock_id: str | None = field(default=None, init=False)
    _render_measurement_id: str | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        """Initialize visualizer."""
        super().__post_init__()
        # Update statistics with target FPS from settings
        self.statistics = RenderStatistics(
            frames_rendered=0,
            frames_dropped=0,
            average_render_time_ms=0.0,
            peak_render_time_ms=0.0,
            current_fps=0.0,
            target_fps=self.settings.update_rate_hz,
        )
        
        # Initialize concurrency resources
        self._initialize_concurrency_resources()

    def _initialize_concurrency_resources(self) -> None:
        """Initialize concurrency resources through ports."""
        # Create unique IDs for this visualizer instance
        base_id = str(self.id)
        
        # Create thread context
        result = self.concurrency_port.create_thread_context(f"{base_id}_thread")
        if result.is_success:
            self._thread_context_id = result.value
        
        # Create synchronization events
        stop_result = self.concurrency_port.create_synchronization_event(f"{base_id}_stop")
        if stop_result.is_success:
            self._stop_event_id = stop_result.value
            
        pause_result = self.concurrency_port.create_synchronization_event(f"{base_id}_pause")
        if pause_result.is_success:
            self._pause_event_id = pause_result.value
        
        # Create lock
        lock_result = self.concurrency_port.create_lock(f"{base_id}_lock")
        if lock_result.is_success:
            self._lock_id = lock_result.value

    def start(self) -> bool:
        """Start visualization rendering."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status in [VisualizerStatus.RUNNING, VisualizerStatus.STARTING]:
                return True

            try:
                self._change_status(VisualizerStatus.STARTING)

                # Reset events through ports
                if self._stop_event_id:
                    self.concurrency_port.clear_event(self._stop_event_id)
                if self._pause_event_id:
                    self.concurrency_port.clear_event(self._pause_event_id)

                # Start background rendering task
                if self._thread_context_id:
                    start_result = self.concurrency_port.start_background_task(
                        self._thread_context_id,
                        self._rendering_loop,
                        daemon=True,
                    )
                    
                    if start_result.is_success:
                        self._change_status(VisualizerStatus.RUNNING)
                        return True
                    self._change_status(VisualizerStatus.ERROR)
                    return False

                return False

            except Exception as e:
                self._change_status(VisualizerStatus.ERROR)
                self._handle_error(e)
                return False
        finally:
            # Release lock
            self.concurrency_port.release_lock(self._lock_id)

    def stop(self) -> bool:
        """Stop visualization rendering."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status == VisualizerStatus.STOPPED:
                return True

            try:
                self._change_status(VisualizerStatus.STOPPING)

                # Signal stop through port
                if self._stop_event_id:
                    self.concurrency_port.set_event(self._stop_event_id)

                # Wait for thread to finish through port
                if self._thread_context_id:
                    self.concurrency_port.join_background_task(
                        self._thread_context_id, 
                        timeout_seconds=2.0,
                    )
                    
                self._change_status(VisualizerStatus.STOPPED)
                return True

            except Exception as e:
                self._change_status(VisualizerStatus.ERROR)
                self._handle_error(e)
                return False
        finally:
            # Release lock
            self.concurrency_port.release_lock(self._lock_id)

    def pause(self) -> bool:
        """Pause visualization rendering."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status != VisualizerStatus.RUNNING:
                return False

            if self._pause_event_id:
                self.concurrency_port.set_event(self._pause_event_id)
            self._change_status(VisualizerStatus.PAUSED)
            return True
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def resume(self) -> bool:
        """Resume visualization rendering."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status != VisualizerStatus.PAUSED:
                return False

            if self._pause_event_id:
                self.concurrency_port.clear_event(self._pause_event_id)
            self._change_status(VisualizerStatus.RUNNING)
            return True
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def render_waveform(self, waveform: WaveformData) -> VisualizationFrame | None:
        """Render a single waveform into a visualization frame."""
        try:
            start_time = self.time_port.get_current_time()

            # Generate visualization data based on type using the renderer port
            vis_data_result = None
            if self.settings.visualization_type.value == "waveform":
                vis_data_result = self.renderer_port.render_waveform(waveform, self.settings)
            elif self.settings.visualization_type.value == "spectrum":
                vis_data_result = self.renderer_port.render_spectrum(waveform, self.settings)
            elif self.settings.visualization_type.value == "level_meter":
                vis_data_result = self.renderer_port.render_level_meter(waveform, self.settings)
            else:
                vis_data_result = self.renderer_port.render_waveform(waveform, self.settings)  # Default fallback

            if not vis_data_result or not vis_data_result.is_success:
                self.statistics = self.statistics.add_dropped_frame()
                return None

            vis_data = vis_data_result.value
            
            # Ensure we have valid visualization data
            if not vis_data:
                self.statistics = self.statistics.add_dropped_frame()
                return None

            # Create frame using the renderer port
            frame_result = self.renderer_port.create_visualization_frame(
                vis_data,
                self.settings,
                {
                    "waveform_duration": waveform.duration_ms,
                    "waveform_rms": waveform.rms_level,
                    "waveform_peak": waveform.peak_level,
                    "sample_count": len(waveform.samples),
                },
            )

            if not frame_result or not frame_result.is_success:
                self.statistics = self.statistics.add_dropped_frame()
                return None

            frame = frame_result.value
            
            # Ensure we have a valid frame
            if not frame:
                self.statistics = self.statistics.add_dropped_frame()
                return None

            # Update current frame
            self.current_frame = frame

            # Add to buffer if in buffered mode
            if self.render_mode == RenderMode.BUFFERED:
                self._add_to_frame_buffer(frame)

            # Update statistics
            end_time_result = self.time_port.get_current_time()
            if start_time.is_success and end_time_result.is_success and start_time.value and end_time_result.value:
                # Calculate render time by getting datetime values
                try:
                    if hasattr(start_time.value, "value") and isinstance(start_time.value.value, datetime):
                        start_dt = start_time.value.value
                    elif isinstance(start_time.value, datetime):
                        start_dt = start_time.value
                    else:
                        start_dt = None
                    if hasattr(end_time_result.value, "value") and isinstance(end_time_result.value.value, datetime):
                        end_dt = end_time_result.value.value
                    elif isinstance(end_time_result.value, datetime):
                        end_dt = end_time_result.value
                    else:
                        end_dt = None
                    if start_dt is not None and end_dt is not None:
                        render_time_ms = (end_dt - start_dt).total_seconds() * 1000.0
                        self._update_render_statistics(render_time_ms)
                except (TypeError, AttributeError):
                    # If we can't calculate render time, skip updating statistics
                    pass
            
            # Update last render time
            datetime_result = self.time_port.get_current_datetime()
            if datetime_result.is_success and datetime_result.value:
                self.last_render_time = datetime_result.value

            # Call frame callback
            if self.frame_callback:
                try:
                    self.frame_callback(frame)
                except Exception as e:
                    self._handle_error(e)

            return frame

        except Exception as e:
            self.statistics = self.statistics.add_dropped_frame()
            self._handle_error(e)
            return None

    def render_buffer(self, buffer: AudioBuffer,
    ) -> VisualizationFrame | None:
        """Render audio buffer into a visualization frame."""
        if buffer.is_empty():
            return None

        # Get recent data for visualization
        recent_data = buffer.get_time_range(100.0)  # Last 100ms

        if not recent_data:
            return None

        # Concatenate recent waveforms
        concatenated = buffer.concatenate_latest(len(recent_data))

        if concatenated:
            return self.render_waveform(concatenated)

        return None

    def update_settings(self, new_settings: VisualizationSettings) -> None:
        """Update visualization settings."""
        if not self._lock_id:
            return
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return
            
        try:
            self.settings = new_settings
            self.statistics = self.statistics.update_target_fps(new_settings.update_rate_hz)
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def get_current_frame(self) -> VisualizationFrame | None:
        """Get the current visualization frame."""
        return self.current_frame

    def get_frame_buffer(self) -> list[VisualizationFrame]:
        """Get the frame buffer."""
        return self.frame_buffer.copy()

    def clear_frame_buffer(self) -> None:
        """Clear the frame buffer."""
        if not self._lock_id:
            return
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return
            
        try:
            self.frame_buffer.clear()
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def get_statistics(self) -> RenderStatistics:
        """Get rendering statistics."""
        return self.statistics

    def set_frame_callback(self, callback: Callable[[VisualizationFrame], None] | None) -> None:
        """Set frame rendering callback."""
        self.frame_callback = callback

    def set_error_callback(self, callback: Callable[[Exception], None] | None) -> None:
        """Set error handling callback."""
        self.error_callback = callback

    def set_status_callback(self, callback: Callable[[VisualizerStatus], None] | None) -> None:
        """Set status change callback."""
        self.status_callback = callback

    def _rendering_loop(self) -> None:
        """Main rendering loop."""
        interval = 1.0 / self.settings.update_rate_hz

        # Get stop and pause event references through the concurrency port
        stop_event_set = False
        pause_event_set = False
        
        while not stop_event_set:
            # Check pause state
            if self._pause_event_id:
                pause_result = self.concurrency_port.is_event_set(self._pause_event_id)
                if pause_result.is_success and pause_result.value is not None:
                    pause_event_set = pause_result.value
            
            if pause_event_set:
                self.time_port.sleep(0.1)
                continue

            try:
                # Pull waveform data via provider port when available
                if self.render_mode == RenderMode.REAL_TIME and self.data_provider_port is not None:
                    try:
                        waveform_result = self.data_provider_port.get_next_waveform()
                        if waveform_result and waveform_result.is_success and waveform_result.value:
                            self.render_waveform(waveform_result.value)
                    except Exception as e:
                        self._handle_error(e)

                self.time_port.sleep(interval)

                # Check stop condition
                if self._stop_event_id:
                    stop_result = self.concurrency_port.is_event_set(self._stop_event_id)
                    if stop_result.is_success and stop_result.value is not None:
                        stop_event_set = stop_result.value

            except Exception as e:
                self._handle_error(e)
                break

    # All rendering implementation has been moved to infrastructure layer via VisualizationRendererPort

    def _add_to_frame_buffer(self, frame: VisualizationFrame,
    ) -> None:
        """Add frame to buffer with size management."""
        self.frame_buffer.append(frame)

        # Remove old frames if buffer is full
        while len(self.frame_buffer) > self.max_frame_buffer_size:
            self.frame_buffer.pop(0)

    def _update_render_statistics(self, render_time_ms: float) -> None:
        """Update rendering statistics."""
        self.statistics = self.statistics.add_frame_rendered()

        # Update peak render time
        self.statistics = self.statistics.update_peak_render_time(render_time_ms)

                # Update average render time
        alpha = 0.1  # Smoothing factor
        if self.statistics.average_render_time_ms == 0.0:
            new_average = render_time_ms
        else:
            new_average = (
                alpha * render_time_ms + 
                (1 - alpha) * self.statistics.average_render_time_ms
            )
        self.statistics = self.statistics.update_average_render_time(new_average)

        # Update FPS calculation using time port
        current_time_result = self.time_port.get_current_time()
        if current_time_result.is_success and current_time_result.value:
            if not hasattr(self, "_frame_times"):
                self._frame_times = []

            # Extract timestamp value for arithmetic strictly via port-returned datetime
            current_timestamp = None
            if hasattr(current_time_result.value, "value") and isinstance(current_time_result.value.value, datetime):
                current_timestamp = current_time_result.value.value.timestamp()
            elif isinstance(current_time_result.value, datetime):
                current_timestamp = current_time_result.value.timestamp()

            if current_timestamp is None:
                return

            self._frame_times.append(current_timestamp)

            # Keep only recent frame times (last second)
            cutoff_time = current_timestamp - 1.0
            self._frame_times = [t for t in self._frame_times if t > cutoff_time]

            # Calculate current FPS
            if len(self._frame_times) > 1:
                time_span = self._frame_times[-1] - self._frame_times[0]
                if time_span > 0:
                    fps = (len(self._frame_times) - 1) / time_span
                    self.statistics = self.statistics.update_fps(fps)

    def _change_status(self, new_status: VisualizerStatus,
    ) -> None:
        """Change visualizer status and notify callback."""
        old_status = self.status
        self.status = new_status

        if self.status_callback and old_status != new_status:
            try:
                self.status_callback(new_status)
            except Exception:
                # Don't let callback errors affect status change
                pass

    def _handle_error(self, error: Exception,
    ) -> None:
        """Handle rendering errors."""
        if self.error_callback:
            try:
                self.error_callback(error)
            except Exception:
                # Don't let callback errors cause more errors
                pass

    def is_running(self) -> bool:
        """Check if visualizer is running."""
        return self.status == VisualizerStatus.RUNNING

    def is_stopped(self) -> bool:
        """Check if visualizer is stopped."""
        return self.status == VisualizerStatus.STOPPED

    def is_paused(self) -> bool:
        """Check if visualizer is paused."""
        return self.status == VisualizerStatus.PAUSED

    def has_error(self) -> bool:
        """Check if visualizer has an error."""
        return self.status == VisualizerStatus.ERROR