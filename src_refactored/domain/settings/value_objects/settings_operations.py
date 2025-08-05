"""Settings Operations Value Objects.

This module defines value objects for settings operations including
result types, phases, and operational enums.
"""

from enum import Enum


class ApplyResult(Enum):
    """Result status for settings application."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    CONFIGURATION_ERROR = "configuration_error"
    PERSISTENCE_ERROR = "persistence_error"
    ROLLBACK_ERROR = "rollback_error"


class ApplyPhase(Enum):
    """Phases of settings application process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    BACKUP_CREATION = "backup_creation"
    CONFIGURATION_UPDATE = "configuration_update"
    PERSISTENCE = "persistence"
    VERIFICATION = "verification"
    FINALIZATION = "finalization"


class SettingType(Enum):
    """Types of settings that can be configured."""
    AUDIO = "audio"
    MODEL = "model"
    HOTKEY = "hotkey"
    UI = "ui"
    SYSTEM = "system"
    TRANSCRIPTION = "transcription"
    EXPORT = "export"
    ADVANCED = "advanced"


class ApplicationState(Enum):
    """Application states during settings changes."""
    IDLE = "idle"
    APPLYING_SETTINGS = "applying_settings"
    VALIDATING = "validating"
    RESTARTING = "restarting"
    ERROR = "error"
    ROLLBACK = "rollback"


class ExportResult(Enum):
    """Result status for settings export."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    FILE_ERROR = "file_error"
    PERMISSION_ERROR = "permission_error"
    FORMAT_ERROR = "format_error"


class ExportPhase(Enum):
    """Phases of settings export process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    DATA_COLLECTION = "data_collection"
    FORMAT_CONVERSION = "format_conversion"
    FILE_WRITING = "file_writing"
    VERIFICATION = "verification"
    FINALIZATION = "finalization"


class ExportFormat(Enum):
    """Supported export formats for settings."""
    JSON = "json"
    YAML = "yaml"
    INI = "ini"
    XML = "xml"
    TOML = "toml"
    BINARY = "binary"


class ImportResult(Enum):
    """Result status for settings import."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    FILE_ERROR = "file_error"
    FORMAT_ERROR = "format_error"
    COMPATIBILITY_ERROR = "compatibility_error"


class ImportPhase(Enum):
    """Phases of settings import process."""
    INITIALIZATION = "initialization"
    FILE_READING = "file_reading"
    FORMAT_PARSING = "format_parsing"
    VALIDATION = "validation"
    COMPATIBILITY_CHECK = "compatibility_check"
    DATA_MAPPING = "data_mapping"
    APPLICATION = "application"
    FINALIZATION = "finalization"


class ImportFormat(Enum):
    """Supported import formats for settings."""
    JSON = "json"
    YAML = "yaml"
    INI = "ini"
    XML = "xml"
    TOML = "toml"
    BINARY = "binary"
    AUTO_DETECT = "auto_detect"


class LoadSource(Enum):
    """Sources for loading settings."""
    FILE = "file"
    DATABASE = "database"
    REGISTRY = "registry"
    ENVIRONMENT = "environment"
    DEFAULT = "default"
    CACHE = "cache"
    REMOTE = "remote"


class LoadStrategy(Enum):
    """Strategies for loading settings."""
    LAZY = "lazy"
    EAGER = "eager"
    CACHED = "cached"
    REFRESH = "refresh"
    FALLBACK = "fallback"
    MERGE = "merge"


class ResetScope(Enum):
    """Scope of settings reset operation."""
    ALL = "all"
    AUDIO = "audio"
    MODEL = "model"
    HOTKEY = "hotkey"
    UI = "ui"
    SYSTEM = "system"
    TRANSCRIPTION = "transcription"
    EXPORT = "export"
    ADVANCED = "advanced"
    USER_DEFINED = "user_defined"


class HotkeyRecordingState(Enum):
    """States of hotkey recording process."""
    IDLE = "idle"
    RECORDING = "recording"
    VALIDATING = "validating"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


class ValidationSeverity(Enum):
    """Severity levels for validation results."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ValidationCategory(Enum):
    """Categories of validation checks."""
    SYNTAX = "syntax"
    SEMANTIC = "semantic"
    COMPATIBILITY = "compatibility"
    SECURITY = "security"
    PERFORMANCE = "performance"
    BUSINESS_RULE = "business_rule"