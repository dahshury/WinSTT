"""Load Settings Use Case.

This module implements the use case for loading settings from various sources,
including JSON files, default configurations, and environment variables.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration
from src_refactored.domain.settings.value_objects.settings_operations import (
    LoadSource,
    LoadStrategy,
)


@dataclass
class LoadSettingsRequest:
    """Request for loading settings."""
    sources: list[LoadSource]
    strategy: LoadStrategy = LoadStrategy.FALLBACK
    config_file_path: Path | None = None
    create_if_missing: bool = True
    validate_after_load: bool = True
    merge_with_defaults: bool = True
    environment_prefix: str = "WINSTT_"


@dataclass
class SourceLoadResult:
    """Result from loading a single source."""
    source: LoadSource
    success: bool
    settings: SettingsConfiguration | None = None
    error_message: str | None = None
    warnings: list[str] = None
    metadata: dict[str, Any] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.metadata is None:
            self.metadata = {}


@dataclass
class LoadSettingsResponse:
    """Response from loading settings."""
    success: bool
    settings: SettingsConfiguration | None = None
    source_results: list[SourceLoadResult] = None
    merged_from_sources: list[LoadSource] = None
    validation_errors: list[str] = None
    warnings: list[str] = None
    error_message: str | None = None
    created_default_config: bool = False

    def __post_init__(self):
        if self.source_results is None:
            self.source_results = []
        if self.merged_from_sources is None:
            self.merged_from_sources = []
        if self.validation_errors is None:
            self.validation_errors = []
        if self.warnings is None:
            self.warnings = []


class SettingsRepositoryProtocol(Protocol,
    ):
    """Protocol for settings repository."""

    def load_from_json(self, file_path: Path,
    ) -> SettingsConfiguration:
        """Load settings from JSON file."""
        ...

    def save_to_json(self, settings: SettingsConfiguration, file_path: Path,
    ) -> bool:
        """Save settings to JSON file."""
        ...

    def get_default_settings(self) -> SettingsConfiguration:
        """Get default settings configuration."""
        ...


class EnvironmentLoaderProtocol(Protocol):
    """Protocol for environment variable loader."""

    def load_from_environment(self, prefix: str = "WINSTT_",
    ) -> dict[str, Any]:
        """Load settings from environment variables."""
        ...


class RegistryLoaderProtocol(Protocol):
    """Protocol for Windows registry loader."""

    def load_from_registry(self, key_path: str,
    ) -> dict[str, Any]:
        """Load settings from Windows registry."""
        ...


class SettingsValidatorProtocol(Protocol):
    """Protocol for settings validator."""

    def validate(self, settings: SettingsConfiguration,
    ) -> tuple[bool, list[str]]:
        """Validate settings configuration."""
        ...


class LoadSettingsUseCase:
    """Use case for loading settings from various sources."""

    def __init__(
        self,
        settings_repository: SettingsRepositoryProtocol,
        environment_loader: EnvironmentLoaderProtocol | None = None,
        registry_loader: RegistryLoaderProtocol | None = None,
        validator: SettingsValidatorProtocol | None = None,
    ):
        self.settings_repository = settings_repository
        self.environment_loader = environment_loader
        self.registry_loader = registry_loader
        self.validator = validator

    def execute(self, request: LoadSettingsRequest,
    ) -> LoadSettingsResponse:
        """Execute the load settings use case."""
        try:
            source_results = []
            merged_settings = None
            merged_from_sources = []
            warnings = []
            created_default_config = False

            # Load from each source
            for source in request.sources:
                result = self._load_from_source(source, request)
                source_results.append(result)

                # Handle loading strategy
                if result.success and result.settings:
                    if request.strategy == LoadStrategy.STRICT:
                        # In strict mode, all sources must succeed
                        if merged_settings is None:
                            merged_settings = result.settings
                            merged_from_sources.append(source,
    )
                        else:
                            merged_settings = self._merge_settings(merged_settings, result.settings)
                            merged_from_sources.append(source)

                    elif request.strategy == LoadStrategy.FALLBACK:
                        # In fallback mode, use first successful source
                        if merged_settings is None:
                            merged_settings = result.settings
                            merged_from_sources.append(source,
    )
                            break

                    elif request.strategy in [LoadStrategy.MERGE, LoadStrategy.OVERRIDE]:
                        # In merge/override mode, combine all successful sources
                        if merged_settings is None:
                            merged_settings = result.settings
                            merged_from_sources.append(source,
    )
                        else:
                            if request.strategy == LoadStrategy.MERGE:
merged_settings = (
    self._merge_settings(merged_settings, result.settings))
                            else:  # OVERRIDE
merged_settings = (
    self._override_settings(merged_settings, result.settings))
                            merged_from_sources.append(source)

                elif request.strategy == LoadStrategy.STRICT:
                    # In strict mode, any failure is fatal
                    return LoadSettingsResponse(
                        success=False,
                        source_results=source_results,
                        error_message=f"Failed to load from {source.value}: {result.error_message}",
                    )

                # Collect warnings
                warnings.extend(result.warnings)

            # If no settings loaded and fallback is allowed, create defaults
            if merged_settings is None and request.strategy != LoadStrategy.STRICT:
                if request.merge_with_defaults:
                    merged_settings = self.settings_repository.get_default_settings()
                    merged_from_sources.append(LoadSource.DEFAULT_CONFIG,
    )

                    # Create default config file if requested
                    if request.create_if_missing and request.config_file_path:
                        try:
success = (
    self.settings_repository.save_to_json(merged_settings, request.config_file_path))
                            if success:
                                created_default_config = True
                                warnings.append(f"Created default configuration file: {request.confi\
    g_file_path}")
                        except Exception as e:
                            warnings.append(f"Failed to create default config file: {e!s}",
    )

            # Validate settings if requested
            validation_errors = []
            if request.validate_after_load and merged_settings and self.validator:
                is_valid, errors = self.validator.validate(merged_settings)
                if not is_valid:
                    validation_errors = errors
                    if request.strategy == LoadStrategy.STRICT:
                        return LoadSettingsResponse(
                            success=False,
                            settings=merged_settings,
                            source_results=source_results,
                            validation_errors=validation_errors,
                            error_message="Settings validation failed",
                        )

            # Determine success
            success = merged_settings is not None
            if request.strategy == LoadStrategy.STRICT:
                success = success and len(validation_errors,
    ) == 0

            return LoadSettingsResponse(
                success=success,
                settings=merged_settings,
                source_results=source_results,
                merged_from_sources=merged_from_sources,
                validation_errors=validation_errors,
                warnings=warnings,
                created_default_config=created_default_config,
            )

        except Exception as e:
            return LoadSettingsResponse(
                success=False,
                error_message=f"Unexpected error during settings loading: {e!s}",
            )

    def _load_from_source(self, source: LoadSource, request: LoadSettingsRequest,
    ) -> SourceLoadResult:
        """Load settings from a specific source."""
        try:
            if source == LoadSource.JSON_FILE:
                return self._load_from_json_file(request)
            if source == LoadSource.DEFAULT_CONFIG:
                return self._load_default_config()
            if source == LoadSource.ENVIRONMENT:
                return self._load_from_environment(request)
            if source == LoadSource.REGISTRY:
                return self._load_from_registry()
            if source == LoadSource.COMMAND_LINE:
                return self._load_from_command_line()
            return SourceLoadResult(
                source=source,
                success=False,
                error_message=f"Unsupported source: {source.value}",
            )

        except Exception as e:
            return SourceLoadResult(
                source=source,
                success=False,
                error_message=str(e)
            )

    def _load_from_json_file(self, request: LoadSettingsRequest,
    ) -> SourceLoadResult:
        """Load settings from JSON file."""
        if not request.config_file_path:
            return SourceLoadResult(
                source=LoadSource.JSON_FILE,
                success=False,
                error_message="No config file path specified",
            )

        if not request.config_file_path.exists():
            if request.create_if_missing:
                # Will be handled later in the main flow
                return SourceLoadResult(
                    source=LoadSource.JSON_FILE,
                    success=False,
                    error_message="Config file does not exist",
                    warnings=[f"Config file not found: {request.config_file_path}"],
                )
            return SourceLoadResult(
                source=LoadSource.JSON_FILE,
                success=False,
                error_message=f"Config file does not exist: {request.config_file_path}",
            )

        try:
            settings = self.settings_repository.load_from_json(request.config_file_path,
    )
            return SourceLoadResult(
                source=LoadSource.JSON_FILE,
                success=True,
                settings=settings,
                metadata={"file_path": str(request.config_file_path)},
            )
        except Exception as e:
            return SourceLoadResult(
                source=LoadSource.JSON_FILE,
                success=False,
                error_message=f"Failed to load JSON file: {e!s}",
            )

    def _load_default_config(self) -> SourceLoadResult:
        """Load default configuration."""
        try:
            settings = self.settings_repository.get_default_settings(,
    )
            return SourceLoadResult(
                source=LoadSource.DEFAULT_CONFIG,
                success=True,
                settings=settings,
            )
        except Exception as e:
            return SourceLoadResult(
                source=LoadSource.DEFAULT_CONFIG,
                success=False,
                error_message=f"Failed to load default config: {e!s}",
            )

    def _load_from_environment(self, request: LoadSettingsRequest,
    ) -> SourceLoadResult:
        """Load settings from environment variables."""
        if not self.environment_loader:
            return SourceLoadResult(
                source=LoadSource.ENVIRONMENT,
                success=False,
                error_message="Environment loader not available",
            )

        try:
            env_data = self.environment_loader.load_from_environment(request.environment_prefix,
    )
            if not env_data:
                return SourceLoadResult(
                    source=LoadSource.ENVIRONMENT,
                    success=False,
                    error_message="No environment variables found",
                )

            # Convert environment data to settings configuration
            # This would need to be implemented based on the specific mapping
            settings = self._convert_env_data_to_settings(env_data)

            return SourceLoadResult(
                source=LoadSource.ENVIRONMENT,
                success=True,
                settings=settings,
                metadata={"variables_count": len(env_data)},
            )
        except Exception as e:
            return SourceLoadResult(
                source=LoadSource.ENVIRONMENT,
                success=False,
                error_message=f"Failed to load from environment: {e!s}",
            )

    def _load_from_registry(self) -> SourceLoadResult:
        """Load settings from Windows registry."""
        if not self.registry_loader:
            return SourceLoadResult(
                source=LoadSource.REGISTRY,
                success=False,
                error_message="Registry loader not available",
            )

        try:
registry_data = (
    self.registry_loader.load_from_registry("HKEY_CURRENT_USER\\Software\\WinSTT",)
    )
            if not registry_data:
                return SourceLoadResult(
                    source=LoadSource.REGISTRY,
                    success=False,
                    error_message="No registry data found",
                )

            # Convert registry data to settings configuration
            settings = self._convert_registry_data_to_settings(registry_data)

            return SourceLoadResult(
                source=LoadSource.REGISTRY,
                success=True,
                settings=settings,
                metadata={"keys_count": len(registry_data)},
            )
        except Exception as e:
            return SourceLoadResult(
                source=LoadSource.REGISTRY,
                success=False,
                error_message=f"Failed to load from registry: {e!s}",
            )

    def _load_from_command_line(self) -> SourceLoadResult:
        """Load settings from command line arguments."""
        # This would typically be implemented to parse sys.argv or use argparse
        # For now, return not implemented
        return SourceLoadResult(
            source=LoadSource.COMMAND_LINE,
            success=False,
            error_message="Command line loading not implemented",
        )

    def _merge_settings(self, base: SettingsConfiguration, override: SettingsConfiguration,
    ) -> SettingsConfiguration:
        """Merge two settings configurations, keeping non-None values from override."""
        # This would need to be implemented based on the specific SettingsConfiguration structure
        # For now, return the override settings
        return override

    def _override_settings(self,
    base: SettingsConfiguration, override: SettingsConfiguration,
    ) -> SettingsConfiguration:
        """Override base settings with override settings."""
        # This would completely replace base with override
        return override

    def _convert_env_data_to_settings(self, env_data: dict[str, Any]) -> SettingsConfiguration:
        """Convert environment variable data to settings configuration."""
        # This would need to be implemented based on the specific mapping
        # For now, return default settings
        return self.settings_repository.get_default_settings()

    def _convert_registry_data_to_settings(
    self,
    registry_data: dict[str,
    Any]) -> SettingsConfiguration:
        """Convert registry data to settings configuration."""
        # This would need to be implemented based on the specific mapping
        # For now, return default settings
        return self.settings_repository.get_default_settings()