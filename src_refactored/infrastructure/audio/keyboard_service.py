"""Keyboard Service.

This module implements the KeyboardService for managing keyboard hook operations
with event-driven patterns and comprehensive key combination handling.
Extracted from utils/listener.py keyboard hook implementation.
"""

import contextlib
import threading
from dataclasses import dataclass
from typing import Any, Protocol

from keyboard import hook, unhook_all

from src_refactored.domain.settings.value_objects.key_combination import KeyCombination
from src_refactored.domain.system_integration.value_objects.system_operations import (
    KeyboardServiceResult,
    KeyEventType,
)


@dataclass
class KeyEvent:
    """Represents a keyboard event."""
    event_type: KeyEventType
    key_name: str
    timestamp: float
    scan_code: int | None = None
    is_extended: bool = False


class KeyEventHandler(Protocol,
    ):
    """Protocol for key event handlers."""

    def __call__(self, event: KeyEvent,
    ) -> None:
        """Handle a key event."""
        ...


class HotkeyHandler(Protocol):
    """Protocol for hotkey handlers."""

    def on_hotkey_pressed(self, combination: KeyCombination,
    ) -> None:
        """Called when hotkey combination is pressed."""
        ...

    def on_hotkey_released(self, combination: KeyCombination,
    ) -> None:
        """Called when hotkey combination is released."""
        ...


@dataclass
class KeyboardServiceConfiguration:
    """Configuration for keyboard service."""
    enable_key_normalization: bool = True
    track_key_states: bool = True
    enable_event_logging: bool = False
    max_event_history: int = 100


class KeyboardService:
    """Service for managing keyboard hook operations with event-driven patterns."""

    def __init__(self, config: KeyboardServiceConfiguration | None = None):
        """Initialize the keyboard service."""
        self._config = config or KeyboardServiceConfiguration()
        self._is_hooked = False
        self._keys_down: set[str] = set()
        self._registered_hotkeys: dict[str, tuple[KeyCombination, HotkeyHandler]] = {}
        self._event_handlers: list[KeyEventHandler] = []
        self._event_history: list[KeyEvent] = []
        self._lock = threading.RLock()

        # Key normalization mapping
        self._key_mapping = {
            "CTRL": "ctrl",
            "ALT": "alt",
            "SHIFT": "shift",
            "WIN": "windows",
            "CMD": "cmd",
            "META": "windows",  # Map META to windows key
        }

    def start_hook(self) -> KeyboardServiceResult:
        """Start the keyboard hook."""
        with self._lock:
            if self._is_hooked:
                return KeyboardServiceResult.ALREADY_HOOKED

            try:
                hook(self._key_event_handler)
                self._is_hooked = True
                return KeyboardServiceResult.SUCCESS
            except Exception:
                return KeyboardServiceResult.FAILURE

    def stop_hook(self) -> KeyboardServiceResult:
        """Stop the keyboard hook."""
        with self._lock:
            if not self._is_hooked:
                return KeyboardServiceResult.NOT_HOOKED

            try:
                unhook_all()
                self._is_hooked = False
                self._keys_down.clear()
                return KeyboardServiceResult.SUCCESS
            except Exception:
                return KeyboardServiceResult.FAILURE

    def register_hotkey(self,
    hotkey_id: str, combination: KeyCombination, handler: HotkeyHandler,
    ) -> KeyboardServiceResult:
        """Register a hotkey combination with a handler."""
        with self._lock:
            if not combination.is_valid_for_recording():
                return KeyboardServiceResult.INVALID_COMBINATION

            self._registered_hotkeys[hotkey_id] = (combination, handler)
            return KeyboardServiceResult.SUCCESS

    def unregister_hotkey(self, hotkey_id: str,
    ) -> KeyboardServiceResult:
        """Unregister a hotkey combination."""
        with self._lock:
            if hotkey_id in self._registered_hotkeys:
                del self._registered_hotkeys[hotkey_id]
                return KeyboardServiceResult.SUCCESS
            return KeyboardServiceResult.NOT_HOOKED

    def add_event_handler(self, handler: KeyEventHandler,
    ) -> None:
        """Add a general key event handler."""
        with self._lock:
            self._event_handlers.append(handler)

    def remove_event_handler(self, handler: KeyEventHandler,
    ) -> bool:
        """Remove a key event handler."""
        with self._lock:
            try:
                self._event_handlers.remove(handler)
                return True
            except ValueError:
                return False

    def get_pressed_keys(self) -> set[str]:
        """Get currently pressed keys."""
        with self._lock:
            return self._keys_down.copy()

    def is_combination_pressed(self, combination: KeyCombination,
    ) -> bool:
        """Check if a specific key combination is currently pressed."""
        with self._lock:
            normalized_keys = self._normalize_key_combination(combination)
            return normalized_keys.issubset(self._keys_down)

    def get_event_history(self) -> list[KeyEvent]:
        """Get recent key event history."""
        with self._lock:
            return self._event_history.copy()

    def clear_event_history(self) -> None:
        """Clear the event history."""
        with self._lock:
            self._event_history.clear(,
    )

    def _key_event_handler(self, event: Any,
    ) -> None:
        """Internal handler for keyboard events from the hook."""
        try:
            # Convert keyboard library event to our KeyEvent
            key_event = KeyEvent(
event_type = (
    KeyEventType.KEY_DOWN if event.event_type == "down" else KeyEventType.KEY_UP,)
                key_name=event.name,
                timestamp=getattr(event, "time", 0.0)
                scan_code=getattr(event, "scan_code", None)
                is_extended=getattr(event, "is_extended", False),
            )

            with self._lock:
                # Update key state tracking
                if self._config.track_key_states:
                    if key_event.event_type == KeyEventType.KEY_DOWN:
                        self._keys_down.add(key_event.key_name)
                    else:
                        self._keys_down.discard(key_event.key_name)

                # Add to event history
                if self._config.enable_event_logging:
                    self._event_history.append(key_event)
                    if len(self._event_history) > self._config.max_event_history:
                        self._event_history.pop(0)

                # Check for hotkey matches
                self._check_hotkey_matches(key_event)

                # Notify general event handlers
                for handler in self._event_handlers:
                    try:
                        handler(key_event)
                    except Exception:
                        # Continue processing other handlers even if one fails
                        pass

        except Exception:
            # Prevent hook failures from crashing the application
            pass

    def _check_hotkey_matches(self, event: KeyEvent,
    ) -> None:
        """Check if current key state matches any registered hotkeys."""
        for (combination, handler) in self._registered_hotkeys.values():
            normalized_keys = self._normalize_key_combination(combination)

            if event.event_type == KeyEventType.KEY_DOWN:
                # Check if hotkey is now fully pressed
                if normalized_keys.issubset(self._keys_down):
                    with contextlib.suppress(Exception):
                        handler.on_hotkey_pressed(combination)

            elif event.event_type == KeyEventType.KEY_UP:
                # Check if hotkey is no longer fully pressed
                if not normalized_keys.issubset(self._keys_down):
                    with contextlib.suppress(Exception):
                        handler.on_hotkey_released(combination)

    def _normalize_key_combination(self, combination: KeyCombination,
    ) -> set[str]:
        """Normalize a key combination for comparison with pressed keys."""
        normalized_keys = set()

        # Normalize modifiers
        for modifier in combination.modifiers:
            normalized_key = self._normalize_key_name(modifier)
            if normalized_key:
                normalized_keys.add(normalized_key)

        # Normalize main key
        normalized_main_key = self._normalize_key_name(combination.key)
        if normalized_main_key:
            normalized_keys.add(normalized_main_key,
    )

        return normalized_keys

    def _normalize_key_name(self, key_name: str,
    ) -> str:
        """Normalize a key name for consistent comparison."""
        if not self._config.enable_key_normalization:
            return key_name

        key_upper = key_name.strip().upper()

        # Check if it's a known modifier
        if key_upper in self._key_mapping:
            return self._key_mapping[key_upper]

        # For regular keys, convert to lowercase
        return key_name.lower()

    def is_hooked(self) -> bool:
        """Check if the keyboard hook is active."""
        return self._is_hooked

    def get_registered_hotkeys(self) -> dict[str, KeyCombination]:
        """Get all registered hotkey combinations."""
        with self._lock:
            return {hotkey_id: combination for hotkey_id, (combination, _) in self._registered_hotkeys.items()}

    def shutdown(self) -> None:
        """Shutdown the keyboard service and clean up resources."""
        self.stop_hook()
        with self._lock:
            self._registered_hotkeys.clear()
            self._event_handlers.clear()
            self._event_history.clear()
            self._keys_down.clear()