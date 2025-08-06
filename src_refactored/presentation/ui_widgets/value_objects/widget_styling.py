"""Widget styling value object for UI widgets domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common import ValueObject


class BorderStyle(Enum):
    """Border style enumeration."""
    NONE = "none"
    SOLID = "solid"
    DASHED = "dashed"
    DOTTED = "dotted"
    DOUBLE = "double"
    GROOVE = "groove"
    RIDGE = "ridge"
    INSET = "inset"
    OUTSET = "outset"


class FontWeight(Enum):
    """Font weight enumeration."""
    NORMAL = "normal"
    BOLD = "bold"
    LIGHTER = "lighter"
    BOLDER = "bolder"
    W100 = "100"
    W200 = "200"
    W300 = "300"
    W400 = "400"
    W500 = "500"
    W600 = "600"
    W700 = "700"
    W800 = "800"
    W900 = "900"


class FontStyle(Enum):
    """Font style enumeration."""
    NORMAL = "normal"
    ITALIC = "italic"
    OBLIQUE = "oblique"


class TextAlign(Enum):
    """Text alignment enumeration."""
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"
    JUSTIFY = "justify"


@dataclass(frozen=True)
class ColorValue:
    """Color value with validation."""
    value: str

    def __post_init__(self):
        """Validate color value."""
        if not self.value:
            msg = "Color value cannot be empty"
            raise ValueError(msg)

        # Basic validation for common color formats
        value = self.value.strip().lower()

        # Hex color validation
        if value.startswith("#"):
            hex_part = value[1:]
            if len(hex_part,
    ) not in [3, 6, 8]:  # #RGB, #RRGGBB, #RRGGBBAA
                msg = f"Invalid hex color format: {self.value}"
                raise ValueError(msg)
            try:
                int(hex_part, 16)
            except ValueError:
                msg = f"Invalid hex color value: {self.value}"
                raise ValueError(msg,
    )

        # RGB/RGBA validation
        elif value.startswith(("rgb(", "rgba(")):
            if not value.endswith(")"):
                msg = f"Invalid RGB color format: {self.value}"
                raise ValueError(msg)

        # HSL/HSLA validation
        elif value.startswith(("hsl(", "hsla(")):
            if not value.endswith(")"):
                msg = f"Invalid HSL color format: {self.value}"
                raise ValueError(msg)

        # Named colors are accepted as-is

    @classmethod
    def from_hex(cls, hex_value: str,
    ) -> ColorValue:
        """Create color from hex value."""
        if not hex_value.startswith("#"):
            hex_value = f"#{hex_value}"
        return cls(hex_value)

    @classmethod
    def from_rgb(cls, r: int, g: int, b: int, a: float | None = None) -> ColorValue:
        """Create color from RGB values."""
        if not all(0 <= val <= 255 for val in [r, g, b]):
            msg = "RGB values must be between 0 and 255"
            raise ValueError(msg)

        if a is not None:
            if not 0.0 <= a <= 1.0:
                msg = "Alpha value must be between 0.0 and 1.0"
                raise ValueError(msg,
    )
            return cls(f"rgba({r}, {g}, {b}, {a})")

        return cls(f"rgb({r}, {g}, {b})")

    @classmethod
    def from_name(cls, name: str,
    ) -> ColorValue:
        """Create color from named color."""
        return cls(name.lower())


@dataclass(frozen=True)
class BorderStyling:
    """Border styling configuration."""
    width: str | None = None
    style: BorderStyle | None = None
    color: ColorValue | None = None
    radius: str | None = None

    def to_css(self) -> str:
        """Convert to CSS border properties."""
        css_parts = []

        if self.width and self.style and self.color:
            css_parts.append(f"border: {self.width} {self.style.value} {self.color.value};")
        else:
            if self.width:
                css_parts.append(f"border-width: {self.width};")
            if self.style:
                css_parts.append(f"border-style: {self.style.value};")
            if self.color:
                css_parts.append(f"border-color: {self.color.value};")

        if self.radius:
            css_parts.append(f"border-radius: {self.radius};")

        return " ".join(css_parts)


@dataclass(frozen=True)
class FontStyling:
    """Font styling configuration."""
    family: str | None = None
    size: str | None = None
    weight: FontWeight | None = None
    style: FontStyle | None = None
    color: ColorValue | None = None
    line_height: str | None = None

    def to_css(self) -> str:
        """Convert to CSS font properties."""
        css_parts = []

        if self.family:
            css_parts.append(f"font-family: {self.family};")
        if self.size:
            css_parts.append(f"font-size: {self.size};")
        if self.weight:
            css_parts.append(f"font-weight: {self.weight.value};")
        if self.style:
            css_parts.append(f"font-style: {self.style.value};")
        if self.color:
            css_parts.append(f"color: {self.color.value};")
        if self.line_height:
            css_parts.append(f"line-height: {self.line_height};")

        return " ".join(css_parts)


@dataclass(frozen=True)
class WidgetStyling(ValueObject):
    """Value object representing widget styling properties."""

    background_color: ColorValue | None = None
    border: BorderStyling | None = None
    font: FontStyling | None = None
    padding: str | None = None
    margin: str | None = None
    opacity: float = 1.0
    text_align: TextAlign | None = None
    cursor: str | None = None
    box_shadow: str | None = None
    custom_properties: dict[str, str] | None = None

    def __post_init__(self):
        """Validate widget styling."""
        self.validate()

    def with_background_color(self, color: ColorValue,
    ) -> WidgetStyling:
        """Create new styling with updated background color."""
        return WidgetStyling(
            background_color=color,
            border=self.border,
            font=self.font,
            padding=self.padding,
            margin=self.margin,
            opacity=self.opacity,
            text_align=self.text_align,
            cursor=self.cursor,
            box_shadow=self.box_shadow,
            custom_properties=self.custom_properties,
        )

    def with_border(self, border: BorderStyling,
    ) -> WidgetStyling:
        """Create new styling with updated border."""
        return WidgetStyling(
            background_color=self.background_color,
            border=border,
            font=self.font,
            padding=self.padding,
            margin=self.margin,
            opacity=self.opacity,
            text_align=self.text_align,
            cursor=self.cursor,
            box_shadow=self.box_shadow,
            custom_properties=self.custom_properties,
        )

    def with_font(self, font: FontStyling,
    ) -> WidgetStyling:
        """Create new styling with updated font."""
        return WidgetStyling(
            background_color=self.background_color,
            border=self.border,
            font=font,
            padding=self.padding,
            margin=self.margin,
            opacity=self.opacity,
            text_align=self.text_align,
            cursor=self.cursor,
            box_shadow=self.box_shadow,
            custom_properties=self.custom_properties,
        )

    def with_opacity(self, opacity: float,
    ) -> WidgetStyling:
        """Create new styling with updated opacity."""
        return WidgetStyling(
            background_color=self.background_color,
            border=self.border,
            font=self.font,
            padding=self.padding,
            margin=self.margin,
            opacity=opacity,
            text_align=self.text_align,
            cursor=self.cursor,
            box_shadow=self.box_shadow,
            custom_properties=self.custom_properties,
        )

    def with_custom_property(self, key: str, value: str,
    ) -> WidgetStyling:
        """Create new styling with added custom property."""
        custom_props = dict(self.custom_properties) if self.custom_properties else {}
        custom_props[key] = value

        return WidgetStyling(
            background_color=self.background_color,
            border=self.border,
            font=self.font,
            padding=self.padding,
            margin=self.margin,
            opacity=self.opacity,
            text_align=self.text_align,
            cursor=self.cursor,
            box_shadow=self.box_shadow,
            custom_properties=custom_props,
        )

    def merge_with(self, other: WidgetStyling,
    ) -> WidgetStyling:
        """Merge with another styling, other takes precedence."""
        merged_custom = dict(self.custom_properties) if self.custom_properties else {}
        if other.custom_properties:
            merged_custom.update(other.custom_properties)

        return WidgetStyling(
            background_color=other.background_color or self.background_color,
            border=other.border or self.border,
            font=other.font or self.font,
            padding=other.padding or self.padding,
            margin=other.margin or self.margin,
            opacity=other.opacity if other.opacity != 1.0 else self.opacity,
            text_align=other.text_align or self.text_align,
            cursor=other.cursor or self.cursor,
            box_shadow=other.box_shadow or self.box_shadow,
            custom_properties=merged_custom if merged_custom else None,
        )

    def to_stylesheet(self) -> str:
        """Convert styling to CSS stylesheet string."""
        css_parts = []

        if self.background_color:
            css_parts.append(f"background-color: {self.background_color.value};")

        if self.border:
            border_css = self.border.to_css()
            if border_css:
                css_parts.append(border_css)

        if self.font:
            font_css = self.font.to_css()
            if font_css:
                css_parts.append(font_css)

        if self.padding:
            css_parts.append(f"padding: {self.padding};")

        if self.margin:
            css_parts.append(f"margin: {self.margin};")

        if self.opacity != 1.0:
            css_parts.append(f"opacity: {self.opacity};")

        if self.text_align:
            css_parts.append(f"text-align: {self.text_align.value};")

        if self.cursor:
            css_parts.append(f"cursor: {self.cursor};")

        if self.box_shadow:
            css_parts.append(f"box-shadow: {self.box_shadow};",
    )

        if self.custom_properties:
            for key, value in self.custom_properties.items():
                css_parts.append(f"{key}: {value};")

        return " ".join(css_parts)

    def get_property_names(self) -> list[str]:
        """Get list of all defined property names."""
        properties = []

        if self.background_color:
            properties.append("background-color")
        if self.border:
            properties.extend(["border", "border-radius"])
        if self.font:
            properties.extend(["font-family", "font-size", "font-weight", "font-style", "color", "line-height"])
        if self.padding:
            properties.append("padding")
        if self.margin:
            properties.append("margin")
        if self.opacity != 1.0:
            properties.append("opacity")
        if self.text_align:
            properties.append("text-align")
        if self.cursor:
            properties.append("cursor")
        if self.box_shadow:
            properties.append("box-shadow")
        if self.custom_properties:
            properties.extend(self.custom_properties.keys())

        return properties

    def is_empty(self) -> bool:
        """Check if styling has no defined properties."""
        return (
            self.background_color is None and
            self.border is None and
            self.font is None and
            self.padding is None and
            self.margin is None and
            self.opacity == 1.0 and
            self.text_align is None and
            self.cursor is None and
            self.box_shadow is None and
            not self.custom_properties
        )

    @classmethod
    def create_basic(cls, background_color: str | None = None,
                    border_color: str | None = None,
                    font_color: str | None = None) -> WidgetStyling:
        """Create basic styling with common properties."""
        bg_color = ColorValue(background_color) if background_color else None
        border = BorderStyling(color=ColorValue(border_color)) if border_color else None
        font = FontStyling(color=ColorValue(font_color)) if font_color else None

        return cls(
            background_color=bg_color,
            border=border,
            font=font,
        )

    @classmethod
    def create_button_style(cls, bg_color: str, text_color: str,
                           border_radius: str = "4px") -> WidgetStyling:
        """Create button-specific styling."""
        return cls(
            background_color=ColorValue(bg_color),
            border=BorderStyling(radius=border_radius),
            font=FontStyling(color=ColorValue(text_color), weight=FontWeight.NORMAL),
            padding="8px 16px",
            cursor="pointer",
        )

    def __invariants__(self) -> None:
        """Validate widget styling invariants."""
        if not 0.0 <= self.opacity <= 1.0:
            msg = "Opacity must be between 0.0 and 1.0"
            raise ValueError(msg,
    )

        if self.custom_properties:
            for key, value in self.custom_properties.items():
                if not key or not isinstance(key, str):
                    msg = "Custom property keys must be non-empty strings"
                    raise ValueError(msg)
                if not isinstance(value, str):
                    msg = "Custom property values must be strings"
                    raise ValueError(msg)