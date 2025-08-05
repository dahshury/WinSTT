"""Audio Stream Service.

This module implements the AudioStreamService for managing audio streaming
with non-blocking patterns and comprehensive stream management.
"""

import threading
import time
from dataclasses import dataclass
from enum import Enum
from queue import Empty, Queue
from typing import Protocol

from src_refactored.domain.audio.entities import AudioDevice

# Import domain value objects
from src_refactored.domain.audio.value_objects import (
    AudioBuffer,
    AudioStreamServiceRequest,
    BufferMode,
    StreamConfiguration,
    StreamDirection,
    StreamMetrics,
    StreamOperation,
    StreamResult,
)

# StreamResult, StreamOperation, StreamDirection, and BufferMode now imported from domain layer
# StreamState is imported from src_refactored.domain.audio.value_objects.audio_data
from src_refactored.domain.audio.value_objects.audio_data import StreamState


# Infrastructure-specific audio format enum (different from domain AudioFormat)
class InfraAudioFormat(Enum):
    """Infrastructure-specific audio format constants."""
    PCM_16 = "pcm_16"
    PCM_24 = "pcm_24"
    PCM_32 = "pcm_32"
    FLOAT_32 = "float_32"
    FLOAT_64 = "float_64"


# AudioDevice,
StreamConfiguration, AudioBuffer, StreamMetrics, and AudioStreamServiceRequest now imported from domain layer
    config: StreamConfiguration | None = None
    buffer_data: AudioBuffer | None = None
    device_id: int | None = None
    timeout: float = 5.0
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    enable_metrics: bool = True


@dataclass
class DeviceListResult:
    """Result of device listing operation."""
    devices_found: bool
    input_devices: list[AudioDevice] = None
    output_devices: list[AudioDevice] = None
    default_input: AudioDevice | None = None
    default_output: AudioDevice | None = None
    error_message: str | None = None

    def __post_init__(self,
    ):
        if self.input_devices is None:
            self.input_devices = []
        if self.output_devices is None:
            self.output_devices = []


@dataclass
class StreamStartResult:
    """Result of stream start operation."""
    stream_started: bool
    stream_id: str | None = None
    actual_config: StreamConfiguration | None = None
    latency_info: dict[str, float] | None = None
    error_message: str | None = None


@dataclass
class BufferOperationResult:
    """Result of buffer operations."""
    operation_successful: bool
    buffer: AudioBuffer | None = None
    buffers_available: int = 0
    buffer_space_available: int = 0
    error_message: str | None = None


@dataclass
class AudioStreamServiceState:
    """Current state of audio stream service."""
    initialized: bool = False
    current_config: StreamConfiguration | None = None
    input_stream_active: bool = False
    output_stream_active: bool = False
    input_stream_id: str | None = None
    output_stream_id: str | None = None
    processing_state: StreamState = StreamState.IDLE
    available_devices: DeviceListResult | None = None
    metrics: StreamMetrics | None = None
    error_message: str | None = None


@dataclass
class AudioStreamServiceResponse:
    """Response from audio stream service operations."""
    result: StreamResult
    state: AudioStreamServiceState
    device_list: DeviceListResult | None = None
    stream_start: StreamStartResult | None = None
    buffer_operation: BufferOperationResult | None = None
    buffers: list[AudioBuffer] | None = None
    error_message: str | None = None
    warnings: list[str] = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.buffers is None:
            self.buffers = []


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device service."""

    def list_devices(self,
    ) -> DeviceListResult:
        """List available audio devices."""
        ...

    def get_device_info(self, device_id: int,
    ) -> tuple[bool, AudioDevice | None, str | None]:
        """Get information about specific device."""
        ...

    def test_device(self, device_id: int, direction: StreamDirection,
    ) -> tuple[bool, str | None]:
        """Test device functionality."""
        ...

    def get_default_device(self, direction: StreamDirection,
    ) -> tuple[bool, AudioDevice | None, str | None]:
        """Get default device for direction."""
        ...


class StreamManagementServiceProtocol(Protocol):
    """Protocol for stream management service."""

    def create_stream(self, config: StreamConfiguration,
    ) -> tuple[bool, str | None, str | None]:
        """Create audio stream."""
        ...

    def start_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Start audio stream."""
        ...

    def stop_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Stop audio stream."""
        ...

    def pause_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Pause audio stream."""
        ...

    def resume_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Resume audio stream."""
        ...

    def destroy_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Destroy audio stream."""
        ...


class BufferManagementServiceProtocol(Protocol):
    """Protocol for buffer management service."""

    def read_buffer(self, stream_id: str, timeout: float,
    ) -> tuple[bool, AudioBuffer | None, str | None]:
        """Read audio buffer from input stream."""
        ...

    def write_buffer(self, stream_id: str, buffer: AudioBuffer, timeout: float,
    ) -> tuple[bool, str | None]:
        """Write audio buffer to output stream."""
        ...

    def get_buffer_info(self, stream_id: str,
    ) -> tuple[bool, int, int, str | None]:
        """Get buffer availability information."""
        ...

    def flush_buffers(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Flush stream buffers."""
        ...


class AudioValidationServiceProtocol(Protocol):
    """Protocol for audio validation service."""

    def validate_configuration(self, config: StreamConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate stream configuration."""
        ...

    def validate_device_compatibility(self,
    device: AudioDevice, config: StreamConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility with configuration."""
        ...

    def validate_buffer(self, buffer: AudioBuffer, config: StreamConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate audio buffer."""
        ...


class MetricsServiceProtocol(Protocol):
    """Protocol for metrics service."""

    def start_metrics_collection(self, stream_id: str,
    ) -> None:
        """Start collecting metrics for stream."""
        ...

    def update_metrics(self, stream_id: str, metrics: StreamMetrics,
    ) -> None:
        """Update stream metrics."""
        ...

    def get_metrics(self, stream_id: str,
    ) -> StreamMetrics | None:
        """Get current metrics for stream."""
        ...

    def stop_metrics_collection(self, stream_id: str,
    ) -> None:
        """Stop collecting metrics for stream."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: StreamOperation,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: StreamOperation, progress: float,
    ) -> None:
        """Update progress for current operation."""
        ...

    def complete_progress(self) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message."""
        ...


class AudioStreamService:
    """Service for managing audio streaming with non-blocking patterns."""

    def __init__(
        self,
        device_service: AudioDeviceServiceProtocol,
        stream_management_service: StreamManagementServiceProtocol,
        buffer_management_service: BufferManagementServiceProtocol,
        validation_service: AudioValidationServiceProtocol,
        metrics_service: MetricsServiceProtocol | None = None,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._device_service = device_service
        self._stream_management_service = stream_management_service
        self._buffer_management_service = buffer_management_service
        self._validation_service = validation_service
        self._metrics_service = metrics_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

        self._state = AudioStreamServiceState()
        self._input_buffer_queue = Queue()
        self._output_buffer_queue = Queue()
        self._stop_event = threading.Event()
        self._worker_threads: dict[str, threading.Thread] = {}
        self._buffer_counter = 0
        self._stream_counter = 0

    def execute(self, request: AudioStreamServiceRequest,
    ) -> AudioStreamServiceResponse:
        """Execute audio stream service operation."""
        start_time = time.time()
        warnings = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(request.operation)

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting audio stream operation",
                    operation=request.operation.value,
                )

            # Route to appropriate operation handler
            if request.operation == StreamOperation.INITIALIZE:
                return self._handle_initialize(request, start_time, warnings)
            if request.operation == StreamOperation.START_INPUT:
                return self._handle_start_input(request, start_time, warnings)
            if request.operation == StreamOperation.START_OUTPUT:
                return self._handle_start_output(request, start_time, warnings)
            if request.operation == StreamOperation.STOP_INPUT:
                return self._handle_stop_input(request, start_time, warnings)
            if request.operation == StreamOperation.STOP_OUTPUT:
                return self._handle_stop_output(request, start_time, warnings)
            if request.operation == StreamOperation.PAUSE_INPUT:
                return self._handle_pause_input(request, start_time, warnings)
            if request.operation == StreamOperation.PAUSE_OUTPUT:
                return self._handle_pause_output(request, start_time, warnings)
            if request.operation == StreamOperation.RESUME_INPUT:
                return self._handle_resume_input(request, start_time, warnings)
            if request.operation == StreamOperation.RESUME_OUTPUT:
                return self._handle_resume_output(request, start_time, warnings)
            if request.operation == StreamOperation.GET_BUFFER:
                return self._handle_get_buffer(request, start_time, warnings)
            if request.operation == StreamOperation.PUT_BUFFER:
                return self._handle_put_buffer(request, start_time, warnings)
            if request.operation == StreamOperation.FLUSH_BUFFERS:
                return self._handle_flush_buffers(request, start_time, warnings)
            if request.operation == StreamOperation.CLEANUP:
                return self._handle_cleanup(request, start_time, warnings)
            error_message = f"Unsupported operation: {request.operation}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Unexpected error during stream operation: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Audio stream operation failed",
                    error=str(e)
                    operation=request.operation.value,
                    execution_time=time.time() - start_time,
                )

            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_initialize(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle stream service initialization."""
        try:
            # List available devices
            device_list = self._device_service.list_devices()
            if not device_list.devices_found:
                return AudioStreamServiceResponse(
                    result=StreamResult.DEVICE_ERROR,
                    state=self._state,
                    device_list=device_list,
                    error_message="No audio devices found",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.initialized = True
            self._state.available_devices = device_list
            self._state.processing_state = StreamState.ACTIVE

            # Initialize metrics if enabled
            if request.enable_metrics and self._metrics_service:
                self._state.metrics = StreamMetrics()

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Audio stream service initialized",
                    input_devices=len(device_list.input_devices)
                    output_devices=len(device_list.output_devices)
                    execution_time=time.time() - start_time,
                )

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                device_list=device_list,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to initialize stream service: {e!s}"
            self._state.error_message = error_message

            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_start_input(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle input stream start."""
        if not self._state.initialized:
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message="Stream service not initialized",
                execution_time=time.time() - start_time,
            )

        if not request.config:
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message="Configuration required for stream start",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
config_valid, config_error = (
    self._validation_service.validate_configuration(request.config))
            if not config_valid:
                return AudioStreamServiceResponse(
                    result=StreamResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Check if input stream already active
            if self._state.input_stream_active:
                warnings.append("Input stream already active")
                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            # Create and start input stream
stream_success, stream_id, stream_error = (
    self._stream_management_service.create_stream(request.config))
            if not stream_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to create input stream: {stream_error}",
                    execution_time=time.time() - start_time,
                )

            start_success, start_error = self._stream_management_service.start_stream(stream_id)
            if not start_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to start input stream: {start_error}",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.input_stream_active = True
            self._state.input_stream_id = stream_id
            self._state.current_config = request.config
            self._state.processing_state = StreamState.STREAMING

            # Start metrics collection
            if request.enable_metrics and self._metrics_service:
                self._metrics_service.start_metrics_collection(stream_id)

            # Start buffer management thread
            if request.config.buffer_mode == BufferMode.NON_BLOCKING:
                self._start_input_buffer_worker(stream_id)

            stream_start_result = StreamStartResult(
                stream_started=True,
                stream_id=stream_id,
                actual_config=request.config,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                stream_start=stream_start_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start input stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_start_output(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle output stream start."""
        if not self._state.initialized:
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message="Stream service not initialized",
                execution_time=time.time() - start_time,
            )

        if not request.config:
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message="Configuration required for stream start",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
config_valid, config_error = (
    self._validation_service.validate_configuration(request.config))
            if not config_valid:
                return AudioStreamServiceResponse(
                    result=StreamResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Check if output stream already active
            if self._state.output_stream_active:
                warnings.append("Output stream already active")
                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            # Create and start output stream
stream_success, stream_id, stream_error = (
    self._stream_management_service.create_stream(request.config))
            if not stream_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to create output stream: {stream_error}",
                    execution_time=time.time() - start_time,
                )

            start_success, start_error = self._stream_management_service.start_stream(stream_id)
            if not start_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to start output stream: {start_error}",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.output_stream_active = True
            self._state.output_stream_id = stream_id
            if not self._state.current_config:
                self._state.current_config = request.config
            self._state.processing_state = StreamState.STREAMING

            # Start metrics collection
            if request.enable_metrics and self._metrics_service:
                self._metrics_service.start_metrics_collection(stream_id)

            # Start buffer management thread
            if request.config.buffer_mode == BufferMode.NON_BLOCKING:
                self._start_output_buffer_worker(stream_id)

            stream_start_result = StreamStartResult(
                stream_started=True,
                stream_id=stream_id,
                actual_config=request.config,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                stream_start=stream_start_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start output stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_input(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle input stream stop."""
        try:
            if not self._state.input_stream_active:
                warnings.append("No input stream active")
                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            # Stop stream
stop_success, stop_error = (
    self._stream_management_service.stop_stream(self._state.input_stream_id))
            if not stop_success:
                warnings.append(f"Failed to stop input stream: {stop_error}")

            # Stop worker thread
            if self._state.input_stream_id in self._worker_threads:
                self._stop_event.set()
                thread = self._worker_threads[self._state.input_stream_id]
                if thread.is_alive():
                    thread.join(timeout=1.0)
                del self._worker_threads[self._state.input_stream_id]

            # Stop metrics collection
            if self._metrics_service:
                self._metrics_service.stop_metrics_collection(self._state.input_stream_id)

            # Destroy stream
            destroy_success,
destroy_error = (
    self._stream_management_service.destroy_stream(self._state.input_stream_id))
            if not destroy_success:
                warnings.append(f"Failed to destroy input stream: {destroy_error}")

            # Update state
            self._state.input_stream_active = False
            self._state.input_stream_id = None

            if not self._state.output_stream_active:
                self._state.processing_state = StreamState.ACTIVE

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop input stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_output(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle output stream stop."""
        try:
            if not self._state.output_stream_active:
                warnings.append("No output stream active")
                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            # Stop stream
stop_success, stop_error = (
    self._stream_management_service.stop_stream(self._state.output_stream_id))
            if not stop_success:
                warnings.append(f"Failed to stop output stream: {stop_error}")

            # Stop worker thread
            if self._state.output_stream_id in self._worker_threads:
                self._stop_event.set()
                thread = self._worker_threads[self._state.output_stream_id]
                if thread.is_alive():
                    thread.join(timeout=1.0)
                del self._worker_threads[self._state.output_stream_id]

            # Stop metrics collection
            if self._metrics_service:
                self._metrics_service.stop_metrics_collection(self._state.output_stream_id)

            # Destroy stream
            destroy_success,
destroy_error = (
    self._stream_management_service.destroy_stream(self._state.output_stream_id))
            if not destroy_success:
                warnings.append(f"Failed to destroy output stream: {destroy_error}")

            # Update state
            self._state.output_stream_active = False
            self._state.output_stream_id = None

            if not self._state.input_stream_active:
                self._state.processing_state = StreamState.ACTIVE

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop output stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_pause_input(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle input stream pause."""
        try:
            if not self._state.input_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No input stream active",
                    execution_time=time.time() - start_time,
                )

pause_success, pause_error = (
    self._stream_management_service.pause_stream(self._state.input_stream_id))
            if not pause_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message=f"Failed to pause input stream: {pause_error}",
                    execution_time=time.time() - start_time,
                )

            self._state.processing_state = StreamState.PAUSED

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to pause input stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_pause_output(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle output stream pause."""
        try:
            if not self._state.output_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No output stream active",
                    execution_time=time.time() - start_time,
                )

pause_success, pause_error = (
    self._stream_management_service.pause_stream(self._state.output_stream_id))
            if not pause_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message=f"Failed to pause output stream: {pause_error}",
                    execution_time=time.time() - start_time,
                )

            self._state.processing_state = StreamState.PAUSED

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to pause output stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_resume_input(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle input stream resume."""
        try:
            if not self._state.input_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No input stream active",
                    execution_time=time.time() - start_time,
                )

resume_success, resume_error = (
    self._stream_management_service.resume_stream(self._state.input_stream_id))
            if not resume_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message=f"Failed to resume input stream: {resume_error}",
                    execution_time=time.time() - start_time,
                )

            self._state.processing_state = StreamState.STREAMING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to resume input stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_resume_output(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle output stream resume."""
        try:
            if not self._state.output_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No output stream active",
                    execution_time=time.time() - start_time,
                )

resume_success, resume_error = (
    self._stream_management_service.resume_stream(self._state.output_stream_id))
            if not resume_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message=f"Failed to resume output stream: {resume_error}",
                    execution_time=time.time() - start_time,
                )

            self._state.processing_state = StreamState.STREAMING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to resume output stream: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_get_buffer(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle buffer retrieval from input stream."""
        try:
            if not self._state.input_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No input stream active",
                    execution_time=time.time() - start_time,
                )

            # Try to get buffer from queue first (non-blocking mode)
            try:
                buffer = self._input_buffer_queue.get_nowait(,
    )
                buffer_result = BufferOperationResult(
                    operation_successful=True,
                    buffer=buffer,
                    buffers_available=self._input_buffer_queue.qsize()
                )

                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    buffer_operation=buffer_result,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            except Empty:
                # Try direct buffer read
                read_success, buffer, read_error = self._buffer_management_service.read_buffer(
                    self._state.input_stream_id, request.timeout,
                )

                if not read_success:
                    return AudioStreamServiceResponse(
                        result=StreamResult.BUFFER_ERROR,
                        state=self._state,
                        error_message=f"Failed to read buffer: {read_error}",
                        execution_time=time.time() - start_time,
                    )

                buffer_result = BufferOperationResult(
                    operation_successful=True,
                    buffer=buffer,
                )

                return AudioStreamServiceResponse(
                    result=StreamResult.SUCCESS,
                    state=self._state,
                    buffer_operation=buffer_result,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

        except Exception as e:
            error_message = f"Failed to get buffer: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.BUFFER_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_put_buffer(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle buffer writing to output stream."""
        try:
            if not self._state.output_stream_active:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="No output stream active",
                    execution_time=time.time() - start_time,
                )

            if not request.buffer_data:
                return AudioStreamServiceResponse(
                    result=StreamResult.FAILED,
                    state=self._state,
                    error_message="Buffer data required",
                    execution_time=time.time() - start_time,
                )

            # Validate buffer
            buffer_valid, buffer_error = self._validation_service.validate_buffer(
                request.buffer_data, self._state.current_config,
            )
            if not buffer_valid:
                return AudioStreamServiceResponse(
                    result=StreamResult.BUFFER_ERROR,
                    state=self._state,
                    error_message=f"Invalid buffer: {buffer_error}",
                    execution_time=time.time() - start_time,
                )

            # Write buffer
            write_success, write_error = self._buffer_management_service.write_buffer(
                self._state.output_stream_id, request.buffer_data, request.timeout,
            )

            if not write_success:
                return AudioStreamServiceResponse(
                    result=StreamResult.BUFFER_ERROR,
                    state=self._state,
                    error_message=f"Failed to write buffer: {write_error}",
                    execution_time=time.time() - start_time,
                )

            buffer_result = BufferOperationResult(
                operation_successful=True,
            )

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                buffer_operation=buffer_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to put buffer: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.BUFFER_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_flush_buffers(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle buffer flushing."""
        try:
            # Flush input buffers
            if self._state.input_stream_active:
flush_success, flush_error = (
    self._buffer_management_service.flush_buffers(self._state.input_stream_id))
                if not flush_success:
                    warnings.append(f"Failed to flush input buffers: {flush_error}")

            # Flush output buffers
            if self._state.output_stream_active:
                flush_success,
flush_error = (
    self._buffer_management_service.flush_buffers(self._state.output_stream_id))
                if not flush_success:
                    warnings.append(f"Failed to flush output buffers: {flush_error}")

            # Clear internal queues
            while not self._input_buffer_queue.empty():
                try:
                    self._input_buffer_queue.get_nowait()
                except Empty:
                    break

            while not self._output_buffer_queue.empty():
                try:
                    self._output_buffer_queue.get_nowait()
                except Empty:
                    break

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to flush buffers: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.BUFFER_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_cleanup(self,
    request: AudioStreamServiceRequest, start_time: float, warnings: list[str]) -> AudioStreamServiceResponse:
        """Handle stream service cleanup."""
        try:
            # Stop all streams
            if self._state.input_stream_active:
                self._handle_stop_input(request, start_time, warnings)

            if self._state.output_stream_active:
                self._handle_stop_output(request, start_time, warnings)

            # Stop all worker threads
            self._stop_event.set()
            for thread in self._worker_threads.values():
                if thread.is_alive():
                    thread.join(timeout=1.0)
            self._worker_threads.clear()

            # Clear queues
            self._handle_flush_buffers(request, start_time, warnings)

            # Reset state
            self._state = AudioStreamServiceState()

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioStreamServiceResponse(
                result=StreamResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to cleanup stream service: {e!s}"
            return AudioStreamServiceResponse(
                result=StreamResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _start_input_buffer_worker(self, stream_id: str,
    ) -> None:
        """Start input buffer worker thread."""
        worker_thread = threading.Thread(
            target=self._input_buffer_worker,
            args=(stream_id,)
            daemon=True,
        )
        self._worker_threads[stream_id] = worker_thread
        worker_thread.start()

    def _start_output_buffer_worker(self, stream_id: str,
    ) -> None:
        """Start output buffer worker thread."""
        worker_thread = threading.Thread(
            target=self._output_buffer_worker,
            args=(stream_id,)
            daemon=True,
        )
        self._worker_threads[stream_id] = worker_thread
        worker_thread.start()

    def _input_buffer_worker(self, stream_id: str,
    ) -> None:
        """Worker thread for input buffer management."""
        while not self._stop_event.is_set():
            try:
                # Read buffer from stream
read_success, buffer, read_error = (
    self._buffer_management_service.read_buffer(stream_id, 0.1))

                if read_success and buffer:
                    # Add to queue if not full
                    if self._input_buffer_queue.qsize() < 100:  # Max 100 buffers
                        self._input_buffer_queue.put(buffer)
                    else:
                        # Drop oldest buffer
                        try:
                            self._input_buffer_queue.get_nowait()
                            self._input_buffer_queue.put(buffer)
                        except Empty:
                            pass

                time.sleep(0.001)  # Small delay to prevent busy waiting

            except Exception as e:
                if self._logger_service:
                    self._logger_service.log_error(
                        "Error in input buffer worker",
                        stream_id=stream_id,
                        error=str(e)
                    )
                break

    def _output_buffer_worker(self, stream_id: str,
    ) -> None:
        """Worker thread for output buffer management."""
        while not self._stop_event.is_set():
            try:
                # Get buffer from queue
                try:
                    buffer = self._output_buffer_queue.get(timeout=0.1,
    )

                    # Write buffer to stream
write_success, write_error = (
    self._buffer_management_service.write_buffer(stream_id, buffer, 0.1))

                    if not write_success and self._logger_service:
                        self._logger_service.log_warning(
                            "Failed to write buffer in worker",
                            stream_id=stream_id,
                            error=write_error,
                        )

                except Empty:
                    continue

            except Exception as e:
                if self._logger_service:
                    self._logger_service.log_error(
                        "Error in output buffer worker",
                        stream_id=stream_id,
                        error=str(e)
                    )
                break

    def get_input_buffer_queue(self) -> Queue:
        """Get input buffer queue for non-blocking access."""
        return self._input_buffer_queue

    def get_output_buffer_queue(self) -> Queue:
        """Get output buffer queue for non-blocking access."""
        return self._output_buffer_queue

    def get_state(self) -> AudioStreamServiceState:
        """Get current service state."""
        return self._state

    def get_metrics(self) -> StreamMetrics | None:
        """Get current stream metrics."""
        return self._state.metrics