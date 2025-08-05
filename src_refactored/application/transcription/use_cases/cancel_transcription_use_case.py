"""Cancel transcription use case.

This module contains the use case for cancelling ongoing transcriptions.
"""

from dataclasses import dataclass

from ....domain.common.abstractions import UseCase
from ....domain.common.result import Result
from ....domain.transcription.entities import TranscriptionSession
from ....domain.transcription.value_objects import TranscriptionState


@dataclass
class CancelTranscriptionRequest:
    """Request for cancelling transcription."""

    transcription_id: str | None = None
    session_id: str | None = None
    force_cancel: bool = False
    cleanup_resources: bool = True
    reason: str | None = None


@dataclass
class CancelTranscriptionResponse:
    """Response for cancelling transcription."""

    success: bool
    transcription_id: str | None = None
    was_processing: bool = False
    cleanup_completed: bool = False
    partial_result_available: bool = False
    error_message: str | None = None


class CancelTranscriptionUseCase(UseCase[CancelTranscriptionRequest, CancelTranscriptionResponse]):
    """Use case for cancelling ongoing transcriptions.
    
    This use case handles the cancellation of transcription processes,
    including cleanup of resources and preservation of partial results.
    """

    def __init__(
        self,
        transcription_session: TranscriptionSession,
        model_service=None,
        progress_callback_service=None,
        cleanup_service=None,
    ):
        """Initialize the cancel transcription use case.
        
        Args:
            transcription_session: The transcription session entity
            model_service: Optional service for model management
            progress_callback_service: Optional service for progress updates
            cleanup_service: Optional service for resource cleanup
        """
        self._transcription_session = transcription_session
        self._model_service = model_service
        self._progress_callback_service = progress_callback_service
        self._cleanup_service = cleanup_service

    def execute(self, request: CancelTranscriptionRequest,
    ) -> Result[CancelTranscriptionResponse]:
        """Execute the cancel transcription use case.
        
        Args:
            request: The cancel transcription request
            
        Returns:
            Result containing the cancel transcription response
        """
        try:
            # Resolve transcription ID
            transcription_id = self._resolve_transcription_id(request)
            if not transcription_id:
                return Result.failure(
                    CancelTranscriptionResponse(
                        success=False,
                        error_message="No transcription ID provided or found in session",
                    )
                    "Missing transcription ID",
                )

            # Get current transcription state
            current_result = self._transcription_session.get_transcription_result(transcription_id)
            if current_result.is_failure():
                return Result.failure(
                    CancelTranscriptionResponse(
                        success=False,
                        transcription_id=transcription_id,
                        error_message=f"Failed to get transcription state: {current_result.error}",
                    )
                    current_result.error,
                )

            transcription_result = current_result.value
            was_processing = transcription_result.state == TranscriptionState.PROCESSING

            # Check if cancellation is possible
            if not self._can_cancel_transcription(transcription_result, request.force_cancel):
                state_name = transcription_result.state.value if hasattr(transcription_result.state,
                "value") else str(transcription_result.state)
                return Result.failure(
                    CancelTranscriptionResponse(
                        success=False,
                        transcription_id=transcription_id,
                        was_processing=was_processing,
                        error_message=f"Cannot cancel transcription in state: {state_name}",
                    )
                    f"Transcription not cancellable in state: {state_name}",
                )

            # Stop model processing if available and transcription is processing
            if was_processing and self._model_service:
                try:
                    stop_result = self._model_service.stop_transcription(transcription_id)
                    if stop_result.is_failure(,
    ) and not request.force_cancel:
                        return Result.failure(
                            CancelTranscriptionResponse(
                                success=False,
                                transcription_id=transcription_id,
                                was_processing=was_processing,
error_message = (
    f"Failed to stop model processing: {stop_result.error}",),
                            )
                            stop_result.error,
                        )
                except Exception as e:
                    if not request.force_cancel:
                        return Result.failure(
                            CancelTranscriptionResponse(
                                success=False,
                                transcription_id=transcription_id,
                                was_processing=was_processing,
                                error_message=f"Error stopping model processing: {e!s}",
                            )
                            f"Model stop error: {e!s}",
                        )

            # Check for partial results before cancellation
            partial_result_available = self._check_partial_result_availability(
                transcription_result,
            )

            # Cancel transcription in session
            cancel_reason = request.reason or "User requested cancellation"
            cancel_result = self._transcription_session.cancel_transcription(
                transcription_id, cancel_reason,
            )

            if cancel_result.is_failure():
                return Result.failure(
                    CancelTranscriptionResponse(
                        success=False,
                        transcription_id=transcription_id,
                        was_processing=was_processing,
                        partial_result_available=partial_result_available,
                        error_message=f"Failed to cancel transcription: {cancel_result.error}",
                    )
                    cancel_result.error,
                )

            # Perform cleanup if requested
            cleanup_completed = False
            if request.cleanup_resources:
                cleanup_completed = self._perform_cleanup(
                    transcription_id,
                    preserve_partial_results=partial_result_available,
                )

            # Notify progress callback if available
            if self._progress_callback_service:
                try:
                    self._progress_callback_service.notify_transcription_cancelled(
                        transcription_id=transcription_id,
                        reason=cancel_reason,
                        partial_result_available=partial_result_available,
                    )
                except Exception:
                    # Notification failure shouldn't affect cancellation result
                    pass

            return Result.success(
                CancelTranscriptionResponse(
                    success=True,
                    transcription_id=transcription_id,
                    was_processing=was_processing,
                    cleanup_completed=cleanup_completed,
                    partial_result_available=partial_result_available,
                ),
            )

        except Exception as e:
            error_msg = f"Unexpected error cancelling transcription: {e!s}"
            return Result.failure(
                CancelTranscriptionResponse(
                    success=False,
                    transcription_id=request.transcription_id,
                    error_message=error_msg,
                )
                error_msg,
            )

    def _resolve_transcription_id(self, request: CancelTranscriptionRequest,
    ) -> str | None:
        """Resolve transcription ID from request or session.
        
        Args:
            request: The cancel transcription request
            
        Returns:
            The resolved transcription ID or None
        """
        if request.transcription_id:
            return request.transcription_id

        if request.session_id:
            # Get current transcription from session
            current_result = self._transcription_session.get_current_transcription()
            if current_result.is_success():
                return current_result.value.transcription_id

        # Try to get latest transcription from session
        latest_result = self._transcription_session.get_latest_transcription()
        if latest_result.is_success():
            return latest_result.value.transcription_id

        return None

    def _can_cancel_transcription(self, transcription_result, force_cancel: bool,
    ) -> bool:
        """Check if transcription can be cancelled.
        
        Args:
            transcription_result: The transcription result
            force_cancel: Whether to force cancellation
            
        Returns:
            True if transcription can be cancelled
        """
        if force_cancel:
            return True

        # Can cancel if processing or queued
        cancellable_states = {
            TranscriptionState.PROCESSING,
            TranscriptionState.QUEUED,
            TranscriptionState.INITIALIZING,
        }

        return transcription_result.state in cancellable_states

    def _check_partial_result_availability(self, transcription_result) -> bool:
        """Check if partial results are available.
        
        Args:
            transcription_result: The transcription result
            
        Returns:
            True if partial results are available
        """
        # Check if there's any text or segments available
        if transcription_result.text and transcription_result.text.strip():
            return True

        if transcription_result.segments and len(transcription_result.segments) > 0:
            return True

        # Check if processing has progressed significantly
return bool(transcription_result.state = (
    = TranscriptionState.PROCESSING and hasattr(transcription_result)
        "progress_percentage") and
    transcription_result.progress_percentage and transcription_result.progress_percentage > 10)

    def _perform_cleanup(
        self,
        transcription_id: str,
        preserve_partial_results: bool = True,
    ) -> bool:
        """Perform cleanup of transcription resources.
        
        Args:
            transcription_id: The transcription ID
            preserve_partial_results: Whether to preserve partial results
            
        Returns:
            True if cleanup completed successfully
        """
        cleanup_success = True

        # Use cleanup service if available
        if self._cleanup_service:
            try:
                cleanup_result = self._cleanup_service.cleanup_transcription(
                    transcription_id=transcription_id,
                    preserve_partial_results=preserve_partial_results,
                )
                cleanup_success = cleanup_result.is_success()
            except Exception:
                cleanup_success = False

        # Fallback cleanup operations
        if not cleanup_success:
            try:
                # Clear model resources if available
                if self._model_service:
                    self._model_service.clear_transcription_resources(transcription_id,
    )

                # Clear session temporary data
                self._transcription_session.clear_temporary_data(
                    transcription_id,
                    preserve_results=preserve_partial_results,
                )

                cleanup_success = True
            except Exception:
                cleanup_success = False

        return cleanup_success