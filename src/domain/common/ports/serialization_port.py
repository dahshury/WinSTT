"""Serialization Port.

This module defines the port for serialization/deserialization operations
without direct dependency on specific serialization implementations.
"""

from abc import ABC, abstractmethod
from typing import Any

from src.domain.common.result import Result


class SerializationPort(ABC):
    """Port for serialization and deserialization operations."""

    @abstractmethod
    def serialize_to_json(self, data: Any) -> Result[str]:
        """Serialize data to JSON string.
        
        Args:
            data: Data to serialize
            
        Returns:
            Result with JSON string or error
        """

    @abstractmethod
    def deserialize_from_json(self, json_string: str, expected_type: type | None = None) -> Result[Any]:
        """Deserialize JSON string to data.
        
        Args:
            json_string: JSON string to deserialize
            expected_type: Expected type for validation (optional)
            
        Returns:
            Result with deserialized data or error
        """

    @abstractmethod
    def serialize_to_dict(self, obj: Any) -> Result[dict[str, Any]]:
        """Serialize object to dictionary.
        
        Args:
            obj: Object to serialize
            
        Returns:
            Result with dictionary representation or error
        """

    @abstractmethod
    def deserialize_from_dict(self, data: dict[str, Any], target_type: type) -> Result[Any]:
        """Deserialize dictionary to object of specified type.
        
        Args:
            data: Dictionary data
            target_type: Target type to deserialize to
            
        Returns:
            Result with deserialized object or error
        """

    @abstractmethod
    def serialize_to_xml(self, data: Any) -> Result[str]:
        """Serialize data to XML string.
        
        Args:
            data: Data to serialize
            
        Returns:
            Result with XML string or error
        """

    @abstractmethod
    def deserialize_from_xml(self, xml_string: str, expected_type: type | None = None) -> Result[Any]:
        """Deserialize XML string to data.
        
        Args:
            xml_string: XML string to deserialize
            expected_type: Expected type for validation (optional)
            
        Returns:
            Result with deserialized data or error
        """

    @abstractmethod
    def validate_json_schema(self, json_string: str, schema: dict[str, Any]) -> Result[bool]:
        """Validate JSON string against a schema.
        
        Args:
            json_string: JSON string to validate
            schema: JSON schema to validate against
            
        Returns:
            Result with validation result or error
        """

    @abstractmethod
    def get_supported_formats(self) -> Result[list[str]]:
        """Get list of supported serialization formats.
        
        Returns:
            Result with list of format names
        """

    @abstractmethod
    def is_valid_json(self, json_string: str) -> Result[bool]:
        """Check if string is valid JSON.
        
        Args:
            json_string: String to validate
            
        Returns:
            Result with validation result
        """

    @abstractmethod
    def pretty_print_json(self, json_string: str, indent: int = 2) -> Result[str]:
        """Format JSON string with pretty printing.
        
        Args:
            json_string: JSON string to format
            indent: Number of spaces for indentation
            
        Returns:
            Result with formatted JSON string or error
        """

    @abstractmethod
    def minify_json(self, json_string: str) -> Result[str]:
        """Minify JSON string by removing unnecessary whitespace.
        
        Args:
            json_string: JSON string to minify
            
        Returns:
            Result with minified JSON string or error
        """

    @abstractmethod
    def deserialize_json_to_dict(self, file_path: str) -> Result[dict[str, Any]]:
        """Deserialize JSON from a file to dictionary.
        
        Args:
            file_path: Path to JSON file to deserialize
            
        Returns:
            Result with dictionary or error
        """