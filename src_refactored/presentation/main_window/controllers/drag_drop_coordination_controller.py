"""Drag Drop Coordination Controller.

This controller coordinates drag and drop functionality using proper DDD architecture,
delegating to use cases and domain services rather than implementing PyQt6 directly.
"""

from typing import Any

from PyQt6.QtWidgets import QWidget

from src_refactored.application.main_window_coordination import (
    FileTranscriptionRequest,
    MainWindowController,
)
from src_refactored.application.system_integration.process_drag_drop_use_case import (
    IDragDropProcessingPort,
    ProcessDragDropRequest,
    ProcessDragDropUseCase,
)
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.system_integration.ports.drag_drop_port import IDragDropPort, MimeType
from src_refactored.domain.system_integration.value_objects.drag_drop_operations import DropZoneType
from src_refactored.presentation.main_window.controllers.ui_state_controller import (
    UIStateController,
)


class MainWindowDragDropProcessingAdapter(IDragDropProcessingPort):
    """Adapter that implements IDragDropProcessingPort for main window file processing."""
    
    def __init__(
        self, 
        main_window_controller: MainWindowController,
        ui_controller: UIStateController,
        logger: LoggingPort | None = None,
    ):
        self._main_window_controller = main_window_controller
        self._ui_controller = ui_controller
        self._logger = logger
    
    def process_dropped_files(self, file_paths: list[str]) -> bool:
        """Process dropped files using main window controller."""
        try:
            if not file_paths:
                return False
            
            # Process the first supported file
            for file_path in file_paths:
                if self.validate_file_types([file_path]):
                    request = FileTranscriptionRequest(file_path=file_path)
                    self._main_window_controller.handle_file_transcription(request)
                    
                    # Update UI for file transcription (shows progress bar)
                    self._ui_controller.start_transcribing_ui(show_progress=True)
                    
                    if self._logger:
                        self._logger.log_info(f"Processing dropped file: {file_path}")
                    
                    return True
            
            return False
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error processing dropped files: {e}")
            return False
    
    def validate_file_types(self, file_paths: list[str]) -> list[str]:
        """Validate dropped file types."""
        supported_extensions = (".mp3", ".wav", ".mp4", ".avi", ".mov", ".m4a", ".flac")
        valid_files = []
        
        for file_path in file_paths:
            if file_path.lower().endswith(supported_extensions):
                valid_files.append(file_path)
        
        return valid_files


class DragDropCoordinationController:
    """Controller for coordinating drag and drop functionality using DDD architecture."""
    
    def __init__(
        self, 
        drag_drop_port: IDragDropPort,
        main_window_controller: MainWindowController,
        ui_controller: UIStateController,
        logger: LoggingPort | None = None,
    ):
        self._drag_drop_port = drag_drop_port
        self._main_window_controller = main_window_controller
        self._ui_controller = ui_controller
        self._logger = logger
        
        # Create processing adapter
        self._processing_adapter = MainWindowDragDropProcessingAdapter(
            main_window_controller, ui_controller, logger,
        )
        
        # Create use case
        self._process_drag_drop_use_case = ProcessDragDropUseCase(self._processing_adapter)
        
        # Zone configuration
        self._main_zone_id = "main_window"
    
    def setup_main_window_drag_drop(self, main_window: QWidget) -> bool:
        """Set up drag and drop for the main window using proper DDD architecture."""
        try:
            # Enable drag drop through port
            enable_result = self._drag_drop_port.enable_drag_drop(
                self._main_zone_id, 
                DropZoneType.MAIN_WINDOW,
            )
            
            if not enable_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to enable drag drop: {enable_result.error}")
                return False
            
            # Set accepted MIME types for audio/video files
            mime_types = [
                MimeType.AUDIO_WAV,
                MimeType.AUDIO_MP3,
                MimeType.VIDEO_MP4,
            ]
            
            mime_result = self._drag_drop_port.set_accepted_mime_types(
                self._main_zone_id, 
                mime_types,
            )
            
            if not mime_result.is_success and self._logger:
                self._logger.log_warning(f"Failed to set MIME types: {mime_result.error}")
            
            # Set drop callback
            def handle_drop(zone_id: str, files: list[str], metadata: dict[str, Any]):
                try:
                    if self._logger:
                        self._logger.log_info(f"Files dropped in zone {zone_id}: {files}")
                    
                    # Create request for use case
                    from src_refactored.domain.ui_coordination.value_objects.drag_drop_operations import (
                        DragDropEventData,
                    )
                    
                    event_data = DragDropEventData(
                        files=files,
                        position=metadata.get("position", (0, 0)),
                    )
                    
                    request = ProcessDragDropRequest(
                        event_data=event_data,
                        allowed_extensions=[".mp3", ".wav", ".mp4", ".avi", ".mov", ".m4a", ".flac"],
                        max_files=1,  # Process one file at a time
                        progress_callback=self._handle_progress,
                        completion_callback=self._handle_completion,
                        error_callback=self._handle_error,
                    )
                    
                    # Execute use case
                    response = self._process_drag_drop_use_case.execute(request)
                    
                    if response.success:
                        from src_refactored.domain.system_integration.ports.drag_drop_port import (
                            DropAction,
                        )
                        return DropAction.ACCEPT
                    else:
                        if self._logger:
                            self._logger.log_warning(f"Drop processing failed: {response.message}")
                        return DropAction.REJECT
                        
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drop: {e}")
                    from src_refactored.domain.system_integration.ports.drag_drop_port import (
                        DropAction,
                    )
                    return DropAction.REJECT
            
            drop_callback_result = self._drag_drop_port.set_drop_callback(
                self._main_zone_id,
                handle_drop,
            )
            
            if not drop_callback_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to set drop callback: {drop_callback_result.error}")
                return False
            
            # Set drag enter callback for visual feedback
            def handle_drag_enter(zone_id: str, metadata: dict[str, Any]) -> bool:
                try:
                    # Show visual feedback through UI controller
                    # This could trigger status message or cursor change
                    if self._logger:
                        self._logger.log_debug(f"Drag entered zone {zone_id}")
                    return True
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drag enter: {e}")
                    return False
            
            enter_callback_result = self._drag_drop_port.set_drag_enter_callback(
                self._main_zone_id,
                handle_drag_enter,
            )
            
            if not enter_callback_result.is_success:
                if self._logger:
                    self._logger.log_warning(f"Failed to set drag enter callback: {enter_callback_result.error}")
            
            # Set drag leave callback
            def handle_drag_leave(zone_id: str) -> None:
                try:
                    if self._logger:
                        self._logger.log_debug(f"Drag left zone {zone_id}")
                    # Could reset visual feedback here
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drag leave: {e}")
            
            leave_callback_result = self._drag_drop_port.set_drag_leave_callback(
                self._main_zone_id,
                handle_drag_leave,
            )
            
            if not leave_callback_result.is_success:
                if self._logger:
                    self._logger.log_warning(f"Failed to set drag leave callback: {leave_callback_result.error}")
            
            # Enable drag drop on the actual widget using the adapter's convenience method
            if hasattr(self._drag_drop_port, "enable_widget_drag_drop"):
                widget_result = self._drag_drop_port.enable_widget_drag_drop(
                    main_window, 
                    self._main_zone_id, 
                    media_files=True,
                )
                
                if not widget_result.is_success:
                    if self._logger:
                        self._logger.log_error(f"Failed to enable widget drag drop: {widget_result.error}")
                    return False
            
            if self._logger:
                self._logger.log_info("Main window drag drop setup completed using DDD architecture")
            
            return True
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error setting up main window drag drop: {e}")
            return False
    
    def _handle_progress(self, message: str, progress: float) -> None:
        """Handle progress updates from drag drop processing."""
        try:
            if self._logger:
                self._logger.log_debug(f"Drag drop progress: {message} ({progress:.1%})")
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error handling progress: {e}")
    
    def _handle_completion(self, processed_files: list[str]) -> None:
        """Handle completion of drag drop processing."""
        try:
            if self._logger:
                self._logger.log_info(f"Drag drop processing completed: {len(processed_files)} files processed")
            
            # Simulate transcription completion (in real implementation, this would be event-driven)
            if processed_files:
                import os

                from PyQt6.QtCore import QTimer
                
                def complete_transcription():
                    filename = os.path.basename(processed_files[0])
                    self._main_window_controller.complete_transcription(
                        result=f"Transcription of {filename}",
                        transcription_type="file",
                    )
                    self._ui_controller.stop_transcribing_ui()
                
                # Use QTimer for async completion
                QTimer.singleShot(3000, complete_transcription)
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error handling completion: {e}")
    
    def _handle_error(self, error_message: str) -> None:
        """Handle errors from drag drop processing."""
        try:
            if self._logger:
                self._logger.log_error(f"Drag drop processing error: {error_message}")
            
            # Stop any ongoing UI operations
            self._ui_controller.stop_transcribing_ui()
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error handling error: {e}")
    
    def get_active_zones(self) -> list[str]:
        """Get list of active drop zones."""
        try:
            result = self._drag_drop_port.get_active_drop_zones()
            if result.is_success:
                return result.value
            else:
                if self._logger:
                    self._logger.log_error(f"Failed to get active zones: {result.error}")
                return []
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error getting active zones: {e}")
            return []
    
    def validate_dropped_files(self, files: list[str]) -> list[str]:
        """Validate dropped files using the port."""
        try:
            result = self._drag_drop_port.validate_drop_data(self._main_zone_id, files)
            if result.is_success:
                return result.value
            else:
                if self._logger:
                    self._logger.log_warning(f"File validation failed: {result.error}")
                return []
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error validating files: {e}")
            return []
    
    def cleanup(self) -> None:
        """Clean up drag drop resources."""
        try:
            self._drag_drop_port.disable_drag_drop(self._main_zone_id)
            
            if hasattr(self._drag_drop_port, "cleanup"):
                self._drag_drop_port.cleanup()
            
            if self._logger:
                self._logger.log_info("Drag drop coordination controller cleaned up")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error during drag drop cleanup: {e}")

