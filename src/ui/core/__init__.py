"""
Core UI Infrastructure Package

This package provides the foundational patterns, abstractions, and utilities
for building a professional, maintainable UI layer following SOLID principles
and advanced design patterns.

Architecture:
- Abstract base classes for all UI components
- Dependency injection container
- Event system with mediator pattern
- Command pattern for user actions
- Observer pattern for state management
- Factory patterns for widget creation
- Strategy pattern for behavior variations
"""

# Import core abstractions first
from .abstractions import (
    ICommand,
    IMediator,
    IObservable,
    IObserver,
    IPresenter,
    IQuery,
    IServiceProvider,
    IStrategy,
    IUIComponent,
    IUIFactory,
    IUIRepository,
    IUIState,
    IUIValidator,
    IView,
    Result,
    UIAggregateRoot,
    UIBounds,
    UIEntity,
    UIEvent,
    UIEventType,
    UIPosition,
    UISize,
)

# Import container and events
from .container import ServiceLifetime, UIContainer, UIContainerBuilder
from .events import EventPriority, UIEventSystem

# Import patterns
from .patterns import (
    AnimationContext,
    AnimationStrategy,
    FadeInStrategy,
    IWidgetFactory,
    LoggingDecorator,
    ShowComponentCommand,
    SlideInStrategy,
    TooltipDecorator,
    UICommand,
    UICommandInvoker,
    UIComponentBuilder,
    UIComponentDecorator,
    UIWidgetFactory,
    ValidationDecorator,
    WidgetConfiguration,
    WidgetType,
)

__all__ = [
    "AnimationContext",
    "AnimationStrategy",
    "EventPriority",
    "FadeInStrategy",
    "ICommand",
    "IMediator",
    "IObservable",
    "IObserver",
    "IPresenter",
    "IQuery",
    "IServiceProvider",
    "IStrategy",
    "IUIComponent",
    "IUIFactory",
    "IUIRepository",
    "IUIState",
    "IUIValidator",
    "IView",
    "IWidgetFactory",
    "LoggingDecorator",
    # Core Abstractions
    "Result",
    "ServiceLifetime",
    "ShowComponentCommand",
    "SlideInStrategy",
    "TooltipDecorator",
    "UIAggregateRoot",
    "UIBounds",
    "UICommand",
    "UICommandInvoker",
    "UIComponentBuilder",
    "UIComponentDecorator",
    # Container
    "UIContainer",
    "UIContainerBuilder",
    "UIEntity",
    "UIEvent",
    # Events
    "UIEventSystem",
    "UIEventType",
    "UIPosition",
    "UISize",
    "UIWidgetFactory",
    "ValidationDecorator",
    "WidgetConfiguration",
    # Patterns
    "WidgetType",
] 