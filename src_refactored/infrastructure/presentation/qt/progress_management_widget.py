"""Progress Management Widget Component.

This module provides a reusable widget for progress management
that handles progress bar coordination, reparenting, and download UI state.
"""


from PyQt6.QtCore import QRect, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QHBoxLayout,
    QProgressBar,
    QVBoxLayout,
    QWidget,
)

from src_refactored.application.use_cases.progress_management.reparent_progress_bar_use_case import (
    ReparentProgressBarUseCase,
)
from src_refactored.application.use_cases.progress_management.update_progress_state_use_case import (
    UpdateProgressStateUseCase,
)
from src_refactored.domain.progress_management.value_objects.progress_state import (
    ProgressBarMovementState,
    ProgressState,
)
from src_refactored.infrastructure.progress_management.progress_ui_service import (
    ProgressUIService,
)


class ProgressManagementWidget(QWidget):
    """Progress management widget component.
    
    This widget provides UI controls for progress management including
    progress bar coordination, reparenting, and download state management.
    """

    # Signals for progress management events
    download_started = pyqtSignal()
    download_finished = pyqtSignal()
    progress_updated = pyqtSignal(int)  # percentage
    progress_bar_moved = pyqtSignal(bool)  # True if moved to dialog, False if returned
    state_changed = pyqtSignal(str)  # state description

    def __init__(self, parent=None, parent_window=None):
        """Initialize the progress management widget.
        
        Args:
            parent: Parent widget
            parent_window: Reference to main window for progress bar access
        """
        super().__init__(parent)

        # Store parent window reference
        self.parent_window = parent_window

        # Initialize use cases (these would be injected via DI in full implementation)
        self._reparent_progress_bar_use_case = ReparentProgressBarUseCase()
        self._update_progress_state_use_case = UpdateProgressStateUseCase()

        # Initialize services
        self._progress_ui_service = ProgressUIService()

        # Current state
        self._current_state = ProgressState.create_idle()
        self._is_downloading_model = False
        self._is_progress_bar_moving = False

        # Progress bar management
        self._original_progress_parent: QWidget | None = None
        self._original_progress_geometry: QRect | None = None

        # UI components
        self.progress_placeholder: QWidget | None = None
        self.progress_placeholder_layout: QHBoxLayout | None = None

        # Debounce timer for progress bar operations
        self._progress_debounce_timer = QTimer()
        self._progress_debounce_timer.setSingleShot(True)
        self._progress_debounce_timer.timeout.connect(self._reset_moving_flag)

        # Setup UI
        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self):
        """Setup the user interface."""
        # Create main layout
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Create progress placeholder section
        self._create_progress_placeholder(layout)

    def _create_progress_placeholder(self, layout: QVBoxLayout):
        """Create the progress placeholder section.
        
        Args:
            layout: Parent layout to add the section to
        """
        # Create a collapsed placeholder for the progress bar
        self.progress_placeholder = QWidget()
        self.progress_placeholder.setFixedHeight(0)  # Start with 0 height
        self.progress_placeholder.setMaximumHeight(20)  # But allow expansion up to 20
        self.progress_placeholder_layout = QHBoxLayout(self.progress_placeholder)
        self.progress_placeholder_layout.setContentsMargins(0, 0, 0, 0)
        self.progress_placeholder_layout.setSpacing(0)

        layout.addWidget(self.progress_placeholder)

    def _setup_connections(self):
        """Setup signal connections."""
        # Connect internal signals
        self._progress_debounce_timer.timeout.connect(self._reset_moving_flag)

    def _reset_moving_flag(self):
        """Reset the progress bar moving flag."""
        self._is_progress_bar_moving = False
        self._current_state = self._current_state.with_moving(False)

    def _get_progress_bar(self) -> QProgressBar | None:
        """Get the progress bar from parent window.
        
        Returns:
            Progress bar widget if available, None otherwise
        """
        if (hasattr(self.parent_window, "progressBar") and
            self.parent_window.progressBar is not None):
            return self.parent_window.progressBar
        return None

    def _store_original_progress_state(self, progress_bar: QProgressBar):
        """Store the original state of the progress bar.
        
        Args:
            progress_bar: Progress bar to store state for
        """
        if self._original_progress_parent is None:
            self._original_progress_parent = progress_bar.parent()
        if self._original_progress_geometry is None:
            self._original_progress_geometry = progress_bar.geometry()

    def _reparent_progress_bar_to_dialog(self, progress_bar: QProgressBar) -> bool:
        """Reparent progress bar to this dialog.
        
        Args:
            progress_bar: Progress bar to reparent
            
        Returns:
            True if successful, False otherwise
        """
        try:
            # Store original state
            self._store_original_progress_state(progress_bar)

            # Reparent progress bar to our dialog
            progress_bar.setParent(self.progress_placeholder)

            # Add to our layout
            self.progress_placeholder_layout.addWidget(progress_bar)

            # Make sure it's visible
            progress_bar.setVisible(True)
            progress_bar.raise_()

            # Update to ensure it shows up
            progress_bar.update()
            self.progress_placeholder.update()

            return True

        except RuntimeError:
            # If the progress bar has been deleted, ignore
            return False

    def _restore_progress_bar_to_parent(self, progress_bar: QProgressBar) -> bool:
        """Restore progress bar to its original parent.
        
        Args:
            progress_bar: Progress bar to restore
            
        Returns:
            True if successful, False otherwise
        """
        try:
            # Remove from our layout first
            for i in range(self.progress_placeholder_layout.count()):
                item = self.progress_placeholder_layout.itemAt(i)
                if item and item.widget() == progress_bar:
                    self.progress_placeholder_layout.removeItem(item)
                    break

            # Return progress bar to original parent and position
            if self._original_progress_parent:
                progress_bar.setParent(self._original_progress_parent)
                if self._original_progress_geometry:
                    progress_bar.setGeometry(self._original_progress_geometry)
            else:
                # Fallback to parent window's central widget
                progress_bar.setParent(self.parent_window.centralwidget)

            return True

        except RuntimeError:
            # If the progress bar has been deleted, ignore
            return False

    def start_download(self):
        """Start the model download process.
        
        This will disable UI and setup progress tracking.
        """
        self._is_downloading_model = True
        self._current_state = ProgressState.create_downloading()

        # Expand the progress placeholder to make room for the progress bar
        if self.progress_placeholder:
            self.progress_placeholder.setFixedHeight(20)

        # Only move the progress bar if we're not already in the process of moving it
        progress_bar = self._get_progress_bar()
        if (not self._is_progress_bar_moving and progress_bar is not None):
            self._is_progress_bar_moving = True
            self._current_state = self._current_state.with_moving(
                True, ProgressBarMovementState.REPARENTING,
            )

            # Reparent progress bar to dialog
            success = self._reparent_progress_bar_to_dialog(progress_bar)

            if success:
                self.progress_bar_moved.emit(True)

            # Start debounce timer
            self._progress_debounce_timer.start(200)

        # Emit signals
        self.download_started.emit()
        self.state_changed.emit("Download started")

    def finish_download(self):
        """Re-enable settings and hide progress bar after download."""
        self._is_downloading_model = False
        self._current_state = ProgressState.create_idle()

        # Collapse the progress placeholder
        if self.progress_placeholder:
            self.progress_placeholder.setFixedHeight(0)

        # Only move the progress bar if we're not already in the process of moving it
        progress_bar = self._get_progress_bar()
        if (not self._is_progress_bar_moving and progress_bar is not None):
            self._is_progress_bar_moving = True
            self._current_state = self._current_state.with_moving(
                True, ProgressBarMovementState.RESTORING,
            )

            # Restore progress bar to parent
            success = self._restore_progress_bar_to_parent(progress_bar)

            if success:
                # Hide progress bar
                progress_bar.setVisible(False)
                self.progress_bar_moved.emit(False)

            # Start debounce timer
            self._progress_debounce_timer.start(200)

        # Emit signals
        self.download_finished.emit()
        self.state_changed.emit("Download finished")

    def update_progress(self, percentage: int):
        """Update the progress bar value.
        
        Args:
            percentage: Progress percentage (0-100)
        """
        progress_bar = self._get_progress_bar()
        if progress_bar is not None:
            try:
                progress_bar.setValue(percentage)
                self.progress_updated.emit(percentage)
            except RuntimeError:
                # If the progress bar has been deleted, ignore
                pass

    def handle_dialog_show(self):
        """Handle dialog show event.
        
        Ensures progress bar appears in dialog if download is in progress.
        """
        if (self._is_downloading_model and
            not self._is_progress_bar_moving):

            progress_bar = self._get_progress_bar()
            if progress_bar is not None:
                self._is_progress_bar_moving = True
                self._current_state = self._current_state.with_moving(
                    True, ProgressBarMovementState.REPARENTING,
                )

                # Reparent to dialog
                success = self._reparent_progress_bar_to_dialog(progress_bar)

                if success:
                    self.progress_bar_moved.emit(True)

                # Start debounce timer
                self._progress_debounce_timer.start(200)

    def handle_dialog_hide(self):
        """Handle dialog hide event.
        
        Returns progress bar to parent window if download is in progress.
        """
        if (self._is_downloading_model and
            not self._is_progress_bar_moving):

            progress_bar = self._get_progress_bar()
            if progress_bar is not None:
                self._is_progress_bar_moving = True
                self._current_state = self._current_state.with_moving(
                    True, ProgressBarMovementState.RESTORING,
                )

                # Restore to parent
                success = self._restore_progress_bar_to_parent(progress_bar)

                if success:
                    # Make sure it's visible in parent
                    progress_bar.setVisible(True)
                    progress_bar.raise_()
                    progress_bar.update()
                    self.progress_bar_moved.emit(False)

                # Start debounce timer
                self._progress_debounce_timer.start(200)

    def cleanup(self):
        """Clean up resources and restore progress bar state."""
        # Stop any running timers
        if self._progress_debounce_timer.isActive():
            self._progress_debounce_timer.stop()

        # If we're in the middle of a download, clean up properly
        if self._is_downloading_model:
            self.finish_download()

        # Reset state
        self._current_state = ProgressState.create_idle()
        self._is_downloading_model = False
        self._is_progress_bar_moving = False
        self._original_progress_parent = None
        self._original_progress_geometry = None

    # Public interface methods
    def is_downloading(self) -> bool:
        """Check if a download is currently in progress.
        
        Returns:
            True if downloading, False otherwise
        """
        return self._is_downloading_model

    def is_progress_bar_moving(self) -> bool:
        """Check if the progress bar is currently being moved.
        
        Returns:
            True if moving, False otherwise
        """
        return self._is_progress_bar_moving

    def get_current_state(self) -> ProgressState:
        """Get the current progress state.
        
        Returns:
            Current progress state
        """
        return self._current_state

    def set_parent_window(self, parent_window):
        """Set the parent window reference.
        
        Args:
            parent_window: Reference to main window
        """
        self.parent_window = parent_window

    def get_progress_placeholder_height(self) -> int:
        """Get the current height of the progress placeholder.
        
        Returns:
            Height in pixels
        """
        if self.progress_placeholder:
            return self.progress_placeholder.height()
        return 0

    def set_progress_placeholder_height(self, height: int):
        """Set the height of the progress placeholder.
        
        Args:
            height: Height in pixels
        """
        if self.progress_placeholder:
            self.progress_placeholder.setFixedHeight(height)

    def expand_progress_placeholder(self):
        """Expand the progress placeholder to show progress bar."""
        self.set_progress_placeholder_height(20)

    def collapse_progress_placeholder(self):
        """Collapse the progress placeholder to hide progress bar."""
        self.set_progress_placeholder_height(0)

    def force_progress_bar_return(self):
        """Force the progress bar to return to its original parent.
        
        This is useful for cleanup scenarios.
        """
        progress_bar = self._get_progress_bar()
        if progress_bar is not None and not self._is_progress_bar_moving:
            self._is_progress_bar_moving = True

            success = self._restore_progress_bar_to_parent(progress_bar)

            if success:
                self.progress_bar_moved.emit(False)

            # Start debounce timer
            self._progress_debounce_timer.start(200)

    def set_enabled(self, enabled: bool):
        """Enable or disable the widget.
        
        Args:
            enabled: Whether to enable the widget
        """
        super().setEnabled(enabled)

        # If disabled during download, clean up
        if not enabled and self._is_downloading_model:
            self.finish_download()

    def get_progress_value(self) -> int:
        """Get the current progress bar value.
        
        Returns:
            Progress percentage (0-100)
        """
        progress_bar = self._get_progress_bar()
        if progress_bar is not None:
            try:
                return progress_bar.value()
            except RuntimeError:
                # Progress bar has been deleted
                pass
        return 0

    def set_progress_visible(self, visible: bool):
        """Set the visibility of the progress bar.
        
        Args:
            visible: Whether to show the progress bar
        """
        progress_bar = self._get_progress_bar()
        if progress_bar is not None:
            try:
                progress_bar.setVisible(visible)
            except RuntimeError:
                # Progress bar has been deleted
                pass

    def reset_progress(self):
        """Reset the progress bar to 0 and hide it."""
        progress_bar = self._get_progress_bar()
        if progress_bar is not None:
            try:
                progress_bar.setValue(0)
                progress_bar.setVisible(False)
            except RuntimeError:
                # Progress bar has been deleted
                pass

    def has_progress_bar(self) -> bool:
        """Check if a progress bar is available.
        
        Returns:
            True if progress bar is available, False otherwise
        """
        return self._get_progress_bar() is not None

    def get_movement_state(self) -> ProgressBarMovementState:
        """Get the current progress bar movement state.
        
        Returns:
            Current movement state
        """
        return self._current_state.movement_state

    def set_debounce_timeout(self, timeout_ms: int):
        """Set the debounce timeout for progress bar operations.
        
        Args:
            timeout_ms: Timeout in milliseconds
        """
        if timeout_ms > 0:
            self._progress_debounce_timer.setInterval(timeout_ms)

    def get_debounce_timeout(self) -> int:
        """Get the current debounce timeout.
        
        Returns:
            Timeout in milliseconds
        """
        return self._progress_debounce_timer.interval()