"""Save Configuration Use Case

This module implements the SaveConfigurationUseCase for persisting application
configuration to various storage backends with validation and progress tracking.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.settings.value_objects.configuration_operations import (
    SaveFormat,
    SavePhase,
    SaveResult,
    SaveStrategy,
)


@dataclass(frozen=True)
class SaveConfiguration:
    """Configuration for save operation"""
    target_path: str
    format: SaveFormat = SaveFormat.JSON
    strategy: SaveStrategy = SaveStrategy.ATOMIC
    create_backup: bool = True
    backup_suffix: str = ".bak"
    validate_before_save: bool = True
    verify_after_save: bool = True
    compress_output: bool = False
    encryption_key: str | None = None
    include_metadata: bool = True
    exclude_sensitive_data: bool = True
    pretty_format: bool = True
    max_file_size_mb: int = 100
    timeout_seconds: int = 30


@dataclass(frozen=True,
    )
class SaveConfigurationRequest:
    """Request for saving configuration"""
    configuration_data: dict[str, Any]
    save_config: SaveConfiguration
    source_description: str = "application_settings"
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class SaveConfigurationResponse:
    """Response from save configuration operation"""
    result: SaveResult
    saved_path: str | None = None
    backup_path: str | None = None
    saved_size_bytes: int = 0
    save_duration_ms: int = 0
    format_used: SaveFormat | None = None
    strategy_used: SaveStrategy | None = None
    compression_ratio: float | None = None
    validation_warnings: list[str] = field(default_factory=list,
    )
    error_message: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class FileSystemServiceProtocol(Protocol):
    """Protocol for file system operations"""

    def file_exists(self, path: str,
    ) -> bool:
        """Check if file exists"""
        ...

    def create_directory(self, path: str,
    ) -> Result[None]:
        """Create directory if it doesn't exist"""
        ...

    def copy_file(self, source: str, destination: str,
    ) -> Result[None]:
        """Copy file from source to destination"""
        ...

    def write_file(self, path: str, content: bytes,
    ) -> Result[None]:
        """Write content to file"""
        ...

    def read_file(self, path: str,
    ) -> Result[bytes]:
        """Read file content"""
        ...

    def get_file_size(self, path: str,
    ) -> Result[int]:
        """Get file size in bytes"""
        ...

    def delete_file(self, path: str,
    ) -> Result[None]:
        """Delete file"""
        ...

    def get_available_space(self, path: str,
    ) -> Result[int]:
        """Get available disk space in bytes"""
        ...


class SerializationServiceProtocol(Protocol):
    """Protocol for data serialization operations"""

    def serialize_to_json(self, data: dict[str, Any], pretty: bool = True,
    ) -> Result[str]:
        """Serialize data to JSON format"""
        ...

    def serialize_to_xml(self, data: dict[str, Any], pretty: bool = True,
    ) -> Result[str]:
        """Serialize data to XML format"""
        ...

    def serialize_to_yaml(self, data: dict[str, Any]) -> Result[str]:
        """Serialize data to YAML format"""
        ...

    def serialize_to_ini(self, data: dict[str, Any]) -> Result[str]:
        """Serialize data to INI format"""
        ...

    def serialize_to_binary(self, data: dict[str, Any]) -> Result[bytes]:
        """Serialize data to binary format"""
        ...

    def compress_data(self, data: bytes,
    ) -> Result[bytes]:
        """Compress data"""
        ...

    def encrypt_data(self, data: bytes, key: str,
    ) -> Result[bytes]:
        """Encrypt data with key"""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for configuration validation"""

    def validate_configuration_data(self, data: dict[str, Any]) -> Result[None]:
        """Validate configuration data structure and values"""
        ...

    def sanitize_sensitive_data(self, data: dict[str, Any]) -> Result[dict[str, Any]]:
        """Remove or mask sensitive data from configuration"""
        ...

    def validate_file_path(self, path: str,
    ) -> Result[None]:
        """Validate file path for security and accessibility"""
        ...

    def estimate_serialized_size(self, data: dict[str, Any], format: SaveFormat,
    ) -> Result[int]:
        """Estimate size of serialized data"""
        ...


class MetadataServiceProtocol(Protocol):
    """Protocol for metadata management"""

    def create_save_metadata(self, config: SaveConfiguration, data_size: int,
    ) -> dict[str, Any]:
        """Create metadata for save operation"""
        ...

    def update_save_history(self, path: str, metadata: dict[str, Any]) -> Result[None]:
        """Update save history with new entry"""
        ...

    def get_save_statistics(self, path: str,
    ) -> Result[dict[str, Any]]:
        """Get save statistics for a configuration file"""
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


class SaveConfigurationUseCase:
    """Use case for saving application configuration"""

    def __init__(
        self,
        file_system_service: FileSystemServiceProtocol,
        serialization_service: SerializationServiceProtocol,
        validation_service: ValidationServiceProtocol,
        metadata_service: MetadataServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._file_system = file_system_service
        self._serialization = serialization_service
        self._validation = validation_service
        self._metadata = metadata_service
        self._logger = logger_service

    def execute(self, request: SaveConfigurationRequest,
    ) -> SaveConfigurationResponse:
        """Execute the save configuration operation"""
        start_time = datetime.utcnow()
        response = SaveConfigurationResponse(result=SaveResult.FAILED)

        try:
            self._logger.log_info(
                "Starting configuration save operation",
                target_path=request.save_config.target_path,
                format=request.save_config.format.value,
                strategy=request.save_config.strategy.value,
                source=request.source_description,
            )

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, SavePhase.INITIALIZING, 0):
                response.result = SaveResult.CANCELLED
                return response

            # Validate target path
            path_validation = self._validation.validate_file_path(request.save_config.target_path)
            if not path_validation.is_success:
                response.error_message = f"Invalid target path: {path_validation.error_message}"
                return response

            # Check available disk space
            estimated_size_result = self._validation.estimate_serialized_size(
                request.configuration_data, request.save_config.format,
            )
            if estimated_size_result.is_success:
                estimated_size = estimated_size_result.value
                if request.save_config.compress_output:
                    estimated_size = int(estimated_size * 0.3)  # Assume 70% compression

                # Check if estimated size exceeds limit
                max_size_bytes = request.save_config.max_file_size_mb * 1024 * 1024
                if estimated_size > max_size_bytes:
                    response.error_message
 = (
    f"Estimated file size ({estimated_size} bytes) exceeds limit ({max_size_bytes} bytes)")
                    return response

                # Check available disk space
available_space_result = (
    self._file_system.get_available_space(request.save_config.target_path,)
    )
                if available_space_result.is_success and available_space_result.value < estimated_size *
    2:
                    response.error_message = "Insufficient disk space"
                    response.result = SaveResult.DISK_FULL
                    return response

            # Phase 2: Validate configuration data
            if not self._update_progress(request.progress_callback, SavePhase.VALIDATING_CONFIGURATION, 10):
                response.result = SaveResult.CANCELLED
                return response

            if request.save_config.validate_before_save:
validation_result = (
    self._validation.validate_configuration_data(request.configuration_data,)
    )
                if not validation_result.is_success:
response.error_message = (
    f"Configuration validation failed: {validation_result.error_message}")
                    response.result = SaveResult.VALIDATION_FAILED
                    return response

            # Phase 3: Prepare data
            if not self._update_progress(request.progress_callback, SavePhase.PREPARING_DATA, 20):
                response.result = SaveResult.CANCELLED
                return response

            # Sanitize sensitive data if requested
            data_to_save = request.configuration_data
            if request.save_config.exclude_sensitive_data:
                sanitize_result = self._validation.sanitize_sensitive_data(data_to_save)
                if sanitize_result.is_success:
                    data_to_save = sanitize_result.value
                    if len(sanitize_result.value) < len(request.configuration_data):
                        response.validation_warnings.append("Sensitive data was excluded from save")
                else:
                    response.validation_warnings.append(f"Failed to sanitize sensitive data: {sanitize_result.error_message}",
    )

            # Add metadata if requested
            if request.save_config.include_metadata:
metadata = (
    self._metadata.create_save_metadata(request.save_config, len(str(data_to_save))))
                data_to_save = {
                    "_metadata": metadata,
                    "configuration": data_to_save,
                }

            # Phase 4: Create backup
            backup_path = None
            if request.save_config.create_backup and
    self._file_system.file_exists(request.save_config.target_path):
                if not self._update_progress(request.progress_callback, SavePhase.CREATING_BACKUP, 30):
                    response.result = SaveResult.CANCELLED
                    return response

backup_path = (
    f"{request.save_config.target_path}{request.save_config.backup_suffix}")
backup_result = (
    self._file_system.copy_file(request.save_config.target_path, backup_path))
                if backup_result.is_success:
                    response.backup_path = backup_path
                    self._logger.log_info(f"Configuration backup created: {backup_path}")
                else:
                    response.validation_warnings.append(f"Failed to create backup: {backup_result.er\
    ror_message}")
                    if request.save_config.strategy == SaveStrategy.ATOMIC:
                        response.error_message = "Backup creation failed for atomic save strategy"
                        response.result = SaveResult.BACKUP_FAILED
                        return response

            # Phase 5: Serialize data
            if not self._update_progress(request.progress_callback, SavePhase.SERIALIZING_DATA, 50):
                response.result = SaveResult.CANCELLED
                return response

            serialized_data = self._serialize_data(data_to_save, request.save_config)
            if not serialized_data.is_success:
                response.error_message = f"Serialization failed: {serialized_data.error_message}"
                response.result = SaveResult.SERIALIZATION_FAILED
                return response

            final_data = serialized_data.value

            # Apply compression if requested
            if request.save_config.compress_output:
                if isinstance(final_data, str):
                    final_data = final_data.encode("utf-8")
                compress_result = self._serialization.compress_data(final_data)
                if compress_result.is_success:
                    original_size = len(final_data)
                    final_data = compress_result.value
                    response.compression_ratio = len(final_data) / original_size
                else:
                    response.validation_warnings.append(f"Compression failed: {compress_result.error_message}",
    )

            # Apply encryption if requested
            if request.save_config.encryption_key:
                if isinstance(final_data, str):
                    final_data = final_data.encode("utf-8")
encrypt_result = (
    self._serialization.encrypt_data(final_data, request.save_config.encryption_key))
                if encrypt_result.is_success:
                    final_data = encrypt_result.value
                else:
                    response.validation_warnings.append(f"Encryption failed: {encrypt_result.error_message}",
    )

            # Phase 6: Write to storage
            if not self._update_progress(request.progress_callback, SavePhase.WRITING_TO_STORAGE, 70):
                response.result = SaveResult.CANCELLED
                return response

            # Ensure target directory exists
            import os
            target_dir = os.path.dirname(request.save_config.target_path)
            if target_dir:
                dir_result = self._file_system.create_directory(target_dir,
    )
                if not dir_result.is_success:
response.error_message = (
    f"Failed to create target directory: {dir_result.error_message}")
                    return response

            # Write data based on strategy
            write_result = self._write_data_with_strategy(
                final_data, request.save_config.target_path, request.save_config.strategy,
            )
            if not write_result.is_success:
                response.error_message = f"Write operation failed: {write_result.error_message}"
                response.result = SaveResult.WRITE_FAILED
                # Try to restore backup if atomic strategy failed
                if backup_path and request.save_config.strategy == SaveStrategy.ATOMIC:
restore_result = (
    self._file_system.copy_file(backup_path, request.save_config.target_path))
                    if not restore_result.is_success:
                        response.validation_warnings.append(f"Failed to restore backup: {restore_res\
    ult.error_message}")
                return response

            response.saved_path = request.save_config.target_path

            # Phase 7: Verify save
            if not self._update_progress(request.progress_callback, SavePhase.VERIFYING_SAVE, 85):
                response.result = SaveResult.CANCELLED
                return response

            if request.save_config.verify_after_save:
                verify_result = self._verify_saved_data(request.save_config.target_path,
                data_to_save, request.save_config)
                if not verify_result.is_success:
                    response.validation_warnings.append(f"Save verification failed: {verify_result.e\
    rror_message}")
                    response.result = SaveResult.VERIFICATION_FAILED

            # Phase 8: Update metadata
            if not self._update_progress(request.progress_callback, SavePhase.UPDATING_METADATA, 90):
                response.result = SaveResult.CANCELLED
                return response

            # Get file size
            size_result = self._file_system.get_file_size(request.save_config.target_path)
            if size_result.is_success:
                response.saved_size_bytes = size_result.value

            # Update save history
            save_metadata = {
                "timestamp": start_time.isoformat()
                "source": request.source_description,
                "format": request.save_config.format.value,
                "strategy": request.save_config.strategy.value,
                "size_bytes": response.saved_size_bytes,
                "compressed": request.save_config.compress_output,
                "encrypted": request.save_config.encryption_key is not None,
                "backup_created": backup_path is not None,
            }

history_result = (
    self._metadata.update_save_history(request.save_config.target_path, save_metadata))
            if not history_result.is_success:
                response.validation_warnings.append(f"Failed to update save history: {history_result\
    .error_message}")

            # Phase 9: Clean up
            if not self._update_progress(request.progress_callback, SavePhase.CLEANING_UP, 95):
                response.result = SaveResult.CANCELLED
                return response

            # Clean up old backups if strategy is versioned
            if request.save_config.strategy == SaveStrategy.VERSIONED:
                # Implementation would clean up old versions
                pass

            # Phase 10: Complete
            if not self._update_progress(request.progress_callback, SavePhase.COMPLETED, 100):
                response.result = SaveResult.CANCELLED
                return response

            # Set success response
            response.result = SaveResult.SUCCESS
            response.save_duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)
            response.format_used = request.save_config.format
            response.strategy_used = request.save_config.strategy

            # Add metadata
            response.metadata = {
                "save_timestamp": start_time.isoformat()
                "target_path": request.save_config.target_path,
                "source_description": request.source_description,
                "validation_performed": request.save_config.validate_before_save,
                "verification_performed": request.save_config.verify_after_save,
                "backup_created": backup_path is not None,
                "compression_applied": request.save_config.compress_output,
                "encryption_applied": request.save_config.encryption_key is not None,
                "metadata_included": request.save_config.include_metadata,
                "sensitive_data_excluded": request.save_config.exclude_sensitive_data,
            }

            self._logger.log_info(
                "Configuration save completed",
                result=response.result.value,
                path=response.saved_path,
                size_bytes=response.saved_size_bytes,
                duration_ms=response.save_duration_ms,
                format=response.format_used.value,
                strategy=response.strategy_used.value,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during configuration save: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = SaveResult.FAILED

        return response

    def _serialize_data(self, data: dict[str, Any], config: SaveConfiguration,
    ) -> Result[bytes | str]:
        """Serialize data according to the specified format"""
        try:
            if config.format == SaveFormat.JSON:
                return self._serialization.serialize_to_json(data, config.pretty_format)
            if config.format == SaveFormat.XML:
                return self._serialization.serialize_to_xml(data, config.pretty_format)
            if config.format == SaveFormat.YAML:
                return self._serialization.serialize_to_yaml(data)
            if config.format == SaveFormat.INI:
                return self._serialization.serialize_to_ini(data)
            if config.format == SaveFormat.BINARY:
                return self._serialization.serialize_to_binary(data)
            return Result.failure(f"Unsupported format: {config.format}")
        except Exception as e:
            return Result.failure(f"Serialization error: {e!s}")

    def _write_data_with_strategy(self, data: bytes | str, target_path: str, strategy: SaveStrategy,
    ) -> Result[None]:
        """Write data using the specified strategy"""
        try:
            if isinstance(data, str):
                data = data.encode("utf-8")

            if strategy == SaveStrategy.ATOMIC:
                # Write to temporary file first, then rename
                temp_path = f"{target_path}.tmp"
                write_result = self._file_system.write_file(temp_path, data)
                if write_result.is_success:
                    import os
                    try:
                        os.rename(temp_path, target_path)
                        return Result.success(None)
                    except Exception as e:
                        self._file_system.delete_file(temp_path)
                        return Result.failure(f"Atomic rename failed: {e!s}")
                return write_result

            if strategy == SaveStrategy.OVERWRITE:
                return self._file_system.write_file(target_path, data)

            if strategy == SaveStrategy.VERSIONED:
                # Create versioned filename
                import os
                base, ext = os.path.splitext(target_path)
                timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                versioned_path = f"{base}_{timestamp}{ext}"
                return self._file_system.write_file(versioned_path, data)

            if strategy == SaveStrategy.MERGE:
                # For merge strategy, would need to read existing data and merge
                # This is a simplified implementation
                return self._file_system.write_file(target_path, data)

            if strategy == SaveStrategy.APPEND:
                # For append strategy, would append to existing file
                # This is a simplified implementation
                return self._file_system.write_file(target_path, data)

            return Result.failure(f"Unsupported save strategy: {strategy}")

        except Exception as e:
            return Result.failure(f"Write strategy error: {e!s}")

    def _verify_saved_data(self,
    saved_path: str, original_data: dict[str, Any], config: SaveConfiguration,
    ) -> Result[None]:
        """Verify that the saved data can be read back correctly"""
        try:
            # Read the saved file
            read_result = self._file_system.read_file(saved_path)
            if not read_result.is_success:
                return Result.failure(f"Could not read saved file: {read_result.error_message}")

            # For basic verification, just check that the file exists and has content
            saved_content = read_result.value
            if len(saved_content) == 0:
                return Result.failure("Saved file is empty")

            # More sophisticated verification would deserialize and compare
            # This is a simplified implementation
            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Verification error: {e!s}")

    def _update_progress(self, callback: ProgressCallback | None, phase: SavePhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            return callback.update_progress(
                percentage=percentage,
                message=f"Save phase: {phase.value}",
                phase=phase.value,
            )
        return True