"""Qt Drag Drop Adapter.

This adapter implements IDragDropPort to manage drag and drop functionality
using Qt/PyQt6 infrastructure services, following the hexagonal architecture pattern.
"""

from collections.abc import Callable as ABCCallable
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.result import Result
from src_refactored.domain.system_integration.ports.drag_drop_port import (
    DropAction,
    IDragDropPort,
    MimeType,
)
from src_refactored.domain.system_integration.value_objects.drag_drop_operations import DropZoneType
from src_refactored.presentation.qt.services.drag_drop_service import (
    DragDropManager,
    DragDropService,
)

if TYPE_CHECKING:
    from src_refactored.presentation.qt.services.drag_drop_integration_service import (
        DragDropIntegrationService,
    )


class QtDragDropAdapter(IDragDropPort):
    """Adapter for drag and drop operations using Qt implementation."""
    
    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        self._drop_zones: dict[str, Any] = {}
        self._drag_drop_service = DragDropService()
        self._drag_drop_manager = DragDropManager()
        self._integration_service: DragDropIntegrationService | None = None
        self._callbacks: dict[str, dict[str, ABCCallable]] = {}
    
    def enable_drag_drop(self, zone_id: str, zone_type: DropZoneType) -> Result[None]:
        """Enable drag and drop for a zone using existing infrastructure services."""
        try:
            if zone_id in self._drop_zones:
                return Result.success(None)  # Already enabled
            
            # Store zone information
            self._drop_zones[zone_id] = {
                "type": zone_type,
                "enabled": True,
                "callbacks": {},
            }
            
            if self._logger:
                self._logger.log_info(f"Enabled drag drop for zone: {zone_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error enabling drag drop for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def disable_drag_drop(self, zone_id: str) -> Result[None]:
        """Disable drag and drop for a zone."""
        try:
            if zone_id in self._drop_zones:
                del self._drop_zones[zone_id]
                
                if self._logger:
                    self._logger.log_info(f"Disabled drag drop for zone: {zone_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error disabling drag drop for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_accepted_mime_types(self, zone_id: str, mime_types: list[MimeType]) -> Result[None]:
        """Set accepted MIME types for a drop zone."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            # Convert domain MIME types to string extensions
            extensions = []
            for mime_type in mime_types:
                if mime_type == MimeType.AUDIO_WAV:
                    extensions.append(".wav")
                elif mime_type == MimeType.AUDIO_MP3:
                    extensions.append(".mp3")
                elif mime_type == MimeType.VIDEO_MP4:
                    extensions.append(".mp4")
                elif mime_type == MimeType.TEXT_PLAIN:
                    extensions.append(".txt")
                elif mime_type == MimeType.IMAGE_PNG:
                    extensions.append(".png")
                elif mime_type == MimeType.IMAGE_JPEG:
                    extensions.append(".jpg")
            
            # Configure the drag drop service
            self._drag_drop_service.configure(accepted_extensions=extensions)
            
            self._drop_zones[zone_id]["mime_types"] = mime_types
            
            if self._logger:
                self._logger.log_debug(f"Set {len(mime_types)} MIME types for zone {zone_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting MIME types for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_drop_callback(
        self, 
        zone_id: str, 
        callback: ABCCallable[[str, list[str], dict[str, Any]], DropAction],
    ) -> Result[None]:
        """Set callback for drop events."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            # Store callback
            if zone_id not in self._callbacks:
                self._callbacks[zone_id] = {}
            self._callbacks[zone_id]["drop"] = callback
            
            # Connect to the infrastructure service signals
            def handle_files_dropped(event_data):
                try:
                    files = event_data.files if hasattr(event_data, "files") else []
                    metadata = {"position": event_data.position} if hasattr(event_data, "position") else {}
                    action = callback(zone_id, files, metadata)
                    
                    if self._logger:
                        self._logger.log_debug(f"Drop callback executed for zone {zone_id}, action: {action}")
                        
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error in drop callback for zone {zone_id}: {e}")
            
            self._drag_drop_service.files_dropped.connect(handle_files_dropped)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting drop callback for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_drag_enter_callback(
        self, 
        zone_id: str, 
        callback: ABCCallable[[str, dict[str, Any]], bool],
    ) -> Result[None]:
        """Set callback for drag enter events."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            # Store callback
            if zone_id not in self._callbacks:
                self._callbacks[zone_id] = {}
            self._callbacks[zone_id]["drag_enter"] = callback
            
            # Connect to the infrastructure service signals
            def handle_drag_entered(event_data):
                try:
                    metadata = {"position": event_data.position} if hasattr(event_data, "position") else {}
                    accepted = callback(zone_id, metadata)
                    
                    if self._logger:
                        self._logger.log_debug(f"Drag enter callback executed for zone {zone_id}, accepted: {accepted}")
                        
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error in drag enter callback for zone {zone_id}: {e}")
            
            self._drag_drop_service.drag_entered.connect(handle_drag_entered)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting drag enter callback for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def set_drag_leave_callback(
        self, 
        zone_id: str, 
        callback: ABCCallable[[str], None],
    ) -> Result[None]:
        """Set callback for drag leave events."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            # Store callback
            if zone_id not in self._callbacks:
                self._callbacks[zone_id] = {}
            self._callbacks[zone_id]["drag_leave"] = callback
            
            # Connect to the infrastructure service signals
            def handle_drag_left():
                try:
                    callback(zone_id)
                    
                    if self._logger:
                        self._logger.log_debug(f"Drag leave callback executed for zone {zone_id}")
                        
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error in drag leave callback for zone {zone_id}: {e}")
            
            self._drag_drop_service.drag_left.connect(handle_drag_left)
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error setting drag leave callback for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def get_drop_zone_info(self, zone_id: str) -> Result[dict[str, Any]]:
        """Get information about a drop zone."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            zone_info = self._drop_zones[zone_id].copy()
            zone_info["callbacks_count"] = len(self._callbacks.get(zone_id, {}))
            
            return Result.success(zone_info)
            
        except Exception as e:
            error_msg = f"Error getting drop zone info for {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def get_active_drop_zones(self) -> Result[list[str]]:
        """Get list of active drop zone IDs."""
        try:
            active_zones = [zone_id for zone_id, zone in self._drop_zones.items() 
                           if zone.get("enabled", False)]
            return Result.success(active_zones)
            
        except Exception as e:
            error_msg = f"Error getting active drop zones: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def validate_drop_data(self, zone_id: str, file_paths: list[str]) -> Result[list[str]]:
        """Validate dropped data for a zone using infrastructure services."""
        try:
            if zone_id not in self._drop_zones:
                return Result.failure(f"Drop zone '{zone_id}' not found")
            
            # Use the infrastructure service for validation
            valid_files, invalid_files = self._drag_drop_service._validate_files(file_paths)
            
            if self._logger:
                self._logger.log_debug(f"Validated {len(valid_files)} valid files for zone {zone_id}")
            
            return Result.success(valid_files)
            
        except Exception as e:
            error_msg = f"Error validating drop data for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def get_mime_type(self, file_path: str) -> Result[MimeType]:
        """Get MIME type for a file."""
        try:
            # Simple file extension to MIME type mapping
            lower_path = file_path.lower()
            
            if lower_path.endswith(".wav"):
                return Result.success(MimeType.AUDIO_WAV)
            elif lower_path.endswith(".mp3"):
                return Result.success(MimeType.AUDIO_MP3)
            elif lower_path.endswith(".mp4"):
                return Result.success(MimeType.VIDEO_MP4)
            elif lower_path.endswith(".txt"):
                return Result.success(MimeType.TEXT_PLAIN)
            elif lower_path.endswith(".png"):
                return Result.success(MimeType.IMAGE_PNG)
            elif lower_path.endswith((".jpg", ".jpeg")):
                return Result.success(MimeType.IMAGE_JPEG)
            elif lower_path.endswith(".json"):
                return Result.success(MimeType.APPLICATION_JSON)
            else:
                return Result.failure(f"Unknown MIME type for file: {file_path}")
                
        except Exception as e:
            error_msg = f"Error getting MIME type for {file_path}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def get_drag_drop_service(self) -> DragDropService:
        """Get the underlying drag drop service for advanced operations."""
        return self._drag_drop_service
    
    def get_drag_drop_manager(self) -> DragDropManager:
        """Get the drag drop manager for high-level operations."""
        return self._drag_drop_manager
    
    def enable_widget_drag_drop(self, widget, zone_id: str, media_files: bool = True) -> Result[None]:
        """Enable drag and drop for a specific widget using manager convenience methods."""
        try:
            if media_files:
                self._drag_drop_manager.setup_media_file_drop(widget)
            else:
                self._drag_drop_manager.setup_custom_drop(
                    widget, 
                    accepted_extensions=[".txt", ".json"],
                )
            
            # Enable the zone
            self.enable_drag_drop(zone_id, DropZoneType.MAIN_WINDOW)
            
            if self._logger:
                self._logger.log_info(f"Enabled widget drag drop for zone {zone_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error enabling widget drag drop for zone {zone_id}: {e}"
            if self._logger:
                self._logger.log_error(error_msg)
            return Result.failure(error_msg)
    
    def cleanup(self) -> None:
        """Clean up all drag drop resources."""
        try:
            # Disable all zones
            for zone_id in list(self._drop_zones.keys()):
                self.disable_drag_drop(zone_id)
            
            # Cleanup manager
            self._drag_drop_manager.disable_all()
            
            # Clear callbacks
            self._callbacks.clear()
            
            if self._logger:
                self._logger.log_info("Drag drop adapter cleaned up")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error during drag drop cleanup: {e}")

