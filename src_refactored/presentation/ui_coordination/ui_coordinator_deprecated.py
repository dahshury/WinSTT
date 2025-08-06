"""DEPRECATED: UI coordinator entity - VIOLATES HEXAGONAL ARCHITECTURE.

This file contains domain logic in the presentation layer and should not be used.
Use UICoordinatorPresenter instead, which properly delegates to application services.

This file is kept temporarily for reference during refactoring.
"""

from dataclasses import dataclass, field

from src_refactored.domain.common.entity import Entity
from src_refactored.presentation.ui_coordination.value_objects import (
    AnimationState,
    ElementType,
    MessageDisplay,
    UIElementState,
)


@dataclass
class UICoordinatorDeprecated(Entity):
    """DEPRECATED: UI coordinator entity - violates hexagonal architecture."""

    # UI element states
    element_states: dict[ElementType, UIElementState] = field(default_factory=dict)

    # Active animations
    active_animations: dict[ElementType, AnimationState] = field(default_factory=dict)

    # Message queue and current message
    message_queue: list[MessageDisplay] = field(default_factory=list)
    current_message: MessageDisplay | None = None

    # UI mode tracking
    is_recording: bool = False
    is_downloading: bool = False
    is_transcribing: bool = False
    is_in_batch_mode: bool = False

    # ... rest of the implementation is preserved for reference ...
