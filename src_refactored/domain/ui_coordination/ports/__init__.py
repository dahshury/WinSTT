"""Ports for UI coordination (layout, arrangement, responsive)."""

"""UI coordination ports for dependency inversion."""

from .ui_state_management_port import UIStateManagementPort
from .widget_operation_port import WidgetOperationPort
from .window_management_port import WindowManagementPort

__all__ = [
    "UIStateManagementPort",
    "WidgetOperationPort",
    "WindowManagementPort",
]