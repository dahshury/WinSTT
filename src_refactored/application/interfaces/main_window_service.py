"""Main window service interface for presentation layer."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from datetime import datetime

    from src_refactored.domain.common.result import Result


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
    """Window metrics data transfer object."""
    minimize_count: int = 0
    total_sessions: int = 0
    last_activity: datetime | None = None
    uptime_seconds: float = 0.0


class IMainWindowService(ABC):
    """Interface for main window application services."""

    @abstractmethod
    def initialize_window(self, window_id: str) -> Result[None]:
        """Initialize the main window."""

    @abstractmethod
    def start_recording(self, window_id: str) -> Result[None]:
        """Start recording mode."""

    @abstractmethod
    def stop_recording(self, window_id: str) -> Result[None]:
        """Stop recording mode."""

    @abstractmethod
    def complete_transcription(self, window_id: str) -> Result[None]:
        """Complete transcription and return to ready state."""

    @abstractmethod
    def minimize_window(self, window_id: str) -> Result[None]:
        """Minimize the window."""

    @abstractmethod
    def restore_window(self, window_id: str) -> Result[None]:
        """Restore the window from minimized state."""

    @abstractmethod
    def set_window_mode(self, window_id: str, mode: WindowMode) -> Result[None]:
        """Set window display mode."""

    @abstractmethod
    def apply_opacity_effect(self, window_id: str, effect_name: str, opacity: float) -> Result[None]:
        """Apply an opacity effect to the window."""

    @abstractmethod
    def remove_opacity_effect(self, window_id: str, effect_name: str) -> Result[None]:
        """Remove an opacity effect from the window."""

    @abstractmethod
    def close_window(self, window_id: str) -> Result[None]:
        """Close the window."""

    @abstractmethod
    def get_window_state(self, window_id: str) -> Result[WindowState]:
        """Get current window state."""

    @abstractmethod
    def get_window_mode(self, window_id: str) -> Result[WindowMode]:
        """Get current window mode."""

    @abstractmethod
    def get_window_metrics(self, window_id: str) -> Result[WindowMetrics]:
        """Get window metrics."""

    @abstractmethod
    def is_transcribing(self, window_id: str) -> Result[bool]:
        """Check if window is currently transcribing."""
