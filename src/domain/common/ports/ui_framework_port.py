"""UI Framework Port for framework-agnostic UI operations."""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any


class WidgetType(Enum):
    """Types of UI widgets."""
    WINDOW = "window"
    DIALOG = "dialog"
    BUTTON = "button"
    LABEL = "label"
    INPUT = "input"
    CHECKBOX = "checkbox"
    COMBOBOX = "combobox"
    PROGRESS_BAR = "progress_bar"
    LAYOUT = "layout"


class UIEventType(Enum):
    """Types of UI events."""
    CLICK = "click"
    KEY_PRESS = "key_press"
    CLOSE = "close"
    RESIZE = "resize"
    DRAG_DROP = "drag_drop"


class IUIWidget(ABC):
    """Abstract UI widget interface."""
    
    @abstractmethod
    def show(self) -> None:
        """Show the widget."""
        ...
    
    @abstractmethod
    def hide(self) -> None:
        """Hide the widget."""
        ...
    
    @abstractmethod
    def set_enabled(self, enabled: bool) -> None:
        """Set widget enabled state."""
        ...
    
    @abstractmethod
    def get_value(self) -> Any:
        """Get widget value."""
        ...
    
    @abstractmethod
    def set_value(self, value: Any) -> None:
        """Set widget value."""
        ...


class IUILayout(ABC):
    """Abstract UI layout interface."""
    
    @abstractmethod
    def add_widget(self, widget: IUIWidget) -> None:
        """Add widget to layout."""
        ...
    
    @abstractmethod
    def remove_widget(self, widget: IUIWidget) -> None:
        """Remove widget from layout."""
        ...


class IUIWindow(ABC):
    """Abstract UI window interface."""
    
    @abstractmethod
    def set_title(self, title: str) -> None:
        """Set window title."""
        ...
    
    @abstractmethod
    def set_size(self, width: int, height: int) -> None:
        """Set window size."""
        ...
    
    @abstractmethod
    def set_layout(self, layout: IUILayout) -> None:
        """Set window layout."""
        ...
    
    @abstractmethod
    def show(self) -> None:
        """Show window."""
        ...
    
    @abstractmethod
    def close(self) -> None:
        """Close window."""
        ...


class IUIDialog(ABC):
    """Abstract UI dialog interface."""
    
    @abstractmethod
    def exec(self) -> int:
        """Execute dialog modally."""
        ...
    
    @abstractmethod
    def accept(self) -> None:
        """Accept dialog."""
        ...
    
    @abstractmethod
    def reject(self) -> None:
        """Reject dialog."""
        ...


class IUIFactory(ABC):
    """Abstract UI factory for creating UI elements."""
    
    @abstractmethod
    def create_window(self, title: str) -> IUIWindow:
        """Create a window."""
        ...
    
    @abstractmethod
    def create_dialog(self, title: str, parent: IUIWindow | None = None) -> IUIDialog:
        """Create a dialog."""
        ...
    
    @abstractmethod
    def create_widget(self, widget_type: WidgetType) -> IUIWidget:
        """Create a widget."""
        ...
    
    @abstractmethod
    def create_layout(self, layout_type: str) -> IUILayout:
        """Create a layout."""
        ...


class IUIEventHandler(ABC):
    """Abstract UI event handler interface."""
    
    @abstractmethod
    def handle_event(self, event_type: UIEventType, event_data: dict[str, Any]) -> None:
        """Handle UI event."""
        ...


class IUIApplication(ABC):
    """Abstract UI application interface."""
    
    @abstractmethod
    def run(self) -> int:
        """Run the application."""
        ...
    
    @abstractmethod
    def quit(self) -> None:
        """Quit the application."""
        ...
    
    @abstractmethod
    def set_style(self, style_name: str) -> None:
        """Set application style."""
        ...
