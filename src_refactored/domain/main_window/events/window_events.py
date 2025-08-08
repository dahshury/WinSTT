"""Main Window Domain Events.

This module defines domain events related to main window operations.
"""

from dataclasses import dataclass

from ...common.events import DomainEvent
from ..entities.main_window_instance import WindowGeometry


@dataclass(frozen=True)
class WindowShowRequestedEvent(DomainEvent):
    """Event raised when window show is requested."""
    
    window_id: str
    reason: str | None = None
    restore_geometry: bool = True
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowHideRequestedEvent(DomainEvent):
    """Event raised when window hide is requested."""
    
    window_id: str
    reason: str | None = None
    minimize_to_tray: bool = False
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowShownEvent(DomainEvent):
    """Event raised when window is shown."""
    
    window_id: str
    geometry: WindowGeometry
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowHiddenEvent(DomainEvent):
    """Event raised when window is hidden."""
    
    window_id: str
    was_minimized: bool = False
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowMaximizeRequestedEvent(DomainEvent):
    """Event raised when window maximize is requested."""
    
    window_id: str
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowMinimizeRequestedEvent(DomainEvent):
    """Event raised when window minimize is requested."""
    
    window_id: str
    to_tray: bool = False
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowRestoreRequestedEvent(DomainEvent):
    """Event raised when window restore is requested."""
    
    window_id: str
    from_tray: bool = False
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowGeometryChangedEvent(DomainEvent):
    """Event raised when window geometry changes."""
    
    window_id: str
    new_geometry: WindowGeometry
    previous_geometry: WindowGeometry | None = None
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowTitleChangedEvent(DomainEvent):
    """Event raised when window title changes."""
    
    window_id: str
    new_title: str
    previous_title: str | None = None
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowStateChangedEvent(DomainEvent):
    """Event raised when window state changes."""
    
    window_id: str
    new_state: str  # normal, maximized, minimized, fullscreen
    previous_state: str | None = None
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowCloseRequestedEvent(DomainEvent):
    """Event raised when window close is requested."""
    
    window_id: str
    force_close: bool = False
    save_geometry: bool = True
    
    def __post_init__(self) -> None:
        super().__post_init__()


@dataclass(frozen=True)
class WindowFocusChangedEvent(DomainEvent):
    """Event raised when window focus changes."""
    
    window_id: str
    has_focus: bool
    
    def __post_init__(self) -> None:
        super().__post_init__()
