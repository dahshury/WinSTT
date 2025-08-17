"""Settings domain entities."""

from .hotkey_binding import HotkeyBinding, KeyInfo, KeyType, RecordingState
from .settings_configuration import SettingsConfiguration
from .user_preferences import UserPreferences

__all__ = [
    "HotkeyBinding",
    "KeyInfo",
    "KeyType",
    "RecordingState",
    "SettingsConfiguration",
    "UserPreferences",
]