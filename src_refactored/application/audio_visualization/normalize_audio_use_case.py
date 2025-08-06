"""Normalize Audio Use Case.

This module implements the NormalizeAudioUseCase for handling audio
normalization with various methods and progress tracking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from src_refactored.domain.audio_visualization.value_objects.normalization_types import (
    NormalizationMethod,
    NormalizationPhase,
    NormalizationResult,
    ScalingStrategy,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    import numpy as np

    from src_refactored.domain.audio_visualization.protocols import (
        AudioDataValidationServiceProtocol,
        AudioNormalizationServiceProtocol,
        AudioProcessingServiceProtocol,
        AudioStatisticsServiceProtocol,
        LoggerServiceProtocol,
    )


@dataclass
class NormalizationConfiguration:
    """Configuration for audio normalization."""
    method: NormalizationMethod = NormalizationMethod.SPEECH_OPTIMIZED
    scaling_strategy: ScalingStrategy = ScalingStrategy.FIXED_FACTOR
    scaling_factor: float = 0.3
    target_rms: float = 0.1
    target_peak: float = 1.0
    enable_clipping: bool = True
    enable_centering: bool = True
    clip_threshold: float = 1.0
    rms_threshold: float = 1e-6
    preserve_dynamic_range: bool = True
    validate_input: bool = True


@dataclass
class NormalizeAudioRequest:
    """Request for normalizing audio data."""
    audio_data: np.ndarray
    configuration: NormalizationConfiguration
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[NormalizationResult], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class AudioStatistics:
    """Statistics about audio data."""
    original_rms: float
    original_peak: float
    original_range: tuple[float, float]
    original_mean: float
    original_std: float
    normalized_rms: float
    normalized_peak: float
    normalized_range: tuple[float, float]
    scaling_applied: float
    clipping_occurred: bool
    centering_applied: bool


@dataclass
class NormalizeAudioResponse:
    """Response from normalizing audio data."""
    result: NormalizationResult
    normalized_data: np.ndarray | None = None
    statistics: AudioStatistics | None = None
    processing_time: float | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


# Protocols now imported from domain layer


class NormalizeAudioUseCase:
    """Use case for normalizing audio data."""

    def __init__(
        self,
        validation_service: AudioDataValidationServiceProtocol,
        statistics_service: AudioStatisticsServiceProtocol,
        normalization_service: AudioNormalizationServiceProtocol,
        processing_service: AudioProcessingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            validation_service: Service for data validation
            statistics_service: Service for statistics calculation
            normalization_service: Service for audio normalization
            processing_service: Service for audio processing
            logger_service: Service for logging
        """
        self._validation_service = validation_service
        self._statistics_service = statistics_service
        self._normalization_service = normalization_service
        self._processing_service = processing_service
        self._logger_service = logger_service

    def execute(self, request: NormalizeAudioRequest,
    ) -> NormalizeAudioResponse:
        """Execute the normalize audio use case.
        
        Args:
            request: The normalization request
            
        Returns:
            NormalizeAudioResponse with normalization results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize normalization
            self._logger_service.log_debug(
                "Starting audio normalization",
                phase=NormalizationPhase.INITIALIZING.value,
                method=request.configuration.method.value,
                data_shape=request.audio_data.shape,
            )

            if request.progress_callback:
                request.progress_callback("Initializing normalization...", 10.0)

            # Phase 2: Validate input data if configured
            if request.configuration.validate_input:
                self._logger_service.log_debug(
                    "Validating audio data",
                    phase=NormalizationPhase.VALIDATING_DATA.value,
                )

                if request.progress_callback:
                    request.progress_callback("Validating data...", 20.0)

                if not self._validation_service.validate_audio_array(request.audio_data):
                    error_message = "Invalid audio data provided"
                    self._logger_service.log_error("Audio data validation failed")

                    if request.error_callback:
                        request.error_callback(error_message)

                    return NormalizeAudioResponse(
                        result=NormalizationResult.INVALID_DATA,
                        processing_time=time.time() - start_time,
                        error_message=error_message,
                    )

                # Check for empty data
                if len(request.audio_data) == 0:
                    error_message = "Empty audio data provided"
                    self._logger_service.log_error("Empty audio data")

                    if request.error_callback:
                        request.error_callback(error_message,
    )

                    return NormalizeAudioResponse(
                        result=NormalizationResult.EMPTY_DATA,
                        processing_time=time.time() - start_time,
                        error_message=error_message,
                    )

            # Phase 3: Calculate original statistics
            self._logger_service.log_debug(
                "Calculating original statistics",
                phase=NormalizationPhase.CALCULATING_RMS.value,
            )

            if request.progress_callback:
                request.progress_callback("Calculating statistics...", 30.0)

            try:
                original_stats = self._statistics_service.calculate_statistics(request.audio_data,
    )
                original_rms = original_stats["rms"]
                original_peak = original_stats["peak"]
                original_mean = original_stats["mean"]
                original_std = original_stats["std"]
                original_range = (original_stats["min"], original_stats["max"])

                # Check for zero RMS
                if original_rms < request.configuration.rms_threshold:
                    warning_message = f"Very low RMS value: {original_rms}"
                    self._logger_service.log_warning(warning_message)

                    if original_rms == 0.0:
                        error_message = "Zero RMS - cannot normalize silent audio"
                        self._logger_service.log_error(error_message)

                        if request.error_callback:
                            request.error_callback(error_message,
    )

                        return NormalizeAudioResponse(
                            result=NormalizationResult.ZERO_RMS,
                            processing_time=time.time() - start_time,
                            error_message=error_message,
                        )

            except Exception as e:
                error_message = f"Failed to calculate statistics: {e!s}"
                self._logger_service.log_error("Statistics calculation failed", error=str(e))

                if request.error_callback:
                    request.error_callback(error_message)

                return NormalizeAudioResponse(
                    result=NormalizationResult.CALCULATION_ERROR,
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 4: Apply normalization based on method
            self._logger_service.log_debug(
                "Applying normalization",
                phase=NormalizationPhase.APPLYING_SCALING.value,
                method=request.configuration.method.value,
            )

            if request.progress_callback:
                request.progress_callback("Applying normalization...", 50.0)

            try:
                if request.configuration.method == NormalizationMethod.SPEECH_OPTIMIZED:
                    normalized_data = self._normalization_service.normalize_for_speech(
                        request.audio_data, request.configuration.scaling_factor,
                    )
                    scaling_applied = request.configuration.scaling_factor

                elif request.configuration.method == NormalizationMethod.RMS_BASED:
                    normalized_data = self._normalization_service.normalize_rms_based(
                        request.audio_data, request.configuration.target_rms, original_rms,
                    )
                    scaling_applied = (
                        request.configuration.target_rms / original_rms if original_rms > 0 else 0.0)

                elif request.configuration.method == NormalizationMethod.PEAK_BASED:
                    normalized_data = self._normalization_service.normalize_peak_based(
                        request.audio_data, request.configuration.target_peak, original_peak,
                    )
                    scaling_applied = (
                        request.configuration.target_peak / original_peak if original_peak > 0 else 0.0)

                elif request.configuration.method == NormalizationMethod.Z_SCORE:
                    normalized_data = self._normalization_service.apply_z_score_normalization(
                        request.audio_data,
                    )
                    scaling_applied = 1.0 / original_std if original_std > 0 else 0.0

                elif request.configuration.method == NormalizationMethod.MIN_MAX:
                    normalized_data = self._normalization_service.apply_min_max_normalization(
                        request.audio_data, -1.0, 1.0,
                    )
                    data_range = original_range[1] - original_range[0]
                    scaling_applied = 2.0 / data_range if data_range > 0 else 0.0

                else:
                    # Default to speech optimized
                    normalized_data = self._normalization_service.normalize_for_speech(
                        request.audio_data, request.configuration.scaling_factor,
                    )
                    scaling_applied = request.configuration.scaling_factor

            except Exception as e:
                error_message = f"Failed to apply normalization: {e!s}"
                self._logger_service.log_error("Normalization failed", error=str(e))

                if request.error_callback:
                    request.error_callback(error_message)

                return NormalizeAudioResponse(
                    result=NormalizationResult.FAILURE,
                    processing_time=time.time() - start_time,
                    error_message=error_message,
                )

            # Phase 5: Apply clipping if enabled
            clipping_occurred = False
            if request.configuration.enable_clipping:
                self._logger_service.log_debug(
                    "Applying clipping",
                    phase=NormalizationPhase.APPLYING_CLIPPING.value,
                )

                if request.progress_callback:
                    request.progress_callback("Applying clipping...", 70.0)

                normalized_data, clipping_occurred = self._processing_service.apply_clipping(
                    normalized_data, request.configuration.clip_threshold,
                )

                if clipping_occurred:
                    self._logger_service.log_debug("Clipping was applied to audio data")

            # Phase 6: Apply centering if enabled
            centering_applied = False
            if request.configuration.enable_centering:
                self._logger_service.log_debug(
                    "Centering data",
                    phase=NormalizationPhase.CENTERING_DATA.value,
                )

                if request.progress_callback:
                    request.progress_callback("Centering data...", 80.0)

                normalized_data = self._processing_service.center_data(normalized_data)
                centering_applied = True

            # Phase 7: Calculate final statistics
            if request.progress_callback:
                request.progress_callback("Calculating final statistics...", 90.0)

            final_stats = self._statistics_service.calculate_statistics(normalized_data)
            normalized_rms = final_stats["rms"]
            normalized_peak = final_stats["peak"]
            normalized_range = (final_stats["min"], final_stats["max"])

            # Phase 8: Complete normalization
            processing_time = time.time() - start_time

            if request.progress_callback:
                request.progress_callback("Normalization completed!", 100.0)

            if request.completion_callback:
                request.completion_callback(NormalizationResult.SUCCESS)

            # Create statistics object
            statistics = AudioStatistics(
                original_rms=original_rms,
                original_peak=original_peak,
                original_range=original_range,
                original_mean=original_mean,
                original_std=original_std,
                normalized_rms=normalized_rms,
                normalized_peak=normalized_peak,
                normalized_range=normalized_range,
                scaling_applied=scaling_applied,
                clipping_occurred=clipping_occurred,
                centering_applied=centering_applied,
            )

            self._logger_service.log_debug(
                "Audio normalization completed",
                phase=NormalizationPhase.COMPLETING.value,
                processing_time=processing_time,
                method=request.configuration.method.value,
                original_rms=original_rms,
                normalized_rms=normalized_rms,
                scaling_applied=scaling_applied,
                clipping_occurred=clipping_occurred,
            )

            return NormalizeAudioResponse(
                result=NormalizationResult.SUCCESS,
                normalized_data=normalized_data,
                statistics=statistics,
                processing_time=processing_time,
            )

        except Exception as e:
            error_message = f"Error normalizing audio: {e!s}"

            self._logger_service.log_error(
                "Audio normalization failed",
                phase=NormalizationPhase.ERROR_HANDLING.value,
                error=str(e),
            )

            if request.error_callback:
                request.error_callback(error_message)

            return NormalizeAudioResponse(
                result=NormalizationResult.FAILURE,
                processing_time=time.time() - start_time,
                error_message=error_message,
            )