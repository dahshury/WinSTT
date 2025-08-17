"""DEPRECATED: Animation controller entity - VIOLATES HEXAGONAL ARCHITECTURE.

This file contains domain logic in the presentation layer and should not be used.
Use AnimationControllerPresenter instead, which properly delegates to application services.

This file is kept temporarily for reference during refactoring.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src.domain.common.entity import Entity
from src.presentation.ui_coordination.value_objects import (
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


@dataclass
class AnimationControllerDeprecated(Entity):
    """DEPRECATED: Animation controller entity - violates hexagonal architecture."""
    
    # Active animations by element type
    active_animations: dict[ElementType, AnimationInstance] = field(default_factory=dict)
    
    # Animation groups for coordinated animations
    animation_groups: dict[str, Any] = field(default_factory=dict)
    
    # Callbacks for animation updates
    update_callbacks: dict[ElementType, list[Callable[[float], None]]] = field(default_factory=dict)
    
    # Global animation settings
    global_speed_multiplier: float = 1.0
    animations_enabled: bool = True

    # ... rest of the implementation is preserved for reference ...
