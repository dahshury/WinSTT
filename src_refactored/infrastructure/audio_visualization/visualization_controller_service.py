"""Visualization Controller Service for visualization lifecycle management.

This module implements the VisualizationControllerService that provides
visualization lifecycle management with progress tracking.
Extracted from src/ui/voice_visualizer.py lines 155-193.
"""

import contextlib
from collections.abc import Callable
from datetime import datetime
from typing import Protocol

import numpy as np
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.audio.value_objects.audio_samples import (
    AudioDataType,
    AudioSampleData,
    SampleRate,
)
from src_refactored.domain.audio_visualization.entities.audio_processor import (
    AudioProcessor,
    AudioProcessorConfig,
)
from src_refactored.domain.audio_visualization.entities.visualizer import (
    Visualizer,
)
from src_refactored.domain.audio_visualization.ports.visualization_renderer_port import (
    VisualizationRendererPort,
)
from src_refactored.domain.audio_visualization.value_objects.visualization_settings import (
    VisualizationSettings,
)
from src_refactored.domain.common.ports.concurrency_management_port import ConcurrencyManagementPort
from src_refactored.domain.common.ports.time_management_port import TimeManagementPort
from src_refactored.infrastructure.audio.audio_buffer_service import AudioBufferService
from src_refactored.infrastructure.audio_visualization.audio_data_provider_service import (
    AudioDataProviderService,
)
from src_refactored.infrastructure.audio_visualization.audio_processor_service import (
    AudioProcessorService,
    PyAudioProcessor,
)
from src_refactored.infrastructure.system.logging_service import LoggingService


class VisualizationControllerServiceProtocol(Protocol):
    """Protocol for visualization controller service."""

    def create_visualizer(self, config: AudioProcessorConfig,
    ) -> Visualizer:
        """Create a new visualizer."""
        ...

    def start_visualization(self, visualizer: Visualizer,
    ) -> bool:
        """Start visualization processing."""
        ...

    def stop_visualization(self, visualizer: Visualizer,
    ) -> bool:
        """Stop visualization processing."""
        ...

    def is_active(self, visualizer: Visualizer,
    ) -> bool:
        """Check if visualization is active."""
        ...

    def connect_data_handler(
    self,
    visualizer: Visualizer,
    handler: Callable[[np.ndarray],
    None]) -> None:
        """Connect data handler for visualization updates."""
        ...


class VisualizationController(QObject):
    """Controller for managing audio visualization lifecycle.
    
    Extracted from original VoiceVisualizer class in voice_visualizer.py.
    Manages audio processor lifecycle and provides data forwarding.
    """

    # Signals for visualization events
    visualization_started = pyqtSignal(str)  # visualizer_id
    visualization_stopped = pyqtSignal(str)  # visualizer_id
    data_received = pyqtSignal(str, np.ndarray)  # visualizer_id, audio_data
    error_occurred = pyqtSignal(str, str)  # visualizer_id, error_message

    def __init__(self,
                 visualizer: Visualizer,
                 audio_processor_service: AudioProcessorService,
                 parent: QObject | None = None,
                 buffer_service: AudioBufferService | None = None):
        """Initialize the visualization controller.
        
        Args:
            visualizer: Visualizer entity
            audio_processor_service: Audio processor service
            parent: Parent QObject
        """
        super().__init__(parent)
        self.visualizer = visualizer
        self.audio_processor_service = audio_processor_service
        self.logger = LoggingService().get_logger("VisualizationController")
        self._buffer_service = buffer_service

        # Internal state
        self._processor: AudioProcessor | None = None
        self._pyaudio_processor: PyAudioProcessor | None = None
        self._is_active = False
        self._data_handlers: list[Callable[[np.ndarray], None]] = []

    def start_processing(self) -> bool:
        """Start the audio processor and visualization.
        
        Returns:
            True if started successfully, False otherwise
        """
        if self._is_active and self._processor:
            self.logger.warning("Visualization already active: {self.visualizer.id}")
            return True

        try:
            # Create audio processor if needed
            if not self._processor:
                config = AudioProcessorConfig(
                    sample_rate=16000,
                    chunk_size=1024,
                    buffer_size=100,
                )
                self._processor = self.audio_processor_service.create_processor(config)

                # Get PyAudio processor thread for signal connections
                self._pyaudio_processor = self.audio_processor_service.get_processor_thread(self._processor)

                if self._pyaudio_processor:
                    # Connect signals
                    self._pyaudio_processor.data_ready.connect(self._handle_new_data)
                    self._pyaudio_processor.error_occurred.connect(self._handle_error)
                    self._pyaudio_processor.status_changed.connect(self._handle_status_change)

            # Start the processor
            if self._processor and self.audio_processor_service.start_processor(self._processor):
                self._is_active = True
                self.visualizer.start()
                self.visualization_started.emit(self.visualizer.id)
                self.logger.info("Started visualization: {self.visualizer.id}")
                return True
            self.logger.error("Failed to start processor for: {self.visualizer.id}")
            return False

        except Exception as e:
            self.logger.exception(f"Error starting visualization {self.visualizer.id}: {e}")
            self.error_occurred.emit(self.visualizer.id, str(e))
            return False

    def stop_processing(self) -> bool:
        """Stop the audio processor and visualization.

        Returns:
            True if stopped successfully, False otherwise
        """
        if not self._is_active:
            self.logger.debug("Visualization already inactive: {self.visualizer.id}")
            return True

        try:
            self._is_active = False

            # Stop the processor
            if self._processor:
                success = self.audio_processor_service.stop_processor(self._processor)
                if success:
                    self.visualizer.stop()
                    self.visualization_stopped.emit(self.visualizer.id)
                    self.logger.info("Stopped visualization: {self.visualizer.id}")
                    return True
                self.logger.error("Failed to stop processor for: {self.visualizer.id}")
                return False

            return True

        except Exception as e:
            self.logger.exception(f"Error stopping visualization {self.visualizer.id}: {e}")
            self.error_occurred.emit(self.visualizer.id, str(e))
            return False

    def cleanup(self) -> None:
        """Clean up visualization resources."""
        try:
            if self._is_active:
                self.stop_processing()

            if self._processor:
                self.audio_processor_service.cleanup_processor(self._processor)
                self._processor = None
                self._pyaudio_processor = None

            self._data_handlers.clear()
            self.logger.info("Cleaned up visualization: {self.visualizer.id}")

        except Exception as e:
            self.logger.exception(f"Error cleaning up visualization {self.visualizer.id}: {e}")

    def add_data_handler(self, handler: Callable[[np.ndarray], None]) -> None:
        """Add a data handler for visualization updates.

        Args:
            handler: Function to handle audio data updates
        """
        if handler not in self._data_handlers:
            self._data_handlers.append(handler)
            self.logger.debug("Added data handler for: {self.visualizer.id}")

    def remove_data_handler(self, handler: Callable[[np.ndarray], None]) -> None:
        """Remove a data handler.

        Args:
            handler: Function to remove from handlers
        """
        if handler in self._data_handlers:
            self._data_handlers.remove(handler)
            self.logger.debug("Removed data handler for: {self.visualizer.id}")

    def is_processing(self) -> bool:
        """Check if the visualizer is currently processing audio.

        Returns:
            True if processing, False otherwise
        """
        return self._is_active

    def _handle_new_data(self, data: np.ndarray) -> None:
        """Handle new audio data from the processor.

        Args:
            data: Audio data from processor
        """
        if not self._is_active:
            return

        try:
            # Update shared buffer for the provider
            if self._buffer_service is not None:
                with contextlib.suppress(Exception):
                    sample_rate = SampleRate(self._processor.config.sample_rate) if self._processor else SampleRate.speech_standard()
                    sample = AudioSampleData(
                        samples=tuple(float(x) for x in data.tolist()),
                        sample_rate=sample_rate,
                        channels=1,
                        data_type=AudioDataType.FLOAT32,
                    )
                    self._buffer_service.update_buffer(sample)

            # Emit signal for external listeners
            self.data_received.emit(self.visualizer.id, data)

            # Call registered data handlers
            for handler in self._data_handlers:
                with contextlib.suppress(Exception):
                    handler(data)

        except Exception as e:
            self.logger.exception(f"Error handling audio data for {self.visualizer.id}: {e}")

    def _handle_error(self, error_message: str,
    ) -> None:
        """Handle error from audio processor.

        Args:
            error_message: Error message from processor
        """
        self.logger.error(f"Audio processor error for {self.visualizer.id}: {error_message}")
        self.error_occurred.emit(self.visualizer.id, error_message)

    def _handle_status_change(self, status: str,
    ) -> None:
        """Handle status change from audio processor.

        Args:
            status: New processor status
        """
        self.logger.debug("Processor status changed for {self.visualizer.id}: {status}")

        # Update visualizer status
        if self.visualizer:
            self.visualizer.update_settings(self.visualizer.settings)
            self.visualizer.update_settings(self.visualizer.settings)
            self.visualizer.update_settings(self.visualizer.settings)


class VisualizationControllerService:
    """Service for managing visualization controllers.

    Provides high-level interface for creating and managing
    visualization controllers with lifecycle management.
    """

    def __init__(self,
                 audio_processor_service: AudioProcessorService,
                 logger_service: LoggingService | None = None):
        """Initialize the visualization controller service.

        Args:
            audio_processor_service: Audio processor service
            logger_service: Optional logger service
        """
        self.audio_processor_service = audio_processor_service
        self.logger_service = logger_service or LoggingService()
        self.logger = self.logger_service.get_logger("VisualizationControllerService")
        self._active_controllers: dict[str, VisualizationController] = {}

    def create_visualizer(self, config: AudioProcessorConfig,
    ) -> Visualizer:
        """Create a new visualizer with controller.

        Args:
            config: Audio processor configuration

        Returns:
            Visualizer entity
        """
        f"visualizer_{len(self._active_controllers)}"

        # Create visualizer entity
        
        # Create simple mock implementations for now
        
        class MockConcurrencyPort(ConcurrencyManagementPort):
            def create_thread_context(self, name): return type("Result", (), {"is_success": True, "value": "mock_thread"})()
            def create_synchronization_event(self, name): return type("Result", (), {"is_success": True, "value": "mock_event"})()
            def create_lock(self, name): return type("Result", (), {"is_success": True, "value": "mock_lock"})()
            def acquire_lock(self, lock_id, timeout_seconds): return type("Result", (), {"is_success": True, "value": True})()
            def release_lock(self, lock_id): pass
            def start_background_task(self, thread_id, func, daemon): return type("Result", (), {"is_success": True})()
            def stop_background_task(self, thread_id, timeout_seconds): return type("Result", (), {"is_success": True})()
            def join_background_task(self, thread_id, timeout_seconds): pass
            def clear_event(self, event_id): pass
            def set_event(self, event_id): pass
            def wait_for_event(self, event_id, timeout_seconds): return type("Result", (), {"is_success": True, "value": False})()
            def is_event_set(self, event_id): return type("Result", (), {"is_success": True, "value": False})()
            def cleanup_thread_context(self, thread_id): pass
            def get_thread_state(self, thread_id): return type("Result", (), {"is_success": True, "value": "running"})()
        
        class MockTimePort(TimeManagementPort):
            def get_current_time(self): return type("Result", (), {"is_success": True, "value": type("MockTime", (), {"value": datetime.now()})()})()
            def get_current_datetime(self): return type("Result", (), {"is_success": True, "value": datetime.now()})()
            def get_current_timestamp_ms(self): return type("Result", (), {"is_success": True, "value": 0.0})()
            def measure_execution_time(self, name): return type("Result", (), {"is_success": True, "value": "mock_measurement"})()
            def stop_measurement(self, measurement_id): return type("Result", (), {"is_success": True, "value": 1.0})()
            def sleep(self, seconds): pass
            def get_execution_time_ms(self, measurement_id): return type("Result", (), {"is_success": True, "value": 1.0})()
        
        class MockRendererPort(VisualizationRendererPort):
            def render_waveform(self, waveform, settings): return type("Result", (), {"is_success": True, "value": type("MockVisData", (), {})()})()
            def render_spectrum(self, waveform, settings): return type("Result", (), {"is_success": True, "value": type("MockVisData", (), {})()})()
            def render_level_meter(self, waveform, settings): return type("Result", (), {"is_success": True, "value": type("MockVisData", (), {})()})()
            def create_visualization_frame(self, vis_data, settings, metadata): return type("Result", (), {"is_success": True, "value": type("MockFrame", (), {})()})()
            def supports_visualization_type(self, vis_type): return True
        
        settings = VisualizationSettings.default_waveform()
        
        # Create concrete implementations of the ports
        concurrency_port = MockConcurrencyPort()
        time_port = MockTimePort()
        renderer_port = MockRendererPort()
        
        # Create an infrastructure audio buffer and provider to feed the visualizer
        buffer_service = AudioBufferService(max_size=config.buffer_size)
        frame_window_ms = 1000.0 / max(1, settings.update_rate_hz)
        data_provider = AudioDataProviderService(
            buffer_service=buffer_service,
            sample_rate=config.sample_rate,
            frame_window_ms=frame_window_ms,
        )

        # Create the visualizer entity wired with the data provider port
        visualizer = Visualizer(
            settings=settings,
            concurrency_port=concurrency_port,
            time_port=time_port,
            renderer_port=renderer_port,
            data_provider_port=data_provider,
        )
        
        # Create controller
        controller = VisualizationController(
            visualizer=visualizer,
            audio_processor_service=self.audio_processor_service,
            buffer_service=buffer_service,
        )
        
        # Store reference
        self._active_controllers[str(visualizer.id)] = controller
        
        self.logger.info(f"Created visualizer: {visualizer.id}")
        return visualizer

    def start_visualization(self, visualizer: Visualizer,
    ) -> bool:
        """Start visualization processing.

        Args:
            visualizer: Visualizer entity

        Returns:
            True if started successfully, False otherwise
        """
        controller = self._active_controllers.get(str(visualizer.id))
        if not controller:
            self.logger.error(f"Controller not found: {visualizer.id}")
            return False

        return controller.start_processing()

    def stop_visualization(self, visualizer: Visualizer,
    ) -> bool:
        """Stop visualization processing.

        Args:
            visualizer: Visualizer entity

        Returns:
            True if stopped successfully, False otherwise
        """
        controller = self._active_controllers.get(str(visualizer.id))
        if not controller:
            self.logger.error(f"Controller not found: {visualizer.id}")
            return False

        return controller.stop_processing()

    def is_active(self, visualizer: Visualizer,
    ) -> bool:
        """Check if visualization is active.

        Args:
            visualizer: Visualizer entity

        Returns:
            True if active, False otherwise
        """
        controller = self._active_controllers.get(str(visualizer.id))
        if not controller:
            return False

        return controller.is_processing()

    def connect_data_handler(
    self,
    visualizer: Visualizer,
    handler: Callable[[np.ndarray],
    None]) -> None:
        """Connect data handler for visualization updates.

        Args:
            visualizer: Visualizer entity
            handler: Function to handle audio data updates
        """
        controller = self._active_controllers.get(str(visualizer.id))
        if controller:
            controller.add_data_handler(handler)
        else:
            self.logger.error(f"Controller not found: {visualizer.id}")

    def get_controller(self, visualizer: Visualizer,
    ) -> VisualizationController | None:
        """Get visualization controller for signal connections.

        Args:
            visualizer: Visualizer entity

        Returns:
            Visualization controller or None if not found
        """
        return self._active_controllers.get(str(visualizer.id))

    def cleanup_visualizer(self, visualizer: Visualizer,
    ) -> None:
        """Clean up visualizer resources.

        Args:
            visualizer: Visualizer entity
        """
        controller = self._active_controllers.get(str(visualizer.id))
        if controller:
            try:
                controller.cleanup()
                del self._active_controllers[str(visualizer.id)]
                self.logger.info(f"Cleaned up visualizer: {visualizer.id}")
            except Exception as e:
                self.logger.exception(f"Failed to cleanup visualizer {visualizer.id}: {e}")

    def cleanup_all(self) -> None:
        """Clean up all active visualizers."""
        for visualizer_id, controller in list(self._active_controllers.items()):
            try:
                controller.cleanup()
            except Exception as e:
                self.logger.exception(f"Error cleaning up visualizer {visualizer_id}: {e}")

        self._active_controllers.clear()
        self.logger.info("Cleaned up all visualizers")