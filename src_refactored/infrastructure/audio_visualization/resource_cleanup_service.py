"""Resource Cleanup Service for audio visualization resources.

This module implements the ResourceCleanupService that provides
comprehensive cleanup of audio resources, threads, and PyAudio streams.
Extracted from src/ui/voice_visualizer.py lines 120-139, 180-193.
"""

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

import pyaudio
from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal

from src_refactored.infrastructure.system.logging_service import LoggingService


class ResourceType(Enum):
    """Types of resources that can be managed."""
    PYAUDIO_STREAM = "pyaudio_stream"
    PYAUDIO_INSTANCE = "pyaudio_instance"
    QTHREAD = "qthread"
    AUDIO_BUFFER = "audio_buffer"
    FILE_HANDLE = "file_handle"
    NETWORK_CONNECTION = "network_connection"
    TIMER = "timer"
    SIGNAL_CONNECTION = "signal_connection"


class ResourceState(Enum):
    """Resource lifecycle states."""
    ACTIVE = "active"
    STOPPING = "stopping"
    STOPPED = "stopped"
    CLEANUP_PENDING = "cleanup_pending"
    CLEANED_UP = "cleaned_up"
    ERROR = "error"


@dataclass
class ResourceInfo:
    """Information about a managed resource."""
    resource_id: str
    resource_type: ResourceType
    resource_object: Any
    state: ResourceState = ResourceState.ACTIVE
    created_at: float = field(default_factory=time.time,
    )
    cleanup_timeout: float = 5.0
    cleanup_attempts: int = 0
    max_cleanup_attempts: int = 3
    metadata: dict[str, Any] = field(default_factory=dict)


class ResourceCleanupServiceProtocol(Protocol):
    """Protocol for resource cleanup service."""

    def register_resource(self, resource_id: str, resource_type: ResourceType,
                         resource_object: Any, cleanup_timeout: float = 5.0,
    ) -> bool:
        """Register a resource for management."""
        ...

    def cleanup_resource(self, resource_id: str, force: bool = False,
    ) -> bool:
        """Clean up a specific resource."""
        ...

    def cleanup_all_resources(self, force: bool = False,
    ) -> bool:
        """Clean up all managed resources."""
        ...

    def get_resource_state(self, resource_id: str,
    ) -> ResourceState | None:
        """Get current state of a resource."""
        ...


class PyAudioResourceManager:
    """Specialized manager for PyAudio resources.
    
    Handles proper cleanup of PyAudio streams and instances
    with thread safety and error handling.
    """

    def __init__(self):
        """Initialize the PyAudio resource manager."""
        self.logger = LoggingService().get_logger("PyAudioResourceManager")
        self._lock = threading.RLock()

    def cleanup_stream(self, stream: pyaudio.Stream, timeout: float = 5.0,
    ) -> bool:
        """Clean up a PyAudio stream safely.
        
        Args:
            stream: PyAudio stream to clean up
            timeout: Maximum time to wait for cleanup
            
        Returns:
            True if cleanup successful, False otherwise
        """
        if not stream:
            return True

        with self._lock:
            try:
                # Stop the stream if it's active
                if stream.is_active():
                    self.logger.debug("Stopping active PyAudio stream")
                    stream.stop_stream()

                    # Wait for stream to stop with timeout
                    start_time = time.time()
                    while stream.is_active() and (time.time() - start_time) < timeout:
                        time.sleep(0.1)

                    if stream.is_active():
                        self.logger.warning("Stream did not stop within {timeout}s timeout")

                # Close the stream
                if not stream.is_stopped():
                    self.logger.debug("Closing PyAudio stream")
                    stream.close()

                self.logger.info("PyAudio stream cleaned up successfully")
                return True

            except Exception as e:
                self.logger.exception(f"Error cleaning up PyAudio stream: {e}")
                return False

    def cleanup_pyaudio_instance(self, pyaudio_instance: pyaudio.PyAudio, timeout: float = 5.0,
    ) -> bool:
        """Clean up a PyAudio instance safely.
        
        Args:
            pyaudio_instance: PyAudio instance to clean up
            timeout: Maximum time to wait for cleanup
            
        Returns:
            True if cleanup successful, False otherwise
        """
        if not pyaudio_instance:
            return True

        with self._lock:
            try:
                self.logger.debug("Terminating PyAudio instance")
                pyaudio_instance.terminate()

                self.logger.info("PyAudio instance cleaned up successfully")
                return True

            except Exception as e:
                self.logger.exception(f"Error cleaning up PyAudio instance: {e}")
                return False


class ThreadResourceManager:
    """Specialized manager for QThread resources.
    
    Handles proper cleanup of QThread instances with
    graceful shutdown and forced termination as fallback.
    """

    def __init__(self):
        """Initialize the thread resource manager."""
        self.logger = LoggingService().get_logger("ThreadResourceManager")

    def cleanup_thread(self, thread: QThread, timeout: float = 5.0, force: bool = False,
    ) -> bool:
        """Clean up a QThread safely.
        
        Args:
            thread: QThread to clean up
            timeout: Maximum time to wait for graceful shutdown
            force: Whether to force termination if graceful shutdown fails
            
        Returns:
            True if cleanup successful, False otherwise
        """
        if not thread or not thread.isRunning():
            return True

        try:
            # Request graceful shutdown
            self.logger.debug("Requesting thread shutdown: {thread.objectName()}")
            thread.requestInterruption()

            # Wait for graceful shutdown
            if thread.wait(int(timeout * 1000)):  # Convert to milliseconds
                self.logger.info("Thread shut down gracefully: {thread.objectName()}")
                return True

            # Graceful shutdown failed
            self.logger.warning("Thread did not shut down gracefully within {timeout}s: {thread.obje\
    ctName()}")

            if force:
                # Force termination as last resort
                self.logger.warning("Force terminating thread: {thread.objectName()}")
                thread.terminate()

                # Wait a bit more for forced termination
                if thread.wait(2000):  # 2 seconds
                    self.logger.info("Thread force terminated: {thread.objectName()}")
                    return True
                self.logger.error("Failed to force terminate thread: {thread.objectName()}")
                return False

            return False

        except Exception as e:
            self.logger.exception(f"Error cleaning up thread {thread.objectName()}: {e}")
            return False


class ResourceCleanupManager(QObject):
    """Manager for comprehensive resource cleanup.
    
    Provides centralized management of various resource types
    with automatic cleanup, timeout handling, and error recovery.
    """

    # Signals for cleanup events
    resource_registered = pyqtSignal(str, str)  # resource_id, resource_type
    resource_cleanup_started = pyqtSignal(str)  # resource_id
    resource_cleanup_completed = pyqtSignal(str, bool)  # resource_id, success
    cleanup_failed = pyqtSignal(str, str)  # resource_id, error_message
    all_resources_cleaned = pyqtSignal(bool)  # success

    def __init__(self, parent: QObject | None = None):
        """Initialize the resource cleanup manager.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)
        self.logger = LoggingService().get_logger("ResourceCleanupManager")

        # Resource tracking
        self._resources: dict[str, ResourceInfo] = {}
        self._lock = threading.RLock()

        # Specialized managers
        self.pyaudio_manager = PyAudioResourceManager()
        self.thread_manager = ThreadResourceManager()

        # Cleanup timer for automatic cleanup
        self.cleanup_timer = QTimer()
        self.cleanup_timer.timeout.connect(self._periodic_cleanup)
        self.cleanup_timer.setInterval(30000)  # 30 seconds

    def register_resource(self, resource_id: str, resource_type: ResourceType,
                         resource_object: Any, cleanup_timeout: float = 5.0,
                         metadata: dict[str, Any] | None = None) -> bool:
        """Register a resource for management.
        
        Args:
            resource_id: Unique identifier for the resource
            resource_type: Type of resource
            resource_object: The actual resource object
            cleanup_timeout: Maximum time to wait for cleanup
            metadata: Optional metadata about the resource
            
        Returns:
            True if registered successfully, False otherwise
        """
        with self._lock:
            if resource_id in self._resources:
                self.logger.warning("Resource already registered: {resource_id}")
                return False

            try:
                resource_info = ResourceInfo(
                    resource_id=resource_id,
                    resource_type=resource_type,
                    resource_object=resource_object,
                    cleanup_timeout=cleanup_timeout,
                    metadata=metadata or {},
                )

                self._resources[resource_id] = resource_info

                self.logger.info("Registered resource: {resource_id} ({resource_type.value})")
                self.resource_registered.emit(resource_id, resource_type.value)

                # Start cleanup timer if this is the first resource
                if len(self._resources) == 1:
                    self.cleanup_timer.start()

                return True

            except Exception as e:
                self.logger.exception(f"Error registering resource {resource_id}: {e}")
                return False

    def cleanup_resource(self, resource_id: str, force: bool = False,
    ) -> bool:
        """Clean up a specific resource.
        
        Args:
            resource_id: Resource identifier
            force: Whether to force cleanup
            
        Returns:
            True if cleanup successful, False otherwise
        """
        with self._lock:
            resource_info = self._resources.get(resource_id)
            if not resource_info:
                self.logger.warning("Resource not found for cleanup: {resource_id}",
    )
                return False

            if resource_info.state in [ResourceState.CLEANED_UP, ResourceState.CLEANUP_PENDING]:
                self.logger.debug("Resource already cleaned up or pending: {resource_id}")
                return True

            try:
                # Mark as cleanup pending
                resource_info.state = ResourceState.CLEANUP_PENDING
                resource_info.cleanup_attempts += 1

                self.logger.info("Starting cleanup for resource: {resource_id}")
                self.resource_cleanup_started.emit(resource_id)

                # Perform type-specific cleanup
                success = self._cleanup_by_type(resource_info, force)

                if success:
                    resource_info.state = ResourceState.CLEANED_UP
                    self.logger.info("Successfully cleaned up resource: {resource_id}")
                    self.resource_cleanup_completed.emit(resource_id, True)
                else:
                    resource_info.state = ResourceState.ERROR
                    error_msg = f"Failed to clean up resource: {resource_id}"
                    self.logger.error(error_msg)
                    self.cleanup_failed.emit(resource_id, error_msg)
                    self.resource_cleanup_completed.emit(resource_id, False)

                return success

            except Exception as e:
                resource_info.state = ResourceState.ERROR
                error_msg = f"Exception during cleanup of {resource_id}: {e}"
                self.logger.exception(error_msg)
                self.cleanup_failed.emit(resource_id, error_msg)
                self.resource_cleanup_completed.emit(resource_id, False)
                return False

    def _cleanup_by_type(self, resource_info: ResourceInfo, force: bool,
    ) -> bool:
        """Perform type-specific resource cleanup.
        
        Args:
            resource_info: Resource information
            force: Whether to force cleanup
            
        Returns:
            True if cleanup successful, False otherwise
        """
        resource_type = resource_info.resource_type
        resource_object = resource_info.resource_object
        timeout = resource_info.cleanup_timeout

        if resource_type == ResourceType.PYAUDIO_STREAM:
            return self.pyaudio_manager.cleanup_stream(resource_object, timeout)

        if resource_type == ResourceType.PYAUDIO_INSTANCE:
            return self.pyaudio_manager.cleanup_pyaudio_instance(resource_object, timeout)

        if resource_type == ResourceType.QTHREAD:
            return self.thread_manager.cleanup_thread(resource_object, timeout, force)

        if resource_type == ResourceType.TIMER:
            try:
                if hasattr(resource_object, "stop"):
                    resource_object.stop()
                elif hasattr(resource_object, "cancel"):
                    resource_object.cancel()
                return True
            except Exception as e:
                self.logger.exception(f"Error cleaning up timer: {e}")
                return False

        elif resource_type == ResourceType.FILE_HANDLE:
            try:
                if hasattr(resource_object, "close"):
                    resource_object.close()
                return True
            except Exception as e:
                self.logger.exception(f"Error closing file handle: {e}")
                return False

        else:
            # Generic cleanup - try common cleanup methods
            try:
                if hasattr(resource_object, "cleanup"):
                    resource_object.cleanup()
                elif hasattr(resource_object, "close"):
                    resource_object.close()
                elif hasattr(resource_object, "stop"):
                    resource_object.stop()
                return True
            except Exception as e:
                self.logger.exception(f"Error in generic cleanup: {e}")
                return False

    def cleanup_all_resources(self, force: bool = False,
    ) -> bool:
        """Clean up all managed resources.
        
        Args:
            force: Whether to force cleanup
            
        Returns:
            True if all resources cleaned successfully, False otherwise
        """
        with self._lock:
            if not self._resources:
                self.logger.debug("No resources to clean up")
                self.all_resources_cleaned.emit(True)
                return True

            self.logger.info("Starting cleanup of {len(self._resources)} resources")

            success_count = 0
            total_count = len(self._resources)

            # Clean up resources in reverse order of registration
            resource_ids = list(self._resources.keys())
            for resource_id in reversed(resource_ids):
                if self.cleanup_resource(resource_id, force):
                    success_count += 1

            # Stop cleanup timer
            self.cleanup_timer.stop()

            # Remove cleaned up resources
            self._remove_cleaned_resources()

            success = success_count == total_count
            self.logger.info("Cleanup completed: {success_count}/{total_count} successful")
            self.all_resources_cleaned.emit(success)

            return success

    def _remove_cleaned_resources(self) -> None:
        """Remove resources that have been cleaned up."""
        to_remove = [
            resource_id for resource_id, resource_info in self._resources.items()
            if resource_info.state == ResourceState.CLEANED_UP
        ]

        for resource_id in to_remove:
            del self._resources[resource_id]
            self.logger.debug("Removed cleaned resource: {resource_id}")

    def _periodic_cleanup(self) -> None:
        """Perform periodic cleanup of stale resources."""
        current_time = time.time()
        stale_resources = []

        with self._lock:
            for resource_id, resource_info in self._resources.items():
                # Check for stale resources (older than 1 hour)
                if (current_time - resource_info.created_at) > 3600:
                    stale_resources.append(resource_id)

        # Clean up stale resources
        for resource_id in stale_resources:
            self.logger.warning("Cleaning up stale resource: {resource_id}")
            self.cleanup_resource(resource_id, force=True)

    def get_resource_state(self, resource_id: str,
    ) -> ResourceState | None:
        """Get current state of a resource.
        
        Args:
            resource_id: Resource identifier
            
        Returns:
            Resource state or None if not found
        """
        with self._lock:
            resource_info = self._resources.get(resource_id,
    )
            return resource_info.state if resource_info else None

    def get_resource_info(self, resource_id: str,
    ) -> ResourceInfo | None:
        """Get detailed resource information.
        
        Args:
            resource_id: Resource identifier
            
        Returns:
            Resource information or None if not found
        """
        with self._lock:
            return self._resources.get(resource_id)

    def list_resources(self) -> list[str]:
        """Get list of all managed resource IDs.
        
        Returns:
            List of resource identifiers
        """
        with self._lock:
            return list(self._resources.keys())

    def get_resource_count_by_type(self, resource_type: ResourceType,
    ) -> int:
        """Get count of resources by type.
        
        Args:
            resource_type: Type of resource
            
        Returns:
            Count of resources of the specified type
        """
        with self._lock:
            return sum(
                1 for resource_info in self._resources.values()
                if resource_info.resource_type == resource_type
            )


class ResourceCleanupService:
    """Service for comprehensive resource cleanup with domain integration.
    
    Provides high-level interface for resource cleanup that integrates
    with domain entities and application use cases.
    """

    def __init__(self, logger_service: LoggingService | None = None):
        """Initialize the resource cleanup service.
        
        Args:
            logger_service: Optional logger service
        """
        self.logger_service = logger_service or LoggingService()
        self.logger = self.logger_service.get_logger("ResourceCleanupService")
        self.cleanup_manager = ResourceCleanupManager()

    def register_resource(self, resource_id: str, resource_type: ResourceType,
                         resource_object: Any, cleanup_timeout: float = 5.0,
    ) -> bool:
        """Register a resource for management.
        
        Args:
            resource_id: Unique identifier for the resource
            resource_type: Type of resource
            resource_object: The actual resource object
            cleanup_timeout: Maximum time to wait for cleanup
            
        Returns:
            True if registered successfully, False otherwise
        """
        return self.cleanup_manager.register_resource(
            resource_id, resource_type, resource_object, cleanup_timeout,
        )

    def cleanup_resource(self, resource_id: str, force: bool = False,
    ) -> bool:
        """Clean up a specific resource.
        
        Args:
            resource_id: Resource identifier
            force: Whether to force cleanup
            
        Returns:
            True if cleanup successful, False otherwise
        """
        return self.cleanup_manager.cleanup_resource(resource_id, force)

    def cleanup_all_resources(self, force: bool = False,
    ) -> bool:
        """Clean up all managed resources.
        
        Args:
            force: Whether to force cleanup
            
        Returns:
            True if all resources cleaned successfully, False otherwise
        """
        return self.cleanup_manager.cleanup_all_resources(force)

    def get_resource_state(self, resource_id: str,
    ) -> ResourceState | None:
        """Get current state of a resource.
        
        Args:
            resource_id: Resource identifier
            
        Returns:
            Resource state or None if not found
        """
        return self.cleanup_manager.get_resource_state(resource_id)

    @contextmanager
    def managed_resource(self, resource_id: str, resource_type: ResourceType,
                        resource_object: Any, cleanup_timeout: float = 5.0,
    ):
        """Context manager for automatic resource cleanup.
        
        Args:
            resource_id: Unique identifier for the resource
            resource_type: Type of resource
            resource_object: The actual resource object
            cleanup_timeout: Maximum time to wait for cleanup
            
        Yields:
            The resource object
        """
        try:
            # Register resource
            success = self.register_resource(resource_id, resource_type, resource_object, cleanup_timeout)
            if not success:
                msg = f"Failed to register resource: {resource_id}"
                raise RuntimeError(msg)

            yield resource_object

        finally:
            # Clean up resource
            self.cleanup_resource(resource_id, force=True)

    def get_cleanup_manager(self) -> ResourceCleanupManager:
        """Get cleanup manager for signal connections.

        Returns:
            Resource cleanup manager instance
        """
        return self.cleanup_manager

    def get_resource_statistics(self) -> dict[str, Any]:
        """Get resource management statistics.

        Returns:
            Dictionary with resource statistics
        """
        total_resources = len(self.cleanup_manager.list_resources())

        stats: dict[str, Any] = {
            "total_resources": total_resources,
            "by_type": {},
            "by_state": {},
        }

        # Count by type
        for resource_type in ResourceType:
            count = self.cleanup_manager.get_resource_count_by_type(resource_type)
            if count > 0:
                stats["by_type"][resource_type.value] = count

        # Count by state
        for resource_id in self.cleanup_manager.list_resources():
            resource_info = self.cleanup_manager.get_resource_info(resource_id)
            if resource_info:
                state = resource_info.state.value
                if state not in stats["by_state"]:
                    stats["by_state"][state] = 0
                stats["by_state"][state] += 1

        return stats

    def cleanup(self) -> None:
        """Clean up service resources."""
        self.cleanup_all_resources(force=True)
        self.logger.info("Cleaned up resource cleanup service")