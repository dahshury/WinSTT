"""Voice Visualizer UI Component.

This module provides the visualization UI controller for audio waveform display,
managing the visual representation of real-time audio data.
"""

import contextlib
from collections.abc import Callable

import numpy as np
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.audio_visualization.ports.waveform_update_port import IWaveformUpdatePort
from src_refactored.domain.audio_visualization.value_objects.visualization_config import (
    VisualizationConfig,
)
from src_refactored.domain.audio_visualization.value_objects.waveform_data import (
    WaveformData,
)
from src_refactored.infrastructure.audio_visualization.visualization_service import (
    VisualizationService,
)


class VoiceVisualizerUI(QObject):
    """Voice visualizer UI controller.
    
    This component handles:
    - Audio waveform visualization management
    - Real-time data updates from audio processor
    - UI state management for visualization
    - Integration with parent UI components
    - Visualization configuration and scaling
    """

    # Signals for visualization events
    visualization_started = pyqtSignal()
    visualization_stopped = pyqtSignal()
    waveform_updated = pyqtSignal(object)  # WaveformData
    visualization_error = pyqtSignal(str)  # error_message
    processing_state_changed = pyqtSignal(bool)  # is_processing

    def __init__(self, waveform_update_port: IWaveformUpdatePort, parent=None):
        """Initialize the voice visualizer UI.
        
        Args:
            waveform_update_port: Port for waveform update operations
            parent: Parent UI component
        """
        super().__init__(parent)

        # Injected dependencies
        self._waveform_update_port = waveform_update_port

        # Initialize services
        self._visualization_service = VisualizationService()

        # State management
        self._is_active = False
        self._is_processing = False

        # Configuration
        self._visualization_config = VisualizationConfig(
            sample_rate=16000,
            chunk_size=1024,
            buffer_size=100,
            scale_factor=0.5,
            clip_range=(-0.7, 0.7),
            normalization_factor=2.5,
        )

        # Audio processor reference
        self._audio_processor = None

        # Data handlers
        self._waveform_handler: Callable[[np.ndarray], None] | None = None
        self._update_callback: Callable[[np.ndarray], None] | None = None

        # Current waveform data
        self._current_waveform: WaveformData | None = None

    def set_audio_processor(self, processor):
        """Set the audio processor for data source.
        
        Args:
            processor: Audio processor instance
        """
        # Disconnect from previous processor if any
        if self._audio_processor:
            with contextlib.suppress(TypeError, RuntimeError):
                self._audio_processor.data_ready.disconnect(self.handle_new_data)

        self._audio_processor = processor

        # Connect to new processor
        if processor:
            processor.data_ready.connect(self.handle_new_data)

    def set_visualization_config(self, config: VisualizationConfig):
        """Set visualization configuration.
        
        Args:
            config: Visualization configuration
        """
        self._visualization_config = config

    def set_waveform_handler(self, handler: Callable[[np.ndarray], None]):
        """Set custom waveform data handler.
        
        Args:
            handler: Function to call with waveform data
        """
        self._waveform_handler = handler

    def set_update_callback(self, callback: Callable[[np.ndarray], None]):
        """Set update callback for parent UI.
        
        Args:
            callback: Function to call on waveform updates
        """
        self._update_callback = callback

    def start_visualization(self):
        """Start the audio visualization."""
        try:
            if self._is_active:
                return

            self._is_active = True
            self._is_processing = True

            # Emit signals
            self.visualization_started.emit()
            self.processing_state_changed.emit(True)

        except Exception as e:
            self.visualization_error.emit(f"Failed to start visualization: {e!s}")
            self._is_active = False
            self._is_processing = False

    def stop_visualization(self):
        """Stop the audio visualization."""
        try:
            self._is_active = False
            self._is_processing = False

            # Clear current waveform
            self._current_waveform = None

            # Emit signals
            self.visualization_stopped.emit()
            self.processing_state_changed.emit(False)

        except Exception as e:
            self.visualization_error.emit(f"Error stopping visualization: {e!s}")

    def handle_new_data(self, data: np.ndarray):
        """Handle new audio data from the processor.
        
        Args:
            data: Audio waveform data
        """
        try:
            if not self._is_active:
                return

            # Create waveform data object using value object factory
            timestamp_ms = self._get_current_timestamp() * 1000.0
            waveform_data = WaveformData.from_samples_list(
                samples=data.tolist(),
                sample_rate=self._visualization_config.sample_rate,
                timestamp_ms=timestamp_ms,
            )

            # Store current waveform
            self._current_waveform = waveform_data

            # Call custom handler if set
            if self._waveform_handler:
                self._waveform_handler(data)

            # Update parent UI if callback is set
            if self._update_callback:
                self._update_callback(data)

            # Try to update parent directly (legacy support)
            if self.parent() and hasattr(self.parent(), "update_waveform"):
                with contextlib.suppress(Exception):
                    self.parent().update_waveform(data)

            # Emit signal
            self.waveform_updated.emit(waveform_data)

        except Exception as e:
            self.visualization_error.emit(f"Error handling audio data: {e!s}")

    def is_processing(self) -> bool:
        """Check if the visualizer is currently processing audio.
        
        Returns:
            True if processing audio
        """
        return self._is_processing

    def is_active(self) -> bool:
        """Check if the visualizer is active.
        
        Returns:
            True if visualization is active
        """
        return self._is_active

    def get_current_waveform(self) -> WaveformData | None:
        """Get the current waveform data.
        
        Returns:
            Current waveform data or None
        """
        return self._current_waveform

    def get_visualization_config(self) -> VisualizationConfig:
        """Get the current visualization configuration.
        
        Returns:
            Visualization configuration
        """
        return self._visualization_config

    def update_scale_factor(self, scale_factor: float):
        """Update the visualization scale factor.
        
        Args:
            scale_factor: New scale factor (0.1 to 2.0)
        """
        if 0.1 <= scale_factor <= 2.0:
            self._visualization_config = self._visualization_config.with_scale_factor(scale_factor)
        else:
            self.visualization_error.emit("Scale factor must be between 0.1 and 2.0")

    def update_clip_range(self, min_val: float, max_val: float):
        """Update the visualization clipping range.
        
        Args:
            min_val: Minimum clipping value
            max_val: Maximum clipping value
        """
        if min_val < max_val:
            self._visualization_config = self._visualization_config.with_clip_range((min_val, max_val))
        else:
            self.visualization_error.emit("Invalid clip range: min must be less than max")

    def reset_visualization(self):
        """Reset the visualization to default state."""
        self._current_waveform = None

        # Reset to default configuration
        self._visualization_config = VisualizationConfig(
            sample_rate=16000,
            chunk_size=1024,
            buffer_size=100,
            scale_factor=0.5,
            clip_range=(-0.7, 0.7),
            normalization_factor=2.5,
        )

    def get_visualization_state(self) -> dict:
        """Get current visualization state information.
        
        Returns:
            Dictionary with state information
        """
        return {
            "is_active": self._is_active,
            "is_processing": self._is_processing,
            "has_audio_processor": self._audio_processor is not None,
            "has_current_waveform": self._current_waveform is not None,
            "has_waveform_handler": self._waveform_handler is not None,
            "has_update_callback": self._update_callback is not None,
            "sample_rate": self._visualization_config.sample_rate,
            "scale_factor": self._visualization_config.scale_factor,
        }

    def get_audio_processor(self):
        """Get the current audio processor.
        
        Returns:
            Audio processor instance or None
        """
        return self._audio_processor

    def clear_handlers(self):
        """Clear all custom handlers and callbacks."""
        self._waveform_handler = None
        self._update_callback = None

    def disconnect_audio_processor(self):
        """Disconnect from the current audio processor."""
        if self._audio_processor:
            with contextlib.suppress(TypeError, RuntimeError):
                self._audio_processor.data_ready.disconnect(self.handle_new_data)
            self._audio_processor = None

    def cleanup(self):
        """Clean up the visualizer resources."""
        try:
            # Stop visualization
            self.stop_visualization()

            # Disconnect from audio processor
            self.disconnect_audio_processor()

            # Clear handlers
            self.clear_handlers()

            # Clear state
            self._current_waveform = None
            self._is_active = False
            self._is_processing = False

        except Exception as e:
            self.visualization_error.emit(f"Error during cleanup: {e!s}")

    def _get_current_timestamp(self) -> float:
        """Get current timestamp for waveform data.
        
        Returns:
            Current timestamp in seconds
        """
        import time
        return time.time()

    def get_visualization_statistics(self) -> dict:
        """Get visualization statistics.
        
        Returns:
            Dictionary with statistics
        """
        return {
            "total_updates": 0,  # Would track in full implementation
            "error_count": 0,
            "average_update_rate": 0.0,
            "last_update_timestamp": 0.0,
            "buffer_size": self._visualization_config.buffer_size,
            "chunk_size": self._visualization_config.chunk_size,
        }

    def reset_statistics(self):
        """Reset visualization statistics."""
        # Would reset counters in full implementation

    def validate_configuration(self) -> bool:
        """Validate the current visualization configuration.
        
        Returns:
            True if configuration is valid
        """
        try:
            config = self._visualization_config

            # Check sample rate
            if config.sample_rate not in [8000, 16000, 22050, 44100, 48000]:
                return False

            # Check chunk size
            if config.chunk_size < 256 or config.chunk_size > 4096:
                return False

            # Check buffer size
            if config.buffer_size < 10 or config.buffer_size > 1000:
                return False

            # Check scale factor
            if config.scale_factor < 0.1 or config.scale_factor > 2.0:
                return False

            # Check clip range
            min_clip, max_clip = config.clip_range
            return not (min_clip >= max_clip or abs(min_clip) > 2.0 or abs(max_clip) > 2.0)

        except Exception:
            return False

    def get_recommended_config(self) -> VisualizationConfig:
        """Get recommended visualization configuration.
        
        Returns:
            Recommended configuration
        """
        return VisualizationConfig(
            sample_rate=16000,
            chunk_size=1024,
            buffer_size=100,
            scale_factor=0.5,
            clip_range=(-0.7, 0.7),
            normalization_factor=2.5,
        )

    def apply_recommended_config(self):
        """Apply recommended visualization configuration."""
        self._visualization_config = self.get_recommended_config()

    def get_waveform_info(self) -> dict:
        """Get information about the current waveform.
        
        Returns:
            Dictionary with waveform information
        """
        if not self._current_waveform:
            return {
                "has_waveform": False,
                "sample_count": 0,
                "duration": 0.0,
                "timestamp": 0.0,
            }

        waveform = self._current_waveform
        return {
            "has_waveform": True,
            "sample_count": len(waveform.samples),
            "duration": len(waveform.samples) / waveform.sample_rate,
            "timestamp": waveform.timestamp_ms / 1000.0,
            "sample_rate": waveform.sample_rate,
            "min_amplitude": float(np.min(waveform.samples)),
            "max_amplitude": float(np.max(waveform.samples)),
            "rms_amplitude": float(np.sqrt(np.mean(np.square(waveform.samples)))),
        }

    def export_waveform_data(self) -> dict | None:
        """Export current waveform data for external use.
        
        Returns:
            Waveform data dictionary or None
        """
        if not self._current_waveform:
            return None

        waveform = self._current_waveform
        return {
            "samples": list(waveform.samples),
            "sample_rate": waveform.sample_rate,
            "timestamp": waveform.timestamp_ms / 1000.0,
            "duration": len(waveform.samples) / waveform.sample_rate,
        }

    def import_waveform_data(self, data: dict) -> bool:
        """Import waveform data from external source.
        
        Args:
            data: Waveform data dictionary
            
        Returns:
            True if import was successful
        """
        try:
            samples = np.array(data["samples"], dtype=np.float32)
            sample_rate = data["sample_rate"]
            timestamp_ms = float(data.get("timestamp", self._get_current_timestamp())) * 1000.0

            self._current_waveform = WaveformData.from_samples_list(
                samples=samples.tolist(),
                sample_rate=sample_rate,
                timestamp_ms=timestamp_ms,
            )

            # Emit update signal
            self.waveform_updated.emit(self._current_waveform)

            return True

        except Exception as e:
            self.visualization_error.emit(f"Failed to import waveform data: {e!s}")
            return False