"""Startup Application Use Case.

This module implements the use case for application startup workflow,
including environment setup, logging configuration, and UI initialization.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from src.domain.application_lifecycle.entities import StartupConfiguration
from src.domain.application_lifecycle.entities.application_instance import (
    ApplicationInstance,
)
from src.domain.application_lifecycle.value_objects import StartupPhase, StartupResult
from src.domain.common.ports.command_line_port import ICommandLinePort
from src.domain.main_window.entities.main_window_instance import MainWindowInstance


@dataclass
class StartupApplicationRequest:
    """Request for application startup."""
    configuration: StartupConfiguration
    progress_callback: Callable[[int, str, StartupPhase], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None
    command_line_args: list[str] | None = None


@dataclass
class StartupApplicationResponse:
    """Response from application startup."""
    result: StartupResult
    application: ApplicationInstance | None = None  # Application instance
    main_window: MainWindowInstance | None = None  # Main window instance
    logger: logging.Logger | None = None
    completed_phases: list[StartupPhase] = field(default_factory=list)
    current_phase: StartupPhase = StartupPhase.ENVIRONMENT_SETUP
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.completed_phases is None:
            self.completed_phases = []
        if self.warnings is None:
            self.warnings = []


class LoggerServiceProtocol(Protocol,
    ):
    """Protocol for logger service."""

    def setup_logger(self, level: int = logging.INFO) -> logging.Logger:
        """Setup application logger."""
        ...


class EnvironmentServiceProtocol(Protocol,
    ):
    """Protocol for environment service."""

    def setup_environment_variables(self, variables: dict[str, str]) -> bool:
        """Setup environment variables."""
        ...

    def suppress_warnings(self) -> bool:
        """Suppress application warnings."""
        ...


class SingleInstanceServiceProtocol(Protocol):
    """Protocol for single instance service."""

    def is_already_running(self, port: int,
    ) -> bool:
        """Check if application is already running."""
        ...

    def activate_existing_instance(self, app_name: str,
    ) -> bool:
        """Activate existing application instance."""
        ...

    def cleanup(self) -> None:
        """Cleanup single instance resources."""
        ...


class ApplicationFactoryProtocol(Protocol):
    """Protocol for application factory."""

    def create_application(self, args: list[str], config: StartupConfiguration,
    ) -> ApplicationInstance:
        """Create application instance."""
        ...

    def create_main_window(self) -> MainWindowInstance:
        """Create main window instance."""
        ...


class StartupApplicationUseCase:
    """Use case for application startup workflow."""

    def __init__(
        self,
        logger_service: LoggerServiceProtocol,
        environment_service: EnvironmentServiceProtocol,
        single_instance_service: SingleInstanceServiceProtocol,
        application_factory: ApplicationFactoryProtocol,
        command_line_service: ICommandLinePort,
    ):
        self.logger_service = logger_service
        self.environment_service = environment_service
        self.single_instance_service = single_instance_service
        self.application_factory = application_factory
        self.command_line_service = command_line_service
        self.current_phase = StartupPhase.ENVIRONMENT_SETUP

    def execute(self, request: StartupApplicationRequest,
    ) -> StartupApplicationResponse:
        """Execute the startup application use case."""
        response = StartupApplicationResponse(
            result=StartupResult.CRITICAL_ERROR,
            current_phase=self.current_phase,
        )

        try:
            # Phase 1: Environment Setup
            self._update_progress(request, 10, "Setting up environment...", StartupPhase.ENVIRONMENT_SETUP)
            success = self._setup_environment(request, response)
            if not success:
                return self._create_error_response("Environment setup failed", response)

            # Phase 2: Logging Setup
            self._update_progress(request, 20, "Setting up logging...", StartupPhase.LOGGING_SETUP)
            success = self._setup_logging(request, response)
            if not success:
                return self._create_error_response("Logging setup failed", response)

            # Phase 3: Warnings Suppression
            self._update_progress(request, 30, "Suppressing warnings...", StartupPhase.WARNINGS_SUPPRESSION)
            success = self._suppress_warnings(request, response)
            if not success:
                response.warnings.append("Warning suppression failed")

            # Phase 4: Framework Initialization
            self._update_progress(request, 50, "Initializing framework...", StartupPhase.FRAMEWORK_INITIALIZATION)
            success = self._initialize_framework(request, response)
            if not success:
                return self._create_error_response("Framework initialization failed", response)

            # Phase 5: Single Instance Check
            self._update_progress(request, 70, "Checking for existing instance...", StartupPhase.SINGLE_INSTANCE_CHECK)
            is_running = self._check_single_instance(request, response)
            if is_running:
                response.result = StartupResult.ALREADY_RUNNING
                return response

            # Phase 6: Window Creation
            self._update_progress(request, 90, "Creating main window...", StartupPhase.WINDOW_CREATION)
            success = self._create_main_window(request, response)
            if not success:
                return self._create_error_response("Window creation failed", response)

            # Phase 7: Application Ready
            self._update_progress(request, 100, "Application ready", StartupPhase.APPLICATION_READY)
            response.result = StartupResult.SUCCESS
            response.current_phase = StartupPhase.APPLICATION_READY
            response.completed_phases.append(StartupPhase.APPLICATION_READY)

            return response

        except Exception as e:
            return self._create_error_response(f"Unexpected startup error: {e!s}", response, e)

    def _setup_environment(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Setup environment variables and configuration."""
        try:
            success = self.environment_service.setup_environment_variables(
                request.configuration.environment_variables,
            )

            if success:
                response.completed_phases.append(StartupPhase.ENVIRONMENT_SETUP)
                return True

            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Environment setup failed", e)
            return False

    def _setup_logging(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Setup application logging."""
        try:
            if request.configuration.enable_logging:
                # Convert domain LogLevel enum to int for logger setup
                try:
                    level_int = int(request.configuration.log_level.value)
                except Exception:
                    level_int = logging.INFO
                logger = self.logger_service.setup_logger(level_int)
                response.logger = logger

                if logger:
                    logger.info("Application logging initialized")
                    response.completed_phases.append(StartupPhase.LOGGING_SETUP)
                    return True
            else:
                response.completed_phases.append(StartupPhase.LOGGING_SETUP,
    )
                return True

            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Logging setup failed", e)
            return False

    def _suppress_warnings(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Suppress application warnings."""
        try:
            if request.configuration.suppress_warnings:
                success = self.environment_service.suppress_warnings()

                if success:
                    response.completed_phases.append(StartupPhase.WARNINGS_SUPPRESSION)
                    return True
                return False
            response.completed_phases.append(StartupPhase.WARNINGS_SUPPRESSION,
    )
            return True

        except Exception as e:
            if request.error_callback:
                request.error_callback("Warning suppression failed", e)
            return False

    def _initialize_framework(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Initialize the application framework (PyQt)."""
        try:
            args_result = self.command_line_service.get_arguments()
            args = request.command_line_args if request.command_line_args is not None else (args_result.value if args_result.is_success and args_result.value is not None else [])
            app = self.application_factory.create_application(args, request.configuration)

            if app:
                response.application = app
                response.completed_phases.append(StartupPhase.FRAMEWORK_INITIALIZATION)

                if response.logger:
                    response.logger.info("Framework initialized successfully")

                return True

            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Framework initialization failed", e)
            return False

    def _check_single_instance(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Check if application is already running."""
        try:
            is_running = self.single_instance_service.is_already_running(
                request.configuration.single_instance_port,
            )

            if is_running:
                # Try to activate existing instance
                activated = self.single_instance_service.activate_existing_instance(
                    request.configuration.app_name,
                )

                if response.logger:
                    if activated:
                        response.logger.info("Activated existing application instance")
                    else:
                        response.logger.warning("Could not activate existing instance")
                        response.warnings.append("Could not activate existing instance")

                return True  # Another instance is running

            response.completed_phases.append(StartupPhase.SINGLE_INSTANCE_CHECK)
            return False  # No other instance running

        except Exception as e:
            if request.error_callback:
                request.error_callback("Single instance check failed", e)
            # Continue startup even if single instance check fails
            response.warnings.append(f"Single instance check failed: {e!s}")
            response.completed_phases.append(StartupPhase.SINGLE_INSTANCE_CHECK)
            return False

    def _create_main_window(self, request: StartupApplicationRequest, response: StartupApplicationResponse,
    ) -> bool:
        """Create and setup the main window."""
        try:
            window = self.application_factory.create_main_window()

            if window:
                response.main_window = window
                response.completed_phases.append(StartupPhase.WINDOW_CREATION)

                if response.logger:
                    response.logger.info("Main window created successfully",
    )

                return True

            return False

        except Exception as e:
            if request.error_callback:
                request.error_callback("Window creation failed", e)
            return False

    def _update_progress(
        self,
        request: StartupApplicationRequest,
        percentage: int,
        message: str,
        phase: StartupPhase,
    ) -> None:
        """Update startup progress."""
        self.current_phase = phase

        if request.progress_callback:
            request.progress_callback(percentage, message, phase)

    def _create_error_response(
        self,
        error_message: str,
        response: StartupApplicationResponse,
        exception: Exception | None = None,
    ) -> StartupApplicationResponse:
        """Create an error response."""
        response.result = StartupResult.CRITICAL_ERROR
        response.error_message = error_message

        if response.logger:
            if exception:
                response.logger.exception(f"Startup error: {error_message}")
            else:
                response.logger.error("Startup error: {error_message}")

        return response

    def get_current_phase(self) -> StartupPhase:
        """Get the current startup phase."""
        return self.current_phase

    def cleanup(self) -> None:
        """Cleanup startup resources."""
        try:
            self.single_instance_service.cleanup()
        except Exception:
            pass  # Ignore cleanup errors