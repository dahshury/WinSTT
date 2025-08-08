"""UI coordinator presenter for managing UI state and coordination.

This presenter follows MVP pattern and delegates business logic to application services.
Replaces the previous UICoordinator entity that violated hexagonal architecture.
"""

from dataclasses import dataclass

from src_refactored.application.interfaces.ui_coordination_service import (
    ElementType as AppElementType,
)
from src_refactored.application.interfaces.ui_coordination_service import (
    IUICoordinationService,
)
from src_refactored.domain.common.result import Result
from src_refactored.presentation.ui_coordination.value_objects import (
    AnimationState,
    ElementType,
    InteractionState,
    MessageDisplay,
    UIElementState,
    VisibilityState,
)


@dataclass
class UICoordinatorPresenter:
    """UI coordinator presenter coordinating with application services.
    
    This presenter handles UI presentation concerns and delegates coordination logic
    to application services, following hexagonal architecture principles.
    """

    def __init__(self, coordinator_id: str, coordination_service: IUICoordinationService):
        """Initialize the UI coordinator presenter.
        
        Args:
            coordinator_id: Unique identifier for the coordinator
            coordination_service: Application service for UI coordination operations
        """
        self._coordinator_id = coordinator_id
        self._coordination_service = coordination_service
        
        # Presentation-specific state (not business logic)
        self._local_element_states: dict[ElementType, UIElementState] = {}
        self._local_message_display: MessageDisplay | None = None
        self._initialize_default_presentation_states()

    def _initialize_default_presentation_states(self):
        """Set up initial UI element presentation states."""
        # Initialize all elements as visible and enabled by default
        default_elements = [
            ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS,
            ElementType.INSTRUCTION, ElementType.LABEL, ElementType.BUTTON,
        ]

        for element_type in default_elements:
            self._local_element_states[element_type] = UIElementState.visible_enabled(element_type)

        # Special states for specific elements
        self._local_element_states[ElementType.VISUALIZER] = UIElementState.hidden(ElementType.VISUALIZER)
        self._local_element_states[ElementType.PROGRESS_BAR] = UIElementState.hidden(ElementType.PROGRESS_BAR)
    
    def _convert_to_app_element_type(self, element_type: ElementType) -> AppElementType:
        """Convert presentation ElementType to application ElementType."""
        # Both enums have the same values, so we can convert by value
        return AppElementType(element_type.value)

    def start_recording_mode(self) -> Result[dict[ElementType, AnimationState]]:
        """Start recording mode with coordinated animations through application service."""
        service_result = self._coordination_service.start_recording_mode(self._coordinator_id)
        if not service_result.is_success:
            return Result.failure(service_result.error or "Failed to start recording mode")

        # Update local presentation states for immediate UI feedback
        animations = {}
        
        # Show and fade in visualizer
        self._local_element_states[ElementType.VISUALIZER] = UIElementState.visible_enabled(ElementType.VISUALIZER)
        animations[ElementType.VISUALIZER] = AnimationState.fade_in(duration_ms=500)

        # Dim other elements
        dim_elements = [ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS]
        for element_type in dim_elements:
            self._local_element_states[element_type] = UIElementState.dimmed(element_type, opacity=0.4)
            animations[element_type] = AnimationState.dim(opacity=0.4, duration_ms=500)

        # Hide instruction completely
        self._local_element_states[ElementType.INSTRUCTION] = UIElementState.hidden(ElementType.INSTRUCTION)
        animations[ElementType.INSTRUCTION] = AnimationState.fade_out(duration_ms=500)

        return Result.success(animations)

    def stop_recording_mode(self) -> Result[dict[ElementType, AnimationState]]:
        """Stop recording mode and restore UI elements through application service."""
        service_result = self._coordination_service.stop_recording_mode(self._coordinator_id)
        if not service_result.is_success:
            return Result.failure(service_result.error or "Failed to stop recording mode")

        # Update local presentation states for immediate UI feedback
        animations = {}

        # Hide visualizer
        self._local_element_states[ElementType.VISUALIZER] = UIElementState.hidden(ElementType.VISUALIZER)
        animations[ElementType.VISUALIZER] = AnimationState.fade_out(duration_ms=500)

        # Restore dimmed elements
        restore_elements = [ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS]
        for element_type in restore_elements:
            self._local_element_states[element_type] = UIElementState.visible_enabled(element_type)
            animations[element_type] = AnimationState.restore(from_opacity=0.4, duration_ms=500)

        # Show instruction again
        self._local_element_states[ElementType.INSTRUCTION] = UIElementState.visible_enabled(ElementType.INSTRUCTION)
        animations[ElementType.INSTRUCTION] = AnimationState.fade_in(duration_ms=500)

        return Result.success(animations)

    def start_download_mode(self, filename: str) -> Result[None]:
        """Start download mode through application service."""
        service_result = self._coordination_service.start_download_mode(self._coordinator_id, filename)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        if ElementType.SETTINGS in self._local_element_states:
            current_state = self._local_element_states[ElementType.SETTINGS]
            self._local_element_states[ElementType.SETTINGS] = UIElementState(
                element_type=ElementType.SETTINGS,
                visibility=current_state.visibility,
                interaction=InteractionState.DISABLED,
                opacity=current_state.opacity,
            )

        # Hide instruction during download
        self._hide_instruction_during_process()
        return Result.success(None)

    def update_download_progress(self, filename: str, percentage: int) -> Result[None]:
        """Update download progress through application service."""
        service_result = self._coordination_service.update_download_progress(self._coordinator_id, filename, percentage)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        self._local_element_states[ElementType.PROGRESS_BAR] = UIElementState.progress_bar(percentage, visible=True)
        return Result.success(None)

    def complete_download_mode(self) -> Result[None]:
        """Complete download mode through application service."""
        service_result = self._coordination_service.complete_download_mode(self._coordinator_id)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        if ElementType.SETTINGS in self._local_element_states:
            current_state = self._local_element_states[ElementType.SETTINGS]
            self._local_element_states[ElementType.SETTINGS] = UIElementState(
                element_type=ElementType.SETTINGS,
                visibility=current_state.visibility,
                interaction=InteractionState.ENABLED,
                opacity=current_state.opacity,
            )

        # Hide progress bar and show instruction again
        self._local_element_states[ElementType.PROGRESS_BAR] = UIElementState.hidden(ElementType.PROGRESS_BAR)
        self._show_instruction_after_process()
        return Result.success(None)

    def start_transcription_mode(self, hold_message: bool = True) -> Result[None]:
        """Start transcription mode through application service."""
        return self._coordination_service.start_transcription_mode(self._coordinator_id, hold_message)

    def update_transcription_progress(self, percentage: int) -> Result[None]:
        """Update transcription progress through application service."""
        service_result = self._coordination_service.update_transcription_progress(self._coordinator_id, percentage)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        self._local_element_states[ElementType.PROGRESS_BAR] = UIElementState.progress_bar(percentage, visible=True)
        return Result.success(None)

    def complete_transcription_mode(self, success_message: str | None = None) -> Result[None]:
        """Complete transcription mode through application service."""
        service_result = self._coordination_service.complete_transcription_mode(self._coordinator_id, success_message)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        self._local_element_states[ElementType.PROGRESS_BAR] = UIElementState.hidden(ElementType.PROGRESS_BAR)
        return Result.success(None)

    def display_message(self, message: MessageDisplay) -> Result[None]:
        """Display a message through application service."""
        message_text = message.get_display_text() if hasattr(message, "get_display_text") else str(message)
        priority = message.priority.value if hasattr(message, "priority") else "normal"
        
        service_result = self._coordination_service.display_message(self._coordinator_id, message_text, priority)
        if service_result.is_success:
            self._local_message_display = message
        return service_result

    def clear_current_message(self) -> Result[str | None]:
        """Clear current message through application service."""
        service_result = self._coordination_service.clear_current_message(self._coordinator_id)
        if service_result.is_success:
            self._local_message_display = None
        return service_result

    def update_instruction_text(self, key_combination: str) -> Result[None]:
        """Update instruction text through application service."""
        service_result = self._coordination_service.update_instruction_text(self._coordinator_id, key_combination)
        if not service_result.is_success:
            return service_result

        # Update local presentation state
        instruction_message = MessageDisplay.instruction(
            "Hold {key} to record or drag & drop to transcribe",
            key_combination,
        )

        self._local_element_states[ElementType.INSTRUCTION] = UIElementState.visible_enabled(
            ElementType.INSTRUCTION,
            text=instruction_message.get_display_text(),
        )
        return Result.success(None)

    def get_element_state(self, element_type: ElementType) -> Result[UIElementState | None]:
        """Get current state of a UI element from application service."""
        app_element_type = self._convert_to_app_element_type(element_type)
        service_result = self._coordination_service.get_element_state(self._coordinator_id, app_element_type)
        if not service_result.is_success:
            return Result.failure(service_result.error or "Failed to get element state")

        # Return local presentation state as fallback
        local_state = self._local_element_states.get(element_type)
        return Result.success(local_state)

    def get_current_ui_mode(self) -> Result[str]:
        """Get description of current UI mode from application service."""
        return self._coordination_service.get_current_ui_mode(self._coordinator_id)

    def reset_to_idle_state(self) -> Result[None]:
        """Reset UI to idle state through application service."""
        service_result = self._coordination_service.reset_to_idle_state(self._coordinator_id)
        if not service_result.is_success:
            return service_result

        # Reset local presentation state
        self._local_message_display = None
        self._initialize_default_presentation_states()
        return Result.success(None)

    def _hide_instruction_during_process(self) -> None:
        """Hide instruction text during processes like download."""
        if ElementType.INSTRUCTION in self._local_element_states:
            self._local_element_states[ElementType.INSTRUCTION] = UIElementState(
                element_type=ElementType.INSTRUCTION,
                visibility=VisibilityState.HIDDEN,
                interaction=InteractionState.DISABLED,
                opacity=0.0,
                text="",
            )

    def _show_instruction_after_process(self) -> None:
        """Show instruction text after processes complete."""
        if ElementType.INSTRUCTION in self._local_element_states:
            current_state = self._local_element_states[ElementType.INSTRUCTION]
            self._local_element_states[ElementType.INSTRUCTION] = UIElementState(
                element_type=ElementType.INSTRUCTION,
                visibility=VisibilityState.VISIBLE,
                interaction=InteractionState.ENABLED,
                opacity=1.0,
                text=current_state.text or "Hold key to record or drag & drop to transcribe",
            )

    # Presentation-specific properties
    @property
    def coordinator_id(self) -> str:
        """Get coordinator identifier."""
        return self._coordinator_id

    @property
    def local_element_states(self) -> dict[ElementType, UIElementState]:
        """Get local element states for immediate UI feedback."""
        return self._local_element_states.copy()

    @property
    def current_message_display(self) -> MessageDisplay | None:
        """Get current message display state."""
        return self._local_message_display


# Backward compatibility alias - will be removed after full migration
UICoordinator = UICoordinatorPresenter