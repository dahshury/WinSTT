"""Color palette value object for presentation layer.

Moved from domain layer to presentation layer as this is UI-specific presentation logic.
This module contains the ColorPalette value object for managing UI color schemes.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class ColorRole(Enum):
    """Color role enumeration for UI elements."""
    WINDOW = "window"
    WINDOW_TEXT = "window_text"
    BASE = "base"
    ALTERNATE_BASE = "alternate_base"
    TOOLTIP_BASE = "tooltip_base"
    TOOLTIP_TEXT = "tooltip_text"
    TEXT = "text"
    BUTTON = "button"
    BUTTON_TEXT = "button_text"
    BRIGHT_TEXT = "bright_text"
    LINK = "link"
    HIGHLIGHT = "highlight"
    HIGHLIGHTED_TEXT = "highlighted_text"
    LIGHT = "light"
    MIDLIGHT = "midlight"
    DARK = "dark"
    MID = "mid"
    SHADOW = "shadow"


class PaletteTheme(Enum):
    """Predefined palette themes."""
    LIGHT = "light"
    DARK = "dark"
    SYSTEM = "system"
    CUSTOM = "custom"


@dataclass(frozen=True)
class Color:
    """RGB color representation."""
    red: int
    green: int
    blue: int
    alpha: int = 255

    def __post_init__(self,
    ):
        """Validate color values."""
        for component in [self.red, self.green, self.blue, self.alpha]:
            if not 0 <= component <= 255:
                msg = f"Color component must be between 0 and 255, got {component}"
                raise ValueError(msg)

    @classmethod
    def from_hex(cls, hex_color: str,
    ) -> Color:
        """Create color from hex string.
        
        Args:
            hex_color: Hex color string (e.g., '#FF0000' or 'FF0000')
            
        Returns:
            Color object
            
        Raises:
            ValueError: If hex string is invalid
        """
        hex_color = hex_color.lstrip("#")

        if len(hex_color) == 6:
            # RGB format
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            return cls(r, g, b)
        if len(hex_color) == 8:
            # RGBA format
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            a = int(hex_color[6:8], 16)
            return cls(r, g, b, a)
        msg = f"Invalid hex color format: {hex_color}"
        raise ValueError(msg)

    @classmethod
    def from_rgb(cls, r: int, g: int, b: int, a: int = 255,
    ) -> Color:
        """Create color from RGB values."""
        return cls(r, g, b, a)

    def to_hex(self, include_alpha: bool = False,
    ) -> str:
        """Convert to hex string.
        
        Args:
            include_alpha: Whether to include alpha channel
            
        Returns:
            Hex color string
        """
        if include_alpha:
            return f"#{self.red:02x}{self.green:02x}{self.blue:02x}{self.alpha:02x}"
        return f"#{self.red:02x}{self.green:02x}{self.blue:02x}"

    def to_rgb_tuple(self, include_alpha: bool = False,
    ) -> tuple[int, ...]:
        """Convert to RGB tuple.
        
        Args:
            include_alpha: Whether to include alpha channel
            
        Returns:
            RGB or RGBA tuple
        """
        if include_alpha:
            return (self.red, self.green, self.blue, self.alpha)
        return (self.red, self.green, self.blue)

    def with_alpha(self, alpha: int,
    ) -> Color:
        """Create new color with different alpha.
        
        Args:
            alpha: New alpha value (0-255)
            
        Returns:
            New Color with updated alpha
        """
        return Color(self.red, self.green, self.blue, alpha)

    def lighter(self, factor: float = 1.5) -> Color:
        """Create lighter version of color.
        
        Args:
            factor: Lightening factor (>1.0 for lighter,
    )
            
        Returns:
            Lighter color
        """
        r = min(255, int(self.red * factor))
        g = min(255, int(self.green * factor))
        b = min(255, int(self.blue * factor))
        return Color(r, g, b, self.alpha)

    def darker(self, factor: float = 0.7) -> Color:
        """Create darker version of color.
        
        Args:
            factor: Darkening factor (<1.0 for darker,
    )
            
        Returns:
            Darker color
        """
        r = max(0, int(self.red * factor))
        g = max(0, int(self.green * factor))
        b = max(0, int(self.blue * factor))
        return Color(r, g, b, self.alpha)


@dataclass(frozen=True)
class ColorPalette(ValueObject):
    """Color palette value object.
    
    Represents a complete color scheme for UI elements.
    """
    
    colors: dict[ColorRole, Color]
    theme: PaletteTheme = PaletteTheme.CUSTOM
    
    def __post_init__(self):
        """Validate color palette after initialization."""
        if not self.colors or not isinstance(self.colors, dict):
            msg = "Colors must be a non-empty dictionary"
            raise ValueError(msg)

        # Validate all keys are ColorRole and values are Color
        for role, color in self.colors.items():
            if not isinstance(role, ColorRole):
                msg = f"Invalid color role: {role}"
                raise ValueError(msg)
            if not isinstance(color, Color):
                msg = f"Invalid color for role {role}: {color}"
                raise ValueError(msg)

    @classmethod
    def create_light_theme(cls) -> ColorPalette:
        """Create light theme palette.
        
        Returns:
            Light theme ColorPalette
        """
        colors = {
            ColorRole.WINDOW: Color.from_rgb(240, 240, 240),
            ColorRole.WINDOW_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.BASE: Color.from_rgb(255, 255, 255),
            ColorRole.ALTERNATE_BASE: Color.from_rgb(247, 247, 247),
            ColorRole.TOOLTIP_BASE: Color.from_rgb(255, 255, 220),
            ColorRole.TOOLTIP_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.BUTTON: Color.from_rgb(240, 240, 240),
            ColorRole.BUTTON_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.BRIGHT_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.LINK: Color.from_rgb(0, 0, 255),
            ColorRole.HIGHLIGHT: Color.from_rgb(0, 120, 215),
            ColorRole.HIGHLIGHTED_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.LIGHT: Color.from_rgb(255, 255, 255),
            ColorRole.MIDLIGHT: Color.from_rgb(227, 227, 227),
            ColorRole.DARK: Color.from_rgb(160, 160, 160),
            ColorRole.MID: Color.from_rgb(160, 160, 160),
            ColorRole.SHADOW: Color.from_rgb(105, 105, 105),
        }
        return cls(colors, PaletteTheme.LIGHT)

    @classmethod
    def create_dark_theme(cls) -> ColorPalette:
        """Create dark theme palette.
        
        Returns:
            Dark theme ColorPalette
        """
        colors = {
            ColorRole.WINDOW: Color.from_rgb(53, 53, 53),
            ColorRole.WINDOW_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.BASE: Color.from_rgb(25, 25, 25),
            ColorRole.ALTERNATE_BASE: Color.from_rgb(53, 53, 53),
            ColorRole.TOOLTIP_BASE: Color.from_rgb(0, 0, 0),
            ColorRole.TOOLTIP_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.BUTTON: Color.from_rgb(53, 53, 53),
            ColorRole.BUTTON_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.BRIGHT_TEXT: Color.from_rgb(255, 0, 0),
            ColorRole.LINK: Color.from_rgb(42, 130, 218),
            ColorRole.HIGHLIGHT: Color.from_rgb(42, 130, 218),
            ColorRole.HIGHLIGHTED_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.LIGHT: Color.from_rgb(95, 95, 95),
            ColorRole.MIDLIGHT: Color.from_rgb(74, 74, 74),
            ColorRole.DARK: Color.from_rgb(35, 35, 35),
            ColorRole.MID: Color.from_rgb(44, 44, 44),
            ColorRole.SHADOW: Color.from_rgb(20, 20, 20),
        }
        return cls(colors, PaletteTheme.DARK)

    @classmethod
    def create_winstt_theme(cls) -> ColorPalette:
        """Create WinSTT-specific theme palette.
        
        Returns:
            WinSTT theme ColorPalette
        """
        # Based on the red theme from the original code
        red_color = Color.from_rgb(189, 46, 45)  # Main red color

        colors = {
            ColorRole.WINDOW: Color.from_rgb(240, 240, 240),
            ColorRole.WINDOW_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.BASE: Color.from_rgb(255, 255, 255),
            ColorRole.ALTERNATE_BASE: Color.from_rgb(247, 247, 247),
            ColorRole.TOOLTIP_BASE: Color.from_rgb(255, 255, 220),
            ColorRole.TOOLTIP_TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.TEXT: Color.from_rgb(0, 0, 0),
            ColorRole.BUTTON: red_color,
            ColorRole.BUTTON_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.BRIGHT_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.LINK: red_color,
            ColorRole.HIGHLIGHT: red_color,
            ColorRole.HIGHLIGHTED_TEXT: Color.from_rgb(255, 255, 255),
            ColorRole.LIGHT: red_color.lighter(1.3),
            ColorRole.MIDLIGHT: red_color.lighter(1.1),
            ColorRole.DARK: red_color.darker(0.7),
            ColorRole.MID: red_color.darker(0.8),
            ColorRole.SHADOW: red_color.darker(0.5),
        }
        return cls(colors, PaletteTheme.CUSTOM)

    @classmethod
    def from_dict(cls,
color_dict: dict[str, str | tuple[int, int, int] | tuple[int, int, int, int]], theme: PaletteTheme = PaletteTheme.CUSTOM,
    ) -> Result[ColorPalette]:
        """Create palette from dictionary.
        
        Args:
            color_dict: Dictionary with role names as keys and color values
            theme: Palette theme
            
        Returns:
            Result containing ColorPalette or error
        """
        try:
            colors = {}

            for role_name, color_value in color_dict.items():
                # Convert role name to ColorRole
                try:
                    role = ColorRole(role_name.lower())
                except ValueError:
                    return Result.failure(f"Invalid color role: {role_name}")

                # Convert color value to Color
                if isinstance(color_value, str):
                    color = Color.from_hex(color_value)
                elif isinstance(color_value, tuple | list):
                    if len(color_value) == 3 or len(color_value) == 4:
                        color = Color.from_rgb(*color_value)
                    else:
                        return Result.failure(f"Invalid color tuple length for {role_name}: {len(color_value)}")
                else:
                    return Result.failure(f"Invalid color value type for {role_name}: {type(color_value)}")

                colors[role] = color

            return Result.success(cls(colors, theme))
        except Exception as e:
            return Result.failure(f"Failed to create palette from dict: {e!s}")

    def get_color(self, role: ColorRole,
    ) -> Color | None:
        """Get color for specific role.
        
        Args:
            role: Color role
            
        Returns:
            Color for the role or None if not found
        """
        return self.colors.get(role)

    def get_color_or_default(self, role: ColorRole, default: Color,
    ) -> Color:
        """Get color for role or return default.
        
        Args:
            role: Color role
            default: Default color if role not found
            
        Returns:
            Color for the role or default
        """
        return self.colors.get(role, default)

    def has_role(self, role: ColorRole,
    ) -> bool:
        """Check if palette has color for role.
        
        Args:
            role: Color role to check
            
        Returns:
            True if role exists, False otherwise
        """
        return role in self.colors

    def with_color(self, role: ColorRole, color: Color,
    ) -> ColorPalette:
        """Create new palette with updated color.
        
        Args:
            role: Color role to update
            color: New color
            
        Returns:
            New ColorPalette with updated color
        """
        new_colors = self.colors.copy()
        new_colors[role] = color
        return ColorPalette(colors=new_colors, theme=self.theme)

    def without_role(self, role: ColorRole,
    ) -> ColorPalette:
        """Create new palette without specific role.
        
        Args:
            role: Color role to remove
            
        Returns:
            New ColorPalette without the role
        """
        new_colors = self.colors.copy()
        new_colors.pop(role, None)
        return ColorPalette(colors=new_colors, theme=self.theme)

    def merge_with(self, other: ColorPalette,
    ) -> ColorPalette:
        """Merge with another palette.
        
        Args:
            other: Other palette to merge with
            
        Returns:
            New ColorPalette with merged colors
        """
        merged_colors = self.colors.copy()
        merged_colors.update(other.colors)
        return ColorPalette(colors=merged_colors, theme=self.theme)

    def to_dict(self, hex_format: bool = True,
    ) -> dict[str, str | tuple[int, ...]]:
        """Convert to dictionary.
        
        Args:
            hex_format: Whether to use hex format for colors
            
        Returns:
            Dictionary representation
        """
        result: dict[str, str | tuple[int, ...]] = {}
        for role, color in self.colors.items():
            if hex_format:
                result[role.value] = color.to_hex(include_alpha=True)
            else:
                result[role.value] = color.to_rgb_tuple(include_alpha=True)
        return result

    def validate_completeness(self, required_roles: set[ColorRole] | None = None) -> Result[None]:
        """Validate that palette has all required roles.
        
        Args:
            required_roles: Set of required roles (defaults to all roles)
            
        Returns:
            Result indicating success or failure
        """
        if required_roles is None:
            required_roles = set(ColorRole)

        missing_roles = required_roles - set(self.colors.keys())
        if missing_roles:
            missing_names = [role.value for role in missing_roles]
            return Result.failure(f"Missing color roles: {', '.join(missing_names)}")

        return Result.success(None)

    def get_theme(self) -> PaletteTheme:
        """Get palette theme."""
        return self.theme

    @property
    def role_count(self) -> int:
        """Get number of color roles defined."""
        return len(self.colors)

    @property
    def roles(self) -> set[ColorRole]:
        """Get set of defined color roles."""
        return set(self.colors.keys())

    def __str__(self) -> str:
        """String representation."""
        return f"ColorPalette({self.theme.value}, {self.role_count} roles)"

    def __repr__(self) -> str:
        """Developer representation."""
        return f"ColorPalette(theme={self.theme.value}, colors={dict(self.colors)})"