"""Activation Method Value Object

Defines the methods available for window activation.
"""

from enum import Enum


class ActivationMethod(Enum):
    """Methods for window activation."""
    WIN32_API = "win32_api"
    QT_NATIVE = "qt_native"
    SYSTEM_TRAY = "system_tray"
    KEYBOARD_SHORTCUT = "keyboard_shortcut"
    IPC_MESSAGE = "ipc_message"
    FORCE_FOREGROUND = "force_foreground"