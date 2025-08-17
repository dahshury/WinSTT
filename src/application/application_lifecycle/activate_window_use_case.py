"""Activate Window Use Case.

This module implements the use case for activating and bringing application
windows to the foreground, with support for multiple activation methods.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from src.domain.application_lifecycle.entities import ActivationConfiguration, WindowInfo
from src.domain.common.ports.time_port import ITimePort
from src.domain.window_management.value_objects import (
    ActivationMethod,
    ActivationResult,
    WindowState,
)


@dataclass
class ActivateWindowRequest:
    """Request for window activation."""
    window_identifier: str  # Title, class name, or handle
    configuration: ActivationConfiguration
    search_by_title: bool = True
    search_by_class: bool = False
    exact_match: bool = False
    case_sensitive: bool = False
    progress_callback: Callable[[int, str], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None


@dataclass
class ActivateWindowResponse:
    """Response from window activation."""
    result: ActivationResult
    window_info: WindowInfo | None = None
    method_used: ActivationMethod | None = None
    attempts_made: int = 0
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    activation_time_ms: float | None = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WindowFinderProtocol(Protocol,
    ):
    """Protocol for finding windows."""

    def find_by_title(
        self,
        title: str,
        exact_match: bool = False,
        case_sensitive: bool = False,
    ) -> list[WindowInfo]:
        """Find windows by title."""

    def find_by_class(self, class_name: str, exact_match: bool = False,
    ) -> list[WindowInfo]:
        """Find windows by class name."""

    def find_by_handle(self, handle: Any,
    ) -> WindowInfo | None:
        """Find window by handle."""

    def get_window_state(self, handle: Any,
    ) -> WindowState:
        """Get window state."""


class WindowActivatorProtocol(Protocol):
    """Protocol for window activation."""

    def activate_window(self, handle: Any,
    ) -> bool:
        """Activate window."""

    def bring_to_foreground(self, handle: Any,
    ) -> bool:
        """Bring window to foreground."""

    def restore_window(self, handle: Any,
    ) -> bool:
        """Restore minimized window."""

    def focus_window(self, handle: Any,
    ) -> bool:
        """Focus window."""

    def flash_window(self, handle: Any, count: int = 3) -> bool:
        """Flash window to get attention."""


class SystemTrayProtocol(Protocol):
    """Protocol for system tray interaction."""

    def show_from_tray(self) -> bool:
        """Show window from system tray."""

    def is_in_tray(self) -> bool:
        """Check if window is in system tray."""


class KeyboardProtocol(Protocol,
    ):
    """Protocol for keyboard shortcuts."""

    def send_shortcut(self, shortcut: str,
    ) -> bool:
        """Send keyboard shortcut."""


class ActivateWindowUseCase:
    """Use case for activating application windows."""

    def __init__(
        self,
        window_finder: WindowFinderProtocol,
        window_activator: WindowActivatorProtocol,
        system_tray: SystemTrayProtocol | None = None,
        keyboard: KeyboardProtocol | None = None,
        logger: logging.Logger | None = None,
        time_port: ITimePort | None = None,
    ):
        self.window_finder = window_finder
        self.window_activator = window_activator
        self.system_tray = system_tray
        self.keyboard = keyboard
        self.logger = logger
        self._time = time_port

    def execute(self, request: ActivateWindowRequest,
    ) -> ActivateWindowResponse:
        """Execute the window activation use case."""
        if self._time is None:
            msg = "ITimePort is required for ActivateWindowUseCase"
            raise ValueError(msg)
        start_time = self._time.get_current_time()

        response = ActivateWindowResponse(
            result=ActivationResult.ERROR,
        )

        try:
            if self.logger:
                self.logger.info("Activating window: %s", request.window_identifier)

            # Find the target window
            self._update_progress(request, 20, "Finding target window...")
            window_info = self._find_target_window(request, response)

            if not window_info:
                response.result = ActivationResult.WINDOW_NOT_FOUND
                response.error_message = f"Window not found: {request.window_identifier}"
                return response

            response.window_info = window_info

            # Attempt activation with configured method
            self._update_progress(request, 50, "Attempting window activation...")
            success = self._attempt_activation(request, response, window_info)

            if success:
                response.result = ActivationResult.SUCCESS
                end_time = self._time.get_current_time()
                response.activation_time_ms = (end_time - start_time) * 1000
                self._update_progress(request, 100, "Window activated successfully")

                if self.logger:
                    method_name = response.method_used.value if response.method_used else "unknown"
                    self.logger.info(
                        "Window activated successfully using %s",
                        method_name,
                    )
            else:
                response.result = ActivationResult.ACTIVATION_FAILED
                response.error_message = "All activation methods failed"

                if self.logger:
                    self.logger.warning(
                        "Failed to activate window after %d attempts",
                        response.attempts_made,
                    )

            return response

        except Exception as e:
            return self._create_error_response(f"Window activation failed: {e!s}", response, e)

    def _find_target_window(self,
    request: ActivateWindowRequest, response: ActivateWindowResponse,
    ) -> WindowInfo | None:
        """Find the target window to activate."""
        try:
            windows = []

            # Search by title if requested
            if request.search_by_title:
                title_windows = self.window_finder.find_by_title(
                    request.window_identifier,
                    exact_match=request.exact_match,
                    case_sensitive=request.case_sensitive,
                )
                windows.extend(title_windows)

            # Search by class if requested
            if request.search_by_class:
                class_windows = self.window_finder.find_by_class(
                    request.window_identifier,
                    exact_match=request.exact_match,
                )
                windows.extend(class_windows)

            # Try to find by handle if identifier looks like a handle
            if not windows and str(request.window_identifier).isdigit():
                try:
                    handle = int(request.window_identifier)
                    window_info = self.window_finder.find_by_handle(handle)
                    if window_info:
                        windows.append(window_info,
    )
                except ValueError:
                    pass

            if not windows:
                return None

            # Return the first visible and enabled window
            for window in windows:
                if window.is_visible and window.is_enabled:
                    return window

            # If no visible/enabled window, return the first one
            return windows[0] if windows else None

        except Exception as e:
            if self.logger:
                self.logger.warning("Window search failed: %s", e)
            response.warnings.append(f"Window search error: {e!s}")
            return None

    def _attempt_activation(self,
    request: ActivateWindowRequest, response: ActivateWindowResponse, window_info: WindowInfo,
    ) -> bool:
        """Attempt to activate the window using configured methods."""
        config = request.configuration
        methods_to_try = [config.method, *config.fallback_methods]

        for method in methods_to_try:
            for attempt in range(config.retry_attempts):
                response.attempts_made += 1

                try:
                    if attempt > 0:
                        if self._time is None:
                            msg = "ITimePort is required for retry delays"
                            raise ValueError(msg)
                        self._time.sleep(config.retry_delay_seconds)

                    success = self._activate_with_method(method, config, window_info, response)

                    if success:
                        response.method_used = method
                        return True

                except Exception as e:
                    if self.logger:
                        self.logger.debug("Activation attempt %d with %s failed: %s", attempt + 1, method.value, e)
                    response.warnings.append(f"{method.value} attempt {attempt + 1} error: {e!s}")

        return False

    def _activate_with_method(self,
    method: ActivationMethod, config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Activate window using specific method."""
        if method == ActivationMethod.WIN32_API:
            return self._activate_via_win32(config, window_info, response)
        if method == ActivationMethod.QT_NATIVE:
            return self._activate_via_qt(config, window_info, response)
        if method == ActivationMethod.SYSTEM_TRAY:
            return self._activate_via_system_tray(config, window_info, response)
        if method == ActivationMethod.KEYBOARD_SHORTCUT:
            return self._activate_via_keyboard(config, window_info, response)
        if method == ActivationMethod.FORCE_FOREGROUND:
            return self._activate_via_force_foreground(config, window_info, response)
        response.warnings.append(f"Unsupported activation method: {method.value}")
        return False

    def _activate_via_win32(self,
    config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Activate window using Win32 API."""
        try:
            # Restore if minimized
            if config.restore_if_minimized and window_info.state == WindowState.MINIMIZED and not self.window_activator.restore_window(window_info.handle):
                    return False

            # Activate the window
            if not self.window_activator.activate_window(window_info.handle):
                return False

            # Bring to foreground
            if config.bring_to_foreground and not self.window_activator.bring_to_foreground(window_info.handle):
                return False

            # Focus the window
            if config.focus_window:
                if not self.window_activator.focus_window(window_info.handle):
                    return False

            # Flash window if requested
            if config.flash_window:
                self.window_activator.flash_window(window_info.handle, config.flash_count)

            return True

        except Exception as e:
            response.warnings.append(f"Win32 activation error: {e!s}")
            return False

    def _activate_via_qt(self,
    config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Activate window using Qt native methods."""
        try:
            # Basic activation
            success = self.window_activator.activate_window(window_info.handle)

            if success and config.bring_to_foreground:
                success = self.window_activator.bring_to_foreground(window_info.handle)

            return success

        except Exception as e:
            response.warnings.append(f"Qt activation error: {e!s}",
    )
            return False

    def _activate_via_system_tray(self,
    config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Activate window via system tray."""
        if not self.system_tray:
            response.warnings.append("System tray not available")
            return False

        try:
            if self.system_tray.is_in_tray():
                return self.system_tray.show_from_tray()
            # Fall back to direct activation
            return self.window_activator.activate_window(window_info.handle)

        except Exception as e:
            response.warnings.append(f"System tray activation error: {e!s}")
            return False

    def _activate_via_keyboard(self,
    config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Activate window using keyboard shortcut."""
        if not self.keyboard:
            response.warnings.append("Keyboard interface not available")
            return False

        try:
            # Common shortcuts for window activation
            shortcuts = ["Alt+Tab", "Win+Tab", "Ctrl+Alt+Tab"]

            for shortcut in shortcuts:
                if self.keyboard.send_shortcut(shortcut):
                    if self._time is None:
                        msg = "ITimePort is required for activation delay"
                        raise ValueError(msg)
                    self._time.sleep(0.5)
                    # Verify activation by checking window state
                    current_state = self.window_finder.get_window_state(window_info.handle)
                    if current_state != WindowState.MINIMIZED:
                        return True

            return False

        except Exception as e:
            response.warnings.append(f"Keyboard activation error: {e!s}")
            return False

    def _activate_via_force_foreground(self,
    config: ActivationConfiguration, window_info: WindowInfo, response: ActivateWindowResponse,
    ) -> bool:
        """Force window to foreground using aggressive methods."""
        try:
            # Multiple attempts with different approaches
            methods = [
                lambda: self.window_activator.restore_window(window_info.handle),
                lambda: self.window_activator.activate_window(window_info.handle),
                lambda: self.window_activator.bring_to_foreground(window_info.handle),
                lambda: self.window_activator.focus_window(window_info.handle),
            ]

            success = True
            for method in methods:
                try:
                    if not method():
                        success = False
                except Exception:
                    success = False

            return success

        except Exception as e:
            response.warnings.append(f"Force foreground error: {e!s}")
            return False

    def _update_progress(self, request: ActivateWindowRequest, percentage: int, message: str,
    ) -> None:
        """Update activation progress."""
        if request.progress_callback:
            request.progress_callback(percentage, message)

    def _create_error_response(
        self,
        error_message: str,
        response: ActivateWindowResponse,
        exception: Exception | None = None,
    ) -> ActivateWindowResponse:
        """Create an error response."""
        response.result = ActivationResult.ERROR
        response.error_message = error_message

        if self.logger:
            if exception:
                self.logger.exception(f"Window activation error: {error_message}")
            else:
                self.logger.error("Window activation error: {error_message}")

        return response

    def find_windows(self,
        identifier: str,
        search_by_title: bool = True,
        search_by_class: bool = False,
    ) -> list[WindowInfo]:
        """Find windows matching the identifier."""
        try:
            windows = []

            if search_by_title:
                windows.extend(self.window_finder.find_by_title(identifier))

            if search_by_class:
                windows.extend(self.window_finder.find_by_class(identifier))

            return windows

        except Exception:
            if self.logger:
                self.logger.warning("Window search failed: {e!s}")
            return []

    def get_window_info(self, handle: Any,
    ) -> WindowInfo | None:
        """Get information about a specific window."""
        try:
            return self.window_finder.find_by_handle(handle)
        except Exception:
            if self.logger:
                self.logger.warning("Failed to get window info: {e!s}")
            return None