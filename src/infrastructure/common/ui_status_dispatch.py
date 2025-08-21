"""Global UI status dispatch registration.

Provides a process-wide place to register and retrieve a UI status callback
so non-UI components (e.g., settings flow) can emit progress/status updates
without tightly coupling to the main window.
"""

from __future__ import annotations

from typing import Callable, Optional


_ui_status_cb: Optional[Callable[[str | None, str | None, float | None, bool | None, bool | None], None]] = None


def set_ui_status_callback(cb: Callable[[str | None, str | None, float | None, bool | None, bool | None], None]) -> None:

	global _ui_status_cb
	_ui_status_cb = cb


def get_ui_status_callback() -> Optional[Callable[[str | None, str | None, float | None, bool | None, bool | None], None]]:

	return _ui_status_cb


