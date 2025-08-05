"""UI coordinator entity for managing UI state and coordination."""

from dataclasses import dataclass, field

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.ui_coordination.value_objects import (
    AnimationState,
    ElementType,
    InteractionState,
    MessageDisplay,
    MessagePriority,
    UIElementState,
    VisibilityState,
)


@dataclass
class UICoordinator(Entity):
    """Coordinates UI state, animations, and message display."""

    # UI element states
    element_states: dict[ElementType, UIElementState] = field(default_factory=dict)

    # Active animations
    active_animations: dict[ElementType, AnimationState] = field(default_factory=dict)

    # Message queue and current message
    message_queue: list[MessageDisplay] = field(default_factory=list)
    current_message: MessageDisplay | None = None

    # UI mode tracking
    is_recording: bool = False
    is_downloading: bool = False
    is_transcribing: bool = False
    is_in_batch_mode: bool = False

    # Animation groups for coordinated transitions
    recording_elements: set[ElementType] = field(default_factory=lambda: {
        ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS,
        ElementType.INSTRUCTION, ElementType.VISUALIZER,
    })

    def __post_init__(self):
        """Initialize default UI states."""
        super().__post_init__()
        self._initialize_default_states()

    def _initialize_default_states(self):
        """Set up initial UI element states."""
        # Initialize all elements as visible and enabled by default
        default_elements = [
            ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS,
            ElementType.INSTRUCTION, ElementType.LABEL, ElementType.BUTTON,
        ]

        for element_type in default_elements:
            self.element_states[element_type] = UIElementState.visible_enabled(element_type)

        # Special states for specific elements
        self.element_states[ElementType.VISUALIZER] = UIElementState.hidden(ElementType.VISUALIZER)
self.element_states[ElementType.PROGRESS_BAR] = (
    UIElementState.hidden(ElementType.PROGRESS_BAR))

    def start_recording_mode(self) -> dict[ElementType, AnimationState]:
        """Start recording mode with coordinated animations."""
        if self.is_recording:
            return {}

        self.is_recording = True
        animations = {}

        # Show and fade in visualizer
self.element_states[ElementType.VISUALIZER] = (
    UIElementState.visible_enabled(ElementType.VISUALIZER))
        animations[ElementType.VISUALIZER] = AnimationState.fade_in(duration_ms=500)

        # Dim other elements
        dim_elements = [ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS]
        for element_type in dim_elements:
            self.element_states[element_type] = UIElementState.dimmed(element_type, opacity=0.4)
            animations[element_type] = AnimationState.dim(opacity=0.4, duration_ms=500)

        # Hide instruction completely
self.element_states[ElementType.INSTRUCTION] = (
    UIElementState.hidden(ElementType.INSTRUCTION))
        animations[ElementType.INSTRUCTION] = AnimationState.fade_out(duration_ms=500)

        # Store active animations
        self.active_animations.update(animations)

        return animations

    def stop_recording_mode(self) -> dict[ElementType, AnimationState]:
        """Stop recording mode and restore UI elements."""
        if not self.is_recording:
            return {}

        self.is_recording = False
        animations = {}

        # Hide visualizer
        self.element_states[ElementType.VISUALIZER] = UIElementState.hidden(ElementType.VISUALIZER)
        animations[ElementType.VISUALIZER] = AnimationState.fade_out(duration_ms=500)

        # Restore dimmed elements
        restore_elements = [ElementType.LOGO, ElementType.TITLE, ElementType.SETTINGS]
        for element_type in restore_elements:
            self.element_states[element_type] = UIElementState.visible_enabled(element_type)
            animations[element_type] = AnimationState.restore(from_opacity=0.4, duration_ms=500)

        # Show instruction again
self.element_states[ElementType.INSTRUCTION] = (
    UIElementState.visible_enabled(ElementType.INSTRUCTION))
        animations[ElementType.INSTRUCTION] = AnimationState.fade_in(duration_ms=500)

        # Store active animations
        self.active_animations.update(animations)

        return animations

    def start_download_mode(self, filename: str,
    ) -> None:
        """Start download mode and disable settings."""
        self.is_downloading = True

        # Disable settings button
        if ElementType.SETTINGS in self.element_states:
            current_state = self.element_states[ElementType.SETTINGS]
            self.element_states[ElementType.SETTINGS] = UIElementState(
                element_type=ElementType.SETTINGS,
                visibility=current_state.visibility,
                interaction=InteractionState.DISABLED,
                opacity=current_state.opacity,
            )

        # Show download message
        download_message = MessageDisplay.download_progress(filename, 0)
        self.display_message(download_message)

        # Hide instruction during download
        self._hide_instruction_during_process()

    def update_download_progress(self, filename: str, percentage: int,
    ) -> None:
        """Update download progress."""
        if not self.is_downloading:
            return

        # Update progress bar
self.element_states[ElementType.PROGRESS_BAR] = (
    UIElementState.progress_bar(percentage, visible=True))

        # Update message
        download_message = MessageDisplay.download_progress(filename, percentage)
        self.current_message = download_message

        # Complete download if at 100%
        if percentage >= 100:
            self.complete_download_mode()

    def complete_download_mode(self) -> None:
        """Complete download mode and restore UI."""
        if not self.is_downloading:
            return

        self.is_downloading = False

        # Re-enable settings button
        if ElementType.SETTINGS in self.element_states:
            current_state = self.element_states[ElementType.SETTINGS]
            self.element_states[ElementType.SETTINGS] = UIElementState(
                element_type=ElementType.SETTINGS,
                visibility=current_state.visibility,
                interaction=InteractionState.ENABLED,
                opacity=current_state.opacity,
            )

        # Hide progress bar
self.element_states[ElementType.PROGRESS_BAR] = (
    UIElementState.hidden(ElementType.PROGRESS_BAR))

        # Clear current message
        self.current_message = None

        # Show instruction again
        self._show_instruction_after_process()

    def start_transcription_mode(self, hold_message: bool = True,
    ) -> None:
        """Start transcription mode."""
        self.is_transcribing = True

        # Show transcription message
        transcription_message = MessageDisplay.transcription_progress(0, hold=hold_message)
        self.display_message(transcription_message)

    def update_transcription_progress(self, percentage: int,
    ) -> None:
        """Update transcription progress."""
        if not self.is_transcribing:
            return

        # Update progress bar
self.element_states[ElementType.PROGRESS_BAR] = (
    UIElementState.progress_bar(percentage, visible=True))

        # Update message if we have one
        if self.current_message and self.current_message.is_progress_message():
            self.current_message = self.current_message.with_progress(percentage)

    def complete_transcription_mode(self, success_message: str | None = None) -> None:
        """Complete transcription mode."""
        if not self.is_transcribing:
            return

        self.is_transcribing = False

        # Show success message if provided
        if success_message:
            success_msg = MessageDisplay.success(success_message)
            self.display_message(success_msg)

        # Hide progress bar after delay if not in batch mode
        if not self.is_in_batch_mode:
self.element_states[ElementType.PROGRESS_BAR] = (
    UIElementState.hidden(ElementType.PROGRESS_BAR,)
    )
            self.current_message = None

    def display_message(self, message: MessageDisplay,
    ) -> None:
        """Display a message, handling priority and queue."""
        # Handle high priority messages immediately
        if message.priority in [MessagePriority.HIGH, MessagePriority.CRITICAL]:
            self.current_message = message
            return

        # Queue normal priority messages
        if self.current_message is None:
            self.current_message = message
        else:
            self.message_queue.append(message)

    def clear_current_message(self) -> MessageDisplay | None:
        """Clear current message and show next in queue."""
        cleared_message = self.current_message
        self.current_message = None

        # Show next message in queue
        if self.message_queue:
            self.current_message = self.message_queue.pop(0)

        return cleared_message

    def update_instruction_text(self, key_combination: str,
    ) -> None:
        """Update instruction text with current key combination."""
        if self.is_downloading:
            return  # Don't show instruction during download

        instruction_message = MessageDisplay.instruction(
            "Hold {key} to record or drag & drop to transcribe",
            key_combination,
        )

        # Update instruction element state
        self.element_states[ElementType.INSTRUCTION] = UIElementState.visible_enabled(
            ElementType.INSTRUCTION,
            text=instruction_message.get_display_text()
        )

    def _hide_instruction_during_process(self) -> None:
        """Hide instruction text during processes like download."""
        if ElementType.INSTRUCTION in self.element_states:
            self.element_states[ElementType.INSTRUCTION] = UIElementState(
                element_type=ElementType.INSTRUCTION,
                visibility=VisibilityState.HIDDEN,
                interaction=InteractionState.DISABLED,
                opacity=0.0,
                text="",
            )

    def _show_instruction_after_process(self) -> None:
        """Show instruction text after processes complete."""
        if ElementType.INSTRUCTION in self.element_states:
            current_state = self.element_states[ElementType.INSTRUCTION]
            self.element_states[ElementType.INSTRUCTION] = UIElementState(
                element_type=ElementType.INSTRUCTION,
                visibility=VisibilityState.VISIBLE,
                interaction=InteractionState.ENABLED,
                opacity=1.0,
                text=current_state.text or "Hold key to record or drag & drop to transcribe",
            )

    def get_element_state(self, element_type: ElementType,
    ) -> UIElementState | None:
        """Get current state of a UI element."""
        return self.element_states.get(element_type)

    def get_active_animation(self, element_type: ElementType,
    ) -> AnimationState | None:
        """Get active animation for an element."""
        return self.active_animations.get(element_type)

    def complete_animation(self, element_type: ElementType,
    ) -> None:
        """Mark an animation as complete."""
        self.active_animations.pop(element_type, None)

    def is_element_animating(self, element_type: ElementType,
    ) -> bool:
        """Check if an element is currently animating."""
        return element_type in self.active_animations

    def get_current_ui_mode(self) -> str:
        """Get a description of the current UI mode."""
        if self.is_recording:
            return "recording"
        if self.is_downloading:
            return "downloading"
        if self.is_transcribing:
            return "transcribing"
        if self.is_in_batch_mode:
            return "batch_processing"
        return "idle"

    def reset_to_idle_state(self) -> None:
        """Reset UI to idle state."""
        self.is_recording = False
        self.is_downloading = False
        self.is_transcribing = False
        self.is_in_batch_mode = False

        self.current_message = None
        self.message_queue.clear()
        self.active_animations.clear()

        # Reset to default states
        self._initialize_default_states()