"""Visualization Controller Service for visualization lifecycle management.

This module implements the VisualizationControllerService that provides
visualization lifecycle management with progress tracking.
Extracted from src/ui/voice_visualizer.py lines 155-193.
"""

import contextlib
from collections.abc import Callable
from typing import Protocol

import numpy as np
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.audio_visualization.entities.audio_processor import (
    AudioProcessor,
    AudioProcessorConfig,
    ProcessorStatus,
)
from src_refactored.domain.audio_visualization.entities.visualizer import (
    RenderMode,
    Visualizer,
    VisualizerStatus,
)
from src_refactored.infrastructure.audio_visualization.audio_processor_service import (
    AudioProcessorService,
    PyAudioProcessor,
)
from src_refactored.infrastructure.system.logging_service import LoggerService


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
                 parent: QObject | None = None):
        """Initialize the visualization controller.
        
        Args:
            visualizer: Visualizer entity
            audio_processor_service: Audio processor service
            parent: Parent QObject
        """
        super().__init__(parent)
        self.visualizer = visualizer
        self.audio_processor_service = audio_processor_service
        self.logger = LoggerService().get_logger("VisualizationController")

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
            self.logger.warning("Visualization already active: {self.visualizer.visualizer_id}")
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
self._pyaudio_processor = (
    self.audio_processor_service.get_processor_thread(self._processor))

                if self._pyaudio_processor:
                    # Connect signals
                    self._pyaudio_processor.data_ready.connect(self._handle_new_data)
                    self._pyaudio_processor.error_occurred.connect(self._handle_error)
                    self._pyaudio_processor.status_changed.connect(self._handle_status_change)

            # Start the processor
            if self._processor and self.audio_processor_service.start_processor(self._processor):
                self._is_active = True
                self.visualizer.start()
                self.visualization_started.emit(self.visualizer.visualizer_id)
                self.logger.info("Started visualization: {self.visualizer.visualizer_id}")
                return True
            self.logger.error("Failed to start processor for: {self.visualizer.visualizer_id}")
            return False

        except Exception as e:
            self.logger.exception(f"Error starting visualization {self.visualizer.visualizer_id}: {e\
    }")
            self.error_occurred.emit(self.visualizer.visualizer_id, str(e))
            return False

    def stop_processing(self) -> bool:
        """Stop the audio processor and visualization.

        Returns:
            True if stopped successfully, False otherwise
        """
        if not self._is_active:
            self.logger.debug("Visualization already inactive: {self.visualizer.visualizer_id}")
            return True

        try:
            self._is_active = False

            # Stop the processor
            if self._processor:
                success = self.audio_processor_service.stop_processor(self._processor)
                if success:
                    self.visualizer.stop()
                    self.visualization_stopped.emit(self.visualizer.visualizer_id)
                    self.logger.info("Stopped visualization: {self.visualizer.visualizer_id}")
                    return True
                self.logger.error("Failed to stop processor for: {self.visualizer.visualizer_id}")
                return False

            return True

        except Exception as e:
            self.logger.exception(f"Error stopping visualization {self.visualizer.visualizer_id}: {e}",
    )
            self.error_occurred.emit(self.visualizer.visualizer_id, str(e))
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
            self.logger.info("Cleaned up visualization: {self.visualizer.visualizer_id}")

        except Exception as e:
            self.logger.exception(f"Error cleaning up visualization {self.visualizer.visualizer_id}:\
     {e}")

    def add_data_handler(self, handler: Callable[[np.ndarray], None]) -> None:
        """Add a data handler for visualization updates.

        Args:
            handler: Function to handle audio data updates
        """
        if handler not in self._data_handlers:
            self._data_handlers.append(handler)
            self.logger.debug("Added data handler for: {self.visualizer.visualizer_id}")

    def remove_data_handler(self, handler: Callable[[np.ndarray], None]) -> None:
        """Remove a data handler.

        Args:
            handler: Function to remove from handlers
        """
        if handler in self._data_handlers:
            self._data_handlers.remove(handler)
            self.logger.debug("Removed data handler for: {self.visualizer.visualizer_id}")

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
            # Emit signal for external listeners
            self.data_received.emit(self.visualizer.visualizer_id, data)

            # Call registered data handlers
            for handler in self._data_handlers:
                with contextlib.suppress(Exception):
                    handler(data)

        except Exception as e:
            self.logger.exception(f"Error handling audio data for {self.visualizer.visualizer_id}: {\
    e}")

    def _handle_error(self, error_message: str,
    ) -> None:
        """Handle error from audio processor.

        Args:
            error_message: Error message from processor
        """
        self.logger.error("Audio processor error for {self.visualizer.visualizer_id}: {error_message\
    }")
        self.error_occurred.emit(self.visualizer.visualizer_id, error_message)

    def _handle_status_change(self, status: str,
    ) -> None:
        """Handle status change from audio processor.

        Args:
            status: New processor status
        """
        self.logger.debug("Processor status changed for {self.visualizer.visualizer_id}: {status}")

        # Update visualizer status based on processor status
        if status == ProcessorStatus.RUNNING.value:
            self.visualizer.update_status(VisualizerStatus.ACTIVE)
        elif status == ProcessorStatus.STOPPED.value:
            self.visualizer.update_status(VisualizerStatus.INACTIVE)
        elif status == ProcessorStatus.ERROR.value:
            self.visualizer.update_status(VisualizerStatus.ERROR)


class VisualizationControllerService:
    """Service for managing visualization controllers.

    Provides high-level interface for creating and managing
    visualization controllers with lifecycle management.
    """

    def __init__(self,
                 audio_processor_service: AudioProcessorService,
                 logger_service: LoggerService | None = None):
        """Initialize the visualization controller service.

        Args:
            audio_processor_service: Audio processor service
            logger_service: Optional logger service
        """
        self.audio_processor_service = audio_processor_service
        self.logger_service = logger_service or LoggerService()
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
        visualizer_id = f"visualizer_{len(self._active_controllers)}"

        # Create visualizer entity
        visualizer = Visualizer(
            visualizer_id=visualizer_id,
            render_mode=RenderMode.WAVEFORM,
            status=VisualizerStatus.INACTIVE,
        )

        # Create controller
        controller = VisualizationController(
            visualizer=visualizer,
            audio_processor_service=self.audio_processor_service,
        )

        # Store reference
        self._active_controllers[visualizer_id] = controller

        self.logger.info("Created visualizer: {visualizer_id}")
        return visualizer

    def start_visualization(self, visualizer: Visualizer,
    ) -> bool:
        """Start visualization processing.

        Args:
            visualizer: Visualizer entity

        Returns:
            True if started successfully, False otherwise
        """
        controller = self._active_controllers.get(visualizer.visualizer_id)
        if not controller:
            self.logger.error("Controller not found: {visualizer.visualizer_id}")
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
        controller = self._active_controllers.get(visualizer.visualizer_id)
        if not controller:
            self.logger.error("Controller not found: {visualizer.visualizer_id}")
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
        controller = self._active_controllers.get(visualizer.visualizer_id)
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
        controller = self._active_controllers.get(visualizer.visualizer_id)
        if controller:
            controller.add_data_handler(handler)
        else:
            self.logger.error("Controller not found: {visualizer.visualizer_id}")

    def get_controller(self, visualizer: Visualizer,
    ) -> VisualizationController | None:
        """Get visualization controller for signal connections.

        Args:
            visualizer: Visualizer entity

        Returns:
            Visualization controller or None if not found
        """
        return self._active_controllers.get(visualizer.visualizer_id)

    def cleanup_visualizer(self, visualizer: Visualizer,
    ) -> None:
        """Clean up visualizer resources.

        Args:
            visualizer: Visualizer entity
        """
        controller = self._active_controllers.get(visualizer.visualizer_id)
        if controller:
            try:
                controller.cleanup()
                del self._active_controllers[visualizer.visualizer_id]
                self.logger.info("Cleaned up visualizer: {visualizer.visualizer_id}")
            except Exception as e:
                self.logger.exception(f"Failed to cleanup visualizer {visualizer.visualizer_id}: {e}\
    ")

    def cleanup_all(self) -> None:
        """Clean up all active visualizers."""
        for visualizer_id, controller in list(self._active_controllers.items()):
            try:
                controller.cleanup()
            except Exception as e:
                self.logger.exception(f"Error cleaning up visualizer {visualizer_id}: {e}")

        self._active_controllers.clear()
        self.logger.info("Cleaned up all visualizers")