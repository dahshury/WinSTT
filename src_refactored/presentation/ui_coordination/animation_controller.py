"""Animation controller presenter for managing UI animations.

This presenter follows MVP pattern and delegates business logic to application services.
Replaces the previous AnimationController entity that violated hexagonal architecture.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum

from src_refactored.application.interfaces.ui_coordination_service import (
    ElementType,
    IAnimationService,
)
from src_refactored.domain.common.result import Result
from src_refactored.presentation.ui_coordination.value_objects import (
    AnimationEasing,
    AnimationState,
)


class AnimationStatus(Enum):
    """Status of an animation."""
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


@dataclass
class AnimationInstance:
    """Represents a running animation instance."""
    animation_state: AnimationState
    element_type: ElementType
    start_time: datetime
    status: AnimationStatus = AnimationStatus.PENDING
    current_value: float = 0.0
    completion_callback: Callable[[], None] | None = None

    @property
    def end_time(self) -> datetime:
        """Calculate when the animation should end."""
        total_duration = self.animation_state.delay_ms + self.animation_state.duration_ms
        return self.start_time + timedelta(milliseconds=total_duration)

    @property
    def should_start(self) -> bool:
        """Check if animation should start (delay period passed)."""
        if self.status != AnimationStatus.PENDING:
            return False

        delay_end = self.start_time + timedelta(milliseconds=self.animation_state.delay_ms)
        return datetime.now() >= delay_end

    @property
    def is_complete(self) -> bool:
        """Check if animation is complete."""
        return self.status in (AnimationStatus.COMPLETED, AnimationStatus.CANCELLED)

    def get_progress(self) -> float:
        """Get current animation progress (0.0 to 1.0)."""
        if self.status == AnimationStatus.PENDING:
            return 0.0
        if self.status in (AnimationStatus.COMPLETED, AnimationStatus.CANCELLED):
            return 1.0

        now = datetime.now()
        if now < self.start_time:
            return 0.0

        # Account for delay
        animation_start = self.start_time + timedelta(milliseconds=self.animation_state.delay_ms)
        if now < animation_start:
            return 0.0

        elapsed = (now - animation_start).total_seconds() * 1000  # Convert to ms
        return min(elapsed / self.animation_state.duration_ms, 1.0)

    def calculate_current_value(self) -> float:
        """Calculate the current animated value based on progress and easing."""
        progress = self.get_progress()
        if progress <= 0.0:
            return self.animation_state.start_value
        if progress >= 1.0:
            return self.animation_state.end_value

        # Apply easing function
        eased_progress = self._apply_easing(progress, self.animation_state.easing)

        # Interpolate between start and end values
        value_range = self.animation_state.end_value - self.animation_state.start_value
        return self.animation_state.start_value + (value_range * eased_progress)

    def _apply_easing(self, progress: float, easing: AnimationEasing) -> float:
        """Apply easing function to progress value."""
        if easing == AnimationEasing.LINEAR:
            return progress
        if easing == AnimationEasing.EASE_IN:
            return progress * progress
        if easing == AnimationEasing.EASE_OUT:
            return 1 - (1 - progress) * (1 - progress)
        if easing == AnimationEasing.EASE_IN_OUT:
            if progress < 0.5:
                return 2 * progress * progress
            return 1 - 2 * (1 - progress) * (1 - progress)
        if easing == AnimationEasing.EASE_IN_CUBIC:
            return progress * progress * progress
        if easing == AnimationEasing.EASE_OUT_CUBIC:
            return 1 - (1 - progress) ** 3
        if easing == AnimationEasing.EASE_IN_OUT_CUBIC:
            if progress < 0.5:
                return 4 * progress * progress * progress
            return 1 - 4 * (1 - progress) ** 3
        return progress  # Fallback to linear


@dataclass
class AnimationGroup:
    """Group of animations that can be controlled together."""
    name: str
    animations: list[AnimationInstance] = field(default_factory=list)
    completion_callback: Callable[[], None] | None = None

    def add_animation(self, animation: AnimationInstance) -> None:
        """Add an animation to this group."""
        self.animations.append(animation)

    def is_complete(self) -> bool:
        """Check if all animations in the group are complete."""
        return all(anim.is_complete for anim in self.animations)

    def get_progress(self) -> float:
        """Get average progress of all animations in the group."""
        if not self.animations:
            return 1.0
        
        total_progress = sum(anim.get_progress() for anim in self.animations)
        return total_progress / len(self.animations)


class AnimationControllerPresenter:
    """Animation controller presenter coordinating with application services.
    
    This presenter handles UI animation presentation concerns and delegates complex
    animation logic to application services, following hexagonal architecture principles.
    """

    def __init__(self, controller_id: str, animation_service: IAnimationService):
        """Initialize the animation controller presenter.
        
        Args:
            controller_id: Unique identifier for the controller
            animation_service: Application service for animation operations
        """
        self._controller_id = controller_id
        self._animation_service = animation_service
        
        # Presentation-specific state for immediate UI feedback
        self._local_animation_instances: dict[ElementType, AnimationInstance] = {}
        self._local_animation_groups: dict[str, AnimationGroup] = {}
        self._local_update_callbacks: dict[ElementType, list[Callable[[float], None]]] = {}

    def start_animation(
        self, 
        element_type: ElementType, 
        animation_state: AnimationState,
        completion_callback: Callable[[], None] | None = None,
    ) -> Result[str]:
        """Start a new animation through application service."""
        # Convert animation state to config dict for service
        animation_config = {
            "start_value": animation_state.start_value,
            "end_value": animation_state.end_value,
            "duration_ms": animation_state.duration_ms,
            "delay_ms": animation_state.delay_ms,
            "easing": animation_state.easing.value if hasattr(animation_state.easing, "value") else str(animation_state.easing),
        }
        
        service_result = self._animation_service.start_animation(
            self._controller_id, element_type, animation_config,
        )
        
        if not service_result.is_success:
            return service_result

        # Create local animation instance for immediate UI feedback
        animation = AnimationInstance(
            animation_state=animation_state,
            element_type=element_type,
            start_time=datetime.now(),
            completion_callback=completion_callback,
        )
        
        self._local_animation_instances[element_type] = animation
        return service_result

    def start_animation_group(
        self, 
        group_name: str, 
        animations: dict[ElementType, AnimationState],
        completion_callback: Callable[[], None] | None = None,
    ) -> Result[None]:
        """Start a group of coordinated animations through application service."""
        # Convert animations to config dict format
        animation_configs = {}
        for element_type, animation_state in animations.items():
            animation_configs[element_type] = {
                "start_value": animation_state.start_value,
                "end_value": animation_state.end_value,
                "duration_ms": animation_state.duration_ms,
                "delay_ms": animation_state.delay_ms,
                "easing": animation_state.easing.value if hasattr(animation_state.easing, "value") else str(animation_state.easing),
            }
        
        service_result = self._animation_service.start_animation_group(
            self._controller_id, group_name, animation_configs,
        )
        
        if not service_result.is_success:
            return service_result

        # Create local animation group for immediate UI feedback
        group = AnimationGroup(name=group_name, completion_callback=completion_callback)
        start_time = datetime.now()
        
        for element_type, animation_state in animations.items():
            animation = AnimationInstance(
                animation_state=animation_state,
                element_type=element_type,
                start_time=start_time,
            )
            group.add_animation(animation)
            self._local_animation_instances[element_type] = animation
        
        self._local_animation_groups[group_name] = group
        return service_result

    def cancel_animation(self, element_type: ElementType) -> Result[bool]:
        """Cancel an active animation through application service."""
        service_result = self._animation_service.cancel_animation(self._controller_id, element_type)
        
        if service_result.is_success:
            # Update local state
            if element_type in self._local_animation_instances:
                self._local_animation_instances[element_type].status = AnimationStatus.CANCELLED
                del self._local_animation_instances[element_type]
        
        return service_result

    def cancel_animation_group(self, group_name: str) -> Result[bool]:
        """Cancel an entire animation group through application service."""
        service_result = self._animation_service.cancel_animation_group(self._controller_id, group_name)
        
        if service_result.is_success:
            # Update local state
            if group_name in self._local_animation_groups:
                group = self._local_animation_groups[group_name]
                for animation in group.animations:
                    animation.status = AnimationStatus.CANCELLED
                    if animation.element_type in self._local_animation_instances:
                        del self._local_animation_instances[animation.element_type]
                del self._local_animation_groups[group_name]
        
        return service_result

    def pause_animation(self, element_type: ElementType) -> Result[bool]:
        """Pause an active animation through application service."""
        service_result = self._animation_service.pause_animation(self._controller_id, element_type)
        
        if service_result.is_success:
            # Update local state
            if element_type in self._local_animation_instances:
                self._local_animation_instances[element_type].status = AnimationStatus.PAUSED
        
        return service_result

    def resume_animation(self, element_type: ElementType) -> Result[bool]:
        """Resume a paused animation through application service."""
        service_result = self._animation_service.resume_animation(self._controller_id, element_type)
        
        if service_result.is_success:
            # Update local state
            if element_type in self._local_animation_instances:
                self._local_animation_instances[element_type].status = AnimationStatus.RUNNING
        
        return service_result

    def get_animation_progress(self, element_type: ElementType) -> Result[float]:
        """Get the progress of an animation from application service."""
        service_result = self._animation_service.get_animation_progress(self._controller_id, element_type)
        
        if not service_result.is_success:
            # Fallback to local state
            if element_type in self._local_animation_instances:
                progress = self._local_animation_instances[element_type].get_progress()
                return Result.success(progress)
        
        return service_result

    def is_animating(self, element_type: ElementType) -> Result[bool]:
        """Check if an element is currently animating through application service."""
        return self._animation_service.is_animating(self._controller_id, element_type)

    def has_active_animations(self) -> Result[bool]:
        """Check if there are any active animations through application service."""
        return self._animation_service.has_active_animations(self._controller_id)

    def set_global_speed(self, multiplier: float) -> Result[None]:
        """Set global animation speed multiplier through application service."""
        if multiplier <= 0:
            return Result.failure("Speed multiplier must be positive")
        
        return self._animation_service.set_global_speed(self._controller_id, multiplier)

    def enable_animations(self, enabled: bool = True) -> Result[None]:
        """Enable or disable all animations through application service."""
        service_result = self._animation_service.enable_animations(self._controller_id, enabled)
        
        if service_result.is_success and not enabled:
            # Clear local state when disabling
            self._local_animation_instances.clear()
            self._local_animation_groups.clear()
            self._local_update_callbacks.clear()
        
        return service_result

    def add_update_callback(
        self,
        element_type: ElementType,
        callback: Callable[[float], None],
    ) -> None:
        """Add a callback to be called when animation value updates."""
        if element_type not in self._local_update_callbacks:
            self._local_update_callbacks[element_type] = []
        self._local_update_callbacks[element_type].append(callback)

    def remove_update_callback(
        self,
        element_type: ElementType,
        callback: Callable[[float], None],
    ) -> bool:
        """Remove an update callback."""
        if element_type in self._local_update_callbacks:
            try:
                self._local_update_callbacks[element_type].remove(callback)
                if not self._local_update_callbacks[element_type]:
                    del self._local_update_callbacks[element_type]
                return True
            except ValueError:
                pass
        return False

    def update_local_animations(self) -> dict[ElementType, float]:
        """Update local animation instances for immediate UI feedback."""
        current_values = {}
        completed_animations = []

        # Update individual animations
        for element_type, animation in self._local_animation_instances.items():
            if animation.should_start and animation.status == AnimationStatus.PENDING:
                animation.status = AnimationStatus.RUNNING

            if animation.status == AnimationStatus.RUNNING:
                current_value = animation.calculate_current_value()
                animation.current_value = current_value
                current_values[element_type] = current_value

                # Check if animation is complete
                if animation.get_progress() >= 1.0:
                    animation.status = AnimationStatus.COMPLETED
                    completed_animations.append(element_type)

                # Call update callbacks
                if element_type in self._local_update_callbacks:
                    for callback in self._local_update_callbacks[element_type]:
                        try:
                            callback(current_value)
                        except Exception:
                            pass  # Ignore callback errors

        # Handle completed animations
        for element_type in completed_animations:
            animation = self._local_animation_instances[element_type]
            if animation.completion_callback:
                try:
                    animation.completion_callback()
                except Exception:
                    pass  # Ignore callback errors
            del self._local_animation_instances[element_type]

        return current_values

    # Presentation-specific properties
    @property
    def controller_id(self) -> str:
        """Get controller identifier."""
        return self._controller_id

    @property
    def local_animation_instances(self) -> dict[ElementType, AnimationInstance]:
        """Get local animation instances for immediate UI feedback."""
        return self._local_animation_instances.copy()

    @property
    def local_animation_groups(self) -> dict[str, AnimationGroup]:
        """Get local animation groups for immediate UI feedback."""
        return self._local_animation_groups.copy()


# Backward compatibility alias - will be removed after full migration
AnimationController = AnimationControllerPresenter