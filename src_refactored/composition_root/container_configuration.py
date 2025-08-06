"""Container Configuration for WinSTT

This module configures the existing UIContainer with all new services,
using the enterprise IoC container for dependency injection.

This is part of the composition root and is allowed to know about all layers.
"""

from typing import Any, TypeVar

# Import application services - ALLOWED in composition root
from src_refactored.application.application_config import (
    ApplicationConfiguration,
    create_default_configuration,
)
from src_refactored.application.application_lifecycle.shutdown_application_use_case import (
    ShutdownApplicationUseCase,
    ShutdownManager,
    create_shutdown_manager,
    create_shutdown_use_case,
)
from src_refactored.application.application_lifecycle.startup_application_use_case import (
    StartupApplicationUseCase,
    create_startup_use_case,
)
from src_refactored.application.application_orchestrator import (
    ApplicationOrchestrator,
    create_application_orchestrator,
)

# Import domain ports
from src_refactored.domain.common.ports.logging_port import LoggingPort

# Import infrastructure adapters
from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter

# Import infrastructure services
from src_refactored.infrastructure.common.event_bus import (
    EventBus,
    EventBusManager,
    create_event_bus,
)
from src_refactored.infrastructure.common.progress_callback import (
    ProgressCallbackManager,
)
from src_refactored.infrastructure.common.task_manager import (
    TaskManager,
    create_task_manager,
)
from src_refactored.infrastructure.common.unit_of_work import (
    create_in_memory_unit_of_work,
)
from src_refactored.infrastructure.presentation.qt.ui_core_abstractions import (
    UIEventBus as UIEventBusCore,
)
from src_refactored.infrastructure.presentation.qt.ui_core_abstractions import (
    UILifecycleManager,
)
from src_refactored.infrastructure.presentation.qt.ui_core_patterns import (
    UIAnimationManager,
    UILayoutManager,
    UIPatternRegistry,
    UIThemeManager,
)
from src_refactored.presentation.core.container import UIContainer, UIContainerBuilder

T = TypeVar("T")


class ContainerConfiguration:
    """Configuration class for setting up the UIContainer with all services."""
    
    def __init__(self):
        self.logger = PythonLoggingAdapter()
        self._container: UIContainer | None = None
        self._builder: UIContainerBuilder | None = None
    
    def configure_container(self) -> UIContainer:
        """Configure and build the UIContainer with all services.
        
        Returns:
            Configured UIContainer instance
        """
        if self._container is not None:
            return self._container
        
        self.logger.info("Configuring UIContainer with all services")
        
        # Create container builder
        self._builder = UIContainerBuilder()
        
        # Register all service categories
        self._register_core_services()
        self._register_domain_services()
        self._register_application_services()
        self._register_infrastructure_services()
        register_worker_services(self._builder)
        register_ui_patterns(self._builder)
        self._register_ui_pattern_services()
        register_presentation_services(self._builder)
        
        # Build the container
        self._container = self._builder.build()
        
        self.logger.info("UIContainer configuration completed")
        return self._container
    
    def _register_core_services(self) -> None:
        """Register core application services."""
        self.logger.debug("Registering core services")
        
        # Logging Service (Singleton)
        self._builder.register_singleton(
            LoggingPort,
            lambda: PythonLoggingAdapter(),
        )
        
        # Application Configuration (Singleton)
        self._builder.register_singleton(
            ApplicationConfiguration,
            lambda: create_default_configuration(),
        )
        
        # Application Orchestrator (Singleton)
        self._builder.register_singleton(
            ApplicationOrchestrator,
            lambda: create_application_orchestrator(),
        )
    
    def _register_domain_services(self) -> None:
        """Register domain services using UIContainer."""
        self.logger.debug("Registering domain services")
        
        # Progress Management (Singleton)
        self._builder.register_singleton(
            ProgressCallbackManager,
            lambda: ProgressCallbackManager(),
        )
        
        # Task Management (Singleton)
        self._builder.register_singleton(
            TaskManager,
            lambda: create_task_manager(),
        )
        
        # Event Bus (Singleton)
        self._builder.register_singleton(
            EventBus,
            lambda: create_event_bus("default", set_as_default=True).value,
        )
        
        self._builder.register_singleton(
            EventBusManager,
            lambda: EventBusManager(),
        )
    
    def _register_application_services(self) -> None:
        """Register application use cases using UIContainer."""
        self.logger.debug("Registering application use cases")
        
        # Startup Use Case (Transient)
        self._builder.register_transient(
            StartupApplicationUseCase,
            lambda: create_startup_use_case(),
        )
        
        # Shutdown Use Case (Transient)
        self._builder.register_transient(
            ShutdownApplicationUseCase,
            lambda: create_shutdown_use_case(),
        )
        
        # Shutdown Manager (Singleton)
        self._builder.register_singleton(
            ShutdownManager,
            lambda: create_shutdown_manager(),
        )
    
    def _register_infrastructure_services(self) -> None:
        """Register infrastructure services using UIContainer."""
        self.logger.debug("Registering infrastructure services")
        
        # Unit of Work Services (Transient for stateless operations)
        self._builder.add_transient(
            "InMemoryUnitOfWork",
            lambda: create_in_memory_unit_of_work(),
        )
    
    def _register_ui_pattern_services(self) -> None:
        """Register existing UI patterns from patterns.py using UIContainer."""
        self.logger.debug("Registering UI pattern services")
        
        # UI Pattern Registry (Singleton)
        self._builder.register_singleton(
            UIPatternRegistry,
            lambda: UIPatternRegistry(),
        )
        
        # UI Layout Manager (Singleton)
        self._builder.register_singleton(
            UILayoutManager,
            lambda: UILayoutManager(),
        )
        
        # UI Theme Manager (Singleton)
        self._builder.register_singleton(
            UIThemeManager,
            lambda: UIThemeManager(),
        )
        
        # UI Animation Manager (Singleton)
        self._builder.register_singleton(
            UIAnimationManager,
            lambda: UIAnimationManager(),
        )
    
    def _register_presentation_services(self) -> None:
        """Register presentation layer services using UIContainer."""
        self.logger.debug("Registering presentation layer services")
        
        # UI Lifecycle Manager (Singleton)
        self._builder.register_singleton(
            UILifecycleManager,
            lambda: UILifecycleManager(),
        )
        
        # UI Event Bus Core (Singleton)
        self._builder.register_singleton(
            UIEventBusCore,
            lambda: UIEventBusCore(),
        )
    
    def auto_register_from_modules(self, *module_paths: str) -> None:
        """Auto-register services from modules using decorators.
        
        Args:
            *module_paths: Paths to modules to scan for decorated services
        """
        self.logger.debug(f"Auto-registering services from modules: {module_paths}")
        
        for module_path in module_paths:
            try:
                # Use the existing auto_register_from_module functionality
                self._builder.auto_register_from_module(module_path)
                self.logger.debug(f"Auto-registered services from {module_path}")
            except Exception as e:
                self.logger.warning(f"Failed to auto-register from {module_path}: {e}")
    
    def register_custom_service(
        self, 
        service_type: type[T], 
        factory_func: Any, 
        lifetime: str = "singleton",
    ) -> None:
        """Register a custom service with the container.
        
        Args:
            service_type: Type of the service to register
            factory_func: Factory function to create the service
            lifetime: Service lifetime ('singleton', 'transient', 'scoped')
        """
        if not self._builder:
            msg = "Container builder not initialized"
            raise RuntimeError(msg)
        
        if lifetime == "singleton":
            self._builder.register_singleton(service_type, factory_func)
        elif lifetime == "transient":
            self._builder.register_transient(service_type, factory_func)
        elif lifetime == "scoped":
            self._builder.register_scoped(service_type, factory_func)
        else:
            msg = f"Unknown lifetime: {lifetime}"
            raise ValueError(msg)
        
        self.logger.debug(f"Registered custom service {service_type.__name__} with {lifetime} lifetime")


class ServiceRegistrationHelper:
    """Helper class for service registration operations."""
    
    def __init__(self, container: UIContainer):
        self.container = container
        self.logger = PythonLoggingAdapter()
    
    def get_service(self, service_type: type[T]) -> T:
        """Get a service from the container.
        
        Args:
            service_type: Type of service to retrieve
            
        Returns:
            Service instance
        """
        try:
            return self.container.resolve(service_type)
        except Exception as e:
            self.logger.exception(f"Failed to resolve service {service_type.__name__}: {e}")
            raise
    
    def get_service_by_name(self, service_name: str) -> Any:
        """Get a service by name from the container.
        
        Args:
            service_name: Name of service to retrieve
            
        Returns:
            Service instance
        """
        try:
            return self.container.resolve(service_name)
        except Exception as e:
            self.logger.exception(f"Failed to resolve service '{service_name}': {e}")
            raise
    
    def check_service_registration(self, service_type: type[T]) -> bool:
        """Check if a service is registered in the container.
        
        Args:
            service_type: Type of service to check
            
        Returns:
            True if service is registered, False otherwise
        """
        try:
            self.container.resolve(service_type)
            return True
        except:
            return False
    
    def list_registered_services(self) -> dict[str, str]:
        """List all registered services in the container.
        
        Returns:
            Dictionary mapping service names to their types
        """
        # This would depend on the UIContainer implementation
        # For now, return an empty dict as a placeholder
        return {}


# Global container instance
_global_container: UIContainer | None = None
_global_helper: ServiceRegistrationHelper | None = None


def configure_global_container() -> UIContainer:
    """Configure and return the global container instance.
    
    Returns:
        Configured UIContainer instance
    """
    global _global_container, _global_helper
    
    if _global_container is None:
        config = ContainerConfiguration()
        _global_container = config.configure_container()
        _global_helper = ServiceRegistrationHelper(_global_container)
    
    return _global_container


def get_global_container() -> UIContainer:
    """Get the global container instance.
    
    Returns:
        Global UIContainer instance
        
    Raises:
        RuntimeError: If container is not configured
    """
    if _global_container is None:
        msg = "Global container not configured. Call configure_global_container() first."
        raise RuntimeError(msg)
    
    return _global_container


def get_service(service_type: type[T]) -> T:
    """Get a service from the global container.
    
    Args:
        service_type: Type of service to retrieve
        
    Returns:
        Service instance
    """
    if _global_helper is None:
        configure_global_container()
    
    return _global_helper.get_service(service_type)


def get_service_by_name(service_name: str) -> Any:
    """Get a service by name from the global container.
    
    Args:
        service_name: Name of service to retrieve
        
    Returns:
        Service instance
    """
    if _global_helper is None:
        configure_global_container()
    
    return _global_helper.get_service_by_name(service_name)


def register_worker_services(builder: UIContainerBuilder) -> None:
    """Register PyQt worker services with the container."""
    from src.workers.worker_classes import (
        ListenerWorker,
        LLMWorker,
        ModelWorker,
        PyQtAudioToText,
        VadWorker,
    )
    
    # Register worker classes as transient for thread-based operations
    builder.add_transient(PyQtAudioToText, PyQtAudioToText)
    builder.add_transient(VadWorker, VadWorker)
    builder.add_transient(ModelWorker, ModelWorker)
    builder.add_transient(ListenerWorker, ListenerWorker)
    builder.add_transient(LLMWorker, LLMWorker)


def register_ui_patterns(builder: UIContainerBuilder) -> None:
    """Register existing UI patterns from patterns.py with the container."""
    from src_refactored.presentation.core.patterns import (
        AnimationContext,
        FadeInStrategy,
        IWidgetFactory,
        LoggingDecorator,
        SlideInStrategy,
        TooltipDecorator,
        UICommandInvoker,
        UIComponentBuilder,
        UIComponentDecorator,
        UIWidgetFactory,
        ValidationDecorator,
    )
    
    # Factory patterns
    builder.add_singleton(IWidgetFactory, UIWidgetFactory)
    
    # Builder patterns - register as transient for stateful building
    builder.add_transient(UIComponentBuilder, UIComponentBuilder)
    
    # Strategy patterns - register animation strategies
    builder.add_transient(FadeInStrategy, FadeInStrategy)
    builder.add_transient(SlideInStrategy, SlideInStrategy)
    builder.add_singleton(AnimationContext, AnimationContext)
    
    # Decorator patterns - register as transient for composition
    builder.add_transient(UIComponentDecorator, UIComponentDecorator)
    builder.add_transient(TooltipDecorator, TooltipDecorator)
    builder.add_transient(ValidationDecorator, ValidationDecorator)
    builder.add_transient(LoggingDecorator, LoggingDecorator)
    
    # Command patterns
    builder.add_singleton(UICommandInvoker, UICommandInvoker)


def register_presentation_services(builder: UIContainerBuilder) -> None:
    """Register presentation layer services with the container."""
    # Note: These would be implemented as part of the refactoring
    # Main window presenters and view models
    # builder.register_transient(IMainWindowPresenter, MainWindowPresenter)
    # builder.register_transient(ISettingsDialogPresenter, SettingsDialogPresenter)
    # builder.register_transient(IVoiceVisualizerPresenter, VoiceVisualizerPresenter)
    
    # View models for MVVM pattern
    # builder.register_transient(IMainWindowViewModel, MainWindowViewModel)
    # builder.register_transient(ISettingsViewModel, SettingsViewModel)
    # builder.register_transient(IAudioVisualizationViewModel, AudioVisualizationViewModel)
    
    # UI state management
    # builder.register_singleton(IUIStateManager, UIStateManager)
    # builder.register_singleton(IThemeManager, ThemeManager)
    
    # Event handlers for UI events
    # builder.register_transient(IUIEventHandler, UIEventHandler)


def create_container_configuration() -> ContainerConfiguration:
    """Factory function to create a ContainerConfiguration instance."""
    return ContainerConfiguration()
