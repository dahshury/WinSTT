"""UI State Management Service for element enable/disable with visual feedback.

This service provides centralized UI state management functionality with opacity effects,
extracted from settings_dialog.py (lines 1320-1361).
"""

from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QWidget

from src.domain.ui_coordination.value_objects.ui_state_management import (
    OpacityLevel,
    UIState,
)


class UIStateManagementService(QObject):
    """Service for managing UI element states with visual feedback.
    
    Extracted from settings_dialog.py UI state management patterns.
    """

    # Signals for state changes
    state_changed = pyqtSignal(str, str)  # element_group, new_state
    elements_enabled = pyqtSignal(str, bool)  # element_group, enabled
    opacity_changed = pyqtSignal(str, float)  # element_group, opacity

    def __init__(self):
        """Initialize the UI state management service."""
        super().__init__()
        self.element_groups: dict[str, list[QWidget]] = {}
        self.group_states: dict[str, UIState] = {}
        self.opacity_effects: dict[QWidget, QGraphicsOpacityEffect] = {}
        self.state_configurations: dict[UIState, dict[str, Any]] = {
            UIState.ENABLED: {
                "enabled": True,
                "opacity": OpacityLevel.FULLY_VISIBLE.value,
            },
            UIState.DISABLED: {
                "enabled": False,
                "opacity": OpacityLevel.DISABLED.value,
            },
            UIState.LOADING: {
                "enabled": False,
                "opacity": OpacityLevel.SEMI_TRANSPARENT.value,
            },
            UIState.ERROR: {
                "enabled": False,
                "opacity": OpacityLevel.BARELY_VISIBLE.value,
            },
            UIState.SUCCESS: {
                "enabled": True,
                "opacity": OpacityLevel.FULLY_VISIBLE.value,
            },
        }

    def register_element_group(self, group_name: str, elements: list[QWidget]) -> None:
        """Register a group of UI elements for state management.
        
        Args:
            group_name: Unique identifier for the element group
            elements: List of widgets to manage together
        """
        # Filter out None elements for safety
        valid_elements = [element for element in elements if element is not None]
        self.element_groups[group_name] = valid_elements
        self.group_states[group_name] = UIState.ENABLED

        # Initialize opacity effects for elements that need them
        for element in valid_elements:
            self._ensure_opacity_effect(element)

    def add_element_to_group(self, group_name: str, element: QWidget,
    ) -> bool:
        """Add a single element to an existing group.
        
        Args:
            group_name: Name of the existing group
            element: Widget to add to the group
            
        Returns:
            True if element was added, False if group doesn't exist or element is None
        """
        if group_name not in self.element_groups or element is None:
            return False

        if element not in self.element_groups[group_name]:
            self.element_groups[group_name].append(element)
            self._ensure_opacity_effect(element)

            # Apply current group state to new element
            current_state = self.group_states[group_name]
            self._apply_state_to_element(element, current_state)

        return True

    def remove_element_from_group(self, group_name: str, element: QWidget,
    ) -> bool:
        """Remove an element from a group.
        
        Args:
            group_name: Name of the group
            element: Widget to remove from the group
            
        Returns:
            True if element was removed, False if group doesn't exist or element not found
        """
        if group_name not in self.element_groups:
            return False

        if element in self.element_groups[group_name]:
            self.element_groups[group_name].remove(element)

            # Clean up opacity effect
            if element in self.opacity_effects:
                del self.opacity_effects[element]

            return True

        return False

    def set_group_state(self, group_name: str, state: UIState,
    ) -> bool:
        """Set the state for an entire group of elements.
        
        Args:
            group_name: Name of the element group
            state: New state to apply
            
        Returns:
            True if state was applied, False if group doesn't exist
        """
        if group_name not in self.element_groups:
            return False

        self.group_states[group_name] = state

        # Apply state to all elements in the group
        for element in self.element_groups[group_name]:
            self._apply_state_to_element(element, state)

        # Emit signals
        config = self.state_configurations[state]
        self.state_changed.emit(group_name, state.value)
        self.elements_enabled.emit(group_name, config["enabled"])
        self.opacity_changed.emit(group_name, config["opacity"])

        return True

    def set_group_enabled(self, group_name: str, enabled: bool,
    ) -> bool:
        """Enable or disable a group of elements with visual feedback.
        
        Args:
            group_name: Name of the element group
            enabled: Whether to enable or disable the elements
            
        Returns:
            True if state was applied, False if group doesn't exist
        """
        state = UIState.ENABLED if enabled else UIState.DISABLED
        return self.set_group_state(group_name, state)

    def set_group_opacity(self, group_name: str, opacity: float,
    ) -> bool:
        """Set custom opacity for a group of elements.
        
        Args:
            group_name: Name of the element group
            opacity: Opacity value (0.0 to 1.0)
            
        Returns:
            True if opacity was applied, False if group doesn't exist
        """
        if group_name not in self.element_groups:
            return False

        # Clamp opacity to valid range
        opacity = max(0.0, min(1.0, opacity))

        # Apply opacity to all elements in the group
        for element in self.element_groups[group_name]:
            self._set_element_opacity(element, opacity)

        self.opacity_changed.emit(group_name, opacity)
        return True

    def get_group_state(self, group_name: str,
    ) -> UIState | None:
        """Get the current state of an element group.
        
        Args:
            group_name: Name of the element group
            
        Returns:
            Current state or None if group doesn't exist
        """
        return self.group_states.get(group_name)

    def is_group_enabled(self, group_name: str,
    ) -> bool | None:
        """Check if a group is currently enabled.
        
        Args:
            group_name: Name of the element group
            
        Returns:
            True if enabled, False if disabled, None if group doesn't exist
        """
        state = self.get_group_state(group_name)
        if state is None:
            return None

        config = self.state_configurations[state]
        return config["enabled"]

    def get_group_elements(self, group_name: str,
    ) -> list[QWidget] | None:
        """Get the list of elements in a group.
        
        Args:
            group_name: Name of the element group
            
        Returns:
            List of widgets or None if group doesn't exist
        """
        return self.element_groups.get(group_name)

    def get_all_group_names(self) -> list[str]:
        """Get names of all registered element groups.
        
        Returns:
            List of group names
        """
        return list(self.element_groups.keys())

    def configure_state(self, state: UIState, enabled: bool, opacity: float,
    ) -> None:
        """Configure the properties for a specific UI state.
        
        Args:
            state: UI state to configure
            enabled: Whether elements should be enabled in this state
            opacity: Opacity level for this state (0.0 to 1.0)
        """
        opacity = max(0.0, min(1.0, opacity))  # Clamp to valid range

        self.state_configurations[state] = {
            "enabled": enabled,
            "opacity": opacity,
        }

    def apply_loading_state(self, group_name: str,
    ) -> bool:
        """Apply loading state to a group (disabled with semi-transparent opacity).
        
        Args:
            group_name: Name of the element group
            
        Returns:
            True if state was applied, False if group doesn't exist
        """
        return self.set_group_state(group_name, UIState.LOADING)

    def apply_error_state(self, group_name: str,
    ) -> bool:
        """Apply error state to a group (disabled with low opacity).
        
        Args:
            group_name: Name of the element group
            
        Returns:
            True if state was applied, False if group doesn't exist
        """
        return self.set_group_state(group_name, UIState.ERROR)

    def apply_success_state(self, group_name: str,
    ) -> bool:
        """Apply success state to a group (enabled with full opacity).
        
        Args:
            group_name: Name of the element group
            
        Returns:
            True if state was applied, False if group doesn't exist
        """
        return self.set_group_state(group_name, UIState.SUCCESS)

    def reset_group_to_default(self, group_name: str,
    ) -> bool:
        """Reset a group to default enabled state.
        
        Args:
            group_name: Name of the element group
            
        Returns:
            True if state was reset, False if group doesn't exist
        """
        return self.set_group_state(group_name, UIState.ENABLED)

    def _ensure_opacity_effect(self, element: QWidget,
    ) -> None:
        """Ensure an element has an opacity effect for visual feedback.
        
        Args:
            element: Widget to ensure has opacity effect
        """
        if element not in self.opacity_effects:
            if hasattr(element, "setOpacity"):
                # Element has built-in opacity support
                # Store a sentinel to indicate built-in support without effect
                self.opacity_effects[element] = None  # type: ignore[assignment]
            else:
                # Create graphics opacity effect
                effect = QGraphicsOpacityEffect(element)
                element.setGraphicsEffect(effect)
                self.opacity_effects[element] = effect

    def _set_element_opacity(self, element: QWidget, opacity: float,
    ) -> None:
        """Set opacity for a single element.
        
        Args:
            element: Widget to set opacity for
            opacity: Opacity value (0.0 to 1.0)
        """
        set_opacity_method = getattr(element, "setOpacity", None)
        if set_opacity_method and callable(set_opacity_method):
            # Use built-in opacity
            set_opacity_method(opacity)
        elif element in self.opacity_effects and self.opacity_effects[element] is not None:
            # Use graphics effect
            self.opacity_effects[element].setOpacity(opacity)

    def _apply_state_to_element(self, element: QWidget, state: UIState,
    ) -> None:
        """Apply a state configuration to a single element.
        
        Args:
            element: Widget to apply state to
            state: State to apply
        """
        config = self.state_configurations[state]

        # Set enabled state
        element.setEnabled(config["enabled"])

        # Set opacity
        self._set_element_opacity(element, config["opacity"])

    def cleanup_group(self, group_name: str,
    ) -> bool:
        """Clean up a group and its resources.
        
        Args:
            group_name: Name of the group to clean up
            
        Returns:
            True if group was cleaned up, False if group doesn't exist
        """
        if group_name not in self.element_groups:
            return False

        # Clean up opacity effects for elements in this group
        for element in self.element_groups[group_name]:
            if element in self.opacity_effects:
                del self.opacity_effects[element]

        # Remove group
        del self.element_groups[group_name]
        del self.group_states[group_name]

        return True

    def cleanup_all(self) -> None:
        """Clean up all groups and resources."""
        self.element_groups.clear()
        self.group_states.clear()
        self.opacity_effects.clear()

    def create_settings_ui_group(self, model_combo, quant_combo, sound_toggle, srt_toggle,
                                rec_key_edit, change_rec_key_btn, browse_btn, enable_llm_toggle,
                                reset_buttons: list[QWidget] | None = None) -> str:
        """Create a UI group for settings elements (extracted from settings_dialog.py).
        
        Args:
            model_combo: Model selection combo box
            quant_combo: Quantization combo box
            sound_toggle: Sound toggle widget
            srt_toggle: SRT toggle widget
            rec_key_edit: Recording key edit widget
            change_rec_key_btn: Change recording key button
            browse_btn: Browse button
            enable_llm_toggle: LLM toggle widget
            reset_buttons: Optional list of reset buttons
            
        Returns:
            Name of the created group
        """
        group_name = "settings_ui_elements"

        # Collect all UI elements
        ui_elements = [
            model_combo,
            quant_combo,
            sound_toggle,
            srt_toggle,
            rec_key_edit,
            change_rec_key_btn,
            browse_btn,
            enable_llm_toggle,
        ]

        # Add reset buttons if provided
        if reset_buttons:
            ui_elements.extend(reset_buttons)

        # Register the group
        self.register_element_group(group_name, ui_elements)

        return group_name