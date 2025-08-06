"""Get transcription history use case.

This module contains the use case for retrieving transcription history.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from src_refactored.domain.common.abstractions import UseCase
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.entities.transcription_session import TranscriptionSession
from src_refactored.domain.transcription.value_objects.transcription_operations import (
    FilterCriteria,
    SortOrder,
)
from src_refactored.domain.transcription.value_objects.transcription_result import (
    TranscriptionResult,
)
from src_refactored.domain.transcription.value_objects.transcription_state import TranscriptionState


@dataclass
class TranscriptionHistoryItem:
    """Represents a transcription history item."""

    transcription_id: str
    session_id: str
    text: str
    language: str | None
    confidence: float
    duration_seconds: float
    processing_time: float
    state: TranscriptionState
    created_at: datetime
    completed_at: datetime | None
    model_type: str | None
    model_size: str | None
    word_count: int
    character_count: int
    has_segments: bool
    error_message: str | None = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class HistoryStatistics:
    """Statistics about transcription history."""

    total_transcriptions: int
    completed_transcriptions: int
    failed_transcriptions: int
    cancelled_transcriptions: int
    total_audio_duration: float
    total_processing_time: float
    average_confidence: float
    average_processing_speed: float  # audio_duration / processing_time
    most_used_language: str | None
    most_used_model: str | None
    success_rate: float
    total_words: int
    total_characters: int


@dataclass
class GetTranscriptionHistoryRequest:
    """Request for getting transcription history."""

    session_id: str | None = None
    limit: int = 50
    offset: int = 0
    sort_order: SortOrder = SortOrder.NEWEST_FIRST
    filter_criteria: list[FilterCriteria] | None = None
    date_from: datetime | None = None
    date_to: datetime | None = None
    search_text: str | None = None
    min_confidence: float | None = None
    max_confidence: float | None = None
    min_duration: float | None = None
    max_duration: float | None = None
    languages: list[str] | None = None
    states: list[TranscriptionState] | None = None
    include_segments: bool = False
    include_metadata: bool = False
    include_statistics: bool = False


@dataclass
class GetTranscriptionHistoryResponse:
    """Response for getting transcription history."""

    success: bool
    items: list[TranscriptionHistoryItem]
    total_count: int
    has_more: bool
    statistics: HistoryStatistics | None = None
    error_message: str | None = None


class GetTranscriptionHistoryUseCase(UseCase[GetTranscriptionHistoryRequest, GetTranscriptionHistoryResponse]):
    """Use case for retrieving transcription history.
    
    This use case handles retrieving and filtering transcription history,
    including search, sorting, pagination, and statistics.
    """

    def __init__(
        self,
        transcription_session: TranscriptionSession,
        history_service=None,
        search_service=None,
        statistics_service=None,
    ):
        """Initialize the get transcription history use case.
        
        Args:
            transcription_session: The transcription session entity
            history_service: Optional service for history management
            search_service: Optional service for text search
            statistics_service: Optional service for statistics calculation
        """
        self._transcription_session = transcription_session
        self._history_service = history_service
        self._search_service = search_service
        self._statistics_service = statistics_service

    def execute(self, request: GetTranscriptionHistoryRequest,
    ) -> Result[GetTranscriptionHistoryResponse]:
        """Execute the get transcription history use case.
        
        Args:
            request: The get transcription history request
            
        Returns:
            Result containing the transcription history response
        """
        try:
            # Get raw transcription history
            history_result = self._get_raw_history(request)
            if history_result.is_failure():
                return Result.failure(f"Failed to retrieve history: {history_result.error}")

            raw_history = history_result.value

            # Apply filters
            filtered_history = self._apply_filters(raw_history, request)

            # Apply search if specified
            if request.search_text:
                filtered_history = self._apply_search(filtered_history, request.search_text)

            # Apply sorting
            sorted_history = self._apply_sorting(filtered_history, request.sort_order)

            # Calculate total count before pagination
            total_count = len(sorted_history)

            # Apply pagination
            paginated_history = self._apply_pagination(
                sorted_history, request.limit, request.offset,
            )

            # Convert to history items
            history_items = self._convert_to_history_items(
                paginated_history, request,
            )

            # Calculate statistics if requested
            statistics = None
            if request.include_statistics:
                statistics = self._calculate_statistics(filtered_history)

            # Determine if there are more items
            has_more = (request.offset + len(history_items)
    ) < total_count

            return Result.success(
                GetTranscriptionHistoryResponse(
                    success=True,
                    items=history_items,
                    total_count=total_count,
                    has_more=has_more,
                    statistics=statistics,
                ),
            )

        except Exception as e:
            error_msg = f"Unexpected error retrieving transcription history: {e!s}"
            return Result.failure(error_msg)

    def _get_raw_history(self, request: GetTranscriptionHistoryRequest,
    ) -> Result[list[TranscriptionResult]]:
        """Get raw transcription history.
        
        Args:
            request: The history request
            
        Returns:
            Result containing list of transcription results
        """
        try:
            # Use history service if available
            if self._history_service:
                return self._history_service.get_transcription_history(
                    session_id=request.session_id,
                    date_from=request.date_from,
                    date_to=request.date_to,
                )

            # Fallback to session history
            if request.session_id:
                session_history = self._transcription_session.get_session_history(request.session_id)
            else:
                session_history = self._transcription_session.get_all_history()

            if session_history.is_failure():
                return session_history

            return Result.success(session_history.value)

        except Exception as e:
            return Result.failure(f"Error retrieving raw history: {e!s}",
    )

    def _apply_filters(
        self,
        history: list[TranscriptionResult],
        request: GetTranscriptionHistoryRequest,
    ) -> list[TranscriptionResult]:
        """Apply filters to transcription history.

        Args:
            history: List of transcription results
            request: The history request

        Returns:
            Filtered list of transcription results
        """
        filtered = history

        # Apply filter criteria
        if request.filter_criteria:
            for criteria in request.filter_criteria:
                filtered = self._apply_single_filter(filtered, criteria)

        # Apply date range filters
        if request.date_from:
            filtered = [item for item in filtered if item.created_at >= request.date_from]

        if request.date_to:
            filtered = [item for item in filtered if item.created_at <= request.date_to]

        # Apply confidence filters
        if request.min_confidence is not None:
            filtered = [item for item in filtered if item.confidence >= request.min_confidence]

        if request.max_confidence is not None:
            filtered = [item for item in filtered if item.confidence <= request.max_confidence]

        # Apply duration filters
        if request.min_duration is not None:
            filtered = [item for item in filtered
                       if hasattr(item, "duration_seconds") and 
                       isinstance(getattr(item, "duration_seconds", 0), int | float) and
                       getattr(item, "duration_seconds", 0) >= request.min_duration]

        if request.max_duration is not None:
            filtered = [item for item in filtered
                       if hasattr(item, "duration_seconds") and 
                       isinstance(getattr(item, "duration_seconds", 0), int | float) and
                       getattr(item, "duration_seconds", 0) <= request.max_duration]

        # Apply language filters
        if request.languages:
            filtered = [item for item in filtered
                       if item.language and item.language in request.languages]

        # Apply state filters
        if request.states:
            filtered = [item for item in filtered if item.state in request.states]

        return filtered

    def _apply_single_filter(
        self,
        history: list[TranscriptionResult],
        criteria: FilterCriteria,
    ) -> list[TranscriptionResult]:
        """Apply a single filter criteria.

        Args:
            history: List of transcription results
            criteria: Filter criteria to apply

        Returns:
            Filtered list of transcription results
        """
        if criteria == FilterCriteria.ALL:
            return history

        if criteria == FilterCriteria.COMPLETED:
            return [item for item in history if item.state == TranscriptionState.COMPLETED]

        if criteria == FilterCriteria.FAILED:
            return [item for item in history if item.state == TranscriptionState.FAILED]

        if criteria == FilterCriteria.PROCESSING:
            return [item for item in history if item.state == TranscriptionState.PROCESSING]

        if criteria == FilterCriteria.CANCELLED:
            return [item for item in history if item.state == TranscriptionState.CANCELLED]

        if criteria == FilterCriteria.TODAY:
            today = datetime.now().date()
            return [item for item in history if item.created_at.date() == today]

        if criteria == FilterCriteria.LAST_WEEK:
            week_ago = datetime.now() - timedelta(days=7)
            return [item for item in history if item.created_at >= week_ago]

        if criteria == FilterCriteria.LAST_MONTH:
            month_ago = datetime.now() - timedelta(days=30)
            return [item for item in history if item.created_at >= month_ago]

        if criteria == FilterCriteria.HIGH_CONFIDENCE:
            return [item for item in history if item.confidence >= 0.8]

        if criteria == FilterCriteria.LOW_CONFIDENCE:
            return [item for item in history if item.confidence < 0.6]

        return history

    def _apply_search(
        self,
        history: list[TranscriptionResult],
        search_text: str,
    ) -> list[TranscriptionResult]:
        """Apply text search to transcription history.

        Args:
            history: List of transcription results
            search_text: Text to search for

        Returns:
            Filtered list of transcription results
        """
        if not search_text:
            return history

        search_lower = search_text.lower()

        # Use search service if available
        if self._search_service:
            try:
                search_result = self._search_service.search_transcriptions(history, search_text)
                if search_result.is_success():
                    return search_result.value
            except Exception:
                pass

        # Fallback to simple text search
        filtered = []
        for item in history:
            if (item.text and search_lower in item.text.lower()) or \
               (item.transcription_id and search_lower in item.transcription_id.lower()):
                filtered.append(item)

        return filtered

    def _apply_sorting(
        self,
        history: list[TranscriptionResult],
        sort_order: SortOrder,
    ) -> list[TranscriptionResult]:
        """Apply sorting to transcription history.

        Args:
            history: List of transcription results
            sort_order: Sort order to apply

        Returns:
            Sorted list of transcription results
        """
        if sort_order == SortOrder.NEWEST_FIRST:
            return sorted(history, key=lambda x: x.created_at, reverse=True)

        if sort_order == SortOrder.OLDEST_FIRST:
            return sorted(history, key=lambda x: x.created_at)

        if sort_order == SortOrder.DURATION_DESC:
            return sorted(history,
                         key=lambda x: getattr(x, "duration_seconds", 0),
                         reverse=True)

        if sort_order == SortOrder.DURATION_ASC:
            return sorted(history,
                         key=lambda x: getattr(x, "duration_seconds", 0))

        if sort_order == SortOrder.CONFIDENCE_DESC:
            return sorted(history, key=lambda x: x.confidence, reverse=True)

        if sort_order == SortOrder.CONFIDENCE_ASC:
            return sorted(history, key=lambda x: x.confidence)

        return history

    def _apply_pagination(
        self,
        history: list[TranscriptionResult],
        limit: int,
        offset: int,
    ) -> list[TranscriptionResult]:
        """Apply pagination to transcription history.

        Args:
            history: List of transcription results
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            Paginated list of transcription results
        """
        return history[offset:offset + limit]

    def _convert_to_history_items(
        self,
        history: list[TranscriptionResult],
        request: GetTranscriptionHistoryRequest,
    ) -> list[TranscriptionHistoryItem]:
        """Convert transcription results to history items.

        Args:
            history: List of transcription results
            request: The history request

        Returns:
            List of transcription history items
        """
        items = []

        for result in history:
            # Calculate word and character counts
            text = result.text or ""
            word_count = len(text.split()) if text else 0
            character_count = len(text)

            # Check if segments are available
            has_segments = bool(result.segments and len(result.segments) > 0)

            # Get model information
            model_type = None
            model_size = None
            if hasattr(result, "model_configuration") and result.model_configuration:
                try:
                    model_config = result.model_configuration
                    if hasattr(model_config, "model_type"):
                        model_type = str(model_config.model_type)
                    if hasattr(model_config, "model_size"):
                        model_size = str(model_config.model_size)
                except (AttributeError, TypeError):
                    pass

            # Get duration
            duration_seconds = getattr(result, "duration_seconds", 0.0)

            # Convert string state to TranscriptionState enum
            try:
                state = TranscriptionState(result.state)
            except ValueError:
                # Fallback to IDLE if state is unknown
                state = TranscriptionState.IDLE

            # Create history item
            item = TranscriptionHistoryItem(
                transcription_id=result.transcription_id,
                session_id=getattr(result, "session_id", ""),
                text=text,
                language=result.language,
                confidence=result.confidence,
                duration_seconds=duration_seconds,
                processing_time=result.processing_time,
                state=state,
                created_at=result.created_at,
                completed_at=result.completed_at,
                model_type=model_type,
                model_size=model_size,
                word_count=word_count,
                character_count=character_count,
                has_segments=has_segments,
                error_message=result.error_message,
            )

            # Add metadata if requested
            if request.include_metadata:
                item.metadata = getattr(result, "metadata", {})

            items.append(item)

        return items

    def _calculate_statistics(self, history: list[TranscriptionResult]) -> HistoryStatistics:
        """Calculate statistics for transcription history.

        Args:
            history: List of transcription results

        Returns:
            History statistics
        """
        if not history:
            return HistoryStatistics(
                total_transcriptions=0,
                completed_transcriptions=0,
                failed_transcriptions=0,
                cancelled_transcriptions=0,
                total_audio_duration=0.0,
                total_processing_time=0.0,
                average_confidence=0.0,
                average_processing_speed=0.0,
                most_used_language=None,
                most_used_model=None,
                success_rate=0.0,
                total_words=0,
                total_characters=0,
            )

        # Use statistics service if available
        if self._statistics_service:
            try:
                stats_result = self._statistics_service.calculate_history_statistics(history)
                if stats_result.is_success():
                    return stats_result.value
            except Exception:
                pass

        # Calculate basic statistics
        total_transcriptions = len(history)
        completed = [item for item in history if item.state == TranscriptionState.COMPLETED]
        failed = [item for item in history if item.state == TranscriptionState.FAILED]
        cancelled = [item for item in history if item.state == TranscriptionState.CANCELLED]

        completed_transcriptions = len(completed)
        failed_transcriptions = len(failed)
        cancelled_transcriptions = len(cancelled)

        # Calculate durations and processing times
        total_audio_duration = sum(getattr(item, "duration_seconds", 0) for item in history)
        total_processing_time = sum(item.processing_time for item in history)

        # Calculate average confidence
        confidences = [item.confidence for item in completed if item.confidence > 0]
        average_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        # Calculate processing speed
        valid_speeds = []
        for item in completed:
            duration = getattr(item, "duration_seconds", 0)
            if duration > 0 and item.processing_time > 0:
                valid_speeds.append(duration / item.processing_time)

        average_processing_speed = sum(valid_speeds) / len(valid_speeds) if valid_speeds else 0.0

        # Find most used language
        languages = [item.language for item in history if item.language]
        most_used_language = max(set(languages), key=languages.count) if languages else None

        # Find most used model (simplified)
        models = []
        for item in history:
            if hasattr(item, "model_configuration") and item.model_configuration:
                try:
                    model_config = item.model_configuration
                    if hasattr(model_config, "model_type") and hasattr(model_config, "model_size"):
                        model_name = f"{model_config.model_type}_{model_config.model_size}"
                        models.append(model_name)
                except (AttributeError, TypeError):
                    pass

        most_used_model = max(set(models), key=models.count) if models else None

        # Calculate success rate
        success_rate = completed_transcriptions / total_transcriptions if total_transcriptions > 0 else 0.0

        # Calculate word and character counts
        total_words = sum(len((item.text or "").split()) for item in completed)
        total_characters = sum(len(item.text or "") for item in completed)

        return HistoryStatistics(
            total_transcriptions=total_transcriptions,
            completed_transcriptions=completed_transcriptions,
            failed_transcriptions=failed_transcriptions,
            cancelled_transcriptions=cancelled_transcriptions,
            total_audio_duration=total_audio_duration,
            total_processing_time=total_processing_time,
            average_confidence=average_confidence,
            average_processing_speed=average_processing_speed,
            most_used_language=most_used_language,
            most_used_model=most_used_model,
            success_rate=success_rate,
            total_words=total_words,
            total_characters=total_characters,
        )