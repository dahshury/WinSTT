"""Get recording status use case.

This module contains the use case for retrieving audio recording status.
"""

import time
from dataclasses import dataclass

from src_refactored.domain.audio.entities import AudioRecorder, AudioRecorderConfiguration
from src_refactored.domain.audio.value_objects import RecordingState
from src_refactored.domain.audio.value_objects.status_metrics import RecordingMetrics
from src_refactored.domain.common.abstractions import UseCase


@dataclass
class GetRecordingStatusRequest:
    """Request for getting recording status."""

    include_configuration: bool = False
    include_metrics: bool = False


@dataclass
class GetRecordingStatusResponse:
    """Response for getting recording status."""

    success: bool
    state: RecordingState | None = None
    recording_id: str | None = None
    configuration: AudioRecorderConfiguration | None = None
    metrics: RecordingMetrics | None = None
    is_recording_successful: bool | None = None
    minimum_duration: float | None = None
    error_message: str | None = None


class GetRecordingStatusUseCase(UseCase[GetRecordingStatusRequest, GetRecordingStatusResponse]):
    """Use case for getting audio recording status.
    
    This use case provides comprehensive information about the current
    recording state, configuration, and metrics.
    """

    def __init__(
        self,
        audio_recorder: AudioRecorder,
        metrics_service=None,
    ):
        """Initialize the get recording status use case.
        
        Args:
            audio_recorder: The audio recorder entity
            metrics_service: Optional service for detailed metrics
        """
        self._audio_recorder = audio_recorder
        self._metrics_service = metrics_service

    def execute(self, request: GetRecordingStatusRequest,
    ) -> GetRecordingStatusResponse:
        """Execute the get recording status use case.
        
        Args:
            request: The get recording status request
            
        Returns:
            GetRecordingStatusResponse containing the recording status
        """
        try:
            # Get basic status information
            state = self._audio_recorder.get_state()
            recording_id = self._audio_recorder.get_recording_id()
            is_recording_successful = self._audio_recorder.was_recording_successful()
            minimum_duration = self._audio_recorder.get_minimum_duration()

            # Get configuration if requested
            configuration = None
            if request.include_configuration:
                configuration = self._audio_recorder.get_configuration()

            # Get metrics if requested
            metrics = None
            if request.include_metrics:
                metrics = self._get_recording_metrics()

            return GetRecordingStatusResponse(
                success=True,
                state=state,
                recording_id=recording_id,
                configuration=configuration,
                metrics=metrics,
                is_recording_successful=is_recording_successful,
                minimum_duration=minimum_duration,
            )

        except Exception as e:
            # Handle unexpected errors
            error_msg = f"Error getting recording status: {e!s}"

            return GetRecordingStatusResponse(
                success=False,
                error_message=error_msg,
            )

    def _get_recording_metrics(self) -> RecordingMetrics:
        """Get detailed recording metrics.
        
        Returns:
            RecordingMetrics object with current metrics
        """
        try:
            start_time = self._audio_recorder.get_start_time()
            duration = None

            if start_time and self._audio_recorder.get_state() == RecordingState.RECORDING:
                duration = time.time() - start_time
            elif start_time and self._audio_recorder.get_state() == RecordingState.STOPPED:
                # For stopped recordings, try to get the actual duration
                duration = self._audio_recorder.get_recording_duration()

            # Get additional metrics from metrics service if available
            data_size = None
            sample_count = None
            peak_amplitude = None
            average_amplitude = None

            if self._metrics_service:
                try:
                    detailed_metrics = self._metrics_service.get_current_metrics(
                        self._audio_recorder.get_recording_id(),
                    )

                    if detailed_metrics:
                        data_size = detailed_metrics.get("data_size")
                        sample_count = detailed_metrics.get("sample_count")
                        peak_amplitude = detailed_metrics.get("peak_amplitude")
                        average_amplitude = detailed_metrics.get("average_amplitude")

                except Exception:
                    # Metrics service failure shouldn't break status retrieval
                    pass

            return RecordingMetrics(
                duration=duration,
                start_time=start_time,
                data_size=data_size,
                sample_count=sample_count,
                peak_amplitude=peak_amplitude,
                average_amplitude=average_amplitude,
            )

        except Exception:
            # Return empty metrics on error
            return RecordingMetrics()