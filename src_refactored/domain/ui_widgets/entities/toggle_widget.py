"""Toggle widget entity for UI widgets domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common import AggregateRoot


class ToggleState(Enum):
    """Toggle widget state enumeration."""
    OFF = 0
    ON = 1


class ToggleMode(Enum):
    """Toggle widget interaction mode."""
    CLICK_TO_TOGGLE = "click_to_toggle"
    DRAG_TO_TOGGLE = "drag_to_toggle"
    BOTH = "both"


@dataclass
class ToggleConfiguration:
    """Configuration for toggle widget behavior."""
    width: int = 23
    height: int = 11
    mode: ToggleMode = ToggleMode.CLICK_TO_TOGGLE
    enabled: bool = True

    def __post_init__(self):
        """Validate configuration after initialization."""
        if self.width <= 0 or self.height <= 0:
            msg = "Widget dimensions must be positive"
            raise ValueError(msg)
        if self.width < 10 or self.height < 5:
            msg = "Widget too small for usability"
            raise ValueError(msg)


class ToggleWidget(AggregateRoot[str],
    ):
    """Toggle widget aggregate root managing state and behavior."""

    def __init__(self, widget_id: str, configuration: ToggleConfiguration,
    ):
        super().__init__(widget_id)
        self._state = ToggleState.OFF
        self._configuration = configuration
        self._previous_state: ToggleState | None = None
        self._is_enabled = configuration.enabled
        self.validate()

    @classmethod
    def create(
    cls,
    widget_id: str,
    configuration: ToggleConfiguration | None = None) -> ToggleWidget:
        """Create a new toggle widget with default or provided configuration."""
        if configuration is None:
            configuration = ToggleConfiguration(,
    )

        return cls(widget_id, configuration)

    def toggle(self) -> bool:
        """Toggle the widget state and return success status."""
        if not self._is_enabled:
            return False

        self._previous_state = self._state
        self._state = ToggleState.ON if self._state == ToggleState.OFF else ToggleState.OFF
        self.mark_as_updated()
        return True

    def set_state(self, state: ToggleState,
    ) -> bool:
        """Set the widget state explicitly and return success status."""
        if not self._is_enabled:
            return False

        if self._state != state:
            self._previous_state = self._state
            self._state = state
            self.mark_as_updated()

        return True

    def enable(self) -> None:
        """Enable the toggle widget."""
        if not self._is_enabled:
            self._is_enabled = True
            self.mark_as_updated()

    def disable(self) -> None:
        """Disable the toggle widget."""
        if self._is_enabled:
            self._is_enabled = False
            self.mark_as_updated()

    def reset_to_default(self) -> None:
        """Reset widget to default state (OFF)."""
        if self._state != ToggleState.OFF:
            self._previous_state = self._state
            self._state = ToggleState.OFF
            self.mark_as_updated()

    def can_interact(self) -> bool:
        """Check if the widget can be interacted with."""
        return self._is_enabled

    def has_state_changed(self) -> bool:
        """Check if the state has changed from previous state."""
        return self._previous_state is not None and self._previous_state != self._state

    # Properties
    @property
    def state(self) -> ToggleState:
        """Get current toggle state."""
        return self._state

    @property
    def is_on(self) -> bool:
        """Check if toggle is in ON state."""
        return self._state == ToggleState.ON

    @property
    def is_off(self) -> bool:
        """Check if toggle is in OFF state."""
        return self._state == ToggleState.OFF

    @property
    def is_enabled(self) -> bool:
        """Check if widget is enabled."""
        return self._is_enabled

    @property
    def configuration(self) -> ToggleConfiguration:
        """Get widget configuration."""
        return self._configuration

    @property
    def previous_state(self) -> ToggleState | None:
        """Get previous toggle state."""
        return self._previous_state

    def __invariants__(self) -> None:
        """Validate widget invariants."""
        if not self._configuration:
            msg = "Toggle widget must have configuration"
            raise ValueError(msg)
        if self._configuration.width <= 0 or self._configuration.height <= 0:
            msg = "Widget dimensions must be positive"
            raise ValueError(msg,
    )