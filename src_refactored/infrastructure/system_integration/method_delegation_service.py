"""Method Delegation Service for dynamic method assignment and delegation.

This module provides infrastructure services for managing method delegation
patterns, allowing dynamic assignment of methods from external modules
to class instances in the WinSTT application.
"""

import importlib
import inspect
from collections.abc import Callable
from typing import Any, Protocol

from PyQt6.QtCore import QObject, pyqtSignal

from logger import setup_logger
from src.domain.common.result import Result
from src_refactored.domain.system_integration.value_objects.method_delegation import (
    DelegationConfiguration,
    DelegationMode,
    MethodInfo,
    MethodType,
)


class MethodDelegationServiceProtocol(Protocol):
    """Protocol for method delegation operations."""

    def delegate_method(self, target_instance: Any, method_info: MethodInfo,
    ) -> bool:
        """Delegate a single method to target instance."""
        ...

    def delegate_methods(self, target_instance: Any, config: DelegationConfiguration,
    ) -> bool:
        """Delegate multiple methods to target instance."""
        ...

    def validate_delegation(self, target_instance: Any, method_name: str,
    ) -> bool:
        """Validate that a method delegation is working correctly."""
        ...


class MethodDelegationService(QObject):
    """Service for managing method delegation patterns."""

    # Signals
    method_delegated = pyqtSignal(str, str)  # method_name, target_class
    delegation_failed = pyqtSignal(str, str, str)  # method_name, target_class, error_message
    delegation_validated = pyqtSignal(str, bool)  # method_name, is_valid

    def __init__(self):
        super().__init__()
        self.logger = setup_logger()
self._delegated_methods: dict[str, dict[str, MethodInfo]] = (
    {}  # class_name -> {method_name -> MethodInfo})
        self._source_modules: dict[str, Any] = {}  # module_path -> module_object

    def register_delegation_configuration(self, config: DelegationConfiguration,
    ) -> Result[None]:
        """Register a delegation configuration."""
        try:
            if config.target_class_name not in self._delegated_methods:
                self._delegated_methods[config.target_class_name] = {}

            for method_info in config.methods:
                self._delegated_methods[config.target_class_name][method_info.name] = method_info

            # Import source module if auto_import is enabled
            if config.auto_import:
                import_result = self._import_source_module(config.source_module_path)
                if not import_result.is_success:
                    return Result.failure(f"Failed to import source module: {import_result.error()}"\
    )

            self.logger.debug("Registered delegation configuration for {config.target_class_name} wi\
    th {len(config.methods)} methods")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to register delegation configuration: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def delegate_method(self, target_instance: Any, method_info: MethodInfo,
    ) -> Result[None]:
        """Delegate a single method to target instance."""
        try:
            # Import source module if not already imported
            if method_info.source_module not in self._source_modules:
                import_result = self._import_source_module(method_info.source_module)
                if not import_result.is_success:
error_msg = (
    f"Failed to import source module {method_info.source_module}: {import_result.error()}
    )}"
                    self.delegation_failed.emit(method_info.name, target_instance.__class__.__name__, error_msg)
                    return Result.failure(error_msg)

            source_module = self._source_modules[method_info.source_module]

            # Get source function
            if not hasattr(source_module, method_info.source_function):
                error_msg
 = (
    f"Source function {method_info.source_function} not found in module {method_info.source_module}")
                self.delegation_failed.emit(method_info.name, target_instance.__class__.__name__, error_msg)
                return Result.failure(error_msg)

            source_function = getattr(source_module, method_info.source_function)

            # Apply delegation based on mode
            if method_info.delegation_mode == DelegationMode.DIRECT_ASSIGNMENT:
                setattr(target_instance, method_info.name, source_function)

            elif method_info.delegation_mode == DelegationMode.WRAPPER_FUNCTION:
                wrapper = self._create_wrapper_function(source_function, target_instance)
                setattr(target_instance, method_info.name, wrapper)

            elif method_info.delegation_mode == DelegationMode.PROXY_OBJECT:
                proxy = self._create_proxy_object(source_function, target_instance)
                setattr(target_instance, method_info.name, proxy)

            else:
                error_msg = f"Unsupported delegation mode: {method_info.delegation_mode}"
                self.delegation_failed.emit(method_info.name, target_instance.__class__.__name__, error_msg)
                return Result.failure(error_msg)

            self.method_delegated.emit(method_info.name, target_instance.__class__.__name__)
            self.logger.debug("Delegated method {method_info.name} to {target_instance.__class__.__n\
    ame__}")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to delegate method {method_info.name}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.delegation_failed.emit(method_info.name, target_instance.__class__.__name__, error_msg)
            return Result.failure(error_msg)

    def delegate_methods(self, target_instance: Any, config: DelegationConfiguration,
    ) -> Result[list[str]]:
        """Delegate multiple methods to target instance."""
        try:
            successful_delegations = []
            failed_delegations = []

            for method_info in config.methods:
                result = self.delegate_method(target_instance, method_info)

                if result.is_success:
                    successful_delegations.append(method_info.name)
                else:
                    failed_delegations.append(f"{method_info.name}: {result.error()}")
                    if method_info.is_required:
                        error_msg = f"Required method delegation failed: {method_info.name}"
                        self.logger.error(error_msg)
                        return Result.failure(error_msg)

            if failed_delegations:
                self.logger.warning("Some method delegations failed: {failed_delegations}")

            self.logger.info("Successfully delegated {len(successful_delegations)} methods to {targe\
    t_instance.__class__.__name__}")
            return Result.success(successful_delegations)

        except Exception as e:
            error_msg = f"Failed to delegate methods: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def validate_delegation(self, target_instance: Any, method_name: str,
    ) -> Result[bool]:
        """Validate that a method delegation is working correctly."""
        try:
            # Check if method exists
            if not hasattr(target_instance, method_name):
                self.delegation_validated.emit(method_name, False)
                return Result.success(False)

            method = getattr(target_instance, method_name)

            # Check if method is callable
            if not callable(method):
                self.delegation_validated.emit(method_name, False)
                return Result.success(False)

            # Additional validation based on method type
            class_name = target_instance.__class__.__name__
            if class_name in self._delegated_methods and
    method_name in self._delegated_methods[class_name]:
                method_info = self._delegated_methods[class_name][method_name]

                # Validate signature if required
                if hasattr(self, "_validate_method_signature"):
                    signature_valid = self._validate_method_signature(method, method_info)
                    if not signature_valid:
                        self.delegation_validated.emit(method_name, False)
                        return Result.success(False)

            self.delegation_validated.emit(method_name, True)
            return Result.success(True)

        except Exception as e:
            error_msg = f"Failed to validate delegation for {method_name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def get_delegated_methods(self, target_class_name: str,
    ) -> Result[list[str]]:
        """Get list of delegated methods for a target class."""
        try:
            if target_class_name not in self._delegated_methods:
                return Result.success([])

            method_names = list(self._delegated_methods[target_class_name].keys())
            return Result.success(method_names)

        except Exception as e:
            error_msg = f"Failed to get delegated methods for {target_class_name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def remove_delegation(self, target_instance: Any, method_name: str,
    ) -> Result[None]:
        """Remove a method delegation from target instance."""
        try:
            if hasattr(target_instance, method_name):
                delattr(target_instance, method_name)
                self.logger.debug("Removed delegation for {method_name} from {target_instance.__clas\
    s__.__name__}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to remove delegation for {method_name}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def _import_source_module(self, module_path: str,
    ) -> Result[Any]:
        """Import source module dynamically."""
        try:
            if module_path in self._source_modules:
                return Result.success(self._source_modules[module_path])

            module = importlib.import_module(module_path)
            self._source_modules[module_path] = module

            self.logger.debug("Imported source module: {module_path}")
            return Result.success(module)

        except ImportError as e:
            error_msg = f"Failed to import module {module_path}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def _create_wrapper_function(self, source_function: Callable, target_instance: Any,
    ) -> Callable:
        """Create a wrapper function for method delegation."""
        def wrapper(*args, **kwargs):
            # Inject target instance as first argument if needed
            if inspect.signature(source_function).parameters:
                first_param = next(iter(inspect.signature(source_function).parameters.keys()),
    )
                if first_param == "self":
                    return source_function(target_instance, *args, **kwargs)
            return source_function(*args, **kwargs)

        wrapper.__name__ = source_function.__name__
        wrapper.__doc__ = source_function.__doc__
        return wrapper

    def _create_proxy_object(self, source_function: Callable, target_instance: Any,
    ) -> Any:
        """Create a proxy object for method delegation."""
        class MethodProxy:
            def __init__(self, func, instance):
                self.func = func
                self.instance = instance

            def __call__(self, *args, **kwargs):
                return self.func(self.instance, *args, **kwargs)

            def __getattr__(self, name):
                return getattr(self.func, name)

        return MethodProxy(source_function, target_instance)

    @classmethod
    def create_for_main_window(cls) -> "MethodDelegationService":
        """Factory method to create service configured for main window."""
        service = cls()

        # Define main window method delegation configuration
        main_window_methods = [
            MethodInfo("open_settings",
            "src.ui.window_methods", "open_settings", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("init_workers_and_signals",
            "src.ui.window_methods", "init_workers_and_signals", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("init_listener",
            "src.ui.window_methods", "init_listener", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("init_llm_worker",
            "src.ui.window_methods", "init_llm_worker", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("handle_llm_error",
            "src.ui.window_methods", "handle_llm_error", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("handle_transcription",
            "src.ui.window_methods", "handle_transcription", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("display_message",
            "src.ui.window_methods", "display_message", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("create_tray_icon",
            "src.ui.window_methods", "create_tray_icon", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("show_window",
            "src.ui.window_methods", "show_window", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("close_app",
            "src.ui.window_methods", "close_app", MethodType.INSTANCE_METHOD, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("keyPressEvent",
            "src.ui.window_methods", "keyPressEvent", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("keyReleaseEvent",
            "src.ui.window_methods", "keyReleaseEvent", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("eventFilter",
            "src.ui.window_methods", "eventFilter", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("resizeEvent",
            "src.ui.window_methods", "resizeEvent", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("dragEnterEvent",
            "src.ui.window_methods", "dragEnterEvent", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
            MethodInfo("dropEvent",
            "src.ui.window_methods", "dropEvent", MethodType.EVENT_HANDLER, DelegationMode.DIRECT_ASSIGNMENT)
        ]

        config = DelegationConfiguration(
            target_class_name="MainWindow",
            source_module_path="src.ui.window_methods",
            methods=main_window_methods,
            auto_import=True,
            validate_signatures=False,
            allow_overrides=True,
        )

        service.register_delegation_configuration(config)

        return service