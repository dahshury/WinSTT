"""UI Text Value Objects.

This module defines value objects for UI text updates including
results, phases, and text types.
"""

from enum import Enum


class UpdateResult(Enum):
    """Results for UI text update operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    TRANSLATION_ERROR = "translation_error"
    FORMATTING_ERROR = "formatting_error"
    ENCODING_ERROR = "encoding_error"
    CANCELLED = "cancelled"


class UpdatePhase(Enum):
    """Phases of UI text update process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    TEXT_PREPARATION = "text_preparation"
    TRANSLATION = "translation"
    FORMATTING = "formatting"
    WIDGET_UPDATE = "widget_update"
    VALIDATION_POST = "validation_post"
    FINALIZATION = "finalization"


class TextType(Enum):
    """Types of UI text content."""
    LABEL = "label"
    BUTTON = "button"
    TOOLTIP = "tooltip"
    STATUS = "status"
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"
    PLACEHOLDER = "placeholder"
    TITLE = "title"
    DESCRIPTION = "description"