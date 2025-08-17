"""Framework-agnostic UI abstractions for the presentation layer.

This module defines interfaces that abstract away framework-specific dependencies,
allowing the presentation layer to remain independent of UI frameworks like PyQt6.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.domain.common.result import Result


# ============================================================================
# WIDGET ABSTRACTIONS
# ============================================================================

class IWidget(Protocol):
    """Framework-agnostic widget interface."""
    
    def set_text(self, text: str) -> None:
        """Set widget text content."""
        ...
    
    def get_text(self) -> str:
        """Get widget text content."""
        ...
    
    def set_enabled(self, enabled: bool) -> None:
        """Enable or disable the widget."""
        ...
    
    def is_enabled(self) -> bool:
        """Check if widget is enabled."""
        ...
    
    def set_visible(self, visible: bool) -> None:
        """Show or hide the widget."""
        ...
    
    def is_visible(self) -> bool:
        """Check if widget is visible."""
        ...
    
    def set_position(self, x: int, y: int) -> None:
        """Set widget position."""
        ...
    
    def get_position(self) -> tuple[int, int]:
        """Get widget position."""
        ...
    
    def set_size(self, width: int, height: int) -> None:
        """Set widget size."""
        ...
    
    def get_size(self) -> tuple[int, int]:
        """Get widget size."""
        ...


class IButton(IWidget, Protocol):
    """Framework-agnostic button interface."""
    
    def set_click_handler(self, handler: Callable[[], None]) -> None:
        """Set button click handler."""
        ...


class ILabel(IWidget, Protocol):
    """Framework-agnostic label interface."""
    
    def set_word_wrap(self, wrap: bool) -> None:
        """Enable or disable word wrapping."""
        ...
    
    def set_alignment(self, alignment: str) -> None:
        """Set text alignment."""
        ...


class ITextInput(IWidget, Protocol):
    """Framework-agnostic text input interface."""
    
    def set_placeholder(self, text: str) -> None:
        """Set placeholder text."""
        ...
    
    def set_max_length(self, length: int) -> None:
        """Set maximum text length."""
        ...
    
    def set_read_only(self, read_only: bool) -> None:
        """Set read-only mode."""
        ...


class IDialog(IWidget, Protocol):
    """Framework-agnostic dialog interface."""
    
    def set_title(self, title: str) -> None:
        """Set dialog title."""
        ...
    
    def set_modal(self, modal: bool) -> None:
        """Set modal mode."""
        ...
    
    def show_dialog(self) -> None:
        """Show the dialog."""
        ...
    
    def close_dialog(self) -> None:
        """Close the dialog."""
        ...


# ============================================================================
# FONT ABSTRACTIONS
# ============================================================================

@dataclass
class FontDescriptor:
    """Framework-agnostic font description."""
    family: str | None = None
    size: int | None = None
    bold: bool = False
    italic: bool = False
    
    def __post_init__(self):
        if self.size is not None and self.size <= 0:
            msg = "Font size must be positive"
            raise ValueError(msg)


class IFont(Protocol):
    """Framework-agnostic font interface."""
    
    def set_family(self, family: str) -> None:
        """Set font family."""
        ...
    
    def get_family(self) -> str:
        """Get font family."""
        ...
    
    def set_size(self, size: int) -> None:
        """Set font size."""
        ...
    
    def get_size(self) -> int:
        """Get font size."""
        ...
    
    def set_bold(self, bold: bool) -> None:
        """Set bold style."""
        ...
    
    def is_bold(self) -> bool:
        """Check if font is bold."""
        ...


class IFontFactory(Protocol):
    """Framework-agnostic font factory."""
    
    def create_font(self, descriptor: FontDescriptor) -> IFont:
        """Create a font from descriptor."""
        ...


# ============================================================================
# ANIMATION ABSTRACTIONS
# ============================================================================

class AnimationEasing(Enum):
    """Animation easing types."""
    LINEAR = "linear"
    EASE_IN = "ease_in"
    EASE_OUT = "ease_out"
    EASE_IN_OUT = "ease_in_out"
    EASE_IN_CUBIC = "ease_in_cubic"
    EASE_OUT_CUBIC = "ease_out_cubic"


@dataclass
class AnimationDescriptor:
    """Framework-agnostic animation description."""
    duration_ms: int
    start_value: float
    end_value: float
    easing: AnimationEasing = AnimationEasing.EASE_IN_OUT
    property_name: str = "opacity"
    
    def __post_init__(self):
        if self.duration_ms <= 0:
            msg = "Animation duration must be positive"
            raise ValueError(msg)


class IAnimation(Protocol):
    """Framework-agnostic animation interface."""
    
    def start(self) -> None:
        """Start the animation."""
        ...
    
    def stop(self) -> None:
        """Stop the animation."""
        ...
    
    def pause(self) -> None:
        """Pause the animation."""
        ...
    
    def resume(self) -> None:
        """Resume the animation."""
        ...
    
    def is_running(self) -> bool:
        """Check if animation is running."""
        ...
    
    def set_completion_callback(self, callback: Callable[[], None]) -> None:
        """Set animation completion callback."""
        ...


class IAnimationFactory(Protocol):
    """Framework-agnostic animation factory."""
    
    def create_property_animation(
        self, 
        target: IWidget, 
        descriptor: AnimationDescriptor,
    ) -> IAnimation:
        """Create a property animation."""
        ...
    
    def create_fade_animation(
        self, 
        target: IWidget, 
        duration_ms: int,
        start_opacity: float,
        end_opacity: float,
    ) -> IAnimation:
        """Create a fade animation."""
        ...


# ============================================================================
# GRAPHICS EFFECTS ABSTRACTIONS
# ============================================================================

class IGraphicsEffect(Protocol):
    """Framework-agnostic graphics effect interface."""
    
    def set_opacity(self, opacity: float) -> None:
        """Set effect opacity."""
        ...
    
    def get_opacity(self) -> float:
        """Get effect opacity."""
        ...


class IEffectsFactory(Protocol):
    """Framework-agnostic effects factory."""
    
    def create_opacity_effect(self) -> IGraphicsEffect:
        """Create an opacity effect."""
        ...


# ============================================================================
# GEOMETRY ABSTRACTIONS
# ============================================================================

@dataclass
class Rectangle:
    """Framework-agnostic rectangle."""
    x: int
    y: int
    width: int
    height: int
    
    def __post_init__(self):
        if self.width <= 0 or self.height <= 0:
            msg = "Rectangle dimensions must be positive"
            raise ValueError(msg)


class IGeometry(Protocol):
    """Framework-agnostic geometry interface."""
    
    def get_rectangle(self) -> Rectangle:
        """Get geometry as rectangle."""
        ...
    
    def set_rectangle(self, rect: Rectangle) -> None:
        """Set geometry from rectangle."""
        ...


# ============================================================================
# WIDGET FACTORY ABSTRACTIONS
# ============================================================================

class IUIWidgetFactory(Protocol):
    """Framework-agnostic widget factory interface."""
    
    def create_button(self, **properties) -> Result[IButton]:
        """Create a button widget."""
        ...
    
    def create_label(self, **properties) -> Result[ILabel]:
        """Create a label widget."""
        ...
    
    def create_text_input(self, **properties) -> Result[ITextInput]:
        """Create a text input widget."""
        ...
    
    def create_dialog(self, **properties) -> Result[IDialog]:
        """Create a dialog widget."""
        ...


# ============================================================================
# STRATEGY ABSTRACTIONS
# ============================================================================

class IAnimationStrategy(ABC):
    """Framework-agnostic animation strategy."""
    
    @abstractmethod
    def execute(self, target: IWidget) -> Result[None]:
        """Execute the animation strategy."""


class IWidgetStyler(Protocol):
    """Framework-agnostic widget styling interface."""
    
    def apply_font(self, widget: IWidget, font: IFont) -> None:
        """Apply font to widget."""
        ...
    
    def apply_effect(self, widget: IWidget, effect: IGraphicsEffect) -> None:
        """Apply graphics effect to widget."""
        ...
    
    def set_property(self, widget: IWidget, property_name: str, value: Any) -> None:
        """Set widget property."""
        ...


__all__ = [
    "AnimationDescriptor",
    "AnimationEasing",
    "FontDescriptor",
    "IAnimation",
    "IAnimationFactory",
    "IAnimationStrategy",
    "IButton",
    "IDialog",
    "IEffectsFactory",
    "IFont",
    "IFontFactory",
    "IGeometry",
    "IGraphicsEffect",
    "ILabel",
    "ITextInput",
    "IUIWidgetFactory",
    "IWidget",
    "IWidgetStyler",
    "Rectangle",
]
