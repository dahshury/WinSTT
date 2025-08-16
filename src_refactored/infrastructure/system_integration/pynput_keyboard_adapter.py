"""Pynput Keyboard Adapter.

Provides a minimal keystroke simulation API using pynput.
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING

from pynput.keyboard import Controller, Key

if TYPE_CHECKING:
    from collections.abc import Iterable


class PynputKeyboardAdapter:
    """Thin wrapper around pynput.keyboard.Controller."""

    def __init__(self) -> None:
        self._controller = Controller()

    def press_key(self, key: str | Key) -> None:
        with contextlib.suppress(Exception):
            self._controller.press(key)

    def release_key(self, key: str | Key) -> None:
        with contextlib.suppress(Exception):
            self._controller.release(key)

    def press_combo(self, keys: Iterable[str | Key]) -> None:
        try:
            for k in keys:
                self._controller.press(k)
            for k in reversed(list(keys)):
                self._controller.release(k)
        except Exception:
            pass

    def send_paste(self) -> None:
        """Simulate Ctrl+V paste."""
        try:
            self.press_combo([Key.ctrl, "v"])  # type: ignore[list-item]
        except Exception:
            pass


