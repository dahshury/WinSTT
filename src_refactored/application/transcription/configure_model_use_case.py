"""Configure model use case.

This module contains the use case for configuring transcription models.
"""

import logging
from dataclasses import dataclass
from typing import Any

from src_refactored.domain.common.abstractions import UseCase
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.entities import TranscriptionSession
from src_refactored.domain.transcription.value_objects import (
    ModelConfiguration,
    ModelSize,
    ModelType,
    TranscriptionState,
)

# Constants for validation
MAX_BEAM_SIZE = 20

# Initialize logger
logger = logging.getLogger(__name__)


@dataclass
class ConfigureModelRequest:
    """Request for configuring transcription model."""

    model_type: ModelType | None = None
    model_size: ModelSize | None = None
    model_path: str | None = None
    language: str | None = None
    task: str | None = None  # "transcribe" or "translate"
    device: str | None = None  # "cpu", "cuda", "auto"
    compute_type: str | None = None  # "float16", "int8", etc.
    beam_size: int | None = None
    best_of: int | None = None
    temperature: float | None = None
    compression_ratio_threshold: float | None = None
    log_prob_threshold: float | None = None
    no_speech_threshold: float | None = None
    condition_on_previous_text: bool | None = None
    initial_prompt: str | None = None
    word_timestamps: bool | None = None
    prepend_punctuations: str | None = None
    append_punctuations: str | None = None
    custom_parameters: dict[str, Any] | None = None
    validate_configuration: bool = True
    apply_immediately: bool = True


@dataclass
class ModelConfigurationInfo:
    """Information about model configuration."""

    model_type: ModelType
    model_size: ModelSize
    model_path: str
    language: str | None
    task: str
    device: str
    compute_type: str
    beam_size: int
    best_of: int
    temperature: float
    compression_ratio_threshold: float
    log_prob_threshold: float
    no_speech_threshold: float
    condition_on_previous_text: bool
    initial_prompt: str | None
    word_timestamps: bool
    prepend_punctuations: str
    append_punctuations: str
    custom_parameters: dict[str, Any]
    is_valid: bool
    validation_errors: list
    estimated_memory_usage: float | None = None
    supported_languages: list | None = None


@dataclass
class ConfigureModelResponse:
    """Response for configuring transcription model."""

    success: bool
    configuration: ModelConfigurationInfo | None = None
    previous_configuration: ModelConfigurationInfo | None = None
    configuration_applied: bool = False
    requires_model_reload: bool = False
    validation_warnings: list | None = None
    error_message: str | None = None


class ConfigureModelUseCase(UseCase[ConfigureModelRequest, ConfigureModelResponse]):
    """Use case for configuring transcription models.
    
    This use case handles the configuration of transcription models,
    including validation, optimization, and application of settings.
    """

    def __init__(
        self,
        transcription_session: TranscriptionSession,
        model_service: ModelManagementServiceProtocol | None = None,
        validation_service: ConfigurationValidationServiceProtocol | None = None,
        optimization_service: OptimizationServiceProtocol | None = None,
    ):
        """Initialize the configure model use case.
        
        Args:
            transcription_session: The transcription session entity
            model_service: Optional service for model management
            validation_service: Optional service for configuration validation
            optimization_service: Optional service for configuration optimization
        """
        self._transcription_session = transcription_session
        self._model_service = model_service or self._get_default_model_service()
        self._validation_service = validation_service or self._get_default_validation_service()
        self._optimization_service = optimization_service or self._get_default_optimization_service()

    def _get_default_model_service(self) -> ModelManagementServiceProtocol:
        """Get default model management service."""
        return DefaultModelManagementService()

    def _get_default_validation_service(self) -> ConfigurationValidationServiceProtocol:
        """Get default configuration validation service."""
        return DefaultConfigurationValidationService()

    def _get_default_optimization_service(self) -> OptimizationServiceProtocol:
        """Get default optimization service."""
        return DefaultOptimizationService()

    def execute(self, request: ConfigureModelRequest,
    ) -> Result[ConfigureModelResponse]:
        """Execute the configure model use case.
        
        Args:
            request: The configure model request
            
        Returns:
            Result containing the configure model response
        """
        try:
            # Get current configuration
            current_config = self._transcription_session.get_model_configuration()
            previous_config_info = (
                self._convert_to_config_info(current_config)
                if current_config else None
            )

            # Check if transcription is in progress
            if self._transcription_session.get_state() == TranscriptionState.PROCESSING:
                return Result.failure("Cannot configure model while transcription is in progress")

            # Build new configuration
            new_config_result = self._build_configuration(request, current_config)
            if new_config_result.is_failure():
                return Result.failure(f"Failed to build configuration: {new_config_result.error}")

            new_config = new_config_result.value

            # Validate configuration if requested
            validation_warnings = []
            if request.validate_configuration:
                validation_result = self._validate_configuration(new_config)
                if validation_result.is_failure():
                    return Result.failure(f"Configuration validation failed: {validation_result.error}")

                validation_warnings = validation_result.value or []

            # Optimize configuration if service available
            if self._optimization_service:
                try:
                    optimization_result = (
                        self._optimization_service.optimize_configuration(new_config)
                    )
                    if optimization_result.is_success():
                        new_config = optimization_result.value
                        if optimization_result.warnings:
                            validation_warnings.extend(optimization_result.warnings)
                except Exception as e:
                    logger.warning("Configuration optimization failed: %s", e)
                    # Optimization failure shouldn't block configuration
                    validation_warnings.append(f"Configuration optimization failed: {e!s}")

            # Convert to configuration info
            config_info = self._convert_to_config_info(new_config,
    )

            # Check if model reload is required
            requires_reload = self._requires_model_reload(current_config, new_config)

            # Apply configuration if requested
            configuration_applied = False
            if request.apply_immediately:
                apply_result = self._transcription_session.configure_model(new_config)
                if apply_result.is_failure():
                    return Result.failure(f"Failed to apply configuration: {apply_result.error}")

                configuration_applied = True

                # Reload model if required and service available
                if requires_reload and self._model_service:
                    try:
                        reload_result = self._model_service.reload_model(new_config)
                        if reload_result.is_failure():
                            validation_warnings.append(
                                f"Model reload failed: {reload_result.error}",
                            )
                    except Exception as e:
                        logger.warning("Model reload failed: %s", e)
                        validation_warnings.append(f"Model reload error: {e!s}")

            return Result.success(
                ConfigureModelResponse(
                    success=True,
                    configuration=config_info,
                    previous_configuration=previous_config_info,
                    configuration_applied=configuration_applied,
                    requires_model_reload=requires_reload,
                    validation_warnings=validation_warnings if validation_warnings else None,
                ),
            )

        except Exception as e:
            logger.exception("Unexpected error configuring model")
            error_msg = f"Unexpected error configuring model: {e!s}"
            return Result.failure(error_msg)

    def _build_configuration(
        self,
        request: ConfigureModelRequest,
        current_config: ModelConfiguration | None,
    ) -> Result[ModelConfiguration]:
        """Build new model configuration from request.
        
        Args:
            request: The configure model request
            current_config: Current model configuration
            
        Returns:
            Result containing the new model configuration
        """
        try:
            # Start with current config or defaults
            if current_config:
                config_dict = current_config.to_dict()
            else:
                config_dict = self._get_default_configuration()

            # Apply request parameters
            if request.model_type is not None:
                config_dict["model_type"] = request.model_type
            if request.model_size is not None:
                config_dict["model_size"] = request.model_size
            if request.model_path is not None:
                config_dict["model_path"] = request.model_path
            if request.language is not None:
                config_dict["language"] = request.language
            if request.task is not None:
                config_dict["task"] = request.task
            if request.device is not None:
                config_dict["device"] = request.device
            if request.compute_type is not None:
                config_dict["compute_type"] = request.compute_type
            if request.beam_size is not None:
                config_dict["beam_size"] = request.beam_size
            if request.best_of is not None:
                config_dict["best_of"] = request.best_of
            if request.temperature is not None:
                config_dict["temperature"] = request.temperature
            if request.compression_ratio_threshold is not None:
                config_dict["compression_ratio_threshold"] = request.compression_ratio_threshold
            if request.log_prob_threshold is not None:
                config_dict["log_prob_threshold"] = request.log_prob_threshold
            if request.no_speech_threshold is not None:
                config_dict["no_speech_threshold"] = request.no_speech_threshold
            if request.condition_on_previous_text is not None:
                config_dict["condition_on_previous_text"] = request.condition_on_previous_text
            if request.initial_prompt is not None:
                config_dict["initial_prompt"] = request.initial_prompt
            if request.word_timestamps is not None:
                config_dict["word_timestamps"] = request.word_timestamps
            if request.prepend_punctuations is not None:
                config_dict["prepend_punctuations"] = request.prepend_punctuations
            if request.append_punctuations is not None:
                config_dict["append_punctuations"] = request.append_punctuations

            # Apply custom parameters
            if request.custom_parameters:
                if "custom_parameters" not in config_dict:
                    config_dict["custom_parameters"] = {}
                config_dict["custom_parameters"].update(request.custom_parameters)

            # Create new configuration
            new_config = ModelConfiguration.from_dict(config_dict)
            return Result.success(new_config)

        except Exception as e:
            logger.exception("Failed to build configuration")
            return Result.failure(f"Failed to build configuration: {e!s}")

    def _get_default_configuration(self,
    ) -> dict[str, Any]:
        """Get default model configuration.
        
        Returns:
            Default configuration dictionary
        """
        return {
            "model_type": ModelType.WHISPER,
            "model_size": ModelSize.BASE,
            "model_path": None,
            "language": None,
            "task": "transcribe",
            "device": "auto",
            "compute_type": "float16",
            "beam_size": 5,
            "best_of": 5,
            "temperature": 0.0,
            "compression_ratio_threshold": 2.4,
            "log_prob_threshold": -1.0,
            "no_speech_threshold": 0.6,
            "condition_on_previous_text": True,
            "initial_prompt": None,
            "word_timestamps": False,
            "prepend_punctuations": '"\'¿([{-',
            "append_punctuations": '".,!?:")]}\\',
            "custom_parameters": {},
        }

    def _validate_configuration(self, config: ModelConfiguration,
    ) -> Result[list]:
        """Validate model configuration.
        
        Args:
            config: The model configuration to validate
            
        Returns:
            Result containing validation warnings list
        """
        warnings = []

        try:
            # Use validation service if available
            if self._validation_service:
                validation_result = self._validation_service.validate_model_configuration(config)
                if validation_result.is_failure():
                    return validation_result
                warnings.extend(validation_result.value or [])

            # Basic validation checks
            if config.beam_size < 1 or config.beam_size > MAX_BEAM_SIZE:
                warnings.append("Beam size should be between 1 and 20")

            if config.best_of < config.beam_size:
                warnings.append("best_of should be >= beam_size")

            if config.temperature < 0.0 or config.temperature > 1.0:
                warnings.append("Temperature should be between 0.0 and 1.0")

            if config.compression_ratio_threshold < 1.0:
                warnings.append("Compression ratio threshold should be >= 1.0")

            if config.no_speech_threshold < 0.0 or config.no_speech_threshold > 1.0:
                warnings.append("No speech threshold should be between 0.0 and 1.0")

            # Device validation
            if config.device not in ["cpu", "cuda", "auto"]:
                warnings.append(f"Unknown device: {config.device}")

            # Task validation
            if config.task not in ["transcribe", "translate"]:
                warnings.append(f"Unknown task: {config.task}")

            return Result.success(warnings)

        except Exception as e:
            logger.exception("Configuration validation error")
            return Result.failure(f"Configuration validation error: {e!s}")

    def _requires_model_reload(
        self,
        current_config: ModelConfiguration | None,
        new_config: ModelConfiguration,
    ) -> bool:
        """Check if model reload is required.
        
        Args:
            current_config: Current model configuration
            new_config: New model configuration
            
        Returns:
            True if model reload is required
        """
        if not current_config:
            return True

        # Check critical parameters that require reload
        reload_params = [
            "model_type", "model_size", "model_path",
            "device", "compute_type",
        ]

        for param in reload_params:
            if getattr(current_config, param, None) != getattr(new_config, param, None):
                return True

        return False

    def _convert_to_config_info(self, config: ModelConfiguration,
    ) -> ModelConfigurationInfo:
        """Convert model configuration to configuration info.
        
        Args:
            config: The model configuration
            
        Returns:
            Model configuration info
        """
        # Get additional info from model service if available
        estimated_memory = None
        supported_languages = None

        if self._model_service:
            try:
                model_info = self._model_service.get_model_info(config)
                if model_info.is_success():
                    estimated_memory = model_info.value.get("memory_usage")
                    supported_languages = model_info.value.get("supported_languages",
    )
            except Exception as e:
                logger.warning("Failed to get model info: %s", e)

        return ModelConfigurationInfo(
            model_type=config.model_type,
            model_size=config.model_size,
            model_path=config.model_path or "",
            language=config.language,
            task=config.task,
            device=config.device,
            compute_type=config.compute_type,
            beam_size=config.beam_size,
            best_of=config.best_of,
            temperature=config.temperature,
            compression_ratio_threshold=config.compression_ratio_threshold,
            log_prob_threshold=config.log_prob_threshold,
            no_speech_threshold=config.no_speech_threshold,
            condition_on_previous_text=config.condition_on_previous_text,
            initial_prompt=config.initial_prompt,
            word_timestamps=config.word_timestamps,
            prepend_punctuations=config.prepend_punctuations,
            append_punctuations=config.append_punctuations,
            custom_parameters=config.custom_parameters or {},
            is_valid=True,
            validation_errors=[],
            estimated_memory_usage=estimated_memory,
            supported_languages=supported_languages,
        )