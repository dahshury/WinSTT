"""Audio Processing Services.

This module provides audio processing services and adapters that implement
the processing protocols expected by different subsystems (recording, VAD,
and playback).
"""


import numpy as np

from src.infrastructure.audio.audio_playback_service import (
    AudioProcessingServiceProtocol as PlaybackProcessingProtocol,
)
from src.infrastructure.audio.audio_recording_service import (
    AudioProcessingServiceProtocol as RecordingProcessingProtocol,
)
# VAD-specific processing protocol removed; onnx_asr handles VAD internally.


class AudioProcessingService(RecordingProcessingProtocol):
    """Service for processing audio data."""

    def apply_noise_reduction(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply noise reduction to audio data."""
        try:
            if len(data) == 0:
                return True, data, None
            
            # Simple noise gate
            threshold = 0.01
            mask = np.abs(data) > threshold
            processed_data = data * mask
            
            return True, processed_data, None
            
        except Exception as e:
            return False, None, f"Failed to apply noise reduction: {e}"

    def apply_auto_gain(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply automatic gain control."""
        try:
            if len(data) == 0:
                return True, data, None
            
            # Calculate RMS
            rms = np.sqrt(np.mean(np.square(data)))
            
            if rms > 0:
                # Normalize to target RMS
                target_rms = 0.1
                gain = target_rms / rms
                gain = min(gain, 10.0)  # Limit maximum gain
                
                processed_data = data * gain
                processed_data = np.clip(processed_data, -1.0, 1.0)
                
                return True, processed_data, None
            return True, data, None
                
        except Exception as e:
            return False, None, f"Failed to apply auto gain: {e}"

    def detect_silence(self, data: np.ndarray, threshold: float) -> tuple[bool, bool, str | None]:
        """Detect silence in audio data."""
        try:
            if len(data) == 0:
                return True, True, None
            
            # Calculate RMS
            rms = np.sqrt(np.mean(np.square(data)))
            
            is_silence = rms < threshold
            
            return True, is_silence, None
            
        except Exception as e:
            return False, False, f"Failed to detect silence: {e}"

    def calculate_levels(self, data: np.ndarray) -> tuple[bool, float, float, str | None]:
        """Calculate RMS and peak levels."""
        try:
            if len(data) == 0:
                return True, 0.0, 0.0, None
            
            rms = np.sqrt(np.mean(np.square(data)))
            peak = np.max(np.abs(data))
            
            return True, rms, peak, None
            
        except Exception as e:
            return False, 0.0, 0.0, f"Failed to calculate levels: {e}"


# Removed VADAudioProcessingService; VAD functionality is provided by onnx_asr


class PlaybackAudioProcessingService(PlaybackProcessingProtocol):
    """Processing implementation for playback effects/transformations."""

    def apply_volume(self, data: np.ndarray, volume: float, mode: str = "linear",
    ) -> tuple[bool, np.ndarray | None, str | None]:
        try:
            if mode != "linear":
                # For now only linear scaling is supported
                pass
            return True, (data.astype(np.float32) * float(volume)).clip(-1.0, 1.0), None
        except Exception as e:
            return False, None, str(e)

    def apply_speed_change(self, data: np.ndarray, speed: float,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        try:
            if speed <= 0:
                return False, None, "Speed must be positive"
            if speed == 1.0:
                return True, data, None
            # Resample by factor 1/speed
            new_len = max(1, int(len(data) / speed))
            x_old = np.linspace(0.0, 1.0, num=len(data), endpoint=False, dtype=np.float32)
            x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False, dtype=np.float32)
            changed = np.interp(x_new, x_old, data).astype(np.float32, copy=False)
            return True, changed, None
        except Exception as e:
            return False, None, str(e)

    def apply_equalizer(self, data: np.ndarray, bands: list[float],
    ) -> tuple[bool, np.ndarray | None, str | None]:
        # Placeholder: return data unchanged
        return True, data, None

    def apply_crossfade(self, data1: np.ndarray, data2: np.ndarray, duration: float, sample_rate: int,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        try:
            fade_samples = max(1, int(duration * sample_rate))
            a = data1.astype(np.float32)
            b = data2.astype(np.float32)
            a_tail = a[-fade_samples:] if len(a) >= fade_samples else a
            b_head = b[:fade_samples] if len(b) >= fade_samples else b
            t = np.linspace(0.0, 1.0, num=min(len(a_tail), len(b_head)), endpoint=False, dtype=np.float32)
            cross = (a_tail[: len(t)] * (1.0 - t)) + (b_head[: len(t)] * t)
            combined = np.concatenate([a[:-len(t)] if len(a) > len(t) else np.array([], dtype=np.float32), cross, b[len(t):]])
            return True, combined.clip(-1.0, 1.0), None
        except Exception as e:
            return False, None, str(e)

    def resample_audio(self, data: np.ndarray, source_rate: int, target_rate: int,
    ) -> tuple[bool, np.ndarray | None, str | None]:
        try:
            if source_rate == target_rate or len(data) == 0:
                return True, data.astype(np.float32, copy=False), None
            duration = len(data) / float(source_rate)
            target_length = int(duration * target_rate)
            if target_length <= 0:
                return True, data.astype(np.float32, copy=False), None
            x_old = np.linspace(0.0, 1.0, num=len(data), endpoint=False, dtype=np.float32)
            x_new = np.linspace(0.0, 1.0, num=target_length, endpoint=False, dtype=np.float32)
            resampled = np.interp(x_new, x_old, data).astype(np.float32, copy=False)
            return True, resampled, None
        except Exception as e:
            return False, None, str(e)
