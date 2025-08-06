"""Worker Imports Configuration Infrastructure Service.

This module provides configuration and factory patterns for worker imports,
managing the creation and initialization of different worker types.
"""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.worker_management.value_objects.worker_imports import (
    WorkerImportConfig,
    WorkerImportType,
)


class WorkerFactory(ABC):
    """Abstract base class for worker factories."""

    @abstractmethod
    def create_worker(self, config: WorkerImportConfig, **kwargs) -> Any:
        """Create a worker instance based on configuration.
        
        Args:
            config: Worker import configuration
            **kwargs: Additional parameters for worker creation
            
        Returns:
            Worker instance
        """

    @abstractmethod
    def supports_worker_type(self, worker_type: WorkerImportType,
    ) -> bool:
        """Check if factory supports the given worker type.
        
        Args:
            worker_type: The worker type to check
            
        Returns:
            True if supported, False otherwise
        """


class DefaultWorkerFactory(WorkerFactory):
    """Default implementation of worker factory."""

    def __init__(self):
        """Initialize the default worker factory."""
        self._import_cache: dict[str, type] = {}

    def create_worker(self, config: WorkerImportConfig, **kwargs) -> Any:
        """Create a worker instance based on configuration.
        
        Args:
            config: Worker import configuration
            **kwargs: Additional parameters for worker creation
            
        Returns:
            Worker instance
            
        Raises:
            ImportError: If worker module cannot be imported
            AttributeError: If worker class cannot be found
        """
        # Get the worker class
        worker_class = self._get_worker_class(config)

        # Merge initialization parameters
        init_params = {**config.initialization_params, **kwargs}

        # Create and return worker instance
        return worker_class(**init_params)

    def supports_worker_type(self, _worker_type: WorkerImportType,
    ) -> bool:
        """Check if factory supports the given worker type.
        
        Args:
            _worker_type: The worker type to check
            
        Returns:
            True if supported (all types supported by default)
        """
        return True

    def _get_worker_class(self, config: WorkerImportConfig,
    ) -> type:
        """Get worker class from configuration.
        
        Args:
            config: Worker import configuration
            
        Returns:
            Worker class type
            
        Raises:
            ImportError: If module cannot be imported
            AttributeError: If class cannot be found
        """
        cache_key = f"{config.module_path}.{config.class_name}"

        # Check cache first
        if cache_key in self._import_cache:
            return self._import_cache[cache_key]

        # Import module and get class
        try:
            module = __import__(config.module_path, fromlist=[config.class_name])
            worker_class = getattr(module, config.class_name)
        except ImportError as e:
            msg = f"Failed to import module {config.module_path}: {e}"
            raise ImportError(msg) from e
        except AttributeError as e:
            msg = f"Class {config.class_name} not found in module {config.module_path}: {e}"
            raise AttributeError(msg) from e

        # Cache the class
        self._import_cache[cache_key] = worker_class

        return worker_class


class WorkerImportsConfiguration:
    """Configuration service for worker imports.
    
    This service manages the configuration and creation of different worker types,
    providing a centralized way to handle worker imports and factory patterns.
    """

    def __init__(self, factory: WorkerFactory | None = None):
        """Initialize the worker imports configuration.
        
        Args:
            factory: Optional custom worker factory
        """
        self._factory = factory or DefaultWorkerFactory()
        self._configurations: dict[WorkerImportType, WorkerImportConfig] = {}
        self._setup_default_configurations()

    def _setup_default_configurations(self) -> None:
        """Setup default worker configurations."""
        # VAD Worker Configuration
        self.register_worker_config(WorkerImportConfig(
            worker_type=WorkerImportType.VAD,
            module_path="src_refactored.infrastructure.audio.vad_worker_service",
            class_name="VadWorkerService",
            dependencies=["utils.transcribe.VaDetector"],
        ))

        # Model Worker Configuration
        self.register_worker_config(WorkerImportConfig(
            worker_type=WorkerImportType.MODEL,
            module_path="src_refactored.infrastructure.transcription.model_worker_service",
            class_name="ModelWorkerService",
            dependencies=["utils.transcribe.WhisperONNXTranscriber"],
        ))

        # LLM Worker Configuration
        self.register_worker_config(WorkerImportConfig(
            worker_type=WorkerImportType.LLM,
            module_path="src_refactored.infrastructure.llm.llm_pyqt_worker_service",
            class_name="LLMPyQtWorkerService",
            dependencies=["src_refactored.infrastructure.llm.gemma_inference_service"],
        ))

        # Listener Worker Configuration
        self.register_worker_config(WorkerImportConfig(
            worker_type=WorkerImportType.LISTENER,
            module_path="src_refactored.infrastructure.audio.listener_worker_service",
            class_name="ListenerWorkerService",
            dependencies=["utils.listener.AudioToText"],
        ))

        # PyQt Audio Adapter Configuration
        self.register_worker_config(WorkerImportConfig(
            worker_type=WorkerImportType.PYQT_AUDIO,
            module_path="src_refactored.infrastructure.audio.pyqt_audio_adapter",
            class_name="PyQtAudioAdapter",
            dependencies=["utils.listener.AudioToText"],
        ))

    def register_worker_config(self, config: WorkerImportConfig,
    ) -> None:
        """Register a worker configuration.
        
        Args:
            config: Worker import configuration to register
        """
        self._configurations[config.worker_type] = config

    def get_worker_config(self, worker_type: WorkerImportType,
    ) -> WorkerImportConfig | None:
        """Get worker configuration by type.
        
        Args:
            worker_type: The worker type to get configuration for
            
        Returns:
            Worker configuration if found, None otherwise
        """
        return self._configurations.get(worker_type)

    def create_worker(self, worker_type: WorkerImportType, **kwargs) -> Any:
        """Create a worker instance by type.
        
        Args:
            worker_type: The type of worker to create
            **kwargs: Additional parameters for worker creation
            
        Returns:
            Worker instance
            
        Raises:
            ValueError: If worker type is not configured
            ImportError: If worker cannot be imported
        """
        config = self.get_worker_config(worker_type)
        if config is None:
            msg = f"No configuration found for worker type: {worker_type}"
            raise ValueError(msg)

        if not self._factory.supports_worker_type(worker_type):
            msg = f"Factory does not support worker type: {worker_type}"
            raise ValueError(msg)

        return self._factory.create_worker(config, **kwargs)

    def get_available_worker_types(self) -> list[WorkerImportType]:
        """Get list of available worker types.
        
        Returns:
            List of configured worker types
        """
        return list(self._configurations.keys())

    def validate_dependencies(self, worker_type: WorkerImportType,
    ) -> bool:
        """Validate that worker dependencies are available.
        
        Args:
            worker_type: The worker type to validate
            
        Returns:
            True if all dependencies are available, False otherwise
        """
        config = self.get_worker_config(worker_type)
        if config is None:
            return False

        for dependency in config.dependencies:
            try:
                __import__(dependency)
            except ImportError:
                return False

        return True

    def set_factory(self, factory: WorkerFactory,
    ) -> None:
        """Set a custom worker factory.
        
        Args:
            factory: The worker factory to use
        """
        self._factory = factory

    def get_factory(self) -> WorkerFactory:
        """Get the current worker factory.
        
        Returns:
            The current worker factory
        """
        return self._factory


class WorkerImportsManager:
    """High-level manager for worker imports and configuration.
    
    This manager provides a simplified interface for worker import
    management and factory operations.
    """

    def __init__(self, configuration: WorkerImportsConfiguration | None = None):
        """Initialize the worker imports manager.
        
        Args:
            configuration: Optional custom worker imports configuration
        """
        self._configuration = configuration or WorkerImportsConfiguration()

    def create_vad_worker(self, **kwargs) -> Any:
        """Create a VAD worker.
        
        Args:
            **kwargs: Additional parameters for worker creation
            
        Returns:
            VAD worker instance
        """
        return self._configuration.create_worker(WorkerImportType.VAD, **kwargs)

    def create_model_worker(
    self,
    model_type: str = "whisper-turbo",
    quantization: str | None = None,
    **kwargs) -> Any:
        """Create a model worker.
        
        Args:
            model_type: The type of model to use
            quantization: The quantization level
            **kwargs: Additional parameters for worker creation
            
        Returns:
            Model worker instance
        """
        params = {"model_type": model_type}
        if quantization is not None:
            params["quantization"] = quantization
        params.update(kwargs)

        return self._configuration.create_worker(WorkerImportType.MODEL, **params)

    def create_llm_worker(
    self,
    model_type: str = "gemma-3-1b-it",
    quantization: str = "Full",
    **kwargs) -> Any:
        """Create an LLM worker.
        
        Args:
            model_type: The type of LLM model to use
            quantization: The quantization level
            **kwargs: Additional parameters for worker creation
            
        Returns:
            LLM worker instance
        """
        params = {"model_type": model_type, "quantization": quantization}
        params.update(kwargs)

        return self._configuration.create_worker(WorkerImportType.LLM, **params)

    def create_listener_worker(self, model: Any, vad: Any, rec_key: str, **kwargs) -> Any:
        """Create a listener worker.
        
        Args:
            model: The transcription model instance
            vad: The VAD instance
            rec_key: The recording key binding
            **kwargs: Additional parameters for worker creation
            
        Returns:
            Listener worker instance
        """
        params = {"model": model, "vad": vad, "rec_key": rec_key}
        params.update(kwargs)

        return self._configuration.create_worker(WorkerImportType.LISTENER, **params)

    def create_pyqt_audio_adapter(
    self,
    model_cls: Any,
    vad_cls: Any,
    rec_key: str | None = None,
    **kwargs) -> Any:
        """Create a PyQt audio adapter.
        
        Args:
            model_cls: The model class
            vad_cls: The VAD class
            rec_key: Optional recording key
            **kwargs: Additional parameters for worker creation
            
        Returns:
            PyQt audio adapter instance
        """
        params = {"model_cls": model_cls, "vad_cls": vad_cls}
        if rec_key is not None:
            params["rec_key"] = rec_key
        params.update(kwargs)

        return self._configuration.create_worker(WorkerImportType.PYQT_AUDIO, **params)

    def validate_all_dependencies(self) -> dict[WorkerImportType, bool]:
        """Validate dependencies for all worker types.
        
        Returns:
            Dictionary mapping worker types to validation results
        """
        results = {}
        for worker_type in self._configuration.get_available_worker_types():
            results[worker_type] = self._configuration.validate_dependencies(worker_type)
        return results

    def get_configuration(self) -> WorkerImportsConfiguration:
        """Get the worker imports configuration.
        
        Returns:
            The worker imports configuration
        """
        return self._configuration