"""Audio processor entity for audio visualization."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.audio.value_objects.audio_samples import (
    AudioSampleData,
)
from src_refactored.domain.audio_visualization.value_objects import (
    AudioBuffer,
    WaveformData,
)
from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.ports.concurrency_management_port import ConcurrencyManagementPort
from src_refactored.domain.common.ports.time_management_port import TimeManagementPort


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

    # Ports (injected dependencies) - must come first as they have no defaults
    concurrency_port: ConcurrencyManagementPort
    time_port: TimeManagementPort

    # Configuration
    config: AudioProcessorConfig = field(default_factory=AudioProcessorConfig)

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

    # Internal concurrency identifiers (managed by port)
    _thread_context_id: str | None = field(default=None, init=False)
    _stop_event_id: str | None = field(default=None, init=False)
    _pause_event_id: str | None = field(default=None, init=False)
    _lock_id: str | None = field(default=None, init=False)
    _processing_measurement_id: str | None = field(default=None, init=False)

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
        
        # Initialize concurrency resources
        self._initialize_concurrency_resources()

    def _initialize_concurrency_resources(self) -> None:
        """Initialize concurrency resources through ports."""
        # Create unique IDs for this processor instance
        base_id = str(self.id)
        
        # Create thread context
        result = self.concurrency_port.create_thread_context(f"{base_id}_processor")
        if result.is_success:
            self._thread_context_id = result.value
        
        # Create synchronization events
        stop_result = self.concurrency_port.create_synchronization_event(f"{base_id}_stop")
        if stop_result.is_success:
            self._stop_event_id = stop_result.value
            
        pause_result = self.concurrency_port.create_synchronization_event(f"{base_id}_pause")
        if pause_result.is_success:
            self._pause_event_id = pause_result.value
        
        # Create lock
        lock_result = self.concurrency_port.create_lock(f"{base_id}_lock")
        if lock_result.is_success:
            self._lock_id = lock_result.value

    def start(self) -> bool:
        """Start audio processing."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status in [ProcessorStatus.RUNNING, ProcessorStatus.STARTING]:
                return True

            try:
                self._change_status(ProcessorStatus.STARTING)

                # Reset events through ports
                if self._stop_event_id:
                    self.concurrency_port.clear_event(self._stop_event_id)
                if self._pause_event_id:
                    self.concurrency_port.clear_event(self._pause_event_id)

                # Start background processing task
                if self._thread_context_id:
                    start_result = self.concurrency_port.start_background_task(
                        self._thread_context_id,
                        self._processing_loop,
                        daemon=True,
                    )
                    
                    if start_result.is_success:
                        self._change_status(ProcessorStatus.RUNNING)
                        return True
                    self._change_status(ProcessorStatus.ERROR)
                    return False

                return False

            except Exception as e:
                self._change_status(ProcessorStatus.ERROR)
                self._handle_error(e)
                return False
        finally:
            # Release lock
            self.concurrency_port.release_lock(self._lock_id)

    def stop(self) -> bool:
        """Stop audio processing."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status == ProcessorStatus.STOPPED:
                return True

            try:
                self._change_status(ProcessorStatus.STOPPING)

                # Signal stop through port
                if self._stop_event_id:
                    self.concurrency_port.set_event(self._stop_event_id)

                # Stop background task
                if self._thread_context_id:
                    stop_result = self.concurrency_port.stop_background_task(
                        self._thread_context_id, 
                        timeout_seconds=2.0,
                    )
                    
                    if stop_result.is_success:
                        self._change_status(ProcessorStatus.STOPPED)
                        return True
                    self._change_status(ProcessorStatus.ERROR)
                    return False

                return False

            except Exception as e:
                self._change_status(ProcessorStatus.ERROR)
                self._handle_error(e)
                return False
        finally:
            # Release lock
            self.concurrency_port.release_lock(self._lock_id)

    def pause(self) -> bool:
        """Pause audio processing."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status != ProcessorStatus.RUNNING:
                return False

            if self._pause_event_id:
                self.concurrency_port.set_event(self._pause_event_id)
            
            self._change_status(ProcessorStatus.PAUSED)
            return True
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def resume(self) -> bool:
        """Resume audio processing."""
        if not self._lock_id:
            return False
            
        # Acquire lock
        lock_result = self.concurrency_port.acquire_lock(self._lock_id, timeout_seconds=1.0)
        if not lock_result.is_success or not lock_result.value:
            return False
            
        try:
            if self.status != ProcessorStatus.PAUSED:
                return False

            if self._pause_event_id:
                self.concurrency_port.clear_event(self._pause_event_id)
            
            self._change_status(ProcessorStatus.RUNNING)
            return True
        finally:
            self.concurrency_port.release_lock(self._lock_id)

    def process_samples(self, samples: AudioSampleData) -> WaveformData | None:
        """Process raw audio samples."""
        try:
            # Start timing measurement
            measurement_result = self.time_port.measure_execution_time(f"process_{self.id}")
            measurement_id = measurement_result.value if measurement_result.is_success else None

            # Convert to mono if stereo
            processed_samples = samples
            if samples.channels > 1:
                processed_samples = samples.to_mono()

            # Apply gain
            if self.config.gain_factor != 1.0:
                processed_samples = self._apply_gain(processed_samples, self.config.gain_factor)

            # Apply noise reduction if enabled
            if self.config.enable_noise_reduction:
                processed_samples = self._apply_noise_reduction(processed_samples)

            # Apply auto gain if enabled
            if self.config.enable_auto_gain:
                processed_samples = self._apply_auto_gain(processed_samples)

            # Clip to prevent overflow
            processed_samples = self._clip_samples(processed_samples)

            # Get current timestamp
            timestamp_result = self.time_port.get_current_timestamp_ms()
            timestamp_ms = timestamp_result.value if timestamp_result.is_success and timestamp_result.value is not None else 0.0

            # Create waveform data
            waveform = WaveformData.from_audio_sample_data(processed_samples, timestamp_ms)

            # Update buffer
            if self.buffer:
                self.buffer = self.buffer.add_audio_sample_data(processed_samples, timestamp_ms)

            # Update statistics
            self.total_samples_processed += len(processed_samples.samples)
            self.total_chunks_processed += 1
            
            # Get current time for statistics
            current_time_result = self.time_port.get_current_time()
            if current_time_result.is_success and current_time_result.value:
                # Convert Timestamp to datetime if needed; otherwise leave None
                if hasattr(current_time_result.value, "value") and isinstance(current_time_result.value.value, datetime):
                    self.last_processing_time = current_time_result.value.value
                elif isinstance(current_time_result.value, datetime):
                    self.last_processing_time = current_time_result.value

            # Update average processing time
            if measurement_id:
                processing_time_result = self.time_port.stop_measurement(measurement_id)
                if processing_time_result.is_success and processing_time_result.value is not None:
                    self._update_average_processing_time(processing_time_result.value)

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

        if not (self._stop_event_id and self._pause_event_id):
            return

        # Check for stop event
        stop_result = self.concurrency_port.wait_for_event(self._stop_event_id, timeout_seconds=0.0)
        while not (stop_result.is_success and stop_result.value):
            # Check for pause event
            pause_result = self.concurrency_port.wait_for_event(self._pause_event_id, timeout_seconds=0.0)
            if pause_result.is_success and pause_result.value:
                # Sleep while paused
                self.time_port.sleep(0.1)
                stop_result = self.concurrency_port.wait_for_event(self._stop_event_id, timeout_seconds=0.0)
                continue

            try:
                # No domain-side dummy generation. Concrete implementations should override
                # this method or feed data via application/infrastructure.
                self.time_port.sleep(interval)
            except Exception as e:
                self._handle_error(e)
                break
            
            # Check for stop event again
            stop_result = self.concurrency_port.wait_for_event(self._stop_event_id, timeout_seconds=0.0)

    # Removed dummy audio generation from domain. Provide real data via adapters.

    def _apply_gain(self, samples: AudioSampleData, gain_factor: float) -> AudioSampleData:
        """Apply gain to audio samples."""
        if gain_factor == 1.0:
            return samples
            
        # Apply gain to all samples
        gained_samples = [sample * gain_factor for sample in samples.samples]
        
        return AudioSampleData(
            samples=gained_samples,
            sample_rate=samples.sample_rate,
            channels=samples.channels,
            data_type=samples.data_type,
            timestamp=samples.timestamp,
            duration=samples.duration,
        )

    def _apply_noise_reduction(self, samples: AudioSampleData) -> AudioSampleData:
        """Apply basic noise reduction."""
        # Simple noise gate - threshold below which samples are set to zero
        threshold = 0.01
        
        # Apply noise gate
        filtered_samples = [
            sample if abs(sample) > threshold else 0.0 
            for sample in samples.samples
        ]
        
        return AudioSampleData(
            samples=filtered_samples,
            sample_rate=samples.sample_rate,
            channels=samples.channels,
            data_type=samples.data_type,
            timestamp=samples.timestamp,
            duration=samples.duration,
        )

    def _apply_auto_gain(self, samples: AudioSampleData) -> AudioSampleData:
        """Apply automatic gain control."""
        if len(samples.samples) == 0:
            return samples

        # Calculate RMS level manually
        sum_squares = sum(sample * sample for sample in samples.samples)
        rms = (sum_squares / len(samples.samples)) ** 0.5

        if rms > 0:
            # Target RMS level
            target_rms = 0.3
            gain = target_rms / rms

            # Limit gain to prevent excessive amplification
            gain = max(0.1, min(10.0, gain))

            # Apply gain
            gained_samples = [sample * gain for sample in samples.samples]
            
            return AudioSampleData(
                samples=gained_samples,
                sample_rate=samples.sample_rate,
                channels=samples.channels,
                data_type=samples.data_type,
                timestamp=samples.timestamp,
                duration=samples.duration,
            )

        return samples

    def _clip_samples(self, samples: AudioSampleData) -> AudioSampleData:
        """Clip samples to prevent overflow."""
        # Clip samples to [-1.0, 1.0] range
        clipped_samples = [max(-1.0, min(1.0, sample)) for sample in samples.samples]
        
        return AudioSampleData(
            samples=clipped_samples,
            sample_rate=samples.sample_rate,
            channels=samples.channels,
            data_type=samples.data_type,
            timestamp=samples.timestamp,
            duration=samples.duration,
        )

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