"""Audio Validation Service.

This module implements the AudioValidationService for validating audio
configurations, data, and operations with comprehensive validation rules.
"""

import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

import numpy as np

# Import domain concepts
# Use the canonical domain validation types from validation_operations to avoid
# name/shape conflicts with similarly named classes in validation.py
from src.domain.audio.value_objects.validation_operations import (
    ValidationCategory,
    ValidationIssue,
    ValidationRule,
    ValidationSeverity,
    ValidationType,
)


class ValidationStatus(Enum):
    """Infrastructure validation status for operations."""
    VALID = "valid"
    INVALID = "invalid"
    WARNING = "warning"
    ERROR = "error"
    UNSUPPORTED = "unsupported"
    PARTIAL = "partial"


# AudioFormat is now imported from domain layer
# Infrastructure-specific validation format mapping
class ValidationAudioFormat(Enum):
    """Audio formats for validation purposes."""
    WAV = "wav"
    MP3 = "mp3"
    FLAC = "flac"
    OGG = "ogg"
    M4A = "m4a"
    AAC = "aac"
    WMA = "wma"
    RAW = "raw"
    PCM = "pcm"


# ValidationCategory, ValidationRule, and ValidationIssue are now imported from domain layer


@dataclass
class AudioConfiguration:
    """Audio configuration for validation."""
    sample_rate: int = 44100
    channels: int = 2
    bit_depth: int = 16
    format: ValidationAudioFormat = ValidationAudioFormat.WAV
    buffer_size: int = 4096
    device_id: int | None = None
    codec: str | None = None
    quality: str | None = None
    compression: float | None = None
    metadata: dict[str, Any] | None = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


@dataclass
class AudioDataInfo:
    """Audio data information for validation."""
    data: np.ndarray | None = None
    file_path: Path | None = None
    size_bytes: int | None = None
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    bit_depth: int | None = None
    format: ValidationAudioFormat | None = None
    codec: str | None = None
    checksum: str | None = None
    metadata: dict[str, Any] | None = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


@dataclass
class DeviceInfo:
    """Audio device information for validation."""
    device_id: int
    name: str
    type: str  # input/output
    driver: str | None = None
    max_input_channels: int = 0
    max_output_channels: int = 0
    default_sample_rate: float = 44100.0
    supported_sample_rates: list[float] | None = None
    supported_formats: list[str] | None = None
    latency: float | None = None
    is_default: bool = False
    is_available: bool = True
    metadata: dict[str, Any] | None = None

    def __post_init__(self):
        if self.supported_sample_rates is None:
            self.supported_sample_rates = [44100.0, 48000.0]
        if self.supported_formats is None:
            self.supported_formats = ["int16", "int24", "int32", "float32"]
        if self.metadata is None:
            self.metadata = {}


@dataclass
class ValidationRequest:
    """Request for audio validation."""
    validation_types: list[ValidationType]
    config: AudioConfiguration | None = None
    audio_data: AudioDataInfo | None = None
    device_info: DeviceInfo | None = None
    file_path: Path | None = None
    rules: list[ValidationRule] | None = None
    strict_mode: bool = False
    auto_fix: bool = False
    include_warnings: bool = True
    include_suggestions: bool = True
    timeout: float = 10.0
    enable_logging: bool = True

    def __post_init__(self,
    ):
        if self.rules is None:
            self.rules = []


@dataclass
class ValidationReport:
    """Validation report with results."""
    is_valid: bool
    overall_status: ValidationStatus
    issues: list[ValidationIssue]
    warnings: list[str]
    errors: list[str]
    suggestions: list[str]
    auto_fixes_applied: list[str]
    validation_summary: dict[ValidationType, ValidationStatus]
    performance_metrics: dict[str, float] | None = None
    metadata: dict[str, Any] | None = None

    def __post_init__(self):
        if self.performance_metrics is None:
            self.performance_metrics = {}
        if self.metadata is None:
            self.metadata = {}


@dataclass
class AudioValidationServiceState:
    """Current state of audio validation service."""
    initialized: bool = False
    available_rules: list[ValidationRule] | None = None
    active_rules: list[ValidationRule] | None = None
    validation_history: list[ValidationReport] | None = None
    performance_stats: dict[str, Any] | None = None
    error_message: str | None = None

    def __post_init__(self):
        if self.available_rules is None:
            self.available_rules = []
        if self.active_rules is None:
            self.active_rules = []
        if self.validation_history is None:
            self.validation_history = []
        if self.performance_stats is None:
            self.performance_stats = {}


@dataclass
class AudioValidationServiceResponse:
    """Response from audio validation service."""
    status: ValidationStatus
    state: AudioValidationServiceState
    report: ValidationReport | None = None
    fixed_config: AudioConfiguration | None = None
    fixed_data: AudioDataInfo | None = None
    recommendations: list[str] | None = None
    error_message: str | None = None
    warnings: list[str] | None = None
    execution_time: float = 0.0

    def __post_init__(self):
        if self.recommendations is None:
            self.recommendations = []
        if self.warnings is None:
            self.warnings = []


class AudioFormatServiceProtocol(Protocol,
    ):
    """Protocol for audio format service."""

    def get_format_info(self, format: ValidationAudioFormat,
    ) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get format information."""
        ...

    def is_format_supported(self, format: ValidationAudioFormat,
    ) -> tuple[bool, str | None]:
        """Check if format is supported."""
        ...

    def validate_format_compatibility(self,
    source_format: ValidationAudioFormat, target_format: ValidationAudioFormat,
    ) -> tuple[bool, str | None]:
        """Validate format compatibility."""
        ...


class AudioDeviceServiceProtocol(Protocol):
    """Protocol for audio device service."""

    def get_device_info(self, device_id: int,
    ) -> tuple[bool, DeviceInfo | None, str | None]:
        """Get device information."""
        ...

    def test_device_compatibility(self, device_id: int, config: AudioConfiguration,
    ) -> tuple[bool, str | None]:
        """Test device compatibility."""
        ...

    def list_devices(self) -> tuple[bool, list[DeviceInfo], str | None]:
        """List available devices."""
        ...


class AudioFileServiceProtocol(Protocol):
    """Protocol for audio file service."""

    def validate_file(self, file_path: Path,
    ) -> tuple[bool, str | None]:
        """Validate audio file."""
        ...

    def get_file_info(self, file_path: Path,
    ) -> tuple[bool, AudioDataInfo | None, str | None]:
        """Get file information."""
        ...

    def check_file_integrity(self, file_path: Path,
    ) -> tuple[bool, str | None]:
        """Check file integrity."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message."""
        ...


class AudioValidationService:
    """Service for validating audio configurations, data, and operations."""

    def __init__(
        self,
        format_service: AudioFormatServiceProtocol | None = None,
        device_service: AudioDeviceServiceProtocol | None = None,
        file_service: AudioFileServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._format_service = format_service
        self._device_service = device_service
        self._file_service = file_service
        self._logger_service = logger_service

        self._state = AudioValidationServiceState()
        self._initialize_default_rules()

    def execute(self, request: ValidationRequest,
    ) -> AudioValidationServiceResponse:
        """Execute audio validation."""
        start_time = time.time()
        warnings: list[str] = []

        try:
            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting audio validation",
                    validation_types=[vt.value for vt in request.validation_types],
                )

            # Initialize if needed
            if not self._state.initialized:
                self._initialize_service()

            # Create validation report
            report = ValidationReport(
                is_valid=True,
                overall_status=ValidationStatus.VALID,
                issues=[],
                warnings=[],
                errors=[],
                suggestions=[],
                auto_fixes_applied=[],
                validation_summary={},
            )

            # Get active rules
            active_rules = request.rules if request.rules is not None else self._state.active_rules
            # Ensure active_rules is a concrete list
            active_rules = active_rules or []

            # Perform validations
            for validation_type in request.validation_types:
                validation_result = self._perform_validation(
                    validation_type, request, active_rules, report,
                )
                report.validation_summary[validation_type] = validation_result

                if validation_result in [ValidationStatus.INVALID, ValidationStatus.ERROR]:
                    report.is_valid = False
                    report.overall_status = ValidationStatus.INVALID

            # Apply auto-fixes if requested
            fixed_config = None
            fixed_data = None
            if request.auto_fix:
                fixed_config, fixed_data = self._apply_auto_fixes(request, report)

            # Generate recommendations
            recommendations = self._generate_recommendations(request, report)

            # Update performance metrics
            execution_time = time.time() - start_time
            report.performance_metrics = {
                "execution_time": execution_time,
                "rules_evaluated": len(active_rules),
                "issues_found": len(report.issues),
            }

            # Add to history
            history = self._state.validation_history or []
            history.append(report)
            if len(history) > 100:  # Keep last 100 reports
                history.pop(0)
            self._state.validation_history = history

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Audio validation completed",
                    is_valid=report.is_valid,
                    issues_count=len(report.issues),
                    execution_time=execution_time,
                )

            return AudioValidationServiceResponse(
                status=report.overall_status,
                state=self._state,
                report=report,
                fixed_config=fixed_config,
                fixed_data=fixed_data,
                recommendations=recommendations,
                warnings=warnings,
                execution_time=execution_time,
            )

        except Exception as e:
            error_message = f"Audio validation failed: {e!s}"
            self._state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Audio validation error",
                    error=str(e),
                    execution_time=time.time() - start_time,
                )

            return AudioValidationServiceResponse(
                status=ValidationStatus.ERROR,
                state=self._state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
            )

    def _initialize_service(self) -> None:
        """Initialize the validation service."""
        self._state.initialized = True
        # There is no enabled flag on ValidationRule (immutable VO). Treat all as active by default.
        self._state.active_rules = list(self._state.available_rules or [])

    def _initialize_default_rules(self) -> None:
        """Initialize default validation rules."""
        default_rules = [
            # Sample rate validation
            ValidationRule(
                rule_id="sample_rate_range",
                name="Sample Rate Range",
                description="Validate sample rate is within supported range",
                category=ValidationCategory.TECHNICAL,
                severity=ValidationSeverity.ERROR,
                validation_type=ValidationType.SAMPLE_RATE,
                parameters={"min_rate": 8000, "max_rate": 192000, "common_rates": [44100, 48000, 96000]},
            ),
            # Channel validation
            ValidationRule(
                rule_id="channel_count",
                name="Channel Count",
                description="Validate channel count is supported",
                category=ValidationCategory.TECHNICAL,
                severity=ValidationSeverity.ERROR,
                validation_type=ValidationType.CHANNELS,
                parameters={"min_channels": 1, "max_channels": 8, "common_channels": [1, 2]},
            ),

            # Bit depth validation
            ValidationRule(
                rule_id="bit_depth_standard",
                name="Bit Depth Standard",
                description="Validate bit depth is a standard value",
                category=ValidationCategory.TECHNICAL,
                severity=ValidationSeverity.WARNING,
                validation_type=ValidationType.FORMAT,
                parameters={"supported_depths": [8, 16, 24, 32]},
            ),
            # Buffer size validation
            ValidationRule(
                rule_id="buffer_size_power_of_two",
                name="Buffer Size Power of Two",
                description="Validate buffer size is a power of two",
                category=ValidationCategory.PERFORMANCE,
                severity=ValidationSeverity.WARNING,
                validation_type=ValidationType.FORMAT,
                parameters={"min_size": 64, "max_size": 8192},
            ),
            # Audio format validation
            ValidationRule(
                rule_id="format_support",
                name="Format Support",
                description="Validate audio format is supported",
                category=ValidationCategory.TECHNICAL,
                severity=ValidationSeverity.ERROR,
                validation_type=ValidationType.FORMAT,
                parameters={"supported_formats": ["wav", "mp3", "flac", "ogg"]},
            ),
            # Data integrity validation
            ValidationRule(
                rule_id="data_integrity",
                name="Data Integrity",
                description="Validate audio data integrity",
                category=ValidationCategory.TECHNICAL,
                severity=ValidationSeverity.ERROR,
                validation_type=ValidationType.QUALITY,
                parameters={"check_nan": True, "check_inf": True, "check_range": True},
            ),
            # Performance validation
            ValidationRule(
                rule_id="performance_check",
                name="Performance Check",
                description="Validate configuration for performance",
                category=ValidationCategory.PERFORMANCE,
                severity=ValidationSeverity.WARNING,
                validation_type=ValidationType.FORMAT,
                parameters={"max_latency_ms": 50, "min_buffer_count": 2},
            ),
        ]

        self._state.available_rules = default_rules

    def _perform_validation(
        self,
        validation_type: ValidationType,
        request: ValidationRequest,
        rules: list[ValidationRule],
        report: ValidationReport,
    ) -> ValidationStatus:
        """Perform specific validation type."""
        try:
            # Get rules for this validation type
            type_rules = [rule for rule in rules if rule.validation_type == validation_type]

            if not type_rules:
                return ValidationStatus.VALID

            validation_result = ValidationStatus.VALID

            for rule in type_rules:
                rule_result = self._apply_validation_rule(rule, request, report)

                # Update overall result
                if rule_result == ValidationStatus.INVALID:
                    validation_result = ValidationStatus.INVALID
                elif rule_result == ValidationStatus.WARNING and validation_result == ValidationStatus.VALID:
                    validation_result = ValidationStatus.WARNING

            return validation_result

        except Exception as e:
            issue = ValidationIssue(
                rule_id="system",
                severity=ValidationSeverity.ERROR,
                message=f"Validation error: {e!s}",
                field_path="validation",
                actual_value=None,
                expected_value=None,
                suggestion=f"Check {validation_type.value} validation configuration",
            )
            report.issues.append(issue)
            report.errors.append(str(e))

            return ValidationStatus.ERROR

    def _apply_validation_rule(
        self,
        rule: ValidationRule,
        request: ValidationRequest,
        report: ValidationReport,
    ) -> ValidationStatus:
        """Apply a specific validation rule."""
        try:
            if rule.validation_type == ValidationType.SAMPLE_RATE:
                return self._validate_sample_rate(rule, request, report)
            if rule.validation_type == ValidationType.CHANNELS:
                return self._validate_channels(rule, request, report)
            if rule.validation_type == ValidationType.QUALITY:
                return self._validate_bit_depth(rule, request, report)
            if rule.validation_type == ValidationType.FORMAT:
                return self._validate_audio_format(rule, request, report)
            if rule.validation_type == ValidationType.QUALITY:
                return self._validate_data_integrity(rule, request, report)
            if rule.validation_type == ValidationType.DEVICE:
                return self._validate_device_compatibility(rule, request, report)
            if rule.validation_type == ValidationType.FORMAT:
                return self._validate_file_format(rule, request, report)
            if rule.validation_type == ValidationType.QUALITY:
                return self._validate_performance(rule, request, report)
            return ValidationStatus.VALID

        except Exception as e:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=ValidationSeverity.ERROR,
                message=f"Rule application error: {e!s}",
                field_path="rule_application",
                actual_value=None,
                expected_value=None,
                suggestion=f"Check rule {rule.name} configuration",
            )
            report.issues.append(issue)

            return ValidationStatus.ERROR

    def _validate_sample_rate(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate sample rate."""
        if not request.config:
            return ValidationStatus.VALID

        sample_rate = request.config.sample_rate
        params = rule.parameters

        min_rate = params.get("min_rate", 8000)
        max_rate = params.get("max_rate", 192000)
        common_rates = params.get("common_rates", [44100, 48000])

        if sample_rate < min_rate or sample_rate > max_rate:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Sample rate {sample_rate} is out of range",
                field_path="sample_rate",
                actual_value=sample_rate,
                expected_value=f"{min_rate}-{max_rate} Hz",
                suggestion="Consider using a sample rate between the specified range",
            )
            report.issues.append(issue)

            if rule.severity == ValidationSeverity.ERROR:
                report.errors.append(issue.message)
                return ValidationStatus.INVALID
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        # Check if it's a common rate
        if sample_rate not in common_rates:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=ValidationSeverity.WARNING,
                message=f"Sample rate {sample_rate} is not commonly used",
                field_path="sample_rate",
                actual_value=sample_rate,
                expected_value=f"Common rates: {common_rates}",
                suggestion="Consider using 44100 or 48000 Hz for better compatibility",
            )
            report.issues.append(issue)
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_channels(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate channel count."""
        if not request.config:
            return ValidationStatus.VALID

        channels = request.config.channels
        params = rule.parameters

        min_channels = params.get("min_channels", 1)
        max_channels = params.get("max_channels", 8)

        if channels < min_channels or channels > max_channels:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Channel count {channels} is out of range",
                field_path="channels",
                actual_value=channels,
                expected_value=f"{min_channels}-{max_channels} channels",
                suggestion="Consider using a channel count within the supported range",
            )
            report.issues.append(issue)

            if rule.severity == ValidationSeverity.ERROR:
                report.errors.append(issue.message)
                return ValidationStatus.INVALID
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_bit_depth(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate bit depth."""
        if not request.config:
            return ValidationStatus.VALID

        bit_depth = request.config.bit_depth
        params = rule.parameters

        supported_depths = params.get("supported_depths", [8, 16, 24, 32])

        if bit_depth not in supported_depths:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Bit depth {bit_depth} is not standard",
                field_path="bit_depth",
                actual_value=bit_depth,
                expected_value=f"Supported depths: {supported_depths}",
                suggestion="Consider using a standard bit depth (8, 16, 24, or 32 bits)",
            )
            report.issues.append(issue)

            if rule.severity == ValidationSeverity.ERROR:
                report.errors.append(issue.message)
                return ValidationStatus.INVALID
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_buffer_size(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate buffer size."""
        if not request.config:
            return ValidationStatus.VALID

        buffer_size = request.config.buffer_size
        params = rule.parameters

        min_size = params.get("min_size", 64)
        max_size = params.get("max_size", 8192)

        # Check range
        if buffer_size < min_size or buffer_size > max_size:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=ValidationSeverity.ERROR,
                message=f"Buffer size {buffer_size} is out of range",
                field_path="buffer_size",
                actual_value=buffer_size,
                expected_value=f"{min_size}-{max_size}",
                suggestion="Use a buffer size within the supported range",
            )
            report.issues.append(issue)
            report.errors.append(issue.message)
            return ValidationStatus.INVALID

        # Check if power of two
        if buffer_size & (buffer_size - 1) != 0:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Buffer size {buffer_size} is not a power of two",
                field_path="buffer_size",
                actual_value=buffer_size,
                expected_value="Power of two (e.g., 512, 1024, 2048, 4096)",
                suggestion="Consider using a power of two buffer size for better performance",
            )
            report.issues.append(issue)
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_audio_format(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate audio format."""
        if not request.config:
            return ValidationStatus.VALID

        format_value = request.config.format.value
        params = rule.parameters

        supported_formats = params.get("supported_formats", ["wav", "mp3", "flac"])

        if format_value not in supported_formats:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Audio format {format_value} is not supported",
                field_path="format",
                actual_value=format_value,
                expected_value=f"Supported formats: {supported_formats}",
                suggestion="Consider using a supported audio format",
            )
            report.issues.append(issue)

            if rule.severity == ValidationSeverity.ERROR:
                report.errors.append(issue.message)
                return ValidationStatus.INVALID
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_data_integrity(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate audio data integrity."""
        if not request.audio_data or request.audio_data.data is None:
            return ValidationStatus.VALID

        data = request.audio_data.data
        params = rule.parameters

        check_nan = params.get("check_nan", True)
        check_inf = params.get("check_inf", True)
        check_range = params.get("check_range", True)

        issues_found = []

        # Check for NaN values
        if check_nan and np.isnan(data).any():
            issues_found.append("Contains NaN values")

        # Check for infinite values
        if check_inf and np.isinf(data).any():
            issues_found.append("Contains infinite values")

        # Check value range
        if check_range:
            if data.dtype in (np.float32, np.float64):
                if np.abs(data).max() > 1.0:
                    issues_found.append("Float values exceed [-1.0, 1.0] range")
            elif data.dtype == np.int16 and (data.min() < -32768 or data.max() > 32767):
                issues_found.append("Int16 values exceed [-32768, 32767] range")

        if issues_found:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Data integrity issues: {', '.join(issues_found)}",
                field_path="audio_data",
                actual_value=None,
                expected_value="Valid audio data without NaN, infinite, or out-of-range values",
                suggestion="Clean the audio data to remove invalid values",
            )
            report.issues.append(issue)

            if rule.severity == ValidationSeverity.ERROR:
                report.errors.append(issue.message)
                return ValidationStatus.INVALID
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_device_compatibility(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate device compatibility."""
        if not request.device_info or not request.config:
            return ValidationStatus.VALID

        device = request.device_info
        config = request.config

        issues_found = []

        # Check sample rate support
        if device.supported_sample_rates and config.sample_rate not in device.supported_sample_rates:
    
            issues_found.append(f"Sample rate {config.sample_rate} not supported by device")

        # Check channel count
        if device.type == "output" and config.channels > device.max_output_channels:
            issues_found.append(f"Channel count {config.channels} exceeds device maximum {device.max_output_channels}")
        elif device.type == "input" and config.channels > device.max_input_channels:
            issues_found.append(f"Channel count {config.channels} exceeds device maximum {device.max_input_channels}")

        # Check device availability
        if not device.is_available:
            issues_found.append("Device is not available")

        if issues_found:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=ValidationSeverity.ERROR,
                message=f"Device compatibility issues: {', '.join(issues_found)}",
                field_path="device_compatibility",
                actual_value=None,
                expected_value="Configuration compatible with device capabilities",
                suggestion="Adjust configuration to match device capabilities",
            )
            report.issues.append(issue)
            report.errors.append(issue.message)
            return ValidationStatus.INVALID

        return ValidationStatus.VALID

    def _validate_file_format(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate file format."""
        if not request.file_path:
            return ValidationStatus.VALID

        file_path = request.file_path

        # Check file extension
        extension = file_path.suffix.lower().lstrip(".")
        supported_extensions = ["wav", "mp3", "flac", "ogg", "m4a"]

        if extension not in supported_extensions:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=ValidationSeverity.WARNING,
                message=f"File extension '{extension}' may not be supported",
                field_path="file_format",
                actual_value=extension,
                expected_value=f"Supported extensions: {supported_extensions}",
                suggestion="Use a supported audio file format",
            )
            report.issues.append(issue)
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _validate_performance(self,
    rule: ValidationRule, request: ValidationRequest, report: ValidationReport,
    ) -> ValidationStatus:
        """Validate performance characteristics."""
        if not request.config:
            return ValidationStatus.VALID

        config = request.config
        params = rule.parameters

        max_latency_ms = params.get("max_latency_ms", 50)
        params.get("min_buffer_count", 2)

        # Calculate estimated latency
        estimated_latency = (config.buffer_size / config.sample_rate) * 1000  # ms

        if estimated_latency > max_latency_ms:
            issue = ValidationIssue(
                rule_id=rule.rule_id,
                severity=rule.severity,
                message=f"Estimated latency {estimated_latency:.1f}ms exceeds maximum {max_latency_ms}ms",
                field_path="performance",
                actual_value=estimated_latency,
                expected_value=f"<= {max_latency_ms}ms",
                suggestion="Reduce buffer size to decrease latency",
            )
            report.issues.append(issue)
            report.warnings.append(issue.message)
            return ValidationStatus.WARNING

        return ValidationStatus.VALID

    def _apply_auto_fixes(self,
    request: ValidationRequest, report: ValidationReport,
    ) -> tuple[AudioConfiguration | None, AudioDataInfo | None]:
        """Apply automatic fixes to configuration and data."""
        fixed_config = None
        fixed_data = None

        if request.config:
            fixed_config = AudioConfiguration(
                sample_rate=request.config.sample_rate,
                channels=request.config.channels,
                bit_depth=request.config.bit_depth,
                format=request.config.format,
                buffer_size=request.config.buffer_size,
                device_id=request.config.device_id,
                codec=request.config.codec,
                quality=request.config.quality,
                compression=request.config.compression,
                metadata=request.config.metadata.copy() if request.config.metadata else {},
            )

            # Apply fixes based on issues
            for issue in report.issues:
                # Check if this is a sample rate issue
                if issue.field_path and "sample_rate" in issue.field_path:
                    if fixed_config.sample_rate < 8000:
                        fixed_config.sample_rate = 44100
                        report.auto_fixes_applied.append("Fixed sample rate to 44100 Hz")
                    elif fixed_config.sample_rate > 192000:
                        fixed_config.sample_rate = 48000
                        report.auto_fixes_applied.append("Fixed sample rate to 48000 Hz")

                # Check if this is a channels issue
                elif issue.field_path and "channels" in issue.field_path:
                    if fixed_config.channels < 1:
                        fixed_config.channels = 1
                        report.auto_fixes_applied.append("Fixed channels to 1 (mono)")
                    elif fixed_config.channels > 8:
                        fixed_config.channels = 2
                        report.auto_fixes_applied.append("Fixed channels to 2 (stereo)")

                # Check if this is a bit depth issue
                elif issue.field_path and "bit_depth" in issue.field_path:
                    if fixed_config.bit_depth not in [8, 16, 24, 32]:
                        fixed_config.bit_depth = 16
                        report.auto_fixes_applied.append("Fixed bit depth to 16-bit")

                # Check if this is a buffer size issue
                elif issue.field_path and "buffer_size" in issue.field_path:
                    if fixed_config.buffer_size < 64:
                        fixed_config.buffer_size = 512
                        report.auto_fixes_applied.append("Fixed buffer size to 512")
                    elif fixed_config.buffer_size > 8192:
                        fixed_config.buffer_size = 4096
                        report.auto_fixes_applied.append("Fixed buffer size to 4096")
                    elif fixed_config.buffer_size & (fixed_config.buffer_size - 1) != 0:
                        # Round to nearest power of two
                        import math
                        power = round(math.log2(fixed_config.buffer_size))
                        fixed_config.buffer_size = 2 ** power
                        report.auto_fixes_applied.append(f"Fixed buffer size to {fixed_config.buffer_size} (power of two)")

        # Fix audio data if needed
        if request.audio_data and request.audio_data.data is not None:
            data = request.audio_data.data.copy()
            data_fixed = False

            # Remove NaN and Inf values
            if np.isnan(data).any() or np.isinf(data).any():
                data = np.nan_to_num(data, nan=0.0, posinf=1.0, neginf=-1.0)
                data_fixed = True
                report.auto_fixes_applied.append("Removed NaN and infinite values from audio data")

            # Normalize range for float data
            if data.dtype in [np.float32, np.float64] and np.abs(data).max() > 1.0:
                data = data / np.abs(data).max()
                data_fixed = True
                report.auto_fixes_applied.append("Normalized audio data to [-1.0, 1.0] range")

            if data_fixed:
                fixed_data = AudioDataInfo(
                    data=data,
                    file_path=request.audio_data.file_path,
                    size_bytes=request.audio_data.size_bytes,
                    duration_seconds=request.audio_data.duration_seconds,
                    sample_rate=request.audio_data.sample_rate,
                    channels=request.audio_data.channels,
                    bit_depth=request.audio_data.bit_depth,
                    format=request.audio_data.format,
                    codec=request.audio_data.codec,
                    checksum=request.audio_data.checksum,
                    metadata=request.audio_data.metadata.copy() if request.audio_data.metadata else {},
                )

        return fixed_config, fixed_data

    def _generate_recommendations(self, request: ValidationRequest, report: ValidationReport,
    ) -> list[str]:
        """Generate recommendations based on validation results."""
        recommendations = []

        # Add suggestions from issues
        for issue in report.issues:
            if issue.suggestion and issue.suggestion not in recommendations:
                recommendations.append(issue.suggestion)

        # Add general recommendations
        if request.config:
            config = request.config

            # Sample rate recommendations
            if config.sample_rate not in [44100, 48000]:
                recommendations.append("Consider using 44100 Hz or 48000 Hz for better compatibility")
    

            # Channel recommendations
            if config.channels > 2:
                recommendations.append("Consider using stereo (2 channels) for better compatibility")

            # Buffer size recommendations
            if config.buffer_size < 512:
                recommendations.append("Consider using a larger buffer size (512+) for better stability")
            elif config.buffer_size > 4096:
                recommendations.append("Consider using a smaller buffer size (< = 4096) for lower latency")

        return recommendations

    def get_available_rules(self) -> list[ValidationRule]:
        """Get available validation rules."""
        return list(self._state.available_rules or [])

    def get_active_rules(self) -> list[ValidationRule]:
        """Get active validation rules."""
        return list(self._state.active_rules or [])

    def set_rule_enabled(self, rule_id: str, enabled: bool,
    ) -> bool:
        """Enable or disable a validation rule."""
        available_rules = self._state.available_rules or []
        active_rules = list(self._state.active_rules or [])
        for rule in available_rules:
            if rule.rule_id == rule_id:
                # Since ValidationRule doesn't have an enabled attribute, we'll track enabled rules separately
                if enabled:
                    if rule not in active_rules:
                        active_rules.append(rule)
                elif rule in active_rules:
                    active_rules.remove(rule)
                self._state.active_rules = active_rules
                return True
        return False

    def add_custom_rule(self, rule: ValidationRule,
    ) -> bool:
        """Add a custom validation rule."""
        # Check if rule ID already exists
        if any(r.rule_id == rule.rule_id for r in (self._state.available_rules or [])):
            return False

        available = list(self._state.available_rules or [])
        available.append(rule)
        self._state.available_rules = available
        # Add to active rules by default
        active = list(self._state.active_rules or [])
        active.append(rule)
        self._state.active_rules = active

        return True

    def get_validation_history(self) -> list[ValidationReport]:
        """Get validation history."""
        return list(self._state.validation_history or [])

    def get_state(self) -> AudioValidationServiceState:
        """Get current service state."""
        return self._state