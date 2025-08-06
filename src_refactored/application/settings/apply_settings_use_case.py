"""Apply Settings Use Case.

This module implements the use case for applying settings changes to the application,
including parent window communication and worker reinitialization.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol

from src_refactored.domain.common.ports.event_publisher_port import IEventPublisher
from src_refactored.domain.common.ports.file_system_port import IFileSystemPort
from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration
from src_refactored.domain.settings.events.settings_events import (
    SettingsApplyProgressEvent,
    SettingsUpdatedEvent,
    WorkerReinitializationRequestedEvent,
)
from src_refactored.domain.settings.value_objects.settings_operations import (
    ApplicationState,
    SettingType,
)


@dataclass
class SettingChange:
    """Represents a single setting change."""
    setting_type: SettingType
    old_value: Any
    new_value: Any
    requires_restart: bool = False
    requires_download: bool = False
    requires_worker_reinit: bool = False


@dataclass
class ApplySettingsRequest:
    """Request for applying settings."""
    settings: SettingsConfiguration
    changes: list[SettingChange]
    immediate_apply: bool = True
    show_progress: bool = True


@dataclass
class ApplySettingsResponse:
    """Response from applying settings."""
    success: bool
    applied_changes: list[SettingChange]
    failed_changes: list[SettingChange]
    final_state: ApplicationState
    restart_required: bool
    error_message: str | None = None
    warnings: list[str] = field()

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


# Removed ParentWindowProtocol - UI concerns moved to presentation layer via domain events


class WorkerManagerProtocol(Protocol):
    """Protocol for worker management."""

    def reinitialize_workers(self) -> bool:
        """Reinitialize all workers."""
        ...

    def update_listener_settings(self, settings: SettingsConfiguration,
    ) -> bool:
        """Update listener worker settings."""
        ...

    def update_model_settings(self, settings: SettingsConfiguration,
    ) -> bool:
        """Update model worker settings."""
        ...


class DownloadManagerProtocol(Protocol):
    """Protocol for download management."""

    def start_model_download(
    self,
    model_name: str,
    progress_callback: Callable[[int],
    None]) -> bool:
        """Start model download."""
        ...

    def is_download_required(self, model_name: str,
    ) -> bool:
        """Check if download is required for model."""
        ...


class ApplySettingsUseCase:
    """Use case for applying settings changes to the application."""

    def __init__(
        self,
        event_publisher: IEventPublisher,
        worker_manager: WorkerManagerProtocol | None = None,
        download_manager: DownloadManagerProtocol | None = None,
        file_system_service: IFileSystemPort | None = None,
    ):
        self.event_publisher = event_publisher
        self.worker_manager = worker_manager
        self.download_manager = download_manager
        self.file_system_service = file_system_service
        self.current_state = ApplicationState.IDLE

    def execute(self, request: ApplySettingsRequest,
    ) -> ApplySettingsResponse:
        """Execute the apply settings use case."""
        try:
            self.current_state = ApplicationState.APPLYING

            applied_changes = []
            failed_changes = []
            warnings = []
            restart_required = False

            # Sort changes by priority (downloads first, then worker reinits)
            sorted_changes = self._sort_changes_by_priority(request.changes)

            total_changes = len(sorted_changes)

            for i, change in enumerate(sorted_changes):
                try:
                    # Publish progress event
                    if request.show_progress:
                        progress = int((i / total_changes) * 100)
                        progress_event = SettingsApplyProgressEvent(
                            percentage=progress,
                            message=f"Applying {change.setting_type.value}...",
                            current_step=f"Step {i+1} of {total_changes}",
                        )
                        self.event_publisher.publish(progress_event)

                    # Apply the change
                    success, warning = self._apply_single_change(change, request)

                    if success:
                        applied_changes.append(change)
                        if warning:
                            warnings.append(warning)

                        # Check if restart is required
                        if change.requires_restart:
                            restart_required = True
                    else:
                        failed_changes.append(change)

                except Exception as e:
                    failed_changes.append(change)
                    warnings.append(f"Failed to apply {change.setting_type.value}: {e!s}")

            # Final progress update
            if request.progress_callback:
                request.progress_callback(100, "Settings applied successfully")

            # Determine final state
            if failed_changes:
                final_state = ApplicationState.ERROR if not applied_changes else ApplicationState.COMPLETED
            else:
                final_state = ApplicationState.COMPLETED

            self.current_state = final_state

            return ApplySettingsResponse(
                success=len(failed_changes) == 0,
                applied_changes=applied_changes,
                failed_changes=failed_changes,
                final_state=final_state,
                restart_required=restart_required,
                warnings=warnings,
            )

        except Exception as e:
            self.current_state = ApplicationState.ERROR
            return ApplySettingsResponse(
                success=False,
                applied_changes=[],
                failed_changes=request.changes,
                final_state=ApplicationState.ERROR,
                restart_required=False,
                error_message=str(e),
            )

    def _sort_changes_by_priority(self, changes: list[SettingChange]) -> list[SettingChange]:
        """Sort changes by application priority."""
        # Priority order: downloads first, then worker reinits, then simple changes
        def priority_key(change: SettingChange) -> int:
            if change.requires_download:
                return 0
            if change.requires_worker_reinit:
                return 1
            return 2

        return sorted(changes, key=priority_key)

    def _apply_single_change(self, change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply a single setting change."""

        try:
            if change.setting_type == SettingType.MODEL:
                return self._apply_model_change(change, request)
            if change.setting_type == SettingType.QUANTIZATION:
                return self._apply_quantization_change(change, request)
            if change.setting_type == SettingType.RECORDING_SOUND:
                return self._apply_recording_sound_change(change, request)
            if change.setting_type == SettingType.SRT_OUTPUT:
                return self._apply_srt_output_change(change, request)
            if change.setting_type == SettingType.HOTKEY:
                return self._apply_hotkey_change(change, request)
            if change.setting_type == SettingType.LLM_SETTINGS:
                return self._apply_llm_settings_change(change, request)
            if change.setting_type == SettingType.AUDIO_SETTINGS:
                return self._apply_audio_settings_change(change, request)
            if change.setting_type == SettingType.UI_SETTINGS:
                return self._apply_ui_settings_change(change, request)
            return False, f"Unknown setting type: {change.setting_type}"

        except Exception as e:
            return False, f"Error applying {change.setting_type.value}: {e!s}"

    def _apply_model_change(self, change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply model change."""
        try:
            # Check if download is required
            if self.download_manager and change.requires_download:
                self.current_state = ApplicationState.DOWNLOADING

                def download_progress(percentage: int):
                    if request.progress_callback:
                        request.progress_callback(percentage, f"Downloading {change.new_value}...")

                success = self.download_manager.start_model_download(change.new_value, download_progress)
                if not success:
                    return False, f"Failed to download model {change.new_value}"

            # Publish settings updated event
            settings_event = SettingsUpdatedEvent(
                setting_types=[change.setting_type],
                changes_count=1,
                restart_required=change.requires_restart,
            )
            self.event_publisher.publish(settings_event)

            # Request worker reinitialization if required
            if change.requires_worker_reinit:
                self.current_state = ApplicationState.REINITIALIZING
                if self.worker_manager:
                    success = self.worker_manager.reinitialize_workers()
                    if not success:
                        return False, "Failed to reinitialize workers"
                else:
                    # Publish worker reinitialization event
                    worker_event = WorkerReinitializationRequestedEvent(
                        worker_types=["model_worker", "listener_worker"],
                        reason=f"Model changed to {change.new_value}",
                    )
                    self.event_publisher.publish(worker_event)

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_quantization_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply quantization change."""
        try:
            # Publish settings updated event
            settings_event = SettingsUpdatedEvent(
                setting_types=[change.setting_type],
                changes_count=1,
                restart_required=change.requires_restart,
            )
            self.event_publisher.publish(settings_event)

            # Request worker reinitialization if required
            if change.requires_worker_reinit:
                if self.worker_manager:
                    self.worker_manager.reinitialize_workers()
                else:
                    # Publish worker reinitialization event
                    worker_event = WorkerReinitializationRequestedEvent(
                        worker_types=["model_worker"],
                        reason=f"Quantization changed to {change.new_value}",
                    )
                    self.event_publisher.publish(worker_event)

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_recording_sound_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply recording sound change."""
        try:
            # Publish settings updated event
            settings_event = SettingsUpdatedEvent(
                setting_types=[change.setting_type],
                changes_count=1,
                restart_required=change.requires_restart,
            )
            self.event_publisher.publish(settings_event)

            # Update listener worker if available
            if self.worker_manager:
                self.worker_manager.update_listener_settings(request.settings)

            # Show message
            if request.message_callback:
                if change.new_value and self.file_system_service:
                    filename = self.file_system_service.get_basename(change.new_value)
                else:
                    filename = "None"
                request.message_callback(f"Sound path updated to {filename}")

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_srt_output_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply SRT output change."""
        try:
            # Publish settings updated event
            settings_event = SettingsUpdatedEvent(
                setting_types=[change.setting_type],
                changes_count=1,
                restart_required=change.requires_restart,
            )
            self.event_publisher.publish(settings_event)

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_hotkey_change(self, change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply hotkey change."""
        try:
            # Update listener worker if available
            if self.worker_manager:
                self.worker_manager.update_listener_settings(request.settings)

            # Show message
            if request.message_callback:
                request.message_callback(f"Hotkey updated to {change.new_value}")

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_llm_settings_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply LLM settings change."""
        try:
            # LLM settings typically don't require immediate application
            # They are applied when the LLM is next used

            # Show message
            if request.message_callback:
                request.message_callback("LLM settings updated")

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_audio_settings_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply audio settings change."""
        try:
            # Update worker settings if available
            if self.worker_manager:
                self.worker_manager.update_listener_settings(request.settings)

            # Show message
            if request.message_callback:
                request.message_callback("Audio settings updated")

            return True, None

        except Exception as e:
            return False, str(e)

    def _apply_ui_settings_change(self,
    change: SettingChange, request: ApplySettingsRequest,
    ) -> tuple[bool, str | None]:
        """Apply UI settings change."""
        try:
            # UI settings typically require restart or immediate UI updates
            # This would be handled by the UI layer

            # Show message
            if request.message_callback:
                request.message_callback("UI settings updated")

            return True, None

        except Exception as e:
            return False, str(e)

    def get_current_state(self) -> ApplicationState:
        """Get the current application state."""
        return self.current_state

    def cancel_operation(self) -> bool:
        """Cancel the current operation if possible."""
        if self.current_state in [ApplicationState.DOWNLOADING, ApplicationState.APPLYING]:
            self.current_state = ApplicationState.IDLE
            return True
        return False