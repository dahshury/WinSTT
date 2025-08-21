"""PyAudio Recorder.

A focused, reusable recorder that encapsulates stream lifecycle and device
refresh logic. Extracted from the previous monolithic service.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

import pyaudio


class PyAudioRecorder:
    """PyAudio-based audio recorder with non-blocking patterns.
    
    Extracted from utils/listener.py Recorder class (lines 23-124).
    """

    def __init__(self, chunk: int = 256, channels: int = 1, rate: int = 16000):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = threading.Event()
        self._frames: list[bytes] = []
        self.p: pyaudio.PyAudio | None = None
        self.stream: pyaudio.Stream | None = None
        self.logger = logging.getLogger(__name__)
        self._error_callback: Callable[[str], None] | None = None
        self._last_device_available = True  # Track if device was available on last attempt
        self._stream_lock = threading.Lock()  # Protect stream operations

        # Initialize PyAudio
        self._initialize_pyaudio()

    def _initialize_pyaudio(self) -> None:
        """Initialize PyAudio instance."""
        try:
            self.p = pyaudio.PyAudio()
        except Exception as exc:
            self.logger.exception("Failed to initialize PyAudio")
            msg = f"Failed to initialize PyAudio: {exc}"
            raise RuntimeError(msg) from exc

    def set_error_callback(self, callback: Callable[[str], None]) -> None:
        """Set error callback for non-blocking error reporting."""
        self._error_callback = callback

    def start(self) -> None:
        """Start recording with non-blocking patterns and persistent stream reuse."""
        self._running.set()
        self._frames = []
        
        with self._stream_lock:
            try:
                # Initialize PyAudio if needed
                if self.p is None:
                    self._initialize_pyaudio()
                assert self.p is not None

                # Check if we need to create/recreate the stream
                need_new_stream = (
                    self.stream is None or 
                    not self._last_device_available  # Recreate if no device was available last time
                )
                
                if need_new_stream:
                    # Close existing stream if any
                    if self.stream is not None:
                        with contextlib.suppress(Exception):
                            self.stream.close()
                        self.stream = None
                    
                    # If device was unavailable last time, refresh PyAudio to detect newly connected devices
                    if not self._last_device_available:
                        self.logger.info("Device was unavailable last time - refreshing PyAudio to detect newly connected devices")
                        if self.p is not None:
                            with contextlib.suppress(Exception):
                                self.p.terminate()
                        self._initialize_pyaudio()
                        self.logger.debug("PyAudio reinitialized for device detection")
                    
                    # Try to create new stream
                    self._create_stream()
                elif not self.stream.is_active():
                    try:
                        self.stream.start_stream()
                    except OSError:
                        # If reusing fails, recreate
                        with contextlib.suppress(Exception):
                            self.stream.close()
                        self.stream = None
                        self._create_stream()

                # Mark device as available since we got here
                was_previously_unavailable = not self._last_device_available
                self._last_device_available = True
                if was_previously_unavailable:
                    self.logger.info("Audio device is now available - recording ready")
                
                # Start recording thread
                threading.Thread(target=self._recording, daemon=True).start()
                self.logger.debug("Recording started.")
                
            except OSError as e:
                self._last_device_available = False
                if "Invalid input device" in str(e) or "no default output device" in str(e):
                    # Nice message for missing recording device
                    msg = "No recording device detected. Please connect a microphone."
                    if self._error_callback:
                        # Defer user-facing message to callback; avoid also logging here to prevent dupes
                        self._error_callback(msg)
                    else:
                        self.logger.warning(msg)
                    raise RuntimeError(msg) from e
                # Log without traceback to keep console clean
                self.logger.exception("Failed to access audio device")
                msg = f"Failed to access audio device: {e}"
                if self._error_callback:
                    self._error_callback(msg)
                raise RuntimeError(msg) from None
            except Exception as e:
                self._last_device_available = False
                # Log without traceback; caller decides whether to show details
                self.logger.exception("Failed to start recording")
                msg = "Failed to start recording"
                if self._error_callback:
                    self._error_callback(msg)
                raise RuntimeError(msg) from None

    def _create_stream(self) -> None:
        """Create a new PyAudio stream with device fallback logic."""
        # Try default device first; on failure, fall back to first usable input device
        try:
            self.stream = self.p.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK,
            )
        except OSError as default_error:
            # Attempt fallback to a specific input device to handle cases where no default is set
            try:
                device_count = self.p.get_device_count()
                fallback_opened = False
                for idx in range(device_count):
                    try:
                        info = self.p.get_device_info_by_index(idx)
                        if info.get("maxInputChannels", 0) > 0:
                            # Use device's default rate if available
                            rate = int(info.get("defaultSampleRate", self.RATE) or self.RATE)
                            self.stream = self.p.open(
                                format=self.FORMAT,
                                channels=self.CHANNELS,
                                rate=rate,
                                input=True,
                                input_device_index=idx,
                                frames_per_buffer=self.CHUNK,
                            )
                            fallback_opened = True
                            break
                    except Exception:
                        # Log and try next device
                        self.logger.debug("Skipping unusable input device during fallback", exc_info=True)
                        continue
                if not fallback_opened:
                    raise default_error
            except Exception:
                # Re-raise to outer handler
                raise
        except OSError as e:
            if "Invalid input device" in str(e) or "no default output device" in str(e):
                # Nice message for missing recording device
                msg = "No recording device detected. Please connect a microphone."
                if self._error_callback:
                    # Defer user-facing message to callback; avoid also logging here to prevent dupes
                    self._error_callback(msg)
                else:
                    self.logger.warning(msg)
                raise RuntimeError(msg) from e
            # Log without traceback to keep console clean
            self.logger.exception("Failed to access audio device")
            msg = f"Failed to access audio device: {e}"
            if self._error_callback:
                self._error_callback(msg)
            raise RuntimeError(msg) from None
        except Exception:
            # Log without traceback; caller decides whether to show details
            self.logger.exception("Failed to start recording")
            msg = "Failed to start recording"
            if self._error_callback:
                self._error_callback(msg)
            raise RuntimeError(msg) from None

    def _recording(self) -> None:
        """Recording worker thread."""
        try:
            while self._running.is_set():
                if self.stream is not None:
                    data = self.stream.read(self.CHUNK, exception_on_overflow=False)
                    self._frames.append(data)
        except Exception:
            self.logger.exception("Error during recording")
            if self._error_callback:
                self._error_callback("Error during recording")
        finally:
            if self.stream is not None:
                try:
                    self.stream.stop_stream()
                    self.stream.close()
                except Exception:
                    self.logger.exception("Error closing stream")
                finally:
                    self.stream = None
                    self.logger.debug("Stream closed.")

    def stop(self) -> None:
        """Stop recording but keep stream alive for reuse."""
        self._running.clear()
        with self._stream_lock:
            # Stop the stream but don't close it for reuse
            if self.stream is not None:
                try:
                    # Only attempt to stop if device was available and stream is likely valid
                    if self._last_device_available and hasattr(self.stream, "is_active"):
                        if self.stream.is_active():
                            self.stream.stop_stream()
                        self.logger.debug("Recording stopped, stream kept for reuse.")
                    else:
                        # Device not available or stream in invalid state - clean up safely
                        with contextlib.suppress(Exception):
                            self.stream.close()
                        self.stream = None
                        self.logger.debug("Recording stopped, stream cleaned up due to device unavailability.")
                except Exception:
                    self.logger.exception("Error stopping stream")
                    # If stopping fails, close and recreate next time
                    with contextlib.suppress(Exception):
                        self.stream.close()
                    self.stream = None
            else:
                self.logger.debug("Recording stopped.")

    def get_wav_bytes(self) -> bytes:
        """Assemble the recorded frames into a WAV format in-memory bytes buffer."""
        try:
            from src.infrastructure.common.file_audio_writer import FileAudioWriter
            writer = FileAudioWriter()
            sample_width = self.p.get_sample_size(self.FORMAT) if self.p is not None else 2
            return writer.assemble_wav(sample_width, self.CHANNELS, self.RATE, self._frames)
        except Exception:
            self.logger.exception("Failed to assemble WAV bytes")
            if self._error_callback:
                self._error_callback("Failed to assemble WAV bytes")
            raise

    def close(self, reset: bool = False,
    ) -> None:
        """Close the Recorder and release resources.
        
        Args:
            reset: If True, reset the audio stream and PyAudio instance for reuse.
        """
        try:
            with self._stream_lock:
                if self.stream is not None:
                    try:
                        self.stream.stop_stream()
                        self.stream.close()
                    except Exception:
                        self.logger.exception("Error stopping/closing stream")
                    finally:
                        if not reset:
                            self.stream = None

                if self.p is not None:
                    try:
                        self.p.terminate()
                    except Exception:
                        self.logger.exception("Error terminating PyAudio")
                    finally:
                        if not reset:
                            self.p = None

                if reset:
                    # Reinitialize PyAudio for reuse and reset device state
                    self._initialize_pyaudio()
                    self.stream = None  # Ensure the stream is reset
                    self._last_device_available = True  # Reset device state for fresh detection
                    self.logger.debug("Recorder reset for reinitialization.")
        except Exception:
            self.logger.exception("Error closing Recorder")
            if self._error_callback:
                self._error_callback("Error closing Recorder")


__all__ = ["PyAudioRecorder"]


