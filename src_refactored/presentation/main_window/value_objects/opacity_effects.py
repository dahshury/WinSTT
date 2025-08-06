"""Opacity Effects Value Objects for presentation layer.

Moved from domain layer to presentation layer as this is UI-specific presentation logic.
This module defines value objects for opacity effects management including
results, phases, modes, effect types, and opacity levels.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class ManageResult(Enum):
    """Results for opacity effects management operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    EFFECT_ERROR = "effect_error"
    STATE_ERROR = "state_error"
    ANIMATION_ERROR = "animation_error"
    CANCELLED = "cancelled"


class ManagePhase(Enum):
    """Phases of opacity effects management process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    STATE_BACKUP = "state_backup"
    EFFECT_SETUP = "effect_setup"
    OPACITY_APPLICATION = "opacity_application"
    ANIMATION_SETUP = "animation_setup"
    STATE_MONITORING = "state_monitoring"
    FINALIZATION = "finalization"


class OpacityMode(Enum):
    """Opacity effect modes."""
    RECORDING = "recording"
    IDLE = "idle"
    TRANSITION = "transition"
    DISABLED = "disabled"
    CUSTOM = "custom"


class EffectType(Enum):
    """Types of opacity effects."""
    FADE = "fade"
    PULSE = "pulse"
    BLINK = "blink"
    SMOOTH = "smooth"
    INSTANT = "instant"


@dataclass(frozen=True)
class OpacityLevel(ValueObject):
    """Opacity level value object.
    
    Represents an opacity value with validation and utility methods.
    """
    value: float
    
    def __post_init__(self):
        """Validate opacity value."""
        if not 0.0 <= self.value <= 1.0:
            msg = f"Opacity must be between 0.0 and 1.0, got {self.value}"
            raise ValueError(msg)
    
    @classmethod
    def create(cls, value: float) -> Result[OpacityLevel]:
        """Create opacity level with validation.
        
        Args:
            value: Opacity value (0.0 to 1.0)
            
        Returns:
            Result containing OpacityLevel or error
        """
        try:
            return Result.success(cls(value))
        except ValueError as e:
            return Result.failure(str(e))
    
    @classmethod
    def transparent(cls) -> OpacityLevel:
        """Create fully transparent opacity."""
        return cls(0.0)
    
    @classmethod
    def opaque(cls) -> OpacityLevel:
        """Create fully opaque opacity."""
        return cls(1.0)
    
    @classmethod
    def semi_transparent(cls) -> OpacityLevel:
        """Create semi-transparent opacity (50%)."""
        return cls(0.5)
    
    @classmethod
    def from_percentage(cls, percentage: int) -> Result[OpacityLevel]:
        """Create opacity from percentage.
        
        Args:
            percentage: Percentage value (0 to 100)
            
        Returns:
            Result containing OpacityLevel or error
        """
        if not 0 <= percentage <= 100:
            return Result.failure(f"Percentage must be between 0 and 100, got {percentage}")
        
        return cls.create(percentage / 100.0)
    
    def to_percentage(self) -> int:
        """Convert to percentage.
        
        Returns:
            Percentage value (0 to 100)
        """
        return int(self.value * 100)
    
    def is_transparent(self) -> bool:
        """Check if fully transparent."""
        return self.value == 0.0
    
    def is_opaque(self) -> bool:
        """Check if fully opaque."""
        return self.value == 1.0
    
    def is_semi_transparent(self) -> bool:
        """Check if semi-transparent (not fully transparent or opaque)."""
        return 0.0 < self.value < 1.0
    
    def blend_with(self, other: OpacityLevel, factor: float = 0.5) -> Result[OpacityLevel]:
        """Blend with another opacity level.
        
        Args:
            other: Other opacity level
            factor: Blending factor (0.0 to 1.0)
            
        Returns:
            Result containing blended OpacityLevel
        """
        if not 0.0 <= factor <= 1.0:
            return Result.failure(f"Blend factor must be between 0.0 and 1.0, got {factor}")
        
        blended_value = self.value * (1.0 - factor) + other.value * factor
        return self.create(blended_value)
    
    def adjust(self, delta: float) -> Result[OpacityLevel]:
        """Adjust opacity by delta.
        
        Args:
            delta: Change in opacity (-1.0 to 1.0)
            
        Returns:
            Result containing adjusted OpacityLevel
        """
        new_value = self.value + delta
        return self.create(new_value)
    
    def multiply(self, factor: float) -> Result[OpacityLevel]:
        """Multiply opacity by factor.
        
        Args:
            factor: Multiplication factor (0.0 to positive)
            
        Returns:
            Result containing multiplied OpacityLevel
        """
        if factor < 0.0:
            return Result.failure(f"Factor must be non-negative, got {factor}")
        
        new_value = min(1.0, self.value * factor)
        return self.create(new_value)
    
    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.value,)
    
    def __str__(self) -> str:
        """String representation."""
        return f"OpacityLevel({self.value:.2f})"
    
    def __repr__(self) -> str:
        """Developer representation."""
        return f"OpacityLevel(value={self.value})"


@dataclass(frozen=True)
class OpacityTransition(ValueObject):
    """Opacity transition configuration.
    
    Defines how opacity changes from one level to another.
    """
    from_opacity: OpacityLevel
    to_opacity: OpacityLevel
    duration_ms: int
    effect_type: EffectType = EffectType.SMOOTH
    
    def __post_init__(self):
        """Validate transition configuration."""
        if self.duration_ms < 0:
            msg = f"Duration must be non-negative, got {self.duration_ms}"
            raise ValueError(msg)
    
    @classmethod
    def create(
        cls,
        from_opacity: OpacityLevel,
        to_opacity: OpacityLevel,
        duration_ms: int,
        effect_type: EffectType = EffectType.SMOOTH,
    ) -> Result[OpacityTransition]:
        """Create opacity transition with validation.
        
        Args:
            from_opacity: Starting opacity level
            to_opacity: Target opacity level
            duration_ms: Transition duration in milliseconds
            effect_type: Type of transition effect
            
        Returns:
            Result containing OpacityTransition or error
        """
        try:
            return Result.success(cls(from_opacity, to_opacity, duration_ms, effect_type))
        except ValueError as e:
            return Result.failure(str(e))
    
    @classmethod
    def fade_in(cls, duration_ms: int = 300) -> Result[OpacityTransition]:
        """Create fade-in transition.
        
        Args:
            duration_ms: Transition duration in milliseconds
            
        Returns:
            Result containing fade-in OpacityTransition
        """
        return cls.create(
            OpacityLevel.transparent(),
            OpacityLevel.opaque(),
            duration_ms,
            EffectType.FADE,
        )
    
    @classmethod
    def fade_out(cls, duration_ms: int = 300) -> Result[OpacityTransition]:
        """Create fade-out transition.
        
        Args:
            duration_ms: Transition duration in milliseconds
            
        Returns:
            Result containing fade-out OpacityTransition
        """
        return cls.create(
            OpacityLevel.opaque(),
            OpacityLevel.transparent(),
            duration_ms,
            EffectType.FADE,
        )
    
    def is_fade_in(self) -> bool:
        """Check if this is a fade-in transition."""
        return (self.from_opacity.value < self.to_opacity.value and
                self.effect_type == EffectType.FADE)
    
    def is_fade_out(self) -> bool:
        """Check if this is a fade-out transition."""
        return (self.from_opacity.value > self.to_opacity.value and
                self.effect_type == EffectType.FADE)
    
    def reverse(self) -> OpacityTransition:
        """Create reverse transition.
        
        Returns:
            Reversed OpacityTransition
        """
        return OpacityTransition(
            self.to_opacity,
            self.from_opacity,
            self.duration_ms,
            self.effect_type,
        )
    
    def with_duration(self, duration_ms: int) -> Result[OpacityTransition]:
        """Create transition with different duration.
        
        Args:
            duration_ms: New duration in milliseconds
            
        Returns:
            Result containing OpacityTransition with new duration
        """
        return self.create(
            self.from_opacity,
            self.to_opacity,
            duration_ms,
            self.effect_type,
        )
    
    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (self.from_opacity, self.to_opacity, self.duration_ms, self.effect_type)
    
    def __str__(self) -> str:
        """String representation."""
        return f"OpacityTransition({self.from_opacity.value:.2f} -> {self.to_opacity.value:.2f}, {self.duration_ms}ms)"
    
    def __repr__(self) -> str:
        """Developer representation."""
        return (f"OpacityTransition(from_opacity={self.from_opacity}, "
                f"to_opacity={self.to_opacity}, duration_ms={self.duration_ms}, "
                f"effect_type={self.effect_type})")