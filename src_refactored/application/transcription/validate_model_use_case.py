"""Validate model use case.

This module contains the use case for validating transcription models.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src_refactored.domain.common.abstractions import UseCase
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.value_objects.model_configuration import ModelConfiguration
from src_refactored.domain.transcription.value_objects.model_size import ModelSize
from src_refactored.domain.transcription.value_objects.model_type import ModelType


@dataclass
class ValidationIssue:
    """Represents a validation issue."""

    severity: str  # "error", "warning", "info"
    category: str  # "model", "configuration", "system", "performance"
    message: str
    suggestion: str | None = None
    parameter: str | None = None


@dataclass
class ModelValidationInfo:
    """Information about model validation."""

    model_exists: bool
    model_size_bytes: int | None
    model_format_valid: bool
    model_accessible: bool
    model_version: str | None
    supported_languages: list[str] | None
    estimated_memory_usage: float | None
    performance_metrics: dict[str, Any] | None


@dataclass
class SystemValidationInfo:
    """Information about system validation."""

    device_available: bool
    device_memory: float | None
    compute_capability: str | None
    driver_version: str | None
    python_version: str
    dependencies_satisfied: bool
    missing_dependencies: list[str]


@dataclass
class ValidateModelRequest:
    """Request for validating transcription model."""

    model_configuration: ModelConfiguration | None = None
    model_path: str | None = None
    check_model_file: bool = True
    check_system_requirements: bool = True
    check_performance: bool = False
    check_dependencies: bool = True
    validate_languages: bool = True
    quick_validation: bool = False


@dataclass
class ValidateModelResponse:
    """Response for validating transcription model."""

    success: bool
    is_valid: bool
    validation_issues: list[ValidationIssue]
    model_info: ModelValidationInfo | None = None
    system_info: SystemValidationInfo | None = None
    recommendations: list[str] | None = None
    error_message: str | None = None


class ValidateModelUseCase(UseCase[ValidateModelRequest, ValidateModelResponse]):
    """Use case for validating transcription models.
    
    This use case handles comprehensive validation of transcription models,
    including model file validation, system requirements, and performance checks.
    """

    def __init__(
        self,
        model_service=None,
        system_service=None,
        dependency_service=None,
        performance_service=None,
    ):
        """Initialize the validate model use case.
        
        Args:
            model_service: Optional service for model operations
            system_service: Optional service for system information
            dependency_service: Optional service for dependency checking
            performance_service: Optional service for performance testing
        """
        self._model_service = model_service
        self._system_service = system_service
        self._dependency_service = dependency_service
        self._performance_service = performance_service

    def execute(self, request: ValidateModelRequest,
    ) -> ValidateModelResponse:
        """Execute the validate model use case.
        
        Args:
            request: The validate model request
            
        Returns:
            ValidateModelResponse containing the validation result
        """
        try:
            validation_issues = []
            model_info = None
            system_info = None
            recommendations = []

            # Determine model configuration
            model_config = request.model_configuration
            if not model_config and request.model_path:
                # Create basic configuration from path
                model_config = self._create_config_from_path(request.model_path)

            if not model_config:
                return ValidateModelResponse(
                    success=False,
                    is_valid=False,
                    validation_issues=[ValidationIssue(
                        severity="error",
                        category="configuration",
                        message="No model configuration or path provided",
                    )],
                    error_message="Missing model configuration",
                )

            # Validate model file if requested
            if request.check_model_file:
                model_validation = self._validate_model_file(model_config)
                if model_validation.is_success():
                    model_info, file_issues = model_validation.value
                    validation_issues.extend(file_issues)
                else:
                    validation_issues.append(ValidationIssue(
                        severity="error",
                        category="model",
                        message=f"Model file validation failed: {model_validation.error}",
                    ))

            # Validate system requirements if requested
            if request.check_system_requirements:
                system_validation = self._validate_system_requirements(model_config)
                if system_validation.is_success():
                    system_info, system_issues = system_validation.value
                    validation_issues.extend(system_issues)
                else:
                    validation_issues.append(ValidationIssue(
                        severity="error",
                        category="system",
                        message=f"System validation failed: {system_validation.error}",
                    ))

            # Check dependencies if requested
            if request.check_dependencies:
                dependency_issues = self._validate_dependencies(model_config)
                validation_issues.extend(dependency_issues)

            # Validate configuration parameters
            config_issues = self._validate_configuration_parameters(model_config)
            validation_issues.extend(config_issues)

            # Validate language support if requested
            if request.validate_languages:
                language_issues = self._validate_language_support(model_config)
                validation_issues.extend(language_issues)

            # Performance validation if requested and not quick validation
            if request.check_performance and not request.quick_validation:
                performance_issues = self._validate_performance(model_config)
                validation_issues.extend(performance_issues)

            # Generate recommendations
            recommendations = self._generate_recommendations(
                model_config, validation_issues, model_info, system_info,
            )

            # Determine overall validity
            has_errors = any(issue.severity == "error" for issue in validation_issues)
            is_valid = not has_errors

            return ValidateModelResponse(
                success=True,
                is_valid=is_valid,
                validation_issues=validation_issues,
                model_info=model_info,
                system_info=system_info,
                recommendations=recommendations if recommendations else None,
            )

        except Exception as e:
            error_msg = f"Unexpected error during model validation: {e!s}"
            return ValidateModelResponse(
                success=False,
                is_valid=False,
                validation_issues=[ValidationIssue(
                    severity="error",
                    category="system",
                    message=error_msg,
                )],
                error_message=error_msg,
            )

    def _create_config_from_path(self, model_path: str,
    ) -> ModelConfiguration | None:
        """Create basic model configuration from path.
        
        Args:
            model_path: Path to the model file
            
        Returns:
            Basic model configuration or None
        """
        try:
            # Infer model type and size from path
            path_lower = model_path.lower()

            if "whisper" in path_lower:
                model_type = "whisper"
            else:
                model_type = "whisper"  # Default

            # Infer size from filename
            if "tiny" in path_lower:
                model_size = "tiny"
            elif "base" in path_lower:
                model_size = "base"
            elif "small" in path_lower:
                model_size = "small"
            elif "medium" in path_lower:
                model_size = "medium"
            elif "large" in path_lower:
                model_size = "large"
            else:
                model_size = "base"  # Default

            return ModelConfiguration(
                model_type=model_type,
                model_size=model_size,
                model_path=model_path,
                language=None,
                task="transcribe",
                device="cpu",
                compute_type="float32",
                beam_size=5,
                best_of=5,
                temperature=0.0,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
                condition_on_previous_text=True,
                initial_prompt=None,
                word_timestamps=False,
                prepend_punctuations="\"'([{-",
                append_punctuations="\"'.!?):]}",
            )

        except Exception:
            return None

    def _validate_model_file(self, config: ModelConfiguration,
    ) -> Result[tuple]:
        """Validate model file existence and format.
        
        Args:
            config: Model configuration
            
        Returns:
            Result containing (ModelValidationInfo, issues)
        """
        issues = []

        try:
            model_path = config.model_path
            if not model_path:
                # Try to get default path for model type/size
                if self._model_service:
                    default_path_result = self._model_service.get_default_model_path(
                        config.model_type, config.model_size,
                    )
                    if default_path_result.is_success():
                        model_path = default_path_result.value

            if not model_path:
                issues.append(ValidationIssue(
                    severity="error",
                    category="model",
                    message="No model path specified",
                    suggestion="Provide a valid model path or ensure default model is available",
                ))
                return Result.success((None, issues))

            # Check file existence
            model_file = Path(model_path)
            model_exists = model_file.exists()

            if not model_exists:
                issues.append(ValidationIssue(
                    severity="error",
                    category="model",
                    message=f"Model file not found: {model_path}",
                    suggestion="Download the model or check the path",
                ))
                return Result.success((ModelValidationInfo(
                    model_exists=False,
                    model_size_bytes=None,
                    model_format_valid=False,
                    model_accessible=False,
                    model_version=None,
                    supported_languages=None,
                    estimated_memory_usage=None,
                    performance_metrics=None,
                ), issues))

            # Check file accessibility
            model_accessible = model_file.is_file() and model_file.stat().st_size > 0
            if not model_accessible:
                issues.append(ValidationIssue(
                    severity="error",
                    category="model",
                    message="Model file is not accessible or empty",
                    suggestion="Check file permissions and integrity",
                ))

            # Get file size
            model_size_bytes = model_file.stat().st_size if model_accessible else None

            # Validate file format using model service if available
            model_format_valid = True
            model_version = None
            supported_languages = None
            estimated_memory = None

            if self._model_service and model_accessible:
                try:
                    format_result = self._model_service.validate_model_format(model_path)
                    if format_result.is_success():
                        format_info = format_result.value
                        model_format_valid = format_info.get("valid", True)
                        model_version = format_info.get("version")
                        supported_languages = format_info.get("languages")
                        estimated_memory = format_info.get("memory_usage")

                        if not model_format_valid:
                            issues.append(ValidationIssue(
                                severity="error",
                                category="model",
                                message="Invalid model file format",
                                suggestion="Use a compatible model file",
                            ))
                    else:
                        issues.append(ValidationIssue(
                            severity="warning",
                            category="model",
                            message=f"Could not validate model format: {format_result.error}",
                        ))
                except Exception as e:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="model",
                        message=f"Model format validation error: {e!s}",
                    ))

            # Check model size reasonableness
            if model_size_bytes:
                if model_size_bytes < 1024 * 1024:  # Less than 1MB
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="model",
                        message="Model file seems unusually small",
                        suggestion="Verify model file integrity",
                    ))
                elif model_size_bytes > 10 * 1024 * 1024 * 1024:  # More than 10GB
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="model",
                        message="Model file is very large",
                        suggestion="Ensure sufficient disk space and memory",
                    ))

            model_info = ModelValidationInfo(
                model_exists=model_exists,
                model_size_bytes=model_size_bytes,
                model_format_valid=model_format_valid,
                model_accessible=model_accessible,
                model_version=model_version,
                supported_languages=supported_languages,
                estimated_memory_usage=estimated_memory,
                performance_metrics=None,
            )

            return Result.success((model_info, issues))

        except Exception as e:
            return Result.failure(f"Model file validation error: {e!s}")

    def _validate_system_requirements(self, config: ModelConfiguration,
    ) -> Result[tuple]:
        """Validate system requirements for the model.
        
        Args:
            config: Model configuration
            
        Returns:
            Result containing (SystemValidationInfo, issues)
        """
        issues = []

        try:
            # Get system information
            device_available = True
            device_memory = None
            compute_capability = None
            driver_version = None
            dependencies_satisfied = True
            missing_dependencies = []

            if self._system_service:
                try:
                    system_info = self._system_service.get_system_info()
                    if system_info.is_success():
                        info = system_info.value
                        device_memory = info.get("memory")
                        compute_capability = info.get("compute_capability")
                        driver_version = info.get("driver_version")
                except Exception as e:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="system",
                        message=f"Could not get system information: {e!s}",
                    ))

            # Validate device availability
            if config.device == "cuda" and self._system_service:
                try:
                    cuda_available = self._system_service.is_cuda_available()
                    if not cuda_available:
                        device_available = False
                        issues.append(ValidationIssue(
                            severity="error",
                            category="system",
                            message="CUDA device requested but not available",
                            suggestion="Use CPU device or install CUDA support",
                            parameter="device",
                        ))
                except Exception:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="system",
                        message="Could not verify CUDA availability",
                    ))

            # Check memory requirements
            if device_memory:
                estimated_usage = self._estimate_memory_usage(config)
                if estimated_usage and estimated_usage > device_memory * 0.8:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="system",
                        message="Model may require more memory than available",
                        suggestion="Consider using a smaller model or increasing system memory",
                    ))

            # Get Python version
            import sys
            python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"

            # Check dependencies if service available
            if self._dependency_service:
                try:
                    dep_result = self._dependency_service.check_dependencies(config)
                    if dep_result.is_success():
                        dep_info = dep_result.value
                        dependencies_satisfied = dep_info.get("satisfied", True)
                        missing_dependencies = dep_info.get("missing", [])

                        if not dependencies_satisfied:
                            issues.append(ValidationIssue(
                                severity="error",
                                category="system",
                                message=f"Missing dependencies: {', '.join(missing_dependencies)}",
                                suggestion="Install missing dependencies",
                            ))
                except Exception as e:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="system",
                        message=f"Could not check dependencies: {e!s}",
                    ))

            system_info = SystemValidationInfo(
                device_available=device_available,
                device_memory=device_memory,
                compute_capability=compute_capability,
                driver_version=driver_version,
                python_version=python_version,
                dependencies_satisfied=dependencies_satisfied,
                missing_dependencies=missing_dependencies,
            )

            return Result.success((system_info, issues))

        except Exception as e:
            return Result.failure(f"System validation error: {e!s}")

    def _validate_dependencies(self, config: ModelConfiguration,
    ) -> list[ValidationIssue]:
        """Validate required dependencies.

        Args:
            config: Model configuration

        Returns:
            List of validation issues
        """
        issues = []

        # Check basic dependencies
        required_packages = ["numpy", "torch"]

        if config.model_type == ModelType.WHISPER:
            required_packages.extend(["whisper", "librosa"])

        for package in required_packages:
            try:
                __import__(package)
            except ImportError:
                issues.append(ValidationIssue(
                    severity="error",
                    category="system",
                    message=f"Required package not found: {package}",
                    suggestion=f"Install {package} package",
                ))

        return issues

    def _validate_configuration_parameters(self, config: ModelConfiguration,
    ) -> list[ValidationIssue]:
        """Validate configuration parameters.

        Args:
            config: Model configuration

        Returns:
            List of validation issues
        """
        issues = []

        # Validate beam size
        if config.beam_size < 1 or config.beam_size > 20:
            issues.append(ValidationIssue(
                severity="warning",
                category="configuration",
                message="Beam size should be between 1 and 20",
                parameter="beam_size",
                suggestion="Use a beam size between 1 and 20",
            ))

        # Validate temperature
        if config.temperature < 0.0 or config.temperature > 1.0:
            issues.append(ValidationIssue(
                severity="warning",
                category="configuration",
                message="Temperature should be between 0.0 and 1.0",
                parameter="temperature",
                suggestion="Use a temperature between 0.0 and 1.0",
            ))

        # Validate best_of vs beam_size
        if config.best_of < config.beam_size:
            issues.append(ValidationIssue(
                severity="warning",
                category="configuration",
                message="best_of should be >= beam_size",
                parameter="best_of",
                suggestion="Set best_of to at least the beam_size value",
            ))

        return issues

    def _validate_language_support(self, config: ModelConfiguration,
    ) -> list[ValidationIssue]:
        """Validate language support.

        Args:
            config: Model configuration

        Returns:
            List of validation issues
        """
        issues = []

        if config.language and self._model_service:
            try:
                lang_result = self._model_service.is_language_supported(
                    config.model_type, config.language,
                )
                if lang_result.is_success() and not lang_result.value:
                    issues.append(ValidationIssue(
                        severity="warning",
                        category="configuration",
                        message=f"Language '{config.language}' may not be supported",
                        parameter="language",
                        suggestion="Check supported languages or use auto-detection",
                    ))
            except Exception:
                pass

        return issues

    def _validate_performance(self, config: ModelConfiguration,
    ) -> list[ValidationIssue]:
        """Validate performance characteristics.

        Args:
            config: Model configuration

        Returns:
            List of validation issues
        """
        issues = []

        if self._performance_service:
            try:
                perf_result = self._performance_service.test_model_performance(config)
                if perf_result.is_success():
                    perf_info = perf_result.value

                    if perf_info.get("load_time", 0) > 30:
                        issues.append(ValidationIssue(
                            severity="info",
                            category="performance",
                            message="Model loading time is high",
                            suggestion="Consider using a smaller model for faster loading",
                        ))

                    if perf_info.get("inference_speed", 0) < 0.5:
                        issues.append(ValidationIssue(
                            severity="info",
                            category="performance",
                            message="Inference speed is slow",
                            suggestion="Consider optimizing configuration or using GPU",
                        ))
            except Exception as e:
                issues.append(ValidationIssue(
                    severity="info",
                    category="performance",
                    message=f"Could not test performance: {e!s}",
                ))

        return issues

    def _estimate_memory_usage(self, config: ModelConfiguration,
    ) -> float | None:
        """Estimate memory usage for the model.

        Args:
            config: Model configuration

        Returns:
            Estimated memory usage in GB
        """
        # Basic estimation based on model size
        size_memory_map = {
            ModelSize.TINY: 0.5,
            ModelSize.BASE: 1.0,
            ModelSize.SMALL: 2.0,
            ModelSize.MEDIUM: 4.0,
            ModelSize.LARGE: 8.0,
        }

        base_memory = size_memory_map.get(config.model_size, 2.0)

        # Adjust for compute type
        if config.compute_type == "float32":
            base_memory *= 2
        elif config.compute_type == "int8":
            base_memory *= 0.5

        return base_memory

    def _generate_recommendations(
        self,
        config: ModelConfiguration,
        issues: list[ValidationIssue],
        model_info: ModelValidationInfo | None,
        system_info: SystemValidationInfo | None,
    ) -> list[str]:
        """Generate recommendations based on validation results.

        Args:
            config: Model configuration
            issues: Validation issues
            model_info: Model validation info
            system_info: System validation info

        Returns:
            List of recommendations
        """
        recommendations = []

        # Extract suggestions from issues
        for issue in issues:
            if issue.suggestion and issue.suggestion not in recommendations:
                recommendations.append(issue.suggestion)

        # Add general recommendations
        if system_info and not system_info.device_available and config.device == "cuda":
            recommendations.append("Consider using CPU device for better compatibility")

        if model_info and model_info.model_size_bytes and model_info.model_size_bytes > 5 * 1024 * 1024 * 1024:
            recommendations.append("Consider using a smaller model for better performance")

        if config.temperature > 0.5:
            recommendations.append("Lower temperature values typically provide more consistent results")

        return recommendations