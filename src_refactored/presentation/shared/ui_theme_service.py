"""UI Theme Service.

This service provides centralized theme management for consistent
styling across UI components.
"""

from dataclasses import dataclass


@dataclass
class ColorPalette:
    """Color palette for the application theme."""
    primary_text: str = "rgb(144, 164, 174)"
    background_dark: str = "rgb(20, 27, 31)"
    border_accent: str = "rgb(78, 106, 129)"
    border_accent_hover: str = "rgba(78, 106, 129, 0.5)"
    instruction_text: str = "rgba(169, 169, 169, 1)"
    progress_background: str = "rgb(8, 11, 14)"


class UIThemeService:
    """Service for managing UI themes and styles."""
    
    def __init__(self):
        self._colors = ColorPalette()
        self._styles = self._create_style_definitions()
    
    def _create_style_definitions(self) -> dict[str, str]:
        """Create predefined style definitions."""
        return {
            "title": f"color: {self._colors.primary_text};",
            "status": f"color: {self._colors.primary_text};",
            "instruction": f"""
                color: {self._colors.instruction_text};
                font-style: italic;
            """,
            "button_transparent": f"""
                QPushButton {{
                    background-color: transparent;
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: {self._colors.border_accent};
                }}
                QPushButton:hover {{
                    background-color: {self._colors.border_accent_hover};
                }}
            """,
            "progress_bar": f"""
                QProgressBar {{
                    background-color: {self._colors.progress_background};
                    color: {self._colors.primary_text};
                    border-radius: 5px;
                }}
            """,
        }
    
    def get_text_style(self, style_name: str) -> str:
        """Get a text style by name."""
        return self._styles.get(style_name, "")
    
    def get_widget_style(self, style_name: str) -> str:
        """Get a widget style by name."""
        return self._styles.get(style_name, "")
    
    def get_color(self, color_name: str) -> str:
        """Get a color value by name."""
        return getattr(self._colors, color_name, "#FFFFFF")

