"""Export Settings Use Case for WinSTT Application."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback, ProgressPercentage
from src_refactored.domain.common.result import Result
from src_refactored.domain.settings.value_objects.file_path import FilePath
from src_refactored.domain.settings.value_objects.settings_operations import ExportFormat

if TYPE_CHECKING:
    from src_refactored.domain.settings.entities.user_preferences import UserPreferences


class ExportResult(Enum):
    """Result of export operation"""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"
    CANCELLED = "cancelled"


class ExportPhase(Enum):
    """Phases of export operation"""
    VALIDATION = "validation"
    PREPARATION = "preparation"
    BACKUP = "backup"
    WRITING = "writing"
    VERIFICATION = "verification"
    FINALIZATION = "finalization"


@dataclass
class ExportConfiguration:
    """Configuration for export operations"""
    include_sensitive_data: bool = False
    include_metadata: bool = True
    pretty_format: bool = True
    backup_existing: bool = True
    verify_export: bool = True
    compression_enabled: bool = False
    encryption_enabled: bool = False
    max_file_size_mb: int = 10


@dataclass
class ExportSettingsRequest:
    """Request for exporting settings"""
    export_path: FilePath
    export_format: ExportFormat
    settings_to_export: UserPreferences
    configuration: ExportConfiguration = field(default_factory=ExportConfiguration)
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class ExportSettingsResponse:
    """Response from export settings operation"""
    result: ExportResult
    exported_file_path: FilePath | None = None
    exported_settings_count: int = 0
    file_size_bytes: int = 0
    export_duration_ms: int = 0
    backup_file_path: FilePath | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class FileSystemServiceProtocol(Protocol):
    """Protocol for file system operations"""

    def write_text_file(self, path: Path, content: str) -> Result[None]:
        """Write text content to file"""
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


class SerializationServiceProtocol(Protocol):
    """Protocol for serialization operations"""

    def serialize_to_json(self, data: dict[str, Any], pretty: bool = True) -> Result[str]:
        """Serialize data to JSON format"""
        ...

    def serialize_to_xml(self, data: dict[str, Any], pretty: bool = True) -> Result[str]:
        """Serialize data to XML format"""
        ...

    def serialize_to_yaml(self, data: dict[str, Any]) -> Result[str]:
        """Serialize data to YAML format"""
        ...

    def serialize_to_ini(self, data: dict[str, Any]) -> Result[str]:
        """Serialize data to INI format"""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for validation operations"""

    def validate_export_path(self, path: FilePath, format_type: ExportFormat) -> Result[None]:
        """Validate export path"""
        ...

    def validate_settings_data(self, settings: UserPreferences) -> Result[None]:
        """Validate settings data"""
        ...

    def verify_exported_file(self, path: FilePath, original_data: dict[str, Any]) -> Result[None]:
        """Verify exported file"""
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


class ExportSettingsUseCase:
    """Use case for exporting settings to various formats."""

    def __init__(
        self,
        file_system_service: FileSystemServiceProtocol,
        serialization_service: SerializationServiceProtocol,
        validation_service: ValidationServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._file_system = file_system_service
        self._serialization = serialization_service
        self._validation = validation_service
        self._logger = logger_service

    def execute(self, request: ExportSettingsRequest) -> ExportSettingsResponse:
        """Execute the export settings operation."""
        response = ExportSettingsResponse(result=ExportResult.FAILED)
        start_time = datetime.now(UTC)

        try:
            # Phase 1: Validate request
            if not self._update_progress(request.progress_callback, ExportPhase.VALIDATION, 10):
                response.result = ExportResult.FAILED
                return response

            validation_result = self._validate_request(request)
            if not validation_result.is_success:
                response.error_message = validation_result.error
                return response

            # Phase 2: Prepare export data
            if not self._update_progress(request.progress_callback, ExportPhase.PREPARATION, 25):
                response.result = ExportResult.FAILED
                return response

            data_result = self._prepare_export_data(request)
            if not data_result.is_success:
                response.error_message = data_result.error
                return response

            export_data = data_result.value or {}
            response.exported_settings_count = len([k for k in export_data if not k.startswith("_")])

            # Phase 3: Backup existing file
            backup_path = None
            if request.configuration.backup_existing:
                if not self._update_progress(request.progress_callback, ExportPhase.BACKUP, 40):
                    response.result = ExportResult.FAILED
                    return response

                backup_result = self._backup_existing_file(request.export_path)
                if backup_result.is_success:
                    backup_path = backup_result.value
                    response.backup_file_path = FilePath(path=str(backup_path)) if backup_path else None
                else:
                    response.warnings.append(f"Backup failed: {backup_result.error}")

            # Phase 4: Write export file
            if not self._update_progress(request.progress_callback, ExportPhase.WRITING, 60):
                response.result = ExportResult.FAILED
                return response

            write_result = self._write_export_file(request, export_data)
            if not write_result.is_success:
                response.error_message = write_result.error
                return response

            # Phase 5: Verify export
            if request.configuration.verify_export:
                if not self._update_progress(request.progress_callback, ExportPhase.VERIFICATION, 80):
                    response.result = ExportResult.FAILED
                    return response

                verify_result = self._validation.verify_exported_file(request.export_path, export_data)
                if not verify_result.is_success:
                    response.warnings.append(f"Verification warning: {verify_result.error}")

            # Phase 6: Complete
            if not self._update_progress(request.progress_callback, ExportPhase.FINALIZATION, 100):
                response.result = ExportResult.FAILED
                return response

            # Get file size
            size_result = self._file_system.get_file_size(Path(request.export_path.path))
            if size_result.is_success and size_result.value is not None:
                response.file_size_bytes = size_result.value

            # Set success response
            response.result = ExportResult.SUCCESS
            response.exported_file_path = request.export_path
            response.export_duration_ms = int((datetime.now(UTC) - start_time).total_seconds() * 1000)

            # Add metadata
            response.metadata = {
                "export_timestamp": start_time.isoformat(),
                "format": request.export_format.value,
                "configuration": {
                    "include_sensitive_data": request.configuration.include_sensitive_data,
                    "include_metadata": request.configuration.include_metadata,
                    "pretty_format": request.configuration.pretty_format,
                    "backup_created": backup_path is not None,
                },
            }

            self._logger.log_info(
                "Settings export completed successfully",
                export_path=str(request.export_path.path),
                settings_count=response.exported_settings_count,
                file_size=response.file_size_bytes,
                duration_ms=response.export_duration_ms,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during settings export: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = ExportResult.FAILED

        return response

    def _validate_request(self, request: ExportSettingsRequest) -> Result[None]:
        """Validate the export request"""
        # Validate export path
        path_validation = self._validation.validate_export_path(request.export_path, request.export_format)
        if not path_validation.is_success:
            return path_validation

        # Check if format is supported
        if request.export_format not in ExportFormat:
            return Result.failure(f"Unsupported export format: {request.export_format}")

        return Result.success(None)

    def _prepare_export_data(self, request: ExportSettingsRequest) -> Result[dict[str, Any]]:
        """Prepare settings data for export"""
        try:
            settings = request.settings_to_export
            export_data = {
                "model": settings.model_config.model_type.value,
                "quantization": settings.model_config.quantization.value,
                "recording_sound_enabled": settings.audio_config.recording_sound_enabled,
                "sound_file_path": str(settings.audio_config.recording_sound_path.path) if settings.audio_config.recording_sound_path else None,
                "output_srt": settings.output_srt_enabled,
                "recording_key": settings.recording_key.to_string(),
                "llm_enabled": settings.llm_config.enabled,
                "llm_model": settings.llm_config.model_name,
                "llm_quantization": settings.llm_config.quantization.value,
                "llm_prompt": settings.llm_config.system_prompt,
            }

            # Add metadata if enabled
            if request.configuration.include_metadata:
                metadata: dict[str, str] = {
                    "export_timestamp": datetime.now(UTC).isoformat(),
                    "export_format": request.export_format.value,
                    "application_version": "1.0.0",  # Should come from app config
                    "settings_version": "1.0",
                }
                export_data["_metadata"] = metadata  # type: ignore[assignment]

            # Filter sensitive data if not included
            if not request.configuration.include_sensitive_data:
                # Remove any sensitive fields (none currently, but placeholder for future)
                pass

            return Result.success(export_data)

        except Exception as e:
            return Result.failure(f"Failed to prepare export data: {e!s}")

    def _backup_existing_file(self, export_path: FilePath) -> Result[Path]:
        """Create backup of existing file if it exists"""
        file_path = Path(export_path.path)

        if not self._file_system.file_exists(file_path):
            return Result.failure("File does not exist, no backup needed")

        return self._file_system.backup_file(file_path)

    def _write_export_file(self, request: ExportSettingsRequest, data: dict[str, Any]) -> Result[None]:
        """Write the export data to file"""
        try:
            # Serialize data based on format
            if request.export_format == ExportFormat.JSON:
                content_result = self._serialization.serialize_to_json(data, request.configuration.pretty_format)
            elif request.export_format == ExportFormat.XML:
                content_result = self._serialization.serialize_to_xml(data, request.configuration.pretty_format)
            elif request.export_format == ExportFormat.YAML:
                content_result = self._serialization.serialize_to_yaml(data)
            elif request.export_format == ExportFormat.INI:
                content_result = self._serialization.serialize_to_ini(data)
            else:
                return Result.failure(f"Unsupported export format: {request.export_format}")

            if not content_result.is_success:
                return Result.failure(f"Serialization failed: {content_result.error}")

            # Write to file
            file_path = Path(request.export_path.path)
            write_result = self._file_system.write_text_file(file_path, content_result.value or "")

            if not write_result.is_success:
                return Result.failure(f"File write failed: {write_result.error}")

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Failed to write export file: {e!s}")

    def _update_progress(self, callback: ProgressCallback | None, phase: ExportPhase, percentage: int) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            try:
                callback(
                    progress=ProgressPercentage(percentage),
                    message=f"Export phase: {phase.value}",
                    error=None,
                )
                return True
            except Exception:
                return False
        return True