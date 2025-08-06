"""UI coordination service interface for presentation layer."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src_refactored.domain.common.result import Result


class ElementType(Enum):
    """UI element type enumeration."""
    LOGO = "logo"
    TITLE = "title"
    SETTINGS = "settings"
    INSTRUCTION = "instruction"
    LABEL = "label"
    BUTTON = "button"
    VISUALIZER = "visualizer"
    PROGRESS_BAR = "progress_bar"


class VisibilityState(Enum):
    """Visibility state enumeration."""
    VISIBLE = "visible"
    HIDDEN = "hidden"
    COLLAPSED = "collapsed"


class IUICoordinationService(ABC):
    """Interface for UI coordination application services."""

    @abstractmethod
    def start_recording_mode(self, coordinator_id: str) -> Result[dict[ElementType, Any]]:
        """Start recording mode with coordinated animations."""

    @abstractmethod
    def stop_recording_mode(self, coordinator_id: str) -> Result[dict[ElementType, Any]]:
        """Stop recording mode and restore UI elements."""

    @abstractmethod
    def start_download_mode(self, coordinator_id: str, filename: str) -> Result[None]:
        """Start download mode and disable settings."""

    @abstractmethod
    def update_download_progress(self, coordinator_id: str, filename: str, percentage: int) -> Result[None]:
        """Update download progress."""

    @abstractmethod
    def complete_download_mode(self, coordinator_id: str) -> Result[None]:
        """Complete download mode and restore UI."""

    @abstractmethod
    def start_transcription_mode(self, coordinator_id: str, hold_message: bool = True) -> Result[None]:
        """Start transcription mode."""

    @abstractmethod
    def update_transcription_progress(self, coordinator_id: str, percentage: int) -> Result[None]:
        """Update transcription progress."""

    @abstractmethod
    def complete_transcription_mode(self, coordinator_id: str, success_message: str | None = None) -> Result[None]:
        """Complete transcription mode."""

    @abstractmethod
    def display_message(self, coordinator_id: str, message: str, priority: str = "normal") -> Result[None]:
        """Display a message with priority handling."""

    @abstractmethod
    def clear_current_message(self, coordinator_id: str) -> Result[str | None]:
        """Clear current message and show next in queue."""

    @abstractmethod
    def update_instruction_text(self, coordinator_id: str, key_combination: str) -> Result[None]:
        """Update instruction text with current key combination."""

    @abstractmethod
    def get_element_state(self, coordinator_id: str, element_type: ElementType) -> Result[Any]:
        """Get current state of a UI element."""

    @abstractmethod
    def get_current_ui_mode(self, coordinator_id: str) -> Result[str]:
        """Get description of current UI mode."""

    @abstractmethod
    def reset_to_idle_state(self, coordinator_id: str) -> Result[None]:
        """Reset UI to idle state."""


class IAnimationService(ABC):
    """Interface for animation management services."""

    @abstractmethod
    def start_animation(self, controller_id: str, element_type: ElementType, animation_config: dict[str, Any]) -> Result[str]:
        """Start a new animation for the specified element type."""

    @abstractmethod
    def start_animation_group(self, controller_id: str, group_name: str, animations: dict[ElementType, dict[str, Any]]) -> Result[None]:
        """Start a group of coordinated animations."""

    @abstractmethod
    def cancel_animation(self, controller_id: str, element_type: ElementType) -> Result[bool]:
        """Cancel an active animation."""

    @abstractmethod
    def cancel_animation_group(self, controller_id: str, group_name: str) -> Result[bool]:
        """Cancel an entire animation group."""

    @abstractmethod
    def pause_animation(self, controller_id: str, element_type: ElementType) -> Result[bool]:
        """Pause an active animation."""

    @abstractmethod
    def resume_animation(self, controller_id: str, element_type: ElementType) -> Result[bool]:
        """Resume a paused animation."""

    @abstractmethod
    def get_animation_progress(self, controller_id: str, element_type: ElementType) -> Result[float]:
        """Get the progress of an animation (0.0 to 1.0)."""

    @abstractmethod
    def is_animating(self, controller_id: str, element_type: ElementType) -> Result[bool]:
        """Check if an element is currently animating."""

    @abstractmethod
    def has_active_animations(self, controller_id: str) -> Result[bool]:
        """Check if there are any active animations."""

    @abstractmethod
    def set_global_speed(self, controller_id: str, multiplier: float) -> Result[None]:
        """Set global animation speed multiplier."""

    @abstractmethod
    def enable_animations(self, controller_id: str, enabled: bool = True) -> Result[None]:
        """Enable or disable all animations."""
