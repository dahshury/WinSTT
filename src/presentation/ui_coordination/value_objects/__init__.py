"""UI Coordination value objects for presentation layer.

Contains UI-specific value objects that were previously in the domain layer.
"""

from .animation_state import AnimationEasing, AnimationState, AnimationType
from .element_type import ElementType
from .message_display import DisplayBehavior, MessageDisplay, MessagePriority, MessageType
from .ui_element_state import InteractionState, UIElementState, VisibilityState

__all__ = [
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