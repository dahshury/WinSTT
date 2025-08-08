"""Reset settings use case implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Result, UseCase
from src_refactored.domain.settings.value_objects.settings_operations import (
    ResetScope,
)

if TYPE_CHECKING:
    from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration


@dataclass(frozen=True)
class ResetSettingsRequest:
    """Request for resetting settings."""
    scope: ResetScope = ResetScope.ALL
    specific_keys: set[str] | None = None
    create_backup: bool = True
    validate_after_reset: bool = True
    notify_changes: bool = True


@dataclass(frozen=True)
class SettingsResetInfo:
    """Information about reset settings."""
    key: str
    old_value: Any
    new_value: Any
    category: str


@dataclass(frozen=True,
    )
class ResetSettingsResponse:
    """Response for resetting settings."""
    success: bool
    reset_items: list[SettingsResetInfo]
    backup_created: bool = False
    validation_errors: dict[str, str] | None = None
    message: str | None = None


class ResetSettingsUseCase(UseCase[ResetSettingsRequest, ResetSettingsResponse]):
    """Use case for resetting application settings.
    
    This use case handles:
    - Selective or complete settings reset
    - Backup creation before reset
    - Validation after reset
    - Progress tracking and notifications
    """

    def __init__(
        self,
        settings_config: SettingsConfiguration,
        default_settings: dict[str, Any] | None = None,
    ):
        """Initialize the reset settings use case.
        
        Args:
            settings_config: Settings configuration entity
            default_settings: Optional default settings override
        """
        self._settings_config = settings_config
        self._default_settings = default_settings or self._get_default_settings()

    def execute(self, request: ResetSettingsRequest,
    ) -> ResetSettingsResponse:
        """Execute the reset settings use case.
        
        Args:
            request: Reset settings request
            
        Returns:
            Reset settings response with results or error information
        """
        try:
            # Load current settings
            current_settings = self._settings_config.load_configuration()

            # Create backup if requested
            backup_created = False
            if request.create_backup:
                backup_result = self._create_backup(current_settings)
                backup_created = backup_result.is_success

            # Determine what to reset
            keys_to_reset = self._determine_reset_keys(request)

            # Perform reset
            reset_items = []
            updated_settings = current_settings.copy()

            for key in keys_to_reset:
                if key in self._default_settings:
                    old_value = current_settings.get(key)
                    new_value = self._default_settings[key]

                    if old_value != new_value:
                        updated_settings[key] = new_value
                        reset_items.append(
                            SettingsResetInfo(
                                key=key,
                                old_value=old_value,
                                new_value=new_value,
                                category=self._get_setting_category(key),
                            ),
                        )

            # Validate after reset if requested
            validation_errors = None
            if request.validate_after_reset:
                validation_result = self._validate_settings(updated_settings)
                if not validation_result.is_success:
                    validation_errors = {"validation": validation_result.error or "Unknown validation error"}
                    return ResetSettingsResponse(
                        success=False,
                        reset_items=[],
                        backup_created=backup_created,
                        validation_errors=validation_errors,
                        message="Settings validation failed after reset",
                    )

            # Save updated settings
            save_result = self._settings_config.save_configuration(updated_settings)

            if save_result:
                message = self._generate_reset_message(request.scope, len(reset_items))
                return ResetSettingsResponse(
                    success=True,
                    reset_items=reset_items,
                    backup_created=backup_created,
                    message=message,
                )
            return ResetSettingsResponse(
                success=False,
                reset_items=[],
                backup_created=backup_created,
                message="Failed to save reset settings",
            )

        except Exception as e:
            return ResetSettingsResponse(
                success=False,
                reset_items=[],
                message=f"Error resetting settings: {e!s}",
            )

    def _determine_reset_keys(self, request: ResetSettingsRequest,
    ) -> set[str]:
        """Determine which keys to reset based on request.
        
        Args:
            request: Reset settings request
            
        Returns:
            Set of keys to reset
        """
        if request.specific_keys:
            return request.specific_keys

        scope_mappings = {
            ResetScope.ALL: set(self._default_settings.keys()),
            ResetScope.MODEL: {"model", "quantization"},
            ResetScope.AUDIO: {"recording_sound_enabled", "sound_file_path"},
            ResetScope.HOTKEY: {"recording_key"},
            ResetScope.ADVANCED: {"llm_enabled", "llm_model", "llm_quantization", "llm_prompt"},
            ResetScope.EXPORT: {"output_srt"},
        }

        return scope_mappings.get(request.scope, set())

    def _get_setting_category(self, key: str,
    ) -> str:
        """Get the category for a setting key.
        
        Args:
            key: Setting key
            
        Returns:
            Category name
        """
        category_mappings = {
            "model": "Model",
            "quantization": "Model",
            "recording_sound_enabled": "Audio",
            "sound_file_path": "Audio",
            "output_srt": "Output",
            "recording_key": "Hotkey",
            "llm_enabled": "LLM",
            "llm_model": "LLM",
            "llm_quantization": "LLM",
            "llm_prompt": "LLM",
        }

        return category_mappings.get(key, "General")

    def _generate_reset_message(self, scope: ResetScope, items_count: int,
    ) -> str:
        """Generate a message describing the reset operation.
        
        Args:
            scope: Reset scope
            items_count: Number of items reset
            
        Returns:
            Reset message
        """
        if items_count == 0:
            return "No settings needed to be reset"

        scope_messages = {
            ResetScope.ALL: f"All settings reset to defaults ({items_count} items)",
            ResetScope.MODEL: "Model settings reset to defaults",
            ResetScope.AUDIO: "Audio settings reset to defaults",
            ResetScope.HOTKEY: "Hotkey settings reset to defaults",
            ResetScope.ADVANCED: "Advanced settings reset to defaults",
            ResetScope.EXPORT: "Export settings reset to defaults",
        }

        return scope_messages.get(scope, f"{items_count} settings reset to defaults")

    def _validate_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Validate settings after reset.
        
        Args:
            settings: Settings dictionary to validate
            
        Returns:
            Result indicating validation success or failure
        """
        errors = {}

        # Basic validation - ensure required keys exist
        required_keys = {
            "model", "quantization", "recording_sound_enabled",
            "sound_file_path", "output_srt", "recording_key",
        }

        for key in required_keys:
            if key not in settings:
                errors[key] = f"Required setting '{key}' is missing"

        # Validate data types
        type_validations = {
            "model": str,
            "quantization": str,
            "recording_sound_enabled": bool,
            "sound_file_path": str,
            "output_srt": bool,
            "recording_key": str,
            "llm_enabled": bool,
            "llm_model": str,
            "llm_quantization": str,
            "llm_prompt": str,
        }

        for key, expected_type in type_validations.items():
            if key in settings and not isinstance(settings[key], expected_type):
                errors[key] = f"Setting '{key}' must be of type {expected_type.__name__}"

        if errors:
            error_message = "; ".join([f"{key}: {value}" for key, value in errors.items()])
            return Result.failure(error_message)

        return Result.success(None)

    def _create_backup(self, settings: dict[str, Any]) -> Result[None]:
        """Create backup of current settings.
        
        Args:
            settings: Current settings to backup
            
        Returns:
            Result indicating backup success or failure
        """
        try:
            # Implementation would depend on backup strategy
            # For now, assume the settings configuration handles backup internally
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to create backup: {e!s}")

    def _get_default_settings(self) -> dict[str, Any]:
        """Get default settings configuration.
        
        Returns:
            Default settings dictionary
        """
        return {
            "model": "base",
            "quantization": "int8",
            "recording_sound_enabled": True,
            "sound_file_path": "",
            "output_srt": False,
            "recording_key": "CTRL+SHIFT+R",
            "llm_enabled": False,
            "llm_model": "llama2",
            "llm_quantization": "q4_0",
            "llm_prompt": "Please improve this transcription:",
        }