"""Color palette value object.

This module defines the ColorPalette value object for managing UI color schemes.
"""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class Color(ValueObject):
    """Value object representing a color."""
    
    red: int
    green: int
    blue: int
    alpha: int = 255
    
    @classmethod
    def from_hex(cls, hex_color: str) -> "Color":
        """Create Color from hex string.
        
        Args:
            hex_color: Hex color string (e.g., "#FF0000" or "FF0000")
            
        Returns:
            Color instance
        """
        hex_color = hex_color.lstrip("#")
        if len(hex_color) == 6:
            return cls(
                red=int(hex_color[0:2], 16),
                green=int(hex_color[2:4], 16),
                blue=int(hex_color[4:6], 16),
            )
        if len(hex_color) == 8:
            return cls(
                red=int(hex_color[0:2], 16),
                green=int(hex_color[2:4], 16),
                blue=int(hex_color[4:6], 16),
                alpha=int(hex_color[6:8], 16),
            )
        msg = f"Invalid hex color format: {hex_color}"
        raise ValueError(msg)
    
    @classmethod
    def from_rgb(cls, red: int, green: int, blue: int, alpha: int = 255) -> "Color":
        """Create Color from RGB values.
        
        Args:
            red: Red component (0-255)
            green: Green component (0-255)
            blue: Blue component (0-255)
            alpha: Alpha component (0-255)
            
        Returns:
            Color instance
        """
        return cls(red, green, blue, alpha)
    
    def __post_init__(self) -> None:
        """Validate color components."""
        for component, name in [(self.red, "red"), (self.green, "green"), 
                               (self.blue, "blue"), (self.alpha, "alpha")]:
            if not isinstance(component, int):
                msg = f"{name.capitalize()} component must be an integer"
                raise ValueError(msg)
            if not 0 <= component <= 255:
                msg = f"{name.capitalize()} component must be between 0 and 255"
                raise ValueError(msg)
    
    def to_hex(self, include_alpha: bool = False) -> str:
        """Convert to hex string.
        
        Args:
            include_alpha: Whether to include alpha channel
            
        Returns:
            Hex color string
        """
        if include_alpha:
            return f"#{self.red:02X}{self.green:02X}{self.blue:02X}{self.alpha:02X}"
        return f"#{self.red:02X}{self.green:02X}{self.blue:02X}"
    
    def to_rgba_tuple(self) -> tuple[int, int, int, int]:
        """Convert to RGBA tuple.
        
        Returns:
            Tuple of (red, green, blue, alpha)
        """
        return (self.red, self.green, self.blue, self.alpha)
    
    def with_alpha(self, alpha: int) -> "Color":
        """Create new Color with different alpha.
        
        Args:
            alpha: New alpha value (0-255)
            
        Returns:
            New Color with updated alpha
        """
        return Color(self.red, self.green, self.blue, alpha)


@dataclass(frozen=True)
class ColorPalette(ValueObject):
    """Value object representing a color palette for UI themes."""
    
    name: str
    primary: Color
    secondary: Color
    background: Color
    text: Color
    accent: Color | None = None
    error: Color | None = None
    warning: Color | None = None
    success: Color | None = None
    
    @classmethod
    def create_default_light(cls) -> "ColorPalette":
        """Create default light theme palette.
        
        Returns:
            Light theme ColorPalette
        """
        return cls(
            name="Light",
            primary=Color.from_hex("#2196F3"),     # Blue
            secondary=Color.from_hex("#FFC107"),   # Amber
            background=Color.from_hex("#FFFFFF"),  # White
            text=Color.from_hex("#212121"),        # Dark gray
            accent=Color.from_hex("#FF5722"),      # Deep orange
            error=Color.from_hex("#F44336"),       # Red
            warning=Color.from_hex("#FF9800"),     # Orange
            success=Color.from_hex("#4CAF50"),     # Green
        )
    
    @classmethod
    def create_default_dark(cls) -> "ColorPalette":
        """Create default dark theme palette.
        
        Returns:
            Dark theme ColorPalette
        """
        return cls(
            name="Dark",
            primary=Color.from_hex("#1976D2"),     # Dark blue
            secondary=Color.from_hex("#FFA000"),   # Dark amber
            background=Color.from_hex("#121212"),  # Dark gray
            text=Color.from_hex("#FFFFFF"),        # White
            accent=Color.from_hex("#FF3D00"),      # Deep orange accent
            error=Color.from_hex("#CF6679"),       # Light red
            warning=Color.from_hex("#FFB74D"),     # Light orange
            success=Color.from_hex("#81C784"),     # Light green
        )
    
    def __post_init__(self) -> None:
        """Validate the color palette."""
        if not isinstance(self.name, str) or not self.name.strip():
            msg = "Palette name must be a non-empty string"
            raise ValueError(msg)
    
    def get_color(self, color_role: str) -> Color | None:
        """Get color by role name.
        
        Args:
            color_role: Role name (primary, secondary, background, text, etc.)
            
        Returns:
            Color for the role, or None if not found
        """
        return getattr(self, color_role, None)
    
    def with_color(self, color_role: str, color: Color) -> "ColorPalette":
        """Create new palette with updated color.
        
        Args:
            color_role: Role name to update
            color: New color for the role
            
        Returns:
            New ColorPalette with updated color
        """
        
        # Valid color roles mapping
        valid_roles = {
            "name", "primary", "secondary", "background", "text", 
            "accent", "error", "warning", "success",
        }
        
        if color_role not in valid_roles:
            msg = f"Unknown color role: {color_role}"
            raise ValueError(msg)
        
        # Create kwargs dict with proper typing
        kwargs = {field: getattr(self, field) for field in valid_roles if hasattr(self, field)}
        kwargs[color_role] = color
        
        return ColorPalette(**kwargs)
    
    def is_dark_theme(self) -> bool:
        """Check if this is a dark theme.
        
        Returns:
            True if background is darker than text
        """
        bg_brightness = (self.background.red + self.background.green + self.background.blue) / 3
        text_brightness = (self.text.red + self.text.green + self.text.blue) / 3
        return bg_brightness < text_brightness
    
    def get_contrast_ratio(self, color1: Color, color2: Color) -> float:
        """Calculate contrast ratio between two colors.
        
        Args:
            color1: First color
            color2: Second color
            
        Returns:
            Contrast ratio (1.0 to 21.0)
        """
        def luminance(color: Color) -> float:
            """Calculate relative luminance of a color."""
            def gamma_correct(c: int) -> float:
                c_float = c / 255.0
                return c_float / 12.92 if c_float <= 0.03928 else ((c_float + 0.055) / 1.055) ** 2.4
            
            r = gamma_correct(color.red)
            g = gamma_correct(color.green)
            b = gamma_correct(color.blue)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        
        l1 = luminance(color1)
        l2 = luminance(color2)
        lighter = max(l1, l2)
        darker = min(l1, l2)
        return (lighter + 0.05) / (darker + 0.05)


# Common color palettes
DEFAULT_LIGHT_PALETTE = ColorPalette.create_default_light()
DEFAULT_DARK_PALETTE = ColorPalette.create_default_dark()

# Common colors
WHITE = Color.from_rgb(255, 255, 255)
BLACK = Color.from_rgb(0, 0, 0)
TRANSPARENT = Color.from_rgb(0, 0, 0, 0)
PRIMARY_BLUE = Color.from_hex("#2196F3")
SUCCESS_GREEN = Color.from_hex("#4CAF50")
ERROR_RED = Color.from_hex("#F44336")
WARNING_ORANGE = Color.from_hex("#FF9800")
