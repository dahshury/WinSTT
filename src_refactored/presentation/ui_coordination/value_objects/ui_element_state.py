"""UI element state value object for UI coordination."""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject
from src_refactored.presentation.ui_coordination.value_objects.element_type import (
    ElementType,
    InteractionState,
    VisibilityState,
)


@dataclass(frozen=True)
class UIElementState(ValueObject):
    """Represents the state of a UI element."""

    element_type: ElementType
    visibility: VisibilityState
    interaction: InteractionState
    opacity: float = 1.0
    text: str | None = None
    progress_value: int | None = None
    is_animated: bool = False

    def __post_init__(self):
        """Validate UI element state."""
        if not (0.0 <= self.opacity <= 1.0):
            msg = "Opacity must be between 0.0 and 1.0"
            raise ValueError(msg)

        if self.progress_value is not None:
            if not (0 <= self.progress_value <= 100):
                msg = "Progress value must be between 0 and 100"
                raise ValueError(msg)
            if self.element_type != ElementType.PROGRESS_BAR:
                msg = "Progress value only valid for progress bars"
                raise ValueError(msg,
    )

    @classmethod
    def visible_enabled(
    cls,
    element_type: ElementType,
    text: str | None = None) -> "UIElementState":
        """Create a visible and enabled element state."""
        return cls(
            element_type=element_type,
            visibility=VisibilityState.VISIBLE,
            interaction=InteractionState.ENABLED,
            text=text,
        )

    @classmethod
    def hidden(cls, element_type: ElementType,
    ) -> "UIElementState":
        """Create a hidden element state."""
        return cls(
            element_type=element_type,
            visibility=VisibilityState.HIDDEN,
            interaction=InteractionState.DISABLED,
            opacity=0.0,
        )

    @classmethod
    def dimmed(cls, element_type: ElementType, opacity: float = 0.4,
    ) -> "UIElementState":
        """Create a dimmed element state."""
        return cls(
            element_type=element_type,
            visibility=VisibilityState.DIMMED,
            interaction=InteractionState.DISABLED,
            opacity=opacity,
        )

    @classmethod
    def loading(cls, element_type: ElementType, text: str | None = None) -> "UIElementState":
        """Create a loading element state."""
        return cls(
            element_type=element_type,
            visibility=VisibilityState.VISIBLE,
            interaction=InteractionState.LOADING,
            text=text,
        )

    @classmethod
    def progress_bar(cls, value: int, visible: bool = True,
    ) -> "UIElementState":
        """Create a progress bar state."""
        return cls(
            element_type=ElementType.PROGRESS_BAR,
            visibility=VisibilityState.VISIBLE if visible else VisibilityState.HIDDEN,
            interaction=InteractionState.DISABLED,
            progress_value=value,
            opacity=1.0,
        )

    def with_text(self, text: str,
    ) -> "UIElementState":
        """Create a new state with updated text."""
        return UIElementState(
            element_type=self.element_type,
            visibility=self.visibility,
            interaction=self.interaction,
            opacity=self.opacity,
            text=text,
            progress_value=self.progress_value,
            is_animated=self.is_animated,
        )

    def with_opacity(self, opacity: float,
    ) -> "UIElementState":
        """Create a new state with updated opacity."""
        return UIElementState(
            element_type=self.element_type,
            visibility=self.visibility,
            interaction=self.interaction,
            opacity=opacity,
            text=self.text,
            progress_value=self.progress_value,
            is_animated=self.is_animated,
        )

    def with_progress(self, value: int,
    ) -> "UIElementState":
        """Create a new state with updated progress value."""
        if self.element_type != ElementType.PROGRESS_BAR:
            msg = "Progress value only valid for progress bars"
            raise ValueError(msg,
    )

        return UIElementState(
            element_type=self.element_type,
            visibility=self.visibility,
            interaction=self.interaction,
            opacity=self.opacity,
            text=self.text,
            progress_value=value,
            is_animated=self.is_animated,
        )

    def is_visible(self) -> bool:
        """Check if element is visible."""
        return self.visibility in [VisibilityState.VISIBLE, VisibilityState.DIMMED]

    def is_interactive(self) -> bool:
        """Check if element can be interacted with."""
        return self.interaction == InteractionState.ENABLED

    def is_in_transition(self) -> bool:
        """Check if element is in a transition state."""
        return self.visibility in [VisibilityState.FADING_IN, VisibilityState.FADING_OUT] or self.is_animated