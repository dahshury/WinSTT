"""PyQt6 UI Framework Adapter."""

from typing import Any

from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from src_refactored.domain.common.ports.ui_framework_port import (
    IUIApplication,
    IUIDialog,
    IUIFactory,
    IUILayout,
    IUIWidget,
    IUIWindow,
    WidgetType,
)


class PyQt6WidgetAdapter(IUIWidget):
    """PyQt6 widget adapter."""
    
    def __init__(self, qt_widget: QWidget):
        """Initialize adapter with Qt widget."""
        self._widget = qt_widget
    
    def show(self) -> None:
        """Show the widget."""
        self._widget.show()
    
    def hide(self) -> None:
        """Hide the widget."""
        self._widget.hide()
    
    def set_enabled(self, enabled: bool) -> None:
        """Set widget enabled state."""
        self._widget.setEnabled(enabled)
    
    def get_value(self) -> Any:
        """Get widget value."""
        if hasattr(self._widget, "text"):
            return self._widget.text()
        if hasattr(self._widget, "isChecked"):
            return self._widget.isChecked()
        if hasattr(self._widget, "value"):
            return self._widget.value()
        return None
    
    def set_value(self, value: Any) -> None:
        """Set widget value."""
        if hasattr(self._widget, "setText") and isinstance(value, str):
            self._widget.setText(value)
        elif hasattr(self._widget, "setChecked") and isinstance(value, bool):
            self._widget.setChecked(value)
        elif hasattr(self._widget, "setValue"):
            self._widget.setValue(value)


class PyQt6LayoutAdapter(IUILayout):
    """PyQt6 layout adapter."""
    
    def __init__(self, qt_layout):
        """Initialize adapter with Qt layout."""
        self._layout = qt_layout
    
    def add_widget(self, widget: IUIWidget) -> None:
        """Add widget to layout."""
        if isinstance(widget, PyQt6WidgetAdapter):
            self._layout.addWidget(widget._widget)
    
    def remove_widget(self, widget: IUIWidget) -> None:
        """Remove widget from layout."""
        if isinstance(widget, PyQt6WidgetAdapter):
            self._layout.removeWidget(widget._widget)


class PyQt6WindowAdapter(IUIWindow):
    """PyQt6 window adapter."""
    
    def __init__(self, qt_window: QMainWindow):
        """Initialize adapter with Qt window."""
        self._window = qt_window
    
    def set_title(self, title: str) -> None:
        """Set window title."""
        self._window.setWindowTitle(title)
    
    def set_size(self, width: int, height: int) -> None:
        """Set window size."""
        self._window.resize(width, height)
    
    def set_layout(self, layout: IUILayout) -> None:
        """Set window layout."""
        if isinstance(layout, PyQt6LayoutAdapter):
            central_widget = QWidget()
            central_widget.setLayout(layout._layout)
            self._window.setCentralWidget(central_widget)
    
    def show(self) -> None:
        """Show window."""
        self._window.show()
    
    def close(self) -> None:
        """Close window."""
        self._window.close()


class PyQt6DialogAdapter(IUIDialog):
    """PyQt6 dialog adapter."""
    
    def __init__(self, qt_dialog: QDialog):
        """Initialize adapter with Qt dialog."""
        self._dialog = qt_dialog
    
    def exec(self) -> int:
        """Execute dialog modally."""
        return self._dialog.exec()
    
    def accept(self) -> None:
        """Accept dialog."""
        self._dialog.accept()
    
    def reject(self) -> None:
        """Reject dialog."""
        self._dialog.reject()


class PyQt6UIFactory(IUIFactory):
    """PyQt6 UI factory."""
    
    def create_window(self, title: str) -> IUIWindow:
        """Create a window."""
        qt_window = QMainWindow()
        qt_window.setWindowTitle(title)
        return PyQt6WindowAdapter(qt_window)
    
    def create_dialog(self, title: str, parent: IUIWindow | None = None) -> IUIDialog:
        """Create a dialog."""
        parent_widget = None
        if parent and isinstance(parent, PyQt6WindowAdapter):
            parent_widget = parent._window
        
        qt_dialog = QDialog(parent_widget)
        qt_dialog.setWindowTitle(title)
        return PyQt6DialogAdapter(qt_dialog)
    
    def create_widget(self, widget_type: WidgetType) -> IUIWidget:
        """Create a widget."""
        widget_map = {
            WidgetType.BUTTON: QPushButton,
            WidgetType.LABEL: QLabel,
            WidgetType.INPUT: QLineEdit,
            WidgetType.CHECKBOX: QCheckBox,
            WidgetType.COMBOBOX: QComboBox,
            WidgetType.PROGRESS_BAR: QProgressBar,
        }
        
        if widget_type in widget_map:
            qt_widget = widget_map[widget_type]()
            return PyQt6WidgetAdapter(qt_widget)
        
        msg = f"Unsupported widget type: {widget_type}"
        raise ValueError(msg)
    
    def create_layout(self, layout_type: str) -> IUILayout:
        """Create a layout."""
        layout_map = {
            "vertical": QVBoxLayout,
            "horizontal": QHBoxLayout,
        }
        
        if layout_type in layout_map:
            qt_layout = layout_map[layout_type]()
            return PyQt6LayoutAdapter(qt_layout)
        
        msg = f"Unsupported layout type: {layout_type}"
        raise ValueError(msg)


class PyQt6ApplicationAdapter(IUIApplication):
    """PyQt6 application adapter."""
    
    def __init__(self, app: QApplication):
        """Initialize adapter with Qt application."""
        self._app = app
    
    def run(self) -> int:
        """Run the application."""
        return self._app.exec()
    
    def quit(self) -> None:
        """Quit the application."""
        self._app.quit()
    
    def set_style(self, style_name: str) -> None:
        """Set application style."""
        self._app.setStyle(style_name)
