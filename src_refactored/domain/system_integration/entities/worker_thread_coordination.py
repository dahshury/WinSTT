"""Worker thread coordination entity for system integration domain."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Entity

if TYPE_CHECKING:
    from collections.abc import Callable


class ThreadState(Enum):
    """Enumeration of thread states."""
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"
    TERMINATED = "terminated"


class ThreadType(Enum):
    """Enumeration of worker thread types."""
    VAD = "vad"  # Voice Activity Detection
    MODEL = "model"  # Model processing
    LISTENER = "listener"  # Audio listener
    LLM = "llm"  # Language model
    CUSTOM = "custom"  # Custom worker


class ThreadPriority(Enum):
    """Enumeration of thread priorities."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class ThreadConfiguration:
    """Value object for thread configuration."""
    thread_type: ThreadType
    priority: ThreadPriority = ThreadPriority.NORMAL
    auto_start: bool = False
    restart_on_error: bool = True
    max_restart_attempts: int = 3
    timeout_seconds: int = 30

    def __post_init__(self,
    ):
        """Validate thread configuration."""
        if self.max_restart_attempts < 0:
            msg = f"Max restart attempts cannot be negative, got: {self.max_restart_attempts}"
            raise ValueError(msg)

        if self.timeout_seconds <= 0:
            msg = f"Timeout must be positive, got: {self.timeout_seconds}"
            raise ValueError(msg)


@dataclass
class ThreadMetrics:
    """Value object for thread metrics."""
    start_time: datetime | None = None
    stop_time: datetime | None = None
    restart_count: int = 0
    error_count: int = 0
    last_error: str | None = None
    last_error_time: datetime | None = None

    def get_uptime_seconds(self) -> float | None:
        """Get thread uptime in seconds."""
        if self.start_time is None:
            return None

        end_time = self.stop_time or datetime.now()
        return (end_time - self.start_time).total_seconds()

    def get_error_rate(self) -> float:
        """Get error rate (errors per restart,
    )."""
        if self.restart_count == 0:
            return 0.0
        return self.error_count / max(1, self.restart_count)


class WorkerThreadCoordination(Entity):
    """Entity for worker thread coordination and management."""

    def __init__(
        self,
        coordination_id: str,
        max_threads: int = 10,
    ):
        """Initialize worker thread coordination."""
        super().__init__()
        self._coordination_id = coordination_id
        self._max_threads = max_threads
        self._threads: dict[str, ThreadConfiguration] = {}
        self._thread_states: dict[str, ThreadState] = {}
        self._thread_metrics: dict[str, ThreadMetrics] = {}
        self._thread_references: dict[str, Any] = {}  # Actual thread objects
        self._worker_classes: dict[ThreadType, type] = {}
        self._state_change_callbacks: dict[str, Callable[[str, ThreadState], None]] = {}
        self._global_state_callback: Callable[[dict[str, ThreadState]], None] | None = None

    @property
    def coordination_id(self) -> str:
        """Get coordination ID."""
        return self._coordination_id

    @property
    def max_threads(self) -> int:
        """Get maximum number of threads."""
        return self._max_threads

    @property
    def thread_count(self) -> int:
        """Get current number of threads."""
        return len(self._threads)

    @property
    def active_thread_count(self) -> int:
        """Get number of active threads."""
        active_states = {ThreadState.STARTING, ThreadState.RUNNING, ThreadState.PAUSED}
        return sum(1 for state in self._thread_states.values() if state in active_states)

    @property
    def thread_ids(self) -> set[str]:
        """Get all thread IDs."""
        return set(self._threads.keys())

    def register_worker_class(self, thread_type: ThreadType, worker_class: type,
    ) -> None:
        """Register a worker class for a thread type."""
        if not worker_class:
            msg = "Worker class cannot be None"
            raise ValueError(msg,
    )

        self._worker_classes[thread_type] = worker_class

    def get_worker_class(self, thread_type: ThreadType,
    ) -> type | None:
        """Get registered worker class for thread type."""
        return self._worker_classes.get(thread_type)

    def add_thread(self, thread_id: str, configuration: ThreadConfiguration,
    ) -> None:
        """Add a new thread to coordination."""
        if not thread_id or not thread_id.strip():
            msg = "Thread ID cannot be empty"
            raise ValueError(msg)

        if thread_id in self._threads:
            msg = f"Thread with ID '{thread_id}' already exists"
            raise ValueError(msg)

        if self.thread_count >= self._max_threads:
            msg = f"Maximum thread limit ({self._max_threads}) reached"
            raise ValueError(msg)

        self._threads[thread_id] = configuration
        self._thread_states[thread_id] = ThreadState.CREATED
        self._thread_metrics[thread_id] = ThreadMetrics(,
    )

    def remove_thread(self, thread_id: str,
    ) -> None:
        """Remove a thread from coordination."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        # Stop thread if it's running
        if self._thread_states[thread_id] in {ThreadState.RUNNING, ThreadState.PAUSED}:
            self.stop_thread(thread_id)

        # Clean up
        del self._threads[thread_id]
        del self._thread_states[thread_id]
        del self._thread_metrics[thread_id]
        if thread_id in self._thread_references:
            del self._thread_references[thread_id]
        if thread_id in self._state_change_callbacks:
            del self._state_change_callbacks[thread_id]

    def get_thread_configuration(self, thread_id: str,
    ) -> ThreadConfiguration | None:
        """Get thread configuration."""
        return self._threads.get(thread_id)

    def get_thread_state(self, thread_id: str,
    ) -> ThreadState | None:
        """Get thread state."""
        return self._thread_states.get(thread_id)

    def get_thread_metrics(self, thread_id: str,
    ) -> ThreadMetrics | None:
        """Get thread metrics."""
        return self._thread_metrics.get(thread_id)

    def set_thread_reference(self, thread_id: str, thread_reference: Any,
    ) -> None:
        """Set reference to actual thread object."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._thread_references[thread_id] = thread_reference

    def get_thread_reference(self, thread_id: str,
    ) -> Any | None:
        """Get reference to actual thread object."""
        return self._thread_references.get(thread_id)

    def start_thread(self, thread_id: str,
    ) -> None:
        """Start a thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        current_state = self._thread_states[thread_id]
        if current_state not in {ThreadState.CREATED, ThreadState.STOPPED}:
            msg = f"Cannot start thread in state: {current_state}"
            raise ValueError(msg)

        self._update_thread_state(thread_id, ThreadState.STARTING)

        # Update metrics
        metrics = self._thread_metrics[thread_id]
        metrics.start_time = datetime.now()
        metrics.stop_time = None

    def stop_thread(self, thread_id: str,
    ) -> None:
        """Stop a thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        current_state = self._thread_states[thread_id]
        if current_state in {ThreadState.STOPPED, ThreadState.TERMINATED}:
            return  # Already stopped

        self._update_thread_state(thread_id, ThreadState.STOPPING)

    def pause_thread(self, thread_id: str,
    ) -> None:
        """Pause a thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg)

        current_state = self._thread_states[thread_id]
        if current_state != ThreadState.RUNNING:
            msg = f"Cannot pause thread in state: {current_state}"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.PAUSED)

    def resume_thread(self, thread_id: str,
    ) -> None:
        """Resume a paused thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg)

        current_state = self._thread_states[thread_id]
        if current_state != ThreadState.PAUSED:
            msg = f"Cannot resume thread in state: {current_state}"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.RUNNING)

    def mark_thread_running(self, thread_id: str,
    ) -> None:
        """Mark thread as running (called after successful start)."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.RUNNING)

    def mark_thread_stopped(self, thread_id: str,
    ) -> None:
        """Mark thread as stopped."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.STOPPED)

        # Update metrics
        metrics = self._thread_metrics[thread_id]
        metrics.stop_time = datetime.now()

    def mark_thread_error(self, thread_id: str, error_message: str,
    ) -> None:
        """Mark thread as having an error."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.ERROR)

        # Update metrics
        metrics = self._thread_metrics[thread_id]
        metrics.error_count += 1
        metrics.last_error = error_message
        metrics.last_error_time = datetime.now()

        # Check if we should restart
        config = self._threads[thread_id]
        if (config.restart_on_error and
            metrics.restart_count < config.max_restart_attempts):
            self._attempt_restart(thread_id)

    def _attempt_restart(self, thread_id: str,
    ) -> None:
        """Attempt to restart a failed thread."""
        metrics = self._thread_metrics[thread_id]
        metrics.restart_count += 1

        try:
            # Reset to stopped state first
            self._update_thread_state(thread_id, ThreadState.STOPPED)
            # Then attempt to start
            self.start_thread(thread_id)
        except Exception as e:
            self.mark_thread_error(thread_id, f"Restart failed: {e!s}")

    def terminate_thread(self, thread_id: str,
    ) -> None:
        """Terminate a thread (permanent stop)."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._update_thread_state(thread_id, ThreadState.TERMINATED)

        # Update metrics
        metrics = self._thread_metrics[thread_id]
        if metrics.stop_time is None:
            metrics.stop_time = datetime.now()

    def _update_thread_state(self, thread_id: str, new_state: ThreadState,
    ) -> None:
        """Update thread state and notify callbacks."""
        self._thread_states[thread_id]
        self._thread_states[thread_id] = new_state

        # Call thread-specific callback
        callback = self._state_change_callbacks.get(thread_id)
        if callback:
            try:
                callback(thread_id, new_state)
            except Exception:
                # Don't let callback errors affect state management
                pass

        # Call global callback
        if self._global_state_callback:
            try:
                self._global_state_callback(self._thread_states.copy())
            except Exception:
                # Don't let callback errors affect state management
                pass

    def set_thread_state_callback(
    self,
    thread_id: str,
    callback: Callable[[str,
    ThreadState],
    None]) -> None:
        """Set state change callback for specific thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg,
    )

        self._state_change_callbacks[thread_id] = callback

    def set_global_state_callback(self, callback: Callable[[dict[str, ThreadState]], None]) -> None:
        """Set global state change callback."""
        self._global_state_callback = callback

    def start_all_auto_start_threads(self) -> None:
        """Start all threads configured for auto-start."""
        for thread_id, config in self._threads.items():
            if config.auto_start and self._thread_states[thread_id] == ThreadState.CREATED:
                try:
                    self.start_thread(thread_id)
                except Exception as e:
                    self.mark_thread_error(thread_id, f"Auto-start failed: {e!s}")

    def stop_all_threads(self) -> None:
        """Stop all running threads."""
        for thread_id in self._threads:
            if self._thread_states[thread_id] in {ThreadState.RUNNING, ThreadState.PAUSED}:
                try:
                    self.stop_thread(thread_id)
                except Exception:
                    # Continue stopping other threads even if one fails
                    pass

    def get_threads_by_type(self, thread_type: ThreadType,
    ) -> dict[str, ThreadConfiguration]:
        """Get all threads of a specific type."""
        return {
            tid: config for tid, config in self._threads.items()
            if config.thread_type == thread_type
        }

    def get_threads_by_state(self, state: ThreadState,
    ) -> dict[str, ThreadConfiguration]:
        """Get all threads in a specific state."""
        return {
            tid: self._threads[tid] for tid, thread_state in self._thread_states.items()
            if thread_state == state
        }

    def get_health_status(self) -> dict[str, Any]:
        """Get overall health status of thread coordination."""
        states = list(self._thread_states.values())
        error_count = sum(1 for state in states if state == ThreadState.ERROR)
        running_count = sum(1 for state in states if state == ThreadState.RUNNING)

        total_errors = sum(metrics.error_count for metrics in self._thread_metrics.values())
        total_restarts = sum(metrics.restart_count for metrics in self._thread_metrics.values())

        return {
            "coordination_id": self._coordination_id,
            "total_threads": len(self._threads)
            "running_threads": running_count,
            "error_threads": error_count,
            "total_errors": total_errors,
            "total_restarts": total_restarts,
            "health_score": max(0.0, 1.0 - (error_count / max(1, len(self._threads)))),
            "thread_states": {tid: state.value for tid, state in self._thread_states.items()},
        }

    def reset_thread_metrics(self, thread_id: str,
    ) -> None:
        """Reset metrics for a specific thread."""
        if thread_id not in self._threads:
            msg = f"Thread with ID '{thread_id}' does not exist"
            raise ValueError(msg)

        self._thread_metrics[thread_id] = ThreadMetrics()

    def reset_all_metrics(self) -> None:
        """Reset metrics for all threads."""
        for thread_id in self._threads:
            self._thread_metrics[thread_id] = ThreadMetrics(,
    )