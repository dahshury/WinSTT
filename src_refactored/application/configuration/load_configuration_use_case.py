"""Load Configuration Use Case

This module implements the LoadConfigurationUseCase for loading application
configuration from various sources with progress tracking and validation.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src_refactored.domain.common.progress_callback import ProgressCallback
from src_refactored.domain.common.result import Result
from src_refactored.domain.settings.entities.user_preferences import UserPreferences
from src_refactored.domain.settings.value_objects.configuration_operations import (
    ConfigurationSource,
    LoadPhase,
    LoadResult,
    MergeStrategy,
)
from src_refactored.domain.settings.value_objects.file_path import FilePath


@dataclass(frozen=True)
class ConfigurationLocation:
    """Configuration location specification"""
    source: ConfigurationSource
    path: FilePath | None = None
    environment_prefix: str | None = None
    registry_key: str | None = None
    connection_string: str | None = None
    url: str | None = None
    priority: int = 0


@dataclass(frozen=True)
class LoadConfiguration:
    """Configuration for load operations"""
    locations: list[ConfigurationLocation] = field(default_factory=list)
    merge_strategy: MergeStrategy = MergeStrategy.MERGE_DEEP
    use_defaults_on_failure: bool = True
    validate_after_load: bool = True
    cache_loaded_config: bool = True
    max_retry_attempts: int = 3
    retry_delay_ms: int = 1000
    timeout_ms: int = 30000
    fallback_to_defaults: bool = True


@dataclass(frozen=True)
class LoadConfigurationRequest:
    """Request for loading configuration"""
    configuration: LoadConfiguration = field(default_factory=LoadConfiguration)
    force_reload: bool = False
    include_environment: bool = True
    include_user_overrides: bool = True
    progress_callback: ProgressCallback | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow,
    )


@dataclass
class LoadConfigurationResponse:
    """Response from load configuration operation"""
    result: LoadResult
    loaded_config: dict[str, Any] | None = None
    user_preferences: UserPreferences | None = None
    sources_used: list[ConfigurationSource] = field(default_factory=list)
    load_duration_ms: int = 0
    validation_warnings: list[str] = field(default_factory=list,
    )
    fallback_values_used: dict[str, Any] = field(default_factory=dict)
    error_message: str | None = None
    retry_count: int = 0
    cache_hit: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


class FileSystemServiceProtocol(Protocol):
    """Protocol for file system operations"""

    def read_json_file(self, path: str,
    ) -> Result[dict[str, Any]]:
        """Read JSON configuration from file"""
        ...

    def file_exists(self, path: str,
    ) -> bool:
        """Check if configuration file exists"""
        ...

    def get_project_root(self) -> Result[str]:
        """Get project root directory"""
        ...

    def resolve_config_path(self, relative_path: str,
    ) -> Result[str]:
        """Resolve configuration file path"""
        ...


class EnvironmentServiceProtocol(Protocol):
    """Protocol for environment variable operations"""

    def get_environment_config(self, prefix: str,
    ) -> Result[dict[str, Any]]:
        """Get configuration from environment variables"""
        ...

    def get_environment_variable(self, name: str, default: str | None = None) -> str | None:
        """Get single environment variable"""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for configuration validation"""

    def validate_configuration(self, config: dict[str, Any]) -> Result[list[str]]:
        """Validate configuration data, returns warnings"""
        ...

    def validate_configuration_schema(self, config: dict[str, Any]) -> Result[None]:
        """Validate configuration against schema"""
        ...


class CacheServiceProtocol(Protocol):
    """Protocol for configuration caching"""

    def get_cached_config(self, cache_key: str,
    ) -> Result[dict[str, Any]]:
        """Get cached configuration"""
        ...

    def cache_config(self, cache_key: str, config: dict[str, Any], ttl_seconds: int = 3600,
    ) -> Result[None]:
        """Cache configuration data"""
        ...

    def invalidate_cache(self, cache_key: str,
    ) -> Result[None]:
        """Invalidate cached configuration"""
        ...


class ConfigurationFactoryProtocol(Protocol):
    """Protocol for creating configuration objects"""

    def create_user_preferences(self, config_data: dict[str, Any]) -> Result[UserPreferences]:
        """Create UserPreferences from configuration data"""
        ...

    def get_default_configuration(self) -> dict[str, Any]:
        """Get default configuration values"""
        ...

    def merge_configurations(self,
    base: dict[str, Any], overlay: dict[str, Any], strategy: MergeStrategy,
    ) -> Result[dict[str, Any]]:
        """Merge multiple configuration sources"""
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


class LoadConfigurationUseCase:
    """Use case for loading application configuration"""

    def __init__(
        self,
        file_system_service: FileSystemServiceProtocol,
        environment_service: EnvironmentServiceProtocol,
        validation_service: ValidationServiceProtocol,
        cache_service: CacheServiceProtocol,
        configuration_factory: ConfigurationFactoryProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._file_system = file_system_service
        self._environment = environment_service
        self._validation = validation_service
        self._cache = cache_service
        self._factory = configuration_factory
        self._logger = logger_service

    def execute(self, request: LoadConfigurationRequest,
    ) -> LoadConfigurationResponse:
        """Execute the load configuration operation"""
        start_time = datetime.utcnow()
        response = LoadConfigurationResponse(result=LoadResult.FAILED)

        try:
            self._logger.log_info(
                "Starting configuration load",
                force_reload=request.force_reload,
                include_environment=request.include_environment,
            )

            # Phase 1: Initialize
            if not self._update_progress(request.progress_callback, LoadPhase.INITIALIZING, 0):
                response.result = LoadResult.CANCELLED
                return response

            # Check cache first (unless force reload)
            cache_key = self._generate_cache_key(request)
            if not request.force_reload and request.configuration.cache_loaded_config:
                cached_result = self._cache.get_cached_config(cache_key)
                if cached_result.is_success:
                    response.loaded_config = cached_result.value
                    response.cache_hit = True
                    response.result = LoadResult.SUCCESS
                    response.load_duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

                    # Still create user preferences from cached config
                    prefs_result = self._factory.create_user_preferences(response.loaded_config)
                    if prefs_result.is_success:
                        response.user_preferences = prefs_result.value

                    self._logger.log_info("Configuration loaded from cache")

                    return response

            # Phase 2: Locate configuration sources
            if not self._update_progress(request.progress_callback, LoadPhase.LOCATING_SOURCE, 15):
                response.result = LoadResult.CANCELLED
                return response

            config_locations = self._prepare_configuration_locations(request)

            # Phase 3: Read configuration data
            if not self._update_progress(request.progress_callback, LoadPhase.READING_DATA, 30):
                response.result = LoadResult.CANCELLED
                return response

            config_data_result = self._load_from_sources(config_locations, request)
            if not config_data_result.is_success:
                if request.configuration.fallback_to_defaults:
                    self._logger.log_warning(f"Failed to load configuration, using defaults: {config_data_result.error_message}")
                    config_data = self._factory.get_default_configuration()
                    response.fallback_values_used = config_data.copy()
                    response.result = LoadResult.FALLBACK_USED
                else:
                    response.error_message = config_data_result.error_message
                    return response
            else:
                config_data = config_data_result.value

            # Phase 4: Parse and merge configuration
            if not self._update_progress(request.progress_callback, LoadPhase.PARSING_CONFIG, 50):
                response.result = LoadResult.CANCELLED
                return response

            # Apply environment overrides if requested
            if request.include_environment:
                env_config_result = self._environment.get_environment_config("WINSTT_")
                if env_config_result.is_success and env_config_result.value:
                    merge_result = self._factory.merge_configurations(
                        config_data,
                        env_config_result.value,
                        MergeStrategy.OVERLAY,
                    )
                    if merge_result.is_success:
                        config_data = merge_result.value
                        response.sources_used.append(ConfigurationSource.ENVIRONMENT)

            # Phase 5: Validate configuration
            if not self._update_progress(request.progress_callback, LoadPhase.VALIDATING_CONFIG, 70):
                response.result = LoadResult.CANCELLED
                return response

            if request.configuration.validate_after_load:
                validation_result = self._validation.validate_configuration(config_data)
                if validation_result.is_success:
                    response.validation_warnings = validation_result.value
                else:
                    response.error_message = f"Configuration validation failed: {validation_result.error_message}"
                    if not request.configuration.fallback_to_defaults:
                        response.result = LoadResult.VALIDATION_FAILED
                        return response

            # Phase 6: Apply defaults for missing values
            if not self._update_progress(request.progress_callback, LoadPhase.APPLYING_DEFAULTS, 85):
                response.result = LoadResult.CANCELLED
                return response

            default_config = self._factory.get_default_configuration()
            final_config_result = self._factory.merge_configurations(
                default_config,
                config_data,
                MergeStrategy.OVERLAY,
            )

            if not final_config_result.is_success:
                response.error_message = f"Failed to merge with defaults: {final_config_result.error_message}"
                return response

            final_config = final_config_result.value

            # Phase 7: Create user preferences
            prefs_result = self._factory.create_user_preferences(final_config)
            if not prefs_result.is_success:
                response.error_message = f"Failed to create user preferences: {prefs_result.error_message}"
                return response

            # Phase 8: Finalize
            if not self._update_progress(request.progress_callback, LoadPhase.FINALIZING, 95):
                response.result = LoadResult.CANCELLED
                return response

            # Cache the configuration if enabled
            if request.configuration.cache_loaded_config:
                cache_result = self._cache.cache_config(cache_key, final_config)
                if not cache_result.is_success:
                    response.validation_warnings.append(f"Failed to cache configuration: {cache_result.error_message}")

            # Phase 9: Complete
            if not self._update_progress(request.progress_callback, LoadPhase.COMPLETED, 100):
                response.result = LoadResult.CANCELLED
                return response

            # Set success response
            if response.result != LoadResult.FALLBACK_USED:
                response.result = (
                    LoadResult.SUCCESS if not response.validation_warnings else LoadResult.PARTIAL_SUCCESS)

            response.loaded_config = final_config
            response.user_preferences = prefs_result.value
            response.load_duration_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            # Add metadata
            response.metadata = {
                "load_timestamp": start_time.isoformat(),
                "sources_attempted": len(config_locations),
                "sources_successful": len(response.sources_used),
                "cache_enabled": request.configuration.cache_loaded_config,
                "validation_enabled": request.configuration.validate_after_load,
                "environment_included": request.include_environment,
                "force_reload": request.force_reload,
            }

            self._logger.log_info(
                "Configuration load completed",
                result=response.result.value,
                sources_used=len(response.sources_used),
                warnings=len(response.validation_warnings),
                duration_ms=response.load_duration_ms,
                cache_hit=response.cache_hit,
            )

        except Exception as e:
            self._logger.log_error(f"Unexpected error during configuration load: {e!s}")
            response.error_message = f"Unexpected error: {e!s}"
            response.result = LoadResult.FAILED

        return response

    def _prepare_configuration_locations(self, request: LoadConfigurationRequest,
    ) -> list[ConfigurationLocation]:
        """Prepare list of configuration locations to try"""
        locations = request.configuration.locations.copy()

        # Add default file location if none specified
        if not locations:
            locations.append(ConfigurationLocation(
                source=ConfigurationSource.FILE,
                path=FilePath("settings.json"),
                priority=1,
            ))

        # Sort by priority (higher priority first)
        return sorted(locations, key=lambda x: x.priority, reverse=True)

    def _load_from_sources(self,
    locations: list[ConfigurationLocation], request: LoadConfigurationRequest,
    ) -> Result[dict[str, Any]]:
        """Load configuration from multiple sources"""
        merged_config = {}
        sources_used = []

        for location in locations:
            try:
                if location.source == ConfigurationSource.FILE:
                    config_result = self._load_from_file(location)
                elif location.source == ConfigurationSource.ENVIRONMENT:
                    config_result = self._load_from_environment(location)
                elif location.source == ConfigurationSource.DEFAULT:
                    config_result = Result.success(self._factory.get_default_configuration())
                else:
                    self._logger.log_warning(f"Unsupported configuration source: {location.source}")
                    continue

                if config_result.is_success:
                    merge_result = self._factory.merge_configurations(
                        merged_config,
                        config_result.value,
                        request.configuration.merge_strategy,
                    )
                    if merge_result.is_success:
                        merged_config = merge_result.value
                        sources_used.append(location.source)
                    else:
                        self._logger.log_warning(f"Failed to merge config from {location.source}: {merge_result.error_message}")
                else:
                    self._logger.log_warning(f"Failed to load config from {location.source}: {config_result.error_message}")

            except Exception as e:
                self._logger.log_error(f"Error loading from {location.source}: {e!s}")

        if not merged_config and not sources_used:
            return Result.failure("No configuration sources could be loaded")

        return Result.success(merged_config)

    def _load_from_file(self, location: ConfigurationLocation,
    ) -> Result[dict[str, Any]]:
        """Load configuration from file"""
        if not location.path:
            return Result.failure("File path not specified")

        # Resolve relative path
        if not self._file_system.is_absolute_path(location.path.path):
            root_result = self._file_system.get_project_root()
            if root_result.is_success:
                file_path = self._file_system.join_path(root_result.value, location.path.path)
            else:
                return Result.failure(f"Could not resolve project root: {root_result.error_message}")
        else:
            file_path = location.path.path

        if not self._file_system.file_exists(file_path):
            return Result.failure(f"Configuration file not found: {file_path}")

        return self._file_system.read_json_file(file_path)

    def _load_from_environment(self, location: ConfigurationLocation,
    ) -> Result[dict[str, Any]]:
        """Load configuration from environment variables"""
        prefix = location.environment_prefix or "WINSTT_"
        return self._environment.get_environment_config(prefix)

    def _generate_cache_key(self, request: LoadConfigurationRequest,
    ) -> str:
        """Generate cache key for configuration"""
        key_parts = [
            "config",
            str(request.include_environment),
            str(request.include_user_overrides),
            str(len(request.configuration.locations)),
        ]
        return "_".join(key_parts)

    def _update_progress(self, callback: ProgressCallback | None, phase: LoadPhase, percentage: int,
    ) -> bool:
        """Update progress and check for cancellation"""
        if callback:
            return callback(
                percentage=percentage,
                message=f"Load phase: {phase.value}",
                error=None,
            )
        return True