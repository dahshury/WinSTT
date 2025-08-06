"""Serialization Port Interface.

This module defines the port interface for serialization operations in the domain layer.
"""

from abc import ABC, abstractmethod
from typing import Any


class ISerializationPort(ABC):
    """Port interface for serialization operations."""

    @abstractmethod
    def serialize_to_json(self, data: Any) -> str:
        """Serialize data to JSON string.
        
        Args:
            data: Data to serialize
            
        Returns:
            JSON string representation
            
        Raises:
            SerializationError: If serialization fails
        """
        ...

    @abstractmethod
    def deserialize_from_json(self, json_string: str) -> Any:
        """Deserialize data from JSON string.
        
        Args:
            json_string: JSON string to deserialize
            
        Returns:
            Deserialized data
            
        Raises:
            SerializationError: If deserialization fails
        """
        ...

    @abstractmethod
    def serialize_to_bytes(self, data: Any) -> bytes:
        """Serialize data to bytes.
        
        Args:
            data: Data to serialize
            
        Returns:
            Serialized bytes
            
        Raises:
            SerializationError: If serialization fails
        """
        ...

    @abstractmethod
    def deserialize_from_bytes(self, data_bytes: bytes) -> Any:
        """Deserialize data from bytes.
        
        Args:
            data_bytes: Bytes to deserialize
            
        Returns:
            Deserialized data
            
        Raises:
            SerializationError: If deserialization fails
        """
        ...

    @abstractmethod
    def serialize_dict_to_json(self, data: dict[str, Any]) -> str:
        """Serialize dictionary to JSON string.
        
        Args:
            data: Dictionary to serialize
            
        Returns:
            JSON string representation
            
        Raises:
            SerializationError: If serialization fails
        """
        ...

    @abstractmethod
    def deserialize_json_to_dict(self, json_string: str) -> dict[str, Any]:
        """Deserialize JSON string to dictionary.
        
        Args:
            json_string: JSON string to deserialize
            
        Returns:
            Deserialized dictionary
            
        Raises:
            SerializationError: If deserialization fails
        """
        ...

    @abstractmethod
    def is_valid_json(self, json_string: str) -> bool:
        """Check if string is valid JSON.
        
        Args:
            json_string: String to validate
            
        Returns:
            True if valid JSON
        """
        ...


class SerializationError(Exception):
    """Exception raised when serialization/deserialization fails."""
    
    def __init__(self, message: str, original_error: Exception | None = None):
        super().__init__(message)
        self.original_error = original_error
