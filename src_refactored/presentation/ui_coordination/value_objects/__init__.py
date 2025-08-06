"""UI Coordination value objects for presentation layer.

Contains UI-specific value objects that were previously in the domain layer.
"""

from .animation_state import AnimationEasing, AnimationState, AnimationType
from .element_type import ElementType

__all__ = [
    "AnimationEasing",
    "AnimationState",
    "AnimationType",
    "ElementType",
]