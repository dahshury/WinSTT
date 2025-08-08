"""Z-order level value object.

This module contains the ZOrderLevel value object for managing UI element layering.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class ZOrderPreset(Enum):
    """Predefined z-order levels for common UI elements."""
    BACKGROUND = -1000
    VERY_LOW = -100
    LOW = -10
    NORMAL = 0
    ABOVE_NORMAL = 10
    HIGH = 100
    VERY_HIGH = 1000
    OVERLAY = 5000
    MODAL = 10000
    TOOLTIP = 15000
    POPUP = 20000
    ALWAYS_ON_TOP = 50000


class ZOrderCategory(Enum):
    """Z-order categories for UI element types."""
    BACKGROUND_LAYER = "background"
    CONTENT_LAYER = "content"
    UI_LAYER = "ui"
    OVERLAY_LAYER = "overlay"
    MODAL_LAYER = "modal"
    SYSTEM_LAYER = "system"


class ZOrderType(Enum):
    """Types of z-order operations and behaviors."""
    ABSOLUTE = "absolute"  # Set absolute z-order value
    RELATIVE = "relative"  # Set relative to another element
    BRING_TO_FRONT = "bring_to_front"  # Bring to front of all elements
    SEND_TO_BACK = "send_to_back"  # Send to back of all elements
    RAISE_ABOVE = "raise_above"  # Raise above specific element
    LOWER_BELOW = "lower_below"  # Lower below specific element
    AUTO = "auto"  # Automatically determine based on context


@dataclass(frozen=True)
class ZOrderLevel(ValueObject):
    """Z-order level value object.
    
    Represents the stacking order of UI elements, where higher values
    appear in front of lower values.
    """
    value: int

    MIN_Z_ORDER = -100000
    MAX_Z_ORDER = 100000

    def __post_init__(self):
        """Validate z-order value."""
        if not isinstance(self.value, int):
            try:
                int(self.value)
            except (ValueError, TypeError):
                msg = f"Z-order value must be an integer, got {type(self.value)}"
                raise ValueError(msg)

        if not (self.MIN_Z_ORDER <= self.value <= self.MAX_Z_ORDER):
            msg = (
                f"Z-order value must be between {self.MIN_Z_ORDER} and {self.MAX_Z_ORDER}, "
                f"got {self.value}"
            )
            raise ValueError(msg)

    @classmethod
    def from_value(cls, value: float,
    ) -> Result[ZOrderLevel]:
        """Create ZOrderLevel from numeric value with validation.
        
        Args:
            value: Z-order value
            
        Returns:
            Result containing ZOrderLevel or error
        """
        try:
            return Result.success(cls(int(value)))
        except ValueError as e:
            return Result.failure(str(e))

    @classmethod
    def from_preset(cls, preset: ZOrderPreset,
    ) -> ZOrderLevel:
        """Create ZOrderLevel from preset.
        
        Args:
            preset: Z-order preset
            
        Returns:
            ZOrderLevel with preset value
        """
        return cls(preset.value)

    @classmethod
    def normal(cls) -> ZOrderLevel:
        """Create normal z-order level (0).
        
        Returns:
            Normal ZOrderLevel
        """
        return cls(ZOrderPreset.NORMAL.value)

    @classmethod
    def background(cls) -> ZOrderLevel:
        """Create background z-order level.
        
        Returns:
            Background ZOrderLevel
        """
        return cls(ZOrderPreset.BACKGROUND.value)

    @classmethod
    def overlay(cls) -> ZOrderLevel:
        """Create overlay z-order level.
        
        Returns:
            Overlay ZOrderLevel
        """
        return cls(ZOrderPreset.OVERLAY.value)

    @classmethod
    def modal(cls) -> ZOrderLevel:
        """Create modal z-order level.
        
        Returns:
            Modal ZOrderLevel
        """
        return cls(ZOrderPreset.MODAL.value)

    @classmethod
    def always_on_top(cls) -> ZOrderLevel:
        """Create always-on-top z-order level.
        
        Returns:
            Always-on-top ZOrderLevel
        """
        return cls(ZOrderPreset.ALWAYS_ON_TOP.value)

    @classmethod
    def for_winstt_elements(cls) -> dict[str, ZOrderLevel]:
        """Get z-order levels for WinSTT UI elements.
        
        Based on the original code's raising order:
        graphicsView_2, label, label_3, progressBar, label_4, 
        voice_visualizer, instruction_label, label_2, WinSTT, settingsButton
        
        Returns:
            Dictionary mapping element names to z-order levels
        """
        return {
            "graphicsView_2": cls(10),      # Background graphics view
            "label": cls(20),               # Logo label
            "label_3": cls(30),             # Status label
            "progressBar": cls(40),         # Progress bar
            "label_4": cls(50),             # Additional label
            "voice_visualizer": cls(60),    # Voice visualizer
            "instruction_label": cls(70),   # Instruction label
            "label_2": cls(80),             # Another label
            "WinSTT": cls(90),              # Main title
            "settingsButton": cls(100),     # Settings button (topmost)
        }

    def increase(self, amount: int,
    ) -> Result[ZOrderLevel]:
        """Increase z-order by amount.
        
        Args:
            amount: Amount to increase
            
        Returns:
            Result containing new ZOrderLevel or error
        """
        new_value = self.value + amount
        return ZOrderLevel.from_value(new_value)

    def decrease(self, amount: int,
    ) -> Result[ZOrderLevel]:
        """Decrease z-order by amount.
        
        Args:
            amount: Amount to decrease (must be positive)
            
        Returns:
            Result containing new ZOrderLevel or error
        """
        if amount < 0:
            return Result.failure("Decrease amount must be positive")
        return self.increase(-amount)

    def bring_to_front(self, reference_level: ZOrderLevel, offset: int = 1,
    ) -> ZOrderLevel:
        """Bring this level in front of reference level.
        
        Args:
            reference_level: Reference z-order level
            offset: Offset to add above reference level
            
        Returns:
            New ZOrderLevel in front of reference
        """
        new_value = max(reference_level.value + offset, self.value)
        # Clamp to valid range
        new_value = min(new_value, self.MAX_Z_ORDER)
        return ZOrderLevel(new_value)

    def send_to_back(self, reference_level: ZOrderLevel, offset: int = 1,
    ) -> ZOrderLevel:
        """Send this level behind reference level.
        
        Args:
            reference_level: Reference z-order level
            offset: Offset to subtract below reference level
            
        Returns:
            New ZOrderLevel behind reference
        """
        new_value = min(reference_level.value - offset, self.value)
        # Clamp to valid range
        new_value = max(new_value, self.MIN_Z_ORDER)
        return ZOrderLevel(new_value)

    def clamp_to_range(self, min_level: int, max_level: int,
    ) -> Result[ZOrderLevel]:
        """Clamp z-order to specified range.
        
        Args:
            min_level: Minimum z-order value
            max_level: Maximum z-order value
            
        Returns:
            Result containing clamped ZOrderLevel or error
        """
        if min_level < self.MIN_Z_ORDER or max_level > self.MAX_Z_ORDER:
            return Result.failure(
                f"Range must be within {self.MIN_Z_ORDER}-{self.MAX_Z_ORDER}",
            )

        if min_level > max_level:
            return Result.failure("Minimum level cannot be greater than maximum")

        clamped_value = max(min_level, min(max_level, self.value))
        return ZOrderLevel.from_value(clamped_value)

    def get_category(self) -> ZOrderCategory:
        """Get the category this z-order level belongs to.
        
        Returns:
            ZOrderCategory based on the value range
        """
        if self.value < -500:
            return ZOrderCategory.BACKGROUND_LAYER
        if self.value < 0:
            return ZOrderCategory.CONTENT_LAYER
        if self.value < 1000:
            return ZOrderCategory.UI_LAYER
        if self.value < 10000:
            return ZOrderCategory.OVERLAY_LAYER
        if self.value < 50000:
            return ZOrderCategory.MODAL_LAYER
        return ZOrderCategory.SYSTEM_LAYER

    def get_closest_preset(self) -> ZOrderPreset:
        """Get the closest predefined preset.
        
        Returns:
            Closest ZOrderPreset
        """
        closest_preset = ZOrderPreset.NORMAL
        min_distance = abs(self.value - ZOrderPreset.NORMAL.value)

        for preset in ZOrderPreset:
            distance = abs(self.value - preset.value,
    )
            if distance < min_distance:
                min_distance = distance
                closest_preset = preset

        return closest_preset

    def is_in_front_of(self, other: ZOrderLevel,
    ) -> bool:
        """Check if this level is in front of another.
        
        Args:
            other: Other z-order level
            
        Returns:
            True if this level is in front, False otherwise
        """
        return self.value > other.value

    def is_behind(self, other: ZOrderLevel,
    ) -> bool:
        """Check if this level is behind another.
        
        Args:
            other: Other z-order level
            
        Returns:
            True if this level is behind, False otherwise
        """
        return self.value < other.value

    def is_same_level(self, other: ZOrderLevel,
    ) -> bool:
        """Check if this level is the same as another.
        
        Args:
            other: Other z-order level
            
        Returns:
            True if levels are the same, False otherwise
        """
        return self.value == other.value

    def distance_from(self, other: ZOrderLevel,
    ) -> int:
        """Get distance from another z-order level.
        
        Args:
            other: Other z-order level
            
        Returns:
            Absolute distance between levels
        """
        return abs(self.value - other.value)

    def is_background(self) -> bool:
        """Check if this is a background level.
        
        Returns:
            True if background level, False otherwise
        """
        return self.value < 0

    def is_foreground(self) -> bool:
        """Check if this is a foreground level.
        
        Returns:
            True if foreground level, False otherwise
        """
        return self.value > 0

    def is_normal(self) -> bool:
        """Check if this is normal level (0).
        
        Returns:
            True if normal level, False otherwise
        """
        return self.value == 0

    def to_qt_value(self) -> int:
        """Convert to Qt-compatible z-value.
        
        Returns:
            Qt-compatible z-order value
        """
        return self.value

    def __add__(self, other: ZOrderLevel | int) -> Result[ZOrderLevel]:
        """Add z-order levels or values.
        
        Args:
            other: Other z-order level or integer value
            
        Returns:
            Result containing new ZOrderLevel or error
        """
        if isinstance(other, ZOrderLevel):
            return self.increase(other.value)
        if isinstance(other, int):
            return self.increase(other)
        return Result.failure(f"Cannot add {type(other)} to ZOrderLevel")

    def __sub__(self, other: ZOrderLevel | int) -> Result[ZOrderLevel]:
        """Subtract z-order levels or values.
        
        Args:
            other: Other z-order level or integer value
            
        Returns:
            Result containing new ZOrderLevel or error
        """
        if isinstance(other, ZOrderLevel):
            return self.increase(-other.value)
        if isinstance(other, int):
            return self.increase(-other)
        return Result.failure(f"Cannot subtract {type(other)} from ZOrderLevel")

    def __lt__(self, other: ZOrderLevel,
    ) -> bool:
        """Less than comparison (behind)."""
        if not isinstance(other, ZOrderLevel):
            return NotImplemented
        return self.value < other.value

    def __le__(self, other: ZOrderLevel,
    ) -> bool:
        """Less than or equal comparison."""
        if not isinstance(other, ZOrderLevel):
            return NotImplemented
        return self.value <= other.value

    def __gt__(self, other: ZOrderLevel,
    ) -> bool:
        """Greater than comparison (in front)."""
        if not isinstance(other, ZOrderLevel):
            return NotImplemented
        return self.value > other.value

    def __ge__(self, other: ZOrderLevel,
    ) -> bool:
        """Greater than or equal comparison."""
        if not isinstance(other, ZOrderLevel):
            return NotImplemented
        return self.value >= other.value

    def __str__(self) -> str:
        """String representation."""
        return str(self.value)

    def __repr__(self) -> str:
        """Developer representation."""
        preset = self.get_closest_preset()
        category = self.get_category()
        return f"ZOrderLevel({self.value}, closest={preset.name}, category={category.value})"