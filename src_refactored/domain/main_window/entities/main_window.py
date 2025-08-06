"""Main window aggregate root.

This module contains the MainWindow aggregate that coordinates window lifecycle,
configuration, and UI state management.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from src_refactored.domain.common.aggregate_root import AggregateRoot
from src_refactored.domain.common.result import Result

if TYPE_CHECKING:
    from src_refactored.domain.main_window.value_objects.opacity_level import OpacityLevel

    from .ui_layout import UILayout
    from .visualization_integration import VisualizationIntegration
    from .window_configuration import WindowConfiguration


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


class MainWindow(AggregateRoot[str],
    ):
    """Main window aggregate root.
    
    Coordinates window lifecycle, configuration, UI state, and user interactions.
    """

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

    @classmethod
    def create(
        cls,
        configuration: WindowConfiguration,
        ui_layout: UILayout,
        visualization: VisualizationIntegration,
    ) -> Result[MainWindow]:
        """Create a new main window."""
        try:
            window_id = f"main_window_{datetime.utcnow().timestamp()}"
            window = cls(window_id, configuration, ui_layout, visualization)
            return Result.success(window)
        except Exception as e:
            return Result.failure(f"Failed to create main window: {e!s}")

    def initialize(self) -> Result[None]:
        """Initialize the main window."""
        if self._state != WindowState.INITIALIZING:
            return Result.failure("Window is not in initializing state")

        # Initialize UI layout
        layout_result = self._ui_layout.initialize()
        if not layout_result.is_success:
            return Result.failure(f"Failed to initialize UI layout: {layout_result.error()}")

        # Initialize visualization
        viz_result = self._visualization.initialize()
        if not viz_result.is_success:
            return Result.failure(f"Failed to initialize visualization: {viz_result.error()}")

        self._state = WindowState.READY
        self.mark_as_updated()
        return Result.success(None)

    def start_recording(self) -> Result[None]:
        """Start recording mode."""
        if self._state not in [WindowState.READY, WindowState.TRANSCRIBING]:
            return Result.failure(f"Cannot start recording from state: {self._state.value}")

        # Update visualization for recording
        viz_result = self._visualization.start_recording()
        if not viz_result.is_success:
            return Result.failure(viz_result.error())

        self._state = WindowState.RECORDING
        self._is_transcribing = True
        self._metrics.record_session()
        self.mark_as_updated()
        return Result.success(None)

    def stop_recording(self) -> Result[None]:
        """Stop recording mode."""
        if self._state != WindowState.RECORDING:
            return Result.failure("Window is not in recording state")

        # Update visualization for stopped recording
        viz_result = self._visualization.stop_recording()
        if not viz_result.is_success:
            return Result.failure(viz_result.error())

        self._state = WindowState.TRANSCRIBING
        self.mark_as_updated()
        return Result.success(None)

    def complete_transcription(self) -> Result[None]:
        """Complete transcription and return to ready state."""
        if self._state != WindowState.TRANSCRIBING:
            return Result.failure("Window is not in transcribing state")

        self._state = WindowState.READY
        self._is_transcribing = False
        self.mark_as_updated()
        return Result.success(None)

    def start_download(self) -> Result[None]:
        """Start download mode."""
        if self._state != WindowState.READY:
            return Result.failure("Cannot start download from current state")

        self._state = WindowState.DOWNLOADING
        self.mark_as_updated()
        return Result.success(None)

    def complete_download(self) -> Result[None]:
        """Complete download and return to ready state."""
        if self._state != WindowState.DOWNLOADING:
            return Result.failure("Window is not in downloading state")

        self._state = WindowState.READY
        self.mark_as_updated()
        return Result.success(None)

    def minimize(self) -> Result[None]:
        """Minimize the window."""
        if self._state == WindowState.CLOSING:
            return Result.failure("Cannot minimize closing window")

        self._state = WindowState.MINIMIZED
        self._metrics.record_minimize()
        self.mark_as_updated()
        return Result.success(None)

    def restore(self) -> Result[None]:
        """Restore the window from minimized state."""
        if self._state != WindowState.MINIMIZED:
            return Result.failure("Window is not minimized")

        self._state = WindowState.READY
        self.mark_as_updated()
        return Result.success(None)

    def set_opacity_effect(self, element_name: str, opacity: OpacityLevel,
    ) -> Result[None]:
        """Set opacity effect for a UI element."""
        self._opacity_effects[element_name] = opacity
        self.mark_as_updated()
        return Result.success(None)

    def get_opacity_effect(self, element_name: str,
    ) -> OpacityLevel | None:
        """Get opacity effect for a UI element."""
        return self._opacity_effects.get(element_name)

    def change_mode(self, mode: WindowMode,
    ) -> Result[None]:
        """Change window mode."""
        if self._state == WindowState.CLOSING:
            return Result.failure("Cannot change mode of closing window")

        self._mode = mode
        self.mark_as_updated()
        return Result.success(None)

    def close(self) -> Result[None]:
        """Close the window."""
        self._state = WindowState.CLOSING
        self.mark_as_updated()
        return Result.success(None)

    # Properties
    @property
    def configuration(self) -> WindowConfiguration:
        """Get window configuration."""
        return self._configuration

    @property
    def ui_layout(self) -> UILayout:
        """Get UI layout."""
        return self._ui_layout

    @property
    def visualization(self) -> VisualizationIntegration:
        """Get visualization integration."""
        return self._visualization

    @property
    def state(self) -> WindowState:
        """Get current window state."""
        return self._state

    @property
    def mode(self) -> WindowMode:
        """Get current window mode."""
        return self._mode

    @property
    def metrics(self) -> WindowMetrics:
        """Get window metrics."""
        return self._metrics

    @property
    def is_transcribing(self) -> bool:
        """Check if window is currently transcribing."""
        return self._is_transcribing

    @property
    def is_ready(self) -> bool:
        """Check if window is ready for operations."""
        return self._state == WindowState.READY

    @property
    def is_recording(self) -> bool:
        """Check if window is in recording state."""
        return self._state == WindowState.RECORDING

    @property
    def is_downloading(self) -> bool:
        """Check if window is downloading."""
        return self._state == WindowState.DOWNLOADING

    @property
    def created_at(self) -> datetime:
        """Get creation timestamp."""
        return self._created_at

    def __invariants__(self) -> None:
        """Validate main window invariants."""
        if not self._configuration:
            msg = "Main window must have configuration"
            raise ValueError(msg)
        if not self._ui_layout:
            msg = "Main window must have UI layout"
            raise ValueError(msg)
        if not self._visualization:
            msg = "Main window must have visualization integration"
            raise ValueError(msg,
    )
        if not isinstance(self._state, WindowState):
            msg = "Invalid window state"
            raise ValueError(msg)
        if not isinstance(self._mode, WindowMode):
            msg = "Invalid window mode"
            raise ValueError(msg)