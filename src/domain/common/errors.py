"""Domain-specific error types for the WinSTT application.

This module defines domain-specific exceptions and error types that represent
business rule violations and domain-specific error conditions.
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass
from enum import Enum
from typing import Any


class ErrorSeverity(Enum):
    """Severity levels for domain errors."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ErrorCategory(Enum):
    """Categories of domain errors."""
    VALIDATION = "validation"
    BUSINESS_RULE = "business_rule"
    RESOURCE = "resource"
    CONFIGURATION = "configuration"
    OPERATION = "operation"
    SECURITY = "security"
    EXTERNAL_SERVICE = "external_service"


@dataclass(frozen=True)
class DomainError:
    """Base domain error with structured information."""
    code: str
    message: str
    category: ErrorCategory
    severity: ErrorSeverity
    context: dict[str, Any] | None = None
    inner_error: Exception | None = None

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"

    def __repr__(self) -> str:
        return f"DomainError(code='{self.code}', message='{self.message}', category={self.category}, severity={self.severity})"


class DomainException(Exception, ABC):
    """Base class for all domain-specific exceptions."""

    def __init__(self, error: DomainError) -> None:
        self.error = error
        super().__init__(str(error))

    @property
    def code(self) -> str:
        return self.error.code

    @property
    def category(self) -> ErrorCategory:
        return self.error.category

    @property
    def severity(self) -> ErrorSeverity:
        return self.error.severity

    @property
    def context(self) -> dict[str, Any] | None:
        return self.error.context


# ============================================================================
# AUDIO DOMAIN ERRORS
# ============================================================================

class AudioDomainException(DomainException):
    """Base exception for audio domain errors."""


class AudioValidationException(AudioDomainException):
    """Exception for audio validation errors."""
    
    @classmethod
    def invalid_sample_rate(cls, sample_rate: int) -> AudioValidationException:
        error = DomainError(
            code="AUDIO_INVALID_SAMPLE_RATE",
            message=f"Invalid sample rate: {sample_rate}. Supported rates: 16000, 22050, 44100, 48000",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"sample_rate": sample_rate},
        )
        return cls(error)
    
    @classmethod
    def empty_audio_data(cls) -> AudioValidationException:
        error = DomainError(
            code="AUDIO_EMPTY_DATA",
            message="Audio data cannot be empty",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
        )
        return cls(error)
    
    @classmethod
    def audio_too_short(cls, duration: float, min_duration: float) -> AudioValidationException:
        error = DomainError(
            code="AUDIO_TOO_SHORT",
            message=f"Audio duration {duration:.2f}s is too short. Minimum: {min_duration:.2f}s",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"duration": duration, "min_duration": min_duration},
        )
        return cls(error)


class AudioProcessingException(AudioDomainException):
    """Exception for audio processing errors."""
    
    @classmethod
    def processing_failed(cls, operation: str, reason: str) -> AudioProcessingException:
        error = DomainError(
            code="AUDIO_PROCESSING_FAILED",
            message=f"Audio processing failed during {operation}: {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"operation": operation, "reason": reason},
        )
        return cls(error)
    
    @classmethod
    def normalization_failed(cls, reason: str) -> AudioProcessingException:
        error = DomainError(
            code="AUDIO_NORMALIZATION_FAILED",
            message=f"Audio normalization failed: {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"reason": reason},
        )
        return cls(error)


class AudioSessionException(AudioDomainException):
    """Exception for audio session errors."""
    
    @classmethod
    def session_already_active(cls, session_id: str) -> AudioSessionException:
        error = DomainError(
            code="AUDIO_SESSION_ALREADY_ACTIVE",
            message=f"Audio session {session_id} is already active",
            category=ErrorCategory.BUSINESS_RULE,
            severity=ErrorSeverity.ERROR,
            context={"session_id": session_id},
        )
        return cls(error)
    
    @classmethod
    def session_not_found(cls, session_id: str) -> AudioSessionException:
        error = DomainError(
            code="AUDIO_SESSION_NOT_FOUND",
            message=f"Audio session {session_id} not found",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"session_id": session_id},
        )
        return cls(error)


# ============================================================================
# TRANSCRIPTION DOMAIN ERRORS
# ============================================================================

class TranscriptionDomainException(DomainException):
    """Base exception for transcription domain errors."""


class ModelException(TranscriptionDomainException):
    """Exception for model-related errors."""
    
    @classmethod
    def model_not_found(cls, model_name: str) -> ModelException:
        error = DomainError(
            code="MODEL_NOT_FOUND",
            message=f"Model '{model_name}' not found",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"model_name": model_name},
        )
        return cls(error)
    
    @classmethod
    def model_load_failed(cls, model_name: str, reason: str) -> ModelException:
        error = DomainError(
            code="MODEL_LOAD_FAILED",
            message=f"Failed to load model '{model_name}': {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.CRITICAL,
            context={"model_name": model_name, "reason": reason},
        )
        return cls(error)
    
    @classmethod
    def unsupported_model_type(cls, model_type: str) -> ModelException:
        error = DomainError(
            code="UNSUPPORTED_MODEL_TYPE",
            message=f"Unsupported model type: {model_type}",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"model_type": model_type},
        )
        return cls(error)


class TranscriptionException(TranscriptionDomainException):
    """Exception for transcription operation errors."""
    
    @classmethod
    def transcription_failed(cls, reason: str) -> TranscriptionException:
        error = DomainError(
            code="TRANSCRIPTION_FAILED",
            message=f"Transcription failed: {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"reason": reason},
        )
        return cls(error)
    
    @classmethod
    def transcription_timeout(cls, timeout_seconds: int) -> TranscriptionException:
        error = DomainError(
            code="TRANSCRIPTION_TIMEOUT",
            message=f"Transcription timed out after {timeout_seconds} seconds",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"timeout_seconds": timeout_seconds},
        )
        return cls(error)


# ============================================================================
# SETTINGS DOMAIN ERRORS
# ============================================================================

class SettingsDomainException(DomainException):
    """Base exception for settings domain errors."""


class ConfigurationException(SettingsDomainException):
    """Exception for configuration errors."""
    
    @classmethod
    def invalid_configuration(cls, setting_name: str, value: Any, reason: str) -> ConfigurationException:
        error = DomainError(
            code="INVALID_CONFIGURATION",
            message=f"Invalid configuration for '{setting_name}': {reason}",
            category=ErrorCategory.CONFIGURATION,
            severity=ErrorSeverity.ERROR,
            context={"setting_name": setting_name, "value": value, "reason": reason},
        )
        return cls(error)
    
    @classmethod
    def configuration_not_found(cls, setting_name: str) -> ConfigurationException:
        error = DomainError(
            code="CONFIGURATION_NOT_FOUND",
            message=f"Configuration '{setting_name}' not found",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"setting_name": setting_name},
        )
        return cls(error)


class HotkeyException(SettingsDomainException):
    """Exception for hotkey-related errors."""
    
    @classmethod
    def invalid_key_combination(cls, combination: str) -> HotkeyException:
        error = DomainError(
            code="INVALID_KEY_COMBINATION",
            message=f"Invalid key combination: {combination}",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"combination": combination},
        )
        return cls(error)
    
    @classmethod
    def hotkey_already_registered(cls, combination: str) -> HotkeyException:
        error = DomainError(
            code="HOTKEY_ALREADY_REGISTERED",
            message=f"Hotkey combination '{combination}' is already registered",
            category=ErrorCategory.BUSINESS_RULE,
            severity=ErrorSeverity.ERROR,
            context={"combination": combination},
        )
        return cls(error)


# ============================================================================
# MEDIA DOMAIN ERRORS
# ============================================================================

class MediaDomainException(DomainException):
    """Base exception for media domain errors."""


class MediaFileException(MediaDomainException):
    """Exception for media file errors."""
    
    @classmethod
    def file_not_found(cls, file_path: str) -> MediaFileException:
        error = DomainError(
            code="MEDIA_FILE_NOT_FOUND",
            message=f"Media file not found: {file_path}",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"file_path": file_path},
        )
        return cls(error)
    
    @classmethod
    def unsupported_format(cls, file_path: str, format_type: str) -> MediaFileException:
        error = DomainError(
            code="UNSUPPORTED_MEDIA_FORMAT",
            message=f"Unsupported media format '{format_type}' for file: {file_path}",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"file_path": file_path, "format_type": format_type},
        )
        return cls(error)
    
    @classmethod
    def file_corrupted(cls, file_path: str, reason: str) -> MediaFileException:
        error = DomainError(
            code="MEDIA_FILE_CORRUPTED",
            message=f"Media file is corrupted: {file_path}. Reason: {reason}",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"file_path": file_path, "reason": reason},
        )
        return cls(error)


class ConversionException(MediaDomainException):
    """Exception for media conversion errors."""
    
    @classmethod
    def conversion_failed(cls, source_format: str, target_format: str, reason: str) -> ConversionException:
        error = DomainError(
            code="MEDIA_CONVERSION_FAILED",
            message=f"Failed to convert from {source_format} to {target_format}: {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"source_format": source_format, "target_format": target_format, "reason": reason},
        )
        return cls(error)


# ============================================================================
# SYSTEM INTEGRATION DOMAIN ERRORS
# ============================================================================

class SystemIntegrationException(DomainException):
    """Base exception for system integration errors."""


class SystemResourceException(SystemIntegrationException):
    """Exception for system resource errors."""
    
    @classmethod
    def insufficient_memory(cls, required_mb: int, available_mb: int) -> SystemResourceException:
        error = DomainError(
            code="INSUFFICIENT_MEMORY",
            message=f"Insufficient memory. Required: {required_mb}MB, Available: {available_mb}MB",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.CRITICAL,
            context={"required_mb": required_mb, "available_mb": available_mb},
        )
        return cls(error)
    
    @classmethod
    def disk_space_low(cls, required_mb: int, available_mb: int) -> SystemResourceException:
        error = DomainError(
            code="DISK_SPACE_LOW",
            message=f"Insufficient disk space. Required: {required_mb}MB, Available: {available_mb}MB",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.WARNING,
            context={"required_mb": required_mb, "available_mb": available_mb},
        )
        return cls(error)


# ============================================================================
# WORKER MANAGEMENT DOMAIN ERRORS
# ============================================================================

class WorkerManagementException(DomainException):
    """Base exception for worker management errors."""


class WorkerException(WorkerManagementException):
    """Exception for worker-related errors."""
    
    @classmethod
    def worker_not_found(cls, worker_id: str) -> WorkerException:
        error = DomainError(
            code="WORKER_NOT_FOUND",
            message=f"Worker {worker_id} not found",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"worker_id": worker_id},
        )
        return cls(error)
    
    @classmethod
    def worker_already_running(cls, worker_id: str) -> WorkerException:
        error = DomainError(
            code="WORKER_ALREADY_RUNNING",
            message=f"Worker {worker_id} is already running",
            category=ErrorCategory.BUSINESS_RULE,
            severity=ErrorSeverity.ERROR,
            context={"worker_id": worker_id},
        )
        return cls(error)
    
    @classmethod
    def worker_execution_failed(cls, worker_id: str, reason: str) -> WorkerException:
        error = DomainError(
            code="WORKER_EXECUTION_FAILED",
            message=f"Worker {worker_id} execution failed: {reason}",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context={"worker_id": worker_id, "reason": reason},
        )
        return cls(error)


# ============================================================================
# PROGRESS MANAGEMENT DOMAIN ERRORS
# ============================================================================

class ProgressManagementException(DomainException):
    """Base exception for progress management errors."""


class ProgressException(ProgressManagementException):
    """Exception for progress-related errors."""
    
    @classmethod
    def invalid_progress_value(cls, value: float) -> ProgressException:
        error = DomainError(
            code="INVALID_PROGRESS_VALUE",
            message=f"Invalid progress value: {value}. Must be between 0.0 and 1.0",
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context={"value": value},
        )
        return cls(error)
    
    @classmethod
    def progress_session_not_found(cls, session_id: str) -> ProgressException:
        error = DomainError(
            code="PROGRESS_SESSION_NOT_FOUND",
            message=f"Progress session {session_id} not found",
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context={"session_id": session_id},
        )
        return cls(error)


# ============================================================================
# EXTERNAL SERVICE DOMAIN ERRORS
# ============================================================================

class ExternalServiceException(DomainException):
    """Base exception for external service errors."""


class LLMServiceException(ExternalServiceException):
    """Exception for LLM service errors."""
    
    @classmethod
    def service_unavailable(cls, service_name: str) -> LLMServiceException:
        error = DomainError(
            code="LLM_SERVICE_UNAVAILABLE",
            message=f"LLM service '{service_name}' is unavailable",
            category=ErrorCategory.EXTERNAL_SERVICE,
            severity=ErrorSeverity.ERROR,
            context={"service_name": service_name},
        )
        return cls(error)
    
    @classmethod
    def api_quota_exceeded(cls, service_name: str) -> LLMServiceException:
        error = DomainError(
            code="LLM_API_QUOTA_EXCEEDED",
            message=f"API quota exceeded for LLM service '{service_name}'",
            category=ErrorCategory.EXTERNAL_SERVICE,
            severity=ErrorSeverity.WARNING,
            context={"service_name": service_name},
        )
        return cls(error)
    
    @classmethod
    def invalid_api_key(cls, service_name: str) -> LLMServiceException:
        error = DomainError(
            code="LLM_INVALID_API_KEY",
            message=f"Invalid API key for LLM service '{service_name}'",
            category=ErrorCategory.SECURITY,
            severity=ErrorSeverity.ERROR,
            context={"service_name": service_name},
        )
        return cls(error)