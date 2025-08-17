"""Process Drag Drop Use Case.

This module implements the ProcessDragDropUseCase for handling drag and drop
events in the system integration layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.domain.ui_coordination.value_objects.drag_drop_operations import (
        DragDropEventData,
    )


class IDragDropProcessingPort(Protocol):
    """Port for drag and drop processing operations."""
    
    def process_dropped_files(self, file_paths: list[str]) -> bool:
        """Process dropped files."""
        ...
    
    def validate_file_types(self, file_paths: list[str]) -> list[str]:
        """Validate dropped file types."""
        ...


@dataclass
class ProcessDragDropRequest:
    """Request for processing drag and drop events."""
    event_data: DragDropEventData
    allowed_extensions: list[str] | None = None
    max_files: int | None = None
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[list[str]], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class ProcessDragDropResponse:
    """Response from drag and drop processing."""
    success: bool
    processed_files: list[str]
    rejected_files: list[str]
    message: str = ""


class ProcessDragDropUseCase:
    """Use case for processing drag and drop events.
    
    This use case handles:
    - File validation and filtering
    - Drag and drop event processing
    - Error handling for invalid files
    - Progress tracking for file processing
    """
    
    def __init__(self, processing_port: IDragDropProcessingPort):
        """Initialize the process drag drop use case.
        
        Args:
            processing_port: Port for drag and drop processing operations
        """
        self._processing_port = processing_port
    
    def execute(self, request: ProcessDragDropRequest) -> ProcessDragDropResponse:
        """Execute the drag and drop processing operation.
        
        Args:
            request: Process drag drop request
            
        Returns:
            ProcessDragDropResponse: Result of the processing operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback("Processing dropped files", 0.1)
            
            # Extract file paths from event data
            file_paths = self._extract_file_paths(request.event_data)
            
            if not file_paths:
                return ProcessDragDropResponse(
                    success=False,
                    processed_files=[],
                    rejected_files=[],
                    message="No valid files found in drop event",
                )
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Validating file types", 0.3)
            
            # Validate file types if restrictions are specified
            if request.allowed_extensions:
                valid_files = self._filter_by_extensions(file_paths, request.allowed_extensions)
                rejected_files = [f for f in file_paths if f not in valid_files]
            else:
                valid_files = file_paths
                rejected_files = []
            
            # Check file count limits
            if request.max_files and len(valid_files) > request.max_files:
                rejected_files.extend(valid_files[request.max_files:])
                valid_files = valid_files[:request.max_files]
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Processing valid files", 0.7)
            
            # Process valid files
            processed_files = []
            for file_path in valid_files:
                if self._processing_port.process_dropped_files([file_path]):
                    processed_files.append(file_path)
                else:
                    rejected_files.append(file_path)
            
            # Report completion
            if request.progress_callback:
                request.progress_callback("Drag and drop processing completed", 1.0)
            
            if request.completion_callback:
                request.completion_callback(processed_files)
            
            success = len(processed_files) > 0
            message = f"Processed {len(processed_files)} files successfully"
            if rejected_files:
                message += f", rejected {len(rejected_files)} files"
            
            return ProcessDragDropResponse(
                success=success,
                processed_files=processed_files,
                rejected_files=rejected_files,
                message=message,
            )
            
        except Exception as e:
            error_msg = f"Failed to process drag and drop: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            return ProcessDragDropResponse(
                success=False,
                processed_files=[],
                rejected_files=[],
                message=error_msg,
            )
    
    def _extract_file_paths(self, event_data: DragDropEventData) -> list[str]:
        """Extract file paths from drag drop event data.
        
        Args:
            event_data: Drag drop event data
            
        Returns:
            list[str]: List of file paths
        """
        try:
            return list(event_data.files) if hasattr(event_data, "files") and event_data.files else []
        except Exception:
            return []
    
    def _filter_by_extensions(self, file_paths: list[str], allowed_extensions: list[str]) -> list[str]:
        """Filter file paths by allowed extensions.
        
        Args:
            file_paths: List of file paths to filter
            allowed_extensions: List of allowed file extensions
            
        Returns:
            list[str]: Filtered list of file paths
        """
        valid_files = []
        for file_path in file_paths:
            file_extension = file_path.lower().split(".")[-1] if "." in file_path else ""
            if file_extension in [ext.lower().lstrip(".") for ext in allowed_extensions]:
                valid_files.append(file_path)
        return valid_files


def create_process_drag_drop_use_case(
    processing_port: IDragDropProcessingPort,
) -> ProcessDragDropUseCase:
    """Factory function to create ProcessDragDropUseCase.
    
    Args:
        processing_port: Port for drag and drop processing operations
        
    Returns:
        ProcessDragDropUseCase: Configured use case instance
    """
    return ProcessDragDropUseCase(processing_port)