"""UI infrastructure services package.

This package provides infrastructure services for UI management,
including message display, file dialogs, progress tracking,
state management, and comprehensive event system.

Note: Drag & Drop is provided via the adapter
`src.infrastructure.adapters.qt_drag_drop_adapter.QtDragDropAdapter`
which uses presentation-level services; it is not re-exported here.
"""

# Re-export selected presentation services through infrastructure namespace where appropriate
from src.presentation.qt.services.event_system_service import UIEventSystem
from src.presentation.qt.services.file_dialog_service import (
    FileDialogResult,
    FileDialogService,
)
from src.presentation.qt.services.message_display_service import (
    MessageDisplayService,
)
from src.presentation.qt.services.progress_ui_service import ProgressUIService
from src.presentation.qt.services.state_management_service import StateManagementService

__all__ = [
    # File Dialogs
    "FileDialogResult",
    "FileDialogService",
    # Message Display
    "MessageDisplayService",
    # Progress UI
    "ProgressUIService",
    # State Management
    "StateManagementService",
    # Event System
    "UIEventSystem",
]