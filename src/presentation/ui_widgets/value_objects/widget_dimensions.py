"""Widget dimensions value object for UI widgets domain."""

from __future__ import annotations

from dataclasses import dataclass

from src.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class WidgetPosition(ValueObject):
    """Value object representing widget position."""
    
    x: int
    y: int
    
    def __post_init__(self) -> None:
        """Validate position."""
        # Allow negative positions for widgets that can be positioned outside their parent
    
    def move_by(self, dx: int, dy: int) -> WidgetPosition:
        """Create a new position moved by the given offset."""
        return WidgetPosition(x=self.x + dx, y=self.y + dy)
    
    def move_to(self, x: int, y: int) -> WidgetPosition:
        """Create a new position at the given coordinates."""
        return WidgetPosition(x=x, y=y)
    
    def distance_to(self, other: WidgetPosition) -> float:
        """Calculate distance to another position."""
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
    
    def is_origin(self) -> bool:
        """Check if position is at origin (0, 0)."""
        return self.x == 0 and self.y == 0
    
    @classmethod
    def origin(cls) -> WidgetPosition:
        """Create a position at origin."""
        return cls(x=0, y=0)
    
    @classmethod
    def top_left(cls) -> WidgetPosition:
        """Create a position at top-left (alias for origin)."""
        return cls.origin()


@dataclass(frozen=True)
class WidgetSize(ValueObject):
    """Value object representing widget size."""
    
    width: int
    height: int
    
    def __post_init__(self) -> None:
        """Validate size."""
        if self.width <= 0:
            msg = "Width must be positive"
            raise ValueError(msg)
        if self.height <= 0:
            msg = "Height must be positive"
            raise ValueError(msg)
    
    def scale(self, factor: float) -> WidgetSize:
        """Create a new size scaled by the given factor."""
        if factor <= 0:
            msg = "Scale factor must be positive"
            raise ValueError(msg)
        
        return WidgetSize(
            width=int(self.width * factor),
            height=int(self.height * factor),
        )
    
    def resize_to(self, width: int, height: int) -> WidgetSize:
        """Create a new size with given dimensions."""
        return WidgetSize(width=width, height=height)
    
    def expand_by(self, dw: int, dh: int) -> WidgetSize:
        """Create a new size expanded by the given amounts."""
        return WidgetSize(width=self.width + dw, height=self.height + dh)
    
    def get_area(self) -> int:
        """Calculate the area."""
        return self.width * self.height
    
    def get_aspect_ratio(self) -> float:
        """Calculate aspect ratio (width/height)."""
        if self.height == 0:
            msg = "Cannot calculate aspect ratio with zero height"
            raise ValueError(msg)
        return self.width / self.height
    
    def is_square(self) -> bool:
        """Check if size represents a square."""
        return self.width == self.height
    
    def fits_within(self, other: WidgetSize) -> bool:
        """Check if this size fits within another size."""
        return self.width <= other.width and self.height <= other.height
    
    @classmethod
    def square(cls, size: int) -> WidgetSize:
        """Create a square size."""
        return cls(width=size, height=size)
    
    @classmethod
    def minimum(cls) -> WidgetSize:
        """Create minimum valid size."""
        return cls(width=1, height=1)


@dataclass(frozen=True)
class WidgetDimensions:
    """Value object representing widget dimensions and positioning."""

    width: int
    height: int
    x: int | None = None
    y: int | None = None
    min_width: int | None = None
    min_height: int | None = None
    max_width: int | None = None
    max_height: int | None = None

    def __post_init__(self):
        """Validate widget dimensions."""
        self.validate()

    def validate(self) -> None:
        """Validate widget dimensions invariants."""
        if self.width <= 0:
            msg = "Width must be positive"
            raise ValueError(msg)
        if self.height <= 0:
            msg = "Height must be positive"
            raise ValueError(msg)

        if self.min_width is not None and self.min_width <= 0:
            msg = "Minimum width must be positive"
            raise ValueError(msg)
        if self.min_height is not None and self.min_height <= 0:
            msg = "Minimum height must be positive"
            raise ValueError(msg)

        if self.max_width is not None and self.max_width <= 0:
            msg = "Maximum width must be positive"
            raise ValueError(msg)
        if self.max_height is not None and self.max_height <= 0:
            msg = "Maximum height must be positive"
            raise ValueError(msg)

        if self.min_width is not None and self.max_width is not None:
            if self.min_width > self.max_width:
                msg = "Minimum width cannot be greater than maximum width"
                raise ValueError(msg)

        if self.min_height is not None and self.max_height is not None:
            if self.min_height > self.max_height:
                msg = "Minimum height cannot be greater than maximum height"
                raise ValueError(msg)

        if self.min_width is not None and self.width < self.min_width:
            msg = "Width cannot be less than minimum width"
            raise ValueError(msg)
        if self.min_height is not None and self.height < self.min_height:
            msg = "Height cannot be less than minimum height"
            raise ValueError(msg)

        if self.max_width is not None and self.width > self.max_width:
            msg = "Width cannot be greater than maximum width"
            raise ValueError(msg)
        if self.max_height is not None and self.height > self.max_height:
            msg = "Height cannot be greater than maximum height"
            raise ValueError(msg)

    def with_size(self, width: int, height: int,
    ) -> WidgetDimensions:
        """Create new dimensions with updated size."""
        return WidgetDimensions(
            width=width,
            height=height,
            x=self.x,
            y=self.y,
            min_width=self.min_width,
            min_height=self.min_height,
            max_width=self.max_width,
            max_height=self.max_height,
        )

    def with_position(self, x: int, y: int,
    ) -> WidgetDimensions:
        """Create new dimensions with updated position."""
        return WidgetDimensions(
            width=self.width,
            height=self.height,
            x=x,
            y=y,
            min_width=self.min_width,
            min_height=self.min_height,
            max_width=self.max_width,
            max_height=self.max_height,
        )

    def with_constraints(self, min_width: int | None = None, min_height: int | None = None,
                        max_width: int | None = None, max_height: int | None = None) -> WidgetDimensions:
        """Create new dimensions with updated size constraints."""
        return WidgetDimensions(
            width=self.width,
            height=self.height,
            x=self.x,
            y=self.y,
            min_width=min_width if min_width is not None else self.min_width,
            min_height=min_height if min_height is not None else self.min_height,
            max_width=max_width if max_width is not None else self.max_width,
            max_height=max_height if max_height is not None else self.max_height,
        )

    def scale(self, factor: float,
    ) -> WidgetDimensions:
        """Create new dimensions scaled by factor."""
        if factor <= 0:
            msg = "Scale factor must be positive"
            raise ValueError(msg)

        return WidgetDimensions(
            width=int(self.width * factor),
            height=int(self.height * factor),
            x=int(self.x * factor) if self.x is not None else None,
            y=int(self.y * factor) if self.y is not None else None,
            min_width=int(self.min_width * factor) if self.min_width is not None else None,
            min_height=int(self.min_height * factor) if self.min_height is not None else None,
            max_width=int(self.max_width * factor) if self.max_width is not None else None,
            max_height=int(self.max_height * factor) if self.max_height is not None else None,
        )

    def get_size(self) -> tuple[int, int]:
        """Get size as tuple (width, height)."""
        return (self.width, self.height)

    def get_position(self) -> tuple[int, int] | None:
        """Get position as tuple (x, y) if both are set."""
        if self.x is not None and self.y is not None:
            return (self.x, self.y)
        return None

    def get_area(self) -> int:
        """Calculate widget area."""
        return self.width * self.height

    def get_aspect_ratio(self) -> float:
        """Calculate aspect ratio (width/height)."""
        if self.height == 0:
            msg = "Cannot calculate aspect ratio with zero height"
            raise ValueError(msg)
        return self.width / self.height

    def is_square(self) -> bool:
        """Check if dimensions represent a square."""
        return self.width == self.height

    def is_within_constraints(self) -> bool:
        """Check if current size is within defined constraints."""
        if self.min_width is not None and self.width < self.min_width:
            return False
        if self.min_height is not None and self.height < self.min_height:
            return False
        if self.max_width is not None and self.width > self.max_width:
            return False
        return not (self.max_height is not None and self.height > self.max_height)

    def constrain_to_limits(self,
    ) -> WidgetDimensions:
        """Create new dimensions constrained to defined limits."""
        width = self.width
        height = self.height

        if self.min_width is not None:
            width = max(width, self.min_width)
        if self.max_width is not None:
            width = min(width, self.max_width)
        if self.min_height is not None:
            height = max(height, self.min_height)
        if self.max_height is not None:
            height = min(height, self.max_height)

        return self.with_size(width, height)

    def fits_within(self, container: WidgetDimensions,
    ) -> bool:
        """Check if this widget fits within container dimensions."""
        return self.width <= container.width and self.height <= container.height

    def center_within(self, container: WidgetDimensions,
    ) -> WidgetDimensions:
        """Create new dimensions centered within container."""
        if not self.fits_within(container):
            msg = "Widget does not fit within container"
            raise ValueError(msg)

        center_x = (container.width - self.width) // 2
        center_y = (container.height - self.height) // 2

        return self.with_position(center_x, center_y)

    @classmethod
    def create_square(
        cls,
        size: int,
        x: int | None = None,
        y: int | None = None) -> WidgetDimensions:
        """Create square dimensions."""
        return cls(width=size, height=size, x=x, y=y)

    @classmethod
    def create_fixed_size(cls, width: int, height: int,
    ) -> WidgetDimensions:
        """Create fixed size dimensions with equal min/max constraints."""
        return cls(
            width=width,
            height=height,
            min_width=width,
            min_height=height,
            max_width=width,
            max_height=height,
        )

    @classmethod
    def create_flexible(cls, width: int, height: int, min_width: int, min_height: int,
                       max_width: int | None = None, max_height: int | None = None) -> WidgetDimensions:
        """Create flexible dimensions with constraints."""
        return cls(
            width=width,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
        )