"""Thread reference value object for system integration domain."""

from __future__ import annotations

import threading
import weakref
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any


class ThreadReferenceType(Enum):
    """Enumeration of thread reference types."""
    PYTHON_THREAD = "python_thread"
    QT_THREAD = "qt_thread"
    WORKER_THREAD = "worker_thread"
    CUSTOM_THREAD = "custom_thread"


class ThreadLifecycleState(Enum):
    """Enumeration of thread lifecycle states."""
    CREATED = "created"
    STARTED = "started"
    RUNNING = "running"
    FINISHED = "finished"
    TERMINATED = "terminated"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ThreadReference:
    """Value object representing a reference to a thread."""

    thread_id: str
    reference_type: ThreadReferenceType
    thread_name: str | None = None
    created_at: datetime | None = None

    def __post_init__(self):
        """Validate thread reference."""
        if not self.thread_id or not self.thread_id.strip():
            msg = "Thread ID cannot be empty"
            raise ValueError(msg)

        # Set default created_at if not provided
        if self.created_at is None:
            object.__setattr__(self, "created_at", datetime.now())

    @classmethod
    def from_python_thread(cls, thread: threading.Thread) -> ThreadReference:
        """Create thread reference from Python threading.Thread."""
        if not isinstance(thread, threading.Thread):
            msg = "Expected threading.Thread instance"
            raise ValueError(msg)

        thread_id = str(thread.ident) if thread.ident else f"thread_{id(thread)}"

        return cls(
            thread_id=thread_id,
            reference_type=ThreadReferenceType.PYTHON_THREAD,
            thread_name=thread.name,
            created_at=datetime.now(),
        )

    @classmethod
    def from_qt_thread(cls, thread: Any, thread_name: str | None = None) -> ThreadReference:
        """Create thread reference from Qt QThread."""
        # Note: We use Any type to avoid Qt dependency in domain layer
        if not hasattr(thread, "isRunning"):
            msg = "Expected Qt QThread-like object"
            raise ValueError(msg)

        thread_id = f"qt_thread_{id(thread)}"

        return cls(
            thread_id=thread_id,
            reference_type=ThreadReferenceType.QT_THREAD,
            thread_name=thread_name or getattr(thread, "objectName", lambda: None,
    )(),
            created_at=datetime.now(),
        )

    @classmethod
    def from_worker(cls, worker: Any, thread_name: str | None = None) -> ThreadReference:
        """Create thread reference from worker object."""
        if not worker:
            msg = "Worker object cannot be None"
            raise ValueError(msg)

        thread_id = f"worker_{id(worker)}"

        return cls(
            thread_id=thread_id,
            reference_type=ThreadReferenceType.WORKER_THREAD,
            thread_name=thread_name or getattr(worker, "__class__", type).__name__,
            created_at=datetime.now(),
        )

    @classmethod
    def from_custom(cls, thread_id: str, thread_name: str | None = None) -> ThreadReference:
        """Create thread reference for custom thread implementation."""
        return cls(
            thread_id=thread_id,
            reference_type=ThreadReferenceType.CUSTOM_THREAD,
            thread_name=thread_name,
            created_at=datetime.now(),
        )

    def get_display_name(self) -> str:
        """Get display name for the thread."""
        if self.thread_name:
            return f"{self.thread_name} ({self.thread_id})"
        return self.thread_id

    def get_short_id(self) -> str:
        """Get shortened thread ID for display."""
        if len(self.thread_id) > 12:
            return f"{self.thread_id[:8]}...{self.thread_id[-4:]}"
        return self.thread_id

    def is_python_thread(self) -> bool:
        """Check if this is a Python threading.Thread reference."""
        return self.reference_type == ThreadReferenceType.PYTHON_THREAD

    def is_qt_thread(self) -> bool:
        """Check if this is a Qt QThread reference."""
        return self.reference_type == ThreadReferenceType.QT_THREAD

    def is_worker_thread(self) -> bool:
        """Check if this is a worker thread reference."""
        return self.reference_type == ThreadReferenceType.WORKER_THREAD

    def is_custom_thread(self) -> bool:
        """Check if this is a custom thread reference."""
        return self.reference_type == ThreadReferenceType.CUSTOM_THREAD

    def get_age_seconds(self) -> float:
        """Get age of thread reference in seconds."""
        if self.created_at:
            return (datetime.now() - self.created_at).total_seconds()
        return 0.0

    def get_age_minutes(self) -> float:
        """Get age of thread reference in minutes."""
        return self.get_age_seconds() / 60.0

    def to_dict(self) -> dict[str, Any]:
        """Convert thread reference to dictionary."""
        return {
            "thread_id": self.thread_id,
            "reference_type": self.reference_type.value,
            "thread_name": self.thread_name,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "age_seconds": self.get_age_seconds(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ThreadReference:
        """Create thread reference from dictionary."""
        created_at = None
        if data.get("created_at"):
            created_at = datetime.fromisoformat(data["created_at"])

        return cls(
            thread_id=data["thread_id"],
            reference_type=ThreadReferenceType(data["reference_type"]),
            thread_name=data.get("thread_name"),
            created_at=created_at,
        )

    def __str__(self) -> str:
        """String representation of the thread reference."""
        return self.get_display_name()

    def __repr__(self) -> str:
        """Detailed string representation."""
        return (
            f"ThreadReference("
            f"thread_id='{self.thread_id}', "
            f"reference_type={self.reference_type.value}, "
            f"thread_name='{self.thread_name}', "
            f"created_at={self.created_at}"
            f")"
        )


class ThreadReferenceManager:
    """Manager for thread references with weak reference support."""

    def __init__(self):
        """Initialize thread reference manager."""
        self._references: dict[str, ThreadReference] = {}
        self._weak_refs: dict[str, weakref.ref] = {}
        self._lifecycle_states: dict[str, ThreadLifecycleState] = {}

    def add_reference(self, reference: ThreadReference, thread_object: Any | None = None) -> None:
        """Add thread reference with optional weak reference to actual thread."""
        self._references[reference.thread_id] = reference
        self._lifecycle_states[reference.thread_id] = ThreadLifecycleState.CREATED

        if thread_object is not None:
            try:
                # Create weak reference with cleanup callback
                def cleanup_callback(ref):
                    self._cleanup_reference(reference.thread_id)

                self._weak_refs[reference.thread_id] = weakref.ref(thread_object, cleanup_callback)
            except TypeError:
                # Object doesn't support weak references
                pass

    def remove_reference(self, thread_id: str,
    ) -> None:
        """Remove thread reference."""
        self._references.pop(thread_id, None)
        self._weak_refs.pop(thread_id, None)
        self._lifecycle_states.pop(thread_id, None)

    def get_reference(self, thread_id: str,
    ) -> ThreadReference | None:
        """Get thread reference by ID."""
        return self._references.get(thread_id)

    def get_thread_object(self, thread_id: str,
    ) -> Any | None:
        """Get actual thread object via weak reference."""
        weak_ref = self._weak_refs.get(thread_id)
        if weak_ref:
            return weak_ref()
        return None

    def is_thread_alive(self, thread_id: str,
    ) -> bool:
        """Check if thread is still alive."""
        thread_obj = self.get_thread_object(thread_id)
        if thread_obj is None:
            return False

        # Check different thread types
        if hasattr(thread_obj, "is_alive"):
            return thread_obj.is_alive()  # Python threading.Thread
        if hasattr(thread_obj, "isRunning"):
            return thread_obj.isRunning()  # Qt QThread

        return True  # Assume alive if we can't determine

    def update_lifecycle_state(self, thread_id: str, state: ThreadLifecycleState,
    ) -> None:
        """Update thread lifecycle state."""
        if thread_id in self._references:
            self._lifecycle_states[thread_id] = state

    def get_lifecycle_state(self, thread_id: str,
    ) -> ThreadLifecycleState | None:
        """Get thread lifecycle state."""
        return self._lifecycle_states.get(thread_id)

    def get_all_references(self) -> dict[str, ThreadReference]:
        """Get all thread references."""
        return self._references.copy()

    def get_references_by_type(self, reference_type: ThreadReferenceType,
    ) -> dict[str, ThreadReference]:
        """Get thread references by type."""
        return {
            tid: ref for tid, ref in self._references.items()
            if ref.reference_type == reference_type
        }

    def get_alive_references(self) -> dict[str, ThreadReference]:
        """Get references to threads that are still alive."""
        return {
            tid: ref for tid, ref in self._references.items()
            if self.is_thread_alive(tid)
        }

    def cleanup_dead_references(self) -> int:
        """Remove references to dead threads. Returns number of cleaned up references."""
        dead_threads = []

        for thread_id in list(self._references.keys()):
            if not self.is_thread_alive(thread_id):
                dead_threads.append(thread_id)

        for thread_id in dead_threads:
            self.remove_reference(thread_id)

        return len(dead_threads)

    def _cleanup_reference(self, thread_id: str,
    ) -> None:
        """Internal cleanup callback for weak references."""
        if thread_id in self._lifecycle_states:
            self._lifecycle_states[thread_id] = ThreadLifecycleState.TERMINATED

    def get_status_summary(self) -> dict[str, Any]:
        """Get summary of thread reference status."""
        total_refs = len(self._references)
        alive_count = len(self.get_alive_references())

        type_counts = {}
        for ref_type in ThreadReferenceType:
            type_counts[ref_type.value] = len(self.get_references_by_type(ref_type))

        state_counts = {}
        for state in ThreadLifecycleState:
            state_counts[state.value] = sum(
                1 for s in self._lifecycle_states.values() if s == state
            )

        return {
            "total_references": total_refs,
            "alive_threads": alive_count,
            "dead_threads": total_refs - alive_count,
            "references_by_type": type_counts,
            "threads_by_state": state_counts,
        }