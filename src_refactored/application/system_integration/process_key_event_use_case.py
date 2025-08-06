"""Process Key Event Use Case.

This module implements the ProcessKeyEventUseCase for handling keyboard
events in the system integration layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.ui_coordination.value_objects.key_event_data import (
        KeyEventData,
    )


class IKeyEventProcessingPort(Protocol):
    """Port for key event processing operations."""
    
    def process_key_combination(self, key_combination: str) -> bool:
        """Process key combination."""
        ...
    
    def validate_key_sequence(self, key_sequence: str) -> bool:
        """Validate key sequence."""
        ...
    
    def execute_key_action(self, action_name: str, context: dict) -> bool:
        """Execute action associated with key event."""
        ...


@dataclass
class ProcessKeyEventRequest:
    """Request for processing key events."""
    event_data: KeyEventData
    context: dict | None = None
    action_mapping: dict[str, str] | None = None
    modifier_keys: list[str] | None = None
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[str], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class ProcessKeyEventResponse:
    """Response from key event processing."""
    success: bool
    action_executed: str
    key_combination: str
    handled: bool
    message: str = ""


class ProcessKeyEventUseCase:
    """Use case for processing keyboard events.
    
    This use case handles:
    - Key combination validation
    - Action mapping and execution
    - Modifier key processing
    - Context-aware key handling
    """
    
    def __init__(self, processing_port: IKeyEventProcessingPort):
        """Initialize the process key event use case.
        
        Args:
            processing_port: Port for key event processing operations
        """
        self._processing_port = processing_port
    
    def execute(self, request: ProcessKeyEventRequest) -> ProcessKeyEventResponse:
        """Execute the key event processing operation.
        
        Args:
            request: Process key event request
            
        Returns:
            ProcessKeyEventResponse: Result of the processing operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback("Processing key event", 0.1)
            
            # Extract key combination from event data
            key_combination = self._extract_key_combination(request.event_data)
            
            if not key_combination:
                return ProcessKeyEventResponse(
                    success=False,
                    action_executed="",
                    key_combination="",
                    handled=False,
                    message="No valid key combination found",
                )
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Validating key sequence", 0.3)
            
            # Validate key sequence
            if not self._processing_port.validate_key_sequence(key_combination):
                return ProcessKeyEventResponse(
                    success=False,
                    action_executed="",
                    key_combination=key_combination,
                    handled=False,
                    message=f"Invalid key sequence: {key_combination}",
                )
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Processing key combination", 0.5)
            
            # Process key combination
            if not self._processing_port.process_key_combination(key_combination):
                return ProcessKeyEventResponse(
                    success=False,
                    action_executed="",
                    key_combination=key_combination,
                    handled=False,
                    message=f"Failed to process key combination: {key_combination}",
                )
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Executing mapped action", 0.7)
            
            # Determine action to execute
            action_name = self._determine_action(key_combination, request.action_mapping)
            
            if not action_name:
                return ProcessKeyEventResponse(
                    success=True,
                    action_executed="",
                    key_combination=key_combination,
                    handled=True,
                    message=f"Key combination processed but no action mapped: {key_combination}",
                )
            
            # Execute the mapped action
            context = request.context or {}
            action_success = self._processing_port.execute_key_action(action_name, context)
            
            # Report completion
            if request.progress_callback:
                request.progress_callback("Key event processing completed", 1.0)
            
            if request.completion_callback:
                request.completion_callback(action_name)
            
            message = f"Successfully executed action '{action_name}' for key combination '{key_combination}'"
            if not action_success:
                message = f"Key combination processed but action '{action_name}' failed"
            
            return ProcessKeyEventResponse(
                success=action_success,
                action_executed=action_name,
                key_combination=key_combination,
                handled=True,
                message=message,
            )
            
        except Exception as e:
            error_msg = f"Failed to process key event: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            return ProcessKeyEventResponse(
                success=False,
                action_executed="",
                key_combination="",
                handled=False,
                message=error_msg,
            )
    
    def _extract_key_combination(self, event_data: KeyEventData) -> str:
        """Extract key combination from key event data.
        
        Args:
            event_data: Key event data
            
        Returns:
            str: Key combination string
        """
        # This would depend on the actual KeyEventData implementation
        # For now, return empty string as placeholder
        return ""
    
    def _determine_action(self, key_combination: str, action_mapping: dict[str, str] | None) -> str:
        """Determine action to execute based on key combination.
        
        Args:
            key_combination: The key combination that was pressed
            action_mapping: Optional mapping of key combinations to actions
            
        Returns:
            str: Action name to execute, or empty string if no action mapped
        """
        if not action_mapping:
            return ""
        
        return action_mapping.get(key_combination, "")
    
    def _normalize_key_combination(self, key_combination: str) -> str:
        """Normalize key combination for consistent matching.
        
        Args:
            key_combination: Raw key combination string
            
        Returns:
            str: Normalized key combination
        """
        # Convert to lowercase and sort modifier keys for consistency
        parts = key_combination.lower().split("+")
        if len(parts) > 1:
            modifiers = sorted(parts[:-1])
            key = parts[-1]
            return "+".join([*modifiers, key])
        return key_combination.lower()


def create_process_key_event_use_case(
    processing_port: IKeyEventProcessingPort,
) -> ProcessKeyEventUseCase:
    """Factory function to create ProcessKeyEventUseCase.
    
    Args:
        processing_port: Port for key event processing operations
        
    Returns:
        ProcessKeyEventUseCase: Configured use case instance
    """
    return ProcessKeyEventUseCase(processing_port)