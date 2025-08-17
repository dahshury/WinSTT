"""Repository Base Infrastructure.

This module provides base repository pattern implementations for the WinSTT application,
enabling consistent data access patterns across different storage mechanisms.
"""

import abc
import json
import logging
import pickle
from collections.abc import Callable, Hashable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from threading import RLock
from typing import (
    Any,
    Generic,
    Protocol,
    TypeVar,
)

from src.domain.common.entity import Entity
from src.domain.common.result import Result
from src.domain.common.value_object import ValueObject

T = TypeVar("T")
TEntity = TypeVar("TEntity", bound=Entity)
TId = TypeVar("TId", bound=Hashable)


class RepositoryError(Exception):
    """Base exception for repository operations."""


class EntityNotFoundError(RepositoryError):
    """Exception raised when an entity is not found."""


class DuplicateEntityError(RepositoryError):
    """Exception raised when trying to create a duplicate entity."""


class ConcurrencyError(RepositoryError):
    """Exception raised when a concurrency conflict occurs."""


class StorageError(RepositoryError):
    """Exception raised when storage operations fail."""


class QueryOperation(Enum):
    """Enumeration of query operations."""
    EQUALS = "eq"
    NOT_EQUALS = "ne"
    GREATER_THAN = "gt"
    GREATER_THAN_OR_EQUAL = "gte"
    LESS_THAN = "lt"
    LESS_THAN_OR_EQUAL = "lte"
    CONTAINS = "contains"
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    IN = "in"
    NOT_IN = "not_in"
    IS_NULL = "is_null"
    IS_NOT_NULL = "is_not_null"


class SortDirection(Enum):
    """Enumeration of sort directions."""
    ASC = "asc"
    DESC = "desc"


@dataclass(frozen=True)
class QueryCriteria(ValueObject):
    """Value object representing query criteria."""
    field: str
    operation: QueryOperation
    value: Any = None
    
    def _get_equality_components(self) -> tuple:
        return (self.field, self.operation, self.value)
    
    @classmethod
    def equals(cls, field: str, value: Any) -> "QueryCriteria":
        """Create equals criteria.
        
        Args:
            field: Field name
            value: Field value
            
        Returns:
            Query criteria
        """
        return cls(field, QueryOperation.EQUALS, value)
    
    @classmethod
    def contains(cls, field: str, value: str) -> "QueryCriteria":
        """Create contains criteria.
        
        Args:
            field: Field name
            value: Value to search for
            
        Returns:
            Query criteria
        """
        return cls(field, QueryOperation.CONTAINS, value)
    
    @classmethod
    def greater_than(cls, field: str, value: Any) -> "QueryCriteria":
        """Create greater than criteria.
        
        Args:
            field: Field name
            value: Comparison value
            
        Returns:
            Query criteria
        """
        return cls(field, QueryOperation.GREATER_THAN, value)
    
    @classmethod
    def in_values(cls, field: str, values: list[Any]) -> "QueryCriteria":
        """Create in values criteria.
        
        Args:
            field: Field name
            values: List of values
            
        Returns:
            Query criteria
        """
        return cls(field, QueryOperation.IN, values)


@dataclass(frozen=True)
class SortCriteria(ValueObject):
    """Value object representing sort criteria."""
    field: str
    direction: SortDirection = SortDirection.ASC
    
    def _get_equality_components(self) -> tuple:
        return (self.field, self.direction)
    
    @classmethod
    def ascending(cls, field: str) -> "SortCriteria":
        """Create ascending sort criteria.
        
        Args:
            field: Field name
            
        Returns:
            Sort criteria
        """
        return cls(field, SortDirection.ASC)
    
    @classmethod
    def descending(cls, field: str) -> "SortCriteria":
        """Create descending sort criteria.
        
        Args:
            field: Field name
            
        Returns:
            Sort criteria
        """
        return cls(field, SortDirection.DESC)


@dataclass(frozen=True)
class PageInfo(ValueObject):
    """Value object representing pagination information."""
    page: int
    size: int
    total_count: int | None = None
    
    def _get_equality_components(self) -> tuple:
        return (self.page, self.size, self.total_count)
    
    @property
    def offset(self) -> int:
        """Get offset for pagination.
        
        Returns:
            Offset value
        """
        return (self.page - 1) * self.size
    
    @property
    def total_pages(self) -> int | None:
        """Get total pages.
        
        Returns:
            Total pages or None if total count is unknown
        """
        if self.total_count is None:
            return None
        return (self.total_count + self.size - 1) // self.size
    
    @property
    def has_next(self) -> bool | None:
        """Check if there are more pages.
        
        Returns:
            True if there are more pages, None if unknown
        """
        if self.total_pages is None:
            return None
        return self.page < self.total_pages
    
    @property
    def has_previous(self) -> bool:
        """Check if there are previous pages.
        
        Returns:
            True if there are previous pages
        """
        return self.page > 1
    
    def next_page(self) -> "PageInfo":
        """Get next page info.
        
        Returns:
            Next page info
        """
        return PageInfo(self.page + 1, self.size, self.total_count)
    
    def previous_page(self) -> "PageInfo":
        """Get previous page info.
        
        Returns:
            Previous page info
        """
        return PageInfo(max(1, self.page - 1), self.size, self.total_count)


@dataclass
class QuerySpecification(Generic[TEntity]):
    """Specification for querying entities."""
    criteria: list[QueryCriteria] = field(default_factory=list)
    sort_criteria: list[SortCriteria] = field(default_factory=list)
    page_info: PageInfo | None = None
    include_deleted: bool = False
    
    def where(self, criteria: QueryCriteria) -> "QuerySpecification[TEntity]":
        """Add query criteria.
        
        Args:
            criteria: Query criteria
            
        Returns:
            Updated specification
        """
        self.criteria.append(criteria)
        return self
    
    def order_by(self, sort_criteria: SortCriteria) -> "QuerySpecification[TEntity]":
        """Add sort criteria.
        
        Args:
            sort_criteria: Sort criteria
            
        Returns:
            Updated specification
        """
        self.sort_criteria.append(sort_criteria)
        return self
    
    def paginate(self, page: int, size: int) -> "QuerySpecification[TEntity]":
        """Add pagination.
        
        Args:
            page: Page number (1-based)
            size: Page size
            
        Returns:
            Updated specification
        """
        self.page_info = PageInfo(page, size)
        return self
    
    def with_deleted(self) -> "QuerySpecification[TEntity]":
        """Include deleted entities.
        
        Returns:
            Updated specification
        """
        self.include_deleted = True
        return self


@dataclass
class QueryResult(Generic[TEntity]):
    """Result of a query operation."""
    entities: list[TEntity]
    page_info: PageInfo | None = None
    total_count: int | None = None
    
    @property
    def count(self) -> int:
        """Get count of returned entities.
        
        Returns:
            Entity count
        """
        return len(self.entities)
    
    @property
    def is_empty(self) -> bool:
        """Check if result is empty.
        
        Returns:
            True if no entities returned
        """
        return len(self.entities) == 0
    
    @property
    def first(self) -> TEntity | None:
        """Get first entity.
        
        Returns:
            First entity or None
        """
        return self.entities[0] if self.entities else None
    
    @property
    def last(self) -> TEntity | None:
        """Get last entity.
        
        Returns:
            Last entity or None
        """
        return self.entities[-1] if self.entities else None
    
    def map(self, func: Callable[[TEntity], T]) -> list[T]:
        """Map entities to another type.
        
        Args:
            func: Mapping function
            
        Returns:
            Mapped list
        """
        return [func(entity) for entity in self.entities]
    
    def filter(self, predicate: Callable[[TEntity], bool]) -> "QueryResult[TEntity]":
        """Filter entities.
        
        Args:
            predicate: Filter predicate
            
        Returns:
            Filtered result
        """
        filtered_entities = [entity for entity in self.entities if predicate(entity)]
        return QueryResult(filtered_entities, self.page_info, self.total_count)


from typing import TypeVar

_TId_contra = TypeVar("_TId_contra", contravariant=True)


class IRepository(Protocol[TEntity, _TId_contra]):
    """Protocol for repository pattern."""
    
    def get_by_id(self, entity_id: _TId_contra) -> Result[TEntity | None]:
        """Get entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result containing entity or None if not found
        """
        ...
    
    def get_all(self) -> Result[list[TEntity]]:
        """Get all entities.
        
        Returns:
            Result containing list of entities
        """
        ...
    
    def find(self, specification: QuerySpecification[TEntity]) -> Result[QueryResult[TEntity]]:
        """Find entities by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Result containing query result
        """
        ...
    
    def add(self, entity: TEntity) -> Result[None]:
        """Add entity.
        
        Args:
            entity: Entity to add
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    def update(self, entity: TEntity) -> Result[None]:
        """Update entity.
        
        Args:
            entity: Entity to update
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    def remove(self, entity: TEntity) -> Result[None]:
        """Remove entity.
        
        Args:
            entity: Entity to remove
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    def remove_by_id(self, entity_id: _TId_contra) -> Result[None]:
        """Remove entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    def exists(self, entity_id: _TId_contra) -> Result[bool]:
        """Check if entity exists.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result containing existence flag
        """
        ...
    
    def count(self, specification: QuerySpecification[TEntity] | None = None) -> Result[int]:
        """Count entities.
        
        Args:
            specification: Optional query specification
            
        Returns:
            Result containing entity count
        """
        ...


class RepositoryBase(Generic[TEntity, TId], IRepository[TEntity, TId]):
    """Base repository implementation."""
    
    def __init__(self, entity_type: type[TEntity]):
        """Initialize repository.
        
        Args:
            entity_type: Entity type
        """
        self.entity_type = entity_type
        self._lock = RLock()
        self.logger = logging.getLogger(__name__)
    
    @abc.abstractmethod
    def _get_by_id_impl(self, entity_id: TId) -> TEntity | None:
        """Implementation-specific get by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Entity or None if not found
        """
    
    @abc.abstractmethod
    def _get_all_impl(self) -> list[TEntity]:
        """Implementation-specific get all.
        
        Returns:
            List of entities
        """
    
    @abc.abstractmethod
    def _find_impl(self, specification: QuerySpecification[TEntity]) -> QueryResult[TEntity]:
        """Implementation-specific find.
        
        Args:
            specification: Query specification
            
        Returns:
            Query result
        """
    
    @abc.abstractmethod
    def _add_impl(self, entity: TEntity) -> None:
        """Implementation-specific add.
        
        Args:
            entity: Entity to add
        """
    
    @abc.abstractmethod
    def _update_impl(self, entity: TEntity) -> None:
        """Implementation-specific update.
        
        Args:
            entity: Entity to update
        """
    
    @abc.abstractmethod
    def _remove_impl(self, entity: TEntity) -> None:
        """Implementation-specific remove.
        
        Args:
            entity: Entity to remove
        """
    
    @abc.abstractmethod
    def _exists_impl(self, entity_id: TId) -> bool:
        """Implementation-specific exists check.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            True if entity exists
        """
    
    @abc.abstractmethod
    def _count_impl(self, specification: QuerySpecification[TEntity] | None = None) -> int:
        """Implementation-specific count.
        
        Args:
            specification: Optional query specification
            
        Returns:
            Entity count
        """
    
    def get_by_id(self, entity_id: TId) -> Result[TEntity | None]:
        """Get entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result containing entity or None if not found
        """
        try:
            with self._lock:
                entity = self._get_by_id_impl(entity_id)
                return Result.success(entity)
        except Exception as e:
            error_msg = f"Failed to get entity by ID {entity_id}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_all(self) -> Result[list[TEntity]]:
        """Get all entities.
        
        Returns:
            Result containing list of entities
        """
        try:
            with self._lock:
                entities = self._get_all_impl()
                return Result.success(entities)
        except Exception as e:
            error_msg = f"Failed to get all entities: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def find(self, specification: QuerySpecification[TEntity]) -> Result[QueryResult[TEntity]]:
        """Find entities by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Result containing query result
        """
        try:
            with self._lock:
                result = self._find_impl(specification)
                return Result.success(result)
        except Exception as e:
            error_msg = f"Failed to find entities: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def add(self, entity: TEntity) -> Result[None]:
        """Add entity.
        
        Args:
            entity: Entity to add
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                # Check if entity already exists
                if hasattr(entity, "id"):
                    from typing import cast
                    entity_id_typed: TId = cast("TId", entity.id)
                    if self._exists_impl(entity_id_typed):
                        return Result.failure(f"Entity with ID {getattr(entity, 'id', 'unknown')} already exists")
                
                self._add_impl(entity)
                self.logger.debug(f"Added entity {getattr(entity, 'id', 'unknown')}")
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to add entity: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def update(self, entity: TEntity) -> Result[None]:
        """Update entity.
        
        Args:
            entity: Entity to update
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                # Check if entity exists
                if hasattr(entity, "id"):
                    from typing import cast
                    entity_id_typed: TId = cast("TId", entity.id)
                    if not self._exists_impl(entity_id_typed):
                        return Result.failure(f"Entity with ID {getattr(entity, 'id', 'unknown')} not found")
                
                self._update_impl(entity)
                self.logger.debug(f"Updated entity {getattr(entity, 'id', 'unknown')}")
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to update entity: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def remove(self, entity: TEntity) -> Result[None]:
        """Remove entity.
        
        Args:
            entity: Entity to remove
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                self._remove_impl(entity)
                self.logger.debug(f"Removed entity {getattr(entity, 'id', 'unknown')}")
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to remove entity: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def remove_by_id(self, entity_id: TId) -> Result[None]:
        """Remove entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                entity = self._get_by_id_impl(entity_id)
                if not entity:
                    return Result.failure(f"Entity with ID {entity_id} not found")
                
                self._remove_impl(entity)
                self.logger.debug(f"Removed entity {entity_id}")
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to remove entity by ID {entity_id}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def exists(self, entity_id: TId) -> Result[bool]:
        """Check if entity exists.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Result containing existence flag
        """
        try:
            with self._lock:
                exists = self._exists_impl(entity_id)
                return Result.success(exists)
        except Exception as e:
            error_msg = f"Failed to check entity existence {entity_id}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def count(self, specification: QuerySpecification[TEntity] | None = None) -> Result[int]:
        """Count entities.
        
        Args:
            specification: Optional query specification
            
        Returns:
            Result containing entity count
        """
        try:
            with self._lock:
                count = self._count_impl(specification)
                return Result.success(count)
        except Exception as e:
            error_msg = f"Failed to count entities: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def find_one(self, specification: QuerySpecification[TEntity]) -> Result[TEntity | None]:
        """Find single entity by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Result containing entity or None if not found
        """
        result = self.find(specification)
        if not result.is_success:
            return Result.failure(result.get_error())

        query_result = result.get_value()
        if query_result.is_empty:
            return Result.success(None)
        
        if query_result.count > 1:
            return Result.failure("Multiple entities found when expecting single result")
        
        return Result.success(query_result.first)
    
    def find_first(self, specification: QuerySpecification[TEntity]) -> Result[TEntity | None]:
        """Find first entity by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Result containing first entity or None if not found
        """
        # Limit to 1 result
        specification.paginate(1, 1)
        
        result = self.find(specification)
        if not result.is_success:
            return Result.failure(result.get_error())

        query_result = result.get_value()
        return Result.success(query_result.first)


class InMemoryRepository(RepositoryBase[TEntity, TId]):
    """In-memory repository implementation."""
    
    def __init__(self, entity_type: type[TEntity]):
        """Initialize in-memory repository.
        
        Args:
            entity_type: Entity type
        """
        super().__init__(entity_type)
        self._entities: dict[TId, TEntity] = {}
    
    def _get_by_id_impl(self, entity_id: TId) -> TEntity | None:
        """Get entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Entity or None if not found
        """
        return self._entities.get(entity_id)
    
    def _get_all_impl(self) -> list[TEntity]:
        """Get all entities.
        
        Returns:
            List of entities
        """
        return list(self._entities.values())
    
    def _find_impl(self, specification: QuerySpecification[TEntity]) -> QueryResult[TEntity]:
        """Find entities by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Query result
        """
        entities = list(self._entities.values())
        
        # Apply filters
        for criteria in specification.criteria:
            entities = self._apply_criteria(entities, criteria)
        
        # Apply sorting
        for sort_criteria in specification.sort_criteria:
            entities = self._apply_sort(entities, sort_criteria)
        
        # Count before pagination
        total_count = len(entities)
        
        # Apply pagination
        if specification.page_info:
            page_info = specification.page_info
            start_idx = page_info.offset
            end_idx = start_idx + page_info.size
            entities = entities[start_idx:end_idx]
            
            # Update page info with total count
            page_info = PageInfo(page_info.page, page_info.size, total_count)
        else:
            page_info = None
        
        return QueryResult(entities, page_info, total_count)
    
    def _apply_criteria(self, entities: list[TEntity], criteria: QueryCriteria) -> list[TEntity]:
        """Apply query criteria to entities.
        
        Args:
            entities: List of entities
            criteria: Query criteria
            
        Returns:
            Filtered entities
        """
        def matches_criteria(entity: TEntity) -> bool:
            try:
                field_value = getattr(entity, criteria.field)
                
                if criteria.operation == QueryOperation.EQUALS:
                    return field_value == criteria.value
                if criteria.operation == QueryOperation.NOT_EQUALS:
                    return field_value != criteria.value
                if criteria.operation == QueryOperation.GREATER_THAN:
                    return field_value > criteria.value
                if criteria.operation == QueryOperation.GREATER_THAN_OR_EQUAL:
                    return field_value >= criteria.value
                if criteria.operation == QueryOperation.LESS_THAN:
                    return field_value < criteria.value
                if criteria.operation == QueryOperation.LESS_THAN_OR_EQUAL:
                    return field_value <= criteria.value
                if criteria.operation == QueryOperation.CONTAINS:
                    return criteria.value in str(field_value)
                if criteria.operation == QueryOperation.STARTS_WITH:
                    return str(field_value).startswith(str(criteria.value))
                if criteria.operation == QueryOperation.ENDS_WITH:
                    return str(field_value).endswith(str(criteria.value))
                if criteria.operation == QueryOperation.IN:
                    return field_value in criteria.value
                if criteria.operation == QueryOperation.NOT_IN:
                    return field_value not in criteria.value
                if criteria.operation == QueryOperation.IS_NULL:
                    return field_value is None
                if criteria.operation == QueryOperation.IS_NOT_NULL:
                    return field_value is not None
                return True
            except AttributeError:
                return False
        
        return [entity for entity in entities if matches_criteria(entity)]
    
    def _apply_sort(self, entities: list[TEntity], sort_criteria: SortCriteria) -> list[TEntity]:
        """Apply sort criteria to entities.
        
        Args:
            entities: List of entities
            sort_criteria: Sort criteria
            
        Returns:
            Sorted entities
        """
        try:
            reverse = sort_criteria.direction == SortDirection.DESC
            return sorted(
                entities,
                key=lambda e: str(getattr(e, sort_criteria.field, "")),
                reverse=reverse,
            )
        except Exception:
            # If sorting fails, return original list
            return entities
    
    def _add_impl(self, entity: TEntity) -> None:
        """Add entity.
        
        Args:
            entity: Entity to add
        """
        if hasattr(entity, "id"):
            from typing import cast
            self._entities[cast("TId", entity.id)] = entity
        else:
            msg = "Entity must have an 'id' attribute"
            raise ValueError(msg)
    
    def _update_impl(self, entity: TEntity) -> None:
        """Update entity.
        
        Args:
            entity: Entity to update
        """
        if hasattr(entity, "id"):
            from typing import cast
            self._entities[cast("TId", entity.id)] = entity
        else:
            msg = "Entity must have an 'id' attribute"
            raise ValueError(msg)
    
    def _remove_impl(self, entity: TEntity) -> None:
        """Remove entity.
        
        Args:
            entity: Entity to remove
        """
        if hasattr(entity, "id"):
            from typing import cast
            key = cast("TId", entity.id)
            if key in self._entities:
                del self._entities[key]
    
    def _exists_impl(self, entity_id: TId) -> bool:
        """Check if entity exists.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            True if entity exists
        """
        return entity_id in self._entities
    
    def _count_impl(self, specification: QuerySpecification[TEntity] | None = None) -> int:
        """Count entities.
        
        Args:
            specification: Optional query specification
            
        Returns:
            Entity count
        """
        if not specification:
            return len(self._entities)
        
        # Apply specification without pagination to get accurate count
        spec_without_pagination = QuerySpecification[TEntity]()
        spec_without_pagination.criteria = specification.criteria
        spec_without_pagination.include_deleted = specification.include_deleted
        
        result = self._find_impl(spec_without_pagination)
        return result.total_count or 0
    
    def clear(self) -> Result[None]:
        """Clear all entities.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                self._entities.clear()
                self.logger.debug("Cleared all entities")
                return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to clear entities: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


class FileRepository(RepositoryBase[TEntity, TId]):
    """File-based repository implementation."""
    
    def __init__(self, entity_type: type[TEntity], storage_path: str, 
                 serializer_type: str = "json"):
        """Initialize file repository.
        
        Args:
            entity_type: Entity type
            storage_path: Storage directory path
            serializer: Serialization format ("json" or "pickle")
        """
        super().__init__(entity_type)
        self.storage_path = Path(storage_path)
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.serializer = serializer_type
        
        if serializer_type not in ["json", "pickle"]:
            msg = "Serializer must be 'json' or 'pickle'"
            raise ValueError(msg)
    
    def _get_entity_file_path(self, entity_id: TId) -> Path:
        """Get file path for entity.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            File path
        """
        extension = ".json" if self.serializer == "json" else ".pkl"
        return self.storage_path / f"{entity_id}{extension}"
    
    def _serialize_entity(self, entity: TEntity) -> bytes:
        """Serialize entity.
        
        Args:
            entity: Entity to serialize
            
        Returns:
            Serialized data
        """
        if self.serializer == "json":
            # Convert entity to dict (assuming entity has to_dict method)
            try:
                if hasattr(entity, "to_dict"):
                    to_dict_method = entity.to_dict
                    data = to_dict_method() if callable(to_dict_method) else entity.__dict__
                else:
                    data = entity.__dict__
            except Exception:
                # Fallback to __dict__ if to_dict fails
                data = entity.__dict__
            return json.dumps(data, indent=2, default=str).encode("utf-8")
        # pickle
        return pickle.dumps(entity)
    
    def _deserialize_entity(self, data: bytes) -> TEntity:
        """Deserialize entity.
        
        Args:
            data: Serialized data
            
        Returns:
            Deserialized entity
        """
        if self.serializer == "json":
            json_data = json.loads(data.decode("utf-8"))
            # Convert dict to entity (prefer explicit from_dict when available)
            if hasattr(self.entity_type, "from_dict"):
                from typing import cast
                from_dict_fn = self.entity_type.from_dict
                return cast("TEntity", from_dict_fn(json_data))
            # Create entity instance and set attributes
            entity = self.entity_type.__new__(self.entity_type)  # type: ignore[call-overload]
            for key, value in json_data.items():
                setattr(entity, key, value)
            return entity  # type: ignore[return-value]
        # pickle
        return pickle.loads(data)
    
    def _get_by_id_impl(self, entity_id: TId) -> TEntity | None:
        """Get entity by ID.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            Entity or None if not found
        """
        file_path = self._get_entity_file_path(entity_id)
        
        if not file_path.exists():
            return None
        
        try:
            with open(file_path, "rb") as f:
                data = f.read()
            return self._deserialize_entity(data)
        except Exception as e:
            self.logger.exception(f"Failed to load entity {entity_id}: {e}")
            return None
    
    def _get_all_impl(self) -> list[TEntity]:
        """Get all entities.
        
        Returns:
            List of entities
        """
        entities = []
        extension = ".json" if self.serializer == "json" else ".pkl"
        
        for file_path in self.storage_path.glob(f"*{extension}"):
            try:
                with open(file_path, "rb") as f:
                    data = f.read()
                entity = self._deserialize_entity(data)
                entities.append(entity)
            except Exception as e:
                self.logger.exception(f"Failed to load entity from {file_path}: {e}")
                continue
        
        return entities
    
    def _find_impl(self, specification: QuerySpecification[TEntity]) -> QueryResult[TEntity]:
        """Find entities by specification.
        
        Args:
            specification: Query specification
            
        Returns:
            Query result
        """
        # For file repository, we load all entities and filter in memory
        # This is not efficient for large datasets, but works for small to medium datasets
        entities = self._get_all_impl()
        
        # Apply filters
        for criteria in specification.criteria:
            entities = self._apply_criteria(entities, criteria)
        
        # Apply sorting
        for sort_criteria in specification.sort_criteria:
            entities = self._apply_sort(entities, sort_criteria)
        
        # Count before pagination
        total_count = len(entities)
        
        # Apply pagination
        if specification.page_info:
            page_info = specification.page_info
            start_idx = page_info.offset
            end_idx = start_idx + page_info.size
            entities = entities[start_idx:end_idx]
            
            # Update page info with total count
            page_info = PageInfo(page_info.page, page_info.size, total_count)
        else:
            page_info = None
        
        return QueryResult(entities, page_info, total_count)
    
    def _apply_criteria(self, entities: list[TEntity], criteria: QueryCriteria) -> list[TEntity]:
        """Apply query criteria to entities.
        
        Args:
            entities: List of entities
            criteria: Query criteria
            
        Returns:
            Filtered entities
        """
        # Same implementation as InMemoryRepository
        def matches_criteria(entity: TEntity) -> bool:
            try:
                field_value = getattr(entity, criteria.field)
                
                if criteria.operation == QueryOperation.EQUALS:
                    return field_value == criteria.value
                if criteria.operation == QueryOperation.NOT_EQUALS:
                    return field_value != criteria.value
                if criteria.operation == QueryOperation.GREATER_THAN:
                    return field_value > criteria.value
                if criteria.operation == QueryOperation.GREATER_THAN_OR_EQUAL:
                    return field_value >= criteria.value
                if criteria.operation == QueryOperation.LESS_THAN:
                    return field_value < criteria.value
                if criteria.operation == QueryOperation.LESS_THAN_OR_EQUAL:
                    return field_value <= criteria.value
                if criteria.operation == QueryOperation.CONTAINS:
                    return criteria.value in str(field_value)
                if criteria.operation == QueryOperation.STARTS_WITH:
                    return str(field_value).startswith(str(criteria.value))
                if criteria.operation == QueryOperation.ENDS_WITH:
                    return str(field_value).endswith(str(criteria.value))
                if criteria.operation == QueryOperation.IN:
                    return field_value in criteria.value
                if criteria.operation == QueryOperation.NOT_IN:
                    return field_value not in criteria.value
                if criteria.operation == QueryOperation.IS_NULL:
                    return field_value is None
                if criteria.operation == QueryOperation.IS_NOT_NULL:
                    return field_value is not None
                return True
            except AttributeError:
                return False
        
        return [entity for entity in entities if matches_criteria(entity)]
    
    def _apply_sort(self, entities: list[TEntity], sort_criteria: SortCriteria) -> list[TEntity]:
        """Apply sort criteria to entities.
        
        Args:
            entities: List of entities
            sort_criteria: Sort criteria
            
        Returns:
            Sorted entities
        """
        try:
            reverse = sort_criteria.direction == SortDirection.DESC
            return sorted(
                entities,
                key=lambda e: str(getattr(e, sort_criteria.field, "")),
                reverse=reverse,
            )
        except Exception:
            # If sorting fails, return original list
            return entities
    
    def _add_impl(self, entity: TEntity) -> None:
        """Add entity.
        
        Args:
            entity: Entity to add
        """
        if not hasattr(entity, "id"):
            msg = "Entity must have an 'id' attribute"
            raise ValueError(msg)
        
        from typing import cast
        file_path = self._get_entity_file_path(cast("TId", entity.id))
        data = self._serialize_entity(entity)
        
        with open(file_path, "wb") as f:
            f.write(data)
    
    def _update_impl(self, entity: TEntity) -> None:
        """Update entity.
        
        Args:
            entity: Entity to update
        """
        # Same as add for file repository
        self._add_impl(entity)
    
    def _remove_impl(self, entity: TEntity) -> None:
        """Remove entity.
        
        Args:
            entity: Entity to remove
        """
        if not hasattr(entity, "id"):
            msg = "Entity must have an 'id' attribute"
            raise ValueError(msg)
        
        from typing import cast
        file_path = self._get_entity_file_path(cast("TId", entity.id))
        
        if file_path.exists():
            file_path.unlink()
    
    def _exists_impl(self, entity_id: TId) -> bool:
        """Check if entity exists.
        
        Args:
            entity_id: Entity identifier
            
        Returns:
            True if entity exists
        """
        file_path = self._get_entity_file_path(entity_id)
        return file_path.exists()
    
    def _count_impl(self, specification: QuerySpecification[TEntity] | None = None) -> int:
        """Count entities.
        
        Args:
            specification: Optional query specification
            
        Returns:
            Entity count
        """
        if not specification:
            extension = ".json" if self.serializer == "json" else ".pkl"
            return len(list(self.storage_path.glob(f"*{extension}")))
        
        # Apply specification without pagination to get accurate count
        spec_without_pagination = QuerySpecification[TEntity]()
        spec_without_pagination.criteria = specification.criteria
        spec_without_pagination.include_deleted = specification.include_deleted
        
        result = self._find_impl(spec_without_pagination)
        return result.total_count or 0


# Convenience functions
def create_in_memory_repository(entity_type: type[TEntity]) -> InMemoryRepository[TEntity, Any]:
    """Create an in-memory repository.
    
    Args:
        entity_type: Entity type
        
    Returns:
        In-memory repository
    """
    return InMemoryRepository(entity_type)


def create_file_repository(entity_type: type[TEntity], storage_path: str, 
                         serializer_type: str = "json") -> FileRepository[TEntity, Any]:
    """Create a file repository.
    
    Args:
        entity_type: Entity type
        storage_path: Storage directory path
        serializer: Serialization format
        
    Returns:
        File repository
    """
    return FileRepository(entity_type, storage_path, serializer_type)


def create_query_specification(entity_type: type[TEntity]) -> QuerySpecification[TEntity]:
    """Create a query specification.
    
    Args:
        entity_type: Entity type
        
    Returns:
        Query specification
    """
    return QuerySpecification[TEntity]()