"""Widget Styling Service for CSS management and widget styling.

This service provides centralized widget styling functionality with CSS management,
extracted from settings_dialog.py (lines 36-57, 73-105, 199-240).
"""

from typing import ClassVar

from PyQt6.QtWidgets import QComboBox, QFrame, QGroupBox, QLineEdit, QPushButton, QTextEdit, QWidget


class WidgetStylingService:
    """Service for managing widget styling and CSS templates.
    
    Extracted from settings_dialog.py styling patterns.
    """

    # Default color scheme
    DEFAULT_COLORS: ClassVar[dict[str, str]] = {
        "dialog_bg": "#141b1f",
        "section_bg": "#0c0e13",
        "text_color": "rgb(144, 164, 174)",
        "border_color": "rgb(78, 106, 129)",
        "divider_color": "rgba(78, 106, 129, 80)",
        "accent_color": "rgb(0, 122, 255)",
        "button_bg": "rgb(54, 71, 84)",
        "button_hover": "rgb(74, 91, 104)",
        "input_bg": "rgb(34, 51, 64)",
        "input_border": "rgb(78, 106, 129)",
    }

    def __init__(self, custom_colors: dict[str, str] | None = None):
        """Initialize the styling service.
        
        Args:
            custom_colors: Optional custom color overrides
        """
        self.colors = self.DEFAULT_COLORS.copy()
        if custom_colors:
            self.colors.update(custom_colors)

        self._initialize_templates()

    def _initialize_templates(self) -> None:
        """Initialize CSS templates with current colors."""
        self.section_style_template = """
            QGroupBox {{
                color: {text_color};
                border: 1px solid {border_color};
                border-radius: 3px;
                margin-top: 10px;
                background-color: {bg_color};
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                subcontrol-position: top left;
                padding: 0 3px;
            }}
        """

        self.divider_style = """
            QFrame {{
                color: {divider_color};
                background-color: rgba(78, 106, 129, 0);
            }}
        """

        self.dialog_style = """
            QDialog {{
                background-color: {dialog_bg};
            }}
        """

        self.combo_box_style = """
            QComboBox {{
                background-color: {input_bg};
                border: 1px solid {input_border};
                border-radius: 3px;
                padding: 2px 5px;
                color: white;
                min-height: 20px;
            }}
            QComboBox QAbstractItemView {{
                background-color: {input_bg};
                border: 1px solid {input_border};
                selection-background-color: {accent_color};
                color: white;
            }}
        """

        self.button_style = """
            QPushButton {{
                background-color: {button_bg};
                border: 1px solid {border_color};
                border-radius: 3px;
                padding: 5px 10px;
                color: white;
                font-weight: bold;
            }}
            QPushButton:hover {{
                background-color: {button_hover};
            }}
            QPushButton:pressed {{
                background-color: {accent_color};
            }}
        """

        self.line_edit_style = """
            QLineEdit {{
                background-color: {input_bg};
                border: 1px solid {input_border};
                border-radius: 3px;
                padding: 5px;
                color: white;
                selection-background-color: {accent_color};
            }}
            QLineEdit:focus {{
                border: 2px solid {accent_color};
            }}
        """

        self.text_edit_style = """
            QTextEdit {{
                background-color: {input_bg};
                border: 1px solid {input_border};
                border-radius: 3px;
                padding: 5px;
                color: white;
                selection-background-color: {accent_color};
            }}
            QTextEdit:focus {{
                border: 2px solid {accent_color};
            }}
        """

    def apply_dialog_style(self, dialog: QWidget,
    ) -> None:
        """Apply dialog styling.
        
        Args:
            dialog: Dialog widget to style
        """
        dialog.setStyleSheet(self.dialog_style.format(**self.colors))

    def apply_section_style(self, group_box: QGroupBox, bg_color: str | None = None) -> None:
        """Apply section group box styling.
        
        Args:
            group_box: Group box widget to style
            bg_color: Optional custom background color
        """
        colors = self.colors.copy()
        if bg_color:
            colors["bg_color"] = bg_color
        else:
            colors["bg_color"] = self.colors["section_bg"]

        group_box.setStyleSheet(self.section_style_template.format(**colors))

    def apply_divider_style(self, frame: QFrame,
    ) -> None:
        """Apply divider styling.
        
        Args:
            frame: Frame widget to style as divider
        """
        frame.setStyleSheet(self.divider_style.format(**self.colors))

    def apply_combo_box_style(self, combo_box: QComboBox,
    ) -> None:
        """Apply combo box styling.
        
        Args:
            combo_box: Combo box widget to style
        """
        combo_box.setStyleSheet(self.combo_box_style.format(**self.colors))

    def apply_button_style(self, button: QPushButton,
    ) -> None:
        """Apply button styling.
        
        Args:
            button: Button widget to style
        """
        button.setStyleSheet(self.button_style.format(**self.colors))

    def apply_line_edit_style(self, line_edit: QLineEdit,
    ) -> None:
        """Apply line edit styling.
        
        Args:
            line_edit: Line edit widget to style
        """
        line_edit.setStyleSheet(self.line_edit_style.format(**self.colors))

    def apply_text_edit_style(self, text_edit: QTextEdit,
    ) -> None:
        """Apply text edit styling.
        
        Args:
            text_edit: Text edit widget to style
        """
        text_edit.setStyleSheet(self.text_edit_style.format(**self.colors))

    def apply_label_style(self, label: QWidget, color: str | None = None) -> None:
        """Apply label styling.
        
        Args:
            label: Label widget to style
            color: Optional custom text color
        """
        text_color = color or self.colors["text_color"]
        label.setStyleSheet(f"color: {text_color};")

    def apply_custom_style(self, widget: QWidget, style_template: str, **kwargs) -> None:
        """Apply custom styling with template.
        
        Args:
            widget: Widget to style
            style_template: CSS template string
            **kwargs: Additional template variables
        """
        colors = self.colors.copy()
        colors.update(kwargs)
        widget.setStyleSheet(style_template.format(**colors))

    def get_color(self, color_name: str,
    ) -> str:
        """Get color value by name.
        
        Args:
            color_name: Name of the color
            
        Returns:
            Color value string
        """
        return self.colors.get(color_name, "#000000")

    def update_colors(self, color_updates: dict[str, str]) -> None:
        """Update color scheme and reinitialize templates.
        
        Args:
            color_updates: Dictionary of color updates
        """
        self.colors.update(color_updates)
        self._initialize_templates()

    def create_recording_key_style(self, is_recording: bool = False,
    ) -> str:
        """Create recording key input styling.
        
        Args:
            is_recording: Whether recording is active
            
        Returns:
            CSS style string
        """
        if is_recording:
            return """
                QLineEdit {
                    background-color: rgba(255, 0, 0, 30);
                    border: 2px solid red;
                    border-radius: 3px;
                    padding: 5px;
                    color: white;
                    font-weight: bold;
                }
            """
        return f"""
                QLineEdit {{
                    background-color: {self.colors["input_bg"]};
                    border: 1px solid {self.colors["input_border"]};
                    border-radius: 3px;
                    padding: 5px;
                    color: white;
                }}
            """

    def create_sound_path_display_style(self) -> str:
        """Create sound path display styling.
        
        Returns:
            CSS style string
        """
        return f"""
            QLineEdit {{
                background-color: {self.colors["input_bg"]};
                border: 1px solid {self.colors["input_border"]};
                border-radius: 3px;
                padding: 5px;
                color: white;
                font-style: italic;
            }}
            QLineEdit:focus {{
                border: 2px solid {self.colors["accent_color"]};
            }}
        """