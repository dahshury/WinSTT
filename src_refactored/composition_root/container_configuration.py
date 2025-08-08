"""Container Configuration for WinSTT

This module configures the existing UIContainer with all new services,
using the enterprise IoC container for dependency injection.

This is part of the composition root and is allowed to know about all layers.
"""

from collections.abc import Callable
from typing import Any, TypeVar, cast

# Import application services - ALLOWED in composition root
from src_refactored.application.application_config import (
    ApplicationConfiguration,
    create_default_configuration,
)
from src_refactored.application.application_orchestrator import (
    ApplicationOrchestrator,
    create_application_orchestrator,
)

# Note: Shutdown use case temporarily disabled due to missing implementation
# from src_refactored.application.application_lifecycle.shutdown_application_use_case import (
#     ShutdownApplicationUseCase,
#     create_shutdown_use_case,
# )
from src_refactored.application.services.application_startup_service import (
    ApplicationStartupService,
    IApplicationStartupService,
)

# Import domain ports  
from src_refactored.domain.common.ports.logger_port import ILoggerPort

# Import infrastructure adapters
from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter

# Import infrastructure services
from src_refactored.infrastructure.common.event_bus import (
    EventBus,
    EventBusManager,
    get_event_bus,
    initialize_default_event_bus,
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
from src_refactored.presentation.core.container import (
    EnterpriseContainer,
    EnterpriseContainerBuilder,
)
from src_refactored.presentation.infrastructure_bridge.ui_core_abstractions import (
    UIEventBus as UIEventBusCore,
)
from src_refactored.presentation.infrastructure_bridge.ui_core_abstractions import (
    UILifecycleManager,
)
from src_refactored.presentation.infrastructure_bridge.ui_core_patterns import (
    UIAnimationManager,
    UILayoutManager,
    UIPatternRegistry,
    UIThemeManager,
)

T = TypeVar("T")


class ContainerConfiguration:
    """Configuration class for setting up the UIContainer with all services."""
    
    def __init__(self) -> None:
        self.logger = PythonLoggingAdapter()
        self._container: EnterpriseContainer | None = None
        self._builder: EnterpriseContainerBuilder | None = None
    
    def configure_container(self) -> EnterpriseContainer:
        """Configure and build the UIContainer with all services.
        
        Returns:
            Configured EnterpriseContainer instance
        """
        if self._container is not None:
            return self._container
        
        self.logger.info("Configuring UIContainer with all services")
        
        # Create container builder
        self._builder = EnterpriseContainerBuilder()
        
        # Register all service categories
        self._register_core_services()
        self._register_domain_services()
        self._register_application_services()
        self._register_infrastructure_services()
        if self._builder is not None:
            register_worker_services(self._builder)
            register_ui_adapters(self._builder)
            register_ui_patterns(self._builder)
            self._register_ui_pattern_services()
            register_presentation_services(self._builder)
        
        # Build the container
        if self._builder is not None:
            self._container = self._builder.build()
        
        self.logger.info("UIContainer configuration completed")
        return self._container
    
    def _register_core_services(self) -> None:
        """Register core application services."""
        self.logger.debug("Registering core services")
        
        # Logging Service (Singleton)
        if self._builder is not None:
            # Register logger adapter as ILoggerPort
            self._builder.add_singleton(
                cast(type[Any], ILoggerPort),
                cast(Callable[[], ILoggerPort], lambda: PythonLoggingAdapter().setup_logger()),
            )
        
        # Application Configuration (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                ApplicationConfiguration,
                lambda: create_default_configuration(),
            )
        
        # Application Orchestrator (Singleton)
        if self._builder is not None:
            def create_orchestrator() -> ApplicationOrchestrator:
                logger: ILoggerPort = PythonLoggingAdapter().setup_logger()
                startup_service: IApplicationStartupService = self._create_application_startup_service()
                return create_application_orchestrator(startup_service, logger)
            
            self._builder.add_singleton(
                ApplicationOrchestrator,
                create_orchestrator,
            )
    
    def _register_domain_services(self) -> None:
        """Register domain services using UIContainer."""
        self.logger.debug("Registering domain services")
        
        # Progress Management (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                ProgressCallbackManager,
                lambda: ProgressCallbackManager(),
            )
        
        # Task Management (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                TaskManager,
                lambda: create_task_manager(),
            )
        
        # Event Bus (Singleton)
        if self._builder is not None:
            def _event_bus_factory() -> EventBus:
                initialize_default_event_bus()
                bus = get_event_bus("default")
                if bus is None:
                    # Fallback to a fresh instance to satisfy type checker
                    return EventBus("default")
                return bus

            self._builder.add_singleton(EventBus, _event_bus_factory)
        
        if self._builder is not None:
            self._builder.add_singleton(
                EventBusManager,
                lambda: EventBusManager(),
            )
    
    def _register_application_services(self) -> None:
        """Register application use cases using UIContainer."""
        self.logger.debug("Registering application use cases")
        
        # Application Startup Service (Transient)
        if self._builder is not None:
            self._builder.add_transient(
                cast(type[Any], IApplicationStartupService),
                cast(Callable[[], IApplicationStartupService], lambda: self._create_application_startup_service()),
            )
        
        # Note: Shutdown Use Case temporarily removed until proper implementation
        
        # Note: ShutdownManager removed as it's not implemented in the use case module
    
    def _register_infrastructure_services(self) -> None:
        """Register infrastructure services using UIContainer."""
        self.logger.debug("Registering infrastructure services")
        
        # Unit of Work Services (Transient for stateless operations)
        if self._builder is not None:
            from src_refactored.infrastructure.common.unit_of_work import InMemoryUnitOfWork

            self._builder.add_transient(
                InMemoryUnitOfWork,
                cast(Callable[[], InMemoryUnitOfWork], lambda: create_in_memory_unit_of_work()),
            )
    
    def _register_ui_pattern_services(self) -> None:
        """Register existing UI patterns from patterns.py using UIContainer."""
        self.logger.debug("Registering UI pattern services")
        
        # UI Pattern Registry (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                UIPatternRegistry,
                lambda: UIPatternRegistry(),
            )
        
        # UI Layout Manager (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                UILayoutManager,
                lambda: UILayoutManager(),
            )
        
        # UI Theme Manager (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                UIThemeManager,
                lambda: UIThemeManager(),
            )
        
        # UI Animation Manager (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                UIAnimationManager,
                lambda: UIAnimationManager(),
            )
    
    def _register_presentation_services(self) -> None:
        """Register presentation layer services using UIContainer."""
        self.logger.debug("Registering presentation layer services")
        
        # UI Lifecycle Manager (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
                UILifecycleManager,
                lambda: UILifecycleManager(),
            )
        
        # UI Event Bus Core (Singleton)
        if self._builder is not None:
            self._builder.add_singleton(
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
                if self._builder is not None:
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
        
        if self._builder is None:
            msg = "Container builder not initialized"
            raise RuntimeError(msg)
        
        if lifetime == "singleton":
            self._builder.add_singleton(service_type, factory_func)
        elif lifetime == "transient":
            self._builder.add_transient(service_type, factory_func)
        elif lifetime == "scoped":
            self._builder.add_scoped(service_type, factory_func)
        else:
            msg = f"Unknown lifetime: {lifetime}"
            raise ValueError(msg)
        
        self.logger.debug(f"Registered custom service {service_type.__name__} with {lifetime} lifetime")
    
    def _create_application_startup_service(self) -> ApplicationStartupService:
        """Create an ApplicationStartupService with required dependencies."""
        from src_refactored.infrastructure.adapters.logging_adapter import PythonLoggingAdapter
        from src_refactored.infrastructure.adapters.minimal_adapters import (
            create_minimal_startup_service,
        )
        
        # Create logger and startup service with minimal adapters
        logger = PythonLoggingAdapter()
        return create_minimal_startup_service(logger)


class ServiceRegistrationHelper:
    """Helper class for service registration operations."""
    
    def __init__(self, container: EnterpriseContainer) -> None:
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
            return self.container.get_service(service_type)
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
            # Note: EnterpriseContainer doesn't have resolve by name, we'll need to implement this
            # For now, this will raise an exception
            msg = f"Service resolution by name '{service_name}' not implemented yet"
            raise NotImplementedError(msg)
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
            return self.container.is_registered(service_type)
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
_global_container: EnterpriseContainer | None = None
_global_helper: ServiceRegistrationHelper | None = None


def configure_global_container() -> EnterpriseContainer:
    """Configure and return the global container instance.
    
    Returns:
        Configured EnterpriseContainer instance
    """
    global _global_container, _global_helper
    
    if _global_container is None:
        config = ContainerConfiguration()
        _global_container = config.configure_container()
        _global_helper = ServiceRegistrationHelper(_global_container)
    
    return _global_container


def get_global_container() -> EnterpriseContainer:
    """Get the global container instance.
    
    Returns:
        Global EnterpriseContainer instance
        
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
    assert _global_helper is not None
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
    assert _global_helper is not None
    return _global_helper.get_service_by_name(service_name)


def register_worker_services(builder: EnterpriseContainerBuilder) -> None:
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


def register_ui_adapters(builder: EnterpriseContainerBuilder) -> None:
    """Register framework-agnostic UI adapters with the container.

    Only register adapters that exist to satisfy type-checking.
    """
    from src_refactored.infrastructure.adapters.pyqt6.widget_adapters import QtUIWidgetFactory
    from src_refactored.presentation.core.ui_abstractions import IUIWidgetFactory

    builder.add_singleton(cast(type[Any], IUIWidgetFactory), QtUIWidgetFactory)


def register_ui_patterns(builder: EnterpriseContainerBuilder) -> None:
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
    
    # Factory patterns - UIWidgetFactory now requires dependencies
    builder.add_singleton(cast(type[Any], IWidgetFactory), UIWidgetFactory)
    
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


def register_presentation_services(builder: EnterpriseContainerBuilder) -> None:
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
