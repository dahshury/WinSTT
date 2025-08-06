"""Visualizer entity for audio visualization."""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

import numpy as np

from src_refactored.domain.audio_visualization.value_objects import (
    AudioBuffer,
    VisualizationSettings,
    WaveformData,
)
from src_refactored.domain.common.entity import Entity


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


@dataclass
class VisualizationFrame:
    """A single frame of visualization data."""
    timestamp: datetime
    data: np.ndarray
    settings: VisualizationSettings
    metadata: dict[str, Any] = field(default_factory=dict)

    def get_age_ms(self) -> float:
        """Get frame age in milliseconds."""
        return (datetime.now() - self.timestamp).total_seconds() * 1000.0

    def is_expired(self, max_age_ms: float,
    ) -> bool:
        """Check if frame is expired."""
        return self.get_age_ms() > max_age_ms


@dataclass
class RenderStatistics:
    """Statistics for visualization rendering."""
    frames_rendered: int = 0
    frames_dropped: int = 0
    average_render_time_ms: float = 0.0
    peak_render_time_ms: float = 0.0
    current_fps: float = 0.0
    target_fps: float = 0.0

    def get_drop_rate(self) -> float:
        """Get frame drop rate as percentage."""
        total_frames = self.frames_rendered + self.frames_dropped
        if total_frames == 0:
            return 0.0
        return (self.frames_dropped / total_frames) * 100.0

    def get_efficiency(self) -> float:
        """Get rendering efficiency (0.0 to 1.0,
    )."""
        if self.target_fps == 0:
            return 1.0
        return min(1.0, self.current_fps / self.target_fps)


@dataclass
class Visualizer(Entity):
    """Entity for rendering audio visualizations."""

    # Configuration
    settings: VisualizationSettings
    render_mode: RenderMode = RenderMode.REAL_TIME

    # State
    status: VisualizerStatus = VisualizerStatus.STOPPED
    current_frame: VisualizationFrame | None = None

    # Rendering state
    frame_buffer: list[VisualizationFrame] = field(default_factory=list)
    max_frame_buffer_size: int = 10

    # Statistics
    statistics: RenderStatistics = field(default_factory=RenderStatistics,
    )
    last_render_time: datetime | None = None

    # Callbacks
    frame_callback: Callable[[VisualizationFrame], None] | None = None
    error_callback: Callable[[Exception], None] | None = None
    status_callback: Callable[[VisualizerStatus], None] | None = None

    # Internal state
    _render_thread: threading.Thread | None = field(default=None, init=False)
    _stop_event: threading.Event = field(default_factory=threading.Event, init=False)
    _pause_event: threading.Event = field(default_factory=threading.Event, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _frame_times: list[float] = field(default_factory=list, init=False)

    def __post_init__(self):
        """Initialize visualizer."""
        super().__post_init__()
        self.statistics.target_fps = self.settings.update_rate_hz

    def start(self) -> bool:
        """Start visualization rendering."""
        with self._lock:
            if self.status in [VisualizerStatus.RUNNING, VisualizerStatus.STARTING]:
                return True

            try:
                self._change_status(VisualizerStatus.STARTING)

                # Reset events
                self._stop_event.clear()
                self._pause_event.clear()

                # Start rendering thread
                self._render_thread = threading.Thread(
                    target=self._rendering_loop,
                    daemon=True,
                )
                self._render_thread.start()

                self._change_status(VisualizerStatus.RUNNING)
                return True

            except Exception as e:
                self._change_status(VisualizerStatus.ERROR)
                self._handle_error(e)
                return False

    def stop(self) -> bool:
        """Stop visualization rendering."""
        with self._lock:
            if self.status == VisualizerStatus.STOPPED:
                return True

            try:
                self._change_status(VisualizerStatus.STOPPING)

                # Signal stop
                self._stop_event.set()

                # Wait for thread to finish
                if self._render_thread and self._render_thread.is_alive():
                    self._render_thread.join(timeout=2.0)

                self._render_thread = None
                self._change_status(VisualizerStatus.STOPPED)
                return True

            except Exception as e:
                self._change_status(VisualizerStatus.ERROR)
                self._handle_error(e)
                return False

    def pause(self) -> bool:
        """Pause visualization rendering."""
        with self._lock:
            if self.status != VisualizerStatus.RUNNING:
                return False

            self._pause_event.set()
            self._change_status(VisualizerStatus.PAUSED)
            return True

    def resume(self) -> bool:
        """Resume visualization rendering."""
        with self._lock:
            if self.status != VisualizerStatus.PAUSED:
                return False

            self._pause_event.clear()
            self._change_status(VisualizerStatus.RUNNING)
            return True

    def render_waveform(self, waveform: WaveformData,
    ) -> VisualizationFrame | None:
        """Render a single waveform into a visualization frame."""
        try:
            start_time = time.time()

            # Generate visualization data based on type
            if self.settings.visualization_type.value == "waveform":
                vis_data = self._render_waveform_data(waveform)
            elif self.settings.visualization_type.value == "spectrum":
                vis_data = self._render_spectrum_data(waveform)
            elif self.settings.visualization_type.value == "level_meter":
                vis_data = self._render_level_meter_data(waveform)
            else:
                vis_data = self._render_waveform_data(waveform)  # Default fallback

            # Create frame
            frame = VisualizationFrame(
                timestamp=datetime.now(),
                data=vis_data,
                settings=self.settings,
                metadata={
                    "waveform_duration": waveform.duration_ms,
                    "waveform_rms": waveform.rms_level,
                    "waveform_peak": waveform.peak_level,
                    "sample_count": len(waveform.samples),
                },
            )

            # Update current frame
            self.current_frame = frame

            # Add to buffer if in buffered mode
            if self.render_mode == RenderMode.BUFFERED:
                self._add_to_frame_buffer(frame)

            # Update statistics
            render_time_ms = (time.time() - start_time) * 1000.0
            self._update_render_statistics(render_time_ms)
            self.last_render_time = datetime.now()

            # Call frame callback
            if self.frame_callback:
                try:
                    self.frame_callback(frame)
                except Exception as e:
                    self._handle_error(e)

            return frame

        except Exception as e:
            self.statistics.frames_dropped += 1
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

    def update_settings(self, new_settings: VisualizationSettings,
    ) -> None:
        """Update visualization settings."""
        with self._lock:
            self.settings = new_settings
            self.statistics.target_fps = new_settings.update_rate_hz

    def get_current_frame(self) -> VisualizationFrame | None:
        """Get the current visualization frame."""
        return self.current_frame

    def get_frame_buffer(self) -> list[VisualizationFrame]:
        """Get the frame buffer."""
        return self.frame_buffer.copy()

    def clear_frame_buffer(self) -> None:
        """Clear the frame buffer."""
        with self._lock:
            self.frame_buffer.clear()

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

        while not self._stop_event.is_set():
            if self._pause_event.is_set():
                time.sleep(0.1)
                continue

            try:
                # In real implementation, this would get data from audio processor
                # For now, we'll create dummy data
                if self.render_mode == RenderMode.REAL_TIME:
                    # Generate dummy waveform for testing
                    samples = np.random.normal(0, 0.1, self.settings.chunk_size).astype(np.float32)
                    timestamp_ms = time.time() * 1000.0
                    waveform = WaveformData.from_numpy_array(samples, self.settings.sample_rate, timestamp_ms)
                    self.render_waveform(waveform)

                time.sleep(interval)

            except Exception as e:
                self._handle_error(e)
                break

    def _render_waveform_data(self, waveform: WaveformData) -> np.ndarray:
        """Render waveform visualization data."""
        samples = waveform.to_numpy_array()

        # Downsample if needed
        target_points = self.settings.width
        if len(samples) > target_points:
            # Simple downsampling by taking every nth sample
            step = len(samples) // target_points
            samples = samples[::step][:target_points]
        elif len(samples) < target_points:
            # Upsample by interpolation
            x_old = np.linspace(0, 1, len(samples))
            x_new = np.linspace(0, 1, target_points)
            samples = np.interp(x_new, x_old, samples)

        # Apply sensitivity
        samples = samples * self.settings.sensitivity

        # Apply smoothing
        if self.settings.smoothing_factor > 0 and hasattr(self, "_last_samples"):
            alpha = self.settings.smoothing_factor
            samples = alpha * self._last_samples + (1 - alpha) * samples

        self._last_samples = samples

        # Normalize to display range
        if self.settings.auto_normalize:
            max_val = np.max(np.abs(samples))
            if max_val > 0:
                samples = samples / max_val * self.settings.normalization_target

        # Convert to screen coordinates
        height = self.settings.height
        y_coords = (samples + 1.0) * (height / 2.0,
    )
        return np.clip(y_coords, 0, height - 1)


    def _render_spectrum_data(self, waveform: WaveformData) -> np.ndarray:
        """Render spectrum visualization data."""
        samples = waveform.to_numpy_array()

        # Apply window function
        if self.settings.window_function.value != "none":
            if self.settings.window_function.value == "hann":
                window = np.hanning(len(samples))
            elif self.settings.window_function.value == "hamming":
                window = np.hamming(len(samples))
            elif self.settings.window_function.value == "blackman":
                window = np.blackman(len(samples))
            else:
                window = np.ones(len(samples))

            samples = samples * window

        # Pad to FFT size
        if len(samples,
    ) < self.settings.fft_size:
            samples = np.pad(samples, (0, self.settings.fft_size - len(samples)))
        elif len(samples) > self.settings.fft_size:
            samples = samples[:self.settings.fft_size]

        # Compute FFT
        fft = np.fft.rfft(samples)
        magnitude = np.abs(fft)

        # Convert to dB
        magnitude = 20 * np.log10(magnitude + 1e-10,
    )

        # Apply frequency range filtering
        freq_bins = np.fft.rfftfreq(self.settings.fft_size, 1.0 / self.settings.sample_rate)
        freq_min, freq_max = self.settings.frequency_range

        mask = (freq_bins >= freq_min) & (freq_bins <= freq_max)
        magnitude = magnitude[mask]

        # Downsample to display width
        target_points = self.settings.width
        if len(magnitude) > target_points:
            # Bin averaging for downsampling
            bin_size = len(magnitude) // target_points
            magnitude = magnitude[:target_points * bin_size].reshape(-1, bin_size).mean(axis=1)

        # Normalize to display range
        magnitude = magnitude - np.min(magnitude)
        max_val = np.max(magnitude)
        if max_val > 0:
            magnitude = magnitude / max_val

        # Convert to screen coordinates
        height = self.settings.height
        y_coords = magnitude * height
        return np.clip(y_coords, 0, height - 1)


    def _render_level_meter_data(self, waveform: WaveformData,
    ) -> np.ndarray:
        """Render level meter visualization data."""
        # Calculate RMS and peak levels
        rms_level = waveform.rms_level
        peak_level = waveform.peak_level

        # Apply peak hold
        if hasattr(self, "_held_peak"):
            if peak_level > self._held_peak:
                self._held_peak = peak_level
                self._peak_hold_time = time.time()
            elif time.time() - self._peak_hold_time > (self.settings.peak_hold_time_ms / 1000.0):
                self._held_peak *= self.settings.decay_rate
        else:
            self._held_peak = peak_level
            self._peak_hold_time = time.time()

        # Create level meter data
        height = self.settings.height

        # RMS level bar
        rms_height = int(rms_level * height)

        # Peak level indicator
        peak_height = int(self._held_peak * height)

        # Create visualization array
        vis_data = np.zeros(height)

        # Fill RMS level
        if rms_height > 0:
            vis_data[:rms_height] = 1.0

        # Add peak indicator
        if peak_height < height:
            vis_data[peak_height] = 1.0

        return vis_data

    def _add_to_frame_buffer(self, frame: VisualizationFrame,
    ) -> None:
        """Add frame to buffer with size management."""
        self.frame_buffer.append(frame)

        # Remove old frames if buffer is full
        while len(self.frame_buffer) > self.max_frame_buffer_size:
            self.frame_buffer.pop(0)

    def _update_render_statistics(self, render_time_ms: float,
    ) -> None:
        """Update rendering statistics."""
        self.statistics.frames_rendered += 1

        # Update peak render time
        self.statistics.peak_render_time_ms = max(self.statistics.peak_render_time_ms, render_time_ms)

        # Update average render time
        alpha = 0.1  # Smoothing factor
        if self.statistics.average_render_time_ms == 0.0:
            self.statistics.average_render_time_ms = render_time_ms
        else:
            self.statistics.average_render_time_ms = (
                alpha * render_time_ms +
                (1 - alpha) * self.statistics.average_render_time_ms
            )

        # Update FPS calculation
        current_time = time.time()
        self._frame_times.append(current_time)

        # Keep only recent frame times (last second)
        cutoff_time = current_time - 1.0
        self._frame_times = [t for t in self._frame_times if t > cutoff_time]

        # Calculate current FPS
        if len(self._frame_times) > 1:
            time_span = self._frame_times[-1] - self._frame_times[0]
            if time_span > 0:
                self.statistics.current_fps = (len(self._frame_times) - 1,
    ) / time_span

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