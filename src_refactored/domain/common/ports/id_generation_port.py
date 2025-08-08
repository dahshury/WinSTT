"""ID Generation Port for domain entities and value objects."""

from __future__ import annotations

from abc import abstractmethod
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .operation_result import OperationResult


class IDGenerationPort(Protocol):
    """Port interface for ID generation services."""
    
    @abstractmethod
    def generate_uuid(self) -> OperationResult[str]:
        """Generate a UUID string.
        
        Returns:
            OperationResult containing UUID string or error
        """
        ...
    
    @abstractmethod
    def generate_short_id(self, length: int = 8) -> OperationResult[str]:
        """Generate a short alphanumeric ID.
        
        Args:
            length: Length of the ID to generate
            
        Returns:
            OperationResult containing short ID string or error
        """
        ...
    
    @abstractmethod
    def generate_sequence_id(self, prefix: str = "", sequence_name: str = "default") -> OperationResult[str]:
        """Generate a sequential ID with optional prefix.
        
        Args:
            prefix: Optional prefix for the ID
            sequence_name: Name of the sequence to use
            
        Returns:
            OperationResult containing sequential ID string or error
        """
        ...


class DefaultIDGenerator:
    """Default ID generator using deterministic methods for domain usage."""
    
    @staticmethod
    def create_entity_id(entity_type: str, timestamp_ms: int) -> str:
        """Create a deterministic entity ID.
        
        Args:
            entity_type: Type of entity
            timestamp_ms: Timestamp in milliseconds
            
        Returns:
            Deterministic ID string
        """
        # Simple deterministic ID generation for domain use
        base_id = f"{entity_type}_{timestamp_ms}"
        # Add simple hash for uniqueness without external dependencies
        hash_value = abs(hash(base_id)) % 100000
        return f"{base_id}_{hash_value:05d}"
