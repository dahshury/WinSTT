"""Opacity Effects Value Objects.

This module defines value objects for opacity effects management including
results, phases, modes, and effect types.
"""

from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class ManageResult(ValueObject, Enum):
    """Results for opacity effects management operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    EFFECT_ERROR = "effect_error"
    STATE_ERROR = "state_error"
    ANIMATION_ERROR = "animation_error"
    CANCELLED = "cancelled"


class ManagePhase(ValueObject, Enum):
    """Phases of opacity effects management process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    STATE_BACKUP = "state_backup"
    EFFECT_SETUP = "effect_setup"
    OPACITY_APPLICATION = "opacity_application"
    ANIMATION_SETUP = "animation_setup"
    STATE_MONITORING = "state_monitoring"
    FINALIZATION = "finalization"


class OpacityMode(ValueObject, Enum):
    """Opacity effect modes."""
    RECORDING = "recording"
    IDLE = "idle"
    TRANSITION = "transition"
    DISABLED = "disabled"
    CUSTOM = "custom"


class EffectType(ValueObject, Enum):
    """Types of opacity effects."""
    FADE = "fade"
    PULSE = "pulse"
    BLINK = "blink"
    SMOOTH = "smooth"
    INSTANT = "instant"