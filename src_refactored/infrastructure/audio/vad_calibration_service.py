"""VAD Calibration Service.

This module implements the VADCalibrationService for calibrating VAD operations.
"""


import numpy as np

from src_refactored.domain.audio.value_objects import (
    AudioChunk,
    CalibrationResult,
    VADConfiguration,
)

from .vad_service import CalibrationServiceProtocol


class VADCalibrationService(CalibrationServiceProtocol):
    """Service for calibrating VAD operations."""

    def __init__(self):
        """Initialize the VAD calibration service."""

    def calibrate_threshold(self, audio_chunks: list[AudioChunk], config: VADConfiguration,
    ) -> CalibrationResult:
        """Calibrate VAD threshold based on audio chunks."""
        try:
            if not audio_chunks:
                return CalibrationResult(
                    calibrated=False,
                    error_message="No audio chunks provided for calibration",
                )

            # Extract audio data from chunks
            all_audio_data = []
            for chunk in audio_chunks:
                if hasattr(chunk, "data") and chunk.data is not None:
                    all_audio_data.extend(chunk.data)

            if not all_audio_data:
                return CalibrationResult(
                    calibrated=False,
                    error_message="No valid audio data found in chunks",
                )

            # Convert to numpy array
            audio_array = np.array(all_audio_data)

            # Calculate noise level (RMS of the entire audio)
            noise_level = np.sqrt(np.mean(audio_array**2))

            # Calculate speech level (95th percentile of RMS values)
            frame_size = config.frame_size
            hop_size = config.hop_size
            
            rms_values = []
            for i in range(0, len(audio_array) - frame_size, hop_size):
                frame = audio_array[i:i + frame_size]
                rms = np.sqrt(np.mean(frame**2))
                rms_values.append(rms)

            speech_level = np.percentile(rms_values, 95) if rms_values else noise_level

            # Calculate optimal threshold
            # Use a value between noise and speech levels
            optimal_threshold = noise_level + (speech_level - noise_level) * 0.3

            # Ensure threshold is within valid range
            optimal_threshold = max(0.0, min(1.0, optimal_threshold))

            return CalibrationResult(
                calibrated=True,
                noise_level=noise_level,
                speech_level=speech_level,
                optimal_threshold=optimal_threshold,
                calibration_samples=len(audio_chunks),
            )

        except Exception as e:
            return CalibrationResult(
                calibrated=False,
                error_message=str(e),
            )

    def analyze_noise_level(self, audio_chunks: list[AudioChunk]) -> float:
        """Analyze noise level from audio chunks."""
        try:
            if not audio_chunks:
                return 0.0

            # Extract all audio data
            all_audio_data = []
            for chunk in audio_chunks:
                if hasattr(chunk, "data") and chunk.data is not None:
                    all_audio_data.extend(chunk.data)

            if not all_audio_data:
                return 0.0

            # Calculate RMS of all audio data
            audio_array = np.array(all_audio_data)
            noise_level = np.sqrt(np.mean(audio_array**2))

            return float(noise_level)

        except Exception:
            return 0.0

    def analyze_speech_level(self, audio_chunks: list[AudioChunk]) -> float:
        """Analyze speech level from audio chunks."""
        try:
            if not audio_chunks:
                return 0.0

            # Extract all audio data
            all_audio_data = []
            for chunk in audio_chunks:
                if hasattr(chunk, "data") and chunk.data is not None:
                    all_audio_data.extend(chunk.data)

            if not all_audio_data:
                return 0.0

            # Calculate 95th percentile of RMS values
            audio_array = np.array(all_audio_data)
            frame_size = 1024  # Default frame size
            hop_size = 512     # Default hop size
            
            rms_values = []
            for i in range(0, len(audio_array) - frame_size, hop_size):
                frame = audio_array[i:i + frame_size]
                rms = np.sqrt(np.mean(frame**2))
                rms_values.append(rms)

            speech_level = np.percentile(rms_values, 95) if rms_values else 0.0

            return float(speech_level)

        except Exception:
            return 0.0
