"""Audio Validation Value Objects.

This module defines value objects for audio validation
concepts in the domain.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject

from .audio_format import AudioFormat
from .sample_rate import SampleRate


class ValidationCategory(Enum):
    """Audio validation categories."""
    FORMAT = "format"
    QUALITY = "quality"
    COMPATIBILITY = "compatibility"
    PERFORMANCE = "performance"
    SECURITY = "security"
    CONTENT = "content"


class ValidationSeverity(Enum):
    """Validation issue severity levels."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass(frozen=True)
class ValidationRule(ValueObject):
    """Audio validation rule."""

    rule_id: str
    name: str
    description: str
    category: ValidationCategory
    severity: ValidationSeverity
    is_enabled: bool = True
    parameters: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.rule_id,
            self.name,
            self.description,
            self.category,
            self.severity,
            self.is_enabled,
            tuple(sorted(self.parameters.items())),
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

    @property
    def is_blocking(self) -> bool:
        """Check if this rule blocks processing when violated."""
        return self.severity in [ValidationSeverity.ERROR, ValidationSeverity.CRITICAL]

    @property
    def is_informational(self) -> bool:
        """Check if this rule is informational only."""
        return self.severity == ValidationSeverity.INFO


@dataclass(frozen=True)
class ValidationIssue(ValueObject):
    """Audio validation issue."""

    issue_id: str
    rule: ValidationRule
    message: str
    details: str | None = None
    location: str | None = None
    timestamp: datetime = field(default_factory=datetime.now,
    )
    context: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.issue_id,
            self.rule,
            self.message,
            self.details,
            self.location,
            self.timestamp,
            tuple(sorted(self.context.items())),
        )

    def __invariants__(self) -> None:
        if not self.issue_id or not self.issue_id.strip():
            msg = "Issue ID cannot be empty"
            raise ValueError(msg)
        if not self.message or not self.message.strip():
            msg = "Issue message cannot be empty"
            raise ValueError(msg)

    @property
    def severity(self) -> ValidationSeverity:
        """Get issue severity from rule."""
        return self.rule.severity

    @property
    def category(self) -> ValidationCategory:
        """Get issue category from rule."""
        return self.rule.category

    @property
    def is_blocking(self) -> bool:
        """Check if this issue blocks processing."""
        return self.rule.is_blocking

    def get_full_message(self) -> str:
        """Get full issue message including details."""
        if self.details:
            return f"{self.message}. {self.details}"
        return self.message


@dataclass(frozen=True)
class AudioDataInfo(ValueObject):
    """Audio data information for validation."""

    sample_rate: SampleRate
    channels: int
    audio_format: AudioFormat
    frame_count: int
    duration_seconds: float
    bit_depth: int = 16
    is_compressed: bool = False
    codec: str | None = None
    file_size_bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.sample_rate,
            self.channels,
            self.audio_format,
            self.frame_count,
            self.duration_seconds,
            self.bit_depth,
            self.is_compressed,
            self.codec,
            self.file_size_bytes,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)
        if self.frame_count < 0:
            msg = "Frame count cannot be negative"
            raise ValueError(msg)
        if self.duration_seconds < 0:
            msg = "Duration cannot be negative"
            raise ValueError(msg)
        if self.bit_depth <= 0:
            msg = "Bit depth must be positive"
            raise ValueError(msg)
        if self.file_size_bytes is not None and self.file_size_bytes < 0:
            msg = "File size cannot be negative"
            raise ValueError(msg)

    @property
    def is_mono(self) -> bool:
        """Check if audio is mono."""
        return self.channels == 1

    @property
    def is_stereo(self) -> bool:
        """Check if audio is stereo."""
        return self.channels == 2

    @property
    def is_high_quality(self) -> bool:
        """Check if audio is considered high quality."""
        return (
            self.sample_rate.value >= 44100 and
            self.bit_depth >= 16 and
            not self.is_compressed
        )

    @property
    def estimated_bitrate(self) -> int:
        """Estimate bitrate in bits per second."""
        if self.is_compressed and self.file_size_bytes:
            return int((self.file_size_bytes * 8) / self.duration_seconds)
        return int(self.sample_rate.value * self.channels * self.bit_depth)

    @property
    def calculated_file_size(self) -> int:
        """Calculate expected file size for uncompressed audio."""
        bytes_per_sample = self.bit_depth // 8
        return int(self.frame_count * self.channels * bytes_per_sample)


@dataclass(frozen=True)
class ValidationResult(ValueObject):
    """Audio validation result."""

    is_valid: bool
    issues: list[ValidationIssue]
    audio_info: AudioDataInfo | None = None
    validation_time: datetime = field(default_factory=datetime.now)
    rules_applied: list[ValidationRule] = field(default_factory=list)

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.is_valid,
            tuple(self.issues),
            self.audio_info,
            self.validation_time,
            tuple(self.rules_applied),
        )

    def __invariants__(self) -> None:
        # If there are blocking issues, validation should not be valid
        blocking_issues = [issue for issue in self.issues if issue.is_blocking]
        if blocking_issues and self.is_valid:
            msg = "Validation cannot be valid with blocking issues"
            raise ValueError(msg)

    @property
    def has_errors(self,
    ) -> bool:
        """Check if validation has error-level issues."""
        return any(
            issue.severity in [ValidationSeverity.ERROR, ValidationSeverity.CRITICAL]
            for issue in self.issues
        )

    @property
    def has_warnings(self) -> bool:
        """Check if validation has warning-level issues."""
        return any(
            issue.severity == ValidationSeverity.WARNING
            for issue in self.issues
        )

    @property
    def error_count(self) -> int:
        """Get count of error-level issues."""
        return len([
            issue for issue in self.issues
            if issue.severity in [ValidationSeverity.ERROR, ValidationSeverity.CRITICAL]
        ])

    @property
    def warning_count(self) -> int:
        """Get count of warning-level issues."""
        return len([
            issue for issue in self.issues
            if issue.severity == ValidationSeverity.WARNING
        ])

    def get_issues_by_category(self, category: ValidationCategory,
    ) -> list[ValidationIssue]:
        """Get issues filtered by category."""
        return [issue for issue in self.issues if issue.category == category]

    def get_issues_by_severity(self, severity: ValidationSeverity,
    ) -> list[ValidationIssue]:
        """Get issues filtered by severity."""
        return [issue for issue in self.issues if issue.severity == severity]