"""Resource Management Service.

This module provides utilities for resource path resolution,
compatible with both development and PyInstaller environments.
"""

import os
import sys

from ...domain.common.result import Result


class ResourceService:
    """Service for managing application resources."""
    
    def __init__(self) -> None:
        self._base_path: str | None = None
        self._initialize_base_path()
    
    def _initialize_base_path(self) -> None:
        """Initialize the base path for resource resolution."""
        try:
            # PyInstaller creates a temp folder and stores path in _MEIPASS
            self._base_path = sys._MEIPASS  # type: ignore[attr-defined]
        except AttributeError:
            # We're running in development mode
            # Get the project root (go up from src_refactored/infrastructure/common)
            current_file = os.path.abspath(__file__)
            # From infrastructure/common/resource_service.py -> infrastructure/common -> infrastructure -> src_refactored -> project_root
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
            # Resources are in project root for now
            self._base_path = project_root
    
    def get_resource_path(self, relative_path: str) -> Result[str]:
        """Get absolute path to resource.
        
        Args:
            relative_path: Path relative to the resources directory
            
        Returns:
            Result containing the absolute path or error message
        """
        if not self._base_path:
            return Result.failure("Base path not initialized")
        
        if not relative_path:
            return Result.failure("Relative path cannot be empty")
        
        full_path = os.path.join(self._base_path, relative_path)
        
        # Check if resource exists
        if not os.path.exists(full_path):
            # Try multiple fallback locations
            current_file = os.path.abspath(__file__)
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(current_file))))
            
            # List of possible resource directories
            resource_dirs = [
                "src/resources",    # src/resources/file.png
                "media",           # media/file.png  
                "src",             # src/file.png
                "",                # project_root/file.png
            ]
            
            for resource_dir in resource_dirs:
                if resource_dir:
                    alt_path = os.path.join(project_root, resource_dir, relative_path.replace("resources/", ""))
                else:
                    alt_path = os.path.join(project_root, relative_path.replace("resources/", ""))
                
                if os.path.exists(alt_path):
                    return Result.success(alt_path)
            
            return Result.failure(f"Resource not found: {full_path}, tried multiple locations")
        
        return Result.success(full_path)
    
    def resource_exists(self, relative_path: str) -> bool:
        """Check if a resource exists.
        
        Args:
            relative_path: Path relative to the resources directory
            
        Returns:
            True if the resource exists, False otherwise
        """
        result = self.get_resource_path(relative_path)
        return result.is_success


# Legacy compatibility function
def resource_path(relative_path: str) -> str:
    """Legacy compatibility function for resource_path.
    
    Args:
        relative_path: Path relative to the resources directory
        
    Returns:
        Absolute path to the resource
        
    Raises:
        FileNotFoundError: If the resource cannot be found
    """
    service = ResourceService()
    result = service.get_resource_path(relative_path)
    
    if not result.is_success:
        raise FileNotFoundError(result.get_error())
    
    return result.get_value()