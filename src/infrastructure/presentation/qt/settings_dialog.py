"""Settings Dialog UI Component.

This module provides the main settings dialog coordinator that integrates
with domain services and follows the DDD architecture principles.
"""

import os

from PyQt6.QtCore import QEvent, QSize, Qt, pyqtSignal
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.infrastructure.common.configuration_service import get_config, save_config
from src.infrastructure.common.resource_service import resource_path
from src.presentation.qt.toggle_switch_widget import ToggleSwitch


class SettingsDialog(QDialog):
    """Main settings dialog coordinator.
    
    This class coordinates the settings dialog UI and integrates with
    domain services for settings management.
    """

    # Signals for settings changes
    settings_changed = pyqtSignal(dict)
    model_changed = pyqtSignal(str)
    quantization_changed = pyqtSignal(str)

    def __init__(self, parent=None):
        """Initialize the settings dialog.
        
        Args:
            parent: Parent widget
        """
        super().__init__(parent)
        self.parent_window = parent

        # Note: Use cases would be injected via DI in full implementation
        # For now, using direct config functions

        # Load current settings
        self._load_current_settings()

        # Initialize UI state
        self.recording_key = False
        self.pressed_keys: set[str] = set()
        self.combination = ""
        self.reset_buttons = []
        self.supported_file_types = [".wav", ".mp3", ".flac", ".ogg", ".m4a"]

        # Setup UI
        self._setup_ui()
        self._setup_connections()
        self._setup_event_filter()

    def _load_current_settings(self):
        """Load current settings from configuration."""
        config = get_config()

        # Load current values
        self.current_model = config.get("model", "whisper-turbo")
        self.current_quantization = config.get("quantization", "Full")
        self.current_rec_key = config.get("rec_key", "F9")
        # Use a safer fallback for sound path
        try:
            default_sound = resource_path("@resources/splash.wav")
        except FileNotFoundError:
            default_sound = "@resources/splash.wav"
        self.current_sound_path = config.get("sound_path", default_sound)
        self.enable_rec_sound = config.get("recording_sound", True)
        self.current_output_srt = config.get("output_srt", False)

        # LLM settings
        self.llm_enabled = config.get("llm_enabled", False)
        self.llm_model = config.get("llm_model", "microsoft/DialoGPT-medium")
        self.llm_quantization = config.get("llm_quantization", "Full")
        self.llm_prompt = config.get("llm_prompt", "Please correct any errors in the following text:")

        # Default values
        self.default_model = "whisper-turbo"
        self.default_quantization = "Full"
        self.default_rec_key = "F9"
        # Use a safer fallback for default sound path
        try:
            self.default_sound_path = resource_path("@resources/splash.wav")
        except FileNotFoundError:
            self.default_sound_path = "@resources/splash.wav"
        self.default_recording_sound = True
        self.default_output_srt = False
        self.default_llm_enabled = False
        self.default_llm_model = "microsoft/DialoGPT-medium"
        self.default_llm_quantization = "Full"
        self.default_llm_prompt = "Please correct any errors in the following text:"

    def _setup_ui(self):
        """Setup the user interface."""
        self.setWindowTitle("Settings")
        self.setFixedSize(500, 700)
        self.setModal(True)

        # Apply dark theme styling
        self._apply_styling()

        # Create main layout
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(15)
        main_layout.setContentsMargins(20, 20, 20, 20)

        # Create UI sections
        self._create_recording_key_section(main_layout)
        self._create_model_section(main_layout)
        self._create_llm_section(main_layout)
        self._create_sound_section(main_layout)
        self._create_output_section(main_layout)
        self._create_button_section(main_layout)

        main_layout.addStretch()

    def _apply_styling(self):
        """Apply dark theme styling to the dialog."""
        # Color scheme
        self.bg_color = "rgb(8, 11, 14)"
        self.section_bg_color = "rgb(18, 25, 31)"
        self.model_bg_color = "rgb(18, 25, 31)"
        self.llm_bg_color = "rgb(18, 25, 31)"
        self.sound_bg_color = "rgb(18, 25, 31)"

        # Style templates
        self.section_style_template = """
            QGroupBox {{
                background-color: {bg_color};
                border: 1px solid rgb(78, 106, 129);
                border-radius: 5px;
                margin-top: 10px;
                font-weight: bold;
                color: rgb(144, 164, 174);
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }}
        """

        self.divider_style = """
            QFrame {
                background-color: rgb(78, 106, 129);
                border: none;
            }
        """

        # Apply main dialog styling
        self.setStyleSheet(f"""
            QDialog {{
                background-color: {self.bg_color};
                color: rgb(144, 164, 174);
            }}
        """)

    def _create_recording_key_section(self, main_layout):
        """Create the recording key configuration section."""
        rec_key_group = QGroupBox("Recording Key")
        rec_key_group.setStyleSheet(self.section_style_template.format(bg_color=self.section_bg_color))

        rec_key_layout = QVBoxLayout()
        rec_key_layout.setSpacing(8)

        # Recording key container
        rec_key_container = QWidget()
        rec_key_container_layout = QHBoxLayout(rec_key_container)
        rec_key_container_layout.setContentsMargins(0, 0, 0, 0)

        # Recording key display
        self.rec_key_edit = QTextEdit()
        self.rec_key_edit.setFixedHeight(30)
        self.rec_key_edit.setText(self.current_rec_key)
        self.rec_key_edit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.rec_key_edit.setReadOnly(True)
        self.rec_key_edit.setStyleSheet("""
            QTextEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129)
            }
        """)

        # Change key button
        self.change_rec_key_btn = QPushButton("Change Key")
        self.change_rec_key_btn.setFixedHeight(30)
        self.change_rec_key_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)

        # Reset key button
        rec_key_reset_btn = self._create_reset_button()

        rec_key_container_layout.addWidget(self.rec_key_edit, 1)
        rec_key_container_layout.addWidget(self.change_rec_key_btn)
        rec_key_container_layout.addWidget(rec_key_reset_btn)

        rec_key_layout.addWidget(rec_key_container)
        rec_key_group.setLayout(rec_key_layout)
        main_layout.addWidget(rec_key_group)

    def _create_model_section(self, main_layout):
        """Create the model configuration section."""
        model_group = QGroupBox("Model Settings")
        model_group.setStyleSheet(self.section_style_template.format(bg_color=self.model_bg_color))

        model_layout = QVBoxLayout()
        model_layout.setSpacing(8)

        # Model selection
        model_widget = QWidget()
        model_row_layout = QHBoxLayout(model_widget)
        model_row_layout.setContentsMargins(0, 0, 0, 0)

        model_label = QLabel("Model:")
        model_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.model_combo = QComboBox()
        self.model_combo.addItems(["whisper-turbo", "lite-whisper-turbo", "lite-whisper-turbo-fast"])
        self.model_combo.setCurrentText(self.current_model)
        self.model_combo.setStyleSheet("""
            QComboBox {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
            }
            QComboBox QAbstractItemView {
                background-color: rgb(8, 11, 14);
            }
        """)

        model_reset_btn = self._create_reset_button()

        model_row_layout.addWidget(model_label)
        model_row_layout.addWidget(self.model_combo, 1)
        model_row_layout.addWidget(model_reset_btn)

        model_layout.addWidget(model_widget)

        # Divider
        divider = self._create_divider()
        model_layout.addWidget(divider)

        # Quantization selection
        quant_widget = QWidget()
        quant_row_layout = QHBoxLayout(quant_widget)
        quant_row_layout.setContentsMargins(0, 0, 0, 0)

        quant_label = QLabel("Quantization:")
        quant_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.quant_combo = QComboBox()
        self.quant_combo.addItems(["Full", "Quantized"] if "lite" not in self.current_model else ["Full"])
        self.quant_combo.setCurrentText(self.current_quantization)
        self.quant_combo.setStyleSheet("""
            QComboBox {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
            }
            QComboBox QAbstractItemView {
                background-color: rgb(8, 11, 14);
            }
        """)

        quant_reset_btn = self._create_reset_button()

        quant_row_layout.addWidget(quant_label)
        quant_row_layout.addWidget(self.quant_combo, 1)
        quant_row_layout.addWidget(quant_reset_btn)

        model_layout.addWidget(quant_widget)
        model_group.setLayout(model_layout)
        main_layout.addWidget(model_group)

    def _create_llm_section(self, main_layout):
        """Create the LLM configuration section."""
        llm_group = QGroupBox("LLM Settings")
        llm_group.setStyleSheet(self.section_style_template.format(bg_color=self.llm_bg_color))

        llm_layout = QVBoxLayout()
        llm_layout.setSpacing(8)

        # LLM enable toggle
        llm_enable_container = QWidget()
        llm_enable_layout = QHBoxLayout(llm_enable_container)
        llm_enable_layout.setContentsMargins(15, 10, 15, 10)

        llm_enable_label = QLabel("Enable LLM Processing")
        llm_enable_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.enable_llm_toggle = ToggleSwitch()
        self.enable_llm_toggle.setChecked(self.llm_enabled)

        llm_enable_layout.addWidget(llm_enable_label)
        llm_enable_layout.addStretch(1)
        llm_enable_layout.addWidget(self.enable_llm_toggle)

        llm_layout.addWidget(llm_enable_container)

        # LLM model selection
        llm_model_widget = QWidget()
        llm_model_layout = QHBoxLayout(llm_model_widget)
        llm_model_layout.setContentsMargins(0, 0, 0, 0)

        llm_model_label = QLabel("LLM Model:")
        llm_model_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.llm_model_combo = QComboBox()
        self.llm_model_combo.addItems(["microsoft/DialoGPT-medium", "microsoft/DialoGPT-large"])
        self.llm_model_combo.setCurrentText(self.llm_model)
        self.llm_model_combo.setStyleSheet("""
            QComboBox {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
            }
            QComboBox QAbstractItemView {
                background-color: rgb(8, 11, 14);
            }
        """)

        llm_model_reset_btn = self._create_reset_button()

        llm_model_layout.addWidget(llm_model_label)
        llm_model_layout.addWidget(self.llm_model_combo, 1)
        llm_model_layout.addWidget(llm_model_reset_btn)

        llm_layout.addWidget(llm_model_widget)

        # LLM prompt
        llm_prompt_widget = QWidget()
        llm_prompt_layout = QVBoxLayout(llm_prompt_widget)
        llm_prompt_layout.setContentsMargins(0, 0, 0, 0)

        llm_prompt_label = QLabel("LLM Prompt:")
        llm_prompt_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.llm_prompt_textbox = QLineEdit()
        self.llm_prompt_textbox.setText(self.llm_prompt)
        self.llm_prompt_textbox.setStyleSheet("""
            QLineEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px;
            }
        """)

        llm_prompt_layout.addWidget(llm_prompt_label)
        llm_prompt_layout.addWidget(self.llm_prompt_textbox)

        llm_layout.addWidget(llm_prompt_widget)
        llm_group.setLayout(llm_layout)
        main_layout.addWidget(llm_group)

    def _create_sound_section(self, main_layout):
        """Create the sound configuration section."""
        sound_group = QGroupBox("Sound Settings")
        sound_group.setStyleSheet(self.section_style_template.format(bg_color=self.sound_bg_color))

        sound_layout = QVBoxLayout()
        sound_layout.setSpacing(8)

        # Recording sound toggle
        sound_enable_container = QWidget()
        sound_enable_layout = QHBoxLayout(sound_enable_container)
        sound_enable_layout.setContentsMargins(15, 10, 15, 10)

        sound_enable_label = QLabel("Enable Recording Sound")
        sound_enable_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.sound_toggle = ToggleSwitch()
        self.sound_toggle.setChecked(self.enable_rec_sound)

        sound_enable_layout.addWidget(sound_enable_label)
        sound_enable_layout.addStretch(1)
        sound_enable_layout.addWidget(self.sound_toggle)

        sound_layout.addWidget(sound_enable_container)

        # Sound file selection
        sound_file_widget = QWidget()
        sound_file_layout = QHBoxLayout(sound_file_widget)
        sound_file_layout.setContentsMargins(0, 0, 0, 0)

        sound_file_label = QLabel("Sound File:")
        sound_file_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.sound_path_display = QLineEdit()
        self.sound_path_display.setText(os.path.basename(self.current_sound_path))
        self.sound_path_display.setToolTip(self.current_sound_path)
        self.sound_path_display.setStyleSheet("""
            QLineEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px;
            }
        """)

        browse_btn = QPushButton("Browse")
        browse_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)

        sound_reset_btn = self._create_reset_button()

        sound_file_layout.addWidget(sound_file_label)
        sound_file_layout.addWidget(self.sound_path_display, 1)
        sound_file_layout.addWidget(browse_btn)
        sound_file_layout.addWidget(sound_reset_btn)

        sound_layout.addWidget(sound_file_widget)
        sound_group.setLayout(sound_layout)
        main_layout.addWidget(sound_group)

    def _create_output_section(self, main_layout):
        """Create the output configuration section."""
        form_layout = QFormLayout()

        # SRT output toggle
        srt_container = QWidget()
        srt_layout = QHBoxLayout(srt_container)
        srt_layout.setContentsMargins(15, 10, 15, 10)

        srt_label = QLabel("Output SRT with timestamps")
        srt_label.setStyleSheet("color: rgb(144, 164, 174);")

        self.srt_toggle = ToggleSwitch()
        self.srt_toggle.setChecked(self.current_output_srt)

        srt_layout.addWidget(srt_label)
        srt_layout.addStretch(1)
        srt_layout.addWidget(self.srt_toggle)

        form_layout.addRow("", srt_container)
        main_layout.addLayout(form_layout)

    def _create_button_section(self, main_layout):
        """Create the button section."""
        button_area = QWidget()
        button_layout = QHBoxLayout(button_area)

        # Reset all button
        reset_all_btn = QPushButton("Reset All")
        reset_all_btn.setFixedHeight(30)
        reset_all_btn.setIcon(QIcon(resource_path("@resources/Command-Reset-256.png")))
        reset_all_btn.setIconSize(QSize(16, 16))
        reset_all_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)

        self.reset_all_btn = reset_all_btn
        self.reset_buttons.append(reset_all_btn)

        button_layout.addWidget(reset_all_btn)
        button_layout.addStretch()

        main_layout.addWidget(button_area)

    def _create_reset_button(self) -> QPushButton:
        """Create a standardized reset button."""
        reset_btn = QPushButton()
        reset_btn.setToolTip("Reset to default")
        reset_btn.setIcon(QIcon(resource_path("@resources/Command-Reset-256.png")))
        reset_btn.setIconSize(QSize(16, 16))
        reset_btn.setFixedSize(17, 30)
        reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        self.reset_buttons.append(reset_btn)
        return reset_btn

    def _create_divider(self) -> QFrame:
        """Create a standardized divider line."""
        divider = QFrame()
        divider.setFrameShape(QFrame.Shape.HLine)
        divider.setFixedHeight(1)
        divider.setStyleSheet(self.divider_style)
        return divider

    def _setup_connections(self):
        """Setup signal connections."""
        # Model and quantization changes
        self.model_combo.currentTextChanged.connect(self._on_model_changed)
        self.quant_combo.currentTextChanged.connect(self._on_quantization_changed)

        # Sound settings
        self.sound_toggle.valueChanged.connect(self._on_recording_sound_changed)
        self.sound_path_display.textChanged.connect(self._on_sound_path_changed)

        # LLM settings
        self.enable_llm_toggle.valueChanged.connect(self._on_llm_enabled_changed)
        self.llm_model_combo.currentTextChanged.connect(self._on_llm_model_changed)
        self.llm_prompt_textbox.textChanged.connect(self._on_llm_prompt_changed)

        # Output settings
        self.srt_toggle.valueChanged.connect(self._on_srt_output_changed)

        # Recording key
        self.change_rec_key_btn.clicked.connect(self._toggle_rec_key_recording)

        # Reset buttons
        self.reset_all_btn.clicked.connect(self._reset_all)

    def _setup_event_filter(self):
        """Setup event filter for drag and drop and key recording."""
        self.setAcceptDrops(True)
        self.installEventFilter(self)

    def _on_model_changed(self):
        """Handle model selection changes."""
        model = self.model_combo.currentText()
        self.current_model = model

        # Update quantization options based on model
        if "lite" in model:
            self.quant_combo.clear()
            self.quant_combo.addItem("Full")
            self.quant_combo.setCurrentText("Full")
            self.quant_combo.setEnabled(False)
        else:
            self.quant_combo.clear()
            self.quant_combo.addItems(["Full", "Quantized"])
            self.quant_combo.setCurrentText(self.current_quantization)
            self.quant_combo.setEnabled(True)

        self._save_settings()
        self.model_changed.emit(model)

    def _on_quantization_changed(self):
        """Handle quantization selection changes."""
        quantization = self.quant_combo.currentText()
        self.current_quantization = quantization
        self._save_settings()
        self.quantization_changed.emit(quantization)

    def _on_recording_sound_changed(self):
        """Handle recording sound toggle changes."""
        self.enable_rec_sound = self.sound_toggle.isChecked()
        self._save_settings()

    def _on_sound_path_changed(self):
        """Handle sound path changes."""
        # This will be triggered by drag and drop or manual editing

    def _on_llm_enabled_changed(self):
        """Handle LLM enabled toggle changes."""
        self.llm_enabled = self.enable_llm_toggle.isChecked()
        self._save_settings()

    def _on_llm_model_changed(self):
        """Handle LLM model selection changes."""
        self.llm_model = self.llm_model_combo.currentText()
        self._save_settings()

    def _on_llm_prompt_changed(self):
        """Handle LLM prompt changes."""
        self.llm_prompt = self.llm_prompt_textbox.text()
        self._save_settings()

    def _on_srt_output_changed(self):
        """Handle SRT output toggle changes."""
        self.current_output_srt = self.srt_toggle.isChecked()
        self._save_settings()

    def _toggle_rec_key_recording(self):
        """Toggle recording key capture mode."""
        self.recording_key = not self.recording_key
        if self.recording_key:
            self.change_rec_key_btn.setText("Stop Recording")
            self.pressed_keys.clear()
            self.rec_key_edit.setText("Press keys...")
        else:
            self.change_rec_key_btn.setText("Change Key")
            if self.combination:
                self.current_rec_key = self.combination
                self.rec_key_edit.setText(self.current_rec_key)
                self._save_settings()
            else:
                self.rec_key_edit.setText(self.current_rec_key)

    def _reset_all(self):
        """Reset all settings to defaults."""
        # Reset all values to defaults
        self.current_model = self.default_model
        self.current_quantization = self.default_quantization
        self.current_rec_key = self.default_rec_key
        self.current_sound_path = self.default_sound_path
        self.enable_rec_sound = self.default_recording_sound
        self.current_output_srt = self.default_output_srt
        self.llm_enabled = self.default_llm_enabled
        self.llm_model = self.default_llm_model
        self.llm_quantization = self.default_llm_quantization
        self.llm_prompt = self.default_llm_prompt

        # Update UI
        self._update_ui_from_settings()
        self._save_settings()

    def _update_ui_from_settings(self):
        """Update UI controls from current settings."""
        self.model_combo.setCurrentText(self.current_model)
        self.quant_combo.setCurrentText(self.current_quantization)
        self.rec_key_edit.setText(self.current_rec_key)
        self.sound_path_display.setText(os.path.basename(self.current_sound_path))
        self.sound_path_display.setToolTip(self.current_sound_path)
        self.sound_toggle.setChecked(self.enable_rec_sound)
        self.srt_toggle.setChecked(self.current_output_srt)
        self.enable_llm_toggle.setChecked(self.llm_enabled)
        self.llm_model_combo.setCurrentText(self.llm_model)
        self.llm_prompt_textbox.setText(self.llm_prompt)

    def _save_settings(self):
        """Save current settings to configuration."""
        config = {
            "model": self.current_model,
            "quantization": self.current_quantization,
            "rec_key": self.current_rec_key,
            "sound_path": self.current_sound_path,
            "recording_sound": self.enable_rec_sound,
            "output_srt": self.current_output_srt,
            "llm_enabled": self.llm_enabled,
            "llm_model": self.llm_model,
            "llm_quantization": self.llm_quantization,
            "llm_prompt": self.llm_prompt,
        }
        save_config(config)
        self.settings_changed.emit(config)

    def eventFilter(self, obj, event):
        """Handle drag and drop and key recording events."""
        if event.type() == QEvent.Type.DragEnter:
            mime_data = event.mimeData()
            if mime_data.hasUrls():
                file_path = mime_data.urls()[0].toLocalFile()
                if any(file_path.lower().endswith(ext) for ext in self.supported_file_types):
                    obj.setCursor(Qt.CursorShape.DragCopyCursor)
                    event.acceptProposedAction()
                    return True

        elif event.type() == QEvent.Type.DragLeave:
            obj.unsetCursor()
            return True

        elif event.type() == QEvent.Type.Drop:
            mime_data = event.mimeData()
            if mime_data.hasUrls():
                url = mime_data.urls()[0]
                path = url.toLocalFile()
                if any(path.lower().endswith(ext) for ext in self.supported_file_types):
                    obj.unsetCursor()
                    self.current_sound_path = path
                    self.sound_path_display.setText(os.path.basename(path))
                    self.sound_path_display.setToolTip(path)
                    self._save_settings()
                    event.acceptProposedAction()
                    return True

        elif event.type() == QEvent.Type.KeyPress and self.recording_key:
            self._handle_key_press(event)
            return True

        elif event.type() == QEvent.Type.KeyRelease and self.recording_key:
            self._handle_key_release(event)
            return True

        return super().eventFilter(obj, event)

    def _handle_key_press(self, event):
        """Handle key press events during key recording."""
        key_text = self._get_key_name(event)
        if key_text:
            self.pressed_keys.add(key_text)
            self._update_rec_key_display()

    def _handle_key_release(self, event):
        """Handle key release events during key recording."""
        key_text = self._get_key_name(event)
        if key_text and key_text in self.pressed_keys:
            self.pressed_keys.discard(key_text)
            self._update_rec_key_display()

    def _update_rec_key_display(self):
        """Update the recording key display."""
        if len(self.pressed_keys) > 0:
            self.combination = "+".join(sorted(self.pressed_keys))
            self.rec_key_edit.setText(self.combination)

    def _get_key_name(self, event) -> str | None:
        """Get the printable name of a key."""
        key = event.key()

        # Handle modifier keys
        if key == Qt.Key.Key_Control:
            return "CTRL"
        if key == Qt.Key.Key_Alt:
            return "ALT"
        if key == Qt.Key.Key_Shift:
            return "SHIFT"
        if key == Qt.Key.Key_Meta:
            return "META"

        # Handle function keys
        if Qt.Key.Key_F1 <= key <= Qt.Key.Key_F35:
            return f"F{key - Qt.Key.Key_F1 + 1}"

        # Handle other keys
        key_text = event.text()
        if key_text and key_text.isprintable():
            return key_text.upper()

        return None

    # Public interface methods
    def get_selected_model(self) -> str:
        """Get the currently selected model."""
        return self.current_model

    def get_selected_quantization(self) -> str:
        """Get the currently selected quantization."""
        return self.current_quantization

    def is_recording_sound_enabled(self) -> bool:
        """Check if recording sound is enabled."""
        return self.enable_rec_sound

    def is_srt_output_enabled(self) -> bool:
        """Check if SRT output is enabled."""
        return self.current_output_srt

    def get_sound_path(self) -> str:
        """Get the current sound file path."""
        return self.current_sound_path

    def is_llm_enabled(self) -> bool:
        """Check if LLM processing is enabled."""
        return self.llm_enabled

    def get_llm_model(self) -> str:
        """Get the currently selected LLM model."""
        return self.llm_model

    def get_llm_prompt(self) -> str:
        """Get the current LLM prompt."""
        return self.llm_prompt

    def get_recording_key(self) -> str:
        """Get the current recording key combination."""
        return self.current_rec_key