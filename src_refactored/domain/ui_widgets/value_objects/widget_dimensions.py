"""Widget dimensions value object for UI widgets domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class WidgetDimensions(ValueObject):
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
max_width: int | None = (
    None, max_height: int | None = None) -> WidgetDimensions:)
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
            width=int(self.width * factor,
    )
            height=int(self.height * factor)
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
max_width: int | None = (
    None, max_height: int | None = None) -> WidgetDimensions:)
        """Create flexible dimensions with constraints."""
        return cls(
            width=width,
            height=height,
            min_width=min_width,
            min_height=min_height,
            max_width=max_width,
            max_height=max_height,
        )

    def __invariants__(self) -> None:
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
            raise ValueError(msg,
    )