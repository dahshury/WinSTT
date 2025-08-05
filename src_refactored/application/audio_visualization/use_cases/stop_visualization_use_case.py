"""Stop Visualization Use Case.

This module implements the StopVisualizationUseCase for handling audio
visualization shutdown with progress tracking and error handling.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from src_refactored.domain.audio_visualization.value_objects.visualization_control import (
    ShutdownStrategy,
    StopPhase,
    StopResult,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.audio_visualization.value_objects.visualization_configuration import \
    (
        VisualizationStopConfiguration,
    )


@dataclass
class StopVisualizationRequest:
    """Request for stopping visualization."""
    configuration: VisualizationStopConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[StopResult], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class StopVisualizationResponse:
    """Response from stopping visualization."""
    result: StopResult
    signals_disconnected: bool = False
    processor_stopped: bool = False
    resources_cleaned: bool = False
    visualization_deactivated: bool = False
    shutdown_time: float | None = None
    error_message: str | None = None
    warnings: list[str] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class AudioProcessorServiceProtocol(Protocol,
    ):
    """Protocol for audio processor service."""

    def stop_processor(self, processor: Any, timeout: float | None = None) -> bool:
        """Stop the audio processor.
        
        Args:
            processor: Audio processor instance
            timeout: Maximum time to wait for stop
            
        Returns:
            True if stopped successfully
        """
        ...

    def force_stop_processor(self, processor: Any,
    ) -> bool:
        """Force stop the audio processor.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if force stopped successfully
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

    def cleanup_processor(self, processor: Any,
    ) -> bool:
        """Clean up processor resources.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if cleaned up successfully
        """
        ...


class SignalConnectionServiceProtocol(Protocol):
    """Protocol for signal connection service."""

    def disconnect_all_signals(self, processor: Any,
    ) -> bool:
        """Disconnect all signals from processor.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            True if disconnected successfully
        """
        ...

    def get_connected_signals_count(self, processor: Any,
    ) -> int:
        """Get count of connected signals.
        
        Args:
            processor: Audio processor instance
            
        Returns:
            Number of connected signals
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

    def clear_visualization_state(self) -> None:
        """Clear all visualization state."""
        ...


class ResourceCleanupServiceProtocol(Protocol):
    """Protocol for resource cleanup service."""

    def cleanup_audio_resources(self) -> bool:
        """Clean up audio-related resources.
        
        Returns:
            True if cleaned up successfully
        """
        ...

    def cleanup_visualization_resources(self) -> bool:
        """Clean up visualization-related resources.
        
        Returns:
            True if cleaned up successfully
        """
        ...

    def force_cleanup_all(self) -> bool:
        """Force cleanup of all resources.
        
        Returns:
            True if cleaned up successfully
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


class StopVisualizationUseCase:
    """Use case for stopping audio visualization."""

    def __init__(
        self,
        audio_processor_service: AudioProcessorServiceProtocol,
        signal_connection_service: SignalConnectionServiceProtocol,
        visualization_state_service: VisualizationStateServiceProtocol,
        resource_cleanup_service: ResourceCleanupServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            audio_processor_service: Service for audio processor management
            signal_connection_service: Service for signal connections
            visualization_state_service: Service for visualization state
            resource_cleanup_service: Service for resource cleanup
            logger_service: Service for logging
        """
        self._audio_processor_service = audio_processor_service
        self._signal_connection_service = signal_connection_service
        self._visualization_state_service = visualization_state_service
        self._resource_cleanup_service = resource_cleanup_service
        self._logger_service = logger_service

    def execute(self, request: StopVisualizationRequest,
    ) -> StopVisualizationResponse:
        """Execute the stop visualization use case.
        
        Args:
            request: The stop request
            
        Returns:
            StopVisualizationResponse with shutdown results
        """
        import time
        start_time = time.time()

        response = StopVisualizationResponse(result=StopResult.SUCCESS)

        try:
            # Phase 1: Initialize and check current status
            self._logger_service.log_info(
                "Stopping audio visualization",
                phase=StopPhase.INITIALIZING.value,
                strategy=request.configuration.shutdown_strategy.value,
            )

            if request.progress_callback:
                request.progress_callback("Initializing shutdown...", 10.0)

            # Phase 2: Check if visualization is already stopped
            self._logger_service.log_info(
                "Checking visualization status",
                phase=StopPhase.CHECKING_STATUS.value,
            )

            if not self._visualization_state_service.is_visualization_active():
                self._logger_service.log_info("Visualization is already stopped")

                if request.completion_callback:
                    request.completion_callback(StopResult.ALREADY_STOPPED)

                response.result = StopResult.ALREADY_STOPPED
                response.visualization_deactivated = True
                response.shutdown_time = time.time() - start_time
                return response

            # Get current processor
            current_processor = self._visualization_state_service.get_current_processor()
            if not current_processor:
                self._logger_service.log_warning("No current processor found, but visualization is active")
                # Continue with deactivation

            # Phase 3: Disconnect signals if configured and processor exists
            if request.configuration.disconnect_signals and current_processor:
                self._logger_service.log_info(
                    "Disconnecting processor signals",
                    phase=StopPhase.DISCONNECTING_SIGNALS.value,
                )

                if request.progress_callback:
                    request.progress_callback("Disconnecting signals...", 25.0)

                signals_disconnected = self._signal_connection_service.disconnect_all_signals(
                    current_processor,
                )

                response.signals_disconnected = signals_disconnected

                if not signals_disconnected:
                    warning_message = "Failed to disconnect some signals"
                    self._logger_service.log_warning(warning_message)
                    response.warnings.append(warning_message)

                    if request.error_callback:
                        request.error_callback(f"Warning: {warning_message}",
    )

            # Phase 4: Stop the processor if it exists and is running
            if current_processor:
                self._logger_service.log_info(
                    "Stopping audio processor",
                    phase=StopPhase.STOPPING_PROCESSOR.value,
                )

                if request.progress_callback:
                    request.progress_callback("Stopping processor...", 50.0)

                processor_stopped = False

                if request.configuration.shutdown_strategy == ShutdownStrategy.FORCE:
                    processor_stopped = self._audio_processor_service.force_stop_processor(
                        current_processor,
                    )
                else:
                    processor_stopped = self._audio_processor_service.stop_processor(
                        current_processor,
                        timeout=request.configuration.timeout,
                    )

                    # If graceful stop failed and force_stop_on_timeout is enabled
                    if not processor_stopped and request.configuration.force_stop_on_timeout:
                        self._logger_service.log_warning("Graceful stop failed, attempting force stop")
                        processor_stopped = self._audio_processor_service.force_stop_processor(
                            current_processor,
                        )

                response.processor_stopped = processor_stopped

                if not processor_stopped:
                    error_message = "Failed to stop audio processor"
                    self._logger_service.log_error(error_message)

                    if request.error_callback:
                        request.error_callback(error_message,
    )

                    response.result = StopResult.PROCESSOR_STOP_FAILED
                    response.error_message = error_message
                    # Continue with cleanup anyway

            # Phase 5: Clean up resources if configured
            if request.configuration.cleanup_resources:
                self._logger_service.log_info(
                    "Cleaning up resources",
                    phase=StopPhase.CLEANING_UP.value,
                )

                if request.progress_callback:
                    request.progress_callback("Cleaning up resources...", 75.0)

                resources_cleaned = True

                # Clean up processor-specific resources
                if current_processor:
                    processor_cleaned = self._audio_processor_service.cleanup_processor(
                        current_processor,
                    )
                    if not processor_cleaned:
                        resources_cleaned = False
                        warning_message = "Failed to clean up processor resources"
                        self._logger_service.log_warning(warning_message)
                        response.warnings.append(warning_message)

                # Clean up audio resources
                audio_cleaned = self._resource_cleanup_service.cleanup_audio_resources()
                if not audio_cleaned:
                    resources_cleaned = False
                    warning_message = "Failed to clean up audio resources"
                    self._logger_service.log_warning(warning_message)
                    response.warnings.append(warning_message)

                # Clean up visualization resources
                viz_cleaned = self._resource_cleanup_service.cleanup_visualization_resources()
                if not viz_cleaned:
                    resources_cleaned = False
                    warning_message = "Failed to clean up visualization resources"
                    self._logger_service.log_warning(warning_message)
                    response.warnings.append(warning_message)

                response.resources_cleaned = resources_cleaned

if not resources_cleaned and request.configuration.shutdown_strategy = (
    = ShutdownStrategy.FORCE:)
                    self._logger_service.log_warning("Attempting force cleanup")
                    force_cleaned = self._resource_cleanup_service.force_cleanup_all()
                    if force_cleaned:
                        response.resources_cleaned = True
                        response.warnings.append("Resources cleaned using force cleanup",
    )

            # Phase 6: Deactivate visualization
            self._logger_service.log_info(
                "Deactivating visualization",
                phase=StopPhase.DEACTIVATING_VISUALIZATION.value,
            )

            if request.progress_callback:
                request.progress_callback("Deactivating visualization...", 90.0)

            # Clear processor and deactivate visualization
            self._visualization_state_service.set_current_processor(None)
            self._visualization_state_service.set_visualization_active(False)

            if request.configuration.cleanup_resources:
                self._visualization_state_service.clear_visualization_state()

            response.visualization_deactivated = True

            # Phase 7: Complete shutdown
            shutdown_time = time.time() - start_time
            response.shutdown_time = shutdown_time

            if request.progress_callback:
                request.progress_callback("Visualization stopped successfully!", 100.0)

            if request.completion_callback:
                request.completion_callback(response.result)

            self._logger_service.log_info(
                "Audio visualization stopped successfully",
                phase=StopPhase.COMPLETING.value,
                shutdown_time=shutdown_time,
                strategy=request.configuration.shutdown_strategy.value,
                warnings_count=len(response.warnings)
            )

            return response

        except Exception as e:
            error_message = f"Error stopping visualization: {e!s}"

            self._logger_service.log_error(
                "Visualization shutdown failed",
                phase=StopPhase.ERROR_HANDLING.value,
                error=str(e)
            )

            if request.error_callback:
                request.error_callback(error_message)

            response.result = StopResult.FAILURE
            response.error_message = error_message
            response.shutdown_time = time.time() - start_time

            return response