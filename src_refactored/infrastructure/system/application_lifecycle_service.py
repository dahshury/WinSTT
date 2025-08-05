"""Application lifecycle service for managing application startup, shutdown, and cleanup.

This module provides infrastructure services for application lifecycle management,
including cleanup registration, graceful shutdown, and error handling.
"""

import atexit
import contextlib
import sys
from collections.abc import Callable
from typing import Any


class CleanupHandler:
    """Container for cleanup handler information."""

    def __init__(self, name: str, handler: Callable[[], None], priority: int = 0):
        """Initialize cleanup handler.
        
        Args:
            name: Name of the cleanup handler
            handler: Cleanup function to call
            priority: Priority for cleanup order (higher priority runs first)
        """
        self.name = name
        self.handler = handler
        self.priority = priority

    def __repr__(self,
    ) -> str:
        return f"CleanupHandler(name='{self.name}', priority={self.priority})"


class ApplicationLifecycleService:
    """Service for managing application lifecycle and cleanup operations.
    
    This service provides infrastructure-only logic for application lifecycle
    management, without any UI or business logic dependencies.
    """

    def __init__(self):
        """Initialize the application lifecycle service."""
        self._cleanup_handlers: list[CleanupHandler] = []
        self._is_shutdown_registered = False
        self._shutdown_in_progress = False
        self._exit_code = 0

    def register_cleanup_handler(
    self,
    name: str,
    handler: Callable[[],
    None],
    priority: int = 0) -> None:
        """Register a cleanup handler to be called on application shutdown.
        
        Args:
            name: Name of the cleanup handler
            handler: Cleanup function to call
            priority: Priority for cleanup order (higher priority runs first,
    )
        """
        cleanup_handler = CleanupHandler(name, handler, priority)
        self._cleanup_handlers.append(cleanup_handler)

        # Register atexit handler if not already done
        if not self._is_shutdown_registered:
            atexit.register(self._perform_cleanup)
            self._is_shutdown_registered = True

    def unregister_cleanup_handler(self, name: str,
    ) -> bool:
        """Unregister a cleanup handler by name.
        
        Args:
            name: Name of the cleanup handler to remove
            
        Returns:
            True if handler was found and removed, False otherwise
        """
        for i, handler in enumerate(self._cleanup_handlers):
            if handler.name == name:
                del self._cleanup_handlers[i]
                return True
        return False

    def get_cleanup_handlers(self) -> list[CleanupHandler]:
        """Get list of registered cleanup handlers.
        
        Returns:
            List of CleanupHandler objects sorted by priority (descending)
        """
        return sorted(self._cleanup_handlers, key=lambda h: h.priority, reverse=True)

    def _perform_cleanup(self) -> None:
        """Perform cleanup operations in priority order."""
        if self._shutdown_in_progress:
            return

        self._shutdown_in_progress = True

        # Sort handlers by priority (higher priority first)
        sorted_handlers = self.get_cleanup_handlers()

        for handler in sorted_handlers:
            try:
                handler.handler()
            except Exception:
                # Ignore errors during cleanup to prevent cascading failures
                pass

    def shutdown_gracefully(self, exit_code: int = 0) -> None:
        """Perform graceful shutdown with cleanup.
        
        Args:
            exit_code: Exit code to use when exiting
        """
        self._exit_code = exit_code
        self._perform_cleanup()
        sys.exit(exit_code,
    )

    def shutdown_immediately(self, exit_code: int = 1) -> None:
        """Perform immediate shutdown without cleanup.
        
        Args:
            exit_code: Exit code to use when exiting
        """
        sys.exit(exit_code)

    def is_shutdown_in_progress(self,
    ) -> bool:
        """Check if shutdown is currently in progress.
        
        Returns:
            True if shutdown is in progress, False otherwise
        """
        return self._shutdown_in_progress

    def get_exit_code(self) -> int:
        """Get the current exit code.
        
        Returns:
            Current exit code
        """
        return self._exit_code

    def set_exit_code(self, exit_code: int,
    ) -> None:
        """Set the exit code for application shutdown.
        
        Args:
            exit_code: Exit code to set
        """
        self._exit_code = exit_code

    def cleanup_and_exit(self, exit_code: int = 0) -> None:
        """Perform cleanup and exit with specified code.
        
        This method replicates the cleanup logic from main.py.
        
        Args:
            exit_code: Exit code to use when exiting
        """
        self.shutdown_gracefully(exit_code,
    )

    def handle_application_startup(self, startup_func: Callable[[], Any]) -> Any:
        """Handle application startup with error handling.
        
        Args:
            startup_func: Function to call for application startup
            
        Returns:
            Result of startup function or None if error occurred
        """
        try:
            return startup_func()
        except Exception:
            # Log error and exit
            self.shutdown_gracefully(1)
            return None

    def handle_application_execution(self, app_exec_func: Callable[[], int]) -> int:
        """Handle application execution with proper exit handling.
        
        This method replicates the application execution logic from main.py.
        
        Args:
            app_exec_func: Function that runs the application (e.g., app.exec())
            
        Returns:
            Exit code from application execution
        """
        try:
            exit_code = app_exec_func()
            self.set_exit_code(exit_code)
            return exit_code
        except Exception:
            self.set_exit_code(1,
    )
            return 1

    def register_socket_cleanup(self, socket_cleanup_func: Callable[[], None]) -> None:
        """Register socket cleanup function.
        
        This method provides the socket cleanup functionality from main.py.
        
        Args:
            socket_cleanup_func: Function to clean up sockets
        """
        self.register_cleanup_handler("socket_cleanup", socket_cleanup_func, priority=100)

    def create_socket_cleanup_handler(self, socket_obj: Any,
    ) -> Callable[[], None]:
        """Create a socket cleanup handler for a specific socket object.
        
        Args:
            socket_obj: Socket object to clean up
            
        Returns:
            Cleanup function for the socket
        """
        def cleanup_socket() -> None:
            if socket_obj:
                with contextlib.suppress(Exception):
                    socket_obj.close()

        return cleanup_socket

    def register_resource_cleanup(self,
    resource_name: str, cleanup_func: Callable[[], None], priority: int = 50,
    ) -> None:
        """Register cleanup for a specific resource.
        
        Args:
            resource_name: Name of the resource
            cleanup_func: Function to clean up the resource
            priority: Priority for cleanup order
        """
        self.register_cleanup_handler(f"resource_{resource_name}", cleanup_func, priority)

    def get_cleanup_status(self) -> dict[str, Any]:
        """Get status information about cleanup handlers.
        
        Returns:
            Dictionary with cleanup status information
        """
        return {
            "handlers_count": len(self._cleanup_handlers)
            "shutdown_registered": self._is_shutdown_registered,
            "shutdown_in_progress": self._shutdown_in_progress,
            "exit_code": self._exit_code,
            "handlers": [h.name for h in self.get_cleanup_handlers()],
        }

    def clear_cleanup_handlers(self) -> None:
        """Clear all registered cleanup handlers.
        
        Use with caution as this removes all cleanup functionality.
        """
        self._cleanup_handlers.clear()

    def force_cleanup(self) -> None:
        """Force immediate cleanup execution.
        
        This can be called manually to trigger cleanup without exiting.
        """
        if not self._shutdown_in_progress:
            self._perform_cleanup()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit with cleanup."""
        if exc_type is not None:
            # Exception occurred, set error exit code
            self.set_exit_code(1)
        self._perform_cleanup()


class ApplicationLifecycleManager:
    """High-level manager for application lifecycle operations.
    
    Provides a simplified interface for common lifecycle patterns.
    """

    def __init__(self):
        """Initialize the application lifecycle manager."""
        self.service = ApplicationLifecycleService()

    def setup_standard_cleanup(self, socket_obj: Any = None) -> None:
        """Set up standard cleanup handlers for typical application resources.
        
        Args:
            socket_obj: Optional socket object to register for cleanup
        """
        if socket_obj:
            cleanup_func = self.service.create_socket_cleanup_handler(socket_obj)
            self.service.register_socket_cleanup(cleanup_func,
    )

    def run_application_with_lifecycle(
    self,
    startup_func: Callable[[],
    Any],
    exec_func: Callable[[],
    int]) -> int:
        """Run application with full lifecycle management.
        
        Args:
            startup_func: Function to call for application startup
            exec_func: Function to call for application execution
            
        Returns:
            Exit code from application
        """
        try:
            # Handle startup
            startup_result = self.service.handle_application_startup(startup_func)
            if startup_result is None:
                return 1

            # Handle execution
            return self.service.handle_application_execution(exec_func)
        except Exception:
            return 1

    def cleanup(self) -> None:
        """Clean up manager resources."""
        self.service.force_cleanup()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.cleanup()