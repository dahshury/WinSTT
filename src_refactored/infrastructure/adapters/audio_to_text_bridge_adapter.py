"""Audio To Text Bridge Adapter.

This adapter bridges the old AudioToText implementation with the new DDD architecture,
ensuring proper state synchronization and error handling while maintaining the
hexagonal architecture principles.
"""

import contextlib
import io
from collections.abc import Callable
from typing import Any

from src_refactored.domain.audio.entities.audio_recorder import AudioRecorder
from src_refactored.domain.audio.value_objects.recording_state import RecordingState
from src_refactored.domain.common.ports.logging_port import LoggingPort

# Constants
MIN_AUDIO_DATA_SIZE = 1024  # Minimum bytes for valid audio data


class AudioToTextBridgeAdapter:
    """Adapter that bridges AudioToText with the DDD AudioRecorder entity.
    
    This adapter ensures that the old AudioToText implementation works seamlessly
    with the new hexagonal architecture while providing proper state management
    and error handling.
    """
    
    def __init__(
        self,
        audio_recorder: AudioRecorder,
        transcription_adapter: Any,
        vad_adapter: Any,
        recording_key: str = "F10",
        logger: LoggingPort | None = None,
        ui_callback: Callable[[str, Any, Any, Any, Any], None] | None = None,
    ):
        """Initialize the bridge adapter.
        
        Args:
            audio_recorder: The DDD AudioRecorder entity
            transcription_adapter: The real transcription adapter
            vad_adapter: The real VAD adapter
            recording_key: The hotkey for recording
            logger: Optional logger
            ui_callback: Optional UI callback for status updates
        """
        self._audio_recorder = audio_recorder
        self._transcription_adapter = transcription_adapter
        self._vad_adapter = vad_adapter
        self._recording_key = recording_key
        self._logger = logger
        self._ui_callback = ui_callback
        
        # Audio recording state
        self._audio_to_text = None
        self._is_listening = False
        self._last_transcription = ""
        
        # Initialize the AudioToText system
        self._initialize_audio_to_text()
    
    def _initialize_audio_to_text(self) -> None:
        """Initialize the AudioToText system with proper adapters."""
        try:
            # Check if transcription and VAD adapters are properly initialized
            transcriber_available = (hasattr(self._transcription_adapter, "_transcriber") and 
                                   self._transcription_adapter._transcriber is not None)
            vad_available = (hasattr(self._vad_adapter, "_vad_detector") and 
                           self._vad_adapter._vad_detector is not None)
            
            if not transcriber_available:
                if self._logger:
                    self._logger.log_warning("Transcription adapter not properly initialized, using fallback mode")
            
            if not vad_available:
                if self._logger:
                    self._logger.log_warning("VAD adapter not properly initialized, using fallback mode")
            
            # Only try to create AudioToText if both core services are available
            # Otherwise, we'll operate in a degraded mode where we handle recording ourselves
            if transcriber_available and vad_available:
                # Import the original AudioToText system
                from utils.listener import AudioToText
                
                # Create AudioToText instance with real adapters
                self._audio_to_text = AudioToText(
                    model_cls=self._transcription_adapter,
                    vad_cls=self._vad_adapter,
                    rec_key=self._recording_key,
                    error_callback=self._create_error_callback(),
                )
            else:
                if self._logger:
                    self._logger.log_warning("Running in degraded mode without AudioToText system")
                self._audio_to_text = None
                return
            
            # Override the transcription handler to sync state
            original_transcribe_and_paste = self._audio_to_text.transcribe_and_paste
            self._audio_to_text.transcribe_and_paste = self._bridged_transcribe_and_paste
            self._original_transcribe_and_paste = original_transcribe_and_paste
            
            # Override recording start/stop to sync state
            original_start_recording = self._audio_to_text.start_recording
            original_stop_recording = self._audio_to_text.stop_recording
            self._audio_to_text.start_recording = self._bridged_start_recording
            self._audio_to_text.stop_recording = self._bridged_stop_recording
            self._original_start_recording = original_start_recording
            self._original_stop_recording = original_stop_recording
            
            if self._logger:
                self._logger.log_info("AudioToText bridge adapter initialized successfully")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to initialize AudioToText bridge adapter: {e}")
            self._audio_to_text = None
    
    def _create_error_callback(self) -> Any:
        """Create error callback that handles both UI updates and state sync."""
        class SignalLikeCallback:
            """Signal-like wrapper for callback function to match AudioToText expectations."""
            
            def __init__(self, ui_callback: Callable | None, logger: Any):
                self._ui_callback = ui_callback
                self._logger = logger
            
            def emit(self, txt: str | None, filename: Any = None, percentage: Any = None, hold: Any = None, reset: Any = None):
                """Handle error/status messages from AudioToText (mimics PyQt signal.emit)."""
                try:
                    # Forward to UI callback if available
                    if self._ui_callback:
                        self._ui_callback(txt, filename, percentage, hold, reset)
                    
                    # Log the message
                    if self._logger and txt:
                        if "error" in txt.lower() or "failed" in txt.lower():
                            self._logger.log_error(f"AudioToText: {txt}")
                        else:
                            self._logger.log_info(f"AudioToText: {txt}")
                            
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error in signal-like callback: {e}")
        
        return SignalLikeCallback(self._ui_callback, self._logger)
    
    def _bridged_start_recording(self) -> None:
        """Start recording with state synchronization."""
        try:
            # Ensure audio input device exists before starting
            if not self.check_audio_device():
                if self._ui_callback:
                    self._ui_callback("No recording device detected.\nPlease connect a microphone.", None, None, None, None)
                if self._logger:
                    self._logger.log_warning("Attempted to start recording with no input device detected")
                return

            # Call original start recording first to validate underlying audio stack
            self._original_start_recording()

            # Only update DDD entity state after successful low-level start
            self._audio_recorder.start_recording()
            
            if self._logger:
                self._logger.log_info("Recording started via bridge adapter")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error starting bridged recording: {e}")
            
            # Reset audio backend on recording error (following original pattern)
            # This ensures that if a device was disconnected during recording attempt,
            # the next attempt can detect newly connected devices
            self._reset_audio_backend_for_device_refresh()
            
            # Reset state on error
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                self._audio_recorder.stop_recording()
    
    def _bridged_stop_recording(self) -> None:
        """Stop recording with state synchronization."""
        try:
            # Call original stop recording
            self._original_stop_recording()
            
            # Update DDD entity state
            self._audio_recorder.stop_recording()
            
            if self._logger:
                self._logger.log_info("Recording stopped via bridge adapter")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error stopping bridged recording: {e}")
            
            # Ensure state is reset
            if self._audio_recorder.get_state() == RecordingState.RECORDING:
                self._audio_recorder.stop_recording()
    
    # Public methods to be orchestrated from the application layer (controller)
    def start_recording_from_hotkey(self) -> bool:
        """Entry point for starting recording initiated by a hotkey in the app layer."""
        try:
            # Immediately gate by device availability to avoid stale state causing UI to show recording
            if not self.check_audio_device():
                if self._ui_callback:
                    self._ui_callback("No recording device detected.\nPlease connect a microphone.", None, None, None, None)
                if self._logger:
                    self._logger.log_warning("Hotkey start ignored due to no input device")
                
                # CRITICAL: Reset the underlying AudioToText PyAudio instance so it can detect newly connected devices
                # This follows the pattern from the original listener.py implementation
                self._reset_audio_backend_for_device_refresh()
                return False

            self._audio_recorder.get_state()
            self._bridged_start_recording()
            after_state = self._audio_recorder.get_state()
            return getattr(after_state, "name", "").upper() == "RECORDING" or getattr(after_state, "value", "") == "recording"
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to start recording from hotkey: {e}")
            
            # Reset audio backend on any error to ensure fresh state for next attempt
            self._reset_audio_backend_for_device_refresh()
            return False

    def stop_recording_from_hotkey(self) -> bool:
        """Entry point for stopping recording initiated by a hotkey in the app layer."""
        try:
            self._bridged_stop_recording()
            # If no exception, consider stop successful; transcription is handled async in AudioToText
            return True
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to stop recording from hotkey: {e}")
            return False

    def _bridged_transcribe_and_paste(self, wav_bytes: bytes) -> None:
        """Transcribe and paste with proper VAD and state management."""
        try:
            # Check if there's sufficient data
            if len(wav_bytes) <= MIN_AUDIO_DATA_SIZE:
                error_msg = "Audio data is too small. Check your recording device."
                if self._ui_callback:
                    self._ui_callback(error_msg, None, None, None, None)
                if self._logger:
                    self._logger.log_warning(error_msg)
                return
            
            # Create audio buffer for VAD
            with io.BytesIO(wav_bytes) as wav_buffer:
                # Use real VAD to check for speech
                if not self._vad_adapter.has_speech(wav_buffer):
                    error_msg = "No speech detected in the recording."
                    if self._ui_callback:
                        self._ui_callback(error_msg, None, None, None, None)
                    if self._logger:
                        self._logger.log_warning(error_msg)
                    return
                
                # Reset buffer position after VAD
                wav_buffer.seek(0)
                
                # Use real transcription
                if self._logger:
                    self._logger.log_debug("Starting transcription")
                
                transcription_result = self._transcription_adapter.transcribe(wav_buffer)
                
                if self._logger:
                    self._logger.log_debug("Transcription completed")
                
                # Store result
                self._last_transcription = transcription_result
                
                # Paste the transcription (using original implementation)
                self._audio_to_text.paste_transcription(transcription_result)
                
                # Show success message
                if self._ui_callback:
                    self._ui_callback(f"{transcription_result}", None, None, None, None)
                
        except Exception as e:
            error_msg = f"Transcription Error: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg)
            if self._ui_callback:
                self._ui_callback("Transcription Error. Check logs.", None, None, None, None)
    
    def start_listening(self) -> bool:
        """Start listening for hotkeys."""
        if self._audio_to_text is None:
            if self._logger:
                self._logger.log_warning("AudioToText not initialized, creating fallback recording system")
            # In degraded mode, create a simple fallback recording system
            self._create_fallback_recording_system()
            self._is_listening = True
            return True
        
        try:
            self._audio_to_text.capture_keys(self._recording_key)
            self._is_listening = True
            if self._logger:
                self._logger.log_info("Started listening for hotkeys")
            return True
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to start listening: {e}")
            # Try fallback system
            self._create_fallback_recording_system()
            self._is_listening = True
            return True
    
    def stop_listening(self) -> None:
        """Stop listening for hotkeys."""
        if self._audio_to_text:
            try:
                self._audio_to_text.shutdown()
                self._is_listening = False
                if self._logger:
                    self._logger.log_info("Stopped listening for hotkeys")
            except Exception as e:
                if self._logger:
                    self._logger.log_error(f"Error stopping listening: {e}")
    
    def is_listening(self) -> bool:
        """Check if currently listening."""
        return self._is_listening
    
    def is_recording(self) -> bool:
        """Check if currently recording."""
        # Check the DDD entity state first (most reliable)
        recorder_state = self._audio_recorder.get_state()
        if recorder_state.name == "RECORDING":
            return True
        
        # Fallback to AudioToText if available
        if self._audio_to_text:
            return getattr(self._audio_to_text, "is_recording", False)
        
        return False
    
    def get_last_transcription(self) -> str:
        """Get the last transcription result."""
        return self._last_transcription
    
    def get_audio_recorder(self) -> AudioRecorder:
        """Get the DDD AudioRecorder entity."""
        return self._audio_recorder
    
    def check_audio_device(self) -> bool:
        """Check if an input audio device is currently available.

        Important: Do NOT assume a fixed sample rate when probing devices. Some
        microphones do not support 16 kHz and will incorrectly fail a probe.
        For hotkey behavior, presence of any input-capable device is sufficient;
        the recording backend will negotiate an appropriate rate.
        
        This method performs a fresh check every time it's called - no caching.
        """
        try:
            import pyaudio

            # Force a fresh PyAudio instance for each check to avoid stale device state
            pa = pyaudio.PyAudio()
            try:
                device_count = pa.get_device_count()
                if self._logger:
                    self._logger.log_debug(f"PyAudio reports {device_count} total devices")
            except Exception as e:
                if self._logger:
                    self._logger.log_debug(f"Failed to get device count: {e}")
                device_count = 0

            usable_input_devices = 0
            for i in range(device_count):
                try:
                    info = pa.get_device_info_by_index(i)
                    max_input_channels = info.get("maxInputChannels", 0)
                    
                    if max_input_channels > 0:
                        device_name = info.get("name", "Unknown")
                        default_rate = info.get("defaultSampleRate", 0)
                        
                        # Test if the device is actually usable by trying to open it briefly
                        try:
                            test_stream = pa.open(
                                format=pyaudio.paInt16,
                                channels=1,
                                rate=int(default_rate) if default_rate > 0 else 44100,
                                input=True,
                                input_device_index=i,
                                frames_per_buffer=1024,
                            )
                            test_stream.close()
                            usable_input_devices += 1
                            if self._logger:
                                self._logger.log_debug(
                                    f"✓ Usable input device {i}: '{device_name}' (channels={max_input_channels}, rate={default_rate})"
                                )
                        except Exception as device_error:
                            if self._logger:
                                self._logger.log_debug(
                                    f"✗ Device {i} '{device_name}' reported as input but failed test: {device_error}"
                                )
                            continue
                            
                except Exception as info_error:
                    if self._logger:
                        self._logger.log_debug(f"Error getting info for device {i}: {info_error}")
                    continue

            # Always terminate PyAudio to ensure clean state for next check
            try:
                pa.terminate()
            except Exception as terminate_error:
                if self._logger:
                    self._logger.log_debug(f"Error terminating PyAudio: {terminate_error}")

            has_devices = usable_input_devices > 0
            if self._logger:
                if has_devices:
                    self._logger.log_info(f"Audio device check: {usable_input_devices} usable input devices found (out of {device_count} total)")
                else:
                    self._logger.log_info(f"Audio device check: No usable input devices found (checked {device_count} total devices)")
            
            return has_devices

        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to check audio device availability: {e}")
            return False
    
    def _reset_audio_backend_for_device_refresh(self) -> None:
        """Reset the underlying AudioToText PyAudio instance to allow detection of newly connected devices.
        
        This follows the pattern from the original listener.py implementation where the Recorder's 
        PyAudio instance is reset with `close(reset=True)` after device detection failures.
        """
        try:
            if self._audio_to_text and hasattr(self._audio_to_text, 'rec'):
                # Reset the recorder's PyAudio instance following the original pattern
                if self._logger:
                    self._logger.log_debug("Resetting AudioToText recorder PyAudio instance for device refresh")
                
                # This mirrors the original listener.py logic in lines 305 and 313
                # where `self.rec.close(reset=True)` is called after device errors
                self._audio_to_text.rec.close(reset=True)
                
                if self._logger:
                    self._logger.log_debug("AudioToText recorder reset completed")
                    
        except Exception as e:
            if self._logger:
                self._logger.log_warning(f"Failed to reset audio backend for device refresh: {e}")
    
    def _create_fallback_recording_system(self) -> None:
        """Create a fallback recording system when ONNX services are unavailable."""
        try:
            if self._logger:
                self._logger.log_info("Creating fallback recording system for testing")
            
            # Create a simple keyboard listener that can handle hotkeys
            from keyboard import hook
            
            def fallback_key_handler(event):
                """Simple fallback key handler for testing."""
                try:
                    # Parse the recording key (e.g., "F10", "Ctrl+Alt+A")
                    key_parts = self._recording_key.lower().split("+")
                    target_key = key_parts[-1]  # Last part is the main key
                    
                    # Check if this is our target key
                    if event.name.lower() == target_key.lower():
                        if event.event_type == "down":
                            # Key pressed - start recording
                            current_state = self._audio_recorder.get_state()
                            if current_state.name != "RECORDING":
                                if self._logger:
                                    self._logger.log_debug(f"Key down: {event.name}, starting recording")
                                self._start_fallback_recording()
                        elif event.event_type == "up":
                            # Key released - stop recording
                            current_state = self._audio_recorder.get_state()
                            if current_state.name == "RECORDING":
                                if self._logger:
                                    self._logger.log_debug(f"Key up: {event.name}, stopping recording")
                                self._stop_fallback_recording()
                                
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error in fallback key handler: {e}")
            
            # Install the keyboard hook
            hook(fallback_key_handler)
            
            if self._logger:
                self._logger.log_info(f"Fallback keyboard listener installed for key: {self._recording_key}")
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to create fallback recording system: {e}")
    
    def _start_fallback_recording(self) -> None:
        """Start recording in fallback mode."""
        try:
            # Check audio device first
            if not self.check_audio_device():
                if self._ui_callback:
                    self._ui_callback("No microphone detected. Please connect a microphone.", None, None, None, None)
                return
            
            # Update DDD entity state
            result = self._audio_recorder.start_recording()
            if result.is_failure():
                if self._ui_callback:
                    self._ui_callback(f"Failed to start recording: {result.error}", None, None, None, None)
                return
            
            # Show recording message (minimal wording)
            if self._ui_callback:
                self._ui_callback("Recording...", None, None, None, None)
            
            if self._logger:
                self._logger.log_info("Fallback recording started")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error starting fallback recording: {e}")
            if self._ui_callback:
                self._ui_callback("Error starting recording", None, None, None, None)
    
    def _stop_fallback_recording(self) -> None:
        """Stop recording in fallback mode."""
        try:
            # Update DDD entity state
            result = self._audio_recorder.stop_recording()
            if result.is_failure():
                if self._ui_callback:
                    self._ui_callback(f"Failed to stop recording: {result.error}", None, None, None, None)
                return
            
            # Show completion message (since we can't transcribe without ONNX)
            if self._ui_callback:
                self._ui_callback("Recording completed. Transcription unavailable (ONNX not loaded).", None, None, None, None)
            
            if self._logger:
                self._logger.log_info("Fallback recording stopped")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error stopping fallback recording: {e}")
            if self._ui_callback:
                self._ui_callback("Error stopping recording", None, None, None, None)

    def cleanup(self) -> None:
        """Clean up resources."""
        self.stop_listening()
        if self._audio_to_text:
            with contextlib.suppress(Exception):
                self._audio_to_text.shutdown()
        self._audio_to_text = None
        
        # Clean up keyboard hooks
        try:
            from keyboard import unhook_all
            unhook_all()
        except Exception:
            pass
