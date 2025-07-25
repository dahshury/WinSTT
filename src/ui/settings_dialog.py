import json
import os

import onnxruntime as ort
from PyQt6.QtCore import QEvent, QSize, Qt, QTimer
from PyQt6.QtGui import QFont, QIcon
from PyQt6.QtWidgets import (
    QComboBox,
    QDialog,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGraphicsOpacityEffect,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSlider,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.core.utils import resource_path


class ToggleSwitch(QSlider):
    """Custom toggle switch that looks like a mobile toggle"""
    def __init__(self, parent=None):
        super().__init__(Qt.Orientation.Horizontal, parent)
        self.setMaximum(1)
        self.setMinimum(0)
        self.setFixedSize(23, 11)  # Half the original size (46x22)
        self.setSingleStep(1)
        self.setPageStep(1)
        self.setStyleSheet("""
            QSlider::groove:horizontal {
                border: 1px solid rgba(78, 106, 129, 120);
                height: 10px;
                background: rgba(54, 71, 84, 180);
                border-radius: 5px;
            }
            QSlider::handle:horizontal {
                background: white;
                border: 1px solid rgba(78, 106, 129, 150);
                width: 9px;
                height: 9px;
                margin: 0px;
                border-radius: 4px;
            }
            QSlider::handle:horizontal:checked, QSlider::handle:horizontal:on {
                background: rgb(0, 122, 255);
            }
            QSlider::groove:horizontal:on {
                background: rgba(0, 122, 255, 40);
            }
        """)
        
    def mousePressEvent(self, event):
        """Make the toggle switch clickable by changing state on click"""
        if event.button() == Qt.MouseButton.LeftButton:
            # Toggle the state
            self.setValue(0 if self.value() == 1 else 1)
            event.accept()
        else:
            super().mousePressEvent(event)
        
    def paintEvent(self, event):
        super().paintEvent(event)
        
        # Change handle color when checked
        if self.value() == 1:
            self.setStyleSheet("""
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(0, 122, 255, 40);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """)
        else:
            self.setStyleSheet("""
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(54, 71, 84, 180);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """)
            
    def isChecked(self):
        return self.value() == 1
        
    def setChecked(self, checked):
        self.setValue(1 if checked else 0)


class SettingsDialog(QDialog):
    def __init__(self, current_model, current_quantization, enable_rec_sound, current_sound_path, output_srt, parent=None, 
                 llm_enabled=False, llm_model="gemma-3-1b-it", llm_quantization="Full", llm_prompt="You are a helpful assistant."):
        super().__init__(parent)
        self.setWindowTitle("Settings")
        self.setFixedSize(350, 520)  # Increased height to accommodate new controls
        
        # Default values for settings
        self.default_model = "whisper-turbo"
        self.default_quantization = "Full" if ort.get_device() == "GPU" else "Quantized"
        self.default_recording_sound = True
        self.default_sound_path = resource_path("resources/splash.mp3")
        self.default_output_srt = False
        self.default_rec_key = "CTRL+ALT+A"
        
        # Default values for LLM settings
        self.default_llm_enabled = False
        self.default_llm_model = "gemma-3-1b-it"
        self.default_llm_quantization = "Full"
        self.default_llm_prompt = "You are a helpful assistant."
        
        # Flag to track if we're currently downloading a model
        self.is_downloading_model = False
        
        # Store parent reference to access its progress bar
        self.parent_window = parent
        
        # Store original progress bar geometry for restoration
        self.original_progress_geometry = None
        self.original_progress_parent = None
        
        # Debounce timer for progress bar operations
        self.progress_timer = QTimer()
        self.progress_timer.setSingleShot(True)
        self.progress_timer.setInterval(200)  # 200ms debounce
        
        # Tracking flag to prevent multiple operations
        self.is_progress_bar_moving = False
        
        # Store a reference to our reset_all button (will be created later)
        self.reset_all_btn = None
        
        # List to store all reset buttons that need to be disabled during download
        self.reset_buttons = []
        
        # Create a placeholder for the progress bar in our layout
        self.progress_placeholder = QWidget()
        self.progress_placeholder.setFixedHeight(20)  # Approximate height of progress bar
        self.progress_placeholder_layout = QHBoxLayout(self.progress_placeholder)
        self.progress_placeholder_layout.setContentsMargins(0, 0, 0, 0)
        self.progress_placeholder_layout.setSpacing(0)
        
        # Load settings from JSON
        self.load_settings_from_json()
        
        # Store current values
        self.current_model = current_model
        self.current_quantization = current_quantization
        self.enable_rec_sound = enable_rec_sound
        self.current_sound_path = current_sound_path
        self.current_output_srt = output_srt
        self.current_rec_key = parent.rec_key if parent and hasattr(parent, "rec_key") else self.default_rec_key
        
        # Store current LLM values
        self.current_llm_enabled = llm_enabled
        self.current_llm_model = llm_model
        self.current_llm_quantization = llm_quantization
        self.current_llm_prompt = llm_prompt
        
        # For key recording
        self.recording_key = False
        self.pressed_keys = set()
        self.supported_file_types = [".mp3", ".wav", ".ogg", ".flac", ".aac", ".wma", ".m4a"]
        
        # Inherit palette from parent for theme consistency
        if parent:
            self.setPalette(parent.palette())
        
        # Font for consistency
        font = QFont("Roboto")
        
        # Set consistent button height
        button_height = 22
        
        # Base styles
        self.setStyleSheet("""
            QDialog {
                background-color: #141b1f;
            }
        """)
        
        # Section background colors - use #0c0e13 for all sections
        self.rec_key_bg_color = "#0c0e13"      # Recording key settings
        self.model_bg_color = "#0c0e13"        # Model settings 
        self.llm_bg_color = "#0c0e13"          # LLM settings
        self.sound_bg_color = "#0c0e13"        # Sound settings
        
        # Set section styles
        self.section_style_template = """
            QGroupBox {{
                color: rgb(144, 164, 174);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                margin-top: 10px;
                background-color: {bg_color};
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                subcontrol-position: top left;
                padding: 0 3px;
            }}
        """
        
        # Divider style
        self.divider_style = """
            QFrame {
                color: rgba(78, 106, 129, 80);
                background-color: rgba(78, 106, 129, 0);
            }
        """
        
        # Main layout
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(5)
        main_layout.setContentsMargins(10, 10, 10, 10)
        
        # Create a form layout for SRT checkbox
        form_layout = QFormLayout()
        
        # Create a group box for recording key settings - now at the top
        rec_key_group = QGroupBox("Recording Key Settings")
        rec_key_group.setStyleSheet(self.section_style_template.format(bg_color=self.rec_key_bg_color))
        rec_key_layout = QVBoxLayout()
        rec_key_layout.setSpacing(8)
        
        # Recording key field container
        rec_key_container = QWidget()
        rec_key_container_layout = QHBoxLayout(rec_key_container)
        rec_key_container_layout.setContentsMargins(0, 0, 0, 0)
        
        self.rec_key_edit = QTextEdit()
        self.rec_key_edit.setFixedHeight(button_height)
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
        
        # Change record key button
        self.change_rec_key_btn = QPushButton("Change Key")
        self.change_rec_key_btn.setFixedHeight(button_height)
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
        self.change_rec_key_btn.clicked.connect(self.toggle_rec_key_recording)
        
        # Reset record key button
        rec_key_reset_btn = QPushButton()
        rec_key_reset_btn.setToolTip("Reset to default recording key")
        rec_key_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        rec_key_reset_btn.setIconSize(QSize(16, 16))
        rec_key_reset_btn.setFixedSize(17, button_height)
        rec_key_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        rec_key_reset_btn.clicked.connect(self.reset_rec_key)
        self.reset_buttons.append(rec_key_reset_btn)
        
        rec_key_container_layout.addWidget(self.rec_key_edit, 1)
        rec_key_container_layout.addWidget(self.change_rec_key_btn)
        rec_key_container_layout.addWidget(rec_key_reset_btn)
        
        rec_key_layout.addWidget(rec_key_container)
        rec_key_group.setLayout(rec_key_layout)
        
        # Group box for model and quantization settings - now second
        model_group = QGroupBox("Model Settings")
        model_group.setStyleSheet(self.section_style_template.format(bg_color=self.model_bg_color))
        model_layout = QVBoxLayout()
        model_layout.setSpacing(8)
        
        # Model selection widget
        model_widget = QWidget()
        model_row_layout = QHBoxLayout(model_widget)
        model_row_layout.setContentsMargins(0, 0, 0, 0)
        
        model_label = QLabel("Model:")
        model_label.setFont(font)
        model_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.model_combo = QComboBox()
        self.model_combo.addItem("whisper-turbo")
        self.model_combo.addItem("lite-whisper-turbo")
        self.model_combo.addItem("lite-whisper-turbo-fast")
        self.model_combo.setCurrentText(current_model)
        self.model_combo.setEnabled(True)
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
        
        # Reset button for model
        model_reset_btn = QPushButton()
        model_reset_btn.setToolTip("Reset to default model")
        model_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        model_reset_btn.setIconSize(QSize(16, 16))
        model_reset_btn.setFixedSize(17, button_height)
        model_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        model_reset_btn.clicked.connect(self.reset_model)
        self.reset_buttons.append(model_reset_btn)
        
        model_row_layout.addWidget(model_label)
        model_row_layout.addWidget(self.model_combo, 1)
        model_row_layout.addWidget(model_reset_btn)
        
        model_layout.addWidget(model_widget)
        
        # Divider line
        divider1 = QFrame()
        divider1.setFrameShape(QFrame.Shape.HLine)
        divider1.setFixedHeight(1)
        divider1.setStyleSheet(self.divider_style)
        model_layout.addWidget(divider1)
        
        # Quantization selection widget
        quant_widget = QWidget()
        quant_row_layout = QHBoxLayout(quant_widget)
        quant_row_layout.setContentsMargins(0, 0, 0, 0)
        
        quant_label = QLabel("Quantization:")
        quant_label.setFont(font)
        quant_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.quant_combo = QComboBox()
        self.quant_combo.addItems(["Full", "Quantized"] if "lite" not in self.current_model else ["Full"])
        self.quant_combo.setCurrentText(current_quantization)
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
        
        # Reset button for quantization
        quant_reset_btn = QPushButton()
        quant_reset_btn.setToolTip("Reset to default quantization")
        quant_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        quant_reset_btn.setIconSize(QSize(16, 16))
        quant_reset_btn.setFixedSize(17, button_height)
        quant_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        quant_reset_btn.clicked.connect(self.reset_quantization)
        self.reset_buttons.append(quant_reset_btn)
        
        quant_row_layout.addWidget(quant_label)
        quant_row_layout.addWidget(self.quant_combo, 1)
        quant_row_layout.addWidget(quant_reset_btn)
        
        model_layout.addWidget(quant_widget)
        
        # Create a collapsed placeholder for the progress bar
        self.progress_placeholder = QWidget()
        self.progress_placeholder.setFixedHeight(0)  # Start with 0 height
        self.progress_placeholder.setMaximumHeight(20)  # But allow expansion up to 20
        self.progress_placeholder_layout = QHBoxLayout(self.progress_placeholder)
        self.progress_placeholder_layout.setContentsMargins(0, 0, 0, 0)
        self.progress_placeholder_layout.setSpacing(0)
        
        model_layout.addWidget(self.progress_placeholder)
        model_group.setLayout(model_layout)
        
        # Create a new group for LLM settings - now third
        llm_group = QGroupBox("LLM Settings")
        llm_group.setStyleSheet(self.section_style_template.format(bg_color=self.llm_bg_color))
        llm_layout = QVBoxLayout()
        llm_layout.setSpacing(8)
        
        # Enable LLM toggle
        llm_toggle_container = QWidget()
        llm_toggle_layout = QHBoxLayout(llm_toggle_container)
        llm_toggle_layout.setContentsMargins(0, 0, 0, 0)
        
        llm_toggle_label = QLabel("Enable LLM Inference")
        llm_toggle_label.setFont(font)
        llm_toggle_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.enable_llm_toggle = ToggleSwitch()
        self.enable_llm_toggle.setChecked(self.current_llm_enabled)
        self.enable_llm_toggle.valueChanged.connect(self.llm_enabled_changed)
        
        llm_toggle_layout.addWidget(llm_toggle_label)
        llm_toggle_layout.addStretch(1)
        llm_toggle_layout.addWidget(self.enable_llm_toggle)
        
        llm_layout.addWidget(llm_toggle_container)
        
        # Divider line
        divider2 = QFrame()
        divider2.setFrameShape(QFrame.Shape.HLine)
        divider2.setFixedHeight(1)
        divider2.setStyleSheet(self.divider_style)
        llm_layout.addWidget(divider2)
        
        # LLM model selection
        llm_model_container = QWidget()
        llm_model_layout = QHBoxLayout(llm_model_container)
        llm_model_layout.setContentsMargins(0, 0, 0, 0)
        
        llm_model_label = QLabel("LLM Model:")
        llm_model_label.setFont(font)
        llm_model_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.llm_model_combo = QComboBox()
        self.llm_model_combo.addItem("gemma-3-1b-it")
        self.llm_model_combo.setEnabled(False)  # Initially disabled until LLM is enabled
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
        
        # Add LLM model reset button
        llm_model_reset_btn = QPushButton()
        llm_model_reset_btn.setToolTip("Reset to default LLM model")
        llm_model_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        llm_model_reset_btn.setIconSize(QSize(16, 16))
        llm_model_reset_btn.setFixedSize(17, button_height)
        llm_model_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        llm_model_reset_btn.clicked.connect(self.reset_llm_model)
        self.reset_buttons.append(llm_model_reset_btn)
        
        llm_model_layout.addWidget(llm_model_label)
        llm_model_layout.addWidget(self.llm_model_combo, 1)
        llm_model_layout.addWidget(llm_model_reset_btn)
        
        llm_layout.addWidget(llm_model_container)
        
        # Divider line
        divider3 = QFrame()
        divider3.setFrameShape(QFrame.Shape.HLine)
        divider3.setFixedHeight(1)
        divider3.setStyleSheet(self.divider_style)
        llm_layout.addWidget(divider3)
        
        # LLM quantization selection
        llm_quant_container = QWidget()
        llm_quant_layout = QHBoxLayout(llm_quant_container)
        llm_quant_layout.setContentsMargins(0, 0, 0, 0)
        
        llm_quant_label = QLabel("LLM Quantization:")
        llm_quant_label.setFont(font)
        llm_quant_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.llm_quant_combo = QComboBox()
        self.llm_quant_combo.addItems(["Full", "Quantized"])
        self.llm_quant_combo.setEnabled(False)  # Initially disabled
        self.llm_quant_combo.setStyleSheet("""
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
        
        # Add LLM quantization reset button
        llm_quant_reset_btn = QPushButton()
        llm_quant_reset_btn.setToolTip("Reset to default LLM quantization")
        llm_quant_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        llm_quant_reset_btn.setIconSize(QSize(16, 16))
        llm_quant_reset_btn.setFixedSize(17, button_height)
        llm_quant_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        llm_quant_reset_btn.clicked.connect(self.reset_llm_quantization)
        self.reset_buttons.append(llm_quant_reset_btn)
        
        llm_quant_layout.addWidget(llm_quant_label)
        llm_quant_layout.addWidget(self.llm_quant_combo, 1)
        llm_quant_layout.addWidget(llm_quant_reset_btn)
        
        llm_layout.addWidget(llm_quant_container)
        
        # Divider line
        divider4 = QFrame()
        divider4.setFrameShape(QFrame.Shape.HLine)
        divider4.setFixedHeight(1)
        divider4.setStyleSheet(self.divider_style)
        llm_layout.addWidget(divider4)
        
        # LLM prompt text field
        llm_prompt_container = QWidget()
        llm_prompt_layout = QHBoxLayout(llm_prompt_container)
        llm_prompt_layout.setContentsMargins(0, 0, 0, 0)
        
        llm_prompt_label = QLabel("System Prompt:")
        llm_prompt_label.setFont(font)
        llm_prompt_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.llm_prompt_textbox = QLineEdit()
        self.llm_prompt_textbox.setText("You are a helpful assistant.")
        self.llm_prompt_textbox.setEnabled(False)  # Initially disabled
        self.llm_prompt_textbox.setStyleSheet("""
            QLineEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 2px;
            }
        """)
        
        llm_prompt_layout.addWidget(llm_prompt_label)
        llm_prompt_layout.addWidget(self.llm_prompt_textbox, 1)
        
        llm_layout.addWidget(llm_prompt_container)
        
        # Initialize LLM controls with current values
        self.enable_llm_toggle.setChecked(self.current_llm_enabled)
        self.llm_model_combo.setCurrentText(self.current_llm_model)
        self.llm_quant_combo.setCurrentText(self.current_llm_quantization)
        self.llm_prompt_textbox.setText(self.current_llm_prompt)
        
        # Enable/disable controls based on LLM enabled state
        self.llm_enabled_changed()  # Call explicitly to set initial state
        
        llm_group.setLayout(llm_layout)
        
        # Create a group box for sound settings
        sound_group = QGroupBox("Sound Settings")
        sound_group.setStyleSheet(self.section_style_template.format(bg_color=self.sound_bg_color))
        sound_layout = QVBoxLayout()
        sound_layout.setSpacing(8)
        
        # Recording sound toggle
        sound_toggle_container = QWidget()
        sound_toggle_layout = QHBoxLayout(sound_toggle_container)
        sound_toggle_layout.setContentsMargins(0, 0, 0, 0)
        
        sound_toggle_label = QLabel("Enable recording sound")
        sound_toggle_label.setFont(font)
        sound_toggle_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.sound_toggle = ToggleSwitch()
        self.sound_toggle.setChecked(enable_rec_sound)
        self.sound_toggle.valueChanged.connect(self.recording_sound_changed)
        
        sound_toggle_layout.addWidget(sound_toggle_label)
        sound_toggle_layout.addStretch(1)
        sound_toggle_layout.addWidget(self.sound_toggle)
        
        sound_layout.addWidget(sound_toggle_container)
        
        # Divider line
        divider5 = QFrame()
        divider5.setFrameShape(QFrame.Shape.HLine)
        divider5.setFixedHeight(1)
        divider5.setStyleSheet(self.divider_style)
        sound_layout.addWidget(divider5)
        
        # Sound file selection
        sound_widget = QWidget()
        sound_widget.setAcceptDrops(True)
        sound_widget.installEventFilter(self)
        sound_row_layout = QHBoxLayout(sound_widget)
        sound_row_layout.setContentsMargins(0, 0, 0, 0)
        
        sound_file_label = QLabel("Sound File:")
        sound_file_label.setFont(font)
        sound_file_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.sound_path_display = QLineEdit(os.path.basename(current_sound_path) if current_sound_path else "No file selected")
        self.sound_path_display.setReadOnly(True)
        self.sound_path_display.setToolTip(current_sound_path if current_sound_path else "")
        self.sound_path_display.setStyleSheet("""
            color: rgb(163, 190, 203);
            background-color: rgb(54, 71, 84);
            border: 1px solid rgb(78, 106, 129);
            border-radius: 3px;
            padding: 2px 5px;
        """)
        self.sound_path_display.setFixedHeight(button_height)
        
        # Browse button with edit icon
        self.browse_btn = QPushButton()
        self.browse_btn.setToolTip("Browse for sound file")
        self.browse_btn.setIcon(QIcon(resource_path("resources/open-folder.png")))
        self.browse_btn.setIconSize(QSize(16, 16))
        self.browse_btn.setFixedSize(17, button_height)
        self.browse_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        self.browse_btn.clicked.connect(self.browse_sound_file)
        
        sound_reset_btn = QPushButton()
        sound_reset_btn.setToolTip("Reset to default sound file")
        sound_reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        sound_reset_btn.setIconSize(QSize(16, 16))
        sound_reset_btn.setFixedSize(17, button_height)
        sound_reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        sound_reset_btn.clicked.connect(self.reset_sound_path)
        self.reset_buttons.append(sound_reset_btn)
        
        sound_row_layout.addWidget(sound_file_label)
        sound_row_layout.addWidget(self.sound_path_display, 1)
        sound_row_layout.addWidget(self.browse_btn)
        sound_row_layout.addWidget(sound_reset_btn)
        
        # Install event filter for drag and drop
        self.sound_path_display.setAcceptDrops(True)
        self.sound_path_display.installEventFilter(self)
        
        # Make the sound group accept drops
        sound_group.setAcceptDrops(True)
        sound_group.installEventFilter(self)
        
        sound_layout.addWidget(sound_widget)
        sound_group.setLayout(sound_layout)
        
        # SRT output toggle
        srt_container = QWidget()
        srt_layout = QHBoxLayout(srt_container)
        srt_layout.setContentsMargins(15, 10, 15, 10)
        
        srt_label = QLabel("Output SRT with timestamps")
        srt_label.setFont(font)
        srt_label.setStyleSheet("color: rgb(144, 164, 174);")
        
        self.srt_toggle = ToggleSwitch()
        self.srt_toggle.setChecked(self.current_output_srt)
        self.srt_toggle.valueChanged.connect(self.srt_output_changed)
        
        srt_layout.addWidget(srt_label)
        srt_layout.addStretch(1)
        srt_layout.addWidget(self.srt_toggle)
        
        # Add to form layout
        form_layout.addRow("", srt_container)
        
        # Add things to the main layout in the desired order
        main_layout.addWidget(rec_key_group)     # Recording key settings first
        main_layout.addWidget(model_group)       # Model settings second
        main_layout.addWidget(llm_group)         # LLM settings third
        main_layout.addWidget(sound_group)       # Sound settings fourth
        main_layout.addLayout(form_layout)       # Form layout with SRT checkbox fifth
        
        main_layout.addStretch()  # Add stretch to push everything to the top
        
        # Button area at the bottom
        button_area = QWidget()
        button_layout = QHBoxLayout(button_area)
        
        # Reset all button
        reset_all_btn = QPushButton("Reset All")
        reset_all_btn.setFixedHeight(button_height)
        reset_all_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
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
        reset_all_btn.clicked.connect(self.reset_all)
        self.reset_all_btn = reset_all_btn
        self.reset_buttons.append(reset_all_btn)
        
        # Remove OK/Cancel buttons
        button_layout.addWidget(reset_all_btn)
        button_layout.addStretch()
        
        main_layout.addWidget(button_area)
        
        # Set dialog to accept drops
        self.setAcceptDrops(True)
        
        # Connect signals to handle immediate changes
        self.model_combo.currentTextChanged.connect(self.model_changed)
        self.quant_combo.currentTextChanged.connect(self.quantization_changed)
        self.sound_path_display.textChanged.connect(self.recording_sound_changed)
        self.sound_path_display.editingFinished.connect(self.recording_sound_changed)
        self.srt_toggle.valueChanged.connect(self.srt_output_changed)
        
        # Install event filter for key events
        self.installEventFilter(self)
    
    def eventFilter(self, obj, event):
        if event.type() == QEvent.Type.DragEnter:
            mime_data = event.mimeData()
            if mime_data.hasUrls():
                file_path = mime_data.urls()[0].toLocalFile()
                if any(file_path.lower().endswith(ext) for ext in self.supported_file_types):
                    # Set cursor for various widget types
                    if isinstance(obj, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget):
                        obj.setCursor(Qt.CursorShape.DragCopyCursor)
                        event.acceptProposedAction()
                        return True
        elif event.type() == QEvent.Type.DragLeave:
            # Reset cursor when drag leaves
            if isinstance(obj, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget):
                obj.unsetCursor()
                return True
        elif event.type() == QEvent.Type.Drop:
            mime_data = event.mimeData()
            if mime_data.hasUrls():
                url = mime_data.urls()[0]
                path = url.toLocalFile()
                if any(path.lower().endswith(ext) for ext in self.supported_file_types):
                    # Reset cursor
                    if isinstance(obj, QLabel | QLineEdit | QPushButton | QGroupBox | QWidget):
                        obj.unsetCursor()
                    
                    # Update UI
                    self.sound_path_display.setText(os.path.basename(path))
                    self.sound_path_display.setToolTip(path)
                    
                    # Update internal settings
                    self.current_sound_path = path
                    
                    # Apply the change to the parent window
                    if hasattr(self, "parent_window") and self.parent_window:
                        # Update parent's sound path
                        self.parent_window.start_sound = path
                        
                        # Update listener sound if recording sound is enabled
                        if self.enable_rec_sound and hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                            self.parent_window.listener_worker.listener.update_start_sound_file(path)
                            self.parent_window.listener_worker.listener.init_pygame()
                        
                        # Display confirmation
                        self.parent_window.display_message(txt=f"Recording sound updated to {os.path.basename(path)}")
                    
                    # Save the changes
                    self.save_settings_to_json()
                    
                    # Accept the action
                    event.acceptProposedAction()
                    return True
        elif event.type() == QEvent.Type.KeyPress and self.recording_key:
            self.key_press_event(event)
            return True
        elif event.type() == QEvent.Type.KeyRelease and self.recording_key:
            self.key_release_event(event)
            return True
        
        return super().eventFilter(obj, event)

    def key_press_event(self, event):
        """Handle key press events when recording a key combination."""
        key_text = self.get_key_name(event)
        if key_text:
            self.pressed_keys.add(key_text)
            self.update_rec_key_display()
    
    def key_release_event(self, event):
        """Handle key release events when recording a key combination."""
        key_text = self.get_key_name(event)
        if key_text and key_text in self.pressed_keys:
            self.pressed_keys.discard(key_text)
            self.update_rec_key_display()
    
    def update_rec_key_display(self):
        """Update the recording key display with the current combination."""
        if len(self.pressed_keys) > 0:
            self.combination = "+".join(sorted(self.pressed_keys))
            self.rec_key_edit.setText(self.combination)
    
    def get_key_name(self, event):
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
        
        # Try to get the text for the key
        key_text = event.text().upper()
        
        # If the key doesn't have a text representation, use the key constant name
        if not key_text or len(key_text) == 0:
            # Check for special keys
            special_keys = {
                Qt.Key.Key_F1: "F1", Qt.Key.Key_F2: "F2", Qt.Key.Key_F3: "F3",
                Qt.Key.Key_F4: "F4", Qt.Key.Key_F5: "F5", Qt.Key.Key_F6: "F6",
                Qt.Key.Key_F7: "F7", Qt.Key.Key_F8: "F8", Qt.Key.Key_F9: "F9",
                Qt.Key.Key_F10: "F10", Qt.Key.Key_F11: "F11", Qt.Key.Key_F12: "F12",
                Qt.Key.Key_Escape: "ESC", Qt.Key.Key_Tab: "TAB",
                Qt.Key.Key_CapsLock: "CAPS", Qt.Key.Key_Space: "SPACE",
            }
            if key in special_keys:
                return special_keys[key]
        
        return key_text
    
    def toggle_rec_key_recording(self):
        """Toggle recording state for the hotkey combination."""
        self.recording_key = not self.recording_key
        
        if self.recording_key:
            # Start recording
            self.pressed_keys.clear()
            self.change_rec_key_btn.setText("Stop")
            self.rec_key_edit.setStyleSheet("""
                QTextEdit {
                    background-color: rgb(80, 40, 40);
                    color: rgb(144, 164, 174);
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: rgb(78, 106, 129)
                }
            """)
        else:
            # Stop recording
            self.change_rec_key_btn.setText("Change Key")
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
            
            # Update the recording key if a combination was selected
            if len(self.pressed_keys) > 0:
                self.current_rec_key = "+".join(sorted(self.rec_key_edit.toPlainText().split("+"), key=len, reverse=True)).upper()
                
                # Apply the change to the parent window
                if hasattr(self, "parent_window") and self.parent_window:
                    self.parent_window.rec_key = self.current_rec_key
                    # Update listener worker's recording key
                    if hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                        self.parent_window.listener_worker.listener.capture_keys(self.current_rec_key)
                    # Update the instruction text to reflect the new key
                    if hasattr(self.parent_window, "instruction_label"):
                        self.parent_window.instruction_label.setText(f"Hold {self.current_rec_key} to start recording or drop a file/folder to transcribe")
                    self.parent_window.display_message(txt=f"Recording key changed to {self.current_rec_key}")
                
                self.save_settings_to_json()
            
            self.pressed_keys.clear()
    
    def reset_rec_key(self):
        """Reset recording key to default."""
        self.current_rec_key = self.default_rec_key
        self.rec_key_edit.setText(self.current_rec_key)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.rec_key = self.current_rec_key
            # Update listener worker's recording key
            if hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                self.parent_window.listener_worker.listener.capture_keys(self.current_rec_key)
            # Update the instruction text to reflect the new key
            if hasattr(self.parent_window, "instruction_label"):
                self.parent_window.instruction_label.setText(f"Hold {self.current_rec_key} to start recording or drop a file/folder to transcribe")
            self.parent_window.display_message(txt="Recording key reset to default")
        self.save_settings_to_json()
    
    def open_audio_files(self):
        """Open file dialog to select audio files for transcription."""
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.open_files()
    
    def reset_model(self):
        """Reset the model to default value."""
        self.model_combo.setCurrentText(self.default_model)
        self.model_changed()
        self.save_settings_to_json()
    def reset_quantization(self):
        self.quant_combo.setCurrentText(self.default_quantization)
        self.quantization_changed()
        self.save_settings_to_json()
        
    def reset_sound_path(self):
        if self.current_sound_path != self.default_sound_path:
            self.current_sound_path = self.default_sound_path
            self.sound_path_display.setText(os.path.basename(self.default_sound_path))
            self.sound_path_display.setToolTip(self.default_sound_path)
            
            # Apply the change to the parent window
            if hasattr(self, "parent_window") and self.parent_window:
                self.parent_window.start_sound = self.default_sound_path
                # Update listener sound if recording sound is enabled
                if self.enable_rec_sound and hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                    self.parent_window.listener_worker.listener.update_start_sound_file(self.default_sound_path)
                    self.parent_window.listener_worker.listener.init_pygame()
                self.parent_window.display_message(txt="Sound file reset to default")
                
        self.save_settings_to_json()
        
    def reset_sound_checkbox(self):
        """Reset the recording sound checkbox to default value."""
        self.sound_toggle.setChecked(self.default_recording_sound)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.enable_recording_sound = self.default_recording_sound
            
            # Update listener sound if relevant
            if hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                self.parent_window.listener_worker.listener.enable_sound = self.default_recording_sound
            
            # Display a message about the reset
            self.parent_window.display_message(txt="Recording sound setting reset to default")
        
        self.save_settings_to_json()
    def reset_srt_checkbox(self):
        """Reset the SRT output checkbox to default value."""
        self.srt_toggle.setChecked(self.default_output_srt)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.current_output_srt = self.default_output_srt
            
            # Display a message about the reset
            self.parent_window.display_message(txt="SRT output setting reset to default")
        
        self.save_settings_to_json()
    
    def reset_llm_checkbox(self):
        """Reset the LLM settings to default values."""
        self.enable_llm_toggle.setChecked(self.default_llm_enabled)
        self.llm_model_combo.setCurrentText(self.default_llm_model)
        self.llm_quant_combo.setCurrentText(self.default_llm_quantization)
        self.llm_prompt_textbox.setText(self.default_llm_prompt)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.llm_enabled = self.default_llm_enabled
            self.parent_window.llm_model = self.default_llm_model
            self.parent_window.llm_quantization = self.default_llm_quantization
            self.parent_window.llm_prompt = self.default_llm_prompt
            
            # Update the LLM worker if LLM is enabled
            if self.default_llm_enabled:
                self.parent_window.init_llm_worker()
            elif hasattr(self.parent_window, "llm_worker"):
                # Clean up LLM worker if it exists
                if hasattr(self.parent_window, "llm_thread") and self.parent_window.llm_thread.isRunning():
                    self.parent_window.llm_thread.quit()
                    self.parent_window.llm_thread.wait()
                    if hasattr(self.parent_window, "llm_worker"):
                        self.parent_window.llm_worker.deleteLater()
                        
            # Display a message about the reset
            self.parent_window.display_message(txt="LLM settings reset to defaults")
        
        # Save settings and trigger UI update
        self.save_settings_to_json()
        self.llm_enabled_changed()
        
    def reset_all(self):
        self.reset_model()
        self.reset_quantization()
        self.reset_sound_path()
        self.reset_sound_checkbox()
        self.reset_srt_checkbox()
        self.reset_rec_key()
        self.reset_llm_checkbox()
        self.save_settings_to_json()
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.display_message(txt="All settings reset to defaults")
            
    
    def get_selected_model(self):
        return self.model_combo.currentText()
    
    def get_selected_quantization(self):
        return self.quant_combo.currentText()
        
    def is_recording_sound_enabled(self):
        return self.sound_toggle.isChecked()
        
    def is_srt_output_enabled(self):
        return self.srt_toggle.isChecked()
        
    def get_sound_path(self):
        return self.current_sound_path

    def is_llm_enabled(self):
        return self.enable_llm_toggle.isChecked()
    
    def get_llm_model(self):
        return self.llm_model_combo.currentText()
    
    def get_llm_quantization(self):
        return self.llm_quant_combo.currentText()
    
    def get_llm_prompt(self):
        return self.llm_prompt_textbox.text()

    def model_changed(self):
        """Update parent window when model is changed."""
        # Get the selected model name
        model = self.get_selected_model()
        
        # Update parent window's selected model
        if hasattr(self.parent_window, "selected_model"):
            old_model = self.parent_window.selected_model
            if old_model != model:
                self.parent_window.selected_model = model
                
                # Show a helpful message for users about the model change
                if model == "whisper-turbo":
                    message = "Using standard Whisper Turbo model"
                    self.quant_combo.setEnabled(True)
                    self.quantization_changed()
                elif model == "lite-whisper-turbo":
                    message = "Using Lite Whisper"
                    self.quant_combo.setCurrentText("Full")
                    self.quant_combo.setEnabled(False)
                    self.quantization_changed()
                elif model == "lite-whisper-turbo-fast":
                    message = "Using Lite Whisper Fast"
                    self.quant_combo.setCurrentText("Full")
                    self.quant_combo.setEnabled(False)
                    self.quantization_changed()
                else:
                    message = f"Using {model} model"
                
                # Start download process and disable UI
                self.start_download()
                
                # Connect to the model worker's display_message_signal for progress updates
                if hasattr(self.parent_window, "model_worker"):
                    try:
                        self.parent_window.model_worker.display_message_signal.disconnect(self.handle_model_message)
                    except (TypeError, RuntimeError):
                        # If it wasn't connected, that's fine
                        pass
                    self.parent_window.model_worker.display_message_signal.connect(self.handle_model_message)
                
                # Re-initialize workers to apply the change immediately
                self.parent_window.init_workers_and_signals()
                
                # Display a message about the change
                if hasattr(self.parent_window, "display_message"):
                    self.parent_window.display_message(txt=message)
        
        self.save_settings_to_json()

    def quantization_changed(self):
        """Handle quantization selection changes and apply them immediately."""
        new_quantization = self.quant_combo.currentText()
        # Only update if the value changed
        if new_quantization != self.current_quantization:
            self.current_quantization = new_quantization
            # Apply the change to the parent window
            if hasattr(self, "parent_window") and self.parent_window:
                # Check if we need to reinitialize workers
                if self.parent_window.selected_quantization != new_quantization:
                    self.parent_window.selected_quantization = new_quantization
                    self.parent_window.init_workers_and_signals()
                    self.parent_window.display_message(txt=f"Quantization updated to {new_quantization}")
        
        self.save_settings_to_json()
        
    def handle_model_message(self, txt=None, filename=None, percentage=None, hold=False, reset=None):
        """Handle messages from the model worker, including download progress."""
        if percentage is not None:
            # Update progress bar in parent window
            if hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None:
                try:
                    self.parent_window.progressBar.setValue(percentage)
                except RuntimeError:
                    # If the progress bar has been deleted, ignore
                    pass
                
            if percentage >= 100:
                # Disconnect from the signal to avoid memory leaks
                if hasattr(self.parent_window, "model_worker"):
                    try:
                        self.parent_window.model_worker.display_message_signal.disconnect(self.handle_model_message)
                    except (TypeError, RuntimeError):
                        # It's already disconnected or the connection failed
                        pass
                # Re-enable UI elements
                self.finish_download()
                
    def recording_sound_changed(self):
        """Handle sound path changes and apply them immediately."""
        new_sound_path = self.sound_path_display.toolTip()
        # Only update if the path changed
        if new_sound_path != self.current_sound_path:
            self.current_sound_path = new_sound_path
            # Apply the change to the parent window
            if hasattr(self, "parent_window") and self.parent_window:
                self.parent_window.start_sound = new_sound_path
                # Update listener sound if recording sound is enabled
                if self.enable_rec_sound and hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                    self.parent_window.listener_worker.listener.update_start_sound_file(new_sound_path)
                    self.parent_window.listener_worker.listener.init_pygame()
                self.parent_window.display_message(txt=f"Sound path updated to {os.path.basename(new_sound_path)}")
        
        self.save_settings_to_json()
    
    def srt_output_changed(self):
        """Handle SRT output checkbox changes and apply them immediately."""
        new_output_srt = self.srt_toggle.isChecked()
        # Only update if the value changed
        if new_output_srt != self.current_output_srt:
            self.current_output_srt = new_output_srt
            # Apply the change to the parent window
            if hasattr(self, "parent_window") and self.parent_window:
                self.parent_window.current_output_srt = new_output_srt
                self.parent_window.display_message(txt=f"SRT output {'enabled' if new_output_srt else 'disabled'}")
        
        self.save_settings_to_json()
    
    def browse_sound_file(self):
        """Handle sound file browsing and apply changes immediately."""
        file_dialog = QFileDialog(self)
        file_dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        file_dialog.setNameFilter("Audio files (*.mp3 *.wav)")
        file_dialog.setWindowTitle("Select Sound File")
        
        if file_dialog.exec() == QDialog.DialogCode.Accepted:
            selected_file = file_dialog.selectedFiles()[0]
            # Only update if the file changed
            if selected_file != self.current_sound_path:
                self.current_sound_path = selected_file
                self.sound_path_display.setText(os.path.basename(selected_file))
                self.sound_path_display.setToolTip(selected_file)
                
                # Apply the change to the parent window
                if hasattr(self, "parent_window") and self.parent_window:
                    self.parent_window.start_sound = selected_file
                    # Update listener sound if recording sound is enabled
                    if self.enable_rec_sound and hasattr(self.parent_window, "listener_worker") and hasattr(self.parent_window.listener_worker, "listener"):
                        self.parent_window.listener_worker.listener.update_start_sound_file(selected_file)
                        self.parent_window.listener_worker.listener.init_pygame()
                    self.parent_window.display_message(txt="Sound file updated")
        
        self.save_settings_to_json()

    def load_settings_from_json(self):
        """Load settings from JSON if available"""
        try:
            if os.path.exists("settings.json"):
                with open("settings.json") as f:
                    settings = json.load(f)
                    # Populate default values from saved settings if available
                    self.default_model = settings.get("model", self.default_model)
                    self.default_quantization = settings.get("quantization", self.default_quantization)
                    self.default_recording_sound = settings.get("enable_sound", self.default_recording_sound)
                    self.default_sound_path = settings.get("sound_path", self.default_sound_path)
                    self.default_output_srt = settings.get("output_srt", self.default_output_srt)
                    self.default_rec_key = settings.get("rec_key", self.default_rec_key)
                    
                    # Set default LLM settings
                    self.default_llm_enabled = settings.get("llm_enabled", False)
                    self.default_llm_model = settings.get("llm_model", "gemma-3-1b-it")
                    self.default_llm_quantization = settings.get("llm_quantization", "Full")
                    self.default_llm_prompt = settings.get("llm_prompt", "You are a helpful assistant.")
                    
                    # Apply LLM settings to UI if controls exist
                    if hasattr(self, "enable_llm_toggle"):
                        self.enable_llm_toggle.setChecked(self.default_llm_enabled)
                    if hasattr(self, "llm_model_combo"):
                        self.llm_model_combo.setCurrentText(self.default_llm_model)
                    if hasattr(self, "llm_quant_combo"):
                        self.llm_quant_combo.setCurrentText(self.default_llm_quantization)
                    if hasattr(self, "llm_prompt_textbox"):
                        self.llm_prompt_textbox.setText(self.default_llm_prompt)
        except Exception as e:
            print(f"Error loading settings: {e}")

    def save_settings_to_json(self):
        """Save current settings to JSON"""
        try:
            # Check if all UI elements are initialized before saving
            if not hasattr(self, "sound_toggle") or not hasattr(self, "model_combo"):
                print("Settings dialog not fully initialized, skipping save")
                return
                
            settings = {
                "model": self.get_selected_model(),
                "quantization": self.get_selected_quantization(),
                "enable_sound": self.is_recording_sound_enabled(),
                "sound_path": self.get_sound_path(),
                "output_srt": self.is_srt_output_enabled(),
                "rec_key": self.current_rec_key,
                "llm_enabled": self.is_llm_enabled(),
                "llm_model": self.get_llm_model(),
                "llm_quantization": self.get_llm_quantization(),
                "llm_prompt": self.get_llm_prompt(),
            }
            
            with open("settings.json", "w") as f:
                json.dump(settings, f, indent=4)
        except Exception as e:
            print(f"Error saving settings: {e}")
    
    def set_ui_elements_enabled(self, enabled):
        """Enable or disable UI elements with visual feedback."""
        # Get all the UI elements we want to modify
        print("Setting UI elements enabled:", enabled)
        ui_elements = [
            self.model_combo,
            self.quant_combo,
            self.sound_toggle,
            self.srt_toggle,
            self.rec_key_edit,
            self.change_rec_key_btn,
            self.browse_btn,
            self.enable_llm_toggle,
        ]
        
        # Add all reset buttons to the list - we'll populate this in the next step
        self.reset_buttons = getattr(self, "reset_buttons", [])
        
        # Include reset buttons in the UI elements
        ui_elements.extend(self.reset_buttons)
        
        # Standard opacity values
        enabled_opacity = 1.0
        disabled_opacity = 0.5
        
        # Set enabled state and opacity for each element
        for element in ui_elements:
            if element is not None:  # Skip None elements for safety
                element.setEnabled(enabled)
                
                # Apply visual effect based on enabled state
                if hasattr(element, "setOpacity"):
                    # Some widgets have built-in opacity
                    element.setOpacity(enabled_opacity if enabled else disabled_opacity)
                else:
                    # For others, we need to create or update a graphics effect
                    if not hasattr(element, "_opacity_effect"):
                        element._opacity_effect = QGraphicsOpacityEffect(element)
                        element.setGraphicsEffect(element._opacity_effect)
                    
                    element._opacity_effect.setOpacity(enabled_opacity if enabled else disabled_opacity)

    def finish_download(self):
        """Re-enable settings and hide progress bar after download."""
        self.is_downloading_model = False
        
        # Re-enable UI elements with visual feedback
        self.set_ui_elements_enabled(True)
        
        # Only move the progress bar if we're not already in the process of moving it
        if not self.is_progress_bar_moving:
            self.is_progress_bar_moving = True
            
            # If we're visible and finishing the download, return progress bar to parent
            if hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None:
                try:
                    # Get the progress bar
                    progress_bar = self.parent_window.progressBar
                    
                    # Remove it from our layout if it's there
                    for i in reversed(range(self.progress_placeholder_layout.count())): 
                        item = self.progress_placeholder_layout.itemAt(i)
                        if item.widget() == progress_bar:
                            self.progress_placeholder_layout.removeItem(item)
                        
                    # Return progress bar to original parent and position
                    if self.original_progress_parent is not None:
                        progress_bar.setParent(self.original_progress_parent)
                        if self.original_progress_geometry is not None:
                            progress_bar.setGeometry(self.original_progress_geometry)
                    else:
                        # Fallback to centralwidget if original parent unknown
                        progress_bar.setParent(self.parent_window.centralwidget)
                    
                    # Hide it in our dialog but make it visible in main window if download is still ongoing
                    progress_bar.setVisible(False)
                    
                    # Reset original geometry and parent tracking
                    self.original_progress_geometry = None
                    self.original_progress_parent = None
                    
                    # Collapse the progress placeholder area
                    self.progress_placeholder.setFixedHeight(0)
                except RuntimeError:
                    # If the progress bar has been deleted, ignore
                    pass
                finally:
                    # Use a direct timer call rather than connecting to prevent memory leak
                    QTimer.singleShot(200, lambda: setattr(self, "is_progress_bar_moving", False))

    def closeEvent(self, event):
        """Handle the dialog close event to properly clean up signal connections."""
        # If a model download is in progress, disconnect our signal handlers
        if self.is_downloading_model and hasattr(self.parent_window, "model_worker"):
            try:
                # Disconnect our message handler to prevent calls to deleted objects
                self.parent_window.model_worker.display_message_signal.disconnect(self.handle_model_message)
            except (TypeError, RuntimeError):
                # It's already disconnected or the connection failed
                pass
            
            # If we're downloading and have a parent window with a progress bar,
            # make sure it's visible in the parent window, but only if we're not already moving it
            if (hasattr(self.parent_window, "progressBar") and 
                self.parent_window.progressBar is not None and 
                not self.is_progress_bar_moving):
                
                self.is_progress_bar_moving = True
                
                try:
                    # Get the progress bar
                    progress_bar = self.parent_window.progressBar
                    
                    # Remove it from our layout if it's there
                    for i in reversed(range(self.progress_placeholder_layout.count())): 
                        item = self.progress_placeholder_layout.itemAt(i)
                        if item.widget() == progress_bar:
                            self.progress_placeholder_layout.removeItem(item)
                    
                    # Return progress bar to original parent and position
                    if self.original_progress_parent is not None:
                        progress_bar.setParent(self.original_progress_parent)
                        if self.original_progress_geometry is not None:
                            progress_bar.setGeometry(self.original_progress_geometry)
                    else:
                        # Fallback to centralwidget if original parent unknown
                        progress_bar.setParent(self.parent_window.centralwidget)
                    
                    # Make sure it's visible if we're still downloading
                    progress_bar.setVisible(True)
                    progress_bar.raise_()
                    
                    # Force update to ensure it appears
                    progress_bar.update()
                    if self.original_progress_parent is not None:
                        self.original_progress_parent.update()
                    else:
                        self.parent_window.centralwidget.update()
                except RuntimeError:
                    # If the progress bar has been deleted, ignore
                    pass
                finally:
                    # Reset flag after a delay to prevent rapid changes
                    # Use a direct timer call rather than connecting to prevent memory leak
                    QTimer.singleShot(200, lambda: setattr(self, "is_progress_bar_moving", False))
        
        # Accept the close event and close the dialog
        event.accept()
        super().closeEvent(event)

    def exec(self):
        """Override exec to properly handle the progress bar when opening the dialog."""
        print("Executing dialog")
        # If we're downloading, make sure all UI elements remain disabled
        if self.is_downloading_model:
            self.set_ui_elements_enabled(False)
        
        # If we're currently downloading a model, make sure progress bar appears in our dialog
        if self.is_downloading_model and hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None and not self.is_progress_bar_moving:
            # Call start_download after a small delay to ensure the dialog is visible
            QTimer.singleShot(50, self.start_download)
        
        # Call the parent class's exec method
        return super().exec()

    def showEvent(self, event):
        """Handle showing the dialog."""
        print("Showing dialog")
        # If we're downloading, make sure all UI elements remain disabled
        if self.is_downloading_model:
            self.set_ui_elements_enabled(False)
        
        # If we're currently downloading a model, make sure progress bar appears in our dialog
        if self.is_downloading_model and hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None and not self.is_progress_bar_moving:
            # Delay the call to start_download slightly to ensure the dialog is fully shown
            QTimer.singleShot(100, self.start_download)
        
        # Call the parent class's showEvent method
        super().showEvent(event) 

    def llm_enabled_changed(self):
        # Enable or disable LLM controls based on checkbox state
        is_enabled = self.enable_llm_toggle.isChecked()
        self.llm_model_combo.setEnabled(is_enabled)
        self.llm_quant_combo.setEnabled(is_enabled)
        self.llm_prompt_textbox.setEnabled(is_enabled)
        
        # If enabled and parent window exists, initialize the LLM worker
        if is_enabled and hasattr(self, "parent_window") and self.parent_window:
            # Initialize LLM worker if needed
            if not hasattr(self.parent_window, "llm_worker") or self.parent_window.llm_worker is None:
                self.parent_window.init_llm_worker()
            
            # Display a message about enabling LLM
            if hasattr(self.parent_window, "display_message"):
                self.parent_window.display_message(txt="LLM inference enabled")
        elif hasattr(self, "parent_window") and self.parent_window:
            # Display message about disabling LLM
            if hasattr(self.parent_window, "display_message"):
                self.parent_window.display_message(txt="LLM inference disabled")
        
        # Save the settings on any change
        self.save_settings_to_json()

    def reset_llm_model(self):
        """Reset the LLM model to default value."""
        self.llm_model_combo.setCurrentText(self.default_llm_model)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.llm_model = self.default_llm_model
            
            # Update the LLM worker if LLM is enabled
            if self.parent_window.llm_enabled:
                self.parent_window.init_llm_worker()
                
            # Display a message about the reset
            self.parent_window.display_message(txt="LLM model reset to default")
        
        self.save_settings_to_json()
    
    def reset_llm_quantization(self):
        """Reset the LLM quantization to default value."""
        self.llm_quant_combo.setCurrentText(self.default_llm_quantization)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.llm_quantization = self.default_llm_quantization
            
            # Update the LLM worker if LLM is enabled
            if self.parent_window.llm_enabled:
                self.parent_window.init_llm_worker()
                
            # Display a message about the reset
            self.parent_window.display_message(txt="LLM quantization reset to default")
            
        self.save_settings_to_json()
    
    def reset_llm_prompt(self):
        """Reset the LLM prompt to default value."""
        self.llm_prompt_textbox.setText(self.default_llm_prompt)
        
        # Apply the change to the parent window
        if hasattr(self, "parent_window") and self.parent_window:
            self.parent_window.llm_prompt = self.default_llm_prompt
            
            # Display a message about the reset
            self.parent_window.display_message(txt="LLM prompt reset to default")
        
        self.save_settings_to_json()

    def start_download(self):
        """Start the model download process. This will disable UI and setup progress tracking."""
        self.is_downloading_model = True
        
        # Disable UI elements with visual feedback
        self.set_ui_elements_enabled(False)
        
        # Expand the progress placeholder to make room for the progress bar
        self.progress_placeholder.setFixedHeight(20)
        
        # Only move the progress bar if we're not already in the process of moving it
        if not self.is_progress_bar_moving and hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None:
            self.is_progress_bar_moving = True
            
            try:
                # Get the progress bar
                progress_bar = self.parent_window.progressBar
                
                # Store original parent and geometry for restoration later
                if self.original_progress_parent is None:
                    self.original_progress_parent = progress_bar.parent()
                if self.original_progress_geometry is None:
                    self.original_progress_geometry = progress_bar.geometry()
                
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
            except RuntimeError:
                # If the progress bar has been deleted, ignore
                pass
            finally:
                # Use a direct timer call rather than connecting to prevent memory leak
                QTimer.singleShot(200, lambda: setattr(self, "is_progress_bar_moving", False)) 