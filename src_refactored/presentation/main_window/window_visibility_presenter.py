"""Window Visibility Presenter.

This module implements the presenter for handling window visibility operations.
Moved from application layer to maintain proper separation of concerns.
"""

from dataclasses import dataclass
from typing import Any, Protocol

from src_refactored.domain.common.result import Result
from src_refactored.domain.main_window.events.window_events import (
    WindowHiddenEvent,
    WindowHideRequestedEvent,
    WindowShownEvent,
    WindowShowRequestedEvent,
)
from src_refactored.domain.ui_coordination.value_objects.ui_abstractions import IUIWindow


@dataclass
class ShowWindowRequest:
    """Request for showing window."""
    window_id: str
    reason: str | None = None
    restore_geometry: bool = True
    event_publisher: Any | None = None


@dataclass
class HideWindowRequest:
    """Request for hiding window."""
    window_id: str
    reason: str | None = None
    minimize_to_tray: bool = False
    event_publisher: Any | None = None


@dataclass
class WindowVisibilityResponse:
    """Response from window visibility operation."""
    result: Result[None]
    window_id: str
    operation: str  # "show" or "hide"
    error_message: str | None = None


class WindowManagementServiceProtocol(Protocol):
    """Protocol for window management operations."""

    def get_window_by_id(self, window_id: str) -> IUIWindow | None:
        """Get window by ID."""
        ...

    def show_window(self, window: IUIWindow) -> bool:
        """Show window."""
        ...

    def hide_window(self, window: IUIWindow) -> bool:
        """Hide window."""
        ...

    def is_window_visible(self, window: IUIWindow) -> bool:
        """Check if window is visible."""
        ...

    def get_window_geometry(self, window: IUIWindow) -> dict[str, int]:
        """Get window geometry."""
        ...


class WindowVisibilityPresenter:
    """Presenter for handling window visibility operations in the presentation layer."""

    def __init__(self, window_management_service: WindowManagementServiceProtocol):
        self._window_management = window_management_service

    def handle_show_window_request(self, request: ShowWindowRequest) -> WindowVisibilityResponse:
        """Handle window show request.
        
        Args:
            request: Window show request
            
        Returns:
            Response with operation result
        """
        try:
            # Publish domain event for show request
            if request.event_publisher:
                show_requested_event = WindowShowRequestedEvent(
                    window_id=request.window_id,
                    reason=request.reason,
                    restore_geometry=request.restore_geometry,
                )
                request.event_publisher.publish(show_requested_event)

            # Get window
            window = self._window_management.get_window_by_id(request.window_id)
            if not window:
                return WindowVisibilityResponse(
                    result=Result.failure(f"Window not found: {request.window_id}"),
                    window_id=request.window_id,
                    operation="show",
                    error_message="Window not found",
                )

            # Show window
            if not self._window_management.show_window(window):
                return WindowVisibilityResponse(
                    result=Result.failure("Failed to show window"),
                    window_id=request.window_id,
                    operation="show",
                    error_message="Window show operation failed",
                )

            # Publish domain event for successful show
            if request.event_publisher:
                geometry = self._window_management.get_window_geometry(window)
                shown_event = WindowShownEvent(
                    window_id=request.window_id,
                    geometry=geometry,  # Convert to domain geometry object
                )
                request.event_publisher.publish(shown_event)

            return WindowVisibilityResponse(
                result=Result.success(None),
                window_id=request.window_id,
                operation="show",
            )

        except Exception as e:
            error_message = f"Unexpected error showing window: {e!s}"
            return WindowVisibilityResponse(
                result=Result.failure(error_message),
                window_id=request.window_id,
                operation="show",
                error_message=error_message,
            )

    def handle_hide_window_request(self, request: HideWindowRequest) -> WindowVisibilityResponse:
        """Handle window hide request.
        
        Args:
            request: Window hide request
            
        Returns:
            Response with operation result
        """
        try:
            # Publish domain event for hide request
            if request.event_publisher:
                hide_requested_event = WindowHideRequestedEvent(
                    window_id=request.window_id,
                    reason=request.reason,
                    minimize_to_tray=request.minimize_to_tray,
                )
                request.event_publisher.publish(hide_requested_event)

            # Get window
            window = self._window_management.get_window_by_id(request.window_id)
            if not window:
                return WindowVisibilityResponse(
                    result=Result.failure(f"Window not found: {request.window_id}"),
                    window_id=request.window_id,
                    operation="hide",
                    error_message="Window not found",
                )

            # Hide window
            if not self._window_management.hide_window(window):
                return WindowVisibilityResponse(
                    result=Result.failure("Failed to hide window"),
                    window_id=request.window_id,
                    operation="hide",
                    error_message="Window hide operation failed",
                )

            # Publish domain event for successful hide
            if request.event_publisher:
                hidden_event = WindowHiddenEvent(
                    window_id=request.window_id,
                    was_minimized=request.minimize_to_tray,
                )
                request.event_publisher.publish(hidden_event)

            return WindowVisibilityResponse(
                result=Result.success(None),
                window_id=request.window_id,
                operation="hide",
            )

        except Exception as e:
            error_message = f"Unexpected error hiding window: {e!s}"
            return WindowVisibilityResponse(
                result=Result.failure(error_message),
                window_id=request.window_id,
                operation="hide",
                error_message=error_message,
            )
