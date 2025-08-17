"""Event Processing Port for system integration operations."""

from abc import ABC, abstractmethod

from src.domain.common.result import Result


class IDragDropProcessor(ABC):
    """Port interface for drag and drop processing."""
    
    @abstractmethod
    def process_drag_enter(self, file_paths: list[str], widget_type: str) -> Result[bool]:
        """Process drag enter event.
        
        Args:
            file_paths: List of file paths being dragged
            widget_type: Type of widget receiving the drag
            
        Returns:
            Result containing whether drag should be accepted
        """
        ...
    
    @abstractmethod
    def process_drop(self, file_paths: list[str], widget_id: str) -> Result[None]:
        """Process drop event.
        
        Args:
            file_paths: List of file paths being dropped
            widget_id: ID of widget receiving the drop
            
        Returns:
            Result indicating success or failure
        """
        ...


class IKeyEventProcessor(ABC):
    """Port interface for key event processing."""
    
    @abstractmethod
    def process_key_event(self, key_combination: str, widget_context: str) -> Result[None]:
        """Process key event.
        
        Args:
            key_combination: Key combination string (e.g., "Ctrl+Alt+A")
            widget_context: Context where key was pressed
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def validate_key_combination(self, key_combination: str) -> Result[bool]:
        """Validate a key combination.
        
        Args:
            key_combination: Key combination to validate
            
        Returns:
            Result containing validation result
        """
        ...
