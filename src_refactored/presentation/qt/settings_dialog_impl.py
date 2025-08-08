"""Presentation Settings Dialog implementation (Qt).

Pure presentation layer - receives state from coordinator, emits UI events.
No business logic, configuration access, or resource management here.
"""

from __future__ import annotations

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
    model: str = "whisper-turbo"
    quantization: str = "Full"
    rec_key: str = "F9"
    recording_sound: bool = True
    sound_path: str = "resources/splash.mp3"
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
        self.setFixedSize(500, 650)

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
        # Match original app palette
        self._bg = "#141b1f"
        self._section_bg = "#0c0e13"
        self._text = "rgb(144, 164, 174)"
        self._border = "rgb(78, 106, 129)"

        self.setStyleSheet(
            f"""
            QDialog {{
                background-color: {self._bg};
                color: {self._text};
            }}
            QGroupBox {{
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 5px;
                margin-top: 10px;
                background-color: {self._section_bg};
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                padding: 0 6px;
            }}
            QLineEdit {{
                background-color: rgb(54, 71, 84);
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 3px;
                padding: 5px;
                min-height: 20px;
            }}
            QComboBox {{
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border: 1px solid {self._border};
                border-radius: 3px;
                padding: 4px 8px;
                min-height: 20px;
            }}
            QComboBox::drop-down {{
                border: none;
                width: 20px;
            }}
            QComboBox::down-arrow {{
                width: 8px;
                height: 8px;
            }}
            QComboBox QAbstractItemView {{
                background-color: {self._bg};
                color: {self._text};
                border: 1px solid {self._border};
            }}
            QPushButton {{
                background-color: rgb(54, 71, 84);
                color: {self._text};
                border: 1px solid {self._border};
                border-radius: 3px;
                padding: 4px 8px;
                min-height: 20px;
            }}
            QPushButton:hover {{
                background-color: {self._border};
            }}
        """,
        )

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
        if self._resource_service:
            try:
                icon_path = self._resource_service.get_resource_path("resources/Command-Reset-256.png")
                btn.setIcon(QIcon(icon_path))
                btn.setIconSize(QSize(16, 16))
            except Exception:
                # Fallback to text if icon loading fails
                btn.setText("↻")
                btn.setStyleSheet("font-weight: bold; font-size: 14px;")
        else:
            # No resource service - use text fallback
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
        self.rec_key_edit.setReadOnly(True)
        self.rec_key_edit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.change_rec_key_btn = QPushButton("Change Key")
        self.change_rec_key_btn.clicked.connect(self._toggle_rec_key_recording)
        rec_reset = self._reset_button()
        rec_reset.clicked.connect(lambda: self.reset_requested.emit("rec_key"))
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
        self.model_combo.addItems(["whisper-turbo", "lite-whisper-turbo", "lite-whisper-turbo-fast"])
        self.model_combo.setCurrentText(self._current_data.model)
        model_reset = self._reset_button()
        model_reset.clicked.connect(lambda: self.reset_requested.emit("model"))
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
        quant_reset = self._reset_button()
        quant_reset.clicked.connect(lambda: self.reset_requested.emit("quantization"))
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
        llm_enabled_row.setContentsMargins(12, 6, 12, 6)
        llm_enabled_label = QLabel("Enable LLM Processing")
        self.llm_toggle = ToggleSwitch()
        self.llm_toggle.setChecked(bool(self._current_data.llm_enabled))
        self.llm_toggle.valueChanged.connect(self._on_llm_enabled_changed)
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
        llm_model_reset = self._reset_button()
        llm_model_reset.clicked.connect(lambda: self.reset_requested.emit("llm_model"))
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
        llm_quant_reset = self._reset_button()
        llm_quant_reset.clicked.connect(lambda: self.reset_requested.emit("llm_quantization"))
        llm_quant_row.addWidget(llm_quant_label)
        llm_quant_row.addWidget(self.llm_quant_combo, 1)
        llm_quant_row.addWidget(llm_quant_reset)
        llm_v.addLayout(llm_quant_row)
        # divider
        llm_v.addWidget(self._divider())
        # prompt
        llm_prompt_row = QFormLayout()
        self.llm_prompt_edit = QLineEdit(self._current_data.llm_prompt)
        llm_prompt_row.addRow(QLabel("LLM Prompt:"), self.llm_prompt_edit)
        llm_v.addLayout(llm_prompt_row)
        root.addWidget(llm_group)

        # Sound
        sound_group = QGroupBox("Sound Settings")
        sound_v = QVBoxLayout(sound_group)
        # toggle
        snd_toggle_row = QHBoxLayout()
        snd_toggle_row.setContentsMargins(12, 6, 12, 6)
        snd_toggle_label = QLabel("Enable Recording Sound")
        self.rec_sound_toggle = ToggleSwitch()
        self.rec_sound_toggle.setChecked(bool(self._current_data.recording_sound))
        snd_toggle_row.addWidget(snd_toggle_label)
        snd_toggle_row.addStretch(1)
        snd_toggle_row.addWidget(self.rec_sound_toggle)
        sound_v.addLayout(snd_toggle_row)
        # file chooser
        snd_file_row = QHBoxLayout()
        snd_file_row.setContentsMargins(0, 0, 0, 0)
        snd_label = QLabel("Sound File:")
        self.sound_path_display = QLineEdit(self._basename(self._current_data.sound_path))
        self.sound_path_display.setToolTip(self._current_data.sound_path)
        browse_btn = QPushButton("Browse")
        browse_btn.clicked.connect(lambda: self.sound_file_browse_requested.emit())
        snd_reset = self._reset_button()
        snd_reset.clicked.connect(lambda: self.reset_requested.emit("sound_path"))
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
        output_form.addRow(QLabel("Output SRT with timestamps"), self.srt_toggle)
        root.addWidget(output_group)

        # Buttons
        buttons = QWidget()
        hb = QHBoxLayout(buttons)
        hb.addStretch(1)
        reset_all = QPushButton("Reset All")
        # Use proper resource service for reset all button too
        if self._resource_service:
            try:
                icon_path = self._resource_service.get_resource_path("resources/Command-Reset-256.png")
                reset_all.setIcon(QIcon(icon_path))
                reset_all.setIconSize(QSize(16, 16))
            except Exception:
                pass
        reset_all.clicked.connect(lambda: self.reset_requested.emit("all"))
        ok_btn = QPushButton("OK")
        cancel_btn = QPushButton("Cancel")
        ok_btn.clicked.connect(self._accept)
        cancel_btn.clicked.connect(self.reject)
        hb.addWidget(reset_all)
        hb.addWidget(ok_btn)
        hb.addWidget(cancel_btn)
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
        if key == Qt.Key.Key_Control:
            return "CTRL"
        if key == Qt.Key.Key_Alt:
            return "ALT"
        if key == Qt.Key.Key_Shift:
            return "SHIFT"
        if key == Qt.Key.Key_Meta:
            return "META"
        if Qt.Key.Key_F1 <= key <= Qt.Key.Key_F35:
            return f"F{key - Qt.Key.Key_F1 + 1}"
        text = event.text()
        if text and text.isprintable():
            return text.upper()
        return None



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
        except Exception:
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


