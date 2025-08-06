"""Audio Validation Value Objects.

This module defines validation types, severities, and results
that are core domain concepts for audio validation.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class ValidationType(Enum):
    """Types of audio validation."""
    FORMAT = "format"
    QUALITY = "quality"
    DURATION = "duration"
    SAMPLE_RATE = "sample_rate"
    CHANNELS = "channels"
    BITRATE = "bitrate"
    CODEC = "codec"
    METADATA = "metadata"
    CONTENT = "content"
    DEVICE = "device"


class ValidationSeverity(Enum):
    """Severity levels for validation issues."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ValidationCategory(Enum):
    """Categories of validation rules."""
    TECHNICAL = "technical"
    BUSINESS = "business"
    SECURITY = "security"
    PERFORMANCE = "performance"
    COMPATIBILITY = "compatibility"


@dataclass(frozen=True)
class ValidationRule(ValueObject):
    """A validation rule definition."""
    rule_id: str
    name: str
    description: str
    category: ValidationCategory
    severity: ValidationSeverity
    validation_type: ValidationType
    parameters: dict[str, Any]

    def _get_equality_components(self) -> tuple:
        return (
            self.rule_id,
            self.name,
            self.category,
            self.severity,
            self.validation_type,
        )

    def __invariants__(self) -> None:
        if not self.rule_id or not self.rule_id.strip():
            msg = "Rule ID cannot be empty"
            raise ValueError(msg)
        if not self.name or not self.name.strip():
            msg = "Rule name cannot be empty"
            raise ValueError(msg)
        if not self.description or not self.description.strip():
            msg = "Rule description cannot be empty"
            raise ValueError(msg)


@dataclass(frozen=True)
class ValidationIssue(ValueObject):
    """A validation issue found during validation."""
    rule_id: str
    severity: ValidationSeverity
    message: str
    field_path: str | None = None
    actual_value: Any | None = None
    expected_value: Any | None = None
    suggestion: str | None = None

    def _get_equality_components(self) -> tuple:
        return (
            self.rule_id,
            self.severity,
            self.message,
            self.field_path,
            str(self.actual_value),
            str(self.expected_value),
        )

    def __invariants__(self) -> None:
        if not self.rule_id or not self.rule_id.strip():
            msg = "Rule ID cannot be empty"
            raise ValueError(msg)
        if not self.message or not self.message.strip():
            msg = "Validation message cannot be empty"
            raise ValueError(msg)


@dataclass(frozen=True)
class ValidationResult(ValueObject):
    """Result of a validation operation."""
    is_valid: bool
    issues: list[ValidationIssue]
    validation_type: ValidationType
    timestamp: float
    duration_ms: float
    metadata: dict[str, Any] | None = None

    def _get_equality_components(self) -> tuple:
        return (
            self.is_valid,
            tuple(self.issues),
            self.validation_type,
            self.timestamp,
        )

    def __invariants__(self) -> None:
        if self.duration_ms < 0:
            msg = "Validation duration cannot be negative"
            raise ValueError(msg)
        if self.timestamp <= 0:
            msg = "Timestamp must be positive"
            raise ValueError(msg)
        if not self.is_valid and not self.issues:
            msg = "Invalid result must have at least one issue"
            raise ValueError(msg)

    def has_errors(self,
    ) -> bool:
        """Check if validation has any errors or critical issues."""
        return any(
            issue.severity in [ValidationSeverity.ERROR, ValidationSeverity.CRITICAL]
            for issue in self.issues
        )

    def has_warnings(self) -> bool:
        """Check if validation has any warnings."""
        return any(
            issue.severity == ValidationSeverity.WARNING
            for issue in self.issues
        )

    def get_issues_by_severity(self, severity: ValidationSeverity,
    ) -> list[ValidationIssue]:
        """Get all issues of a specific severity."""
        return [issue for issue in self.issues if issue.severity == severity]