"""UI Core Patterns and Design Patterns.

This module provides core UI design patterns that preserve existing UI patterns
while enabling dependency injection, modular architecture, and clean separation of concerns.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Protocol, TypeVar

from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation
from PyQt6.QtGui import QFont, QPalette
from PyQt6.QtWidgets import QFormLayout, QGridLayout, QHBoxLayout, QLayout, QVBoxLayout, QWidget

from src.domain.common.result import Result
from src.domain.common.value_object import ValueObject

from .ui_core_abstractions import UIDialogComponent, UIWidgetComponent

T = TypeVar("T")
TWidget = TypeVar("TWidget", bound=QWidget)
TLayout = TypeVar("TLayout", bound="QLayout")


class UIPatternType(Enum):
    """Enumeration of UI pattern types."""
    MVVM = "mvvm"
    MVP = "mvp"
    MVC = "mvc"
    OBSERVER = "observer"
    COMMAND = "command"
    STRATEGY = "strategy"
    FACTORY = "factory"
    BUILDER = "builder"
    COMPOSITE = "composite"
    DECORATOR = "decorator"
    FACADE = "facade"
    ADAPTER = "adapter"


class UILayoutType(Enum):
    """Enumeration of UI layout types."""
    VERTICAL = "vertical"
    HORIZONTAL = "horizontal"
    GRID = "grid"
    FORM = "form"
    STACKED = "stacked"
    SPLITTER = "splitter"
    TABS = "tabs"
    CUSTOM = "custom"


@dataclass(frozen=True)
class UIPattern(ValueObject):
    """Value object representing a UI pattern."""
    pattern_type: UIPatternType
    pattern_name: str
    description: str
    components: list[str] = field(default_factory=list)
    properties: dict[str, Any] = field(default_factory=dict)
    
    def _get_equality_components(self) -> tuple:
        return (
            self.pattern_type,
            self.pattern_name,
            self.description,
            tuple(sorted(self.components)),
            tuple(sorted(self.properties.items())),
        )


@dataclass(frozen=True)
class UILayoutConfiguration(ValueObject):
    """Value object for UI layout configuration."""
    layout_type: UILayoutType
    spacing: int = 6
    margins: tuple = (9, 9, 9, 9)  # left, top, right, bottom
    alignment: str = "center"
    stretch_factors: dict[int, int] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)
    
    def _get_equality_components(self) -> tuple:
        return (
            self.layout_type,
            self.spacing,
            self.margins,
            self.alignment,
            tuple(sorted(self.stretch_factors.items())),
            tuple(sorted(self.properties.items())),
        )


class IUIPattern(Protocol):
    """Protocol for UI patterns."""
    
    @property
    def pattern_info(self) -> UIPattern:
        """Get pattern information."""
        ...
    
    def apply_pattern(self, target: Any) -> Result[None]:
        """Apply the pattern to a target."""
        ...
    
    def validate_pattern(self, target: Any) -> Result[None]:
        """Validate that the pattern is correctly applied."""
        ...


class IUILayoutManager(Protocol):
    """Protocol for UI layout management."""
    
    def create_layout(self, config: UILayoutConfiguration) -> Result[Any]:
        """Create a layout based on configuration."""
        ...
    
    def add_widget(self, widget: QWidget, position: Any = None) -> Result[None]:
        """Add a widget to the layout."""
        ...
    
    def remove_widget(self, widget: QWidget) -> Result[None]:
        """Remove a widget from the layout."""
        ...


class IUIThemeManager(Protocol):
    """Protocol for UI theme management."""
    
    def apply_theme(self, widget: QWidget, theme_name: str) -> Result[None]:
        """Apply a theme to a widget."""
        ...
    
    def get_theme_property(self, theme_name: str, property_name: str) -> Any:
        """Get a theme property value."""
        ...


class MVVMPattern(IUIPattern):
    """Model-View-ViewModel pattern implementation."""
    
    def __init__(self, view_model_class: type, model_class: type | None = None):
        """Initialize MVVM pattern.
        
        Args:
            view_model_class: ViewModel class
            model_class: Optional Model class
        """
        self._view_model_class = view_model_class
        self._model_class = model_class
        self._pattern_info = UIPattern(
            pattern_type=UIPatternType.MVVM,
            pattern_name="Model-View-ViewModel",
            description="Separates UI logic from business logic using ViewModels",
            components=["View", "ViewModel", "Model"] if model_class else ["View", "ViewModel"],
        )
        
        self.logger = logging.getLogger(__name__)
    
    @property
    def pattern_info(self) -> UIPattern:
        """Get pattern information."""
        return self._pattern_info
    
    def apply_pattern(self, target: QWidget) -> Result[None]:
        """Apply MVVM pattern to a widget.
        
        Args:
            target: Target widget to apply pattern to
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Create ViewModel instance
            view_model = self._view_model_class()
            
            # Create Model instance if specified
            model = None
            if self._model_class:
                model = self._model_class()
                # Connect Model to ViewModel
                if hasattr(view_model, "set_model"):
                    view_model.set_model(model)
            
            # Connect ViewModel to View
            if hasattr(target, "set_view_model") and callable(getattr(target, "set_view_model", None)):
                target.set_view_model(view_model)
            else:
                # Store as property
                target._view_model = view_model
            
            # Connect ViewModel signals to View slots if they exist
            self._connect_view_model_signals(target, view_model)
            
            self.logger.info(f"MVVM pattern applied to {target.__class__.__name__}")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to apply MVVM pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def validate_pattern(self, target: QWidget) -> Result[None]:
        """Validate MVVM pattern implementation.
        
        Args:
            target: Target widget to validate
            
        Returns:
            Result indicating validation success or failure
        """
        try:
            # Check if ViewModel is present
            view_model = getattr(target, "_view_model", None)
            if not view_model:
                return Result.failure("ViewModel not found")
            
            # Check if ViewModel has required methods
            required_methods = ["initialize", "cleanup"]
            for method in required_methods:
                if not hasattr(view_model, method):
                    return Result.failure(f"ViewModel missing required method: {method}")
            
            # Check Model if specified
            if self._model_class:
                model = getattr(view_model, "_model", None)
                if not model:
                    return Result.failure("Model not found in ViewModel")
            
            return Result.success(None)
            
        except Exception as e:
            return Result.failure(f"MVVM validation failed: {e!s}")
    
    def _connect_view_model_signals(self, view: QWidget, view_model: QObject) -> None:
        """Connect ViewModel signals to View slots.
        
        Args:
            view: View widget
            view_model: ViewModel object
        """
        try:
            # Common signal-slot connections
            signal_slot_mappings = [
                ("property_changed", "on_property_changed"),
                ("data_updated", "on_data_updated"),
                ("error_occurred", "on_error_occurred"),
                ("busy_state_changed", "on_busy_state_changed"),
                ("validation_failed", "on_validation_failed"),
            ]
            
            for signal_name, slot_name in signal_slot_mappings:
                if hasattr(view_model, signal_name) and hasattr(view, slot_name):
                    signal = getattr(view_model, signal_name)
                    slot = getattr(view, slot_name)
                    signal.connect(slot)
                    self.logger.debug(f"Connected {signal_name} to {slot_name}")
            
        except Exception as e:
            self.logger.warning(f"Failed to connect some ViewModel signals: {e}")


class ObserverPattern(IUIPattern):
    """Observer pattern implementation for UI components."""
    
    def __init__(self):
        """Initialize Observer pattern."""
        self._observers: dict[str, list[Callable]] = {}
        self._pattern_info = UIPattern(
            pattern_type=UIPatternType.OBSERVER,
            pattern_name="Observer",
            description="Notifies multiple observers when subject state changes",
            components=["Subject", "Observer"],
        )
        
        self.logger = logging.getLogger(__name__)
    
    @property
    def pattern_info(self) -> UIPattern:
        """Get pattern information."""
        return self._pattern_info
    
    def apply_pattern(self, target: QObject) -> Result[None]:
        """Apply Observer pattern to a QObject.
        
        Args:
            target: Target object to apply pattern to
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Add observer methods to target
            target._observers = {}
            target.add_observer = lambda event, callback: self._add_observer(target, event, callback)
            target.remove_observer = lambda event, callback: self._remove_observer(target, event, callback)
            target.notify_observers = lambda event, data=None: self._notify_observers(target, event, data)
            
            self.logger.info(f"Observer pattern applied to {target.__class__.__name__}")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to apply Observer pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def validate_pattern(self, target: QObject) -> Result[None]:
        """Validate Observer pattern implementation.
        
        Args:
            target: Target object to validate
            
        Returns:
            Result indicating validation success or failure
        """
        required_methods = ["add_observer", "remove_observer", "notify_observers"]
        
        for method in required_methods:
            if not hasattr(target, method):
                return Result.failure(f"Observer pattern missing required method: {method}")
        
        if not hasattr(target, "_observers"):
            return Result.failure("Observer pattern missing _observers attribute")
        
        return Result.success(None)
    
    def _add_observer(self, target: QObject, event: str, callback: Callable) -> None:
        """Add an observer for an event.
        
        Args:
            target: Target object
            event: Event name
            callback: Callback function
        """
        observers = getattr(target, "_observers", {})
        if event not in observers:
            observers[event] = []
        if callback not in observers[event]:
            observers[event].append(callback)
    
    def _remove_observer(self, target: QObject, event: str, callback: Callable) -> None:
        """Remove an observer for an event.
        
        Args:
            target: Target object
            event: Event name
            callback: Callback function
        """
        observers = getattr(target, "_observers", {})
        if event in observers and callback in observers[event]:
            observers[event].remove(callback)
    
    def _notify_observers(self, target: QObject, event: str, data: Any = None) -> None:
        """Notify all observers of an event.
        
        Args:
            target: Target object
            event: Event name
            data: Optional event data
        """
        observers = getattr(target, "_observers", {})
        if event in observers:
            for callback in observers[event]:
                try:
                    callback(data)
                except Exception as e:
                    self.logger.exception(f"Error in observer callback: {e}")


class CommandPattern(IUIPattern):
    """Command pattern implementation for UI actions."""
    
    def __init__(self):
        """Initialize Command pattern."""
        self._commands: dict[str, ICommand] = {}
        self._command_history: list[ICommand] = []
        self._max_history = 100
        
        self._pattern_info = UIPattern(
            pattern_type=UIPatternType.COMMAND,
            pattern_name="Command",
            description="Encapsulates requests as objects for undo/redo functionality",
            components=["Command", "Invoker", "Receiver"],
        )
        
        self.logger = logging.getLogger(__name__)
    
    @property
    def pattern_info(self) -> UIPattern:
        """Get pattern information."""
        return self._pattern_info
    
    def apply_pattern(self, target: QObject) -> Result[None]:
        """Apply Command pattern to a QObject.
        
        Args:
            target: Target object to apply pattern to
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Add command methods to target
            target._commands = {}
            target._command_history = []
            target.register_command = lambda name, command: self._register_command(target, name, command)
            target.execute_command = lambda name, *args, **kwargs: self._execute_command(target, name, *args, **kwargs)
            target.undo_last_command = lambda: self._undo_last_command(target)
            target.get_command_history = lambda: self._get_command_history(target)
            
            self.logger.info(f"Command pattern applied to {target.__class__.__name__}")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to apply Command pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def validate_pattern(self, target: QObject) -> Result[None]:
        """Validate Command pattern implementation.
        
        Args:
            target: Target object to validate
            
        Returns:
            Result indicating validation success or failure
        """
        required_methods = ["register_command", "execute_command", "undo_last_command", "get_command_history"]
        
        for method in required_methods:
            if not hasattr(target, method):
                return Result.failure(f"Command pattern missing required method: {method}")
        
        required_attributes = ["_commands", "_command_history"]
        for attr in required_attributes:
            if not hasattr(target, attr):
                return Result.failure(f"Command pattern missing required attribute: {attr}")
        
        return Result.success(None)
    
    def _register_command(self, target: QObject, name: str, command: "ICommand") -> None:
        """Register a command.
        
        Args:
            target: Target object
            name: Command name
            command: Command instance
        """
        commands = getattr(target, "_commands", {})
        commands[name] = command
    
    def _execute_command(self, target: QObject, name: str, *args, **kwargs) -> Result[Any]:
        """Execute a command.
        
        Args:
            target: Target object
            name: Command name
            *args: Command arguments
            **kwargs: Command keyword arguments
            
        Returns:
            Result of command execution
        """
        try:
            commands = getattr(target, "_commands", {})
            if name not in commands:
                return Result.failure(f"Command '{name}' not found")
            
            command = commands[name]
            result = command.execute(*args, **kwargs)
            
            # Add to history if command supports undo
            if hasattr(command, "undo"):
                history = getattr(target, "_command_history", [])
                history.append(command)
                
                # Trim history if needed
                if len(history) > self._max_history:
                    history = history[-self._max_history:]
                    target._command_history = history
            
            return result
            
        except Exception as e:
            return Result.failure(f"Command execution failed: {e!s}")
    
    def _undo_last_command(self, target: QObject) -> Result[None]:
        """Undo the last command.
        
        Args:
            target: Target object
            
        Returns:
            Result indicating success or failure
        """
        try:
            history = getattr(target, "_command_history", [])
            if not history:
                return Result.failure("No commands to undo")
            
            last_command = history.pop()
            if hasattr(last_command, "undo"):
                return last_command.undo()
            return Result.failure("Last command does not support undo")
            
        except Exception as e:
            return Result.failure(f"Undo failed: {e!s}")
    
    def _get_command_history(self, target: QObject) -> list["ICommand"]:
        """Get command history.
        
        Args:
            target: Target object
            
        Returns:
            List of executed commands
        """
        return getattr(target, "_command_history", []).copy()


class ICommand(Protocol):
    """Protocol for commands."""
    
    def execute(self, *args, **kwargs) -> Result[Any]:
        """Execute the command."""
        ...
    
    def undo(self) -> Result[None]:
        """Undo the command."""
        ...


class UILayoutManager(IUILayoutManager):
    """Manager for UI layouts."""
    
    def __init__(self):
        """Initialize layout manager."""
        self._layouts: dict[str, Any] = {}
        self.logger = logging.getLogger(__name__)
    
    def create_layout(self, config: UILayoutConfiguration) -> Result[Any]:
        """Create a layout based on configuration.
        
        Args:
            config: Layout configuration
            
        Returns:
            Result containing the created layout
        """
        try:
            layout = None
            
            if config.layout_type == UILayoutType.VERTICAL:
                layout = QVBoxLayout()
            elif config.layout_type == UILayoutType.HORIZONTAL:
                layout = QHBoxLayout()
            elif config.layout_type == UILayoutType.GRID:
                layout = QGridLayout()
            elif config.layout_type == UILayoutType.FORM:
                layout = QFormLayout()
            else:
                return Result.failure(f"Unsupported layout type: {config.layout_type}")
            
            # Apply configuration
            layout.setSpacing(config.spacing)
            layout.setContentsMargins(*config.margins)
            
            # Apply stretch factors for box layouts
            if hasattr(layout, "setStretchFactor") and config.stretch_factors:
                for index, factor in config.stretch_factors.items():
                    layout.setStretch(index, factor)
            
            # Apply additional properties
            for prop_name, prop_value in config.properties.items():
                if hasattr(layout, prop_name):
                    try:
                        getattr(layout, prop_name)(prop_value)
                    except Exception as e:
                        self.logger.warning(f"Failed to set layout property {prop_name}: {e}")
            
            self.logger.info(f"Created {config.layout_type.value} layout")
            return Result.success(layout)
            
        except Exception as e:
            error_msg = f"Failed to create layout: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    # Keep a convenience overload while honoring Protocol signature
    def add_widget(self, widget: QWidget, position: Any = None) -> Result[None]:
        # Default to a stored main layout if present
        layout = self._layouts.get("main", None)
        if layout is None and self._layouts:
            # pick any available layout
            layout = next(iter(self._layouts.values()))
        if layout is None:
            return Result.failure("No layout available")
        return self._add_widget_to_layout(layout, widget, position)

    def _add_widget_to_layout(self, layout: Any, widget: QWidget, position: Any = None) -> Result[None]:
        """Add a widget to the layout.
        
        Args:
            layout: Target layout
            widget: Widget to add
            position: Optional position specification
            
        Returns:
            Result indicating success or failure
        """
        try:
            if isinstance(layout, QVBoxLayout | QHBoxLayout):
                if position is not None and isinstance(position, int):
                    layout.insertWidget(position, widget)
                else:
                    layout.addWidget(widget)
            elif isinstance(layout, QGridLayout):
                if position and len(position) >= 2:
                    row, col = position[0], position[1]
                    rowspan = position[2] if len(position) > 2 else 1
                    colspan = position[3] if len(position) > 3 else 1
                    layout.addWidget(widget, row, col, rowspan, colspan)
                else:
                    # Find next available position
                    row = layout.rowCount()
                    layout.addWidget(widget, row, 0)
            elif isinstance(layout, QFormLayout):
                if position and isinstance(position, str):
                    layout.addRow(position, widget)
                else:
                    layout.addWidget(widget)
            else:
                return Result.failure("Unsupported layout type for widget addition")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to add widget to layout: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def remove_widget(self, widget: QWidget) -> Result[None]:
        # Remove from any known layout containing the widget
        for layout in self._layouts.values():
            try:
                layout.removeWidget(widget)  # type: ignore[no-untyped-call]
                return Result.success(None)
            except Exception:
                continue
        return Result.failure("Widget not found in layouts")
        """Remove a widget from the layout.
        
        Args:
            layout: Source layout
            widget: Widget to remove
            
        Returns:
            Result indicating success or failure
        """
        try:
            layout.removeWidget(widget)
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to remove widget from layout: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


class UIThemeManager(IUIThemeManager):
    """Manager for UI themes and styling."""
    
    def __init__(self):
        """Initialize theme manager."""
        self._themes: dict[str, dict[str, Any]] = {}
        self._current_theme = "default"
        self._load_default_themes()
        
        self.logger = logging.getLogger(__name__)
    
    def apply_theme(self, widget: QWidget, theme_name: str) -> Result[None]:
        """Apply a theme to a widget.
        
        Args:
            widget: Target widget
            theme_name: Name of theme to apply
            
        Returns:
            Result indicating success or failure
        """
        try:
            if theme_name not in self._themes:
                return Result.failure(f"Theme '{theme_name}' not found")
            
            theme = self._themes[theme_name]
            
            # Apply stylesheet if present
            if "stylesheet" in theme:
                widget.setStyleSheet(theme["stylesheet"])
            
            # Apply font if present
            if "font" in theme:
                font_config = theme["font"]
                font = QFont()
                if "family" in font_config:
                    font.setFamily(font_config["family"])
                if "size" in font_config:
                    font.setPointSize(font_config["size"])
                if "bold" in font_config:
                    font.setBold(font_config["bold"])
                if "italic" in font_config:
                    font.setItalic(font_config["italic"])
                widget.setFont(font)
            
            # Apply palette if present
            if "palette" in theme:
                palette_config = theme["palette"]
                palette = widget.palette()
                
                for role_name, color_value in palette_config.items():
                    try:
                        role = getattr(QPalette.ColorRole, role_name)
                        palette.setColor(role, color_value)
                    except AttributeError:
                        self.logger.warning(f"Unknown palette role: {role_name}")
                
                widget.setPalette(palette)
            
            # Apply custom properties
            if "properties" in theme:
                for prop_name, prop_value in theme["properties"].items():
                    if hasattr(widget, prop_name):
                        try:
                            getattr(widget, prop_name)(prop_value)
                        except Exception as e:
                            self.logger.warning(f"Failed to set property {prop_name}: {e}")
            
            self.logger.info(f"Applied theme '{theme_name}' to {widget.__class__.__name__}")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to apply theme: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_theme_property(self, theme_name: str, property_name: str) -> Any:
        """Get a theme property value.
        
        Args:
            theme_name: Name of the theme
            property_name: Name of the property
            
        Returns:
            Property value or None if not found
        """
        if theme_name in self._themes:
            return self._themes[theme_name].get(property_name)
        return None
    
    def register_theme(self, theme_name: str, theme_config: dict[str, Any]) -> Result[None]:
        """Register a new theme.
        
        Args:
            theme_name: Name of the theme
            theme_config: Theme configuration
            
        Returns:
            Result indicating success or failure
        """
        try:
            self._themes[theme_name] = theme_config
            self.logger.info(f"Registered theme '{theme_name}'")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to register theme: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_available_themes(self) -> list[str]:
        """Get list of available themes.
        
        Returns:
            List of theme names
        """
        return list(self._themes.keys())
    
    def _load_default_themes(self) -> None:
        """Load default themes."""
        # Default light theme
        self._themes["default"] = {
            "stylesheet": "",
            "font": {
                "family": "Segoe UI",
                "size": 9,
                "bold": False,
                "italic": False,
            },
            "properties": {},
        }
        
        # Dark theme
        self._themes["dark"] = {
            "stylesheet": """
                QWidget {
                    background-color: #2b2b2b;
                    color: #ffffff;
                }
                QPushButton {
                    background-color: #404040;
                    border: 1px solid #555555;
                    padding: 5px;
                    border-radius: 3px;
                }
                QPushButton:hover {
                    background-color: #505050;
                }
                QPushButton:pressed {
                    background-color: #353535;
                }
                QLineEdit, QTextEdit {
                    background-color: #404040;
                    border: 1px solid #555555;
                    padding: 2px;
                    border-radius: 3px;
                }
            """,
            "font": {
                "family": "Segoe UI",
                "size": 9,
                "bold": False,
                "italic": False,
            },
        }


class UIAnimationManager:
    """Manager for UI animations and transitions."""
    
    def __init__(self):
        """Initialize animation manager."""
        self._animations: dict[str, QPropertyAnimation] = {}
        self.logger = logging.getLogger(__name__)
    
    def create_fade_animation(self, widget: QWidget, duration: int = 300, fade_in: bool = True) -> Result[str]:
        """Create a fade animation for a widget.
        
        Args:
            widget: Target widget
            duration: Animation duration in milliseconds
            fade_in: True for fade in, False for fade out
            
        Returns:
            Result containing animation ID
        """
        try:
            animation_id = f"fade_{id(widget)}_{datetime.now().timestamp()}"
            
            # Create opacity effect if not present
            if not hasattr(widget, "graphicsEffect") or widget.graphicsEffect() is None:
                from PyQt6.QtWidgets import QGraphicsOpacityEffect
                effect = QGraphicsOpacityEffect()
                widget.setGraphicsEffect(effect)
            
            effect = widget.graphicsEffect()
            animation = QPropertyAnimation(effect, b"opacity")
            animation.setDuration(duration)
            
            if fade_in:
                animation.setStartValue(0.0)
                animation.setEndValue(1.0)
            else:
                animation.setStartValue(1.0)
                animation.setEndValue(0.0)
            
            animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
            
            self._animations[animation_id] = animation
            
            self.logger.info(f"Created fade animation {animation_id}")
            return Result.success(animation_id)
            
        except Exception as e:
            error_msg = f"Failed to create fade animation: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def create_slide_animation(self, widget: QWidget, direction: str, distance: int, duration: int = 300) -> Result[str]:
        """Create a slide animation for a widget.
        
        Args:
            widget: Target widget
            direction: Direction ('left', 'right', 'up', 'down')
            distance: Distance to slide in pixels
            duration: Animation duration in milliseconds
            
        Returns:
            Result containing animation ID
        """
        try:
            animation_id = f"slide_{id(widget)}_{datetime.now().timestamp()}"
            
            animation = QPropertyAnimation(widget, b"geometry")
            animation.setDuration(duration)
            
            start_geometry = widget.geometry()
            end_geometry = start_geometry
            
            if direction == "left":
                end_geometry.moveLeft(start_geometry.left() - distance)
            elif direction == "right":
                end_geometry.moveLeft(start_geometry.left() + distance)
            elif direction == "up":
                end_geometry.moveTop(start_geometry.top() - distance)
            elif direction == "down":
                end_geometry.moveTop(start_geometry.top() + distance)
            else:
                return Result.failure(f"Invalid direction: {direction}")
            
            animation.setStartValue(start_geometry)
            animation.setEndValue(end_geometry)
            animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
            
            self._animations[animation_id] = animation
            
            self.logger.info(f"Created slide animation {animation_id}")
            return Result.success(animation_id)
            
        except Exception as e:
            error_msg = f"Failed to create slide animation: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def start_animation(self, animation_id: str) -> Result[None]:
        """Start an animation.
        
        Args:
            animation_id: ID of animation to start
            
        Returns:
            Result indicating success or failure
        """
        try:
            if animation_id not in self._animations:
                return Result.failure(f"Animation '{animation_id}' not found")
            
            animation = self._animations[animation_id]
            animation.start()
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to start animation: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def stop_animation(self, animation_id: str) -> Result[None]:
        """Stop an animation.
        
        Args:
            animation_id: ID of animation to stop
            
        Returns:
            Result indicating success or failure
        """
        try:
            if animation_id not in self._animations:
                return Result.failure(f"Animation '{animation_id}' not found")
            
            animation = self._animations[animation_id]
            animation.stop()
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to stop animation: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def cleanup_animation(self, animation_id: str) -> Result[None]:
        """Cleanup an animation.
        
        Args:
            animation_id: ID of animation to cleanup
            
        Returns:
            Result indicating success or failure
        """
        try:
            if animation_id in self._animations:
                animation = self._animations[animation_id]
                animation.stop()
                del self._animations[animation_id]
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to cleanup animation: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def cleanup_all_animations(self) -> Result[None]:
        """Cleanup all animations.
        
        Returns:
            Result indicating success or failure
        """
        try:
            for animation in self._animations.values():
                animation.stop()
            
            self._animations.clear()
            
            self.logger.info("All animations cleaned up")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to cleanup animations: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


class UIPatternRegistry:
    """Registry for UI patterns."""
    
    def __init__(self):
        """Initialize pattern registry."""
        self._patterns: dict[str, IUIPattern] = {}
        self._applied_patterns: dict[str, list[str]] = {}  # object_id -> pattern_names
        
        # Register default patterns
        self._register_default_patterns()
        
        self.logger = logging.getLogger(__name__)
    
    def register_pattern(self, name: str, pattern: IUIPattern) -> Result[None]:
        """Register a UI pattern.
        
        Args:
            name: Pattern name
            pattern: Pattern implementation
            
        Returns:
            Result indicating success or failure
        """
        try:
            self._patterns[name] = pattern
            self.logger.info(f"Registered pattern '{name}'")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to register pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def apply_pattern(self, pattern_name: str, target: Any) -> Result[None]:
        """Apply a pattern to a target.
        
        Args:
            pattern_name: Name of pattern to apply
            target: Target object
            
        Returns:
            Result indicating success or failure
        """
        try:
            if pattern_name not in self._patterns:
                return Result.failure(f"Pattern '{pattern_name}' not found")
            
            pattern = self._patterns[pattern_name]
            result = pattern.apply_pattern(target)
            
            if result.is_success:
                # Track applied pattern
                target_id = str(id(target))
                if target_id not in self._applied_patterns:
                    self._applied_patterns[target_id] = []
                if pattern_name not in self._applied_patterns[target_id]:
                    self._applied_patterns[target_id].append(pattern_name)
            
            return result
            
        except Exception as e:
            error_msg = f"Failed to apply pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def validate_pattern(self, pattern_name: str, target: Any) -> Result[None]:
        """Validate a pattern implementation.
        
        Args:
            pattern_name: Name of pattern to validate
            target: Target object
            
        Returns:
            Result indicating validation success or failure
        """
        try:
            if pattern_name not in self._patterns:
                return Result.failure(f"Pattern '{pattern_name}' not found")
            
            pattern = self._patterns[pattern_name]
            return pattern.validate_pattern(target)
            
        except Exception as e:
            error_msg = f"Failed to validate pattern: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_applied_patterns(self, target: Any) -> list[str]:
        """Get patterns applied to a target.
        
        Args:
            target: Target object
            
        Returns:
            List of applied pattern names
        """
        target_id = str(id(target))
        return self._applied_patterns.get(target_id, []).copy()
    
    def get_available_patterns(self) -> list[str]:
        """Get list of available patterns.
        
        Returns:
            List of pattern names
        """
        return list(self._patterns.keys())
    
    def _register_default_patterns(self) -> None:
        """Register default patterns."""
        try:
            self._patterns["mvvm"] = MVVMPattern(object)  # Placeholder ViewModel class
            self._patterns["observer"] = ObserverPattern()
            self._patterns["command"] = CommandPattern()
            
            self.logger.info("Default patterns registered")
            
        except Exception as e:
            self.logger.exception(f"Failed to register default patterns: {e}")


class UIComponentFactory:
    """Factory for creating UI components with patterns."""
    
    def __init__(self, pattern_registry: UIPatternRegistry, theme_manager: UIThemeManager):
        """Initialize component factory.
        
        Args:
            pattern_registry: Pattern registry
            theme_manager: Theme manager
        """
        self._pattern_registry = pattern_registry
        self._theme_manager = theme_manager
        self.logger = logging.getLogger(__name__)
    
    def create_widget_component(self, widget_class: type, component_id: str | None = None, 
                              patterns: list[str] | None = None, theme: str | None = None, 
                              **widget_kwargs) -> Result[UIWidgetComponent]:
        """Create a widget component with patterns and theme.
        
        Args:
            widget_class: Widget class to instantiate
            component_id: Optional component ID
            patterns: Optional list of patterns to apply
            theme: Optional theme to apply
            **widget_kwargs: Widget constructor arguments
            
        Returns:
            Result containing the created component
        """
        try:
            # Create widget
            widget = widget_class(**widget_kwargs)
            
            # Generate component ID if not provided
            if component_id is None:
                component_id = f"{widget_class.__name__}_{id(widget)}"
            
            # Create component
            component = UIWidgetComponent(component_id, widget)
            
            # Apply patterns
            if patterns:
                for pattern_name in patterns:
                    pattern_result = self._pattern_registry.apply_pattern(pattern_name, widget)
                    if not pattern_result.is_success:
                        self.logger.warning(f"Failed to apply pattern '{pattern_name}': {pattern_result.get_error()}")
            
            # Apply theme
            if theme:
                theme_result = self._theme_manager.apply_theme(widget, theme)
                if not theme_result.is_success:
                    self.logger.warning(f"Failed to apply theme '{theme}': {theme_result.get_error()}")
            
            self.logger.info(f"Created widget component '{component_id}'")
            return Result.success(component)
            
        except Exception as e:
            error_msg = f"Failed to create widget component: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def create_dialog_component(self, dialog_class: type, component_id: str | None = None,
                              patterns: list[str] | None = None, theme: str | None = None,
                              **dialog_kwargs) -> Result[UIDialogComponent]:
        """Create a dialog component with patterns and theme.
        
        Args:
            dialog_class: Dialog class to instantiate
            component_id: Optional component ID
            patterns: Optional list of patterns to apply
            theme: Optional theme to apply
            **dialog_kwargs: Dialog constructor arguments
            
        Returns:
            Result containing the created component
        """
        try:
            # Create dialog
            dialog = dialog_class(**dialog_kwargs)
            
            # Generate component ID if not provided
            if component_id is None:
                component_id = f"{dialog_class.__name__}_{id(dialog)}"
            
            # Create component
            component = UIDialogComponent(component_id, dialog)
            
            # Apply patterns
            if patterns:
                for pattern_name in patterns:
                    pattern_result = self._pattern_registry.apply_pattern(pattern_name, dialog)
                    if not pattern_result.is_success:
                        self.logger.warning(f"Failed to apply pattern '{pattern_name}': {pattern_result.get_error()}")
            
            # Apply theme
            if theme:
                theme_result = self._theme_manager.apply_theme(dialog, theme)
                if not theme_result.is_success:
                    self.logger.warning(f"Failed to apply theme '{theme}': {theme_result.get_error()}")
            
            self.logger.info(f"Created dialog component '{component_id}'")
            return Result.success(component)
            
        except Exception as e:
            error_msg = f"Failed to create dialog component: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


# Convenience functions for common UI patterns
def create_mvvm_widget(widget_class: type, view_model_class: type, model_class: type | None = None, **kwargs) -> Result[UIWidgetComponent]:
    """Create a widget with MVVM pattern applied.
    
    Args:
        widget_class: Widget class
        view_model_class: ViewModel class
        model_class: Optional Model class
        **kwargs: Widget constructor arguments
        
    Returns:
        Result containing the created component
    """
    pattern_registry = UIPatternRegistry()
    theme_manager = UIThemeManager()
    factory = UIComponentFactory(pattern_registry, theme_manager)
    
    # Register MVVM pattern with specific classes
    mvvm_pattern = MVVMPattern(view_model_class, model_class)
    pattern_registry.register_pattern("custom_mvvm", mvvm_pattern)
    
    return factory.create_widget_component(
        widget_class,
        patterns=["custom_mvvm"],
        **kwargs,
    )


def create_themed_widget(widget_class: type, theme_name: str = "default", **kwargs) -> Result[UIWidgetComponent]:
    """Create a widget with a specific theme applied.
    
    Args:
        widget_class: Widget class
        theme_name: Theme name
        **kwargs: Widget constructor arguments
        
    Returns:
        Result containing the created component
    """
    pattern_registry = UIPatternRegistry()
    theme_manager = UIThemeManager()
    factory = UIComponentFactory(pattern_registry, theme_manager)
    
    return factory.create_widget_component(
        widget_class,
        theme=theme_name,
        **kwargs,
    )


def create_observable_widget(widget_class: type, **kwargs) -> Result[UIWidgetComponent]:
    """Create a widget with Observer pattern applied.
    
    Args:
        widget_class: Widget class
        **kwargs: Widget constructor arguments
        
    Returns:
        Result containing the created component
    """
    pattern_registry = UIPatternRegistry()
    theme_manager = UIThemeManager()
    factory = UIComponentFactory(pattern_registry, theme_manager)
    
    return factory.create_widget_component(
        widget_class,
        patterns=["observer"],
        **kwargs,
    )