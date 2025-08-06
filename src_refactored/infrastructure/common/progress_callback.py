"""Progress Callback Infrastructure.

This module provides progress callback interfaces and implementations for non-blocking operations
in the WinSTT application, enabling real-time progress reporting and user feedback.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from threading import Lock
from typing import Any, Protocol

from PyQt6.QtCore import QObject, QTimer, pyqtSignal
from PyQt6.QtWidgets import QLabel, QProgressBar

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class ProgressStatus(Enum):
    """Enumeration of progress statuses."""
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


class ProgressType(Enum):
    """Enumeration of progress types."""
    DETERMINATE = "determinate"  # Known total amount
    INDETERMINATE = "indeterminate"  # Unknown total amount
    STEPPED = "stepped"  # Discrete steps
    CONTINUOUS = "continuous"  # Continuous progress


@dataclass(frozen=True)
class ProgressInfo(ValueObject):
    """Value object representing progress information."""
    current: float
    total: float
    percentage: float
    status: ProgressStatus
    message: str = ""
    details: str = ""
    elapsed_time: timedelta = field(default_factory=lambda: timedelta())
    estimated_remaining: timedelta | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def _get_equality_components(self) -> tuple:
        return (
            self.current,
            self.total,
            self.percentage,
            self.status,
            self.message,
            self.details,
            self.elapsed_time,
            self.estimated_remaining,
            tuple(sorted(self.metadata.items())),
        )
    
    @classmethod
    def create(cls, current: float, total: float, status: ProgressStatus = ProgressStatus.IN_PROGRESS,
               message: str = "", details: str = "", **kwargs) -> "ProgressInfo":
        """Create progress info with calculated percentage.
        
        Args:
            current: Current progress value
            total: Total progress value
            status: Progress status
            message: Progress message
            details: Progress details
            **kwargs: Additional metadata
            
        Returns:
            ProgressInfo instance
        """
        percentage = (current / total * 100) if total > 0 else 0
        percentage = max(0, min(100, percentage))  # Clamp to 0-100
        
        return cls(
            current=current,
            total=total,
            percentage=percentage,
            status=status,
            message=message,
            details=details,
            metadata=kwargs,
        )
    
    def is_complete(self) -> bool:
        """Check if progress is complete.
        
        Returns:
            True if progress is complete
        """
        return self.status == ProgressStatus.COMPLETED or self.percentage >= 100
    
    def is_failed(self) -> bool:
        """Check if progress failed.
        
        Returns:
            True if progress failed
        """
        return self.status == ProgressStatus.FAILED
    
    def is_cancelled(self) -> bool:
        """Check if progress was cancelled.
        
        Returns:
            True if progress was cancelled
        """
        return self.status == ProgressStatus.CANCELLED
    
    def with_message(self, message: str) -> "ProgressInfo":
        """Create new progress info with updated message.
        
        Args:
            message: New message
            
        Returns:
            New ProgressInfo instance
        """
        return ProgressInfo(
            current=self.current,
            total=self.total,
            percentage=self.percentage,
            status=self.status,
            message=message,
            details=self.details,
            elapsed_time=self.elapsed_time,
            estimated_remaining=self.estimated_remaining,
            metadata=self.metadata,
        )
    
    def with_details(self, details: str) -> "ProgressInfo":
        """Create new progress info with updated details.
        
        Args:
            details: New details
            
        Returns:
            New ProgressInfo instance
        """
        return ProgressInfo(
            current=self.current,
            total=self.total,
            percentage=self.percentage,
            status=self.status,
            message=self.message,
            details=details,
            elapsed_time=self.elapsed_time,
            estimated_remaining=self.estimated_remaining,
            metadata=self.metadata,
        )


class IProgressCallback(Protocol):
    """Protocol for progress callbacks."""
    
    def report_progress(self, progress: ProgressInfo) -> None:
        """Report progress.
        
        Args:
            progress: Progress information
        """
        ...
    
    def report_error(self, error: str, details: str = "") -> None:
        """Report an error.
        
        Args:
            error: Error message
            details: Error details
        """
        ...
    
    def report_completion(self, message: str = "", details: str = "") -> None:
        """Report completion.
        
        Args:
            message: Completion message
            details: Completion details
        """
        ...
    
    def report_cancellation(self, message: str = "") -> None:
        """Report cancellation.
        
        Args:
            message: Cancellation message
        """
        ...


class IProgressTracker(Protocol):
    """Protocol for progress tracking."""
    
    def start_tracking(self, total: float, progress_type: ProgressType = ProgressType.DETERMINATE) -> None:
        """Start progress tracking.
        
        Args:
            total: Total progress amount
            progress_type: Type of progress tracking
        """
        ...
    
    def update_progress(self, current: float, message: str = "", details: str = "") -> None:
        """Update progress.
        
        Args:
            current: Current progress value
            message: Progress message
            details: Progress details
        """
        ...
    
    def increment_progress(self, amount: float = 1, message: str = "", details: str = "") -> None:
        """Increment progress by amount.
        
        Args:
            amount: Amount to increment
            message: Progress message
            details: Progress details
        """
        ...
    
    def finish_tracking(self, message: str = "", details: str = "") -> None:
        """Finish progress tracking.
        
        Args:
            message: Completion message
            details: Completion details
        """
        ...
    
    def cancel_tracking(self, message: str = "") -> None:
        """Cancel progress tracking.
        
        Args:
            message: Cancellation message
        """
        ...


class ProgressCallback(QObject, IProgressCallback):
    """Base progress callback implementation with PyQt signals."""
    
    # Signals
    progress_updated = pyqtSignal(object)  # ProgressInfo
    error_occurred = pyqtSignal(str, str)  # error, details
    completed = pyqtSignal(str, str)  # message, details
    cancelled = pyqtSignal(str)  # message
    
    def __init__(self, callback_id: str | None = None):
        """Initialize progress callback.
        
        Args:
            callback_id: Optional callback identifier
        """
        super().__init__()
        self.callback_id = callback_id or f"callback_{id(self)}"
        self._lock = Lock()
        self._last_progress: ProgressInfo | None = None
        
        self.logger = logging.getLogger(__name__)
    
    def report_progress(self, progress: ProgressInfo) -> None:
        """Report progress.
        
        Args:
            progress: Progress information
        """
        with self._lock:
            self._last_progress = progress
            self.progress_updated.emit(progress)
            self.logger.debug(f"Progress reported: {progress.percentage:.1f}% - {progress.message}")
    
    def report_error(self, error: str, details: str = "") -> None:
        """Report an error.
        
        Args:
            error: Error message
            details: Error details
        """
        with self._lock:
            if self._last_progress:
                error_progress = ProgressInfo(
                    current=self._last_progress.current,
                    total=self._last_progress.total,
                    percentage=self._last_progress.percentage,
                    status=ProgressStatus.FAILED,
                    message=error,
                    details=details,
                    elapsed_time=self._last_progress.elapsed_time,
                    estimated_remaining=self._last_progress.estimated_remaining,
                    metadata=self._last_progress.metadata,
                )
                self._last_progress = error_progress
                self.progress_updated.emit(error_progress)
            
            self.error_occurred.emit(error, details)
            self.logger.error(f"Error reported: {error} - {details}")
    
    def report_completion(self, message: str = "", details: str = "") -> None:
        """Report completion.
        
        Args:
            message: Completion message
            details: Completion details
        """
        with self._lock:
            if self._last_progress:
                completion_progress = ProgressInfo(
                    current=self._last_progress.total,
                    total=self._last_progress.total,
                    percentage=100.0,
                    status=ProgressStatus.COMPLETED,
                    message=message or "Completed",
                    details=details,
                    elapsed_time=self._last_progress.elapsed_time,
                    estimated_remaining=timedelta(),
                    metadata=self._last_progress.metadata,
                )
                self._last_progress = completion_progress
                self.progress_updated.emit(completion_progress)
            
            self.completed.emit(message, details)
            self.logger.info(f"Completion reported: {message} - {details}")
    
    def report_cancellation(self, message: str = "") -> None:
        """Report cancellation.
        
        Args:
            message: Cancellation message
        """
        with self._lock:
            if self._last_progress:
                cancellation_progress = ProgressInfo(
                    current=self._last_progress.current,
                    total=self._last_progress.total,
                    percentage=self._last_progress.percentage,
                    status=ProgressStatus.CANCELLED,
                    message=message or "Cancelled",
                    details="",
                    elapsed_time=self._last_progress.elapsed_time,
                    estimated_remaining=None,
                    metadata=self._last_progress.metadata,
                )
                self._last_progress = cancellation_progress
                self.progress_updated.emit(cancellation_progress)
            
            self.cancelled.emit(message)
            self.logger.info(f"Cancellation reported: {message}")
    
    def get_last_progress(self) -> ProgressInfo | None:
        """Get the last reported progress.
        
        Returns:
            Last progress info or None
        """
        with self._lock:
            return self._last_progress


class ProgressTracker(QObject, IProgressTracker):
    """Progress tracker with automatic time estimation."""
    
    def __init__(self, callback: IProgressCallback, tracker_id: str | None = None):
        """Initialize progress tracker.
        
        Args:
            callback: Progress callback
            tracker_id: Optional tracker identifier
        """
        super().__init__()
        self.callback = callback
        self.tracker_id = tracker_id or f"tracker_{id(self)}"
        
        self._lock = Lock()
        self._total: float = 0
        self._current: float = 0
        self._start_time: datetime | None = None
        self._progress_type = ProgressType.DETERMINATE
        self._is_tracking = False
        
        self.logger = logging.getLogger(__name__)
    
    def start_tracking(self, total: float, progress_type: ProgressType = ProgressType.DETERMINATE) -> None:
        """Start progress tracking.
        
        Args:
            total: Total progress amount
            progress_type: Type of progress tracking
        """
        with self._lock:
            self._total = total
            self._current = 0
            self._start_time = datetime.now()
            self._progress_type = progress_type
            self._is_tracking = True
            
            initial_progress = ProgressInfo.create(
                current=0,
                total=total,
                status=ProgressStatus.IN_PROGRESS,
                message="Starting...",
            )
            
            self.callback.report_progress(initial_progress)
            self.logger.info(f"Started tracking progress: total={total}, type={progress_type.value}")
    
    def update_progress(self, current: float, message: str = "", details: str = "") -> None:
        """Update progress.
        
        Args:
            current: Current progress value
            message: Progress message
            details: Progress details
        """
        with self._lock:
            if not self._is_tracking:
                return
            
            self._current = current
            elapsed_time = datetime.now() - self._start_time if self._start_time else timedelta()
            
            # Calculate estimated remaining time
            estimated_remaining = None
            if self._progress_type == ProgressType.DETERMINATE and current > 0:
                progress_rate = current / elapsed_time.total_seconds() if elapsed_time.total_seconds() > 0 else 0
                if progress_rate > 0:
                    remaining_work = self._total - current
                    estimated_seconds = remaining_work / progress_rate
                    estimated_remaining = timedelta(seconds=estimated_seconds)
            
            progress = ProgressInfo(
                current=current,
                total=self._total,
                percentage=(current / self._total * 100) if self._total > 0 else 0,
                status=ProgressStatus.IN_PROGRESS,
                message=message,
                details=details,
                elapsed_time=elapsed_time,
                estimated_remaining=estimated_remaining,
            )
            
            self.callback.report_progress(progress)
    
    def increment_progress(self, amount: float = 1, message: str = "", details: str = "") -> None:
        """Increment progress by amount.
        
        Args:
            amount: Amount to increment
            message: Progress message
            details: Progress details
        """
        with self._lock:
            new_current = self._current + amount
            self.update_progress(new_current, message, details)
    
    def finish_tracking(self, message: str = "", details: str = "") -> None:
        """Finish progress tracking.
        
        Args:
            message: Completion message
            details: Completion details
        """
        with self._lock:
            if not self._is_tracking:
                return
            
            self._is_tracking = False
            self.callback.report_completion(message or "Completed successfully", details)
            self.logger.info(f"Finished tracking progress: {message}")
    
    def cancel_tracking(self, message: str = "") -> None:
        """Cancel progress tracking.
        
        Args:
            message: Cancellation message
        """
        with self._lock:
            if not self._is_tracking:
                return
            
            self._is_tracking = False
            self.callback.report_cancellation(message or "Operation cancelled")
            self.logger.info(f"Cancelled tracking progress: {message}")
    
    def is_tracking(self) -> bool:
        """Check if currently tracking progress.
        
        Returns:
            True if tracking is active
        """
        with self._lock:
            return self._is_tracking
    
    def get_current_progress(self) -> float:
        """Get current progress value.
        
        Returns:
            Current progress value
        """
        with self._lock:
            return self._current
    
    def get_total_progress(self) -> float:
        """Get total progress value.
        
        Returns:
            Total progress value
        """
        with self._lock:
            return self._total


class UIProgressCallback(ProgressCallback):
    """Progress callback that updates UI components."""
    
    def __init__(self, progress_bar: QProgressBar | None = None, status_label: QLabel | None = None, 
                 details_label: QLabel | None = None, callback_id: str | None = None):
        """Initialize UI progress callback.
        
        Args:
            progress_bar: Optional progress bar widget
            status_label: Optional status label widget
            details_label: Optional details label widget
            callback_id: Optional callback identifier
        """
        super().__init__(callback_id)
        
        self.progress_bar = progress_bar
        self.status_label = status_label
        self.details_label = details_label
        
        # Connect signals to UI update methods
        self.progress_updated.connect(self._update_ui)
        self.error_occurred.connect(self._update_error_ui)
        self.completed.connect(self._update_completion_ui)
        self.cancelled.connect(self._update_cancellation_ui)
    
    def _update_ui(self, progress: ProgressInfo) -> None:
        """Update UI components with progress.
        
        Args:
            progress: Progress information
        """
        try:
            if self.progress_bar:
                if progress.status == ProgressStatus.IN_PROGRESS:
                    self.progress_bar.setVisible(True)
                    self.progress_bar.setValue(int(progress.percentage))
                elif progress.status in [ProgressStatus.COMPLETED, ProgressStatus.FAILED, ProgressStatus.CANCELLED]:
                    self.progress_bar.setVisible(False)
            
            if self.status_label:
                self.status_label.setText(progress.message)
                
                # Set style based on status
                if progress.status == ProgressStatus.FAILED:
                    self.status_label.setStyleSheet("color: red;")
                elif progress.status == ProgressStatus.COMPLETED:
                    self.status_label.setStyleSheet("color: green;")
                elif progress.status == ProgressStatus.CANCELLED:
                    self.status_label.setStyleSheet("color: orange;")
                else:
                    self.status_label.setStyleSheet("")
            
            if self.details_label and progress.details:
                self.details_label.setText(progress.details)
                self.details_label.setVisible(True)
            elif self.details_label:
                self.details_label.setVisible(False)
                
        except Exception as e:
            self.logger.exception(f"Failed to update UI: {e}")
    
    def _update_error_ui(self, error: str, details: str) -> None:
        """Update UI for error state.
        
        Args:
            error: Error message
            details: Error details
        """
        try:
            if self.progress_bar:
                self.progress_bar.setVisible(False)
            
            if self.status_label:
                self.status_label.setText(f"Error: {error}")
                self.status_label.setStyleSheet("color: red;")
            
            if self.details_label and details:
                self.details_label.setText(details)
                self.details_label.setVisible(True)
                
        except Exception as e:
            self.logger.exception(f"Failed to update error UI: {e}")
    
    def _update_completion_ui(self, message: str, details: str) -> None:
        """Update UI for completion state.
        
        Args:
            message: Completion message
            details: Completion details
        """
        try:
            if self.progress_bar:
                self.progress_bar.setValue(100)
                # Hide progress bar after a delay
                QTimer.singleShot(2000, lambda: self.progress_bar.setVisible(False))
            
            if self.status_label:
                self.status_label.setText(message or "Completed")
                self.status_label.setStyleSheet("color: green;")
            
            if self.details_label and details:
                self.details_label.setText(details)
                self.details_label.setVisible(True)
                
        except Exception as e:
            self.logger.exception(f"Failed to update completion UI: {e}")
    
    def _update_cancellation_ui(self, message: str) -> None:
        """Update UI for cancellation state.
        
        Args:
            message: Cancellation message
        """
        try:
            if self.progress_bar:
                self.progress_bar.setVisible(False)
            
            if self.status_label:
                self.status_label.setText(message or "Cancelled")
                self.status_label.setStyleSheet("color: orange;")
            
            if self.details_label:
                self.details_label.setVisible(False)
                
        except Exception as e:
            self.logger.exception(f"Failed to update cancellation UI: {e}")


class CompositeProgressCallback(ProgressCallback):
    """Progress callback that forwards to multiple callbacks."""
    
    def __init__(self, callbacks: list[IProgressCallback], callback_id: str | None = None):
        """Initialize composite progress callback.
        
        Args:
            callbacks: List of callbacks to forward to
            callback_id: Optional callback identifier
        """
        super().__init__(callback_id)
        self.callbacks = callbacks or []
        self._lock = Lock()
    
    def add_callback(self, callback: IProgressCallback) -> None:
        """Add a callback.
        
        Args:
            callback: Callback to add
        """
        with self._lock:
            if callback not in self.callbacks:
                self.callbacks.append(callback)
    
    def remove_callback(self, callback: IProgressCallback) -> None:
        """Remove a callback.
        
        Args:
            callback: Callback to remove
        """
        with self._lock:
            if callback in self.callbacks:
                self.callbacks.remove(callback)
    
    def report_progress(self, progress: ProgressInfo) -> None:
        """Report progress to all callbacks.
        
        Args:
            progress: Progress information
        """
        super().report_progress(progress)  # Emit our own signals
        
        with self._lock:
            for callback in self.callbacks:
                try:
                    callback.report_progress(progress)
                except Exception as e:
                    self.logger.exception(f"Error in callback {callback}: {e}")
    
    def report_error(self, error: str, details: str = "") -> None:
        """Report error to all callbacks.
        
        Args:
            error: Error message
            details: Error details
        """
        super().report_error(error, details)  # Emit our own signals
        
        with self._lock:
            for callback in self.callbacks:
                try:
                    callback.report_error(error, details)
                except Exception as e:
                    self.logger.exception(f"Error in callback {callback}: {e}")
    
    def report_completion(self, message: str = "", details: str = "") -> None:
        """Report completion to all callbacks.
        
        Args:
            message: Completion message
            details: Completion details
        """
        super().report_completion(message, details)  # Emit our own signals
        
        with self._lock:
            for callback in self.callbacks:
                try:
                    callback.report_completion(message, details)
                except Exception as e:
                    self.logger.exception(f"Error in callback {callback}: {e}")
    
    def report_cancellation(self, message: str = "") -> None:
        """Report cancellation to all callbacks.
        
        Args:
            message: Cancellation message
        """
        super().report_cancellation(message)  # Emit our own signals
        
        with self._lock:
            for callback in self.callbacks:
                try:
                    callback.report_cancellation(message)
                except Exception as e:
                    self.logger.exception(f"Error in callback {callback}: {e}")


class ProgressCallbackManager:
    """Manager for progress callbacks."""
    
    def __init__(self):
        """Initialize progress callback manager."""
        self._callbacks: dict[str, IProgressCallback] = {}
        self._trackers: dict[str, ProgressTracker] = {}
        self._lock = Lock()
        
        self.logger = logging.getLogger(__name__)
    
    def create_callback(self, callback_id: str, callback_type: str = "basic", **kwargs) -> Result[IProgressCallback]:
        """Create a progress callback.
        
        Args:
            callback_id: Callback identifier
            callback_type: Type of callback ('basic', 'ui', 'composite')
            **kwargs: Additional arguments for callback creation
            
        Returns:
            Result containing the created callback
        """
        try:
            with self._lock:
                if callback_id in self._callbacks:
                    return Result.failure(f"Callback '{callback_id}' already exists")
                
                if callback_type == "basic":
                    callback = ProgressCallback(callback_id)
                elif callback_type == "ui":
                    callback = UIProgressCallback(
                        progress_bar=kwargs.get("progress_bar"),
                        status_label=kwargs.get("status_label"),
                        details_label=kwargs.get("details_label"),
                        callback_id=callback_id,
                    )
                elif callback_type == "composite":
                    callback = CompositeProgressCallback(
                        callbacks=kwargs.get("callbacks", []),
                        callback_id=callback_id,
                    )
                else:
                    return Result.failure(f"Unknown callback type: {callback_type}")
                
                self._callbacks[callback_id] = callback
                self.logger.info(f"Created {callback_type} callback '{callback_id}'")
                return Result.success(callback)
                
        except Exception as e:
            error_msg = f"Failed to create callback: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_callback(self, callback_id: str) -> IProgressCallback | None:
        """Get a progress callback.
        
        Args:
            callback_id: Callback identifier
            
        Returns:
            Progress callback or None if not found
        """
        with self._lock:
            return self._callbacks.get(callback_id)
    
    def create_tracker(self, tracker_id: str, callback_id: str) -> Result[ProgressTracker]:
        """Create a progress tracker.
        
        Args:
            tracker_id: Tracker identifier
            callback_id: Associated callback identifier
            
        Returns:
            Result containing the created tracker
        """
        try:
            with self._lock:
                if tracker_id in self._trackers:
                    return Result.failure(f"Tracker '{tracker_id}' already exists")
                
                callback = self._callbacks.get(callback_id)
                if not callback:
                    return Result.failure(f"Callback '{callback_id}' not found")
                
                tracker = ProgressTracker(callback, tracker_id)
                self._trackers[tracker_id] = tracker
                
                self.logger.info(f"Created tracker '{tracker_id}' with callback '{callback_id}'")
                return Result.success(tracker)
                
        except Exception as e:
            error_msg = f"Failed to create tracker: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_tracker(self, tracker_id: str) -> ProgressTracker | None:
        """Get a progress tracker.
        
        Args:
            tracker_id: Tracker identifier
            
        Returns:
            Progress tracker or None if not found
        """
        with self._lock:
            return self._trackers.get(tracker_id)
    
    def remove_callback(self, callback_id: str) -> Result[None]:
        """Remove a progress callback.
        
        Args:
            callback_id: Callback identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if callback_id in self._callbacks:
                    del self._callbacks[callback_id]
                    
                    # Remove associated trackers
                    trackers_to_remove = [
                        tid for tid, tracker in self._trackers.items()
                        if hasattr(tracker.callback, "callback_id") and tracker.callback.callback_id == callback_id
                    ]
                    
                    for tracker_id in trackers_to_remove:
                        del self._trackers[tracker_id]
                    
                    self.logger.info(f"Removed callback '{callback_id}' and {len(trackers_to_remove)} associated trackers")
                
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to remove callback: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def remove_tracker(self, tracker_id: str) -> Result[None]:
        """Remove a progress tracker.
        
        Args:
            tracker_id: Tracker identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if tracker_id in self._trackers:
                    tracker = self._trackers[tracker_id]
                    if tracker.is_tracking():
                        tracker.cancel_tracking("Tracker removed")
                    del self._trackers[tracker_id]
                    self.logger.info(f"Removed tracker '{tracker_id}'")
                
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to remove tracker: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def cleanup_all(self) -> Result[None]:
        """Cleanup all callbacks and trackers.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                # Cancel all active trackers
                for tracker in self._trackers.values():
                    if tracker.is_tracking():
                        tracker.cancel_tracking("Manager cleanup")
                
                self._trackers.clear()
                self._callbacks.clear()
                
                self.logger.info("All callbacks and trackers cleaned up")
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to cleanup: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_active_trackers(self) -> list[str]:
        """Get list of active tracker IDs.
        
        Returns:
            List of active tracker IDs
        """
        with self._lock:
            return [
                tracker_id for tracker_id, tracker in self._trackers.items()
                if tracker.is_tracking()
            ]
    
    def get_all_callbacks(self) -> list[str]:
        """Get list of all callback IDs.
        
        Returns:
            List of callback IDs
        """
        with self._lock:
            return list(self._callbacks.keys())
    
    def get_all_trackers(self) -> list[str]:
        """Get list of all tracker IDs.
        
        Returns:
            List of tracker IDs
        """
        with self._lock:
            return list(self._trackers.keys())


# Convenience functions
def create_ui_progress_callback(progress_bar: QProgressBar | None = None, status_label: QLabel | None = None,
                              details_label: QLabel | None = None) -> UIProgressCallback:
    """Create a UI progress callback.
    
    Args:
        progress_bar: Optional progress bar widget
        status_label: Optional status label widget
        details_label: Optional details label widget
        
    Returns:
        UI progress callback
    """
    return UIProgressCallback(progress_bar, status_label, details_label)


def create_progress_tracker(callback: IProgressCallback) -> ProgressTracker:
    """Create a progress tracker.
    
    Args:
        callback: Progress callback
        
    Returns:
        Progress tracker
    """
    return ProgressTracker(callback)


def create_composite_callback(*callbacks: IProgressCallback) -> CompositeProgressCallback:
    """Create a composite progress callback.
    
    Args:
        *callbacks: Callbacks to include
        
    Returns:
        Composite progress callback
    """
    return CompositeProgressCallback(list(callbacks))


def create_simple_progress_info(
    current: float, 
    total: float = 100.0, 
    message: str = "", 
    status: ProgressStatus = ProgressStatus.IN_PROGRESS,
) -> ProgressInfo:
    """Create a simple ProgressInfo with automatic percentage calculation.
    
    Args:
        current: Current progress value
        total: Total progress value (default 100)
        message: Progress message
        status: Progress status
        
    Returns:
        ProgressInfo instance with calculated percentage
    """
    return ProgressInfo.create(
        current=current,
        total=total,
        status=status,
        message=message,
    )