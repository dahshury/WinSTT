"""Window management service interface for application layer.

This interface abstracts window management operations, providing a clean boundary
between the presentation layer and domain/infrastructure concerns.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from src_refactored.domain.common.result import Result

# ============================================================================
# DATA TRANSFER OBJECTS
# ============================================================================

@dataclass
class WindowShowRequest:
    """Request for showing window."""
    window_id: str
    reason: str | None = None
    restore_geometry: bool = True


@dataclass
class WindowHideRequest:
    """Request for hiding window."""
    window_id: str
    reason: str | None = None
    minimize_to_tray: bool = False


@dataclass
class WindowVisibilityResponse:
    """Response from window visibility operation."""
    success: bool
    window_id: str
    operation: str  # "show" or "hide"
    error_message: str | None = None


@dataclass
class WindowGeometry:
    """Window geometry information."""
    x: int
    y: int
    width: int
    height: int


@dataclass
class WindowInfo:
    """Window information for presentation layer."""
    window_id: str
    is_visible: bool
    geometry: WindowGeometry


# ============================================================================
# SERVICE INTERFACES
# ============================================================================

class IWindowManagementService(Protocol):
    """Service interface for window management operations."""

    def show_window(self, request: WindowShowRequest) -> Result[WindowVisibilityResponse]:
        """Show a window.
        
        Args:
            request: Window show request
            
        Returns:
            Result containing window visibility response
        """
        ...

    def hide_window(self, request: WindowHideRequest) -> Result[WindowVisibilityResponse]:
        """Hide a window.
        
        Args:
            request: Window hide request
            
        Returns:
            Result containing window visibility response
        """
        ...

    def get_window_info(self, window_id: str) -> Result[WindowInfo]:
        """Get window information.
        
        Args:
            window_id: Window identifier
            
        Returns:
            Result containing window information
        """
        ...

    def is_window_available(self, window_id: str) -> Result[bool]:
        """Check if a window is available for operations.
        
        Args:
            window_id: Window identifier
            
        Returns:
            Result containing availability status
        """
        ...


class IWindowEventService(Protocol):
    """Service interface for window event handling."""

    def publish_window_show_requested(
        self, 
        window_id: str, 
        reason: str | None = None, 
        restore_geometry: bool = True,
    ) -> Result[None]:
        """Publish window show requested event.
        
        Args:
            window_id: Window identifier
            reason: Reason for showing
            restore_geometry: Whether to restore geometry
            
        Returns:
            Result indicating success
        """
        ...

    def publish_window_shown(self, window_id: str, geometry: WindowGeometry) -> Result[None]:
        """Publish window shown event.
        
        Args:
            window_id: Window identifier
            geometry: Window geometry
            
        Returns:
            Result indicating success
        """
        ...

    def publish_window_hide_requested(
        self, 
        window_id: str, 
        reason: str | None = None, 
        minimize_to_tray: bool = False,
    ) -> Result[None]:
        """Publish window hide requested event.
        
        Args:
            window_id: Window identifier
            reason: Reason for hiding
            minimize_to_tray: Whether to minimize to tray
            
        Returns:
            Result indicating success
        """
        ...

    def publish_window_hidden(self, window_id: str, was_minimized: bool = False) -> Result[None]:
        """Publish window hidden event.
        
        Args:
            window_id: Window identifier
            was_minimized: Whether window was minimized
            
        Returns:
            Result indicating success
        """
        ...


__all__ = [
    "IWindowEventService",
    "IWindowManagementService",
    "WindowGeometry",
    "WindowHideRequest",
    "WindowInfo",
    "WindowShowRequest",
    "WindowVisibilityResponse",
]
