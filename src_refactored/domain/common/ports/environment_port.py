"""Environment Port Interface.

This module defines the port interface for environment variable operations.
"""

from abc import ABC, abstractmethod


class IEnvironmentPort(ABC):
    """Port interface for environment variable operations."""

    @abstractmethod
    def set_variable(self, key: str, value: str) -> None:
        """Set an environment variable.
        
        Args:
            key: The environment variable name
            value: The environment variable value
        """
        ...

    @abstractmethod
    def get_variable(self, key: str, default: str | None = None) -> str | None:
        """Get an environment variable.
        
        Args:
            key: The environment variable name
            default: Default value if not found
            
        Returns:
            The environment variable value or default
        """
        ...

    @abstractmethod
    def has_variable(self, key: str) -> bool:
        """Check if environment variable exists.
        
        Args:
            key: The environment variable name
            
        Returns:
            True if variable exists
        """
        ...

    @abstractmethod
    def set_variables(self, variables: dict[str, str]) -> None:
        """Set multiple environment variables.
        
        Args:
            variables: Dictionary of key-value pairs to set
        """
        ...

    @abstractmethod
    def get_all_variables(self) -> dict[str, str]:
        """Get all environment variables.
        
        Returns:
            Dictionary of all environment variables
        """
        ...
