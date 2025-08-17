"""Get Widget State Query Handler.

This module implements the query handler for retrieving widget state information,
following CQRS pattern with read-only operations.
"""

import time
from typing import Protocol

from src.application.ui_widgets.queries.get_widget_state_query import (
    GetWidgetStateQuery,
    WidgetStateResult,
)
from src.domain.common.abstractions import IQueryHandler
from src.domain.common.result import Result
from src.domain.ui_widget_operations import WidgetType


# Service Protocols (Ports)
class WidgetStateServiceProtocol(Protocol):
    """Protocol for widget state service."""
    def get_current_state(self, widget_id: str, widget_type: WidgetType) -> Result[dict]: ...
    def get_event_history(self, widget_id: str, max_entries: int) -> Result[list[dict]]: ...
    def get_response_state(self, widget_id: str) -> Result[dict]: ...
    def get_validation_state(self, widget_id: str) -> Result[dict]: ...
    def widget_exists(self, widget_id: str) -> bool: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs) -> None: ...
    def log_error(self, message: str, **kwargs) -> None: ...
    def log_warning(self, message: str, **kwargs) -> None: ...


class GetWidgetStateQueryHandler(IQueryHandler[GetWidgetStateQuery, WidgetStateResult]):
    """Query handler for retrieving widget state information.
    
    This handler provides read-only access to widget state data
    without any side effects or modifications.
    """

    def __init__(
        self,
        widget_state_service: WidgetStateServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._widget_state_service = widget_state_service
        self._logger = logger_service

    def handle(self, query: GetWidgetStateQuery) -> Result[WidgetStateResult]:
        """Handle widget state query.
        
        Args:
            query: The widget state query
            
        Returns:
            Result containing widget state information or error
        """
        try:
            self._logger.log_info(
                "Processing widget state query",
                widget_id=query.widget_id,
                widget_type=query.widget_type.value,
                include_history=query.include_event_history,
                include_response=query.include_response_state,
                include_validation=query.include_validation_state,
            )

            # Validate widget exists
            if not self._widget_state_service.widget_exists(query.widget_id):
                error_msg = f"Widget with ID '{query.widget_id}' not found"
                self._logger.log_warning(error_msg, widget_id=query.widget_id)
                return Result.failure(error_msg)

            # Get current state (always required)
            current_state_result = self._widget_state_service.get_current_state(
                query.widget_id,
                query.widget_type,
            )
            if not current_state_result.is_success:
                self._logger.log_error(
                    "Failed to retrieve current widget state",
                    widget_id=query.widget_id,
                    error=current_state_result.get_error(),
                )
                return Result.failure(current_state_result.get_error())

            # Initialize result with current state
            current_state = current_state_result.value if current_state_result.value is not None else {}
            result = WidgetStateResult(
                widget_id=query.widget_id,
                widget_type=query.widget_type,
                current_state=current_state,
                timestamp=time.time(),
            )

            # Get event history if requested
            if query.include_event_history:
                event_history_result = self._widget_state_service.get_event_history(
                    query.widget_id,
                    query.max_history_entries,
                )
                if event_history_result.is_success:
                    object.__setattr__(result, "event_history", event_history_result.value)
                else:
                    self._logger.log_warning(
                        "Failed to retrieve event history",
                        widget_id=query.widget_id,
                        error=event_history_result.error,
                    )
                    # Continue without event history rather than failing
                    object.__setattr__(result, "event_history", [])

            # Get response state if requested
            if query.include_response_state:
                response_state_result = self._widget_state_service.get_response_state(
                    query.widget_id,
                )
                if response_state_result.is_success:
                    object.__setattr__(result, "response_state", response_state_result.value)
                else:
                    self._logger.log_warning(
                        "Failed to retrieve response state",
                        widget_id=query.widget_id,
                        error=response_state_result.error,
                    )
                    # Continue without response state rather than failing
                    object.__setattr__(result, "response_state", {})

            # Get validation state if requested
            if query.include_validation_state:
                validation_state_result = self._widget_state_service.get_validation_state(
                    query.widget_id,
                )
                if validation_state_result.is_success:
                    object.__setattr__(result, "validation_state", validation_state_result.value)
                else:
                    self._logger.log_warning(
                        "Failed to retrieve validation state",
                        widget_id=query.widget_id,
                        error=validation_state_result.error,
                    )
                    # Continue without validation state rather than failing
                    object.__setattr__(result, "validation_state", {})

            self._logger.log_info(
                "Widget state query completed successfully",
                widget_id=query.widget_id,
                has_event_history=result.event_history is not None,
                has_response_state=result.response_state is not None,
                has_validation_state=result.validation_state is not None,
            )

            return Result.success(result)
            
        except (ValueError, TypeError, AttributeError, RuntimeError) as e:
            error_msg = f"Unexpected error retrieving widget state: {e!s}"
            self._logger.log_error(
                error_msg,
                widget_id=query.widget_id,
                exception=str(e),
            )
            return Result.failure(error_msg)
        except Exception as e:
            # Last resort for any other unexpected exceptions
            error_msg = f"Critical error retrieving widget state: {e!s}"
            self._logger.log_error(
                error_msg,
                widget_id=query.widget_id,
                exception=str(e),
            )
            return Result.failure(error_msg)