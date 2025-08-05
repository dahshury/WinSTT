"""UI Text Management Service for text content and localization.

This module provides infrastructure services for managing text content,
translations, and dynamic text updates for UI elements in the main window.
"""

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QWidget

from logger import setup_logger


class TextUpdateMode(Enum):
    """Text update modes for dynamic content."""
    STATIC = "static"  # Static text that doesn't change
    DYNAMIC = "dynamic"  # Dynamic text based on application state
    CONDITIONAL = "conditional"  # Text that changes based on conditions
    TEMPLATE = "template"  # Template-based text with placeholders


@dataclass
class TextContent:
    """Text content configuration."""
    text: str
    mode: TextUpdateMode = TextUpdateMode.STATIC
    template: str | None = None
    condition_func: Callable[[], bool] | None = None
    true_text: str | None = None
    false_text: str | None = None
    placeholder_values: dict[str, Any] | None = None


class UITextManagementError(Exception):
    """Exception raised for UI text management errors."""


class UITextManagementService(QObject):
    """Service for managing UI text content and localization."""

    # Signals
    text_updated = pyqtSignal(str, str)  # element_name, new_text
    translation_changed = pyqtSignal(str)  # new_language
    template_rendered = pyqtSignal(str, str)  # template_name, rendered_text
    condition_evaluated = pyqtSignal(str, bool)  # element_name, condition_result

    def __init__(self):
        """Initialize the UI text management service."""
        super().__init__()
        self.logger = setup_logger()

        # Text content storage
        self._text_contents: dict[str, TextContent] = {}
        self._widget_mappings: dict[str, QWidget] = {}

        # Translation storage
        self._translations: dict[str, dict[str, str]] = {}  # language -> {key: text}
        self._current_language = "en"  # Default language

        # Template storage
        self._templates: dict[str, str] = {}

        # State tracking for dynamic updates
        self._application_state: dict[str, Any] = {}

        # Initialize default text contents
        self._initialize_default_texts()

    def _initialize_default_texts(self) -> None:
        """Initialize default text contents for common UI elements."""
        try:
            # Static texts
            self.register_text_content("window_title", TextContent(
                text="WinSTT - Windows Speech to Text",
                mode=TextUpdateMode.STATIC,
            ))

            self.register_text_content("app_title", TextContent(
                text="WinSTT",
                mode=TextUpdateMode.STATIC,
            ))

            self.register_text_content("status_ready", TextContent(
                text="Ready",
                mode=TextUpdateMode.STATIC,
            ))

            # Dynamic instruction text based on recording key and model status
            self.register_text_content("instruction_text", TextContent(
                text="Press {recording_key} to start recording",
                mode=TextUpdateMode.TEMPLATE,
                template="Press {recording_key} to start recording",
                placeholder_values={"recording_key": "F2"},
            ))

            # Conditional text for model download status
            self.register_text_content("model_status", TextContent(
                text="Model ready",
                mode=TextUpdateMode.CONDITIONAL,
                condition_func=lambda: self._application_state.get("model_downloaded", False)
                true_text="Model ready",
                false_text="Downloading model...",
            ))

            # Progress bar text
            self.register_text_content("progress_text", TextContent(
                text="Progress: {progress}%",
                mode=TextUpdateMode.TEMPLATE,
                template="Progress: {progress}%",
                placeholder_values={"progress": 0},
            ))

            self.logger.debug("Default text contents initialized")

        except Exception as e:
            self.logger.exception(f"Failed to initialize default texts: {e}")

    def register_text_content(self, element_name: str, content: TextContent,
    ) -> bool:
        """Register text content for a UI element.
        
        Args:
            element_name: Unique name for the UI element
            content: TextContent configuration
            
        Returns:
            True if registration successful, False otherwise
        """
        try:
            if element_name in self._text_contents:
                self.logger.warning("Text content '{element_name}' already exists, overwriting")

            self._text_contents[element_name] = content
            self.logger.debug("Registered text content for '{element_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to register text content for '{element_name}': {e}")
            return False

    def register_widget(self, element_name: str, widget: QWidget,
    ) -> bool:
        """Register a widget for text management.
        
        Args:
            element_name: Name of the UI element
            widget: Widget to manage
            
        Returns:
            True if registration successful, False otherwise
        """
        try:
            if not self._is_text_widget(widget):
                self.logger.error("Widget for '{element_name}' does not support text")
                return False

            self._widget_mappings[element_name] = widget

            # Apply initial text if content exists
            if element_name in self._text_contents:
                self._update_widget_text(element_name)

            self.logger.debug("Registered widget for '{element_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to register widget for '{element_name}': {e}")
            return False

    def update_text(self, element_name: str, new_text: str,
    ) -> bool:
        """Update text for a UI element.
        
        Args:
            element_name: Name of the UI element
            new_text: New text content
            
        Returns:
            True if update successful, False otherwise
        """
        try:
            if element_name not in self._text_contents:
                self.logger.error("Text content '{element_name}' not found")
                return False

            # Update the text content
            self._text_contents[element_name].text = new_text

            # Update widget if registered
            if element_name in self._widget_mappings:
                self._update_widget_text(element_name)

            self.text_updated.emit(element_name, new_text)
            self.logger.debug("Updated text for '{element_name}': {new_text}")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to update text for '{element_name}': {e}")
            return False

    def update_template_values(self, element_name: str, values: dict[str, Any]) -> bool:
        """Update template placeholder values for a UI element.
        
        Args:
            element_name: Name of the UI element
            values: Dictionary of placeholder values
            
        Returns:
            True if update successful, False otherwise
        """
        try:
            if element_name not in self._text_contents:
                self.logger.error("Text content '{element_name}' not found")
                return False

            content = self._text_contents[element_name]

            if content.mode != TextUpdateMode.TEMPLATE:
                self.logger.error("Element '{element_name}' is not in template mode")
                return False

            # Update placeholder values
            if content.placeholder_values is None:
                content.placeholder_values = {}

            content.placeholder_values.update(values)

            # Re-render template
            self._render_template(element_name)

            return True

        except Exception as e:
            self.logger.exception(f"Failed to update template values for '{element_name}': {e}")
            return False

    def update_application_state(self, state_key: str, value: Any,
    ) -> None:
        """Update application state for dynamic text updates.
        
        Args:
            state_key: State key
            value: State value
        """
        try:
            self._application_state[state_key] = value

            # Update all conditional and dynamic texts
            self._update_dynamic_texts()

            self.logger.debug("Updated application state: {state_key} = {value}")

        except Exception as e:
            self.logger.exception(f"Failed to update application state: {e}")

    def set_language(self, language: str,
    ) -> bool:
        """Set current language for translations.
        
        Args:
            language: Language code (e.g., 'en', 'es', 'fr')
            
        Returns:
            True if language set successfully, False otherwise
        """
        try:
            if language not in self._translations:
                self.logger.warning("No translations found for language '{language}'")

            self._current_language = language

            # Update all translated texts
            self._update_translated_texts()

            self.translation_changed.emit(language)
            self.logger.debug("Language set to '{language}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to set language to '{language}': {e}")
            return False

    def add_translation(self, language: str, translations: dict[str, str]) -> bool:
        """Add translations for a language.
        
        Args:
            language: Language code
            translations: Dictionary of translation keys to text
            
        Returns:
            True if translations added successfully, False otherwise
        """
        try:
            if language not in self._translations:
                self._translations[language] = {}

            self._translations[language].update(translations)

            # Update texts if this is the current language
            if language == self._current_language:
                self._update_translated_texts()

            self.logger.debug("Added {len(translations)} translations for '{language}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to add translations for '{language}': {e}")
            return False

    def get_text(self, element_name: str,
    ) -> str | None:
        """Get current text for a UI element.
        
        Args:
            element_name: Name of the UI element
            
        Returns:
            Current text or None if element not found
        """
        if element_name not in self._text_contents:
            return None

        content = self._text_contents[element_name]

        if content.mode == TextUpdateMode.TEMPLATE:
            return self._render_template_text(content)
        if content.mode == TextUpdateMode.CONDITIONAL:
            return self._evaluate_conditional_text(content)
        return self._get_translated_text(content.text)

    def get_translated_text(self, key: str, language: str | None = None) -> str:
        """Get translated text for a key.
        
        Args:
            key: Translation key
            language: Language code (uses current language if None)
            
        Returns:
            Translated text or original key if translation not found
        """
        language = language or self._current_language

        if language in self._translations and key in self._translations[language]:
            return self._translations[language][key]

        return key  # Return key as fallback

    def refresh_all_texts(self) -> None:
        """Refresh all text contents and update widgets."""
        try:
            for element_name in self._text_contents:
                if element_name in self._widget_mappings:
                    self._update_widget_text(element_name)

            self.logger.debug("Refreshed all text contents")

        except Exception as e:
            self.logger.exception(f"Failed to refresh all texts: {e}")

    def _update_widget_text(self, element_name: str,
    ) -> None:
        """Update widget text for an element.
        
        Args:
            element_name: Name of the UI element
        """
        try:
            if element_name not in self._widget_mappings:
                return

            widget = self._widget_mappings[element_name]
            text = self.get_text(element_name)

            if text is not None:
                self._set_widget_text(widget, text)

        except Exception as e:
            self.logger.exception(f"Failed to update widget text for '{element_name}': {e}")

    def _update_dynamic_texts(self) -> None:
        """Update all dynamic and conditional texts."""
        try:
            for element_name, content in self._text_contents.items():
                if content.mode in [TextUpdateMode.DYNAMIC, TextUpdateMode.CONDITIONAL]:
                    if element_name in self._widget_mappings:
                        self._update_widget_text(element_name)

        except Exception as e:
            self.logger.exception(f"Failed to update dynamic texts: {e}")

    def _update_translated_texts(self) -> None:
        """Update all translated texts."""
        try:
            for element_name in self._text_contents:
                if element_name in self._widget_mappings:
                    self._update_widget_text(element_name)

        except Exception as e:
            self.logger.exception(f"Failed to update translated texts: {e}")

    def _render_template(self, element_name: str,
    ) -> None:
        """Render template for an element.
        
        Args:
            element_name: Name of the UI element
        """
        try:
            if element_name not in self._text_contents:
                return

            content = self._text_contents[element_name]
            rendered_text = self._render_template_text(content)

            if rendered_text:
                content.text = rendered_text

                if element_name in self._widget_mappings:
                    self._update_widget_text(element_name)

                self.template_rendered.emit(element_name, rendered_text)

        except Exception as e:
            self.logger.exception(f"Failed to render template for '{element_name}': {e}")

    def _render_template_text(self, content: TextContent,
    ) -> str | None:
        """Render template text with placeholder values.
        
        Args:
            content: TextContent with template
            
        Returns:
            Rendered text or None if rendering failed
        """
        try:
            if not content.template or not content.placeholder_values:
                return content.text

            return content.template.format(**content.placeholder_values)

        except Exception as e:
            self.logger.exception(f"Failed to render template text: {e}")
            return content.text

    def _evaluate_conditional_text(self, content: TextContent,
    ) -> str:
        """Evaluate conditional text based on condition function.
        
        Args:
            content: TextContent with condition
            
        Returns:
            Appropriate text based on condition
        """
        try:
            if not content.condition_func:
                return content.text

            condition_result = content.condition_func()
            text = content.true_text if condition_result else content.false_text

            # Emit condition evaluation signal
element_name = (
    next((name for name, c in self._text_contents.items() if c == content), "unknown"))
            self.condition_evaluated.emit(element_name, condition_result)

            return text or content.text

        except Exception as e:
            self.logger.exception(f"Failed to evaluate conditional text: {e}")
            return content.text

    def _get_translated_text(self, text: str,
    ) -> str:
        """Get translated version of text.

        Args:
            text: Original text

        Returns:
            Translated text or original if translation not found
        """
        return self.get_translated_text(text)

    def _is_text_widget(self, widget: QWidget,
    ) -> bool:
        """Check if widget supports text.

        Args:
            widget: Widget to check

        Returns:
            True if widget supports text, False otherwise
        """
        return hasattr(widget, "setText") or hasattr(widget, "setWindowTitle")

    def _set_widget_text(self, widget: QWidget, text: str,
    ) -> None:
        """Set text on a widget.

        Args:
            widget: Widget to update
            text: Text to set
        """
        try:
            if hasattr(widget, "setText"):
                widget.setText(text)
            elif hasattr(widget, "setWindowTitle"):
                widget.setWindowTitle(text)
            else:
                self.logger.warning("Widget does not support text setting: {type(widget)}")

        except Exception as e:
            self.logger.exception(f"Failed to set widget text: {e}")

    def get_all_text_contents(self) -> dict[str, TextContent]:
        """Get all text contents.

        Returns:
            Dictionary of element names to TextContent objects
        """
        return self._text_contents.copy()

    def get_all_widgets(self) -> dict[str, QWidget]:
        """Get all registered widgets.

        Returns:
            Dictionary of element names to QWidget objects
        """
        return self._widget_mappings.copy()

    def remove_text_content(self, element_name: str,
    ) -> bool:
        """Remove text content for an element.

        Args:
            element_name: Name of the UI element

        Returns:
            True if removed successfully, False if not found
        """
        try:
            if element_name not in self._text_contents:
                return False

            del self._text_contents[element_name]

            if element_name in self._widget_mappings:
                del self._widget_mappings[element_name]

            self.logger.debug("Removed text content for '{element_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to remove text content for '{element_name}': {e}")
            return False

    def cleanup(self) -> None:
        """Clean up text management resources."""
        try:
            self._text_contents.clear()
            self._widget_mappings.clear()
            self._translations.clear()
            self._templates.clear()
            self._application_state.clear()

            self.logger.debug("UI text management service cleaned up")

        except Exception as e:
            self.logger.exception(f"Failed to cleanup UI text management service: {e}")


class UITextManagementManager:
    """High-level manager for UI text management operations."""

    def __init__(self):
        self._service: UITextManagementService | None = None

    def create_text_service(self) -> UITextManagementService:
        """Create and return UI text management service.

        Returns:
            UITextManagementService instance
        """
        self._service = UITextManagementService()
        return self._service

    def get_service(self) -> UITextManagementService | None:
        """Get current UI text management service.

        Returns:
            Current UITextManagementService or None if not created
        """
        return self._service

    def setup_main_window_texts(self, widgets: dict[str, QWidget]) -> bool:
        """Setup text management for main window widgets.

        Args:
            widgets: Dictionary mapping element names to widgets

        Returns:
            True if setup successful, False otherwise

        Raises:
            UITextManagementError: If service not created
        """
        if not self._service:
            msg = "UI text management service not created"
            raise UITextManagementError(msg,
    )

        try:
            for element_name, widget in widgets.items():
                self._service.register_widget(element_name, widget)

            return True

        except Exception as e:
            msg = f"Failed to setup main window texts: {e}"
            raise UITextManagementError(msg,
    )

    def load_translations(self, translations: dict[str, dict[str, str]]) -> bool:
        """Load translations for multiple languages.

        Args:
            translations: Dictionary mapping language codes to translation dictionaries

        Returns:
            True if loading successful, False otherwise

        Raises:
            UITextManagementError: If service not created
        """
        if not self._service:
            msg = "UI text management service not created"
            raise UITextManagementError(msg,
    )

        try:
            for language, translation_dict in translations.items():
                self._service.add_translation(language, translation_dict)

            return True

        except Exception as e:
            msg = f"Failed to load translations: {e}"
            raise UITextManagementError(msg,
    )

    def update_recording_key(self, recording_key: str,
    ) -> bool:
        """Update recording key in instruction text.

        Args:
            recording_key: New recording key

        Returns:
            True if update successful, False otherwise

        Raises:
            UITextManagementError: If service not created
        """
        if not self._service:
            msg = "UI text management service not created"
            raise UITextManagementError(msg,
    )

        return self._service.update_template_values("instruction_text", {"recording_key": recording_key})

    def update_model_status(self, is_downloaded: bool,
    ) -> None:
        """Update model download status.

        Args:
            is_downloaded: Whether model is downloaded

        Raises:
            UITextManagementError: If service not created
        """
        if not self._service:
            msg = "UI text management service not created"
            raise UITextManagementError(msg,
    )

        self._service.update_application_state("model_downloaded", is_downloaded)

    def cleanup(self) -> None:
        """Clean up UI text management manager."""
        if self._service:
            self._service.cleanup()
            self._service = None