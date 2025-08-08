"""Unit of Work Infrastructure.

This module provides Unit of Work pattern implementation for the WinSTT application,
enabling transaction management and coordination of multiple repositories.
"""

import abc
import logging
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from threading import RLock
from typing import (
    Any,
    Protocol,
    TypeVar,
)

from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject
from src_refactored.infrastructure.common.repository_base import IRepository

T = TypeVar("T")
TEntity = TypeVar("TEntity", bound=Entity)
TId = TypeVar("TId")


class UnitOfWorkError(Exception):
    """Base exception for unit of work operations."""


class TransactionError(UnitOfWorkError):
    """Exception raised when transaction operations fail."""


class ConcurrencyError(UnitOfWorkError):
    """Exception raised when concurrency conflicts occur."""


class RollbackError(UnitOfWorkError):
    """Exception raised when rollback operations fail."""


class TransactionState(Enum):
    """Enumeration of transaction states."""
    INACTIVE = "inactive"
    ACTIVE = "active"
    COMMITTED = "committed"
    ROLLED_BACK = "rolled_back"
    FAILED = "failed"


class IsolationLevel(Enum):
    """Enumeration of transaction isolation levels."""
    READ_UNCOMMITTED = "read_uncommitted"
    READ_COMMITTED = "read_committed"
    REPEATABLE_READ = "repeatable_read"
    SERIALIZABLE = "serializable"


@dataclass(frozen=True)
class TransactionOptions(ValueObject):
    """Value object representing transaction options."""
    isolation_level: IsolationLevel = IsolationLevel.READ_COMMITTED
    timeout_seconds: int | None = None
    read_only: bool = False
    auto_commit: bool = False
    
    def _get_equality_components(self) -> tuple:
        return (self.isolation_level, self.timeout_seconds, self.read_only, self.auto_commit)
    
    @classmethod
    def default(cls) -> "TransactionOptions":
        """Create default transaction options.
        
        Returns:
            Default transaction options
        """
        return cls()
    
    @classmethod
    def create_read_only(cls) -> "TransactionOptions":
        """Create read-only transaction options.
        
        Returns:
            Read-only transaction options
        """
        return cls(read_only=True)
    
    @classmethod
    def with_timeout(cls, timeout_seconds: int) -> "TransactionOptions":
        """Create transaction options with timeout.
        
        Args:
            timeout_seconds: Timeout in seconds
            
        Returns:
            Transaction options with timeout
        """
        return cls(timeout_seconds=timeout_seconds)


@dataclass
class TransactionInfo:
    """Information about a transaction."""
    transaction_id: str
    state: TransactionState
    options: TransactionOptions
    started_at: datetime
    completed_at: datetime | None = None
    error: str | None = None
    
    @property
    def duration(self) -> timedelta | None:
        """Get transaction duration.
        
        Returns:
            Duration or None if not completed
        """
        if self.completed_at:
            return self.completed_at - self.started_at
        return None
    
    @property
    def is_active(self) -> bool:
        """Check if transaction is active.
        
        Returns:
            True if transaction is active
        """
        return self.state == TransactionState.ACTIVE
    
    @property
    def is_completed(self) -> bool:
        """Check if transaction is completed.
        
        Returns:
            True if transaction is completed
        """
        return self.state in [TransactionState.COMMITTED, TransactionState.ROLLED_BACK, TransactionState.FAILED]
    
    @property
    def is_successful(self) -> bool:
        """Check if transaction was successful.
        
        Returns:
            True if transaction was committed
        """
        return self.state == TransactionState.COMMITTED


class IUnitOfWork(Protocol):
    """Protocol for Unit of Work pattern."""
    
    @property
    def transaction_info(self) -> TransactionInfo | None:
        """Get current transaction information.
        
        Returns:
            Transaction information or None if no active transaction
        """
        ...
    
    def begin_transaction(self, options: TransactionOptions | None = None) -> Result[str]:
        """Begin a new transaction.
        
        Args:
            options: Transaction options
            
        Returns:
            Result containing transaction ID
        """
        ...
    
    def commit(self) -> Result[None]:
        """Commit the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    def rollback(self) -> Result[None]:
        """Rollback the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    def save_changes(self) -> Result[None]:
        """Save all pending changes.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    def register_new(self, entity: Entity) -> None:
        """Register a new entity.
        
        Args:
            entity: Entity to register as new
        """
        ...
    
    def register_updated(self, entity: Entity) -> None:
        """Register an updated entity.
        
        Args:
            entity: Entity to register as updated
        """
        ...
    
    def register_removed(self, entity: Entity) -> None:
        """Register a removed entity.
        
        Args:
            entity: Entity to register as removed
        """
        ...
    
    def is_registered(self, entity: Entity) -> bool:
        """Check if entity is registered.
        
        Args:
            entity: Entity to check
            
        Returns:
            True if entity is registered
        """
        ...
    
    def clear_changes(self) -> None:
        """Clear all pending changes."""
        ...

    # Optional: provide counts and callback registration used by Qt manager
    @property
    def change_count(self) -> int: ...
    def add_transaction_callback(self, callback: Callable[["TransactionInfo"], None]) -> None: ...
    def add_change_callback(self, callback: Callable[["EntityChange"], None]) -> None: ...


class EntityChangeType(Enum):
    """Enumeration of entity change types."""
    NEW = "new"
    UPDATED = "updated"
    REMOVED = "removed"


@dataclass
class EntityChange:
    """Represents a change to an entity."""
    entity: Entity
    change_type: EntityChangeType
    timestamp: datetime = field(default_factory=datetime.utcnow)
    
    @property
    def entity_id(self) -> Any:
        """Get entity ID.
        
        Returns:
            Entity identifier
        """
        return getattr(self.entity, "id", None)
    
    @property
    def entity_type(self) -> type:
        """Get entity type.
        
        Returns:
            Entity type
        """
        return type(self.entity)


class UnitOfWorkBase(IUnitOfWork):
    """Base implementation of Unit of Work pattern."""
    
    def __init__(self):
        """Initialize unit of work."""
        self._lock = RLock()
        self.logger = logging.getLogger(__name__)
        self._transaction_info: TransactionInfo | None = None
        self._repositories: dict[type, IRepository] = {}
        self._new_entities: set[Entity] = set()
        self._updated_entities: set[Entity] = set()
        self._removed_entities: set[Entity] = set()
        self._entity_changes: list[EntityChange] = []
        self._change_callbacks: list[Callable[[EntityChange], None]] = []
        self._transaction_callbacks: list[Callable[[TransactionInfo], None]] = []
    
    @property
    def transaction_info(self) -> TransactionInfo | None:
        """Get current transaction information.
        
        Returns:
            Transaction information or None if no active transaction
        """
        with self._lock:
            return self._transaction_info
    
    @property
    def has_active_transaction(self) -> bool:
        """Check if there is an active transaction.
        
        Returns:
            True if there is an active transaction
        """
        with self._lock:
            return self._transaction_info is not None and self._transaction_info.is_active
    
    @property
    def has_changes(self) -> bool:
        """Check if there are pending changes.
        
        Returns:
            True if there are pending changes
        """
        with self._lock:
            return bool(self._new_entities or self._updated_entities or self._removed_entities)
    
    @property
    def change_count(self) -> int:
        """Get count of pending changes.
        
        Returns:
            Number of pending changes
        """
        with self._lock:
            return len(self._new_entities) + len(self._updated_entities) + len(self._removed_entities)
    
    def register_repository(self, entity_type: type, repository: IRepository) -> None:
        """Register a repository for an entity type.
        
        Args:
            entity_type: Entity type
            repository: Repository instance
        """
        with self._lock:
            self._repositories[entity_type] = repository
            self.logger.debug(f"Registered repository for {entity_type.__name__}")
    
    def get_repository(self, entity_type: type) -> IRepository | None:
        """Get repository for an entity type.
        
        Args:
            entity_type: Entity type
            
        Returns:
            Repository instance or None if not found
        """
        with self._lock:
            return self._repositories.get(entity_type)
    
    def begin_transaction(self, options: TransactionOptions | None = None) -> Result[str]:
        """Begin a new transaction.
        
        Args:
            options: Transaction options
            
        Returns:
            Result containing transaction ID
        """
        try:
            with self._lock:
                if self.has_active_transaction:
                    return Result.failure("Transaction already active")
                
                if options is None:
                    options = TransactionOptions.default()
                
                transaction_id = str(uuid.uuid4())
                self._transaction_info = TransactionInfo(
                    transaction_id=transaction_id,
                    state=TransactionState.ACTIVE,
                    options=options,
                    started_at=datetime.utcnow(),
                )
                
                # Begin transaction in implementation
                begin_result = self._begin_transaction_impl(transaction_id, options)
                if not begin_result.is_success:
                    self._transaction_info = None
                    # Map failure from Result[None] to Result[str] for the public API
                    return Result.failure(begin_result.get_error())
                
                self.logger.debug(f"Started transaction {transaction_id}")
                self._notify_transaction_callbacks()
                
                return Result.success(transaction_id)
        except Exception as e:
            error_msg = f"Failed to begin transaction: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def commit(self) -> Result[None]:
        """Commit the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if not self.has_active_transaction:
                    return Result.failure("No active transaction")
                # mypy: guard transaction info
                ti_current = self._transaction_info
                assert ti_current is not None
                
                transaction_id = ti_current.transaction_id
                
                # Save all changes first
                save_result = self._save_changes_impl()
                if not save_result.is_success:
                    # Try to rollback
                    self._rollback_impl()
                    # mypy: _transaction_info is non-None inside has_active_transaction branch
                    ti_current = self._transaction_info
                    assert ti_current is not None
                    ti_current.state = TransactionState.FAILED
                    ti_current.completed_at = datetime.utcnow()
                    ti_current.error = save_result.get_error()
                    self._notify_transaction_callbacks()
                    return save_result
                
                # Commit transaction in implementation
                commit_result = self._commit_impl()
                if not commit_result.is_success:
                    # Try to rollback
                    self._rollback_impl()
                    ti_current.state = TransactionState.FAILED
                    ti_current.completed_at = datetime.utcnow()
                    ti_current.error = commit_result.get_error()
                    self._notify_transaction_callbacks()
                    return commit_result
                
                # Update transaction state
                ti_current.state = TransactionState.COMMITTED
                ti_current.completed_at = datetime.utcnow()
                
                # Clear changes
                self.clear_changes()
                
                self.logger.debug(f"Committed transaction {transaction_id}")
                self._notify_transaction_callbacks()
                
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to commit transaction: {e!s}"
            self.logger.exception(error_msg)
            
            # Update transaction state
            if self._transaction_info:
                ti_err = self._transaction_info  # type: ignore[assignment]
                ti_err.state = TransactionState.FAILED
                ti_err.completed_at = datetime.utcnow()
                ti_err.error = error_msg
                self._notify_transaction_callbacks()
            
            return Result.failure(error_msg)
    
    def rollback(self) -> Result[None]:
        """Rollback the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if not self.has_active_transaction:
                    return Result.failure("No active transaction")
                # mypy: guard transaction info
                ti_current = self._transaction_info
                assert ti_current is not None
                
                transaction_id = ti_current.transaction_id
                
                # Rollback transaction in implementation
                rollback_result = self._rollback_impl()
                
                # Update transaction state
                ti_current.state = TransactionState.ROLLED_BACK
                ti_current.completed_at = datetime.utcnow()
                
                if not rollback_result.is_success:
                    ti_current.error = rollback_result.get_error()
                
                # Clear changes
                self.clear_changes()
                
                self.logger.debug(f"Rolled back transaction {transaction_id}")
                self._notify_transaction_callbacks()
                
                return rollback_result
        except Exception as e:
            error_msg = f"Failed to rollback transaction: {e!s}"
            self.logger.exception(error_msg)
            
            # Update transaction state
            if self._transaction_info:
                ti_err2 = self._transaction_info  # type: ignore[assignment]
                ti_err2.state = TransactionState.FAILED
                ti_err2.completed_at = datetime.utcnow()
                ti_err2.error = error_msg
                self._notify_transaction_callbacks()
            
            return Result.failure(error_msg)
    
    def save_changes(self) -> Result[None]:
        """Save all pending changes.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if not self.has_changes:
                    return Result.success(None)
                
                return self._save_changes_impl()
        except Exception as e:
            error_msg = f"Failed to save changes: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def register_new(self, entity: Entity) -> None:
        """Register a new entity.
        
        Args:
            entity: Entity to register as new
        """
        with self._lock:
            # Remove from other sets if present
            self._updated_entities.discard(entity)
            self._removed_entities.discard(entity)
            
            # Add to new entities
            self._new_entities.add(entity)
            
            # Record change
            change = EntityChange(entity, EntityChangeType.NEW)
            self._entity_changes.append(change)
            self._notify_change_callbacks(change)
            
            self.logger.debug(f"Registered new entity {getattr(entity, 'id', 'unknown')}")
    
    def register_updated(self, entity: Entity) -> None:
        """Register an updated entity.
        
        Args:
            entity: Entity to register as updated
        """
        with self._lock:
            # Don't register as updated if it's already new
            if entity in self._new_entities:
                return
            
            # Remove from removed set if present
            self._removed_entities.discard(entity)
            
            # Add to updated entities
            self._updated_entities.add(entity)
            
            # Record change
            change = EntityChange(entity, EntityChangeType.UPDATED)
            self._entity_changes.append(change)
            self._notify_change_callbacks(change)
            
            self.logger.debug(f"Registered updated entity {getattr(entity, 'id', 'unknown')}")
    
    def register_removed(self, entity: Entity) -> None:
        """Register a removed entity.
        
        Args:
            entity: Entity to register as removed
        """
        with self._lock:
            # Remove from other sets
            self._new_entities.discard(entity)
            self._updated_entities.discard(entity)
            
            # Add to removed entities
            self._removed_entities.add(entity)
            
            # Record change
            change = EntityChange(entity, EntityChangeType.REMOVED)
            self._entity_changes.append(change)
            self._notify_change_callbacks(change)
            
            self.logger.debug(f"Registered removed entity {getattr(entity, 'id', 'unknown')}")
    
    def is_registered(self, entity: Entity) -> bool:
        """Check if entity is registered.
        
        Args:
            entity: Entity to check
            
        Returns:
            True if entity is registered
        """
        with self._lock:
            return entity in self._new_entities or entity in self._updated_entities or entity in self._removed_entities
    
    def clear_changes(self) -> None:
        """Clear all pending changes."""
        with self._lock:
            self._new_entities.clear()
            self._updated_entities.clear()
            self._removed_entities.clear()
            self._entity_changes.clear()
            self.logger.debug("Cleared all pending changes")
    
    def get_changes(self) -> list[EntityChange]:
        """Get all entity changes.
        
        Returns:
            List of entity changes
        """
        with self._lock:
            return self._entity_changes.copy()
    
    def get_changes_by_type(self, change_type: EntityChangeType) -> list[EntityChange]:
        """Get entity changes by type.
        
        Args:
            change_type: Change type to filter by
            
        Returns:
            List of entity changes
        """
        with self._lock:
            return [change for change in self._entity_changes if change.change_type == change_type]
    
    def add_change_callback(self, callback: Callable[[EntityChange], None]) -> None:
        """Add change callback.
        
        Args:
            callback: Callback function
        """
        with self._lock:
            self._change_callbacks.append(callback)
    
    def remove_change_callback(self, callback: Callable[[EntityChange], None]) -> None:
        """Remove change callback.
        
        Args:
            callback: Callback function
        """
        with self._lock:
            if callback in self._change_callbacks:
                self._change_callbacks.remove(callback)
    
    def add_transaction_callback(self, callback: Callable[[TransactionInfo], None]) -> None:
        """Add transaction callback.
        
        Args:
            callback: Callback function
        """
        with self._lock:
            self._transaction_callbacks.append(callback)
    
    def remove_transaction_callback(self, callback: Callable[[TransactionInfo], None]) -> None:
        """Remove transaction callback.
        
        Args:
            callback: Callback function
        """
        with self._lock:
            if callback in self._transaction_callbacks:
                self._transaction_callbacks.remove(callback)
    
    def _notify_change_callbacks(self, change: EntityChange) -> None:
        """Notify change callbacks.
        
        Args:
            change: Entity change
        """
        for callback in self._change_callbacks:
            try:
                callback(change)
            except Exception as e:
                self.logger.exception(f"Error in change callback: {e}")
    
    def _notify_transaction_callbacks(self) -> None:
        """Notify transaction callbacks."""
        ti = self._transaction_info
        if ti is None:
            return
        for callback in self._transaction_callbacks:
            try:
                callback(ti)
            except Exception as e:
                self.logger.exception(f"Error in transaction callback: {e}")
    
    def _save_changes_impl(self) -> Result[None]:
        """Implementation-specific save changes.
        
        Returns:
            Result indicating success or failure
        """
        try:
            # Save new entities
            for entity in self._new_entities:
                repository = self.get_repository(type(entity))
                if repository:
                    result = repository.add(entity)
                    if not result.is_success:
                        return result
                else:
                    self.logger.warning(f"No repository found for entity type {type(entity).__name__}")
            
            # Save updated entities
            for entity in self._updated_entities:
                repository = self.get_repository(type(entity))
                if repository:
                    result = repository.update(entity)
                    if not result.is_success:
                        return result
                else:
                    self.logger.warning(f"No repository found for entity type {type(entity).__name__}")
            
            # Remove entities
            for entity in self._removed_entities:
                repository = self.get_repository(type(entity))
                if repository:
                    result = repository.remove(entity)
                    if not result.is_success:
                        return result
                else:
                    self.logger.warning(f"No repository found for entity type {type(entity).__name__}")
            
            return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to save changes: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    @abc.abstractmethod
    def _begin_transaction_impl(self, transaction_id: str, options: TransactionOptions) -> Result[None]:
        """Implementation-specific begin transaction.
        
        Args:
            transaction_id: Transaction identifier
            options: Transaction options
            
        Returns:
            Result indicating success or failure
        """
    
    @abc.abstractmethod
    def _commit_impl(self) -> Result[None]:
        """Implementation-specific commit.
        
        Returns:
            Result indicating success or failure
        """
    
    @abc.abstractmethod
    def _rollback_impl(self) -> Result[None]:
        """Implementation-specific rollback.
        
        Returns:
            Result indicating success or failure
        """


class InMemoryUnitOfWork(UnitOfWorkBase):
    """In-memory implementation of Unit of Work."""
    
    def __init__(self):
        """Initialize in-memory unit of work."""
        super().__init__()
        self._transaction_stack: list[str] = []
        self._savepoints: dict[str, dict] = {}
    
    def _begin_transaction_impl(self, transaction_id: str, options: TransactionOptions) -> Result[None]:
        """Begin transaction implementation.
        
        Args:
            transaction_id: Transaction identifier
            options: Transaction options
            
        Returns:
            Result indicating success or failure
        """
        try:
            # For in-memory, we just track the transaction
            self._transaction_stack.append(transaction_id)
            
            # Create savepoint
            savepoint = {
                "new_entities": self._new_entities.copy(),
                "updated_entities": self._updated_entities.copy(),
                "removed_entities": self._removed_entities.copy(),
                "entity_changes": self._entity_changes.copy(),
            }
            self._savepoints[transaction_id] = savepoint
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def _commit_impl(self) -> Result[None]:
        """Commit transaction implementation.
        
        Returns:
            Result indicating success or failure
        """
        try:
            if not self._transaction_stack:
                return Result.failure("No active transaction")
            
            transaction_id = self._transaction_stack.pop()
            
            # Remove savepoint
            if transaction_id in self._savepoints:
                del self._savepoints[transaction_id]
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))
    
    def _rollback_impl(self) -> Result[None]:
        """Rollback transaction implementation.
        
        Returns:
            Result indicating success or failure
        """
        try:
            if not self._transaction_stack:
                return Result.failure("No active transaction")
            
            transaction_id = self._transaction_stack.pop()
            
            # Restore from savepoint
            if transaction_id in self._savepoints:
                savepoint = self._savepoints[transaction_id]
                self._new_entities = savepoint["new_entities"]
                self._updated_entities = savepoint["updated_entities"]
                self._removed_entities = savepoint["removed_entities"]
                self._entity_changes = savepoint["entity_changes"]
                del self._savepoints[transaction_id]
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))


class UnitOfWorkManager(QObject):
    """Manager for Unit of Work instances with PyQt signals."""
    
    # Signals
    transaction_started = pyqtSignal(str)  # transaction_id
    transaction_committed = pyqtSignal(str)  # transaction_id
    transaction_rolled_back = pyqtSignal(str)  # transaction_id
    transaction_failed = pyqtSignal(str, str)  # transaction_id, error
    changes_saved = pyqtSignal(int)  # change_count
    entity_changed = pyqtSignal(object, str)  # entity, change_type
    
    def __init__(self, unit_of_work: IUnitOfWork, parent: QObject | None = None):
        """Initialize unit of work manager.
        
        Args:
            unit_of_work: Unit of work instance
            parent: Parent QObject
        """
        super().__init__(parent)
        self.unit_of_work = unit_of_work
        self.logger = logging.getLogger(__name__)
        
        # Add callbacks
        self.unit_of_work.add_transaction_callback(self._on_transaction_changed)
        self.unit_of_work.add_change_callback(self._on_entity_changed)
    
    def _on_transaction_changed(self, transaction_info: TransactionInfo) -> None:
        """Handle transaction state changes.
        
        Args:
            transaction_info: Transaction information
        """
        try:
            if transaction_info.state == TransactionState.ACTIVE:
                self.transaction_started.emit(transaction_info.transaction_id)
            elif transaction_info.state == TransactionState.COMMITTED:
                self.transaction_committed.emit(transaction_info.transaction_id)
            elif transaction_info.state == TransactionState.ROLLED_BACK:
                self.transaction_rolled_back.emit(transaction_info.transaction_id)
            elif transaction_info.state == TransactionState.FAILED:
                error = transaction_info.error or "Unknown error"
                self.transaction_failed.emit(transaction_info.transaction_id, error)
        except Exception as e:
            self.logger.exception(f"Error handling transaction change: {e}")
    
    def _on_entity_changed(self, change: EntityChange) -> None:
        """Handle entity changes.
        
        Args:
            change: Entity change
        """
        try:
            self.entity_changed.emit(change.entity, change.change_type.value)
        except Exception as e:
            self.logger.exception(f"Error handling entity change: {e}")
    
    def begin_transaction(self, options: TransactionOptions | None = None) -> Result[str]:
        """Begin a new transaction.
        
        Args:
            options: Transaction options
            
        Returns:
            Result containing transaction ID
        """
        return self.unit_of_work.begin_transaction(options)
    
    def commit(self) -> Result[None]:
        """Commit the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        result = self.unit_of_work.commit()
        if result.is_success:
            change_count = self.unit_of_work.change_count
            self.changes_saved.emit(change_count)
        return result
    
    def rollback(self) -> Result[None]:
        """Rollback the current transaction.
        
        Returns:
            Result indicating success or failure
        """
        return self.unit_of_work.rollback()
    
    def save_changes(self) -> Result[None]:
        """Save all pending changes.
        
        Returns:
            Result indicating success or failure
        """
        result = self.unit_of_work.save_changes()
        if result.is_success:
            change_count = self.unit_of_work.change_count
            self.changes_saved.emit(change_count)
        return result
    
    @contextmanager
    def transaction(self, options: TransactionOptions | None = None):
        """Context manager for transactions.
        
        Args:
            options: Transaction options
            
        Yields:
            Transaction ID
        """
        result = self.begin_transaction(options)
        if not result.is_success:
            raise TransactionError(result.get_error())
        
        transaction_id = result.get_value()
        
        try:
            yield transaction_id
            
            commit_result = self.commit()
            if not commit_result.is_success:
                raise TransactionError(commit_result.get_error())
        except Exception:
            rollback_result = self.rollback()
            if not rollback_result.is_success:
                self.logger.exception(f"Failed to rollback transaction: {rollback_result.get_error()}")
            raise


# Convenience functions
def create_in_memory_unit_of_work() -> InMemoryUnitOfWork:
    """Create an in-memory unit of work.
    
    Returns:
        In-memory unit of work
    """
    return InMemoryUnitOfWork()


def create_unit_of_work_manager(unit_of_work: IUnitOfWork, 
                               parent: QObject | None = None) -> UnitOfWorkManager:
    """Create a unit of work manager.
    
    Args:
        unit_of_work: Unit of work instance
        parent: Parent QObject
        
    Returns:
        Unit of work manager
    """
    return UnitOfWorkManager(unit_of_work, parent)