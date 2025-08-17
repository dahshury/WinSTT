"""Opacity Effects Value Objects (Domain Layer).

Framework-agnostic value objects and enums for managing opacity effects.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.domain.common.result import Result
from src.domain.common.value_object import ValueObject


class ManageResult(Enum):
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    EFFECT_ERROR = "effect_error"
    STATE_ERROR = "state_error"
    ANIMATION_ERROR = "animation_error"
    CANCELLED = "cancelled"


class ManagePhase(Enum):
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    STATE_BACKUP = "state_backup"
    EFFECT_SETUP = "effect_setup"
    OPACITY_APPLICATION = "opacity_application"
    ANIMATION_SETUP = "animation_setup"
    STATE_MONITORING = "state_monitoring"
    FINALIZATION = "finalization"


class OpacityMode(Enum):
    RECORDING = "recording"
    IDLE = "idle"
    TRANSITION = "transition"
    DISABLED = "disabled"
    CUSTOM = "custom"


class EffectType(Enum):
    FADE = "fade"
    PULSE = "pulse"
    BLINK = "blink"
    SMOOTH = "smooth"
    INSTANT = "instant"


@dataclass(frozen=True)
class OpacityLevel(ValueObject):
    value: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.value <= 1.0:
            message = f"Opacity must be between 0.0 and 1.0, got {self.value}"
            raise ValueError(message)

    @classmethod
    def create(cls, value: float) -> Result[OpacityLevel]:
        try:
            return Result.success(cls(value))
        except ValueError as exc:
            return Result.failure(str(exc))

    @classmethod
    def transparent(cls) -> OpacityLevel:
        return cls(0.0)

    @classmethod
    def opaque(cls) -> OpacityLevel:
        return cls(1.0)

    @classmethod
    def semi_transparent(cls) -> OpacityLevel:
        return cls(0.5)

    @classmethod
    def from_percentage(cls, percentage: int) -> Result[OpacityLevel]:
        percent_max = 100
        if not 0 <= percentage <= percent_max:
            return Result.failure(f"Percentage must be between 0 and 100, got {percentage}")
        return cls.create(percentage / 100.0)

    def to_percentage(self) -> int:
        return int(self.value * 100)

    def is_transparent(self) -> bool:
        return self.value == 0.0

    def is_opaque(self) -> bool:
        return self.value == 1.0

    def is_semi_transparent(self) -> bool:
        return 0.0 < self.value < 1.0

    def blend_with(self, other: OpacityLevel, factor: float = 0.5) -> Result[OpacityLevel]:
        if not 0.0 <= factor <= 1.0:
            return Result.failure(f"Blend factor must be between 0.0 and 1.0, got {factor}")
        blended_value = self.value * (1.0 - factor) + other.value * factor
        return self.create(blended_value)

    def adjust(self, delta: float) -> Result[OpacityLevel]:
        new_value = self.value + delta
        return self.create(new_value)

    def multiply(self, factor: float) -> Result[OpacityLevel]:
        if factor < 0.0:
            return Result.failure(f"Factor must be non-negative, got {factor}")
        new_value = min(1.0, self.value * factor)
        return self.create(new_value)


@dataclass(frozen=True)
class OpacityTransition(ValueObject):
    from_opacity: OpacityLevel
    to_opacity: OpacityLevel
    duration_ms: int
    effect_type: EffectType = EffectType.SMOOTH

    def __post_init__(self) -> None:
        if self.duration_ms < 0:
            message = f"Duration must be non-negative, got {self.duration_ms}"
            raise ValueError(message)

    @classmethod
    def create(
        cls,
        from_opacity: OpacityLevel,
        to_opacity: OpacityLevel,
        duration_ms: int,
        effect_type: EffectType = EffectType.SMOOTH,
    ) -> Result[OpacityTransition]:
        try:
            return Result.success(cls(from_opacity, to_opacity, duration_ms, effect_type))
        except ValueError as exc:
            return Result.failure(str(exc))

    @classmethod
    def fade_in(cls, duration_ms: int = 300) -> Result[OpacityTransition]:
        return cls.create(OpacityLevel.transparent(), OpacityLevel.opaque(), duration_ms, EffectType.FADE)

    @classmethod
    def fade_out(cls, duration_ms: int = 300) -> Result[OpacityTransition]:
        return cls.create(OpacityLevel.opaque(), OpacityLevel.transparent(), duration_ms, EffectType.FADE)

    def is_fade_in(self) -> bool:
        return self.from_opacity.value < self.to_opacity.value and self.effect_type == EffectType.FADE

    def is_fade_out(self) -> bool:
        return self.from_opacity.value > self.to_opacity.value and self.effect_type == EffectType.FADE

    def reverse(self) -> OpacityTransition:
        return OpacityTransition(self.to_opacity, self.from_opacity, self.duration_ms, self.effect_type)


