"""Validate settings use case implementation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import UseCase
from src_refactored.domain.settings.value_objects.key_combination import KeyCombination
from src_refactored.domain.settings.value_objects.settings_operations import (
    ValidationCategory,
    ValidationSeverity,
)

if TYPE_CHECKING:
    from src_refactored.domain.settings.entities.settings_configuration import SettingsConfiguration


@dataclass(frozen=True)
class ValidationRule:
    """Validation rule definition."""
    name: str
    category: ValidationCategory
    severity: ValidationSeverity
    description: str


@dataclass(frozen=True)
class ValidationIssue:
    """Validation issue information."""
    rule: ValidationRule
    key: str
    value: Any
    message: str
    suggestion: str | None = None


@dataclass(frozen=True)
class ValidateSettingsRequest:
    """Request for validating settings."""
    settings: dict[str, Any] | None = None
    categories: set[ValidationCategory] | None = None
    severity_filter: ValidationSeverity | None = None
    include_business_rules: bool = True
    include_system_checks: bool = True


@dataclass(frozen=True)
class ValidateSettingsResponse:
    """Response for validating settings."""
    is_valid: bool
    issues: list[ValidationIssue]
    errors_count: int
    warnings_count: int
    info_count: int
    validated_settings: dict[str, Any]
    message: str | None = None


class ValidateSettingsUseCase(UseCase[ValidateSettingsRequest, ValidateSettingsResponse]):
    """Use case for validating application settings.
    
    This use case handles:
    - Comprehensive settings validation
    - Business rules enforcement
    - System compatibility checks
    - Detailed issue reporting with suggestions
    """

    def __init__(
        self,
        settings_config: SettingsConfiguration,
        available_models: list[str] | None = None,
        available_quantizations: list[str] | None = None,
    ):
        """Initialize the validate settings use case.
        
        Args:
            settings_config: Settings configuration entity
            available_models: List of available models
            available_quantizations: List of available quantizations
        """
        self._settings_config = settings_config
        self._available_models = available_models or self._get_default_models()
        self._available_quantizations = available_quantizations or self._get_default_quantizations()
        self._validation_rules = self._initialize_validation_rules()

    def execute(self, request: ValidateSettingsRequest) -> ValidateSettingsResponse:
        """Execute the validate settings use case.
        
        Args:
            request: Validate settings request
            
        Returns:
            Validation response with results or error information
        """
        try:
            # Get settings to validate
            settings = request.settings or self._settings_config.load_configuration()

            # Filter validation rules
            rules_to_apply = self._filter_validation_rules(
                request.categories,
                request.severity_filter,
            )

            # Perform validation
            issues = []

            # Basic structure validation
            issues.extend(self._validate_structure(settings, rules_to_apply))

            # Type validation
            issues.extend(self._validate_types(settings, rules_to_apply))

            # Business rules validation
            if request.include_business_rules:
                issues.extend(self._validate_business_rules(settings, rules_to_apply))

            # System compatibility validation
            if request.include_system_checks:
                issues.extend(self._validate_system_compatibility(settings, rules_to_apply))

            # Count issues by severity
            errors_count = sum(1 for issue in issues if issue.rule.severity == ValidationSeverity.ERROR)
            warnings_count = sum(1 for issue in issues if issue.rule.severity == ValidationSeverity.WARNING)
            info_count = sum(1 for issue in issues if issue.rule.severity == ValidationSeverity.INFO)

            # Determine overall validity
            is_valid = errors_count == 0

            # Generate message
            message = self._generate_validation_message(is_valid, errors_count, warnings_count, info_count)

            return ValidateSettingsResponse(
                is_valid=is_valid,
                issues=issues,
                errors_count=errors_count,
                warnings_count=warnings_count,
                info_count=info_count,
                validated_settings=settings,
                message=message,
            )

        except Exception as e:
            # Return response indicating validation failure
            return ValidateSettingsResponse(
                is_valid=False,
                issues=[],
                errors_count=1,
                warnings_count=0,
                info_count=0,
                validated_settings={},
                message=f"Validation error: {e!s}",
            )

    def _validate_structure(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate settings structure.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        # Check required keys
        required_keys = {
            "model", "quantization", "recording_sound_enabled",
            "sound_file_path", "output_srt", "recording_key",
        }

        structure_rule = next(
            (rule for rule in rules if rule.name == "required_keys"),
            ValidationRule(
                name="required_keys",
                category=ValidationCategory.SYSTEM,
                severity=ValidationSeverity.ERROR,
                description="Required settings keys must be present",
            ),
        )

        for key in required_keys:
            if key not in settings:
                issues.append(
                    ValidationIssue(
                        rule=structure_rule,
                        key=key,
                        value=None,
                        message=f"Required setting '{key}' is missing",
                        suggestion=f"Add '{key}' to settings configuration",
                    ),
                )

        return issues

    def _validate_types(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate settings data types.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        type_rule = next(
            (rule for rule in rules if rule.name == "data_types"),
            ValidationRule(
                name="data_types",
                category=ValidationCategory.SYSTEM,
                severity=ValidationSeverity.ERROR,
                description="Settings must have correct data types",
            ),
        )

        type_expectations = {
            "model": str,
            "quantization": str,
            "recording_sound_enabled": bool,
            "sound_file_path": str,
            "output_srt": bool,
            "recording_key": str,
            "llm_enabled": bool,
            "llm_model": str,
            "llm_quantization": str,
            "llm_prompt": str,
        }

        for key, expected_type in type_expectations.items():
            if key in settings and not isinstance(settings[key], expected_type):
                issues.append(
                    ValidationIssue(
                        rule=type_rule,
                        key=key,
                        value=settings[key],
                        message=(
                            f"Setting '{key}' must be of type {expected_type.__name__}, got {type(settings[key]).__name__}"
                        ),
                        suggestion=f"Convert '{key}' value to {expected_type.__name__}",
                    ),
                )

        return issues

    def _validate_business_rules(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate business rules.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        # Validate model configuration
        issues.extend(self._validate_model_config(settings, rules))

        # Validate audio configuration
        issues.extend(self._validate_audio_config(settings, rules))

        # Validate hotkey configuration
        issues.extend(self._validate_hotkey_config(settings, rules))

        # Validate LLM configuration
        issues.extend(self._validate_llm_config(settings, rules))

        return issues

    def _validate_model_config(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate model configuration.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        model_rule = next(
            (rule for rule in rules if rule.name == "model_validation"),
            ValidationRule(
                name="model_validation",
                category=ValidationCategory.MODEL,
                severity=ValidationSeverity.ERROR,
                description="Model configuration must be valid",
            ),
        )

        model = settings.get("model")
        quantization = settings.get("quantization")

        # Validate model availability
        if model and model not in self._available_models:
            issues.append(
                ValidationIssue(
                    rule=model_rule,
                    key="model",
                    value=model,
                    message=f"Model '{model}' is not available",
                    suggestion=f"Use one of: {', '.join(self._available_models)}",
                ),
            )

        # Validate quantization availability
        if quantization and quantization not in self._available_quantizations:
            issues.append(
                ValidationIssue(
                    rule=model_rule,
                    key="quantization",
                    value=quantization,
                    message=f"Quantization '{quantization}' is not available",
                    suggestion=f"Use one of: {', '.join(self._available_quantizations)}",
                ),
            )

        return issues

    def _validate_audio_config(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate audio configuration.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        audio_rule = next(
            (rule for rule in rules if rule.name == "audio_validation"),
            ValidationRule(
                name="audio_validation",
                category=ValidationCategory.AUDIO,
                severity=ValidationSeverity.WARNING,
                description="Audio configuration should be valid",
            ),
        )

        sound_file_path = settings.get("sound_file_path", "")

        # Validate sound file path if provided
        if sound_file_path and not Path(sound_file_path).exists():
            issues.append(
                ValidationIssue(
                    rule=audio_rule,
                    key="sound_file_path",
                    value=sound_file_path,
                    message=f"Sound file path does not exist: {sound_file_path}",
                    suggestion="Provide a valid path to an audio file or leave empty",
                ),
            )

        return issues

    def _validate_hotkey_config(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate hotkey configuration.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        hotkey_rule = next(
            (rule for rule in rules if rule.name == "hotkey_validation"),
            ValidationRule(
                name="hotkey_validation",
                category=ValidationCategory.HOTKEY,
                severity=ValidationSeverity.ERROR,
                description="Hotkey configuration must be valid",
            ),
        )

        recording_key = settings.get("recording_key")

        if recording_key:
            try:
                KeyCombination.from_string(recording_key)
            except Exception as e:
                issues.append(
                    ValidationIssue(
                        rule=hotkey_rule,
                        key="recording_key",
                        value=recording_key,
                        message=f"Invalid hotkey combination: {e!s}",
                        suggestion="Use a valid key combination like 'CTRL+SHIFT+R'",
                    ),
                )

        return issues

    def _validate_llm_config(
    self,
    settings: dict[str,
    Any],
    rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate LLM configuration.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        issues = []

        llm_rule = next(
            (rule for rule in rules if rule.name == "llm_validation"),
            ValidationRule(
                name="llm_validation",
                category=ValidationCategory.LLM,
                severity=ValidationSeverity.WARNING,
                description="LLM configuration should be valid when enabled",
            ),
        )

        llm_enabled = settings.get("llm_enabled", False)

        if llm_enabled:
            llm_model = settings.get("llm_model")
            llm_prompt = settings.get("llm_prompt")

            if not llm_model or not llm_model.strip():
                issues.append(
                    ValidationIssue(
                        rule=llm_rule,
                        key="llm_model",
                        value=llm_model,
                        message="LLM model must be specified when LLM is enabled",
                        suggestion="Specify a valid LLM model name",
                    ),
                )

            if not llm_prompt or not llm_prompt.strip():
                issues.append(
                    ValidationIssue(
                        rule=llm_rule,
                        key="llm_prompt",
                        value=llm_prompt,
                        message="LLM prompt should not be empty when LLM is enabled",
                        suggestion="Provide a meaningful prompt for the LLM",
                    ),
                )

        return issues

    def _validate_system_compatibility(self,
    settings: dict[str, Any], rules: list[ValidationRule]) -> list[ValidationIssue]:
        """Validate system compatibility.
        
        Args:
            settings: Settings to validate
            rules: Validation rules to apply
            
        Returns:
            List of validation issues
        """
        return []

        # System compatibility checks would go here
        # For example: checking if ONNX runtime supports the selected model


    def _filter_validation_rules(
        self,
        categories: set[ValidationCategory] | None,
        severity_filter: ValidationSeverity | None,
    ) -> list[ValidationRule]:
        """Filter validation rules based on criteria.
        
        Args:
            categories: Categories to include
            severity_filter: Minimum severity level
            
        Returns:
            Filtered validation rules
        """
        rules = self._validation_rules

        if categories:
            rules = [rule for rule in rules if rule.category in categories]

        if severity_filter:
            severity_order = [
                ValidationSeverity.ERROR, ValidationSeverity.WARNING, ValidationSeverity.INFO,
            ]
            min_index = severity_order.index(severity_filter)
            rules = [rule for rule in rules if severity_order.index(rule.severity) >= min_index]

        return rules

    def _generate_validation_message(
        self,
        is_valid: bool,
        errors_count: int,
        warnings_count: int,
        info_count: int,
    ) -> str:
        """Generate validation summary message.
        
        Args:
            is_valid: Whether settings are valid
            errors_count: Number of errors
            warnings_count: Number of warnings
            info_count: Number of info items
            
        Returns:
            Validation message
        """
        if is_valid and warnings_count == 0 and info_count == 0:
            return "Settings validation passed successfully"
        if is_valid:
            parts = []
            if warnings_count > 0:
                parts.append(f"{warnings_count} warning(s)")
            if info_count > 0:
                parts.append(f"{info_count} info item(s)")
            return f"Settings validation passed with {', '.join(parts)}"
        return f"Settings validation failed with {errors_count} error(s)"

    def _initialize_validation_rules(self) -> list[ValidationRule]:
        """Initialize validation rules.
        
        Returns:
            List of validation rules
        """
        return [
            ValidationRule(
                name="required_keys",
                category=ValidationCategory.SYSTEM,
                severity=ValidationSeverity.ERROR,
                description="Required settings keys must be present",
            ),
            ValidationRule(
                name="data_types",
                category=ValidationCategory.SYSTEM,
                severity=ValidationSeverity.ERROR,
                description="Settings must have correct data types",
            ),
            ValidationRule(
                name="model_validation",
                category=ValidationCategory.MODEL,
                severity=ValidationSeverity.ERROR,
                description="Model configuration must be valid",
            ),
            ValidationRule(
                name="audio_validation",
                category=ValidationCategory.AUDIO,
                severity=ValidationSeverity.WARNING,
                description="Audio configuration should be valid",
            ),
            ValidationRule(
                name="hotkey_validation",
                category=ValidationCategory.HOTKEY,
                severity=ValidationSeverity.ERROR,
                description="Hotkey configuration must be valid",
            ),
            ValidationRule(
                name="llm_validation",
                category=ValidationCategory.LLM,
                severity=ValidationSeverity.WARNING,
                description="LLM configuration should be valid when enabled",
            ),
        ]

    def _get_default_models(self) -> list[str]:
        """Get default available models.
        
        Returns:
            List of default models
        """
        return ["tiny", "base", "small", "medium", "large"]

    def _get_default_quantizations(self) -> list[str]:
        """Get default available quantizations.
        
        Returns:
            List of default quantizations
        """
        return ["int8", "fp16", "fp32"]