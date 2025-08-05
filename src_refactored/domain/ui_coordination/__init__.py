"""UI coordination domain."""

from .entities import (
    AnimationController,
    AnimationGroup,
    AnimationInstance,
    AnimationStatus,
    UICoordinator,
)
from .value_objects import (
    AnimationEasing,
    AnimationState,
    AnimationType,
    DisplayBehavior,
    ElementType,
    InteractionState,
    MessageDisplay,
    MessagePriority,
    MessageType,
    UIElementState,
    VisibilityState,
)

__all__ = [
    # Entities
    "AnimationController",
    "AnimationEasing",
    "AnimationGroup",
    "AnimationInstance",
    # Value Objects
    "AnimationState",
    "AnimationStatus",
    "AnimationType",
    "DisplayBehavior",
    "ElementType",
    "InteractionState",
    "MessageDisplay",
    "MessagePriority",
    "MessageType",
    "UICoordinator",
    "UIElementState",
    "VisibilityState",
]