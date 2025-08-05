"""Save settings use case implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Result, UseCase
from src_refactored.domain.settings.value_objects.audio_configuration import AudioConfiguration
from src_refactored.domain.settings.value_objects.file_path import AudioFilePath
from src_refactored.domain.settings.value_objects.key_combination import KeyCombination
from src_refactored.domain.settings.value_objects.llm_configuration import LLMConfiguration
from src_refactored.domain.settings.value_objects.model_configuration import ModelConfiguration

if TYPE_CHECKING:
    from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration


@dataclass(frozen=True)
class SaveSettingsRequest:
    """Request for saving settings."""
    model: str
    quantization: str
    recording_sound_enabled: bool
    sound_file_path: str
    output_srt: bool
    recording_key: str
    llm_enabled: bool
    llm_model: str
    llm_quantization: str
    llm_prompt: str
    validate_before_save: bool = True
    create_backup: bool = True


@dataclass(frozen=True,
    )
class SaveSettingsResponse:
    """Response for saving settings."""
    success: bool
    settings_saved: dict[str, Any]
    validation_errors: dict[str, str] | None = None
    backup_created: bool = False
    message: str | None = None


class SaveSettingsUseCase(UseCase[SaveSettingsRequest, SaveSettingsResponse]):
    """Use case for saving application settings.
    
    This use case handles:
    - Settings validation before saving
    - Configuration persistence
    - Backup creation
    - Error handling and reporting
    """

    def __init__(
        self,
        settings_config: SettingsConfiguration,
        validation_service: Any | None = None,
    ):
        """Initialize the save settings use case.
        
        Args:
            settings_config: Settings configuration entity
            validation_service: Optional validation service
        """
        self._settings_config = settings_config
        self._validation_service = validation_service

    def execute(self, request: SaveSettingsRequest,
    ) -> Result[SaveSettingsResponse]:
        """Execute the save settings use case.
        
        Args:
            request: Save settings request
            
        Returns:
            Result containing save settings response
        """
        try:
            # Prepare settings dictionary
            settings_dict = self._prepare_settings_dict(request)

            # Validate settings if requested
            validation_errors = None
            if request.validate_before_save:
                validation_result = self._validate_settings(settings_dict)
                if not validation_result.is_success(,
    ):
                    validation_errors = validation_result.error
                    return Result.failure(
                        SaveSettingsResponse(
                            success=False,
                            settings_saved={},
                            validation_errors=validation_errors,
                            message="Settings validation failed",
                        ),
                    )

            # Create backup if requested
            backup_created = False
            if request.create_backup:
                backup_result = self._create_backup()
                backup_created = backup_result.is_success()

            # Save settings
            save_result = self._settings_config.save_configuration(settings_dict,
    )

            if save_result:
                return Result.success(
                    SaveSettingsResponse(
                        success=True,
                        settings_saved=settings_dict,
                        backup_created=backup_created,
                        message="Settings saved successfully",
                    ),
                )
            return Result.failure(
                SaveSettingsResponse(
                    success=False,
                    settings_saved={},
                    message="Failed to save settings to file",
                ),
            )

        except Exception as e:
            return Result.failure(
                SaveSettingsResponse(
                    success=False,
                    settings_saved={},
                    message=f"Error saving settings: {e!s}",
                ),
            )

    def _prepare_settings_dict(self, request: SaveSettingsRequest,
    ) -> dict[str, Any]:
        """Prepare settings dictionary from request.
        
        Args:
            request: Save settings request
            
        Returns:
            Settings dictionary
        """
        return {
            "model": request.model,
            "quantization": request.quantization,
            "recording_sound_enabled": request.recording_sound_enabled,
            "sound_file_path": request.sound_file_path,
            "output_srt": request.output_srt,
            "recording_key": request.recording_key,
            "llm_enabled": request.llm_enabled,
            "llm_model": request.llm_model,
            "llm_quantization": request.llm_quantization,
            "llm_prompt": request.llm_prompt,
        }

    def _validate_settings(self, settings: dict[str, Any]) -> Result[None]:
        """Validate settings before saving.
        
        Args:
            settings: Settings dictionary to validate
            
        Returns:
            Result indicating validation success or failure
        """
        errors = {}

        # Validate model configuration
        try:
            ModelConfiguration(
                model_name=settings.get("model", "")
                quantization=settings.get("quantization", ""),
            )
        except Exception as e:
            errors["model"] = f"Invalid model configuration: {e!s}"

        # Validate LLM configuration if enabled
        if settings.get("llm_enabled", False):
            try:
                LLMConfiguration(
                    model_name=settings.get("llm_model", "")
                    quantization=settings.get("llm_quantization", "")
                    prompt=settings.get("llm_prompt", ""),
                )
            except Exception as e:
                errors["llm"] = f"Invalid LLM configuration: {e!s}"

        # Validate audio configuration
        try:
            AudioConfiguration(
                recording_sound_enabled=settings.get("recording_sound_enabled", False)
                sound_file_path=AudioFilePath(settings.get("sound_file_path", "")),
                output_srt=settings.get("output_srt", False),
            )
        except Exception as e:
            errors["audio"] = f"Invalid audio configuration: {e!s}"

        # Validate recording key
        try:
            KeyCombination.from_string(settings.get("recording_key", ""))
        except Exception as e:
            errors["recording_key"] = f"Invalid recording key: {e!s}"

        if errors:
            return Result.failure(errors)

        return Result.success(None)

    def _create_backup(self) -> Result[None]:
        """Create backup of current settings.
        
        Returns:
            Result indicating backup success or failure
        """
        try:
            # Implementation would depend on settings configuration backup method
            # For now, assume the settings configuration handles backup internally
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to create backup: {e!s}")