"""Reset Sound Settings Use Case.

This module implements the ResetSoundSettingsUseCase for resetting
sound-related settings to their default values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from src_refactored.domain.common import Result, UseCase

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.settings.value_objects.settings_operations import (
        ResetScope,
    )



class ISoundSettingsResetPort(Protocol):
    """Port for sound settings reset operations."""
    
    def reset_recording_sound(self) -> bool:
        """Reset recording sound to default."""
        ...
    
    def reset_notification_sound(self) -> bool:
        """Reset notification sound to default."""
        ...
    
    def reset_volume_settings(self) -> bool:
        """Reset volume settings to default."""
        ...


@dataclass
class ResetSoundSettingsRequest:
    """Request for resetting sound settings."""
    reset_scope: ResetScope
    include_recording_sound: bool = True
    include_notification_sound: bool = True
    include_volume_settings: bool = True
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[str], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class ResetSoundSettingsResponse:
    """Response from sound settings reset operation."""
    success: bool
    reset_items: list[str]
    failed_items: list[str]
    message: str = ""


class ResetSoundSettingsUseCase(UseCase[ResetSoundSettingsRequest, ResetSoundSettingsResponse]):
    """Use case for resetting sound settings to defaults.
    
    This use case handles:
    - Recording sound reset
    - Notification sound reset
    - Volume settings reset
    - Selective reset based on scope
    """
    
    def __init__(self, reset_port: ISoundSettingsResetPort):
        """Initialize the reset sound settings use case.
        
        Args:
            reset_port: Port for sound settings reset operations
        """
        self._reset_port = reset_port
    
    def execute(self, request: ResetSoundSettingsRequest) -> Result[ResetSoundSettingsResponse]:
        """Execute the sound settings reset operation.
        
        Args:
            request: Reset sound settings request
            
        Returns:
            Result[ResetSoundSettingsResponse]: Result of the reset operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback("Starting sound settings reset", 0.1)
            
            reset_items = []
            failed_items = []
            
            # Reset recording sound if requested
            if request.include_recording_sound:
                if request.progress_callback:
                    request.progress_callback("Resetting recording sound", 0.3)
                
                if self._reset_port.reset_recording_sound():
                    reset_items.append("Recording sound")
                else:
                    failed_items.append("Recording sound")
            
            # Reset notification sound if requested
            if request.include_notification_sound:
                if request.progress_callback:
                    request.progress_callback("Resetting notification sound", 0.6)
                
                if self._reset_port.reset_notification_sound():
                    reset_items.append("Notification sound")
                else:
                    failed_items.append("Notification sound")
            
            # Reset volume settings if requested
            if request.include_volume_settings:
                if request.progress_callback:
                    request.progress_callback("Resetting volume settings", 0.8)
                
                if self._reset_port.reset_volume_settings():
                    reset_items.append("Volume settings")
                else:
                    failed_items.append("Volume settings")
            
            # Report completion
            if request.progress_callback:
                request.progress_callback("Sound settings reset completed", 1.0)
            
            success = len(reset_items) > 0
            message = f"Reset {len(reset_items)} sound settings successfully"
            if failed_items:
                message += f", failed to reset {len(failed_items)} items"
            
            if request.completion_callback:
                request.completion_callback(message)
            
            response = ResetSoundSettingsResponse(
                success=success,
                reset_items=reset_items,
                failed_items=failed_items,
                message=message,
            )
            
            return Result.success(response)
            
        except Exception as e:
            error_msg = f"Failed to reset sound settings: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            
            response = ResetSoundSettingsResponse(
                success=False,
                reset_items=[],
                failed_items=[],
                message=error_msg,
            )
            
            return Result.failure(error_msg)


def create_reset_sound_settings_use_case(
    reset_port: ISoundSettingsResetPort,
) -> ResetSoundSettingsUseCase:
    """Factory function to create ResetSoundSettingsUseCase.
    
    Args:
        reset_port: Port for sound settings reset operations
        
    Returns:
        ResetSoundSettingsUseCase: Configured use case instance
    """
    return ResetSoundSettingsUseCase(reset_port)