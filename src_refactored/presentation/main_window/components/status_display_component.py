"""Status Display Component.

This component handles the status label and related UI elements,
following the component pattern for better separation of concerns.
"""

from PyQt6 import QtCore
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import QLabel, QWidget

from src_refactored.presentation.shared.ui_theme_service import UIThemeService


class StatusDisplayComponent:
    """Component for handling status display UI elements."""
    
    def __init__(self, parent: QWidget, theme_service: UIThemeService):
        self._parent = parent
        self._theme = theme_service
        self._setup_components()
    
    def _setup_components(self) -> None:
        """Set up status display components."""
        # Title label
        self.title_label = QLabel("STT", parent=self._parent)
        self.title_label.setGeometry(QtCore.QRect(150, 10, 131, 31))
        self.title_label.setStyleSheet(self._theme.get_text_style("title"))
        
        font = QFont()
        font.setFamily("Codec Pro ExtraBold")
        font.setPointSize(24)
        font.setBold(True)
        self.title_label.setFont(font)
        self.title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        # Status label
        self.status_label = QLabel("", parent=self._parent)
        self.status_label.setGeometry(QtCore.QRect(17, 85, 370, 30))
        self.status_label.setStyleSheet(self._theme.get_text_style("status"))
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        font = QFont()
        font.setFamily("Input")
        font.setPointSize(10)
        self.status_label.setFont(font)
        
        # Instruction label
        self.instruction_label = QLabel("", parent=self._parent)
        self.instruction_label.setGeometry(QtCore.QRect(17, 50, 370, 30))
        self.instruction_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.instruction_label.setStyleSheet(self._theme.get_text_style("instruction"))
        
        font = QFont()
        font.setFamily("Roboto")
        font.setPointSize(9)
        self.instruction_label.setFont(font)
    
    def update_instruction_text(self, recording_key: str) -> None:
        """Update the instruction text with the current recording key."""
        self.instruction_label.setText(
            f"Hold {recording_key} to record or drag & drop to transcribe",
        )
    
    def update_status_text(self, text: str) -> None:
        """Update the status label text."""
        self.status_label.setText(text)
    
    def get_status_label(self) -> QLabel:
        """Get the status label for external services."""
        return self.status_label

