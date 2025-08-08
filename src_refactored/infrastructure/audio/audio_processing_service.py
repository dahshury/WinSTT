"""Audio Processing Services.

This module provides audio processing services and adapters that implement
the processing protocols expected by different subsystems (recording, VAD,
and playback).
"""


import numpy as np

from src_refactored.infrastructure.audio.audio_recording_service import (
    AudioProcessingServiceProtocol as RecordingProcessingProtocol,
)
from src_refactored.infrastructure.audio.vad_service import (
    AudioProcessingServiceProtocol as VADProcessingProtocol,
)
from src_refactored.infrastructure.audio.audio_playback_service import (
    AudioProcessingServiceProtocol as PlaybackProcessingProtocol,
)


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


class VADAudioProcessingService(VADProcessingProtocol):
    """Processing implementation for the VAD pipeline."""

    def preprocess_audio(
        self, audio_data: np.ndarray, sample_rate: int, target_rate: int,
    ) -> tuple[bool, np.ndarray, str | None]:
        try:
            if sample_rate == target_rate or len(audio_data) == 0:
                return True, audio_data.astype(np.float32, copy=False), None

            # Simple linear resampling
            duration = len(audio_data) / float(sample_rate)
            target_length = int(duration * target_rate)
            if target_length <= 0:
                return True, audio_data.astype(np.float32, copy=False), None
            x_old = np.linspace(0.0, 1.0, num=len(audio_data), endpoint=False, dtype=np.float32)
            x_new = np.linspace(0.0, 1.0, num=target_length, endpoint=False, dtype=np.float32)
            resampled = np.interp(x_new, x_old, audio_data).astype(np.float32, copy=False)
            return True, resampled, None
        except Exception as e:
            return False, np.array([], dtype=np.float32), str(e)

    def normalize_audio(self, audio_data: np.ndarray) -> np.ndarray:
        if len(audio_data) == 0:
            return audio_data.astype(np.float32, copy=False)
        max_abs = float(np.max(np.abs(audio_data)))
        if max_abs <= 0.0:
            return audio_data.astype(np.float32, copy=False)
        return (audio_data.astype(np.float32) / max_abs).clip(-1.0, 1.0)

    def apply_windowing(self, audio_data: np.ndarray, window_size: int, overlap: float,
    ) -> list[np.ndarray]:
        if window_size <= 0 or len(audio_data) == 0:
            return []
        step = max(1, int(window_size * (1.0 - max(0.0, min(overlap, 0.99)))))
        windows: list[np.ndarray] = []
        for start in range(0, max(0, len(audio_data) - window_size + 1), step):
            windows.append(audio_data[start:start + window_size])
        return windows

    def calculate_energy(self, audio_data: np.ndarray) -> float:
        if len(audio_data) == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(audio_data))))


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
        ok, resampled, err = VADAudioProcessingService().preprocess_audio(data, source_rate, target_rate)
        return ok, resampled, err
