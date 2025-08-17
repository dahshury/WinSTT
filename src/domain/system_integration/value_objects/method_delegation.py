"""Domain value objects for method delegation operations.

This module defines domain concepts related to method delegation,
including delegation modes, method types, and delegation configurations.
"""

from dataclasses import dataclass
from enum import Enum


class DelegationMode(Enum):
    """Method delegation modes."""
    DIRECT_ASSIGNMENT = "direct_assignment"
    WRAPPER_FUNCTION = "wrapper_function"
    PROXY_OBJECT = "proxy_object"
    DYNAMIC_IMPORT = "dynamic_import"


class MethodType(Enum):
    """Types of methods that can be delegated."""
    INSTANCE_METHOD = "instance_method"
    CLASS_METHOD = "class_method"
    STATIC_METHOD = "static_method"
    PROPERTY = "property"
    EVENT_HANDLER = "event_handler"
    SIGNAL_SLOT = "signal_slot"


@dataclass
class MethodInfo:
    """Information about a delegated method."""
    name: str
    source_module: str
    source_function: str
    method_type: MethodType
    delegation_mode: DelegationMode
    is_required: bool = True
    description: str | None = None

    def __post_init__(self) -> None:
        if not self.name:
            msg = "Method name cannot be empty"
            raise ValueError(msg)
        if not self.source_module:
            msg = "Source module cannot be empty"
            raise ValueError(msg)
        if not self.source_function:
            msg = "Source function cannot be empty"
            raise ValueError(msg)


@dataclass
class DelegationConfiguration:
    """Configuration for method delegation."""
    target_class_name: str
    source_module_path: str
    methods: list[MethodInfo]
    auto_import: bool = True
    validate_signatures: bool = True
    allow_overrides: bool = False

    def __post_init__(self) -> None:
        if not self.target_class_name:
            msg = "Target class name cannot be empty"
            raise ValueError(msg)
        if not self.source_module_path:
            msg = "Source module path cannot be empty"
            raise ValueError(msg)
        if not self.methods:
            msg = "Methods list cannot be empty"
            raise ValueError(msg,
    )