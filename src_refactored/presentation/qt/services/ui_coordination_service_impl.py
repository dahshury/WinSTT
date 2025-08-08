"""UI coordination service implementation for presentation layer (moved)."""

from __future__ import annotations

from typing import Any

from src_refactored.application.interfaces.ui_coordination_service import (
    ElementType,
    IAnimationService,
    IUICoordinationService,
)
from src_refactored.domain.common.result import Result


class UICoordinationServiceImpl(IUICoordinationService):
    def __init__(self, animation_service: IAnimationService | None = None):
        self._animation_service = animation_service
        self._ui_states: dict[str, dict[ElementType, Any]] = {}
        self._current_modes: dict[str, str] = {}
        self._message_queues: dict[str, list[tuple[str, str]]] = {}
        self._current_messages: dict[str, str] = {}

    def start_recording_mode(self, coordinator_id: str) -> Result[dict[ElementType, Any]]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            ui_state = {
                ElementType.LOGO: {"visible": True, "opacity": 0.8},
                ElementType.TITLE: {"visible": True, "text": "Recording..."},
                ElementType.SETTINGS: {"enabled": False},
                ElementType.INSTRUCTION: {"visible": False},
                ElementType.BUTTON: {"enabled": True, "text": "Stop"},
                ElementType.VISUALIZER: {"active": True},
                ElementType.PROGRESS_BAR: {"visible": False},
            }
            self._ui_states[coordinator_id] = ui_state
            self._current_modes[coordinator_id] = "recording"
            return Result.success(ui_state)
        except Exception as e:
            return Result.failure(f"Failed to start recording mode: {e}")

    def stop_recording_mode(self, coordinator_id: str) -> Result[dict[ElementType, Any]]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            ui_state = {
                ElementType.LOGO: {"visible": True, "opacity": 1.0},
                ElementType.TITLE: {"visible": True, "text": "WinSTT"},
                ElementType.SETTINGS: {"enabled": True},
                ElementType.INSTRUCTION: {"visible": True},
                ElementType.BUTTON: {"enabled": True, "text": "Record"},
                ElementType.VISUALIZER: {"active": False},
                ElementType.PROGRESS_BAR: {"visible": False},
            }
            self._ui_states[coordinator_id] = ui_state
            self._current_modes[coordinator_id] = "idle"
            return Result.success(ui_state)
        except Exception as e:
            return Result.failure(f"Failed to stop recording mode: {e}")

    def start_download_mode(self, coordinator_id: str, filename: str) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            if ElementType.SETTINGS not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.SETTINGS] = {}
            self._ui_states[coordinator_id][ElementType.SETTINGS]["enabled"] = False
            if ElementType.PROGRESS_BAR not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR] = {}
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["visible"] = True
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["value"] = 0
            self._current_modes[coordinator_id] = "downloading"
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to start download mode: {e}")

    def update_download_progress(self, coordinator_id: str, filename: str, percentage: int) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                return Result.failure(f"Coordinator {coordinator_id} not initialized")
            if ElementType.PROGRESS_BAR not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR] = {}
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["value"] = percentage
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to update download progress: {e}")

    def complete_download_mode(self, coordinator_id: str) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                return Result.failure(f"Coordinator {coordinator_id} not initialized")
            if ElementType.SETTINGS in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.SETTINGS]["enabled"] = True
            if ElementType.PROGRESS_BAR in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["visible"] = False
            self._current_modes[coordinator_id] = "idle"
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to complete download mode: {e}")

    def start_transcription_mode(self, coordinator_id: str, hold_message: bool = True) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            if ElementType.SETTINGS not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.SETTINGS] = {}
            self._ui_states[coordinator_id][ElementType.SETTINGS]["enabled"] = False
            if ElementType.PROGRESS_BAR not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR] = {}
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["visible"] = True
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["value"] = 0
            if ElementType.TITLE not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.TITLE] = {}
            self._ui_states[coordinator_id][ElementType.TITLE]["text"] = "Transcribing..."
            self._current_modes[coordinator_id] = "transcribing"
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to start transcription mode: {e}")

    def update_transcription_progress(self, coordinator_id: str, percentage: int) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                return Result.failure(f"Coordinator {coordinator_id} not initialized")
            if ElementType.PROGRESS_BAR not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR] = {}
            self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["value"] = percentage
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to update transcription progress: {e}")

    def complete_transcription_mode(self, coordinator_id: str, success_message: str | None = None) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                return Result.failure(f"Coordinator {coordinator_id} not initialized")
            if ElementType.SETTINGS in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.SETTINGS]["enabled"] = True
            if ElementType.PROGRESS_BAR in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.PROGRESS_BAR]["visible"] = False
            if ElementType.TITLE in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.TITLE]["text"] = "WinSTT"
            if success_message:
                self.display_message(coordinator_id, success_message, "success")
            self._current_modes[coordinator_id] = "idle"
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to complete transcription mode: {e}")

    def display_message(self, coordinator_id: str, message: str, priority: str = "normal") -> Result[None]:
        try:
            if coordinator_id not in self._message_queues:
                self._message_queues[coordinator_id] = []
            self._message_queues[coordinator_id].append((message, priority))
            if coordinator_id not in self._current_messages:
                self._current_messages[coordinator_id] = message
                if self._message_queues[coordinator_id]:
                    self._message_queues[coordinator_id].pop(0)
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to display message: {e}")

    def clear_current_message(self, coordinator_id: str) -> Result[str | None]:
        try:
            current_message = self._current_messages.get(coordinator_id)
            if coordinator_id in self._current_messages:
                del self._current_messages[coordinator_id]
            if self._message_queues.get(coordinator_id):
                next_message, _ = self._message_queues[coordinator_id].pop(0)
                self._current_messages[coordinator_id] = next_message
                return Result.success(next_message)
            return Result.success(current_message)
        except Exception as e:
            return Result.failure(f"Failed to clear current message: {e}")

    def update_instruction_text(self, coordinator_id: str, key_combination: str) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            if ElementType.INSTRUCTION not in self._ui_states[coordinator_id]:
                self._ui_states[coordinator_id][ElementType.INSTRUCTION] = {}
            instruction_text = f"Press {key_combination} to start recording"
            self._ui_states[coordinator_id][ElementType.INSTRUCTION]["text"] = instruction_text
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to update instruction text: {e}")

    def get_element_state(self, coordinator_id: str, element_type: ElementType) -> Result[Any]:
        try:
            if coordinator_id not in self._ui_states:
                return Result.failure(f"Coordinator {coordinator_id} not initialized")
            element_state = self._ui_states[coordinator_id].get(element_type, {})
            return Result.success(element_state)
        except Exception as e:
            return Result.failure(f"Failed to get element state: {e}")

    def get_current_ui_mode(self, coordinator_id: str) -> Result[str]:
        try:
            mode = self._current_modes.get(coordinator_id, "idle")
            return Result.success(mode)
        except Exception as e:
            return Result.failure(f"Failed to get current UI mode: {e}")

    def reset_to_idle_state(self, coordinator_id: str) -> Result[None]:
        try:
            if coordinator_id not in self._ui_states:
                self._ui_states[coordinator_id] = {}
            idle_state = {
                ElementType.LOGO: {"visible": True, "opacity": 1.0},
                ElementType.TITLE: {"visible": True, "text": "WinSTT"},
                ElementType.SETTINGS: {"enabled": True},
                ElementType.INSTRUCTION: {"visible": True},
                ElementType.BUTTON: {"enabled": True, "text": "Record"},
                ElementType.VISUALIZER: {"active": False},
                ElementType.PROGRESS_BAR: {"visible": False},
            }
            self._ui_states[coordinator_id] = idle_state
            self._current_modes[coordinator_id] = "idle"
            if coordinator_id in self._current_messages:
                del self._current_messages[coordinator_id]
            if coordinator_id in self._message_queues:
                self._message_queues[coordinator_id].clear()
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Failed to reset to idle state: {e}")

