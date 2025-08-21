"""PyAudio Core Service.

This module implements the core orchestration for PyAudio operations using the
modular protocols and types. It replaces the monolithic service logic with a
clean, layered implementation that can be wired by a factory.
"""

from __future__ import annotations

import threading
import time
from queue import Empty, Queue
from typing import TYPE_CHECKING, Any

from src.domain.audio.value_objects import (
    AudioData,
    AudioOperation,
    AudioResult,
    DeviceType,
    StreamConfiguration,
)

if TYPE_CHECKING:
    from .pyaudio_protocols import (
        AudioDataServiceProtocol,
        AudioValidationServiceProtocol,
        DeviceManagementServiceProtocol,
        LoggerServiceProtocol,
        ProgressTrackingServiceProtocol,
        StreamManagementServiceProtocol,
    )
from .pyaudio_types import (
    DeviceListResult,
    PyAudioServiceRequest,
    PyAudioServiceResponse,
    PyAudioServiceState,
    StreamOperationResult,
)


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


__all__ = ["PyAudioService"]


