"""UI Layout Value Objects for presentation layer.

Moved from domain layer to presentation layer as this is UI-specific presentation logic.
This module defines value objects for UI layout setup including
results, phases, component roles, and layout configuration.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class SetupResult(Enum):
    """Enumeration of possible setup results."""
    SUCCESS = "success"
    LAYOUT_CREATION_FAILED = "layout_creation_failed"
    COMPONENT_ARRANGEMENT_FAILED = "component_arrangement_failed"
    CONSTRAINT_VALIDATION_FAILED = "constraint_validation_failed"
    RESPONSIVE_SETUP_FAILED = "responsive_setup_failed"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class SetupPhase(Enum):
    """Enumeration of setup phases."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    LAYOUT_CREATION = "layout_creation"
    COMPONENT_ARRANGEMENT = "component_arrangement"
    CONSTRAINT_APPLICATION = "constraint_application"
    RESPONSIVE_CONFIGURATION = "responsive_configuration"
    FINALIZATION = "finalization"


class ComponentRole(Enum):
    """Enumeration of component roles in layout."""
    HEADER = "header"
    FOOTER = "footer"
    SIDEBAR = "sidebar"
    MAIN_CONTENT = "main_content"
    TOOLBAR = "toolbar"
    STATUS_BAR = "status_bar"
    NAVIGATION = "navigation"
    CONTROL_PANEL = "control_panel"
    VISUALIZATION = "visualization"


class LayoutDirection(Enum):
    """Layout direction enumeration."""
    LEFT_TO_RIGHT = "left_to_right"
    RIGHT_TO_LEFT = "right_to_left"
    TOP_TO_BOTTOM = "top_to_bottom"
    BOTTOM_TO_TOP = "bottom_to_top"


class LayoutMode(Enum):
    """Layout mode enumeration."""
    FIXED = "fixed"
    RESPONSIVE = "responsive"
    ADAPTIVE = "adaptive"
    FLUID = "fluid"


@dataclass(frozen=True)
class LayoutConstraints(ValueObject):
    """Layout constraints value object.
    
    Defines size and positioning constraints for UI components.
    """
    min_width: int = 0
    max_width: int | None = None
    min_height: int = 0
    max_height: int | None = None
    preferred_width: int | None = None
    preferred_height: int | None = None
    
    def __post_init__(self):
        """Validate layout constraints."""
        if self.min_width < 0:
            msg = f"Minimum width must be non-negative, got {self.min_width}"
            raise ValueError(msg)
        if self.min_height < 0:
            msg = f"Minimum height must be non-negative, got {self.min_height}"
            raise ValueError(msg)
        if self.max_width is not None and self.max_width < self.min_width:
            msg = f"Maximum width ({self.max_width}) must be >= minimum width ({self.min_width})"
            raise ValueError(msg)
        if self.max_height is not None and self.max_height < self.min_height:
            msg = f"Maximum height ({self.max_height}) must be >= minimum height ({self.min_height})"
            raise ValueError(msg)
    
    @classmethod
    def create(
        cls,
        min_width: int = 0,
        max_width: int | None = None,
        min_height: int = 0,
        max_height: int | None = None,
        preferred_width: int | None = None,
        preferred_height: int | None = None,
    ) -> Result[LayoutConstraints]:
        """Create layout constraints with validation.
        
        Returns:
            Result containing LayoutConstraints or error
        """
        try:
            return Result.success(cls(
                min_width, max_width, min_height, max_height,
                preferred_width, preferred_height,
            ))
        except ValueError as e:
            return Result.failure(str(e))
    
    @classmethod
    def fixed_size(cls, width: int, height: int) -> Result[LayoutConstraints]:
        """Create fixed size constraints.
        
        Args:
            width: Fixed width
            height: Fixed height
            
        Returns:
            Result containing fixed size LayoutConstraints
        """
        return cls.create(
            min_width=width, max_width=width,
            min_height=height, max_height=height,
            preferred_width=width, preferred_height=height,
        )
    
    @classmethod
    def minimum_size(cls, width: int, height: int) -> Result[LayoutConstraints]:
        """Create minimum size constraints.
        
        Args:
            width: Minimum width
            height: Minimum height
            
        Returns:
            Result containing minimum size LayoutConstraints
        """
        return cls.create(min_width=width, min_height=height)
    
    def is_fixed_width(self) -> bool:
        """Check if width is fixed."""
        return (self.max_width is not None and 
                self.min_width == self.max_width)
    
    def is_fixed_height(self) -> bool:
        """Check if height is fixed."""
        return (self.max_height is not None and 
                self.min_height == self.max_height)
    
    def is_fixed_size(self) -> bool:
        """Check if both width and height are fixed."""
        return self.is_fixed_width() and self.is_fixed_height()
    
    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.min_width, self.max_width,
            self.min_height, self.max_height,
            self.preferred_width, self.preferred_height,
        )


@dataclass(frozen=True)
class ComponentLayout(ValueObject):
    """Component layout configuration.
    
    Defines how a specific component should be laid out.
    """
    role: ComponentRole
    constraints: LayoutConstraints
    position: tuple[int, int] = (0, 0)  # (x, y)
    z_index: int = 0
    visible: bool = True
    enabled: bool = True
    
    def __post_init__(self):
        """Validate component layout."""
        if not isinstance(self.role, ComponentRole):
            msg = f"Invalid component role: {self.role}"
            raise ValueError(msg)
        if not isinstance(self.constraints, LayoutConstraints):
            msg = f"Invalid constraints: {self.constraints}"
            raise ValueError(msg)
    
    @classmethod
    def create(
        cls,
        role: ComponentRole,
        constraints: LayoutConstraints,
        position: tuple[int, int] = (0, 0),
        z_index: int = 0,
        visible: bool = True,
        enabled: bool = True,
    ) -> Result[ComponentLayout]:
        """Create component layout with validation.
        
        Returns:
            Result containing ComponentLayout or error
        """
        try:
            return Result.success(cls(
                role, constraints, position, z_index, visible, enabled,
            ))
        except ValueError as e:
            return Result.failure(str(e))
    
    def with_position(self, x: int, y: int) -> ComponentLayout:
        """Create layout with new position.
        
        Args:
            x: X coordinate
            y: Y coordinate
            
        Returns:
            New ComponentLayout with updated position
        """
        return ComponentLayout(
            self.role, self.constraints, (x, y),
            self.z_index, self.visible, self.enabled,
        )
    
    def with_z_index(self, z_index: int) -> ComponentLayout:
        """Create layout with new z-index.
        
        Args:
            z_index: New z-index value
            
        Returns:
            New ComponentLayout with updated z-index
        """
        return ComponentLayout(
            self.role, self.constraints, self.position,
            z_index, self.visible, self.enabled,
        )
    
    def with_visibility(self, visible: bool) -> ComponentLayout:
        """Create layout with new visibility.
        
        Args:
            visible: New visibility state
            
        Returns:
            New ComponentLayout with updated visibility
        """
        return ComponentLayout(
            self.role, self.constraints, self.position,
            self.z_index, visible, self.enabled,
        )
    
    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.role, self.constraints, self.position,
            self.z_index, self.visible, self.enabled,
        )


@dataclass(frozen=True)
class UILayout(ValueObject):
    """UI layout configuration value object.
    
    Represents the complete layout configuration for a UI.
    """
    components: dict[ComponentRole, ComponentLayout]
    direction: LayoutDirection = LayoutDirection.LEFT_TO_RIGHT
    mode: LayoutMode = LayoutMode.RESPONSIVE
    spacing: int = 8
    margins: tuple[int, int, int, int] = (8, 8, 8, 8)  # top, right, bottom, left
    
    def __post_init__(self):
        """Validate UI layout."""
        if not self.components:
            msg = "Layout must have at least one component"
            raise ValueError(msg)
        if self.spacing < 0:
            msg = f"Spacing must be non-negative, got {self.spacing}"
            raise ValueError(msg)
        if any(margin < 0 for margin in self.margins):
            msg = f"All margins must be non-negative, got {self.margins}"
            raise ValueError(msg)
    
    @classmethod
    def create(
        cls,
        components: dict[ComponentRole, ComponentLayout],
        direction: LayoutDirection = LayoutDirection.LEFT_TO_RIGHT,
        mode: LayoutMode = LayoutMode.RESPONSIVE,
        spacing: int = 8,
        margins: tuple[int, int, int, int] = (8, 8, 8, 8),
    ) -> Result[UILayout]:
        """Create UI layout with validation.
        
        Returns:
            Result containing UILayout or error
        """
        try:
            return Result.success(cls(components, direction, mode, spacing, margins))
        except ValueError as e:
            return Result.failure(str(e))
    
    @classmethod
    def create_simple(
        cls,
        main_content_constraints: LayoutConstraints,
        direction: LayoutDirection = LayoutDirection.LEFT_TO_RIGHT,
    ) -> Result[UILayout]:
        """Create simple layout with just main content.
        
        Args:
            main_content_constraints: Constraints for main content
            direction: Layout direction
            
        Returns:
            Result containing simple UILayout
        """
        main_layout_result = ComponentLayout.create(
            ComponentRole.MAIN_CONTENT,
            main_content_constraints,
        )
        
        if not main_layout_result.is_success:
            return Result.failure(main_layout_result.error or "Failed to create main layout")
        
        main_layout = main_layout_result.value
        if main_layout is None:
            return Result.failure("Main layout result was None")
        
        components = {
            ComponentRole.MAIN_CONTENT: main_layout,
        }
        
        return cls.create(components, direction)
    
    def get_component(self, role: ComponentRole) -> ComponentLayout | None:
        """Get component layout by role.
        
        Args:
            role: Component role
            
        Returns:
            ComponentLayout if found, None otherwise
        """
        return self.components.get(role)
    
    def has_component(self, role: ComponentRole) -> bool:
        """Check if layout has component with role.
        
        Args:
            role: Component role to check
            
        Returns:
            True if component exists, False otherwise
        """
        return role in self.components
    
    def with_component(self, component: ComponentLayout) -> UILayout:
        """Create layout with added/updated component.
        
        Args:
            component: Component layout to add/update
            
        Returns:
            New UILayout with updated component
        """
        new_components = self.components.copy()
        new_components[component.role] = component
        
        return UILayout(
            new_components, self.direction, self.mode,
            self.spacing, self.margins,
        )
    
    def without_component(self, role: ComponentRole) -> UILayout:
        """Create layout without specific component.
        
        Args:
            role: Component role to remove
            
        Returns:
            New UILayout without the component
        """
        new_components = self.components.copy()
        new_components.pop(role, None)
        
        return UILayout(
            new_components, self.direction, self.mode,
            self.spacing, self.margins,
        )
    
    def with_spacing(self, spacing: int) -> Result[UILayout]:
        """Create layout with new spacing.
        
        Args:
            spacing: New spacing value
            
        Returns:
            Result containing UILayout with new spacing
        """
        return self.create(
            self.components, self.direction, self.mode,
            spacing, self.margins,
        )
    
    def with_margins(self, top: int, right: int, bottom: int, left: int) -> Result[UILayout]:
        """Create layout with new margins.
        
        Args:
            top: Top margin
            right: Right margin
            bottom: Bottom margin
            left: Left margin
            
        Returns:
            Result containing UILayout with new margins
        """
        return self.create(
            self.components, self.direction, self.mode,
            self.spacing, (top, right, bottom, left),
        )
    
    def initialize(self) -> Result[None]:
        """Initialize the layout.
        
        Returns:
            Result indicating success or failure
        """
        # Validate all components
        for component in self.components.values():
            if not component.enabled:
                continue
                
            # Additional validation logic can be added here
        
        return Result.success(None)
    
    @property
    def component_count(self) -> int:
        """Get number of components in layout."""
        return len(self.components)
    
    @property
    def visible_components(self) -> list[ComponentLayout]:
        """Get list of visible components."""
        return [comp for comp in self.components.values() if comp.visible]
    
    @property
    def enabled_components(self) -> list[ComponentLayout]:
        """Get list of enabled components."""
        return [comp for comp in self.components.values() if comp.enabled]
    
    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            tuple(sorted(self.components.items())),
            self.direction, self.mode, self.spacing, self.margins,
        )
    
    def __str__(self) -> str:
        """String representation."""
        return f"UILayout({self.component_count} components, {self.mode.value})"
    
    def __repr__(self) -> str:
        """Developer representation."""
        return (f"UILayout(components={dict(self.components)}, "
                f"direction={self.direction}, mode={self.mode}, "
                f"spacing={self.spacing}, margins={self.margins})")