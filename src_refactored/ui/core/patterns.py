"""Advanced Design Patterns for UI Components

This module implements sophisticated design patterns specifically tailored
for UI components, following enterprise-level architectural practices.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic

from PyQt6.QtWidgets import QWidget, QPushButton, QLabel, QLineEdit, QDialog
from PyQt6.QtCore import QPropertyAnimation, QEasingCurve, QRect
from PyQt6.QtGui import QFont

from .abstractions import (
    IStrategy,
    IUIComponent,
    IUIFactory,
    Result,
    T,
    UIBounds,
    UIPosition,
    UISize,
)

if TYPE_CHECKING:
    from collections.abc import Callable

# ============================================================================
# FACTORY PATTERNS
# ============================================================================

class WidgetType(Enum):
    """Enumeration of widget types for factory creation."""
    BUTTON = "button"
    LABEL = "label"
    INPUT = "input"
    DIALOG = "dialog"
    PROGRESS_BAR = "progress_bar"
    VISUALIZER = "visualizer"
    CONTAINER = "container"

@dataclass
class WidgetConfiguration:
    """Configuration for widget creation."""
    widget_type: WidgetType
    position: UIPosition | None = None
    size: UISize | None = None
    style_class: str | None = None
    properties: dict[str, Any] = None
    parent_id: str | None = None
    
    def __post_init__(self):
        if self.properties is None:
            self.properties = {}

class IWidgetFactory(IUIFactory[QWidget]):
    """Abstract factory for creating UI widgets."""
    
    @abstractmethod
    def create_button(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a button widget."""
    
    @abstractmethod
    def create_label(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a label widget."""
    
    @abstractmethod
    def create_input(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create an input widget."""
    
    @abstractmethod
    def create_dialog(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a dialog widget."""

class UIWidgetFactory(IWidgetFactory):
    """Concrete factory for creating standard UI widgets."""
    
    def __init__(self):
        self._widget_creators: dict[WidgetType, Callable[[WidgetConfiguration], Result[QWidget]]] = {
            WidgetType.BUTTON: self._create_button,
            WidgetType.LABEL: self._create_label,
            WidgetType.INPUT: self._create_input,
            WidgetType.DIALOG: self._create_dialog,
        }
    
    def create(self, **kwargs) -> Result[QWidget]:
        """Create a widget based on configuration."""
        config = kwargs.get("config")
        if not isinstance(config, WidgetConfiguration):
            return Result.failure("Invalid configuration provided")
        
        creator = self._widget_creators.get(config.widget_type)
        if not creator:
            return Result.failure(f"No creator found for widget type: {config.widget_type}")
        
        return creator(config)
    
    def create_button(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a button widget."""
        return self._create_button(config)
    
    def create_label(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a label widget."""
        return self._create_label(config)
    
    def create_input(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create an input widget."""
        return self._create_input(config)
    
    def create_dialog(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Create a dialog widget."""
        return self._create_dialog(config)
    
    def _create_button(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal button creation logic."""
        try:
            button = QPushButton()
            text = config.properties.get("text", "Button")
            button.setText(text)
            
            if config.properties.get("enabled") is not None:
                button.setEnabled(config.properties["enabled"])
            
            self._apply_base_configuration(button, config)
            return Result.success(button)
        except Exception as e:
            return Result.failure(f"Failed to create button: {str(e)}")
    
    def _create_label(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal label creation logic."""
        try:
            label = QLabel()
            text = config.properties.get("text", "Label")
            label.setText(text)
            
            if config.properties.get("word_wrap") is not None:
                label.setWordWrap(config.properties["word_wrap"])
            
            if config.properties.get("alignment") is not None:
                label.setAlignment(config.properties["alignment"])
            
            self._apply_base_configuration(label, config)
            return Result.success(label)
        except Exception as e:
            return Result.failure(f"Failed to create label: {str(e)}")
    
    def _create_input(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal input creation logic."""
        try:
            input_widget = QLineEdit()
            
            if config.properties.get("placeholder") is not None:
                input_widget.setPlaceholderText(config.properties["placeholder"])
            
            if config.properties.get("max_length") is not None:
                input_widget.setMaxLength(config.properties["max_length"])
            
            if config.properties.get("read_only") is not None:
                input_widget.setReadOnly(config.properties["read_only"])
            
            self._apply_base_configuration(input_widget, config)
            return Result.success(input_widget)
        except Exception as e:
            return Result.failure(f"Failed to create input: {str(e)}")
    
    def _create_dialog(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal dialog creation logic."""
        try:
            dialog = QDialog()
            
            title = config.properties.get("title", "Dialog")
            dialog.setWindowTitle(title)
            
            if config.properties.get("modal") is not None:
                dialog.setModal(config.properties["modal"])
            
            self._apply_base_configuration(dialog, config)
            return Result.success(dialog)
        except Exception as e:
            return Result.failure(f"Failed to create dialog: {str(e)}")
    
    def _apply_base_configuration(self, widget: QWidget, config: WidgetConfiguration) -> None:
        """Apply base configuration to any widget."""
        if config.position:
            widget.move(config.position.x, config.position.y)
        
        if config.size:
            widget.resize(config.size.width, config.size.height)
        
        if config.style_class:
            widget.setProperty("class", config.style_class)
        
        # Apply font if specified
        if "font_family" in config.properties or "font_size" in config.properties:
            font = QFont()
            if "font_family" in config.properties:
                font.setFamily(config.properties["font_family"])
            if "font_size" in config.properties:
                font.setPointSize(config.properties["font_size"])
            widget.setFont(font)

# ============================================================================
# BUILDER PATTERN
# ============================================================================

class UIComponentBuilder(Generic[T]):
    """Builder for creating complex UI components with fluent interface."""
    
    def __init__(self, component_type: type[T]):
        self._component_type = component_type
        self._position: UIPosition | None = None
        self._size: UISize | None = None
        self._style_class: str | None = None
        self._properties: dict[str, Any] = {}
        self._children: list[QWidget] = []
        self._event_handlers: dict[str, Callable] = {}
        self._validators: list[Callable] = []
    
    def with_position(self, x: int, y: int) -> UIComponentBuilder[T]:
        """Set component position."""
        self._position = UIPosition(x, y)
        return self
    
    def with_size(self, width: int, height: int) -> UIComponentBuilder[T]:
        """Set component size."""
        self._size = UISize(width, height)
        return self
    
    def with_bounds(self, bounds: UIBounds) -> UIComponentBuilder[T]:
        """Set component bounds."""
        self._position = bounds.position
        self._size = bounds.size
        return self
    
    def with_style(self, style_class: str) -> UIComponentBuilder[T]:
        """Set component style class."""
        self._style_class = style_class
        return self
    
    def with_property(self, key: str, value: Any) -> UIComponentBuilder[T]:
        """Add a property to the component."""
        self._properties[key] = value
        return self
    
    def with_properties(self, **properties) -> UIComponentBuilder[T]:
        """Add multiple properties to the component."""
        self._properties.update(properties)
        return self
    
    def add_child(self, child: QWidget) -> UIComponentBuilder[T]:
        """Add a child widget."""
        self._children.append(child)
        return self
    
    def add_event_handler(self, event_name: str, handler: Callable) -> UIComponentBuilder[T]:
        """Add an event handler."""
        self._event_handlers[event_name] = handler
        return self
    
    def add_validator(self, validator: Callable) -> UIComponentBuilder[T]:
        """Add a validator function."""
        self._validators.append(validator)
        return self
    
    def build(self) -> Result[T]:
        """Build the component with all configured properties."""
        try:
            # Create the component instance
            if hasattr(self._component_type, '__init__'):
                component = self._component_type()
            else:
                return Result.failure(f"Cannot instantiate {self._component_type.__name__}")
            
            # Apply configuration if it's a QWidget
            if isinstance(component, QWidget):
                self._apply_widget_configuration(component)
            
            # Apply custom properties
            for key, value in self._properties.items():
                if hasattr(component, f"set_{key}"):
                    getattr(component, f"set_{key}")(value)
                else:
                    component.setProperty(key, value)
            
            # Add children
            for child in self._children:
                if hasattr(component, 'layout') and component.layout():
                    component.layout().addWidget(child)
                else:
                    child.setParent(component)
            
            # Connect event handlers
            for event_name, handler in self._event_handlers.items():
                if hasattr(component, event_name):
                    signal = getattr(component, event_name)
                    if hasattr(signal, 'connect'):
                        signal.connect(handler)
            
            return Result.success(component)
        
        except Exception as e:
            return Result.failure(f"Failed to build component: {str(e)}")
    
    def _apply_widget_configuration(self, widget: QWidget) -> None:
        """Apply widget-specific configuration."""
        if self._position:
            widget.move(self._position.x, self._position.y)
        
        if self._size:
            widget.resize(self._size.width, self._size.height)
        
        if self._style_class:
            widget.setProperty("class", self._style_class)
        
        # Apply font configuration
        if "font_family" in self._properties or "font_size" in self._properties:
            font = QFont()
            if "font_family" in self._properties:
                font.setFamily(self._properties["font_family"])
            if "font_size" in self._properties:
                font.setPointSize(self._properties["font_size"])
            widget.setFont(font)

# ============================================================================
# STRATEGY PATTERN FOR ANIMATIONS
# ============================================================================

class AnimationStrategy(IStrategy[QWidget, None]):
    """Abstract strategy for widget animations."""
    
    @abstractmethod
    def execute(self, context: QWidget) -> Result[None]:
        """Execute the animation strategy."""

class FadeInStrategy(AnimationStrategy):
    """Strategy for fade-in animation."""
    
    def __init__(self, duration: int = 500):
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute fade-in animation."""
        try:
            from PyQt6.QtCore import QPropertyAnimation
            from PyQt6.QtWidgets import QGraphicsOpacityEffect
            
            effect = QGraphicsOpacityEffect()
            context.setGraphicsEffect(effect)
            
            animation = QPropertyAnimation(effect, b"opacity")
            animation.setDuration(self.duration)
            animation.setStartValue(0.0)
            animation.setEndValue(1.0)
            animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Fade-in animation failed: {str(e)}")

class SlideInStrategy(AnimationStrategy):
    """Strategy for slide-in animation."""
    
    def __init__(self, direction: str = "left", duration: int = 500):
        self.direction = direction
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute slide-in animation."""
        try:
            original_geometry = context.geometry()
            
            # Calculate start position based on direction
            if self.direction == "left":
                start_x = -original_geometry.width()
                start_y = original_geometry.y()
            elif self.direction == "right":
                start_x = context.parent().width() if context.parent() else 800
                start_y = original_geometry.y()
            elif self.direction == "top":
                start_x = original_geometry.x()
                start_y = -original_geometry.height()
            else:  # bottom
                start_x = original_geometry.x()
                start_y = context.parent().height() if context.parent() else 600
            
            # Set initial position
            context.setGeometry(start_x, start_y, original_geometry.width(), original_geometry.height())
            
            # Create animation
            animation = QPropertyAnimation(context, b"geometry")
            animation.setDuration(self.duration)
            animation.setStartValue(QRect(start_x, start_y, original_geometry.width(), original_geometry.height()))
            animation.setEndValue(original_geometry)
            animation.setEasingCurve(QEasingCurve.Type.OutCubic)
            animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Slide-in animation failed: {str(e)}")

class AnimationContext:
    """Context for animation strategies."""
    
    def __init__(self, widget: QWidget):
        self._widget = widget
        self._strategy: AnimationStrategy | None = None
    
    def set_strategy(self, strategy: AnimationStrategy) -> None:
        """Set the animation strategy."""
        self._strategy = strategy
    
    def animate(self) -> Result[None]:
        """Execute the current animation strategy."""
        if not self._strategy:
            return Result.failure("No animation strategy set")
        
        return self._strategy.execute(self._widget)

# ============================================================================
# DECORATOR PATTERN
# ============================================================================

class UIComponentDecorator(IUIComponent):
    """Base decorator for UI components."""
    
    def __init__(self, component: IUIComponent):
        self._component = component
    
    @property
    def widget(self) -> QWidget:
        """Get the decorated widget."""
        return self._component.widget
    
    def initialize(self) -> Result[None]:
        """Initialize the decorated component."""
        return self._component.initialize()
    
    def cleanup(self) -> None:
        """Clean up the decorated component."""
        self._component.cleanup()

class TooltipDecorator(UIComponentDecorator):
    """Decorator that adds tooltip functionality."""
    
    def __init__(self, component: IUIComponent, tooltip_text: str):
        super().__init__(component)
        self._tooltip_text = tooltip_text
    
    def initialize(self) -> Result[None]:
        """Initialize with tooltip."""
        result = super().initialize()
        if result.is_success:
            self.widget.setToolTip(self._tooltip_text)
        return result

class ValidationDecorator(UIComponentDecorator):
    """Decorator that adds validation functionality."""
    
    def __init__(self, component: IUIComponent, validator: Callable[[Any], bool]):
        super().__init__(component)
        self._validator = validator
        self._is_valid = True
    
    def validate(self, value: Any) -> bool:
        """Validate the given value."""
        self._is_valid = self._validator(value)
        self._update_visual_state()
        return self._is_valid
    
    def _update_visual_state(self) -> None:
        """Update visual state based on validation."""
        if hasattr(self.widget, 'setStyleSheet'):
            if self._is_valid:
                self.widget.setStyleSheet("")
            else:
                self.widget.setStyleSheet("border: 2px solid red;")

class LoggingDecorator(UIComponentDecorator):
    """Decorator that adds logging functionality."""
    
    def __init__(self, component: IUIComponent, logger=None):
        super().__init__(component)
        self._logger = logger or self._default_logger
    
    def initialize(self) -> Result[None]:
        """Initialize with logging."""
        self._logger(f"Initializing component: {type(self._component).__name__}")
        result = super().initialize()
        if result.is_success:
            self._logger(f"Component initialized successfully: {type(self._component).__name__}")
        else:
            self._logger(f"Component initialization failed: {result.error}")
        return result
    
    def cleanup(self) -> None:
        """Cleanup with logging."""
        self._logger(f"Cleaning up component: {type(self._component).__name__}")
        super().cleanup()
        self._logger(f"Component cleaned up: {type(self._component).__name__}")
    
    @staticmethod
    def _default_logger(message: str) -> None:
        """Default logger implementation."""
        print(f"[UI] {message}")

# ============================================================================
# COMMAND PATTERN
# ============================================================================

class UICommand(ABC):
    """Abstract base class for UI commands."""
    
    def __init__(self, component: IUIComponent):
        self._component = component
        self._executed = False
    
    @property
    def component(self) -> IUIComponent:
        """Get the target component."""
        return self._component
    
    @abstractmethod
    def execute(self) -> Result[Any]:
        """Execute the command."""
    
    @abstractmethod
    def undo(self) -> Result[Any]:
        """Undo the command."""
    
    def can_execute(self) -> bool:
        """Check if command can be executed."""
        return not self._executed
    
    def can_undo(self) -> bool:
        """Check if command can be undone."""
        return self._executed

class ShowComponentCommand(UICommand):
    """Command to show a UI component."""
    
    def execute(self) -> Result[Any]:
        """Show the component."""
        try:
            if not self.can_execute():
                return Result.failure("Command already executed")
            
            self._component.widget.show()
            self._executed = True
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to show component: {str(e)}")
    
    def undo(self) -> Result[Any]:
        """Hide the component."""
        try:
            if not self.can_undo():
                return Result.failure("Command not executed yet")
            
            self._component.widget.hide()
            self._executed = False
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to hide component: {str(e)}")

class UICommandInvoker:
    """Invoker for UI commands with undo/redo support."""
    
    def __init__(self):
        self._command_history: list[UICommand] = []
        self._current_index = -1
    
    def execute_command(self, command: UICommand) -> Result[Any]:
        """Execute a command and add it to history."""
        result = command.execute()
        if result.is_success:
            # Remove any commands after current index (for redo functionality)
            self._command_history = self._command_history[:self._current_index + 1]
            self._command_history.append(command)
            self._current_index += 1
        return result
    
    def undo(self) -> Result[Any]:
        """Undo the last command."""
        if not self.can_undo():
            return Result.failure("No commands to undo")
        
        command = self._command_history[self._current_index]
        result = command.undo()
        if result.is_success:
            self._current_index -= 1
        return result
    
    def redo(self) -> Result[Any]:
        """Redo the next command."""
        if not self.can_redo():
            return Result.failure("No commands to redo")
        
        self._current_index += 1
        command = self._command_history[self._current_index]
        return command.execute()
    
    def can_undo(self) -> bool:
        """Check if undo is possible."""
        return self._current_index >= 0
    
    def can_redo(self) -> bool:
        """Check if redo is possible."""
        return self._current_index < len(self._command_history) - 1

__all__ = [
    "AnimationContext",
    "AnimationStrategy",
    "FadeInStrategy",
    "IWidgetFactory",
    "LoggingDecorator",
    "ShowComponentCommand",
    "SlideInStrategy",
    "TooltipDecorator",
    "UICommand",
    "UICommandInvoker",
    "UIComponentBuilder",
    "UIComponentDecorator",
    "UIWidgetFactory",
    "ValidationDecorator",
    "WidgetConfiguration",
    "WidgetType",
]