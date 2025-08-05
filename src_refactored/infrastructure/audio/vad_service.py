"""VAD (Voice Activity Detection) Service.

This module implements the VADService for managing voice activity detection
with non-blocking patterns and comprehensive audio processing.
"""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from queue import Empty, Queue
from typing import Any, Protocol

import numpy as np

# Import domain concepts
from src_refactored.domain.audio.value_objects import (
    AudioChunk,
    CalibrationResult,
    VADConfiguration,
    VADDetection,
    VADModel,
    VADOperation,
    VADResult,
    VADState,
    VoiceActivity,
)

# VAD domain concepts (AudioChunk, CalibrationResult, VADDetection) now imported from domain layer


@dataclass
class VADServiceRequest:
    """Request for VAD service operations."""
    operation: VADOperation
    config: VADConfiguration | None = None
    audio_chunk: AudioChunk | None = None
    calibration_duration: float = 5.0
    callback: Callable[[VADDetection], None] | None = None
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    operation_timeout: float = 30.0


@dataclass
class ModelLoadResult:
    """Result of VAD model loading."""
    model_loaded: bool
    model_info: dict[str, Any] | None = None
    load_time: float = 0.0
    error_message: str | None = None


@dataclass
class ContinuousVADResult:
    """Result of continuous VAD processing."""
    session_started: bool
    session_id: str | None = None
    processing_thread: threading.Thread | None = None
    error_message: str | None = None


@dataclass
class VADServiceState:
    """Current state of VAD service."""
    initialized: bool = False
    current_config: VADConfiguration | None = None
    model_loaded: bool = False
    processing_state: VADState = VADState.INACTIVE
    continuous_session_id: str | None = None
    last_detection: VADDetection | None = None
    calibration_result: CalibrationResult | None = None
    error_message: str | None = None


@dataclass
class VADServiceResponse:
    """Response from VAD service operations."""
    result: VADResult
    state: VADServiceState
    detection: VADDetection | None = None
    detections: list[VADDetection] | None = None
    model_result: ModelLoadResult | None = None
    calibration: CalibrationResult | None = None
    continuous_result: ContinuousVADResult | None = None
    error_message: str | None = None
    warnings: list[str] = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.detections is None:
            self.detections = []


class VADModelServiceProtocol(Protocol,
    ):
    """Protocol for VAD model service."""

    def load_model(self, model: VADModel, config: VADConfiguration,
    ) -> ModelLoadResult:
        """Load VAD model."""
        ...

    def detect_voice_activity(self,
    audio_chunk: AudioChunk, config: VADConfiguration,
    ) -> tuple[bool, float, str | None]:
        """Detect voice activity in audio chunk."""
        ...

    def get_model_info(self) -> dict[str, Any]:
        """Get loaded model information."""
        ...

    def unload_model(self) -> tuple[bool, str | None]:
        """Unload current model."""
        ...


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def preprocess_audio(self,
    audio_data: np.ndarray, sample_rate: int, target_rate: int,
    ) -> tuple[bool, np.ndarray, str | None]:
        """Preprocess audio for VAD."""
        ...

    def normalize_audio(self, audio_data: np.ndarray) -> np.ndarray:
        """Normalize audio amplitude."""
        ...

    def apply_windowing(self, audio_data: np.ndarray, window_size: int, overlap: float,
    ) -> list[np.ndarray]:
        """Apply windowing to audio data."""
        ...

    def calculate_energy(self, audio_data: np.ndarray) -> float:
        """Calculate audio energy."""
        ...


class VADValidationServiceProtocol(Protocol):
    """Protocol for VAD validation service."""

    def validate_configuration(self, config: VADConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate VAD configuration."""
        ...

    def validate_audio_chunk(self, chunk: AudioChunk,
    ) -> tuple[bool, str | None]:
        """Validate audio chunk for processing."""
        ...

    def validate_threshold(self, threshold: float,
    ) -> tuple[bool, str | None]:
        """Validate VAD threshold value."""
        ...


class CalibrationServiceProtocol(Protocol):
    """Protocol for VAD calibration service."""

    def calibrate_threshold(self, audio_chunks: list[AudioChunk], config: VADConfiguration,
    ) -> CalibrationResult:
        """Calibrate optimal VAD threshold."""
        ...

    def analyze_noise_level(self, audio_chunks: list[AudioChunk]) -> float:
        """Analyze background noise level."""
        ...

    def analyze_speech_level(self, audio_chunks: list[AudioChunk]) -> float:
        """Analyze speech signal level."""
        ...


class SmoothingServiceProtocol(Protocol):
    """Protocol for VAD smoothing service."""

    def apply_smoothing(self, detections: list[VADDetection], config: VADConfiguration,
    ) -> list[VADDetection]:
        """Apply smoothing to VAD detections."""
        ...

    def filter_short_segments(self, detections: list[VADDetection], min_duration: float,
    ) -> list[VADDetection]:
        """Filter out short speech/silence segments."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: VADOperation,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: VADOperation, progress: float,
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


class VADService:
    """Service for managing voice activity detection with non-blocking patterns."""

    def __init__(
        self,
        model_service: VADModelServiceProtocol,
        audio_processing_service: AudioProcessingServiceProtocol,
        validation_service: VADValidationServiceProtocol,
        calibration_service: CalibrationServiceProtocol,
        smoothing_service: SmoothingServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._model_service = model_service
        self._audio_processing_service = audio_processing_service
        self._validation_service = validation_service
        self._calibration_service = calibration_service
        self._smoothing_service = smoothing_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

        self._state = VADServiceState()
        self._detection_queue = Queue()
        self._stop_event = threading.Event()
        self._worker_thread: threading.Thread | None = None
        self._chunk_counter = 0
        self._detection_history: list[VADDetection] = []

    def execute(self, request: VADServiceRequest,
    ) -> VADServiceResponse:
        """Execute VAD service operation."""
        start_time = time.time()
        warnings = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(request.operation)

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting VAD operation",
                    operation=request.operation.value,
                )

            # Route to appropriate operation handler
            if request.operation == VADOperation.INITIALIZE:
                return self._handle_initialize(request, start_time, warnings)
            if request.operation == VADOperation.DETECT_VOICE:
                return self._handle_detect_voice(request, start_time, warnings)
            if request.operation == VADOperation.SET_THRESHOLD:
                return self._handle_set_threshold(request, start_time, warnings)
            if request.operation == VADOperation.CALIBRATE:
                return self._handle_calibrate(request, start_time, warnings)
            if request.operation == VADOperation.START_CONTINUOUS:
                return self._handle_start_continuous(request, start_time, warnings)
            if request.operation == VADOperation.STOP_CONTINUOUS:
                return self._handle_stop_continuous(request, start_time, warnings)
            if request.operation == VADOperation.CLEANUP:
                return self._handle_cleanup(request, start_time, warnings)
            error_message = f"Unsupported operation: {request.operation}"
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Unexpected error during VAD operation: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "VAD operation failed",
                    error=str(e)
                    operation=request.operation.value,
                    execution_time=time.time() - start_time,
                )

            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_initialize(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle VAD initialization."""
        if not request.config:
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="Configuration required for initialization",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate configuration
config_valid, config_error = (
    self._validation_service.validate_configuration(request.config))
            if not config_valid:
                return VADServiceResponse(
                    result=VADResult.FAILED,
                    state=self._state,
                    error_message=f"Invalid configuration: {config_error}",
                    execution_time=time.time() - start_time,
                )

            # Load model
            model_result = self._model_service.load_model(request.config.model, request.config)
            if not model_result.model_loaded:
                return VADServiceResponse(
                    result=VADResult.MODEL_ERROR,
                    state=self._state,
                    model_result=model_result,
                    error_message=f"Failed to load model: {model_result.error_message}",
                    execution_time=time.time() - start_time,
                )

            # Update state
            self._state.initialized = True
            self._state.current_config = request.config
            self._state.model_loaded = True
            self._state.processing_state = VADState.ACTIVE

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "VAD initialized successfully",
                    model=request.config.model.value,
                    threshold=request.config.threshold,
                    execution_time=time.time() - start_time,
                )

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                model_result=model_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to initialize VAD: {e!s}"
            self._state.error_message = error_message

            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _handle_detect_voice(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle voice activity detection."""
        if not self._state.initialized or not self._state.model_loaded:
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="VAD service not initialized",
                execution_time=time.time() - start_time,
            )

        if not request.audio_chunk:
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="Audio chunk required for detection",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate audio chunk
chunk_valid, chunk_error = (
    self._validation_service.validate_audio_chunk(request.audio_chunk))
            if not chunk_valid:
                return VADServiceResponse(
                    result=VADResult.AUDIO_ERROR,
                    state=self._state,
                    error_message=f"Invalid audio chunk: {chunk_error}",
                    execution_time=time.time() - start_time,
                )

            # Preprocess audio if needed
            if request.audio_chunk.sample_rate != self._state.current_config.sample_rate:
                preprocess_success,
                processed_audio, preprocess_error = self._audio_processing_service.preprocess_audio(
                    request.audio_chunk.data,
                    request.audio_chunk.sample_rate,
                    self._state.current_config.sample_rate,
                )

                if not preprocess_success:
                    return VADServiceResponse(
                        result=VADResult.AUDIO_ERROR,
                        state=self._state,
                        error_message=f"Audio preprocessing failed: {preprocess_error}",
                        execution_time=time.time() - start_time,
                    )

                # Update chunk with processed audio
                request.audio_chunk.data = processed_audio
                request.audio_chunk.sample_rate = self._state.current_config.sample_rate

            # Detect voice activity
detection_success, confidence, detection_error = (
    self._model_service.detect_voice_activity()
                request.audio_chunk, self._state.current_config,
            )

            if not detection_success:
                return VADServiceResponse(
                    result=VADResult.MODEL_ERROR,
                    state=self._state,
                    error_message=f"Voice detection failed: {detection_error}",
                    execution_time=time.time() - start_time,
                )

            # Determine voice activity
            activity
 = (
    VoiceActivity.SPEECH if confidence >= self._state.current_config.threshold else VoiceActivity.SILENCE)
            if abs(confidence - self._state.current_config.threshold) < 0.1:
                activity = VoiceActivity.UNCERTAIN

            # Create detection result
            detection = VADDetection(
                activity=activity,
                confidence=confidence,
                timestamp=request.audio_chunk.timestamp,
                duration=request.audio_chunk.duration,
                chunk_id=request.audio_chunk.chunk_id,
                raw_score=confidence,
            )

            # Apply smoothing if enabled
            if self._state.current_config.enable_smoothing and self._detection_history:
                smoothed_detections = self._smoothing_service.apply_smoothing(
                    [*self._detection_history, detection], self._state.current_config,
                )
                if smoothed_detections:
                    detection = smoothed_detections[-1]

            # Update history
            self._detection_history.append(detection)
            if len(self._detection_history) > 100:  # Keep last 100 detections
                self._detection_history = self._detection_history[-100:]

            self._state.last_detection = detection

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress(,
    )

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                detection=detection,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to detect voice activity: {e!s}"
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_set_threshold(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle threshold setting."""
        if not request.config or not hasattr(request.config, "threshold"):
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="Threshold value required in configuration",
                execution_time=time.time() - start_time,
            )

        try:
            # Validate threshold
threshold_valid, threshold_error = (
    self._validation_service.validate_threshold(request.config.threshold))
            if not threshold_valid:
                return VADServiceResponse(
                    result=VADResult.THRESHOLD_ERROR,
                    state=self._state,
                    error_message=f"Invalid threshold: {threshold_error}",
                    execution_time=time.time() - start_time,
                )

            # Update threshold
            if self._state.current_config:
                self._state.current_config.threshold = request.config.threshold

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "VAD threshold updated",
                    new_threshold=request.config.threshold,
                    execution_time=time.time() - start_time,
                )

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to set threshold: {e!s}"
            return VADServiceResponse(
                result=VADResult.THRESHOLD_ERROR,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_calibrate(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle VAD calibration."""
        if not self._state.initialized:
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="VAD service not initialized",
                execution_time=time.time() - start_time,
            )

        try:
            self._state.processing_state = VADState.CALIBRATING

            # Collect audio chunks for calibration
            calibration_chunks = []
            # This would typically involve collecting audio over the calibration duration
            # For now, we'll simulate with empty list and return a placeholder result

            calibration_result = self._calibration_service.calibrate_threshold(
                calibration_chunks, self._state.current_config,
            )

            # Update configuration with calibrated threshold
            if self._state.current_config:
                self._state.current_config.threshold = calibration_result.optimal_threshold

            self._state.calibration_result = calibration_result
            self._state.processing_state = VADState.ACTIVE

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "VAD calibration completed",
                    optimal_threshold=calibration_result.optimal_threshold,
                    confidence=calibration_result.confidence,
                    execution_time=time.time() - start_time,
                )

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                calibration=calibration_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to calibrate VAD: {e!s}"
            self._state.processing_state = VADState.ERROR
            self._state.error_message = error_message

            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_start_continuous(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle start continuous VAD processing."""
        if not self._state.initialized:
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message="VAD service not initialized",
                execution_time=time.time() - start_time,
            )

        if self._state.processing_state == VADState.CONTINUOUS:
            warnings.append("Continuous processing already active")
            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        try:
            # Start continuous processing thread
            session_id = f"vad_session_{int(time.time())}"
            self._state.continuous_session_id = session_id
            self._state.processing_state = VADState.CONTINUOUS

            self._stop_event.clear()
            self._worker_thread = threading.Thread(
                target=self._continuous_processing_worker,
                args=(request.callback,)
                daemon=True,
            )
            self._worker_thread.start()

            continuous_result = ContinuousVADResult(
                session_started=True,
                session_id=session_id,
                processing_thread=self._worker_thread,
            )

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                continuous_result=continuous_result,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to start continuous processing: {e!s}"
            self._state.processing_state = VADState.ERROR

            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_stop_continuous(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle stop continuous VAD processing."""
        try:
            if self._state.processing_state != VADState.CONTINUOUS:
                warnings.append("No continuous processing active")
                return VADServiceResponse(
                    result=VADResult.SUCCESS,
                    state=self._state,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                )

            # Stop processing thread
            self._stop_event.set()
            if self._worker_thread and self._worker_thread.is_alive():
                self._worker_thread.join(timeout=1.0)

            self._state.processing_state = VADState.ACTIVE
            self._state.continuous_session_id = None

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to stop continuous processing: {e!s}"
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _handle_cleanup(self,
    request: VADServiceRequest, start_time: float, warnings: list[str]) -> VADServiceResponse:
        """Handle VAD cleanup."""
        try:
            # Stop continuous processing if active
            if self._state.processing_state == VADState.CONTINUOUS:
                self._stop_event.set()
                if self._worker_thread and self._worker_thread.is_alive():
                    self._worker_thread.join(timeout=1.0)

            # Unload model
            if self._state.model_loaded:
                unload_success, unload_error = self._model_service.unload_model()
                if not unload_success:
                    warnings.append(f"Failed to unload model: {unload_error}")

            # Reset state
            self._state = VADServiceState()
            self._detection_history.clear()

            # Clear queues
            while not self._detection_queue.empty():
                try:
                    self._detection_queue.get_nowait()
                except Empty:
                    break

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.complete_progress()

            return VADServiceResponse(
                result=VADResult.SUCCESS,
                state=self._state,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

        except Exception as e:
            error_message = f"Failed to cleanup VAD: {e!s}"
            return VADServiceResponse(
                result=VADResult.FAILED,
                state=self._state,
                error_message=error_message,
                execution_time=time.time() - start_time,
            )

    def _continuous_processing_worker(
    self,
    callback: Callable[[VADDetection],
    None] | None) -> None:
        """Worker thread for continuous VAD processing."""
        while not self._stop_event.is_set():
            try:
                # Get audio chunk from queue (this would be populated by audio input)
                # For now, we'll just sleep to simulate processing
                time.sleep(0.032)  # 32ms processing interval

                # In a real implementation, this would:
                # 1. Get audio chunk from input queue
                # 2. Process with VAD
                # 3. Call callback with result
                # 4. Add to detection queue

            except Exception as e:
                if self._logger_service:
                    self._logger_service.log_error(
                        "Error in continuous VAD processing",
                        error=str(e)
                    )
                break

    def get_detection_queue(self) -> Queue:
        """Get detection queue for non-blocking access."""
        return self._detection_queue

    def get_state(self) -> VADServiceState:
        """Get current service state."""
        return self._state

    def get_detection_history(self, limit: int = 10,
    ) -> list[VADDetection]:
        """Get recent detection history."""
        return self._detection_history[-limit:] if self._detection_history else []