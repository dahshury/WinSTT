"""Infrastructure adapter that implements TextPastePort using clipboard + Ctrl+V.

Uses pyperclip to set the clipboard and pynput to simulate Ctrl+V, matching
the original behavior while keeping concerns in infrastructure.
"""

from __future__ import annotations

from time import sleep

try:
    import pyperclip  # type: ignore
    from pynput.keyboard import Controller, Key  # type: ignore
except Exception:  # pragma: no cover
    pyperclip = None
    Controller = None
    Key = None

from typing import TYPE_CHECKING

from src.domain.common.ports.text_paste_port import TextPastePort

if TYPE_CHECKING:
    from src.domain.common.ports.logging_port import LoggingPort


class ClipboardTextPasteAdapter(TextPastePort):
    """Concrete adapter for pasting text via clipboard and simulated keys."""

    def __init__(self, logger: LoggingPort | None = None) -> None:
        self._logger = logger
        self._keyboard = Controller() if Controller is not None else None

    def paste_text(self, text: str) -> None:
        """Paste the given text at the current caret position."""
        try:
            if pyperclip is None or self._keyboard is None or Key is None:
                if self._logger:
                    self._logger.log_warning("Clipboard/keyboard libraries not available; skip paste")
                return

            # Normalize new paragraphs as in legacy impl
            normalized = text.replace("New paragraph.", "\n\n")
            pyperclip.copy(normalized)

            # Small delay to ensure clipboard is ready
            sleep(0.01)

            self._keyboard.press(Key.ctrl)
            self._keyboard.press("v")
            self._keyboard.release("v")
            self._keyboard.release(Key.ctrl)

        except Exception as exc:  # pragma: no cover
            if self._logger:
                self._logger.log_error("Failed to paste text", exception=exc)


