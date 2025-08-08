"""Settings Domain Events."""

from dataclasses import dataclass
from typing import Any

from src_refactored.domain.common.events import DomainEvent
from src_refactored.domain.settings.value_objects.settings_operations import SettingType


@dataclass(frozen=True)
class SettingsUpdatedEvent(DomainEvent):
    """Event raised when settings are updated."""
    
    setting_types: list[SettingType]
    changes_count: int
    restart_required: bool = False
    
    def __post_init__(self):
        super().__post_init__()


@dataclass(frozen=True)
class SettingsApplyProgressEvent(DomainEvent):
    """Event raised to notify about settings application progress."""
    
    percentage: int
    message: str
    current_step: str
    
    def __post_init__(self):
        super().__post_init__()


@dataclass(frozen=True)
class SettingsValidationFailedEvent(DomainEvent):
    """Event raised when settings validation fails."""
    
    failed_settings: list[str]
    error_messages: list[str]
    
    def __post_init__(self):
        super().__post_init__()


@dataclass(frozen=True)
class WorkerReinitializationRequestedEvent(DomainEvent):
    """Event raised when worker reinitialization is needed."""
    
    worker_types: list[str]
    reason: str
    
    def __post_init__(self):
        super().__post_init__()


@dataclass(frozen=True)
class ApplicationRestartRequestedEvent(DomainEvent):
    """Event raised when application restart is required."""
    
    reason: str
    changes: list[str]
    
    def __post_init__(self):
        super().__post_init__()


@dataclass(frozen=True)
class SettingsErrorEvent(DomainEvent):
    """Event raised when a settings operation error occurs."""
    
    error_type: str
    error_message: str
    context: dict[str, Any]
    
    def __post_init__(self):
        super().__post_init__()