"""Advanced Design Patterns for UI Components (Refactored)

This module implements sophisticated design patterns specifically tailored
for UI components, following enterprise-level architectural practices and
hexagonal architecture principles by using framework-agnostic abstractions.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic

from .abstractions import (
    IUIComponent,
    IUIFactory,
    Result,
    T,
    UIBounds,
    UIPosition,
    UISize,
)
from .ui_abstractions import (
    FontDescriptor,
    IAnimationStrategy,
    IButton,
    IDialog,
    IFontFactory,
    ILabel,
    ITextInput,
    IUIWidgetFactory,
    IWidget,
    IWidgetStyler,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.application.interfaces.animation_service import (
        IAnimationCoordinationService,
    )

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
    properties: dict[str, Any] = field(default_factory=dict)
    parent_id: str | None = None
    
    def __post_init__(self):
        if self.properties is None:
            self.properties = {}

class IWidgetFactory(IUIFactory[IWidget]):
    """Abstract factory for creating UI widgets."""
    
    @abstractmethod
    def create_button(self, config: WidgetConfiguration) -> Result[IButton]:
        """Create a button widget."""
    
    @abstractmethod
    def create_label(self, config: WidgetConfiguration) -> Result[ILabel]:
        """Create a label widget."""
    
    @abstractmethod
    def create_input(self, config: WidgetConfiguration) -> Result[ITextInput]:
        """Create an input widget."""
    
    @abstractmethod
    def create_dialog(self, config: WidgetConfiguration) -> Result[IDialog]:
        """Create a dialog widget."""

class UIWidgetFactory(IWidgetFactory):
    """Concrete factory for creating standard UI widgets using framework-agnostic abstractions."""
    
    def __init__(self, widget_factory: IUIWidgetFactory, font_factory: IFontFactory, styler: IWidgetStyler):
        """Initialize with injected dependencies.
        
        Args:
            widget_factory: Framework-specific widget factory
            font_factory: Framework-specific font factory  
            styler: Framework-specific widget styler
        """
        self._widget_factory = widget_factory
        self._font_factory = font_factory
        self._styler = styler
        
        self._widget_creators: dict[WidgetType, Callable[[WidgetConfiguration], Result[IWidget]]] = {
            WidgetType.BUTTON: self._create_button,  # type: ignore[dict-item]
            WidgetType.LABEL: self._create_label,    # type: ignore[dict-item]
            WidgetType.INPUT: self._create_input,    # type: ignore[dict-item]
            WidgetType.DIALOG: self._create_dialog,  # type: ignore[dict-item]
        }
    
    def create(self, **kwargs) -> Result[IWidget]:
        """Create a widget based on configuration."""
        config = kwargs.get("config")
        if not isinstance(config, WidgetConfiguration):
            return Result.failure("Invalid configuration provided")
        
        creator = self._widget_creators.get(config.widget_type)
        if not creator:
            return Result.failure(f"No creator found for widget type: {config.widget_type}")
        
        return creator(config)
    
    def create_button(self, config: WidgetConfiguration) -> Result[IButton]:
        """Create a button widget."""
        return self._create_button(config)
    
    def create_label(self, config: WidgetConfiguration) -> Result[ILabel]:
        """Create a label widget."""
        return self._create_label(config)
    
    def create_input(self, config: WidgetConfiguration) -> Result[ITextInput]:
        """Create an input widget."""
        return self._create_input(config)
    
    def create_dialog(self, config: WidgetConfiguration) -> Result[IDialog]:
        """Create a dialog widget."""
        return self._create_dialog(config)
    
    def _create_button(self, config: WidgetConfiguration) -> Result[IButton]:
        """Internal button creation logic."""
        try:
            # Extract properties
            properties = {
                "text": config.properties.get("text", "Button"),
                "enabled": config.properties.get("enabled", True),
            }
            
            # Create button using framework factory
            result = self._widget_factory.create_button(**properties)
            if not result.is_success:
                return result
            
            button = result.value
            if button is None:
                return Result.failure("Button creation returned None")
            self._apply_base_configuration(button, config)
            return Result.success(button)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create button: {e!s}")
    
    def _create_label(self, config: WidgetConfiguration) -> Result[ILabel]:
        """Internal label creation logic."""
        try:
            # Extract properties
            properties = {
                "text": config.properties.get("text", "Label"),
                "word_wrap": config.properties.get("word_wrap", False),
                "alignment": config.properties.get("alignment", "left"),
            }
            
            # Create label using framework factory
            result = self._widget_factory.create_label(**properties)
            if not result.is_success:
                return result
            
            label = result.value
            if label is None:
                return Result.failure("Label creation returned None")
            self._apply_base_configuration(label, config)
            return Result.success(label)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create label: {e!s}")
    
    def _create_input(self, config: WidgetConfiguration) -> Result[ITextInput]:
        """Internal input creation logic."""
        try:
            # Extract properties
            properties = {
                "placeholder": config.properties.get("placeholder", ""),
                "max_length": config.properties.get("max_length", 32767),
                "read_only": config.properties.get("read_only", False),
            }
            
            # Create input using framework factory
            result = self._widget_factory.create_text_input(**properties)
            if not result.is_success:
                return result
            
            text_input = result.value
            if text_input is None:
                return Result.failure("Text input creation returned None")
            self._apply_base_configuration(text_input, config)
            return Result.success(text_input)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create input: {e!s}")
    
    def _create_dialog(self, config: WidgetConfiguration) -> Result[IDialog]:
        """Internal dialog creation logic."""
        try:
            # Extract properties
            properties = {
                "title": config.properties.get("title", "Dialog"),
                "modal": config.properties.get("modal", True),
            }
            
            # Create dialog using framework factory
            result = self._widget_factory.create_dialog(**properties)
            if not result.is_success:
                return result
            
            dialog = result.value
            if dialog is None:
                return Result.failure("Dialog creation returned None")
            self._apply_base_configuration(dialog, config)
            return Result.success(dialog)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to create dialog: {e!s}")
    
    def _apply_base_configuration(self, widget: IWidget, config: WidgetConfiguration) -> None:
        """Apply base configuration to any widget."""
        if config.position:
            widget.set_position(config.position.x, config.position.y)
        
        if config.size:
            widget.set_size(config.size.width, config.size.height)
        
        if config.style_class:
            self._styler.set_property(widget, "class", config.style_class)
        
        # Apply font if specified
        if "font_family" in config.properties or "font_size" in config.properties:
            font_descriptor = FontDescriptor(
                family=config.properties.get("font_family"),
                size=config.properties.get("font_size"),
            )
            font = self._font_factory.create_font(font_descriptor)
            self._styler.apply_font(widget, font)

# ============================================================================
# BUILDER PATTERN
# ============================================================================

class UIComponentBuilder(Generic[T]):
    """Builder for creating complex UI components with fluent interface."""
    
    def __init__(self, component_type: type[T], widget_factory: IUIWidgetFactory):
        """Initialize builder with component type and widget factory."""
        self._component_type = component_type
        self._widget_factory = widget_factory
        self._position: UIPosition | None = None
        self._size: UISize | None = None
        self._style_class: str | None = None
        self._properties: dict[str, Any] = {}
        self._children: list[IWidget] = []
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
    
    def add_child(self, child: IWidget) -> UIComponentBuilder[T]:
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
            if hasattr(self._component_type, "__init__"):
                component = self._component_type()
            else:
                return Result.failure(f"Cannot instantiate {self._component_type.__name__}")
            
            # Apply configuration if it's a widget component
            if hasattr(component, "widget") and hasattr(component.widget, "set_geometry"):
                self._apply_widget_configuration(component.widget)
            
            # Apply custom properties
            for key, value in self._properties.items():
                if hasattr(component, f"set_{key}"):
                    getattr(component, f"set_{key}")(value)
            
            return Result.success(component)
        
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to build component: {e!s}")
    
    def _apply_widget_configuration(self, widget: IWidget) -> None:
        """Apply widget-specific configuration."""
        if self._position:
            widget.set_position(self._position.x, self._position.y)
        
        if self._size:
            widget.set_size(self._size.width, self._size.height)

# ============================================================================
# STRATEGY PATTERN FOR ANIMATIONS
# ============================================================================

class AnimationStrategy(IAnimationStrategy):
    """Abstract strategy for widget animations using framework-agnostic abstractions."""
    
    def __init__(self, animation_coordination_service: IAnimationCoordinationService):
        """Initialize with animation coordination service dependency."""
        self._animation_coordination = animation_coordination_service

class FadeInStrategy(AnimationStrategy):
    """Strategy for fade-in animation."""
    
    def __init__(
        self, 
        animation_coordination_service: IAnimationCoordinationService, 
        duration: int = 500,
    ):
        """Initialize fade-in strategy.
        
        Args:
            animation_coordination_service: Service for coordinating animations
            duration: Animation duration in milliseconds
        """
        super().__init__(animation_coordination_service)
        self.duration = duration
    
    def execute(self, widget: IWidget) -> Result[None]:
        """Execute fade-in animation by delegating to application service."""
        try:
            # Import here to avoid circular imports
            from src_refactored.application.interfaces.animation_service import FadeAnimationRequest
            
            # Get widget identifier (assuming it has an id property or we can generate one)
            widget_id = getattr(widget, "id", f"widget_{id(widget)}")
            
            # Create fade animation request
            fade_request = FadeAnimationRequest(
                duration_ms=self.duration,
                start_opacity=0.0,
                end_opacity=1.0,
            )
            
            # Delegate to application service
            return self._animation_coordination.start_fade_animation(widget_id, fade_request)
            
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Fade-in animation failed: {e!s}")

class SlideInStrategy(AnimationStrategy):
    """Strategy for slide-in animation."""
    
    def __init__(
        self, 
        animation_coordination_service: IAnimationCoordinationService, 
        direction: str = "left", 
        duration: int = 500,
    ):
        """Initialize slide-in strategy.
        
        Args:
            animation_coordination_service: Service for coordinating animations
            direction: Direction of slide animation ("left", "right", "top", "bottom")
            duration: Animation duration in milliseconds
        """
        super().__init__(animation_coordination_service)
        self.direction = direction
        self.duration = duration
    
    def execute(self, widget: IWidget) -> Result[None]:
        """Execute slide-in animation by delegating to application service."""
        try:
            # Import here to avoid circular imports
            from src_refactored.application.interfaces.animation_service import (
                AnimationBounds,
                AnimationDimensions,
                AnimationPosition,
                SlideAnimationRequest,
            )
            
            # Get widget identifier
            widget_id = getattr(widget, "id", f"widget_{id(widget)}")
            
            # Get current widget bounds
            if hasattr(widget, "get_geometry"):
                geometry = widget.get_geometry()  # type: ignore[attr-defined]
                current_bounds = AnimationBounds(
                    position=AnimationPosition(x=geometry.x, y=geometry.y),
                    dimensions=AnimationDimensions(width=geometry.width, height=geometry.height),
                )
            else:
                # Fallback bounds if geometry is not available
                current_bounds = AnimationBounds(
                    position=AnimationPosition(x=0, y=0),
                    dimensions=AnimationDimensions(width=100, height=100),
                )
            
            # Create slide animation request
            slide_request = SlideAnimationRequest(
                direction=self.direction,
                current_bounds=current_bounds,
                screen_bounds=AnimationBounds(  # This will be calculated by the service
                    position=AnimationPosition(x=0, y=0),
                    dimensions=AnimationDimensions(width=0, height=0),
                ),
            )
            
            # Delegate to application service
            return self._animation_coordination.start_slide_animation(widget_id, slide_request)
            
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Slide-in animation failed: {e!s}")

class AnimationContext:
    """Context for animation strategies."""
    
    def __init__(self, widget: IWidget):
        self._widget = widget
        self._strategy: IAnimationStrategy | None = None
    
    def set_strategy(self, strategy: IAnimationStrategy) -> None:
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
    def widget(self) -> IWidget:
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
    
    def __init__(self, component: IUIComponent, tooltip_text: str, styler: IWidgetStyler):
        super().__init__(component)
        self._tooltip_text = tooltip_text
        self._styler = styler
    
    def initialize(self) -> Result[None]:
        """Initialize with tooltip."""
        result = super().initialize()
        if result.is_success:
            self._styler.set_property(self.widget, "toolTip", self._tooltip_text)
        return result

class ValidationDecorator(UIComponentDecorator):
    """Decorator that adds validation functionality."""
    
    def __init__(self, component: IUIComponent, validator: Callable[[Any], bool], styler: IWidgetStyler):
        super().__init__(component)
        self._validator = validator
        self._styler = styler
        self._is_valid = True
    
    def validate(self, value: Any) -> bool:
        """Validate the given value."""
        self._is_valid = self._validator(value)
        self._update_visual_state()
        return self._is_valid
    
    def _update_visual_state(self) -> None:
        """Update visual state based on validation."""
        if self._is_valid:
            self._styler.set_property(self.widget, "styleSheet", "")
        else:
            self._styler.set_property(self.widget, "styleSheet", "border: 2px solid red;")

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
            
            self._component.widget.set_visible(True)
            self._executed = True
            return Result.success(None)
        except (ValueError, TypeError, RuntimeError) as e:
            return Result.failure(f"Failed to show component: {e!s}")
    
    def undo(self) -> Result[Any]:
        """Hide the component."""
        try:
            if not self.can_undo():
                return Result.failure("Command not executed yet")
            
            self._component.widget.set_visible(False)
            self._executed = False
            return Result.success(None)
        except (ValueError, TypeError, RuntimeError) as e:
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
