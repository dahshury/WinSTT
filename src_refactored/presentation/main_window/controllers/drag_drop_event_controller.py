"""Thin controller that forwards Qt drag/drop events to the DDD drag/drop controller.

This keeps the presenter free of direct coordination logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src_refactored.domain.common.ports.logging_port import LoggingPort
    from src_refactored.presentation.main_window.controllers.drag_drop_coordination_controller import (
        DragDropCoordinationController,
    )


@dataclass
class DragDropEventController:
    """Event-forwarding controller for drag/drop."""

    coordinator: DragDropCoordinationController | None
    logger: LoggingPort | None

    def handle_drag_enter(self, event) -> None:
        try:
            if self.coordinator:
                self.coordinator.handle_drag_enter(event)
        except Exception as e:
            if self.logger:
                self.logger.log_error(f"Error forwarding dragEnterEvent: {e}")

    def handle_drop(self, event) -> None:
        try:
            if self.coordinator:
                self.coordinator.handle_drop(event)
        except Exception as e:
            if self.logger:
                self.logger.log_error(f"Error forwarding dropEvent: {e}")


