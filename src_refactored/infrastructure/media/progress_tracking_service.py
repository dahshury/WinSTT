"""Progress Tracking Service for media processing operations.

This module provides infrastructure services for tracking and calculating
progress during media processing operations with callback support.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from threading import Lock

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from src_refactored.domain.progress_management.value_objects.progress_state import (
    ProgressState,
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

    @property
    def percentage(self) -> float:
        """Get progress as percentage (0-100,
    )."""
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
    """Service for tracking progress during media processing operations."""

    # Signals
    progress_updated = pyqtSignal(float, str)  # percentage, message
    progress_started = pyqtSignal(str)  # message
    progress_completed = pyqtSignal(str)  # message
    progress_error = pyqtSignal(str)  # error_message

    def __init__(self,
progress_callback: Callable[[str, str | None, float | None, bool, bool | None], None] | None = (
    None):)
        """Initialize the progress tracking service.
        
        Args:
            progress_callback: Optional callback for progress updates
                              (message, filename, percentage, hold, reset)
        """
        super().__init__()
        self.progress_callback = progress_callback
        self._progress_info = ProgressInfo()
        self._lock = Lock()
        self._update_timer = QTimer()
        self._update_timer.timeout.connect(self._emit_progress_update)
        self._update_interval = 100  # milliseconds
        self._last_emitted_percentage = -1

    def start_progress(
    self,
    message: str,
    total: float = 100.0,
    filename: str | None = None) -> None:
        """Start progress tracking.
        
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
                state=ProgressState.create_processing(),
            )
            self._last_emitted_percentage = -1

        self.progress_started.emit(message)

        if self.progress_callback:
            self.progress_callback(message, filename, 0.0, True, None)

        # Start update timer
        if not self._update_timer.isActive():
            self._update_timer.start(self._update_interval)

    def update_progress(
    self,
    current: float,
    message: str | None = None,
    filename: str | None = None) -> None:
        """Update progress value.
        
        Args:
            current: Current progress value
            message: Optional updated message
            filename: Optional updated filename
        """
        with self._lock:
            if not self._progress_info.state.is_active():
                return

            self._progress_info.current = current
            self._progress_info.last_update = time.time()

            if message is not None:
                self._progress_info.message = message

            if filename is not None:
                self._progress_info.filename = filename

    def update_progress_percentage(self,
    percentage: float, message: str | None = None, filename: str | None = None) -> None:
        """Update progress by percentage.
        
        Args:
            percentage: Progress percentage (0-100)
            message: Optional updated message
            filename: Optional updated filename
        """
        current = (percentage / 100.0) * self._progress_info.total
        self.update_progress(current, message, filename)

    def complete_progress(self, message: str | None = None) -> None:
        """Complete progress tracking.
        
        Args:
            message: Optional completion message
        """
        with self._lock:
            if self._progress_info.state.is_completed():
                return

            self._progress_info.current = self._progress_info.total
            self._progress_info.state = ProgressState.create_completed()

            if message is not None:
                self._progress_info.message = message

        # Stop update timer
        if self._update_timer.isActive():
            self._update_timer.stop()

        # Emit final update
        self._emit_progress_update()

        completion_message = message or self._progress_info.message
        self.progress_completed.emit(completion_message)

        if self.progress_callback:
            self.progress_callback(completion_message, self._progress_info.filename, 100.0, False, None)

    def error_progress(self, error_message: str,
    ) -> None:
        """Mark progress as error.
        
        Args:
            error_message: Error description
        """
        with self._lock:
            self._progress_info.state = ProgressState.create_error(error_message)
            self._progress_info.message = error_message

        # Stop update timer
        if self._update_timer.isActive():
            self._update_timer.stop()

        self.progress_error.emit(error_message)

        if self.progress_callback:
            self.progress_callback(error_message, self._progress_info.filename, None, True, None)

    def pause_progress(self) -> None:
        """Pause progress tracking."""
        with self._lock:
            if self._progress_info.state.is_active():
self._progress_info.state = (
    ProgressState.create_idle()  # Using idle as paused equivalent)

        # Stop update timer
        if self._update_timer.isActive():
            self._update_timer.stop()

    def resume_progress(self) -> None:
        """Resume progress tracking."""
        with self._lock:
            if self._progress_info.state.is_idle():
                self._progress_info.state = ProgressState.create_processing()

        # Start update timer
        if not self._update_timer.isActive():
            self._update_timer.start(self._update_interval)

    def reset_progress(self) -> None:
        """Reset progress tracking."""
        with self._lock:
            self._progress_info = ProgressInfo()
            self._last_emitted_percentage = -1

        # Stop update timer
        if self._update_timer.isActive():
            self._update_timer.stop()

        if self.progress_callback:
            self.progress_callback("", None, None, False, True)

    def get_progress_info(self) -> ProgressInfo:
        """Get current progress information.
        
        Returns:
            Copy of current progress information
        """
        with self._lock:
            return ProgressInfo(
                current=self._progress_info.current,
                total=self._progress_info.total,
                message=self._progress_info.message,
                filename=self._progress_info.filename,
                start_time=self._progress_info.start_time,
                last_update=self._progress_info.last_update,
                state=self._progress_info.state,
            )

    def update_progress_bar_safely(self, progress_bar: QProgressBar, message_text: str, progress_value: float,
    ) -> None:
        """Update progress bar and message text safely to avoid recursive repaint.
        
        Args:
            progress_bar: QProgressBar widget to update
            message_text: Message to display
            progress_value: Progress value (0-100)
        """
        if not progress_bar.isVisible():
            progress_bar.setVisible(True)

        # Update progress bar value without animation
        progress_bar.blockSignals(True)
        progress_bar.setProperty("value", int(progress_value))
        progress_bar.blockSignals(False)

        # Display message without triggering further updates
        if message_text and self.progress_callback:
            self.progress_callback(message_text, None, progress_value, True, None)

    def set_update_interval(self, interval_ms: int,
    ) -> None:
        """Set the progress update interval.
        
        Args:
            interval_ms: Update interval in milliseconds
        """
        self._update_interval = max(50, interval_ms)  # Minimum 50ms

        if self._update_timer.isActive():
            self._update_timer.stop()
            self._update_timer.start(self._update_interval)

    def _emit_progress_update(self) -> None:
        """Emit progress update signal if percentage changed significantly."""
        with self._lock:
            current_percentage = self._progress_info.percentage

            # Only emit if percentage changed by at least 1% or state changed
            if (abs(current_percentage - self._last_emitted_percentage,
    ) >= 1.0 or
                self._progress_info.state in [ProgressState.COMPLETED, ProgressState.ERROR]):

                self._last_emitted_percentage = current_percentage
                message = self._progress_info.message

        # Emit signal outside of lock
        self.progress_updated.emit(current_percentage, message)


class ProgressTrackingManager:
    """High-level manager for progress tracking operations."""

    def __init__(self):
        self._services: dict[str, ProgressTrackingService] = {}

    def create_tracker(self, tracker_id: str,
                      progress_callback: Callable[[str,
str | None, float | None, bool, bool | None], None] | None = (
    None) -> ProgressTrackingService:)
        """Create a new progress tracker.
        
        Args:
            tracker_id: Unique identifier for the tracker
            progress_callback: Optional progress callback
            
        Returns:
            New ProgressTrackingService instance
        """
        service = ProgressTrackingService(progress_callback)
        self._services[tracker_id] = service
        return service

    def get_tracker(self, tracker_id: str,
    ) -> ProgressTrackingService | None:
        """Get an existing progress tracker.
        
        Args:
            tracker_id: Tracker identifier
            
        Returns:
            ProgressTrackingService or None if not found
        """
        return self._services.get(tracker_id)

    def remove_tracker(self, tracker_id: str,
    ) -> None:
        """Remove a progress tracker.
        
        Args:
            tracker_id: Tracker identifier
        """
        if tracker_id in self._services:
            service = self._services[tracker_id]
            service.reset_progress()
            del self._services[tracker_id]

    def get_all_progress_info(self,
    ) -> dict[str, ProgressInfo]:
        """Get progress information for all trackers.
        
        Returns:
            Dictionary mapping tracker IDs to progress information
        """
        return {tracker_id: service.get_progress_info()
                for tracker_id, service in self._services.items()}

    def reset_all_trackers(self) -> None:
        """Reset all progress trackers."""
        for service in self._services.values():
            service.reset_progress()
        self._services.clear()