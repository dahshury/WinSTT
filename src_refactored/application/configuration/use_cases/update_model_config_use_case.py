"""Update Model Configuration Use Case

This module implements the UpdateModelConfigUseCase for updating model
configuration settings with validation and progress tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.settings.value_objects.update_operations import (
    ModelCompatibility,
    UpdatePhase,
    UpdateResult,
)
from src_refactored.domain.transcription.value_objects.model_name import ModelName
from src_refactored.domain.transcription.value_objects.quantization_level import QuantizationLevel


@dataclass(frozen=True)
class ModelConfigurationUpdate:
    """Model configuration update specification"""
    model_name: ModelName | None = None
    quantization_level: QuantizationLevel | None = None
    force_restart_worker: bool = True
    validate_compatibility: bool = True
    save_to_persistent_config: bool = True
    backup_current_config: bool = True


@dataclass(frozen=True)
class UpdateModelConfigRequest:
    """Request for updating model configuration"""
    update: ModelConfigurationUpdate
    current_model: ModelName | None = None
    current_quantization: QuantizationLevel | None = None
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class UpdateModelConfigResponse:
    """Response from update model configuration operation"""
    result: UpdateResult
    updated_model: ModelName | None = None
    updated_quantization: QuantizationLevel | None = None
    previous_model: ModelName | None = None
    previous_quantization: QuantizationLevel | None = None
    worker_restarted: bool = False
    configuration_saved: bool = False
    compatibility_check: ModelCompatibility | None = None
    update_duration_ms: int = 0
    warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    backup_config_path: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class ModelValidationServiceProtocol(Protocol):
    """Protocol for model validation operations"""

    def validate_model_name(self, model_name: ModelName,
    ) -> Result[None]:
        """Validate if model name is supported"""
        ...

    def validate_quantization_level(self, quantization: QuantizationLevel,
    ) -> Result[None]:
        """Validate if quantization level is supported"""
        ...

    def check_model_compatibility(self,
    model: ModelName, quantization: QuantizationLevel,
    ) -> Result[ModelCompatibility]:
        """Check compatibility between model and quantization"""
        ...

    def get_available_models(self) -> Result[list[ModelName]]:
        """Get list of available models"""
        ...

    def get_supported_quantizations(self, model: ModelName,
    ) -> Result[list[QuantizationLevel]]:
        """Get supported quantization levels for a model"""
        ...


class WorkerManagementServiceProtocol(Protocol):
    """Protocol for worker management operations"""

    def stop_current_worker(self) -> Result[None]:
        """Stop the current model worker"""
        ...

    def start_worker_with_config(self, model: ModelName, quantization: QuantizationLevel,
    ) -> Result[None]:
        """Start worker with new model configuration"""
        ...

    def is_worker_running(self) -> bool:
        """Check if worker is currently running"""
        ...

    def get_worker_status(self) -> Result[dict[str, Any]]:
        """Get current worker status information"""
        ...


class ConfigurationServiceProtocol(Protocol):
    """Protocol for configuration management"""

    def get_current_model_config(self) -> Result[dict[str, Any]]:
        """Get current model configuration"""
        ...

    def update_model_config(self, model: ModelName, quantization: QuantizationLevel,
    ) -> Result[None]:
        """Update model configuration in memory"""
        ...

    def save_configuration(self) -> Result[None]:
        """Save configuration to persistent storage"""
        ...

    def backup_configuration(self, backup_suffix: str = ".bak",
    ) -> Result[str]:
        """Create backup of current configuration"""
        ...

    def restore_configuration(self, backup_path: str,
    ) -> Result[None]:
        """Restore configuration from backup"""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations"""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message"""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message"""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message"""
        ...


class UpdateModelConfigUseCase:
    """Use case for updating model configuration"""

    def __init__(
        self,
        model_validation_service: ModelValidationServiceProtocol,
        worker_management_service: WorkerManagementServiceProtocol,
        configuration_service: ConfigurationServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._model_validation = model_validation_service
        self._worker_management = worker_management_service
        self._configuration = configuration_service
        self._logger = logger_service

    def execute(self, request: UpdateModelConfigRequest,
    ) -> UpdateModelConfigResponse:
        """Execute the update model configuration operation"""
        start_time = datetime.utcnow()
        response = UpdateModelConfigResponse(result=UpdateResult.FAILED)

        try:
            self._logger.log_info(
                "Starting model configuration update",
                new_model=request.update.model_name.value if request.update.model_name else None,
new_quantization = (
    request.update.quantization_level.value if request.update.quantization_level else None,),
            )

            # Store current configuration for rollback
            response.previous_model = request.current_model
            response.previous_quantization = request.current_quantization

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, UpdatePhase.INITIALIZING, 0):
                response.result = UpdateResult.CANCELLED
                return response

            # Determine what needs to be updated
            model_to_update = request.update.model_name or request.current_model
quantization_to_update = (
    request.update.quantization_level or request.current_quantization)

            if not model_to_update or not quantization_to_update:
                response.error_message = "Both model and quantization must be specified"
                return response

            # Phase 2: Validate model
            if not self._update_progress(request.progress_callback, UpdatePhase.VALIDATING_MODEL, 10):
                response.result = UpdateResult.CANCELLED
                return response

            if request.update.validate_compatibility:
                model_validation = self._model_validation.validate_model_name(model_to_update,
    )
                if not model_validation.is_success:
                    response.error_message = f"Invalid model: {model_validation.error_message}"
                    response.result = UpdateResult.MODEL_NOT_AVAILABLE
                    return response

            # Phase 3: Validate quantization
            if not self._update_progress(request.progress_callback, UpdatePhase.VALIDATING_QUANTIZATION, 20):
                response.result = UpdateResult.CANCELLED
                return response

            if request.update.validate_compatibility:
quantization_validation = (
    self._model_validation.validate_quantization_level(quantization_to_update)
    )
                if not quantization_validation.is_success:
response.error_message = (
    f"Invalid quantization: {quantization_validation.error_message}")
                    response.result = UpdateResult.QUANTIZATION_NOT_SUPPORTED
                    return response

                # Check model-quantization compatibility
compatibility_result = (
    self._model_validation.check_model_compatibility(model_to_update)
                quantization_to_update)
                if compatibility_result.is_success:
                    response.compatibility_check = compatibility_result.value
                    if compatibility_result.value == ModelCompatibility.INCOMPATIBLE:
                        response.error_message
 = (
    f"Model {model_to_update.value} is incompatible with quantization {quantization_to_update.value}")
                        response.result = UpdateResult.VALIDATION_FAILED
                        return response
                    if compatibility_result.value == ModelCompatibility.PARTIALLY_COMPATIBLE:
                        response.warnings.append(f"Model {model_to_update.value} has limited compati\
    bility with quantization {quantization_to_update.value}")

            # Phase 4: Backup current configuration
            backup_path = None
            if request.update.backup_current_config:
                backup_result = self._configuration.backup_configuration()
                if backup_result.is_success:
                    backup_path = backup_result.value
                    response.backup_config_path = backup_path
                else:
                    response.warnings.append(f"Failed to backup configuration: {backup_result.error_message}",
    )

            # Phase 5: Stop current worker if needed
            if not self._update_progress(request.progress_callback, UpdatePhase.STOPPING_CURRENT_WORKER, 30):
                response.result = UpdateResult.CANCELLED
                return response

            worker_was_running = self._worker_management.is_worker_running()
            if worker_was_running and request.update.force_restart_worker:
                stop_result = self._worker_management.stop_current_worker()
                if not stop_result.is_success:
                    response.warnings.append(f"Failed to stop current worker: {stop_result.error_message}",
    )

            # Phase 6: Update configuration
            if not self._update_progress(request.progress_callback, UpdatePhase.UPDATING_CONFIGURATION, 50):
                response.result = UpdateResult.CANCELLED
                return response

config_update_result = (
    self._configuration.update_model_config(model_to_update, quantization_to_update))
            if not config_update_result.is_success:
response.error_message = (
    f"Failed to update configuration: {config_update_result.error_message}")
                # Try to restore backup if available
                if backup_path:
                    restore_result = self._configuration.restore_configuration(backup_path)
                    if not restore_result.is_success:
                        response.warnings.append(f"Failed to restore backup: {restore_result.error_message}",
    )
                return response

            # Phase 7: Save configuration
            if not self._update_progress(request.progress_callback, UpdatePhase.SAVING_CONFIGURATION, 65):
                response.result = UpdateResult.CANCELLED
                return response

            if request.update.save_to_persistent_config:
                save_result = self._configuration.save_configuration()
                if save_result.is_success:
                    response.configuration_saved = True
                else:
                    response.warnings.append(f"Failed to save configuration: {save_result.error_message}",
    )
                    response.result = UpdateResult.CONFIGURATION_SAVE_FAILED

            # Phase 8: Restart worker
            if not self._update_progress(request.progress_callback, UpdatePhase.RESTARTING_WORKER, 80):
                response.result = UpdateResult.CANCELLED
                return response

            if request.update.force_restart_worker:
worker_start_result = (
    self._worker_management.start_worker_with_config(model_to_update,)
                quantization_to_update)
                if worker_start_result.is_success:
                    response.worker_restarted = True
                else:
response.error_message = (
    f"Failed to restart worker: {worker_start_result.error_message}")
                    response.result = UpdateResult.WORKER_RESTART_FAILED
                    # Try to restore backup if available
                    if backup_path:
                        restore_result = self._configuration.restore_configuration(backup_path,
    )
                        if restore_result.is_success:
                            # Try to restart with old config
                            if request.current_model and request.current_quantization:
                                self._worker_management.start_worker_with_config(request.current_model,
                                request.current_quantization)
                    return response

            # Phase 9: Verify update
            if not self._update_progress(request.progress_callback, UpdatePhase.VERIFYING_UPDATE, 90):
                response.result = UpdateResult.CANCELLED
                return response

            # Verify the configuration was applied
            current_config_result = self._configuration.get_current_model_config()
            if current_config_result.is_success:
                current_config = current_config_result.value
                if (current_config.get("model") == model_to_update.value and
                    current_config.get("quantization") == quantization_to_update.value):
                    response.updated_model = model_to_update
                    response.updated_quantization = quantization_to_update
                else:
                    response.warnings.append("Configuration update verification failed",
    )

            # Phase 10: Complete
            if not self._update_progress(request.progress_callback, UpdatePhase.COMPLETED, 100):
                response.result = UpdateResult.CANCELLED
                return response

            # Set success response
            response.result = UpdateResult.SUCCESS
response.update_duration_ms = (
    int((datetime.utcnow() - start_time).total_seconds() * 1000))

            # Add metadata
            response.metadata = {
                "update_timestamp": start_time.isoformat()
                "model_changed": request.update.model_name is not None,
                "quantization_changed": request.update.quantization_level is not None,
                "worker_was_running": worker_was_running,
                "backup_created": backup_path is not None,
                "compatibility_checked": request.update.validate_compatibility,
                "force_restart": request.update.force_restart_worker,
            }

            self._logger.log_info(
                "Model configuration update completed",
                result=response.result.value,
                updated_model=response.updated_model.value if response.updated_model else None,
updated_quantization = (
    response.updated_quantization.value if response.updated_quantization else None,)
                worker_restarted=response.worker_restarted,
                duration_ms=response.update_duration_ms,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during model configuration update: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = UpdateResult.FAILED

        return response

    def _update_progress(self, callback: ProgressCallback | None, phase: UpdatePhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            return callback.update_progress(
                percentage=percentage,
                message=f"Update phase: {phase.value}",
                phase=phase.value,
            )
        return True