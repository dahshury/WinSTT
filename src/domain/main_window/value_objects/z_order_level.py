"""Z-Order level value object.

This module defines the ZOrderLevel value object for managing widget layering.
"""

from dataclasses import dataclass

from src.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class ZOrderLevel(ValueObject):
    """Value object representing a Z-order level for UI widgets."""
    
    value: int
    
    @classmethod
    def from_value(cls, value: int) -> "ZOrderLevel":
        """Create ZOrderLevel from integer value.
        
        Args:
            value: Integer Z-order value
            
        Returns:
            ZOrderLevel instance
        """
        return cls(value)
    
    def __post_init__(self) -> None:
        """Validate the Z-order level value."""
        if not isinstance(self.value, int):
            msg = "Z-order level must be an integer"
            raise ValueError(msg)
        if self.value < 0:
            msg = "Z-order level must be non-negative"
            raise ValueError(msg)
    
    def is_above(self, other: "ZOrderLevel") -> bool:
        """Check if this Z-order level is above another.
        
        Args:
            other: Other ZOrderLevel to compare
            
        Returns:
            True if this level is above the other
        """
        return self.value > other.value
    
    def is_below(self, other: "ZOrderLevel") -> bool:
        """Check if this Z-order level is below another.
        
        Args:
            other: Other ZOrderLevel to compare
            
        Returns:
            True if this level is below the other
        """
        return self.value < other.value
    
    def increment(self, amount: int = 1) -> "ZOrderLevel":
        """Create a new ZOrderLevel with incremented value.
        
        Args:
            amount: Amount to increment by
            
        Returns:
            New ZOrderLevel with incremented value
        """
        return ZOrderLevel(self.value + amount)
    
    def decrement(self, amount: int = 1) -> "ZOrderLevel":
        """Create a new ZOrderLevel with decremented value.
        
        Args:
            amount: Amount to decrement by
            
        Returns:
            New ZOrderLevel with decremented value
            
        Raises:
            ValueError: If resulting value would be negative
        """
        new_value = self.value - amount
        if new_value < 0:
            msg = "Z-order level cannot be negative"
            raise ValueError(msg)
        return ZOrderLevel(new_value)


# Common Z-order levels
BACKGROUND = ZOrderLevel(0)
NORMAL = ZOrderLevel(1) 
OVERLAY = ZOrderLevel(10)
POPUP = ZOrderLevel(100)
TOOLTIP = ZOrderLevel(1000)
