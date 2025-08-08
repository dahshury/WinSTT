"""UI Text Management Service for text content and localization (Presentation)."""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QWidget


class TextUpdateMode(Enum):
    STATIC = "static"
    DYNAMIC = "dynamic"
    CONDITIONAL = "conditional"
    TEMPLATE = "template"


@dataclass
class TextContent:
    text: str
    mode: TextUpdateMode = TextUpdateMode.STATIC
    template: str | None = None
    condition_func: Callable[[], bool] | None = None
    true_text: str | None = None
    false_text: str | None = None
    placeholder_values: dict[str, Any] | None = None


class UITextManagementError(Exception):
    pass


class UITextManagementService(QObject):
    text_updated = pyqtSignal(str, str)
    translation_changed = pyqtSignal(str)
    template_rendered = pyqtSignal(str, str)
    condition_evaluated = pyqtSignal(str, bool)

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self._text_contents: dict[str, TextContent] = {}
        self._widget_mappings: dict[str, QWidget] = {}
        self._translations: dict[str, dict[str, str]] = {}
        self._current_language = "en"
        self._templates: dict[str, str] = {}
        self._application_state: dict[str, Any] = {}
        self._initialize_default_texts()

    def _initialize_default_texts(self) -> None:
        try:
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
            self.register_text_content("instruction_text", TextContent(
                text="Press {recording_key} to start recording",
                mode=TextUpdateMode.TEMPLATE,
                template="Press {recording_key} to start recording",
                placeholder_values={"recording_key": "F2"},
            ))
        except Exception as e:
            self.logger.exception(f"Failed to initialize default texts: {e}")

    def register_text_content(self, element_name: str, content: TextContent,
    ) -> bool:
        try:
            self._text_contents[element_name] = content
            return True
        except Exception as e:
            self.logger.exception(f"Failed to register text content for '{element_name}': {e}")
            return False

    def register_widget(self, element_name: str, widget: QWidget,
    ) -> bool:
        try:
            if not self._is_text_widget(widget):
                return False
            self._widget_mappings[element_name] = widget
            if element_name in self._text_contents:
                self._update_widget_text(element_name)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to register widget for '{element_name}': {e}")
            return False

    def update_text(self, element_name: str, new_text: str,
    ) -> bool:
        try:
            if element_name not in self._text_contents:
                return False
            self._text_contents[element_name].text = new_text
            if element_name in self._widget_mappings:
                self._update_widget_text(element_name)
            self.text_updated.emit(element_name, new_text)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to update text for '{element_name}': {e}")
            return False

    def update_template_values(self, element_name: str, values: dict[str, Any]) -> bool:
        try:
            if element_name not in self._text_contents:
                return False
            content = self._text_contents[element_name]
            if content.mode != TextUpdateMode.TEMPLATE:
                return False
            if content.placeholder_values is None:
                content.placeholder_values = {}
            content.placeholder_values.update(values)
            self._render_template(element_name)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to update template values for '{element_name}': {e}")
            return False

    def set_language(self, language: str,
    ) -> bool:
        try:
            self._current_language = language
            self._update_translated_texts()
            self.translation_changed.emit(language)
            return True
        except Exception as e:
            self.logger.exception(f"Failed to set language to '{language}': {e}")
            return False

    def add_translation(self, language: str, translations: dict[str, str]) -> bool:
        try:
            self._translations.setdefault(language, {}).update(translations)
            if language == self._current_language:
                self._update_translated_texts()
            return True
        except Exception as e:
            self.logger.exception(f"Failed to add translations for '{language}': {e}")
            return False

    def get_text(self, element_name: str,
    ) -> str | None:
        if element_name not in self._text_contents:
            return None
        content = self._text_contents[element_name]
        if content.mode == TextUpdateMode.TEMPLATE:
            return self._render_template_text(content)
        if content.mode == TextUpdateMode.CONDITIONAL:
            return self._evaluate_conditional_text(content)
        return self._get_translated_text(content.text)

    def refresh_all_texts(self) -> None:
        try:
            for element_name in self._text_contents:
                if element_name in self._widget_mappings:
                    self._update_widget_text(element_name)
        except Exception as e:
            self.logger.exception(f"Failed to refresh all texts: {e}")

    def _update_widget_text(self, element_name: str,
    ) -> None:
        try:
            if element_name not in self._widget_mappings:
                return
            widget = self._widget_mappings[element_name]
            text = self.get_text(element_name)
            if text is not None:
                self._set_widget_text(widget, text)
        except Exception as e:
            self.logger.exception(f"Failed to update widget text for '{element_name}': {e}")

    def _update_translated_texts(self) -> None:
        try:
            for element_name in self._text_contents:
                if element_name in self._widget_mappings:
                    self._update_widget_text(element_name)
        except Exception as e:
            self.logger.exception(f"Failed to update translated texts: {e}")

    def _render_template(self, element_name: str,
    ) -> None:
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
        try:
            if not content.template or not content.placeholder_values:
                return content.text
            return content.template.format(**content.placeholder_values)
        except Exception:
            return content.text

    def _evaluate_conditional_text(self, content: TextContent,
    ) -> str:
        try:
            if not content.condition_func:
                return content.text
            condition_result = content.condition_func()
            text = content.true_text if condition_result else content.false_text
            element_name = next((name for name, c in self._text_contents.items() if c == content), "unknown")
            self.condition_evaluated.emit(element_name, condition_result)
            return text or content.text
        except Exception:
            return content.text

    def _get_translated_text(self, text: str,
    ) -> str:
        return self._translations.get(self._current_language, {}).get(text, text)

    def _is_text_widget(self, widget: QWidget,
    ) -> bool:
        return hasattr(widget, "setText") or hasattr(widget, "setWindowTitle")

    def _set_widget_text(self, widget: QWidget, text: str,
    ) -> None:
        try:
            set_text_method = getattr(widget, "setText", None)
            if set_text_method and callable(set_text_method):
                set_text_method(text)
            else:
                set_title_method = getattr(widget, "setWindowTitle", None)
                if set_title_method and callable(set_title_method):
                    set_title_method(text)
        except Exception as e:
            self.logger.exception(f"Failed to set widget text: {e}")

