"""Animation state value object for UI coordination.

Moved from domain layer to presentation layer as this is UI-specific presentation logic.
"""

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class AnimationType(Enum):
    """Types of animations in the UI."""
    FADE_IN = "fade_in"
    FADE_OUT = "fade_out"
    DIM = "dim"
    RESTORE = "restore"
    SLIDE_IN = "slide_in"
    SLIDE_OUT = "slide_out"


class AnimationEasing(Enum):
    """Animation easing curves."""
    LINEAR = "linear"
    EASE_IN = "ease_in"
    EASE_OUT = "ease_out"
    EASE_IN_OUT = "ease_in_out"
    EASE_IN_CUBIC = "ease_in_cubic"
    EASE_OUT_CUBIC = "ease_out_cubic"
    EASE_IN_OUT_CUBIC = "ease_in_out_cubic"
    IN_OUT_QUAD = "in_out_quad"
    IN_QUAD = "in_quad"
    OUT_QUAD = "out_quad"
    IN_OUT_CUBIC = "in_out_cubic"


@dataclass(frozen=True)
class AnimationState(ValueObject):
    """Represents the state of a UI animation."""

    animation_type: AnimationType
    duration_ms: int
    start_value: float
    end_value: float
    easing: AnimationEasing = AnimationEasing.IN_OUT_QUAD
    delay_ms: int = 0

    def __post_init__(self):
        """Validate animation state parameters."""
        if self.duration_ms <= 0:
            msg = "Animation duration must be positive"
            raise ValueError(msg)

        if not (0.0 <= self.start_value <= 1.0):
            msg = "Start value must be between 0.0 and 1.0"
            raise ValueError(msg)

        if not (0.0 <= self.end_value <= 1.0):
            msg = "End value must be between 0.0 and 1.0"
            raise ValueError(msg)

        if self.delay_ms < 0:
            msg = "Animation delay cannot be negative"
            raise ValueError(msg)

    @classmethod
    def fade_in(cls, duration_ms: int = 500, delay_ms: int = 0) -> "AnimationState":
        """Create a fade-in animation."""
        return cls(
            animation_type=AnimationType.FADE_IN,
            duration_ms=duration_ms,
            start_value=0.0,
            end_value=1.0,
            delay_ms=delay_ms,
        )

    @classmethod
    def fade_out(cls, duration_ms: int = 500, delay_ms: int = 0) -> "AnimationState":
        """Create a fade-out animation."""
        return cls(
            animation_type=AnimationType.FADE_OUT,
            duration_ms=duration_ms,
            start_value=1.0,
            end_value=0.0,
            delay_ms=delay_ms,
        )

    @classmethod
    def dim(cls, opacity: float = 0.4, duration_ms: int = 500) -> "AnimationState":
        """Create a dim animation."""
        return cls(
            animation_type=AnimationType.DIM,
            duration_ms=duration_ms,
            start_value=1.0,
            end_value=opacity,
        )

    @classmethod
    def restore(cls, from_opacity: float = 0.4, duration_ms: int = 500) -> "AnimationState":
        """Create a restore animation."""
        return cls(
            animation_type=AnimationType.RESTORE,
            duration_ms=duration_ms,
            start_value=from_opacity,
            end_value=1.0,
        )

    def is_fade_animation(self) -> bool:
        """Check if this is a fade animation."""
        return self.animation_type in (AnimationType.FADE_IN, AnimationType.FADE_OUT)

    def is_opacity_animation(self) -> bool:
        """Check if this animation affects opacity."""
        return self.animation_type in (
            AnimationType.FADE_IN,
            AnimationType.FADE_OUT,
            AnimationType.DIM,
            AnimationType.RESTORE,
        )

    def get_opacity_change(self) -> float:
        """Get the total opacity change for this animation."""
        return abs(self.end_value - self.start_value)