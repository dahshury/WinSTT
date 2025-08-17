"""Task Manager Infrastructure.

This module provides task management capabilities for the WinSTT application,
including task scheduling, execution, monitoring, and lifecycle management.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from threading import Event, Lock, RLock
from typing import Any, Generic, Protocol, TypeVar

from PyQt6.QtCore import QObject, pyqtSignal

from src.domain.common.result import Result
from src.domain.common.value_object import ValueObject
from src.infrastructure.common.progress_callback import (
    IProgressCallback,
    ProgressInfo,
    ProgressStatus,
)

T = TypeVar("T")
R = TypeVar("R")


class TaskStatus(Enum):
    """Enumeration of task statuses."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    PAUSED = "paused"
    RETRYING = "retrying"


class TaskPriority(Enum):
    """Enumeration of task priorities."""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


class TaskType(Enum):
    """Enumeration of task types."""
    TRANSCRIPTION = "transcription"
    MODEL_LOADING = "model_loading"
    AUDIO_PROCESSING = "audio_processing"
    FILE_OPERATION = "file_operation"
    NETWORK_OPERATION = "network_operation"
    UI_OPERATION = "ui_operation"
    BACKGROUND = "background"
    SYSTEM = "system"


@dataclass(frozen=True)
class TaskConfiguration(ValueObject):
    """Value object representing task configuration."""
    max_retries: int = 3
    retry_delay: timedelta = field(default_factory=lambda: timedelta(seconds=1))
    timeout: timedelta | None = None
    priority: TaskPriority = TaskPriority.NORMAL
    task_type: TaskType = TaskType.BACKGROUND
    cancellable: bool = True
    progress_reporting: bool = True
    auto_cleanup: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def _get_equality_components(self) -> tuple:
        return (
            self.max_retries,
            self.retry_delay,
            self.timeout,
            self.priority,
            self.task_type,
            self.cancellable,
            self.progress_reporting,
            self.auto_cleanup,
            tuple(sorted(self.metadata.items())),
        )
    
    @classmethod
    def create_default(cls) -> "TaskConfiguration":
        """Create default task configuration.
        
        Returns:
            Default task configuration
        """
        return cls()
    
    @classmethod
    def create_transcription_config(cls) -> "TaskConfiguration":
        """Create configuration for transcription tasks.
        
        Returns:
            Transcription task configuration
        """
        return cls(
            max_retries=2,
            retry_delay=timedelta(seconds=2),
            timeout=timedelta(minutes=5),
            priority=TaskPriority.HIGH,
            task_type=TaskType.TRANSCRIPTION,
            cancellable=True,
            progress_reporting=True,
        )
    
    @classmethod
    def create_model_loading_config(cls) -> "TaskConfiguration":
        """Create configuration for model loading tasks.
        
        Returns:
            Model loading task configuration
        """
        return cls(
            max_retries=1,
            retry_delay=timedelta(seconds=5),
            timeout=timedelta(minutes=10),
            priority=TaskPriority.CRITICAL,
            task_type=TaskType.MODEL_LOADING,
            cancellable=False,
            progress_reporting=True,
        )
    
    @classmethod
    def create_ui_config(cls) -> "TaskConfiguration":
        """Create configuration for UI tasks.
        
        Returns:
            UI task configuration
        """
        return cls(
            max_retries=0,
            timeout=timedelta(seconds=30),
            priority=TaskPriority.HIGH,
            task_type=TaskType.UI_OPERATION,
            cancellable=True,
            progress_reporting=False,
        )


@dataclass
class TaskResult(Generic[T]):
    """Result of a task execution."""
    task_id: str
    status: TaskStatus
    result: T | None = None
    error: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    execution_time: timedelta | None = None
    retry_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    
    @property
    def is_success(self) -> bool:
        """Check if task completed successfully.
        
        Returns:
            True if task completed successfully
        """
        return self.status == TaskStatus.COMPLETED and self.error is None
    
    @property
    def is_failed(self) -> bool:
        """Check if task failed.
        
        Returns:
            True if task failed
        """
        return self.status in [TaskStatus.FAILED, TaskStatus.TIMEOUT]
    
    @property
    def is_cancelled(self) -> bool:
        """Check if task was cancelled.
        
        Returns:
            True if task was cancelled
        """
        return self.status == TaskStatus.CANCELLED
    
    def to_result(self) -> Result[T]:
        """Convert to domain Result.
        
        Returns:
            Domain Result object
        """
        if self.is_success and self.result is not None:
            return Result.success(self.result)
        if self.is_success and self.result is None:
            # Guard against None values when a success status is reported
            return Result.failure("Task returned no result")
        error_msg = self.error or f"Task failed with status: {self.status.value}"
        return Result.failure(error_msg)


from typing import TypeVar

_T_co = TypeVar("_T_co", covariant=True)


class ITask(Protocol[_T_co]):
    """Protocol for tasks."""
    
    def execute(self, progress_callback: IProgressCallback | None = None) -> _T_co:
        """Execute the task.
        
        Args:
            progress_callback: Optional progress callback
            
        Returns:
            Task result
        """
        ...
    
    def can_cancel(self) -> bool:
        """Check if task can be cancelled.
        
        Returns:
            True if task can be cancelled
        """
        ...
    
    def cancel(self) -> None:
        """Cancel the task."""
        ...


class Task(Generic[T]):
    """Base task implementation."""
    
    def __init__(self, task_id: str, name: str, func: Callable[..., T], 
                 args: tuple = (), kwargs: dict | None = None, 
                 config: TaskConfiguration | None = None):
        """Initialize task.
        
        Args:
            task_id: Task identifier
            name: Task name
            func: Function to execute
            args: Function arguments
            kwargs: Function keyword arguments
            config: Task configuration
        """
        self.task_id = task_id
        self.name = name
        self.func = func
        self.args = args or ()
        self.kwargs = kwargs or {}
        self.config = config or TaskConfiguration.create_default()
        
        self._status = TaskStatus.PENDING
        self._result: T | None = None
        self._error: str | None = None
        self._start_time: datetime | None = None
        self._end_time: datetime | None = None
        self._retry_count = 0
        self._cancelled = Event()
        self._lock = RLock()
        
        self.logger = logging.getLogger(__name__)
    
    @property
    def status(self) -> TaskStatus:
        """Get task status.
        
        Returns:
            Task status
        """
        with self._lock:
            return self._status
    
    @property
    def result(self) -> T | None:
        """Get task result.
        
        Returns:
            Task result or None
        """
        with self._lock:
            return self._result
    
    @property
    def error(self) -> str | None:
        """Get task error.
        
        Returns:
            Task error or None
        """
        with self._lock:
            return self._error
    
    @property
    def execution_time(self) -> timedelta | None:
        """Get task execution time.
        
        Returns:
            Execution time or None
        """
        with self._lock:
            if self._start_time and self._end_time:
                return self._end_time - self._start_time
            return None
    
    def execute(self, progress_callback: IProgressCallback | None = None) -> T:
        """Execute the task.
        
        Args:
            progress_callback: Optional progress callback
            
        Returns:
            Task result
            
        Raises:
            Exception: If task execution fails
        """
        with self._lock:
            if self._status != TaskStatus.PENDING:
                msg = f"Task {self.task_id} is not in pending state"
                raise RuntimeError(msg)
            
            self._status = TaskStatus.RUNNING
            self._start_time = datetime.now()
        
        try:
            if progress_callback:
                progress_callback.report_progress(
                    ProgressInfo.create(0, 100, ProgressStatus.IN_PROGRESS, f"Starting {self.name}"),
                )
            
            # Check for cancellation
            if self._cancelled.is_set():
                msg = "Task was cancelled"
                raise asyncio.CancelledError(msg)
            
            # Execute the function
            if progress_callback and "progress_callback" in self.func.__code__.co_varnames:
                kwargs = self.kwargs.copy()
                kwargs["progress_callback"] = progress_callback
                result = self.func(*self.args, **kwargs)
            else:
                result = self.func(*self.args, **self.kwargs)
            
            with self._lock:
                self._result = result
                self._status = TaskStatus.COMPLETED
                self._end_time = datetime.now()
            
            if progress_callback:
                progress_callback.report_completion(f"Completed {self.name}")
            
            self.logger.info(f"Task {self.task_id} completed successfully")
            return result
            
        except asyncio.CancelledError:
            with self._lock:
                self._status = TaskStatus.CANCELLED
                self._end_time = datetime.now()
            
            if progress_callback:
                progress_callback.report_cancellation(f"Cancelled {self.name}")
            
            self.logger.info(f"Task {self.task_id} was cancelled")
            raise
            
        except Exception as e:
            error_msg = str(e)
            
            with self._lock:
                self._error = error_msg
                self._status = TaskStatus.FAILED
                self._end_time = datetime.now()
            
            if progress_callback:
                progress_callback.report_error(f"Failed {self.name}", error_msg)
            
            self.logger.exception(f"Task {self.task_id} failed: {error_msg}")
            raise
    
    def can_cancel(self) -> bool:
        """Check if task can be cancelled.
        
        Returns:
            True if task can be cancelled
        """
        return self.config.cancellable and self._status in [TaskStatus.PENDING, TaskStatus.RUNNING]
    
    def cancel(self) -> None:
        """Cancel the task."""
        if self.can_cancel():
            self._cancelled.set()
            with self._lock:
                if self._status in [TaskStatus.PENDING, TaskStatus.RUNNING]:
                    self._status = TaskStatus.CANCELLED
                    self._end_time = datetime.now()
            
            self.logger.info(f"Task {self.task_id} cancelled")
    
    def is_cancelled(self) -> bool:
        """Check if task is cancelled.
        
        Returns:
            True if task is cancelled
        """
        return self._cancelled.is_set()
    
    def get_result(self) -> TaskResult[T]:
        """Get task result.
        
        Returns:
            Task result
        """
        with self._lock:
            return TaskResult(
                task_id=self.task_id,
                status=self._status,
                result=self._result,
                error=self._error,
                start_time=self._start_time,
                end_time=self._end_time,
                execution_time=self.execution_time,
                retry_count=self._retry_count,
                metadata=self.config.metadata.copy(),
            )


class TaskExecutor(QObject):
    """Task executor with PyQt signals."""
    
    # Signals
    task_started = pyqtSignal(str)  # task_id
    task_completed = pyqtSignal(str, object)  # task_id, result
    task_failed = pyqtSignal(str, str)  # task_id, error
    task_cancelled = pyqtSignal(str)  # task_id
    task_progress = pyqtSignal(str, object)  # task_id, progress_info
    
    def __init__(self, max_workers: int = 4):
        """Initialize task executor.
        
        Args:
            max_workers: Maximum number of worker threads
        """
        super().__init__()
        self.max_workers = max_workers
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._futures: dict[str, Future] = {}
        self._tasks: dict[str, Task] = {}
        self._lock = Lock()
        
        self.logger = logging.getLogger(__name__)
    
    def submit_task(self, task: Task[T]) -> Result[str]:
        """Submit a task for execution.
        
        Args:
            task: Task to execute
            
        Returns:
            Result containing task ID
        """
        try:
            with self._lock:
                if task.task_id in self._tasks:
                    return Result.failure(f"Task {task.task_id} already exists")
                
                # Create progress callback
                progress_callback = TaskProgressCallback(task.task_id, self)
                
                # Submit task to executor
                future = self._executor.submit(self._execute_task_with_retry, task, progress_callback)
                
                self._futures[task.task_id] = future
                self._tasks[task.task_id] = task
                
                # Add completion callback
                future.add_done_callback(lambda f: self._handle_task_completion(task.task_id, f))
                
                self.logger.info(f"Submitted task {task.task_id} for execution")
                return Result.success(task.task_id)
                
        except Exception as e:
            error_msg = f"Failed to submit task: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def _execute_task_with_retry(self, task: Task[T], progress_callback: IProgressCallback) -> T:
        """Execute task with retry logic.
        
        Args:
            task: Task to execute
            progress_callback: Progress callback
            
        Returns:
            Task result
            
        Raises:
            Exception: If task execution fails after all retries
        """
        last_exception = None
        
        for attempt in range(task.config.max_retries + 1):
            try:
                if attempt > 0:
                    task._retry_count = attempt
                    task._status = TaskStatus.RETRYING
                    
                    retry_msg = f"Retrying {task.name} (attempt {attempt + 1}/{task.config.max_retries + 1})"
                    progress_callback.report_progress(
                        ProgressInfo.create(0, 100, ProgressStatus.IN_PROGRESS, retry_msg),
                    )
                    
                    # Wait before retry
                    time.sleep(task.config.retry_delay.total_seconds())
                
                # Check for cancellation
                if task.is_cancelled():
                    msg = "Task was cancelled"
                    raise asyncio.CancelledError(msg)
                
                # Execute task
                self.task_started.emit(task.task_id)
                return task.execute(progress_callback)
                
            except asyncio.CancelledError:
                raise  # Don't retry cancelled tasks
                
            except Exception as e:
                last_exception = e
                self.logger.warning(f"Task {task.task_id} attempt {attempt + 1} failed: {e!s}")
                
                if attempt == task.config.max_retries:
                    break  # No more retries
        
        # All retries exhausted
        if last_exception:
            raise last_exception
        msg = f"Task {task.task_id} failed after {task.config.max_retries + 1} attempts"
        raise RuntimeError(msg)
    
    def _handle_task_completion(self, task_id: str, future: Future) -> None:
        """Handle task completion.
        
        Args:
            task_id: Task identifier
            future: Completed future
        """
        try:
            with self._lock:
                if task_id in self._futures:
                    del self._futures[task_id]
            
            if future.cancelled():
                self.task_cancelled.emit(task_id)
                self.logger.info(f"Task {task_id} was cancelled")
            elif future.exception():
                error = str(future.exception())
                self.task_failed.emit(task_id, error)
                self.logger.error(f"Task {task_id} failed: {error}")
            else:
                result = future.result()
                self.task_completed.emit(task_id, result)
                self.logger.info(f"Task {task_id} completed successfully")
                
        except Exception as e:
            self.logger.exception(f"Error handling task completion for {task_id}: {e}")
    
    def cancel_task(self, task_id: str) -> Result[None]:
        """Cancel a task.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                task = self._tasks.get(task_id)
                future = self._futures.get(task_id)
                
                if not task:
                    return Result.failure(f"Task {task_id} not found")
                
                if not task.can_cancel():
                    return Result.failure(f"Task {task_id} cannot be cancelled")
                
                # Cancel the task
                task.cancel()
                
                # Cancel the future if it exists
                if future and not future.done():
                    future.cancel()
                
                self.logger.info(f"Cancelled task {task_id}")
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to cancel task: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_task_status(self, task_id: str) -> TaskStatus | None:
        """Get task status.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Task status or None if not found
        """
        with self._lock:
            task = self._tasks.get(task_id)
            return task.status if task else None
    
    def get_task_result(self, task_id: str) -> TaskResult[Any] | None:
        """Get task result.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Task result or None
        """
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            
            return task.get_result()
    
    def get_running_tasks(self) -> list[str]:
        """Get list of running task IDs.
        
        Returns:
            List of running task IDs
        """
        with self._lock:
            return [
                task_id for task_id, task in self._tasks.items()
                if task.status == TaskStatus.RUNNING
            ]
    
    def get_pending_tasks(self) -> list[str]:
        """Get list of pending task IDs.
        
        Returns:
            List of pending task IDs
        """
        with self._lock:
            return [
                task_id for task_id, task in self._tasks.items()
                if task.status == TaskStatus.PENDING
            ]
    
    def cancel_all_tasks(self) -> Result[None]:
        """Cancel all tasks.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                task_ids = list(self._tasks.keys())
            
            cancelled_count = 0
            for task_id in task_ids:
                result = self.cancel_task(task_id)
                if result.is_success:
                    cancelled_count += 1
            
            self.logger.info(f"Cancelled {cancelled_count} tasks")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to cancel all tasks: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def cleanup_completed_tasks(self) -> Result[None]:
        """Cleanup completed tasks.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                completed_task_ids = [
                    task_id for task_id, task in self._tasks.items()
                    if task.status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]
                    and task.config.auto_cleanup
                ]
                
                for task_id in completed_task_ids:
                    del self._tasks[task_id]
                    if task_id in self._futures:
                        del self._futures[task_id]
            
            self.logger.info(f"Cleaned up {len(completed_task_ids)} completed tasks")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to cleanup completed tasks: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def shutdown(self, wait: bool = True) -> None:
        """Shutdown the task executor.
        
        Args:
            wait: Whether to wait for running tasks to complete
        """
        try:
            if not wait:
                self.cancel_all_tasks()
            
            self._executor.shutdown(wait=wait)
            self.logger.info("Task executor shutdown")
            
        except Exception as e:
            self.logger.exception(f"Error during shutdown: {e}")


class TaskProgressCallback(IProgressCallback):
    """Progress callback that forwards to task executor signals."""
    
    def __init__(self, task_id: str, executor: TaskExecutor):
        """Initialize task progress callback.
        
        Args:
            task_id: Task identifier
            executor: Task executor
        """
        self.task_id = task_id
        self.executor = executor
    
    def report_progress(self, progress: ProgressInfo) -> None:
        """Report progress.
        
        Args:
            progress: Progress information
        """
        self.executor.task_progress.emit(self.task_id, progress)
    
    def report_error(self, error: str, details: str = "") -> None:
        """Report an error.
        
        Args:
            error: Error message
            details: Error details
        """
        error_progress = ProgressInfo.create(
            current=0,
            total=100,
            status=ProgressStatus.FAILED,
            message=error,
            details=details,
        )
        self.executor.task_progress.emit(self.task_id, error_progress)
    
    def report_completion(self, message: str = "", details: str = "") -> None:
        """Report completion.
        
        Args:
            message: Completion message
            details: Completion details
        """
        completion_progress = ProgressInfo.create(
            current=100,
            total=100,
            status=ProgressStatus.COMPLETED,
            message=message or "Completed",
            details=details,
        )
        self.executor.task_progress.emit(self.task_id, completion_progress)
    
    def report_cancellation(self, message: str = "") -> None:
        """Report cancellation.
        
        Args:
            message: Cancellation message
        """
        cancellation_progress = ProgressInfo.create(
            current=0,
            total=100,
            status=ProgressStatus.CANCELLED,
            message=message or "Cancelled",
        )
        self.executor.task_progress.emit(self.task_id, cancellation_progress)


class TaskManager(QObject):
    """High-level task manager."""
    
    # Signals
    task_submitted = pyqtSignal(str, str)  # task_id, task_name
    task_started = pyqtSignal(str, str)  # task_id, task_name
    task_completed = pyqtSignal(str, str, object)  # task_id, task_name, result
    task_failed = pyqtSignal(str, str, str)  # task_id, task_name, error
    task_cancelled = pyqtSignal(str, str)  # task_id, task_name
    task_progress = pyqtSignal(str, str, object)  # task_id, task_name, progress_info
    
    def __init__(self, max_workers: int = 4):
        """Initialize task manager.
        
        Args:
            max_workers: Maximum number of worker threads
        """
        super().__init__()
        self._executor = TaskExecutor(max_workers)
        self._task_registry: dict[str, str] = {}  # task_id -> task_name
        self._lock = Lock()
        
        # Connect executor signals
        self._executor.task_started.connect(self._on_task_started)
        self._executor.task_completed.connect(self._on_task_completed)
        self._executor.task_failed.connect(self._on_task_failed)
        self._executor.task_cancelled.connect(self._on_task_cancelled)
        self._executor.task_progress.connect(self._on_task_progress)
        
        self.logger = logging.getLogger(__name__)
    
    def submit_task(self, name: str, func: Callable[..., T], 
                   args: tuple = (), kwargs: dict | None = None,
                   config: TaskConfiguration | None = None,
                   task_id: str | None = None) -> Result[str]:
        """Submit a task for execution.
        
        Args:
            name: Task name
            func: Function to execute
            args: Function arguments
            kwargs: Function keyword arguments
            config: Task configuration
            task_id: Optional task identifier
            
        Returns:
            Result containing task ID
        """
        try:
            # Generate task ID if not provided
            if not task_id:
                task_id = f"{name}_{uuid.uuid4().hex[:8]}"
            
            # Create task
            task = Task(
                task_id=task_id,
                name=name,
                func=func,
                args=args,
                kwargs=kwargs or {},
                config=config or TaskConfiguration.create_default(),
            )
            
            # Submit to executor
            result = self._executor.submit_task(task)
            
            if result.is_success:
                with self._lock:
                    self._task_registry[task_id] = name
                
                self.task_submitted.emit(task_id, name)
                self.logger.info(f"Submitted task '{name}' with ID {task_id}")
            
            return result
            
        except Exception as e:
            error_msg = f"Failed to submit task '{name}': {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def submit_transcription_task(self, name: str, func: Callable[..., T],
                                args: tuple = (), kwargs: dict | None = None,
                                task_id: str | None = None) -> Result[str]:
        """Submit a transcription task.
        
        Args:
            name: Task name
            func: Function to execute
            args: Function arguments
            kwargs: Function keyword arguments
            task_id: Optional task identifier
            
        Returns:
            Result containing task ID
        """
        config = TaskConfiguration.create_transcription_config()
        return self.submit_task(name, func, args, kwargs, config, task_id)
    
    def submit_model_loading_task(self, name: str, func: Callable[..., T],
                                args: tuple = (), kwargs: dict | None = None,
                                task_id: str | None = None) -> Result[str]:
        """Submit a model loading task.
        
        Args:
            name: Task name
            func: Function to execute
            args: Function arguments
            kwargs: Function keyword arguments
            task_id: Optional task identifier
            
        Returns:
            Result containing task ID
        """
        config = TaskConfiguration.create_model_loading_config()
        return self.submit_task(name, func, args, kwargs, config, task_id)
    
    def submit_ui_task(self, name: str, func: Callable[..., T],
                      args: tuple = (), kwargs: dict | None = None,
                      task_id: str | None = None) -> Result[str]:
        """Submit a UI task.
        
        Args:
            name: Task name
            func: Function to execute
            args: Function arguments
            kwargs: Function keyword arguments
            task_id: Optional task identifier
            
        Returns:
            Result containing task ID
        """
        config = TaskConfiguration.create_ui_config()
        return self.submit_task(name, func, args, kwargs, config, task_id)
    
    def cancel_task(self, task_id: str) -> Result[None]:
        """Cancel a task.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Result indicating success or failure
        """
        return self._executor.cancel_task(task_id)
    
    def get_task_status(self, task_id: str) -> TaskStatus | None:
        """Get task status.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Task status or None if not found
        """
        return self._executor.get_task_status(task_id)
    
    def get_task_result(self, task_id: str) -> TaskResult[Any] | None:
        """Get task result.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Task result or None if not found
        """
        return self._executor.get_task_result(task_id)
    
    def get_task_name(self, task_id: str) -> str | None:
        """Get task name.
        
        Args:
            task_id: Task identifier
            
        Returns:
            Task name or None if not found
        """
        with self._lock:
            return self._task_registry.get(task_id)
    
    def get_running_tasks(self) -> list[tuple[str, str]]:
        """Get list of running tasks.
        
        Returns:
            List of (task_id, task_name) tuples
        """
        running_ids = self._executor.get_running_tasks()
        with self._lock:
            return [(task_id, self._task_registry.get(task_id, "Unknown")) for task_id in running_ids]
    
    def get_pending_tasks(self) -> list[tuple[str, str]]:
        """Get list of pending tasks.
        
        Returns:
            List of (task_id, task_name) tuples
        """
        pending_ids = self._executor.get_pending_tasks()
        with self._lock:
            return [(task_id, self._task_registry.get(task_id, "Unknown")) for task_id in pending_ids]
    
    def cancel_all_tasks(self) -> Result[None]:
        """Cancel all tasks.
        
        Returns:
            Result indicating success or failure
        """
        return self._executor.cancel_all_tasks()
    
    def cleanup_completed_tasks(self) -> Result[None]:
        """Cleanup completed tasks.
        
        Returns:
            Result indicating success or failure
        """
        result = self._executor.cleanup_completed_tasks()
        
        if result.is_success:
            # Also cleanup task registry
            with self._lock:
                active_task_ids = set(self._executor.get_running_tasks() + self._executor.get_pending_tasks())
                completed_task_ids = [task_id for task_id in self._task_registry if task_id not in active_task_ids]
                
                for task_id in completed_task_ids:
                    del self._task_registry[task_id]
        
        return result
    
    def shutdown(self, wait: bool = True) -> None:
        """Shutdown the task manager.
        
        Args:
            wait: Whether to wait for running tasks to complete
        """
        try:
            self._executor.shutdown(wait)
            
            with self._lock:
                self._task_registry.clear()
            
            self.logger.info("Task manager shutdown")
            
        except Exception as e:
            self.logger.exception(f"Error during shutdown: {e}")
    
    def _on_task_started(self, task_id: str) -> None:
        """Handle task started signal.
        
        Args:
            task_id: Task identifier
        """
        with self._lock:
            task_name = self._task_registry.get(task_id, "Unknown")
        
        self.task_started.emit(task_id, task_name)
    
    def _on_task_completed(self, task_id: str, result: Any) -> None:
        """Handle task completed signal.
        
        Args:
            task_id: Task identifier
            result: Task result
        """
        with self._lock:
            task_name = self._task_registry.get(task_id, "Unknown")
        
        self.task_completed.emit(task_id, task_name, result)
    
    def _on_task_failed(self, task_id: str, error: str) -> None:
        """Handle task failed signal.
        
        Args:
            task_id: Task identifier
            error: Error message
        """
        with self._lock:
            task_name = self._task_registry.get(task_id, "Unknown")
        
        self.task_failed.emit(task_id, task_name, error)
    
    def _on_task_cancelled(self, task_id: str) -> None:
        """Handle task cancelled signal.
        
        Args:
            task_id: Task identifier
        """
        with self._lock:
            task_name = self._task_registry.get(task_id, "Unknown")
        
        self.task_cancelled.emit(task_id, task_name)
    
    def _on_task_progress(self, task_id: str, progress_info: ProgressInfo) -> None:
        """Handle task progress signal.
        
        Args:
            task_id: Task identifier
            progress_info: Progress information
        """
        with self._lock:
            task_name = self._task_registry.get(task_id, "Unknown")
        
        self.task_progress.emit(task_id, task_name, progress_info)


# Convenience functions
def create_task_manager(max_workers: int = 4) -> TaskManager:
    """Create a task manager.
    
    Args:
        max_workers: Maximum number of worker threads
        
    Returns:
        Task manager
    """
    return TaskManager(max_workers)


def create_task(task_id: str, name: str, func: Callable[..., T],
               args: tuple = (), kwargs: dict | None = None,
               config: TaskConfiguration | None = None) -> Task[T]:
    """Create a task.
    
    Args:
        task_id: Task identifier
        name: Task name
        func: Function to execute
        args: Function arguments
        kwargs: Function keyword arguments
        config: Task configuration
        
    Returns:
        Task instance
    """
    return Task(task_id, name, func, args, kwargs or {}, config or TaskConfiguration.create_default())


def create_transcription_task(task_id: str, name: str, func: Callable[..., T],
                            args: tuple = (), kwargs: dict | None = None) -> Task[T]:
    """Create a transcription task.
    
    Args:
        task_id: Task identifier
        name: Task name
        func: Function to execute
        args: Function arguments
        kwargs: Function keyword arguments
        
    Returns:
        Task instance
    """
    config = TaskConfiguration.create_transcription_config()
    return Task(task_id, name, func, args, kwargs or {}, config)


def create_model_loading_task(task_id: str, name: str, func: Callable[..., T],
                            args: tuple = (), kwargs: dict | None = None) -> Task[T]:
    """Create a model loading task.
    
    Args:
        task_id: Task identifier
        name: Task name
        func: Function to execute
        args: Function arguments
        kwargs: Function keyword arguments
        
    Returns:
        Task instance
    """
    config = TaskConfiguration.create_model_loading_config()
    return Task(task_id, name, func, args, kwargs or {}, config)