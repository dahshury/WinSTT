"""Audio Service Factory.

This module provides a factory for creating properly configured audio services
with all their dependencies.
"""

from typing import cast

from .audio_device_service import AudioDeviceService
from .audio_file_service import AudioFileService
from .audio_playback_service import (
    AudioDeviceServiceProtocol as PlaybackDeviceProtocol,
    AudioFileServiceProtocol as PlaybackFileProtocol,
    AudioPlaybackService,
    AudioProcessingServiceProtocol as PlaybackProcessingProtocol,
    AudioStreamServiceProtocol as PlaybackStreamProtocol,
)
from .audio_processing_service import (
    AudioProcessingService,
    PlaybackAudioProcessingService,
    VADAudioProcessingService,
)
from .audio_recording_service import AudioRecordingService
from .audio_stream_service import AudioStreamService
from .audio_validation_service import AudioValidationService
from .logger_service import LoggerService
from .playback_validation_service import PlaybackValidationService
from .progress_tracking_service import ProgressTrackingService
from .pyaudio_service import PyAudioService
from .recording_validation_service import RecordingValidationService
from .vad_calibration_service import VADCalibrationService
from .vad_model_service import VADModelService
from .vad_service import VADService
from .vad_smoothing_service import VADSmoothingService
from .vad_validation_service import VADValidationService


class AudioServiceFactory:
    """Factory for creating audio services with proper dependencies."""

    @staticmethod
    def create_audio_recording_service() -> AudioRecordingService:
        """Create a properly configured AudioRecordingService."""
        # Create shared services
        device_service = AudioDeviceService()
        stream_service = AudioStreamService()
        file_service = AudioFileService()
        processing_service = AudioProcessingService()
        validation_service = RecordingValidationService()
        progress_service = ProgressTrackingService()
        logger_service = LoggerService()

        return AudioRecordingService(
            device_service=device_service,
            stream_service=stream_service,
            file_service=file_service,
            processing_service=processing_service,
            validation_service=validation_service,
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    @staticmethod
    def create_audio_playback_service() -> AudioPlaybackService:
        """Create a properly configured AudioPlaybackService."""
        # Create shared services
        device_service = AudioDeviceService()
        stream_service = AudioStreamService()
        file_service = AudioFileService()
        processing_service = AudioProcessingService()
        validation_service = PlaybackValidationService()
        progress_service = ProgressTrackingService()
        logger_service = LoggerService()

        return AudioPlaybackService(
            device_service=cast(PlaybackDeviceProtocol, device_service),
            stream_service=cast(PlaybackStreamProtocol, stream_service),
            file_service=cast(PlaybackFileProtocol, file_service),
            processing_service=cast(PlaybackProcessingProtocol, processing_service),
            validation_service=validation_service,
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    @staticmethod
    def create_vad_service() -> VADService:
        """Create a properly configured VADService."""
        # Create VAD-specific services
        model_service = VADModelService()
        audio_processing_service = VADAudioProcessingService()
        validation_service = VADValidationService()
        calibration_service = VADCalibrationService()
        smoothing_service = VADSmoothingService()
        progress_service = ProgressTrackingService()
        logger_service = LoggerService()

        return VADService(
            model_service=model_service,
            audio_processing_service=audio_processing_service,
            validation_service=validation_service,
            calibration_service=calibration_service,
            smoothing_service=smoothing_service,
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    @staticmethod
    def create_pyaudio_service() -> PyAudioService:
        """Create a properly configured PyAudioService."""
        # Create PyAudio-specific services
        validation_service = AudioValidationService()
        device_management_service = AudioDeviceService()
        stream_management_service = AudioStreamService()
        audio_data_service = PlaybackAudioProcessingService()
        progress_service = ProgressTrackingService()
        logger_service = LoggerService()

        from .pyaudio_service import (
            AudioValidationServiceProtocol as P_Validation,
            DeviceManagementServiceProtocol as P_Device,
            StreamManagementServiceProtocol as P_Stream,
            AudioDataServiceProtocol as P_Data,
        )
        return PyAudioService(
            validation_service=cast(P_Validation, validation_service),
            device_management_service=cast(P_Device, device_management_service),
            stream_management_service=cast(P_Stream, stream_management_service),
            audio_data_service=cast(P_Data, audio_data_service),
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    @staticmethod
    def create_all_services():
        """Create all audio services with proper dependencies."""
        return {
            "recording_service": AudioServiceFactory.create_audio_recording_service(),
            "playback_service": AudioServiceFactory.create_audio_playback_service(),
            "vad_service": AudioServiceFactory.create_vad_service(),
            "pyaudio_service": AudioServiceFactory.create_pyaudio_service(),
        }
