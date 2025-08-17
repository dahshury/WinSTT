"""Update UI Text Use Case.

This module implements the UpdateUITextUseCase for dynamic UI text updates
with translation support and comprehensive validation.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from src.domain.ui_text import (
    TextType,
    UpdatePhase,
    UpdateResult,
)


class TranslationMode(Enum):
    """Translation modes for text updates."""
    NONE = "none"
    AUTO = "auto"
    MANUAL = "manual"
    CACHED = "cached"
    FALLBACK = "fallback"


class FormattingType(Enum):
    """Text formatting types."""
    PLAIN = "plain"
    HTML = "html"
    MARKDOWN = "markdown"
    RICH_TEXT = "rich_text"
    CUSTOM = "custom"


class ValidationLevel(Enum):
    """Validation levels for text content."""
    NONE = "none"
    BASIC = "basic"
    STRICT = "strict"
    CUSTOM = "custom"


@dataclass
class TextContent:
    """Text content configuration."""
    text_id: str
    content: str
    text_type: TextType
    formatting_type: FormattingType
    encoding: str = "utf-8"
    max_length: int | None = None
    allow_html: bool = False
    custom_properties: dict[str, Any] | None = None


@dataclass
class TranslationConfiguration:
    """Configuration for text translation."""
    mode: TranslationMode
    source_language: str
    target_language: str
    use_cache: bool = True
    fallback_text: str | None = None
    translation_context: str | None = None
    custom_translations: dict[str, str] | None = None


@dataclass
class FormattingConfiguration:
    """Configuration for text formatting."""
    formatting_type: FormattingType
    preserve_whitespace: bool = False
    auto_escape: bool = True
    custom_formatters: dict[str, Callable] | None = None
    style_properties: dict[str, Any] | None = None


@dataclass
class WidgetTextTarget:
    """Target widget for text updates."""
    widget_id: str
    widget_type: str
    text_property: str
    current_text: str | None = None
    priority: int = 0
    constraints: dict[str, Any] | None = None


@dataclass
class ValidationConfiguration:
    """Configuration for text validation."""
    validation_level: ValidationLevel
    check_encoding: bool = True
    check_length: bool = True
    check_content: bool = True
    custom_validators: list[Callable] | None = None
    validation_rules: dict[str, Any] | None = None


@dataclass
class UpdateUITextRequest:
    """Request for updating UI text."""
    operation_id: str
    text_updates: list[TextContent]
    target_widgets: list[WidgetTextTarget]
    translation_config: TranslationConfiguration | None = None
    formatting_config: FormattingConfiguration | None = None
    validation_config: ValidationConfiguration | None = None
    batch_mode: bool = False
    progress_callback: Callable[[str, float], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None


@dataclass
class TextUpdate:
    """Result of a text update operation."""
    text_id: str
    widget_id: str
    update_successful: bool
    original_text: str | None
    new_text: str
    translation_applied: bool = False
    formatting_applied: bool = False
    validation_passed: bool = True
    error_message: str | None = None


@dataclass
class TranslationResult:
    """Result of text translation."""
    text_id: str
    original_text: str
    translated_text: str
    source_language: str
    target_language: str
    translation_successful: bool
    cache_used: bool = False
    error_message: str | None = None


@dataclass
class FormattingResult:
    """Result of text formatting."""
    text_id: str
    original_text: str
    formatted_text: str
    formatting_type: FormattingType
    formatting_successful: bool
    error_message: str | None = None


@dataclass
class UITextUpdateState:
    """Current state of UI text update process."""
    current_phase: UpdatePhase
    processed_texts: dict[str, TextUpdate]
    translation_results: dict[str, TranslationResult]
    formatting_results: dict[str, FormattingResult]
    total_updates: int
    completed_updates: int
    errors: list[str]
    warnings: list[str]


@dataclass
class UpdateUITextResponse:
    """Response from UI text update operation."""
    result: UpdateResult
    operation_id: str
    text_updates: list[TextUpdate]
    translation_results: list[TranslationResult]
    formatting_results: list[FormattingResult]
    state: UITextUpdateState
    execution_time_ms: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)


class TextValidationServiceProtocol(Protocol):
    """Protocol for text validation operations."""

    def validate_text_content(self, content: TextContent, config: ValidationConfiguration,
    ) -> bool:
        """Validate text content."""
        ...

    def validate_encoding(self, text: str, encoding: str,
    ) -> bool:
        """Validate text encoding."""
        ...

    def validate_length(self, text: str, max_length: int | None) -> bool:
        """Validate text length."""
        ...

    def sanitize_text(self, text: str, allow_html: bool,
    ) -> str:
        """Sanitize text content."""
        ...


class TranslationServiceProtocol(Protocol):
    """Protocol for text translation operations."""

    def translate_text(self, text: str, config: TranslationConfiguration,
    ) -> TranslationResult:
        """Translate text content."""
        ...

    def get_cached_translation(self, text: str, source_lang: str, target_lang: str,
    ) -> str | None:
        """Get cached translation."""
        ...

    def cache_translation(self, text: str, translation: str, source_lang: str, target_lang: str,
    ) -> None:
        """Cache translation result."""
        ...

    def detect_language(self, text: str,
    ) -> str:
        """Detect text language."""
        ...


class TextFormattingServiceProtocol(Protocol):
    """Protocol for text formatting operations."""

    def format_text(self, text: str, config: FormattingConfiguration,
    ) -> FormattingResult:
        """Format text content."""
        ...

    def convert_to_html(self, text: str,
    ) -> str:
        """Convert text to HTML."""
        ...

    def convert_to_plain(self, text: str,
    ) -> str:
        """Convert text to plain text."""
        ...

    def apply_custom_formatting(self, text: str, formatter: Callable,
    ) -> str:
        """Apply custom formatting."""
        ...


class WidgetTextServiceProtocol(Protocol):
    """Protocol for widget text operations."""

    def update_widget_text(self, widget_id: str, text_property: str, text: str,
    ) -> bool:
        """Update widget text property."""
        ...

    def get_widget_text(self, widget_id: str, text_property: str,
    ) -> str | None:
        """Get current widget text."""
        ...

    def validate_widget_text_property(self, widget_id: str, text_property: str,
    ) -> bool:
        """Validate widget text property exists."""
        ...

    def get_widget_text_constraints(self, widget_id: str, text_property: str,
    ) -> dict[str, Any]:
        """Get widget text constraints."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress(self, operation_id: str, total_steps: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation_id: str, current_step: int, message: str,
    ) -> None:
        """Update progress."""
        ...

    def complete_progress(self, operation_id: str,
    ) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, error: Exception | None = None, **kwargs) -> None:
        """Log error message."""
        ...


class UpdateUITextUseCase:
    """Use case for dynamic UI text updates with translation support.
    
    This use case handles:
    - Text content validation and sanitization
    - Multi-language translation with caching
    - Text formatting and conversion
    - Widget text property updates
    - Batch processing and progress tracking
    - Comprehensive error handling and recovery
    """

    def __init__(
        self,
        text_validation_service: TextValidationServiceProtocol,
        translation_service: TranslationServiceProtocol,
        text_formatting_service: TextFormattingServiceProtocol,
        widget_text_service: WidgetTextServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._text_validation = text_validation_service
        self._translation = translation_service
        self._text_formatting = text_formatting_service
        self._widget_text = widget_text_service
        self._progress_tracking = progress_tracking_service
        self._logger = logger_service

    def execute(self, request: UpdateUITextRequest,
    ) -> UpdateUITextResponse:
        """Execute UI text update operation.
        
        Args:
            request: The UI text update request
            
        Returns:
            UpdateUITextResponse: The operation result
        """
        import time
        start_time = time.time()

        # Initialize state
        state = UITextUpdateState(
            current_phase=UpdatePhase.INITIALIZATION,
            processed_texts={},
            translation_results={},
            formatting_results={},
            total_updates=len(request.text_updates),
            completed_updates=0,
            errors=[],
            warnings=[],
        )

        text_updates: list[TextUpdate] = []
        translation_results: list[TranslationResult] = []
        formatting_results: list[FormattingResult] = []

        try:
            self._logger.log_info(
                f"Starting UI text update for operation {request.operation_id}",
                operation_id=request.operation_id,
                text_count=len(request.text_updates),
                widget_count=len(request.target_widgets),
            )

            # Start progress tracking
            total_steps = 7  # Number of main phases
            self._progress_tracking.start_progress(request.operation_id, total_steps)

            # Phase 1: Validation
            state.current_phase = UpdatePhase.VALIDATION
            self._progress_tracking.update_progress(request.operation_id, 1, "Validating text content and widgets")

            validation_result = self._validate_request(request, state)
            if not validation_result:
                return self._create_error_response(
                    request.operation_id, UpdateResult.VALIDATION_ERROR,
                    "Validation failed", state, text_updates, translation_results,
                    formatting_results, time.time() - start_time,
                )

            # Phase 2: Text Preparation
            state.current_phase = UpdatePhase.TEXT_PREPARATION
            self._progress_tracking.update_progress(request.operation_id, 2, "Preparing text content")

            preparation_result = self._prepare_text_content(request, state)
            if not preparation_result:
                return self._create_error_response(
                    request.operation_id, UpdateResult.FORMATTING_ERROR,
                    "Text preparation failed", state, text_updates, translation_results,
                    formatting_results, time.time() - start_time,
                )

            # Phase 3: Translation
            state.current_phase = UpdatePhase.TRANSLATION
            self._progress_tracking.update_progress(request.operation_id, 3, "Processing translations")

            if request.translation_config and request.translation_config.mode != TranslationMode.NONE:
                translated = self._process_translations(request, state)
                if translated is not None:
                    translation_results = translated

            # Phase 4: Formatting
            state.current_phase = UpdatePhase.FORMATTING
            self._progress_tracking.update_progress(request.operation_id, 4, "Applying text formatting")

            if request.formatting_config:
                formatting_results = self._apply_formatting(request, state)

            # Phase 5: Widget Updates
            state.current_phase = UpdatePhase.WIDGET_UPDATE
            self._progress_tracking.update_progress(request.operation_id, 5, "Updating widget text")

            text_updates = self._update_widget_text(request, state)

            # Phase 6: Post-validation
            state.current_phase = UpdatePhase.VALIDATION_POST
            self._progress_tracking.update_progress(request.operation_id, 6, "Validating updates")

            post_validation_result = self._validate_updates(request, state, text_updates)
            if not post_validation_result:
                state.warnings.append("Some text updates failed post-validation")

            # Phase 7: Finalization
            state.current_phase = UpdatePhase.FINALIZATION
            self._progress_tracking.update_progress(request.operation_id, 7, "Finalizing text updates")

            self._finalize_updates(request, state)

            # Complete progress tracking
            self._progress_tracking.complete_progress(request.operation_id)

            execution_time = (time.time() - start_time) * 1000

            self._logger.log_info(
                "UI text update completed successfully",
                operation_id=request.operation_id,
                execution_time_ms=execution_time,
                updates_count=len(text_updates),
                translations_count=len(translation_results),
                formatting_count=len(formatting_results),
            )

            return UpdateUITextResponse(
                result=UpdateResult.SUCCESS,
                operation_id=request.operation_id,
                text_updates=text_updates,
                translation_results=translation_results,
                formatting_results=formatting_results,
                state=state,
                execution_time_ms=execution_time,
                warnings=state.warnings,
            )

        except Exception as e:
            self._logger.log_error(
                f"UI text update failed for operation {request.operation_id}",
                error=e,
                operation_id=request.operation_id,
            )

            return self._create_error_response(
                request.operation_id, UpdateResult.FAILED,
                str(e), state, text_updates, translation_results,
                formatting_results, (time.time() - start_time) * 1000,
            )

    def _validate_request(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> bool:
        """Validate the UI text update request."""
        try:
            # Validate text content
            for text_content in request.text_updates:
                if not text_content.content:
                    state.errors.append(f"Empty text content for ID: {text_content.text_id}")
                    return False

                # Validate encoding
                try:
                    text_content.content.encode(text_content.encoding)
                except UnicodeEncodeError:
                    state.errors.append(f"Invalid encoding {text_content.encoding} for text ID: {text_content.text_id}")
                    return False

                # Validate length
                if text_content.max_length and len(text_content.content) > text_content.max_length:
                    state.errors.append(f"Text too long for ID {text_content.text_id}: {len(text_content.content)} > {text_content.max_length}")
                    return False

            # Validate target widgets
            for target in request.target_widgets:
                if not self._widget_text.validate_widget_text_property(target.widget_id, target.text_property):
                    state.errors.append(f"Invalid text property {target.text_property} for widget {target.widget_id}")
                    return False

            # Validate translation configuration
            if request.translation_config:
                if not request.translation_config.source_language or not request.translation_config.target_language:
                    state.errors.append("Translation configuration missing source or target language")
                    return False

            return True

        except Exception as e:
            self._logger.log_error("Request validation failed", error=e)
            state.errors.append(f"Validation error: {e!s}")
            return False

    def _prepare_text_content(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> bool:
        """Prepare text content for processing."""
        try:
            for text_content in request.text_updates:
                # Sanitize text if needed
                if request.validation_config:
                    sanitized_text = self._text_validation.sanitize_text(
                        text_content.content,
                        text_content.allow_html,
                    )
                    text_content.content = sanitized_text

                # Validate content
                if request.validation_config:
                    is_valid = self._text_validation.validate_text_content(
                        text_content,
                        request.validation_config,
                    )
                    if not is_valid:
                        state.warnings.append(f"Text content validation failed for ID: {text_content.text_id}")

            return True

        except Exception as e:
            self._logger.log_error("Text preparation failed", error=e)
            state.errors.append(f"Text preparation error: {e!s}")
            return False

    def _process_translations(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> list[TranslationResult] | None:
        """Process text translations."""
        translation_results: list[TranslationResult] = []

        if not request.translation_config:
            return translation_results

        for text_content in request.text_updates:
            try:
                # Check cache first if enabled
                cached_translation = None
                if request.translation_config.use_cache:
                    cached_translation = self._translation.get_cached_translation(
                        text_content.content,
                        request.translation_config.source_language,
                        request.translation_config.target_language,
                    )

                if cached_translation:
                    # Use cached translation
                    translation_result = TranslationResult(
                        text_id=text_content.text_id,
                        original_text=text_content.content,
                        translated_text=cached_translation,
                        source_language=request.translation_config.source_language,
                        target_language=request.translation_config.target_language,
                        translation_successful=True,
                        cache_used=True,
                    )
                else:
                    # Perform translation
                    translation_result = self._translation.translate_text(
                        text_content.content,
                        request.translation_config,
                    )

                    # Cache result if successful
                    if translation_result.translation_successful and request.translation_config.use_cache:

                        self._translation.cache_translation(
                            text_content.content,
                            translation_result.translated_text,
                            request.translation_config.source_language,
                            request.translation_config.target_language,
                        )

                translation_results.append(translation_result)
                state.translation_results[text_content.text_id] = translation_result

                # Update text content with translation
                if translation_result.translation_successful:
                    text_content.content = translation_result.translated_text

            except Exception as e:
                self._logger.log_error(f"Translation failed for text ID {text_content.text_id}", error=e)

                # Create error translation result
                error_result = TranslationResult(
                    text_id=text_content.text_id,
                    original_text=text_content.content,
                    translated_text=text_content.content,  # Keep original
                    source_language=request.translation_config.source_language,
                    target_language=request.translation_config.target_language,
                    translation_successful=False,
                    error_message=str(e),
                )
                translation_results.append(error_result)
                state.errors.append(f"Translation failed for {text_content.text_id}: {e!s}")

        return translation_results

    def _apply_formatting(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> list[FormattingResult]:
        """Apply text formatting."""
        formatting_results: list[FormattingResult] = []

        if not request.formatting_config:
            return formatting_results

        for text_content in request.text_updates:
            try:
                # Apply formatting
                formatting_result = self._text_formatting.format_text(
                    text_content.content,
                    request.formatting_config,
                )

                formatting_results.append(formatting_result)
                state.formatting_results[text_content.text_id] = formatting_result

                # Update text content with formatting
                if formatting_result.formatting_successful:
                    text_content.content = formatting_result.formatted_text

            except Exception as e:
                self._logger.log_error(f"Formatting failed for text ID {text_content.text_id}", error=e)

                # Create error formatting result
                error_result = FormattingResult(
                    text_id=text_content.text_id,
                    original_text=text_content.content,
                    formatted_text=text_content.content,  # Keep original
                    formatting_type=request.formatting_config.formatting_type,
                    formatting_successful=False,
                    error_message=str(e),
                )
                formatting_results.append(error_result)
                state.errors.append(f"Formatting failed for {text_content.text_id}: {e!s}")

        return formatting_results

    def _update_widget_text(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> list[TextUpdate]:
        """Update widget text properties."""
        text_updates = []

        # Create mapping of text IDs to content
        {tc.text_id: tc for tc in request.text_updates}

        # Sort targets by priority
        sorted_targets = sorted(request.target_widgets, key=lambda x: x.priority, reverse=True)

        for target in sorted_targets:
            # Find matching text content
            matching_text = None
            for text_content in request.text_updates:
                if text_content.text_id in target.widget_id or target.widget_id in text_content.text_id:
    
                    matching_text = text_content
                    break

            if not matching_text and request.text_updates:
                # Use first available text content if no specific match
                matching_text = request.text_updates[0]

            if not matching_text:
                continue

            try:
                # Get current text
                current_text = self._widget_text.get_widget_text(target.widget_id, target.text_property)
                target.current_text = current_text

                # Update widget text
                update_successful = self._widget_text.update_widget_text(
                    target.widget_id,
                    target.text_property,
                    matching_text.content,
                )

                # Create text update result
                text_update = TextUpdate(
                    text_id=matching_text.text_id,
                    widget_id=target.widget_id,
                    update_successful=update_successful,
                    original_text=current_text,
                    new_text=matching_text.content,
                    translation_applied=matching_text.text_id in state.translation_results,
                    formatting_applied=matching_text.text_id in state.formatting_results,
                    validation_passed=True,
                )

                text_updates.append(text_update)
                state.processed_texts[target.widget_id] = text_update
                state.completed_updates += 1

                # Progress callback
                if request.progress_callback:
                    progress = state.completed_updates / state.total_updates
                    request.progress_callback(f"Updated text for {target.widget_id}", progress)

            except Exception as e:
                self._logger.log_error(f"Failed to update text for widget {target.widget_id}", error=e)

                # Create error text update
                error_update = TextUpdate(
                    text_id=matching_text.text_id if matching_text else "unknown",
                    widget_id=target.widget_id,
                    update_successful=False,
                    original_text=target.current_text,
                    new_text=matching_text.content if matching_text else "",
                    validation_passed=False,
                    error_message=str(e),
                )
                text_updates.append(error_update)
                state.errors.append(f"Text update failed for {target.widget_id}: {e!s}")

                # Error callback
                if request.error_callback:
                    request.error_callback(f"Text update failed for {target.widget_id}", e)

        return text_updates

    def _validate_updates(self,
    request: UpdateUITextRequest, state: UITextUpdateState, text_updates: list[TextUpdate],
    ) -> bool:
        """Validate completed text updates."""
        try:
            successful_updates = sum(1 for update in text_updates if update.update_successful)
            total_updates = len(text_updates)

            if successful_updates < total_updates:
                state.warnings.append(f"Only {successful_updates}/{total_updates} text updates were successful")
                return False

            return True

        except Exception as e:
            self._logger.log_error("Post-validation failed", error=e)
            return False

    def _finalize_updates(self, request: UpdateUITextRequest, state: UITextUpdateState,
    ) -> None:
        """Finalize UI text updates."""
        try:
            # Log final state
            self._logger.log_info(
                "UI text update finalized",
                operation_id=request.operation_id,
                total_updates=state.total_updates,
                completed_updates=state.completed_updates,
                translations=len(state.translation_results),
                formatting=len(state.formatting_results),
                errors=len(state.errors),
                warnings=len(state.warnings),
            )

        except Exception as e:
            self._logger.log_error("Finalization failed", error=e)

    def _create_error_response(
        self,
        operation_id: str,
        result: UpdateResult,
        error_message: str,
        state: UITextUpdateState,
        text_updates: list[TextUpdate],
        translation_results: list[TranslationResult],
        formatting_results: list[FormattingResult],
        execution_time_ms: float,
    ) -> UpdateUITextResponse:
        """Create error response."""
        return UpdateUITextResponse(
            result=result,
            operation_id=operation_id,
            text_updates=text_updates,
            translation_results=translation_results,
            formatting_results=formatting_results,
            state=state,
            execution_time_ms=execution_time_ms,
            error_message=error_message,
            warnings=state.warnings,
        )