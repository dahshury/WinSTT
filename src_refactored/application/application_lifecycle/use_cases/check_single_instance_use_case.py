"""Check Single Instance Use Case.

This module implements the use case for checking and enforcing single instance
behavior of the application, including instance detection and window activation.
"""

import logging
import socket
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from src_refactored.domain.application_lifecycle.entities import SingleInstanceConfiguration
from src_refactored.domain.application_lifecycle.value_objects import (
    InstanceCheckMethod,
    InstanceCheckResult,
)
from src_refactored.domain.window_management.value_objects import (
    ActivationMethod as WindowActivationMethod,
)


@dataclass
class CheckSingleInstanceRequest:
    """Request for single instance checking."""
    configuration: SingleInstanceConfiguration
    application_name: str
    window_title: str | None = None
    activation_callback: Callable[[bool], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None


@dataclass
class CheckSingleInstanceResponse:
    """Response from single instance checking."""
    result: InstanceCheckResult
    is_first_instance: bool = False
    existing_window_found: bool = False
    activation_attempted: bool = False
    activation_successful: bool = False
    error_message: str | None = None
    warnings: list[str] = None
    lock_resource: Any | None = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class SocketManagerProtocol(Protocol,
    ):
    """Protocol for socket management."""

    def bind_socket(self, host: str, port: int,
    ) -> tuple[bool, socket.socket | None]:
        """Bind to socket for instance checking."""
        ...

    def cleanup_socket(self, sock: socket.socket | None) -> None:
        """Cleanup socket resources."""
        ...


class FileLockManagerProtocol(Protocol):
    """Protocol for file lock management."""

    def acquire_lock(self, file_path: str,
    ) -> tuple[bool, Any | None]:
        """Acquire file lock."""
        ...

    def release_lock(self, lock: Any | None) -> None:
        """Release file lock."""
        ...


class WindowActivatorProtocol(Protocol):
    """Protocol for window activation."""

    def find_window(self, window_title: str, class_name: str | None = None) -> Any | None:
        """Find existing window."""
        ...

    def activate_window(self, window_handle: Any,
    ) -> bool:
        """Activate existing window."""
        ...

    def bring_to_foreground(self, window_handle: Any,
    ) -> bool:
        """Bring window to foreground."""
        ...


class ProcessManagerProtocol(Protocol):
    """Protocol for process management."""

    def find_processes(self, process_name: str,
    ) -> list[int]:
        """Find processes by name."""
        ...

    def get_current_process_id(self) -> int:
        """Get current process ID."""
        ...


class CheckSingleInstanceUseCase:
    """Use case for checking single instance behavior."""

    def __init__(
        self,
        socket_manager: SocketManagerProtocol | None = None,
        file_lock_manager: FileLockManagerProtocol | None = None,
        window_activator: WindowActivatorProtocol | None = None,
        process_manager: ProcessManagerProtocol | None = None,
        logger: logging.Logger | None = None,
    ):
        self.socket_manager = socket_manager
        self.file_lock_manager = file_lock_manager
        self.window_activator = window_activator
        self.process_manager = process_manager
        self.logger = logger
        self._lock_resource = None

    def execute(self, request: CheckSingleInstanceRequest,
    ) -> CheckSingleInstanceResponse:
        """Execute the single instance checking use case."""
        response = CheckSingleInstanceResponse(
            result=InstanceCheckResult.CHECK_FAILED,
        )

        try:
            if self.logger:
                self.logger.info("Checking single instance for: {request.application_name}")

            # Check if another instance is running
            is_first = self._check_instance(request, response)
            response.is_first_instance = is_first

            if is_first:
                response.result = InstanceCheckResult.FIRST_INSTANCE
                if self.logger:
                    self.logger.info("This is the first instance")
                return response

            # Another instance is running, try to activate it
            response.result = InstanceCheckResult.ALREADY_RUNNING
            if self.logger:
                self.logger.info("Another instance is already running")

            # Attempt window activation
            activation_success = self._activate_existing_window(request, response)
            response.activation_attempted = True
            response.activation_successful = activation_success

            if activation_success:
                response.result = InstanceCheckResult.ACTIVATION_SUCCESS
                if self.logger:
                    self.logger.info("Successfully activated existing window")
            else:
                response.result = InstanceCheckResult.ACTIVATION_FAILED
                response.warnings.append("Failed to activate existing window")
                if self.logger:
                    self.logger.warning("Failed to activate existing window")

            return response

        except Exception as e:
            return self._create_error_response(f"Single instance check failed: {e!s}", response, e)

    def _check_instance(self, request: CheckSingleInstanceRequest, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Check if this is the first instance."""
        config = request.configuration

        if config.check_method == InstanceCheckMethod.SOCKET_BINDING:
            return self._check_via_socket(config, response)
        if config.check_method == InstanceCheckMethod.FILE_LOCK:
            return self._check_via_file_lock(config, response)
        if config.check_method == InstanceCheckMethod.PROCESS_CHECK:
            return self._check_via_process(request, response)
        response.warnings.append(f"Unsupported check method: {config.check_method.value}")
        return True  # Default to allowing instance

    def _check_via_socket(self, config: SingleInstanceConfiguration, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Check instance using socket binding."""
        if not self.socket_manager:
            response.warnings.append("Socket manager not available")
            return True

        try:
            success, sock = self.socket_manager.bind_socket(config.socket_host, config.socket_port)

            if success:
                self._lock_resource = sock
                response.lock_resource = sock
                return True
            return False

        except Exception as e:
            if self.logger:
                self.logger.warning("Socket binding check failed: {e!s}")
            response.warnings.append(f"Socket check error: {e!s}")
            return True  # Default to allowing instance on error

    def _check_via_file_lock(self, config: SingleInstanceConfiguration, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Check instance using file lock."""
        if not self.file_lock_manager or not config.lock_file_path:
            response.warnings.append("File lock manager or lock file path not available")
            return True

        try:
            success, lock = self.file_lock_manager.acquire_lock(config.lock_file_path)

            if success:
                self._lock_resource = lock
                response.lock_resource = lock
                return True
            return False

        except Exception as e:
            if self.logger:
                self.logger.warning("File lock check failed: {e!s}")
            response.warnings.append(f"File lock error: {e!s}")
            return True  # Default to allowing instance on error

    def _check_via_process(self, request: CheckSingleInstanceRequest, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Check instance using process enumeration."""
        if not self.process_manager:
            response.warnings.append("Process manager not available")
            return True

        try:
            current_pid = self.process_manager.get_current_process_id()
            processes = self.process_manager.find_processes(request.application_name)

            # Filter out current process
            other_processes = [pid for pid in processes if pid != current_pid]

            return len(other_processes) == 0

        except Exception as e:
            if self.logger:
                self.logger.warning("Process check failed: {e!s}")
            response.warnings.append(f"Process check error: {e!s}",
    )
            return True  # Default to allowing instance on error

    def _activate_existing_window(self,
    request: CheckSingleInstanceRequest, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Activate existing application window."""
        if not self.window_activator or not request.window_title:
            response.warnings.append("Window activator or window title not available")
            return False

        config = request.configuration

        for attempt in range(config.retry_attempts):
            try:
                if attempt > 0:
                    time.sleep(config.retry_delay_seconds)

                # Find the window
                window_handle = self.window_activator.find_window(request.window_title)

                if not window_handle:
                    if self.logger:
                        self.logger.debug("Window not found on attempt {attempt + 1}")
                    continue

                response.existing_window_found = True

                # Try to activate the window
                if config.activation_method == WindowActivationMethod.WIN32_API:
                    success = self._activate_via_win32(window_handle, response)
                elif config.activation_method == WindowActivationMethod.QT_ACTIVATION:
                    success = self._activate_via_qt(window_handle, response)
                else:
                    success = self.window_activator.activate_window(window_handle)

                if success:
                    if request.activation_callback:
                        request.activation_callback(True)
                    return True

            except Exception as e:
                if self.logger:
                    self.logger.warning("Window activation attempt {attempt + 1} failed: {e!s}")
                response.warnings.append(f"Activation attempt {attempt + 1} error: {e!s}")

        if request.activation_callback:
            request.activation_callback(False,
    )

        return False

    def _activate_via_win32(self, window_handle: Any, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Activate window using Win32 API."""
        try:
            # First try to activate
            if not self.window_activator.activate_window(window_handle):
                return False

            # Then bring to foreground
            return self.window_activator.bring_to_foreground(window_handle)

        except Exception as e:
            response.warnings.append(f"Win32 activation error: {e!s}")
            return False

    def _activate_via_qt(self, window_handle: Any, response: CheckSingleInstanceResponse,
    ) -> bool:
        """Activate window using Qt methods."""
        try:
            return self.window_activator.activate_window(window_handle)

        except Exception as e:
            response.warnings.append(f"Qt activation error: {e!s}")
            return False

    def cleanup(self) -> None:
        """Cleanup resources used for instance checking."""
        try:
            if self._lock_resource:
                if self.socket_manager and isinstance(self._lock_resource, socket.socket):
                    self.socket_manager.cleanup_socket(self._lock_resource)
                elif self.file_lock_manager:
                    self.file_lock_manager.release_lock(self._lock_resource)

                self._lock_resource = None

                if self.logger:
                    self.logger.info("Instance checking resources cleaned up")

        except Exception:
            if self.logger:
                self.logger.warning("Cleanup error: {e!s}")

    def _create_error_response(
        self,
        error_message: str,
        response: CheckSingleInstanceResponse,
        exception: Exception | None = None,
    ) -> CheckSingleInstanceResponse:
        """Create an error response."""
        response.result = InstanceCheckResult.CHECK_FAILED
        response.error_message = error_message

        if self.logger:
            if exception:
                self.logger.exception(f"Single instance check error: {error_message}")
            else:
                self.logger.error("Single instance check error: {error_message}")

        return response

    def get_lock_resource(self) -> Any | None:
        """Get the current lock resource."""
        return self._lock_resource

    def is_instance_locked(self) -> bool:
        """Check if instance is currently locked."""
        return self._lock_resource is not None