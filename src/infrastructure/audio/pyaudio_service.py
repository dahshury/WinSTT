"""PyAudio Service.

This module implements the PyAudioService for managing PyAudio operations
with non-blocking patterns and comprehensive audio device management.
Extracted from utils/listener.py Recorder class (lines 23-124).
"""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from queue import Empty, Queue
from typing import Any, Protocol

import pyaudio

# Import domain value objects
from src.domain.audio.value_objects import (
    AudioConfiguration,
    AudioData,
    AudioOperation,
    AudioResult,
    DeviceType,
    StreamConfiguration,
)

# AudioResult, AudioOperation, DeviceType, and StreamState are now imported from domain layer


# AudioFormat is now imported from domain layer
# Infrastructure-specific format mapping
class PyAudioFormat(Enum):
    """PyAudio-specific format constants."""
    INT16 = "int16"
    INT24 = "int24"
    INT32 = "int32"
    FLOAT32 = "float32"


@dataclass
class AudioDeviceInfo:
    """Information about an audio device."""
    index: int
    name: str
    device_type: DeviceType
    max_input_channels: int
    max_output_channels: int
    default_sample_rate: float
    supported_sample_rates: list[float]
    is_default: bool = False
    host_api: str | None = None
    latency: float | None = None

    def __post_init__(self,
    ):
        if self.supported_sample_rates is None:
            self.supported_sample_rates = []


# AudioConfiguration, StreamConfiguration, and AudioData now imported from domain layer


@dataclass
class PyAudioServiceRequest:
    """Request for PyAudio service operations."""
    operation: AudioOperation
    stream_config: StreamConfiguration | None = None
    device_filter: DeviceType | None = None
    test_duration: float = 1.0
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    operation_timeout: float = 30.0


@dataclass
class DeviceListResult:
    """Result of device listing operation."""
    devices: list[AudioDeviceInfo]
    default_input_device: AudioDeviceInfo | None = None
    default_output_device: AudioDeviceInfo | None = None
    total_devices: int = 0
    available_devices: int = 0

    def __post_init__(self):
        self.total_devices = len(self.devices)
        self.available_devices =  len([d for d in self.devices if d.max_input_channels > 0 or d.max_output_channels > 0])



@dataclass
class StreamOperationResult:
    """Result of stream operations."""
    stream_created: bool
    stream_started: bool
    stream_active: bool
    stream_object: Any | None = None
    stream_info: dict[str, Any] | None = None
    error_message: str | None = None


@dataclass
class DeviceTestResult:
    """Result of device testing."""
    device_working: bool
    input_test_passed: bool
    output_test_passed: bool
    latency_measured: float | None = None
    error_message: str | None = None
    test_duration: float = 0.0


@dataclass
class PyAudioServiceState:
    """Current state of PyAudio service."""
    initialized: bool = False
    active_streams: dict[str, Any] | None = None
    available_devices: DeviceListResult | None = None
    # Track the most recent configuration (recording stream or base audio)
    current_config: AudioConfiguration | StreamConfiguration | None = None
    error_message: str | None = None

    def __post_init__(self):
        if self.active_streams is None:
            self.active_streams = {}


@dataclass
class PyAudioServiceResponse:
    """Response from PyAudio service operations."""
    result: AudioResult
    state: PyAudioServiceState
    device_list: DeviceListResult | None = None
    stream_result: StreamOperationResult | None = None
    device_test: DeviceTestResult | None = None
    audio_data: list[AudioData] | None = None
    error_message: str | None = None
    warnings: list[str] | None = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.audio_data is None:
            self.audio_data = []


class AudioValidationServiceProtocol(Protocol,
    ):
    """Protocol for audio validation service."""

    def validate_audio_configuration(self, config: AudioConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate audio configuration."""
        ...

    def validate_stream_configuration(self, config: StreamConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate stream configuration."""
        ...

    def validate_device_compatibility(self,
    device: AudioDeviceInfo, config: AudioConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility with configuration."""
        ...


class DeviceManagementServiceProtocol(Protocol):
    """Protocol for device management service."""

    def enumerate_devices(self) -> tuple[bool, list[AudioDeviceInfo], str | None]:
        """Enumerate available audio devices."""
        ...

    def get_default_device(self, device_type: DeviceType,
    ) -> tuple[bool, AudioDeviceInfo | None, str | None]:
        """Get default audio device."""
        ...

    def test_device(self, device: AudioDeviceInfo, config: AudioConfiguration, duration: float,
    ) -> DeviceTestResult:
        """Test audio device functionality."""
        ...

    def get_device_info(self, device_index: int,
    ) -> tuple[bool, AudioDeviceInfo | None, str | None]:
        """Get detailed device information."""
        ...


class StreamManagementServiceProtocol(Protocol):
    """Protocol for stream management service."""

    def create_stream(self, config: StreamConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Create audio stream."""
        ...

    def start_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Start audio stream."""
        ...

    def stop_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Stop audio stream."""
        ...

    def close_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Close audio stream."""
        ...

    def get_stream_info(self, stream: Any,
    ) -> dict[str, Any]:
        """Get stream information."""
        ...


class AudioDataServiceProtocol(Protocol):
    """Protocol for audio data service."""

    def read_audio_data(self,
    stream: Any, chunk_size: int, timeout: float,
    ) -> tuple[bool, AudioData | None, str | None]:
        """Read audio data from stream."""
        ...

    def write_audio_data(self, stream: Any, data: AudioData, timeout: float,
    ) -> tuple[bool, str | None]:
        """Write audio data to stream."""
        ...

    def process_audio_callback(self, data: bytes, frame_count: int, config: AudioConfiguration,
    ) -> AudioData:
        """Process audio callback data."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: AudioOperation,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: AudioOperation, progress: float,
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


class PyAudioRecorder:
    """PyAudio-based audio recorder with non-blocking patterns.
    
    Extracted from utils/listener.py Recorder class (lines 23-124).
    """

    def __init__(self, chunk: int = 256, channels: int = 1, rate: int = 16000):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = threading.Event()
        self._frames: list[bytes] = []
        self.p: pyaudio.PyAudio | None = None
        self.stream: pyaudio.Stream | None = None
        self.logger = logging.getLogger(__name__)
        self._error_callback: Callable[[str], None] | None = None
        self._last_device_available = True  # Track if device was available on last attempt
        self._stream_lock = threading.Lock()  # Protect stream operations

        # Initialize PyAudio
        self._initialize_pyaudio()

    def _initialize_pyaudio(self) -> None:
        """Initialize PyAudio instance."""
        try:
            self.p = pyaudio.PyAudio()
        except Exception as e:
            self.logger.exception("Failed to initialize PyAudio: %s", e)
            msg = f"Failed to initialize PyAudio: {e}"
            raise RuntimeError(msg) from e

    def set_error_callback(self, callback: Callable[[str], None]) -> None:
        """Set error callback for non-blocking error reporting."""
        self._error_callback = callback

    def start(self) -> None:
        """Start recording with non-blocking patterns and persistent stream reuse."""
        self._running.set()
        self._frames = []
        
        with self._stream_lock:
            try:
                # Initialize PyAudio if needed
                if self.p is None:
                    self._initialize_pyaudio()
                assert self.p is not None

                # Check if we need to create/recreate the stream
                need_new_stream = (
                    self.stream is None or 
                    not self._last_device_available  # Recreate if no device was available last time
                )
                
                if need_new_stream:
                    # Close existing stream if any
                    if self.stream is not None:
                        try:
                            self.stream.close()
                        except Exception:
                            pass
                        self.stream = None
                    
                    # If device was unavailable last time, refresh PyAudio to detect newly connected devices
                    if not self._last_device_available:
                        self.logger.info("Device was unavailable last time - refreshing PyAudio to detect newly connected devices")
                        try:
                            if self.p is not None:
                                self.p.terminate()
                        except Exception:
                            pass
                        self._initialize_pyaudio()
                        self.logger.debug("PyAudio reinitialized for device detection")
                    
                    # Try to create new stream
                    self._create_stream()
                else:
                    # Reuse existing stream - just ensure it's ready
                    try:
                        if not self.stream.is_active():
                            self.stream.start_stream()
                    except Exception:
                        # If reusing fails, recreate
                        try:
                            self.stream.close()
                        except Exception:
                            pass
                        self.stream = None
                        self._create_stream()

                # Mark device as available since we got here
                was_previously_unavailable = not self._last_device_available
                self._last_device_available = True
                if was_previously_unavailable:
                    self.logger.info("Audio device is now available - recording ready")
                
                # Start recording thread
                threading.Thread(target=self._recording, daemon=True).start()
                self.logger.debug("Recording started.")
                
            except OSError as e:
                self._last_device_available = False
                if "Invalid input device" in str(e) or "no default output device" in str(e):
                    # Nice message for missing recording device
                    msg = "No recording device detected. Please connect a microphone."
                    if self._error_callback:
                        # Defer user-facing message to callback to avoid duplicate warnings in console
                        self._error_callback(msg)
                    else:
                        self.logger.warning(msg)
                    raise RuntimeError(msg) from e
                # Log without traceback to keep console clean
                self.logger.error("Failed to access audio device: %s", e)
                msg = f"Failed to access audio device: {e}"
                if self._error_callback:
                    self._error_callback(msg)
                raise RuntimeError(msg) from e
            except Exception as e:
                self._last_device_available = False
                # Log without traceback; caller decides whether to show details
                self.logger.error("Failed to start recording: %s", e)
                msg = f"Failed to start recording: {e}"
                if self._error_callback:
                    self._error_callback(msg)
                raise RuntimeError(msg) from e

    def _create_stream(self) -> None:
        """Create a new PyAudio stream with device fallback logic."""
        # Try default device first; on failure, fall back to first usable input device
        try:
            self.stream = self.p.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK,
            )
        except OSError as default_error:
            # Attempt fallback to a specific input device to handle cases where no default is set
            try:
                device_count = self.p.get_device_count()
                fallback_opened = False
                for idx in range(device_count):
                    try:
                        info = self.p.get_device_info_by_index(idx)
                        if info.get("maxInputChannels", 0) > 0:
                            # Use device's default rate if available
                            rate = int(info.get("defaultSampleRate", self.RATE) or self.RATE)
                            self.stream = self.p.open(
                                format=self.FORMAT,
                                channels=self.CHANNELS,
                                rate=rate,
                                input=True,
                                input_device_index=idx,
                                frames_per_buffer=self.CHUNK,
                            )
                            fallback_opened = True
                            break
                    except Exception:
                        # Try next device
                        continue
                if not fallback_opened:
                    raise default_error
            except Exception as fallback_error:
                raise fallback_error
        except OSError as e:
            if "Invalid input device" in str(e) or "no default output device" in str(e):
                # Nice message for missing recording device
                msg = "No recording device detected. Please connect a microphone."
                if self._error_callback:
                    # Defer user-facing message to callback to avoid duplicate warnings in console
                    self._error_callback(msg)
                else:
                    self.logger.warning(msg)
                raise RuntimeError(msg) from e
            # Log without traceback to keep console clean
            self.logger.error("Failed to access audio device: %s", e)
            msg = f"Failed to access audio device: {e}"
            if self._error_callback:
                self._error_callback(msg)
            raise RuntimeError(msg) from e
        except Exception as e:
            # Log without traceback; caller decides whether to show details
            self.logger.error("Failed to start recording: %s", e)
            msg = f"Failed to start recording: {e}"
            if self._error_callback:
                self._error_callback(msg)
            raise RuntimeError(msg) from e

    def _recording(self) -> None:
        """Recording worker thread."""
        try:
            while self._running.is_set():
                if self.stream is not None:
                    data = self.stream.read(self.CHUNK, exception_on_overflow=False)
                    self._frames.append(data)
        except Exception as e:
            self.logger.exception("Error during recording: %s", e)
            if self._error_callback:
                self._error_callback(f"Error during recording: {e}")
        finally:
            if self.stream is not None:
                try:
                    self.stream.stop_stream()
                    self.stream.close()
                except Exception as e:
                    self.logger.exception("Error closing stream: %s", e)
                finally:
                    self.stream = None
                    self.logger.debug("Stream closed.")

    def stop(self) -> None:
        """Stop recording but keep stream alive for reuse."""
        self._running.clear()
        with self._stream_lock:
            # Stop the stream but don't close it for reuse
            if self.stream is not None:
                try:
                    # Only attempt to stop if device was available and stream is likely valid
                    if self._last_device_available and hasattr(self.stream, 'is_active'):
                        if self.stream.is_active():
                            self.stream.stop_stream()
                        self.logger.debug("Recording stopped, stream kept for reuse.")
                    else:
                        # Device not available or stream in invalid state - clean up safely
                        try:
                            self.stream.close()
                        except Exception:
                            pass
                        self.stream = None
                        self.logger.debug("Recording stopped, stream cleaned up due to device unavailability.")
                except Exception as e:
                    self.logger.error("Error stopping stream: %s", e)
                    # If stopping fails, close and recreate next time
                    try:
                        self.stream.close()
                    except Exception:
                        pass
                    self.stream = None
            else:
                self.logger.debug("Recording stopped.")

    def get_wav_bytes(self) -> bytes:
        """Assemble the recorded frames into a WAV format in-memory bytes buffer."""
        try:
            from src.infrastructure.common.file_audio_writer import FileAudioWriter
            writer = FileAudioWriter()
            sample_width = self.p.get_sample_size(self.FORMAT) if self.p is not None else 2
            return writer.assemble_wav(sample_width, self.CHANNELS, self.RATE, self._frames)
        except Exception as e:
            self.logger.exception("Failed to assemble WAV bytes: %s", e)
            if self._error_callback:
                self._error_callback(f"Failed to assemble WAV bytes: {e}")
            raise

    def close(self, reset: bool = False,
    ) -> None:
        """Close the Recorder and release resources.
        
        Args:
            reset: If True, reset the audio stream and PyAudio instance for reuse.
        """
        try:
            with self._stream_lock:
                if self.stream is not None:
                    try:
                        self.stream.stop_stream()
                        self.stream.close()
                    except Exception as e:
                        self.logger.error("Error stopping/closing stream: %s", e)
                    finally:
                        if not reset:
                            self.stream = None

                if self.p is not None:
                    try:
                        self.p.terminate()
                    except Exception as e:
                        self.logger.error("Error terminating PyAudio: %s", e)
                    finally:
                        if not reset:
                            self.p = None

                if reset:
                    # Reinitialize PyAudio for reuse and reset device state
                    self._initialize_pyaudio()
                    self.stream = None  # Ensure the stream is reset
                    self._last_device_available = True  # Reset device state for fresh detection
                    self.logger.debug("Recorder reset for reinitialization.")
        except Exception as e:
            self.logger.error("Error closing Recorder: %s", e)
            if self._error_callback:
                self._error_callback(f"Error closing Recorder: {e}")


class PyAudioService:
    """Service for managing PyAudio operations with non-blocking patterns."""

    def __init__(
        self,
        validation_service: AudioValidationServiceProtocol,
        device_management_service: DeviceManagementServiceProtocol,
        stream_management_service: StreamManagementServiceProtocol,
        audio_data_service: AudioDataServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._validation_service = validation_service
        self._device_management_service = device_management_service
        self._stream_management_service = stream_management_service
        self._audio_data_service = audio_data_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

        self._state = PyAudioServiceState()
        # Typed audio data queue
        self._data_queue: Queue[AudioData] = Queue()
        self._stop_event = threading.Event()
        self._worker_thread: threading.Thread | None = None
        self._recorder: PyAudioRecorder | None = None

    def execute(self, request: PyAudioServiceRequest,
    ) -> PyAudioServiceResponse:
        """Execute PyAudio service operation."""
        start_time = time.time()
        warnings: list[str] = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(request.operation)

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting PyAudio operation",
                    operation=request.operation.value,
                )

            # Route to appropriate operation handler
            if request.operation == AudioOperation.INITIALIZE:
                return self._handle_initialize(request, start_time, warnings)
            if request.operation == AudioOperation.LIST_DEVICES:
                return self._handle_list_devices(request, start_time, warnings)
            if request.operation == AudioOperation.TEST_DEVICE:
                return self._handle_test_device(request, start_time, warnings)
            if request.operation == AudioOperation.START_RECORDING:
                return self._handle_start_recording(request, start_time, warnings)
            if request.operation == AudioOperation.STOP_RECORDING:
                return self._handle_stop_recording(request, start_time, warnings)
            if request.operation == AudioOperation.START_PLAYBACK:
                return self._handle_start_playback(request, start_time, warnings)
            if request.operation == AudioOperation.STOP_PLAYBACK:
                return self._handle_stop_playback(request, start_time, warnings)
            if request.operation == AudioOperation.CLEANUP:
                return self._handle_cleanup(request, start_time, warnings)
            error_message = f"Unsupported operation: {request.operation}"
            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Unexpected error during PyAudio operation: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "PyAudio operation failed",
                    error=str(e),
                    operation=request.operation.value,
                    execution_time=time.time() - start_time,
                )

            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_initialize(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle PyAudio initialization."""
        try:
            # Initialize PyAudio
            self._state.initialized = True

            # Enumerate devices
            devices_success, devices, devices_error = self._device_management_service.enumerate_devices()
            if not devices_success:
                warnings.append(f"Failed to enumerate devices: {devices_error}")
                devices = []

            # Get default devices
            default_input_success, default_input, _ = self._device_management_service.get_default_device(DeviceType.INPUT)
            default_output_success, default_output, _ = self._device_management_service.get_default_device(DeviceType.OUTPUT)

            device_list = DeviceListResult(
                devices=devices,
                default_input_device=default_input if default_input_success else None,
                default_output_device=default_output if default_output_success else None,
            )

            self._state.available_devices = device_list

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "PyAudio initialized successfully",
                    devices_found=len(devices),
                    execution_time=time.time() - start_time,
                )

            return PyAudioServiceResponse(
                result=AudioResult.SUCCESS,
                state=self._state,
                device_list=device_list,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to initialize PyAudio: {e!s}"
            self._state.error_message = error_message

            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_list_devices(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle device listing."""
        try:
            devices_success, devices, devices_error = self._device_management_service.enumerate_devices()
            if not devices_success:
                return PyAudioServiceResponse(
                    result=AudioResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to enumerate devices: {devices_error}",
                    execution_time=time.time() - start_time,
                )

            # Filter devices if requested
            if request.device_filter:
                if request.device_filter == DeviceType.INPUT:
                    devices = [d for d in devices if d.max_input_channels > 0]
                elif request.device_filter == DeviceType.OUTPUT:
                    devices = [d for d in devices if d.max_output_channels > 0]

            device_list = DeviceListResult(devices=devices)

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return PyAudioServiceResponse(
                result=AudioResult.SUCCESS,
                state=self._state,
                device_list=device_list,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to list devices: {e!s}"
            return PyAudioServiceResponse(
                result=AudioResult.DEVICE_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_test_device(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle device testing."""
        if not request.stream_config:
            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message="Stream configuration required for device testing",
                execution_time=time.time() - start_time,
            )

        try:
            # Get device to test
            device_index = request.stream_config.input_device_id
            if device_index is None:
                return PyAudioServiceResponse(
                    result=AudioResult.FAILED,
                    state=self._state,
                    error_message="Device index required for testing",
                    execution_time=time.time() - start_time,
                )

            device_success, device, device_error = self._device_management_service.get_device_info(int(device_index))
            if not device_success or device is None:
                return PyAudioServiceResponse(
                    result=AudioResult.DEVICE_ERROR,
                    state=self._state,
                    error_message=f"Failed to get device info: {device_error}",
                    execution_time=time.time() - start_time,
                )

            # Test device
            # The protocol expects an AudioConfiguration for test_device
            test_result = self._device_management_service.test_device(
                device,
                request.stream_config.audio_config,
                request.test_duration,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            result = AudioResult.SUCCESS if test_result.device_working else AudioResult.DEVICE_ERROR

            return PyAudioServiceResponse(
                result=result,
                state=self._state,
                device_test=test_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to test device: {e!s}"
            return PyAudioServiceResponse(
                result=AudioResult.DEVICE_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_start_recording(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle start recording operation."""
        if not request.stream_config:
            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message="Stream configuration required for recording",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
            config_valid, config_error = self._validation_service.validate_stream_configuration(request.stream_config)
            if not config_valid:
                return PyAudioServiceResponse(
                    result=AudioResult.FORMAT_ERROR,
                    state=self._state,
                    error_message=f"Invalid stream configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Create stream
            stream_created, stream, stream_error = self._stream_management_service.create_stream(request.stream_config)
            if not stream_created:
                return PyAudioServiceResponse(
                    result=AudioResult.STREAM_ERROR,
                    state=self._state,
                    error_message=f"Failed to create stream: {stream_error}",
                    execution_time=time.time() - start_time,
                )

            # Start stream
            stream_started, start_error = self._stream_management_service.start_stream(stream)
            if not stream_started:
                return PyAudioServiceResponse(
                    result=AudioResult.STREAM_ERROR,
                    state=self._state,
                    error_message=f"Failed to start stream: {start_error}",
                    execution_time=time.time() - start_time,
                )

            # Store stream
            active_streams = self._state.active_streams or {}
            stream_id = f"recording_{len(active_streams)}"
            active_streams[stream_id] = stream
            self._state.active_streams = active_streams
            # Track only the base audio configuration for summary state
            self._state.current_config = request.stream_config.audio_config

            stream_result = StreamOperationResult(
                stream_created=True,
                stream_started=stream_started,
                stream_active=stream_started,
                stream_object=stream,
                stream_info=self._stream_management_service.get_stream_info(stream),
            )

            # Start data collection thread if non-blocking
            if request.stream_config.non_blocking and stream_started:
                self._start_data_collection_thread(stream, request.stream_config)

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return PyAudioServiceResponse(
                result=AudioResult.SUCCESS,
                state=self._state,
                stream_result=stream_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start recording: {e!s}"
            return PyAudioServiceResponse(
                result=AudioResult.STREAM_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_recording(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle stop recording operation."""
        try:
            # Stop all recording streams
            stopped_streams = 0
            for stream_id, stream in list((self._state.active_streams or {}).items()):
                if "recording" in stream_id:
                    stop_success, stop_error = self._stream_management_service.stop_stream(stream)
                    if stop_success:
                        close_success, close_error = self._stream_management_service.close_stream(stream)
                        if close_success:
                            active_streams = self._state.active_streams or {}
                            if stream_id in active_streams:
                                del active_streams[stream_id]
                                self._state.active_streams = active_streams
                            stopped_streams += 1
                        else:
                            warnings.append(f"Failed to close stream {stream_id}: {close_error}")
                    else:
                        warnings.append(f"Failed to stop stream {stream_id}: {stop_error}")

            # Stop data collection thread
            self._stop_data_collection_thread()

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            result = AudioResult.SUCCESS if stopped_streams > 0 else AudioResult.FAILED

            return PyAudioServiceResponse(
                result=result,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop recording: {e!s}"
            return PyAudioServiceResponse(
                result=AudioResult.STREAM_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_start_playback(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle start playback operation."""
        # Similar implementation to start_recording but for output streams
        # Implementation would be similar to _handle_start_recording but configured for output
        return PyAudioServiceResponse(
            result=AudioResult.SUCCESS,
            state=self._state,
            warnings=["Playback not yet implemented"],
            execution_time=time.time() - start_time,
        )

    def _handle_stop_playback(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle stop playback operation."""
        # Similar implementation to stop_recording but for output streams
        return PyAudioServiceResponse(
            result=AudioResult.SUCCESS,
            state=self._state,
            warnings=["Playback not yet implemented"],
            execution_time=time.time() - start_time,
        )

    def _handle_cleanup(self,
    request: PyAudioServiceRequest, start_time: float, warnings: list[str]) -> PyAudioServiceResponse:
        """Handle cleanup operation."""
        try:
            # Stop data collection
            self._stop_data_collection_thread()

            # Close all active streams
            for stream_id, stream in list((self._state.active_streams or {}).items()):
                try:
                    self._stream_management_service.stop_stream(stream)
                    self._stream_management_service.close_stream(stream)
                except Exception as e:
                    warnings.append(f"Error closing stream {stream_id}: {e!s}")

            # Reset state
            if self._state.active_streams:
                self._state.active_streams.clear()
            else:
                self._state.active_streams = {}
            self._state.current_config = None

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return PyAudioServiceResponse(
                result=AudioResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to cleanup: {e!s}"
            return PyAudioServiceResponse(
                result=AudioResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _start_data_collection_thread(self, stream: Any, config: StreamConfiguration,
    ) -> None:
        """Start data collection thread for non-blocking operation."""
        if self._worker_thread and self._worker_thread.is_alive():
            return

        self._stop_event.clear()
        self._worker_thread = threading.Thread(
            target=self._data_collection_worker,
            args=(stream, config),
            daemon=True,
        )
        self._worker_thread.start()

    def _stop_data_collection_thread(self) -> None:
        """Stop data collection thread."""
        if self._worker_thread and self._worker_thread.is_alive():
            self._stop_event.set()
            self._worker_thread.join(timeout=1.0)

    def _data_collection_worker(self, stream: Any, config: StreamConfiguration,
    ) -> None:
        """Worker thread for collecting audio data."""
        while not self._stop_event.is_set():
            try:
                # Read audio data
                data_success, audio_data, data_error = self._audio_data_service.read_audio_data(
                    stream, config.audio_config.chunk_size, config.timeout,
                )

                if data_success and audio_data:
                    # Add to queue
                    try:
                        self._data_queue.put_nowait(audio_data)
                    except Exception:
                        # Queue full or closed, skip this chunk
                        pass

                    # Call callback if provided
                    if config.callback:
                        try:
                            # Callback accepts a single payload argument
                            config.callback(audio_data)
                        except Exception as e:
                            if config.error_callback:
                                config.error_callback(e)

                elif data_error and config.error_callback:
                    config.error_callback(Exception(data_error))

            except Exception as e:
                if config.error_callback:
                    config.error_callback(e)
                break

    def get_audio_data(self, timeout: float = 0.1) -> AudioData | None:
        """Get audio data from queue (non-blocking)."""
        try:
            return self._data_queue.get(timeout=timeout)
        except Empty:
            return None

    def get_state(self,
    ) -> PyAudioServiceState:
        """Get current service state."""
        return self._state