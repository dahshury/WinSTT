from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QSlider

from src_refactored.domain.services.ui_interaction_service import UIInteractionService
from src_refactored.domain.services.widget_styling_service import WidgetStylingService


class ToggleSwitch(QSlider):
    """
    Custom toggle switch widget that provides mobile-style toggle functionality.
    
    This component handles:
    - Toggle switch appearance and styling
    - Click-to-toggle interaction
    - State management (checked/unchecked)
    - Visual feedback for state changes
    """

    def __init__(self, parent=None):
        super().__init__(Qt.Orientation.Horizontal, parent)

        # Services
        self.styling_service = WidgetStylingService()
        self.interaction_service = UIInteractionService()

        # Configure slider properties
        self._setup_slider_properties()

        # Apply initial styling
        self._apply_initial_styling()

    def _setup_slider_properties(self) -> None:
        """
        Configure the basic properties of the slider to work as a toggle switch.
        """
        self.setMaximum(1)
        self.setMinimum(0)
        self.setFixedSize(23, 11)  # Half the original size (46x22)
        self.setSingleStep(1)
        self.setPageStep(1)

    def _apply_initial_styling(self) -> None:
        """
        Apply the initial CSS styling for the toggle switch.
        """
        base_style = """
            QSlider::groove:horizontal {
                border: 1px solid rgba(78, 106, 129, 120);
                height: 10px;
                background: rgba(54, 71, 84, 180);
                border-radius: 5px;
            }
            QSlider::handle:horizontal {
                background: white;
                border: 1px solid rgba(78, 106, 129, 150);
                width: 9px;
                height: 9px;
                margin: 0px;
                border-radius: 4px;
            }
            QSlider::handle:horizontal:checked, QSlider::handle:horizontal:on {
                background: rgb(0, 122, 255);
            }
            QSlider::groove:horizontal:on {
                background: rgba(0, 122, 255, 40);
            }
        """
        self.setStyleSheet(base_style)

    def mousePressEvent(self, event):
        """
        Handle mouse press events to toggle the switch state.
        
        Args:
            event: The mouse press event
        """
        if event.button() == Qt.MouseButton.LeftButton:
            # Toggle the state
            new_value = 0 if self.value() == 1 else 1
            self.setValue(new_value)

            # Update styling based on new state
            self._update_styling_for_state(new_value == 1)

            event.accept()
        else:
            super().mousePressEvent(event)

    def paintEvent(self, event):
        """
        Handle paint events and update styling based on current state.
        
        Args:
            event: The paint event
        """
        super().paintEvent(event)

        # Update styling based on current value
        self._update_styling_for_state(self.value() == 1)

    def _update_styling_for_state(self, is_checked: bool,
    ) -> None:
        """
        Update the widget styling based on the checked state.
        
        Args:
            is_checked: Whether the toggle is in checked state
        """
        if is_checked:
            checked_style = """
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(0, 122, 255, 40);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """
            self.setStyleSheet(checked_style)
        else:
            unchecked_style = """
                QSlider::groove:horizontal {
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: rgba(54, 71, 84, 180);
                    border-radius: 5px;
                }
                QSlider::handle:horizontal {
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }
            """
            self.setStyleSheet(unchecked_style)

    def isChecked(self) -> bool:
        """
        Check if the toggle switch is in checked state.
        
        Returns:
            bool: True if checked, False otherwise
        """
        return self.value() == 1

    def setChecked(self, checked: bool,
    ) -> None:
        """
        Set the checked state of the toggle switch.
        
        Args:
            checked: Whether to set the toggle as checked
        """
        self.setValue(1 if checked else 0)
        self._update_styling_for_state(checked)

    def toggle(self) -> None:
        """
        Toggle the current state of the switch.
        """
        self.setChecked(not self.isChecked())

    def get_state(self) -> dict:
        """
        Get the current state of the toggle switch.
        
        Returns:
            dict: Current state information
        """
        return {
            "checked": self.isChecked()
            "value": self.value()
            "enabled": self.isEnabled()
            "visible": self.isVisible(),
        }

    def apply_theme_styling(self, theme_config: dict,
    ) -> None:
        """
        Apply theme-specific styling to the toggle switch.
        
        Args:
            theme_config: Theme configuration dictionary
        """
        try:
            # Extract theme colors
            groove_color = theme_config.get("groove_color", "rgba(54, 71, 84, 180)")
            groove_border = theme_config.get("groove_border", "rgba(78, 106, 129, 120)")
            handle_color = theme_config.get("handle_color", "white")
            handle_border = theme_config.get("handle_border", "rgba(78, 106, 129, 150)")
            active_color = theme_config.get("active_color", "rgba(0, 122, 255, 40)")

            # Build theme-aware stylesheet
            theme_style = f"""
                QSlider::groove:horizontal {{
                    border: 1px solid {groove_border};
                    height: 10px;
                    background: {groove_color};
                    border-radius: 5px;
                }}
                QSlider::handle:horizontal {{
                    background: {handle_color};
                    border: 1px solid {handle_border};
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }}
                QSlider::groove:horizontal:on {{
                    background: {active_color};
                }}
            """

            self.setStyleSheet(theme_style)

        except Exception:
            # Fallback to default styling if theme application fails
            self._apply_initial_styling()

    def set_interaction_enabled(self, enabled: bool,
    ) -> None:
        """
        Enable or disable user interaction with the toggle switch.
        
        Args:
            enabled: Whether to enable interaction
        """
        self.setEnabled(enabled)

        # Update visual state to reflect interaction capability
        if not enabled:
            self.setStyleSheet(self.styleSheet() + """
                QSlider {
                    opacity: 0.5;
                }
            """)
        else:
            # Remove opacity override
            current_style = self.styleSheet()
            if "opacity: 0.5;" in current_style:
                self.setStyleSheet(current_style.replace("opacity: 0.5;", ""))