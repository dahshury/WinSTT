"""Update hotkey use case implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src_refactored.domain.common import Result, UseCase
from src_refactored.domain.settings.value_objects.key_combination import KeyCombination
from src_refactored.domain.settings.value_objects.settings_operations import (
    HotkeyRecordingState,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration


@dataclass(frozen=True)
class UpdateHotkeyRequest:
    """Request for updating hotkey configuration."""
    new_key_combination: str | None = None
    start_recording: bool = False
    stop_recording: bool = False
    cancel_recording: bool = False
    reset_to_default: bool = False
    validate_combination: bool = True


@dataclass(frozen=True)
class HotkeyRecordingProgress:
    """Progress information for hotkey recording."""
    state: HotkeyRecordingState
    pressed_keys: set[str]
    current_combination: str | None = None
    message: str | None = None


@dataclass(frozen=True,
    )
class UpdateHotkeyResponse:
    """Response for updating hotkey configuration."""
    success: bool
    recording_state: HotkeyRecordingState
    current_hotkey: str | None = None
    pressed_keys: set[str] = None
    validation_error: str | None = None
    message: str | None = None
    requires_ui_update: bool = False


class UpdateHotkeyUseCase(UseCase[UpdateHotkeyRequest, UpdateHotkeyResponse]):
    """Use case for updating hotkey configuration.
    
    This use case handles:
    - Hotkey recording state management
    - Key combination validation
    - Settings persistence
    - Progress callbacks for UI updates
    """

    def __init__(
        self,
        settings_config: SettingsConfiguration,
        default_hotkey: str = "CTRL+SHIFT+R",
        progress_callback: Callable[[HotkeyRecordingProgress], None] | None = None,
    ):
        """Initialize the update hotkey use case.
        
        Args:
            settings_config: Settings configuration entity
            default_hotkey: Default hotkey combination
            progress_callback: Optional callback for recording progress
        """
        self._settings_config = settings_config
        self._default_hotkey = default_hotkey
        self._progress_callback = progress_callback
        self._recording_state = HotkeyRecordingState.IDLE
        self._pressed_keys: set[str] = set()
        self._current_hotkey = self._get_current_hotkey()

    def execute(self, request: UpdateHotkeyRequest,
    ) -> Result[UpdateHotkeyResponse]:
        """Execute the update hotkey use case.
        
        Args:
            request: Update hotkey request
            
        Returns:
            Result containing update hotkey response
        """
        try:
            # Handle different request types
            if request.start_recording:
                return self._start_recording()
            if request.stop_recording:
                return self._stop_recording(request.validate_combination)
            if request.cancel_recording:
                return self._cancel_recording()
            if request.reset_to_default:
                return self._reset_to_default()
            if request.new_key_combination:
                return self._update_hotkey(request.new_key_combination, request.validate_combination)
            return self._get_current_state()

        except Exception as e:
            return Result.success(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message=f"Error updating hotkey: {e!s}",
                ),
            )

    def add_pressed_key(self, key: str,
    ) -> Result[UpdateHotkeyResponse]:
        """Add a pressed key to the current combination.
        
        Args:
            key: Key that was pressed
            
        Returns:
            Result containing updated state
        """
        if self._recording_state != HotkeyRecordingState.RECORDING:
            return Result.failure(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message="Not currently recording hotkey",
                ),
            )

        self._pressed_keys.add(key.upper())

        # Notify progress if callback is available
        if self._progress_callback:
            progress = HotkeyRecordingProgress(
                state=self._recording_state,
                pressed_keys=self._pressed_keys.copy(),
                current_combination=self._format_key_combination(self._pressed_keys),
                message=f"Recording: {self._format_key_combination(self._pressed_keys)}",
            )
            self._progress_callback(progress)

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=self._recording_state,
                pressed_keys=self._pressed_keys.copy(),
                current_hotkey=self._format_key_combination(self._pressed_keys),
                requires_ui_update=True,
            ),
        )

    def _start_recording(self) -> Result[UpdateHotkeyResponse]:
        """Start hotkey recording.
        
        Returns:
            Result containing recording start response
        """
        self._recording_state = HotkeyRecordingState.RECORDING
        self._pressed_keys.clear()

        # Notify progress
        if self._progress_callback:
            progress = HotkeyRecordingProgress(
                state=self._recording_state,
                pressed_keys=set(),
                message="Recording hotkey... Press keys now",
            )
            self._progress_callback(progress)

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=self._recording_state,
                pressed_keys=set(),
                message="Started recording hotkey",
                requires_ui_update=True,
            ),
        )

    def _stop_recording(self, validate: bool = True,
    ) -> Result[UpdateHotkeyResponse]:
        """Stop hotkey recording and apply the combination.
        
        Args:
            validate: Whether to validate the combination
            
        Returns:
            Result containing recording stop response
        """
        if self._recording_state != HotkeyRecordingState.RECORDING:
            return Result.success(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message="Not currently recording",
                ),
            )

        if not self._pressed_keys:
            return Result.success(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message="No keys recorded",
                ),
            )

        # Format the key combination
        new_combination = self._format_key_combination(self._pressed_keys)

        # Validate if requested
        if validate:
            validation_result = self._validate_key_combination(new_combination)
            if not validation_result.is_success():
                self._recording_state = HotkeyRecordingState.IDLE
                return Result.success(
                    UpdateHotkeyResponse(
                        success=False,
                        recording_state=self._recording_state,
                        validation_error=validation_result.error,
                        message=f"Invalid hotkey: {validation_result.error}",
                    ),
                )

        # Apply the new hotkey
        self._current_hotkey = new_combination
        self._recording_state = HotkeyRecordingState.COMPLETED

        # Save to settings
        save_result = self._save_hotkey(new_combination)
        if not save_result.is_success():
            return Result.success(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message=f"Failed to save hotkey: {save_result.error}",
                ),
            )

        # Notify progress
        if self._progress_callback:
            progress = HotkeyRecordingProgress(
                state=self._recording_state,
                pressed_keys=self._pressed_keys.copy(),
                current_combination=new_combination,
                message=f"Hotkey updated to: {new_combination}",
            )
            self._progress_callback(progress)

        # Reset state
        self._pressed_keys.clear()
        self._recording_state = HotkeyRecordingState.IDLE

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=HotkeyRecordingState.IDLE,
                current_hotkey=new_combination,
                message=f"Hotkey updated to: {new_combination}",
                requires_ui_update=True,
            ),
        )

    def _cancel_recording(self) -> Result[UpdateHotkeyResponse]:
        """Cancel hotkey recording.
        
        Returns:
            Result containing recording cancellation response
        """
        self._recording_state = HotkeyRecordingState.CANCELLED
        self._pressed_keys.clear()

        # Notify progress
        if self._progress_callback:
            progress = HotkeyRecordingProgress(
                state=self._recording_state,
                pressed_keys=set(),
                message="Hotkey recording cancelled",
            )
            self._progress_callback(progress)

        # Reset to idle
        self._recording_state = HotkeyRecordingState.IDLE

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=HotkeyRecordingState.IDLE,
                current_hotkey=self._current_hotkey,
                message="Recording cancelled",
                requires_ui_update=True,
            ),
        )

    def _reset_to_default(self) -> Result[UpdateHotkeyResponse]:
        """Reset hotkey to default value.
        
        Returns:
            Result containing reset response
        """
        self._current_hotkey = self._default_hotkey
        self._recording_state = HotkeyRecordingState.IDLE
        self._pressed_keys.clear()

        # Save to settings
        save_result = self._save_hotkey(self._default_hotkey)
        if not save_result.is_success():
            return Result.failure(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message=f"Failed to save default hotkey: {save_result.error}",
                ),
            )

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=self._recording_state,
                current_hotkey=self._default_hotkey,
                message=f"Hotkey reset to default: {self._default_hotkey}",
                requires_ui_update=True,
            ),
        )

    def _update_hotkey(
    self,
    combination: str,
    validate: bool = True) -> Result[UpdateHotkeyResponse]:
        """Update hotkey with a specific combination.
        
        Args:
            combination: Key combination string
            validate: Whether to validate the combination
            
        Returns:
            Result containing update response
        """
        if validate:
            validation_result = self._validate_key_combination(combination)
            if not validation_result.is_success():
                return Result.success(
                    UpdateHotkeyResponse(
                        success=False,
                        recording_state=self._recording_state,
                        validation_error=validation_result.error,
                        message=f"Invalid hotkey: {validation_result.error}",
                    ),
                )

        self._current_hotkey = combination

        # Save to settings
        save_result = self._save_hotkey(combination)
        if not save_result.is_success():
            return Result.success(
                UpdateHotkeyResponse(
                    success=False,
                    recording_state=self._recording_state,
                    message=f"Failed to save hotkey: {save_result.error}",
                ),
            )

        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=self._recording_state,
                current_hotkey=combination,
                message=f"Hotkey updated to: {combination}",
                requires_ui_update=True,
            ),
        )

    def _get_current_state(self) -> Result[UpdateHotkeyResponse]:
        """Get current hotkey state.
        
        Returns:
            Result containing current state
        """
        return Result.success(
            UpdateHotkeyResponse(
                success=True,
                recording_state=self._recording_state,
                current_hotkey=self._current_hotkey,
                pressed_keys=self._pressed_keys.copy() if self._pressed_keys else set(),
            ),
        )

    def _validate_key_combination(self, combination: str,
    ) -> Result[None]:
        """Validate a key combination.
        
        Args:
            combination: Key combination to validate
            
        Returns:
            Result indicating validation success or failure
        """
        try:
            KeyCombination.from_string(combination)
            return Result.success(None)
        except Exception as e:
            return Result.failure(str(e))

    def _format_key_combination(self, keys: set[str]) -> str:
        """Format a set of keys into a combination string.
        
        Args:
            keys: Set of key names
            
        Returns:
            Formatted key combination string
        """
        if not keys:
            return ""

        # Sort keys by length (longer first) then alphabetically
        sorted_keys = sorted(keys, key=lambda x: (-len(x), x))
        return "+".join(sorted_keys)

    def _save_hotkey(self, combination: str,
    ) -> Result[None]:
        """Save hotkey to settings.
        
        Args:
            combination: Key combination to save
            
        Returns:
            Result indicating save success or failure
        """
        try:
            current_settings = self._settings_config.load_configuration()
            current_settings["recording_key"] = combination
            success = self._settings_config.save_configuration(current_settings)

            if success:
                return Result.success(None)
            return Result.failure("Failed to save settings")

        except Exception as e:
            return Result.failure(str(e))

    def _get_current_hotkey(self,
    ) -> str:
        """Get current hotkey from settings.
        
        Returns:
            Current hotkey combination
        """
        try:
            return self._settings_config.get_setting("recording_key", self._default_hotkey)
        except Exception:
            return self._default_hotkey