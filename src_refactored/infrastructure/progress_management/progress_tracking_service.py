"""Progress Tracking Service for progress monitoring and callbacks.

This service provides centralized progress tracking functionality with percentage calculation,
extracted from settings_dialog.py (lines 1187-1208).
"""

from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QProgressBar

from src_refactored.domain.progress_management.value_objects.progress_state import (
    ProgressType,
)


class ProgressTrackingService(QObject):
    """Service for tracking progress with percentage calculation and callbacks.
    
    Extracted from settings_dialog.py progress tracking patterns.
    """

    # Signals for progress updates
    progress_updated = pyqtSignal(str, int)  # progress_id, percentage
    progress_completed = pyqtSignal(str)  # progress_id
    progress_failed = pyqtSignal(str, str)  # progress_id, error_message
    progress_started = pyqtSignal(str, str)  # progress_id, description

    def __init__(self):
        """Initialize the progress tracking service."""
        super().__init__()
        self.active_progress: dict[str, dict[str, Any]] = {}
        self.progress_bars: dict[str, QProgressBar] = {}
        self.completion_callbacks: dict[str, Callable] = {}
        self.update_callbacks: dict[str, Callable] = {}
        self.error_callbacks: dict[str, Callable] = {}

    def start_progress(self, progress_id: str, description: str,
                      progress_type: ProgressType = ProgressType.GENERAL,
                      max_value: int = 100) -> None:
        """Start tracking progress for a specific operation.
        
        Args:
            progress_id: Unique identifier for this progress
            description: Human-readable description of the operation
            progress_type: Type of progress being tracked
            max_value: Maximum value for progress (default 100 for percentage,
    )
        """
        self.active_progress[progress_id] = {
            "description": description,
            "type": progress_type,
            "current_value": 0,
            "max_value": max_value,
            "percentage": 0,
            "is_completed": False,
            "error": None,
        }

        self.progress_started.emit(progress_id, description)

    def update_progress(self, progress_id: str, current_value: int | None = None,
                       percentage: int | None = None,
                       message: str | None = None) -> bool:
        """Update progress for a specific operation.
        
        Args:
            progress_id: Unique identifier for the progress
            current_value: Current progress value
            percentage: Direct percentage value (0-100)
            message: Optional progress message
            
        Returns:
            True if update was successful, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        progress_info = self.active_progress[progress_id]

        # Update current value or percentage
        if percentage is not None:
            progress_info["percentage"] = max(0, min(100, percentage))
            progress_info["current_value"] = int((percentage / 100) * progress_info["max_value"])
        elif current_value is not None:
            progress_info["current_value"] = current_value
            progress_info["percentage"] = int((current_value / progress_info["max_value"]) * 100)

        # Update message if provided
        if message:
            progress_info["message"] = message

        # Update associated progress bar
        if progress_id in self.progress_bars:
            try:
                progress_bar = self.progress_bars[progress_id]
                progress_bar.setValue(progress_info["percentage"],
    )
            except RuntimeError:
                # Progress bar has been deleted, remove reference
                del self.progress_bars[progress_id]

        # Call update callback if registered
        if progress_id in self.update_callbacks:
            try:
                self.update_callbacks[progress_id](progress_info["percentage"], message)
            except Exception:
                # Log error but don't fail the update
                pass

        # Emit progress signal
        self.progress_updated.emit(progress_id, progress_info["percentage"])

        # Check for completion
        if progress_info["percentage"] >= 100:
            self.complete_progress(progress_id)

        return True

    def complete_progress(self, progress_id: str, success_message: str | None = None) -> bool:
        """Mark progress as completed.
        
        Args:
            progress_id: Unique identifier for the progress
            success_message: Optional completion message
            
        Returns:
            True if completion was successful, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        progress_info = self.active_progress[progress_id]
        progress_info["is_completed"] = True
        progress_info["percentage"] = 100

        if success_message:
            progress_info["message"] = success_message

        # Update progress bar to 100%
        if progress_id in self.progress_bars:
            try:
                progress_bar = self.progress_bars[progress_id]
                progress_bar.setValue(100,
    )
            except RuntimeError:
                # Progress bar has been deleted, remove reference
                del self.progress_bars[progress_id]

        # Call completion callback if registered
        if progress_id in self.completion_callbacks:
            try:
                self.completion_callbacks[progress_id](success_message)
            except Exception:
                # Log error but don't fail the completion
                pass

        # Emit completion signal
        self.progress_completed.emit(progress_id)

        # Clean up
        self._cleanup_progress(progress_id)

        return True

    def fail_progress(self, progress_id: str, error_message: str,
    ) -> bool:
        """Mark progress as failed.
        
        Args:
            progress_id: Unique identifier for the progress
            error_message: Error description
            
        Returns:
            True if failure was recorded, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        progress_info = self.active_progress[progress_id]
        progress_info["error"] = error_message
        progress_info["is_completed"] = True

        # Call error callback if registered
        if progress_id in self.error_callbacks:
            try:
                self.error_callbacks[progress_id](error_message)
            except Exception:
                # Log error but don't fail the failure handling
                pass

        # Emit failure signal
        self.progress_failed.emit(progress_id, error_message)

        # Clean up
        self._cleanup_progress(progress_id)

        return True

    def register_progress_bar(self, progress_id: str, progress_bar: QProgressBar,
    ) -> None:
        """Register a progress bar to be updated automatically.
        
        Args:
            progress_id: Unique identifier for the progress
            progress_bar: Progress bar widget to update
        """
        self.progress_bars[progress_id] = progress_bar

        # Set initial values if progress already exists
        if progress_id in self.active_progress:
            try:
                progress_bar.setValue(self.active_progress[progress_id]["percentage"])
            except RuntimeError:
                # Progress bar has been deleted
                pass

    def unregister_progress_bar(self, progress_id: str,
    ) -> None:
        """Unregister a progress bar.
        
        Args:
            progress_id: Unique identifier for the progress
        """
        if progress_id in self.progress_bars:
            del self.progress_bars[progress_id]

    def register_completion_callback(
    self,
    progress_id: str,
    callback: Callable[[str | None],
    None]) -> None:
        """Register a callback to be called when progress completes.
        
        Args:
            progress_id: Unique identifier for the progress
            callback: Function to call on completion (receives success message)
        """
        self.completion_callbacks[progress_id] = callback

    def register_update_callback(
    self,
    progress_id: str,
    callback: Callable[[int,
    str | None],
    None]) -> None:
        """Register a callback to be called on progress updates.
        
        Args:
            progress_id: Unique identifier for the progress
            callback: Function to call on updates (receives percentage and message)
        """
        self.update_callbacks[progress_id] = callback

    def register_error_callback(self, progress_id: str, callback: Callable[[str], None]) -> None:
        """Register a callback to be called on progress errors.
        
        Args:
            progress_id: Unique identifier for the progress
            callback: Function to call on error (receives error message)
        """
        self.error_callbacks[progress_id] = callback

    def get_progress_info(self, progress_id: str,
    ) -> dict[str, Any] | None:
        """Get current progress information.
        
        Args:
            progress_id: Unique identifier for the progress
            
        Returns:
            Progress information dictionary or None if not found
        """
        return self.active_progress.get(progress_id)

    def get_progress_percentage(self, progress_id: str,
    ) -> int | None:
        """Get current progress percentage.
        
        Args:
            progress_id: Unique identifier for the progress
            
        Returns:
            Current percentage (0-100) or None if not found
        """
        if progress_id in self.active_progress:
            return self.active_progress[progress_id]["percentage"]
        return None

    def is_progress_active(self, progress_id: str,
    ) -> bool:
        """Check if progress is currently active.
        
        Args:
            progress_id: Unique identifier for the progress
            
        Returns:
            True if progress is active, False otherwise
        """
        return progress_id in self.active_progress and
    not self.active_progress[progress_id]["is_completed"]

    def cancel_progress(self, progress_id: str,
    ) -> bool:
        """Cancel an active progress operation.
        
        Args:
            progress_id: Unique identifier for the progress
            
        Returns:
            True if cancellation was successful, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        self.fail_progress(progress_id, "Operation cancelled")
        return True

    def get_active_progress_ids(self) -> list[str]:
        """Get list of all active progress IDs.
        
        Returns:
            List of active progress identifiers
        """
        return [pid for pid, info in self.active_progress.items() if not info["is_completed"]]

    def _cleanup_progress(self, progress_id: str,
    ) -> None:
        """Clean up progress tracking resources.
        
        Args:
            progress_id: Unique identifier for the progress
        """
        # Remove from active progress after a delay to allow final callbacks
        if progress_id in self.active_progress:
            del self.active_progress[progress_id]

        # Clean up callbacks
        if progress_id in self.completion_callbacks:
            del self.completion_callbacks[progress_id]
        if progress_id in self.update_callbacks:
            del self.update_callbacks[progress_id]
        if progress_id in self.error_callbacks:
            del self.error_callbacks[progress_id]

        # Keep progress bar reference for potential reuse
        # It will be cleaned up when unregistered or widget is deleted

    def cleanup_all(self) -> None:
        """Clean up all progress tracking resources."""
        self.active_progress.clear()
        self.progress_bars.clear()
        self.completion_callbacks.clear()
        self.update_callbacks.clear()
        self.error_callbacks.clear()

    def handle_model_message(self, progress_id: str, txt: str | None = None,
                           filename: str | None = None, percentage: int | None = None,
                           hold: bool = False, reset: bool | None = None) -> None:
        """Handle model worker messages (extracted from settings_dialog.py).
        
        Args:
            progress_id: Unique identifier for the progress
            txt: Text message
            filename: Filename being processed
            percentage: Progress percentage
            hold: Whether to hold the progress
            reset: Whether to reset the progress
        """
        if reset:
            if progress_id in self.active_progress:
                self.cancel_progress(progress_id)
            return

        if percentage is not None:
            # Update progress
            message = txt or (f"Processing {filename}" if filename else None)
            self.update_progress(progress_id, percentage=percentage, message=message)