"""Audio processor entity for audio visualization."""

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

import numpy as np

from src_refactored.domain.audio_visualization.value_objects import (
    AudioBuffer,
    WaveformData,
)
from src_refactored.domain.common.entity import Entity


class ProcessorStatus(Enum):
    """Audio processor status."""
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"


class AudioFormat(Enum):
    """Supported audio formats."""
    INT16 = "int16"
    INT32 = "int32"
    FLOAT32 = "float32"
    FLOAT64 = "float64"


@dataclass
class AudioProcessorConfig:
    """Configuration for audio processor."""
    sample_rate: int = 16000
    channels: int = 1
    chunk_size: int = 1024
    buffer_size: int = 100
    audio_format: AudioFormat = AudioFormat.FLOAT32
    device_index: int | None = None

    # Processing settings
    enable_noise_reduction: bool = False
    enable_auto_gain: bool = True
    gain_factor: float = 1.0

    # Callback settings
    callback_interval_ms: float = 33.33  # ~30 FPS

    def validate(self) -> None:
        """Validate configuration."""
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg,
    )
        if self.channels not in [1, 2]:
            msg = "Channels must be 1 (mono) or 2 (stereo)"
            raise ValueError(msg)
        if self.chunk_size <= 0:
            msg = "Chunk size must be positive"
            raise ValueError(msg)
        if self.buffer_size <= 0:
            msg = "Buffer size must be positive"
            raise ValueError(msg)
        if self.gain_factor <= 0:
            msg = "Gain factor must be positive"
            raise ValueError(msg)
        if self.callback_interval_ms <= 0:
            msg = "Callback interval must be positive"
            raise ValueError(msg)


@dataclass
class AudioProcessor(Entity):
    """Entity for processing audio data for visualization."""

    # Configuration
    config: AudioProcessorConfig = field(default_factory=AudioProcessorConfig,
    )

    # State
    status: ProcessorStatus = ProcessorStatus.STOPPED
    buffer: AudioBuffer | None = None

    # Statistics
    total_samples_processed: int = 0
    total_chunks_processed: int = 0
    processing_errors: int = 0
    last_processing_time: datetime | None = None
    average_processing_time_ms: float = 0.0

    # Callbacks
    data_callback: Callable[[WaveformData], None] | None = None
    error_callback: Callable[[Exception], None] | None = None
    status_callback: Callable[[ProcessorStatus], None] | None = None

    # Internal state
    _processing_thread: threading.Thread | None = field(default=None, init=False)
    _stop_event: threading.Event = field(default_factory=threading.Event, init=False)
    _pause_event: threading.Event = field(default_factory=threading.Event, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def __post_init__(self):
        """Initialize audio processor."""
        super().__post_init__()
        self.config.validate()

        # Initialize buffer
        self.buffer = AudioBuffer.create_empty(
            max_size=self.config.buffer_size,
            sample_rate=self.config.sample_rate,
            chunk_size=self.config.chunk_size,
        )

    def start(self) -> bool:
        """Start audio processing."""
        with self._lock:
            if self.status in [ProcessorStatus.RUNNING, ProcessorStatus.STARTING]:
                return True

            try:
                self._change_status(ProcessorStatus.STARTING)

                # Reset events
                self._stop_event.clear()
                self._pause_event.clear()

                # Start processing thread
                self._processing_thread = threading.Thread(
                    target=self._processing_loop,
                    daemon=True,
                )
                self._processing_thread.start()

                self._change_status(ProcessorStatus.RUNNING)
                return True

            except Exception as e:
                self._change_status(ProcessorStatus.ERROR)
                self._handle_error(e)
                return False

    def stop(self) -> bool:
        """Stop audio processing."""
        with self._lock:
            if self.status == ProcessorStatus.STOPPED:
                return True

            try:
                self._change_status(ProcessorStatus.STOPPING)

                # Signal stop
                self._stop_event.set()

                # Wait for thread to finish
                if self._processing_thread and self._processing_thread.is_alive():
                    self._processing_thread.join(timeout=2.0)

                self._processing_thread = None
                self._change_status(ProcessorStatus.STOPPED)
                return True

            except Exception as e:
                self._change_status(ProcessorStatus.ERROR)
                self._handle_error(e)
                return False

    def pause(self) -> bool:
        """Pause audio processing."""
        with self._lock:
            if self.status != ProcessorStatus.RUNNING:
                return False

            self._pause_event.set()
            self._change_status(ProcessorStatus.PAUSED)
            return True

    def resume(self) -> bool:
        """Resume audio processing."""
        with self._lock:
            if self.status != ProcessorStatus.PAUSED:
                return False

            self._pause_event.clear()
            self._change_status(ProcessorStatus.RUNNING)
            return True

    def process_samples(self, samples: np.ndarray) -> WaveformData | None:
        """Process raw audio samples."""
        try:
            start_time = time.time()

            # Convert to float32 if needed
            if samples.dtype != np.float32:
                if samples.dtype == np.int16:
                    samples = samples.astype(np.float32) / 32768.0
                elif samples.dtype == np.int32:
                    samples = samples.astype(np.float32) / 2147483648.0
                else:
                    samples = samples.astype(np.float32)

            # Handle stereo to mono conversion
            if len(samples.shape,
    ) > 1 and samples.shape[1] > 1:
                samples = np.mean(samples, axis=1)

            # Apply gain
            if self.config.gain_factor != 1.0:
                samples = samples * self.config.gain_factor

            # Apply noise reduction if enabled
            if self.config.enable_noise_reduction:
                samples = self._apply_noise_reduction(samples)

            # Apply auto gain if enabled
            if self.config.enable_auto_gain:
                samples = self._apply_auto_gain(samples,
    )

            # Clip to prevent overflow
            samples = np.clip(samples, -1.0, 1.0)

            # Create waveform data
            waveform = WaveformData.from_numpy(samples, self.config.sample_rate)

            # Update buffer
            if self.buffer:
                self.buffer = self.buffer.add_waveform(waveform)

            # Update statistics
            self.total_samples_processed += len(samples)
            self.total_chunks_processed += 1
            self.last_processing_time = datetime.now()

            # Update average processing time
            processing_time_ms = (time.time() - start_time) * 1000.0
            self._update_average_processing_time(processing_time_ms)

            # Call data callback
            if self.data_callback:
                try:
                    self.data_callback(waveform)
                except Exception as e:
                    self._handle_error(e)

            return waveform

        except Exception as e:
            self.processing_errors += 1
            self._handle_error(e)
            return None

    def get_latest_data(self, count: int = 1) -> list[WaveformData]:
        """Get latest processed data."""
        if not self.buffer:
            return []
        return self.buffer.get_latest(count)

    def get_buffer_statistics(self,
    ) -> dict[str, Any]:
        """Get buffer statistics."""
        if not self.buffer:
            return {}
        return self.buffer.get_statistics()

    def get_processing_statistics(self) -> dict[str, Any]:
        """Get processing statistics."""
        return {
            "status": self.status.value,
            "total_samples_processed": self.total_samples_processed,
            "total_chunks_processed": self.total_chunks_processed,
            "processing_errors": self.processing_errors,
            "last_processing_time": self.last_processing_time.isoformat() if self.last_processing_time else None,
            "average_processing_time_ms": self.average_processing_time_ms,
            "sample_rate": self.config.sample_rate,
            "chunk_size": self.config.chunk_size,
            "buffer_size": self.config.buffer_size,
        }

    def clear_buffer(self) -> None:
        """Clear the audio buffer."""
        if self.buffer:
            self.buffer = self.buffer.clear()

    def set_data_callback(self, callback: Callable[[WaveformData], None] | None) -> None:
        """Set data processing callback."""
        self.data_callback = callback

    def set_error_callback(self, callback: Callable[[Exception], None] | None) -> None:
        """Set error handling callback."""
        self.error_callback = callback

    def set_status_callback(self, callback: Callable[[ProcessorStatus], None] | None) -> None:
        """Set status change callback."""
        self.status_callback = callback

    def _processing_loop(self) -> None:
        """Main processing loop (to be overridden by concrete implementations)."""
        # This is a base implementation that simulates processing
        # Concrete implementations should override this method
        interval = self.config.callback_interval_ms / 1000.0

        while not self._stop_event.is_set():
            if self._pause_event.is_set():
                time.sleep(0.1)
                continue

            try:
                # Generate dummy audio data for testing
                samples = np.random.normal(0, 0.1, self.config.chunk_size).astype(np.float32)
                self.process_samples(samples)

                time.sleep(interval)

            except Exception as e:
                self._handle_error(e)
                break

    def _apply_noise_reduction(self, samples: np.ndarray) -> np.ndarray:
        """Apply basic noise reduction."""
        # Simple noise gate
        threshold = 0.01
        mask = np.abs(samples) > threshold
        return samples * mask

    def _apply_auto_gain(self, samples: np.ndarray) -> np.ndarray:
        """Apply automatic gain control."""
        if len(samples) == 0:
            return samples

        # Calculate RMS level
        rms = np.sqrt(np.mean(samples ** 2))

        if rms > 0:
            # Target RMS level
            target_rms = 0.3
            gain = target_rms / rms

            # Limit gain to prevent excessive amplification
            gain = np.clip(gain, 0.1, 10.0)

            return samples * gain

        return samples

    def _update_average_processing_time(self, processing_time_ms: float,
    ) -> None:
        """Update average processing time using exponential moving average."""
        alpha = 0.1  # Smoothing factor
        if self.average_processing_time_ms == 0.0:
            self.average_processing_time_ms = processing_time_ms
        else:
            self.average_processing_time_ms = (
                alpha * processing_time_ms +
                (1 - alpha) * self.average_processing_time_ms
            )

    def _change_status(self, new_status: ProcessorStatus,
    ) -> None:
        """Change processor status and notify callback."""
        old_status = self.status
        self.status = new_status

        if self.status_callback and old_status != new_status:
            try:
                self.status_callback(new_status)
            except Exception:
                # Don't let callback errors affect status change
                pass

    def _handle_error(self, error: Exception,
    ) -> None:
        """Handle processing errors."""
        if self.error_callback:
            try:
                self.error_callback(error)
            except Exception:
                # Don't let callback errors cause more errors
                pass

    def is_running(self) -> bool:
        """Check if processor is running."""
        return self.status == ProcessorStatus.RUNNING

    def is_stopped(self) -> bool:
        """Check if processor is stopped."""
        return self.status == ProcessorStatus.STOPPED

    def is_paused(self) -> bool:
        """Check if processor is paused."""
        return self.status == ProcessorStatus.PAUSED

    def has_error(self) -> bool:
        """Check if processor has an error."""
        return self.status == ProcessorStatus.ERROR