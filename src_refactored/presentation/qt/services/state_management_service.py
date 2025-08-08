"""State management service for UI state tracking and transitions (Presentation)."""

from dataclasses import dataclass, field
from typing import Any

from PyQt6 import QtCore
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.ui_coordination.value_objects.ui_state_management import (
    StateTransition,
)


@dataclass
class InfrastructureStateTransition:
    domain_transition: StateTransition
    timestamp: QtCore.QDateTime = field(default_factory=QtCore.QDateTime.currentDateTime)

    @classmethod
    def from_domain(cls, domain_transition: StateTransition,
    ) -> "InfrastructureStateTransition":
        return cls(domain_transition=domain_transition)

    def to_domain(self) -> StateTransition:
        return self.domain_transition


class StateManagementService(QObject):
    state_changed = pyqtSignal(str, str, dict)
    state_entered = pyqtSignal(str, dict)
    state_exited = pyqtSignal(str, dict)
    transition_failed = pyqtSignal(str, str, str)
    # TODO: Implement the rest of the state management logic or remove if unused
    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._states: dict[str, dict[str, Any]] = {}
