"""Window Minimize/Close Controller.

Moves minimize-to-tray behavior and tray notifications out of the window class
into a dedicated controller. The presenter forwards events to this controller.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from src.domain.common.ports.logging_port import LoggingPort


class ITrayNotifier(Protocol):
    """Port for showing notifications through the tray coordination layer."""

    def show_tray_notification(self, title: str, message: str) -> None: ...


@dataclass
class WindowMinimizeController:
    """Controller encapsulating minimize-to-tray logic."""

    tray_notifier: ITrayNotifier | None
    logger: LoggingPort | None

    def handle_close_event(self, window: object, event: object) -> None:
        """Intercept close event to minimize to tray and notify the user."""
        try:
            # Ignore the close and hide the window
            if hasattr(event, "ignore"):
                event.ignore()
            if hasattr(window, "hide"):
                window.hide()

            if self.tray_notifier:
                try:
                    self.tray_notifier.show_tray_notification(
                        "App Minimized",
                        (
                            "The app is minimized to the system tray and running in the background. "
                            "Right-click the tray icon to restore or exit."
                        ),
                    )
                except Exception as e:  # best effort
                    if self.logger:
                        self.logger.log_warning(f"Failed to show tray notification: {e}")
        except Exception as e:
            if self.logger:
                self.logger.log_error(f"Error handling close event: {e}")


