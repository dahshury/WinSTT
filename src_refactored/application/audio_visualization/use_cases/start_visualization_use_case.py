"""Start Visualization Use Case.

This module implements the StartVisualizationUseCase for handling audio
visualization startup with progress tracking and error handling.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from src_refactored.domain.audio_visualization.value_objects.visualization_control import (
    ProcessorType,
    StartPhase,
    StartResult,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.audio_visualization.value_objects.visualization_configuration import \
    (
        VisualizationConfiguration,
    )


@dataclass
class StartVisualizationRequest:
    """Request for starting visualization."""
    configuration: VisualizationConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[StartResult], None] | None = None
    error_callback: Callable[[str], None] | None = None
    data_ready_callback: Callable[[Any], None] | None = None


@dataclass
class StartVisualizationResponse:
    """Response from starting visualization."""
    result: StartResult
    processor_created: bool = False
    signals_connected: bool = False
    visualization_active: bool = False
    startup_time: float | None = None
    error_message: str | None = None
    warnings: list[str] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class AudioProcessorServiceProtocol(Protocol,
    ):
    """Protocol for audio processor service."""

    def create_processor(self, processor_type: ProcessorType,
    ) -> Any | None:
        """Create an audio processor.
        
        Args:
            processor_type: Type of processor to create
            
        Returns:
            Audio processor instance or None if failed
        """
        ...

    def start_processor(self, processor: Any,
    ) -> bool:
        """Start the audio processor.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if started successfully
        """
        ...

    def is_processor_running(self, processor: Any,
    ) -> bool:
        """Check if processor is running.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if processor is running
        """
        ...


class SignalConnectionServiceProtocol(Protocol):
    """Protocol for signal connection service."""

    def connect_data_ready_signal(
        self,
        processor: Any,
        callback: Callable[[Any], None],
    ) -> bool:
        """Connect data ready signal to callback.
        
        Args:
            processor: Audio processor instance
            callback: Callback function for data ready signal
            
        Returns:
            True if connected successfully
        """
        ...

    def disconnect_all_signals(self, processor: Any,
    ) -> bool:
        """Disconnect all signals from processor.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if disconnected successfully
        """
        ...


class VisualizationStateServiceProtocol(Protocol):
    """Protocol for visualization state service."""

    def is_visualization_active(self) -> bool:
        """Check if visualization is currently active.
        
        Returns:
            True if visualization is active
        """
        ...

    def set_visualization_active(self, active: bool,
    ) -> None:
        """Set visualization active state.
        
        Args:
            active: Whether visualization should be active
        """
        ...

    def get_current_processor(self) -> Any | None:
        """Get the current audio processor.
        
        Returns:
            Current processor or None if not set
        """
        ...

    def set_current_processor(self, processor: Any | None) -> None:
        """Set the current audio processor.
        
        Args:
            processor: Audio processor to set
        """
        ...


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device service."""

    def validate_audio_device(self) -> bool:
        """Validate that audio device is available.
        
        Returns:
            True if audio device is available
        """
        ...

    def get_device_info(self) -> dict[str, Any]:
        """Get audio device information.
        
        Returns:
            Dictionary with device information
        """
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logger service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log an info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log a warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log an error message."""
        ...

    def log_debug(self, message: str, **kwargs) -> None:
        """Log a debug message."""
        ...


class StartVisualizationUseCase:
    """Use case for starting audio visualization."""

    def __init__(
        self,
        audio_processor_service: AudioProcessorServiceProtocol,
        signal_connection_service: SignalConnectionServiceProtocol,
        visualization_state_service: VisualizationStateServiceProtocol,
        audio_device_service: AudioDeviceServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            audio_processor_service: Service for audio processor management
            signal_connection_service: Service for signal connections
            visualization_state_service: Service for visualization state
            audio_device_service: Service for audio device validation
            logger_service: Service for logging
        """
        self._audio_processor_service = audio_processor_service
        self._signal_connection_service = signal_connection_service
        self._visualization_state_service = visualization_state_service
        self._audio_device_service = audio_device_service
        self._logger_service = logger_service

    def execute(self, request: StartVisualizationRequest,
    ) -> StartVisualizationResponse:
        """Execute the start visualization use case.
        
        Args:
            request: The start request
            
        Returns:
            StartVisualizationResponse with startup results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize and check current status
            self._logger_service.log_info(
                "Starting audio visualization",
                phase=StartPhase.INITIALIZING.value,
            )

            if request.progress_callback:
                request.progress_callback("Initializing visualization...", 10.0)

            # Phase 2: Check if visualization is already running
            self._logger_service.log_info(
                "Checking visualization status",
                phase=StartPhase.CHECKING_STATUS.value,
            )

            if self._visualization_state_service.is_visualization_active():
                current_processor = self._visualization_state_service.get_current_processor()
                if current_processor and
    self._audio_processor_service.is_processor_running(current_processor):
                    self._logger_service.log_info("Visualization is already running")

                    if request.completion_callback:
                        request.completion_callback(StartResult.ALREADY_RUNNING)

                    return StartVisualizationResponse(
                        result=StartResult.ALREADY_RUNNING,
                        processor_created=False,
                        signals_connected=True,
                        visualization_active=True,
                        startup_time=time.time() - start_time,
                    )

            # Phase 3: Validate audio device if configured
            if request.configuration.validate_audio_device:
                if request.progress_callback:
                    request.progress_callback("Validating audio device...", 20.0)

                if not self._audio_device_service.validate_audio_device():
                    error_message = "Audio device validation failed"
                    self._logger_service.log_error("Audio device not available")

                    if request.error_callback:
                        request.error_callback(error_message)

                    return StartVisualizationResponse(
                        result=StartResult.AUDIO_INITIALIZATION_FAILED,
                        startup_time=time.time() - start_time,
                        error_message=error_message,
                    )

            # Phase 4: Create audio processor
            self._logger_service.log_info(
                "Creating audio processor",
                phase=StartPhase.CREATING_PROCESSOR.value,
                processor_type=request.configuration.processor_type.value,
            )

            if request.progress_callback:
                request.progress_callback("Creating audio processor...", 40.0)

            processor = self._audio_processor_service.create_processor(
                request.configuration.processor_type,
            )

            if not processor:
                error_message = "Failed to create audio processor"
                self._logger_service.log_error("Audio processor creation failed")

                if request.error_callback:
                    request.error_callback(error_message,
    )

                return StartVisualizationResponse(
                    result=StartResult.PROCESSOR_CREATION_FAILED,
                    startup_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 5: Connect signals if configured
            signals_connected = False
            if request.configuration.enable_signal_connections:
                self._logger_service.log_info(
                    "Connecting processor signals",
                    phase=StartPhase.CONNECTING_SIGNALS.value,
                )

                if request.progress_callback:
                    request.progress_callback("Connecting signals...", 60.0)

                # Use provided callback or default handler
                data_callback = request.data_ready_callback
                if not data_callback:
                    data_callback = self._default_data_handler

                signals_connected = self._signal_connection_service.connect_data_ready_signal(
                    processor, data_callback,
                )

                if not signals_connected:
                    error_message = "Failed to connect processor signals"
                    self._logger_service.log_warning("Signal connection failed",
    )

                    # Continue anyway, but log warning
                    if request.error_callback:
                        request.error_callback(f"Warning: {error_message}")

            # Phase 6: Start the processor if configured
            processor_started = False
            if request.configuration.auto_start_processor:
                self._logger_service.log_info(
                    "Starting audio processor",
                    phase=StartPhase.STARTING_PROCESSOR.value,
                )

                if request.progress_callback:
                    request.progress_callback("Starting processor...", 80.0)

                processor_started = self._audio_processor_service.start_processor(processor)

                if not processor_started:
                    error_message = "Failed to start audio processor"
                    self._logger_service.log_error("Audio processor start failed")

                    if request.error_callback:
                        request.error_callback(error_message,
    )

                    return StartVisualizationResponse(
                        result=StartResult.FAILURE,
                        processor_created=True,
                        signals_connected=signals_connected,
                        visualization_active=False,
                        startup_time=time.time() - start_time,
                        error_message=error_message,
                    )

            # Phase 7: Activate visualization
            self._logger_service.log_info(
                "Activating visualization",
                phase=StartPhase.ACTIVATING_VISUALIZATION.value,
            )

            if request.progress_callback:
                request.progress_callback("Activating visualization...", 90.0)

            # Set processor and activate visualization
            self._visualization_state_service.set_current_processor(processor)
            self._visualization_state_service.set_visualization_active(True)

            # Phase 8: Complete startup
            startup_time = time.time() - start_time

            if request.progress_callback:
                request.progress_callback("Visualization started successfully!", 100.0)

            if request.completion_callback:
                request.completion_callback(StartResult.SUCCESS)

            self._logger_service.log_info(
                "Audio visualization started successfully",
                phase=StartPhase.COMPLETING.value,
                startup_time=startup_time,
                processor_type=request.configuration.processor_type.value,
            )

            return StartVisualizationResponse(
                result=StartResult.SUCCESS,
                processor_created=True,
                signals_connected=signals_connected,
                visualization_active=True,
                startup_time=startup_time,
            )

        except Exception as e:
            error_message = f"Error starting visualization: {e!s}"

            self._logger_service.log_error(
                "Visualization startup failed",
                phase=StartPhase.ERROR_HANDLING.value,
                error=str(e)
            )

            if request.error_callback:
                request.error_callback(error_message)

            return StartVisualizationResponse(
                result=StartResult.FAILURE,
                startup_time=time.time() - start_time,
                error_message=error_message,
            )

    def _default_data_handler(self, data: Any,
    ) -> None:
        """Default handler for audio data.

        Args:
            data: Audio data from processor
        """
        try:
            self._logger_service.log_debug("Received audio data",
            data_size=len(data) if hasattr(data, "__len__") else "unknown")
        except Exception as e:
            self._logger_service.log_warning("Error in default data handler", error=str(e))