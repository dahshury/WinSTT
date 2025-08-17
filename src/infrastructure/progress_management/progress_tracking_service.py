"""Consolidated Progress Tracking Service.

This service provides comprehensive progress tracking functionality combining:
- Media processing progress tracking (from media/progress_tracking_service.py)
- General progress tracking with callbacks (from progress_management/progress_tracking_service.py)
- Audio recording progress tracking (from audio/progress_tracking_service.py)
"""

import contextlib
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from threading import Lock

from PyQt6.QtCore import QObject, QTimer, pyqtSignal
from PyQt6.QtWidgets import QProgressBar

from src.domain.audio.value_objects.recording_operation import RecordingOperation
from src.domain.progress_management.value_objects.progress_state import (
    ProgressState,
    ProgressStateType,
    ProgressType,
)


@dataclass
class ProgressInfo:
    """Information about progress tracking."""
    current: float = 0.0
    total: float = 100.0
    message: str = ""
    filename: str | None = None
    start_time: float = field(default_factory=time.time)
    last_update: float = field(default_factory=time.time)
    state: ProgressState = field(default_factory=ProgressState.create_idle)
    progress_type: ProgressType = ProgressType.GENERAL
    is_completed: bool = False
    error: str | None = None

    @property
    def percentage(self) -> float:
        """Get progress as percentage (0-100)."""
        if self.total <= 0:
            return 0.0
        return min(100.0, max(0.0, (self.current / self.total) * 100.0))

    @property
    def elapsed_time(self) -> float:
        """Get elapsed time in seconds."""
        return time.time() - self.start_time

    @property
    def estimated_remaining(self) -> float | None:
        """Estimate remaining time in seconds."""
        if self.percentage <= 0:
            return None

        elapsed = self.elapsed_time
        if elapsed <= 0:
            return None

        total_estimated = elapsed / (self.percentage / 100.0)
        return max(0, total_estimated - elapsed)


class ProgressTrackingError(Exception):
    """Exception raised for progress tracking errors."""


class ProgressTrackingService(QObject):
    """Consolidated service for tracking progress across all operations.
    
    This service combines functionality from:
    - Media processing progress tracking
    - General progress tracking with callbacks
    - Audio recording progress tracking
    """

    # Signals for different types of progress updates
    progress_updated = pyqtSignal(float, str)  # percentage, message (media)
    progress_started = pyqtSignal(str)  # message (media)
    progress_completed = pyqtSignal(str)  # message (media)
    progress_error = pyqtSignal(str)  # error_message (media)
    
    # Signals for general progress tracking
    general_progress_updated = pyqtSignal(str, int)  # progress_id, percentage
    general_progress_completed = pyqtSignal(str)  # progress_id
    general_progress_failed = pyqtSignal(str, str)  # progress_id, error_message
    general_progress_started = pyqtSignal(str, str)  # progress_id, description

    def __init__(self,
                 progress_callback: Callable[[str, str | None, float | None, bool, bool | None], None] | None = None):
        """Initialize the consolidated progress tracking service.
        
        Args:
            progress_callback: Optional callback for progress updates
                              (message, filename, percentage, hold, reset)
        """
        super().__init__()
        
        # Media progress tracking
        self.progress_callback = progress_callback
        self._progress_info = ProgressInfo()
        self._lock = Lock()
        self._update_timer = QTimer()
        self._update_timer.timeout.connect(self._emit_progress_update)
        self._update_interval = 100  # milliseconds
        self._last_emitted_percentage = -1
        
        # General progress tracking
        self.active_progress: dict[str, ProgressInfo] = {}
        self.progress_bars: dict[str, QProgressBar] = {}
        self.completion_callbacks: dict[str, Callable] = {}
        self.update_callbacks: dict[str, Callable] = {}
        self.error_callbacks: dict[str, Callable] = {}
        
        # Audio recording progress tracking
        self._current_operation: RecordingOperation | None = None
        self._current_progress = 0.0
        self._recording_callbacks: list[Callable] = []

    # Media Progress Tracking Methods
    def start_progress(
        self,
        message: str,
        total: float = 100.0,
        filename: str | None = None,
    ) -> None:
        """Start progress tracking for media operations.
        
        Args:
            message: Progress message
            total: Total progress value
            filename: Optional filename being processed
        """
        with self._lock:
            self._progress_info = ProgressInfo(
                current=0.0,
                total=total,
                message=message,
                filename=filename,
                start_time=time.time(),
                last_update=time.time(),
                state=ProgressState.create_processing(),
            )
            self._last_emitted_percentage = -1

        self.progress_started.emit(message)
        
        if self.progress_callback:
            with contextlib.suppress(Exception):
                self.progress_callback(message, filename, 0.0, False, True)

        if not self._update_timer.isActive():
            self._update_timer.start(self._update_interval)

    def update_progress(
        self,
        current: float | None = None,
        message: str | None = None,
        filename: str | None = None,
    ) -> None:
        """Update progress for media operations.
        
        Args:
            current: Current progress value
            message: Optional progress message
            filename: Optional filename being processed
        """
        with self._lock:
            if current is not None:
                self._progress_info.current = max(0.0, min(self._progress_info.total, current))
            
            if message is not None:
                self._progress_info.message = message
                
            if filename is not None:
                self._progress_info.filename = filename
                
            self._progress_info.last_update = time.time()

    def complete_progress(self, message: str | None = None) -> None:
        """Complete progress tracking for media operations.
        
        Args:
            message: Optional completion message
        """
        with self._lock:
            if message:
                self._progress_info.message = message
            self._progress_info.current = self._progress_info.total
            self._progress_info.state = ProgressState.create_completed()
            self._progress_info.is_completed = True

        self._emit_progress_update()
        self.progress_completed.emit(message or "Completed")
        
        if self.progress_callback:
            with contextlib.suppress(Exception):
                self.progress_callback(message or "Completed", None, 100.0, False, False)

        self._update_timer.stop()

    def fail_progress(self, error_message: str) -> None:
        """Fail progress tracking for media operations.
        
        Args:
            error_message: Error description
        """
        with self._lock:
            self._progress_info.error = error_message
            self._progress_info.state = ProgressState.create_error(error_message)
            self._progress_info.is_completed = True

        self.progress_error.emit(error_message)
        self._update_timer.stop()

    def _emit_progress_update(self) -> None:
        """Emit progress update signal."""
        with self._lock:
            percentage = self._progress_info.percentage
            message = self._progress_info.message
            
            # Only emit if percentage changed significantly
            if abs(percentage - self._last_emitted_percentage) >= 1.0 or self._progress_info.is_completed:
                self._last_emitted_percentage = int(percentage)
                self.progress_updated.emit(percentage, message)

    # General Progress Tracking Methods
    def start_general_progress(
        self,
        progress_id: str,
        description: str,
        progress_type: ProgressType = ProgressType.GENERAL,
        max_value: int = 100,
    ) -> None:
        """Start tracking progress for a general operation.
        
        Args:
            progress_id: Unique identifier for this progress
            description: Human-readable description of the operation
            progress_type: Type of progress being tracked
            max_value: Maximum value for progress (default 100 for percentage)
        """
        self.active_progress[progress_id] = ProgressInfo(
            current=0,
            total=max_value,
            message=description,
            progress_type=progress_type,
            state=ProgressState.create_processing(),
        )

        self.general_progress_started.emit(progress_id, description)

    def update_general_progress(
        self,
        progress_id: str,
        current_value: int | None = None,
        percentage: int | None = None,
        message: str | None = None,
    ) -> bool:
        """Update progress for a general operation.
        
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
            progress_info.current = (percentage / 100) * progress_info.total
        elif current_value is not None:
            progress_info.current = current_value

        # Update message if provided
        if message:
            progress_info.message = message

        progress_info.last_update = time.time()

        # Update associated progress bar
        if progress_id in self.progress_bars:
            try:
                progress_bar = self.progress_bars[progress_id]
                progress_bar.setValue(int(progress_info.percentage))
            except RuntimeError:
                # Progress bar has been deleted, remove reference
                del self.progress_bars[progress_id]

        # Call update callback if registered
        if progress_id in self.update_callbacks:
            with contextlib.suppress(Exception):
                self.update_callbacks[progress_id](int(progress_info.percentage), message)

        # Emit progress signal
        self.general_progress_updated.emit(progress_id, int(progress_info.percentage))

        # Check for completion
        if progress_info.percentage >= 100:
            self.complete_general_progress(progress_id)

        return True

    def complete_general_progress(self, progress_id: str, success_message: str | None = None) -> bool:
        """Mark general progress as completed.
        
        Args:
            progress_id: Unique identifier for the progress
            success_message: Optional completion message
            
        Returns:
            True if completion was successful, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        progress_info = self.active_progress[progress_id]
        progress_info.is_completed = True
        progress_info.current = progress_info.total
        progress_info.state = ProgressState.create_completed()

        if success_message:
            progress_info.message = success_message

        # Update progress bar to 100%
        if progress_id in self.progress_bars:
            try:
                progress_bar = self.progress_bars[progress_id]
                progress_bar.setValue(100)
            except RuntimeError:
                del self.progress_bars[progress_id]

        # Call completion callback if registered
        if progress_id in self.completion_callbacks:
            with contextlib.suppress(Exception):
                self.completion_callbacks[progress_id](success_message)

        # Emit completion signal
        self.general_progress_completed.emit(progress_id)

        # Clean up
        self._cleanup_progress(progress_id)

        return True

    def fail_general_progress(self, progress_id: str, error_message: str) -> bool:
        """Mark general progress as failed.
        
        Args:
            progress_id: Unique identifier for the progress
            error_message: Error description
            
        Returns:
            True if failure was recorded, False if progress not found
        """
        if progress_id not in self.active_progress:
            return False

        progress_info = self.active_progress[progress_id]
        progress_info.error = error_message
        progress_info.is_completed = True
        progress_info.state = ProgressState.create_error(error_message)

        # Call error callback if registered
        if progress_id in self.error_callbacks:
            with contextlib.suppress(Exception):
                self.error_callbacks[progress_id](error_message)

        # Emit failure signal
        self.general_progress_failed.emit(progress_id, error_message)

        # Clean up
        self._cleanup_progress(progress_id)

        return True

    # Audio Recording Progress Tracking Methods
    def start_recording_progress(self, operation: RecordingOperation) -> None:
        """Start progress tracking for recording operations.
        
        Args:
            operation: Recording operation to track
        """
        self._current_operation = operation
        self._current_progress = 0.0

    def update_recording_progress(self, operation: RecordingOperation, progress: float) -> None:
        """Update progress for recording operation.
        
        Args:
            operation: Recording operation
            progress: Progress value (0-100)
        """
        if self._current_operation == operation:
            self._current_progress = max(0.0, min(100.0, progress))
            
            # Notify callbacks
            for callback in self._recording_callbacks:
                try:
                    callback(operation, self._current_progress)
                except Exception:
                    # Continue with other callbacks even if one fails
                    pass

    def complete_recording_progress(self) -> None:
        """Complete recording progress tracking."""
        if self._current_operation:
            self.update_recording_progress(self._current_operation, 100.0)
            self._current_operation = None
            self._current_progress = 0.0

    def add_recording_callback(self, callback: Callable) -> None:
        """Add a recording progress callback.
        
        Args:
            callback: Callback function to add
        """
        if callback not in self._recording_callbacks:
            self._recording_callbacks.append(callback)

    def remove_recording_callback(self, callback: Callable) -> None:
        """Remove a recording progress callback.
        
        Args:
            callback: Callback function to remove
        """
        if callback in self._recording_callbacks:
            self._recording_callbacks.remove(callback)

    # Utility Methods
    def register_progress_bar(self, progress_id: str, progress_bar: QProgressBar) -> None:
        """Register a progress bar for automatic updates.
        
        Args:
            progress_id: Progress identifier
            progress_bar: QProgressBar widget to update
        """
        self.progress_bars[progress_id] = progress_bar

    def register_completion_callback(self, progress_id: str, callback: Callable) -> None:
        """Register a completion callback.
        
        Args:
            progress_id: Progress identifier
            callback: Callback function
        """
        self.completion_callbacks[progress_id] = callback

    def register_update_callback(self, progress_id: str, callback: Callable) -> None:
        """Register an update callback.
        
        Args:
            progress_id: Progress identifier
            callback: Callback function
        """
        self.update_callbacks[progress_id] = callback

    def register_error_callback(self, progress_id: str, callback: Callable) -> None:
        """Register an error callback.
        
        Args:
            progress_id: Progress identifier
            callback: Callback function
        """
        self.error_callbacks[progress_id] = callback

    def get_progress_info(self, progress_id: str | None = None) -> ProgressInfo | None:
        """Get progress information.
        
        Args:
            progress_id: Optional progress identifier. If None, returns media progress info.
            
        Returns:
            Progress information or None if not found
        """
        if progress_id is None:
            with self._lock:
                return self._progress_info
        
        return self.active_progress.get(progress_id)

    def is_active(self, progress_id: str | None = None) -> bool:
        """Check if progress is active.
        
        Args:
            progress_id: Optional progress identifier. If None, checks media progress.
            
        Returns:
            True if progress is active
        """
        if progress_id is None:
            with self._lock:
                return not self._progress_info.is_completed and self._progress_info.state.state_type in {ProgressStateType.DOWNLOADING, ProgressStateType.MOVING, ProgressStateType.PROCESSING}
        
        progress_info = self.active_progress.get(progress_id)
        return progress_info is not None and not progress_info.is_completed

    def _cleanup_progress(self, progress_id: str) -> None:
        """Clean up progress tracking data.
        
        Args:
            progress_id: Progress identifier to clean up
        """
        # Remove from active progress
        if progress_id in self.active_progress:
            del self.active_progress[progress_id]
        
        # Remove progress bar reference
        if progress_id in self.progress_bars:
            del self.progress_bars[progress_id]
        
        # Remove callbacks
        if progress_id in self.completion_callbacks:
            del self.completion_callbacks[progress_id]
        
        if progress_id in self.update_callbacks:
            del self.update_callbacks[progress_id]
        
        if progress_id in self.error_callbacks:
            del self.error_callbacks[progress_id]

    def cleanup_all(self) -> None:
        """Clean up all progress tracking data."""
        # Stop timers
        if self._update_timer.isActive():
            self._update_timer.stop()
        
        # Clear all data
        self.active_progress.clear()
        self.progress_bars.clear()
        self.completion_callbacks.clear()
        self.update_callbacks.clear()
        self.error_callbacks.clear()
        self._recording_callbacks.clear()
        
        # Reset media progress
        with self._lock:
            self._progress_info = ProgressInfo()
            self._last_emitted_percentage = -1
        
        # Reset recording progress
        self._current_operation = None
        self._current_progress = 0.0