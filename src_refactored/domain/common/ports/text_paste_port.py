"""Domain port for pasting/transferring text to the active application.

This abstracts clipboard/keyboard specifics behind a clean port so that the
application layer can request a paste operation without depending on concrete
UI or OS APIs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class TextPastePort(ABC):
    """Port for pasting text into the focused application."""

    @abstractmethod
    def paste_text(self, text: str) -> None:
        """Paste the given text at the current caret position.

        Implementations may use clipboard and simulated keyboard events.
        """
        raise NotImplementedError


