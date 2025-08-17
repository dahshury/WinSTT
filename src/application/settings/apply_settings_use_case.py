"""Apply Settings Use Case for WinSTT Application."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

from src.domain.common.domain_utils import DomainIdentityGenerator
from src.domain.settings.events.settings_events import (
    SettingsApplyProgressEvent,
    SettingsUpdatedEvent,
    WorkerReinitializationRequestedEvent,
)
from src.domain.settings.value_objects.settings_operations import SettingType

if TYPE_CHECKING:
    from collections.abc import Callable

    from src.domain.common.ports.event_publisher_port import IEventPublisher
    from src.domain.common.ports.file_system_port import FileSystemPort
    from src.domain.settings.entities.settings_configuration import SettingsConfiguration


class ApplicationState(Enum):
    """Application state during settings application."""
    IDLE = "idle"
    APPLYING = "applying"
    CANCELLED = "cancelled"


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
    progress_callback: Callable[[int, str], None] | None = None
    message_callback: Callable[[str], None] | None = None


@dataclass
class ApplySettingsResponse:
    """Response from applying settings."""
    success: bool
    applied_changes: list[SettingChange]
    failed_changes: list[SettingChange]
    final_state: ApplicationState
    restart_required: bool
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WorkerManagerProtocol(Protocol):
    """Protocol for worker management."""

    def reinitialize_workers(self) -> bool:
        """Reinitialize all workers."""
        ...

    def update_listener_settings(self, settings: SettingsConfiguration) -> bool:
        """Update listener worker settings."""
        ...

    def update_model_settings(self, settings: SettingsConfiguration) -> bool:
        """Update model worker settings."""
        ...


class DownloadManagerProtocol(Protocol):
    """Protocol for download management."""

    def start_model_download(
        self,
        model_name: str,
        progress_callback: Callable[[int, str], None],
    ) -> bool:
        """Start model download."""
        ...

    def is_download_required(self, model_name: str) -> bool:
        """Check if download is required for model."""
        ...


class ApplySettingsUseCase:
    """Use case for applying settings changes to the application."""

    def __init__(
        self,
        event_publisher: IEventPublisher,
        worker_manager: WorkerManagerProtocol | None = None,
        download_manager: DownloadManagerProtocol | None = None,
        file_system_service: FileSystemPort | None = None,
    ):
        self.event_publisher = event_publisher
        self.worker_manager = worker_manager
        self.download_manager = download_manager
        self.file_system_service = file_system_service
        self.current_state = ApplicationState.IDLE

    def execute(self, request: ApplySettingsRequest) -> ApplySettingsResponse:
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
                            event_id=DomainIdentityGenerator.generate_domain_id("event"),
                            timestamp=datetime.now().timestamp(),
                            source="apply_settings_use_case",
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
                    else:
                        failed_changes.append(change)

                    # Check if restart is required
                    if change.requires_restart:
                        restart_required = True

                except Exception as e:
                    failed_changes.append(change)
                    warnings.append(f"Error applying {change.setting_type.value}: {e}")

            # Publish final settings updated event
            if applied_changes:
                settings_event = SettingsUpdatedEvent(
                    event_id=DomainIdentityGenerator.generate_domain_id("event"),
                    timestamp=datetime.now().timestamp(),
                    source="apply_settings_use_case",
                    setting_types=[change.setting_type for change in applied_changes],
                    changes_count=len(applied_changes),
                    restart_required=restart_required,
                )
                self.event_publisher.publish(settings_event)

            # Reinitialize workers if needed
            if self.worker_manager and any(change.requires_worker_reinit for change in applied_changes):
                worker_types = []
                for change in applied_changes:
                    if change.requires_worker_reinit:
                        if change.setting_type == SettingType.MODEL:
                            worker_types.append("model_worker")
                        elif change.setting_type == SettingType.AUDIO:
                            worker_types.append("audio_worker")

                if worker_types:
                    worker_event = WorkerReinitializationRequestedEvent(
                        event_id=DomainIdentityGenerator.generate_domain_id("event"),
                        timestamp=datetime.now().timestamp(),
                        source="apply_settings_use_case",
                        worker_types=worker_types,
                        reason="Settings changes require worker reinitialization",
                    )
                    self.event_publisher.publish(worker_event)

                    # Actually reinitialize workers
                    if self.worker_manager.reinitialize_workers():
                        settings_event = SettingsUpdatedEvent(
                            event_id=DomainIdentityGenerator.generate_domain_id("event"),
                            timestamp=datetime.now().timestamp(),
                            source="apply_settings_use_case",
                            setting_types=[SettingType.SYSTEM],
                            changes_count=1,
                            restart_required=False,
                        )
                        self.event_publisher.publish(settings_event)
                    else:
                        warnings.append("Failed to reinitialize workers")

            # Handle model downloads
            if self.download_manager:
                for change in applied_changes:
                    if change.requires_download and change.setting_type == SettingType.MODEL:
                        model_name = str(change.new_value)
                        if self.download_manager.is_download_required(model_name):
                            def download_progress(percentage: int, message: str):
                                if request.progress_callback:
                                    request.progress_callback(percentage, message)

                            if self.download_manager.start_model_download(model_name, download_progress):
                                worker_event = WorkerReinitializationRequestedEvent(
                                    event_id=DomainIdentityGenerator.generate_domain_id("event"),
                                    timestamp=datetime.now().timestamp(),
                                    source="apply_settings_use_case",
                                    worker_types=["model_worker"],
                                    reason="Model download completed",
                                )
                                self.event_publisher.publish(worker_event)
                            else:
                                warnings.append(f"Failed to download model: {model_name}")

            success = len(failed_changes) == 0
            self.current_state = ApplicationState.IDLE

            return ApplySettingsResponse(
                success=success,
                applied_changes=applied_changes,
                failed_changes=failed_changes,
                final_state=self.current_state,
                restart_required=restart_required,
                error_message=None if success else f"Failed to apply {len(failed_changes)} changes",
                warnings=warnings,
            )

        except Exception as e:
            self.current_state = ApplicationState.IDLE
            return ApplySettingsResponse(
                success=False,
                applied_changes=[],
                failed_changes=request.changes,
                final_state=self.current_state,
                restart_required=False,
                error_message=f"Unexpected error: {e}",
                warnings=warnings,
            )

    def _sort_changes_by_priority(self, changes: list[SettingChange]) -> list[SettingChange]:
        """Sort changes by priority (downloads first, then worker reinits)."""
        def priority_key(change: SettingChange) -> int:
            if change.requires_download:
                return 0
            if change.requires_worker_reinit:
                return 1
            return 2

        return sorted(changes, key=priority_key)

    def _apply_single_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
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
            return False, f"Error applying {change.setting_type.value}: {e}"

    def _apply_model_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply model configuration change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("model", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply model change: {e}"

    def _apply_quantization_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply quantization change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("quantization", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply quantization change: {e}"

    def _apply_recording_sound_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply recording sound change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("recording_sound_enabled", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply recording sound change: {e}"

    def _apply_srt_output_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply SRT output change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("output_srt", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply SRT output change: {e}"

    def _apply_hotkey_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply hotkey change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("recording_key", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply hotkey change: {e}"

    def _apply_llm_settings_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply LLM settings change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("llm_enabled", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply LLM settings change: {e}"

    def _apply_audio_settings_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply audio settings change."""
        try:
            # Update the settings configuration
            request.settings.update_setting("recording_sound_enabled", change.new_value)
            return True, None
        except Exception as e:
            return False, f"Failed to apply audio settings change: {e}"

    def _apply_ui_settings_change(self, change: SettingChange, request: ApplySettingsRequest) -> tuple[bool, str | None]:
        """Apply UI settings change."""
        try:
            # Update the settings configuration - UI settings are handled differently
            # For now, we'll just log that UI settings were changed
            return True, None
        except Exception as e:
            return False, f"Failed to apply UI settings change: {e}"

    def get_current_state(self) -> ApplicationState:
        """Get the current application state."""
        return self.current_state

    def cancel_operation(self) -> bool:
        """Cancel the current operation."""
        if self.current_state == ApplicationState.APPLYING:
            self.current_state = ApplicationState.CANCELLED
            return True
        return False