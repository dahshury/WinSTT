"""Toggle Widget Service for custom toggle switch implementation.

This service provides toggle switch widget functionality with styling and event handling,
extracted from settings_dialog.py (lines 27-112).
"""

from collections.abc import Callable

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QMouseEvent, QPaintEvent
from PyQt6.QtWidgets import QSlider


class ToggleSwitch(QSlider):
    """Custom toggle switch that looks like a mobile toggle.
    
    Extracted from settings_dialog.py (lines 27-112).
    """

    def __init__(self, parent=None):
        """Initialize the toggle switch.
        
        Args:
            parent: Parent widget
        """
        super().__init__(Qt.Orientation.Horizontal, parent)
        self.setMaximum(1)
        self.setMinimum(0)
        self.setFixedSize(23, 11)  # Half the original size (46x22)
        self.setSingleStep(1)
        self.setPageStep(1)
        self._apply_default_style()

    def _apply_default_style(self) -> None:
        """Apply default styling to the toggle switch."""
        self.setStyleSheet("""
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
        """)

    def mousePressEvent(self, event: QMouseEvent,
    ) -> None:
        """Handle mouse press events to make the toggle switch clickable.
        
        Args:
            event: Mouse press event
        """
        if event.button() == Qt.MouseButton.LeftButton:
            # Toggle the state
            self.setValue(0 if self.value() == 1 else 1)
            event.accept()
        else:
            super().mousePressEvent(event)

    def paintEvent(self, event: QPaintEvent,
    ) -> None:
        """Handle paint events to update styling based on state.
        
        Args:
            event: Paint event
        """
        super().paintEvent(event)

        # Change handle color when checked
        if self.value() == 1:
            self._apply_checked_style()
        else:
            self._apply_unchecked_style()

    def _apply_checked_style(self) -> None:
        """Apply styling for checked state."""
        self.setStyleSheet("""
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
        """)

    def _apply_unchecked_style(self) -> None:
        """Apply styling for unchecked state."""
        self.setStyleSheet("""
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
        """)

    def is_checked(self) -> bool:
        """Check if the toggle switch is in checked state.
        
        Returns:
            True if checked, False otherwise
        """
        return self.value() == 1

    def set_checked(self, checked: bool,
    ) -> None:
        """Set the checked state of the toggle switch.
        
        Args:
            checked: True to check, False to uncheck
        """
        self.setValue(1 if checked else 0)


class ToggleWidgetService:
    """Service for managing toggle widget creation and configuration."""

    @staticmethod
    def create_toggle_switch(parent=None,
                           initial_state: bool = False,
                           change_callback: Callable[[bool], None] | None = None) -> ToggleSwitch:
        """Create a configured toggle switch widget.
        
        Args:
            parent: Parent widget
            initial_state: Initial checked state
            change_callback: Optional callback for state changes
            
        Returns:
            Configured ToggleSwitch widget
        """
        toggle = ToggleSwitch(parent)
        toggle.set_checked(initial_state)

        if change_callback:
            toggle.valueChanged.connect(lambda value: change_callback(value == 1))

        return toggle

    @staticmethod
    def configure_toggle_styling(toggle: ToggleSwitch,
                               checked_color: str = "rgb(0, 122, 255)",
                               unchecked_color: str = "rgba(54, 71, 84, 180)") -> None:
        """Configure custom styling for a toggle switch.
        
        Args:
            toggle: Toggle switch to configure
            checked_color: Color for checked state
            unchecked_color: Color for unchecked state
        """
        # Store custom colors for dynamic styling
        toggle.checked_color = checked_color
        toggle.unchecked_color = unchecked_color

        # Override style methods with custom colors
        def apply_checked_style():
            toggle.setStyleSheet(f"""
                QSlider::groove:horizontal {{
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: {checked_color};
                    border-radius: 5px;
                }}
                QSlider::handle:horizontal {{
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }}
            """)

        def apply_unchecked_style():
            toggle.setStyleSheet(f"""
                QSlider::groove:horizontal {{
                    border: 1px solid rgba(78, 106, 129, 120);
                    height: 10px;
                    background: {unchecked_color};
                    border-radius: 5px;
                }}
                QSlider::handle:horizontal {{
                    background: rgb(255, 255, 255);
                    border: 1px solid rgba(78, 106, 129, 150);
                    width: 9px;
                    height: 9px;
                    margin: 0px;
                    border-radius: 4px;
                }}
            """)

        # Replace methods with custom implementations
        toggle.apply_checked_style = apply_checked_style
        toggle.apply_unchecked_style = apply_unchecked_style