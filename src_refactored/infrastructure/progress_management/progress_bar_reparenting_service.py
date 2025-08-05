"""Progress Bar Reparenting Service for complex progress bar lifecycle management.

This service provides centralized progress bar reparenting and lifecycle functionality,
extracted from settings_dialog.py (lines 1571-1613, 1362-1409, 1420-1464).
"""

from PyQt6.QtCore import QObject, QRect, QTimer, pyqtSignal
from PyQt6.QtWidgets import QLayout, QProgressBar, QVBoxLayout, QWidget


class ProgressBarReparentingService(QObject):
    """Service for managing progress bar reparenting and lifecycle.
    
    Extracted from settings_dialog.py progress bar management patterns.
    """

    # Signals for progress bar state changes
    progress_bar_moved = pyqtSignal(QWidget, QWidget)  # progress_bar, new_parent
    progress_bar_restored = pyqtSignal(QWidget, QWidget)  # progress_bar, original_parent
    reparenting_started = pyqtSignal()
    reparenting_finished = pyqtSignal()

    def __init__(self):
        """Initialize the progress bar reparenting service."""
        super().__init__()
        self.is_progress_bar_moving = False
        self.original_progress_parent: QWidget | None = None
        self.original_progress_geometry: QRect | None = None
        self.progress_placeholder: QWidget | None = None
        self.progress_placeholder_layout: QLayout | None = None
        self._move_timer = QTimer()
        self._move_timer.setSingleShot(True)
        self._move_timer.timeout.connect(self._reset_moving_flag)

    def setup_progress_placeholder(self, placeholder_widget: QWidget, layout: QLayout,
    ) -> None:
        """Setup the progress placeholder widget and layout.
        
        Args:
            placeholder_widget: Widget to serve as progress bar placeholder
            layout: Layout to contain the progress bar
        """
        self.progress_placeholder = placeholder_widget
        self.progress_placeholder_layout = layout

        # Initially collapse the placeholder
        self.progress_placeholder.setFixedHeight(0)

    def start_download_reparenting(self, progress_bar: QProgressBar, target_parent: QWidget,
    ) -> bool:
        """Start download process by reparenting progress bar to dialog.
        
        Args:
            progress_bar: Progress bar widget to reparent
            target_parent: Target parent widget (dialog)
            
        Returns:
            True if reparenting was successful, False otherwise
        """
        if self.is_progress_bar_moving or not self.progress_placeholder:
            return False

        self.is_progress_bar_moving = True
        self.reparenting_started.emit()

        try:
            # Store original parent and geometry for restoration
            if self.original_progress_parent is None:
                self.original_progress_parent = progress_bar.parent()
            if self.original_progress_geometry is None:
                self.original_progress_geometry = progress_bar.geometry()

            # Expand the progress placeholder to make room
            self.progress_placeholder.setFixedHeight(20)

            # Reparent progress bar to our placeholder
            progress_bar.setParent(self.progress_placeholder)

            # Add to our layout
            if self.progress_placeholder_layout:
                self.progress_placeholder_layout.addWidget(progress_bar)

            # Make sure it's visible
            progress_bar.setVisible(True)
            progress_bar.raise_()

            # Update to ensure it shows up
            progress_bar.update()
            self.progress_placeholder.update()

            # Emit signal
            self.progress_bar_moved.emit(progress_bar, self.progress_placeholder)

            # Reset flag after delay
            self._move_timer.start(200)

            return True

        except RuntimeError:
            # If the progress bar has been deleted, ignore
            self._reset_moving_flag()
            return False
        except Exception:
            self._reset_moving_flag()
            raise

    def finish_download_reparenting(self, progress_bar: QProgressBar,
    ) -> bool:
        """Finish download process by returning progress bar to original parent.
        
        Args:
            progress_bar: Progress bar widget to restore
            
        Returns:
            True if restoration was successful, False otherwise
        """
        if self.is_progress_bar_moving:
            return False

        self.is_progress_bar_moving = True

        try:
            # Remove from our layout if it's there
            if self.progress_placeholder_layout:
                for i in reversed(range(self.progress_placeholder_layout.count())):
                    item = self.progress_placeholder_layout.itemAt(i)
                    if item and item.widget() == progress_bar:
                        self.progress_placeholder_layout.removeItem(item)

            # Return progress bar to original parent and position
            if self.original_progress_parent is not None:
                progress_bar.setParent(self.original_progress_parent)
                if self.original_progress_geometry is not None:
                    progress_bar.setGeometry(self.original_progress_geometry)

            # Hide it in our dialog
            progress_bar.setVisible(False)

            # Emit signal
            if self.original_progress_parent:
                self.progress_bar_restored.emit(progress_bar, self.original_progress_parent)

            # Reset tracking variables
            self.original_progress_geometry = None
            self.original_progress_parent = None

            # Collapse the progress placeholder area
            if self.progress_placeholder:
                self.progress_placeholder.setFixedHeight(0)

            # Reset flag after delay
            self._move_timer.start(200)

            return True

        except RuntimeError:
            # If the progress bar has been deleted, ignore
            self._reset_moving_flag()
            return False
        except Exception:
            self._reset_moving_flag()
            raise

    def restore_to_main_window(self, progress_bar: QProgressBar, main_window: QWidget,
    ) -> bool:
        """Restore progress bar to main window during dialog close.
        
        Args:
            progress_bar: Progress bar widget to restore
            main_window: Main window widget
            
        Returns:
            True if restoration was successful, False otherwise
        """
        if self.is_progress_bar_moving:
            return False

        self.is_progress_bar_moving = True

        try:
            # Remove from our layout if it's there
            if self.progress_placeholder_layout:
                for i in reversed(range(self.progress_placeholder_layout.count())):
                    item = self.progress_placeholder_layout.itemAt(i)
                    if item and item.widget() == progress_bar:
                        self.progress_placeholder_layout.removeItem(item)

            # Return progress bar to original parent and position
            if self.original_progress_parent is not None:
                progress_bar.setParent(self.original_progress_parent)
                if self.original_progress_geometry is not None:
                    progress_bar.setGeometry(self.original_progress_geometry)
            # Fallback to centralwidget if original parent unknown
            elif hasattr(main_window, "centralwidget"):
                progress_bar.setParent(main_window.centralwidget)
            else:
                progress_bar.setParent(main_window)

            # Make sure it's visible if download is still ongoing
            progress_bar.setVisible(True)
            progress_bar.raise_()

            # Force update to ensure it appears
            progress_bar.update()
            if self.original_progress_parent is not None:
                self.original_progress_parent.update()
            elif hasattr(main_window, "centralwidget"):
                main_window.centralwidget.update()
            else:
                main_window.update()

            # Emit signal
target_parent = (
    self.original_progress_parent or getattr(main_window, "centralwidget", main_window))
            self.progress_bar_restored.emit(progress_bar, target_parent)

            # Reset flag after delay
            self._move_timer.start(200)

            return True

        except RuntimeError:
            # If the progress bar has been deleted, ignore
            self._reset_moving_flag()
            return False
        except Exception:
            self._reset_moving_flag()
            raise

    def is_reparenting_in_progress(self) -> bool:
        """Check if progress bar reparenting is currently in progress.

        Returns:
            True if reparenting is in progress, False otherwise
        """
        return self.is_progress_bar_moving

    def get_original_parent(self) -> QWidget | None:
        """Get the original parent of the progress bar.

        Returns:
            Original parent widget or None
        """
        return self.original_progress_parent

    def get_original_geometry(self) -> QRect | None:
        """Get the original geometry of the progress bar.

        Returns:
            Original geometry or None
        """
        return self.original_progress_geometry

    def reset_state(self) -> None:
        """Reset the service state."""
        self.is_progress_bar_moving = False
        self.original_progress_parent = None
        self.original_progress_geometry = None
        self._move_timer.stop()

    def _reset_moving_flag(self) -> None:
        """Reset the moving flag and emit finished signal."""
        self.is_progress_bar_moving = False
        self.reparenting_finished.emit()

    @staticmethod
    def create_progress_placeholder() -> tuple[QWidget, QVBoxLayout]:
        """Create a progress placeholder widget with layout.

        Returns:
            Tuple of (placeholder_widget, layout)
        """
        placeholder = QWidget()
        placeholder.setFixedHeight(0)  # Initially collapsed
        layout = QVBoxLayout(placeholder)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        return placeholder, layout

    def cleanup(self) -> None:
        """Cleanup resources and reset state."""
        self._move_timer.stop()
        self.reset_state()
        self.progress_placeholder = None
        self.progress_placeholder_layout = None