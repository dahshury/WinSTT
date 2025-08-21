"""Keyboard Service.

This module implements the KeyboardService for managing keyboard hook operations
with event-driven patterns and comprehensive key combination handling.
Extracted from utils/listener.py keyboard hook implementation.
"""

import contextlib
import threading
from dataclasses import dataclass
from typing import Any, Protocol

from keyboard import add_hotkey, hook, remove_hotkey, unhook_all

from src.domain.settings.value_objects.key_combination import KeyCombination
from src.domain.system_integration.value_objects.system_operations import (
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


class _FunctionHotkeyHandler(HotkeyHandler):
    """Adapter to allow plain functions with a single 'on_hotkey_pressed' method."""

    def __init__(self, on_pressed: Any, on_released: Any | None = None):
        self._on_pressed = on_pressed
        self._on_released = on_released

    def on_hotkey_pressed(self, combination: KeyCombination) -> None:
        if callable(self._on_pressed):
            self._on_pressed(combination)

    def on_hotkey_released(self, combination: KeyCombination) -> None:
        if callable(self._on_released):
            self._on_released(combination)


@dataclass
class KeyboardServiceConfiguration:
    """Configuration for keyboard service."""
    enable_key_normalization: bool = True
    track_key_states: bool = True
    enable_event_logging: bool = False
    max_event_history: int = 100
    # When True, suppress registered hotkeys from reaching the OS
    suppress_hotkeys: bool = True


class KeyboardService:
    """Service for managing keyboard hook operations with event-driven patterns."""

    def __init__(self, config: KeyboardServiceConfiguration | None = None):
        """Initialize the keyboard service."""
        self._config = config or KeyboardServiceConfiguration()
        self._is_hooked = False
        self._keys_down: set[str] = set()
        self._registered_hotkeys: dict[str, tuple[KeyCombination, HotkeyHandler]] = {}
        # Handles returned by `keyboard.add_hotkey` for suppression cleanup
        self._suppression_handles: dict[str, Any] = {}
        self._event_handlers: list[KeyEventHandler] = []
        self._event_history: list[KeyEvent] = []
        self._lock = threading.RLock()
        self._pynput_listener = None  # Fallback listener when `keyboard` hook fails
        self._using_keyboard_lib_hook = False  # True when using `keyboard` library hook

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
                self._using_keyboard_lib_hook = True
                # Install suppression for any hotkeys already registered
                if self._config.suppress_hotkeys and self._registered_hotkeys:
                    for hotkey_id, (combination, _handler) in self._registered_hotkeys.items():
                        combo_str = self._to_keyboard_library_string(combination)
                        with contextlib.suppress(Exception):
                            handle = add_hotkey(combo_str, lambda: None, suppress=True)
                            self._suppression_handles[hotkey_id] = handle
                return KeyboardServiceResult.SUCCESS
            except Exception:
                # Fallback: try pynput-based listener if keyboard.hook is unavailable (e.g., no admin perms)
                try:  # pragma: no cover - platform-specific fallback
                    import time as _time

                    from pynput import keyboard as _kb

                    def _name_from_key(k: object) -> str | None:
                        try:
                            from pynput.keyboard import Key, KeyCode  # type: ignore
                            if isinstance(k, KeyCode) and getattr(k, "char", None):
                                return str(k.char).lower()
                            if isinstance(k, Key):
                                special = {
                                    getattr(Key, "ctrl", None): "ctrl",
                                    getattr(Key, "ctrl_l", None): "ctrl",
                                    getattr(Key, "ctrl_r", None): "ctrl",
                                    getattr(Key, "alt", None): "alt",
                                    getattr(Key, "alt_l", None): "alt",
                                    getattr(Key, "alt_r", None): "alt",
                                    getattr(Key, "shift", None): "shift",
                                    getattr(Key, "shift_l", None): "shift",
                                    getattr(Key, "shift_r", None): "shift",
                                    getattr(Key, "cmd", None): "windows",
                                    getattr(Key, "cmd_l", None): "windows",
                                    getattr(Key, "cmd_r", None): "windows",
                                }
                                if k in special and special[k] is not None:
                                    return special[k]
                                # Function keys
                                for i in range(1, 36):
                                    if getattr(Key, f"f{i}", None) == k:
                                        return f"f{i}"
                            return None
                        except Exception:
                            return None

                    def _on_press(k: object) -> None:
                        name = _name_from_key(k)
                        if not name:
                            return
                        evt = KeyEvent(
                            event_type=KeyEventType.KEY_DOWN,
                            key_name=name,
                            timestamp=_time.time(),
                        )
                        self._key_event_handler(evt)  # Reuse unified path

                    def _on_release(k: object) -> None:
                        name = _name_from_key(k)
                        if not name:
                            return
                        evt = KeyEvent(
                            event_type=KeyEventType.KEY_UP,
                            key_name=name,
                            timestamp=_time.time(),
                        )
                        self._key_event_handler(evt)

                    self._pynput_listener = _kb.Listener(on_press=_on_press, on_release=_on_release)
                    self._pynput_listener.start()
                    self._is_hooked = True
                    self._using_keyboard_lib_hook = False
                    return KeyboardServiceResult.SUCCESS
                except Exception:
                    return KeyboardServiceResult.FAILURE

    def stop_hook(self) -> KeyboardServiceResult:
        """Stop the keyboard hook."""
        with self._lock:
            if not self._is_hooked:
                return KeyboardServiceResult.NOT_HOOKED

            try:
                # Try to stop native keyboard hook
                with contextlib.suppress(Exception):
                    unhook_all()
                # Stop pynput fallback if it was used
                if self._pynput_listener is not None:
                    with contextlib.suppress(Exception):
                        self._pynput_listener.stop()
                    self._pynput_listener = None
                # Remove any suppression hotkeys
                if self._suppression_handles:
                    for _id, handle in list(self._suppression_handles.items()):
                        with contextlib.suppress(Exception):
                            remove_hotkey(handle)
                    self._suppression_handles.clear()
                self._is_hooked = False
                self._keys_down.clear()
                return KeyboardServiceResult.SUCCESS
            except Exception:
                return KeyboardServiceResult.FAILURE

    def register_hotkey(self,
    hotkey_id: str, combination: KeyCombination, handler: HotkeyHandler | Any,
    ) -> KeyboardServiceResult:
        """Register a hotkey combination with a handler."""
        with self._lock:
            if not combination.is_valid_for_recording():
                return KeyboardServiceResult.INVALID_COMBINATION

            # Wrap plain callables into the adapter
            if not hasattr(handler, "on_hotkey_pressed"):
                handler = _FunctionHotkeyHandler(handler)

            self._registered_hotkeys[hotkey_id] = (combination, handler)  # type: ignore[arg-type]
            # Best-effort suppression using `keyboard.add_hotkey` if available
            if self._config.suppress_hotkeys and self._using_keyboard_lib_hook:
                combo_str = self._to_keyboard_library_string(combination)
                with contextlib.suppress(Exception):
                    # No-op callback; real logic handled by unified event path
                    handle = add_hotkey(combo_str, lambda: None, suppress=True)
                    self._suppression_handles[hotkey_id] = handle
            return KeyboardServiceResult.SUCCESS

    def unregister_hotkey(self, hotkey_id: str,
    ) -> KeyboardServiceResult:
        """Unregister a hotkey combination."""
        with self._lock:
            if hotkey_id in self._registered_hotkeys:
                del self._registered_hotkeys[hotkey_id]
                # Remove suppression if present
                if hotkey_id in self._suppression_handles:
                    handle = self._suppression_handles.pop(hotkey_id)
                    with contextlib.suppress(Exception):
                        remove_hotkey(handle)
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
            self._event_history.clear()

    def _key_event_handler(self, event: Any,
    ) -> None:
        """Internal handler for keyboard events from the hook or fallback listener."""
        try:
            # If event is already our KeyEvent (from pynput fallback), use it directly
            if isinstance(event, KeyEvent):
                key_event = event
            else:
                # Convert keyboard library event to our KeyEvent
                ev_type = KeyEventType.KEY_DOWN if getattr(event, "event_type", "") == "down" else KeyEventType.KEY_UP
                key_event = KeyEvent(
                    event_type=ev_type,
                    key_name=getattr(event, "name", ""),
                    timestamp=getattr(event, "time", 0.0),
                    scan_code=getattr(event, "scan_code", None),
                    is_extended=getattr(event, "is_extended", False),
                )

            with self._lock:
                # Update key state tracking
                if self._config.track_key_states:
                    normalized_name = self._normalize_key_name(key_event.key_name)
                    if key_event.event_type == KeyEventType.KEY_DOWN:
                        self._keys_down.add(normalized_name)
                    else:
                        self._keys_down.discard(normalized_name)

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
            normalized_keys.add(normalized_main_key)

        return normalized_keys

    def _normalize_key_name(self, key_name: str,
    ) -> str:
        """Normalize a key name for consistent comparison."""
        if not self._config.enable_key_normalization:
            return key_name

        raw = key_name.strip()
        key_upper = raw.upper()

        # Handle left/right variants and common synonyms
        lr_mapping = {
            "LEFT CTRL": "CTRL",
            "RIGHT CTRL": "CTRL",
            "LCTRL": "CTRL",
            "RCTRL": "CTRL",
            "LEFT ALT": "ALT",
            "RIGHT ALT": "ALT",
            "LALT": "ALT",
            "RALT": "ALT",
            "ALTGR": "ALT",
            "ALT GR": "ALT",
            "LEFT SHIFT": "SHIFT",
            "RIGHT SHIFT": "SHIFT",
            "LSHIFT": "SHIFT",
            "RSHIFT": "SHIFT",
            "LEFT WIN": "WIN",
            "RIGHT WIN": "WIN",
            "LEFT WINDOWS": "WIN",
            "RIGHT WINDOWS": "WIN",
            "LWIN": "WIN",
            "RWIN": "WIN",
            "WINDOWS": "WIN",
        }
        if key_upper in lr_mapping:
            key_upper = lr_mapping[key_upper]

        # Check if it's a known modifier
        if key_upper in self._key_mapping:
            return self._key_mapping[key_upper]

        # For regular keys, convert to lowercase
        return raw.lower()

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

    # Internal helpers
    def _to_keyboard_library_string(self, combination: KeyCombination,
    ) -> str:
        """Convert KeyCombination to `keyboard` library string (e.g., 'ctrl+alt+a')."""
        def _map_modifier(name: str) -> str:
            mapping = {
                "CTRL": "ctrl",
                "ALT": "alt",
                "SHIFT": "shift",
                "META": "windows",
                "CMD": "windows",
            }
            return mapping.get(name.upper(), name.lower())

        parts: list[str] = []
        for mod in combination.modifiers:
            parts.append(_map_modifier(mod))
        parts.append(combination.key.lower())
        return "+".join(parts)