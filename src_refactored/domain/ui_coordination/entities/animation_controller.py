"""Animation controller entity for managing UI animations."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.ui_coordination.value_objects import (
    AnimationEasing,
    AnimationState,
    ElementType,
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
        return datetime.now() >= self.end_time

    def get_progress(self) -> float:
        """Get animation progress (0.0 to 1.0)."""
        if self.status == AnimationStatus.PENDING:
            return 0.0

        if self.status in [AnimationStatus.COMPLETED, AnimationStatus.CANCELLED]:
            return 1.0

        now = datetime.now()
        animation_start = self.start_time + timedelta(milliseconds=self.animation_state.delay_ms)

        if now < animation_start:
            return 0.0

        elapsed = (now - animation_start).total_seconds() * 1000  # Convert to ms
        return min(elapsed / self.animation_state.duration_ms, 1.0)


    def calculate_current_value(self) -> float:
        """Calculate current animation value based on progress and easing."""
        progress = self.get_progress()

        if progress <= 0.0:
            return self.animation_state.start_value

        if progress >= 1.0:
            return self.animation_state.end_value

        # Apply easing curve
        eased_progress = self._apply_easing(progress)

        # Interpolate between start and end values
        value_range = self.animation_state.end_value - self.animation_state.start_value
        current_value = self.animation_state.start_value + (value_range * eased_progress)

        self.current_value = current_value
        return current_value

    def _apply_easing(self, progress: float,
    ) -> float:
        """Apply easing curve to progress value."""
        if self.animation_state.easing == AnimationEasing.LINEAR:
            return progress

        if self.animation_state.easing == AnimationEasing.IN_QUAD:
            return progress * progress

        if self.animation_state.easing == AnimationEasing.OUT_QUAD:
            return 1 - (1 - progress) * (1 - progress)

        if self.animation_state.easing == AnimationEasing.IN_OUT_QUAD:
            if progress < 0.5:
                return 2 * progress * progress
            return 1 - 2 * (1 - progress) * (1 - progress)

        if self.animation_state.easing == AnimationEasing.IN_OUT_CUBIC:
            if progress < 0.5:
                return 4 * progress * progress * progress
            p = 2 * progress - 2
            return 1 + p * p * p

        return progress  # Fallback to linear


@dataclass
class AnimationGroup:
    """Represents a group of coordinated animations."""
    name: str
    animations: list[AnimationInstance] = field(default_factory=list)
    completion_callback: Callable[[], None] | None = None

    def add_animation(self, animation: AnimationInstance,
    ) -> None:
        """Add an animation to the group."""
        self.animations.append(animation)

    def is_complete(self) -> bool:
        """Check if all animations in the group are complete."""
        return all(anim.status == AnimationStatus.COMPLETED for anim in self.animations)

    def get_progress(self) -> float:
        """Get overall progress of the animation group."""
        if not self.animations:
            return 1.0

        total_progress = sum(anim.get_progress() for anim in self.animations)
        return total_progress / len(self.animations)


@dataclass
class AnimationController(Entity):
    """Controls and manages UI animations."""

    # Active animations by element type
    active_animations: dict[ElementType, AnimationInstance] = field(default_factory=dict)

    # Animation groups for coordinated animations
    animation_groups: dict[str, AnimationGroup] = field(default_factory=dict)

    # Animation update callbacks
    update_callbacks: dict[ElementType, list[Callable[[float], None]]] = field(default_factory=dict)

    # Global animation settings
    global_speed_multiplier: float = 1.0
    animations_enabled: bool = True

    def start_animation(self, element_type: ElementType, animation_state: AnimationState,
                      completion_callback: Callable[[], None] | None = None) -> str:
        """Start an animation for an element."""
        if not self.animations_enabled:
            # If animations are disabled, immediately set to end value
            if completion_callback:
                completion_callback()
            return ""

        # Cancel existing animation for this element
        self.cancel_animation(element_type)

        # Create new animation instance
        animation = AnimationInstance(
            animation_state=animation_state,
            element_type=element_type,
            start_time=datetime.now()
            completion_callback=completion_callback,
        )

        self.active_animations[element_type] = animation

        return f"{element_type.value}_{animation.start_time.timestamp()}"

    def start_animation_group(self, group_name: str, animations: dict[ElementType, AnimationState],
                            completion_callback: Callable[[], None] | None = None) -> None:
        """Start a group of coordinated animations."""
        if not self.animations_enabled:
            if completion_callback:
                completion_callback()
            return

        # Cancel existing group if it exists
        self.cancel_animation_group(group_name)

        # Create animation group
        group = AnimationGroup(name=group_name, completion_callback=completion_callback)

        # Create and add animations to group
        start_time = datetime.now()
        for element_type, animation_state in animations.items():
            # Cancel existing animation for this element
            self.cancel_animation(element_type)

            animation = AnimationInstance(
                animation_state=animation_state,
                element_type=element_type,
                start_time=start_time,
            )

            group.add_animation(animation)
            self.active_animations[element_type] = animation

        self.animation_groups[group_name] = group

    def update_animations(self) -> dict[ElementType, float]:
        """Update all active animations and return current values."""
        current_values = {}
        completed_animations = []
        completed_groups = []

        # Update individual animations
        for element_type, animation in self.active_animations.items():
            if animation.should_start and animation.status == AnimationStatus.PENDING:
                animation.status = AnimationStatus.RUNNING

            if animation.status == AnimationStatus.RUNNING:
                current_value = animation.calculate_current_value()
                current_values[element_type] = current_value

                # Notify update callbacks
                if element_type in self.update_callbacks:
                    for callback in self.update_callbacks[element_type]:
                        callback(current_value)

                # Check if animation is complete
                if animation.is_complete:
                    animation.status = AnimationStatus.COMPLETED
                    completed_animations.append(element_type)

                    # Call completion callback
                    if animation.completion_callback:
                        animation.completion_callback(,
    )

        # Clean up completed animations
        for element_type in completed_animations:
            del self.active_animations[element_type]

        # Check for completed animation groups
        for group_name, group in self.animation_groups.items():
            if group.is_complete():
                completed_groups.append(group_name)
                if group.completion_callback:
                    group.completion_callback()

        # Clean up completed groups
        for group_name in completed_groups:
            del self.animation_groups[group_name]

        return current_values

    def cancel_animation(self, element_type: ElementType,
    ) -> bool:
        """Cancel an active animation for an element."""
        if element_type in self.active_animations:
            animation = self.active_animations[element_type]
            animation.status = AnimationStatus.CANCELLED
            del self.active_animations[element_type]
            return True
        return False

    def cancel_animation_group(self, group_name: str,
    ) -> bool:
        """Cancel an animation group."""
        if group_name in self.animation_groups:
            group = self.animation_groups[group_name]

            # Cancel all animations in the group
            for animation in group.animations:
                animation.status = AnimationStatus.CANCELLED
                self.active_animations.pop(animation.element_type, None)

            del self.animation_groups[group_name]
            return True
        return False

    def pause_animation(self, element_type: ElementType,
    ) -> bool:
        """Pause an active animation."""
        if element_type in self.active_animations:
            animation = self.active_animations[element_type]
            if animation.status == AnimationStatus.RUNNING:
                animation.status = AnimationStatus.PAUSED
                return True
        return False

    def resume_animation(self, element_type: ElementType,
    ) -> bool:
        """Resume a paused animation."""
        if element_type in self.active_animations:
            animation = self.active_animations[element_type]
            if animation.status == AnimationStatus.PAUSED:
                animation.status = AnimationStatus.RUNNING
                return True
        return False

    def add_update_callback(
    self,
    element_type: ElementType,
    callback: Callable[[float],
    None]) -> None:
        """Add a callback to be called when an element's animation updates."""
        if element_type not in self.update_callbacks:
            self.update_callbacks[element_type] = []
        self.update_callbacks[element_type].append(callback)

    def remove_update_callback(
    self,
    element_type: ElementType,
    callback: Callable[[float],
    None]) -> bool:
        """Remove an update callback."""
        if element_type in self.update_callbacks:
            try:
                self.update_callbacks[element_type].remove(callback)
                return True
            except ValueError:
                pass
        return False

    def get_animation_status(self, element_type: ElementType,
    ) -> AnimationStatus | None:
        """Get the status of an animation."""
        if element_type in self.active_animations:
            return self.active_animations[element_type].status
        return None

    def get_animation_progress(self, element_type: ElementType,
    ) -> float:
        """Get the progress of an animation (0.0 to 1.0)."""
        if element_type in self.active_animations:
            return self.active_animations[element_type].get_progress()
        return 0.0

    def get_group_progress(self, group_name: str,
    ) -> float:
        """Get the progress of an animation group."""
        if group_name in self.animation_groups:
            return self.animation_groups[group_name].get_progress()
        return 0.0

    def is_animating(self, element_type: ElementType,
    ) -> bool:
        """Check if an element is currently animating."""
        return element_type in self.active_animations

    def has_active_animations(self) -> bool:
        """Check if there are any active animations."""
        return len(self.active_animations) > 0

    def set_global_speed(self, multiplier: float,
    ) -> None:
        """Set global animation speed multiplier."""
        if multiplier <= 0:
            msg = "Speed multiplier must be positive"
            raise ValueError(msg,
    )
        self.global_speed_multiplier = multiplier

    def enable_animations(self, enabled: bool = True) -> None:
        """Enable or disable animations globally."""
        self.animations_enabled = enabled

        if not enabled:
            # Cancel all active animations
            for element_type in list(self.active_animations.keys()):
                self.cancel_animation(element_type)

            # Cancel all animation groups
            for group_name in list(self.animation_groups.keys()):
                self.cancel_animation_group(group_name)

    def clear_all_animations(self) -> None:
        """Clear all active animations and groups."""
        self.active_animations.clear()
        self.animation_groups.clear()
        self.update_callbacks.clear(,
    )