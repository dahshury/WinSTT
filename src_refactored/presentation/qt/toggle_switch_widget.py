"""ToggleSwitch widget (Presentation).

Moved from Infrastructure.
"""

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import QSlider


class ToggleSwitch(QSlider):
    """
    Custom toggle switch widget that provides mobile-style toggle functionality.
    """

    valueChanged = pyqtSignal(bool)  # noqa: N815 - Qt signal naming

    def __init__(self, parent=None):
        super().__init__(Qt.Orientation.Horizontal, parent)
        self._setup_slider_properties()
        self._apply_initial_styling()
        super().valueChanged.connect(self._on_value_changed)

    def _on_value_changed(self, value: int) -> None:
        self.valueChanged.emit(value == 1)

    def _setup_slider_properties(self) -> None:
        self.setMaximum(1)
        self.setMinimum(0)
        self.setFixedSize(23, 11)
        self.setSingleStep(1)
        self.setPageStep(1)

    def _apply_initial_styling(self) -> None:
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

    def mousePressEvent(self, event):  # noqa: N802 - Qt override
        if event.button() == Qt.MouseButton.LeftButton:
            new_value = 0 if self.value() == 1 else 1
            self.setValue(new_value)
            self._update_styling_for_state(new_value == 1)
            event.accept()
        else:
            super().mousePressEvent(event)

    def paintEvent(self, event):  # noqa: N802 - Qt override
        super().paintEvent(event)
        self._update_styling_for_state(self.value() == 1)

    def _update_styling_for_state(self, is_checked: bool) -> None:
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

    def isChecked(self) -> bool:  # noqa: N802 - API compatibility
        return self.value() == 1

    def setChecked(self, checked: bool) -> None:  # noqa: N802 - API compatibility
        self.setValue(1 if checked else 0)
        self._update_styling_for_state(checked)

    def toggle(self) -> None:
        self.setChecked(not self.isChecked())

    def get_state(self) -> dict:
        return {
            "checked": self.isChecked(),
            "value": self.value(),
            "enabled": self.isEnabled(),
            "visible": self.isVisible(),
        }


