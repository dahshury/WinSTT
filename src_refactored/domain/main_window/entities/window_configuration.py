"""Window configuration entity.

This module contains the WindowConfiguration entity that manages window
configuration business rules and validation.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.result import Result
from src_refactored.domain.main_window.value_objects.icon_path import IconPath


class WindowSizePolicy(Enum):
    """Window size policy enumeration."""
    FIXED = "fixed"
    RESIZABLE = "resizable"
    MINIMUM = "minimum"
    MAXIMUM = "maximum"


class WindowFlags(Enum):
    """Window flags enumeration."""
    STAY_ON_TOP = "stay_on_top"
    FRAMELESS = "frameless"
    TOOL_WINDOW = "tool_window"
    MODAL = "modal"
    ACCEPT_DROPS = "accept_drops"


@dataclass
class WindowDimensions:
    """Window dimensions data."""
    width: int
    height: int
    min_width: int | None = None
    min_height: int | None = None
    max_width: int | None = None
    max_height: int | None = None

    def __post_init__(self) -> None:
        """Validate dimensions."""
        if self.width <= 0 or self.height <= 0:
            msg = "Width and height must be positive"
            raise ValueError(msg)
        if self.min_width and self.width < self.min_width:
            msg = "Width cannot be less than minimum width"
            raise ValueError(msg)
        if self.min_height and self.height < self.min_height:
            msg = "Height cannot be less than minimum height"
            raise ValueError(msg)
        if self.max_width and self.width > self.max_width:
            msg = "Width cannot be greater than maximum width"
            raise ValueError(msg)
        if self.max_height and self.height > self.max_height:
            msg = "Height cannot be greater than maximum height"
            raise ValueError(msg)

    @property
    def aspect_ratio(self) -> float:
        """Calculate aspect ratio."""
        return self.width / self.height

    @property
    def area(self) -> int:
        """Calculate area in pixels."""
        return self.width * self.height


class WindowConfiguration(Entity,
    ):
    """Window configuration entity.
    
    Manages window configuration business rules including dimensions,
    icon, title, and window properties.
    """

    def __init__(
        self,
        config_id: str,
        title: str,
        dimensions: WindowDimensions,
        icon_path: IconPath,
        size_policy: WindowSizePolicy = WindowSizePolicy.FIXED,
        flags: set[WindowFlags] | None = None,
        properties: dict[str, Any] | None = None,
    ):
        super().__init__(config_id)
        self._title = title
        self._dimensions = dimensions
        self._icon_path = icon_path
        self._size_policy = size_policy
        self._flags = flags or set()
        self._properties = properties or {}
        self.validate()

    @classmethod
    def create_default(cls) -> Result[WindowConfiguration]:
        """Create default window configuration."""
        try:
            # Default WinSTT window configuration
            dimensions = WindowDimensions(
                width=400,
                height=220,
                min_width=300,
                min_height=180,
                max_width=800,
                max_height=600,
            )

            icon_path = IconPath(path="resources/Windows 1 Theta.png")

            config = cls(
                config_id="default_window_config",
                title="WinSTT",
                dimensions=dimensions,
                icon_path=icon_path,
                size_policy=WindowSizePolicy.FIXED,
                flags={WindowFlags.ACCEPT_DROPS},
            )

            return Result.success(config)
        except Exception as e:
            return Result.failure(f"Failed to create default configuration: {e!s}")

    def update_title(self, title: str,
    ) -> Result[None]:
        """Update window title."""
        if not title or not title.strip():
            return Result.failure("Title cannot be empty")

        if len(title) > 100:
            return Result.failure("Title cannot exceed 100 characters")

        self._title = title.strip()
        self.mark_as_updated()
        return Result.success(None)

    def update_dimensions(self, dimensions: WindowDimensions,
    ) -> Result[None]:
        """Update window dimensions."""
        try:
            # Validate new dimensions
            if dimensions.width < 100 or dimensions.height < 100:
                return Result.failure("Minimum window size is 100x100")

            if dimensions.width > 3840 or dimensions.height > 2160:
                return Result.failure("Maximum window size is 3840x2160")

            self._dimensions = dimensions
            self.mark_as_updated()
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to update dimensions: {e!s}")

    def update_icon(self, icon_path: IconPath,
    ) -> Result[None]:
        """Update window icon."""
        # TODO: Add exists check through file system port if needed

        self._icon_path = icon_path
        self.mark_as_updated()
        return Result.success(None)

    def set_size_policy(self, policy: WindowSizePolicy,
    ) -> Result[None]:
        """Set window size policy."""
        self._size_policy = policy
        self.mark_as_updated()
        return Result.success(None)

    def add_flag(self, flag: WindowFlags,
    ) -> Result[None]:
        """Add window flag."""
        self._flags.add(flag)
        self.mark_as_updated()
        return Result.success(None)

    def remove_flag(self, flag: WindowFlags,
    ) -> Result[None]:
        """Remove window flag."""
        self._flags.discard(flag)
        self.mark_as_updated()
        return Result.success(None)

    def has_flag(self, flag: WindowFlags,
    ) -> bool:
        """Check if window has flag."""
        return flag in self._flags

    def set_property(self, key: str, value: Any,
    ) -> Result[None]:
        """Set configuration property."""
        if not key or not key.strip():
            return Result.failure("Property key cannot be empty")

        self._properties[key.strip()] = value
        self.mark_as_updated()
        return Result.success(None)

    def get_property(self, key: str, default: Any | None = None) -> Any:
        """Get configuration property."""
        return self._properties.get(key, default)

    def remove_property(self, key: str,
    ) -> Result[None]:
        """Remove configuration property."""
        if key in self._properties:
            del self._properties[key]
            self.mark_as_updated()
        return Result.success(None)

    # Properties
    @property
    def title(self) -> str:
        """Get window title."""
        return self._title

    @property
    def dimensions(self) -> WindowDimensions:
        """Get window dimensions."""
        return self._dimensions

    @property
    def icon_path(self) -> IconPath:
        """Get icon path."""
        return self._icon_path

    @property
    def size_policy(self) -> WindowSizePolicy:
        """Get size policy."""
        return self._size_policy

    @property
    def flags(self) -> set[WindowFlags]:
        """Get window flags."""
        return self._flags.copy()

    @property
    def properties(self) -> dict[str, Any]:
        """Get configuration properties."""
        return self._properties.copy()

    @property
    def is_fixed_size(self) -> bool:
        """Check if window has fixed size."""
        return self._size_policy == WindowSizePolicy.FIXED

    @property
    def accepts_drops(self) -> bool:
        """Check if window accepts drag and drop."""
        return WindowFlags.ACCEPT_DROPS in self._flags

    def __invariants__(self) -> None:
        """Validate window configuration invariants."""
        if not self._title or not self._title.strip():
            msg = "Window title cannot be empty"
            raise ValueError(msg)
        if not self._dimensions:
            msg = "Window dimensions are required"
            raise ValueError(msg)
        if not self._icon_path:
            msg = "Window icon path is required"
            raise ValueError(msg)
        if not isinstance(self._size_policy, WindowSizePolicy):
            msg = "Invalid size policy"
            raise ValueError(msg)
        if not isinstance(self._flags, set):
            msg = "Flags must be a set"
            raise ValueError(msg)
        if not isinstance(self._properties, dict):
            msg = "Properties must be a dictionary"
            raise ValueError(msg)