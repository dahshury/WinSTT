"""Event Publisher Port for domain event publishing."""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.common.events import DomainEvent


class IEventPublisher(ABC):
    """Port interface for publishing domain events."""
    
    @abstractmethod
    def publish(self, event: DomainEvent) -> None:
        """Publish a domain event.
        
        Args:
            event: The domain event to publish
        """
        ...
    
    @abstractmethod
    def publish_multiple(self, events: list[DomainEvent]) -> None:
        """Publish multiple domain events.
        
        Args:
            events: List of domain events to publish
        """
        ...


class IEventSubscriber(ABC):
    """Port interface for subscribing to domain events."""
    
    @abstractmethod
    def subscribe(self, event_type: type[DomainEvent], handler: Any) -> None:
        """Subscribe to a domain event type.
        
        Args:
            event_type: The type of domain event to subscribe to
            handler: The handler function to call when event is published
        """
        ...
    
    @abstractmethod
    def unsubscribe(self, event_type: type[DomainEvent], handler: Any) -> None:
        """Unsubscribe from a domain event type.
        
        Args:
            event_type: The type of domain event to unsubscribe from
            handler: The handler function to remove
        """
        ...
