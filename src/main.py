import atexit

# Suppress transformers warning about PyTorch/TensorFlow/Flax
import logging
import os
import socket
import subprocess
import sys
import tempfile
from unittest.mock import patch

logging.getLogger("transformers").setLevel(logging.ERROR)

# Add the root directory to Python path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core.utils import resource_path

# Suppress pygame welcome message and warnings
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "hide"
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning,ignore::SyntaxWarning,ignore::UserWarning"
os.environ["QT_LOGGING_RULES"] = "qt.gui.imageio=false;*.debug=false;qt.qpa.*=false"

# Import win32gui for handling existing window activation (Windows only)
HAS_WIN32GUI = False
if os.name in ("nt", "win32"):
    try:
        import win32gui
        HAS_WIN32GUI = True
    except ImportError:
        HAS_WIN32GUI = False

# Suppression patch for subprocess
original_popen = subprocess.Popen

def suppress_subprocess_call(*args, **kwargs):
    # Suppress the console window
    CREATE_NO_WINDOW = 0x08000000
    kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW
    return original_popen(*args, **kwargs)

# Import the resource_path function from utils


# Create a unique socket name based on the app name
socket_name = os.path.join(tempfile.gettempdir(), "winstt_single_instance.sock")
single_instance_socket = None

# Function to check for an existing instance
def is_already_running():
    global single_instance_socket
    try:
        # Try to create and bind a socket
        single_instance_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        single_instance_socket.bind(("localhost", 47123))  # Use a unique, unlikely-to-be-used port
        # If we get here, no other instance is running
        atexit.register(cleanup_socket)
        return False
    except OSError:
        # Socket is already in use, another instance is running
        return True

# Function to clean up socket on exit
def cleanup_socket():
    global single_instance_socket
    if single_instance_socket:
        single_instance_socket.close()

# Import UI components with patch to suppress subprocess console window
with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
    # Import our logger module
    from logger import setup_logger
    from PyQt6.QtGui import QIcon
    from PyQt6.QtWidgets import QApplication, QMessageBox

def main():
    """Main entry point for the application"""
    # Set up logger
    logger = setup_logger()
    
    # Suppress specific warnings
    import warnings
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    warnings.filterwarnings("ignore", category=UserWarning, module="pygame")
    warnings.filterwarnings("ignore", category=UserWarning, module="pydub")
    warnings.filterwarnings("ignore", message="pkg_resources is deprecated")
    
    # Import the UI components
    with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
        from src.ui.main_window import Window
    
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setWindowIcon(QIcon(resource_path("resources/Windows 1 Theta.png")))
    
    # Check if app is already running
    if is_already_running():
        # Send signal to bring existing window to front
        try:
            # If we're on Windows, use win32gui to activate the existing window
            if sys.platform == "win32":
                if HAS_WIN32GUI:
                    # Find window by class name and title
                    def enum_windows_callback(hwnd, result_list):
                        if win32gui.IsWindowVisible(hwnd):
                            window_title = win32gui.GetWindowText(hwnd)
                            if window_title == "WinSTT":  # Match the window title
                                result_list.append(hwnd)
                        return True
                    
                    hwnd_list = []
                    win32gui.EnumWindows(enum_windows_callback, hwnd_list)
                    
                    if hwnd_list:
                        # Bring window to foreground
                        win32gui.ShowWindow(hwnd_list[0], 9)  # SW_RESTORE
                        win32gui.SetForegroundWindow(hwnd_list[0])
                else:
                    # If win32gui is not available, just show a message
                    logger.warning("win32gui module not found. Install with: pip install pywin32")
                    QMessageBox.warning(None, "WinSTT", "Another instance is already running. The pywin32 package is required to activate the existing window.")
            
            logger.info("An instance of WinSTT is already running. Exiting.")
            sys.exit(0)
        except Exception as e:
            logger.exception(f"Error activating existing instance: {e}")
            # If activation fails, show message and exit
            QMessageBox.warning(None, "WinSTT", "An instance of WinSTT is already running.")
            sys.exit(0)
    
    try:
        # Create and setup main window
        window = Window()
        window.show()
        
        logger.info("WinSTT application started successfully")
        sys.exit(app.exec())
        
    except Exception as e:
        logger.exception(f"Failed to start application: {e}")
        QMessageBox.critical(None, "WinSTT Error", f"Failed to start application: {e!s}")
        sys.exit(1)

if __name__ == "__main__":
    main()