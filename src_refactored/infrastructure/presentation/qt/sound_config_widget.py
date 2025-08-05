"""Sound Configuration Widget Component.

This module provides a reusable widget for sound configuration
that integrates with domain services and follows DDD architecture principles.
"""

import os

from PyQt6.QtCore import QEvent, QSize, pyqtSignal
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QFont, QIcon
from PyQt6.QtWidgets import (
    QFileDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from src.core.utils import resource_path
from src_refactored.application.use_cases.settings_management.reset_sound_settings_use_case import (
    ResetSoundSettingsUseCase,
)
from src_refactored.application.use_cases.settings_management.update_sound_settings_use_case import (
    UpdateSoundSettingsUseCase,
)
from src_refactored.domain.settings_management.value_objects.sound_configuration import (
    SoundConfiguration,
)
from src_refactored.infrastructure.presentation.qt.toggle_switch_widget import ToggleSwitch


class SoundConfigWidget(QGroupBox):
    """Sound configuration widget component.
    
    This widget provides UI controls for sound configuration including
    enable/disable toggle and sound file selection with drag-and-drop support.
    """

    # Signals for sound configuration changes
    sound_enabled_changed = pyqtSignal(bool)
    sound_file_changed = pyqtSignal(str)
    sound_reset = pyqtSignal()

    def __init__(self, parent=None):
        """Initialize the sound configuration widget.
        
        Args:
            parent: Parent widget
        """
        super().__init__("Sound Settings", parent)

        # Initialize use cases (these would be injected via DI in full implementation)
        self._update_sound_use_case = UpdateSoundSettingsUseCase()
        self._reset_sound_use_case = ResetSoundSettingsUseCase()

        # Current configuration
        self._current_enabled = False
        self._current_sound_path = ""

        # Default configuration
        self._default_enabled = False
        self._default_sound_path = ""

        # UI components
        self.sound_toggle: ToggleSwitch | None = None
        self.sound_path_display: QLineEdit | None = None
        self.browse_btn: QPushButton | None = None
        self.sound_reset_btn: QPushButton | None = None

        # Setup UI
        self._setup_ui()
        self._setup_connections()
        self._setup_drag_drop()

    def _setup_ui(self):
        """Setup the user interface."""
        # Apply styling
        self._apply_styling()

        # Create main layout
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # Create sound enable toggle section
        self._create_enable_toggle(layout)

        # Create divider
        self._create_divider(layout)

        # Create sound file selection section
        self._create_file_selection(layout)

    def _apply_styling(self):
        """Apply dark theme styling to the widget."""
        self.setStyleSheet("""
            QGroupBox {
                background-color: rgb(18, 25, 31);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 5px;
                margin-top: 10px;
                font-weight: bold;
                color: rgb(144, 164, 174);
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """)

    def _create_enable_toggle(self, layout: QVBoxLayout):
        """Create the sound enable toggle section.
        
        Args:
            layout: Parent layout to add the section to
        """
        toggle_widget = QWidget()
        toggle_layout = QHBoxLayout(toggle_widget)
        toggle_layout.setContentsMargins(0, 0, 0, 0)

        # Enable sound label
        toggle_label = QLabel("Enable recording sound")
        toggle_label.setFont(QFont())
        toggle_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Enable sound toggle switch
        self.sound_toggle = ToggleSwitch()
        self.sound_toggle.setChecked(self._current_enabled)

        # Add to layout
        toggle_layout.addWidget(toggle_label)
        toggle_layout.addStretch(1)
        toggle_layout.addWidget(self.sound_toggle)

        layout.addWidget(toggle_widget)

    def _create_file_selection(self, layout: QVBoxLayout):
        """Create the sound file selection section.
        
        Args:
            layout: Parent layout to add the section to
        """
        file_widget = QWidget()
        file_layout = QHBoxLayout(file_widget)
        file_layout.setContentsMargins(0, 0, 0, 0)

        # Sound file label
        file_label = QLabel("Sound File:")
        file_label.setFont(QFont())
        file_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Sound path display
        self.sound_path_display = QLineEdit()
        self._update_path_display()
        self.sound_path_display.setReadOnly(True)
        self.sound_path_display.setStyleSheet("""
            QLineEdit {
                color: rgb(163, 190, 203);
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px;
            }
        """)
        self.sound_path_display.setFixedHeight(30)

        # Browse button
        self.browse_btn = self._create_action_button(
            "Browse for sound file",
            "resources/open-folder.png",
            self._on_browse_clicked,
        )

        # Reset button
        self.sound_reset_btn = self._create_action_button(
            "Reset to default sound file",
            "resources/Command-Reset-256.png",
            self._on_reset_clicked,
        )

        # Add to layout
        file_layout.addWidget(file_label)
        file_layout.addWidget(self.sound_path_display, 1)
        file_layout.addWidget(self.browse_btn)
        file_layout.addWidget(self.sound_reset_btn)

        layout.addWidget(file_widget)

    def _create_divider(self, layout: QVBoxLayout):
        """Create a divider line.
        
        Args:
            layout: Parent layout to add the divider to
        """
        divider = QFrame()
        divider.setFrameShape(QFrame.Shape.HLine)
        divider.setFixedHeight(1)
        divider.setStyleSheet("""
            QFrame {
                background-color: rgb(78, 106, 129);
                border: none;
            }
        """)
        layout.addWidget(divider)

    def _create_action_button(self, tooltip: str, icon_path: str, callback) -> QPushButton:
        """Create a standardized action button.
        
        Args:
            tooltip: Tooltip text for the button
            icon_path: Path to the button icon
            callback: Function to call when button is clicked
            
        Returns:
            Configured action button
        """
        button = QPushButton()
        button.setToolTip(tooltip)
        button.setIcon(QIcon(resource_path(icon_path)))
        button.setIconSize(QSize(16, 16))
        button.setFixedSize(17, 30)
        button.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        button.clicked.connect(callback)
        return button

    def _setup_connections(self):
        """Setup signal connections."""
        if self.sound_toggle:
            self.sound_toggle.valueChanged.connect(self._on_sound_enabled_changed)

    def _setup_drag_drop(self):
        """Setup drag and drop functionality."""
        # Enable drag and drop for the widget and path display
        self.setAcceptDrops(True)
        if self.sound_path_display:
            self.sound_path_display.setAcceptDrops(True)

    def _update_path_display(self):
        """Update the path display with current sound path."""
        if not self.sound_path_display:
            return

        if self._current_sound_path:
            display_text = os.path.basename(self._current_sound_path)
            tooltip_text = self._current_sound_path
        else:
            display_text = "No file selected"
            tooltip_text = ""

        self.sound_path_display.setText(display_text)
        self.sound_path_display.setToolTip(tooltip_text)

    def _on_sound_enabled_changed(self):
        """Handle sound enabled state changes."""
        if not self.sound_toggle:
            return

        new_enabled = self.sound_toggle.isChecked()
        if new_enabled != self._current_enabled:
            self._current_enabled = new_enabled
            self.sound_enabled_changed.emit(new_enabled)

    def _on_browse_clicked(self):
        """Handle browse button click."""
        file_dialog = QFileDialog(self)
        file_dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        file_dialog.setNameFilter("Audio Files (*.wav *.mp3 *.ogg *.flac *.aac);;All Files (*)")
        file_dialog.setWindowTitle("Select Sound File")

        if self._current_sound_path:
            file_dialog.setDirectory(os.path.dirname(self._current_sound_path))

        if file_dialog.exec() == QFileDialog.DialogCode.Accepted:
            selected_files = file_dialog.selectedFiles()
            if selected_files:
                self._set_sound_path(selected_files[0])

    def _on_reset_clicked(self):
        """Handle reset button click."""
        self._set_sound_path(self._default_sound_path)
        self.sound_reset.emit()

    def _set_sound_path(self, path: str):
        """Set the sound file path.
        
        Args:
            path: Path to the sound file
        """
        if path != self._current_sound_path:
            self._current_sound_path = path
            self._update_path_display()
            self.sound_file_changed.emit(path)

    def _is_valid_audio_file(self, file_path: str) -> bool:
        """Check if the file is a valid audio file.
        
        Args:
            file_path: Path to check
            
        Returns:
            True if valid audio file, False otherwise
        """
        valid_extensions = {".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".wma"}
        return os.path.splitext(file_path.lower())[1] in valid_extensions

    # Event handling for drag and drop
    def dragEnterEvent(self, event: QDragEnterEvent):
        """Handle drag enter events.
        
        Args:
            event: Drag enter event
        """
        if event.mimeData().hasUrls():
            urls = event.mimeData().urls()
            if len(urls) == 1 and urls[0].isLocalFile():
                file_path = urls[0].toLocalFile()
                if self._is_valid_audio_file(file_path):
                    event.acceptProposedAction()
                    return
        event.ignore()

    def dropEvent(self, event: QDropEvent):
        """Handle drop events.
        
        Args:
            event: Drop event
        """
        if event.mimeData().hasUrls():
            urls = event.mimeData().urls()
            if len(urls) == 1 and urls[0].isLocalFile():
                file_path = urls[0].toLocalFile()
                if self._is_valid_audio_file(file_path):
                    self._set_sound_path(file_path)
                    event.acceptProposedAction()
                    return
        event.ignore()

    def eventFilter(self, obj, event: QEvent) -> bool:
        """Filter events for child widgets.
        
        Args:
            obj: Object that received the event
            event: Event to filter
            
        Returns:
            True if event was handled, False otherwise
        """
        # Handle drag and drop events for the path display
        if obj == self.sound_path_display:
            if event.type() == QEvent.Type.DragEnter:
                self.dragEnterEvent(event)
                return True
            if event.type() == QEvent.Type.Drop:
                self.dropEvent(event)
                return True

        return super().eventFilter(obj, event)

    # Public interface methods
    def set_sound_enabled(self, enabled: bool):
        """Set the sound enabled state.
        
        Args:
            enabled: Whether sound should be enabled
        """
        self._current_enabled = enabled
        if self.sound_toggle:
            self.sound_toggle.setChecked(enabled)

    def set_sound_file(self, file_path: str):
        """Set the current sound file path.
        
        Args:
            file_path: Path to the sound file
        """
        self._set_sound_path(file_path)

    def get_sound_enabled(self) -> bool:
        """Get the current sound enabled state.
        
        Returns:
            Current sound enabled state
        """
        return self._current_enabled

    def get_sound_file(self) -> str:
        """Get the current sound file path.
        
        Returns:
            Current sound file path
        """
        return self._current_sound_path

    def get_sound_configuration(self) -> SoundConfiguration:
        """Get the current sound configuration as a domain object.
        
        Returns:
            SoundConfiguration domain object
        """
        return SoundConfiguration(
            enabled=self._current_enabled,
            sound_file_path=self._current_sound_path,
        )

    def set_sound_configuration(self, config: SoundConfiguration):
        """Set the sound configuration from a domain object.
        
        Args:
            config: SoundConfiguration domain object
        """
        self.set_sound_enabled(config.enabled)
        self.set_sound_file(config.sound_file_path)

    def reset_to_defaults(self):
        """Reset all sound settings to default values."""
        self.set_sound_enabled(self._default_enabled)
        self.set_sound_file(self._default_sound_path)
        self.sound_reset.emit()

    def set_enabled(self, enabled: bool):
        """Enable or disable the entire widget.
        
        Args:
            enabled: Whether to enable the widget
        """
        if self.sound_toggle:
            self.sound_toggle.setEnabled(enabled)
        if self.sound_path_display:
            self.sound_path_display.setEnabled(enabled)
        if self.browse_btn:
            self.browse_btn.setEnabled(enabled)
        if self.sound_reset_btn:
            self.sound_reset_btn.setEnabled(enabled)

    def set_default_sound_file(self, file_path: str):
        """Set the default sound file path.
        
        Args:
            file_path: Default sound file path
        """
        self._default_sound_path = file_path

    def get_default_sound_file(self) -> str:
        """Get the default sound file path.
        
        Returns:
            Default sound file path
        """
        return self._default_sound_path

    def clear_sound_file(self):
        """Clear the current sound file selection."""
        self._set_sound_path("")

    def has_sound_file(self) -> bool:
        """Check if a sound file is currently selected.
        
        Returns:
            True if a sound file is selected, False otherwise
        """
        return bool(self._current_sound_path and os.path.exists(self._current_sound_path))

    def validate_sound_file(self) -> bool:
        """Validate the current sound file.
        
        Returns:
            True if the sound file is valid, False otherwise
        """
        if not self._current_sound_path:
            return True  # Empty path is valid (no sound)

        return (os.path.exists(self._current_sound_path) and
                self._is_valid_audio_file(self._current_sound_path))