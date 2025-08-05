"""Get transcription result use case.

This module contains the use case for retrieving transcription results.
"""

from dataclasses import dataclass
from datetime import datetime

from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result
from ....domain.transcription.entities import TranscriptionSession
from ....domain.transcription.value_objects import (
    TranscriptionResult,
    TranscriptionSegment,
    TranscriptionState,
)


@dataclass
class TranscriptionResultData:
    """Data structure for transcription result."""

    transcription_id: str
    text: str
    language: str | None
    confidence: float
    processing_time: float
    segments: list[TranscriptionSegment]
    created_at: datetime
    completed_at: datetime | None
    state: TranscriptionState
    error_message: str | None = None


@dataclass
class GetTranscriptionResultRequest:
    """Request for getting transcription result."""

    transcription_id: str | None = None
    session_id: str | None = None
    include_segments: bool = True
    include_metadata: bool = True
    wait_for_completion: bool = False
    timeout_seconds: float = 30.0


@dataclass
class GetTranscriptionResultResponse:
    """Response for getting transcription result."""

    success: bool
    result: TranscriptionResultData | None = None
    is_processing: bool = False
    progress_percentage: float | None = None
    estimated_time_remaining: float | None = None
    error_message: str | None = None


class GetTranscriptionResultUseCase(UseCase[GetTranscriptionResultRequest, GetTranscriptionResultResponse]):
    """Use case for retrieving transcription results.
    
    This use case handles retrieving transcription results, including completed results,
    in-progress status, and error information.
    """

    def __init__(
        self,
        transcription_session: TranscriptionSession,
        progress_service=None,
        cache_service=None,
    ):
        """Initialize the get transcription result use case.
        
        Args:
            transcription_session: The transcription session entity
            progress_service: Optional service for progress tracking
            cache_service: Optional service for result caching
        """
        self._transcription_session = transcription_session
        self._progress_service = progress_service
        self._cache_service = cache_service

    def execute(self, request: GetTranscriptionResultRequest,
    ) -> Result[GetTranscriptionResultResponse]:
        """Execute the get transcription result use case.
        
        Args:
            request: The get transcription result request
            
        Returns:
            Result containing the transcription result response
        """
        try:
            # Determine transcription ID
            transcription_id = self._resolve_transcription_id(request)
            if not transcription_id:
                return Result.failure(
                    GetTranscriptionResultResponse(
                        success=False,
                        error_message="No transcription ID provided or found in session",
                    )
                    "Missing transcription ID",
                )

            # Check cache first if available
            if self._cache_service and not request.wait_for_completion:
                cached_result = self._cache_service.get_transcription_result(transcription_id,
    )
                if cached_result:
                    return Result.success(
                        GetTranscriptionResultResponse(
                            success=True,
                            result=self._convert_to_result_data(cached_result, request),
                        ),
                    )

            # Get transcription result from session
            result_response = self._transcription_session.get_transcription_result(transcription_id)

            if result_response.is_failure():
                return Result.failure(
                    GetTranscriptionResultResponse(
                        success=False,
                        error_message=f"Failed to retrieve transcription: {result_response.error}",
                    )
                    result_response.error,
                )

            transcription_result = result_response.value

            # Handle different transcription states
            if transcription_result.state == TranscriptionState.PROCESSING:
                return self._handle_processing_state(transcription_result, request)

            if transcription_result.state == TranscriptionState.COMPLETED:
                return self._handle_completed_state(transcription_result, request)

            if transcription_result.state == TranscriptionState.FAILED:
                return self._handle_failed_state(transcription_result, request)

            if transcription_result.state == TranscriptionState.CANCELLED:
                return Result.success(
                    GetTranscriptionResultResponse(
                        success=True,
                        result=self._convert_to_result_data(transcription_result, request)
                        error_message="Transcription was cancelled",
                    ),
                )

            return Result.failure(
                GetTranscriptionResultResponse(
                    success=False,
                    error_message=f"Unknown transcription state: {transcription_result.state}",
                )
                f"Unknown state: {transcription_result.state}",
            )

        except Exception as e:
            error_msg = f"Unexpected error retrieving transcription result: {e!s}"
            return Result.failure(
                GetTranscriptionResultResponse(
                    success=False,
                    error_message=error_msg,
                )
                error_msg,
            )

    def _resolve_transcription_id(self, request: GetTranscriptionResultRequest,
    ) -> str | None:
        """Resolve transcription ID from request or session.
        
        Args:
            request: The get transcription result request
            
        Returns:
            The resolved transcription ID or None
        """
        if request.transcription_id:
            return request.transcription_id

        if request.session_id:
            # Get latest transcription from session
            latest_result = self._transcription_session.get_latest_transcription()
            if latest_result.is_success():
                return latest_result.value.transcription_id

        # Try to get current transcription from session
        current_result = self._transcription_session.get_current_transcription()
        if current_result.is_success():
            return current_result.value.transcription_id

        return None

    def _handle_processing_state(
        self,
        transcription_result: TranscriptionResult,
        request: GetTranscriptionResultRequest,
    ) -> Result[GetTranscriptionResultResponse]:
        """Handle transcription in processing state.
        
        Args:
            transcription_result: The transcription result
            request: The original request
            
        Returns:
            Result with processing status information
        """
        progress_percentage = None
        estimated_time_remaining = None

        # Get progress information if service available
        if self._progress_service:
            try:
                progress_info = self._progress_service.get_transcription_progress(
                    transcription_result.transcription_id,
                )
                if progress_info:
                    progress_percentage = progress_info.percentage
                    estimated_time_remaining = progress_info.estimated_time_remaining
            except Exception:
                # Progress service failure shouldn't affect main result
                pass

        # Handle wait for completion
        if request.wait_for_completion:
            return self._wait_for_completion(transcription_result, request)

        return Result.success(
            GetTranscriptionResultResponse(
                success=True,
                result=self._convert_to_result_data(transcription_result, request)
                is_processing=True,
                progress_percentage=progress_percentage,
                estimated_time_remaining=estimated_time_remaining,
            ),
        )

    def _handle_completed_state(
        self,
        transcription_result: TranscriptionResult,
        request: GetTranscriptionResultRequest,
    ) -> Result[GetTranscriptionResultResponse]:
        """Handle completed transcription.
        
        Args:
            transcription_result: The transcription result
            request: The original request
            
        Returns:
            Result with completed transcription data
        """
        result_data = self._convert_to_result_data(transcription_result, request)

        # Cache result if service available
        if self._cache_service:
            try:
                self._cache_service.cache_transcription_result(
                    transcription_result.transcription_id,
                    transcription_result,
                )
            except Exception:
                # Cache failure shouldn't affect main result
                pass

        return Result.success(
            GetTranscriptionResultResponse(
                success=True,
                result=result_data,
            ),
        )

    def _handle_failed_state(
        self,
        transcription_result: TranscriptionResult,
        request: GetTranscriptionResultRequest,
    ) -> Result[GetTranscriptionResultResponse]:
        """Handle failed transcription.
        
        Args:
            transcription_result: The transcription result
            request: The original request
            
        Returns:
            Result with failure information
        """
        return Result.success(
            GetTranscriptionResultResponse(
                success=True,
                result=self._convert_to_result_data(transcription_result, request)
                error_message=transcription_result.error_message or "Transcription failed",
            ),
        )

    def _wait_for_completion(
        self,
        transcription_result: TranscriptionResult,
        request: GetTranscriptionResultRequest,
    ) -> Result[GetTranscriptionResultResponse]:
        """Wait for transcription completion.
        
        Args:
            transcription_result: The transcription result
            request: The original request
            
        Returns:
            Result with final transcription status
        """
        import time

        start_time = time.time()
        timeout = request.timeout_seconds
        poll_interval = 0.5  # Poll every 500ms

        while time.time() - start_time < timeout:
            # Get updated result
            updated_result = self._transcription_session.get_transcription_result(
                transcription_result.transcription_id,
            )

            if updated_result.is_success():
                current_result = updated_result.value

                if current_result.state == TranscriptionState.COMPLETED:
                    return self._handle_completed_state(current_result, request)

                if current_result.state == TranscriptionState.FAILED:
                    return self._handle_failed_state(current_result, request)

                if current_result.state == TranscriptionState.CANCELLED:
                    return Result.success(
                        GetTranscriptionResultResponse(
                            success=True,
                            result=self._convert_to_result_data(current_result, request)
                            error_message="Transcription was cancelled",
                        ),
                    )

            time.sleep(poll_interval)

        # Timeout reached
        return Result.success(
            GetTranscriptionResultResponse(
                success=True,
                result=self._convert_to_result_data(transcription_result, request)
                is_processing=True,
                error_message=f"Timeout waiting for completion ({timeout}s)",
            ),
        )

    def _convert_to_result_data(
        self,
        transcription_result: TranscriptionResult,
        request: GetTranscriptionResultRequest,
    ) -> TranscriptionResultData:
        """Convert transcription result to result data.
        
        Args:
            transcription_result: The transcription result
            request: The original request
            
        Returns:
            Converted result data
        """
        segments = []
        if request.include_segments and transcription_result.segments:
            segments = transcription_result.segments

        return TranscriptionResultData(
            transcription_id=transcription_result.transcription_id,
            text=transcription_result.text or "",
            language=transcription_result.language,
            confidence=transcription_result.confidence,
            processing_time=transcription_result.processing_time,
            segments=segments,
            created_at=transcription_result.created_at,
            completed_at=transcription_result.completed_at,
            state=transcription_result.state,
            error_message=transcription_result.error_message,
        )