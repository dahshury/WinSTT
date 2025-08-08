"""Update LLM Configuration Use Case

This module implements the UpdateLLMConfigUseCase for updating LLM (Large Language Model)
configuration settings with validation and progress tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ProgressPercentage
from src_refactored.domain.llm.value_objects.llm_model_name import LLMModelName
from src_refactored.domain.llm.value_objects.llm_prompt import LLMPrompt
from src_refactored.domain.llm.value_objects.llm_quantization_level import LLMQuantizationLevel
from src_refactored.domain.settings.value_objects.update_operations import (
    LLMCompatibility,
    LLMUpdatePhase,
    LLMUpdateResult,
)


@dataclass(frozen=True)
class LLMConfigurationUpdate:
    """LLM configuration update specification"""
    enabled: bool | None = None
    model_name: LLMModelName | None = None
    quantization_level: LLMQuantizationLevel | None = None
    prompt: LLMPrompt | None = None
    force_restart_worker: bool = True
    validate_compatibility: bool = True
    save_to_persistent_config: bool = True
    backup_current_config: bool = True


@dataclass(frozen=True)
class UpdateLLMConfigRequest:
    """Request for updating LLM configuration"""
    update: LLMConfigurationUpdate
    current_enabled: bool | None = None
    current_model: LLMModelName | None = None
    current_quantization: LLMQuantizationLevel | None = None
    current_prompt: LLMPrompt | None = None
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class UpdateLLMConfigResponse:
    """Response from update LLM configuration operation"""
    result: LLMUpdateResult
    updated_enabled: bool | None = None
    updated_model: LLMModelName | None = None
    updated_quantization: LLMQuantizationLevel | None = None
    updated_prompt: LLMPrompt | None = None
    previous_enabled: bool | None = None
    previous_model: LLMModelName | None = None
    previous_quantization: LLMQuantizationLevel | None = None
    previous_prompt: LLMPrompt | None = None
    worker_restarted: bool = False
    configuration_saved: bool = False
    compatibility_check: LLMCompatibility | None = None
    update_duration_ms: int = 0
    warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    backup_config_path: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class LLMValidationServiceProtocol(Protocol):
    """Protocol for LLM validation operations"""

    def validate_llm_model_name(self, model_name: LLMModelName,
    ) -> Result[None]:
        """Validate if LLM model name is supported"""
        ...

    def validate_llm_quantization_level(self, quantization: LLMQuantizationLevel,
    ) -> Result[None]:
        """Validate if LLM quantization level is supported"""
        ...

    def validate_llm_prompt(self, prompt: LLMPrompt,
    ) -> Result[None]:
        """Validate LLM prompt format and content"""
        ...

    def check_llm_compatibility(self,
    model: LLMModelName, quantization: LLMQuantizationLevel,
    ) -> Result[LLMCompatibility]:
        """Check compatibility between LLM model and quantization"""
        ...

    def get_available_llm_models(self) -> Result[list[LLMModelName]]:
        """Get list of available LLM models"""
        ...

    def get_supported_llm_quantizations(self, model: LLMModelName,
    ) -> Result[list[LLMQuantizationLevel]]:
        """Get supported quantization levels for an LLM model"""
        ...


class LLMWorkerManagementServiceProtocol(Protocol):
    """Protocol for LLM worker management operations"""

    def stop_current_llm_worker(self) -> Result[None]:
        """Stop the current LLM worker"""
        ...

    def start_llm_worker_with_config(self,
    model: LLMModelName, quantization: LLMQuantizationLevel, prompt: LLMPrompt,
    ) -> Result[None]:
        """Start LLM worker with new configuration"""
        ...

    def is_llm_worker_running(self) -> bool:
        """Check if LLM worker is currently running"""
        ...

    def get_llm_worker_status(self) -> Result[dict[str, Any]]:
        """Get current LLM worker status information"""
        ...

    def disable_llm_worker(self) -> Result[None]:
        """Disable LLM worker completely"""
        ...


class LLMConfigurationServiceProtocol(Protocol):
    """Protocol for LLM configuration management"""

    def get_current_llm_config(self) -> Result[dict[str, Any]]:
        """Get current LLM configuration"""
        ...

    def update_llm_config(self, enabled: bool, model: LLMModelName | None = None,
                         quantization: LLMQuantizationLevel | None = None,
                         prompt: LLMPrompt | None = None) -> Result[None]:
        """Update LLM configuration in memory"""
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


class UpdateLLMConfigUseCase:
    """Use case for updating LLM configuration"""

    def __init__(
        self,
        llm_validation_service: LLMValidationServiceProtocol,
        llm_worker_management_service: LLMWorkerManagementServiceProtocol,
        llm_configuration_service: LLMConfigurationServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ) -> None:
        self._llm_validation = llm_validation_service
        self._llm_worker_management = llm_worker_management_service
        self._llm_configuration = llm_configuration_service
        self._logger = logger_service

    def execute(self, request: UpdateLLMConfigRequest,
    ) -> UpdateLLMConfigResponse:
        """Execute the update LLM configuration operation"""
        start_time = datetime.utcnow()
        response = UpdateLLMConfigResponse(result=LLMUpdateResult.FAILED)

        try:
            self._logger.log_info(
                "Starting LLM configuration update",
                new_enabled=request.update.enabled,
                new_model=request.update.model_name.value if request.update.model_name else None,
                new_quantization=request.update.quantization_level.value if request.update.quantization_level else None,
            )

            # Store current configuration for rollback
            response.previous_enabled = request.current_enabled
            response.previous_model = request.current_model
            response.previous_quantization = request.current_quantization
            response.previous_prompt = request.current_prompt

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.INITIALIZING, 0):
                response.result = LLMUpdateResult.CANCELLED
                return response

            # Determine what needs to be updated
            enabled_to_update = request.update.enabled if request.update.enabled is not None else request.current_enabled
            model_to_update = request.update.model_name or request.current_model
            quantization_to_update = request.update.quantization_level or request.current_quantization
            prompt_to_update = request.update.prompt or request.current_prompt

            # If LLM is being disabled, handle that case
            if enabled_to_update is False:
                return self._handle_llm_disable(request, response, start_time)

            # If LLM is enabled, ensure we have all required parameters
            if enabled_to_update and (not model_to_update or not quantization_to_update or not prompt_to_update):
                response.error_message = "Model, quantization, and prompt must be specified when LLM is enabled"
                return response

            # Phase 2: Validate model
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.VALIDATING_MODEL, 10):
                response.result = LLMUpdateResult.CANCELLED
                return response

            if enabled_to_update and request.update.validate_compatibility and model_to_update:
                model_validation = self._llm_validation.validate_llm_model_name(model_to_update)
                if not model_validation.is_success:
                    response.error_message = f"Invalid LLM model: {model_validation.error}"
                    response.result = LLMUpdateResult.MODEL_NOT_AVAILABLE
                    return response

            # Phase 3: Validate quantization
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.VALIDATING_QUANTIZATION, 20):
                response.result = LLMUpdateResult.CANCELLED
                return response

            if enabled_to_update and request.update.validate_compatibility and quantization_to_update:
                quantization_validation = self._llm_validation.validate_llm_quantization_level(quantization_to_update)
                if not quantization_validation.is_success:
                    response.error_message = f"Invalid LLM quantization: {quantization_validation.error}"
                    response.result = LLMUpdateResult.QUANTIZATION_NOT_SUPPORTED
                    return response

                # Check model-quantization compatibility
                if model_to_update and quantization_to_update:
                    compatibility_result = self._llm_validation.check_llm_compatibility(model_to_update, quantization_to_update)
                    if compatibility_result.is_success:
                        response.compatibility_check = compatibility_result.value
                        if compatibility_result.value == LLMCompatibility.INCOMPATIBLE:
                            response.error_message = (
                                f"LLM model {model_to_update.value} is incompatible with quantization {quantization_to_update.value}")
                            response.result = LLMUpdateResult.VALIDATION_FAILED
                            return response
                        if compatibility_result.value == LLMCompatibility.PARTIALLY_COMPATIBLE:
                            response.warnings.append(f"LLM model {model_to_update.value} has limited compatibility with quantization {quantization_to_update.value}")

            # Phase 4: Validate prompt
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.VALIDATING_PROMPT, 30):
                response.result = LLMUpdateResult.CANCELLED
                return response

            if enabled_to_update and prompt_to_update:
                prompt_validation = self._llm_validation.validate_llm_prompt(prompt_to_update)
                if not prompt_validation.is_success:
                    response.error_message = f"Invalid LLM prompt: {prompt_validation.error}"
                    response.result = LLMUpdateResult.PROMPT_INVALID
                    return response

            # Phase 5: Backup current configuration
            backup_path = None
            if request.update.backup_current_config:
                backup_result = self._llm_configuration.backup_configuration()
                if backup_result.is_success:
                    backup_path = backup_result.value
                    response.backup_config_path = backup_path
                else:
                    response.warnings.append(f"Failed to backup configuration: {backup_result.error}",
    )

            # Phase 6: Stop current worker if needed
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.STOPPING_CURRENT_WORKER, 40):
                response.result = LLMUpdateResult.CANCELLED
                return response

            worker_was_running = self._llm_worker_management.is_llm_worker_running()
            if worker_was_running and request.update.force_restart_worker:
                stop_result = self._llm_worker_management.stop_current_llm_worker()
                if not stop_result.is_success:
                    response.warnings.append(f"Failed to stop current LLM worker: {stop_result.error}",
    )

            # Phase 7: Update configuration
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.UPDATING_CONFIGURATION, 55):
                response.result = LLMUpdateResult.CANCELLED
                return response

            config_update_result = self._llm_configuration.update_llm_config(
                enabled_to_update or False, model_to_update, quantization_to_update, prompt_to_update,
            )
            if not config_update_result.is_success:
                response.error_message = f"Failed to update LLM configuration: {config_update_result.error}"
                # Try to restore backup if available
                if backup_path:
                    restore_result = self._llm_configuration.restore_configuration(backup_path)
                    if not restore_result.is_success:
                        response.warnings.append(f"Failed to restore backup: {restore_result.error}",
    )
                return response

            # Phase 8: Save configuration
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.SAVING_CONFIGURATION, 70):
                response.result = LLMUpdateResult.CANCELLED
                return response

            if request.update.save_to_persistent_config:
                save_result = self._llm_configuration.save_configuration()
                if save_result.is_success:
                    response.configuration_saved = True
                else:
                    response.warnings.append(f"Failed to save configuration: {save_result.error}",
    )
                    response.result = LLMUpdateResult.CONFIGURATION_SAVE_FAILED

            # Phase 9: Restart worker if enabled
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.RESTARTING_WORKER, 85):
                response.result = LLMUpdateResult.CANCELLED
                return response

            if enabled_to_update and request.update.force_restart_worker and model_to_update and quantization_to_update and prompt_to_update:
                worker_start_result = self._llm_worker_management.start_llm_worker_with_config(
                    model_to_update, quantization_to_update, prompt_to_update,
                )
                if worker_start_result.is_success:
                    response.worker_restarted = True
                else:
                    response.error_message = f"Failed to restart LLM worker: {worker_start_result.error}"
                    response.result = LLMUpdateResult.WORKER_RESTART_FAILED
                    # Try to restore backup if available
                    if backup_path:
                        restore_result = self._llm_configuration.restore_configuration(backup_path)
                        if restore_result.is_success:
                            # Try to restart with old config
                            if (request.current_enabled and request.current_model and
                                request.current_quantization and request.current_prompt):
                                self._llm_worker_management.start_llm_worker_with_config(
                                    request.current_model, request.current_quantization, request.current_prompt,
                                )
                    return response

            # Phase 10: Verify update
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.VERIFYING_UPDATE, 95):
                response.result = LLMUpdateResult.CANCELLED
                return response

            # Verify the configuration was applied
            current_config_result = self._llm_configuration.get_current_llm_config()
            if current_config_result.is_success:
                current_config = current_config_result.value
                if current_config is not None:
                    if (current_config.get("llm_enabled") == enabled_to_update and
                        (not enabled_to_update or (
                            model_to_update and current_config.get("llm_model") == model_to_update.value and
                            quantization_to_update and current_config.get("llm_quantization") == quantization_to_update.value and
                            prompt_to_update and current_config.get("llm_prompt") == prompt_to_update.value
                        ))):
                        response.updated_enabled = enabled_to_update
                        response.updated_model = model_to_update
                        response.updated_quantization = quantization_to_update
                        response.updated_prompt = prompt_to_update
                    else:
                        response.warnings.append("LLM configuration update verification failed")

            # Phase 11: Complete
            if not self._update_progress(request.progress_callback, LLMUpdatePhase.COMPLETED, 100):
                response.result = LLMUpdateResult.CANCELLED
                return response

            # Set success response
            response.result = LLMUpdateResult.SUCCESS
            response.update_duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            # Add metadata
            response.metadata = {
                "update_timestamp": start_time.isoformat(),
                "enabled_changed": request.update.enabled is not None,
                "model_changed": request.update.model_name is not None,
                "quantization_changed": request.update.quantization_level is not None,
                "prompt_changed": request.update.prompt is not None,
                "worker_was_running": worker_was_running,
                "backup_created": backup_path is not None,
                "compatibility_checked": request.update.validate_compatibility,
                "force_restart": request.update.force_restart_worker,
            }

            self._logger.log_info(
                "LLM configuration update completed",
                result=response.result.value,
                updated_enabled=response.updated_enabled,
                updated_model=response.updated_model.value if response.updated_model else None,
                updated_quantization=response.updated_quantization.value if response.updated_quantization else None,
                worker_restarted=response.worker_restarted,
                duration_ms=response.update_duration_ms,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during LLM configuration update: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = LLMUpdateResult.FAILED

        return response

    def _handle_llm_disable(self,
    request: UpdateLLMConfigRequest, response: UpdateLLMConfigResponse, start_time: datetime,
    ) -> UpdateLLMConfigResponse:
        """Handle disabling LLM functionality"""
        try:
            # Stop worker if running
            if self._llm_worker_management.is_llm_worker_running():
                disable_result = self._llm_worker_management.disable_llm_worker()
                if not disable_result.is_success:
                    response.warnings.append(f"Failed to disable LLM worker: {disable_result.error}")

            # Update configuration
            config_update_result = self._llm_configuration.update_llm_config(False)
            if not config_update_result.is_success:
                response.error_message = f"Failed to disable LLM in configuration: {config_update_result.error}"
                return response

            # Save configuration if requested
            if request.update.save_to_persistent_config:
                save_result = self._llm_configuration.save_configuration()
                if save_result.is_success:
                    response.configuration_saved = True
                else:
                    response.warnings.append(f"Failed to save configuration: {save_result.error}")

            response.updated_enabled = False
            response.result = LLMUpdateResult.SUCCESS
            response.update_duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            self._logger.log_info("LLM disabled successfully")

        except Exception as e:
            response.error_message = f"Error disabling LLM: {e!s}"
            response.result = LLMUpdateResult.FAILED

        return response

    def _update_progress(self, callback: ProgressCallback | None, phase: LLMUpdatePhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            result = callback(
                progress=ProgressPercentage(percentage),
                message=f"LLM update phase: {phase.value}",
                error=None,
            )
            return result if result is not None else True
        return True