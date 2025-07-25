"""
Advanced Design Patterns for UI Components

This module implements sophisticated design patterns specifically tailored
for UI components, following enterprise-level architectural practices.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic

from PyQt6.QtWidgets import QWidget

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
    """
    Concrete factory for creating standard UI widgets.
    Implements the Abstract Factory pattern.
    """
    
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
            from PyQt6.QtWidgets import QPushButton
            
            button = QPushButton()
            self._apply_base_configuration(button, config)
            
            # Apply button-specific properties
            if "text" in config.properties:
                button.setText(config.properties["text"])
            if "icon" in config.properties:
                from PyQt6.QtGui import QIcon
                button.setIcon(QIcon(config.properties["icon"]))
            
            return Result.success(button)
        except Exception as e:
            return Result.failure(f"Failed to create button: {e!s}")
    
    def _create_label(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal label creation logic."""
        try:
            from PyQt6.QtWidgets import QLabel
            
            label = QLabel()
            self._apply_base_configuration(label, config)
            
            # Apply label-specific properties
            if "text" in config.properties:
                label.setText(config.properties["text"])
            if "pixmap" in config.properties:
                from PyQt6.QtGui import QPixmap
                label.setPixmap(QPixmap(config.properties["pixmap"]))
            
            return Result.success(label)
        except Exception as e:
            return Result.failure(f"Failed to create label: {e!s}")
    
    def _create_input(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal input creation logic."""
        try:
            from PyQt6.QtWidgets import QLineEdit
            
            input_widget = QLineEdit()
            self._apply_base_configuration(input_widget, config)
            
            # Apply input-specific properties
            if "placeholder" in config.properties:
                input_widget.setPlaceholderText(config.properties["placeholder"])
            if "max_length" in config.properties:
                input_widget.setMaxLength(config.properties["max_length"])
            
            return Result.success(input_widget)
        except Exception as e:
            return Result.failure(f"Failed to create input: {e!s}")
    
    def _create_dialog(self, config: WidgetConfiguration) -> Result[QWidget]:
        """Internal dialog creation logic."""
        try:
            from PyQt6.QtWidgets import QDialog
            
            dialog = QDialog()
            self._apply_base_configuration(dialog, config)
            
            # Apply dialog-specific properties
            if "modal" in config.properties:
                dialog.setModal(config.properties["modal"])
            if "title" in config.properties:
                dialog.setWindowTitle(config.properties["title"])
            
            return Result.success(dialog)
        except Exception as e:
            return Result.failure(f"Failed to create dialog: {e!s}")
    
    def _apply_base_configuration(self, widget: QWidget, config: WidgetConfiguration) -> None:
        """Apply base configuration to any widget."""
        if config.position:
            widget.move(config.position.x, config.position.y)
        
        if config.size:
            widget.resize(config.size.width, config.size.height)
        
        if config.style_class:
            widget.setProperty("class", config.style_class)
        
        # Apply general properties
        for key, value in config.properties.items():
            if hasattr(widget, f"set{key.capitalize()}"):
                getattr(widget, f"set{key.capitalize()}")(value)

# ============================================================================
# BUILDER PATTERN
# ============================================================================

class UIComponentBuilder(Generic[T]):
    """
    Builder pattern for creating complex UI components.
    Provides fluent interface for step-by-step construction.
    """
    
    def __init__(self, component_type: type[T]):
        self._component_type = component_type
        self._configuration = WidgetConfiguration(WidgetType.CONTAINER)
        self._children: list[QWidget] = []
        self._event_handlers: dict[str, Callable] = {}
        self._validators: list[Callable] = []
    
    def with_position(self, x: int, y: int) -> UIComponentBuilder[T]:
        """Set component position."""
        self._configuration.position = UIPosition(x, y)
        return self
    
    def with_size(self, width: int, height: int) -> UIComponentBuilder[T]:
        """Set component size."""
        self._configuration.size = UISize(width, height)
        return self
    
    def with_bounds(self, bounds: UIBounds) -> UIComponentBuilder[T]:
        """Set component bounds."""
        self._configuration.position = bounds.position
        self._configuration.size = bounds.size
        return self
    
    def with_style(self, style_class: str) -> UIComponentBuilder[T]:
        """Set component style class."""
        self._configuration.style_class = style_class
        return self
    
    def with_property(self, key: str, value: Any) -> UIComponentBuilder[T]:
        """Add a property to the component."""
        self._configuration.properties[key] = value
        return self
    
    def with_properties(self, **properties) -> UIComponentBuilder[T]:
        """Add multiple properties to the component."""
        self._configuration.properties.update(properties)
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
        """Build the component with all configured options."""
        try:
            # Create the base component
            component = self._component_type()
            
            # Apply configuration if component is a QWidget
            if isinstance(component, QWidget):
                self._apply_widget_configuration(component)
            
            # Apply custom configuration if component has configure method
            if hasattr(component, "configure"):
                component.configure(self._configuration)
            
            # Add children
            for child in self._children:
                if hasattr(component, "add_child"):
                    component.add_child(child)
                elif isinstance(component, QWidget) and hasattr(child, "setParent"):
                    child.setParent(component)
            
            # Setup event handlers
            for event_name, handler in self._event_handlers.items():
                if hasattr(component, event_name):
                    signal = getattr(component, event_name)
                    if hasattr(signal, "connect"):
                        signal.connect(handler)
            
            # Add validators
            if hasattr(component, "add_validator"):
                for validator in self._validators:
                    component.add_validator(validator)
            
            return Result.success(component)
            
        except Exception as e:
            return Result.failure(f"Failed to build component: {e!s}")
    
    def _apply_widget_configuration(self, widget: QWidget) -> None:
        """Apply widget-specific configuration."""
        if self._configuration.position:
            widget.move(self._configuration.position.x, self._configuration.position.y)
        
        if self._configuration.size:
            widget.resize(self._configuration.size.width, self._configuration.size.height)
        
        if self._configuration.style_class:
            widget.setProperty("class", self._configuration.style_class)
        
        # Apply properties
        for key, value in self._configuration.properties.items():
            if hasattr(widget, f"set{key.capitalize()}"):
                getattr(widget, f"set{key.capitalize()}")(value)

# ============================================================================
# STRATEGY PATTERN
# ============================================================================

class AnimationStrategy(IStrategy[QWidget, None]):
    """Base class for widget animation strategies."""
    
    @abstractmethod
    def execute(self, context: QWidget) -> Result[None]:
        """Execute the animation strategy."""

class FadeInStrategy(AnimationStrategy):
    """Strategy for fade-in animations."""
    
    def __init__(self, duration: int = 500):
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute fade-in animation."""
        try:
            from PyQt6.QtCore import QPropertyAnimation
            from PyQt6.QtWidgets import QGraphicsOpacityEffect
            
            effect = QGraphicsOpacityEffect()
            context.setGraphicsEffect(effect)
            
            self.animation = QPropertyAnimation(effect, b"opacity")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(0.0)
            self.animation.setEndValue(1.0)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Fade-in animation failed: {e!s}")

class SlideInStrategy(AnimationStrategy):
    """Strategy for slide-in animations."""
    
    def __init__(self, direction: str = "left", duration: int = 500):
        self.direction = direction
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute slide-in animation."""
        try:
            from PyQt6.QtCore import QPropertyAnimation, QRect
            
            # Get current geometry
            current_rect = context.geometry()
            
            # Calculate start position based on direction
            start_rect = QRect(current_rect)
            if self.direction == "left":
                start_rect.moveLeft(current_rect.left() - current_rect.width())
            elif self.direction == "right":
                start_rect.moveLeft(current_rect.left() + current_rect.width())
            elif self.direction == "top":
                start_rect.moveTop(current_rect.top() - current_rect.height())
            elif self.direction == "bottom":
                start_rect.moveTop(current_rect.top() + current_rect.height())
            
            # Set start position and animate to end position
            context.setGeometry(start_rect)
            
            self.animation = QPropertyAnimation(context, b"geometry")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(start_rect)
            self.animation.setEndValue(current_rect)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Slide-in animation failed: {e!s}")

class AnimationContext:
    """Context for animation strategies."""
    
    def __init__(self, widget: QWidget):
        self.widget = widget
        self._strategy: AnimationStrategy | None = None
    
    def set_strategy(self, strategy: AnimationStrategy) -> None:
        """Set the animation strategy."""
        self._strategy = strategy
    
    def animate(self) -> Result[None]:
        """Execute the current animation strategy."""
        if not self._strategy:
            return Result.failure("No animation strategy set")
        
        return self._strategy.execute(self.widget)

# ============================================================================
# DECORATOR PATTERN
# ============================================================================

class UIComponentDecorator(IUIComponent):
    """
    Base decorator for UI components.
    Implements the Decorator pattern for adding behavior to components.
    """
    
    def __init__(self, component: IUIComponent):
        self._component = component
    
    @property
    def widget(self) -> QWidget:
        """Get the underlying Qt widget."""
        return self._component.widget
    
    def initialize(self) -> Result[None]:
        """Initialize the component."""
        return self._component.initialize()
    
    def cleanup(self) -> None:
        """Cleanup resources."""
        self._component.cleanup()

class TooltipDecorator(UIComponentDecorator):
    """Decorator that adds tooltip functionality."""
    
    def __init__(self, component: IUIComponent, tooltip_text: str):
        super().__init__(component)
        self.tooltip_text = tooltip_text
    
    def initialize(self) -> Result[None]:
        """Initialize with tooltip."""
        result = super().initialize()
        if result.is_success:
            self.widget.setToolTip(self.tooltip_text)
        return result

class ValidationDecorator(UIComponentDecorator):
    """Decorator that adds validation functionality."""
    
    def __init__(self, component: IUIComponent, validator: Callable[[Any], bool]):
        super().__init__(component)
        self.validator = validator
        self._is_valid = True
    
    def validate(self, value: Any) -> bool:
        """Validate a value."""
        self._is_valid = self.validator(value)
        self._update_visual_state()
        return self._is_valid
    
    def _update_visual_state(self) -> None:
        """Update visual state based on validation."""
        if hasattr(self.widget, "setStyleSheet"):
            if self._is_valid:
                self.widget.setStyleSheet("")
            else:
                self.widget.setStyleSheet("border: 2px solid red;")

class LoggingDecorator(UIComponentDecorator):
    """Decorator that adds logging functionality."""
    
    def __init__(self, component: IUIComponent, logger=None):
        super().__init__(component)
        self.logger = logger or self._default_logger
    
    def initialize(self) -> Result[None]:
        """Initialize with logging."""
        self.logger(f"Initializing component: {type(self._component).__name__}")
        result = super().initialize()
        if result.is_success:
            self.logger(f"Component initialized successfully: {type(self._component).__name__}")
        else:
            self.logger(f"Component initialization failed: {result.error}")
        return result
    
    def cleanup(self) -> None:
        """Cleanup with logging."""
        self.logger(f"Cleaning up component: {type(self._component).__name__}")
        super().cleanup()
        self.logger(f"Component cleaned up: {type(self._component).__name__}")
    
    @staticmethod
    def _default_logger(message: str) -> None:
        """Default logger implementation."""
        print(f"[UI] {message}")

# ============================================================================
# COMMAND PATTERN FOR UI ACTIONS
# ============================================================================

class UICommand(ABC):
    """Base class for UI commands."""
    
    def __init__(self, component: IUIComponent):
        self.component = component
        self._executed = False
        self._can_undo = True
    
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
        return self._executed and self._can_undo

class ShowComponentCommand(UICommand):
    """Command to show a UI component."""
    
    def execute(self) -> Result[Any]:
        """Show the component."""
        try:
            if not self.can_execute():
                return Result.failure("Command already executed")
            
            self.component.widget.show()
            self._executed = True
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to show component: {e!s}")
    
    def undo(self) -> Result[Any]:
        """Hide the component."""
        try:
            if not self.can_undo():
                return Result.failure("Command cannot be undone")
            
            self.component.widget.hide()
            self._executed = False
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to hide component: {e!s}")

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
        if self._current_index < 0:
            return Result.failure("No commands to undo")
        
        command = self._command_history[self._current_index]
        result = command.undo()
        if result.is_success:
            self._current_index -= 1
        return result
    
    def redo(self) -> Result[Any]:
        """Redo the next command."""
        if self._current_index >= len(self._command_history) - 1:
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
    # Strategy Pattern
    "AnimationStrategy",
    "FadeInStrategy",
    "IWidgetFactory",
    "LoggingDecorator",
    "ShowComponentCommand",
    "SlideInStrategy",
    "TooltipDecorator",
    # Command Pattern
    "UICommand",
    "UICommandInvoker",
    # Builder Pattern
    "UIComponentBuilder",
    # Decorator Pattern
    "UIComponentDecorator",
    "UIWidgetFactory",
    "ValidationDecorator",
    "WidgetConfiguration",
    # Factory Pattern
    "WidgetType",
] 