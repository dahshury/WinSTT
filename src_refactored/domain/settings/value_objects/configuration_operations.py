"""Configuration Operation Value Objects.

This module defines value objects for configuration operations,
including load/save results, phases, and formats.
"""

from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class ConfigurationSource(ValueObject, Enum):
    """Configuration source types"""
    FILE = "file"
    ENVIRONMENT = "environment"
    REGISTRY = "registry"
    DATABASE = "database"
    REMOTE = "remote"
    DEFAULT = "default"


class LoadResult(ValueObject, Enum):
    """Configuration load results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    FILE_NOT_FOUND = "file_not_found"
    INVALID_FORMAT = "invalid_format"
    VALIDATION_FAILED = "validation_failed"
    PARTIAL_SUCCESS = "partial_success"
    PERMISSION_DENIED = "permission_denied"
    FALLBACK_USED = "fallback_used"


class LoadPhase(ValueObject, Enum):
    """Configuration load phases"""
    INITIALIZING = "initializing"
    LOCATING_SOURCE = "locating_source"
    READING_DATA = "reading_data"
    PARSING_CONFIG = "parsing_config"
    VALIDATING_CONFIG = "validating_config"
    APPLYING_DEFAULTS = "applying_defaults"
    FINALIZING = "finalizing"


class SaveResult(ValueObject, Enum):
    """Configuration save operation results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    VALIDATION_FAILED = "validation_failed"
    PERMISSION_DENIED = "permission_denied"
    DISK_FULL = "disk_full"
    BACKUP_FAILED = "backup_failed"
    SERIALIZATION_FAILED = "serialization_failed"
    WRITE_FAILED = "write_failed"
    VERIFICATION_FAILED = "verification_failed"
    PARTIAL_SAVE = "partial_save"


class SavePhase(ValueObject, Enum):
    """Configuration save operation phases"""
    INITIALIZING = "initializing"
    VALIDATING_CONFIGURATION = "validating_configuration"
    PREPARING_DATA = "preparing_data"
    CREATING_BACKUP = "creating_backup"
    SERIALIZING_DATA = "serializing_data"
    WRITING_TO_STORAGE = "writing_to_storage"
    VERIFYING_SAVE = "verifying_save"
    UPDATING_METADATA = "updating_metadata"
    CLEANING_UP = "cleaning_up"
    COMPLETED = "completed"


class SaveFormat(ValueObject, Enum):
    """Configuration save formats"""
    JSON = "json"
    YAML = "yaml"
    TOML = "toml"
    INI = "ini"
    XML = "xml"
    BINARY = "binary"
    ENCRYPTED = "encrypted"


class MergeStrategy(ValueObject, Enum):
    """Configuration merge strategies"""
    REPLACE = "replace"
    MERGE_DEEP = "merge_deep"
    MERGE_SHALLOW = "merge_shallow"
    OVERLAY = "overlay"


class SaveStrategy(ValueObject, Enum):
    """Configuration save strategies"""
    OVERWRITE = "overwrite"
    MERGE = "merge"
    APPEND = "append"
    VERSIONED = "versioned"
    ATOMIC = "atomic"