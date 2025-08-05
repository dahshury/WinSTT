"""Audio Playback Service.

This module implements the AudioPlaybackService for managing audio playback
with non-blocking patterns and comprehensive playback management.
"""

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Protocol

import numpy as np

# Import domain value objects
from src_refactored.domain.audio.value_objects import (
    AudioFormatType,
    AudioPlaybackServiceRequest,
    AudioTrack,
    PlaybackConfiguration,
    PlaybackMetrics,
    PlaybackMode,
    PlaybackOperation,
    PlaybackResult,
    PlaybackState,
    PlaybackStatus,
)

# Domain concepts now imported from domain layer


# PlaybackStatus, PlaybackMetrics, and AudioPlaybackServiceRequest now imported from domain layer


@dataclass
class PlaybackInitResult:
    """Result of playback initialization."""
    initialized: bool
    actual_config: PlaybackConfiguration | None = None
    device_info: dict[str, Any] | None = None
    supported_formats: list[AudioFormatType] | None = None
    error_message: str | None = None


@dataclass
class AudioLoadResult:
    """Result of audio loading."""
    loaded: bool
    track: AudioTrack | None = None
    duration: float | None = None
    format_info: dict[str, Any] | None = None
    error_message: str | None = None


@dataclass
class PlaybackOperationResult:
    """Result of playback operations."""
    operation_successful: bool
    track_id: str | None = None
    position: float | None = None
    volume: float | None = None
    speed: float | None = None
    queue_size: int | None = None
    error_message: str | None = None


@dataclass
class AudioPlaybackServiceState:
    """Current state of audio playback service."""
    initialized: bool = False
    current_config: PlaybackConfiguration | None = None
    current_track: AudioTrack | None = None
    playback_queue: list[AudioTrack] = None
    processing_state: PlaybackState = PlaybackState.IDLE
    status: PlaybackStatus | None = None
    metrics: PlaybackMetrics | None = None
    available_devices: list[dict[str, Any]] | None = None
    error_message: str | None = None

    def __post_init__(self):
        if self.playback_queue is None:
            self.playback_queue = []
        if self.available_devices is None:
            self.available_devices = []


@dataclass
class AudioPlaybackServiceResponse:
    """Response from audio playback service operations."""
    result: PlaybackResult
    state: AudioPlaybackServiceState
    init_result: PlaybackInitResult | None = None
    load_result: AudioLoadResult | None = None
    operation_result: PlaybackOperationResult | None = None
    status: PlaybackStatus | None = None
    metrics: PlaybackMetrics | None = None
    tracks: list[AudioTrack] | None = None
    error_message: str | None = None
    warnings: list[str] = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.tracks is None:
            self.tracks = []


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device service."""

    def list_output_devices(self,
    ) -> tuple[bool, list[dict[str, Any]], str | None]:
        """List available output devices."""
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

    def create_output_stream(self, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None, str | None]:
        """Create output stream for playback."""
        ...

    def start_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Start audio stream."""
        ...

    def stop_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Stop audio stream."""
        ...

    def write_stream(self, stream_id: str, data: np.ndarray) -> tuple[bool, str | None]:
        """Write data to stream."""
        ...

    def destroy_stream(self, stream_id: str,
    ) -> tuple[bool, str | None]:
        """Destroy audio stream."""
        ...


class AudioFileServiceProtocol(Protocol):
    """Protocol for audio file service."""

    def load_file(self, file_path: Path,
    ) -> tuple[bool, np.ndarray | None, dict[str, Any] | None, str | None]:
        """Load audio file."""
        ...

    def get_file_info(self, file_path: Path,
    ) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get audio file information."""
        ...

    def validate_file(self, file_path: Path,
    ) -> tuple[bool, str | None]:
        """Validate audio file."""
        ...


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def apply_volume(self,
    data: np.ndarray, volume: float, mode: str = "linear",
    ) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply volume adjustment."""
        ...

    def apply_speed_change(self, data: np.ndarray, speed: float,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply speed/pitch change."""
        ...

    def apply_equalizer(
    self,
    data: np.ndarray,
    bands: list[float]) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply equalizer settings."""
        ...

    def apply_crossfade(self,
    data1: np.ndarray, data2: np.ndarray, duration: float, sample_rate: int,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply crossfade between two audio segments."""
        ...

    def resample_audio(self,
    data: np.ndarray, source_rate: int, target_rate: int,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        """Resample audio data."""
        ...


class PlaybackValidationServiceProtocol(Protocol):
    """Protocol for playback validation service."""

    def validate_configuration(self, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate playback configuration."""
        ...

    def validate_audio_data(self, data: np.ndarray, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate audio data compatibility."""
        ...

    def validate_device_compatibility(self, device_id: int, config: PlaybackConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: PlaybackOperation,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: PlaybackOperation, progress: float,
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


class AudioPlaybackService:
    """Service for managing audio playback with non-blocking patterns."""

    def __init__(
        self,
        device_service: AudioDeviceServiceProtocol,
        stream_service: AudioStreamServiceProtocol,
        file_service: AudioFileServiceProtocol,
        processing_service: AudioProcessingServiceProtocol,
        validation_service: PlaybackValidationServiceProtocol,
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

        self._state = AudioPlaybackServiceState()
        self._playback_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._pause_event = threading.Event()
        self._seek_event = threading.Event()
        self._audio_buffer: Queue = Queue(,
    )
        self._stream_id: str | None = None
        self._track_counter = 0
        self._current_position = 0.0
        self._seek_position: float | None = None

    def execute(self, request: AudioPlaybackServiceRequest,
    ) -> AudioPlaybackServiceResponse:
        """Execute audio playback service operation."""
        start_time = time.time()
        warnings = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(request.operation)

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting playback operation",
                    operation=request.operation.value,
                )

            # Route to appropriate operation handler
            if request.operation == PlaybackOperation.INITIALIZE:
                return self._handle_initialize(request, start_time, warnings)
            if request.operation == PlaybackOperation.LOAD_AUDIO:
                return self._handle_load_audio(request, start_time, warnings)
            if request.operation == PlaybackOperation.START_PLAYBACK:
                return self._handle_start_playback(request, start_time, warnings)
            if request.operation == PlaybackOperation.STOP_PLAYBACK:
                return self._handle_stop_playback(request, start_time, warnings)
            if request.operation == PlaybackOperation.PAUSE_PLAYBACK:
                return self._handle_pause_playback(request, start_time, warnings)
            if request.operation == PlaybackOperation.RESUME_PLAYBACK:
                return self._handle_resume_playback(request, start_time, warnings)
            if request.operation == PlaybackOperation.SEEK_POSITION:
                return self._handle_seek_position(request, start_time, warnings)
            if request.operation == PlaybackOperation.SET_VOLUME:
                return self._handle_set_volume(request, start_time, warnings)
            if request.operation == PlaybackOperation.SET_SPEED:
                return self._handle_set_speed(request, start_time, warnings)
            if request.operation == PlaybackOperation.GET_PLAYBACK_STATUS:
                return self._handle_get_playback_status(request, start_time, warnings)
            if request.operation == PlaybackOperation.QUEUE_AUDIO:
                return self._handle_queue_audio(request, start_time, warnings)
            if request.operation == PlaybackOperation.CLEAR_QUEUE:
                return self._handle_clear_queue(request, start_time, warnings)
            if request.operation == PlaybackOperation.CLEANUP:
                return self._handle_cleanup(request, start_time, warnings)
            error_message = f"Unsupported operation: {request.operation}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Unexpected error during playback operation: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Playback operation failed",
                    error=str(e)
                    operation=request.operation.value,
                    execution_time=time.time() - start_time,
                )

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_initialize(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback service initialization."""
        try:
            # List available output devices
            devices_success, devices, devices_error = self._device_service.list_output_devices()
            if not devices_success:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to list devices: {devices_error}",
                    execution_time=time.time() - start_time,
                )

            # Initialize default configuration if not provided
            config = request.config if request.config else PlaybackConfiguration()

            # Validate configuration
            config_valid, config_error = self._validation_service.validate_configuration(config)
            if not config_valid:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.initialized = True
            self._state.current_config = config
            self._state.available_devices = devices
            self._state.processing_state = PlaybackState.READY
            self._state.status = PlaybackStatus(volume=config.volume, speed=config.speed)
            self._state.metrics = PlaybackMetrics(last_update=time.time())

            init_result = PlaybackInitResult(
                initialized=True,
                actual_config=config,
                device_info={"available_devices": len(devices)},
                supported_formats=[AudioFormatType.WAV, AudioFormatType.MP3, AudioFormatType.FLAC],
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Playback service initialized",
                    available_devices=len(devices)
                    execution_time=time.time() - start_time,
                )

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                init_result=init_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to initialize playback service: {e!s}"
            self._state.error_message = error_message

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_load_audio(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle audio loading."""
        if not self._state.initialized:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Playback service not initialized",
                execution_time=time.time() - start_time,
            )

        try:
            track = None

            if request.track:
                track = request.track
            elif request.file_path:
                # Load from file
                file_valid, file_error = self._file_service.validate_file(request.file_path)
                if not file_valid:
                    return AudioPlaybackServiceResponse(
                        result=PlaybackResult.FILE_ERROR,
                        state=self._state,
                        error_message=f"Invalid file: {file_error}",
                        execution_time=time.time() - start_time,
                    )

load_success, audio_data, file_info, load_error = (
    self._file_service.load_file(request.file_path))
                if not load_success:
                    return AudioPlaybackServiceResponse(
                        result=PlaybackResult.FILE_ERROR,
                        state=self._state,
                        error_message=f"Failed to load file: {load_error}",
                        execution_time=time.time() - start_time,
                    )

                # Create track from loaded data
                self._track_counter += 1
                track_id = f"track_{self._track_counter}_{int(time.time())}"

                track = AudioTrack(
                    track_id=track_id,
                    file_path=request.file_path,
                    data=audio_data,
                    duration=file_info.get("duration") if file_info else None,
                    sample_rate=file_info.get("sample_rate", 44100) if file_info else 44100,
                    channels=file_info.get("channels", 2) if file_info else 2,
                    bit_depth=file_info.get("bit_depth", 16) if file_info else 16,
                    title=file_info.get("title") if file_info else request.file_path.stem,
                    metadata=file_info or {},
                )

            elif request.audio_data is not None:
                # Load from raw data
                self._track_counter += 1
                track_id = f"track_{self._track_counter}_{int(time.time())}"

                config = self._state.current_config
                duration = len(request.audio_data) / config.sample_rate if config else None

                track = AudioTrack(
                    track_id=track_id,
                    data=request.audio_data,
                    duration=duration,
                    sample_rate=config.sample_rate if config else 44100,
                    channels=config.channels if config else 2,
                    bit_depth=config.bit_depth if config else 16,
                )

            if not track:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.FAILED,
                    state=self._state,
                    error_message="No audio source provided",
                    execution_time=time.time() - start_time,
                )

            # Validate audio data compatibility
            if track.data is not None:
                data_valid,
data_error = (
    self._validation_service.validate_audio_data(track.data, self._state.current_config))
                if not data_valid:
                    warnings.append(f"Audio data validation warning: {data_error}")

            # Update state
            self._state.current_track = track
            self._state.processing_state = PlaybackState.READY

            if self._state.status:
                self._state.status.current_track_id = track.track_id
                self._state.status.total_duration = track.duration or 0.0
                self._state.status.current_position = 0.0

            load_result = AudioLoadResult(
                loaded=True,
                track=track,
                duration=track.duration,
                format_info={
                    "sample_rate": track.sample_rate,
                    "channels": track.channels,
                    "bit_depth": track.bit_depth,
                    "format": track.format.value,
                },
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                load_result=load_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to load audio: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_start_playback(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback start."""
        if not self._state.initialized:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Playback service not initialized",
                execution_time=time.time() - start_time,
            )

        if not self._state.current_track or not self._state.current_track.data is not None:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="No audio loaded for playback",
                execution_time=time.time() - start_time,
            )

        try:
            # Stop any existing playback
            if self._playback_thread and self._playback_thread.is_alive():
                self._stop_event.set()
                self._playback_thread.join(timeout=2.0)

            # Create output stream
            stream_success,
stream_id, stream_error = (
    self._stream_service.create_output_stream(self._state.current_config))
            if not stream_success:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to create stream: {stream_error}",
                    execution_time=time.time() - start_time,
                )

            self._stream_id = stream_id

            # Start stream
            start_success, start_error = self._stream_service.start_stream(stream_id)
            if not start_success:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to start stream: {start_error}",
                    execution_time=time.time() - start_time,
                )

            # Reset events
            self._stop_event.clear()
            self._pause_event.clear()
            self._seek_event.clear()

            # Update state
            self._state.processing_state = PlaybackState.PLAYING
            if self._state.status:
                self._state.status.is_playing = True
                self._state.status.is_paused = False

            # Start playback thread
            self._playback_thread = threading.Thread(
                target=self._playback_worker,
                args=(request.enable_real_time_callback,)
                daemon=True,
            )
            self._playback_thread.start()

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=self._state.current_track.track_id,
                position=self._current_position,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start playback: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_playback(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback stop."""
        try:
            # Signal stop to playback thread
            self._stop_event.set()

            # Wait for thread to finish
            if self._playback_thread and self._playback_thread.is_alive():
                self._playback_thread.join(timeout=5.0)

            # Stop and destroy stream
            if self._stream_id:
                self._stream_service.stop_stream(self._stream_id)
                self._stream_service.destroy_stream(self._stream_id)
                self._stream_id = None

            # Update state
            self._state.processing_state = PlaybackState.READY
            if self._state.status:
                self._state.status.is_playing = False
                self._state.status.is_paused = False

            # Reset position
            self._current_position = 0.0
            if self._state.status:
                self._state.status.current_position = 0.0

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=self._state.current_track.track_id if self._state.current_track else None,
                position=self._current_position,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop playback: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_pause_playback(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback pause."""
        try:
            self._pause_event.set()

            # Update state
            self._state.processing_state = PlaybackState.PAUSED
            if self._state.status:
                self._state.status.is_paused = True

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=self._state.current_track.track_id if self._state.current_track else None,
                position=self._current_position,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to pause playback: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_resume_playback(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback resume."""
        try:
            self._pause_event.clear()

            # Update state
            self._state.processing_state = PlaybackState.PLAYING
            if self._state.status:
                self._state.status.is_paused = False

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=self._state.current_track.track_id if self._state.current_track else None,
                position=self._current_position,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to resume playback: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_seek_position(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle seek position."""
        if request.position is None:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Position required for seek operation",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate position
            max_duration = self._state.current_track.duration if self._state.current_track else 0.0
            if request.position < 0 or (max_duration > 0 and request.position > max_duration):
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.FAILED,
                    state=self._state,
                    error_message="Invalid seek position",
                    execution_time=time.time() - start_time,
                )

            # Set seek position and signal
            self._seek_position = request.position
            self._seek_event.set()

            # Update state
            self._state.processing_state = PlaybackState.SEEKING

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=self._state.current_track.track_id if self._state.current_track else None,
                position=request.position,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to seek position: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_set_volume(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle volume setting."""
        if request.volume is None:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Volume value required",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate volume range
            if request.volume < 0.0 or request.volume > 1.0:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.FAILED,
                    state=self._state,
                    error_message="Volume must be between 0.0 and 1.0",
                    execution_time=time.time() - start_time,
                )

            # Update configuration and status
            if self._state.current_config:
                self._state.current_config.volume = request.volume

            if self._state.status:
                self._state.status.volume = request.volume

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                volume=request.volume,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to set volume: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_set_speed(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle speed setting."""
        if request.speed is None:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Speed value required",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate speed range
            if request.speed < 0.5 or request.speed > 2.0:
                return AudioPlaybackServiceResponse(
                    result=PlaybackResult.FAILED,
                    state=self._state,
                    error_message="Speed must be between 0.5 and 2.0",
                    execution_time=time.time() - start_time,
                )

            # Update configuration and status
            if self._state.current_config:
                self._state.current_config.speed = request.speed

            if self._state.status:
                self._state.status.speed = request.speed

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                speed=request.speed,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to set speed: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_get_playback_status(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback status retrieval."""
        try:
            # Update status with current information
            if self._state.status:
                self._state.status.current_position = self._current_position
                self._state.status.queue_size = len(self._state.playback_queue)

                # Calculate buffer health
                buffer_size = self._audio_buffer.qsize()
                max_buffer_size = 100  # Assume max 100 buffers
                self._state.status.buffer_health = min(buffer_size / max_buffer_size, 1.0)

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                status=self._state.status,
                metrics=self._state.metrics,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to get playback status: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_queue_audio(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle audio queueing."""
        if not request.track and not request.file_path and request.audio_data is None:
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message="Audio source required for queueing",
                execution_time=time.time() - start_time,
            )

        try:
            # Load audio if needed (similar to load_audio but add to queue)
            track = request.track

            if not track:
                # Create track from file or data (simplified version)
                self._track_counter += 1
                track_id = f"track_{self._track_counter}_{int(time.time())}"

                if request.file_path:
                    track = AudioTrack(
                        track_id=track_id,
                        file_path=request.file_path,
                        title=request.file_path.stem,
                    )
                elif request.audio_data is not None:
                    track = AudioTrack(
                        track_id=track_id,
                        data=request.audio_data,
                    )

            # Add to queue
            self._state.playback_queue.append(track)

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                track_id=track.track_id,
                queue_size=len(self._state.playback_queue)
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to queue audio: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_clear_queue(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle queue clearing."""
        try:
            len(self._state.playback_queue)
            self._state.playback_queue.clear()

            operation_result = PlaybackOperationResult(
                operation_successful=True,
                queue_size=0,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                operation_result=operation_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to clear queue: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_cleanup(self,
    request: AudioPlaybackServiceRequest, start_time: float, warnings: list[str]) -> AudioPlaybackServiceResponse:
        """Handle playback service cleanup."""
        try:
            # Stop playback
            self._stop_event.set()

            if self._playback_thread and self._playback_thread.is_alive():
                self._playback_thread.join(timeout=2.0)

            # Stop and destroy stream
            if self._stream_id:
                self._stream_service.stop_stream(self._stream_id)
                self._stream_service.destroy_stream(self._stream_id)
                self._stream_id = None

            # Clear buffers and queues
            while not self._audio_buffer.empty():
                try:
                    self._audio_buffer.get_nowait()
                except Empty:
                    break

            # Reset state
            self._state = AudioPlaybackServiceState()
            self._current_position = 0.0
            self._seek_position = None

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return AudioPlaybackServiceResponse(
                result=PlaybackResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to cleanup playback service: {e!s}"
            return AudioPlaybackServiceResponse(
                result=PlaybackResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _playback_worker(self, enable_callback: bool,
    ) -> None:
        """Worker thread for audio playback."""
        try:
            if not self._state.current_track or not self._state.current_track.data is not None:
                return

            track = self._state.current_track
            config = self._state.current_config
            audio_data = track.data

            # Calculate chunk size
            chunk_size = config.buffer_size if config else 4096
            sample_rate = track.sample_rate

            # Convert position to sample index
            current_sample = int(self._current_position * sample_rate)

            while not self._stop_event.is_set() and current_sample < len(audio_data):
                # Handle pause
                if self._pause_event.is_set():
                    time.sleep(0.1)
                    continue

                # Handle seek
                if self._seek_event.is_set():
                    if self._seek_position is not None:
                        current_sample = int(self._seek_position * sample_rate)
                        self._current_position = self._seek_position
                        self._seek_position = None

                    self._seek_event.clear(,
    )
                    self._state.processing_state = PlaybackState.PLAYING
                    continue

                # Get audio chunk
                end_sample = min(current_sample + chunk_size, len(audio_data))
                chunk = audio_data[current_sample:end_sample]

                if len(chunk) == 0:
                    break

                # Apply processing
                processed_chunk = chunk

                # Apply volume
                if config and config.volume != 1.0:
volume_success, volume_chunk, volume_error = (
    self._processing_service.apply_volume()
                        chunk, config.volume, config.volume_mode,
                    )
                    if volume_success and volume_chunk is not None:
                        processed_chunk = volume_chunk

                # Apply speed change
                if config and config.speed != 1.0:
speed_success, speed_chunk, speed_error = (
    self._processing_service.apply_speed_change()
                        processed_chunk, config.speed,
                    )
                    if speed_success and speed_chunk is not None:
                        processed_chunk = speed_chunk

                # Apply equalizer
                if config and config.enable_equalizer and config.equalizer_bands:
                    eq_success, eq_chunk, eq_error = self._processing_service.apply_equalizer(
                        processed_chunk, config.equalizer_bands,
                    )
                    if eq_success and eq_chunk is not None:
                        processed_chunk = eq_chunk

                # Write to stream
                if self._stream_id:
write_success, write_error = (
    self._stream_service.write_stream(self._stream_id, processed_chunk))

                    if not write_success:
                        if self._logger_service:
                            self._logger_service.log_warning(
                                "Failed to write to stream",
                                error=write_error,
                            )

                        if self._state.metrics:
                            self._state.metrics.frames_dropped += len(chunk)
                            self._state.metrics.playback_errors += 1
                    elif self._state.metrics:
                        self._state.metrics.frames_played += len(chunk)

                # Update position
                current_sample = end_sample
                self._current_position = current_sample / sample_rate

                if self._state.status:
                    self._state.status.current_position = self._current_position

                # Call real-time callback if enabled
                if enable_callback and config and config.callback:
                    try:
                        config.callback(processed_chunk, self._current_position)
                    except Exception as e:
                        if self._logger_service:
                            self._logger_service.log_warning(
                                "Error in playback callback",
                                error=str(e)
                            )

                # Small delay to control playback rate
                chunk_duration = len(chunk) / sample_rate
                if config and config.speed != 1.0:
                    chunk_duration /= config.speed

                time.sleep(max(0.001, chunk_duration * 0.9))  # Slight adjustment for timing

            # Playback finished
            if not self._stop_event.is_set():
                # Handle loop mode
                if config and config.mode == PlaybackMode.LOOP:
                    self._current_position = 0.0
                    # Restart playback (simplified)
                elif config and config.mode == PlaybackMode.QUEUE and self._state.playback_queue:
                    # Load next track from queue
                    next_track = self._state.playback_queue.pop(0)
                    self._state.current_track = next_track
                    self._current_position = 0.0
                    # Continue playback with new track
                else:
                    # Stop playback
                    self._state.processing_state = PlaybackState.READY
                    if self._state.status:
                        self._state.status.is_playing = False

        except Exception as e:
            if self._logger_service:
                self._logger_service.log_error(
                    "Error in playback worker",
                    error=str(e)
                )

            self._state.processing_state = PlaybackState.ERROR
            if self._state.status:
                self._state.status.last_error = str(e)

    def get_current_track(self) -> AudioTrack | None:
        """Get current track."""
        return self._state.current_track

    def get_playback_queue(self) -> list[AudioTrack]:
        """Get playback queue."""
        return self._state.playback_queue.copy()

    def get_state(self) -> AudioPlaybackServiceState:
        """Get current service state."""
        return self._state

    def get_status(self) -> PlaybackStatus | None:
        """Get current playback status."""
        return self._state.status

    def get_metrics(self) -> PlaybackMetrics | None:
        """Get playback metrics."""
        return self._state.metrics