"""System tray integration aggregate for system integration domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import AggregateRoot

if TYPE_CHECKING:
    from collections.abc import Callable


class TrayState(Enum):
    """Enumeration of system tray states."""
    HIDDEN = "hidden"
    VISIBLE = "visible"
    DISABLED = "disabled"
    ERROR = "error"


class TrayActionType(Enum):
    """Enumeration of tray action types."""
    SHOW = "show"
    SETTINGS = "settings"
    EXIT = "exit"
    CUSTOM = "custom"


@dataclass
class TrayAction:
    """Value object for tray actions."""
    action_type: TrayActionType
    label: str
    callback: Callable[[], None] | None = None
    enabled: bool = True
    visible: bool = True

    def __post_init__(self):
        """Validate tray action."""
        if not self.label or not self.label.strip():
            msg = "Action label cannot be empty"
            raise ValueError(msg)

        if self.action_type == TrayActionType.CUSTOM and self.callback is None:
            msg = "Custom actions must have a callback"
            raise ValueError(msg)


@dataclass
class TrayConfiguration:
    """Value object for tray configuration."""
    icon_path: str
    tooltip: str = "WinSTT"
    show_notifications: bool = True
    auto_hide_on_close: bool = True
    double_click_action: TrayActionType = TrayActionType.SHOW

    def __post_init__(self):
        """Validate tray configuration."""
        if not self.icon_path or not self.icon_path.strip():
            msg = "Icon path cannot be empty"
            raise ValueError(msg)

        if not self.tooltip or not self.tooltip.strip():
            msg = "Tooltip cannot be empty"
            raise ValueError(msg)


class SystemTrayIntegration(AggregateRoot,
    ):
    """Aggregate root for system tray integration and coordination."""

    def __init__(
        self,
        tray_id: str,
        configuration: TrayConfiguration,
    ):
        """Initialize system tray integration."""
        super().__init__()
        self._tray_id = tray_id
        self._configuration = configuration
        self._state = TrayState.HIDDEN
        self._actions: dict[str, TrayAction] = {}
        self._is_supported = True
        self._error_message: str | None = None
        self._notification_callback: Callable[[str, str], None] | None = None

        # Initialize default actions
        self._initialize_default_actions()

    @property
    def tray_id(self) -> str:
        """Get tray ID."""
        return self._tray_id

    @property
    def configuration(self) -> TrayConfiguration:
        """Get tray configuration."""
        return self._configuration

    @property
    def state(self) -> TrayState:
        """Get current tray state."""
        return self._state

    @property
    def actions(self) -> dict[str, TrayAction]:
        """Get tray actions."""
        return self._actions.copy()

    @property
    def is_supported(self) -> bool:
        """Check if system tray is supported."""
        return self._is_supported

    @property
    def is_visible(self) -> bool:
        """Check if tray is visible."""
        return self._state == TrayState.VISIBLE

    @property
    def is_enabled(self) -> bool:
        """Check if tray is enabled."""
        return self._state in {TrayState.VISIBLE, TrayState.HIDDEN}

    @property
    def error_message(self) -> str | None:
        """Get error message if tray is in error state."""
        return self._error_message

    def _initialize_default_actions(self) -> None:
        """Initialize default tray actions."""
        self._actions = {
            "show": TrayAction(
                action_type=TrayActionType.SHOW,
                label="Show",
            ),
            "settings": TrayAction(
                action_type=TrayActionType.SETTINGS,
                label="Settings",
            ),
            "exit": TrayAction(
                action_type=TrayActionType.EXIT,
                label="Exit",
            ),
        }

    def check_system_support(self) -> bool:
        """Check if system tray is supported on current platform."""
        # This would typically check platform capabilities
        # For now, assume it's supported
        self._is_supported = True
        return self._is_supported

    def show_tray(self) -> None:
        """Show the system tray icon."""
        if not self._is_supported:
            msg = "System tray is not supported"
            raise ValueError(msg)

        if self._state == TrayState.ERROR:
            msg = f"Cannot show tray in error state: {self._error_message}"
            raise ValueError(msg)

        self._state = TrayState.VISIBLE

    def hide_tray(self) -> None:
        """Hide the system tray icon."""
        if self._state == TrayState.VISIBLE:
            self._state = TrayState.HIDDEN

    def disable_tray(self,
    ) -> None:
        """Disable the system tray."""
        self._state = TrayState.DISABLED

    def set_error_state(self, error_message: str,
    ) -> None:
        """Set tray to error state."""
        if not error_message or not error_message.strip():
            msg = "Error message cannot be empty"
            raise ValueError(msg)

        self._state = TrayState.ERROR
        self._error_message = error_message.strip()

    def clear_error_state(self) -> None:
        """Clear error state and return to hidden state."""
        if self._state == TrayState.ERROR:
            self._state = TrayState.HIDDEN
            self._error_message = None

    def add_action(self, action_id: str, action: TrayAction,
    ) -> None:
        """Add a custom action to the tray menu."""
        if not action_id or not action_id.strip():
            msg = "Action ID cannot be empty"
            raise ValueError(msg)

        if action_id in self._actions:
            msg = f"Action with ID '{action_id}' already exists"
            raise ValueError(msg)

        self._actions[action_id] = action

    def remove_action(self, action_id: str,
    ) -> None:
        """Remove an action from the tray menu."""
        if action_id in {"show", "settings", "exit"}:
            msg = f"Cannot remove default action: {action_id}"
            raise ValueError(msg)

        if action_id not in self._actions:
            msg = f"Action with ID '{action_id}' does not exist"
            raise ValueError(msg,
    )

        del self._actions[action_id]

    def update_action(self, action_id: str, **updates) -> None:
        """Update an existing action."""
        if action_id not in self._actions:
            msg = f"Action with ID '{action_id}' does not exist"
            raise ValueError(msg,
    )

        action = self._actions[action_id]

        # Create updated action
        updated_action = TrayAction(
            action_type=updates.get("action_type", action.action_type),
            label=updates.get("label", action.label),
            callback=updates.get("callback", action.callback),
            enabled=updates.get("enabled", action.enabled),
            visible=updates.get("visible", action.visible),
        )

        self._actions[action_id] = updated_action

    def get_action(self, action_id: str,
    ) -> TrayAction | None:
        """Get an action by ID."""
        return self._actions.get(action_id)

    def get_visible_actions(self) -> dict[str, TrayAction]:
        """Get all visible actions."""
        return {aid: action for aid, action in self._actions.items() if action.visible}

    def get_enabled_actions(self) -> dict[str, TrayAction]:
        """Get all enabled actions."""
        return {aid: action for aid, action in self._actions.items() if action.enabled}

    def execute_action(self, action_id: str,
    ) -> None:
        """Execute an action by ID."""
        action = self._actions.get(action_id)
        if not action:
            msg = f"Action with ID '{action_id}' does not exist"
            raise ValueError(msg)

        if not action.enabled:
            msg = f"Action '{action_id}' is disabled"
            raise ValueError(msg)

        if action.callback:
            try:
                action.callback()
            except Exception as e:
                self.set_error_state(f"Action '{action_id}' failed: {e!s}",
    )
                raise

    def update_configuration(self, **updates) -> None:
        """Update tray configuration."""
        self._configuration = TrayConfiguration(
            icon_path=updates.get("icon_path", self._configuration.icon_path),
            tooltip=updates.get("tooltip", self._configuration.tooltip),
            show_notifications=updates.get("show_notifications", self._configuration.show_notifications),
            auto_hide_on_close=updates.get("auto_hide_on_close", self._configuration.auto_hide_on_close),
            double_click_action=updates.get("double_click_action", self._configuration.double_click_action),
        )

    def set_notification_callback(self, callback: Callable[[str, str], None]) -> None:
        """Set callback for showing notifications."""
        self._notification_callback = callback

    def show_notification(self, title: str, message: str,
    ) -> None:
        """Show a system tray notification."""
        if not self._configuration.show_notifications:
            return

        if self._state != TrayState.VISIBLE:
            return

        if not title or not title.strip():
            msg = "Notification title cannot be empty"
            raise ValueError(msg)

        if not message or not message.strip():
            msg = "Notification message cannot be empty"
            raise ValueError(msg)

        if self._notification_callback:
            try:
                self._notification_callback(title.strip(), message.strip())
            except Exception:
                # Don't fail the entire operation for notification errors
                pass

    def handle_double_click(self) -> None:
        """Handle double-click on tray icon."""
        if self._state != TrayState.VISIBLE:
            return

        action_id = {
            TrayActionType.SHOW: "show",
            TrayActionType.SETTINGS: "settings",
            TrayActionType.EXIT: "exit",
        }.get(self._configuration.double_click_action)

        if action_id:
            try:
                self.execute_action(action_id)
            except Exception:
                # Don't fail for double-click errors
                pass

    def reset(self) -> None:
        """Reset tray to initial state."""
        self._state = TrayState.HIDDEN
        self._error_message = None
        self._initialize_default_actions()

    def get_status_summary(self) -> dict[str, Any]:
        """Get status summary for debugging."""
        return {
            "tray_id": self._tray_id,
            "state": self._state.value,
            "is_supported": self._is_supported,
            "is_visible": self.is_visible,
            "is_enabled": self.is_enabled,
            "error_message": self._error_message,
            "action_count": len(self._actions),
            "visible_actions": len(self.get_visible_actions()),
            "enabled_actions": len(self.get_enabled_actions()),
            "configuration": {
                "icon_path": self._configuration.icon_path,
                "tooltip": self._configuration.tooltip,
                "show_notifications": self._configuration.show_notifications,
                "auto_hide_on_close": self._configuration.auto_hide_on_close,
                "double_click_action": self._configuration.double_click_action.value,
            },
        }