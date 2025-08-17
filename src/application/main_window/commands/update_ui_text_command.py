"""Update UI Text Command.

This module implements the command for updating UI text content,
separated from query operations following CQRS pattern.
"""

from collections.abc import Callable
from dataclasses import dataclass

from src.application.main_window.update_ui_text_use_case import (
    FormattingConfiguration,
    TextContent,
    TranslationConfiguration,
    ValidationConfiguration,
    WidgetTextTarget,
)
from src.domain.common.abstractions import ICommand


@dataclass
class UpdateUITextCommand(ICommand):
    """Command for updating UI text content.
    
    This command encapsulates the intent to update UI text without
    mixing concerns with query operations or direct UI manipulation.
    """
    operation_id: str
    text_updates: list[TextContent]
    target_widgets: list[WidgetTextTarget]
    translation_config: TranslationConfiguration | None = None
    formatting_config: FormattingConfiguration | None = None
    validation_config: ValidationConfiguration | None = None
    batch_mode: bool = False
    progress_callback: Callable[[str, float], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None

    def __post_init__(self):
        """Validate command data."""
        if not self.operation_id:
            msg = "Operation ID is required"
            raise ValueError(msg)
        if not self.text_updates:
            msg = "Text updates are required"
            raise ValueError(msg)
        if not self.target_widgets:
            msg = "Target widgets are required"
            raise ValueError(msg)