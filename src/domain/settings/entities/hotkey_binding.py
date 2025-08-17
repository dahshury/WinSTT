"""Hotkey binding entity for managing key combination validation and recording."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from src.domain.common import Entity
from src.domain.settings.value_objects.key_combination import KeyCombination

if TYPE_CHECKING:
    from collections.abc import Callable


class RecordingState(Enum):
    """States for hotkey recording."""
    IDLE = "idle"
    RECORDING = "recording"
    COMPLETED = "completed"


class KeyType(Enum):
    """Types of keys that can be part of a hotkey combination."""
    MODIFIER = "modifier"
    REGULAR = "regular"
    FUNCTION = "function"
    SPECIAL = "special"


@dataclass
class KeyInfo:
    """Information about a specific key."""
    name: str
    key_type: KeyType
    display_name: str

    def __post_init__(self) -> None:
        if not self.display_name:
            self.display_name = self.name


@dataclass
class HotkeyBinding(Entity):
    """Entity for managing hotkey binding validation and recording."""

    current_combination: KeyCombination
    recording_state: RecordingState = field(default=RecordingState.IDLE,
    )
    _pressed_keys: set[str] = field(default_factory=set, init=False)
    _key_registry: dict[str, KeyInfo] = field(default_factory=dict, init=False)
    _on_combination_changed: Callable[[KeyCombination], None] | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        """Initialize the hotkey binding entity."""
        super().__post_init__()
        self._initialize_key_registry()
        self._validate_current_combination()

    def _initialize_key_registry(self) -> None:
        """Initialize the registry of supported keys."""
        # Modifier keys
        modifier_keys = [
            KeyInfo("CTRL", KeyType.MODIFIER, "Ctrl"),
            KeyInfo("ALT", KeyType.MODIFIER, "Alt"),
            KeyInfo("SHIFT", KeyType.MODIFIER, "Shift"),
            KeyInfo("META", KeyType.MODIFIER, "Meta"),
        ]

        # Function keys
        function_keys = [
            KeyInfo(f"F{i}", KeyType.FUNCTION, f"F{i}") for i in range(1, 13)
        ]

        # Special keys
        special_keys = [
            KeyInfo("ESC", KeyType.SPECIAL, "Escape"),
            KeyInfo("TAB", KeyType.SPECIAL, "Tab"),
            KeyInfo("CAPS", KeyType.SPECIAL, "Caps Lock"),
            KeyInfo("SPACE", KeyType.SPECIAL, "Space"),
        ]

        # Regular keys (A-Z, 0-9)
        regular_keys = [
            KeyInfo(chr(i), KeyType.REGULAR, chr(i)) for i in range(ord("A"), ord("Z") + 1)
        ] + [
            KeyInfo(str(i), KeyType.REGULAR, str(i)) for i in range(10)
        ]

        # Build registry
        all_keys = modifier_keys + function_keys + special_keys + regular_keys
        self._key_registry = {key.name: key for key in all_keys}

    def _validate_current_combination(self) -> None:
        """Validate the current key combination."""
        if not self.current_combination.is_valid_for_recording():
            msg = "Hotkey combination must have at least one modifier key"
            raise ValueError(msg)

    def start_recording(self) -> None:
        """Start recording a new key combination."""
        if self.recording_state == RecordingState.RECORDING:
            return

        self.recording_state = RecordingState.RECORDING
        self._pressed_keys.clear()

    def stop_recording(self) -> bool:
        """Stop recording and apply the new combination if valid."""
        if self.recording_state != RecordingState.RECORDING:
            return False

        self.recording_state = RecordingState.IDLE

        if len(self._pressed_keys) > 0:
            try:
                # Create new combination from pressed keys
                combination_string = "+".join(sorted(self._pressed_keys, key=self._get_key_sort_priority))
                new_combination = KeyCombination.from_string(combination_string)

                # Validate the new combination
                if new_combination.is_valid_for_recording():
                    self.current_combination = new_combination
                    self.recording_state = RecordingState.COMPLETED

                    # Notify listeners of the change
                    if self._on_combination_changed:
                        self._on_combination_changed(self.current_combination)

                    self._pressed_keys.clear()
                    return True
                # Invalid combination, keep the old one
                self._pressed_keys.clear()
                return False

            except ValueError:
                # Invalid combination format
                self._pressed_keys.clear()
                return False

        return False

    def add_pressed_key(self, key_name: str,
    ) -> bool:
        """Add a key to the currently pressed keys during recording."""
        if self.recording_state != RecordingState.RECORDING:
            return False

        # Normalize key name
        normalized_key = self._normalize_key_name(key_name)

        if normalized_key and self._is_valid_key(normalized_key):
            self._pressed_keys.add(normalized_key)
            return True

        return False

    def remove_pressed_key(self, key_name: str,
    ) -> bool:
        """Remove a key from the currently pressed keys during recording."""
        if self.recording_state != RecordingState.RECORDING:
            return False

        normalized_key = self._normalize_key_name(key_name)

        if normalized_key and normalized_key in self._pressed_keys:
            self._pressed_keys.discard(normalized_key)
            return True

        return False

    def get_current_recording_display(self) -> str:
        """Get the display string for the currently recording combination."""
        if self.recording_state != RecordingState.RECORDING or len(self._pressed_keys) == 0:
            return ""

        sorted_keys = sorted(self._pressed_keys, key=self._get_key_sort_priority)
        display_names = [self._get_key_display_name(key) for key in sorted_keys]
        return " + ".join(display_names)

    def get_pressed_keys(self) -> set[str]:
        """Get the currently pressed keys (read-only)."""
        return self._pressed_keys.copy()

    def is_recording(self) -> bool:
        """Check if currently recording a key combination."""
        return self.recording_state == RecordingState.RECORDING

    def has_minimum_keys_for_valid_combination(self) -> bool:
        """Check if the current pressed keys form a potentially valid combination."""
        if len(self._pressed_keys) == 0:
            return False

        # Must have at least one modifier key
        modifier_keys = {"CTRL", "ALT", "SHIFT", "META"}
        return any(key in modifier_keys for key in self._pressed_keys)

    def set_combination_change_callback(self, callback: Callable[[KeyCombination], None]) -> None:
        """Set a callback to be called when the combination changes."""
        self._on_combination_changed = callback

    def reset_to_default(self) -> None:
        """Reset to a default key combination."""
        self.current_combination = KeyCombination.from_string("CTRL+SHIFT+R")
        self.recording_state = RecordingState.IDLE
        self._pressed_keys.clear()

    def _normalize_key_name(self, key_name: str,
    ) -> str | None:
        """Normalize a key name to the standard format."""
        if not key_name:
            return None

        normalized = key_name.upper().strip()

        # Handle common variations
        key_mappings = {
            "CONTROL": "CTRL",
            "COMMAND": "META",
            "CMD": "META",
            "WIN": "META",
            "WINDOWS": "META",
        }

        return key_mappings.get(normalized, normalized)

    def _is_valid_key(self, key_name: str,
    ) -> bool:
        """Check if a key name is valid and supported."""
        return key_name in self._key_registry

    def _get_key_display_name(self, key_name: str,
    ) -> str:
        """Get the display name for a key."""
        key_info = self._key_registry.get(key_name)
        return key_info.display_name if key_info else key_name

    def _get_key_sort_priority(self, key_name: str,
    ) -> int:
        """Get the sort priority for a key (modifiers first, then others)."""
        key_info = self._key_registry.get(key_name)
        if not key_info:
            return 999

        # Priority order: modifiers, function keys, special keys, regular keys
        priority_map = {
            KeyType.MODIFIER: 0,
            KeyType.FUNCTION: 1,
            KeyType.SPECIAL: 2,
            KeyType.REGULAR: 3,
        }

        base_priority = priority_map.get(key_info.key_type, 999) * 100

        # Within modifiers, maintain a specific order
        if key_info.key_type == KeyType.MODIFIER:
            modifier_order = {"CTRL": 0, "ALT": 1, "SHIFT": 2, "META": 3}
            return base_priority + modifier_order.get(key_name, 99)

        return base_priority + ord(key_name[0]) if key_name else base_priority + 999

    def get_supported_keys(self) -> list[KeyInfo]:
        """Get a list of all supported keys."""
        return list(self._key_registry.values())

    def get_combination_validation_errors(self) -> list[str]:
        """Get validation errors for the current combination."""
        errors = []

        if not self.current_combination.key:
            errors.append("No keys specified in combination")
            return errors

        # Check for at least one modifier
        modifier_keys = {"CTRL", "ALT", "SHIFT", "META"}
        if not any(key in modifier_keys for key in self.current_combination.modifiers):
            errors.append("Combination must include at least one modifier key (Ctrl, Alt, Shift, or Meta)")

        # Check for invalid keys
        for key in [*self.current_combination.modifiers, self.current_combination.key]:
            if not self._is_valid_key(key):
                errors.append(f"Unsupported key: {key}")

        return errors

    @classmethod
    def create_with_default_combination(cls) -> HotkeyBinding:
        """Create a hotkey binding with the default combination."""
        default_combination = KeyCombination.from_string("CTRL+SHIFT+R")
        return cls(current_combination=default_combination)

    @classmethod
    def create_from_string(cls, combination_string: str,
    ) -> HotkeyBinding:
        """Create a hotkey binding from a combination string."""
        combination = KeyCombination.from_string(combination_string)
        return cls(current_combination=combination)