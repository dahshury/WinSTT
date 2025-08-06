"""UI Widgets Module.

This module contains use cases for UI widget operations,
including widget creation, event handling, and state management.
"""

from .create_toggle_widget_use_case import CreateToggleWidgetUseCase
from .handle_widget_event_use_case import HandleWidgetEventUseCase
from .update_widget_state_use_case import UpdateWidgetStateUseCase

__all__ = [
    "CreateToggleWidgetUseCase",
    "HandleWidgetEventUseCase",
    "UpdateWidgetStateUseCase",
]