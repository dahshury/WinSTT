"""Update Operation Value Objects.

This module defines value objects for configuration update operations,
including LLM and model update results, phases, and compatibility levels.
"""

from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class LLMUpdateResult(ValueObject, Enum):
    """LLM configuration update results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    VALIDATION_FAILED = "validation_failed"
    MODEL_NOT_AVAILABLE = "model_not_available"
    QUANTIZATION_NOT_SUPPORTED = "quantization_not_supported"
    PROMPT_INVALID = "prompt_invalid"
    WORKER_RESTART_FAILED = "worker_restart_failed"
    CONFIGURATION_SAVE_FAILED = "configuration_save_failed"
    LLM_DISABLED = "llm_disabled"


class LLMUpdatePhase(ValueObject, Enum):
    """LLM configuration update phases"""
    INITIALIZING = "initializing"
    VALIDATING_MODEL = "validating_model"
    VALIDATING_QUANTIZATION = "validating_quantization"
    VALIDATING_PROMPT = "validating_prompt"
    STOPPING_CURRENT_WORKER = "stopping_current_worker"
    UPDATING_CONFIGURATION = "updating_configuration"
    SAVING_CONFIGURATION = "saving_configuration"
    RESTARTING_WORKER = "restarting_worker"
    VERIFYING_UPDATE = "verifying_update"
    COMPLETED = "completed"


class LLMCompatibility(ValueObject, Enum):
    """LLM model compatibility levels"""
    FULLY_COMPATIBLE = "fully_compatible"
    PARTIALLY_COMPATIBLE = "partially_compatible"
    INCOMPATIBLE = "incompatible"
    UNKNOWN = "unknown"


class UpdateResult(ValueObject, Enum):
    """Model configuration update results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    VALIDATION_FAILED = "validation_failed"
    MODEL_NOT_AVAILABLE = "model_not_available"
    QUANTIZATION_NOT_SUPPORTED = "quantization_not_supported"
    WORKER_RESTART_FAILED = "worker_restart_failed"
    CONFIGURATION_SAVE_FAILED = "configuration_save_failed"


class UpdatePhase(ValueObject, Enum):
    """Model configuration update phases"""
    INITIALIZING = "initializing"
    VALIDATING_MODEL = "validating_model"
    VALIDATING_QUANTIZATION = "validating_quantization"
    STOPPING_CURRENT_WORKER = "stopping_current_worker"
    UPDATING_CONFIGURATION = "updating_configuration"
    SAVING_CONFIGURATION = "saving_configuration"
    RESTARTING_WORKER = "restarting_worker"
    VERIFYING_UPDATE = "verifying_update"
    COMPLETED = "completed"


class ModelCompatibility(ValueObject, Enum):
    """Model compatibility levels"""
    FULLY_COMPATIBLE = "fully_compatible"
    PARTIALLY_COMPATIBLE = "partially_compatible"
    INCOMPATIBLE = "incompatible"
    UNKNOWN = "unknown"