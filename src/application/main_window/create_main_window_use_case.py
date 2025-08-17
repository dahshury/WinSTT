"""Create Main Window Application Service.

This module provides the application service for creating the main window
following hexagonal architecture principles with proper dependency injection.
"""

from dataclasses import dataclass
from typing import Protocol

from src.domain.common.result import Result
from src.domain.ui_coordination.value_objects.ui_abstractions import IUIWindow


class IConfigurationProvider(Protocol):
    """Protocol for configuration access."""
    
    def get_value(self, key: str, default: str | None = None) -> str | None:
        """Get configuration value."""
        ...


class IResourceProvider(Protocol):
    """Protocol for resource access."""
    
    def get_resource_path(self, relative_path: str) -> str:
        """Get absolute path to resource."""
        ...


class IMainWindowFactory(Protocol):
    """Protocol for main window creation."""
    
    def create_window(
        self,
        configuration_provider: IConfigurationProvider,
        resource_provider: IResourceProvider,
    ) -> Result[IUIWindow]:
        """Create main window with injected dependencies."""
        ...


@dataclass
class CreateMainWindowRequest:
    """Request to create main window."""
    title: str = "WinSTT"
    show_immediately: bool = True


@dataclass 
class CreateMainWindowResponse:
    """Response from main window creation."""
    window: IUIWindow | None
    success: bool
    error_message: str | None = None


class CreateMainWindowUseCase:
    """Application service for creating main window."""
    
    def __init__(
        self,
        configuration_provider: IConfigurationProvider,
        resource_provider: IResourceProvider,
        window_factory: IMainWindowFactory,
    ):
        self._configuration_provider = configuration_provider
        self._resource_provider = resource_provider
        self._window_factory = window_factory
    
    def execute(self, request: CreateMainWindowRequest) -> CreateMainWindowResponse:
        """Execute main window creation.
        
        Args:
            request: Creation request
            
        Returns:
            Response with created window or error
        """
        try:
            # Create window through factory with injected dependencies
            result = self._window_factory.create_window(
                self._configuration_provider,
                self._resource_provider,
            )
            
            if not result.is_success:
                return CreateMainWindowResponse(
                    window=None,
                    success=False,
                    error_message=result.error,
                )
            
            window = result.value
            
            # Configure window title if requested
            if window is not None:
                window.set_title(request.title)
            
            # Show window if requested
            if request.show_immediately and window is not None:
                window.show()
            
            return CreateMainWindowResponse(
                window=window,
                success=True,
            )
            
        except Exception as e:
            return CreateMainWindowResponse(
                window=None,
                success=False,
                error_message=f"Failed to create main window: {e}",
            )
