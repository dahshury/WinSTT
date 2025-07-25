"""
UI Domain Layer

This package contains domain models, value objects, and business logic
specific to the UI layer, following Domain-Driven Design principles.
"""

from .models import *
from .services import *
from .value_objects import *

__all__ = [
    "ApplicationSettings",
    "AudioConfiguration",
    "ComponentState",
    "ISettingsManager",
    "ITranscriptionManager",
    # Services
    "IWindowManager",
    "KeyCombination",
    "ModelConfiguration",
    "SettingsManager",
    "StyleConfiguration",
    "TranscriptionManager",
    "TranscriptionSession",
    # Value Objects
    "WindowDimensions",
    "WindowManager",
    # Models
    "WindowState",
] 