"""Audio Normalization Service for speech visualization.

This module provides audio normalization services for speech visualization,
including RMS-based normalization, auto-gain control, and speech-specific
scaling. Extracted from voice_visualizer.py normalization logic.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

import numpy as np

from src_refactored.domain.audio.value_objects.audio_samples import AudioSampleData
from src_refactored.infrastructure.system.logging_service import LoggingService


class NormalizationMethod(Enum):
    """Audio normalization methods."""
    RMS = "rms"
    PEAK = "peak"
    SPEECH_OPTIMIZED = "speech_optimized"
    AUTO_GAIN = "auto_gain"


@dataclass
class NormalizationConfig:
    """Configuration for audio normalization."""
    method: NormalizationMethod = NormalizationMethod.SPEECH_OPTIMIZED
    target_rms: float = 0.3
    target_peak: float = 0.7
    speech_scale_factor: float = 2.5
    speech_fixed_scale: float = 0.5
    speech_clip_range: tuple[float, float] = (-0.7, 0.7)
    noise_gate_threshold: float = 0.01
    auto_gain_max_ratio: float = 10.0
    auto_gain_min_ratio: float = 0.1

    def validate(self) -> None:
        """Validate normalization configuration."""
        if self.target_rms <= 0:
            msg = "Target RMS must be positive"
            raise ValueError(msg)
        if self.target_peak <= 0:
            msg = "Target peak must be positive"
            raise ValueError(msg)
        if self.speech_scale_factor <= 0:
            msg = "Speech scale factor must be positive"
            raise ValueError(msg)
        if self.speech_fixed_scale <= 0:
            msg = "Speech fixed scale must be positive"
            raise ValueError(msg)
        if self.noise_gate_threshold < 0:
            msg = "Noise gate threshold must be non-negative"
            raise ValueError(msg)
        if self.auto_gain_max_ratio <= self.auto_gain_min_ratio:
            msg = "Auto gain max ratio must be greater than min ratio"
            raise ValueError(msg)


class AudioNormalizationServiceProtocol(Protocol):
    """Protocol for audio normalization service."""

    def normalize_audio(self, audio_data: AudioSampleData, config: NormalizationConfig) -> AudioSampleData:
        """Normalize audio data according to configuration."""
        ...

    def apply_speech_normalization(self, audio_data: AudioSampleData) -> AudioSampleData:
        """Apply speech-optimized normalization."""
        ...

    def apply_rms_normalization(self, audio_data: AudioSampleData, target_rms: float) -> AudioSampleData:
        """Apply RMS-based normalization."""
        ...

    def apply_peak_normalization(self, audio_data: AudioSampleData, target_peak: float) -> AudioSampleData:
        """Apply peak-based normalization."""
        ...

    def apply_auto_gain(self, audio_data: AudioSampleData, config: NormalizationConfig) -> AudioSampleData:
        """Apply automatic gain control."""
        ...

    def apply_noise_gate(self, audio_data: AudioSampleData, threshold: float) -> AudioSampleData:
        """Apply noise gate to reduce background noise."""
        ...


class NormalizationProcessor:
    """Core normalization processing logic."""

    @staticmethod
    def calculate_rms(samples: Sequence[float]) -> float:
        """Calculate RMS (Root Mean Square) of audio samples."""
        if not samples:
            return 0.0
        return np.sqrt(np.mean(np.square(samples)))

    @staticmethod
    def calculate_peak(samples: Sequence[float]) -> float:
        """Calculate peak amplitude of audio samples."""
        if not samples:
            return 0.0
        return max(abs(sample) for sample in samples)

    @staticmethod
    def apply_gain(samples: Sequence[float], gain_factor: float) -> list[float]:
        """Apply gain factor to audio samples."""
        if gain_factor == 1.0:
            return list(samples)
        return [float(sample) * gain_factor for sample in samples]

    @staticmethod
    def clip_samples(samples: Sequence[float], min_val: float = -1.0, max_val: float = 1.0) -> list[float]:
        """Clip samples to prevent overflow."""
        return [max(min_val, min(max_val, sample)) for sample in samples]

    @staticmethod
    def apply_noise_gate(samples: Sequence[float], threshold: float) -> list[float]:
        """Apply noise gate to reduce background noise."""
        return [sample if abs(sample) > threshold else 0.0 for sample in samples]


class SpeechNormalizer:
    """Specialized normalizer for speech visualization."""

    def __init__(self, config: NormalizationConfig):
        """Initialize speech normalizer."""
        self.config = config

    def normalize_speech(self, audio_data: AudioSampleData) -> AudioSampleData:
        """Apply speech-optimized normalization for visualization."""
        if not audio_data.samples:
            return audio_data

        # Calculate RMS
        rms = NormalizationProcessor.calculate_rms(audio_data.samples)

        if rms > 0:
            # Apply speech-specific scaling
            normalized_samples = self._apply_speech_scaling(list(audio_data.samples), rms)
            
            # Apply noise gate
            normalized_samples = NormalizationProcessor.apply_noise_gate(
                normalized_samples, 
                self.config.noise_gate_threshold,
            )
            
            # Clip to prevent extreme values
            normalized_samples = NormalizationProcessor.clip_samples(
                normalized_samples,
                self.config.speech_clip_range[0],
                self.config.speech_clip_range[1],
            )
        else:
            # Return zeros for silence
            normalized_samples = [0.0] * len(audio_data.samples)

        return AudioSampleData(
            samples=normalized_samples,
            sample_rate=audio_data.sample_rate,
            channels=audio_data.channels,
            data_type=audio_data.data_type,
            timestamp=audio_data.timestamp,
            duration=audio_data.duration,
        )

    def _apply_speech_scaling(self, samples: list[float], rms: float) -> list[float]:
        """Apply speech-specific scaling factors."""
        # Apply RMS-based normalization with speech scale factor
        normalized = NormalizationProcessor.apply_gain(samples, 1.0 / (rms * self.config.speech_scale_factor))
        
        # Apply fixed scale for consistent visualization
        return NormalizationProcessor.apply_gain(normalized, self.config.speech_fixed_scale)
        


class AudioNormalizationService:
    """Service for audio normalization operations."""

    def __init__(self, logger_service: LoggingService | None = None):
        """Initialize audio normalization service."""
        self.logger_service = logger_service or LoggingService()
        self.logger = self.logger_service.get_logger("AudioNormalizationService")
        self.processor = NormalizationProcessor()

    def normalize_audio(self, audio_data: AudioSampleData, config: NormalizationConfig) -> AudioSampleData:
        """Normalize audio data according to configuration."""
        try:
            config.validate()
            
            if config.method == NormalizationMethod.SPEECH_OPTIMIZED:
                return self.apply_speech_normalization(audio_data)
            if config.method == NormalizationMethod.RMS:
                return self.apply_rms_normalization(audio_data, config.target_rms)
            if config.method == NormalizationMethod.PEAK:
                return self.apply_peak_normalization(audio_data, config.target_peak)
            if config.method == NormalizationMethod.AUTO_GAIN:
                return self.apply_auto_gain(audio_data, config)
            self.logger.warning(f"Unknown normalization method: {config.method}")
            return audio_data
                
        except Exception as e:
            self.logger.exception(f"Error normalizing audio: {e}")
            return audio_data

    def apply_speech_normalization(self, audio_data: AudioSampleData) -> AudioSampleData:
        """Apply speech-optimized normalization."""
        config = NormalizationConfig()  # Use default speech config
        normalizer = SpeechNormalizer(config)
        return normalizer.normalize_speech(audio_data)

    def apply_rms_normalization(self, audio_data: AudioSampleData, target_rms: float) -> AudioSampleData:
        """Apply RMS-based normalization."""
        if not audio_data.samples:
            return audio_data

        current_rms = self.processor.calculate_rms(audio_data.samples)
        
        if current_rms > 0:
            gain_factor = target_rms / current_rms
            normalized_samples = self.processor.apply_gain(audio_data.samples, gain_factor)
            normalized_samples = self.processor.clip_samples(normalized_samples)
        else:
            normalized_samples = list(audio_data.samples)

        return AudioSampleData(
            samples=normalized_samples,
            sample_rate=audio_data.sample_rate,
            channels=audio_data.channels,
            data_type=audio_data.data_type,
            timestamp=audio_data.timestamp,
            duration=audio_data.duration,
        )

    def apply_peak_normalization(self, audio_data: AudioSampleData, target_peak: float) -> AudioSampleData:
        """Apply peak-based normalization."""
        if not audio_data.samples:
            return audio_data

        current_peak = self.processor.calculate_peak(audio_data.samples)
        
        if current_peak > 0:
            gain_factor = target_peak / current_peak
            normalized_samples = self.processor.apply_gain(audio_data.samples, gain_factor)
            normalized_samples = self.processor.clip_samples(normalized_samples)
        else:
            normalized_samples = list(audio_data.samples)

        return AudioSampleData(
            samples=normalized_samples,
            sample_rate=audio_data.sample_rate,
            channels=audio_data.channels,
            data_type=audio_data.data_type,
            timestamp=audio_data.timestamp,
            duration=audio_data.duration,
        )

    def apply_auto_gain(self, audio_data: AudioSampleData, config: NormalizationConfig) -> AudioSampleData:
        """Apply automatic gain control."""
        if not audio_data.samples:
            return audio_data

        current_rms = self.processor.calculate_rms(audio_data.samples)
        
        if current_rms > 0:
            # Calculate gain to reach target RMS
            gain_factor = config.target_rms / current_rms
            
            # Limit gain to prevent excessive amplification
            gain_factor = max(config.auto_gain_min_ratio, min(config.auto_gain_max_ratio, gain_factor))
            
            normalized_samples = self.processor.apply_gain(audio_data.samples, gain_factor)
            normalized_samples = self.processor.clip_samples(normalized_samples)
        else:
            normalized_samples = list(audio_data.samples)

        return AudioSampleData(
            samples=normalized_samples,
            sample_rate=audio_data.sample_rate,
            channels=audio_data.channels,
            data_type=audio_data.data_type,
            timestamp=audio_data.timestamp,
            duration=audio_data.duration,
        )

    def apply_noise_gate(self, audio_data: AudioSampleData, threshold: float) -> AudioSampleData:
        """Apply noise gate to reduce background noise."""
        if not audio_data.samples:
            return audio_data

        gated_samples = self.processor.apply_noise_gate(audio_data.samples, threshold)

        return AudioSampleData(
            samples=gated_samples,
            sample_rate=audio_data.sample_rate,
            channels=audio_data.channels,
            data_type=audio_data.data_type,
            timestamp=audio_data.timestamp,
            duration=audio_data.duration,
        )

