"""Qt Widget Adapters for PyQt6.

This module provides adapters that bridge Qt widgets with the domain interfaces.
"""

from collections.abc import Callable

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QDialog,
    QLabel,
    QLineEdit,
    QPushButton,
    QWidget,
)

from src_refactored.domain.common.value_objects.result import Result
from src_refactored.domain.ui_widgets.ports.button_port import IButton
from src_refactored.domain.ui_widgets.ports.label_port import ILabel
from src_refactored.domain.ui_widgets.ports.line_edit_port import ILineEdit

# ============================================================================
# BASE WIDGET ADAPTER
# ============================================================================

class QtWidgetAdapter:
    """Base Qt widget adapter."""
    
    def __init__(self, qt_widget: QWidget):
        self._qt_widget = qt_widget
    
    @property
    def qt_widget(self) -> QWidget:
        """Get the underlying Qt widget."""
        return self._qt_widget
    
    def show(self) -> None:
        """Show the widget."""
        self._qt_widget.show()
    
    def hide(self) -> None:
        """Hide the widget."""
        self._qt_widget.hide()
    
    def set_visible(self, visible: bool) -> None:
        """Set widget visibility."""
        self._qt_widget.setVisible(visible)
    
    def is_visible(self) -> bool:
        """Check if widget is visible."""
        return self._qt_widget.isVisible()
    
    def set_enabled(self, enabled: bool) -> None:
        """Set widget enabled state."""
        self._qt_widget.setEnabled(enabled)
    
    def is_enabled(self) -> bool:
        """Check if widget is enabled."""
        return self._qt_widget.isEnabled()
    
    def set_tooltip(self, tooltip: str) -> None:
        """Set widget tooltip."""
        self._qt_widget.setToolTip(tooltip)
    
    def get_tooltip(self) -> str:
        """Get widget tooltip."""
        return self._qt_widget.toolTip()


# ============================================================================
# BUTTON ADAPTER
# ============================================================================

class QtButtonAdapter(QtWidgetAdapter, IButton):
    """Qt button adapter implementing IButton."""
    
    def __init__(self, qt_button: QPushButton):
        super().__init__(qt_button)
        self._qt_button = qt_button
    
    def set_click_handler(self, handler: Callable) -> None:
        """Set click handler for button."""
        self._qt_button.clicked.connect(handler)


# ============================================================================
# LABEL ADAPTER
# ============================================================================

class QtLabelAdapter(QtWidgetAdapter, ILabel):
    """Qt label adapter implementing ILabel."""
    
    def __init__(self, qt_label: QLabel):
        super().__init__(qt_label)
        self._qt_label = qt_label
    
    def set_text(self, text: str) -> None:
        """Set label text."""
        self._qt_label.setText(text)
    
    def get_text(self) -> str:
        """Get label text."""
        return self._qt_label.text()
    
    def set_word_wrap(self, wrap: bool) -> None:
        """Set word wrap for label."""
        self._qt_label.setWordWrap(wrap)
    
    def set_alignment(self, alignment: str) -> None:
        """Set text alignment for label."""
        if alignment == "left":
            self._qt_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        elif alignment == "center":
            self._qt_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        elif alignment == "right":
            self._qt_label.setAlignment(Qt.AlignmentFlag.AlignRight)
        elif alignment == "justify":
            self._qt_label.setAlignment(Qt.AlignmentFlag.AlignJustify)


# ============================================================================
# TEXT INPUT ADAPTER
# ============================================================================

class QtTextInputAdapter(QtWidgetAdapter, ILineEdit):
    """Qt text input adapter implementing ILineEdit."""
    
    def __init__(self, qt_input: QLineEdit):
        super().__init__(qt_input)
        self._qt_input = qt_input
    
    def set_text(self, text: str) -> None:
        """Set input text."""
        self._qt_input.setText(text)
    
    def get_text(self) -> str:
        """Get input text."""
        return self._qt_input.text()
    
    def set_placeholder(self, text: str) -> None:
        """Set placeholder text."""
        self._qt_input.setPlaceholderText(text)
    
    def set_max_length(self, length: int) -> None:
        """Set maximum input length."""
        self._qt_input.setMaxLength(length)
    
    def set_read_only(self, read_only: bool) -> None:
        """Set read-only state."""
        self._qt_input.setReadOnly(read_only)


# ============================================================================
# DIALOG ADAPTER
# ============================================================================

class QtDialogAdapter(QtWidgetAdapter):
    """Qt dialog adapter."""
    
    def __init__(self, qt_dialog: QDialog):
        super().__init__(qt_dialog)
        self._qt_dialog = qt_dialog
    
    def set_title(self, title: str) -> None:
        """Set dialog title."""
        self._qt_dialog.setWindowTitle(title)
    
    def set_modal(self, modal: bool) -> None:
        """Set dialog modal state."""
        self._qt_dialog.setModal(modal)
    
    def show_dialog(self) -> None:
        """Show dialog."""
        self._qt_dialog.show()
    
    def close_dialog(self) -> None:
        """Close dialog."""
        self._qt_dialog.close()


# ============================================================================
# WIDGET FACTORY
# ============================================================================

class QtUIWidgetFactory:
    """Qt UI widget factory."""
    
    def create_button(self, **properties) -> Result[IButton]:
        """Create a button widget."""
        try:
            qt_button = QPushButton()
            
            # Apply properties
            if "text" in properties:
                qt_button.setText(properties["text"])
            if "enabled" in properties:
                qt_button.setEnabled(properties["enabled"])
            
            adapter = QtButtonAdapter(qt_button)
            return Result.success(adapter)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create button: {e!s}")
    
    def create_label(self, **properties) -> Result[ILabel]:
        """Create a label widget."""
        try:
            qt_label = QLabel()
            
            # Apply properties
            if "text" in properties:
                qt_label.setText(properties["text"])
            if "word_wrap" in properties:
                qt_label.setWordWrap(properties["word_wrap"])
            if "alignment" in properties:
                adapter = QtLabelAdapter(qt_label)
                adapter.set_alignment(properties["alignment"])
                return Result.success(adapter)
            
            adapter = QtLabelAdapter(qt_label)
            return Result.success(adapter)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create label: {e!s}")
    
    def create_text_input(self, **properties) -> Result[ILineEdit]:
        """Create a text input widget."""
        try:
            qt_input = QLineEdit()
            
            # Apply properties
            if "placeholder" in properties:
                qt_input.setPlaceholderText(properties["placeholder"])
            if "max_length" in properties:
                qt_input.setMaxLength(properties["max_length"])
            if "read_only" in properties:
                qt_input.setReadOnly(properties["read_only"])
            
            adapter = QtTextInputAdapter(qt_input)
            return Result.success(adapter)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create text input: {e!s}")
    
    def create_dialog(self, **properties) -> Result[QtDialogAdapter]:
        """Create a dialog widget."""
        try:
            qt_dialog = QDialog()
            
            # Apply properties
            if "title" in properties:
                qt_dialog.setWindowTitle(properties["title"])
            if "modal" in properties:
                qt_dialog.setModal(properties["modal"])
            
            adapter = QtDialogAdapter(qt_dialog)
            return Result.success(adapter)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create dialog: {e!s}")


__all__ = [
    "QtButtonAdapter",
    "QtDialogAdapter",
    "QtLabelAdapter",
    "QtTextInputAdapter",
    "QtUIWidgetFactory",
    "QtWidgetAdapter",
]
