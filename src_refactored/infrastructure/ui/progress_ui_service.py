"""Progress UI service for managing progress bars and UI state.

This module provides infrastructure services for progress bar management,
UI state updates, and progress tracking with animations.
"""

from PyQt6 import QtCore
from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, QTimer, pyqtSignal
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import QLabel, QProgressBar, QPushButton

from src_refactored.domain.progress_management.value_objects.progress_state import (
    ProgressState,
    ProgressStateType,
)
from src_refactored.infrastructure.progress_management.progress_tracking_service import (
    ProgressInfo as BaseProgressInfo,
)


class ProgressInfo(BaseProgressInfo):
    """Enhanced progress info for UI tracking."""

    def __init__(self, progress_id: str):
        """Initialize progress info.
        
        Args:
            progress_id: Unique identifier for the progress
        """
        self.progress_id = progress_id
        self.current_value = 0.0
        self.maximum_value = 100.0
        self.state = ProgressState.create_idle()
        self.message = ""
        self.details = ""
    @property
    def percentage(self) -> float:
        """Get progress as percentage.
        
        Returns:
            Progress percentage (0-100)
        """
        if self.maximum_value <= 0:
            return 0.0
        return min(100.0, max(0.0, (self.current_value / self.maximum_value) * 100.0))

    @property
    def is_complete(self) -> bool:
        """Check if progress is complete.
        
        Returns:
            True if progress is complete, False otherwise
        """
        return self.state.is_completed() or self.current_value >= self.maximum_value

    @property
    def is_active(self) -> bool:
        """Check if progress is active.
        
        Returns:
            True if progress is active, False otherwise
        """
        return self.state.is_active()

    @property
    def elapsed_time(self) -> int:
        """Get elapsed time in milliseconds.
        
        Returns:
            Elapsed time since start
        """
        return self.start_time.msecsTo(QtCore.QDateTime.currentDateTime())

    def update(self,
               current_value: float | None = None,
               maximum_value: float | None = None,
               state: ProgressState | None = None,
               message: str | None = None,
               details: str | None = None) -> None:
        """Update progress information.
        
        Args:
            current_value: New current value
            maximum_value: New maximum value
            state: New state
            message: New message
            details: New details
        """
        if current_value is not None:
            self.current_value = current_value
        if maximum_value is not None:
            self.maximum_value = maximum_value
        if state is not None:
            self.state = state
        if message is not None:
            self.message = message
        if details is not None:
            self.details = details

        self.last_update = QtCore.QDateTime.currentDateTime()


class ProgressUIService(QObject):
    """Service for managing progress UI elements.
    
    This service provides infrastructure-only logic for progress bars
    and related UI state management without business logic dependencies.
    """

    # Signals for progress events
    progress_started = pyqtSignal(str, ProgressInfo)    # progress_id, info
    progress_updated = pyqtSignal(str, ProgressInfo)    # progress_id, info
    progress_completed = pyqtSignal(str, ProgressInfo)  # progress_id, info
    progress_paused = pyqtSignal(str, ProgressInfo)     # progress_id, info
    progress_resumed = pyqtSignal(str, ProgressInfo)    # progress_id, info
    progress_cancelled = pyqtSignal(str, ProgressInfo)  # progress_id, info
    progress_error = pyqtSignal(str, ProgressInfo, str) # progress_id, info, error

    def __init__(self, parent: QObject | None = None):
        """Initialize the progress UI service.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        # Progress tracking
        self._progress_info: dict[str, ProgressInfo] = {}
        self._progress_bars: dict[str, QProgressBar] = {}
        self._progress_labels: dict[str, QLabel] = {}
        self._progress_buttons: dict[str, QPushButton] = {}

        # Animation settings
        self._animate_updates: bool = True
        self._animation_duration: int = 200
        self._animations: dict[str, QPropertyAnimation] = {}

        # Update timers
        self._update_timers: dict[str, QTimer] = {}
        self._auto_update_interval: int = 100  # milliseconds

        # Styling
        self._state_colors: dict[ProgressStateType, QColor] = {
            ProgressStateType.IDLE: QColor(200, 200, 200),
            ProgressStateType.DOWNLOADING: QColor(0, 120, 215),
            ProgressStateType.PROCESSING: QColor(255, 193, 7),
            ProgressStateType.COMPLETED: QColor(40, 167, 69),
            ProgressStateType.ERROR: QColor(220, 53, 69),
        }

    def register_progress_bar(self,
                             progress_id: str,
                             progress_bar: QProgressBar,
                             label: QLabel | None = None,
                             button: QPushButton | None = None) -> None:
        """Register a progress bar for management.
        
        Args:
            progress_id: Unique identifier for the progress
            progress_bar: Progress bar widget
            label: Optional label for progress text
            button: Optional button for progress control
        """
        self._progress_bars[progress_id] = progress_bar

        if label:
            self._progress_labels[progress_id] = label

        if button:
            self._progress_buttons[progress_id] = button

        # Initialize progress info if not exists
        if progress_id not in self._progress_info:
            self._progress_info[progress_id] = ProgressInfo(progress_id)

        # Setup initial state
        self._update_progress_bar(progress_id)

    def unregister_progress_bar(self, progress_id: str,
    ) -> None:
        """Unregister a progress bar.
        
        Args:
            progress_id: Progress identifier
        """
        # Stop any running animations
        self._stop_animation(progress_id)

        # Stop update timer
        self._stop_update_timer(progress_id)

        # Remove from tracking
        self._progress_bars.pop(progress_id, None)
        self._progress_labels.pop(progress_id, None)
        self._progress_buttons.pop(progress_id, None)
        self._progress_info.pop(progress_id, None)

    def start_progress(self,
                      progress_id: str,
                      maximum_value: float = 100.0,
                      message: str = "",
                      indeterminate: bool = False,
    ) -> None:
        """Start progress tracking.
        
        Args:
            progress_id: Progress identifier
            maximum_value: Maximum progress value
            message: Initial progress message
            indeterminate: Whether progress is indeterminate
        """
        # Create or update progress info
        if progress_id in self._progress_info:
            info = self._progress_info[progress_id]
            info.update(
                current_value=0.0,
                maximum_value=maximum_value,
                state=ProgressState.create_processing()
                if not indeterminate
                else ProgressState.create_processing(),
                message=message,
            )
        else:
            info = ProgressInfo(progress_id)
            info.update(
                current_value=0.0,
                maximum_value=maximum_value,
                state=ProgressState.create_processing()
                if not indeterminate
                else ProgressState.create_processing(),
                message=message,
            )
            self._progress_info[progress_id] = info

        # Update UI
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Start auto-update timer if needed
        if indeterminate:
            self._start_update_timer(progress_id)

        # Emit signal
        self.progress_started.emit(progress_id, info)

    def update_progress(self,
                       progress_id: str,
                       current_value: float | None = None,
                       maximum_value: float | None = None,
                       message: str | None = None,
                       details: str | None = None) -> None:
        """Update progress.
        
        Args:
            progress_id: Progress identifier
            current_value: New current value
            maximum_value: New maximum value
            message: New progress message
            details: New progress details
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        old_value = info.current_value

        # Update info
        info.update(
            current_value=current_value,
            maximum_value=maximum_value,
            message=message,
            details=details,
        )

        # Check for completion
        if info.is_complete and not info.state.is_completed():
            info.state = ProgressState.create_completed()
            self.complete_progress(progress_id)
            return

        # Update UI with animation if enabled
        if self._animate_updates and current_value is not None:
            self._animate_progress_update(progress_id, old_value, current_value)
        else:
            self._update_progress_bar(progress_id)

        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_updated.emit(progress_id, info)

    def complete_progress(self, progress_id: str, message: str = "Completed") -> None:
        """Complete progress.
        
        Args:
            progress_id: Progress identifier
            message: Completion message
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        info.update(
            current_value=info.maximum_value,
            state=ProgressState.create_completed(),
            message=message,
        )

        # Stop timers and animations
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)

        # Update UI
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_completed.emit(progress_id, info)

    def pause_progress(self, progress_id: str, message: str = "Paused") -> None:
        """Pause progress.
        
        Args:
            progress_id: Progress identifier
            message: Pause message
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        if not info.state.is_active():
            return

        info.state = ProgressState.create_idle()  # Using idle as paused equivalent
        info.update(message=message)

        # Stop timers and animations
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)

        # Update UI
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_paused.emit(progress_id, info)

    def resume_progress(self, progress_id: str, message: str = "Resuming...") -> None:
        """Resume progress.
        
        Args:
            progress_id: Progress identifier
            message: Resume message
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        if not info.state.is_idle():
            return

        info.state = ProgressState.create_processing()
        info.update(message=message)

        # Restart timer if needed
        if info.state.is_active():
            self._start_update_timer(progress_id)

        # Update UI
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_resumed.emit(progress_id, info)

    def cancel_progress(self, progress_id: str, message: str = "Cancelled") -> None:
        """Cancel progress.
        
        Args:
            progress_id: Progress identifier
            message: Cancellation message
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        info.state = ProgressState.create_idle()
        info.update(message=message)

        # Stop timers and animations
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)

        # Reset progress bar
        if progress_id in self._progress_bars:
            self._progress_bars[progress_id].setValue(0)

        # Update UI
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_cancelled.emit(progress_id, info)

    def set_progress_error(
        self, progress_id: str, error_message: str, message: str = "Error",
    ) -> None:
        """Set progress to error state.
        
        Args:
            progress_id: Progress identifier
            error_message: Error message
            message: Display message
        """
        if progress_id not in self._progress_info:
            return

        info = self._progress_info[progress_id]
        info.state = ProgressState.create_error(error_message)
        info.update(message=message, details=error_message)

        # Stop timers and animations
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)

        # Update UI
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)

        # Emit signal
        self.progress_error.emit(progress_id, info, error_message)

    def _update_progress_bar(self, progress_id: str) -> None:
        """Update progress bar appearance.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id not in self._progress_bars or progress_id not in self._progress_info:
            return

        progress_bar = self._progress_bars[progress_id]
        info = self._progress_info[progress_id]

        try:
            # Set range and value
            if info.state.is_active():
                progress_bar.setRange(0, int(info.maximum_value))
                progress_bar.setValue(int(info.current_value))
            else:
                progress_bar.setRange(0, 0)  # Indeterminate for non-active states

            # Apply styling based on state
            self._apply_progress_bar_style(progress_bar, info.state.state_type)

        except RuntimeError:
            # Progress bar has been deleted
            pass

    def _update_progress_label(self, progress_id: str) -> None:
        """Update progress label text.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id not in self._progress_labels or progress_id not in self._progress_info:
            return

        label = self._progress_labels[progress_id]
        info = self._progress_info[progress_id]

        try:
            if info.message:
                if info.state.is_active():
                    label.setText(f"{info.message} ({info.percentage:.1f}%)")
                else:
                    label.setText(info.message)
            elif info.state.is_active():
                label.setText(f"{info.percentage:.1f}%")
            else:
                label.setText("Processing...")
        except RuntimeError:
            # Label has been deleted
            pass

    def _update_progress_button(self, progress_id: str) -> None:
        """Update progress control button.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id not in self._progress_buttons or progress_id not in self._progress_info:
            return

        button = self._progress_buttons[progress_id]
        info = self._progress_info[progress_id]

        try:
            if info.state.is_active():
                button.setText("Pause")
                button.setEnabled(True)
            elif info.state.is_idle():
                button.setText("Start")
                button.setEnabled(True)
            elif info.state.is_completed():
                button.setText("Done")
                button.setEnabled(False)
            elif info.state.is_error():
                button.setText("Retry")
                button.setEnabled(True)
        except RuntimeError:
            # Button has been deleted
            pass

    def _apply_progress_bar_style(
        self, progress_bar: QProgressBar, state_type: ProgressStateType,
    ) -> None:
        """Apply styling to progress bar based on state.
        
        Args:
            progress_bar: Progress bar widget
            state_type: Progress state type
        """
        try:
            color = self._state_colors.get(state_type, self._state_colors[ProgressStateType.IDLE])

            # Create stylesheet
            stylesheet = f"""
            QProgressBar {{
                border: 1px solid {color.darker().name()};
                border-radius: 3px;
                text-align: center;
                background-color: #f0f0f0;
            }},
            QProgressBar::chunk {{
                background-color: {color.name()};
                border-radius: 2px;
            }},
            """

            progress_bar.setStyleSheet(stylesheet)
        except RuntimeError:
            # Progress bar has been deleted
            pass

    def _animate_progress_update(
        self, progress_id: str, old_value: float, new_value: float,
    ) -> None:
        """Animate progress bar update.
        
        Args:
            progress_id: Progress identifier
            old_value: Previous value
            new_value: New value
        """
        if progress_id not in self._progress_bars:
            return

        progress_bar = self._progress_bars[progress_id]

        # Stop existing animation
        self._stop_animation(progress_id)

        try:
            # Create animation
            animation = QPropertyAnimation(progress_bar, b"value")
            animation.setDuration(self._animation_duration)
            animation.setStartValue(int(old_value))
            animation.setEndValue(int(new_value))
            animation.setEasingCurve(QEasingCurve.Type.OutCubic)
            # Store and start animation
            self._animations[progress_id] = animation
            animation.start()
        except RuntimeError:
            # Progress bar has been deleted
            pass

    def _start_update_timer(self, progress_id: str) -> None:
        """Start auto-update timer for indeterminate progress.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id in self._update_timers:
            return

        timer = QTimer()
        timer.timeout.connect(lambda: self._update_progress_bar(progress_id))
        timer.start(self._auto_update_interval)

        self._update_timers[progress_id] = timer

    def _stop_update_timer(self, progress_id: str) -> None:
        """Stop auto-update timer.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id in self._update_timers:
            self._update_timers[progress_id].stop()
            del self._update_timers[progress_id]

    def _stop_animation(self, progress_id: str) -> None:
        """Stop progress animation.
        
        Args:
            progress_id: Progress identifier
        """
        if progress_id in self._animations:
            self._animations[progress_id].stop()
            del self._animations[progress_id]

    def get_progress_info(self, progress_id: str) -> ProgressInfo | None:
        """Get progress information.
        
        Args:
            progress_id: Progress identifier
            
        Returns:
            ProgressInfo or None if not found
        """
        return self._progress_info.get(progress_id)

    def get_all_progress_ids(self) -> list[str]:
        """Get all tracked progress IDs.
        
        Returns:
            List of progress identifiers
        """
        return list(self._progress_info.keys())

    def is_progress_active(self, progress_id: str) -> bool:
        """Check if progress is active.
        
        Args:
            progress_id: Progress identifier
            
        Returns:
            True if progress is active, False otherwise
        """
        info = self._progress_info.get(progress_id)
        return info.is_active() if info else False

    def set_animation_enabled(self, enabled: bool) -> None:
        """Enable or disable progress animations.
        
        Args:
            enabled: Whether to enable animations
        """
        self._animate_updates = enabled

    def set_animation_duration(self, duration: int) -> None:
        """Set animation duration.
        
        Args:
            duration: Animation duration in milliseconds
        """
        self._animation_duration = duration

    def set_auto_update_interval(self, interval: int) -> None:
        """Set auto-update interval for indeterminate progress.
        
        Args:
            interval: Update interval in milliseconds
        """
        self._auto_update_interval = interval

    def set_state_color(self, state_type: ProgressStateType, color: QColor) -> None:
        """Set color for a progress state.
        
        Args:
            state_type: Progress state type
            color: Color to use
        """
        self._state_colors[state_type] = color

    def cleanup(self) -> None:
        """Clean up service resources."""
        # Stop all animations and timers
        for progress_id in list(self._animations.keys()):
            self._stop_animation(progress_id)

        for progress_id in list(self._update_timers.keys()):
            self._stop_update_timer(progress_id)

        # Clear tracking
        self._progress_info.clear()
        self._progress_bars.clear()
        self._progress_labels.clear()
        self._progress_buttons.clear()

    def __del__(self):
        """Destructor to ensure cleanup."""
        self.cleanup()


class ProgressUIManager:
    """High-level manager for progress UI functionality.
    
    Provides a simplified interface for common progress patterns.
    """

    def __init__(self, parent: QObject | None = None):
        """Initialize the progress UI manager.
        
        Args:
            parent: Parent QObject
        """
        self.service = ProgressUIService(parent)

    def setup_download_progress(self,
                               progress_id: str,
                               progress_bar: QProgressBar,
                               label: QLabel | None = None) -> None:
        """Setup progress tracking for downloads.
        
        Args:
            progress_id: Progress identifier
            progress_bar: Progress bar widget
            label: Optional label for progress text
        """
        self.service.register_progress_bar(progress_id, progress_bar, label)
        self.service.start_progress(progress_id, 100.0, "Preparing download...")

    def setup_transcription_progress(self,
                                   progress_id: str,
                                   progress_bar: QProgressBar,
                                   label: QLabel | None = None,
                                   button: QPushButton | None = None) -> None:
        """Setup progress tracking for transcription.
        
        Args:
            progress_id: Progress identifier
            progress_bar: Progress bar widget
            label: Optional label for progress text
            button: Optional button for progress control
        """
        self.service.register_progress_bar(progress_id, progress_bar, label, button)
        self.service.start_progress(
            progress_id, 100.0, "Starting transcription...", indeterminate=True,
        )

    def setup_processing_progress(self,
                                progress_id: str,
                                progress_bar: QProgressBar,
                                label: QLabel | None = None,
                                total_items: int = 100,
    ) -> None:
        """Setup progress tracking for batch processing.
        
        Args:
            progress_id: Progress identifier
            progress_bar: Progress bar widget
            label: Optional label for progress text
            total_items: Total number of items to process
        """
        self.service.register_progress_bar(progress_id, progress_bar, label)
        self.service.start_progress(progress_id, float(total_items), "Processing...")

    def update_download_progress(self, progress_id: str, percentage: float, filename: str = "") -> None:
        """Update download progress.
        
        Args:
            progress_id: Progress identifier
            percentage: Download percentage
            filename: Name of file being downloaded
        """
        message = f"Downloading {filename}" if filename else "Downloading"
        self.service.update_progress(
            progress_id, percentage, message=message,
        )

    def update_transcription_progress(self, progress_id: str, percentage: float, status: str = "") -> None:
        """Update transcription progress.
        
        Args:
            progress_id: Progress identifier
            percentage: Transcription percentage
            status: Current transcription status
        """
        message = f"Transcribing: {status}" if status else "Transcribing"
        self.service.update_progress(
            progress_id, percentage, message=message,
        )

    def update_processing_progress(
        self,
        progress_id: str,
        completed_items: int,
        current_item: str = "") -> None:
        """Update processing progress.
        
        Args:
            progress_id: Progress identifier
            completed_items: Number of completed items
            current_item: Name of current item being processed
        """
        message = (
            f"Processing: {current_item}" if current_item else "Processing"
        )
        self.service.update_progress(
            progress_id, float(completed_items), message=message,
        )

    def complete_progress(self, progress_id: str, message: str = "Completed") -> None:
        """Complete progress.
        
        Args:
            progress_id: Progress identifier
            message: Completion message
        """
        self.service.complete_progress(progress_id, message)

    def error_progress(self, progress_id: str, error_message: str) -> None:
        """Set progress to error state.
        
        Args:
            progress_id: Progress identifier
            error_message: Error message
        """
        self.service.set_progress_error(progress_id, error_message)

    def get_service(self) -> ProgressUIService:
        """Get the underlying progress UI service.
        
        Returns:
            ProgressUIService instance
        """
        return self.service