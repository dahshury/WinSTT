"""Animation service interface for application layer.

This interface abstracts animation calculations and logic, providing a clean boundary
between the presentation layer and animation business logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from src_refactored.domain.common.result import Result


# ============================================================================
# DATA TRANSFER OBJECTS
# ============================================================================

@dataclass
class AnimationPosition:
    """Position information for animations."""
    x: int
    y: int


@dataclass
class AnimationDimensions:
    """Dimensions information for animations."""
    width: int
    height: int


@dataclass
class AnimationBounds:
    """Bounds information for animations."""
    position: AnimationPosition
    dimensions: AnimationDimensions


@dataclass
class SlideAnimationRequest:
    """Request for slide animation calculations."""
    direction: str  # "left", "right", "top", "bottom"
    current_bounds: AnimationBounds
    screen_bounds: AnimationBounds


@dataclass
class SlideAnimationResponse:
    """Response with slide animation positions."""
    start_position: AnimationPosition
    end_position: AnimationPosition


@dataclass
class FadeAnimationRequest:
    """Request for fade animation."""
    duration_ms: int
    start_opacity: float = 0.0
    end_opacity: float = 1.0


@dataclass
class AnimationConfiguration:
    """Configuration for animations."""
    duration_ms: int
    easing_type: str = "ease_in_out"
    delay_ms: int = 0


# ============================================================================
# SERVICE INTERFACES
# ============================================================================

class IAnimationCalculationService(Protocol):
    """Service interface for animation calculations."""

    def calculate_slide_positions(
        self, request: SlideAnimationRequest,
    ) -> Result[SlideAnimationResponse]:
        """Calculate start and end positions for slide animations.
        
        Args:
            request: Slide animation request with direction and bounds
            
        Returns:
            Result containing calculated positions
        """
        ...

    def get_screen_bounds(self) -> Result[AnimationBounds]:
        """Get current screen bounds for animation calculations.
        
        Returns:
            Result containing screen bounds
        """
        ...

    def validate_animation_bounds(self, bounds: AnimationBounds) -> Result[bool]:
        """Validate if animation bounds are within acceptable limits.
        
        Args:
            bounds: Animation bounds to validate
            
        Returns:
            Result containing validation status
        """
        ...


class IAnimationCoordinationService(Protocol):
    """Service interface for coordinating animations."""

    def start_fade_animation(self, target_id: str, request: FadeAnimationRequest) -> Result[None]:
        """Start a fade animation for a target component.
        
        Args:
            target_id: Identifier of the target component
            request: Fade animation request
            
        Returns:
            Result indicating success
        """
        ...

    def start_slide_animation(self, target_id: str, request: SlideAnimationRequest) -> Result[None]:
        """Start a slide animation for a target component.
        
        Args:
            target_id: Identifier of the target component
            request: Slide animation request
            
        Returns:
            Result indicating success
        """
        ...

    def stop_animation(self, target_id: str) -> Result[None]:
        """Stop any running animation for a target component.
        
        Args:
            target_id: Identifier of the target component
            
        Returns:
            Result indicating success
        """
        ...

    def is_animation_running(self, target_id: str) -> Result[bool]:
        """Check if an animation is currently running for a target.
        
        Args:
            target_id: Identifier of the target component
            
        Returns:
            Result containing animation status
        """
        ...


__all__ = [
    "AnimationBounds",
    "AnimationConfiguration",
    "AnimationDimensions",
    "AnimationPosition",
    "FadeAnimationRequest",
    "IAnimationCalculationService",
    "IAnimationCoordinationService",
    "SlideAnimationRequest",
    "SlideAnimationResponse",
]
