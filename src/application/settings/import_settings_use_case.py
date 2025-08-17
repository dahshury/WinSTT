"""Import Settings Use Case for WinSTT Application."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from src.domain.common.progress_callback import ProgressCallback, ProgressPercentage
from src.domain.common.result import Result
from src.domain.settings.value_objects.settings_operations import ImportFormat

if TYPE_CHECKING:
    from src.domain.settings.entities.user_preferences import UserPreferences
    from src.domain.settings.value_objects.file_path import FilePath


class ImportResult(Enum):
    """Result of import operation"""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"
    CANCELLED = "cancelled"


class ImportPhase(Enum):
    """Phases of import operation"""
    VALIDATION = "validation"
    READING = "reading"
    PARSING = "parsing"
    APPLICATION = "application"
    FINALIZATION = "finalization"


class ImportStrategy(Enum):
    """Import strategies for handling conflicts"""
    REPLACE_ALL = "replace_all"
    MERGE_PRESERVE_EXISTING = "merge_preserve_existing"
    MERGE_OVERWRITE_EXISTING = "merge_overwrite_existing"
    SELECTIVE_IMPORT = "selective_import"


@dataclass
class ImportConfiguration:
    """Configuration for import operations"""
    strategy: ImportStrategy = ImportStrategy.REPLACE_ALL
    validate_before_apply: bool = True
    backup_current_settings: bool = True
    ignore_unknown_fields: bool = True
    strict_validation: bool = False
    auto_detect_format: bool = True
    max_file_size_mb: int = 10
    allowed_formats: list[ImportFormat] = field(default_factory=lambda: list(ImportFormat))


@dataclass
class ImportSettingsRequest:
    """Request for importing settings"""
    import_path: FilePath
    import_format: ImportFormat = ImportFormat.AUTO_DETECT
    configuration: ImportConfiguration = field(default_factory=ImportConfiguration)
    current_settings: UserPreferences | None = None
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class ImportSettingsResponse:
    """Response from import settings operation"""
    result: ImportResult
    imported_settings: UserPreferences | None = None
    imported_fields_count: int = 0
    skipped_fields_count: int = 0
    invalid_fields_count: int = 0
    import_duration_ms: int = 0
    backup_file_path: FilePath | None = None
    detected_format: ImportFormat | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    field_errors: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


class FileSystemServiceProtocol(Protocol):
    """Protocol for file system operations"""

    def read_text_file(self, path: Path) -> Result[str]:
        """Read text file content"""
        ...

    def backup_file(self, source_path: Path, backup_suffix: str = ".bak") -> Result[Path]:
        """Create backup of file"""
        ...

    def get_file_size(self, path: Path) -> Result[int]:
        """Get file size in bytes"""
        ...

    def file_exists(self, path: Path) -> bool:
        """Check if file exists"""
        ...

    def detect_file_format(self, path: Path) -> Result[ImportFormat]:
        """Detect file format"""
        ...


class DeserializationServiceProtocol(Protocol):
    """Protocol for deserialization operations"""

    def deserialize_from_json(self, content: str) -> Result[dict[str, Any]]:
        """Deserialize JSON content"""
        ...

    def deserialize_from_xml(self, content: str) -> Result[dict[str, Any]]:
        """Deserialize XML content"""
        ...

    def deserialize_from_yaml(self, content: str) -> Result[dict[str, Any]]:
        """Deserialize YAML content"""
        ...

    def deserialize_from_ini(self, content: str) -> Result[dict[str, Any]]:
        """Deserialize INI content"""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for validation operations"""

    def validate_import_path(self, path: FilePath) -> Result[None]:
        """Validate import path"""
        ...

    def validate_imported_data(self, data: dict[str, Any], strict: bool = False) -> Result[dict[str, str]]:
        """Validate imported data"""
        ...

    def validate_settings_compatibility(self, settings: UserPreferences) -> Result[None]:
        """Validate settings compatibility"""
        ...


class SettingsFactoryProtocol(Protocol):
    """Protocol for settings factory operations"""

    def create_user_preferences_from_data(self, data: dict[str, Any]) -> Result[UserPreferences]:
        """Create user preferences from data"""
        ...

    def merge_settings(
        self,
        current: UserPreferences, imported: UserPreferences, strategy: ImportStrategy,
    ) -> Result[UserPreferences]:
        """Merge settings"""
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


class ImportSettingsUseCase:
    """Use case for importing settings from various formats."""

    def __init__(
        self,
        file_system_service: FileSystemServiceProtocol,
        deserialization_service: DeserializationServiceProtocol,
        validation_service: ValidationServiceProtocol,
        settings_factory: SettingsFactoryProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._file_system = file_system_service
        self._deserialization = deserialization_service
        self._validation = validation_service
        self._settings_factory = settings_factory
        self._logger = logger_service

    def execute(self, request: ImportSettingsRequest) -> ImportSettingsResponse:
        """Execute the import settings operation."""
        response = ImportSettingsResponse(result=ImportResult.FAILED)
        start_time = datetime.now(UTC)

        try:
            # Phase 1: Validate request
            if not self._update_progress(request.progress_callback, ImportPhase.VALIDATION, 10):
                response.result = ImportResult.FAILED
                return response

            validation_result = self._validate_request(request)
            if not validation_result.is_success:
                response.error_message = validation_result.error
                return response

            # Phase 2: Read file
            if not self._update_progress(request.progress_callback, ImportPhase.READING, 20):
                response.result = ImportResult.FAILED
                return response

            file_content_result = self._read_import_file(request)
            if not file_content_result.is_success:
                response.error_message = file_content_result.error
                return response

            file_content = file_content_result.value

            # Phase 3: Parse content
            if not self._update_progress(request.progress_callback, ImportPhase.PARSING, 35):
                response.result = ImportResult.FAILED
                return response

            import_format = request.import_format
            if request.configuration.auto_detect_format and import_format == ImportFormat.AUTO_DETECT:
                format_result = self._file_system.detect_file_format(Path(request.import_path.path))
                if format_result.is_success and format_result.value is not None:
                    import_format = format_result.value
                    response.detected_format = format_result.value

            parsed_data_result = self._parse_file_content(file_content or "", import_format)
            if not parsed_data_result.is_success:
                response.error_message = f"Failed to parse file: {parsed_data_result.error}"
                response.result = ImportResult.FAILED
                return response

            parsed_data = parsed_data_result.value or {}

            # Phase 4: Validate settings
            if not self._update_progress(request.progress_callback, ImportPhase.VALIDATION, 50):
                response.result = ImportResult.FAILED
                return response

            if request.configuration.validate_before_apply:
                data_validation_result: Result[dict[str, str]] = self._validation.validate_imported_data(
                    parsed_data or {},
                    request.configuration.strict_validation,
                )
                if not data_validation_result.is_success:
                    field_errors: dict[str, str] = data_validation_result.value or {}
                    response.field_errors = field_errors
                    if request.configuration.strict_validation and response.field_errors:
                        response.error_message = f"Validation failed: {len(response.field_errors)} field errors"
                        response.result = ImportResult.FAILED
                        return response
                    if response.field_errors:
                        response.warnings.append(f"Found {len(response.field_errors)} field validation warnings")

            # Phase 5: Create settings object
            settings_result = self._create_settings_from_data(parsed_data or {}, request.configuration)
            if not settings_result.is_success:
                response.error_message = f"Failed to create settings: {settings_result.error}"
                return response

            imported_settings = settings_result.value
            response.imported_fields_count = len([k for k in (parsed_data or {}) if not k.startswith("_")])

            # Phase 6: Apply settings (merge if needed)
            if not self._update_progress(request.progress_callback, ImportPhase.APPLICATION, 70):
                response.result = ImportResult.FAILED
                return response

            final_settings = imported_settings
            if request.current_settings and request.configuration.strategy != ImportStrategy.REPLACE_ALL:
                merge_result = self._settings_factory.merge_settings(
                    request.current_settings,
                    imported_settings or request.current_settings,
                    request.configuration.strategy,
                )
                if merge_result.is_success:
                    final_settings = merge_result.value
                else:
                    response.warnings.append(f"Settings merge failed: {merge_result.error}")

            # Phase 7: Verify import
            if not self._update_progress(request.progress_callback, ImportPhase.VALIDATION, 85):
                response.result = ImportResult.FAILED
                return response

            if final_settings is not None:
                compatibility_result = self._validation.validate_settings_compatibility(final_settings)
                if not compatibility_result.is_success:
                    response.warnings.append(f"Compatibility warning: {compatibility_result.error}")

            # Phase 8: Complete
            if not self._update_progress(request.progress_callback, ImportPhase.FINALIZATION, 100):
                response.result = ImportResult.FAILED
                return response

            # Set success response
            response.result = ImportResult.SUCCESS if not response.field_errors else ImportResult.SUCCESS
            response.imported_settings = final_settings
            response.import_duration_ms = int((datetime.now(UTC) - start_time).total_seconds() * 1000) if start_time else 0
            response.invalid_fields_count = len(response.field_errors)

            # Add metadata
            response.metadata = {
                "import_timestamp": start_time.isoformat(),
                "detected_format": response.detected_format.value if response.detected_format else import_format.value,
                "original_format": request.import_format.value,
                "strategy_used": request.configuration.strategy.value,
                "file_size_bytes": len(file_content or ""),
                "validation_strict": request.configuration.strict_validation,
            }

            self._logger.log_info(
                "Settings import completed",
                import_path=str(request.import_path.path),
                result=response.result.value,
                imported_fields=response.imported_fields_count,
                invalid_fields=response.invalid_fields_count,
                duration_ms=response.import_duration_ms,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during settings import: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = ImportResult.FAILED

        return response

    def _validate_request(self, request: ImportSettingsRequest) -> Result[None]:
        """Validate the import request"""
        # Validate import path
        path_validation = self._validation.validate_import_path(request.import_path)
        if not path_validation.is_success:
            return path_validation

        # Check if file exists
        if not self._file_system.file_exists(Path(request.import_path.path)):
            return Result.failure(f"Import file not found: {request.import_path.path}")

        # Check file size
        size_result = self._file_system.get_file_size(Path(request.import_path.path))
        if size_result.is_success and size_result.value is not None:
            size_mb = size_result.value / (1024 * 1024)
            if size_mb > request.configuration.max_file_size_mb:
                return Result.failure(f"File too large: {size_mb:.1f}MB (max: {request.configuration.max_file_size_mb}MB)")

        return Result.success(None)

    def _read_import_file(self, request: ImportSettingsRequest) -> Result[str]:
        """Read the import file content"""
        try:
            file_path = Path(request.import_path.path)
            return self._file_system.read_text_file(file_path)
        except Exception as e:
            return Result.failure(f"Failed to read import file: {e!s}")

    def _parse_file_content(self, content: str, format_type: ImportFormat) -> Result[dict[str, Any]]:
        """Parse file content based on format"""
        try:
            if format_type == ImportFormat.JSON:
                return self._deserialization.deserialize_from_json(content)
            if format_type == ImportFormat.XML:
                return self._deserialization.deserialize_from_xml(content)
            if format_type == ImportFormat.YAML:
                return self._deserialization.deserialize_from_yaml(content)
            if format_type == ImportFormat.INI:
                return self._deserialization.deserialize_from_ini(content)
            return Result.failure(f"Unsupported import format: {format_type}")
        except Exception as e:
            return Result.failure(f"Failed to parse {format_type.value} content: {e!s}")

    def _create_settings_from_data(self, data: dict[str, Any], config: ImportConfiguration) -> Result[UserPreferences]:
        """Create UserPreferences object from parsed data"""
        try:
            # Filter unknown fields if configured
            if config.ignore_unknown_fields:
                known_fields = {
                    "model", "quantization", "recording_sound_enabled", "sound_file_path",
                    "output_srt", "recording_key", "llm_enabled", "llm_model",
                    "llm_quantization", "llm_prompt", "_metadata",
                }
                filtered_data = {k: v for k, v in data.items() if k in known_fields or k.startswith("_")}
            else:
                filtered_data = data

            return self._settings_factory.create_user_preferences_from_data(filtered_data)

        except Exception as e:
            return Result.failure(f"Failed to create settings from data: {e!s}")

    def _update_progress(self, callback: ProgressCallback | None, phase: ImportPhase, percentage: int) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            try:
                callback(
                    progress=ProgressPercentage(percentage),
                    message=f"Import phase: {phase.value}",
                    error=None,
                )
                return True
            except Exception:
                return False
        return True