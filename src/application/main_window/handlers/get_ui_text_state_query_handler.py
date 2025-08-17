"""Get UI Text State Query Handler.

This module implements the query handler for retrieving UI text state,
focusing on read-only operations without side effects.
"""

import time
from typing import Any, Protocol

from src.application.main_window.queries.get_ui_text_state_query import (
    GetUITextStateQuery,
    UITextStateResult,
)
from src.domain.common.abstractions import IQueryHandler
from src.domain.common.result import Result


# Service Protocols (Ports)
class UITextStateServiceProtocol(Protocol):
    """Protocol for UI text state service."""
    def get_widget_text_states(self, targets: list) -> Result[dict[str, dict[str, Any]]]: ...
    def get_formatting_cache(self, operation_id: str) -> Result[dict[str, Any]]: ...
    def get_translation_cache(self, operation_id: str) -> Result[dict[str, Any]]: ...
    def get_validation_results(self, operation_id: str) -> Result[dict[str, Any]]: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs) -> None: ...
    def log_error(self, message: str, **kwargs) -> None: ...
    def log_warning(self, message: str, **kwargs) -> None: ...


class GetUITextStateQueryHandler(IQueryHandler[GetUITextStateQuery, UITextStateResult]):
    """Query handler for retrieving UI text state.
    
    This handler focuses on read-only operations and data retrieval
    without causing any side effects or state changes.
    """

    def __init__(
        self,
        ui_text_state_service: UITextStateServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._ui_text_state = ui_text_state_service
        self._logger = logger_service

    def handle(self, query: GetUITextStateQuery) -> Result[UITextStateResult]:
        """Handle UI text state query.
        
        Args:
            query: The UI text state query
            
        Returns:
            Result containing UI text state information
        """
        try:
            self._logger.log_info(
                f"Retrieving UI text state for operation {query.operation_id}",
                operation_id=query.operation_id,
                widget_count=len(query.target_widgets),
                include_formatting=query.include_formatting,
                include_translation_cache=query.include_translation_cache,
                include_validation_state=query.include_validation_state,
            )

            # Get widget text states
            widget_states_result = self._ui_text_state.get_widget_text_states(
                query.target_widgets,
            )
            if not widget_states_result.is_success:
                return Result.failure(f"Failed to get widget states: {widget_states_result.error}")

            # Initialize result
            widget_states = widget_states_result.value or {}
            result = UITextStateResult(
                operation_id=query.operation_id,
                widget_states=widget_states,
                timestamp=time.time(),
            )

            # Get formatting cache if requested
            if query.include_formatting:
                formatting_result = self._ui_text_state.get_formatting_cache(query.operation_id)
                if formatting_result.is_success:
                    result.formatting_cache = formatting_result.value
                else:
                    self._logger.log_warning(
                        f"Failed to get formatting cache: {formatting_result.error}",
                        operation_id=query.operation_id,
                    )

            # Get translation cache if requested
            if query.include_translation_cache:
                translation_result = self._ui_text_state.get_translation_cache(query.operation_id)
                if translation_result.is_success:
                    result.translation_cache = translation_result.value
                else:
                    self._logger.log_warning(
                        f"Failed to get translation cache: {translation_result.error}",
                        operation_id=query.operation_id,
                    )

            # Get validation results if requested
            if query.include_validation_state:
                validation_result = self._ui_text_state.get_validation_results(query.operation_id)
                if validation_result.is_success:
                    result.validation_results = validation_result.value
                else:
                    self._logger.log_warning(
                        f"Failed to get validation results: {validation_result.error}",
                        operation_id=query.operation_id,
                    )

            self._logger.log_info(
                f"Successfully retrieved UI text state for operation {query.operation_id}",
                operation_id=query.operation_id,
                widget_count=len(result.widget_states),
            )

            return Result.success(result)
            
        except Exception as e:
            error_msg = f"Unexpected error retrieving UI text state: {e!s}"
            self._logger.log_error(error_msg, operation_id=query.operation_id)
            return Result.failure(error_msg)