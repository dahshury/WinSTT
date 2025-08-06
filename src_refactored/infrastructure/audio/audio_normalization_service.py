"""Audio Normalization Service.

This module implements the AudioNormalizationService for normalizing
audio data using various methods according to the protocol requirements.
"""

from dataclasses import dataclass
from enum import Enum

import numpy as np
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.audio_visualization.protocols import (
    AudioNormalizationServiceProtocol,
)
from src_refactored.infrastructure.common.logging_service import LoggingService


class NormalizationMethod(Enum):
    """Enumeration of available normalization methods."""
    SPEECH_OPTIMIZED = "speech_optimized"
    RMS_BASED = "rms_based"
    PEAK_BASED = "peak_based"


@dataclass
class NormalizationConfig:
    """Configuration for audio normalization."""
    method: NormalizationMethod = NormalizationMethod.SPEECH_OPTIMIZED
    target_amplitude: float = 0.5
    min_rms_threshold: float = 0.01
    max_amplitude: float = 1.0
    enable_clipping_protection: bool = True
    smoothing_factor: float = 0.1
    noise_floor: float = 0.001


class SpeechNormalizer:
    """Core speech normalization implementation.
    
    Provides advanced speech-optimized normalization with dynamic
    range compression, DC offset removal, and soft clipping.
    """

    def __init__(self, config: NormalizationConfig):
        """Initialize the speech normalizer.
        
        Args:
            config: Normalization configuration
        """
        self.config = config
        self.logger = LoggingService().get_logger("SpeechNormalizer")
        self._last_rms = 0.0
        self._smoothed_amplitude = 0.0

    def normalize_for_speech(self, audio_data: np.ndarray) -> np.ndarray:
        """Normalize audio data specifically for speech visualization.
        
        This method implements the speech normalization algorithm from
        the original voice_visualizer.py, optimized for speech patterns.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            Normalized audio data
        """
        if audio_data is None or len(audio_data) == 0:
            return np.array([])

        try:
            # Remove DC offset
            audio_data = self.remove_dc_offset(audio_data)

            # Calculate RMS for speech detection
            rms = self.calculate_rms(audio_data)

            # Apply smoothing to RMS for stability
            self._last_rms = (
                self.config.smoothing_factor * rms +
                (1 - self.config.smoothing_factor) * self._last_rms
            )

            # Check if audio is above noise floor
            if self._last_rms < self.config.noise_floor:
                return audio_data * 0.1  # Minimal visualization for silence

            # Speech-optimized normalization
            if self._last_rms > self.config.min_rms_threshold:
                # Calculate scaling factor based on RMS
                scale_factor = self.config.target_amplitude / self._last_rms

                # Apply gentle compression for speech dynamics
                if scale_factor > 2.0:  # Avoid over-amplification
                    scale_factor = 2.0 + np.log(scale_factor - 1.0)

                # Normalize audio
                normalized = audio_data * scale_factor

                # Apply clipping protection
                if self.config.enable_clipping_protection:
                    normalized = self.apply_soft_clipping(normalized)

                # Update smoothed amplitude for next iteration
                current_max = np.max(np.abs(normalized))
                self._smoothed_amplitude = (
                    self.config.smoothing_factor * current_max +
                    (1 - self.config.smoothing_factor) * self._smoothed_amplitude
                )

                return normalized
            # Low amplitude - apply minimal scaling
            return audio_data * (self.config.target_amplitude / self.config.min_rms_threshold)

        except Exception as e:
            self.logger.exception(f"Error in speech normalization: {e}")
            return audio_data  # Return original data on error

    def calculate_rms(self, audio_data: np.ndarray) -> float:
        """Calculate RMS (Root Mean Square) of audio data.
        
        Args:
            audio_data: Audio data array
            
        Returns:
            RMS value
        """
        if len(audio_data) == 0:
            return 0.0

        # Calculate RMS with numerical stability
        squared = np.square(audio_data.astype(np.float64))
        mean_squared = np.mean(squared)
        rms = np.sqrt(mean_squared)

        return float(rms)

    def apply_soft_clipping(self, audio_data: np.ndarray) -> np.ndarray:
        """Apply soft clipping to prevent harsh distortion.
        
        Args:
            audio_data: Audio data to clip
            
        Returns:
            Soft-clipped audio data
        """
        # Soft clipping using tanh function
        threshold = self.config.max_amplitude * 0.8

        # Apply soft clipping only to values above threshold
        mask = np.abs(audio_data) > threshold
        clipped = audio_data.copy()

        if np.any(mask):
            # Use tanh for smooth clipping
            clipped[mask] = np.sign(audio_data[mask]) * threshold * np.tanh(
                np.abs(audio_data[mask]) / threshold,
            )

        return clipped

    def remove_dc_offset(self, audio_data: np.ndarray) -> np.ndarray:
        """Remove DC offset from audio data.
        
        Args:
            audio_data: Audio data with potential DC offset
            
        Returns:
            Audio data with DC offset removed
        """
        if len(audio_data) == 0:
            return audio_data

        # Calculate and remove mean (DC component)
        dc_offset = np.mean(audio_data)
        return audio_data - dc_offset

    def apply_dynamic_range_compression(
        self,
        audio_data: np.ndarray,
        ratio: float = 2.0,
    ) -> np.ndarray:
        """Apply dynamic range compression for better visualization.
        
        Args:
            audio_data: Audio data to compress
            ratio: Compression ratio (higher = more compression)
            
        Returns:
            Compressed audio data
        """
        if len(audio_data) == 0 or ratio <= 1.0:
            return audio_data

        # Calculate envelope
        envelope = np.abs(audio_data)

        # Apply compression curve
        threshold = self.config.target_amplitude * 0.5
        compressed_envelope = np.where(
            envelope > threshold,
            threshold + (envelope - threshold) / ratio,
            envelope,
        )

        # Maintain original sign
        return np.sign(audio_data) * compressed_envelope

    def get_normalization_stats(self) -> dict:
        """Get current normalization statistics.
        
        Returns:
            Dictionary with normalization stats
        """
        return {
            "last_rms": self._last_rms,
            "smoothed_amplitude": self._smoothed_amplitude,
            "target_amplitude": self.config.target_amplitude,
            "min_rms_threshold": self.config.min_rms_threshold,
            "noise_floor": self.config.noise_floor,
        }

    def reset_state(self) -> None:
        """Reset internal state for new audio session."""
        self._last_rms = 0.0
        self._smoothed_amplitude = 0.0
        self.logger.debug("Reset normalization state")


class NormalizationProcessor(QObject):
    """Processor for audio normalization with signal support.
    
    Provides high-level interface for audio normalization with
    PyQt signal integration for real-time processing.
    """

    # Signals for normalization events
    normalization_completed = pyqtSignal(np.ndarray, dict)  # normalized_data, stats
    normalization_failed = pyqtSignal(str)  # error_message
    stats_updated = pyqtSignal(dict)  # normalization_stats

    def __init__(self, config: NormalizationConfig, parent: QObject | None = None):
        """Initialize the normalization processor.
        
        Args:
            config: Normalization configuration
            parent: Parent QObject
        """
        super().__init__(parent)
        self.config = config
        self.normalizer = SpeechNormalizer(config)
        self.logger = LoggingService().get_logger("NormalizationProcessor")

    def process_audio(self, audio_data: np.ndarray) -> bool:
        """Process audio data with normalization.
        
        Args:
            audio_data: Raw audio data
            
        Returns:
            True if processing successful, False otherwise
        """
        try:
            # Apply normalization
            normalized_data = self.normalizer.normalize_for_speech(audio_data)

            # Get current stats
            stats = self.normalizer.get_normalization_stats()

            # Emit signals
            self.normalization_completed.emit(normalized_data, stats)
            self.stats_updated.emit(stats)

            return True

        except Exception as e:
            error_msg = f"Normalization processing failed: {e}"
            self.logger.exception(error_msg)
            self.normalization_failed.emit(error_msg)
            return False

    def update_config(self, new_config: NormalizationConfig) -> None:
        """Update normalization configuration.
        
        Args:
            new_config: New normalization configuration
        """
        self.config = new_config
        self.normalizer = SpeechNormalizer(new_config)
        self.logger.info("Updated normalization configuration")

    def reset_processor(self) -> None:
        """Reset processor state."""
        self.normalizer.reset_state()
        self.logger.debug("Reset normalization processor")

    def get_current_stats(self) -> dict:
        """Get current normalization statistics.
        
        Returns:
            Current normalization stats
        """
        return self.normalizer.get_normalization_stats()


class AudioNormalizationService(AudioNormalizationServiceProtocol):
    """Service for audio normalization with domain integration.
    
    Provides high-level interface for audio normalization that integrates
    with domain entities and application use cases.
    
    Consolidated from:
    - src/ui/voice_visualizer.py (speech-optimized normalization)
    - Original audio normalization service (RMS-based normalization)
    """

    def __init__(self, logger_service: LoggingService | None = None):
        """Initialize the audio normalization service.
        
        Args:
            logger_service: Optional logger service
        """
        self.logger_service = logger_service or LoggingService()
        self.logger = self.logger_service.get_logger("AudioNormalizationService")

        # Default configuration for speech
        self.default_config = NormalizationConfig(
            method=NormalizationMethod.SPEECH_OPTIMIZED,
            target_amplitude=0.5,
            min_rms_threshold=0.01,
            max_amplitude=1.0,
            enable_clipping_protection=True,
            smoothing_factor=0.1,
            noise_floor=0.001,
        )

        self.processor = NormalizationProcessor(self.default_config)

    def normalize_for_speech(self, data: np.ndarray, scaling_factor: float = 0.3) -> np.ndarray:
        """Normalize audio data optimized for speech.
        
        Args:
            data: Audio data array
            scaling_factor: Scaling factor for normalization
            
        Returns:
            Normalized audio data
        """
        try:
            if len(data) == 0:
                return data
                
            # Use advanced speech normalizer
            config = NormalizationConfig(
                method=NormalizationMethod.SPEECH_OPTIMIZED,
                target_amplitude=scaling_factor,
                min_rms_threshold=0.01,
                max_amplitude=1.0,
                enable_clipping_protection=True,
                smoothing_factor=0.1,
                noise_floor=0.001,
            )
            
            normalizer = SpeechNormalizer(config)
            return normalizer.normalize_for_speech(data)
                
        except Exception as e:
            msg = f"Failed to normalize for speech: {e}"
            raise ValueError(msg)

    def normalize_rms_based(self, data: np.ndarray, target_rms: float = 0.1) -> np.ndarray:
        """Normalize audio data based on RMS.
        
        Args:
            data: Audio data array
            target_rms: Target RMS value
            
        Returns:
            RMS-normalized audio data
        """
        try:
            if len(data) == 0:
                return data
                
            # Calculate current RMS
            rms = np.sqrt(np.mean(np.square(data)))
            
            if rms > 0:
                # Normalize to target RMS
                normalized = data * (target_rms / rms)
                
                # Clip to prevent overflow
                return np.clip(normalized, -1.0, 1.0)
            return data
                
        except Exception as e:
            msg = f"Failed to normalize based on RMS: {e}"
            raise ValueError(msg)

    def normalize_peak_based(self, data: np.ndarray, target_peak: float = 1.0) -> np.ndarray:
        """Normalize audio data based on peak value.
        
        Args:
            data: Audio data array
            target_peak: Target peak value
            
        Returns:
            Peak-normalized audio data
        """
        try:
            if len(data) == 0:
                return data
                
            # Find peak value
            peak = np.max(np.abs(data))
            
            if peak > 0:
                # Normalize to target peak
                normalized = data * (target_peak / peak)
                
                # Clip to prevent overflow
                return np.clip(normalized, -1.0, 1.0)
            return data
                
        except Exception as e:
            msg = f"Failed to normalize based on peak: {e}"
            raise ValueError(msg)

    def calculate_rms(self, data: np.ndarray) -> float:
        """Calculate RMS value of audio data.
        
        Args:
            data: Audio data array
            
        Returns:
            RMS value
        """
        try:
            if len(data) == 0:
                return 0.0
                
            return float(np.sqrt(np.mean(np.square(data))))
            
        except Exception as e:
            msg = f"Failed to calculate RMS: {e}"
            raise ValueError(msg)

    def apply_dynamic_range_compression(
        self,
        audio_data: np.ndarray,
        ratio: float = 2.0,
    ) -> np.ndarray:
        """Apply dynamic range compression.
        
        Args:
            audio_data: Audio data to compress
            ratio: Compression ratio
            
        Returns:
            Compressed audio data
        """
        normalizer = SpeechNormalizer(self.default_config)
        return normalizer.apply_dynamic_range_compression(audio_data, ratio)

    def remove_dc_offset(self, audio_data: np.ndarray) -> np.ndarray:
        """Remove DC offset from audio data.
        
        Args:
            audio_data: Audio data with potential DC offset
            
        Returns:
            Audio data with DC offset removed
        """
        normalizer = SpeechNormalizer(self.default_config)
        return normalizer.remove_dc_offset(audio_data)

    def create_processor(self, config: NormalizationConfig | None = None) -> NormalizationProcessor:
        """Create a new normalization processor.
        
        Args:
            config: Optional normalization configuration
            
        Returns:
            Normalization processor instance
        """
        processor_config = config or self.default_config
        processor = NormalizationProcessor(processor_config)

        self.logger.info(f"Created normalization processor with method: {processor_config.method.value}")
        return processor

    def get_default_config(self) -> NormalizationConfig:
        """Get default normalization configuration.
        
        Returns:
            Default normalization configuration
        """
        return self.default_config

    def create_config_for_speech(
        self,
        target_amplitude: float = 0.5,
        sensitivity: float = 0.1,
    ) -> NormalizationConfig:
        """Create optimized configuration for speech processing.
        
        Args:
            target_amplitude: Target amplitude for normalization
            sensitivity: Sensitivity factor (lower = more sensitive)
            
        Returns:
            Speech-optimized normalization configuration
        """
        return NormalizationConfig(
            method=NormalizationMethod.SPEECH_OPTIMIZED,
            target_amplitude=target_amplitude,
            min_rms_threshold=sensitivity,
            max_amplitude=1.0,
            enable_clipping_protection=True,
            smoothing_factor=0.1,
            noise_floor=sensitivity * 0.1,
        )

    def cleanup(self) -> None:
        """Clean up service resources."""
        if hasattr(self.processor, "reset_processor"):
            self.processor.reset_processor()

        self.logger.info("Cleaned up audio normalization service")
