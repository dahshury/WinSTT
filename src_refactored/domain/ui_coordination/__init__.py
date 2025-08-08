"""UI coordination domain."""

# Note: UI coordination entities moved to presentation layer
# from .entities import (
#     AnimationController,
#     AnimationGroup,
#     AnimationInstance,
#     AnimationStatus,
#     UICoordinator,
# )
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
    # Note: Entities moved to presentation layer
    # "AnimationController",
    # "AnimationGroup", 
    # "AnimationInstance",
    # "AnimationStatus",
    # "UICoordinator",
    # Value Objects
    "AnimationEasing",
    "AnimationState",
    "AnimationType",
    "DisplayBehavior",
    "ElementType",
    "InteractionState",
    "MessageDisplay",
    "MessagePriority",
    "MessageType",
    "UIElementState",
    "VisibilityState",
]