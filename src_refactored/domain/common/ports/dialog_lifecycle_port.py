"""Dialog Lifecycle Port for managing dialog lifecycle operations."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.result import Result


class IDialogLifecycleManager(ABC):
    """Port interface for dialog lifecycle management."""
    
    @abstractmethod
    def manage_dialog_show(self, dialog_id: str, dialog_config: dict[str, Any]) -> Result[None]:
        """Manage dialog show operation.
        
        Args:
            dialog_id: Unique identifier for the dialog
            dialog_config: Configuration for the dialog
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def manage_dialog_hide(self, dialog_id: str) -> Result[None]:
        """Manage dialog hide operation.
        
        Args:
            dialog_id: Unique identifier for the dialog
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def manage_dialog_close(self, dialog_id: str) -> Result[None]:
        """Manage dialog close operation.
        
        Args:
            dialog_id: Unique identifier for the dialog
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def is_dialog_active(self, dialog_id: str) -> bool:
        """Check if dialog is currently active.
        
        Args:
            dialog_id: Unique identifier for the dialog
            
        Returns:
            True if dialog is active
        """
        ...
