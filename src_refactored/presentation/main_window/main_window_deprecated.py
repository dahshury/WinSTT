"""DEPRECATED: Main window aggregate root - VIOLATES HEXAGONAL ARCHITECTURE.

This file contains domain logic in the presentation layer and should not be used.
Use MainWindowPresenter instead, which properly delegates to application services.

This file is kept temporarily for reference during refactoring.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from src_refactored.domain.common.aggregate_root import AggregateRoot

if TYPE_CHECKING:
    from src_refactored.presentation.main_window.value_objects.opacity_level import OpacityLevel
    from src_refactored.presentation.main_window.value_objects.ui_layout import UILayout
    from src_refactored.presentation.main_window.value_objects.visualization_integration import (
        VisualizationIntegration,
    )
    from src_refactored.presentation.main_window.value_objects.window_configuration import (
        WindowConfiguration,
    )


class WindowState(Enum):
    """Window state enumeration."""
    INITIALIZING = "initializing"
    READY = "ready"
    RECORDING = "recording"
    TRANSCRIBING = "transcribing"
    DOWNLOADING = "downloading"
    ERROR = "error"
    MINIMIZED = "minimized"
    CLOSING = "closing"


class WindowMode(Enum):
    """Window mode enumeration."""
    NORMAL = "normal"
    COMPACT = "compact"
    MINIMAL = "minimal"
    FULLSCREEN = "fullscreen"


@dataclass
class WindowMetrics:
    """Window metrics data."""
    minimize_count: int = 0
    total_sessions: int = 0
    last_activity: datetime | None = None
    uptime_seconds: float = 0.0

    def record_minimize(self) -> None:
        """Record a window minimize event."""
        self.minimize_count += 1
        self.last_activity = datetime.utcnow()

    def record_session(self) -> None:
        """Record a transcription session."""
        self.total_sessions += 1
        self.last_activity = datetime.utcnow()


class MainWindowDeprecated(AggregateRoot[str]):
    """DEPRECATED: Main window aggregate root - violates hexagonal architecture."""

    def __init__(
        self,
        window_id: str,
        configuration: WindowConfiguration,
        ui_layout: UILayout,
        visualization: VisualizationIntegration,
    ):
        super().__init__(window_id)
        self._configuration = configuration
        self._ui_layout = ui_layout
        self._visualization = visualization
        self._state = WindowState.INITIALIZING
        self._mode = WindowMode.NORMAL
        self._metrics = WindowMetrics()
        self._is_transcribing = False
        self._opacity_effects: dict[str, OpacityLevel] = {}
        self._created_at = datetime.utcnow()
        self.validate()

    # ... rest of the implementation is preserved for reference ...
