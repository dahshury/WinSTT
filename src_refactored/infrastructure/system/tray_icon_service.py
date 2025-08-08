"""Tray icon service for system tray management.

This module provides infrastructure services for managing system tray icons,
including creation, visibility control, and interaction handling.
"""

from collections.abc import Callable
from pathlib import Path

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtGui import QAction, QIcon
from PyQt6.QtWidgets import QApplication, QSystemTrayIcon


class TrayIconService(QObject):
    """Service for managing system tray icon functionality.
    
    This service provides infrastructure-only logic for tray icon management,
    without any UI or business logic dependencies.
    """

    # Signals for tray icon events
    tray_activated = pyqtSignal(QSystemTrayIcon.ActivationReason)
    show_window_requested = pyqtSignal()
    settings_requested = pyqtSignal()
    close_app_requested = pyqtSignal()

    def __init__(self, app_name: str = "WinSTT", icon_path: str | None = None):
        """Initialize the tray icon service.
        
        Args:
            app_name: Name of the application for tray icon tooltip
            icon_path: Optional path to custom icon file
        """
        super().__init__()
        self.app_name = app_name
        self.icon_path = icon_path
        self.tray_icon = None
        self.tray_menu = None
        self._is_visible = False

    def create_tray_icon(self) -> bool:
        """Create and configure the system tray icon.
        
        Returns:
            True if tray icon was created successfully, False otherwise
        """
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return False

        # Create tray icon with a stable parent (the QApplication instance) to ensure lifetime
        app = QApplication.instance()
        self.tray_icon = QSystemTrayIcon(app)

        # Set icon
        icon = self._load_icon()
        if icon:
            self.tray_icon.setIcon(icon)

        # Set tooltip
        self.tray_icon.setToolTip(self.app_name)

        # Create context menu
        self._create_tray_menu()

        # Ensure context menu is set before showing
        if self.tray_menu:
            self.tray_icon.setContextMenu(self.tray_menu)

        # Connect signals
        self.tray_icon.activated.connect(self._on_tray_activated)

        return True

    def show_tray_icon(self) -> bool:
        """Show the tray icon.
        
        Returns:
            True if tray icon was shown successfully, False otherwise
        """
        if not self.tray_icon and not self.create_tray_icon():
            return False

        if not QSystemTrayIcon.isSystemTrayAvailable():
            return False

        # Ensure menu is properly attached before showing
        if not self.tray_menu:
            self._create_tray_menu()
            
        if self.tray_menu:
            self.tray_icon.setContextMenu(self.tray_menu)
            # Verify menu is actually attached
            attached_menu = self.tray_icon.contextMenu()
            if attached_menu != self.tray_menu:
                # Try setting it again
                self.tray_icon.setContextMenu(self.tray_menu)

        self.tray_icon.show()
        self._is_visible = True
        return True

    def hide_tray_icon(self) -> None:
        """Hide the tray icon."""
        if self.tray_icon:
            self.tray_icon.hide()
            self._is_visible = False

    def is_tray_icon_visible(self) -> bool:
        """Check if the tray icon is currently visible.
        
        Returns:
            True if tray icon is visible, False otherwise
        """
        return self._is_visible and self.tray_icon is not None

    def update_tooltip(self, tooltip: str,
    ) -> None:
        """Update the tray icon tooltip.
        
        Args:
            tooltip: New tooltip text
        """
        if self.tray_icon:
            self.tray_icon.setToolTip(tooltip)

    def update_icon(self, icon_path: str,
    ) -> bool:
        """Update the tray icon image.
        
        Args:
            icon_path: Path to the new icon file
            
        Returns:
            True if icon was updated successfully, False otherwise
        """
        if not self.tray_icon:
            return False

        icon = self._load_icon(icon_path)
        if icon:
            self.tray_icon.setIcon(icon)
            self.icon_path = icon_path
            return True
        return False

    def show_message(self,
                     title: str, message: str, icon_type: QSystemTrayIcon.MessageIcon = QSystemTrayIcon.MessageIcon.Information, timeout: int = 5000) -> None:
        """Show a notification message from the tray icon.
        
        Args:
            title: Message title
            message: Message content
            icon_type: Type of icon to show in the message
            timeout: Message timeout in milliseconds
        """
        if self.tray_icon and self.tray_icon.isVisible():
            self.tray_icon.showMessage(title, message, icon_type, timeout)

    def add_menu_action(
    self,
    text: str,
    callback: Callable[[],
    None],
    shortcut: str | None = None) -> QAction:
        """Add a custom action to the tray icon context menu.
        
        Args:
            text: Action text
            callback: Function to call when action is triggered
            shortcut: Optional keyboard shortcut
            
        Returns:
            The created QAction object
        """
        if not self.tray_menu:
            self._create_tray_menu()

        action = QAction(text)
        if shortcut:
            action.setShortcut(shortcut)
        action.triggered.connect(callback)

        # Insert before the separator (before Show/Close actions)
        actions = self.tray_menu.actions()
        min_default_actions = 2  # Show and Close actions
        if len(actions) >= min_default_actions:
            self.tray_menu.insertAction(actions[-2], action)
            self.tray_menu.insertSeparator(actions[-2])
        else:
            self.tray_menu.addAction(action)

        # Ensure menu is attached to tray icon
        if self.tray_icon and self.tray_menu:
            self.tray_icon.setContextMenu(self.tray_menu)

        return action

    def remove_menu_action(self, action: QAction,
    ) -> None:
        """Remove an action from the tray icon context menu.
        
        Args:
            action: The QAction to remove
        """
        if self.tray_menu:
            self.tray_menu.removeAction(action)

    def cleanup(self) -> None:
        """Clean up tray icon resources."""
        if self.tray_icon:
            self.tray_icon.hide()
            self.tray_icon = None
        if self.tray_menu:
            self.tray_menu = None
        self._is_visible = False

    def _create_tray_menu(self) -> None:
        """Create the context menu for the tray icon."""
        from PyQt6.QtWidgets import QMenu
        
        self.tray_menu = QMenu()

        # Show action (like the old implementation)
        show_action = QAction("Show", self.tray_menu)
        show_action.triggered.connect(self._on_show_requested)
        self.tray_menu.addAction(show_action)

        # Settings action (like the old implementation)
        settings_action = QAction("Settings", self.tray_menu)
        settings_action.triggered.connect(self._on_settings_requested)
        self.tray_menu.addAction(settings_action)

        # Close action (renamed to "Exit" like old implementation)
        close_action = QAction("Exit", self.tray_menu)
        close_action.triggered.connect(self._on_close_requested)
        self.tray_menu.addAction(close_action)

        # Set menu to tray icon immediately
        if self.tray_icon:
            self.tray_icon.setContextMenu(self.tray_menu)

    def _load_icon(self, icon_path: str | None = None) -> QIcon | None:
        """Load icon from file path.
        
        Args:
            icon_path: Optional path to icon file, uses self.icon_path if None
            
        Returns:
            QIcon object or None if loading failed
        """
        path_to_use = icon_path or self.icon_path

        if path_to_use and Path(path_to_use).exists():
            return QIcon(path_to_use)

        # Try to find default icon in common locations
        possible_paths = [
            "icon.png",
            "icon.ico",
            "assets/icon.png",
            "assets/icon.ico",
            "resources/icon.png",
            "resources/icon.ico",
        ]

        for path in possible_paths:
            if Path(path).exists():
                return QIcon(path)

        # Return default application icon if available
        app = QApplication.instance()
        if app and hasattr(app, "style"):
            style_method = getattr(app, "style", None)
            if style_method and callable(style_method):
                style = style_method()
                if hasattr(style, "standardIcon"):
                    return style.standardIcon(style.StandardPixmap.SP_ComputerIcon)

        return None

    def _on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        """Handle tray icon activation.
        
        Args:
            reason: The reason for activation (click, double-click, etc.)
        """
        from contextlib import suppress
        
        with suppress(Exception):
            # Convert enum to int for signal emission to avoid type conversion issues
            self.tray_activated.emit(int(reason))

        # Ensure right-click shows context menu reliably
        if reason == QSystemTrayIcon.ActivationReason.Context:
            if self.tray_menu:
                try:
                    from PyQt6.QtGui import QCursor
                    # Use exec for modal context menu on Windows
                    self.tray_menu.exec(QCursor.pos())
                except Exception:
                    # Fallback: ensure menu is attached; Qt should handle display
                    if self.tray_icon and self.tray_menu:
                        self.tray_icon.setContextMenu(self.tray_menu)
        # Double-click shows window, matching domain default behavior
        elif reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._on_show_requested()

    def _on_show_requested(self) -> None:
        """Handle show window request from tray menu."""
        self.show_window_requested.emit()

    def _on_settings_requested(self) -> None:
        """Handle settings request from tray menu."""
        self.settings_requested.emit()

    def _on_close_requested(self) -> None:
        """Handle close application request from tray menu."""
        self.close_app_requested.emit()

    @staticmethod
    def is_system_tray_available() -> bool:
        """Check if system tray is available on the current system.
        
        Returns:
            True if system tray is available, False otherwise
        """
        return QSystemTrayIcon.isSystemTrayAvailable()