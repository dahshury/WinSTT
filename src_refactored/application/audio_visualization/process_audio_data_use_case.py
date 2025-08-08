"""Process Audio Data Use Case.

This module implements the ProcessAudioDataUseCase for handling real-time
audio data processing with normalization and visualization preparation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

from src_refactored.domain.audio.value_objects.audio_samples import AudioDataType, AudioSampleData
from src_refactored.domain.audio.value_objects.sample_rate import SampleRate
from src_refactored.domain.audio_visualization.value_objects.normalization_types import (
    NormalizationMethod,
)
from src_refactored.domain.audio_visualization.value_objects.processing_types import (
    ProcessingPhase,
    ProcessingResult,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.audio_visualization.protocols import (
        AudioBufferServiceProtocol,
        AudioDataConversionServiceProtocol,
        AudioDataValidationServiceProtocol,
        AudioNormalizationServiceProtocol,
        LoggerServiceProtocol,
        SignalEmissionServiceProtocol,
    )


@dataclass
class AudioProcessingConfiguration:
    """Configuration for audio data processing."""
    normalization_method: NormalizationMethod = NormalizationMethod.SPEECH_OPTIMIZED
    target_sample_rate: int | None = None
    buffer_size: int = 1024
    scaling_factor: float = 0.3
    enable_clipping: bool = True
    enable_centering: bool = True
    rms_threshold: float = 1e-6
    max_amplitude: float = 1.0
    emit_processed_data: bool = True
    validate_input: bool = True


@dataclass
class ProcessAudioDataRequest:
    """Request for processing audio data."""
    raw_data: Any
    data_type: AudioDataType
    configuration: AudioProcessingConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[ProcessingResult], None] | None = None
    error_callback: Callable[[str], None] | None = None
    data_ready_callback: Callable[[np.ndarray], None] | None = None


@dataclass
class ProcessedAudioData:
    """Processed audio data result."""
    normalized_data: np.ndarray
    original_shape: tuple[int, ...]
    rms_value: float
    peak_value: float
    data_range: tuple[float, float]
    processing_time: float
    buffer_updated: bool = False


@dataclass
class ProcessAudioDataResponse:
    """Response from processing audio data."""
    result: ProcessingResult
    processed_data: ProcessedAudioData | None = None
    buffer_size: int | None = None
    signal_emitted: bool = False
    processing_time: float | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


# Protocols now imported from domain layer


class ProcessAudioDataUseCase:
    """Use case for processing audio data for visualization."""

    def __init__(
        self,
        validation_service: AudioDataValidationServiceProtocol,
        conversion_service: AudioDataConversionServiceProtocol,
        normalization_service: AudioNormalizationServiceProtocol,
        buffer_service: AudioBufferServiceProtocol,
        signal_service: SignalEmissionServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            validation_service: Service for data validation
            conversion_service: Service for data conversion
            normalization_service: Service for audio normalization
            buffer_service: Service for buffer management
            signal_service: Service for signal emission
            logger_service: Service for logging
        """
        self._validation_service = validation_service
        self._conversion_service = conversion_service
        self._normalization_service = normalization_service
        self._buffer_service = buffer_service
        self._signal_service = signal_service
        self._logger_service = logger_service

    def execute(self, request: ProcessAudioDataRequest,
    ) -> ProcessAudioDataResponse:
        """Execute the process audio data use case.
        
        Args:
            request: The processing request
            
        Returns:
            ProcessAudioDataResponse with processing results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize processing
            self._logger_service.log_debug(
                "Starting audio data processing",
                phase=ProcessingPhase.INITIALIZING.value,
                data_type=request.data_type.value,
            )

            if request.progress_callback:
                request.progress_callback("Initializing processing...", 10.0)

            # Phase 2: Validate input data if configured
            if request.configuration.validate_input:
                self._logger_service.log_debug(
                    "Validating audio data",
                    phase=ProcessingPhase.VALIDATING_DATA.value,
                )

                if request.progress_callback:
                    request.progress_callback("Validating data...", 20.0)

                # Convert raw data to AudioSampleData for validation
                audio_data = AudioSampleData(
                    samples=request.raw_data,
                    sample_rate=SampleRate(16000),  # Default rate, should come from request
                    channels=1,
                    data_type=request.data_type,
                )
                if not self._validation_service.validate_audio_data(audio_data):
                    error_message = "Invalid audio data provided"
                    self._logger_service.log_error("Audio data validation failed")

                    if request.error_callback:
                        request.error_callback(error_message)

                    return ProcessAudioDataResponse(
                        result=ProcessingResult.INVALID_DATA,
                        processing_time=time.time() - start_time,
                        error_message=error_message,
                    )

            # Phase 3: Convert data to numpy array
            self._logger_service.log_debug(
                "Converting audio data",
                phase=ProcessingPhase.CONVERTING_DATA.value,
            )

            if request.progress_callback:
                request.progress_callback("Converting data...", 40.0)

            try:
                # Convert raw data to numpy array 
                numpy_data = self._conversion_service.convert_to_numpy(
                    request.raw_data, request.data_type,
                )
                original_shape = numpy_data.shape
            except Exception as e:
                error_message = f"Failed to convert audio data: {e!s}"
                self._logger_service.log_error("Audio data conversion failed", error=str(e))

                if request.error_callback:
                    request.error_callback(error_message)

                return ProcessAudioDataResponse(
                    result=ProcessingResult.FAILURE,
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 4: Normalize the data
            self._logger_service.log_debug(
                "Normalizing audio data",
                phase=ProcessingPhase.NORMALIZING.value,
                method=request.configuration.normalization_method.value,
            )

            if request.progress_callback:
                request.progress_callback("Normalizing data...", 60.0)

            try:
                # Calculate original statistics
                original_rms = self._normalization_service.calculate_rms(numpy_data)
                original_peak = float(np.max(np.abs(numpy_data))) if len(numpy_data) > 0 else 0.0
                original_range = (float(np.min(numpy_data)),
                float(np.max(numpy_data))) if len(numpy_data) > 0 else (0.0, 0.0)

                # Apply normalization based on method
                if request.configuration.normalization_method == NormalizationMethod.SPEECH_OPTIMIZED:
                    # Convert numpy array to AudioSampleData for normalization
                    
                    audio_data = AudioSampleData(
                        samples=numpy_data.tolist(),
                        sample_rate=SampleRate(16000),  # Default rate, should come from request
                        channels=1,
                        data_type=AudioDataType.FLOAT32,
                    )
                    normalized_audio_data = self._normalization_service.normalize_for_speech(
                        audio_data, request.configuration.scaling_factor,
                    )
                    # Convert back to numpy
                    normalized_data = np.array(normalized_audio_data.samples)
                elif request.configuration.normalization_method == NormalizationMethod.RMS_BASED:
                    # Convert numpy array to AudioSampleData for normalization
                    
                    audio_data = AudioSampleData(
                        samples=numpy_data.tolist(),
                        sample_rate=SampleRate(16000),  # Default rate, should come from request
                        channels=1,
                        data_type=AudioDataType.FLOAT32,
                    )
                    # Need target_rms parameter
                    target_rms = 0.1  # Default value, should come from configuration
                    normalized_audio_data = self._normalization_service.normalize_rms_based(
                        audio_data, target_rms,
                    )
                    # Convert back to numpy
                    normalized_data = np.array(normalized_audio_data.samples)
                elif request.configuration.normalization_method == NormalizationMethod.PEAK_BASED:
                    # Convert numpy array to AudioSampleData for normalization
                    audio_data = AudioSampleData(
                        samples=numpy_data.tolist(),
                        sample_rate=SampleRate(16000),  # Default rate, should come from request
                        channels=1,
                        data_type=AudioDataType.FLOAT32,
                    )
                    normalized_audio_data = self._normalization_service.normalize_peak_based(
                        audio_data, request.configuration.max_amplitude,
                    )
                    # Convert back to numpy
                    normalized_data = np.array(normalized_audio_data.samples)
                else:
                    # Default to speech optimized
                    # Convert numpy array to AudioSampleData for normalization
                    audio_data = AudioSampleData(
                        samples=numpy_data.tolist(),
                        sample_rate=SampleRate(16000),  # Default rate, should come from request
                        channels=1,
                        data_type=AudioDataType.FLOAT32,
                    )
                    normalized_audio_data = self._normalization_service.normalize_for_speech(
                        audio_data, request.configuration.scaling_factor,
                    )
                    # Convert back to numpy
                    normalized_data = np.array(normalized_audio_data.samples)

                # Apply clipping if enabled
                if request.configuration.enable_clipping:
                    normalized_data = np.clip(
                        normalized_data,
                        -request.configuration.max_amplitude,
                        request.configuration.max_amplitude,
                    )

                # Apply centering if enabled
                if request.configuration.enable_centering:
                    normalized_data = normalized_data - np.mean(normalized_data)

            except Exception as e:
                error_message = f"Failed to normalize audio data: {e!s}"
                self._logger_service.log_error("Audio normalization failed", error=str(e))

                if request.error_callback:
                    request.error_callback(error_message)

                return ProcessAudioDataResponse(
                    result=ProcessingResult.NORMALIZATION_FAILED,
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 5: Update buffer
            self._logger_service.log_debug(
                "Updating audio buffer",
                phase=ProcessingPhase.UPDATING_BUFFER.value,
            )

            if request.progress_callback:
                request.progress_callback("Updating buffer...", 80.0)

            buffer_updated = False
            try:
                # Convert numpy data back to AudioSampleData for buffer
                audio_data_for_buffer = AudioSampleData(
                    samples=normalized_data.tolist(),
                    sample_rate=SampleRate(16000),  # Default rate, should come from request
                    channels=1,
                    data_type=AudioDataType.FLOAT32,
                )
                # Add audio data to buffer
                self._buffer_service.add_to_buffer(audio_data_for_buffer)
                buffer_updated = True
                if not buffer_updated:
                    warning_message = "Failed to update audio buffer"
                    self._logger_service.log_warning(warning_message)
            except Exception as e:
                warning_message = f"Error updating buffer: {e!s}"
                self._logger_service.log_warning("Buffer update error", error=str(e))

            # Phase 6: Emit signals if configured
            signal_emitted = False
            if request.configuration.emit_processed_data:
                self._logger_service.log_debug(
                    "Emitting processed data signal",
                    phase=ProcessingPhase.EMITTING_SIGNAL.value,
                )

                if request.progress_callback:
                    request.progress_callback("Emitting signals...", 90.0)

                try:
                    # Use provided callback or emit through service
                    if request.data_ready_callback:
                        request.data_ready_callback(normalized_data)
                        signal_emitted = True
                    else:
                        # Convert numpy data to AudioSampleData for signal emission
                        audio_data_for_signal = AudioSampleData(
                            samples=normalized_data.tolist(),
                            sample_rate=SampleRate(16000),  # Default rate, should come from request
                            channels=1,
                            data_type=AudioDataType.FLOAT32,
                        )
                        self._signal_service.emit_data_ready(audio_data_for_signal)
                        signal_emitted = True

                    # Also emit buffer update if buffer was updated
                    if buffer_updated:
                        buffer_data = self._buffer_service.get_buffer_data()
                        buffer_info = {"size": self._buffer_service.get_buffer_size()}
                        # Emit buffer update signal with metadata
                        if buffer_data:
                            self._signal_service.emit_data_processed(buffer_data, buffer_info)

                except Exception as e:
                    warning_message = f"Error emitting signals: {e!s}"
                    self._logger_service.log_warning("Signal emission error", error=str(e))

            # Phase 7: Complete processing
            processing_time = time.time() - start_time

            if request.progress_callback:
                request.progress_callback("Processing completed!", 100.0)

            if request.completion_callback:
                request.completion_callback(ProcessingResult.SUCCESS)

            # Create processed data result
            processed_data = ProcessedAudioData(
                normalized_data=normalized_data,
                original_shape=original_shape,
                rms_value=original_rms,
                peak_value=original_peak,
                data_range=original_range,
                processing_time=processing_time,
                buffer_updated=buffer_updated,
            )

            self._logger_service.log_debug(
                "Audio data processing completed",
                phase=ProcessingPhase.COMPLETING.value,
                processing_time=processing_time,
                data_shape=numpy_data.shape,
                rms_value=original_rms,
                peak_value=original_peak,
            )

            return ProcessAudioDataResponse(
                result=ProcessingResult.SUCCESS,
                processed_data=processed_data,
                buffer_size=self._buffer_service.get_buffer_size(),
                signal_emitted=signal_emitted,
                processing_time=processing_time,
            )

        except Exception as e:
            error_message = f"Error processing audio data: {e!s}"

            self._logger_service.log_error(
                "Audio data processing failed",
                phase=ProcessingPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            return ProcessAudioDataResponse(
                result=ProcessingResult.FAILURE,
                processing_time=time.time() - start_time,
                error_message=error_message,
            )