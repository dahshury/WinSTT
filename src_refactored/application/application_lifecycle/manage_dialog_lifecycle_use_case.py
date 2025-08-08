"""Manage Dialog Lifecycle Use Case.

This module implements the ManageDialogLifecycleUseCase for managing
dialog window lifecycle operations.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

from src_refactored.domain.common import Result, UseCase

if TYPE_CHECKING:
    from collections.abc import Callable


class DialogOperation(Enum):
    """Dialog lifecycle operations."""
    SHOW = "show"
    HIDE = "hide"
    CLOSE = "close"
    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"
    RESTORE = "restore"


class IDialogLifecyclePort(Protocol):
    """Port for dialog lifecycle operations."""
    
    def show_dialog(self, dialog_id: str) -> bool:
        """Show dialog window."""
        ...
    
    def hide_dialog(self, dialog_id: str) -> bool:
        """Hide dialog window."""
        ...
    
    def close_dialog(self, dialog_id: str) -> bool:
        """Close dialog window."""
        ...
    
    def minimize_dialog(self, dialog_id: str) -> bool:
        """Minimize dialog window."""
        ...
    
    def maximize_dialog(self, dialog_id: str) -> bool:
        """Maximize dialog window."""
        ...
    
    def restore_dialog(self, dialog_id: str) -> bool:
        """Restore dialog window."""
        ...
    
    def get_dialog_state(self, dialog_id: str) -> str | None:
        """Get current dialog state."""
        ...


@dataclass
class ManageDialogLifecycleRequest:
    """Request for managing dialog lifecycle."""
    dialog_id: str
    operation: DialogOperation
    context: dict[str, Any] | None = None
    validate_state: bool = True
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[str], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class ManageDialogLifecycleResponse:
    """Response from dialog lifecycle management."""
    success: bool
    dialog_id: str
    operation: DialogOperation
    previous_state: str | None
    new_state: str | None
    message: str = ""


class ManageDialogLifecycleUseCase(UseCase[ManageDialogLifecycleRequest, Result[ManageDialogLifecycleResponse]]):
    """Use case for managing dialog lifecycle operations.
    
    This use case handles:
    - Dialog show/hide operations
    - Dialog window state management
    - Dialog close and cleanup
    - State validation and transitions
    """
    
    def __init__(self, lifecycle_port: IDialogLifecyclePort):
        """Initialize the manage dialog lifecycle use case.
        
        Args:
            lifecycle_port: Port for dialog lifecycle operations
        """
        self._lifecycle_port = lifecycle_port
    
    def execute(self, request: ManageDialogLifecycleRequest) -> Result[ManageDialogLifecycleResponse]:
        """Execute the dialog lifecycle management operation.
        
        Args:
            request: Manage dialog lifecycle request
            
        Returns:
            Result[ManageDialogLifecycleResponse]: Result of the lifecycle operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback(f"Starting {request.operation.value} operation", 0.1)
            
            # Get current state if validation is requested
            previous_state = None
            if request.validate_state:
                previous_state = self._lifecycle_port.get_dialog_state(request.dialog_id)
                
                if request.progress_callback:
                    request.progress_callback("Validating dialog state", 0.3)
                
                # Validate state transition
                validation_result = self._validate_operation(request.operation, previous_state)
                if not validation_result.is_success:
                    return Result.failure(validation_result.error or "Unknown validation error")
            
            # Report progress
            if request.progress_callback:
                request.progress_callback(f"Executing {request.operation.value}", 0.5)
            
            # Execute the operation
            operation_result = self._execute_operation(request.dialog_id, request.operation)
            if not operation_result.is_success:
                error_msg = f"Failed to {request.operation.value} dialog {request.dialog_id}: {operation_result.error or 'Unknown error'}"
                if request.error_callback:
                    request.error_callback(error_msg)
                return Result.failure(error_msg)
            
            # Get new state
            new_state = self._lifecycle_port.get_dialog_state(request.dialog_id)
            
            # Report completion
            if request.progress_callback:
                request.progress_callback(f"Dialog {request.operation.value} completed", 1.0)
            
            message = f"Successfully {request.operation.value}d dialog {request.dialog_id}"
            if request.completion_callback:
                request.completion_callback(message)
            
            response = ManageDialogLifecycleResponse(
                success=True,
                dialog_id=request.dialog_id,
                operation=request.operation,
                previous_state=previous_state,
                new_state=new_state,
                message=message,
            )
            
            return Result.success(response)
            
        except Exception as e:
            error_msg = f"Failed to manage dialog lifecycle: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            
            response = ManageDialogLifecycleResponse(
                success=False,
                dialog_id=request.dialog_id,
                operation=request.operation,
                previous_state=None,
                new_state=None,
                message=error_msg,
            )
            
            return Result.failure(error_msg)
    
    def _validate_operation(self, operation: DialogOperation, current_state: str | None) -> Result[None]:
        """Validate if the operation is allowed in the current state.
        
        Args:
            operation: Operation to validate
            current_state: Current dialog state
            
        Returns:
            Result[None]: Validation result
        """
        # Basic state validation logic
        if current_state is None:
            if operation in [DialogOperation.HIDE, DialogOperation.CLOSE, 
                           DialogOperation.MINIMIZE, DialogOperation.MAXIMIZE, 
                           DialogOperation.RESTORE]:
                return Result.failure(f"Cannot {operation.value} non-existent dialog")
        
        if current_state == "hidden" and operation == DialogOperation.HIDE:
            return Result.failure("Dialog is already hidden")
        
        if current_state == "minimized" and operation == DialogOperation.MINIMIZE:
            return Result.failure("Dialog is already minimized")
        
        if current_state == "maximized" and operation == DialogOperation.MAXIMIZE:
            return Result.failure("Dialog is already maximized")
        
        return Result.success(None)
    
    def _execute_operation(self, dialog_id: str, operation: DialogOperation) -> Result[None]:
        """Execute the specified dialog operation.
        
        Args:
            dialog_id: ID of the dialog to operate on
            operation: Operation to execute
            
        Returns:
            Result[None]: Operation result
        """
        try:
            success = False
            
            if operation == DialogOperation.SHOW:
                success = self._lifecycle_port.show_dialog(dialog_id)
            elif operation == DialogOperation.HIDE:
                success = self._lifecycle_port.hide_dialog(dialog_id)
            elif operation == DialogOperation.CLOSE:
                success = self._lifecycle_port.close_dialog(dialog_id)
            elif operation == DialogOperation.MINIMIZE:
                success = self._lifecycle_port.minimize_dialog(dialog_id)
            elif operation == DialogOperation.MAXIMIZE:
                success = self._lifecycle_port.maximize_dialog(dialog_id)
            elif operation == DialogOperation.RESTORE:
                success = self._lifecycle_port.restore_dialog(dialog_id)
            else:
                return Result.failure(f"Unsupported operation: {operation}")
            
            if success:
                return Result.success(None)
            return Result.failure(f"Operation {operation.value} failed")
                
        except Exception as e:
            return Result.failure(f"Operation execution error: {e!s}")


def create_manage_dialog_lifecycle_use_case(
    lifecycle_port: IDialogLifecyclePort,
) -> ManageDialogLifecycleUseCase:
    """Factory function to create ManageDialogLifecycleUseCase.
    
    Args:
        lifecycle_port: Port for dialog lifecycle operations
        
    Returns:
        ManageDialogLifecycleUseCase: Configured use case instance
    """
    return ManageDialogLifecycleUseCase(lifecycle_port)