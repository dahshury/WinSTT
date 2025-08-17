"""Get recording status use case.

This module contains the use case for retrieving audio recording status.
"""

import time
from dataclasses import dataclass

from src.domain.audio.entities import AudioRecorder, AudioRecorderConfiguration
from src.domain.audio.value_objects import RecordingState
from src.domain.audio.value_objects.duration import Duration
from src.domain.audio.value_objects.status_metrics import RecordingMetrics
from src.domain.common.abstractions import UseCase


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

            # Convert entity RecordingState to value object RecordingState if needed
            from src.domain.audio.value_objects.recording_state import (
                RecordingState as VoRecordingState,
            )
            
            value_object_state = None
            if state is not None:
                # Map entity state to value object state
                state_mapping = {
                    "idle": VoRecordingState.IDLE,
                    "recording": VoRecordingState.RECORDING,
                    "paused": VoRecordingState.PAUSED,
                    "stopped": VoRecordingState.STOPPED,
                }
                value_object_state = state_mapping.get(state.value, VoRecordingState.IDLE)

            return GetRecordingStatusResponse(
                success=True,
                state=value_object_state,
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

            # Create duration object, defaulting to minimum if None or invalid
            total_duration = Duration(max(duration or 0.1, 0.1))
            
            return RecordingMetrics(
                total_duration=total_duration,
                total_frames=sample_count or 0,
                peak_level=peak_amplitude or 0.0,
                average_level=average_amplitude or 0.0,
                file_size_bytes=data_size or 0,
            )

        except Exception:
            # Return empty metrics on error
            return RecordingMetrics(total_duration=Duration(0.1))