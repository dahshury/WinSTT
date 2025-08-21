"""Presentation Settings Dialog implementation (Qt).

Pure presentation layer - receives state from coordinator, emits UI events.
No business logic, configuration access, or resource management here.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from typing import Any, Protocol

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
    QVBoxLayout,
    QWidget,
)

from .toggle_switch_widget import ToggleSwitch


@dataclass
class SettingsDialogData:
    """Data transfer object for settings dialog state."""
    model: str = "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX"
    quantization: str = "Quantized"
    rec_key: str = "F9"
    recording_sound: bool = True
    sound_path: str = "@resources/splash.wav"
    output_srt: bool = False
    llm_enabled: bool = False
    llm_model: str = "gemma-3-1b-it"
    llm_quantization: str = "Full"
    llm_prompt: str = "You are a helpful assistant."


class ResourceServiceProtocol(Protocol):
    """Protocol for resource service."""
    def get_resource_path(self, relative_path: str) -> str: ...


class SettingsDialog(QDialog):
    """Pure presentation settings dialog.
    
    - No business logic or state management
    - Receives initial state via set_data()
    - Emits UI events through signals
    - Resource loading delegated to injected service
    """

    # Pure UI event signals
    settings_changed = pyqtSignal(dict)
    reset_requested = pyqtSignal(str)  # field name or "all"
    sound_file_browse_requested = pyqtSignal()

    def __init__(
        self,
        parent: QWidget | None = None,
        *,
        resource_service: ResourceServiceProtocol | None = None,
    ) -> None:
        super().__init__(parent)
        self._resource_service = resource_service
        
        # Pure UI state (no business logic)
        self._current_data = SettingsDialogData()
        self._recording_key_capture = False
        self._pressed_keys: set[str] = set()

        self.setWindowTitle("Settings")
        self.setFixedSize(540, 720)

        self._apply_styling()
        self._build_ui()
        self._setup_event_filter()
    
    def set_data(self, data: SettingsDialogData) -> None:
        """Set dialog data from coordinator."""
        self._current_data = data
        self._update_ui_from_data()
    
    def _update_ui_from_data(self) -> None:
        """Update UI controls to reflect current data."""
        if hasattr(self, "model_combo"):
            self.model_combo.setCurrentText(self._current_data.model)
            self.quant_combo.setCurrentText(self._current_data.quantization)
            self.rec_key_edit.setText(self._current_data.rec_key)
            self.rec_sound_toggle.setChecked(self._current_data.recording_sound)
            self.sound_path_display.setText(self._basename(self._current_data.sound_path))
            self.sound_path_display.setToolTip(self._current_data.sound_path)
            self.srt_toggle.setChecked(self._current_data.output_srt)
            self.llm_toggle.setChecked(self._current_data.llm_enabled)
            self.llm_model_combo.setCurrentText(self._current_data.llm_model)
            self.llm_quant_combo.setCurrentText(self._current_data.llm_quantization)
            self.llm_prompt_edit.setText(self._current_data.llm_prompt)
            self._on_llm_enabled_changed()

    # ---- Styling ----
    def _apply_styling(self) -> None:
        # Modern dark palette inspired by shadcn/ui
        self._bg = "#0B1115"
        self._section_bg = "#0E151B"
        self._text = "#C7D1D9"
        self._muted = "#9AA7B2"
        self._border = "#1F2937"
        self._accent = "#2563EB"

        # f-string with escaped braces for QSS blocks
        stylesheet = (
            f"""
            QDialog {{
                background-color: {self._bg};
                color: {self._text};
                font-size: 13px;
                font-family: "Segoe UI", system-ui, -apple-system, "Inter";
            }}
            QLabel {{
                color: {self._text};
            }}
            QGroupBox {{
                color: {self._muted};
                border: 1px solid {self._border};
                border-radius: 10px;
                margin-top: 16px;
                background-color: {self._section_bg};
                font-weight: 600;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                padding: 6px 10px;
            }}
            QLineEdit {{
                background-color: #0A0F14;
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 8px;
                padding: 4px 8px;
                min-height: 26px;
                selection-background-color: {self._accent};
                selection-color: #ffffff;
            }}
            QLineEdit:focus {{
                border: 1.5px solid {self._accent};
            }}
            QComboBox {{
                background-color: #0A0F14;
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 8px;
                padding: 2px 8px;
                min-height: 26px;
            }}
            QComboBox:focus {{
                border: 1.5px solid {self._accent};
            }}
            QComboBox::drop-down {{
                border-left: 1px solid {self._border};
                width: 28px;
                border-radius: 0px 8px 8px 0px;
            }}
            QComboBox::down-arrow {{
                width: 0px;
                height: 0px;
                border-left: 6px solid transparent;
                border-right: 6px solid transparent;
                border-top: 8px solid {self._accent};
                margin-right: 8px;
                margin-top: 8px;
            }}
            QComboBox::down-arrow:disabled {{
                border-top-color: #6B7280;
            }}
            QLineEdit:disabled, QComboBox:disabled, QPushButton:disabled {{
                color: #6B7280;
                border-color: #2A3644;
                background-color: #0A0F14;
            }}
            QLabel:disabled {{ color: #6B7280; }}
            /* Better alignment for inline reset buttons */
            #reset-inline {{
                margin-top: -2px;
                padding: 2px 8px;
            }}
            QComboBox QAbstractItemView {{
                background-color: #0A0F14;
                color: {self._text};
                border: 1px solid {self._border};
                selection-background-color: #111827;
            }}
            QPushButton {{
                background-color: #10161C;
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 8px;
                padding: 4px 10px;
                min-height: 26px;
            }}
            QPushButton:hover {{
                background-color: #0F172A;
            }}
            QPushButton[variant="primary"] {{
                background-color: {self._accent};
                border-color: {self._accent};
                color: #ffffff;
            }}
            QPushButton[variant="primary"]:hover {{
                background-color: #1D4ED8;
                border-color: #1D4ED8;
            }}
            QPushButton[variant="outline"] {{
                background-color: transparent;
                border: 1px solid #334155;
                color: {self._text};
            }}
            QPushButton[variant="ghost"] {{
                background-color: transparent;
                border: 1px solid transparent;
                color: {self._text};
            }}
        """
        )
        self.setStyleSheet(stylesheet)

    def _divider(self) -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        line.setFixedHeight(1)
        line.setStyleSheet("QFrame{background-color: rgb(78,106,129); border: none;}")
        return line

    def _reset_button(self) -> QPushButton:
        btn = QPushButton()
        btn.setToolTip("Reset to default")
        btn.setFixedSize(QSize(28, 28))  # Make it square and same height as other controls
        
        # Use proper resource service through architecture
        icon_loaded = False
        if self._resource_service:
            try:
                icon_path = self._resource_service.get_resource_path("@resources/Command-Reset-256.png")
                btn.setIcon(QIcon(icon_path))
                btn.setIconSize(QSize(16, 16))
                icon_loaded = True
            except Exception:  # noqa: BLE001 - ignore, fallback below
                icon_loaded = False
        if not icon_loaded:
            try:
                btn.setIcon(QIcon("@resources/Command-Reset-256.png"))
                btn.setIconSize(QSize(16, 16))
                icon_loaded = True
            except Exception:  # noqa: BLE001 - fallback to text
                icon_loaded = False
        if not icon_loaded:
            btn.setText("↻")
            btn.setStyleSheet("font-weight: bold; font-size: 14px;")
            
        return btn

    # ---- UI ----
    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(14)

        # Recording Key
        rec_group = QGroupBox("Recording Key")
        rec_v = QVBoxLayout(rec_group)
        rec_row = QHBoxLayout()
        rec_row.setContentsMargins(0, 0, 0, 0)
        self.rec_key_edit = QLineEdit(self._current_data.rec_key)
        self.rec_key_edit.setFixedHeight(26)
        self.rec_key_edit.setReadOnly(True)
        self.rec_key_edit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.change_rec_key_btn = QPushButton("Change Key")
        self.change_rec_key_btn.setProperty("variant", "outline")
        self.change_rec_key_btn.setFixedHeight(26)
        # Optional icon for change key
        icon_path = None
        if self._resource_service:
            with contextlib.suppress(Exception):
                icon_path = self._resource_service.get_resource_path("@resources/edit.png")
        if not icon_path:
            icon_path = "@resources/edit.png"
        with contextlib.suppress(Exception):
            self.change_rec_key_btn.setIcon(QIcon(icon_path))
        self.change_rec_key_btn.clicked.connect(self._toggle_rec_key_recording)
        rec_reset = self._reset_button()
        # Use object name for QSS nudge if needed
        rec_reset.setObjectName("reset-inline")
        rec_reset.clicked.connect(lambda: self.reset_requested.emit("rec_key"))
        # Ensure consistent heights and vertical alignment
        row_h = self.change_rec_key_btn.sizeHint().height()
        self.rec_key_edit.setFixedHeight(row_h)
        rec_reset.setFixedHeight(row_h)
        rec_row.setSpacing(8)
        # Add vertical alignment for all elements
        rec_row.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        rec_row.addWidget(self.rec_key_edit, 1)
        rec_row.addWidget(self.change_rec_key_btn)
        rec_row.addWidget(rec_reset)
        rec_v.addLayout(rec_row)
        root.addWidget(rec_group)

        # Model
        model_group = QGroupBox("Model Settings")
        model_v = QVBoxLayout(model_group)
        # Model row
        model_row = QHBoxLayout()
        model_row.setContentsMargins(0, 0, 0, 0)
        model_label = QLabel("Model:")
        self.model_combo = QComboBox()
        self.model_combo.addItems([
            "gigaam-v2-ctc",
            "gigaam-v2-rnnt",
            "nemo-fastconformer-ru-ctc",
            "nemo-fastconformer-ru-rnnt",
            "nemo-parakeet-ctc-0.6b",
            "nemo-parakeet-rnnt-0.6b",
            "nemo-parakeet-tdt-0.6b-v2",
            "nemo-parakeet-tdt-0.6b-v3",
            "whisper-base",
            "onnx-community/whisper-tiny",
            "onnx-community/whisper-base",
            "onnx-community/whisper-small",
            "onnx-community/whisper-large-v3-turbo",
            "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX",
        ])
        self.model_combo.setCurrentText(self._current_data.model)
        self.model_combo.setMinimumHeight(26)
        model_reset = self._reset_button()
        model_reset.setObjectName("reset-inline")
        model_reset.setFixedHeight(26)
        model_reset.clicked.connect(lambda: self.reset_requested.emit("model"))
        # Align reset button to combo height
        model_reset.setFixedHeight(self.model_combo.sizeHint().height())
        model_row.setSpacing(8)
        model_row.setAlignment(model_reset, Qt.AlignmentFlag.AlignVCenter)
        model_row.addWidget(model_label)
        model_row.addWidget(self.model_combo, 1)
        model_row.addWidget(model_reset)
        model_v.addLayout(model_row)
        # Divider
        model_v.addWidget(self._divider())
        # Quant row
        quant_row = QHBoxLayout()
        quant_row.setContentsMargins(0, 0, 0, 0)
        quant_label = QLabel("Quantization:")
        self.quant_combo = QComboBox()
        self.quant_combo.addItems(["Full", "Quantized"])
        self.quant_combo.setCurrentText(self._current_data.quantization)
        self.quant_combo.setMinimumHeight(26)
        quant_reset = self._reset_button()
        quant_reset.setObjectName("reset-inline")
        quant_reset.setFixedHeight(26)
        quant_reset.clicked.connect(lambda: self.reset_requested.emit("quantization"))
        quant_reset.setFixedHeight(self.quant_combo.sizeHint().height())
        quant_row.setSpacing(8)
        quant_row.setAlignment(quant_reset, Qt.AlignmentFlag.AlignVCenter)
        quant_row.addWidget(quant_label)
        quant_row.addWidget(self.quant_combo, 1)
        quant_row.addWidget(quant_reset)
        model_v.addLayout(quant_row)
        root.addWidget(model_group)

        # LLM
        llm_group = QGroupBox("LLM Settings")
        llm_v = QVBoxLayout(llm_group)
        # enabled
        llm_enabled_row = QHBoxLayout()
        llm_enabled_row.setContentsMargins(12, 8, 12, 8)
        llm_enabled_label = QLabel("Enable LLM Processing")
        self.llm_toggle = ToggleSwitch()
        self.llm_toggle.setChecked(bool(self._current_data.llm_enabled))
        self.llm_toggle.valueChanged.connect(self._on_llm_enabled_changed)
        # make toggle bigger look consistent
        self.llm_toggle.setFixedHeight(24)
        llm_enabled_row.addWidget(llm_enabled_label)
        llm_enabled_row.addStretch(1)
        llm_enabled_row.addWidget(self.llm_toggle)
        llm_v.addLayout(llm_enabled_row)
        # model
        llm_model_row = QHBoxLayout()
        llm_model_row.setContentsMargins(0, 0, 0, 0)
        llm_model_label = QLabel("LLM Model:")
        self.llm_model_combo = QComboBox()
        self.llm_model_combo.addItems(["gemma-3-1b-it", "gemma-3-2b-it"])
        self.llm_model_combo.setCurrentText(self._current_data.llm_model)
        self.llm_model_combo.setMinimumHeight(26)
        llm_model_reset = self._reset_button()
        llm_model_reset.setObjectName("reset-inline")
        llm_model_reset.setFixedHeight(26)
        llm_model_reset.clicked.connect(lambda: self.reset_requested.emit("llm_model"))
        llm_model_reset.setFixedHeight(self.llm_model_combo.sizeHint().height())
        llm_model_row.setSpacing(8)
        llm_model_row.setAlignment(llm_model_reset, Qt.AlignmentFlag.AlignVCenter)
        llm_model_row.addWidget(llm_model_label)
        llm_model_row.addWidget(self.llm_model_combo, 1)
        llm_model_row.addWidget(llm_model_reset)
        llm_v.addLayout(llm_model_row)
        # divider
        llm_v.addWidget(self._divider())
        # quant
        llm_quant_row = QHBoxLayout()
        llm_quant_row.setContentsMargins(0, 0, 0, 0)
        llm_quant_label = QLabel("Quantization:")
        self.llm_quant_combo = QComboBox()
        self.llm_quant_combo.addItems(["Full", "Quantized"])  # placeholder
        self.llm_quant_combo.setCurrentText(self._current_data.llm_quantization)
        self.llm_quant_combo.setMinimumHeight(26)
        llm_quant_reset = self._reset_button()
        llm_quant_reset.setObjectName("reset-inline")
        llm_quant_reset.setFixedHeight(26)
        llm_quant_reset.clicked.connect(lambda: self.reset_requested.emit("llm_quantization"))
        llm_quant_reset.setFixedHeight(self.llm_quant_combo.sizeHint().height())
        llm_quant_row.setSpacing(8)
        llm_quant_row.setAlignment(llm_quant_reset, Qt.AlignmentFlag.AlignVCenter)
        llm_quant_row.addWidget(llm_quant_label)
        llm_quant_row.addWidget(self.llm_quant_combo, 1)
        llm_quant_row.addWidget(llm_quant_reset)
        llm_v.addLayout(llm_quant_row)
        # divider
        llm_v.addWidget(self._divider())
        # prompt
        llm_prompt_row = QFormLayout()
        self.llm_prompt_edit = QLineEdit(self._current_data.llm_prompt)
        self.llm_prompt_edit.setFixedHeight(26)
        llm_prompt_row.addRow(QLabel("LLM Prompt:"), self.llm_prompt_edit)
        llm_v.addLayout(llm_prompt_row)
        root.addWidget(llm_group)

        # Sound
        sound_group = QGroupBox("Sound Settings")
        sound_v = QVBoxLayout(sound_group)
        # toggle
        snd_toggle_row = QHBoxLayout()
        snd_toggle_row.setContentsMargins(12, 8, 12, 8)
        snd_toggle_label = QLabel("Enable Recording Sound")
        self.rec_sound_toggle = ToggleSwitch()
        self.rec_sound_toggle.setChecked(bool(self._current_data.recording_sound))
        self.rec_sound_toggle.setFixedHeight(20)
        snd_toggle_row.addWidget(snd_toggle_label)
        snd_toggle_row.addStretch(1)
        snd_toggle_row.addWidget(self.rec_sound_toggle)
        sound_v.addLayout(snd_toggle_row)
        # file chooser
        snd_file_row = QHBoxLayout()
        snd_file_row.setContentsMargins(0, 0, 0, 0)
        snd_file_row.setSpacing(8)
        snd_label = QLabel("Sound File:")
        snd_label.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        self.sound_path_display = QLineEdit(self._basename(self._current_data.sound_path))
        self.sound_path_display.setFixedHeight(26)
        self.sound_path_display.setToolTip(self._current_data.sound_path)
        self.sound_path_display.setReadOnly(True)
        browse_btn = QPushButton("Browse")
        # Add browse icon with resource fallback
        browse_icon_path = None
        if self._resource_service:
            with contextlib.suppress(Exception):
                browse_icon_path = self._resource_service.get_resource_path("@resources/open-folder.png")
        if not browse_icon_path:
            browse_icon_path = "@resources/open-folder.png"
        with contextlib.suppress(Exception):
            browse_btn.setIcon(QIcon(browse_icon_path))
        browse_btn.clicked.connect(lambda: self.sound_file_browse_requested.emit())
        snd_reset = self._reset_button()
        snd_reset.setObjectName("reset-inline")
        # Align heights with line edits/combos
        control_height = self.sound_path_display.sizeHint().height()
        browse_btn.setFixedHeight(control_height)
        snd_reset.setFixedHeight(control_height)
        snd_reset.clicked.connect(lambda: self.reset_requested.emit("sound_path"))
        # Add vertical alignment for all elements
        snd_file_row.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        snd_file_row.addWidget(snd_label)
        snd_file_row.addWidget(self.sound_path_display, 1)
        snd_file_row.addWidget(browse_btn)
        snd_file_row.addWidget(snd_reset)
        sound_v.addLayout(snd_file_row)
        root.addWidget(sound_group)

        # Output
        output_group = QGroupBox("Output")
        output_form = QFormLayout(output_group)
        self.srt_toggle = ToggleSwitch()
        self.srt_toggle.setChecked(bool(self._current_data.output_srt))
        self.srt_toggle.setFixedHeight(24)
        output_form.addRow(QLabel("Output SRT with timestamps"), self.srt_toggle)
        # Reduce group padding/space since there's only one row
        output_group.setStyleSheet("QGroupBox{padding-top:6px;margin-top:6px;}")
        root.addWidget(output_group)

        # Buttons
        buttons = QWidget()
        hb = QHBoxLayout(buttons)
        # Order: Cancel | OK | Reset All (right aligned)
        cancel_btn = QPushButton("Cancel")
        ok_btn = QPushButton("OK")
        reset_all = QPushButton("Reset All")
        # Use proper resource service for reset all button too
        icon_path_reset = None
        if self._resource_service:
            with contextlib.suppress(Exception):
                icon_path_reset = self._resource_service.get_resource_path("@resources/Command-Reset-256.png")
        if not icon_path_reset:
            icon_path_reset = "@resources/Command-Reset-256.png"
        with contextlib.suppress(Exception):
            reset_all.setIcon(QIcon(icon_path_reset))
            reset_all.setIconSize(QSize(16, 16))
        reset_all.clicked.connect(lambda: self.reset_requested.emit("all"))
        ok_btn.clicked.connect(self._accept)
        cancel_btn.clicked.connect(self.reject)
        hb.addWidget(cancel_btn)
        hb.addWidget(ok_btn)
        hb.addStretch(1)
        hb.addWidget(reset_all)
        root.addWidget(buttons)

    # ---- Event filter ----
    def _setup_event_filter(self) -> None:
        self.setAcceptDrops(True)
        self.installEventFilter(self)

    def eventFilter(self, obj, event):  # noqa: N802 (Qt API)
        if event.type() == QEvent.Type.KeyPress and self._recording_key_capture:
            self._on_key_press(event)
            return True
        if event.type() == QEvent.Type.KeyRelease and self._recording_key_capture:
            self._on_key_release(event)
            return True
        return super().eventFilter(obj, event)

    # ---- Actions ----
    def _toggle_rec_key_recording(self) -> None:
        self._recording_key_capture = not self._recording_key_capture
        if self._recording_key_capture:
            self.change_rec_key_btn.setText("Stop Recording")
            self._pressed_keys.clear()
            self.rec_key_edit.setText("Press keys...")
        else:
            self.change_rec_key_btn.setText("Change Key")
            if self._pressed_keys:
                combo = "+".join(sorted(self._pressed_keys))
                self._set_rec_key(combo)

    def _set_rec_key(self, key: str) -> None:
        self._current_data.rec_key = key
        self.rec_key_edit.setText(key)
    
    def set_sound_path(self, path: str) -> None:
        """Set sound path from coordinator."""
        self._current_data.sound_path = path
        self.sound_path_display.setText(self._basename(path))
        self.sound_path_display.setToolTip(path)
    
    def reset_field(self, field_name: str, value: Any) -> None:
        """Reset a specific field from coordinator."""
        if field_name == "rec_key":
            self._set_rec_key(str(value))
        elif field_name == "model":
            self.model_combo.setCurrentText(str(value))
        elif field_name == "quantization":
            self.quant_combo.setCurrentText(str(value))
        elif field_name == "sound_path":
            self.set_sound_path(str(value))
        elif field_name == "llm_model":
            self.llm_model_combo.setCurrentText(str(value))
        elif field_name == "llm_quantization":
            self.llm_quant_combo.setCurrentText(str(value))

    def _on_key_press(self, event) -> None:
        name = self._key_name(event)
        if name:
            self._pressed_keys.add(name)
            self.rec_key_edit.setText("+".join(sorted(self._pressed_keys)))

    def _on_key_release(self, event) -> None:
        name = self._key_name(event)
        if name and name in self._pressed_keys:
            self._pressed_keys.discard(name)

    def _key_name(self, event) -> str | None:
        key = event.key()
        name: str | None = None
        if key == Qt.Key.Key_Control:
            name = "CTRL"
        elif key == Qt.Key.Key_Alt:
            name = "ALT"
        elif key == Qt.Key.Key_Shift:
            name = "SHIFT"
        elif key == Qt.Key.Key_Meta:
            name = "META"
        elif Qt.Key.Key_F1 <= key <= Qt.Key.Key_F35:
            name = f"F{key - Qt.Key.Key_F1 + 1}"
        else:
            text = event.text()
            if text and text.isprintable():
                name = text.upper()
        return name



    def _on_llm_enabled_changed(self) -> None:
        # Enable/disable related fields based on toggle
        enabled = bool(self.llm_toggle.isChecked())
        self.llm_model_combo.setEnabled(enabled)
        self.llm_quant_combo.setEnabled(enabled)
        self.llm_prompt_edit.setEnabled(enabled)

    def _basename(self, p: str) -> str:
        try:
            from pathlib import Path
            return Path(p).name
        except Exception:  # noqa: BLE001 - benign fallback
            return p

    # ---- Accept ----
    def _accept(self) -> None:
        """Emit current UI state as settings change event."""
        changes = {
            "model": self.model_combo.currentText(),
            "quantization": self.quant_combo.currentText(),
            "rec_key": self.rec_key_edit.text(),
            "recording_sound": bool(self.rec_sound_toggle.isChecked()),
            "sound_path": self._current_data.sound_path,
            "output_srt": bool(self.srt_toggle.isChecked()),
            "llm_enabled": bool(self.llm_toggle.isChecked()),
            "llm_model": self.llm_model_combo.currentText(),
            "llm_quantization": self.llm_quant_combo.currentText(),
            "llm_prompt": self.llm_prompt_edit.text(),
        }
        self.settings_changed.emit(changes)
        self.accept()


