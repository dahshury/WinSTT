"""Drag Drop Port Interface.

This module defines the port interface for drag and drop operations in the domain layer.
"""

from abc import ABC, abstractmethod
from collections.abc import Callable
from enum import Enum
from typing import Any

from src.domain.common.result import Result
from src.domain.system_integration.value_objects.drag_drop_operations import DropZoneType


class DragAction(Enum):
    """Drag action types."""
    COPY = "copy"
    MOVE = "move"
    LINK = "link"


class DropAction(Enum):
    """Drop action types."""
    ACCEPT = "accept"
    REJECT = "reject"
    IGNORE = "ignore"


class MimeType(Enum):
    """Common MIME types for drag-drop operations."""
    TEXT_PLAIN = "text/plain"
    TEXT_URI_LIST = "text/uri-list"
    APPLICATION_JSON = "application/json"
    IMAGE_PNG = "image/png"
    IMAGE_JPEG = "image/jpeg"
    AUDIO_WAV = "audio/wav"
    AUDIO_MP3 = "audio/mp3"
    VIDEO_MP4 = "video/mp4"


class IDragDropPort(ABC):
    """Port interface for drag and drop operations."""

    @abstractmethod
    def enable_drag_drop(self, zone_id: str, zone_type: DropZoneType) -> Result[None]:
        """Enable drag and drop for a zone.
        
        Args:
            zone_id: Unique identifier for the drop zone
            zone_type: Type of drop zone
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def disable_drag_drop(self, zone_id: str) -> Result[None]:
        """Disable drag and drop for a zone.
        
        Args:
            zone_id: Drop zone identifier
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def set_accepted_mime_types(self, zone_id: str, mime_types: list[MimeType]) -> Result[None]:
        """Set accepted MIME types for a drop zone.
        
        Args:
            zone_id: Drop zone identifier
            mime_types: List of accepted MIME types
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def set_drop_callback(
        self, 
        zone_id: str, 
        callback: Callable[[str, list[str], dict[str, Any]], DropAction],
    ) -> Result[None]:
        """Set callback for drop events.
        
        Args:
            zone_id: Drop zone identifier
            callback: Function to call on drop events (zone_id, files, metadata) -> DropAction
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def set_drag_enter_callback(
        self, 
        zone_id: str, 
        callback: Callable[[str, dict[str, Any]], bool],
    ) -> Result[None]:
        """Set callback for drag enter events.
        
        Args:
            zone_id: Drop zone identifier
            callback: Function to call on drag enter (zone_id, metadata) -> bool (accept)
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def set_drag_leave_callback(
        self, 
        zone_id: str, 
        callback: Callable[[str], None],
    ) -> Result[None]:
        """Set callback for drag leave events.
        
        Args:
            zone_id: Drop zone identifier
            callback: Function to call on drag leave
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def get_drop_zone_info(self, zone_id: str) -> Result[dict[str, Any]]:
        """Get information about a drop zone.
        
        Args:
            zone_id: Drop zone identifier
            
        Returns:
            Result containing drop zone information
        """
        ...

    @abstractmethod
    def get_active_drop_zones(self) -> Result[list[str]]:
        """Get list of active drop zone IDs.
        
        Returns:
            Result containing list of active drop zone IDs
        """
        ...

    @abstractmethod
    def validate_drop_data(self, zone_id: str, file_paths: list[str]) -> Result[list[str]]:
        """Validate dropped data for a zone.
        
        Args:
            zone_id: Drop zone identifier
            file_paths: List of dropped file paths
            
        Returns:
            Result containing list of valid file paths
        """
        ...

    @abstractmethod
    def get_mime_type(self, file_path: str) -> Result[MimeType]:
        """Get MIME type for a file.
        
        Args:
            file_path: Path to file
            
        Returns:
            Result containing MIME type
        """
        ...


class IWidgetConfigurationPort(ABC):
    """Port interface for widget configuration operations."""

    @abstractmethod
    def configure_widget_properties(self, widget_id: str, properties: dict[str, Any]) -> Result[None]:
        """Configure widget properties.
        
        Args:
            widget_id: Widget identifier
            properties: Properties to set
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def get_widget_properties(self, widget_id: str) -> Result[dict[str, Any]]:
        """Get widget properties.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result containing widget properties
        """
        ...

    @abstractmethod
    def set_widget_style(self, widget_id: str, style_properties: dict[str, str]) -> Result[None]:
        """Set widget style properties.
        
        Args:
            widget_id: Widget identifier
            style_properties: Style properties to set
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def enable_widget(self, widget_id: str) -> Result[None]:
        """Enable a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def disable_widget(self, widget_id: str) -> Result[None]:
        """Disable a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def show_widget(self, widget_id: str) -> Result[None]:
        """Show a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def hide_widget(self, widget_id: str) -> Result[None]:
        """Hide a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            Result indicating success or failure
        """
        ...

    @abstractmethod
    def validate_widget_configuration(self, widget_id: str, configuration: dict[str, Any]) -> Result[bool]:
        """Validate widget configuration.
        
        Args:
            widget_id: Widget identifier
            configuration: Configuration to validate
            
        Returns:
            Result containing validation result
        """
        ...
