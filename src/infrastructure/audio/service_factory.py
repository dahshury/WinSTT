"""Audio Service Factory.

This module provides a factory for creating properly configured audio services
with all their dependencies.
"""

from typing import cast

from .audio_device_service import AudioDeviceService
from .audio_file_service import AudioFileService
from .audio_playback_service import AudioPlaybackService
from .audio_playback_service import AudioDeviceServiceProtocol as PlaybackDeviceProtocol
from .audio_playback_service import AudioFileServiceProtocol as PlaybackFileProtocol
from .audio_playback_service import AudioProcessingServiceProtocol as PlaybackProcessingProtocol
from .audio_playback_service import AudioStreamServiceProtocol as PlaybackStreamProtocol
from .audio_processing_service import AudioProcessingService, PlaybackAudioProcessingService
from .audio_recording_service import AudioRecordingService
from .audio_stream_service import AudioStreamService
from .audio_validation_service import AudioValidationService
from .logger_service import LoggerService
from .playback_validation_service import PlaybackValidationService
from .progress_tracking_service import ProgressTrackingService
from .pyaudio_service import PyAudioService
from .recording_validation_service import RecordingValidationService
# Note: Legacy VAD pipeline is deprecated; onnx_asr handles VAD.


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
            device_service=cast("PlaybackDeviceProtocol", device_service),
            stream_service=cast("PlaybackStreamProtocol", stream_service),
            file_service=cast("PlaybackFileProtocol", file_service),
            processing_service=cast("PlaybackProcessingProtocol", processing_service),
            validation_service=validation_service,
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    # VAD service factory removed in favor of onnx_asr-backed adapter usage

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
            AudioDataServiceProtocol as P_Data,
        )
        from .pyaudio_service import (
            AudioValidationServiceProtocol as P_Validation,
        )
        from .pyaudio_service import (
            DeviceManagementServiceProtocol as P_Device,
        )
        from .pyaudio_service import (
            StreamManagementServiceProtocol as P_Stream,
        )
        return PyAudioService(
            validation_service=cast("P_Validation", validation_service),
            device_management_service=cast("P_Device", device_management_service),
            stream_management_service=cast("P_Stream", stream_management_service),
            audio_data_service=cast("P_Data", audio_data_service),
            progress_tracking_service=progress_service,
            logger_service=logger_service,
        )

    @staticmethod
    def create_all_services():
        """Create all audio services with proper dependencies."""
        return {
            "recording_service": AudioServiceFactory.create_audio_recording_service(),
            "playback_service": AudioServiceFactory.create_audio_playback_service(),
            "pyaudio_service": AudioServiceFactory.create_pyaudio_service(),
        }
