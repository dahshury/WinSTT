"""Pyperclip Clipboard Adapter.

Abstracts clipboard operations used by legacy listener.
"""

from __future__ import annotations

import pyperclip


class PyperclipAdapter:
    """Minimal clipboard adapter around pyperclip."""

    def copy_text(self, text: str) -> bool:
        try:
            pyperclip.copy(text)
        except Exception:
            return False
        return True

    def paste_text(self) -> str | None:
        try:
            value = pyperclip.paste()
        except Exception:
            return None
        return value


