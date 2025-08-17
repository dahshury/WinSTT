"""UI Text Value Objects.

This module defines value objects for UI text styling and formatting.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.domain.common.value_object import ValueObject


class FontFamily(Enum):
    """Font families supported by the application."""
    SYSTEM = "system"
    SANS_SERIF = "sans-serif"
    SERIF = "serif"
    MONOSPACE = "monospace"
    ARIAL = "Arial"
    HELVETICA = "Helvetica"
    TIMES = "Times New Roman"
    COURIER = "Courier New"
    SEGOE_UI = "Segoe UI"
    ROBOTO = "Roboto"


class FontSize(Enum):
    """Standard font sizes for the application."""
    TINY = 8
    SMALL = 10
    NORMAL = 12
    MEDIUM = 14
    LARGE = 16
    EXTRA_LARGE = 18
    HUGE = 24
    TITLE = 28
    HEADER = 32


class FontWeight(Enum):
    """Font weight options."""
    THIN = 100
    LIGHT = 300
    NORMAL = 400
    MEDIUM = 500
    SEMI_BOLD = 600
    BOLD = 700
    EXTRA_BOLD = 800
    BLACK = 900


class TextAlignment(Enum):
    """Text alignment options."""
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"
    JUSTIFY = "justify"


@dataclass(frozen=True)
class UIText(ValueObject):
    """UI text value object with styling information."""
    
    text: str
    font_family: FontFamily = FontFamily.SYSTEM
    font_size: FontSize = FontSize.NORMAL
    font_weight: FontWeight = FontWeight.NORMAL
    alignment: TextAlignment = TextAlignment.LEFT
    color: str | None = None
    is_bold: bool = False
    is_italic: bool = False
    is_underlined: bool = False
    
    def __post_init__(self) -> None:
        """Validate text content."""
        if not isinstance(self.text, str):
            msg = "Text must be a string"
            raise ValueError(msg)
    
    def with_text(self, text: str) -> UIText:
        """Create a new UIText with different text content."""
        return UIText(
            text=text,
            font_family=self.font_family,
            font_size=self.font_size,
            font_weight=self.font_weight,
            alignment=self.alignment,
            color=self.color,
            is_bold=self.is_bold,
            is_italic=self.is_italic,
            is_underlined=self.is_underlined,
        )
    
    def with_style(
        self,
        font_family: FontFamily | None = None,
        font_size: FontSize | None = None,
        font_weight: FontWeight | None = None,
        alignment: TextAlignment | None = None,
        color: str | None = None,
        is_bold: bool | None = None,
        is_italic: bool | None = None,
        is_underlined: bool | None = None,
    ) -> UIText:
        """Create a new UIText with different styling."""
        return UIText(
            text=self.text,
            font_family=font_family if font_family is not None else self.font_family,
            font_size=font_size if font_size is not None else self.font_size,
            font_weight=font_weight if font_weight is not None else self.font_weight,
            alignment=alignment if alignment is not None else self.alignment,
            color=color if color is not None else self.color,
            is_bold=is_bold if is_bold is not None else self.is_bold,
            is_italic=is_italic if is_italic is not None else self.is_italic,
            is_underlined=is_underlined if is_underlined is not None else self.is_underlined,
        )