"""Audio Processor Integration Component.

This module provides the audio processing functionality for real-time audio capture,
processing, and waveform data generation for speech visualization.
"""

import threading
import time
from collections.abc import Callable

import numpy as np
from PyQt6.QtCore import QMutex, QThread, QWaitCondition, pyqtSignal

from src_refactored.application.use_cases.audio_processing.process_audio_use_case import (
    ProcessAudioUseCase,
)
from src_refactored.domain.audio_processing.value_objects.audio_data import AudioData
from src_refactored.domain.audio_processing.value_objects.processing_config import (
    ProcessingConfig,
)
from src_refactored.infrastructure.audio_processing.audio_capture_service import (
    AudioCaptureService,
)


class AudioProcessor(QThread):
    """Audio processor for real-time audio capture and processing.
    
    This component handles:
    - Real-time audio capture from input devices
    - Audio data normalization and processing
    - Waveform data generation for visualization
    - Background processing using QThread
    - Signal emission for UI updates
    - Audio buffer management
    """

    # Signals for audio processing events
    data_ready = pyqtSignal(object)  # np.ndarray - processed audio data
    processing_started = pyqtSignal()
    processing_stopped = pyqtSignal()
    processing_error = pyqtSignal(str)  # error_message
    audio_level_changed = pyqtSignal(float)  # audio_level (0.0 to 1.0)
    device_status_changed = pyqtSignal(bool)  # is_available
    buffer_status_changed = pyqtSignal(int, int)  # current_size, max_size

    def __init__(self, parent=None):
        """Initialize the audio processor.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        # Initialize use cases (these would be injected via DI in full implementation)
        self._process_audio_use_case = ProcessAudioUseCase()

        # Initialize services
        self._audio_capture_service = AudioCaptureService()

        # Processing configuration
        self._processing_config = ProcessingConfig(
            sample_rate=16000,
            chunk_size=1024,
            channels=1,
            format_bits=16,
            buffer_duration=0.1,
            normalization_enabled=True,
            noise_reduction_enabled=False,
            gain_factor=1.0,
        )

        # Thread control
        self._running = False
        self._paused = False
        self._mutex = QMutex()
        self._condition = QWaitCondition()

        # Audio processing state
        self._current_device = None
        self._audio_buffer = []
        self._buffer_lock = threading.Lock()
        self._max_buffer_size = 100

        # Statistics
        self._processed_chunks = 0
        self._total_samples = 0
        self._processing_errors = 0
        self._start_time = 0.0

        # Audio level tracking
        self._current_audio_level = 0.0
        self._peak_audio_level = 0.0
        self._level_smoothing_factor = 0.3

        # Processing callbacks
        self._data_callback: Callable[[np.ndarray], None] | None = None
        self._level_callback: Callable[[float], None] | None = None

    def set_processing_config(self, config: ProcessingConfig):
        """Set audio processing configuration.
        
        Args:
            config: Processing configuration
        """
        with QMutex():
            self._processing_config = config

    def set_audio_device(self, device_name: str):
        """Set the audio input device.
        
        Args:
            device_name: Name of the audio input device
        """
        self._current_device = device_name

    def set_data_callback(self, callback: Callable[[np.ndarray], None]):
        """Set callback for processed audio data.
        
        Args:
            callback: Function to call with processed audio data
        """
        self._data_callback = callback

    def set_level_callback(self, callback: Callable[[float], None]):
        """Set callback for audio level updates.
        
        Args:
            callback: Function to call with audio level (0.0 to 1.0)
        """
        self._level_callback = callback

    def start_processing(self):
        """Start audio processing."""
        try:
            if self._running:
                return

            self._running = True
            self._paused = False
            self._start_time = time.time()

            # Reset statistics
            self._processed_chunks = 0
            self._total_samples = 0
            self._processing_errors = 0

            # Clear buffer
            with self._buffer_lock:
                self._audio_buffer.clear()

            # Start the thread
            self.start()

            # Emit signal
            self.processing_started.emit()

        except Exception as e:
            self.processing_error.emit(f"Failed to start audio processing: {e!s}")
            self._running = False

    def stop_processing(self):
        """Stop audio processing."""
        try:
            self._running = False

            # Wake up the thread if it's waiting
            with QMutex():
                self._condition.wakeAll()

            # Wait for thread to finish
            if self.isRunning():
                self.wait(5000)  # Wait up to 5 seconds

            # Emit signal
            self.processing_stopped.emit()

        except Exception as e:
            self.processing_error.emit(f"Error stopping audio processing: {e!s}")

    def pause_processing(self):
        """Pause audio processing."""
        with QMutex():
            self._paused = True

    def resume_processing(self):
        """Resume audio processing."""
        with QMutex():
            self._paused = False
            self._condition.wakeAll()

    def run(self):
        """Main processing loop (runs in separate thread)."""
        try:
            # Initialize audio capture
            capture_result = self._audio_capture_service.initialize(
                device_name=self._current_device,
                sample_rate=self._processing_config.sample_rate,
                channels=self._processing_config.channels,
                chunk_size=self._processing_config.chunk_size,
            )

            if not capture_result.is_success:
                self.processing_error.emit(f"Failed to initialize audio capture: {capture_result.error()}")
                return

            # Start audio capture
            self._audio_capture_service.start_capture()
            self.device_status_changed.emit(True)

            # Main processing loop
            while self._running:
                try:
                    # Check if paused
                    with QMutex():
                        if self._paused:
                            self._condition.wait(self._mutex)
                            continue

                    # Capture audio data
                    audio_result = self._audio_capture_service.read_audio_chunk()

                    if not audio_result.is_success:
                        self._processing_errors += 1
                        continue

                    audio_data = audio_result.value()

                    # Process the audio data
                    processed_data = self._process_audio_chunk(audio_data)

                    if processed_data is not None:
                        # Update statistics
                        self._processed_chunks += 1
                        self._total_samples += len(processed_data)

                        # Update audio level
                        self._update_audio_level(processed_data)

                        # Add to buffer
                        self._add_to_buffer(processed_data)

                        # Emit data signal
                        self.data_ready.emit(processed_data)

                        # Call custom callback if set
                        if self._data_callback:
                            self._data_callback(processed_data)

                except Exception as e:
                    self._processing_errors += 1
                    self.processing_error.emit(f"Error in processing loop: {e!s}")

        except Exception as e:
            self.processing_error.emit(f"Fatal error in audio processor: {e!s}")

        finally:
            # Cleanup
            try:
                self._audio_capture_service.stop_capture()
                self.device_status_changed.emit(False)
            except Exception as e:
                self.processing_error.emit(f"Error during cleanup: {e!s}")

    def _process_audio_chunk(self, audio_data: AudioData) -> np.ndarray | None:
        """Process a chunk of audio data.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            Processed audio samples or None if processing failed
        """
        try:
            samples = audio_data.samples

            # Apply normalization if enabled
            if self._processing_config.normalization_enabled:
                samples = self._normalize_audio(samples)

            # Apply gain
            if self._processing_config.gain_factor != 1.0:
                samples = samples * self._processing_config.gain_factor

            # Apply noise reduction if enabled
            if self._processing_config.noise_reduction_enabled:
                samples = self._apply_noise_reduction(samples)

            # Clip to prevent overflow
            samples = np.clip(samples, -1.0, 1.0)

            return samples.astype(np.float32)

        except Exception as e:
            self.processing_error.emit(f"Error processing audio chunk: {e!s}")
            return None

    def _normalize_audio(self, samples: np.ndarray) -> np.ndarray:
        """Normalize audio samples.
        
        Args:
            samples: Raw audio samples
            
        Returns:
            Normalized audio samples
        """
        try:
            # Calculate RMS
            rms = np.sqrt(np.mean(np.square(samples)))

            if rms > 0:
                # Normalize to target RMS level (e.g., 0.1)
                target_rms = 0.1
                normalization_factor = target_rms / rms

                # Limit the normalization factor to prevent excessive amplification
                normalization_factor = min(normalization_factor, 10.0)

                return samples * normalization_factor
            return samples

        except Exception:
            return samples

    def _apply_noise_reduction(self, samples: np.ndarray) -> np.ndarray:
        """Apply basic noise reduction.
        
        Args:
            samples: Audio samples
            
        Returns:
            Noise-reduced audio samples
        """
        try:
            # Simple noise gate - remove samples below threshold
            threshold = 0.01
            mask = np.abs(samples) > threshold
            return samples * mask

        except Exception:
            return samples

    def _update_audio_level(self, samples: np.ndarray):
        """Update current audio level.
        
        Args:
            samples: Audio samples
        """
        try:
            # Calculate RMS level
            rms = np.sqrt(np.mean(np.square(samples)))

            # Smooth the level using exponential moving average
            self._current_audio_level = (
                self._level_smoothing_factor * rms +
                (1 - self._level_smoothing_factor) * self._current_audio_level
            )

            # Update peak level
            self._peak_audio_level = max(self._peak_audio_level, rms)

            # Emit level signal
            self.audio_level_changed.emit(self._current_audio_level)

            # Call custom callback if set
            if self._level_callback:
                self._level_callback(self._current_audio_level)

        except Exception as e:
            self.processing_error.emit(f"Error updating audio level: {e!s}")

    def _add_to_buffer(self, samples: np.ndarray):
        """Add samples to the audio buffer.
        
        Args:
            samples: Audio samples to add
        """
        try:
            with self._buffer_lock:
                self._audio_buffer.append(samples.copy())

                # Limit buffer size
                while len(self._audio_buffer) > self._max_buffer_size:
                    self._audio_buffer.pop(0)

                # Emit buffer status
                self.buffer_status_changed.emit(
                    len(self._audio_buffer),
                    self._max_buffer_size,
                )

        except Exception as e:
            self.processing_error.emit(f"Error managing audio buffer: {e!s}")

    def get_buffer_data(self, num_chunks: int | None = None) -> np.ndarray:
        """Get data from the audio buffer.
        
        Args:
            num_chunks: Number of chunks to retrieve (None for all)
            
        Returns:
            Concatenated audio data from buffer
        """
        try:
            with self._buffer_lock:
                if not self._audio_buffer:
                    return np.array([], dtype=np.float32)

                if num_chunks is None:
                    chunks = self._audio_buffer.copy()
                else:
                    chunks = self._audio_buffer[-num_chunks:]

                return np.concatenate(chunks) if chunks else np.array([], dtype=np.float32)

        except Exception as e:
            self.processing_error.emit(f"Error retrieving buffer data: {e!s}")
            return np.array([], dtype=np.float32)

    def clear_buffer(self):
        """Clear the audio buffer."""
        try:
            with self._buffer_lock:
                self._audio_buffer.clear()
                self.buffer_status_changed.emit(0, self._max_buffer_size)

        except Exception as e:
            self.processing_error.emit(f"Error clearing buffer: {e!s}")

    def is_processing(self) -> bool:
        """Check if audio processing is active.
        
        Returns:
            True if processing is active
        """
        return self._running and self.isRunning()

    def is_paused(self) -> bool:
        """Check if audio processing is paused.
        
        Returns:
            True if processing is paused
        """
        return self._paused

    def get_current_audio_level(self) -> float:
        """Get the current audio level.
        
        Returns:
            Current audio level (0.0 to 1.0)
        """
        return self._current_audio_level

    def get_peak_audio_level(self) -> float:
        """Get the peak audio level.
        
        Returns:
            Peak audio level (0.0 to 1.0)
        """
        return self._peak_audio_level

    def reset_peak_level(self):
        """Reset the peak audio level."""
        self._peak_audio_level = 0.0

    def get_processing_statistics(self) -> dict:
        """Get processing statistics.
        
        Returns:
            Dictionary with processing statistics
        """
        runtime = time.time() - self._start_time if self._start_time > 0 else 0

        return {
            "processed_chunks": self._processed_chunks,
            "total_samples": self._total_samples,
            "processing_errors": self._processing_errors,
            "runtime_seconds": runtime,
            "chunks_per_second": self._processed_chunks / runtime if runtime > 0 else 0,
            "samples_per_second": self._total_samples / runtime if runtime > 0 else 0,
            "error_rate": self._processing_errors / max(self._processed_chunks, 1),
            "buffer_size": len(self._audio_buffer),
            "current_audio_level": self._current_audio_level,
            "peak_audio_level": self._peak_audio_level,
        }

    def reset_statistics(self):
        """Reset processing statistics."""
        self._processed_chunks = 0
        self._total_samples = 0
        self._processing_errors = 0
        self._start_time = time.time() if self._running else 0
        self._current_audio_level = 0.0
        self._peak_audio_level = 0.0

    def get_processing_config(self) -> ProcessingConfig:
        """Get the current processing configuration.
        
        Returns:
            Processing configuration
        """
        return self._processing_config

    def update_sample_rate(self, sample_rate: int):
        """Update the sample rate.
        
        Args:
            sample_rate: New sample rate
        """
        if sample_rate in [8000, 16000, 22050, 44100, 48000]:
            self._processing_config = self._processing_config.with_sample_rate(sample_rate)
        else:
            self.processing_error.emit("Unsupported sample rate")

    def update_chunk_size(self, chunk_size: int):
        """Update the chunk size.
        
        Args:
            chunk_size: New chunk size
        """
        if 256 <= chunk_size <= 4096:
            self._processing_config = self._processing_config.with_chunk_size(chunk_size)
        else:
            self.processing_error.emit("Chunk size must be between 256 and 4096")

    def update_gain_factor(self, gain_factor: float):
        """Update the gain factor.
        
        Args:
            gain_factor: New gain factor (0.1 to 10.0)
        """
        if 0.1 <= gain_factor <= 10.0:
            self._processing_config = self._processing_config.with_gain_factor(gain_factor)
        else:
            self.processing_error.emit("Gain factor must be between 0.1 and 10.0")

    def enable_normalization(self, enabled: bool):
        """Enable or disable audio normalization.
        
        Args:
            enabled: True to enable normalization
        """
        self._processing_config = self._processing_config.with_normalization(enabled)

    def enable_noise_reduction(self, enabled: bool):
        """Enable or disable noise reduction.
        
        Args:
            enabled: True to enable noise reduction
        """
        self._processing_config = self._processing_config.with_noise_reduction(enabled)

    def get_available_devices(self) -> list:
        """Get list of available audio input devices.
        
        Returns:
            List of device names
        """
        try:
            return self._audio_capture_service.get_available_devices()
        except Exception as e:
            self.processing_error.emit(f"Error getting available devices: {e!s}")
            return []

    def test_device(self, device_name: str) -> bool:
        """Test if an audio device is working.
        
        Args:
            device_name: Name of the device to test
            
        Returns:
            True if device is working
        """
        try:
            return self._audio_capture_service.test_device(device_name)
        except Exception as e:
            self.processing_error.emit(f"Error testing device {device_name}: {e!s}")
            return False

    def get_device_info(self, device_name: str) -> dict:
        """Get information about an audio device.
        
        Args:
            device_name: Name of the device
            
        Returns:
            Dictionary with device information
        """
        try:
            return self._audio_capture_service.get_device_info(device_name)
        except Exception as e:
            self.processing_error.emit(f"Error getting device info for {device_name}: {e!s}")
            return {}

    def cleanup(self):
        """Clean up the audio processor."""
        try:
            # Stop processing
            self.stop_processing()

            # Clear buffer
            self.clear_buffer()

            # Clear callbacks
            self._data_callback = None
            self._level_callback = None

            # Reset state
            self._current_device = None
            self._running = False
            self._paused = False

        except Exception as e:
            self.processing_error.emit(f"Error during cleanup: {e!s}")

    def get_current_device(self) -> str | None:
        """Get the current audio device.
        
        Returns:
            Current device name or None
        """
        return self._current_device

    def set_buffer_size(self, size: int):
        """Set the maximum buffer size.
        
        Args:
            size: Maximum number of chunks to keep in buffer
        """
        if 10 <= size <= 1000:
            self._max_buffer_size = size
        else:
            self.processing_error.emit("Buffer size must be between 10 and 1000")

    def get_buffer_size(self) -> int:
        """Get the current buffer size.
        
        Returns:
            Current number of chunks in buffer
        """
        with self._buffer_lock:
            return len(self._audio_buffer)

    def get_max_buffer_size(self) -> int:
        """Get the maximum buffer size.
        
        Returns:
            Maximum buffer size
        """
        return self._max_buffer_size

    def export_buffer_data(self) -> dict:
        """Export buffer data for external use.
        
        Returns:
            Dictionary with buffer data
        """
        try:
            buffer_data = self.get_buffer_data()

            return {
                "samples": buffer_data.tolist(),
                "sample_rate": self._processing_config.sample_rate,
                "chunk_count": len(self._audio_buffer),
                "total_samples": len(buffer_data),
                "duration": len(buffer_data) / self._processing_config.sample_rate,
                "timestamp": time.time(),
            }

        except Exception as e:
            self.processing_error.emit(f"Error exporting buffer data: {e!s}")
            return {}

    def validate_configuration(self) -> bool:
        """Validate the current processing configuration.
        
        Returns:
            True if configuration is valid
        """
        try:
            config = self._processing_config

            # Check sample rate
            if config.sample_rate not in [8000, 16000, 22050, 44100, 48000]:
                return False

            # Check chunk size
            if config.chunk_size < 256 or config.chunk_size > 4096:
                return False

            # Check channels
            if config.channels not in [1, 2]:
                return False

            # Check gain factor
            return not (config.gain_factor < 0.1 or config.gain_factor > 10.0)

        except Exception:
            return False