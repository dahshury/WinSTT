"""Worker Thread Management Service.

This module provides infrastructure services for managing worker threads,
including thread creation, lifecycle management, and coordination.
"""

from dataclasses import dataclass

from PyQt6.QtCore import QObject, QThread, pyqtSignal

from logger import setup_logger
from src_refactored.domain.common.result import Result
from src_refactored.domain.system_integration.value_objects.system_operations import ThreadState


@dataclass
class ThreadInfo:
    """Infrastructure thread information with PyQt references."""
    name: str
    thread: QThread
    state: ThreadState
    worker_class: type
    worker_instance: QObject | None = None


class WorkerThreadManagementService(QObject):
    """Service for managing worker threads and their lifecycle."""

    # Signals
    thread_created = pyqtSignal(str)  # thread_name
    thread_started = pyqtSignal(str)  # thread_name
    thread_stopped = pyqtSignal(str)  # thread_name
    thread_error = pyqtSignal(str, str)  # thread_name, error_message

    def __init__(self):
        """Initialize the worker thread management service."""
        super().__init__()
        self.logger = setup_logger()
        self._threads: dict[str, ThreadInfo] = {}
        self._worker_classes: dict[str, type] = {}

    def register_worker_class(self, name: str, worker_class: type,
    ) -> Result[None]:
        """Register a worker class for thread management.
        
        Args:
            name: Name identifier for the worker class
            worker_class: The worker class to register
            
        Returns:
            Result indicating success or failure
        """
        try:
            if not issubclass(worker_class, QObject):
                return Result.failure(f"Worker class {worker_class.__name__} must inherit from QObject")

            self._worker_classes[name] = worker_class
            self.logger.info("Registered worker class: {name}")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to register worker class {name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def create_thread(self, thread_name: str, worker_class_name: str,
    ) -> Result[QThread]:
        """Create a new worker thread.
        
        Args:
            thread_name: Name for the thread
            worker_class_name: Name of the registered worker class
            
        Returns:
            Result containing the created thread or error
        """
        try:
            if thread_name in self._threads:
                return Result.failure(f"Thread {thread_name} already exists")

            if worker_class_name not in self._worker_classes:
                return Result.failure(f"Worker class {worker_class_name} not registered")

            # Create thread
            thread = QThread()
            thread.setObjectName(thread_name)

            # Store thread info
            worker_class = self._worker_classes[worker_class_name]
            thread_info = ThreadInfo(
                name=thread_name,
                thread=thread,
                state=ThreadState.CREATED,
                worker_class=worker_class,
            )

            self._threads[thread_name] = thread_info

            # Connect thread signals
            thread.started.connect(lambda: self._on_thread_started(thread_name))
            thread.finished.connect(lambda: self._on_thread_finished(thread_name))

            self.thread_created.emit(thread_name)
            self.logger.info("Created thread: {thread_name}")

            return Result.success(thread)

        except Exception as e:
            error_msg = f"Failed to create thread {thread_name}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.thread_error.emit(thread_name, error_msg)
            return Result.failure(error_msg)

    def get_thread(self, thread_name: str,
    ) -> QThread | None:
        """Get a thread by name.
        
        Args:
            thread_name: Name of the thread
            
        Returns:
            The thread if found, None otherwise
        """
        thread_info = self._threads.get(thread_name)
        return thread_info.thread if thread_info else None

    def start_thread(self, thread_name: str,
    ) -> Result[None]:
        """Start a thread.
        
        Args:
            thread_name: Name of the thread to start
            
        Returns:
            Result indicating success or failure
        """
        try:
            thread_info = self._threads.get(thread_name)
            if not thread_info:
                return Result.failure(f"Thread {thread_name} not found")

            if thread_info.state == ThreadState.RUNNING:
                return Result.failure(f"Thread {thread_name} is already running")

            thread_info.thread.start()
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to start thread {thread_name}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.thread_error.emit(thread_name, error_msg)
            return Result.failure(error_msg)

    def stop_thread(self, thread_name: str, timeout_ms: int = 5000) -> Result[None]:
        """Stop a thread gracefully.
        
        Args:
            thread_name: Name of the thread to stop
            timeout_ms: Timeout in milliseconds for graceful shutdown
            
        Returns:
            Result indicating success or failure
        """
        try:
            thread_info = self._threads.get(thread_name)
            if not thread_info:
                return Result.failure(f"Thread {thread_name} not found")

            if thread_info.state != ThreadState.RUNNING:
                return Result.success(None)  # Already stopped

            # Request thread to quit
            thread_info.thread.quit()

            # Wait for thread to finish
            if not thread_info.thread.wait(timeout_ms):
                # Force terminate if timeout
                thread_info.thread.terminate()
                thread_info.thread.wait(1000)  # Wait for termination

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to stop thread {thread_name}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.thread_error.emit(thread_name, error_msg)
            return Result.failure(error_msg)

    def get_thread_state(self, thread_name: str,
    ) -> ThreadState | None:
        """Get the state of a thread.
        
        Args:
            thread_name: Name of the thread
            
        Returns:
            Thread state if found, None otherwise
        """
        thread_info = self._threads.get(thread_name)
        return thread_info.state if thread_info else None

    def get_all_threads(self) -> list[str]:
        """Get names of all managed threads.
        
        Returns:
            List of thread names
        """
        return list(self._threads.keys())

    def cleanup_all_threads(self) -> Result[None]:
        """Clean up all managed threads.
        
        Returns:
            Result indicating success or failure
        """
        try:
            errors = []

            for thread_name in list(self._threads.keys()):
                result = self.stop_thread(thread_name)
                if not result.is_success:
                    errors.append(f"Failed to stop {thread_name}: {result.error()}")

            self._threads.clear()

            if errors:
                return Result.failure("; ".join(errors))

            self.logger.info("All threads cleaned up successfully")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to cleanup threads: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def _on_thread_started(self, thread_name: str,
    ) -> None:
        """Handle thread started event."""
        thread_info = self._threads.get(thread_name)
        if thread_info:
            thread_info.state = ThreadState.RUNNING
            self.thread_started.emit(thread_name)
            self.logger.info("Thread started: {thread_name}")

    def _on_thread_finished(self, thread_name: str,
    ) -> None:
        """Handle thread finished event."""
        thread_info = self._threads.get(thread_name)
        if thread_info:
            thread_info.state = ThreadState.STOPPED
            self.thread_stopped.emit(thread_name)
            self.logger.info("Thread finished: {thread_name}")

    @classmethod
    def create_for_main_window(cls) -> "WorkerThreadManagementService":
        """Factory method to create service configured for main window.
        
        Returns:
            Configured WorkerThreadManagementService instance
        """
        from src_refactored.infrastructure.audio.listener_worker_service import (
            ListenerWorkerService,
        )
        from src_refactored.infrastructure.audio.vad_worker_service import VadWorkerService
        from src_refactored.infrastructure.llm.llm_pyqt_worker_service import LLMPyQtWorkerService
        from src_refactored.infrastructure.transcription.model_worker_service import (
            ModelWorkerService,
        )
        
        service = cls()
        
        # Register refactored worker services
        service.register_worker_class("vad", VadWorkerService)
        service.register_worker_class("model", ModelWorkerService)
        service.register_worker_class("listener", ListenerWorkerService)
        service.register_worker_class("llm", LLMPyQtWorkerService)
        
        return service

