"""Update Sound Settings Use Case.

This module implements the UpdateSoundSettingsUseCase for updating
sound-related settings in the application.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from src_refactored.domain.common import Result, UseCase
from src_refactored.domain.settings.value_objects.settings_operations import (
    SettingType,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration


class ISoundSettingsUpdatePort(Protocol):
    """Port for sound settings update operations."""
    
    def update_recording_sound(self, file_path: str) -> bool:
        """Update recording sound file."""
        ...
    
    def update_notification_sound(self, file_path: str) -> bool:
        """Update notification sound file."""
        ...
    
    def update_volume_level(self, volume: float) -> bool:
        """Update volume level."""
        ...
    
    def validate_sound_file(self, file_path: str) -> bool:
        """Validate sound file format and accessibility."""
        ...


@dataclass
class SoundSettingsUpdate:
    """Sound settings update data."""
    setting_type: SettingType
    new_value: Any
    validate_file: bool = True


@dataclass
class UpdateSoundSettingsRequest:
    """Request for updating sound settings."""
    updates: list[SoundSettingsUpdate]
    settings_config: SettingsConfiguration
    validate_changes: bool = True
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[list[str]], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class UpdateSoundSettingsResponse:
    """Response from sound settings update operation."""
    success: bool
    updated_settings: list[str]
    failed_settings: list[str]
    validation_errors: list[str]
    message: str = ""


class UpdateSoundSettingsUseCase(UseCase[UpdateSoundSettingsRequest, UpdateSoundSettingsResponse]):
    """Use case for updating sound settings.
    
    This use case handles:
    - Recording sound file updates
    - Notification sound file updates
    - Volume level adjustments
    - Sound file validation
    """
    
    def __init__(self, update_port: ISoundSettingsUpdatePort):
        """Initialize the update sound settings use case.
        
        Args:
            update_port: Port for sound settings update operations
        """
        self._update_port = update_port
    
    def execute(self, request: UpdateSoundSettingsRequest) -> Result[UpdateSoundSettingsResponse]:
        """Execute the sound settings update operation.
        
        Args:
            request: Update sound settings request
            
        Returns:
            Result[UpdateSoundSettingsResponse]: Result of the update operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback("Starting sound settings update", 0.1)
            
            updated_settings = []
            failed_settings = []
            validation_errors = []
            
            total_updates = len(request.updates)
            
            for i, update in enumerate(request.updates):
                progress = 0.2 + (0.7 * i / total_updates)
                
                if request.progress_callback:
                    request.progress_callback(f"Updating {update.setting_type.value}", progress)
                
                # Validate update if requested
                if request.validate_changes:
                    validation_result = self._validate_update(update)
                    if not validation_result.is_success:
                        validation_errors.append(validation_result.error())
                        failed_settings.append(update.setting_type.value)
                        continue
                
                # Apply the update
                update_result = self._apply_update(update)
                if update_result.is_success:
                    updated_settings.append(update.setting_type.value)
                else:
                    failed_settings.append(update.setting_type.value)
                    validation_errors.append(update_result.error())
            
            # Report completion
            if request.progress_callback:
                request.progress_callback("Sound settings update completed", 1.0)
            
            success = len(updated_settings) > 0
            message = f"Updated {len(updated_settings)} sound settings successfully"
            if failed_settings:
                message += f", failed to update {len(failed_settings)} settings"
            
            if request.completion_callback:
                request.completion_callback(updated_settings)
            
            response = UpdateSoundSettingsResponse(
                success=success,
                updated_settings=updated_settings,
                failed_settings=failed_settings,
                validation_errors=validation_errors,
                message=message,
            )
            
            return Result.success(response)
            
        except Exception as e:
            error_msg = f"Failed to update sound settings: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            
            response = UpdateSoundSettingsResponse(
                success=False,
                updated_settings=[],
                failed_settings=[],
                validation_errors=[error_msg],
                message=error_msg,
            )
            
            return Result.failure(error_msg)
    
    def _validate_update(self, update: SoundSettingsUpdate) -> Result[None]:
        """Validate a sound settings update.
        
        Args:
            update: Sound settings update to validate
            
        Returns:
            Result[None]: Validation result
        """
        try:
            if update.setting_type in [SettingType.RECORDING_SOUND, SettingType.NOTIFICATION_SOUND]:
                # Validate file path
                if not isinstance(update.new_value, str):
                    return Result.failure(f"Sound file path must be a string, got {type(update.new_value)}")
                
                if update.validate_file:
                    file_path = Path(update.new_value)
                    if not file_path.exists():
                        return Result.failure(f"Sound file does not exist: {update.new_value}")
                    
                    if not self._update_port.validate_sound_file(update.new_value):
                        return Result.failure(f"Invalid sound file format: {update.new_value}")
            
            elif update.setting_type == SettingType.VOLUME_LEVEL:
                # Validate volume level
                if not isinstance(update.new_value, int | float):
                    return Result.failure(f"Volume level must be a number, got {type(update.new_value)}")
                
                if not 0.0 <= update.new_value <= 1.0:
                    return Result.failure(f"Volume level must be between 0.0 and 1.0, got {update.new_value}")
            
            return Result.success(None)
            
        except Exception as e:
            return Result.failure(f"Validation error: {e!s}")
    
    def _apply_update(self, update: SoundSettingsUpdate) -> Result[None]:
        """Apply a sound settings update.
        
        Args:
            update: Sound settings update to apply
            
        Returns:
            Result[None]: Application result
        """
        try:
            if update.setting_type == SettingType.RECORDING_SOUND:
                if self._update_port.update_recording_sound(update.new_value):
                    return Result.success(None)
                return Result.failure("Failed to update recording sound")
            
            if update.setting_type == SettingType.NOTIFICATION_SOUND:
                if self._update_port.update_notification_sound(update.new_value):
                    return Result.success(None)
                return Result.failure("Failed to update notification sound")
            
            if update.setting_type == SettingType.VOLUME_LEVEL:
                if self._update_port.update_volume_level(update.new_value):
                    return Result.success(None)
                return Result.failure("Failed to update volume level")
            
            return Result.failure(f"Unsupported setting type: {update.setting_type}")
            
        except Exception as e:
            return Result.failure(f"Update error: {e!s}")


def create_update_sound_settings_use_case(
    update_port: ISoundSettingsUpdatePort,
) -> UpdateSoundSettingsUseCase:
    """Factory function to create UpdateSoundSettingsUseCase.
    
    Args:
        update_port: Port for sound settings update operations
        
    Returns:
        UpdateSoundSettingsUseCase: Configured use case instance
    """
    return UpdateSoundSettingsUseCase(update_port)