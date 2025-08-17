"""Audio Visualization Infrastructure Module.

This module provides infrastructure services for audio visualization,
including audio processing, visualization control, audio stream management,
buffer management, normalization, and resource cleanup.

Extracted and refactored from src/ui/voice_visualizer.py following
Domain-Driven Design principles.
"""

from .audio_normalization_service import (
    AudioNormalizationService,
    AudioNormalizationServiceProtocol,
    NormalizationConfig,
    NormalizationMethod,
    NormalizationProcessor,
    SpeechNormalizer,
)
from .audio_processor_service import (
    AudioProcessorConfig,
    AudioProcessorService,
    PyAudioProcessor,
)
from .audio_stream_service import (
    AudioStreamManager,
    AudioStreamService,
    IAudioStreamInitializer,
    PyAudioStreamInitializer,
    StreamConfiguration,
    StreamInitializationResponse,
    StreamInitializationResult,
)
from .buffer_management_service import (
    BufferConfiguration,
    BufferManagementService,
    BufferManagementServiceProtocol,
    BufferManager,
    RollingAudioBuffer,
)
from .resource_cleanup_service import (
    PyAudioResourceManager,
    ResourceCleanupManager,
    ResourceCleanupService,
    ResourceCleanupServiceProtocol,
    ResourceInfo,
    ResourceState,
    ResourceType,
    ThreadResourceManager,
)
from .visualization_controller_service import (
    VisualizationController,
    VisualizationControllerService,
)

__all__ = [
    # Audio Normalization Service
    "AudioNormalizationService",
    "AudioNormalizationServiceProtocol",
    "AudioProcessorConfig",
    # Audio Processor Service
    "AudioProcessorService",
    "AudioStreamManager",
    # Audio Stream Service
    "AudioStreamService",
    "BufferConfiguration",
    # Buffer Management Service
    "BufferManagementService",
    "BufferManagementServiceProtocol",
    "BufferManager",
    "IAudioStreamInitializer",
    "NormalizationConfig",
    "NormalizationMethod",
    "NormalizationProcessor",
    "PyAudioProcessor",
    "PyAudioResourceManager",
    "PyAudioStreamInitializer",
    "ResourceCleanupManager",
    # Resource Cleanup Service
    "ResourceCleanupService",
    "ResourceCleanupServiceProtocol",
    "ResourceInfo",
    "ResourceState",
    "ResourceType",
    "RollingAudioBuffer",
    "SpeechNormalizer",
    "StreamConfiguration",
    "StreamInitializationResponse",
    "StreamInitializationResult",
    "ThreadResourceManager",
    "VisualizationController",
    # Visualization Controller Service
    "VisualizationControllerService",
]

# Version information
__version__ = "1.0.0"
__author__ = "WinSTT Development Team"
__description__ = "Audio visualization infrastructure services for WinSTT"

# Module metadata
__module_info__ = {
    "name": "audio_visualization",
    "version": __version__,
    "description": __description__,
    "services": [
        "AudioProcessorService",
        "VisualizationControllerService",
        "AudioStreamService",
        "BufferManagementService",
        "AudioNormalizationService",
        "ResourceCleanupService",
    ],
    # Removed legacy extraction note to avoid coupling to old modules
    "architecture": "Domain-Driven Design (DDD)",
    "layer": "Infrastructure",
}