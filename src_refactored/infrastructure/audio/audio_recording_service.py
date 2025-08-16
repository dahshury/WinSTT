"""Audio Recording Service.

This module implements the AudioRecordingService for managing audio recording
with non-blocking patterns and comprehensive recording management.
"""

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Protocol

import numpy as np

# Import domain value objects
from src_refactored.domain.audio.value_objects import (
    AudioRecordingServiceRequest,
    Duration,
    RecordingConfiguration,
    RecordingData,
    RecordingMetadata,
    RecordingOperation,
    RecordingResult,
    RecordingState,
    RecordingStatus,
)

# RecordingConfiguration, RecordingMetadata, and RecordingData now imported from domain layer
# RecordingStatus and AudioRecordingServiceRequest now imported from domain layer


@dataclass
class RecordingInitResult:
    """Result of recording initialization."""
    initialized: bool
    recording_id: str | None = None
    actual_config: RecordingConfiguration | None = None
    device_info: dict[str, Any] | None = None
    error_message: str | None = None


@dataclass
class RecordingOperationResult:
    """Result of recording operations."""
    operation_successful: bool
    recording_id: str | None = None
    file_path: Path | None = None
    duration: float | None = None
    file_size: int | None = None
    error_message: str | None = None


@dataclass
class RecordingDataResult:
    """Result of recording data retrieval."""
    data_available: bool
    recording_data: RecordingData | None = None
    chunks_available: int = 0
    total_duration: float = 0.0
    error_message: str | None = None


@dataclass
class AudioRecordingServiceState:
    """Current state of audio recording service."""
    initialized: bool = False
    current_config: RecordingConfiguration | None = None
    active_recordings: dict[str, RecordingMetadata] = field(default_factory=dict)
    processing_state: RecordingState = RecordingState.IDLE
    current_recording_id: str | None = None
    status: RecordingStatus | None = None
    available_devices: list[dict[str, Any]] | None = None
    error_message: str | None = None

    def __post_init__(self):
        if self.active_recordings is None:
            self.active_recordings = {}
        if self.available_devices is None:
            self.available_devices = []


@dataclass
class AudioRecordingServiceResponse:
    """Response from audio recording service operations."""
    result: RecordingResult
    state: AudioRecordingServiceState
    init_result: RecordingInitResult | None = None
    operation_result: RecordingOperationResult | None = None
    data_result: RecordingDataResult | None = None
    status: RecordingStatus | None = None
    recordings: list[RecordingData] | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.recordings is None:
            self.recordings = []


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device service."""

    def list_input_devices(self,
    ) -> tuple[bool, list[dict[str, Any]], str | None]:
        """List available input devices."""
        ...

    def get_device_info(self, device_id: int,
    ) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get device information."""
        ...

    def test_device(self, device_id: int,
    ) -> tuple[bool, str | None]:
        """Test device functionality."""
        ...


class AudioStreamServiceProtocol(Protocol):
    """Protocol for audio stream service."""

    def create_input_stream(self, config: RecordingConfiguration,
    ) -> tuple[bool, str | None, str | None]:
        """Create input stream for recording."""
        ...

    def start_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Start audio stream."""
        ...

    def stop_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Stop audio stream."""
        ...

    def read_stream(self, stream_id: str, frames: int,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        """Read data from stream."""
        ...

    def destroy_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Destroy audio stream."""
        ...


class AudioFileServiceProtocol(Protocol):
    """Protocol for audio file service."""

    def create_file(self, file_path: Path, config: RecordingConfiguration,
    ) -> tuple[bool, str | None]:
        """Create audio file for recording."""
        ...

    def write_data(self, file_path: Path, data: np.ndarray) -> tuple[bool, str | None]:
        """Write audio data to file."""
        ...

    def finalize_file(self, file_path: Path, metadata: RecordingMetadata,
    ) -> tuple[bool, str | None]:
        """Finalize audio file."""
        ...

    def get_file_info(self, file_path: Path,
    ) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get audio file information."""
        ...


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def apply_noise_reduction(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply noise reduction to audio data."""
        ...

    def apply_auto_gain(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply automatic gain control."""
        ...

    def detect_silence(self, data: np.ndarray, threshold: float,
    ) -> tuple[bool, bool, str | None]:
        """Detect silence in audio data."""
        ...

    def calculate_levels(self, data: np.ndarray) -> tuple[bool, float, float, str | None]:
        """Calculate RMS and peak levels."""
        ...


class RecordingValidationServiceProtocol(Protocol):
    """Protocol for recording validation service."""

    def validate_configuration(self, config: RecordingConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate recording configuration."""
        ...

    def validate_file_path(self, file_path: Path,
    ) -> tuple[bool, str | None]:
        """Validate file path for recording."""
        ...

    def validate_device_compatibility(self, device_id: int, config: RecordingConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: RecordingOperation,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: RecordingOperation, progress: float,
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


class AudioRecordingService:
    """Service for managing audio recording with non-blocking patterns."""

    def __init__(
        self,
        device_service: AudioDeviceServiceProtocol,
        stream_service: AudioStreamServiceProtocol,
        file_service: AudioFileServiceProtocol,
        processing_service: AudioProcessingServiceProtocol,
        validation_service: RecordingValidationServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._device_service = device_service
        self._stream_service = stream_service
        self._file_service = file_service
        self._processing_service = processing_service
        self._validation_service = validation_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

        self._state = AudioRecordingServiceState()
        self._recording_threads: dict[str, threading.Thread] = {}
        self._stop_events: dict[str, threading.Event] = {}
        self._data_queues: dict[str, Queue] = {}
        self._recording_counter = 0
        self._chunk_counter = 0

    def execute(self, request: AudioRecordingServiceRequest,
    ) -> AudioRecordingServiceResponse:
        """Execute audio recording service operation."""
        start_time = time.time()
        warnings: list[str] = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service and request.operation is not None:
                self._progress_tracking_service.start_progress(request.operation)

            if request.enable_logging and self._logger_service and request.operation is not None:
                self._logger_service.log_info(
                    "Starting recording operation",
                    operation=request.operation.value,
                )

            # Route to appropriate operation handler
            if request.operation == RecordingOperation.INITIALIZE:
                return self._handle_initialize(request, start_time, warnings)
            if request.operation == RecordingOperation.START_RECORDING:
                return self._handle_start_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.STOP_RECORDING:
                return self._handle_stop_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.PAUSE_RECORDING:
                return self._handle_pause_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.RESUME_RECORDING:
                return self._handle_resume_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.SAVE_RECORDING:
                return self._handle_save_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.DISCARD_RECORDING:
                return self._handle_discard_recording(request, start_time, warnings)
            if request.operation == RecordingOperation.GET_RECORDING_DATA:
                return self._handle_get_recording_data(request, start_time, warnings)
            if request.operation == RecordingOperation.SET_RECORDING_CONFIG:
                return self._handle_set_recording_config(request, start_time, warnings)
            if request.operation == RecordingOperation.GET_RECORDING_STATUS:
                return self._handle_get_recording_status(request, start_time, warnings)
            if request.operation == RecordingOperation.CLEANUP:
                return self._handle_cleanup(request, start_time, warnings)
            error_message = f"Unsupported operation: {request.operation}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Unexpected error during recording operation: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service and request.operation is not None:
                self._logger_service.log_error(
                    "Recording operation failed",
                    error=str(e),
                    operation=request.operation.value,
                    execution_time=time.time() - start_time,
                )

            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_initialize(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording service initialization."""
        try:
            # List available input devices
            devices_success, devices, devices_error = self._device_service.list_input_devices()
            if not devices_success:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to list devices: {devices_error}",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.initialized = True
            self._state.available_devices = devices
            self._state.processing_state = RecordingState.READY
            self._state.status = RecordingStatus(
                is_recording=False,
                current_duration=Duration(seconds=0.0),
            )

            init_result = RecordingInitResult(
                initialized=True,
                device_info={"available_devices": len(devices)},
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Recording service initialized",
                    available_devices=len(devices),
                    execution_time=time.time() - start_time,
                )

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                init_result=init_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to initialize recording service: {e!s}"
            self._state.error_message = error_message

            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_start_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording start."""
        if not self._state.initialized:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="Recording service not initialized",
                execution_time=time.time() - start_time,
            )

        if not request.config:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="Configuration required for recording start",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
            config_valid, config_error = self._validation_service.validate_configuration(request.config)
            if not config_valid:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Generate recording ID
            self._recording_counter += 1
            recording_id = f"recording_{self._recording_counter}_{int(time.time())}"

            # Create metadata
            metadata = RecordingMetadata(
                recording_id=recording_id,
                start_time=datetime.now(),
                sample_rate=request.config.audio_config.sample_rate.value,
                channels=request.config.audio_config.channels.value,
                bit_depth=request.config.format.bit_depth,
                audio_format=request.config.format.format_type,
            )

            # Create audio stream
            stream_success, stream_id, stream_error = self._stream_service.create_input_stream(request.config)
            if not stream_success:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to create stream: {stream_error}",
                    execution_time=time.time() - start_time,
                )

            # Start stream
            assert stream_id is not None
            start_success, start_error = self._stream_service.start_stream(stream_id)
            if not start_success:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to start stream: {start_error}",
                    execution_time=time.time() - start_time,
                )

            # Create file if auto-save enabled
            file_path: Path | None = None
            candidate_path = request.file_path or request.config.file_path
            if candidate_path:
                file_path = Path(candidate_path)
                file_success, file_error = self._file_service.create_file(file_path, request.config)
                if not file_success:
                    warnings.append(f"Failed to create file: {file_error}")
                    file_path = None
                else:
                    metadata = RecordingMetadata(
                        recording_id=metadata.recording_id,
                        start_time=metadata.start_time,
                        end_time=metadata.end_time,
                        duration=metadata.duration,
                        sample_rate=metadata.sample_rate,
                        channels=metadata.channels,
                        bit_depth=metadata.bit_depth,
                        audio_format=metadata.audio_format,
                        file_size_bytes=metadata.file_size_bytes,
                        file_path=str(file_path),
                        device_name=metadata.device_name,
                        quality_metrics=metadata.quality_metrics,
                        tags=metadata.tags,
                        notes=metadata.notes,
                    )
                    self._state.active_recordings[recording_id] = metadata

            # Update state
            self._state.current_config = request.config
            self._state.current_recording_id = recording_id
            self._state.active_recordings[recording_id] = metadata
            self._state.processing_state = RecordingState.RECORDING
            self._state.status = RecordingStatus(
                is_recording=True,
                current_duration=Duration(seconds=0.0),
            )

            # Create data queue and stop event
            self._data_queues[recording_id] = Queue()
            self._stop_events[recording_id] = threading.Event()

            # Start recording thread
            recording_thread = threading.Thread(
                target=self._recording_worker,
                args=(recording_id, stream_id, request.config, file_path, request.enable_real_time_callback),
                daemon=True,
            )
            self._recording_threads[recording_id] = recording_thread
            recording_thread.start()

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
                file_path=file_path,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording stop."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._state.active_recordings:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No active recording found",
                execution_time=time.time() - start_time,
            )

        try:
            # Signal stop to recording thread
            if recording_id in self._stop_events:
                self._stop_events[recording_id].set()

            # Wait for thread to finish
            if recording_id in self._recording_threads:
                thread = self._recording_threads[recording_id]
                if thread.is_alive():
                    thread.join(timeout=5.0)
                del self._recording_threads[recording_id]

            # Update metadata
            metadata = self._state.active_recordings[recording_id]
            end_dt = datetime.now()
            duration = Duration(seconds=(end_dt - metadata.start_time).total_seconds())
            metadata = RecordingMetadata(
                recording_id=metadata.recording_id,
                start_time=metadata.start_time,
                end_time=end_dt,
                duration=duration,
                sample_rate=metadata.sample_rate,
                channels=metadata.channels,
                bit_depth=metadata.bit_depth,
                audio_format=metadata.audio_format,
                file_size_bytes=metadata.file_size_bytes,
                file_path=metadata.file_path,
                device_name=metadata.device_name,
                quality_metrics=metadata.quality_metrics,
                tags=metadata.tags,
                notes=metadata.notes,
            )
            self._state.active_recordings[recording_id] = metadata

            # Finalize file if exists
            file_path = Path(metadata.file_path) if metadata.file_path else None
            if file_path:
                finalize_success, finalize_error = self._file_service.finalize_file(file_path, metadata)
                if not finalize_success:
                    warnings.append(f"Failed to finalize file: {finalize_error}")

                # Get file info
                info_success, file_info, info_error = self._file_service.get_file_info(file_path)
                if info_success and file_info:
                    file_size = file_info.get("size", 0)
                    metadata = RecordingMetadata(
                        recording_id=metadata.recording_id,
                        start_time=metadata.start_time,
                        end_time=metadata.end_time,
                        duration=metadata.duration,
                        sample_rate=metadata.sample_rate,
                        channels=metadata.channels,
                        bit_depth=metadata.bit_depth,
                        audio_format=metadata.audio_format,
                        file_size_bytes=file_size,
                        file_path=metadata.file_path,
                        device_name=metadata.device_name,
                        quality_metrics=metadata.quality_metrics,
                        tags=metadata.tags,
                        notes=metadata.notes,
                    )
                    self._state.active_recordings[recording_id] = metadata

            # Update state
            self._state.processing_state = RecordingState.READY
            self._state.status = RecordingStatus(
                is_recording=False,
                current_duration=Duration(seconds=0.0),
            )
            self._state.current_recording_id = None

            # Clean up resources
            if recording_id in self._stop_events:
                del self._stop_events[recording_id]

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
                file_path=file_path,
                duration=(metadata.duration.seconds if metadata.duration else None),
                file_size=metadata.file_size_bytes,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_pause_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording pause."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._state.active_recordings:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No active recording found",
                execution_time=time.time() - start_time,
            )

        try:
            self._state.processing_state = RecordingState.PAUSED
            if self._state.status:
                self._state.status = RecordingStatus(
                    is_recording=False,
                    current_duration=self._state.status.current_duration,
                )

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to pause recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_resume_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording resume."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._state.active_recordings:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No active recording found",
                execution_time=time.time() - start_time,
            )

        try:
            self._state.processing_state = RecordingState.RECORDING
            if self._state.status:
                self._state.status = RecordingStatus(
                    is_recording=True,
                    current_duration=self._state.status.current_duration,
                )

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to resume recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_save_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording save."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._state.active_recordings:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No recording found",
                execution_time=time.time() - start_time,
            )

        if not request.file_path:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="File path required for save operation",
                execution_time=time.time() - start_time,
            )

        try:
            metadata = self._state.active_recordings[recording_id]

            # Validate file path
            target_path = Path(request.file_path)
            path_valid, path_error = self._validation_service.validate_file_path(target_path)
            if not path_valid:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.STORAGE_ERROR,
                    state=self._state,
                    error_message=f"Invalid file path: {path_error}",
                    execution_time=time.time() - start_time,
                )

            # Create file
            file_success, file_error = self._file_service.create_file(target_path, self._state.current_config)  # type: ignore[arg-type]
            if not file_success:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.STORAGE_ERROR,
                    state=self._state,
                    error_message=f"Failed to create file: {file_error}",
                    execution_time=time.time() - start_time,
                )

            # Write recorded data
            if recording_id in self._data_queues:
                queue = self._data_queues[recording_id]
                while not queue.empty():
                    try:
                        recording_data = queue.get_nowait()
                        np_data = np.asarray(recording_data.data, dtype=np.float32)
                        write_success, write_error = self._file_service.write_data(target_path, np_data)
                        if not write_success:
                            warnings.append(f"Failed to write data chunk: {write_error}")
                    except Empty:
                        break

            # Finalize file
            # Create new metadata with file_path since it's frozen
            metadata = RecordingMetadata(
                recording_id=metadata.recording_id,
                start_time=metadata.start_time,
                end_time=metadata.end_time,
                duration=metadata.duration,
                sample_rate=metadata.sample_rate,
                channels=metadata.channels,
                bit_depth=metadata.bit_depth,
                audio_format=metadata.audio_format,
                file_size_bytes=metadata.file_size_bytes,
                file_path=str(target_path),
                device_name=metadata.device_name,
                quality_metrics=metadata.quality_metrics,
                tags=metadata.tags,
                notes=metadata.notes,
            )
            self._state.active_recordings[recording_id] = metadata
            
            finalize_success, finalize_error = self._file_service.finalize_file(target_path, metadata)
            if not finalize_success:
                warnings.append(f"Failed to finalize file: {finalize_error}")

            # Get file info
            info_success, file_info, info_error = self._file_service.get_file_info(target_path)
            file_size = None
            if info_success and file_info:
                file_size = file_info.get("size", 0)
                # Create new metadata with file_size since it's frozen
                metadata = RecordingMetadata(
                    recording_id=metadata.recording_id,
                    start_time=metadata.start_time,
                    end_time=metadata.end_time,
                    duration=metadata.duration,
                    sample_rate=metadata.sample_rate,
                    channels=metadata.channels,
                    bit_depth=metadata.bit_depth,
                    audio_format=metadata.audio_format,
                    file_size_bytes=file_size,
                    file_path=metadata.file_path,
                    device_name=metadata.device_name,
                    quality_metrics=metadata.quality_metrics,
                    tags=metadata.tags,
                    notes=metadata.notes,
                )
                self._state.active_recordings[recording_id] = metadata

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
                file_path=target_path,
                duration=metadata.duration.seconds if metadata.duration else None,
                file_size=file_size,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to save recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.STORAGE_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_discard_recording(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording discard."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._state.active_recordings:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No recording found",
                execution_time=time.time() - start_time,
            )

        try:
            # Clean up resources
            if recording_id in self._data_queues:
                del self._data_queues[recording_id]

            if recording_id in self._stop_events:
                del self._stop_events[recording_id]

            if recording_id in self._recording_threads:
                del self._recording_threads[recording_id]

            # Remove from active recordings
            del self._state.active_recordings[recording_id]

            if self._state.current_recording_id == recording_id:
                self._state.current_recording_id = None
                self._state.processing_state = RecordingState.READY
                self._state.status = RecordingStatus(
                    is_recording=False,
                    current_duration=Duration(seconds=0.0),
                )

            operation_result = RecordingOperationResult(
                operation_successful=True,
                recording_id=recording_id,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to discard recording: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_get_recording_data(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording data retrieval."""
        recording_id = request.recording_id or self._state.current_recording_id

        if not recording_id or recording_id not in self._data_queues:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="No recording data available",
                execution_time=time.time() - start_time,
            )

        try:
            queue = self._data_queues[recording_id]
            recordings = []
            total_duration = 0.0

            # Get all available data
            while not queue.empty():
                try:
                    recording_data = queue.get_nowait()
                    recordings.append(recording_data)
                    total_duration += len(recording_data.data) / recording_data.metadata.sample_rate
                except Empty:
                    break

            data_result = RecordingDataResult(
                    data_available=len(recordings) > 0,
                chunks_available=queue.qsize(), 
                total_duration=total_duration,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                data_result=data_result,
                recordings=recordings,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to get recording data: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_set_recording_config(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording configuration update."""
        if not request.config:
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message="Configuration required",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
            config_valid, config_error = self._validation_service.validate_configuration(request.config)
            if not config_valid:
                return AudioRecordingServiceResponse(
                    result=RecordingResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Update configuration
            self._state.current_config = request.config

            operation_result = RecordingOperationResult(
                operation_successful=True,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to set configuration: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_get_recording_status(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording status retrieval."""
        try:
            # Update status with current information
            if self._state.status and self._state.current_recording_id:
                recording_id = self._state.current_recording_id
                metadata = self._state.active_recordings.get(recording_id)

                if metadata:
                    current_time = datetime.now()
                    current_duration = Duration(seconds=(current_time - metadata.start_time).total_seconds())
                    self._state.status = RecordingStatus(
                        is_recording=self._state.processing_state == RecordingState.RECORDING,
                        current_duration=current_duration,
                    )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                status=self._state.status,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to get recording status: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_cleanup(self,
    request: AudioRecordingServiceRequest, start_time: float, warnings: list[str]) -> AudioRecordingServiceResponse:
        """Handle recording service cleanup."""
        try:
            # Stop all active recordings
            for recording_id in list(self._state.active_recordings.keys()):
                if recording_id in self._stop_events:
                    self._stop_events[recording_id].set()

                if recording_id in self._recording_threads:
                    thread = self._recording_threads[recording_id]
                    if thread.is_alive():
                        thread.join(timeout=1.0)

            # Clear all resources
            self._recording_threads.clear()
            self._stop_events.clear()
            self._data_queues.clear()

            # Reset state
            self._state = AudioRecordingServiceState()

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioRecordingServiceResponse(
                result=RecordingResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to cleanup recording service: {e!s}"
            return AudioRecordingServiceResponse(
                result=RecordingResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _recording_worker(self,
    recording_id: str, stream_id: str, config: RecordingConfiguration, file_path: Path | None, enable_callback: bool,
    ) -> None:
        """Worker thread for recording audio data."""
        try:
            queue = self._data_queues[recording_id]
            stop_event = self._stop_events[recording_id]
            metadata = self._state.active_recordings[recording_id]

            frames_per_read = config.audio_config.buffer_size
            silence_frames = 0
            silence_threshold_frames = int(config.silence_duration * config.audio_config.sample_rate.value)

            while not stop_event.is_set():
                # Check if paused
                if self._state.processing_state == RecordingState.PAUSED:
                    time.sleep(0.1,
    )
                    continue

                # Read audio data
                read_success, audio_data, read_error = self._stream_service.read_stream(stream_id, frames_per_read)

                if not read_success:
                    if self._logger_service:
                        self._logger_service.log_warning(
                            "Failed to read audio data",
                            recording_id=recording_id,
                            error=read_error,
                        )
                    continue

                if audio_data is None or len(audio_data) == 0:
                    continue

                # Apply processing if enabled
                processed_data = audio_data

                # Optional processing toggles are not configured via RecordingConfiguration; always attempt when service returns success
                # Noise reduction
                nr_success, nr_data, nr_error = self._processing_service.apply_noise_reduction(audio_data)
                if nr_success and nr_data is not None:
                    processed_data = nr_data

                # Auto gain
                ag_success, ag_data, ag_error = self._processing_service.apply_auto_gain(processed_data)
                if ag_success and ag_data is not None:
                    processed_data = ag_data

                # Calculate levels
                levels_success, rms_level, peak_level, levels_error = self._processing_service.calculate_levels(processed_data)
                if not levels_success:
                    rms_level = peak_level = 0.0

                # Detect silence for voice activation mode
                silence_detected = False
                silence_success, is_silence, silence_error = self._processing_service.detect_silence(processed_data, config.silence_threshold)
                if silence_success:
                    silence_detected = is_silence
                    if is_silence:
                        silence_frames += len(processed_data)
                        if silence_frames >= silence_threshold_frames:
                            stop_event.set()
                            break
                    else:
                        silence_frames = 0

                # Update status
                if self._state.status:
                    frames_recorded = (self._state.status.frames_recorded + len(processed_data)) if self._state.status else len(processed_data)
                    peak = max(self._state.status.peak_level, peak_level)
                    avg = rms_level
                    self._state.status = RecordingStatus(
                        is_recording=True,
                        current_duration=self._state.status.current_duration,
                        frames_recorded=frames_recorded,
                        peak_level=peak,
                        average_level=avg,
                    )

                # Create recording data
                self._chunk_counter += 1
                recording_data = RecordingData(
                    data=processed_data.tolist(),
                    metadata=metadata,
                    timestamp=datetime.now(),
                    chunk_id=self._chunk_counter,
                    rms_level=rms_level,
                    peak_level=peak_level,
                    silence_detected=silence_detected,
                )

                # Add to queue
                if queue.qsize() < 1000:  # Prevent memory overflow
                    queue.put(recording_data)
                else:
                    # Drop oldest data
                    try:
                        queue.get_nowait()
                        queue.put(recording_data)
                    except Empty:
                        pass

                    # dropped_samples not tracked in domain RecordingStatus

                # Write to file if auto-save enabled
                if file_path:
                    write_success, write_error = self._file_service.write_data(file_path, processed_data)
                    if not write_success and self._logger_service:
                        self._logger_service.log_warning(
                            "Failed to write to file",
                            recording_id=recording_id,
                            file_path=str(file_path),
                            error=write_error,
                        )

                # Call real-time callback if enabled
                # Note: callback functionality removed as RecordingConfiguration has no callback attribute
                # if enable_callback and config.callback:
                #     try:
                #         config.callback(processed_data, time.time())
                #     except Exception as e:
                #         if self._logger_service:
                #             self._logger_service.log_warning(
                #                 "Error in recording callback",
                #                 recording_id=recording_id,
                #                 error=str(e)
                #             )

                # Check max duration
                if config.max_duration:
                    current_duration = (datetime.now() - metadata.start_time).total_seconds()
                    if current_duration >= config.max_duration:
                        stop_event.set()
                        break

                time.sleep(0.001)  # Small delay to prevent busy waiting

            # Stop stream
            self._stream_service.stop_stream(stream_id)
            self._stream_service.destroy_stream(stream_id)

        except Exception as e:
            if self._logger_service:
                self._logger_service.log_error(
                    "Error in recording worker",
                    recording_id=recording_id,
                    error=str(e),
                )

            # error_count/last_error not tracked on domain RecordingStatus; rely on logger only

    def get_active_recordings(self) -> dict[str, RecordingMetadata]:
        """Get all active recordings."""
        return self._state.active_recordings.copy()

    def get_recording_queue(self, recording_id: str,
    ) -> Queue | None:
        """Get recording data queue for specific recording."""
        return self._data_queues.get(recording_id)

    def get_state(self) -> AudioRecordingServiceState:
        """Get current service state."""
        return self._state

    def get_status(self) -> RecordingStatus | None:
        """Get current recording status."""
        return self._state.status