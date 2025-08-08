"""Main Window Controller.

This controller coordinates main window interactions with domain services,
following hexagonal architecture principles by keeping business logic
out of the presentation layer.
"""

from dataclasses import dataclass
from typing import Protocol

from src_refactored.application.audio_recording import (
    GetRecordingStatusUseCase,
    StartRecordingUseCase,
    StopRecordingUseCase,
)
from src_refactored.application.audio_recording.start_recording_use_case import (
    StartRecordingRequest,
)
from src_refactored.application.audio_recording.stop_recording_use_case import StopRecordingRequest
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.ports.ui_status_port import (
    StatusDuration,
    StatusMessage,
    StatusType,
    UIStatusPort,
)


@dataclass
class HotkeyRecordingRequest:
    """Request for hotkey-triggered recording."""
    hotkey_name: str
    is_pressed: bool  # True for press, False for release


@dataclass
class FileTranscriptionRequest:
    """Request for file transcription."""
    file_path: str


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device checking."""
    
    def check_availability(self) -> bool:
        """Check if audio input device is available."""
        ...


class AudioToTextBridgeProtocol(Protocol):
    """Protocol for the audio-to-text bridge that coordinates low-level recording."""

    def start_recording_from_hotkey(self) -> bool: ...
    def stop_recording_from_hotkey(self) -> bool: ...


class MainWindowController:
    """Controller for main window business logic coordination."""
    
    def __init__(
        self,
        start_recording_use_case: StartRecordingUseCase,
        stop_recording_use_case: StopRecordingUseCase,
        recording_status_use_case: GetRecordingStatusUseCase,
        ui_status_service: UIStatusPort | None,
        audio_device_service: AudioDeviceServiceProtocol,
        logger: LoggingPort,
        audio_text_bridge: AudioToTextBridgeProtocol | None = None,
    ):
        self._start_recording = start_recording_use_case
        self._stop_recording = stop_recording_use_case
        self._recording_status = recording_status_use_case
        self._ui_status = ui_status_service
        self._audio_device = audio_device_service
        self._logger = logger
        self._audio_text_bridge = audio_text_bridge
    
    def handle_hotkey_recording(self, request: HotkeyRecordingRequest) -> bool:
        """Handle hotkey recording press/release events.
        
        Returns:
            bool: True if the requested action was successful, False otherwise
        """
        try:
            # Ask domain for current recording state
            from src_refactored.domain.audio.value_objects.recording_state import (
                RecordingState as VoRecordingState,
            )
            status_response = self._recording_status.execute(None)
            is_currently_recording = (getattr(status_response, "state", None) == VoRecordingState.RECORDING)
            
            if request.is_pressed and not is_currently_recording:
                return self._start_hotkey_recording(request.hotkey_name)
            elif not request.is_pressed and is_currently_recording:
                return self._stop_hotkey_recording()
            elif not request.is_pressed and not is_currently_recording:
                # Hotkey released but we weren't recording - still need to reset UI to be safe
                if self._ui_status:
                    self._ui_status.show_status(StatusMessage(
                    text="Ready for transcription",
                    type=StatusType.INFO,
                    ))
                return True  # Return True so UI gets reset
            else:
                # Pressing when already recording - no action needed
                return False
                
        except Exception as e:
            self._logger.log_error(f"Error handling hotkey recording: {e}")
            if self._ui_status:
                self._ui_status.show_status(StatusMessage(
                    text="Error processing hotkey",
                    type=StatusType.ERROR,
                ))
            return False
    
    def handle_file_transcription(self, request: FileTranscriptionRequest) -> None:
        """Handle file transcription request."""
        try:
            self._ui_status.show_status(StatusMessage(
                text=f"Transcribing {request.file_path}...",
                type=StatusType.TRANSCRIBING,
                show_progress_bar=True,
                duration=StatusDuration.PERSISTENT,
                auto_clear=False,
            ))
            
            # In real implementation, this would trigger transcription service
            # For now, simulate completion after delay
            self._logger.log_info(f"File transcription started: {request.file_path}")
            
        except Exception as e:
            self._logger.log_error(f"Error handling file transcription: {e}")
            self._ui_status.show_status(StatusMessage(
                text="Error transcribing file",
                type=StatusType.ERROR,
            ))
    
    def complete_transcription(self, result: str, transcription_type: str = "hotkey") -> None:
        """Handle transcription completion."""
        try:
            if transcription_type == "hotkey":
                # Show actual transcription result for hotkey recording
                self._ui_status.show_status(StatusMessage(
                    text=f"Transcription: {result}",
                    type=StatusType.SUCCESS,
                    duration=StatusDuration.LONG,
                ))
            else:
                # Show completion message for file transcription
                self._ui_status.show_status(StatusMessage(
                    text="File transcription complete!",
                    type=StatusType.SUCCESS,
                    duration=StatusDuration.NORMAL,
                ))
            
            self._logger.log_info(f"Transcription completed: {transcription_type}")
            
        except Exception as e:
            self._logger.log_error(f"Error completing transcription: {e}")
    
    def _start_hotkey_recording(self, hotkey_name: str) -> bool:
        """Start recording from hotkey press.
        
        Returns:
            bool: True if recording started successfully, False otherwise
        """
        try:
            # Prefer coordinated start through the bridge so PyAudio/device/VAD are respected
            if self._audio_text_bridge is not None:
                # Let the bridge handle ALL device checking and error reporting
                # The bridge will perform a fresh device check and emit appropriate UI messages
                started = self._audio_text_bridge.start_recording_from_hotkey()
                if started and self._ui_status:
                    # Only show "Recording..." if bridge confirms successful start
                    self._ui_status.show_status(StatusMessage(
                        text="Recording...",
                        type=StatusType.RECORDING,
                        duration=StatusDuration.PERSISTENT,
                        auto_clear=False,
                    ))
                    self._logger.log_info("Recording started via hotkey (bridge)")
                    return True
                else:
                    # Bridge failed - it's responsible for user-facing errors (no device, etc.).
                    # Do NOT show additional error messages here to avoid duplication
                    self._logger.log_info("Bridge failed to start recording (no device or other error)")
                    return False

            # Fallback to the pure domain use case (no device checking here)
            start_request = StartRecordingRequest()
            response = self._start_recording.execute(start_request)
            if response.success and self._ui_status:
                # Keep message minimal per spec
                self._ui_status.show_status(StatusMessage(
                    text="Recording...",
                    type=StatusType.RECORDING,
                    duration=StatusDuration.PERSISTENT,
                    auto_clear=False,
                ))
                self._logger.log_info("Recording started via hotkey")
                return True
            else:
                if self._ui_status:
                    self._ui_status.show_status(StatusMessage(
                        text="Failed to start recording",
                        type=StatusType.ERROR,
                    ))
                return False
                
        except Exception as e:
            self._logger.log_error(f"Error starting hotkey recording: {e}")
            if self._ui_status:
                self._ui_status.show_status(StatusMessage(
                    text="Error starting recording",
                    type=StatusType.ERROR,
                ))
            return False
    
    def _stop_hotkey_recording(self) -> bool:
        """Stop recording from hotkey release.
        
        Returns:
            bool: True if recording stopped successfully, False otherwise
        """
        try:
            # Prefer coordinated stop through the bridge (will trigger VAD + transcription internally)
            if self._audio_text_bridge is not None:
                stopped = self._audio_text_bridge.stop_recording_from_hotkey()
                if stopped and self._ui_status:
                    # Show transcribing status only if stop was successful
                    self._ui_status.show_status(StatusMessage(
                        text="Transcribing...",
                        type=StatusType.TRANSCRIBING,
                        duration=StatusDuration.PERSISTENT,
                        auto_clear=False,
                    ))
                    self._logger.log_info("Recording stopped, transcription started (bridge)")
                    return True
                else:
                    # If stop failed, reset to ready state
                    if self._ui_status:
                        self._ui_status.show_status(StatusMessage(
                            text="Ready for transcription",
                            type=StatusType.INFO,
                        ))
                    return False

            # Fallback to pure domain use case
            stop_request = StopRecordingRequest()
            response = self._stop_recording.execute(stop_request)
            if response.success and self._ui_status:
                self._ui_status.show_status(StatusMessage(
                    text="Transcribing...",
                    type=StatusType.TRANSCRIBING,
                    duration=StatusDuration.PERSISTENT,
                    auto_clear=False,
                ))
                self._logger.log_info("Recording stopped, transcription started")
                return True
            else:
                # Reset to ready state on failure
                if self._ui_status:
                    self._ui_status.show_status(StatusMessage(
                        text="Ready for transcription",
                        type=StatusType.INFO,
                    ))
                return False
                
        except Exception as e:
            self._logger.log_error(f"Error stopping hotkey recording: {e}")
            # Reset to ready state on error
            if self._ui_status:
                self._ui_status.show_status(StatusMessage(
                    text="Ready for transcription",
                    type=StatusType.INFO,
                ))
            return False

    def set_ui_status_port(self, ui_status: UIStatusPort) -> None:
        """Inject or update the UI status port after construction."""
        self._ui_status = ui_status
    
    def get_recording_status(self) -> bool:
        """Get current recording status."""
        try:
            response = self._recording_status.execute(None)
            return getattr(response, "is_recording", False)
        except Exception:
            return False
