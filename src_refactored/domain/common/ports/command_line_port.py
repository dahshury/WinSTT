"""Command Line Port for command line argument operations."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result


class ICommandLinePort(ABC):
    """Port interface for command line operations."""
    
    @abstractmethod
    def get_arguments(self) -> Result[list[str]]:
        """Get command line arguments.
        
        Returns:
            Result containing list of command line arguments
        """
        ...
    
    @abstractmethod
    def parse_arguments(self, argument_definitions: dict[str, Any]) -> Result[dict[str, Any]]:
        """Parse command line arguments based on definitions.
        
        Args:
            argument_definitions: Dictionary defining expected arguments
            
        Returns:
            Result containing parsed arguments
        """
        ...
    
    @abstractmethod
    def get_argument_value(self, argument_name: str) -> Result[str | None]:
        """Get value of specific command line argument.
        
        Args:
            argument_name: Name of argument to retrieve
            
        Returns:
            Result containing argument value or None if not found
        """
        ...
    
    @abstractmethod
    def has_argument(self, argument_name: str) -> Result[bool]:
        """Check if command line argument exists.
        
        Args:
            argument_name: Name of argument to check
            
        Returns:
            Result containing whether argument exists
        """
        ...


class ISerializationPort(ABC):
    """Port interface for data serialization operations."""
    
    @abstractmethod
    def serialize_to_json(self, data: Any) -> Result[str]:
        """Serialize data to JSON string.
        
        Args:
            data: Data to serialize
            
        Returns:
            Result containing JSON string
        """
        ...
    
    @abstractmethod
    def deserialize_from_json(self, json_string: str) -> Result[Any]:
        """Deserialize data from JSON string.
        
        Args:
            json_string: JSON string to deserialize
            
        Returns:
            Result containing deserialized data
        """
        ...
    
    @abstractmethod
    def serialize_to_yaml(self, data: Any) -> Result[str]:
        """Serialize data to YAML string.
        
        Args:
            data: Data to serialize
            
        Returns:
            Result containing YAML string
        """
        ...
    
    @abstractmethod
    def deserialize_from_yaml(self, yaml_string: str) -> Result[Any]:
        """Deserialize data from YAML string.
        
        Args:
            yaml_string: YAML string to deserialize
            
        Returns:
            Result containing deserialized data
        """
        ...
    
    @abstractmethod
    def serialize_to_binary(self, data: Any) -> Result[bytes]:
        """Serialize data to binary format.
        
        Args:
            data: Data to serialize
            
        Returns:
            Result containing binary data
        """
        ...
    
    @abstractmethod
    def deserialize_from_binary(self, binary_data: bytes) -> Result[Any]:
        """Deserialize data from binary format.
        
        Args:
            binary_data: Binary data to deserialize
            
        Returns:
            Result containing deserialized data
        """
        ...