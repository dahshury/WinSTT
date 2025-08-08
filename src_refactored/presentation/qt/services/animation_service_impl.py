"""Animation service implementation for application layer."""

from __future__ import annotations

from src_refactored.application.interfaces.animation_service import (
    AnimationBounds,
    AnimationDimensions,
    AnimationPosition,
    FadeAnimationRequest,
    IAnimationCalculationService,
    IAnimationCoordinationService,
    SlideAnimationRequest,
    SlideAnimationResponse,
)
from src_refactored.domain.common.result import Result


class AnimationCalculationServiceImpl(IAnimationCalculationService):
    """Implementation of animation calculation service."""

    def __init__(self):
        """Initialize the animation calculation service."""
        self._screen_bounds = AnimationBounds(
            position=AnimationPosition(x=0, y=0),
            dimensions=AnimationDimensions(width=1920, height=1080),
        )

    def calculate_slide_positions(
        self, request: SlideAnimationRequest,
    ) -> Result[SlideAnimationResponse]:
        """Calculate start and end positions for slide animations."""
        try:
            current_bounds = request.current_bounds
            screen_bounds = request.screen_bounds
            direction = request.direction.lower()

            # Current position as start
            start_position = current_bounds.position

            # Calculate end position based on direction
            if direction == "left":
                end_x = screen_bounds.position.x - current_bounds.dimensions.width
                end_y = current_bounds.position.y
            elif direction == "right":
                end_x = screen_bounds.dimensions.width
                end_y = current_bounds.position.y
            elif direction == "top":
                end_x = current_bounds.position.x
                end_y = screen_bounds.position.y - current_bounds.dimensions.height
            elif direction == "bottom":
                end_x = current_bounds.position.x
                end_y = screen_bounds.dimensions.height
            else:
                return Result.failure(f"Invalid direction: {direction}")

            end_position = AnimationPosition(x=end_x, y=end_y)

            response = SlideAnimationResponse(
                start_position=start_position,
                end_position=end_position,
            )

            return Result.success(response)
        except Exception as e:
            return Result.failure(f"Failed to calculate slide positions: {e}")

    def get_screen_bounds(self) -> Result[AnimationBounds]:
        """Get current screen bounds for animation calculations."""
        try:
            # In a real implementation, this would query the actual screen dimensions
            return Result.success(self._screen_bounds)
        except Exception as e:
            return Result.failure(f"Failed to get screen bounds: {e}")

    def validate_animation_bounds(self, bounds: AnimationBounds) -> Result[bool]:
        """Validate if animation bounds are within acceptable limits."""
        try:
            # Check if bounds are within screen limits
            screen_bounds = self._screen_bounds
            
            # Position validation
            if bounds.position.x < screen_bounds.position.x:
                return Result.success(False)
            if bounds.position.y < screen_bounds.position.y:
                return Result.success(False)
            
            # Size validation
            max_x = bounds.position.x + bounds.dimensions.width
            max_y = bounds.position.y + bounds.dimensions.height
            
            screen_max_x = screen_bounds.position.x + screen_bounds.dimensions.width
            screen_max_y = screen_bounds.position.y + screen_bounds.dimensions.height
            
            if max_x > screen_max_x:
                return Result.success(False)
            if max_y > screen_max_y:
                return Result.success(False)
            
            # All validations passed
            return Result.success(True)
        except Exception as e:
            return Result.failure(f"Failed to validate animation bounds: {e}")


class AnimationCoordinationServiceImpl(IAnimationCoordinationService):
    """Implementation of animation coordination service."""

    def __init__(self):
        """Initialize the animation coordination service."""
        self._active_animations: dict[str, dict[str, dict]] = {}  # target_id -> animation_type -> config

    def start_fade_animation(self, target_id: str, request: FadeAnimationRequest) -> Result[None]:
        """Start a fade animation for a target component."""
        try:
            if target_id not in self._active_animations:
                self._active_animations[target_id] = {}

            # Store animation configuration
            self._active_animations[target_id]["fade"] = {
                "duration_ms": request.duration_ms,
                "start_opacity": request.start_opacity,
                "end_opacity": request.end_opacity,
                "start_time": None,  # Would be set to current time
                "active": True,
            }

            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to start fade animation: {e}")

    def start_slide_animation(self, target_id: str, request: SlideAnimationRequest) -> Result[None]:
        """Start a slide animation for a target component."""
        try:
            if target_id not in self._active_animations:
                self._active_animations[target_id] = {}

            # Calculate positions
            calc_service = AnimationCalculationServiceImpl()
            positions_result = calc_service.calculate_slide_positions(request)
            
            if positions_result.is_failure():
                return Result.failure(positions_result.get_error())

            positions = positions_result.get_value()

            # Store animation configuration
            self._active_animations[target_id]["slide"] = {
                "direction": request.direction,
                "start_position": positions.start_position,
                "end_position": positions.end_position,
                "start_time": None,  # Would be set to current time
                "active": True,
            }

            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to start slide animation: {e}")

    def stop_animation(self, target_id: str) -> Result[None]:
        """Stop any running animation for a target."""
        try:
            if target_id in self._active_animations:
                # Mark all animations as inactive
                for animation_type in self._active_animations[target_id]:
                    self._active_animations[target_id][animation_type]["active"] = False

            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to stop animation: {e}")

    def is_animation_running(self, target_id: str) -> Result[bool]:
        """Check if an animation is currently running for a target."""
        try:
            if target_id not in self._active_animations:
                return Result.success(False)

            # Check if any animations are active
            for animation_config in self._active_animations[target_id].values():
                if animation_config.get("active", False):
                    return Result.success(True)

            return Result.success(False)
        except Exception as e:
            return Result.failure(f"Failed to check animation status: {e}")

