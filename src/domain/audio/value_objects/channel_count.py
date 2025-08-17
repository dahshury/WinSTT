"""Channel count value object for audio configuration."""

from dataclasses import dataclass

from src.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class ChannelCount(ValueObject):
    """Channel count value object for audio operations."""
    value: int

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.value,)

    def __post_init__(self) -> None:
        """Validate the channel count value."""
        if self.value <= 0:
            msg = "Channel count must be positive"
            raise ValueError(msg)
        if self.value > 8:  # Reasonable limit for most audio applications
            msg = "Channel count cannot exceed 8"
            raise ValueError(msg)
    
    def __eq__(self, other: object) -> bool:
        """Check equality with another channel count."""
        if not isinstance(other, ChannelCount):
            return False
        return self.value == other.value
    
    def __hash__(self) -> int:
        """Hash based on value."""
        return hash(self.value)
    
    def __str__(self) -> str:
        """String representation."""
        return f"ChannelCount({self.value})"
    
    def __repr__(self) -> str:
        """Detailed string representation."""
        return f"ChannelCount(value={self.value})"
    
    @classmethod
    def mono(cls) -> "ChannelCount":
        """Create a mono channel count (1 channel)."""
        return cls(1)
    
    @classmethod
    def stereo(cls) -> "ChannelCount":
        """Create a stereo channel count (2 channels)."""
        return cls(2)
    
    @classmethod
    def surround_5_1(cls) -> "ChannelCount":
        """Create a 5.1 surround channel count (6 channels)."""
        return cls(6)
    
    @classmethod
    def surround_7_1(cls) -> "ChannelCount":
        """Create a 7.1 surround channel count (8 channels)."""
        return cls(8)
    
    def is_mono(self) -> bool:
        """Check if this is mono (1 channel)."""
        return self.value == 1
    
    def is_stereo(self) -> bool:
        """Check if this is stereo (2 channels)."""
        return self.value == 2
    
    def is_surround(self) -> bool:
        """Check if this is surround sound (more than 2 channels)."""
        return self.value > 2 