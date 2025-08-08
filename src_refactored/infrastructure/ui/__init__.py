"""UI infrastructure services package.

This package provides infrastructure services for UI management,
including message display, file dialogs, progress tracking,
state management, and comprehensive event system.

Note: Drag & Drop is provided via the adapter
`src_refactored.infrastructure.adapters.qt_drag_drop_adapter.QtDragDropAdapter`
which uses presentation-level services; it is not re-exported here.
"""

# Re-export selected presentation services through infrastructure namespace where appropriate
from src_refactored.presentation.qt.services.event_system_service import UIEventSystem
from src_refactored.presentation.qt.services.file_dialog_service import (
    FileDialogResult,
    FileDialogService,
)
from src_refactored.presentation.qt.services.message_display_service import (
    MessageDisplayService,
)
from src_refactored.presentation.qt.services.progress_ui_service import ProgressUIService
from src_refactored.presentation.qt.services.state_management_service import StateManagementService

__all__ = [
    # Event System
    "UIEventSystem",
    # File Dialogs
    "FileDialogResult",
    "FileDialogService",
    # Message Display
    "MessageDisplayService",
    # Progress UI
    "ProgressUIService",
    # State Management
    "StateManagementService",
]