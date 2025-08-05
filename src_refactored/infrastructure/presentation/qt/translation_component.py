"""Translation Component for UI text and translation handling.

This module provides translation and text management functionality following the
hexagonal architecture pattern.
"""

import logging

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QMainWindow, QWidget

from src_refactored.domain.ui_coordination.value_objects.ui_state import UIState
from src_refactored.infrastructure.main_window.ui_text_management_service import (
    UITextManagementService,
)
from src_refactored.infrastructure.system.translation_service import TranslationService


class TranslationComponent(QObject):
    """Component for managing UI text and translations.
    
    This component handles dynamic text updates, translation support,
    and recording key display functionality.
    """

    # Signals
    text_updated = pyqtSignal(str, str)  # widget_name, new_text
    translation_changed = pyqtSignal(str)  # new_language

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self.text_service = UITextManagementService()
        self.translation_service = TranslationService()

        # Text mappings
        self.text_mappings: dict[str, str] = {}
        self.widget_references: dict[str, QWidget] = {}

        # Current language
        self.current_language = "en"

        # Recording key display
        self.recording_key = "F2"  # Default

        # Initialize default text mappings
        self._initialize_text_mappings()

    def _initialize_text_mappings(self) -> None:
        """Initialize default text mappings."""
        self.text_mappings = {
            "app_title": "WinSTT - Speech to Text",
            "main_title": "WinSTT",
            "status_ready": "Ready to transcribe",
            "status_recording": "Recording... Press {key} to stop",
            "status_processing": "Processing audio...",
            "status_error": "Error occurred",
            "status_transcribing": "Transcribing...",
            "status_completed": "Transcription completed",
            "button_settings": "Settings",
            "drag_drop_hint": "Drag and drop audio files here",
            "hotkey_hint": "Press {key} to start recording",
            "file_processing": "Processing file: {filename}",
            "download_progress": "Downloading: {progress}%",
            "model_loading": "Loading model...",
            "transcription_saved": "Transcription saved to: {path}",
        }

        self.logger.debug("Default text mappings initialized")

    def setup_translation(self, main_window: QMainWindow,
    ) -> None:
        """Setup translation for the main window.
        
        Args:
            main_window: The main window to setup translation for
        """
        self.logger.info("🌐 Setting up translation system...")

        try:
            # Register main window widgets
            self._register_main_window_widgets(main_window)

            # Load current language settings
            self._load_language_settings()

            # Apply initial translations
            self._apply_translations()

            # Setup recording key display
            self._setup_recording_key_display()

            self.logger.info("✅ Translation system setup complete")

        except Exception as e:
            self.logger.exception(f"Failed to setup translation: {e}")

    def _register_main_window_widgets(self, main_window: QMainWindow,
    ) -> None:
        """Register main window widgets for translation.
        
        Args:
            main_window: The main window
        """
        # Find and register widgets by object name
        widgets_to_register = [
            "title_label",
            "status_label",
            "settings_button",
        ]

        for widget_name in widgets_to_register:
            widget = main_window.findChild(QWidget, widget_name)
            if widget:
                self.widget_references[widget_name] = widget
                self.logger.debug("Registered widget for translation: {widget_name}")

        # Register main window itself
        self.widget_references["main_window"] = main_window

    def _load_language_settings(self) -> None:
        """Load language settings from configuration."""
        try:
            # Load language from translation service
            self.current_language = self.translation_service.get_current_language()
            self.logger.debug("Current language: {self.current_language}")

        except Exception:
            self.logger.warning("Failed to load language settings: {e}")
            self.current_language = "en"  # Fallback to English

    def _apply_translations(self) -> None:
        """Apply translations to registered widgets."""
        # Update main window title
        if "main_window" in self.widget_references:
            title = self.get_text("app_title")
            self.widget_references["main_window"].setWindowTitle(title)

        # Update title label
        if "title_label" in self.widget_references:
            title = self.get_text("main_title")
            self.widget_references["title_label"].setText(title)

        # Update status label
        if "status_label" in self.widget_references:
            status = self.get_text("status_ready")
            self.widget_references["status_label"].setText(status)

        # Update settings button
        if "settings_button" in self.widget_references:
            button_text = self.get_text("button_settings")
            self.widget_references["settings_button"].setText(button_text)

        self.logger.debug("Translations applied to widgets")

    def _setup_recording_key_display(self) -> None:
        """Setup recording key display functionality."""
        try:
            # Load recording key from configuration
            self.recording_key = self.text_service.get_recording_key()

            # Update status text with recording key
            self._update_recording_key_display()

            self.logger.debug("Recording key display setup: {self.recording_key}")

        except Exception:
            self.logger.warning("Failed to setup recording key display: {e}")

    def _update_recording_key_display(self) -> None:
        """Update the recording key display in status text."""
        if "status_label" in self.widget_references:
            hint_text = self.get_text("hotkey_hint").format(key=self.recording_key)
            # Only update if currently showing ready status
            current_text = self.widget_references["status_label"].text()
            if "Ready" in current_text or "Press" in current_text:
                self.widget_references["status_label"].setText(hint_text,
    )

    def get_text(self, key: str, **kwargs) -> str:
        """Get translated text for a given key.
        
        Args:
            key: The text key
            **kwargs: Format arguments for the text
            
        Returns:
            The translated text
        """
        try:
            # Get base text
            base_text = self.text_mappings.get(key, key)

            # Get translation
            translated_text = self.translation_service.translate(
                base_text,
                self.current_language,
            )

            # Apply formatting if kwargs provided
            if kwargs:
                translated_text = translated_text.format(**kwargs)

            return translated_text

        except Exception as e:
            self.logger.exception(f"Failed to get text for key '{key}': {e}",
    )
            return key  # Fallback to key itself

    def update_widget_text(self, widget_name: str, text_key: str, **kwargs) -> None:
        """Update text for a specific widget.
        
        Args:
            widget_name: The widget name
            text_key: The text key
            **kwargs: Format arguments for the text
        """
        if widget_name in self.widget_references:
            widget = self.widget_references[widget_name]
            new_text = self.get_text(text_key, **kwargs)

            # Update widget text based on type
            if hasattr(widget, "setText"):
                widget.setText(new_text)
            elif hasattr(widget, "setWindowTitle"):
                widget.setWindowTitle(new_text)

            # Emit signal
            self.text_updated.emit(widget_name, new_text)

            self.logger.debug("Updated text for {widget_name}: {new_text}")

    def update_status_text(self, text_key: str, **kwargs) -> None:
        """Update the status label text.
        
        Args:
            text_key: The text key
            **kwargs: Format arguments for the text
        """
        self.update_widget_text("status_label", text_key, **kwargs)

    def apply_state_text(self, state: UIState,
    ) -> None:
        """Apply state-specific text updates.
        
        Args:
            state: The UI state to apply
        """
        self.logger.debug("Applying state text: {state.value}")

        if state == UIState.RECORDING:
            self.update_status_text("status_recording", key=self.recording_key)
        elif state == UIState.PROCESSING:
            self.update_status_text("status_processing")
        elif state == UIState.ERROR:
            self.update_status_text("status_error")
        else:  # IDLE
            self.update_status_text("hotkey_hint", key=self.recording_key)

    def set_recording_key(self, key: str,
    ) -> None:
        """Set the recording key for display.
        
        Args:
            key: The recording key
        """
        self.recording_key = key
        self._update_recording_key_display()
        self.logger.debug("Recording key updated: {key}")

    def change_language(self, language_code: str,
    ) -> None:
        """Change the current language.
        
        Args:
            language_code: The language code (e.g., 'en', 'es', 'fr')
        """
        self.logger.info("Changing language to: {language_code}")

        try:
            # Update current language
            self.current_language = language_code

            # Update translation service
            self.translation_service.set_language(language_code)

            # Re-apply translations
            self._apply_translations()

            # Emit signal
            self.translation_changed.emit(language_code)

            self.logger.debug("Language changed to: {language_code}")

        except Exception as e:
            self.logger.exception(f"Failed to change language: {e}")

    def add_text_mapping(self, key: str, text: str,
    ) -> None:
        """Add a new text mapping.
        
        Args:
            key: The text key
            text: The text value
        """
        self.text_mappings[key] = text
        self.logger.debug("Added text mapping: {key} -> {text}")

    def register_widget(self, name: str, widget: QWidget,
    ) -> None:
        """Register a widget for translation.
        
        Args:
            name: The widget name
            widget: The widget instance
        """
        self.widget_references[name] = widget
        self.logger.debug("Registered widget: {name}")

    def unregister_widget(self, name: str,
    ) -> None:
        """Unregister a widget from translation.
        
        Args:
            name: The widget name
        """
        if name in self.widget_references:
            del self.widget_references[name]
            self.logger.debug("Unregistered widget: {name}")

    def get_current_language(self) -> str:
        """Get the current language code.
        
        Returns:
            The current language code
        """
        return self.current_language

    def get_available_languages(self) -> list:
        """Get list of available languages.
        
        Returns:
            List of available language codes
        """
        return self.translation_service.get_available_languages()

    def format_time_duration(self, seconds: float,
    ) -> str:
        """Format time duration for display.
        
        Args:
            seconds: Duration in seconds
            
        Returns:
            Formatted time string
        """
        try:
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = int(seconds % 60)

            if hours > 0:
                return f"{hours:02d}:{minutes:02d}:{secs:02d}"
            return f"{minutes:02d}:{secs:02d}"

        except Exception as e:
            self.logger.exception(f"Failed to format time duration: {e}",
    )
            return "00:00"

    def format_file_size(self, size_bytes: int,
    ) -> str:
        """Format file size for display.
        
        Args:
            size_bytes: Size in bytes
            
        Returns:
            Formatted size string
        """
        try:
            for unit in ["B", "KB", "MB", "GB"]:
                if size_bytes < 1024.0:
                    return f"{size_bytes:.1f} {unit}"
                size_bytes /= 1024.0
            return f"{size_bytes:.1f} TB"

        except Exception as e:
            self.logger.exception(f"Failed to format file size: {e}")
            return "0 B"

    def show_progress_text(self, progress: int, operation: str = "processing") -> None:
        """Show progress text in status label.
        
        Args:
            progress: Progress percentage (0-100)
            operation: The operation being performed
        """
        progress_text = f"{operation.capitalize()}: {progress}%"
        if "status_label" in self.widget_references:
            self.widget_references["status_label"].setText(progress_text,
    )

    def show_file_processing_text(self, filename: str,
    ) -> None:
        """Show file processing text.
        
        Args:
            filename: The filename being processed
        """
        self.update_status_text("file_processing", filename=filename)

    def show_download_progress_text(self, progress: int,
    ) -> None:
        """Show download progress text.
        
        Args:
            progress: Download progress percentage
        """
        self.update_status_text("download_progress", progress=progress)

    def cleanup(self) -> None:
        """Cleanup translation component resources."""
        self.logger.info("Cleaning up translation component")

        # Clear references
        self.widget_references.clear()
        self.text_mappings.clear()

        self.logger.debug("Translation component cleanup complete")