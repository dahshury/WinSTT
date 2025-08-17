"""Window configuration value objects for main window presentation layer."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject


class WindowState(Enum):
    """Window states."""
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"
    FULLSCREEN = "fullscreen"
    HIDDEN = "hidden"


class WindowBehavior(Enum):
    """Window behavior modes."""
    NORMAL = "normal"
    ALWAYS_ON_TOP = "always_on_top"
    STAY_ON_DESKTOP = "stay_on_desktop"
    TOOL_WINDOW = "tool_window"
    SPLASH_SCREEN = "splash_screen"


class ResizeMode(Enum):
    """Window resize modes."""
    RESIZABLE = "resizable"
    FIXED_SIZE = "fixed_size"
    HORIZONTAL_ONLY = "horizontal_only"
    VERTICAL_ONLY = "vertical_only"


@dataclass(frozen=True)
class WindowGeometry(ValueObject):
    """Window geometry configuration."""
    
    x: int
    y: int
    width: int
    height: int
    min_width: int | None = None
    min_height: int | None = None
    max_width: int | None = None
    max_height: int | None = None
    
    def __post_init__(self) -> None:
        """Validate window geometry."""
        if self.width <= 0 or self.height <= 0:
            msg = "Width and height must be positive"
            raise ValueError(msg)
        
        if self.min_width is not None and self.min_width <= 0:
            msg = "Minimum width must be positive"
            raise ValueError(msg)
        
        if self.min_height is not None and self.min_height <= 0:
            msg = "Minimum height must be positive"
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
    
    @classmethod
    def centered(
        cls,
        width: int,
        height: int,
        screen_width: int = 1920,
        screen_height: int = 1080,
    ) -> WindowGeometry:
        """Create centered window geometry."""
        x = (screen_width - width) // 2
        y = (screen_height - height) // 2
        return cls(x=x, y=y, width=width, height=height)
    
    @classmethod
    def default(cls) -> WindowGeometry:
        """Create default window geometry."""
        return cls.centered(800, 600)
    
    def move_to(self, x: int, y: int) -> WindowGeometry:
        """Create new geometry with different position."""
        return WindowGeometry(
            x=x,
            y=y,
            width=self.width,
            height=self.height,
            min_width=self.min_width,
            min_height=self.min_height,
            max_width=self.max_width,
            max_height=self.max_height,
        )
    
    def resize_to(self, width: int, height: int) -> WindowGeometry:
        """Create new geometry with different size."""
        return WindowGeometry(
            x=self.x,
            y=self.y,
            width=width,
            height=height,
            min_width=self.min_width,
            min_height=self.min_height,
            max_width=self.max_width,
            max_height=self.max_height,
        )
    
    def with_constraints(
        self,
        min_width: int | None = None,
        min_height: int | None = None,
        max_width: int | None = None,
        max_height: int | None = None,
    ) -> WindowGeometry:
        """Create new geometry with size constraints."""
        return WindowGeometry(
            x=self.x,
            y=self.y,
            width=self.width,
            height=self.height,
            min_width=min_width if min_width is not None else self.min_width,
            min_height=min_height if min_height is not None else self.min_height,
            max_width=max_width if max_width is not None else self.max_width,
            max_height=max_height if max_height is not None else self.max_height,
        )
    
    def get_position(self) -> tuple[int, int]:
        """Get position as tuple."""
        return (self.x, self.y)
    
    def get_size(self) -> tuple[int, int]:
        """Get size as tuple."""
        return (self.width, self.height)
    
    def get_center(self) -> tuple[int, int]:
        """Get center point of the window."""
        center_x = self.x + self.width // 2
        center_y = self.y + self.height // 2
        return (center_x, center_y)
    
    def is_within_bounds(self, screen_width: int, screen_height: int) -> bool:
        """Check if window is within screen bounds."""
        return (
            self.x >= 0 and
            self.y >= 0 and
            self.x + self.width <= screen_width and
            self.y + self.height <= screen_height
        )


@dataclass(frozen=True)
class WindowConfiguration(ValueObject):
    """Complete window configuration."""
    
    geometry: WindowGeometry
    state: WindowState = WindowState.NORMAL
    behavior: WindowBehavior = WindowBehavior.NORMAL
    resize_mode: ResizeMode = ResizeMode.RESIZABLE
    title: str = "WinSTT"
    icon_path: str | None = None
    opacity: float = 1.0
    is_visible: bool = True
    accepts_focus: bool = True
    show_in_taskbar: bool = True
    
    def __post_init__(self) -> None:
        """Validate window configuration."""
        if not (0.0 <= self.opacity <= 1.0):
            msg = "Opacity must be between 0.0 and 1.0"
            raise ValueError(msg)
        
        if not self.title:
            msg = "Title cannot be empty"
            raise ValueError(msg)
    
    @classmethod
    def default(cls) -> WindowConfiguration:
        """Create default window configuration."""
        return cls(geometry=WindowGeometry.default())
    
    @classmethod
    def main_window(cls, title: str = "WinSTT") -> WindowConfiguration:
        """Create main window configuration."""
        geometry = WindowGeometry.centered(800, 600).with_constraints(
            min_width=400,
            min_height=300,
        )
        return cls(
            geometry=geometry,
            title=title,
            behavior=WindowBehavior.NORMAL,
            resize_mode=ResizeMode.RESIZABLE,
        )
    
    @classmethod
    def dialog_window(cls, title: str, width: int = 400, height: int = 300) -> WindowConfiguration:
        """Create dialog window configuration."""
        geometry = WindowGeometry.centered(width, height)
        return cls(
            geometry=geometry,
            title=title,
            behavior=WindowBehavior.TOOL_WINDOW,
            resize_mode=ResizeMode.FIXED_SIZE,
            show_in_taskbar=False,
        )
    
    @classmethod
    def splash_screen(cls, width: int = 400, height: int = 200) -> WindowConfiguration:
        """Create splash screen configuration."""
        geometry = WindowGeometry.centered(width, height)
        return cls(
            geometry=geometry,
            title="",
            behavior=WindowBehavior.SPLASH_SCREEN,
            resize_mode=ResizeMode.FIXED_SIZE,
            show_in_taskbar=False,
            accepts_focus=False,
        )
    
    def with_geometry(self, geometry: WindowGeometry) -> WindowConfiguration:
        """Create new configuration with different geometry."""
        return WindowConfiguration(
            geometry=geometry,
            state=self.state,
            behavior=self.behavior,
            resize_mode=self.resize_mode,
            title=self.title,
            icon_path=self.icon_path,
            opacity=self.opacity,
            is_visible=self.is_visible,
            accepts_focus=self.accepts_focus,
            show_in_taskbar=self.show_in_taskbar,
        )
    
    def with_state(self, state: WindowState) -> WindowConfiguration:
        """Create new configuration with different state."""
        return WindowConfiguration(
            geometry=self.geometry,
            state=state,
            behavior=self.behavior,
            resize_mode=self.resize_mode,
            title=self.title,
            icon_path=self.icon_path,
            opacity=self.opacity,
            is_visible=self.is_visible,
            accepts_focus=self.accepts_focus,
            show_in_taskbar=self.show_in_taskbar,
        )
    
    def with_title(self, title: str) -> WindowConfiguration:
        """Create new configuration with different title."""
        return WindowConfiguration(
            geometry=self.geometry,
            state=self.state,
            behavior=self.behavior,
            resize_mode=self.resize_mode,
            title=title,
            icon_path=self.icon_path,
            opacity=self.opacity,
            is_visible=self.is_visible,
            accepts_focus=self.accepts_focus,
            show_in_taskbar=self.show_in_taskbar,
        )
    
    def with_opacity(self, opacity: float) -> WindowConfiguration:
        """Create new configuration with different opacity."""
        return WindowConfiguration(
            geometry=self.geometry,
            state=self.state,
            behavior=self.behavior,
            resize_mode=self.resize_mode,
            title=self.title,
            icon_path=self.icon_path,
            opacity=opacity,
            is_visible=self.is_visible,
            accepts_focus=self.accepts_focus,
            show_in_taskbar=self.show_in_taskbar,
        )
    
    def is_resizable(self) -> bool:
        """Check if window is resizable."""
        return self.resize_mode in [ResizeMode.RESIZABLE, ResizeMode.HORIZONTAL_ONLY, ResizeMode.VERTICAL_ONLY]
    
    def is_modal(self) -> bool:
        """Check if window behaves as modal."""
        return self.behavior in [WindowBehavior.TOOL_WINDOW, WindowBehavior.SPLASH_SCREEN]
    
    def is_always_on_top(self) -> bool:
        """Check if window stays on top."""
        return self.behavior == WindowBehavior.ALWAYS_ON_TOP
